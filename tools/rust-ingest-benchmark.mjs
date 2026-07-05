#!/usr/bin/env node
// Measures the metric ingest write path through the Rust API end to end:
// single-point POST /runs/{id}/metrics versus batched POST
// /runs/{id}/metrics/batch. This is the write-side counterpart to
// rust-large-run-benchmark.mjs, which seeds ClickHouse directly and only times
// read endpoints. It exercises the batch ingest endpoint, ClickHouse async
// inserts, and the per-org write-gate usage cache together, since all three
// sit on this path.
//
// It runs against a disposable loopback ClickHouse and a local-auth Rust API,
// so no credentials, hosted warehouse, or network are involved. Local auth
// mode resolves unauthenticated tenant requests to LOCAL_ORG_ID, so the ingest
// POSTs need no bearer token.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const totalPoints = numberEnv("INSTANTML_INGEST_BENCH_POINTS", 20_000);
const metricsPerPoint = numberEnv("INSTANTML_INGEST_BENCH_METRICS_PER_POINT", 6);
const batchSizes = listEnv("INSTANTML_INGEST_BENCH_BATCH_SIZES", [50, 200, 500]);
const concurrency = numberEnv("INSTANTML_INGEST_BENCH_CONCURRENCY", 8);
const warmupPoints = nonNegativeNumberEnv("INSTANTML_INGEST_BENCH_WARMUP_POINTS", 500);
const enforce = process.env.INSTANTML_INGEST_BENCH_ENFORCE === "1";
const project = process.env.INSTANTML_INGEST_BENCH_PROJECT || "ingest-bench";
const outputJson = process.env.INSTANTML_INGEST_BENCH_RESULT_PATH || null;
// Debug builds inflate absolute per-request latency; use release for committed
// throughput numbers. cargoArgs threads the profile into migrate and serve.
const releaseBuild = process.env.INSTANTML_INGEST_BENCH_RELEASE === "1";
const cargoProfileArgs = releaseBuild ? ["--release"] : [];

const MAX_BATCH_POINTS = 500;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-ingest-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

for (const size of batchSizes) {
  if (size > MAX_BATCH_POINTS) {
    throw new Error(`batch size ${size} exceeds the server cap of ${MAX_BATCH_POINTS} points/request`);
  }
}

let apiServer = null;
let clickhouse = null;

