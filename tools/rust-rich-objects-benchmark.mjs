#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { clickhousePost, ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const objectCount = numberEnv("INSTANTML_OBJECT_BENCH_OBJECTS", 500);
const tableRows = numberEnv("INSTANTML_OBJECT_BENCH_ROWS", 1000);
const samples = numberEnv("INSTANTML_OBJECT_BENCH_SAMPLES", 15);
const warmups = numberEnv("INSTANTML_OBJECT_BENCH_WARMUPS", 2);
const enforce = process.env.INSTANTML_BENCH_ENFORCE === "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-rich-objects-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const localOrgId = "00000000-0000-0000-0000-000000000001";
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

  const project = await fetchJson(`${apiBaseUrl}/api/runs/summary?project=object-bench&limit=1`);
  const runId = project.runs?.[0]?.id;
  if (!runId) throw new Error("object benchmark seed did not produce a run");
  const objects = await fetchJson(`${apiBaseUrl}/api/runs/${runId}/objects?kind=table&limit=1`);
  const objectId = objects.objects?.[0]?.id;
  if (!objectId) throw new Error("object benchmark seed did not produce a table object");

  const measurements = {
    object_list_500: await measureEndpoint("object_list_500", `/api/runs/${runId}/objects?limit=500`),
    object_list_tables: await measureEndpoint("object_list_tables", `/api/runs/${runId}/objects?kind=table&limit=100`),
    table_rows_1000: await measureEndpoint("table_rows_1000", `/api/objects/${objectId}/rows?limit=1000`),
  };
  const result = {
    generated_at: new Date().toISOString(),
    environment: {
      object_count: objectCount,
      table_rows: tableRows,
      samples,
      warmups,
      machine: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
    },
    budgets_ms: {
      object_list_p95: 100,
      table_rows_p95: 100,
    },
    measurements,
  };
  const failures = [];
  if (measurements.object_list_500.p95_ms > result.budgets_ms.object_list_p95) failures.push("object_list_500");
  if (measurements.object_list_tables.p95_ms > result.budgets_ms.object_list_p95) failures.push("object_list_tables");
  if (measurements.table_rows_1000.p95_ms > result.budgets_ms.table_rows_p95) failures.push("table_rows_1000");
  result.passed = failures.length === 0;
  result.failures = failures;
  console.log(JSON.stringify(result, null, 2));
  if (enforce && failures.length) process.exitCode = 1;
} finally {
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
  const runId = randomUUID();
  const records = [
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
    opRecord("project", projectId, {
      id: projectId,
      org_id: localOrgId,
      name: "object-bench",
      description: "Rich object benchmark project",
      created_at: now.toISOString(),
    }, now),
    opRecord("run", runId, {
      id: runId,
      org_id: localOrgId,
      project_id: projectId,
      project: "object-bench",
      name: "object-bench-run",
      status: "finished",
      config: {},
      tags: ["bench"],
      metadata: {},
      created_at: now.toISOString(),
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
    }, now),
  ];
  const half = Math.floor(objectCount / 2);
  for (let index = 1; index <= half; index += 1) {
    records.push(opRecord("attribute", String(index), {
      id: index,
      org_id: localOrgId,
      run_id: runId,
      path: `eval/table-${index}`,
      type: "table",
      step: index,
      logged_at: now.toISOString(),
      value: { kind: "table", metadata: { bench: true } },
      summary: { columns: ["prompt", "score"], row_count: index === 1 ? tableRows : 5 },
      artifact_id: null,
      created_at: now.toISOString(),
    }, now));
  }
  for (let index = 1; index <= objectCount - half; index += 1) {
    const id = half + index;
    records.push(opRecord("attribute", String(id), {
      id,
      org_id: localOrgId,
      run_id: runId,
      path: `eval/histogram-${index}`,
      type: "histogram_series",
      step: index,
      logged_at: now.toISOString(),
      value: { bins: [0, 1, 2, 3], counts: [index % 7, index % 11, index % 13] },
      summary: {},
      artifact_id: null,
      created_at: now.toISOString(),
    }, now));
  }
  records.push(opRecord("table_rows", "1", {
    attribute_id: 1,
    rows: Array.from({ length: tableRows }, (_, index) => ({
      row_index: index,
      row: { prompt: `prompt-${index + 1}`, score: (index + 1) / tableRows },
      created_at: now.toISOString(),
    })),
  }, now));
  await insertOperationalRecords(records);
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

async function insertOperationalRecords(records) {
  await clickhousePost(
    clickhouse.url,
    "INSERT INTO operational_records (kind, org_id, entity_id, payload, created_at) FORMAT JSONEachRow",
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

async function measureEndpoint(name, pathSuffix) {
  for (let index = 0; index < warmups; index += 1) await fetchJson(apiBaseUrl + pathSuffix);
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const payload = await fetchJson(apiBaseUrl + pathSuffix);
    timings.push(performance.now() - started);
    if (name.startsWith("object") && !Array.isArray(payload.objects)) throw new Error(`${name} returned malformed objects payload`);
    if (name.startsWith("table") && !Array.isArray(payload.rows)) throw new Error(`${name} returned malformed rows payload`);
  }
  return summarize(timings);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json();
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    min_ms: round(sorted[0]),
    median_ms: round(percentile(50)),
    p95_ms: round(percentile(95)),
    max_ms: round(sorted[sorted.length - 1]),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: options.env || process.env,
    stdio: options.stdio ?? "inherit",
  });
  if (!options.allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result;
}

function clickhouseDate(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function waitForHttp(url, processHandle, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle?.exitCode !== null) {
      const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      throw new Error(`process exited before ${url} was ready\n${log}`);
    }
    if (await httpOk(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  throw new Error(`timed out waiting for ${url}\n${log}`);
}

function httpOk(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function onceClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function numberEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
