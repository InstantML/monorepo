#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  HOSTED_BENCHMARK_BUDGETS_MS,
  budgetFailures,
  budgetForCase,
  sanitizeHostedBenchmarkResult,
  summarizeTimings,
  validateBenchmarkPayload,
} from "./hosted-benchmark-utils.mjs";
import { clickhousePost } from "./local-clickhouse.mjs";

const repo = process.cwd();
loadDotenv(path.join(repo, ".env"));

const runCount = numberEnv("RLOBS_HOSTED_DEMO_RUNS", 100_000);
const longRunSteps = numberEnv("RLOBS_HOSTED_DEMO_LONG_RUN_STEPS", 20_000);
const samples = numberEnv("RLOBS_HOSTED_DEMO_SAMPLES", 8);
const warmups = numberEnv("RLOBS_HOSTED_DEMO_WARMUPS", 2);
const project = process.env.RLOBS_HOSTED_DEMO_PROJECT || "instantml-demo-100k";
const demoEmail = process.env.RLOBS_HOSTED_DEMO_EMAIL || "hello@instantml.ai";
const demoOrg = process.env.RLOBS_HOSTED_DEMO_ORG || "InstantML Demo";
const existingApiBase = process.env.RLOBS_HOSTED_DEMO_API_BASE;
const resultPath = process.env.RLOBS_HOSTED_DEMO_RESULT_PATH || "";
const enforceBudgets = process.env.RLOBS_HOSTED_DEMO_ENFORCE === "1";
const metricKey = process.env.RLOBS_HOSTED_DEMO_METRIC_KEY || "eval/return_mean";
const userDataUrl = clickhouseUrlFromEnv(
  "CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT",
  "CLICKHOUSE_INSTANTML_USER_DATA_USERNAME",
  "CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD",
  process.env.CLICKHOUSE_URL,
);
const cloudLocation = inferCloudLocation(userDataUrl);
const cloudProvider = process.env.RLOBS_CLICKHOUSE_CLOUD_PROVIDER || cloudLocation.provider;
const cloudRegion = process.env.RLOBS_CLICKHOUSE_CLOUD_REGION || cloudLocation.region;
if (process.env.RLOBS_HOSTED_DEMO_ALLOW_PROVISION !== "1") {
  throw new Error("hosted demo benchmark can create paid ClickHouse Cloud services; set RLOBS_HOSTED_DEMO_ALLOW_PROVISION=1 to continue");
}
if (!existingApiBase && (!cloudProvider || !cloudRegion)) {
  throw new Error("RLOBS_CLICKHOUSE_CLOUD_PROVIDER and RLOBS_CLICKHOUSE_CLOUD_REGION are required when the User Data endpoint is not a ClickHouse Cloud hostname");
}
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlobs-hosted-demo-"));

let server = null;
let apiBaseUrl = existingApiBase || "";

