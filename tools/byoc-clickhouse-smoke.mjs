#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { clickhousePost, ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-byoc-clickhouse-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const baseUrl = `http://127.0.0.1:${apiPort}`;
const clickhouseBase = `http://default:@127.0.0.1:${clickhouseHttpPort}`;
const userDataUrl = `${clickhouseBase}/instantml_user_data_byoc`;
const tenantBaseUrl = `${clickhouseBase}/instantml_tenant_base`;
const byocDatabase = `instantml_byoc_${Date.now().toString(36)}`;
let clickhouse = null;
let server = null;
let sessionCookie = "";

try {
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: `${clickhouseBase}/bootstrap`,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });
  await clickhousePost(`${clickhouseBase}/default`, `CREATE DATABASE IF NOT EXISTS ${byocDatabase}`);

  const serverLog = path.join(tempDir, "server.log");
  const output = fs.openSync(serverLog, "w");
  server = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: `${clickhouseBase}/instantml_byoc_default`,
      CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT: userDataUrl,
      INSTANTML_TENANT_CLICKHOUSE_URL: tenantBaseUrl,
      INSTANTML_HOSTED_CLICKHOUSE_ENABLED: "true",
      INSTANTML_CLICKHOUSE_PROVISIONER: "database",
      INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
      INSTANTML_AUTH_MODE: "local",
      INSTANTML_DEV_AUTH_ENABLED: "true",
      INSTANTML_BILLING_ENABLED: "false",
      INSTANTML_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
      INSTANTML_ARTIFACT_UPLOADS_ENABLED: "true",
      INSTANTML_BYOC_ALLOW_PRIVATE_ENDPOINTS: "true",
      INSTANTML_BYOC_SECRET_BACKEND: "local-user-data",
      INSTANTML_BYOC_EGRESS_CIDRS: "127.0.0.1/32",
      INSTANTML_BYOC_EGRESS_SET_VERSION: "local-smoke",
    },
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  await waitForHttp(`${baseUrl}/readyz`, server, serverLog);

  const signup = await apiJson("POST", "/api/auth/dev/google", {
    email: "byoc-smoke@example.com",
    display_name: "BYOC Smoke",
    mode: "signup",
    account_type: "business",
    org_name: `BYOC Smoke ${Date.now()}`,
    plan_tier: "premium",
    storage_choice: "customer-clickhouse",
  }, { saveCookie: true });
  const orgId = signup.body.organization?.id;
  assert.ok(orgId, "signup should return org id");
  assert.equal(signup.body.organization.storage_choice, "customer-clickhouse");
  assert.equal(signup.body.organization.storage_state, "storage_unconfigured");
  assert.equal(signup.body.onboarding_api_key, undefined);

  const blockedKey = await apiJson(
    "POST",
    `/api/orgs/${orgId}/api-keys`,
    { name: "blocked" },
    { expectStatus: 409 },
  );
  assert.equal(blockedKey.body.code, "storage_setup_required");

  const current = await apiJson("GET", "/api/storage/clickhouse-connections/current");
  assert.equal(current.body.connection.storage_state, "storage_unconfigured");
  assert.deepEqual(current.body.connection.required_egress_cidrs, ["127.0.0.1/32"]);

  const connection = {
    org_id: orgId,
    endpoint: `http://127.0.0.1:${clickhouseHttpPort}`,
    database: byocDatabase,
    username: "default",
    password: "",
    storage_choice: "customer-clickhouse",
    allow_create_database: false,
  };
  const validation = await apiJson("POST", "/api/storage/clickhouse-connections/validate", connection);
  assert.equal(validation.body.validation.status, "valid");
  assert.equal(validation.body.validation.database, byocDatabase);

  const saved = await apiJson("POST", "/api/storage/clickhouse-connections", connection);
  assert.equal(saved.body.connection.status, "ready");
  assert.equal(saved.body.connection.storage_state, "storage_ready");
  assert.equal(saved.body.connection.database, byocDatabase);

  const rotated = await apiJson("POST", "/api/storage/clickhouse-connections/rotate-credentials", {
    org_id: orgId,
    username: "default",
    password: "",
  });
  assert.equal(rotated.body.connection.status, "ready");
  assert.equal(rotated.body.connection.database, byocDatabase);

  const keyPayload = await apiJson("POST", `/api/orgs/${orgId}/api-keys`, {
    name: "BYOC smoke SDK key",
  });
  const apiKey = keyPayload.body.api_key;
  assert.match(apiKey, /^instantml_/);

  const run = (await apiJson("POST", "/runs", {
    project: "byoc-smoke",
    name: "byoc-route-ready",
    config: { seed: 7 },
    tags: ["byoc"],
  }, { apiKey })).body.run;
  await apiJson("POST", `/runs/${run.id}/metrics`, {
    step: 1,
    metrics: { "eval/accuracy": 0.98 },
  }, { apiKey });
  await apiJson("POST", `/api/runs/${run.id}/artifacts/upload`, {
    type: "file",
    name: "bytes.bin",
    content_base64: "AQIDBA==",
  }, { apiKey });

  assert.equal(await clickhouseCount(byocDatabase, "operational_records", "kind = 'run'"), 1);
  assert.equal(await clickhouseCount(byocDatabase, "metric_points", "key = 'eval/accuracy'"), 1);

  const usage = await apiJson("GET", "/api/usage");
  const orgUsage = usage.body.organizations[0].usage;
  assert.equal(orgUsage.artifact_bytes_exact, 4);
  assert.equal(orgUsage.warehouse_storage_bytes_exact, null);
  assert.equal(orgUsage.storage_bytes_for_warnings, 4);
  assert.ok(orgUsage.estimated_metadata_bytes > 4);

  console.log(JSON.stringify({
    status: "ok",
    org_id: orgId,
    byoc_database: byocDatabase,
    storage_bytes_for_warnings: orgUsage.storage_bytes_for_warnings,
  }, null, 2));
} finally {
  if (server) {
    server.kill();
    await onceClose(server);
  }
  if (clickhouse) await clickhouse.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function apiJson(method, pathname, body, options = {}) {
  const headers = { "content-type": "application/json" };
  if (sessionCookie) headers.cookie = sessionCookie;
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (options.expectStatus) {
    assert.equal(response.status, options.expectStatus, `${pathname}: ${text}`);
  } else if (!response.ok) {
    throw new Error(`${pathname} failed with ${response.status}: ${text}`);
  }
  const setCookie = response.headers.get("set-cookie")?.split(";")[0];
  if (options.saveCookie && setCookie) sessionCookie = setCookie;
  return { body: text ? JSON.parse(text) : {}, status: response.status };
}

async function clickhouseCount(database, table, where) {
  const text = await clickhousePost(
    `${clickhouseBase}/${database}`,
    `SELECT count() AS count FROM ${table} WHERE ${where} FORMAT JSONEachRow`,
  );
  return Number(JSON.parse(text.trim()).count);
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
