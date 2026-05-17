#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { clickhousePost, ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-hosted-clickhouse-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const controlPort = await freePort();
const dataPort = await freePort();
const controlBaseUrl = `http://127.0.0.1:${controlPort}`;
const dataBaseUrl = `http://127.0.0.1:${dataPort}`;
const clickhouseBase = `http://default:@127.0.0.1:${clickhouseHttpPort}`;
const controlUrl = `${clickhouseBase}/instantml_user_data_smoke`;
const tenantBaseUrl = `${clickhouseBase}/instantml_tenant_base`;
let controlServer = null;
let dataServer = null;
let clickhouse = null;

try {
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: `${clickhouseBase}/bootstrap`,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  controlServer = await startServer("control");
  dataServer = await startServer("data");

  await assertServicePlane(controlBaseUrl, "control");
  await assertServicePlane(dataBaseUrl, "data");
  await assertRouteStatus(controlBaseUrl, "/runs", { method: "GET" }, 404);
  await assertRouteStatus(dataBaseUrl, "/api/orgs", { method: "GET" }, 404);

  const signup = await postJson(controlBaseUrl, "/api/auth/dev/google", {
    email: "hosted-smoke@example.com",
    display_name: "Hosted Smoke",
    mode: "signup",
    account_type: "business",
    org_name: `Hosted Smoke ${Date.now()}`,
    plan_tier: "pro",
    seat_emails: ["teammate@example.com"],
  });
  const cookie = signup.cookie;
  const orgId = signup.body.organization.id;
  assert.ok(orgId, "signup should return an organization id");
  assert.equal(signup.body.organization.plan_tier, "pro");
  assert.equal(signup.body.organization.seat_limit, 3);
  assertNoSensitiveProvisioningFields(signup.body);

  let seats = await getJson(controlBaseUrl, `/api/orgs/${orgId}/seats`, { cookie });
  assert.equal(seats.seats.length, 2);
  assert.equal(seats.seats.some((seat) => seat.user.primary_email === "teammate@example.com" && seat.membership.status === "invited"), true);

  const teammateSignin = await postJson(controlBaseUrl, "/api/auth/dev/google", {
    email: "teammate@example.com",
    display_name: "Teammate Smoke",
    mode: "signin",
  });
  const teammateCookie = teammateSignin.cookie;
  assert.equal(teammateSignin.body.organization.id, orgId);
  assert.equal(teammateSignin.body.membership.role, "member");
  assert.equal(teammateSignin.body.membership.status, "active");
  seats = await getJson(controlBaseUrl, `/api/orgs/${orgId}/seats`, { cookie });
  assert.equal(seats.seats.some((seat) => seat.user.primary_email === "teammate@example.com" && seat.membership.status === "active"), true);

  const firstKinds = await controlKinds();
  for (const kind of ["user", "organization", "membership", "session", "tenant_route"]) {
    assert.ok(firstKinds.includes(kind), `User Data should contain ${kind}`);
  }

  const demoFirst = await postJson(controlBaseUrl, "/api/auth/dev/google", {
    email: "hello@instantml.ai",
    display_name: "Different Demo Name",
    account_type: "individual",
    org_name: "Per Login Demo Org",
  });
  const demoSecond = await postJson(controlBaseUrl, "/api/auth/dev/google", {
    email: "hello@instantml.com",
    display_name: "Alias Demo Name",
    account_type: "business",
    org_name: "Alias Demo Org",
  });
  assertNoSensitiveProvisioningFields(demoFirst.body);
  assert.equal(demoFirst.body.user.primary_email, "hello@instantml.ai");
  const demoRouteCountAfterFirstSignin = await tenantRouteCount(demoFirst.body.organization.id);
  assert.ok(demoRouteCountAfterFirstSignin >= 1);
  assert.equal(demoSecond.body.user.primary_email, "hello@instantml.ai");
  assert.equal(demoSecond.body.organization.id, demoFirst.body.organization.id);
  assert.equal(demoSecond.body.organization.name, "InstantML Demo");
  assert.equal(
    await tenantRouteCount(demoFirst.body.organization.id),
    demoRouteCountAfterFirstSignin,
  );

  const keyPayload = await postJson(
    controlBaseUrl,
    `/api/orgs/${orgId}/api-keys`,
    { name: "Hosted smoke SDK key" },
    { cookie },
  );
  const apiKey = keyPayload.body.api_key;
  assert.match(apiKey, /^instantml_/, "API key should be copy-once secret");
  let listedKeys = await getJson(controlBaseUrl, `/api/orgs/${orgId}/api-keys`, { cookie });
  assert.equal(listedKeys.api_keys.some((key) => key.id === keyPayload.body.key.id), true);
  const extraKeyPayload = await postJson(
    controlBaseUrl,
    `/api/orgs/${orgId}/api-keys`,
    { name: "Hosted smoke revoked key" },
    { cookie },
  );
  await postJson(
    controlBaseUrl,
    `/api/orgs/${orgId}/api-keys/${extraKeyPayload.body.key.id}/revoke`,
    {},
    { cookie },
  );
  listedKeys = await getJson(controlBaseUrl, `/api/orgs/${orgId}/api-keys`, { cookie });
  assert.ok(listedKeys.api_keys.find((key) => key.id === extraKeyPayload.body.key.id)?.revoked_at);
  await assertPostStatus(
    controlBaseUrl,
    `/api/orgs/${orgId}/api-keys`,
    { name: "Hosted smoke forbidden key" },
    { apiKey },
    403,
  );

  const route = await latestTenantRoute(orgId);
  assert.equal(route.status, "ready");
  assert.ok(route.database.startsWith("instantml_org_"));
  assert.equal(route.plan_tier, "pro");
  assert.equal(route.warehouse_kind, "standard");
  assert.equal(route.requested_min_replica_memory_gb, 12);
  assert.equal(route.applied_min_replica_memory_gb, 12);

  const run = (
    await postJson(
      dataBaseUrl,
      "/runs",
      {
        project: "hosted-smoke",
        name: "python-path-ready",
        config: { seed: 13, model: "ppo" },
        tags: ["hosted", "searchable"],
        metadata: { notes: "hosted smoke query target" },
      },
      { apiKey },
    )
  ).body.run;
  await postJson(
    dataBaseUrl,
    `/runs/${run.id}/metrics`,
    { step: 1, metrics: { "eval/return_mean": 42, "train/loss": 0.2 } },
    { apiKey },
  );

  const summary = await getJson(
    dataBaseUrl,
    "/api/runs/summary?project=hosted-smoke&q=searchable&limit=10",
    { cookie },
  );
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].id, run.id);
  assert.equal(summary.runs[0].latest_metrics["eval/return_mean"], 42);

  const teammateSummary = await getJson(
    dataBaseUrl,
    "/api/runs/summary?project=hosted-smoke&q=searchable&limit=10",
    { cookie: teammateCookie },
  );
  assert.equal(teammateSummary.runs.length, 1);
  assert.equal(teammateSummary.runs[0].id, run.id);

  runPythonSdk(apiKey);
  const pythonSummary = await getJson(
    dataBaseUrl,
    "/api/runs/summary?project=hosted-python&q=python-sdk&limit=10",
    { cookie },
  );
  assert.equal(pythonSummary.runs.length, 1);
  assert.equal(pythonSummary.runs[0].latest_metrics["eval/return_mean"], 102);

  const tenantUrl = withDatabase(tenantBaseUrl, route.database);
  assert.equal(await clickhouseCount(tenantUrl, "operational_records", "kind = 'run'"), 3);
  assert.equal(await clickhouseCount(tenantUrl, "metric_points", "key = 'eval/return_mean'"), 4);

  await stopServer("data");
  dataServer = await startServer("data");
  const restarted = await getJson(
    dataBaseUrl,
    "/api/runs/summary?project=hosted-smoke&q=query target&limit=10",
    { cookie },
  );
  assert.equal(restarted.runs.length, 1);
  assert.equal(restarted.runs[0].id, run.id);
  const restartedPython = await getJson(
    dataBaseUrl,
    "/api/runs/summary?project=hosted-python&q=python-sdk&limit=10",
    { cookie },
  );
  assert.equal(restartedPython.runs.length, 1);
  assert.equal(restartedPython.runs[0].latest_metrics["eval/return_mean"], 102);

  const usage = await getJson(dataBaseUrl, "/api/usage", { cookie });
  assert.equal(usage.billing_precision, "not_billable");
  assert.equal(usage.plans.pro.included_seats, 3);
  assert.equal(usage.organizations[0].plan_tier, "pro");
  assert.equal(usage.organizations[0].usage.seats, 2);
  assert.equal(usage.organizations[0].usage.api_keys, 1);
  assert.equal(usage.organizations[0].limits.included_storage_bytes, 1024 ** 4);

  const finalKinds = await controlKinds();
  assert.ok(finalKinds.includes("api_key"), "User Data should contain api_key");
  assert.ok(finalKinds.includes("service_account"), "User Data should contain service_account");
  console.log(
    JSON.stringify(
      {
        status: "ok",
        org_id: orgId,
        tenant_database: route.database,
        control_kinds: [...new Set(finalKinds)].sort(),
      },
      null,
      2,
    ),
  );
} finally {
  await stopServer("data");
  await stopServer("control");
  if (clickhouse) await clickhouse.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runPythonSdk(apiKey) {
  const script = `
import os
import sys
sys.path.insert(0, "packages/python-sdk")
import instantml as ro

run = ro.init(
    project="hosted-python",
    name="python-sdk-hosted",
    config={"seed": 21},
    tags=["hosted", "python-sdk"],
    metadata={"notes": "python sdk hosted path"},
    base_url=os.environ["INSTANTML_BASE_URL"],
    api_key=os.environ["INSTANTML_API_KEY"],
    source_tracking=False,
)
for step, value in enumerate([100, 101, 102]):
    run.log_metrics({"eval/return_mean": value, "train/loss": 1 / (step + 1)}, step=step)
run.finish()
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: repo,
    env: { ...process.env, INSTANTML_BASE_URL: dataBaseUrl, INSTANTML_API_KEY: apiKey },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`python hosted SDK smoke failed with status ${result.status}`);
  }
}

async function startServer(servicePlane) {
  const port = servicePlane === "control" ? controlPort : dataPort;
  const baseUrl = servicePlane === "control" ? controlBaseUrl : dataBaseUrl;
  const serverLog = path.join(tempDir, `${servicePlane}-api-${Date.now()}.log`);
  const output = fs.openSync(serverLog, "w");
  const child = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: `${clickhouseBase}/instantml_${servicePlane}_default`,
      CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT: controlUrl,
      INSTANTML_TENANT_CLICKHOUSE_URL: tenantBaseUrl,
      INSTANTML_HOSTED_CLICKHOUSE_ENABLED: "true",
      INSTANTML_CLICKHOUSE_PROVISIONER: "database",
      INSTANTML_SERVICE_PLANE: servicePlane,
      INSTANTML_BIND_ADDR: `127.0.0.1:${port}`,
      INSTANTML_AUTH_MODE: "local",
      INSTANTML_ARTIFACT_ROOT: path.join(tempDir, `${servicePlane}-artifacts`),
    },
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  await waitForHttp(`${baseUrl}/readyz`, child, serverLog);
  return child;
}

async function stopServer(servicePlane) {
  const child = servicePlane === "control" ? controlServer : dataServer;
  if (!child) return;
  if (servicePlane === "control") {
    controlServer = null;
  } else {
    dataServer = null;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await onceClose(child);
}

async function postJson(baseUrl, pathname, body, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const response = await fetch(baseUrl + pathname, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${text}`);
  return {
    body: text ? JSON.parse(text) : {},
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

async function assertPostStatus(baseUrl, pathname, body, options, status) {
  const headers = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const response = await fetch(baseUrl + pathname, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${pathname} expected ${status}, got ${response.status}: ${text}`);
}

async function getJson(baseUrl, pathname, options = {}) {
  const headers = {};
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(baseUrl + pathname, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function assertServicePlane(baseUrl, expected) {
  const config = await getJson(baseUrl, "/api/auth/config");
  assert.equal(config.service_plane, expected);
  const openapi = await getJson(baseUrl, "/openapi.json");
  assert.equal(openapi["x-instantml-service-plane"], expected);
  if (expected === "control") {
    assert.ok(openapi.paths["/api/orgs/{org_id}/api-keys"]);
    assert.equal(openapi.paths["/runs"], undefined);
  } else {
    assert.ok(openapi.paths["/runs"]);
    assert.equal(openapi.paths["/api/orgs/{org_id}/api-keys"], undefined);
  }
}

async function assertRouteStatus(baseUrl, pathname, options, status) {
  const response = await fetch(baseUrl + pathname, options);
  const text = await response.text();
  assert.equal(response.status, status, `${pathname} expected ${status}, got ${response.status}: ${text}`);
}

async function controlKinds() {
  const rows = await clickhouseJsonEachRow(
    controlUrl,
    "SELECT kind FROM instantml_user_data ORDER BY created_at, event_id FORMAT JSONEachRow",
  );
  return rows.map((row) => row.kind);
}

async function latestTenantRoute(orgId) {
  const rows = await clickhouseJsonEachRow(
    controlUrl,
    `SELECT payload FROM instantml_user_data WHERE kind = 'tenant_route' AND org_id = '${orgId}' ORDER BY created_at DESC, event_id DESC LIMIT 1 FORMAT JSONEachRow`,
  );
  assert.equal(rows.length, 1, "expected one latest tenant route row");
  return JSON.parse(rows[0].payload);
}

async function tenantRouteCount(orgId) {
  const rows = await clickhouseJsonEachRow(
    controlUrl,
    `SELECT count() AS count FROM instantml_user_data WHERE kind = 'tenant_route' AND org_id = '${orgId}' FORMAT JSONEachRow`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function clickhouseCount(url, table, where) {
  const rows = await clickhouseJsonEachRow(
    url,
    `SELECT count() AS count FROM ${table} WHERE ${where} FORMAT JSONEachRow`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function clickhouseJsonEachRow(url, query) {
  const text = await clickhousePost(url, query);
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withDatabase(rawUrl, database) {
  const parsed = new URL(rawUrl);
  parsed.pathname = database;
  return parsed.toString();
}

function assertNoSensitiveProvisioningFields(value) {
  const forbidden = new Set([
    "endpoint",
    "username",
    "password",
    "password_secret_ref",
    "password_ciphertext",
  ]);
  const seen = [];
  walk(value);
  assert.deepEqual(seen, [], `signup payload exposed sensitive route fields: ${seen.join(", ")}`);

  function walk(item) {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) seen.push(key);
      walk(child);
    }
  }
}

async function waitForHttp(url, child, logPath) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) {
      throw new Error(`Rust server exited early. Log:\n${fs.readFileSync(logPath, "utf8")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Log:\n${fs.readFileSync(logPath, "utf8")}`);
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function onceClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