try {
  if (!apiBaseUrl) {
    const apiPort = await freePort();
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    server = await startServer(apiPort);
  }

  const signup = await postJson("/api/auth/dev/google", {
    email: demoEmail,
    display_name: demoOrg,
    account_type: "business",
    org_name: demoOrg,
  });
  const cookie = signup.cookie;
  const orgId = signup.body.organization?.id;
  if (!orgId) throw new Error("demo signup did not return an organization id");

  const route = await latestTenantRoute(orgId);
  if (route.status !== "ready") throw new Error(`demo tenant route is ${route.status}: ${route.error || ""}`);
  if (route.provisioner !== "cloud-service" && process.env.RLOBS_HOSTED_DEMO_ALLOW_DATABASE_ROUTE !== "1") {
    throw new Error(
      `demo tenant route uses ${route.provisioner}; set RLOBS_CLICKHOUSE_PROVISIONER=cloud-service before seeding the hosted demo service`,
    );
  }

  const tenantUrl = tenantUrlFromRoute(route);
  const existingRuns = await seededRunCount(tenantUrl, orgId);
  if (existingRuns >= runCount) {
    console.log(`hosted demo seed already present: ${existingRuns} ${project} runs`);
  } else if (existingRuns > 0) {
    throw new Error(`${project} has a partial seed (${existingRuns}/${runCount} runs). Use a new RLOBS_HOSTED_DEMO_PROJECT to avoid duplicate benchmark rows.`);
  } else {
    await seedBenchmarkData(tenantUrl, orgId);
  }

  if (server) {
    await stopServer();
    const apiPort = Number(new URL(apiBaseUrl).port);
    server = await startServer(apiPort);
  }

  const seededRuns = await seededRunCount(tenantUrl, orgId);
  const seededMetricPoints = await seededMetricPointCount(tenantUrl, orgId);
  const statusCounts = await seededStatusCounts(tenantUrl, orgId);
  assertSeedPreflight({ seededRuns, statusCounts });

  const firstPage = await getJson(
    `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: metricKey })}`,
    cookie,
  );
  const firstRunId = firstPage.runs?.[0]?.id;
  if (!firstRunId) throw new Error("hosted demo seed did not produce a visible run");

  const cases = benchmarkCases(firstRunId);
  await preflightCases(cases, cookie);
  const measurements = [];
  for (const caseDefinition of cases) {
    measurements.push(await measureEndpoint(caseDefinition, cookie));
  }
  const routeLocation = inferCloudLocation(route.endpoint);

  const result = sanitizeHostedBenchmarkResult({
    status: "ok",
    generated_at: new Date().toISOString(),
    git: gitMetadata(),
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      node_version: process.version,
      api_mode: existingApiBase ? "existing-api" : "temporary-rust",
      warmed: true,
    },
    measurement_protocol: {
      warmups,
      samples,
      p95: "nearest-rank",
      endpoint_order: "fixed",
    },
    dataset: {
      project,
      configured_runs: runCount,
      seeded_runs: seededRuns,
      seeded_metric_points: seededMetricPoints,
      long_run_steps: longRunSteps,
      metric_key: metricKey,
      status_counts: statusCounts,
    },
    route: {
      provisioner: route.provisioner,
      endpoint_host: new URL(route.endpoint).host,
      clickhouse_provider: routeLocation.provider || cloudProvider,
      clickhouse_region: routeLocation.region || cloudRegion,
    },
    budgets_ms: HOSTED_BENCHMARK_BUDGETS_MS,
    measurements,
  });

  if (resultPath) {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
  const failures = budgetFailures(result);
  if (enforceBudgets && failures.length) {
    throw new Error(`hosted benchmark budget failures:\n${failures.join("\n")}`);
  }
} finally {
  await stopServer();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function startServer(port) {
  const serverLog = path.join(tempDir, `api-${Date.now()}.log`);
  const output = fs.openSync(serverLog, "w");
  const child = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      RLOBS_HOSTED_CLICKHOUSE_ENABLED: "true",
      RLOBS_CLICKHOUSE_PROVISIONER: "cloud-service",
      RLOBS_CLICKHOUSE_CLOUD_PROVIDER: cloudProvider,
      RLOBS_CLICKHOUSE_CLOUD_REGION: cloudRegion,
      RLOBS_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS: "true",
      RLOBS_BIND_ADDR: `127.0.0.1:${port}`,
      RLOBS_AUTH_MODE: "local",
      RLOBS_REQUEST_TIMEOUT_SECONDS: process.env.RLOBS_REQUEST_TIMEOUT_SECONDS || "900",
      RLOBS_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
    },
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  await waitForHttp(`${apiBaseUrl}/readyz`, child, serverLog);
  return child;
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await onceClose(child);
}

