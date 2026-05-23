#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { clickhousePost, ensureLocalClickHouse } from "../../tools/local-clickhouse.mjs";

const repo = new URL("../..", import.meta.url).pathname;
const runsPerProject = numberEnv("INSTANTML_RANK_SCALE_RUNS", 2000);
const longRunsPerProject = numberEnv("INSTANTML_RANK_SCALE_LONG_RUNS", 2);
const worldSize = numberEnv("INSTANTML_RANK_SCALE_WORLD_SIZE", 8);
const batchRows = numberEnv("INSTANTML_RANK_SCALE_BATCH_ROWS", 5000);
const stepProfiles = listEnv("INSTANTML_RANK_SCALE_STEPS", "10000,15000,20000").map((value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("INSTANTML_RANK_SCALE_STEPS must contain positive numbers");
  return Math.floor(parsed);
});
const orgName = process.env.INSTANTML_RANK_SCALE_ORG || `Rank Scale ${timestampSlug()}`;
const orgId = process.env.INSTANTML_RANK_SCALE_ORG_ID || uuidFromText(`rank-scale-org:${orgName}`);
const userId = uuidFromText(`rank-scale-user:${orgName}`);
const membershipId = uuidFromText(`rank-scale-membership:${orgName}`);
const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://default:@127.0.0.1:8123/instantml";
const now = new Date();
guardClickHouseTarget(clickhouseUrl);

const projectSpecs = [
  {
    label: "vision",
    metric: "eval/accuracy",
    family: "vit",
    stepCount: stepProfiles[0] ?? stepProfiles.at(-1),
  },
  {
    label: "language",
    metric: "eval/perplexity",
    family: "transformer",
    stepCount: stepProfiles[1] ?? stepProfiles.at(-1),
  },
  {
    label: "rl",
    metric: "eval/return_mean",
    family: "ppo",
    stepCount: stepProfiles[2] ?? stepProfiles.at(-1),
  },
];

const clickhouse = await ensureLocalClickHouse({ repo, url: clickhouseUrl });
try {
  run("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "migrate"], {
    env: { ...process.env, CLICKHOUSE_URL: clickhouse.url },
  });
  const started = performance.now();
  const result = await seedScaleProjects();
  result.elapsed_ms = Math.round(performance.now() - started);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (clickhouse.started) await clickhouse.stop();
}

