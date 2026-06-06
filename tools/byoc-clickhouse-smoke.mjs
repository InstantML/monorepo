#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const postgresPort = await freePort();
const apiPort = await freePort();
const baseUrl = `http://127.0.0.1:${apiPort}`;
const clickhouseBase = `http://default:@127.0.0.1:${clickhouseHttpPort}`;
const tenantBaseUrl = `${clickhouseBase}/instantml_tenant_base`;
const databaseUrl = process.env.DATABASE_URL || `postgres://instantml:instantml@127.0.0.1:${postgresPort}/control`;
const byocDatabase = `instantml_byoc_${Date.now().toString(36)}`;
const byocUsername = "instantml_writer_smoke";
const byocPassword = `smoke_${Date.now().toString(36)}`;
let clickhouse = null;
let postgresContainer = "";
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
  postgresContainer = await ensurePostgres();
  await clickhousePost(`${clickhouseBase}/default`, `CREATE DATABASE IF NOT EXISTS ${byocDatabase}`);
  await clickhousePost(
    `${clickhouseBase}/default`,
    `CREATE USER IF NOT EXISTS ${byocUsername} IDENTIFIED WITH sha256_password BY '${byocPassword}'`,
  );
  await clickhousePost(
    `${clickhouseBase}/default`,
    `GRANT SHOW, SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER TABLE ON ${byocDatabase}.* TO ${byocUsername}`,
  );

  const serverLog = path.join(tempDir, "server.log");
  const output = fs.openSync(serverLog, "w");
  server = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: `${clickhouseBase}/instantml_byoc_default`,
      INSTANTML_TENANT_CLICKHOUSE_URL: tenantBaseUrl,
      DATABASE_URL: databaseUrl,
      INSTANTML_HOSTED_CLICKHOUSE_ENABLED: "true",
      INSTANTML_CLICKHOUSE_PROVISIONER: "database",
      INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
      INSTANTML_AUTH_MODE: "local",
      INSTANTML_DEV_AUTH_ENABLED: "true",
      INSTANTML_BILLING_ENABLED: "true",
      INSTANTML_STRIPE_MOCK_CHECKOUT: "true",
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "sk_test_instantml_mock",
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
  assert.match(signup.body.billing_checkout?.session_id ?? "", /^cs_test_instantml__/);
  assert.equal(signup.body.onboarding_api_key, undefined);

  await apiJson("POST", "/api/billing/checkout/sync", {
    session_id: signup.body.billing_checkout.session_id,
  });

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
    username: byocUsername,
    password: byocPassword,
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

  await clickhousePost(
    `${clickhouseBase}/default`,
    `REVOKE CREATE TABLE, CREATE VIEW, ALTER TABLE ON ${byocDatabase}.* FROM ${byocUsername}`,
  );

  const rotated = await apiJson("POST", "/api/storage/clickhouse-connections/rotate-credentials", {
    org_id: orgId,
    username: byocUsername,
    password: byocPassword,
  });
  assert.equal(rotated.body.connection.status, "ready");
  assert.equal(rotated.body.connection.database, byocDatabase);

  const keyPayload = await apiJson("POST", `/api/orgs/${orgId}/api-keys`, {
    name: "BYOC smoke SDK key",
  });
  const apiKey = keyPayload.body.api_key;
  assert.match(apiKey, /^instantml_/);

  const sdkArtifactPath = path.join(tempDir, "bytes.bin");
  fs.writeFileSync(sdkArtifactPath, Buffer.from([1, 2, 3, 4]));
  runPythonSdk(apiKey, sdkArtifactPath);

  assert.equal(
    await clickhouseCount(
      byocDatabase,
      "operational_records",
      "kind = 'run'",
      "uniqExact(entity_id)",
    ),
    1,
  );
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
  if (postgresContainer) {
    spawnSync("docker", ["rm", "-f", postgresContainer], { stdio: "ignore" });
  }
  if (clickhouse) await clickhouse.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runPythonSdk(apiKey, artifactPath) {
  const script = `
import os
import sys
sys.path.insert(0, "packages/python-sdk")
import instantml as iml

run = iml.init(
    project="byoc-smoke",
    name="byoc-python-sdk",
    config={"seed": 7},
    tags=["byoc", "python-sdk"],
    base_url=os.environ["INSTANTML_BASE_URL"],
    api_key=os.environ["INSTANTML_API_KEY"],
    source_tracking=False,
    upload_mode="sync",
)
run.log_metrics({"eval/accuracy": 0.98}, step=1)
run.upload_file(os.environ["INSTANTML_ARTIFACT_PATH"], name="bytes.bin", step=1)
run.finish()
`;
  const result = spawnSync("python3", ["-c", script], {
    cwd: repo,
    env: {
      ...process.env,
      INSTANTML_BASE_URL: baseUrl,
      INSTANTML_API_KEY: apiKey,
      INSTANTML_ARTIFACT_PATH: artifactPath,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`python BYOC SDK smoke failed with status ${result.status}`);
  }
}

async function apiJson(method, pathname, body, options = {}) {
  const headers = { "content-type": "application/json" };
  if (method !== "GET") headers.origin = baseUrl;
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

async function clickhouseCount(database, table, where, expression = "count()") {
  const text = await clickhousePost(
    `${clickhouseBase}/${database}`,
    `SELECT ${expression} AS count FROM ${table} WHERE ${where} FORMAT JSONEachRow`,
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

async function ensurePostgres() {
  if (process.env.DATABASE_URL) return "";
  const result = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "-e",
      "POSTGRES_USER=instantml",
      "-e",
      "POSTGRES_PASSWORD=instantml",
      "-e",
      "POSTGRES_DB=control",
      "-p",
      `127.0.0.1:${postgresPort}:5432`,
      "postgres:16-alpine",
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      "DATABASE_URL is required for BYOC smoke, or Docker must be available to start postgres:16-alpine.\n"
        + result.stderr,
    );
  }
  const id = result.stdout.trim();
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const ready = spawnSync(
      "docker",
      ["exec", id, "pg_isready", "-U", "instantml", "-d", "control"],
      { encoding: "utf8" },
    );
    if (ready.status === 0) return id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  throw new Error("Timed out waiting for postgres:16-alpine to become ready");
}

function onceClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
