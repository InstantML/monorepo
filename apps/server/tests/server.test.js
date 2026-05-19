import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "../src/server.js";

async function withServer(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-node-"));
  const server = createServer({ dbPath: path.join(dir, "instantml.json"), storageRoot: path.join(dir, "artifacts"), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl, server, dir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function request(baseUrl, method, route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error), { status: response.status, payload });
  return payload;
}

test("HTTP lifecycle, summaries, artifacts, and API work", async () => {
  await withServer(async (baseUrl) => {
    assert.deepEqual(await request(baseUrl, "GET", "/health"), { status: "ok" });
    const project = (await request(baseUrl, "POST", "/projects", { name: "cartpole" })).project;
    const run = (await request(baseUrl, "POST", "/runs", { project: "cartpole", name: "seed-1", config: { seed: 1 }, tags: ["rl"] })).run;
    const peer = (await request(baseUrl, "POST", "/runs", { project: "cartpole", name: "seed-2", config: { seed: 2 }, tags: ["rl"] })).run;
    assert.equal(run.project_id, project.id);
    assert.equal((await request(baseUrl, "POST", `/runs/${run.id}/metrics`, { step: 0, metrics: { "eval/return_mean": 5 } })).inserted, 1);
    assert.equal((await request(baseUrl, "POST", `/runs/${peer.id}/metrics`, { step: 0, metrics: { "eval/return_mean": 8 } })).inserted, 1);
    let malformedMetric = await fetch(baseUrl + `/runs/${run.id}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: [], metrics: { reward: 1 } }),
    });
    assert.equal(malformedMetric.status, 400);
    assert.match((await malformedMetric.json()).error, /step/);
    malformedMetric = await fetch(baseUrl + `/runs/${run.id}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: 1, metrics: { reward: [] } }),
    });
    assert.equal(malformedMetric.status, 400);
    assert.match((await malformedMetric.json()).error, /metric values/);
    assert.equal((await request(baseUrl, "PATCH", `/runs/${run.id}`, { status: "finished" })).run.status, "finished");
    const patchedRun = (await request(baseUrl, "PATCH", `/runs/${run.id}`, { tags: ["baseline", "note-search"], notes: "server note search token" })).run;
    assert.deepEqual(patchedRun.tags, ["baseline", "note-search"]);
    assert.equal(patchedRun.metadata.notes, "server note search token");
    assert.equal((await request(baseUrl, "GET", "/runs?project=cartpole")).runs.length, 2);
    assert.equal((await request(baseUrl, "GET", `/runs/${run.id}`)).run.id, run.id);
    assert.equal((await request(baseUrl, "GET", `/runs/${run.id}/metrics?key=eval/return_mean&limit=1`)).metrics[0].value, 5);
    const attributes = (await request(baseUrl, "POST", `/api/runs/${run.id}/attributes`, {
      attributes: [
        { path: "notes/eval", type: "string_series", step: 0, value: "ready" },
        { path: "model/grads", type: "histogram_series", step: 0, value: { bins: [0, 1], counts: [3] } },
      ],
    })).attributes;
    assert.equal(attributes.length, 2);
    assert.equal((await request(baseUrl, "GET", `/api/runs/${run.id}/attributes?type=string_series&path_prefix=notes`)).attributes[0].value, "ready");

    const artifact = (await request(baseUrl, "POST", `/api/runs/${run.id}/artifacts`, {
      type: "checkpoint",
      name: "policy.pt",
      uri: "demo://policy.pt",
      step: 0,
      metadata: { score: 5 },
    })).artifact;
    assert.equal(artifact.type, "checkpoint");
    assert.equal((await request(baseUrl, "GET", `/api/runs/${run.id}/artifacts`)).artifacts.length, 1);

    const upload = (await request(baseUrl, "POST", `/api/runs/${run.id}/artifacts/upload`, {
      name: "metrics.txt",
      content_base64: Buffer.from("hello metrics").toString("base64"),
      mime_type: "text/plain",
      metadata: { source: "test" },
    })).artifact;
    assert.equal(upload.size_bytes, 13);
    assert.equal(upload.sha256.length, 64);
    const downloaded = await fetch(`${baseUrl}/api/artifacts/${upload.id}/download`);
    assert.equal(downloaded.headers.get("content-type"), "text/plain");
    assert.equal(await downloaded.text(), "hello metrics");
    const missingFileArtifact = (await request(baseUrl, "POST", `/api/runs/${run.id}/artifacts`, {
      type: "file",
      name: "missing.txt",
      uri: "instantml://artifacts/missing.txt",
      storage_path: path.join(os.tmpdir(), "missing-instantml-artifact.txt"),
    })).artifact;
    assert.equal(missingFileArtifact.storage_path, null);
    const missingDownload = await fetch(`${baseUrl}/api/artifacts/${missingFileArtifact.id}/download`);
    assert.equal(missingDownload.status, 404);

    const summary = await request(baseUrl, "GET", "/api/runs/summary?project=cartpole&limit=10");
    assert.equal(summary.total, 2);
    const noteSearch = await request(baseUrl, "GET", "/api/runs/summary?project=cartpole&q=server%20note");
    assert.equal(noteSearch.total, 1);
    assert.equal(noteSearch.runs[0].id, run.id);
    assert.equal(summary.runs.find((item) => item.id === run.id).latest_metrics["eval/return_mean"], 5);
    assert.equal(summary.runs.find((item) => item.id === run.id).artifact_counts.checkpoint, 1);
    assert.equal(summary.runs.find((item) => item.id === run.id).metric_aggregates["eval/return_mean"].best_step, 0);
    const sideBySide = await request(baseUrl, "GET", `/api/runs/side-by-side?run_ids=${run.id},${peer.id}&diff_only=true`);
    assert.equal(sideBySide.rows.every((row) => row.different), true);
    const overview = (await request(baseUrl, "GET", "/api/overview?project=cartpole&metric_key=eval/return_mean")).overview;
    assert.equal(overview.total_runs, 2);
    assert.equal(overview.metric_points, 2);
  });
});