async function seedScaleProjects() {
  const projects = projectSpecs.map((spec) => ({
    ...spec,
    id: randomUUID(),
    name: `rank-scale-${spec.label}-${runsPerProject}runs-${spec.stepCount}steps-${timestampSlug()}`,
  }));
  const ops = [
    opRecord("organization", orgId, {
      id: orgId,
      slug: slugify(orgName),
      name: orgName,
      plan_tier: "premium",
      account_type: "business",
      seat_limit: 10,
      created_by_user_id: userId,
      created_at: now.toISOString(),
      tenant_routing_tier: "shared",
      storage_choice: "instantml-hosted",
      storage_state: "storage_ready",
    }, now),
    opRecord("user", userId, {
      id: userId,
      primary_email: "rank-scale@example.com",
      display_name: "Rank Scale",
      avatar_url: null,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    }, now),
    opRecord("membership", membershipId, {
      id: membershipId,
      org_id: orgId,
      user_id: userId,
      role: "owner",
      status: "active",
      created_at: now.toISOString(),
    }, now),
  ];
  const metricRows = [];
  const rankRows = [];
  const projectSummaries = [];

  for (const project of projects) {
    ops.push(opRecord("project", project.id, {
      id: project.id,
      org_id: orgId,
      name: project.name,
      description: `${project.label} rank-scale sweep for k-means and distributed reducer validation.`,
      created_at: now.toISOString(),
    }, now));

    const longRunIds = new Set();
    for (let runIndex = 0; runIndex < runsPerProject; runIndex += 1) {
      if (runIndex < longRunsPerProject) longRunIds.add(runIndex);
      const runId = randomUUID();
      const createdAt = new Date(now.getTime() + projectSummaries.length * 60_000 + runIndex * 1000);
      const config = configForRun(project, runIndex);
      const metricValue = objectiveValue(project, runIndex, config, 1);
      ops.push(opRecord("run", runId, {
        id: runId,
        org_id: orgId,
        project_id: project.id,
        project: project.name,
        name: `${project.label}-sweep-${String(runIndex).padStart(5, "0")}`,
        status: "finished",
        config,
        tags: ["rank-scale", project.label, `cluster-${runIndex % 5}`],
        metadata: {
          notes: `${project.label} sweep row for k-means cluster validation.`,
          scale_profile: { steps: longRunIds.has(runIndex) ? project.stepCount : 1, rank_metrics: longRunIds.has(runIndex) },
        },
        created_at: createdAt.toISOString(),
        started_at: createdAt.toISOString(),
        finished_at: new Date(createdAt.getTime() + 90_000 + (runIndex % 120) * 1000).toISOString(),
      }, createdAt));

      pushMetricBundle(metricRows, project, runId, config, 1, metricValue, createdAt);
      if (longRunIds.has(runIndex)) {
        await seedLongRankRun({ project, runId, config, metricRows, rankRows, createdAt });
      }

      if (ops.length >= batchRows) await insertOperationalRecords(ops.splice(0));
      if (metricRows.length >= batchRows) await insertMetricPoints(metricRows.splice(0));
      if (rankRows.length >= batchRows) await insertRankMetricPoints(rankRows.splice(0));
    }
    projectSummaries.push({
      project: project.name,
      runs: runsPerProject,
      long_rank_runs: longRunsPerProject,
      long_rank_steps_per_run: project.stepCount,
      rank_world_size: worldSize,
      primary_metric: project.metric,
    });
  }

  if (ops.length) await insertOperationalRecords(ops);
  if (metricRows.length) await insertMetricPoints(metricRows);
  if (rankRows.length) await insertRankMetricPoints(rankRows);

  return {
    organization: { id: orgId, name: orgName, login_email: "rank-scale@example.com" },
    projects: projectSummaries,
    inserted: {
      projects: projects.length,
      runs: projects.length * runsPerProject,
      scalar_metric_points: projects.length * runsPerProject * 7
        + projects.reduce((sum, project) => sum + longRunsPerProject * project.stepCount * 7, 0),
      rank_metric_points: projects.reduce(
        (sum, project) => sum + longRunsPerProject * project.stepCount * worldSize * 3,
        0,
      ),
    },
    note: "Restart a running local Rust API after direct ClickHouse seeding so the operational index replays these projects.",
  };
}

async function seedLongRankRun({ project, runId, config, metricRows, rankRows, createdAt }) {
  for (let step = 1; step <= project.stepCount; step += 1) {
    const progress = step / project.stepCount;
    const objective = objectiveValue(project, step, config, progress);
    pushMetricBundle(metricRows, project, runId, config, step, objective, createdAt);
    for (let rank = 0; rank < worldSize; rank += 1) {
      const rankBias = (rank - (worldSize - 1) / 2) * rankSpread(project, config);
      const periodic = Math.sin(step / 97 + rank * 0.7) * rankSpread(project, config) * 0.8;
      const lateOutlier = rank === worldSize - 2 && progress > 0.72 ? rankSpread(project, config) * 8 : 0;
      const rankValue = objective + rankBias + periodic + lateOutlier;
      const throughput = 850 + config.batch_size * 0.8 + rank * 9 - lateOutlier * 60;
      const gradNorm = Math.max(0.01, 3.5 - progress * 2.4 + rank * 0.03 + Math.abs(periodic));
      const base = {
        org_id: orgId,
        run_id: runId,
        step,
        rank,
        local_rank: rank % Math.min(4, worldSize),
        world_size: worldSize,
        weight: config.batch_size + (rank % 3) * 4,
        logged_at: clickhouseDate(new Date(createdAt.getTime() + step * 1000)),
        event_id: randomUUID(),
      };
      rankRows.push({ ...base, key: project.metric, value: rankValue });
      rankRows.push({ ...base, key: "system/rank_tokens_per_second", value: throughput });
      rankRows.push({ ...base, key: "train/grad_norm", value: gradNorm });
    }
    if (metricRows.length >= batchRows) await insertMetricPoints(metricRows.splice(0));
    if (rankRows.length >= batchRows) await insertRankMetricPoints(rankRows.splice(0));
  }
}