async function seedBenchmarkData(tenantUrl, orgId) {
  console.log(`seeding ${runCount} hosted demo runs into ${project}`);
  const now = new Date();
  const projectId = randomUUID();
  const ops = [
    opRecord(orgId, "project", projectId, {
      id: projectId,
      org_id: orgId,
      name: project,
      description: "Hosted ClickHouse demo benchmark project",
      created_at: now.toISOString(),
    }, now),
  ];
  const metricRows = [];
  let newestRunId = null;
  let newestCreatedAt = now;
  for (let index = 1; index <= runCount; index += 1) {
    const runId = randomUUID();
    const createdAt = new Date(now.getTime() - (runCount - index) * 1000);
    newestRunId = runId;
    newestCreatedAt = createdAt;
    const seed = index % 100;
    const model = index % 3 === 0 ? "llm" : "rl";
    const status = index % 97 === 0 ? "failed" : index % 11 === 0 ? "running" : "finished";
    ops.push(opRecord(orgId, "run", runId, {
      id: runId,
      org_id: orgId,
      project_id: projectId,
      project,
      name: `demo-bench-${String(index).padStart(6, "0")}-seed-${seed}`,
      status,
      config: {
        seed,
        model,
        optimizer: index % 2 === 0 ? "adamw" : "ppo",
        hardware: { gpu: index % 4 === 0 ? "H100" : "A100", gpu_count: 1 + (index % 8) },
      },
      tags: ["demo", "bench", `seed-${seed}`, model],
      metadata: { notes: `hosted demo seed ${seed} reward stability cohort ${index % 17}` },
      created_at: createdAt.toISOString(),
      started_at: createdAt.toISOString(),
      finished_at: status === "running" ? null : new Date(createdAt.getTime() + 60_000 + (index % 500) * 1000).toISOString(),
    }, createdAt));
    metricRows.push({
      org_id: orgId,
      run_id: runId,
      key: metricKey,
      step: 1000,
      value: 150 + (index % 800),
      logged_at: clickhouseDate(new Date(createdAt.getTime() + 60 * 60 * 1000)),
    });
    if (ops.length >= 5000) await insertOperationalRecords(tenantUrl, ops.splice(0));
    if (metricRows.length >= 5000) await insertMetricPoints(tenantUrl, metricRows.splice(0));
    if (index % 25_000 === 0) console.log(`seeded ${index}/${runCount} runs`);
  }
  const longRunKeys = [...new Set([metricKey, "train/loss", "train/reward", "system/tokens_per_second"])];
  for (let step = 1; step <= longRunSteps; step += 1) {
    for (const key of longRunKeys) {
      metricRows.push({
        org_id: orgId,
        run_id: newestRunId,
        key,
        step,
        value: longRunMetricValue(key, step),
        logged_at: clickhouseDate(newestCreatedAt),
      });
    }
    if (metricRows.length >= 5000) await insertMetricPoints(tenantUrl, metricRows.splice(0));
  }
  if (ops.length) await insertOperationalRecords(tenantUrl, ops);
  if (metricRows.length) await insertMetricPoints(tenantUrl, metricRows);
}

function opRecord(orgId, kind, entityId, payload, createdAt) {
  return {
    kind,
    org_id: orgId,
    entity_id: entityId,
    payload: JSON.stringify(payload),
    created_at: clickhouseDate(createdAt),
  };
}

