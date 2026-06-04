#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clickhousePost } from "./local-clickhouse.mjs";

const repo = process.cwd();
loadDotenv(path.join(repo, ".env"));

const allow = process.env.INSTANTML_HOSTED_SCALE_SEED_ALLOW === "1";
if (!allow) {
  throw new Error(
    "Hosted scale seed writes to live hosted ClickHouse. Set INSTANTML_HOSTED_SCALE_SEED_ALLOW=1 to continue.",
  );
}

const runCount = positiveInt("INSTANTML_HOSTED_SCALE_RUNS", 100_000);
const stepsPerRun = positiveInt("INSTANTML_HOSTED_SCALE_STEPS", 1_000);
const runBatchSize = positiveInt("INSTANTML_HOSTED_SCALE_RUN_BATCH", 500);
const truncateTenant = process.env.INSTANTML_HOSTED_SCALE_TRUNCATE === "1";
const keepSeedTable = process.env.INSTANTML_HOSTED_SCALE_KEEP_SEED_TABLE === "1";
const projects = envList("INSTANTML_HOSTED_SCALE_PROJECTS", [
  "hosted-scale-control",
  "hosted-scale-data",
]);
const metricKeys = envList("INSTANTML_HOSTED_SCALE_METRIC_KEYS", [
  "eval/return_mean",
  "eval/success_rate",
  "train/loss",
  "train/reward_mean",
  "system/cpu_percent",
  "system/gpu_util",
]);
const dataApiBase = trimSlash(process.env.INSTANTML_DATA_API_BASE || process.env.INSTANTML_API_BASE || "");
const apiKey = process.env.INSTANTML_API_KEY || "";
const tenantBaseUrl = clickhouseUrlFromEnv(
  "INSTANTML_TENANT_CLICKHOUSE_URL",
  "CLICKHOUSE_USERNAME",
  "CLICKHOUSE_PASSWORD",
  process.env.CLICKHOUSE_URL,
);

if (projects.length < 2) throw new Error("At least two projects are required.");
if (runCount < projects.length) throw new Error("Run count must be at least the number of projects.");
if (!metricKeys.includes("eval/return_mean")) throw new Error("Metric keys must include eval/return_mean.");
if (!metricKeys.some((key) => key.startsWith("system/"))) {
  throw new Error("Metric keys must include at least one system/* metric.");
}

const routeRecord = tenantRouteFromOrgId();
const tenantUrl = tenantUrlFromRoute(routeRecord.route);
const orgId = routeRecord.org_id;
const seedTable = `_instantml_scale_seed_${Date.now()}`;

console.log(JSON.stringify({
  status: "starting",
  org_id: orgId,
  tenant_host: new URL(tenantUrl).host,
  run_count: runCount,
  steps_per_run: stepsPerRun,
  metric_keys: metricKeys,
  expected_metric_points: runCount * stepsPerRun * metricKeys.length,
  truncate_tenant: truncateTenant,
}, null, 2));

if (apiKey && dataApiBase) {
  await verifyApiKey();
}

if (truncateTenant) {
  await truncateTenantTables();
}

try {
  await createSeedTable();
  const projectRows = buildProjectRows();
  await insertOperationalRecords(projectRows);
  await insertSeedRunsAndOperationalRecords(projectRows);
  await insertMetricPoints();
  const verification = await verifySeed();
  console.log(JSON.stringify({ status: "ok", ...verification }, null, 2));
} finally {
  if (!keepSeedTable) {
    await clickhousePost(tenantUrl, `DROP TABLE IF EXISTS ${seedTable}`);
  }
}

async function verifyApiKey() {
  const response = await fetch(
    `${dataApiBase}/api/runs/summary?${new URLSearchParams({ limit: "1", sort_by: "created" })}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hosted data API key verification failed with ${response.status}: ${text}`);
  }
  console.log(JSON.stringify({ status: "api_key_verified", data_api_base: dataApiBase }, null, 2));
}

async function truncateTenantTables() {
  for (const table of ["metric_points", "metric_series", "console_log_lines", "operational_records"]) {
    await clickhousePost(tenantUrl, `TRUNCATE TABLE IF EXISTS ${table}`);
  }
  console.log(JSON.stringify({ status: "tenant_tables_truncated" }));
}

