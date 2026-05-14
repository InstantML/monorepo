import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let server = null;
let tempDir = null;
let bootstrapToken = process.env.RLOBS_CONTRACT_BOOTSTRAP_TOKEN || "";

const externalBaseUrl = process.env.RLOBS_CONTRACT_BASE_URL || process.env.RLOBS_BASE_URL;
const backendMode = (process.env.RLOBS_CONTRACT_BACKEND || "rust").toLowerCase();
if (!externalBaseUrl && backendMode !== "node") {
  const result = spawnSync("node", ["tools/rust-service-smoke.mjs", "contract"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? (result.signal ? 1 : 0));
}
const baseUrl = externalBaseUrl || (await startNodeCompatibilityServer());

try {
  await runContract(baseUrl);
  console.log(`contract smoke passed against ${baseUrl}`);
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server.store.close();
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}

async function startNodeCompatibilityServer() {
  const { createServer } = await import("../apps/server/src/server.js");
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rlobs-contract-"));
  server = createServer({
    dbPath: path.join(tempDir, "rlobs.json"),
    storageRoot: path.join(tempDir, "artifacts"),
    requireApiKey: true,
    bootstrapToken: "contract-bootstrap",
  });
  bootstrapToken = "contract-bootstrap";
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function runContract(root) {
  assert.deepEqual(await request(root, "GET", "/health"), { status: "ok" });
  const bootstrapHeaders = bootstrapToken ? { "X-RLOBS-Bootstrap-Token": bootstrapToken } : {};

  const user = (await request(root, "POST", "/api/users", {
    email: "contract@example.com",
    provider: "google",
    provider_subject: "contract-subject",
  }, bootstrapHeaders)).user;
  const org = (await request(root, "POST", "/api/orgs", {
    slug: `contract-${Date.now()}`,
    name: "Contract Smoke",
    owner_user_id: user.id,
  }, bootstrapHeaders)).organization;
  if (bootstrapToken) assert.equal((await expectStatus(root, "POST", `/api/orgs/${org.id}/api-keys`, 401, { name: "blocked" })).error, "invalid bootstrap token");
  const key = await request(root, "POST", `/api/orgs/${org.id}/api-keys`, { name: "contract-sdk" }, bootstrapHeaders);
  const auth = { Authorization: `Bearer ${key.api_key}` };
  const usageKey = await request(root, "POST", `/api/orgs/${org.id}/api-keys`, { name: "contract-usage", scopes: ["usage:read"] }, bootstrapHeaders);
  const usageAuth = { Authorization: `Bearer ${usageKey.api_key}` };
  assert.equal((await request(root, "GET", `/api/orgs/${org.id}/api-keys`, undefined, bootstrapHeaders)).api_keys.length, 2);
  assert.equal((await expectStatus(root, "GET", "/api/usage", 403, undefined, auth)).error, "api key requires usage:read");

  const missingAuth = await fetch(`${root}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "blocked", name: "blocked" }),
  });
  assert.equal(missingAuth.status, 401);
  assert.equal((await expectStatus(root, "POST", "/runs", 403, { project: "blocked", name: "usage-only" }, usageAuth)).error, "api key requires sdk:ingest");
  assert.equal((await expectStatus(root, "POST", "/projects", 403, { name: "blocked-project" }, usageAuth)).error, "api key requires sdk:ingest");

  const run = (await request(root, "POST", "/runs", {
    project: "contract-project",
    name: "contract-run",
    config: { seed: 1 },
    tags: ["contract"],
  }, auth)).run;
  assert.equal((await request(root, "GET", "/projects", undefined, auth)).projects.some((project) => project.name === "contract-project"), true);
  assert.equal((await expectStatus(root, "GET", `/runs/${run.id}`, 401)).error, "missing bearer token");
  assert.equal((await request(root, "GET", `/runs/${run.id}`, undefined, auth)).run.id, run.id);
  assert.equal((await request(root, "GET", "/runs?project=contract-project", undefined, auth)).runs.length, 1);

  assert.equal(
    (await request(root, "POST", `/runs/${run.id}/metrics`, {
      step: 0.5,
      timestamp: "2026-05-09T00:00:00Z",
      metrics: { reward: 1.25 },
    }, { ...auth, "Idempotency-Key": "contract-event-1" })).inserted,
    1,
  );
  assert.equal(
    (await request(root, "POST", `/runs/${run.id}/metrics`, {
      timestamp: "2026-05-09T00:00:00Z",
      metrics: { reward: 1.25 },
      step: 0.5,
    }, { ...auth, "Idempotency-Key": "contract-event-1" })).inserted,
    1,
  );
  const conflict = await fetch(`${root}/runs/${run.id}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth, "Idempotency-Key": "contract-event-1" },
    body: JSON.stringify({ step: 1, metrics: { reward: 2 } }),
  });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /idempotency key/);

  const validation = await fetch(`${root}/runs/${run.id}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ step: -1, metrics: { reward: 2 } }),
  });
  assert.equal(validation.status, 400);
  assert.equal((await expectStatus(root, "POST", `/runs/${run.id}/metrics`, 403, { step: 1, metrics: { reward: 2 } }, usageAuth)).error, "api key requires sdk:ingest");
  if (backendMode !== "node") {
    const logPayload = {
      stream: "stdout",
      lines: [
        { line_number: 1, message: "Epoch 1 loss=1.25", timestamp: "2026-05-09T00:00:00Z" },
        { line_number: 2, message: "\u001b[32mcheckpoint saved\u001b[0m", timestamp: "2026-05-09T00:00:01Z" },
      ],
    };
    assert.equal(
      (await request(root, "POST", `/api/runs/${run.id}/logs`, logPayload, { ...auth, "Idempotency-Key": "contract-log-1" })).inserted,
      2,
    );
    assert.equal(
      (await request(root, "POST", `/api/runs/${run.id}/logs`, logPayload, { ...auth, "Idempotency-Key": "contract-log-1" })).inserted,
      2,
    );
    assert.match(
      (await expectStatus(root, "POST", `/api/runs/${run.id}/logs`, 409, {
        stream: "stdout",
        lines: [{ line_number: 3, message: "different", timestamp: "2026-05-09T00:00:02Z" }],
      }, { ...auth, "Idempotency-Key": "contract-log-1" })).error,
      /idempotency key/,
    );
    assert.equal((await expectStatus(root, "POST", `/api/runs/${run.id}/logs`, 403, logPayload, usageAuth)).error, "api key requires sdk:ingest");
    assert.match(
      (await expectStatus(root, "POST", `/api/runs/${run.id}/logs`, 400, {
        stream: "stdout",
        lines: [{ message: "missing line number" }],
      }, auth)).error,
      /line_number/,
    );
    const firstLogPage = await request(root, "GET", `/api/runs/${run.id}/logs?stream=stdout&limit=1`, undefined, auth);
    assert.equal(firstLogPage.lines.length, 1);
    assert.equal(firstLogPage.lines[0].message, "Epoch 1 loss=1.25");
    assert.ok(firstLogPage.next_cursor);
    const secondLogPage = await request(root, "GET", `/api/runs/${run.id}/logs?stream=stdout&limit=10&cursor=${encodeURIComponent(firstLogPage.next_cursor)}`, undefined, auth);
    assert.equal(secondLogPage.lines[0].line_number, 2);
    const searchedLogs = await request(root, "GET", `/api/runs/${run.id}/logs?stream=stdout&q=checkpoint&limit=10`, undefined, auth);
    assert.equal(searchedLogs.lines.length, 1);
    assert.match(searchedLogs.lines[0].message, /checkpoint/);
    assert.match((await expectStatus(root, "GET", `/api/runs/${run.id}/logs?cursor=${"a".repeat(300)}`, 400, undefined, auth)).error, /cursor/);
  }
  const tooLarge = await fetch(`${root}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: " ".repeat(1_000_001),
  });
  assert.equal(tooLarge.status, 413);
  const missingRun = await fetch(`${root}/runs/missing/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ step: 1, metrics: { reward: 1 } }),
  });
  assert.equal(missingRun.status, 404);

  const otherOrg = (await request(root, "POST", "/api/orgs", {
    slug: `other-${Date.now()}`,
    name: "Other Contract Smoke",
  }, bootstrapHeaders)).organization;
  const otherKey = await request(root, "POST", `/api/orgs/${otherOrg.id}/api-keys`, { name: "other-sdk" }, bootstrapHeaders);
  const crossOrg = await fetch(`${root}/runs/${run.id}/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherKey.api_key}` },
    body: JSON.stringify({ step: 2, metrics: { reward: 9 } }),
  });
  assert.equal(crossOrg.status, 403);

  const metrics = (await request(root, "GET", `/runs/${run.id}/metrics?key=reward&start_step=0.5&end_step=0.5&limit=10`, undefined, auth)).metrics;
  assert.deepEqual(metrics.map((point) => [point.key, point.step, point.value]), [["reward", 0.5, 1.25]]);

  const unauthAttribute = await fetch(`${root}/api/runs/${run.id}/attributes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "notes/blocked", type: "string_series", step: 0.5, value: "blocked" }),
  });
  assert.equal(unauthAttribute.status, 401);
  assert.equal((await expectStatus(root, "POST", `/api/runs/${run.id}/attributes`, 403, {
    attributes: [{ path: "notes/blocked-usage", type: "string_series", step: 0.5, value: "blocked" }],
  }, usageAuth)).error, "api key requires sdk:ingest");
  await request(root, "POST", `/api/runs/${run.id}/attributes`, {
    attributes: [{ path: "notes/status", type: "string_series", step: 0.5, value: "ok" }],
  }, auth);
  const unauthUpload = await fetch(`${root}/api/runs/${run.id}/artifacts/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "blocked.txt", content_base64: Buffer.from("blocked").toString("base64") }),
  });
  assert.equal(unauthUpload.status, 401);
  assert.equal((await expectStatus(root, "POST", `/api/runs/${run.id}/artifacts/upload`, 403, {
    name: "blocked-usage.txt",
    content_base64: Buffer.from("blocked").toString("base64"),
  }, usageAuth)).error, "api key requires artifacts:write");
  assert.equal((await expectStatus(root, "POST", `/api/runs/${run.id}/artifacts`, 403, {
    type: "file",
    name: "blocked-usage-metadata.txt",
    uri: "file://blocked-usage-metadata.txt",
  }, usageAuth)).error, "api key requires artifacts:write");
  const upload = (await request(root, "POST", `/api/runs/${run.id}/artifacts/upload`, {
    name: "contract.txt",
    content_base64: Buffer.from("contract artifact").toString("base64"),
    mime_type: "text/plain",
  }, auth)).artifact;
  const downloaded = await fetch(`${root}/api/artifacts/${upload.id}/download`);
  assert.equal(downloaded.status, 401);
  const authorizedDownload = await fetch(`${root}/api/artifacts/${upload.id}/download`, { headers: auth });
  assert.equal(await authorizedDownload.text(), "contract artifact");
  const usage = await request(root, "GET", "/api/usage", undefined, usageAuth);
  assert.equal(usage.organizations.length, 1);
  assert.equal(usage.organizations[0].org_id, org.id);
  assert.equal(usage.organizations[0].usage.metric_points, 1);
  assert.equal(usage.organizations[0].usage.artifact_bytes_exact, Buffer.byteLength("contract artifact"));
  const usageExport = await request(root, "GET", "/api/usage/export", undefined, usageAuth);
  assert.equal(usageExport.source, "computed_current_state");
  assert.equal(usageExport.organizations[0].org_id, org.id);
  assert.equal((await expectStatus(root, "POST", "/api/demo/reset", 403, {}, usageAuth)).error, "api key requires sdk:ingest");

  assert.equal((await request(root, "PATCH", `/runs/${run.id}`, { status: "finished" }, auth)).run.status, "finished");
  assert.equal((await request(root, "GET", `/api/runs/side-by-side?run_ids=${run.id}`, undefined, auth)).runs.length, 1);
  const summary = await request(root, "GET", "/api/runs/summary?project=contract-project", undefined, auth);
  assert.equal(summary.total, 1);
  assert.equal(summary.runs[0].metric_aggregates.reward.count, 1);

  const exported = await request(root, "GET", "/api/export?project=contract-project", undefined, auth);
  assert.equal(exported.version, 1);
  assert.equal(exported.runs[0].id, run.id);
  assert.equal(exported.metrics.length, 1);

  const importPayload = {
    project: `contract-import-${Date.now()}`,
    runs: [{ name: "imported-run", metrics: [{ key: "reward", step: 1, value: 3 }] }],
  };
  assert.equal((await expectStatus(root, "POST", "/api/imports/neptune", 401, importPayload)).error, "missing bearer token");
  assert.equal((await expectStatus(root, "POST", "/api/imports/neptune", 403, importPayload, usageAuth)).error, "api key requires imports:write");
  assert.equal((await request(root, "POST", "/api/imports/neptune?dry_run=true", importPayload, auth)).dry_run, true);
  const imported = await request(root, "POST", "/api/imports/neptune", importPayload, auth);
  assert.equal(imported.dry_run, false);
  assert.equal(imported.import.org_id, org.id);
  assert.equal((await request(root, "GET", "/api/imports", undefined, auth)).imports.length >= 1, true);
  assert.equal((await request(root, "GET", `/runs/${imported.import.run_ids[0]}`, undefined, auth)).run.org_id, org.id);
  const wandbImportPayload = {
    project: `contract-wandb-${Date.now()}`,
    runs: [{ id: "wandb-contract", name: "wandb-contract", history: [{ _step: 0, _timestamp: 1760000000, reward: 4 }] }],
  };
  assert.equal((await expectStatus(root, "POST", "/api/imports/wandb", 403, wandbImportPayload, usageAuth)).error, "api key requires imports:write");
  assert.equal((await request(root, "POST", "/api/imports/wandb?dry_run=true", wandbImportPayload, auth)).summary.metrics, 1);
  const wandbImported = await request(root, "POST", "/api/imports/wandb", wandbImportPayload, auth);
  assert.equal(wandbImported.import.source_type, "wandb_json");
  assert.equal((await request(root, "GET", `/runs/${wandbImported.import.run_ids[0]}`, undefined, auth)).run.latest_metrics.reward, 4);
  const mlflowImportPayload = {
    project: `contract-mlflow-${Date.now()}`,
    runs: [{
      info: { run_id: "mlflow-contract", status: "FINISHED", start_time: 1760000000000, end_time: 1760000060000 },
      data: { metrics: [{ key: "reward", value: 7, step: 1, timestamp: 1760000030000 }] },
      metric_history_complete: true,
    }],
  };
  assert.equal((await expectStatus(root, "POST", "/api/imports/mlflow", 403, mlflowImportPayload, usageAuth)).error, "api key requires imports:write");
  assert.equal((await request(root, "POST", "/api/imports/mlflow?dry_run=true", mlflowImportPayload, auth)).summary.metrics, 1);
  const mlflowImported = await request(root, "POST", "/api/imports/mlflow", mlflowImportPayload, auth);
  assert.equal(mlflowImported.import.source_type, "mlflow_json");
  assert.equal((await request(root, "GET", `/runs/${mlflowImported.import.run_ids[0]}`, undefined, auth)).run.org_id, org.id);
}

async function request(root, method, route, body, headers = {}) {
  const response = await fetch(root + route, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route} failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function expectStatus(root, method, route, status, body, headers = {}) {
  const response = await fetch(root + route, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${method} ${route} expected ${status} but got ${response.status}`);
  return payload;
}