async function insertOperationalRecords(tenantUrl, records) {
  await clickhousePost(
    tenantUrl,
    "INSERT INTO operational_records (kind, org_id, entity_id, payload, created_at) FORMAT JSONEachRow",
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

async function insertMetricPoints(tenantUrl, points) {
  await clickhousePost(
    tenantUrl,
    "INSERT INTO metric_points (org_id, run_id, key, step, value, logged_at) FORMAT JSONEachRow",
    points.map((point) => JSON.stringify(point)).join("\n"),
  );
}

async function seededRunCount(tenantUrl, orgId) {
  const text = await clickhousePost(
    tenantUrl,
    `SELECT count() AS count FROM operational_records WHERE org_id = toUUID('${orgId}') AND kind = 'run' AND JSONExtractString(payload, 'project') = ${sqlString(project)} FORMAT JSONEachRow`,
  );
  return Number(JSON.parse(text.trim()).count);
}

async function seededMetricPointCount(tenantUrl, orgId) {
  const text = await clickhousePost(
    tenantUrl,
    `SELECT count() AS count
     FROM metric_points
     WHERE org_id = toUUID('${orgId}')
       AND run_id IN (
         SELECT toUUID(entity_id)
         FROM operational_records
         WHERE org_id = toUUID('${orgId}')
           AND kind = 'run'
           AND JSONExtractString(payload, 'project') = ${sqlString(project)}
       )
     FORMAT JSONEachRow`,
  );
  return Number(JSON.parse(text.trim()).count);
}

async function seededStatusCounts(tenantUrl, orgId) {
  const text = await clickhousePost(
    tenantUrl,
    `SELECT JSONExtractString(payload, 'status') AS status, count() AS count
     FROM operational_records
     WHERE org_id = toUUID('${orgId}')
       AND kind = 'run'
       AND JSONExtractString(payload, 'project') = ${sqlString(project)}
     GROUP BY status
     FORMAT JSONEachRow`,
  );
  const counts = {};
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    counts[row.status || "unknown"] = Number(row.count);
  }
  return counts;
}

async function latestTenantRoute(orgId) {
  const text = await clickhousePost(
    userDataUrl,
    `SELECT payload FROM instantml_user_data WHERE kind = 'tenant_route' AND org_id = toUUID('${orgId}') ORDER BY created_at DESC, event_id DESC LIMIT 1 FORMAT JSONEachRow`,
  );
  const line = text.trim().split("\n").filter(Boolean).at(0);
  if (!line) throw new Error(`no tenant route found for org ${orgId}`);
  return JSON.parse(JSON.parse(line).payload);
}

function tenantUrlFromRoute(route) {
  const password = route.password_ciphertext || tenantBasePassword(route);
  const url = new URL(route.endpoint);
  url.username = route.username || "default";
  url.password = password;
  url.pathname = `/${route.database || "default"}`;
  return url.toString();
}

function tenantBasePassword(route) {
  if (route.password_secret_ref !== "config:tenant_base_url_password") {
    throw new Error("tenant route does not include a resolvable password");
  }
  const tenantBase = process.env.RLOBS_TENANT_CLICKHOUSE_URL || userDataUrl;
  return new URL(tenantBase).password;
}

function benchmarkCases(firstRunId) {
  const summary = (name, params, options = {}) => ({
    name,
    kind: "summary",
    group: options.group || "search_filter_sort",
    route_template: "/api/runs/summary",
    path: `/api/runs/summary?${new URLSearchParams({ project, metric_key: metricKey, limit: "25", sort_by: "created", ...params })}`,
    limit: Number(params.limit || 25),
    expect_non_empty: true,
    ...options,
  });
  const latestRunName = `demo-bench-${String(runCount).padStart(6, "0")}`;
  return [
    summary("runs_newest_25", { limit: "25", sort_by: "created" }, { group: "summary", require_metric_key: metricKey }),
    summary("runs_newest_100", { limit: "100", sort_by: "created" }, { group: "summary", require_metric_key: metricKey }),
    summary("search_name_latest_run", { q: latestRunName }, { query_fixture: "name" }),
    summary("search_seed_13", { q: "seed 13" }, { query_fixture: "name_tag_config" }),
    summary("search_tag_config_llm", { q: "llm" }, { query_fixture: "tag_config" }),
    summary("search_notes_reward_stability", { q: "reward stability" }, { query_fixture: "notes" }),
    summary("filter_failed", { status: "failed" }, { expected_status: "failed" }),
    summary("filter_running", { status: "running" }, { expected_status: "running" }),
    summary("filter_finished", { status: "finished" }, { expected_status: "finished" }),
    summary("filter_finished_notes", { status: "finished", q: "reward stability" }, { expected_status: "finished" }),
    summary("sort_metric_best", { sort_by: "metric-best" }, { require_metric_summary_key: metricKey }),
    {
      name: "overview_project",
      kind: "overview",
      group: "overview",
      route_template: "/api/overview",
      path: `/api/overview?${new URLSearchParams({ project, metric_key: metricKey })}`,
    },
    {
      name: "chart_eval_return_5000",
      kind: "chart",
      group: "chart",
      route_template: "/runs/:id/metrics",
      path: `/runs/${firstRunId}/metrics?${new URLSearchParams({ key: metricKey, limit: "5000" })}`,
      limit: 5000,
      expect_non_empty: true,
    },
  ].map((caseDefinition) => ({
    ...caseDefinition,
    budget_ms: budgetForCase(caseDefinition),
  }));
}

function assertSeedPreflight({ seededRuns, statusCounts }) {
  if (seededRuns < runCount) throw new Error(`${project} has ${seededRuns}/${runCount} seeded runs`);
  for (const status of ["failed", "running", "finished"]) {
    if (!statusCounts[status]) throw new Error(`${project} has no ${status} runs for filter benchmarking`);
  }
}

async function preflightCases(cases, cookie) {
  for (const caseDefinition of cases) {
    const payload = await getJson(caseDefinition.path, cookie);
    validateBenchmarkPayload(caseDefinition, payload);
  }
}

async function measureEndpoint(caseDefinition, cookie) {
  let stats = null;
  for (let index = 0; index < warmups; index += 1) {
    const payload = await getJson(caseDefinition.path, cookie);
    stats = validateBenchmarkPayload(caseDefinition, payload);
  }
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const payload = await getJson(caseDefinition.path, cookie);
    timings.push(performance.now() - started);
    stats = validateBenchmarkPayload(caseDefinition, payload);
  }
  return {
    name: caseDefinition.name,
    kind: caseDefinition.kind,
    group: caseDefinition.group,
    route_template: caseDefinition.route_template,
    limit: caseDefinition.limit,
    budget_ms: caseDefinition.budget_ms,
    ...summarizeTimings(timings),
    stats,
  };
}