test("org API keys protect SDK ingestion and idempotent metric replay", async () => {
  await withServer(async (baseUrl) => {
    const bootstrapHeaders = { "X-INSTANTML-Bootstrap-Token": "test-bootstrap" };
    const user = (await request(baseUrl, "POST", "/api/users", {
      email: "owner@example.com",
      provider: "google",
      provider_subject: "sub-1",
    }, bootstrapHeaders)).user;
    const organization = (await request(baseUrl, "POST", "/api/orgs", {
      slug: "acme",
      name: "Acme",
      owner_user_id: user.id,
      plan_tier: "premium",
    }, bootstrapHeaders)).organization;
    assert.equal((await request(baseUrl, "GET", "/api/users", undefined, bootstrapHeaders)).users.length, 1);
    assert.equal((await request(baseUrl, "GET", "/api/orgs", undefined, bootstrapHeaders)).organizations.some((org) => org.id === organization.id), true);
    let response = await fetch(baseUrl + `/api/orgs/${organization.id}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "blocked" }),
    });
    assert.equal(response.status, 401);
    const keyResponse = await request(baseUrl, "POST", `/api/orgs/${organization.id}/api-keys`, { name: "sdk" }, bootstrapHeaders);
    assert.match(keyResponse.api_key, /^instantml_/);
    assert.equal((await request(baseUrl, "GET", `/api/orgs/${organization.id}/api-keys`, undefined, bootstrapHeaders)).api_keys[0].key_hash, undefined);

    const missingAuth = await fetch(baseUrl + "/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "secure", name: "blocked" }),
    });
    assert.equal(missingAuth.status, 401);

    const authHeaders = { Authorization: `Bearer ${keyResponse.api_key}` };
    response = await fetch(baseUrl + "/api/usage", { headers: authHeaders });
    assert.equal(response.status, 403);
    const usageKeyResponse = await request(baseUrl, "POST", `/api/orgs/${organization.id}/api-keys`, { name: "usage", scopes: ["usage:read"] }, bootstrapHeaders);
    const usageHeaders = { Authorization: `Bearer ${usageKeyResponse.api_key}` };
    const run = (await request(baseUrl, "POST", "/runs", { project: "secure", name: "seed-1" }, authHeaders)).run;
    assert.equal(run.org_id, organization.id);
    assert.equal(
      (await request(baseUrl, "POST", `/runs/${run.id}/metrics`, { step: 1, metrics: { reward: 2 } }, { ...authHeaders, "Idempotency-Key": "event-1" })).inserted,
      1,
    );
    assert.equal(
      (await request(baseUrl, "POST", `/runs/${run.id}/metrics`, { metrics: { reward: 2 }, step: 1 }, { ...authHeaders, "Idempotency-Key": "event-1" })).inserted,
      1,
    );
    response = await fetch(baseUrl + `/runs/${run.id}`);
    assert.equal(response.status, 401);
    response = await fetch(baseUrl + `/api/runs/${run.id}/attributes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/status", type: "string_series", step: 1, value: "ok" }),
    });
    assert.equal(response.status, 401);
    response = await fetch(baseUrl + `/api/runs/${run.id}/artifacts/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "blocked.txt", content_base64: Buffer.from("blocked").toString("base64") }),
    });
    assert.equal(response.status, 401);
    response = await fetch(baseUrl + "/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ project: "secure", name: "blocked-by-usage" }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sdk:ingest/);
    response = await fetch(baseUrl + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ name: "blocked-project" }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sdk:ingest/);
    response = await fetch(baseUrl + `/runs/${run.id}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ step: 2, metrics: { reward: 4 } }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sdk:ingest/);
    response = await fetch(baseUrl + `/api/runs/${run.id}/attributes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ path: "notes/blocked", type: "string_series", step: 2, value: "blocked" }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sdk:ingest/);
    response = await fetch(baseUrl + `/api/runs/${run.id}/artifacts/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ name: "blocked-by-usage.txt", content_base64: Buffer.from("blocked").toString("base64") }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /artifacts:write/);
    response = await fetch(baseUrl + `/api/runs/${run.id}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ type: "file", name: "blocked-by-usage.txt", uri: "file://blocked-by-usage.txt" }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /artifacts:write/);
    response = await fetch(baseUrl + `/runs/${run.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ status: "finished" }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sdk:ingest/);
    response = await fetch(baseUrl + "/api/demo/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sdk:ingest/);
    assert.equal((await request(baseUrl, "POST", `/api/runs/${run.id}/attributes`, { path: "notes/status", type: "string_series", step: 1, value: "ok" }, authHeaders)).attributes.length, 1);
    assert.equal((await request(baseUrl, "POST", `/api/runs/${run.id}/artifacts/upload`, {
      name: "allowed.txt",
      content_base64: Buffer.from("allowed").toString("base64"),
    }, authHeaders)).artifact.size_bytes, 7);
    const usage = await request(baseUrl, "GET", "/api/usage", undefined, usageHeaders);
    assert.equal(usage.organizations.length, 1);
    assert.equal(usage.organizations[0].org_id, organization.id);
    assert.equal(usage.organizations[0].usage.metric_points, 1);
    assert.equal(usage.organizations[0].usage.artifact_bytes_exact, 7);
    assert.equal(usage.organizations[0].usage.api_keys, 2);
    const usageExport = await request(baseUrl, "GET", "/api/usage/export", undefined, usageHeaders);
    assert.equal(usageExport.source, "computed_current_state");
    assert.equal(usageExport.organizations[0].org_id, organization.id);
    response = await fetch(baseUrl + "/api/imports/neptune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "secure-import", runs: [{ name: "blocked" }] }),
    });
    assert.equal(response.status, 401);
    response = await fetch(baseUrl + "/api/imports/neptune", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ project: "secure-import", runs: [{ name: "blocked-by-scope" }] }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /imports:write/);
    assert.equal((await request(baseUrl, "POST", "/api/imports/neptune?dry_run=true", { project: "secure-import", runs: [{ name: "allowed" }] }, authHeaders)).dry_run, true);
    const imported = await request(baseUrl, "POST", "/api/imports/neptune", { project: "secure-import", runs: [{ name: "allowed", metrics: [{ key: "reward", step: 1, value: 5 }] }] }, authHeaders);
    assert.equal(imported.dry_run, false);
    const wandbDryRun = await request(baseUrl, "POST", "/api/imports/wandb?dry_run=true", {
      project: "secure-wandb",
      runs: [{ id: "wandb-secure", name: "wandb-secure", history: [{ _step: 0, reward: 2 }] }],
    }, authHeaders);
    assert.deepEqual(wandbDryRun.summary, { project: "secure-wandb", runs: 1, metrics: 1, attributes: 0, artifacts: 0 });
    const wandbImported = await request(baseUrl, "POST", "/api/imports/wandb", {
      project: "secure-wandb",
      runs: [{ id: "wandb-secure", name: "wandb-secure", history: [{ _step: 0, reward: 2 }] }],
    }, authHeaders);
    assert.equal(wandbImported.import.org_id, organization.id);
    response = await fetch(baseUrl + "/api/imports/mlflow", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...usageHeaders },
      body: JSON.stringify({ project: "secure-mlflow", runs: [{ info: { run_id: "blocked-by-scope" } }] }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /imports:write/);
    const mlflowDryRun = await request(baseUrl, "POST", "/api/imports/mlflow?dry_run=true", {
      project: "secure-mlflow",
      runs: [{ info: { run_id: "mlflow-secure", status: "FINISHED" }, data: { metrics: [{ key: "reward", value: 6, step: 1 }] } }],
    }, authHeaders);
    assert.equal(mlflowDryRun.summary.metrics, 1);
    const mlflowImported = await request(baseUrl, "POST", "/api/imports/mlflow", {
      project: "secure-mlflow",
      runs: [{ info: { run_id: "mlflow-secure", status: "FINISHED" }, data: { metrics: [{ key: "reward", value: 6, step: 1 }] } }],
    }, authHeaders);
    assert.equal(mlflowImported.import.org_id, organization.id);
    assert.equal((await request(baseUrl, "GET", "/api/runs/summary?project=secure-import", undefined, authHeaders)).total, 1);
    assert.equal((await request(baseUrl, "GET", "/api/imports", undefined, authHeaders)).imports[0].org_id, organization.id);
    const conflict = await fetch(`${baseUrl}/runs/${run.id}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders, "Idempotency-Key": "event-1" },
      body: JSON.stringify({ step: 2, metrics: { reward: 3 } }),
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /idempotency key/);
    assert.equal((await request(baseUrl, "GET", `/runs/${run.id}/metrics?key=reward`, undefined, authHeaders)).metrics.length, 1);
    assert.equal((await request(baseUrl, "PATCH", `/runs/${run.id}`, { status: "finished" }, authHeaders)).run.status, "finished");

    const exported = await request(baseUrl, "GET", "/api/export?project=secure", undefined, authHeaders);
    assert.equal(exported.organizations[0].id, organization.id);
    assert.equal(exported.metric_series[0].count, 1);
  }, { requireApiKey: true, bootstrapToken: "test-bootstrap" });
});

test("HTTP plan limit errors are structured and non-retryable", async () => {
  await withServer(async (baseUrl) => {
    const bootstrapHeaders = { "X-INSTANTML-Bootstrap-Token": "test-bootstrap" };
    const user = (await request(baseUrl, "POST", "/api/users", {
      email: "free-owner@example.com",
      provider: "google",
      provider_subject: "free-sub-1",
    }, bootstrapHeaders)).user;
    const organization = (await request(baseUrl, "POST", "/api/orgs", {
      slug: "free-limits",
      name: "Free Limits",
      owner_user_id: user.id,
      plan_tier: "free",
    }, bootstrapHeaders)).organization;
    const keyResponse = await request(baseUrl, "POST", `/api/orgs/${organization.id}/api-keys`, {
      name: "sdk",
      scopes: ["sdk:ingest", "artifacts:write", "usage:read"],
    }, bootstrapHeaders);
    const authHeaders = { Authorization: `Bearer ${keyResponse.api_key}` };
    const run = (await request(baseUrl, "POST", "/runs", { project: "limits", name: "seed-1" }, authHeaders)).run;

    const response = await fetch(baseUrl + `/api/runs/${run.id}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        type: "file",
        name: "too-large.bin",
        uri: "s3://bucket/too-large.bin",
        size_bytes: 3 * 1024 ** 3,
      }),
    });

    assert.equal(response.status, 402);
    const payload = await response.json();
    assert.equal(payload.code, "plan_limit_exceeded");
    assert.match(payload.error, /storage would exceed/);
    const usage = await request(baseUrl, "GET", "/api/usage", undefined, authHeaders);
    assert.equal(usage.organizations[0].warnings.length, 0);
  }, { requireApiKey: true, bootstrapToken: "test-bootstrap" });
});

