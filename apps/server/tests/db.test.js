import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConflictError, ForbiddenError, UnauthorizedError, createStore, defaultDbPath, emptyState, loadState, openStore, ValidationError } from "../src/db.js";

test("file-backed store persists and tolerates partial state files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-store-"));
  const dbPath = path.join(dir, "state.json");
  assert.equal(defaultDbPath(), path.join(".instantml", "instantml.json"));
  assert.deepEqual(loadState(path.join(dir, "missing.json")), emptyState());
  fs.writeFileSync(dbPath, JSON.stringify({ projects: [{ id: "p", name: "z", created_at: "t" }] }));
  const loaded = loadState(dbPath);
  assert.equal(loaded.projects[0].name, "z");
  assert.equal(loaded.projects[0].org_id, "local");

  const store = openStore(dbPath);
  store.createProject({ name: "a" });
  store.close();
  assert.equal(loadState(dbPath).projects.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("orgs, users, API keys, idempotency, summaries, and export work", () => {
  const store = createStore(emptyState());
  const user = store.createUser({
    email: "OWNER@EXAMPLE.COM",
    display_name: "Owner",
    provider: "google",
    provider_subject: "google-oauth2|1",
  });
  assert.equal(user.primary_email, "owner@example.com");
  assert.equal(store.createUser({ email: "owner@example.com", provider: "google", provider_subject: "google-oauth2|1" }).id, user.id);
  assert.equal(store.createUser({ email: "owner@example.com" }).id, user.id);
  assert.equal(store.listUsers().length, 1);

  const org = store.createOrganization({ slug: "acme-labs", name: "Acme Labs", owner_user_id: user.id });
  assert.equal(store.listOrganizations().some((organization) => organization.id === org.id), true);
  const member = store.createUser({ email: "member@example.com" });
  store.state.memberships.push({ id: "member-1", org_id: org.id, user_id: member.id, role: "member", created_at: "2026-05-09T00:00:00.000Z" });
  const createdKey = store.createApiKey(org.id, { name: "training", created_by_user_id: user.id, scopes: ["sdk:ingest", "artifacts:write"] });
  assert.match(createdKey.api_key, /^instantml_/);
  assert.equal(createdKey.key.key_hash, undefined);
  assert.equal(store.listApiKeys(org.id)[0].name, "training");
  const auth = store.authenticateApiKey(createdKey.api_key);
  assert.equal(auth.org_id, org.id);

  const run = store.createRun({ org_id: org.id, project: "research", name: "seed-1" });
  assert.equal(store.logMetrics(run.id, { step: 0.25, metrics: { reward: 1 } }, { auth, idempotencyKey: "evt-1" }), 1);
  assert.equal(store.logMetrics(run.id, { step: 0.25, metrics: { reward: 1 } }, { auth, idempotencyKey: "evt-1" }), 1);
  assert.equal(store.getMetrics(run.id, { key: "reward" }).length, 1);
  assert.throws(() => store.logMetrics(run.id, { step: 0.5, metrics: { reward: 2 } }, { auth, idempotencyKey: "evt-1" }), ConflictError);

  const otherOrg = store.createOrganization({ slug: "other-labs", name: "Other Labs" });
  const otherAuth = store.authenticateApiKey(store.createApiKey(otherOrg.id, { name: "other" }).api_key);
  assert.throws(() => store.logMetrics(run.id, { step: 1, metrics: { reward: 3 } }, { auth: otherAuth }), ForbiddenError);
  assert.throws(() => store.authenticateApiKey("instantml_bad"), UnauthorizedError);

  const summary = store.runsSummary({ org_id: org.id, project: "research" });
  assert.equal(summary.runs[0].latest_metrics.reward, 1);
  const rehydrated = store.getRun(run.id);
  assert.equal(rehydrated.latest_metrics.reward, 1);
  assert.equal(rehydrated.metric_aggregates.reward.count, 1);
  assert.equal(rehydrated.artifact_counts.checkpoint, 0);
  store.createArtifact(run.id, { type: "checkpoint", name: "large.pt", uri: "s3://bucket/large.pt", size_bytes: 6 * 1024 ** 3 });
  store.createArtifact(run.id, { type: "file", name: "unknown.bin", uri: "s3://bucket/unknown.bin" });
  const usage = store.usageSummary({ org_id: org.id });
  assert.equal(usage.billing_precision, "not_billable");
  assert.equal(usage.organizations.length, 1);
  assert.equal(usage.organizations[0].usage.seats, 2);
  assert.equal(usage.organizations[0].usage.paid_extra_seats, 1);
  assert.equal(usage.organizations[0].usage.projects, 1);
  assert.equal(usage.organizations[0].usage.runs, 1);
  assert.equal(usage.organizations[0].usage.metric_points, 1);
  assert.equal(usage.organizations[0].usage.metric_series, 1);
  assert.equal(usage.organizations[0].usage.artifacts, 2);
  assert.equal(usage.organizations[0].usage.api_keys, 1);
  assert.equal(usage.organizations[0].usage.artifact_bytes_exact, 6 * 1024 ** 3);
  assert.equal(usage.organizations[0].usage.artifact_bytes_unknown_count, 1);
  assert.equal(usage.organizations[0].warnings.some((warning) => warning.target === "seats" && warning.status === "paid_extra_seats"), true);
  assert.equal(usage.organizations[0].warnings.some((warning) => warning.target === "storage" && warning.status === "over_limit"), true);
  const usageExport = store.usageExport({ org_id: org.id });
  assert.equal(usageExport.source, "computed_current_state");
  assert.equal(usageExport.organizations[0].org_id, org.id);
  assert.equal(store.state.metricSeries[0].count, 1);
  const exported = store.exportData({ org_id: org.id, project: "research" });
  assert.equal(exported.version, 1);
  assert.equal(exported.organizations[0].id, org.id);
  assert.equal(exported.metric_series[0].key, "reward");
  assert.equal(exported.metrics.length, 1);
});

test("store supports runs, metrics, summaries, artifacts, and demo safety", () => {
  const store = createStore(emptyState());
  const userRun = store.createRun({ project: "user", name: "private-run", config: { seed: 1 }, tags: ["keep"] });
  store.logMetrics(userRun.id, { step: 0, metrics: { "eval/return_mean": 1 } });

  const demo = store.resetDemo();
  assert.equal(demo.runs.length, 100);
  assert.equal(demo.total, 1000);
  assert.equal(store.listRuns({ project: "user" }).length, 1);
  assert.equal(store.getMetrics(userRun.id, { key: "eval/return_mean" })[0].value, 1);

  const summary = store.runsSummary({ project: "demo", q: "seed", limit: 2 });
  assert.equal(summary.runs.length, 2);
  assert.equal(summary.total, 1000);
  assert.ok(summary.metric_keys.includes("eval/return_mean"));
  assert.ok(summary.metric_keys.includes("system/cpu_percent"));
  assert.ok(summary.metric_keys.includes("gpu/0/utilization_percent"));
  assert.ok(summary.metric_keys.includes("train/tokens_per_second"));
  assert.ok(summary.metric_keys.includes("rollout/ep_rew_mean"));
  assert.deepEqual(Object.keys(summary.runs[0].artifact_counts).sort(), ["checkpoint", "file", "rollout"]);
  assert.ok(summary.runs.some((run) => run.tags.includes("llm")) || store.runsSummary({ project: "demo", q: "llm", limit: 2 }).total > 0);
  assert.ok(store.runsSummary({ project: "demo", q: "hardware", limit: 2 }).total > 0);

  const artifacts = store.listArtifacts(summary.runs[0].id);
  assert.equal(artifacts.filter((artifact) => artifact.type === "checkpoint").length, 2);
  assert.ok(artifacts.some((artifact) => artifact.mime_type === "video/mp4" || artifact.mime_type === "audio/mpeg"));
  assert.equal(store.listProjects()[0].name, "demo");
  assert.equal(store.overview({ project: "user" }).metric_points, 1);
  assert.equal(store.overview({ project: "demo" }).total_runs, 1000);
  assert.equal(store.overview({ project: "demo", metric_key: "train/loss" }).best_eval_return > 0, true);
  store.resetDemo();
  assert.equal(store.runsSummary({ project: "demo" }).runs.length, 100);

  const org = store.createOrganization({ slug: "demo-org", name: "Demo Org" });
  const orgDemo = store.resetDemo({ org_id: org.id });
  assert.equal(orgDemo.runs.every((run) => run.org_id === org.id), true);
  assert.equal(orgDemo.total, 1000);
  assert.equal(store.runsSummary({ project: "demo" }).total, 2000);
  assert.equal(store.runsSummary({ org_id: org.id, project: "demo" }).total, 1000);
});

test("metric queries are bounded and deterministic with duplicate steps", () => {
  const store = createStore(emptyState());
  const run = store.createRun({ project: "demo", name: "run" });
  store.logMetrics(run.id, { step: 1, metrics: { reward: 1 } });
  store.logMetrics(run.id, { step: 1, metrics: { reward: 2 } });
  store.logMetrics(run.id, { step: 2, metrics: { reward: 3 } });

  const metrics = store.getMetrics(run.id, { key: "reward", limit: 2 });
  assert.deepEqual(metrics.map((metric) => metric.value), [1, 2]);

  const summary = store.runsSummary({ project: "demo" });
  assert.equal(summary.runs[0].latest_metrics.reward, 3);
});

test("run summaries sort globally before pagination and return filtered metric keys", () => {
  const store = createStore(emptyState());
  const weak = store.createRun({ project: "paging", name: "weak" });
  const strong = store.createRun({ project: "paging", name: "strong" });
  const hiddenMetric = store.createRun({ project: "paging", name: "hidden-metric" });
  store.logMetrics(weak.id, { step: 1, metrics: { reward: 1 } });
  store.logMetrics(strong.id, { step: 1, metrics: { reward: 10 } });
  store.logMetrics(hiddenMetric.id, { step: 1, metrics: { "train/loss": 0.1 } });
  store.state.runs.find((run) => run.id === weak.id).started_at = "2026-01-01T00:00:00.000Z";
  store.state.runs.find((run) => run.id === weak.id).finished_at = "2026-01-01T00:00:01.000Z";
  store.state.runs.find((run) => run.id === strong.id).started_at = "2026-01-01T00:00:00.000Z";
  store.state.runs.find((run) => run.id === strong.id).finished_at = "2026-01-01T00:00:03.000Z";

  const bestPage = store.runsSummary({ project: "paging", sort_by: "metric-best", metric_key: "reward", limit: 1, offset: 0 });
  assert.equal(bestPage.runs[0].name, "strong");
  assert.equal(bestPage.total, 3);
  assert.deepEqual(bestPage.metric_keys, ["reward", "train/loss"]);
  assert.equal(store.runsSummary({ project: "paging", sort_by: "duration" }).runs[0].name, "strong");
  assert.throws(() => store.runsSummary({ project: "paging", sort_by: "weird" }), /sort_by/);
});

test("typed attributes, float steps, aggregates, artifacts, and comparison rows work", () => {
  const store = createStore(emptyState());
  const first = store.createRun({
    project: "compare",
    name: "seed-1",
    config: { seed: 1, lr: 0.1 },
    tags: ["baseline"],
    metadata: { entrypoint: "train.py" },
  });
  const second = store.createRun({
    project: "compare",
    name: "seed-2",
    config: { seed: 2, lr: 0.2 },
    tags: ["candidate"],
  });

  store.logMetrics(first.id, {
    step: 0.5,
    timestamp: "2026-01-01T00:00:00.000Z",
    preview: true,
    preview_completion: 0.25,
    metrics: { reward: 1, loss: 4 },
  });
  store.logMetrics(first.id, { step: 1.5, metrics: { reward: 3 } });
  store.logMetrics(second.id, { step: 1.5, metrics: { reward: 5 } });
  store.createAttributes(first.id, {
    attributes: [
      { path: "notes/eval", type: "string_series", step: 1.5, value: "stable" },
      { path: "model/weights", type: "histogram_series", step: 1.5, value: { bins: [0, 1], counts: [2] } },
      { path: "sys/group_tags", type: "tag", value: "baseline", summary: { group: true } },
    ],
  });
  assert.throws(() => store.createAttributes(first.id, {
    attributes: [
      { path: "notes/kept-out", type: "string_series", step: 2, value: "no partial write" },
      { path: "bad/type", type: "unknown", value: "bad" },
    ],
  }), /type/);
  assert.equal(store.listAttributes(first.id, { path_prefix: "notes/kept-out" }).length, 0);
  const artifact = store.createArtifact(first.id, {
    type: "checkpoint",
    name: "policy.pt",
    uri: "instantml://artifact/policy.pt",
    step: 1.5,
    size_bytes: 12,
    sha256: "abc123",
    mime_type: "application/octet-stream",
    storage_path: "/tmp/policy.pt",
  });

  assert.equal(store.getMetrics(first.id, { start_step: 0.5, end_step: 0.5 })[0].step, 0.5);
  assert.equal(store.listAttributes(first.id, { type: "config", path_prefix: "config/s" })[0].value, 1);
  assert.equal(store.listAttributes(first.id, { type: "float_series", path_prefix: "reward" })[0].summary.preview_completion, 0.25);
  assert.equal(store.listAttributes(first.id, { type: "file_series" })[0].artifact_id, artifact.id);
  assert.equal(store.getArtifact(artifact.id).sha256, "abc123");

  const summary = store.runsSummary({ project: "compare" });
  const firstSummary = summary.runs.find((run) => run.id === first.id);
  assert.equal(firstSummary.metric_aggregates.reward.latest, 3);
  assert.equal(firstSummary.metric_aggregates.reward.max, 3);
  assert.equal(firstSummary.metric_aggregates.reward.best_step, 1.5);
  assert.equal(firstSummary.metric_aggregates.reward.count, 2);
  assert.equal(firstSummary.artifact_counts.checkpoint, 1);
  const updated = store.updateRun(first.id, {
    tags: ["baseline", "reviewed"],
    notes: "human note token stable policy",
  });
  assert.deepEqual(updated.tags, ["baseline", "reviewed"]);
  assert.equal(updated.metadata.notes, "human note token stable policy");
  assert.equal(store.runsSummary({ project: "compare", q: "human stable" }).runs[0].id, first.id);
  assert.equal(store.runsSummary({ project: "compare", q: "reviewed" }).runs[0].id, first.id);

  const comparison = store.sideBySide({ run_ids: [first.id, second.id], reference_run_id: first.id });
  assert.equal(comparison.runs.length, 2);
  assert.equal(comparison.rows.find((row) => row.path === "config/lr").different, true);
  assert.equal(store.sideBySide({ run_ids: `${first.id},${second.id}`, diff_only: "true" }).rows.every((row) => row.different), true);
});

test("Neptune-style import supports dry runs, imports, and summaries", () => {
  const store = createStore(emptyState());
  const payload = {
    project: "neptune-import",
    runs: [
      {
        name: "remote-run",
        id: "NEP-1",
        status: "finished",
        config: { seed: 7 },
        tags: ["migrated"],
        metadata: { neptune_id: "NEP-1", _rlobs: { external: true } },
        metrics: [{ key: "eval/return_mean", step: 1, value: 42, timestamp: "2026-01-01T00:00:00.000Z" }],
        attributes: [{ path: "notes/comment", type: "string_series", step: 1, value: "ported" }],
        artifacts: [{ type: "file", name: "config.json", uri: "file://config.json", size_bytes: 10 }],
      },
    ],
  };

  const dryRun = store.importNeptune({ ...payload, dry_run: true });
  assert.equal(dryRun.dry_run, true);
  assert.deepEqual(dryRun.summary, { project: "neptune-import", runs: 1, metrics: 1, attributes: 1, artifacts: 1 });
  assert.equal(store.runsSummary({ project: "neptune-import" }).total, 0);

  const imported = store.importNeptune(payload);
  assert.equal(imported.dry_run, false);
  assert.equal(imported.import.run_ids.length, 1);
  assert.equal(store.listImports()[0].source_type, "neptune_exporter_json");
  const summary = store.runsSummary({ project: "neptune-import" });
  assert.equal(summary.total, 1);
  assert.equal(summary.runs[0].latest_metrics["eval/return_mean"], 42);
  const importedRun = store.getRun(imported.import.run_ids[0]);
  assert.equal(importedRun.metadata.import.external_run_id, "NEP-1");
  assert.equal(importedRun.metadata.neptune.run_id, "NEP-1");
  assert.equal(importedRun.metadata.neptune.metadata._rlobs.external, true);
  assert.equal(importedRun.metadata._rlobs, undefined);
  assert.equal(store.listAttributes(importedRun.id, { type: "string_series" })[0].value, "ported");

  const org = store.createOrganization({ slug: "import-org", name: "Import Org" });
  const orgImported = store.importNeptune({ ...payload, org_id: org.id, project: "org-import" });
  assert.equal(orgImported.import.org_id, org.id);
  assert.equal(store.runsSummary({ org_id: org.id, project: "org-import" }).total, 1);
  assert.equal(store.listImports({ org_id: org.id }).length, 1);
  assert.equal(store.listImports({ org_id: "local" }).length, 1);

  const beforeInvalid = JSON.stringify(store.state);
  assert.throws(() => store.importNeptune({
    project: "bad-import",
    runs: [
      { name: "valid-first", metrics: [{ key: "reward", step: 1, value: 1 }] },
      { name: "invalid-second", metrics: [{ key: "reward", step: -1, value: 2 }] },
    ],
  }), /step/);
  assert.equal(JSON.stringify(store.state), beforeInvalid);
});

test("W&B JSON import normalizes representative runs without downloading artifacts", () => {
  const store = createStore(emptyState());
  const payload = {
    project: "wandb-import",
    runs: [
      {
        id: "wandb-1",
        name: "seed-1",
        state: "finished",
        config: { seed: 1 },
        tags: ["baseline"],
        metadata: { host: "trainer", _rlobs: { external: true } },
        summary: { best_reward: 3 },
        history: [
          { _timestamp: 1760000000, reward: 1, sparse: null, blank: "", ignored_array: [], ignored_object: { no: "scalar" } },
          { _step: 4, _timestamp: "2026-05-09T00:00:00Z", reward: 3, flag: true },
        ],
        artifacts: [
          { name: "policy.pt", type: "model", uri: "wandb://entity/project/runs/wandb-1/files/policy.pt", size_bytes: 12 },
          { name: "metrics.json", type: "dataset", uri: "wandb://entity/project/runs/wandb-1/files/metrics.json", size_bytes: 6 },
        ],
      },
    ],
  };

  const dryRun = store.importWandb({ ...payload, dry_run: true });
  assert.equal(dryRun.dry_run, true);
  assert.deepEqual(dryRun.summary, { project: "wandb-import", runs: 1, metrics: 2, attributes: 0, artifacts: 2 });
  assert.equal(store.runsSummary({ project: "wandb-import" }).total, 0);

  const imported = store.importWandb(payload);
  assert.equal(imported.dry_run, false);
  assert.deepEqual(imported.summary, dryRun.summary);
  assert.equal(store.listImports()[0].source_type, "wandb_json");
  const run = store.getRun(imported.import.run_ids[0]);
  assert.equal(run.metadata.wandb.run_id, "wandb-1");
  assert.equal(run.metadata.wandb.metadata._rlobs.external, true);
  assert.equal(run.latest_metrics.reward, 3);
  const metrics = store.getMetrics(run.id, { key: "reward" });
  assert.equal(metrics[0].step, 0);
  assert.equal(metrics[0].created_at, "2025-10-09T08:53:20.000Z");
  assert.equal(metrics[1].step, 4);
  const artifacts = store.listArtifacts(run.id);
  assert.equal(artifacts[0].type, "checkpoint");
  assert.equal(artifacts[0].metadata.external_type, "model");
  assert.equal(artifacts[1].type, "file");
  assert.equal(artifacts[1].metadata.external_type, "dataset");
});

test("MLflow JSON import preserves history, latest fallback, timestamps, and artifact references", () => {
  const store = createStore(emptyState());
  const payload = {
    schema_version: 1,
    project: "mlflow-import",
    runs: [
      {
        info: {
          run_id: "mlflow-1",
          run_uuid: "mlflow-uuid-1",
          run_name: "seed-1",
          experiment_id: "12",
          status: "FINISHED",
          start_time: 1760000000000,
          end_time: "2025-10-09T08:55:00Z",
          artifact_uri: "s3://bucket/mlruns/12/mlflow-1/artifacts/",
        },
        data: {
          params: [{ key: "seed", value: "1" }],
          tags: [{ key: "mlflow.user", value: "researcher" }],
          metrics: [
            { key: "reward", value: 10, step: 99, timestamp: 1760000099000 },
            { key: "loss", value: 0.5, step: 2, timestamp: 1760000020000 },
          ],
        },
        metric_history_complete: false,
        metric_history: [
          { key: "reward", value: 1, step: 1, timestamp: 1760000010000 },
          { key: "reward", value: 4, step: 3, timestamp: "2025-10-09T08:54:00Z" },
        ],
        artifacts: [
          { path: "checkpoints/policy.pt", file_size: 12345, is_dir: false },
          { path: "nested", is_dir: true },
        ],
      },
    ],
  };

  const dryRun = store.importMlflow({ ...payload, dry_run: true });
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.summary.metrics, 3);
  assert.equal(dryRun.summary.artifacts, 1);
  assert.equal(dryRun.summary.skipped.artifact_directories, 1);
  assert.equal(dryRun.summary.warnings.length, 1);
  assert.equal(store.runsSummary({ project: "mlflow-import" }).total, 0);

  const imported = store.importMlflow(payload);
  assert.equal(imported.dry_run, false);
  assert.deepEqual(imported.summary, dryRun.summary);
  assert.equal(store.listImports()[0].source_type, "mlflow_json");
  const run = store.getRun(imported.import.run_ids[0]);
  assert.equal(run.started_at, "2025-10-09T08:53:20.000Z");
  assert.equal(run.finished_at, "2025-10-09T08:55:00.000Z");
  assert.equal(run.config.seed, "1");
  assert.equal(run.metadata.import.external_run_id, "mlflow-1");
  assert.equal(run.metadata.mlflow.latest_metrics.reward.value, 10);
  assert.equal(run.metadata.mlflow.latest_metrics.loss.value, 0.5);
  assert.equal(run.latest_metrics.reward, 4);
  assert.equal(run.latest_metrics.loss, 0.5);
  const rewardMetrics = store.getMetrics(run.id, { key: "reward" });
  assert.deepEqual(rewardMetrics.map((metric) => [metric.step, metric.value]), [[1, 1], [3, 4]]);
  assert.equal(rewardMetrics[0].created_at, "2025-10-09T08:53:30.000Z");
  const artifacts = store.listArtifacts(run.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].type, "checkpoint");
  assert.equal(artifacts[0].uri, "s3://bucket/mlruns/12/mlflow-1/artifacts/checkpoints/policy.pt");
  assert.equal(artifacts[0].metadata.path, "checkpoints/policy.pt");
});

