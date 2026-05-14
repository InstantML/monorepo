#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

  const firstPage = await getJson(
    `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`,
    cookie,
  );
  const firstRunId = firstPage.runs?.[0]?.id;
  if (!firstRunId) throw new Error("hosted demo seed did not produce a visible run");

  const measurements = {
    summary_newest_project: await measureEndpoint("summary_newest_project", `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, cookie),
    summary_search_seed_13: await measureEndpoint("summary_search_seed_13", `/api/runs/summary?${new URLSearchParams({ project, q: "seed 13", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, cookie),
    summary_sort_metric_best: await measureEndpoint("summary_sort_metric_best", `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "metric-best", metric_key: "eval/return_mean" })}`, cookie),
    chart_series: await measureEndpoint("chart_series", `/runs/${firstRunId}/metrics?${new URLSearchParams({ key: "eval/return_mean", limit: "5000" })}`, cookie),
  };

  console.log(JSON.stringify({
    status: "ok",
    demo_email: demoEmail,
    org_id: orgId,
    project,
    route: {
      provisioner: route.provisioner,
      service_id: route.service_id,
      database: route.database,
      endpoint_host: new URL(route.endpoint).host,
    },
    seeded_runs: await seededRunCount(tenantUrl, orgId),
    measurements,
  }, null, 2));
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
      key: "eval/return_mean",
      step: 1000,
      value: 150 + (index % 800),
      logged_at: clickhouseDate(new Date(createdAt.getTime() + 60 * 60 * 1000)),
    });
    if (ops.length >= 5000) await insertOperationalRecords(tenantUrl, ops.splice(0));
    if (metricRows.length >= 5000) await insertMetricPoints(tenantUrl, metricRows.splice(0));
    if (index % 25_000 === 0) console.log(`seeded ${index}/${runCount} runs`);
  }
  const longRunKeys = ["eval/return_mean", "train/loss", "train/reward", "system/tokens_per_second"];
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

async function measureEndpoint(name, pathSuffix, cookie) {
  for (let index = 0; index < warmups; index += 1) await getJson(pathSuffix, cookie);
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const payload = await getJson(pathSuffix, cookie);
    timings.push(performance.now() - started);
    if (name.startsWith("summary") && !Array.isArray(payload.runs)) throw new Error(`${name} returned malformed runs payload`);
    if (name === "chart_series" && !Array.isArray(payload.metrics)) throw new Error("chart_series returned malformed metrics payload");
  }
  return summarize(timings);
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
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function summarize(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    p50_ms: Math.round(percentile(sorted, 0.5)),
    p95_ms: Math.round(percentile(sorted, 0.95)),
    min_ms: Math.round(sorted[0]),
    max_ms: Math.round(sorted[sorted.length - 1]),
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
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