test("Neptune import endpoint supports dry-run query override and import history", async () => {
  await withServer(async (baseUrl) => {
    const payload = {
      project: "migration",
      dry_run: false,
      runs: [
        {
          name: "neptune-run",
          config: { seed: 9 },
          tags: ["migrated"],
          metrics: [{ key: "reward", step: 1, value: 10 }],
          attributes: [{ path: "notes/status", type: "string_series", step: 1, value: "ok" }],
          artifacts: [{ type: "file", name: "params.json", uri: "file://params.json" }],
        },
      ],
    };
    const dry = await request(baseUrl, "POST", "/api/imports/neptune?dry_run=true", payload);
    assert.equal(dry.dry_run, true);
    assert.equal((await request(baseUrl, "GET", "/api/runs/summary?project=migration")).total, 0);

    const imported = await request(baseUrl, "POST", "/api/imports/neptune", payload);
    assert.equal(imported.dry_run, false);
    assert.equal((await request(baseUrl, "GET", "/api/imports")).imports.length, 1);
    const summary = await request(baseUrl, "GET", "/api/runs/summary?project=migration");
    assert.equal(summary.total, 1);
    assert.equal(summary.runs[0].latest_metrics.reward, 10);

    let malformed = await fetch(baseUrl + "/api/imports/neptune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "migration", runs: [null] }),
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /neptune run/);
    malformed = await fetch(baseUrl + "/api/imports/wandb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "migration", runs: [null] }),
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /wandb run/);
    malformed = await fetch(baseUrl + "/api/imports/mlflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "migration", runs: [null] }),
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /mlflow run/);
    malformed = await fetch(baseUrl + "/api/imports/wandb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "migration", runs: [{ name: "bad", history: [{ _timestamp: 9e99, reward: 1 }] }] }),
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /supported datetime range/);
    malformed = await fetch(baseUrl + "/api/imports/mlflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "migration", runs: [{ info: { run_id: "bad", start_time: 9e99 } }] }),
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /supported datetime range/);
  });
});