test("MLflow importer rejects schema drift and unsafe transformed fixtures", () => {
  const store = createStore(emptyState());
  assert.throws(() => store.importMlflow({ schema_version: 2, project: "bad", runs: [{ info: { run_id: "r1" } }] }), /schema_version/);
  assert.throws(() => store.importMlflow({ project: "bad", runs: [null] }), /mlflow run/);
  assert.throws(() => store.importMlflow({ project: "bad", runs: [{ info: { run_id: "r1", status: "UNKNOWN" } }] }), /mlflow status/);
  assert.throws(() => store.importMlflow({
    project: "bad",
    runs: [{ info: { run_id: "r1" }, data: { params: [{ key: "seed", value: "1" }, { key: "seed", value: "2" }] } }],
  }), /unique/);
  assert.throws(() => store.importMlflow({
    project: "bad",
    runs: [{ info: { run_id: "r1" }, metric_history: [{ key: "reward", value: [], step: 1 }] }],
  }), /metric values/);
  assert.throws(() => store.importMlflow({
    project: "bad",
    runs: [{ info: { run_id: "r1", start_time: {} } }],
  }), /epoch milliseconds/);
  assert.throws(() => store.importMlflow({
    project: "bad",
    runs: [{ info: { run_id: "r1", start_time: 9e99 } }],
  }), /supported datetime range/);
  assert.throws(() => store.importMlflow({
    project: "bad",
    runs: [{ info: { run_id: "r1" }, artifacts: [{ path: "../secret.txt", file_size: 1 }] }],
  }), /traversal/);
  const scheduled = store.importMlflow({ project: "scheduled", runs: [{ info: { run_id: "scheduled-1", status: "SCHEDULED" } }] });
  assert.equal(store.getRun(scheduled.import.run_ids[0]).status, "running");
});

