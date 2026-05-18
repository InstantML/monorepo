#!/usr/bin/env node
/**
 * M4 chart-aggregation benchmark.
 *
 * Seeds a disposable ClickHouse instance with a 200k-point metric series that
 * includes a known spike, then measures the `POST /api/metrics/series` endpoint
 * with `buckets=1000` and without, confirming:
 *
 *   1. The spike at step 180000 is present in the M4 response.
 *   2. M4 p95 latency is < 100 ms locally.
 *   3. Raw prefix-limit (1000 points) returns at most 1000 points.
 *
 * Usage:
 *   node tools/rust-m4-benchmark.mjs
 *
 * Environment overrides:
 *   INSTANTML_M4_BENCH_POINTS    Total points to seed (default 200000)
 *   INSTANTML_M4_BENCH_SAMPLES   Measurement samples per endpoint (default 10)
 *   INSTANTML_M4_BENCH_WARMUPS   Warmup rounds (default 2)
 *   INSTANTML_M4_BENCH_ENFORCE   Set to "1" to fail when p95 budget is missed
 *   INSTANTML_M4_RESULT_PATH     Write JSON result to this path when set
 */

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { clickhousePost, ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const totalPoints = numberEnv("INSTANTML_M4_BENCH_POINTS", 200_000);
const samples = numberEnv("INSTANTML_M4_BENCH_SAMPLES", 10);
const warmups = numberEnv("INSTANTML_M4_BENCH_WARMUPS", 2);
const enforce = process.env.INSTANTML_M4_BENCH_ENFORCE === "1";
const resultPath = process.env.INSTANTML_M4_RESULT_PATH || null;

// The spike step and value embedded in the seeded data.
const SPIKE_STEP = 180_000;
const SPIKE_VALUE = 99.0;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-m4-bench-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const localOrgId = "00000000-0000-0000-0000-000000000001";

let apiServer = null;
let clickhouse = null;

try {
  // -------------------------------------------------------------------------
  // Start ClickHouse and migrate
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Seed a 200k-point series with a spike at step 180k
  // -------------------------------------------------------------------------
  const runId = randomUUID();
  const metricKey = "train/loss";

  console.log(`Seeding ${totalPoints} metric points (run ${runId})...`);
  await seedMetricPoints(clickhouse.url, localOrgId, runId, metricKey, totalPoints, SPIKE_STEP, SPIKE_VALUE);
  console.log("Seed complete.");

  // -------------------------------------------------------------------------
  // Start the Rust API
  // -------------------------------------------------------------------------
  const serverLog = path.join(tempDir, "api.log");
  const output = fs.openSync(serverLog, "w");
  apiServer = spawn(
    "cargo",
    ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"],
    {
      cwd: repo,
      env: {
        ...process.env,
        CLICKHOUSE_URL: clickhouse.url,
        INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
        INSTANTML_AUTH_MODE: "local",
        INSTANTML_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
      },
      stdio: ["ignore", output, output],
    },
  );
  await waitForApi(`${apiBaseUrl}/health`);
  console.log("API started.");

  // -------------------------------------------------------------------------
  // Measure: M4 with buckets=1000
  // -------------------------------------------------------------------------
  const m4Body = JSON.stringify({
    key: metricKey,
    run_ids: [runId],
    limit: 1000,
    buckets: 1000,
  });

  console.log(`\nMeasuring M4 (buckets=1000) over ${warmups} warmups + ${samples} samples...`);
  await measure("m4_warmup", warmups, () => postSeries(m4Body));
  const m4Times = await measure("m4", samples, () => postSeries(m4Body));
  const m4P95 = percentile(m4Times, 95);
  const m4Median = percentile(m4Times, 50);
  console.log(`  M4 median: ${m4Median.toFixed(1)} ms  p95: ${m4P95.toFixed(1)} ms`);

  // Verify spike is preserved in M4 response.
  const m4Payload = await postSeries(m4Body);
  const m4Points = m4Payload.series?.[0]?.metrics ?? [];
  const spikePresent = m4Points.some(
    (p) => Math.abs(p.step - SPIKE_STEP) < 1 && Math.abs(p.value - SPIKE_VALUE) < 0.01,
  );
  if (!spikePresent) {
    throw new Error(
      `M4 response did not contain the spike at step ${SPIKE_STEP} value ${SPIKE_VALUE}. ` +
        `Got ${m4Points.length} points. Spike survival is a correctness invariant.`,
    );
  }
  console.log(`  Spike at step ${SPIKE_STEP} value ${SPIKE_VALUE}: PRESENT in M4 response.`);
  console.log(`  M4 returned ${m4Points.length} points (expected <= 4000).`);
  if (m4Points.length > 4000) {
    throw new Error(`M4 returned ${m4Points.length} points but max is 4 * 1000 = 4000.`);
  }

  // -------------------------------------------------------------------------
  // Measure: raw prefix limit (no M4)
  // -------------------------------------------------------------------------
  const rawBody = JSON.stringify({
    key: metricKey,
    run_ids: [runId],
    limit: 1000,
  });

  console.log(`\nMeasuring raw prefix-limit (limit=1000) over ${warmups} warmups + ${samples} samples...`);
  await measure("raw_warmup", warmups, () => postSeries(rawBody));
  const rawTimes = await measure("raw", samples, () => postSeries(rawBody));
  const rawP95 = percentile(rawTimes, 95);
  const rawMedian = percentile(rawTimes, 50);
  console.log(`  Raw median: ${rawMedian.toFixed(1)} ms  p95: ${rawP95.toFixed(1)} ms`);

  const rawPayload = await postSeries(rawBody);
  const rawPoints = rawPayload.series?.[0]?.metrics ?? [];
  if (rawPoints.length > 1000) {
    throw new Error(`Raw path returned ${rawPoints.length} points but limit is 1000.`);
  }
  const spikeInRaw = rawPoints.some(
    (p) => Math.abs(p.step - SPIKE_STEP) < 1,
  );
  console.log(`  Raw returned ${rawPoints.length} points.`);
  console.log(`  Spike at step ${SPIKE_STEP}: ${spikeInRaw ? "PRESENT (unlikely)" : "ABSENT (expected)"} in raw prefix response.`);

  // -------------------------------------------------------------------------
  // Results summary
  // -------------------------------------------------------------------------
  const result = {
    timestamp: new Date().toISOString(),
    total_points: totalPoints,
    spike_step: SPIKE_STEP,
    spike_value: SPIKE_VALUE,
    m4_buckets: 1000,
    m4: {
      median_ms: parseFloat(m4Median.toFixed(2)),
      p95_ms: parseFloat(m4P95.toFixed(2)),
      points_returned: m4Points.length,
      spike_present: spikePresent,
    },
    raw: {
      median_ms: parseFloat(rawMedian.toFixed(2)),
      p95_ms: parseFloat(rawP95.toFixed(2)),
      points_returned: rawPoints.length,
      spike_present: spikeInRaw,
    },
    budgets_ms: {
      m4_p95: 100,
    },
  };

  const passed = result.m4.p95_ms <= result.budgets_ms.m4_p95;
  console.log(`\n--- M4 Benchmark Results ---`);
  console.log(`  ${totalPoints} points  →  M4 median ${result.m4.median_ms} ms, p95 ${result.m4.p95_ms} ms`);
  console.log(`  Raw prefix  →  median ${result.raw.median_ms} ms, p95 ${result.raw.p95_ms} ms`);
  console.log(`  Spike survival: ${result.m4.spike_present ? "PASS" : "FAIL"}`);
  console.log(`  M4 p95 budget (< ${result.budgets_ms.m4_p95} ms): ${passed ? "PASS" : "OVER BUDGET"}`);

  if (resultPath) {
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(`Result written to ${resultPath}`);
  }

  if (enforce && !passed) {
    throw new Error(`M4 p95 ${result.m4.p95_ms} ms exceeded budget of ${result.budgets_ms.m4_p95} ms`);
  }

  console.log("\nDone.");
} finally {
  if (apiServer) apiServer.kill();
  if (clickhouse?.proc) clickhouse.proc.kill();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedMetricPoints(clickhouseUrl, orgId, runId, key, count, spikeStep, spikeValue) {
  const batchSize = 10_000;
  const now = new Date().toISOString();
  for (let offset = 0; offset < count; offset += batchSize) {
    const rows = [];
    for (let i = 0; i < batchSize && offset + i < count; i++) {
      const step = offset + i;
      // Insert the spike as a distinct high-value row; all others trend 0..1.
      const value = step === spikeStep ? spikeValue : (step % 100) / 100.0;
      rows.push(`('${orgId}','${runId}','${key}',${step},${value},'${now}','${now}')`);
    }
    const sql = `INSERT INTO metric_points (org_id, run_id, key, step, value, logged_at, created_at) VALUES ${rows.join(",")}`;
    await clickhousePost(clickhouseUrl, sql);
  }
}

async function postSeries(bodyJson) {
  const url = `${apiBaseUrl}/api/metrics/series`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyJson,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /api/metrics/series failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function measure(label, n, fn) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return times;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function waitForApi(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API at ${url} did not become ready within ${timeoutMs} ms`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repo,
    stdio: "inherit",
    ...opts,
  });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${result.status}`);
}

async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function numberEnv(key, fallback) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