function configForRun(project, index) {
  return {
    seed: index,
    family: project.family,
    optimizer: {
      lr: round(0.00015 + (index % 17) * 0.000035 + project.label.length * 0.00001, 7),
      weight_decay: round(0.002 + (index % 11) * 0.0007, 6),
    },
    dropout: round((index % 6) * 0.03, 4),
    batch_size: 64 + (index % 8) * 16,
    width: 256 + (index % 7) * 128,
    depth: 4 + (index % 5),
    rank_scale_group: index % 5,
  };
}

function objectiveValue(project, indexOrStep, config, progress) {
  const clusterLift = config.rank_scale_group * 0.015;
  const lrPenalty = Math.abs(config.optimizer.lr - 0.00048) * 90;
  if (project.label === "language") {
    return Math.max(1.1, 12 - progress * 8.5 + config.dropout * 1.7 + lrPenalty - clusterLift);
  }
  if (project.label === "rl") {
    return 80 + progress * 360 + clusterLift * 400 - config.dropout * 90 + Math.sin(indexOrStep / 53) * 12;
  }
  return Math.min(0.995, 0.55 + progress * 0.36 + clusterLift - config.dropout * 0.08 - lrPenalty * 0.02);
}

function pushMetricBundle(rows, project, runId, config, step, objective, createdAt) {
  const loggedAt = clickhouseDate(new Date(createdAt.getTime() + step * 1000));
  const accuracy = project.label === "vision" ? objective : Math.min(0.99, 0.58 + objective / 1000);
  const loss = project.label === "language" ? objective : Math.max(0.01, 1.8 - accuracy);
  const returnMean = project.label === "rl" ? objective : 120 + accuracy * 600;
  const values = {
    [project.metric]: objective,
    "eval/accuracy": accuracy,
    "eval/f1": Math.max(0, accuracy - 0.025),
    "eval/auc": Math.min(0.999, accuracy + 0.035),
    "train/loss": loss,
    "train/grad_norm": Math.max(0.01, 3.0 - step / Math.max(1, project.stepCount) * 2.1 + config.dropout),
    "eval/return_mean": returnMean,
  };
  for (const [key, value] of Object.entries(values)) {
    rows.push({ org_id: orgId, run_id: runId, key, step, value, logged_at: loggedAt });
  }
}

function rankSpread(project, config) {
  if (project.label === "language") return 0.035 + config.dropout * 0.15;
  if (project.label === "rl") return 4.5 + config.dropout * 20;
  return 0.006 + config.dropout * 0.03;
}

async function insertOperationalRecords(records) {
  await clickhousePost(
    clickhouse.url,
    "INSERT INTO operational_records (kind, org_id, entity_id, payload, created_at) FORMAT JSONEachRow",
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

async function insertMetricPoints(points) {
  await clickhousePost(
    clickhouse.url,
    "INSERT INTO metric_points (org_id, run_id, key, step, value, logged_at) FORMAT JSONEachRow",
    points.map((point) => JSON.stringify(point)).join("\n"),
  );
}

async function insertRankMetricPoints(points) {
  await clickhousePost(
    clickhouse.url,
    "INSERT INTO rank_metric_points (org_id, run_id, key, step, rank, local_rank, world_size, value, weight, logged_at, event_id) FORMAT JSONEachRow",
    points.map((point) => JSON.stringify(point)).join("\n"),
  );
}

function opRecord(kind, entityId, payload, createdAt) {
  return {
    kind,
    org_id: orgId,
    entity_id: entityId,
    payload: JSON.stringify(payload),
    created_at: clickhouseDate(createdAt),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

function clickhouseDate(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "rank-scale";
}

function uuidFromText(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
}

function guardClickHouseTarget(url) {
  const parsed = new URL(url);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (loopback) return;
  if (process.env.INSTANTML_RANK_SCALE_ALLOW_REMOTE_CLICKHOUSE === "1") {
    console.warn(`Writing rank-scale seed data to non-loopback ClickHouse target ${redactedUrl(url)}`);
    return;
  }
  throw new Error(
    `Refusing to seed rank-scale data into non-loopback ClickHouse target ${redactedUrl(url)}. ` +
      "Set INSTANTML_RANK_SCALE_ALLOW_REMOTE_CLICKHOUSE=1 only for an intentional disposable staging target.",
  );
}

function redactedUrl(url) {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "REDACTED";
  return parsed.toString();
}

function listEnv(name, fallback) {
  return (process.env[name] || fallback).split(",").map((part) => part.trim()).filter(Boolean);
}