test("malformed importer fixtures fail validation without mutating state", () => {
  const store = createStore(emptyState());
  const before = JSON.stringify(store.state);
  assert.throws(() => store.importNeptune({ project: "bad-neptune", runs: [null] }), /neptune run/);
  assert.throws(() => store.importNeptune({ project: "bad-neptune", runs: [{ name: "bad", metrics: [null] }] }), /run metric/);
  assert.throws(() => store.importNeptune({ project: "bad-neptune", runs: [{ name: "bad", metrics: [{ key: "reward", step: [], value: 1 }] }] }), /step/);
  assert.throws(() => store.importNeptune({ project: "bad-neptune", runs: [{ name: "bad", metrics: [{ key: "reward", step: 1, value: [] }] }] }), /metric values/);
  assert.throws(() => store.importNeptune({ project: "bad-neptune", runs: [{ name: "bad", attributes: [null] }] }), /type/);
  assert.throws(() => store.importNeptune({ project: "bad-neptune", runs: [{ name: "bad", artifacts: [null] }] }), /type/);
  assert.throws(() => store.importWandb({ project: "bad-wandb", runs: [null] }), /wandb run/);
  assert.throws(() => store.importWandb({ project: "bad-wandb", runs: [{ name: "bad", history: [null] }] }), /wandb history rows/);
  assert.throws(() => store.importWandb({ project: "bad-wandb", runs: [{ name: "bad", history: [{ _step: [], reward: 1 }] }] }), /_step/);
  assert.throws(() => store.importWandb({ project: "bad-wandb", runs: [{ name: "bad", artifacts: [null] }] }), /wandb artifact/);
  assert.throws(() => store.importMlflow({ project: "bad-mlflow", runs: [{ info: { run_id: "bad" }, artifacts: [null] }] }), /mlflow artifact/);
  assert.equal(JSON.stringify(store.state), before);
});