try {
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: `http://default:@127.0.0.1:${clickhouseHttpPort}/instantml`,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  run("cargo", ["run", ...cargoProfileArgs, "--manifest-path", "apps/rust-server/Cargo.toml", "--", "migrate"], {
    env: { ...process.env, CLICKHOUSE_URL: clickhouse.url },
  });

  const serverLog = path.join(tempDir, "api.log");
  const output = fs.openSync(serverLog, "w");
  apiServer = spawn("cargo", ["run", ...cargoProfileArgs, "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: clickhouse.url,
      INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
      INSTANTML_AUTH_MODE: "local",
      INSTANTML_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
      // Local-only flag (config ignores it outside local auth mode). Without it
      // the per-credential ingest limiter caps every case at the same rps and
      // the write-side comparison measures the limiter, not the server.
      INSTANTML_TEST_DISABLE_RATE_LIMIT: "1",
    },
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  await waitForHttp(`${apiBaseUrl}/readyz`, apiServer, serverLog);

  await fetchJson(`${apiBaseUrl}/projects`, { method: "POST", body: { name: project } });

  const cases = [];

  // Single-point path: the legacy per-log endpoint, one HTTP request and one
  // capacity check per point. Serves as the baseline the batch path improves on.
  cases.push(await measureCase("single_point", 1));

  // Batched path: the new /metrics/batch endpoint. One request, one capacity
  // check, and one ClickHouse insert cover up to 500 points.
  for (const size of batchSizes) {
    cases.push(await measureCase(`batch_${size}`, size));
  }

  const baseline = cases.find((entry) => entry.case === "single_point");
  const results = {
    generated_at: new Date().toISOString(),
    git: gitMetadata(),
    environment: {
      points_per_case: totalPoints,
      metrics_per_point: metricsPerPoint,
      warmup_points: warmupPoints,
      concurrency,
      machine: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
      cpu: cpuBrand(),
      build_profile: releaseBuild ? "release" : "debug",
    },
    protocol: {
      batch_sizes: batchSizes,
      max_batch_points: MAX_BATCH_POINTS,
      auth_mode: "local",
      notes: [
        "Each case logs the same total point count to one run; batch cases pack points into /runs/{id}/metrics/batch requests, the single case uses /runs/{id}/metrics.",
        "Throughput is wall-clock points/second across the whole case at the configured request concurrency; latency percentiles are per HTTP request.",
        "The write-gate usage cache, ClickHouse async inserts, and the batch endpoint all sit on this path, so the batch speedup reflects their combined effect versus per-point ingest.",
        "Local disposable ClickHouse and local auth mode: no credentials, hosted warehouse, or network egress.",
      ],
    },
    cases,
    speedups: baseline
      ? Object.fromEntries(
          cases
            .filter((entry) => entry.case !== "single_point")
            .map((entry) => [entry.case, round(entry.points_per_second / baseline.points_per_second, 2)]),
        )
      : {},
  };

  const failures = budgetFailures(results);
  results.passed = failures.length === 0;
  results.failures = failures;

  console.log(JSON.stringify(results, null, 2));
  if (outputJson) {
    fs.mkdirSync(path.dirname(path.resolve(outputJson)), { recursive: true });
    fs.writeFileSync(outputJson, JSON.stringify(results, null, 2) + "\n");
  }
  if (enforce && failures.length) process.exitCode = 1;
} finally {
  if (apiServer) {
    apiServer.kill();
    await onceClose(apiServer);
  }
  if (clickhouse) await clickhouse.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function measureCase(name, batchSize) {
  const runId = await createRun(name);
  if (warmupPoints > 0) await drivePoints(runId, warmupPoints, batchSize, 0);

  const latencies = [];
  const wallStart = performance.now();
  const requests = await drivePoints(runId, totalPoints, batchSize, warmupPoints, latencies);
  const wallSeconds = (performance.now() - wallStart) / 1000;

  const summary = summarize(latencies);
  return {
    case: name,
    batch_size: batchSize,
    points: totalPoints,
    requests,
    wall_seconds: round(wallSeconds, 4),
    points_per_second: round(totalPoints / wallSeconds, 1),
    requests_per_second: round(requests / wallSeconds, 1),
    request_latency_ms: summary,
  };
}

// Drives `count` points to the run in HTTP requests of `batchSize` points,
// keeping `concurrency` requests in flight. `stepBase` offsets the monotonic
// step so warmup and measured phases never collide on (run, key, step).
async function drivePoints(runId, count, batchSize, stepBase, latencies = null) {
  const tasks = buildRequests(runId, count, batchSize, stepBase);
  let next = 0;
  let issued = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      const started = latencies ? performance.now() : 0;
      await fetchJson(task.url, { method: "POST", body: task.body });
      if (latencies) latencies.push(performance.now() - started);
      issued += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return issued;
}

function buildRequests(runId, count, batchSize, stepBase) {
  const tasks = [];
  let step = stepBase;
  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    if (batchSize === 1) {
      tasks.push({
        url: `${apiBaseUrl}/runs/${runId}/metrics`,
        body: { metrics: metricsFor(step), step },
      });
      step += 1;
    } else {
      const points = [];
      for (let i = 0; i < size; i += 1) {
        points.push({ metrics: metricsFor(step), step });
        step += 1;
      }
      tasks.push({ url: `${apiBaseUrl}/runs/${runId}/metrics/batch`, body: { points } });
    }
  }
  return tasks;
}

function metricsFor(step) {
  const metrics = {};
  for (let i = 0; i < metricsPerPoint; i += 1) {
    metrics[`train/metric_${String(i).padStart(2, "0")}`] = Math.sin(step / (i + 3)) + i;
  }
  return metrics;
}

async function createRun(name) {
  const payload = await fetchJson(`${apiBaseUrl}/runs`, {
    method: "POST",
    body: { project, name: `${project}-${name}` },
  });
  const runId = payload.run?.id || payload.id;
  if (!runId) throw new Error(`run creation for ${name} did not return an id`);
  return runId;
}

function budgetFailures(results) {
  const failures = [];
  const baseline = results.cases.find((entry) => entry.case === "single_point");
  const largestBatch = results.cases
    .filter((entry) => entry.case !== "single_point")
    .sort((a, b) => b.batch_size - a.batch_size)[0];
  // The batch path must beat per-point ingest; if it does not, async inserts or
  // the batch endpoint regressed. A conservative floor avoids machine-dependent
  // flakiness while still catching a lost speedup.
  if (baseline && largestBatch && largestBatch.points_per_second < baseline.points_per_second * 2) {
    failures.push(
      `${largestBatch.case} throughput ${largestBatch.points_per_second}/s did not reach 2x the single-point baseline ${baseline.points_per_second}/s`,
    );
  }
  return failures;
}

function summarize(values) {
  if (!values.length) return { samples: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: round(percentile(sorted, 0.5), 3),
    p95: round(percentile(sorted, 0.95), 3),
    p99: round(percentile(sorted, 0.99), 3),
    max: round(sorted[sorted.length - 1], 3),
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, index)];
}

async function fetchJson(url, options = {}) {
  const headers = {};
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(url, { method: options.method || "GET", headers, body });
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

function gitMetadata() {
  const gitOutput = (args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    branch: gitOutput(["branch", "--show-current"]),
    commit: gitOutput(["rev-parse", "HEAD"]),
    working_tree_dirty: gitOutput(["status", "--short"]) ? "true" : "false",
  };
}

function cpuBrand() {
  if (process.platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  return os.cpus()?.[0]?.model || null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

function listEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.floor(entry));
  if (!values.length) throw new Error(`${name} must list at least one positive batch size`);
  return values;
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