async function postJson(pathname, body) {
  const response = await fetch(apiBaseUrl + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${text}`);
  return {
    body: text ? JSON.parse(text) : {},
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

async function getJson(pathname, cookie) {
  const response = await fetch(apiBaseUrl + pathname, { headers: { cookie } });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${text}`);
  if (text && !contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${pathname} returned ${contentType || "unknown content type"}, expected JSON`);
  }
  return text ? JSON.parse(text) : {};
}

function longRunMetricValue(key, step) {
  if (key === "train/loss") return Math.max(0.01, 4 / Math.sqrt(step));
  if (key === "train/reward") return 50 + Math.log1p(step) * 12;
  if (key === "system/tokens_per_second") return 12_000 + Math.sin(step / 111) * 700;
  return 100 + Math.sin(step / 25) * 10 + step / 100;
}

function clickhouseDate(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function sqlString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function clickhouseUrlFromEnv(endpointKey, usernameKey, passwordKey, fallback) {
  const endpoint = process.env[endpointKey] || fallback;
  if (!endpoint) throw new Error(`${endpointKey} or CLICKHOUSE_URL is required`);
  const url = new URL(endpoint);
  if (!url.username) url.username = process.env[usernameKey] || "default";
  if (!url.password) url.password = process.env[passwordKey] || "";
  if (!url.pathname || url.pathname === "/") url.pathname = "/default";
  return url.toString();
}

function inferCloudLocation(clickhouseUrl) {
  const host = new URL(clickhouseUrl).hostname;
  const match = host.match(/^[^.]+\.([^.]+)\.([^.]+)\.clickhouse\.cloud$/);
  return match ? { region: match[1], provider: match[2] } : {};
}

function gitMetadata() {
  return {
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
  };
}

function gitValue(args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(line.slice(index + 1).trim());
  }
}

function unquote(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, logPath) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      throw new Error(`process exited early while waiting for ${url}\n${log}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  throw new Error(`timed out waiting for ${url}\n${log}`);
}

function onceClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