test("validation errors match the API contract", () => {
  const store = createStore(emptyState());
  const defaultNamedRun = store.createRun({ project: "default-name" });
  assert.equal(defaultNamedRun.name, "default-name-run");
  assert.equal(store.getRun(defaultNamedRun.id).id, defaultNamedRun.id);
  assert.equal(store.updateRun(defaultNamedRun.id, { status: "running" }).finished_at, null);
  assert.throws(() => store.createProject({ name: "" }), /project name/);
  assert.throws(() => store.createProject({ name: "x", description: 1 }), /description/);
  assert.throws(() => store.createOrganization({ slug: "bad-plan", name: "Bad Plan", plan_tier: "huge" }), /plan_tier/);
  assert.throws(() => store.createRun({ project: "x", config: [] }), /config/);
  assert.throws(() => store.createRun({ project: "x", tags: [""] }), /tags/);
  assert.throws(() => store.createRun({ project: "x", metadata: [] }), /metadata/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => store.createRun({ project: "x", config: circular }), /JSON serializable/);
  assert.throws(() => store.listRuns({ status: "paused" }), /status/);
  assert.throws(() => store.listRuns({ limit: 0 }), /limit/);

  const run = store.createRun({ project: "demo", name: "run" });
  assert.throws(() => store.updateRun(run.id, {}), /at least one/);
  assert.throws(() => store.updateRun(run.id, { notes: [] }), /notes/);
  assert.throws(() => store.logMetrics(run.id, { step: -1, metrics: { x: 1 } }), /step/);
  assert.throws(() => store.logMetrics(run.id, { step: [], metrics: { x: 1 } }), /step/);
  assert.throws(() => store.logMetrics(run.id, { step: true, metrics: { x: 1 } }), /step/);
  assert.throws(() => store.logMetrics(run.id, { step: "", metrics: { x: 1 } }), /step/);
  assert.throws(() => store.logMetrics(run.id, { step: 0, metrics: {} }), /metrics/);
  assert.throws(() => store.logMetrics(run.id, { step: 0, metrics: { x: Infinity } }), /finite/);
  assert.throws(() => store.logMetrics(run.id, { step: 0, metrics: { x: [] } }), /metric values/);
  assert.throws(() => store.logMetrics(run.id, { step: 0, preview_completion: 2, metrics: { x: 1 } }), /preview_completion/);
  assert.throws(() => store.getMetrics(run.id, { start_step: 3, end_step: 1 }), /start_step/);
  assert.deepEqual(store.getMetrics(run.id, { start_step: "0", end_step: "1" }), []);
  assert.throws(() => store.getMetrics(run.id, { start_step: "bad" }), /start_step/);
  assert.throws(() => store.getMetrics(run.id, { limit: "many" }), /limit/);
  assert.throws(() => store.createAttributes(run.id, { attributes: [] }), /attributes/);
  assert.throws(() => store.createAttributes(run.id, { path: "x", type: "unknown", value: 1 }), /type/);
  assert.throws(() => store.createAttributes(run.id, { path: "x", type: "float_series", value: "nan" }), /float_series/);
  assert.throws(() => store.createAttributes(run.id, { path: "x", type: "float_series", value: [] }), /float_series/);
  assert.throws(() => store.createAttributes(run.id, { path: "x", type: "tag", value: 1 }), /tag value/);
  assert.throws(() => store.createAttributes(run.id, { path: "x", type: "string_series", value: "ok", timestamp: "never" }), /timestamp/);
  assert.throws(() => store.listAttributes(run.id, { type: "unknown" }), /type/);
  assert.throws(() => store.listAttributes(run.id, { limit: 0 }), /limit/);
  assert.throws(() => store.createArtifact(run.id, { type: "video" }), /type/);
  assert.throws(() => store.createArtifact(run.id, { type: "file", name: "x", uri: "u", size_bytes: -1 }), /size_bytes/);
  assert.throws(() => store.sideBySide({}), /run_ids/);
  assert.throws(() => store.importNeptune({ project: "x", runs: [] }), /runs/);
  assert.throws(() => store.importNeptune({ project: "x", runs: [{ name: "bad", metrics: "nope" }] }), /run metrics/);
  assert.throws(() => store.importNeptune({ project: "x", runs: [{ name: "bad", metrics: [{ key: "reward", value: null }] }] }), /finite/);
  assert.throws(() => store.importWandb({ project: "x", runs: [{ name: "bad", history: [{ _step: -1, reward: 1 }] }] }), /_step/);
  assert.throws(() => store.importWandb({ project: "x", runs: [{ name: "bad", history: [{ _timestamp: 9e99, reward: 1 }] }] }), /supported datetime range/);
  assert.throws(() => store.getArtifact("missing"), /artifact not found/);
  assert.throws(() => store.getRun("missing"), /run not found/);
  assert.throws(() => store.updateRun("missing", { status: "finished" }), /run not found/);
  assert.throws(() => {
    throw new ValidationError("manual");
  }, /manual/);
});