test("demo reset is project-scoped and route errors are JSON", { timeout: 30_000 }, async () => {
  await withServer(async (baseUrl) => {
    await request(baseUrl, "POST", "/runs", { project: "user", name: "keep-me" });
    const demo = await request(baseUrl, "POST", "/api/demo/reset", {});
    assert.equal(demo.runs.length, 100);
    assert.equal(demo.total, 1000);
    assert.equal((await request(baseUrl, "GET", "/api/runs/summary?project=user")).total, 1);
    const traversal = await rawGet(baseUrl, "/%2e%2e/package.json");
    assert.match(traversal, /route not found/);
    await assert.rejects(() => request(baseUrl, "POST", "/projects", { name: "" }), /project name/);
    await assert.rejects(() => request(baseUrl, "POST", "/missing", {}), /route not found/);
  });
});

test("request parsing and static serving guardrails work", async () => {
  await withServer(async (baseUrl, server, dir) => {
    const missing = await fetch(baseUrl + "/src/missing.js");
    assert.equal(missing.status, 404);

    let response = await fetch(baseUrl + "/projects", { method: "POST", body: "{}" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "content-type must be application/json");

    response = await fetch(baseUrl + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "request body must be valid JSON");

    response = await fetch(baseUrl + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "request body must be a JSON object");

    response = await fetch(baseUrl + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: " ".repeat(1_000_001),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "request body is too large");

    response = await fetch(baseUrl + "/api/runs/missing/artifacts/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "empty.txt", content_base64: "" }),
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /run not found/);

    const run = (await request(baseUrl, "POST", "/runs", { project: "cleanup", name: "cleanup-run" })).run;
    response = await fetch(baseUrl + `/api/runs/${run.id}/artifacts/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad.bin", content_base64: Buffer.from("bad").toString("base64"), type: "video" }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /type/);
    assert.equal(server.store.state.artifacts.length, 0);
    const artifactDir = path.join(dir, "artifacts");
    assert.equal(fs.existsSync(artifactDir) ? fs.readdirSync(artifactDir).length : 0, 0);

    response = await fetch(baseUrl + "/api/artifacts/missing/download");
    assert.equal(response.status, 404);
  });
});

test("listen starts a server on an ephemeral port", async () => {
  const { listen } = await import("../src/server.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-listen-"));
  const server = listen({ dbPath: path.join(dir, "listen.json"), port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  assert.ok(server.address().port > 0);
  await new Promise((resolve) => server.close(resolve));
  server.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("static server falls back to octet-stream for unknown file types", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-static-"));
  fs.writeFileSync(path.join(dir, "blob.bin"), "abc");
  const server = createServer({ dbPath: path.join(dir, "db.json"), webRoot: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/blob.bin`);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  await new Promise((resolve) => server.close(resolve));
  server.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Python SDK can log to the Node server without API changes", async () => {
  await withServer(async (baseUrl) => {
    const repo = process.cwd();
const script = `
import sys
import instantml as ro
run = ro.init(project="sdk-node", name="sdk-run", base_url="${baseUrl}", api_key="test")
run.log({"eval/return_mean": 12.5}, step=1)
run.finish()
print("sdk stdout covered")
print("sdk stderr covered", file=sys.stderr)
`;
    const result = await runPython(script, repo);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /sdk stdout covered/);
    assert.match(result.stderr, /sdk stderr covered/);
    const summary = await request(baseUrl, "GET", "/api/runs/summary?project=sdk-node");
    assert.equal(summary.runs[0].latest_metrics["eval/return_mean"], 12.5);
  });
});

function runPython(script, repo) {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", script], {
      cwd: repo,
      env: { ...process.env, PYTHONPATH: path.join(repo, "packages/python-sdk") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rawGet(baseUrl, route) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: route, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
}
