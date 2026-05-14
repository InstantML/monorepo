#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { clickhousePost, ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const runCount = numberEnv("RLOBS_BENCH_RUNS", 90_000);
const samples = numberEnv("RLOBS_BENCH_SAMPLES", 15);
const warmups = numberEnv("RLOBS_BENCH_WARMUPS", 2);
const includeWeb = process.env.RLOBS_BENCH_WEB === "1";
const enforce = process.env.RLOBS_BENCH_ENFORCE === "1";
const project = process.env.RLOBS_BENCH_PROJECT || "bench-90k";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlobs-large-run-"));
const pgPort = await freePort();
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const databaseUrl = `postgres://127.0.0.1:${pgPort}/rlobs_bench`;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
let apiServer = null;
let webServer = null;
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
  run("createdb", ["-h", "127.0.0.1", "-p", String(pgPort), "rlobs_bench"]);
  run("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl, CLICKHOUSE_URL: clickhouse.url },
  });
  await seedBenchmarkData();
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

  const firstPage = await fetchJson(`${apiBaseUrl}/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`);
  const firstRunId = firstPage.runs?.[0]?.id;
  if (!firstRunId) throw new Error("benchmark seed did not produce runs");

  const measurements = {
    summary_newest_project: await measureEndpoint("summary_newest_project", `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`),
    summary_newest_org: await measureEndpoint("summary_newest_org", `/api/runs/summary?${new URLSearchParams({ limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`),
    summary_search_seed_13: await measureEndpoint("summary_search_seed_13", `/api/runs/summary?${new URLSearchParams({ project, q: "seed 13", limit: "25", sort_by: "created", metric_key: "eval/return_mean" })}`),
    summary_sort_metric_best: await measureEndpoint("summary_sort_metric_best", `/api/runs/summary?${new URLSearchParams({ project, limit: "25", sort_by: "metric-best", metric_key: "eval/return_mean" })}`),
    chart_series: await measureEndpoint("chart_series", `/runs/${firstRunId}/metrics?${new URLSearchParams({ key: "eval/return_mean", limit: "1000" })}`),
  };

  let web = null;
  if (includeWeb) web = await measureWebFirstUsefulRender();
  const result = {
    generated_at: new Date().toISOString(),
    environment: {
      run_count: runCount,
      samples,
      warmups,
      include_web: includeWeb,
      machine: os.hostname(),
      platform: `${process.platform} ${process.arch}`,
    },
    budgets_ms: {
      summary_newest_project_p95: 300,
      summary_search_and_sort_p95: 500,
      chart_series_p95: 200,
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
  run("pg_ctl", ["-D", path.join(tempDir, "data"), "stop", "-m", "fast"], { allowFailure: true, stdio: ["ignore", "ignore", "ignore"] });
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function seedBenchmarkData() {
  const sqlPath = path.join(tempDir, "seed.sql");
  fs.writeFileSync(sqlPath, benchmarkSql(), "utf8");
  run("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", sqlPath], { stdio: ["ignore", "inherit", "inherit"] });
  const metricRows = psqlCapture(metricSeedCopySql());
  await clickhousePost(clickhouse.url, "INSERT INTO metric_points (org_id, run_id, key, step, value, logged_at) FORMAT TabSeparated", metricRows);
}

function benchmarkSql() {
  const escapedProject = project.replaceAll("'", "''");
  return `
delete from projects where org_id = '00000000-0000-0000-0000-000000000001' and name = '${escapedProject}';
insert into projects (org_id, name)
values ('00000000-0000-0000-0000-000000000001', '${escapedProject}');

with project as (
  select id from projects where org_id = '00000000-0000-0000-0000-000000000001' and name = '${escapedProject}'
)
insert into runs (org_id, project_id, name, status, config, tags, metadata, created_at, started_at, finished_at)
select
  '00000000-0000-0000-0000-000000000001',
  project.id,
  format('bench-%s-seed-%s', lpad(gs::text, 6, '0'), gs % 100),
  case when gs % 97 = 0 then 'failed' when gs % 11 = 0 then 'running' else 'finished' end,
  jsonb_build_object(
    'seed', gs % 100,
    'model', case when gs % 3 = 0 then 'llm' else 'rl' end,
    'optimizer', case when gs % 2 = 0 then 'adamw' else 'ppo' end,
    'hardware', jsonb_build_object('gpu', case when gs % 4 = 0 then 'H100' else 'A100' end, 'gpu_count', 1 + gs % 8)
  ),
  array['bench', format('seed-%s', gs % 100), case when gs % 3 = 0 then 'llm' else 'rl' end],
  jsonb_build_object('notes', format('benchmark seed %s reward stability cohort %s', gs % 100, gs % 17)),
  now() - ((${runCount} - gs) * interval '1 second'),
  now() - ((${runCount} - gs) * interval '1 second'),
  case when gs % 11 = 0 then null else now() - ((${runCount} - gs - 60 - (gs % 500)) * interval '1 second') end
from generate_series(1, ${runCount}) as gs, project;

analyze runs;
	`;
}

function metricSeedCopySql() {
  const escapedProject = project.replaceAll("'", "''");
  return `
copy (
  with project_runs as (
    select
      r.org_id,
      r.id,
      r.created_at,
      row_number() over (order by r.created_at) as rn
    from runs r
    join projects p on p.org_id = r.org_id and p.id = r.project_id
    where r.org_id = '00000000-0000-0000-0000-000000000001' and p.name = '${escapedProject}'
  ),
  newest as (
    select org_id, id
    from project_runs
    order by created_at desc, id desc
    limit 1
  )
  select
    org_id,
    id as run_id,
    'eval/return_mean' as key,
    1000::double precision as step,
    (150 + rn % 800)::double precision as value,
    to_char((created_at + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as logged_at
  from project_runs
  union all
  select
    newest.org_id,
    newest.id as run_id,
    'eval/return_mean' as key,
    gs::double precision as step,
    (100 + sin(gs / 25.0) * 10 + gs / 10.0)::double precision as value,
    to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as logged_at
  from newest, generate_series(1, 1000) as gs
) to stdout with (format text, delimiter E'\\t')
  `;
}

async function measureEndpoint(name, pathSuffix) {
  for (let index = 0; index < warmups; index += 1) await fetchJson(apiBaseUrl + pathSuffix);
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const payload = await fetchJson(apiBaseUrl + pathSuffix);
    timings.push(performance.now() - started);
    if (name.startsWith("summary") && !Array.isArray(payload.runs)) throw new Error(`${name} returned malformed runs payload`);
    if (name === "chart_series" && !Array.isArray(payload.metrics)) throw new Error("chart_series returned malformed metrics payload");
  }
  return summarize(timings);
}

async function measureWebFirstUsefulRender() {
  const webPort = await freePort();
  const nextBin = path.join(repo, "node_modules/.bin/next");
  run(nextBin, ["build"], {
    cwd: path.join(repo, "apps/web"),
    env: { ...process.env, RLOBS_API_BASE: apiBaseUrl },
  });
  webServer = spawn(nextBin, ["start", "--port", String(webPort)], {
    cwd: path.join(repo, "apps/web"),
    env: { ...process.env, RLOBS_API_BASE: apiBaseUrl },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHttp(`http://127.0.0.1:${webPort}`, webServer, null);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const started = performance.now();
    await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: "domcontentloaded" });
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
  if (result.measurements.chart_series.p95_ms > result.budgets_ms.chart_series_p95) failures.push("chart_series p95 exceeded 200 ms");
  if (result.web && result.web.first_useful_render_ms > result.budgets_ms.web_first_useful_render) failures.push("web first useful render exceeded 2000 ms");
  return failures;
}

async function fetchJson(url) {
  const response = await fetch(url);
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

function psqlCapture(sql) {
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`psql metric seed export failed with status ${result.status}\n${result.stderr}`);
  }
  return result.stdout;
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
