#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { clickhousePost, ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const runCount = numberEnv("INSTANTML_BENCH_RUNS", 100_000);
const longRunSteps = numberEnv("INSTANTML_BENCH_LONG_RUN_STEPS", 20_000);
const wideMetricKeys = nonNegativeNumberEnv("INSTANTML_BENCH_WIDE_METRIC_KEYS", 0);
const samples = numberEnv("INSTANTML_BENCH_SAMPLES", 15);
const warmups = numberEnv("INSTANTML_BENCH_WARMUPS", 2);
const includeWeb = process.env.INSTANTML_BENCH_WEB === "1";
const enforce = process.env.INSTANTML_BENCH_ENFORCE === "1";
const project = process.env.INSTANTML_BENCH_PROJECT || "bench-100k";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-large-run-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const localOrgId = "00000000-0000-0000-0000-000000000001";
const benchUserId = "00000000-0000-0000-0000-00000000b001";
const benchMembershipId = "00000000-0000-0000-0000-00000000b002";
const benchSessionId = "00000000-0000-0000-0000-00000000b003";
const benchSessionToken = "instantml_session_large_run_benchmark";
const longRunMetricKeys = Object.freeze(["eval/return_mean", "train/loss", "train/reward", "system/tokens_per_second"]);
let apiServer = null;
let webServer = null;
let clickhouse = null;
let metricCatalogRunId = null;