async function createSeedTable() {
  await clickhousePost(
    tenantUrl,
    `CREATE TABLE ${seedTable} (
      run_index UInt32,
      project LowCardinality(String),
      project_id UUID,
      run_id UUID,
      status LowCardinality(String),
      run_created_at DateTime64(6, 'UTC'),
      run_started_at DateTime64(6, 'UTC'),
      run_finished_at Nullable(DateTime64(6, 'UTC'))
    )
    ENGINE = MergeTree
    ORDER BY (run_index)`,
  );
}

function buildProjectRows() {
  const now = new Date();
  return projects.map((project) => {
    const id = randomUUID();
    return opRecord("project", id, {
      id,
      org_id: orgId,
      name: project,
      description: "Hosted split-service scale validation project",
      created_at: now.toISOString(),
    }, now);
  });
}

async function insertSeedRunsAndOperationalRecords(projectRows) {
  const projectIds = new Map(projectRows.map((row) => [row.payload.name, row.payload.id]));
  let seedRows = [];
  let opRows = [];
  const startedAt = Date.now() - runCount * 1_000;
  for (let index = 0; index < runCount; index += 1) {
    const project = projects[index % projects.length];
    const projectId = projectIds.get(project);
    const runId = randomUUID();
    const createdAt = new Date(startedAt + index * 1_000);
    const status = index % 197 === 0 ? "failed" : index % 31 === 0 ? "running" : "finished";
    const finishedAt = status === "running" ? null : new Date(createdAt.getTime() + 900_000 + (index % 600) * 1_000);
    seedRows.push({
      run_index: index,
      project,
      project_id: projectId,
      run_id: runId,
      status,
      run_created_at: clickhouseDate(createdAt),
      run_started_at: clickhouseDate(createdAt),
      run_finished_at: finishedAt ? clickhouseDate(finishedAt) : null,
    });
    opRows.push(opRecord("run", runId, {
      id: runId,
      org_id: orgId,
      project_id: projectId,
      project,
      name: `${project}-run-${String(index + 1).padStart(6, "0")}`,
      status,
      config: {
        seed: index % 10_000,
        framework: index % 2 === 0 ? "torch" : "jax",
        model: index % 5 === 0 ? "transformer" : "rl-policy",
        optimizer: index % 3 === 0 ? "adamw" : "ppo",
        hardware: {
          accelerator: index % 7 === 0 ? "H100" : "A100",
          accelerator_count: 1 + (index % 8),
        },
      },
      tags: ["hosted-scale", project, `seed-${index % 100}`, status],
      metadata: {
        notes: `split-service scale validation ${project} cohort ${index % 37}`,
        source: "hosted-tenant-scale-seed",
      },
      created_at: createdAt.toISOString(),
      started_at: createdAt.toISOString(),
      finished_at: finishedAt ? finishedAt.toISOString() : null,
    }, createdAt));
    if (seedRows.length >= 5_000) {
      await insertSeedRows(seedRows);
      await insertOperationalRecords(opRows);
      seedRows = [];
      opRows = [];
      console.log(JSON.stringify({ status: "runs_seeded", runs: index + 1 }));
    }
  }
  if (seedRows.length) await insertSeedRows(seedRows);
  if (opRows.length) await insertOperationalRecords(opRows);
}

