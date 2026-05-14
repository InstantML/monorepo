#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const objectCount = numberEnv("RLOBS_OBJECT_BENCH_OBJECTS", 500);
const tableRows = numberEnv("RLOBS_OBJECT_BENCH_ROWS", 1000);
const samples = numberEnv("RLOBS_OBJECT_BENCH_SAMPLES", 15);
const warmups = numberEnv("RLOBS_OBJECT_BENCH_WARMUPS", 2);
const enforce = process.env.RLOBS_BENCH_ENFORCE === "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlobs-rich-objects-"));
const pgPort = await freePort();
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const databaseUrl = `postgres://127.0.0.1:${pgPort}/rlobs_object_bench`;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
let apiServer = null;
let clickhouse = null;

try {
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: `http://default:@127.0.0.1:${clickhouseHttpPort}/rlobs`,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  const dataDir = path.join(tempDir, "data");
  run("initdb", ["-D", dataDir, "--auth=trust"], { stdio: ["ignore", "ignore", "inherit"] });
  run("pg_ctl", [
    "-D",
    dataDir,
    "-o",
    `-p ${pgPort} -c listen_addresses='127.0.0.1'`,
    "-l",
    path.join(tempDir, "postgres.log"),
    "start",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  run("createdb", ["-h", "127.0.0.1", "-p", String(pgPort), "rlobs_object_bench"]);
  run("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl, CLICKHOUSE_URL: clickhouse.url },
  });
  seedBenchmarkData();
  const serverLog = path.join(tempDir, "api.log");
  const output = fs.openSync(serverLog, "w");
  apiServer = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CLICKHOUSE_URL: clickhouse.url,
      RLOBS_BIND_ADDR: `127.0.0.1:${apiPort}`,
      RLOBS_AUTH_MODE: "local",
      RLOBS_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
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
  run("pg_ctl", ["-D", path.join(tempDir, "data"), "stop", "-m", "fast"], { allowFailure: true, stdio: ["ignore", "ignore", "ignore"] });
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function seedBenchmarkData() {
  const sqlPath = path.join(tempDir, "seed.sql");
  fs.writeFileSync(sqlPath, benchmarkSql(), "utf8");
  run("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", sqlPath], { stdio: ["ignore", "inherit", "inherit"] });
}

function benchmarkSql() {
  return `
delete from projects where org_id = '00000000-0000-0000-0000-000000000001' and name = 'object-bench';
insert into projects (org_id, name) values ('00000000-0000-0000-0000-000000000001', 'object-bench');

with project as (
  select id from projects where org_id = '00000000-0000-0000-0000-000000000001' and name = 'object-bench'
)
insert into runs (org_id, project_id, name, status, config, tags, metadata)
select '00000000-0000-0000-0000-000000000001', project.id, 'object-bench-run', 'finished', '{}'::jsonb, array['bench'], '{}'::jsonb
from project;

with run as (
  select id from runs where org_id = '00000000-0000-0000-0000-000000000001' and name = 'object-bench-run'
)
insert into attributes (org_id, run_id, path, type, step, logged_at, value, summary)
select
  '00000000-0000-0000-0000-000000000001',
  run.id,
  format('eval/table-%s', gs),
  'table',
  gs,
  now(),
  jsonb_build_object('kind', 'table', 'metadata', jsonb_build_object('bench', true)),
  jsonb_build_object('columns', jsonb_build_array('prompt', 'score'), 'row_count', case when gs = 1 then ${tableRows} else 5 end)
from run, generate_series(1, ${Math.floor(objectCount / 2)}) as gs;

with run as (
  select id from runs where org_id = '00000000-0000-0000-0000-000000000001' and name = 'object-bench-run'
)
insert into attributes (org_id, run_id, path, type, step, logged_at, value, summary)
select
  '00000000-0000-0000-0000-000000000001',
  run.id,
  format('eval/histogram-%s', gs),
  'histogram_series',
  gs,
  now(),
  jsonb_build_object('bins', jsonb_build_array(0, 1, 2, 3), 'counts', jsonb_build_array(gs % 7, gs % 11, gs % 13)),
  '{}'::jsonb
from run, generate_series(1, ${objectCount - Math.floor(objectCount / 2)}) as gs;

with table_object as (
  select org_id, id as attribute_id from attributes where path = 'eval/table-1'
)
insert into table_object_rows (org_id, attribute_id, row_index, row)
select
  table_object.org_id,
  table_object.attribute_id,
  gs - 1,
  jsonb_build_object('prompt', format('prompt-%s', gs), 'score', gs / ${tableRows}.0)
from table_object, generate_series(1, ${tableRows}) as gs;

analyze attributes;
analyze table_object_rows;
  `;
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
    env: process.env,
    stdio: options.stdio ?? "inherit",
    ...options,
  });
  if (!options.allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result;
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