try {
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: `http://default:@127.0.0.1:${clickhouseHttpPort}/instantml`,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  run("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "migrate"], {
    env: { ...process.env, CLICKHOUSE_URL: clickhouse.url },
  });
  await seedBenchmarkData();

  const serverLog = path.join(tempDir, "api.log");
  const output = fs.openSync(serverLog, "w");
  apiServer = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: clickhouse.url,
      INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
      INSTANTML_AUTH_MODE: "local",
      INSTANTML_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
    },
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  await waitForHttp(`${apiBaseUrl}/readyz`, apiServer, serverLog);

  const firstPage = await fetchJson(`${apiBaseUrl}/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`);
  const firstRunId = firstPage.runs?.[0]?.id;
  if (!firstRunId) throw new Error("benchmark seed did not produce runs");
  const selectedRunIds = firstPage.runs.slice(0, Math.min(25, firstPage.runs.length)).map((run) => run.id);

  const seed13Total = seededRunsForSeed(13);
  const seed14Total = seededRunsForSeed(14);
  const llmTotal = Math.floor(runCount / 3);
  const measurements = {
    summary_newest_project: await measureEndpoint("summary_newest_project", `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_newest_project", payload, runCount);
    }),
    summary_newest_org: await measureEndpoint("summary_newest_org", `/api/runs/summary?${new URLSearchParams({ limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_newest_org", payload, runCount);
    }),
    summary_search_seed_13: await measureEndpoint("summary_search_seed_13", `/api/runs/summary?${new URLSearchParams({ project, q: "seed-13", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_search_seed_13", payload, seed13Total);
      assertRuns("summary_search_seed_13", payload, (run) => run.name.includes("seed-13") || run.tags?.includes("seed-13"));
    }),
    summary_search_tag_seed_13: await measureEndpoint("summary_search_tag_seed_13", `/api/runs/summary?${new URLSearchParams({ project, q: "tag:seed-13", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_search_tag_seed_13", payload, seed13Total);
      assertRuns("summary_search_tag_seed_13", payload, (run) => run.tags?.includes("seed-13"));
    }),
    summary_search_config_llm: await measureEndpoint("summary_search_config_llm", `/api/runs/summary?${new URLSearchParams({ project, q: "config:llm", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_search_config_llm", payload, llmTotal);
      assertRuns("summary_search_config_llm", payload, (run) => run.config?.model === "llm");
    }),
    summary_search_boolean_notes: await measureEndpoint("summary_search_boolean_notes", `/api/runs/summary?${new URLSearchParams({ project, q: "(tag:seed-13 OR tag:seed-14) notes:stability", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_search_boolean_notes", payload, seed13Total + seed14Total);
      assertRuns("summary_search_boolean_notes", payload, (run) => (run.tags?.includes("seed-13") || run.tags?.includes("seed-14")) && run.metadata?.notes?.includes("stability"));
    }),
    summary_search_regex_seed: await measureEndpoint("summary_search_regex_seed", `/api/runs/summary?${new URLSearchParams({ project, q: "re:/seed-(13|14)/", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_search_regex_seed", payload, seed13Total + seed14Total);
      assertRuns("summary_search_regex_seed", payload, (run) => /seed-(13|14)/i.test(`${run.name} ${run.tags?.join(" ") ?? ""} ${run.metadata?.notes ?? ""}`));
    }),
    summary_sort_metric_best: await measureEndpoint("summary_sort_metric_best", `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "metric-best", metric_key: "eval/return_mean" })}`, (payload) => {
      assertSummaryTotal("summary_sort_metric_best", payload, runCount);
    }),
    chart_series: await measureEndpoint("chart_series", `/runs/${firstRunId}/metrics?${new URLSearchParams({ key: "eval/return_mean", limit: "5000" })}`),
    batched_series_m4: await measureEndpoint(
      "batched_series_m4",
      "/api/metrics/series",
      (payload) => {
        if (!Array.isArray(payload.series)) throw new Error("batched_series_m4 returned malformed series payload");
        if (payload.series.length !== selectedRunIds.length) {
          throw new Error(`batched_series_m4 returned ${payload.series.length} series, expected ${selectedRunIds.length}`);
        }
        const rows = payload.series.reduce((sum, series) => sum + (Array.isArray(series.metrics) ? series.metrics.length : 0), 0);
        if (rows <= 0) throw new Error("batched_series_m4 returned no points");
        if (rows > payload.total_point_cap) throw new Error("batched_series_m4 exceeded total point cap");
        if (!Number.isFinite(Number(payload.effective_buckets))) throw new Error("batched_series_m4 did not report effective_buckets");
      },
      {
        method: "POST",
        body: {
          key: "eval/return_mean",
          run_ids: selectedRunIds,
          limit: 1000,
          buckets: 100,
        },
      },
    ),
  };
  if (wideMetricKeys > 0) {
    const metricCatalogName = `metric_catalog_${wideMetricKeys}`;
    const catalogRunId = metricCatalogRunId || firstRunId;
    measurements[metricCatalogName] = {
      ...(await measureEndpoint(metricCatalogName, `/runs/${catalogRunId}`, (payload) => {
        const run = payload.run;
        if (!run || typeof run !== "object" || Array.isArray(run)) {
          throw new Error(`${metricCatalogName} returned malformed run detail payload`);
        }
        const metricKeys = Array.isArray(run.metric_keys) ? run.metric_keys : [];
        const wideKeys = metricKeys.filter((key) => typeof key === "string" && key.startsWith("wide/metric_"));
        if (wideKeys.length !== wideMetricKeys) {
          throw new Error(`${metricCatalogName} returned ${wideKeys.length} wide metric keys, expected ${wideMetricKeys}`);
        }
        if (!run.metric_aggregates || typeof run.metric_aggregates !== "object") {
          throw new Error(`${metricCatalogName} returned malformed metric_aggregates`);
        }
        if (!Object.hasOwn(run.metric_aggregates, "wide/metric_000000")) {
          throw new Error(`${metricCatalogName} did not include the first wide metric aggregate`);
        }
        if (!Object.hasOwn(run.latest_metrics || {}, "wide/metric_000000")) {
          throw new Error(`${metricCatalogName} did not include the first wide latest metric`);
        }
      })),
      budget_ms: 5_000,
    };
  }

  let web = null;
  if (includeWeb) web = await measureWebFirstUsefulRender();
  const metricCardinality = longRunMetricKeys.length + wideMetricKeys;
  const result = {
    generated_at: new Date().toISOString(),
    environment: {
      run_count: runCount,
      long_run_steps: longRunSteps,
      long_run_metric_keys: longRunMetricKeys,
      wide_metric_keys: wideMetricKeys,
      samples,
      warmups,
      include_web: includeWeb,
      machine: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
    },
    dataset: {
      project,
      observed_runs: runCount,
      configured_runs: runCount,
      long_run_steps: longRunSteps,
      expected_steps_per_run: longRunSteps,
      steps_per_run: longRunSteps,
      metric_cardinality_per_project: metricCardinality,
      observed_metric_cardinality: metricCardinality,
      metric_keys: wideMetricKeys > 0 ? undefined : [...longRunMetricKeys],
      wide_metric_keys: wideMetricKeys,
    },
    budgets_ms: {
      summary_newest_project_p95: 300,
      summary_search_and_sort_p95: 500,
      summary_advanced_search_p95: 750,
      chart_series_p95: 200,
      batched_series_m4_p95: 250,
      metric_catalog_p95: 5000,
      web_first_useful_render: 2000,
    },
    measurements,
    web,
  };
  const failures = budgetFailures(result);
  result.passed = failures.length === 0;
  result.failures = failures;
  console.log(JSON.stringify(result, null, 2));
  if (enforce && failures.length) process.exitCode = 1;
} finally {
  if (webServer) {
    webServer.kill();
    await onceClose(webServer);
  }
  if (apiServer) {
    apiServer.kill();
    await onceClose(apiServer);
  }
  if (clickhouse) await clickhouse.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function seedBenchmarkData() {
  const now = new Date();
  const projectId = randomUUID();
  const ops = [
    opRecord("organization", localOrgId, {
      id: localOrgId,
      slug: "local",
      name: "Local",
      plan_tier: "free",
      account_type: "customer",
      seat_limit: 1,
      created_by_user_id: null,
      created_at: "1970-01-01T00:00:00Z",
    }, now),
    opRecord("user", benchUserId, {
      id: benchUserId,
      primary_email: "large-benchmark@example.com",
      display_name: "Large Benchmark",
      avatar_url: null,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    }, now),
    opRecord("membership", benchMembershipId, {
      id: benchMembershipId,
      org_id: localOrgId,
      user_id: benchUserId,
      role: "owner",
      status: "active",
      created_at: now.toISOString(),
    }, now),
    opRecord("session", benchSessionId, {
      row: {
        id: benchSessionId,
        user_id: benchUserId,
        org_id: localOrgId,
        metadata: {},
        created_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        revoked_at: null,
      },
      token_hash: Array.from(createHash("sha256").update(benchSessionToken).digest()),
    }, now),
    opRecord("project", projectId, {
      id: projectId,
      org_id: localOrgId,
      name: project,
      description: "Large run benchmark project",
      created_at: now.toISOString(),
    }, now),
  ];
  const metricRows = [];
  let newestRunId = null;
  let newestCreatedAt = null;
  let wideRunId = null;
  let wideCreatedAt = null;
  for (let index = 1; index <= runCount; index += 1) {
    const runId = randomUUID();
    const createdAt = new Date(now.getTime() - (runCount - index) * 1000);
    newestRunId = runId;
    newestCreatedAt = createdAt;
    if (index === 1) {
      wideRunId = runId;
      wideCreatedAt = createdAt;
    }
    const seed = index % 100;
    const model = index % 3 === 0 ? "llm" : "rl";
    const status = index % 97 === 0 ? "failed" : index % 11 === 0 ? "running" : "finished";
    ops.push(opRecord("run", runId, {
      id: runId,
      org_id: localOrgId,
      project_id: projectId,
      project,
      name: `bench-${String(index).padStart(6, "0")}-seed-${seed}`,
      status,
      config: {
        seed,
        model,
        optimizer: index % 2 === 0 ? "adamw" : "ppo",
        hardware: { gpu: index % 4 === 0 ? "H100" : "A100", gpu_count: 1 + (index % 8) },
      },
      tags: ["bench", `seed-${seed}`, model],
      metadata: { notes: `benchmark seed ${seed} reward stability cohort ${index % 17}` },
      created_at: createdAt.toISOString(),
      started_at: createdAt.toISOString(),
      finished_at: status === "running" ? null : new Date(createdAt.getTime() + 60_000 + (index % 500) * 1000).toISOString(),
    }, createdAt));
    metricRows.push({
      org_id: localOrgId,
      run_id: runId,
      key: "eval/return_mean",
      step: 1000,
      value: 150 + (index % 800),
      logged_at: clickhouseDate(new Date(createdAt.getTime() + 60 * 60 * 1000)),
    });
    if (ops.length >= 5000) {
      await insertOperationalRecords(ops.splice(0));
    }
    if (metricRows.length >= 5000) {
      await insertMetricPoints(metricRows.splice(0));
    }
  }
  for (let step = 1; step <= longRunSteps; step += 1) {
    for (const key of longRunMetricKeys) {
      metricRows.push({
        org_id: localOrgId,
        run_id: newestRunId,
        key,
        step,
        value: longRunMetricValue(key, step),
        logged_at: clickhouseDate(newestCreatedAt),
      });
    }
    if (metricRows.length >= 5000) {
      await insertMetricPoints(metricRows.splice(0));
    }
  }
  metricCatalogRunId = wideRunId ?? newestRunId;
  const metricCatalogLoggedAt = wideCreatedAt ?? newestCreatedAt;
  for (let index = 0; index < wideMetricKeys; index += 1) {
    metricRows.push({
      org_id: localOrgId,
      run_id: metricCatalogRunId,
      key: `wide/metric_${String(index).padStart(6, "0")}`,
      step: 1,
      value: index,
      logged_at: clickhouseDate(metricCatalogLoggedAt),
    });
    if (metricRows.length >= 5000) {
      await insertMetricPoints(metricRows.splice(0));
    }
  }
  if (ops.length) await insertOperationalRecords(ops);
  if (metricRows.length) await insertMetricPoints(metricRows);
}

function opRecord(kind, entityId, payload, createdAt) {
  return {
    kind,
    org_id: localOrgId,
    entity_id: entityId,
    payload: JSON.stringify(payload),
    created_at: clickhouseDate(createdAt),
  };
}

function longRunMetricValue(key, step) {
  if (key === "train/loss") return Math.max(0.01, 4 / Math.sqrt(step));
  if (key === "train/reward") return 50 + Math.log1p(step) * 12;
  if (key === "system/tokens_per_second") return 12_000 + Math.sin(step / 111) * 700;
  return 100 + Math.sin(step / 25) * 10 + step / 100;
}

async function insertOperationalRecords(records) {
  await clickhousePost(
    clickhouse.url,
    "INSERT INTO operational_records (kind, org_id, entity_id, payload, created_at) FORMAT JSONEachRow",
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

async function insertMetricPoints(points) {
  await clickhousePost(
    clickhouse.url,
    "INSERT INTO metric_points (org_id, run_id, key, step, value, logged_at) FORMAT JSONEachRow",
    points.map((point) => JSON.stringify(point)).join("\n"),
  );
}

async function measureEndpoint(name, pathSuffix, validate, options = {}) {
  for (let index = 0; index < warmups; index += 1) await fetchJson(apiBaseUrl + pathSuffix, options);
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const payload = await fetchJson(apiBaseUrl + pathSuffix, options);
    timings.push(performance.now() - started);
    if (name.startsWith("summary") && !Array.isArray(payload.runs)) throw new Error(`${name} returned malformed runs payload`);
    if (name === "chart_series" && !Array.isArray(payload.metrics)) throw new Error("chart_series returned malformed metrics payload");
    if (validate) validate(payload);
  }
  return summarize(timings);
}

function seededRunsForSeed(seed) {
  let count = 0;
  for (let index = 1; index <= runCount; index += 1) {
    if (index % 100 === seed) count += 1;
  }
  return count;
}

function assertSummaryTotal(name, payload, expected) {
  if (payload.total !== expected) {
    throw new Error(`${name} returned total ${payload.total}, expected ${expected}`);
  }
}

function assertRuns(name, payload, predicate) {
  const badRun = payload.runs.find((run) => !predicate(run));
  if (badRun) throw new Error(`${name} returned non-matching run ${badRun.id || badRun.name}`);
}

async function measureWebFirstUsefulRender() {
  const webPort = await freePort();
  const nextBin = path.join(repo, "node_modules/.bin/next");
  run(nextBin, ["build"], {
    cwd: path.join(repo, "apps/web"),
    env: { ...process.env, INSTANTML_API_BASE: apiBaseUrl },
  });
  webServer = spawn(nextBin, ["start", "--port", String(webPort)], {
    cwd: path.join(repo, "apps/web"),
    env: { ...process.env, INSTANTML_API_BASE: apiBaseUrl },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${webPort}`, webServer, null);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().addCookies([{
      name: "instantml_session",
      value: benchSessionToken,
      url: `http://127.0.0.1:${webPort}`,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    const started = performance.now();
    await page.goto(`http://127.0.0.1:${webPort}/dashboard/runs`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".workspace-run-row", { timeout: 30_000 });
    const first_useful_render_ms = Math.round(performance.now() - started);
    const text = await page.locator(".workspace-run-footer").innerText();
    return { first_useful_render_ms, footer: text };
  } finally {
    await browser.close();
  }
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

function budgetFailures(result) {
  const failures = [];
  if (result.measurements.summary_newest_project.p95_ms > result.budgets_ms.summary_newest_project_p95) failures.push("summary_newest_project p95 exceeded 300 ms");
  for (const key of ["summary_search_seed_13", "summary_sort_metric_best"]) {
    if (result.measurements[key].p95_ms > result.budgets_ms.summary_search_and_sort_p95) failures.push(`${key} p95 exceeded 500 ms`);
  }
  for (const key of ["summary_search_tag_seed_13", "summary_search_config_llm", "summary_search_boolean_notes", "summary_search_regex_seed"]) {
    if (result.measurements[key].p95_ms > result.budgets_ms.summary_advanced_search_p95) failures.push(`${key} p95 exceeded 750 ms`);
  }
  if (result.measurements.chart_series.p95_ms > result.budgets_ms.chart_series_p95) failures.push("chart_series p95 exceeded 200 ms");
  if (result.measurements.batched_series_m4.p95_ms > result.budgets_ms.batched_series_m4_p95) failures.push("batched_series_m4 p95 exceeded 250 ms");
  for (const [key, measurement] of Object.entries(result.measurements)) {
    if (key.startsWith("metric_catalog_") && measurement.p95_ms > result.budgets_ms.metric_catalog_p95) {
      failures.push(`${key} p95 exceeded 5000 ms`);
    }
  }
  if (result.web && result.web.first_useful_render_ms > result.budgets_ms.web_first_useful_render) failures.push("web first useful render exceeded 2000 ms");
  return failures;
}

async function fetchJson(url, options = {}) {
  const headers = {};
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body,
  });
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function clickhouseDate(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
}

function nonNegativeNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
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
  while (Date.now() - started < 60_000) {
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