async function insertSeedRows(rows) {
  await clickhousePost(
    tenantUrl,
    `INSERT INTO ${seedTable} FORMAT JSONEachRow`,
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
}

async function insertOperationalRecords(records) {
  await clickhousePost(
    tenantUrl,
    "INSERT INTO operational_records (kind, org_id, entity_id, payload, created_at) FORMAT JSONEachRow",
    records.map((record) => JSON.stringify({
      kind: record.kind,
      org_id: orgId,
      entity_id: record.entity_id,
      payload: JSON.stringify(record.payload),
      created_at: clickhouseDate(record.created_at),
    })).join("\n"),
  );
}

async function insertMetricPoints() {
  for (let start = 0; start < runCount; start += runBatchSize) {
    const end = Math.min(runCount, start + runBatchSize);
    await clickhousePost(
      tenantUrl,
      `INSERT INTO metric_points (org_id, run_id, key, step, value, logged_at, created_at)
       SELECT
         toUUID(${sqlString(orgId)}) AS org_id,
         run_id,
         key,
         toFloat64(step_numbers.number + 1) AS step,
         multiIf(
           key = 'eval/return_mean',
             100 + (log2(toFloat64(step_numbers.number + 2)) * 7) + (sin((toFloat64(step_numbers.number + 1) / 25) + toFloat64(run_index % 997)) * 2) + (toFloat64(run_index % 500) / 10),
           key = 'eval/success_rate',
             least(1.0, 0.2 + (toFloat64(step_numbers.number + 1) / 1250) + (toFloat64(run_index % 10) / 100)),
           key = 'train/loss',
             greatest(0.001, (4 / sqrt(toFloat64(step_numbers.number + 2))) + (toFloat64(run_index % 7) / 100)),
           key = 'train/reward_mean',
             45 + (log1p(toFloat64(step_numbers.number + 1)) * 10) + (toFloat64(run_index % 250) / 8),
           key = 'system/cpu_percent',
             50 + (sin((toFloat64(step_numbers.number + 1) / 19) + toFloat64(run_index)) * 20),
           key = 'system/gpu_util',
             65 + (sin((toFloat64(step_numbers.number + 1) / 13) + toFloat64(run_index)) * 25),
           0
         ) AS value,
         run_created_at + toIntervalSecond(toInt64(step_numbers.number + 1)) AS logged_at,
         now64(6) AS created_at
       FROM ${seedTable}
       CROSS JOIN numbers(${stepsPerRun}) AS step_numbers
       ARRAY JOIN [${metricKeys.map(sqlString).join(", ")}] AS key
       WHERE run_index >= ${start} AND run_index < ${end}`,
    );
    console.log(JSON.stringify({
      status: "metric_points_inserted",
      runs: end,
      expected_points: end * stepsPerRun * metricKeys.length,
    }));
  }
}

async function verifySeed() {
  const projectCounts = await queryJsonRows(
    `SELECT JSONExtractString(payload, 'project') AS project, count() AS runs
     FROM operational_records
     WHERE org_id = toUUID(${sqlString(orgId)}) AND kind = 'run'
     GROUP BY project
     ORDER BY project
     FORMAT JSONEachRow`,
  );
  const seriesRows = await queryJsonRows(
    `SELECT
       count() AS series,
       sum(points) AS metric_points,
       min(points) AS min_points_per_series,
       max(points) AS max_points_per_series,
       min(latest_step) AS min_latest_step,
       max(latest_step) AS max_latest_step
     FROM (
       SELECT
         run_id,
         key,
         countMerge(count) AS points,
         maxMerge(latest_step) AS latest_step
       FROM metric_series
       WHERE org_id = toUUID(${sqlString(orgId)})
       GROUP BY run_id, key
     )
     FORMAT JSONEachRow`,
  );
  return {
    projects: projectCounts.map((row) => ({ project: row.project, runs: Number(row.runs) })),
    metric_series: seriesRows[0],
  };
}

function tenantRouteFromOrgId() {
  const orgId = process.env.INSTANTML_HOSTED_SCALE_ORG_ID || "";
  if (!orgId) throw new Error("INSTANTML_HOSTED_SCALE_ORG_ID is required after the Postgres control-plane cutover.");
  const base = new URL(tenantBaseUrl);
  const endpoint = new URL(process.env.INSTANTML_HOSTED_SCALE_CLICKHOUSE_ENDPOINT_OVERRIDE || tenantBaseUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.pathname = "/";
  return {
    org_id: orgId,
    route: {
      endpoint: endpoint.toString(),
      database:
        process.env.INSTANTML_HOSTED_SCALE_TENANT_DATABASE || `instantml_org_${orgId.replaceAll("-", "")}`,
      username: base.username || "default",
      password_ciphertext: base.password,
    },
  };
}

async function queryJsonRows(sql, url = tenantUrl) {
  const text = await clickhousePost(url, sql);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function tenantUrlFromRoute(route) {
  if (!route.endpoint) throw new Error("Tenant route is missing endpoint.");
  const url = new URL(process.env.INSTANTML_HOSTED_SCALE_CLICKHOUSE_ENDPOINT_OVERRIDE || route.endpoint);
  url.username = route.username || "default";
  url.password = route.password_ciphertext || tenantBasePassword(route);
  url.pathname = `/${route.database || "default"}`;
  return url.toString();
}

function tenantBasePassword(route) {
  if (route.password_secret_ref !== "config:tenant_base_url_password") {
    throw new Error("Tenant route does not include a directly resolvable password.");
  }
  return new URL(tenantBaseUrl).password;
}

function opRecord(kind, entityId, payload, createdAt) {
  return { kind, entity_id: entityId, payload, created_at: createdAt };
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

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function clickhouseDate(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function sqlString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function trimSlash(value) {
  return value.replace(/\/$/, "");
}
