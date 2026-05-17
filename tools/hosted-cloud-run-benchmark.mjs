#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  HOSTED_BENCHMARK_BUDGETS_MS,
  budgetFailures,
  budgetForCase,
  sanitizeHostedBenchmarkResult,
  summarizeTimings,
  validateBenchmarkPayload,
} from "./hosted-benchmark-utils.mjs";

const repo = process.cwd();
loadDotenv(path.join(repo, ".env"));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: npm run benchmark:cloud-run

Benchmarks the deployed hosted API path:
  client -> Cloud Run data service or HTTPS router -> ClickHouse Cloud tenant

Required:
  INSTANTML_API_KEY or INSTANTML_CLOUD_RUN_BENCH_API_KEY
  INSTANTML_DATA_API_BASE, INSTANTML_API_BASE, or INSTANTML_CLOUD_RUN_BENCH_API_BASE

Useful overrides:
  INSTANTML_CLOUD_RUN_BENCH_PROJECTS=hosted-scale-control,hosted-scale-data
  INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS=100000
  INSTANTML_CLOUD_RUN_BENCH_SAMPLES=8
  INSTANTML_CLOUD_RUN_BENCH_WARMUPS=2
  INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH=/tmp/instantml-cloud-run-benchmark.json
  INSTANTML_CLOUD_RUN_BENCH_ENFORCE=1
`);
  process.exit(0);
}

const apiBaseUrl = trimSlash(
  process.env.INSTANTML_CLOUD_RUN_BENCH_API_BASE
    || process.env.INSTANTML_HOSTED_BENCH_API_BASE
    || process.env.INSTANTML_DATA_API_BASE
    || process.env.INSTANTML_API_BASE
    || "",
);
const apiKey = process.env.INSTANTML_CLOUD_RUN_BENCH_API_KEY || process.env.INSTANTML_API_KEY || "";
const projects = envList(
  "INSTANTML_CLOUD_RUN_BENCH_PROJECTS",
  envList("INSTANTML_HOSTED_SCALE_PROJECTS", ["hosted-scale-control", "hosted-scale-data"]),
);
const metricKeys = envList("INSTANTML_CLOUD_RUN_BENCH_METRIC_KEYS", envList("INSTANTML_HOSTED_SCALE_METRIC_KEYS", [
  "eval/return_mean",
  "eval/success_rate",
  "train/loss",
  "train/reward_mean",
  "system/cpu_percent",
  "system/gpu_util",
]));
const metricKey = process.env.INSTANTML_CLOUD_RUN_BENCH_METRIC_KEY || "eval/return_mean";
const systemMetricKey = process.env.INSTANTML_CLOUD_RUN_BENCH_SYSTEM_METRIC_KEY || metricKeys.find((key) => key.startsWith("system/")) || "system/gpu_util";
const minRuns = positiveInt("INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS", positiveInt("INSTANTML_HOSTED_SCALE_RUNS", 100_000));
const expectedSteps = positiveInt("INSTANTML_CLOUD_RUN_BENCH_EXPECTED_STEPS", positiveInt("INSTANTML_HOSTED_SCALE_STEPS", 1_000));
const selectedRunCount = positiveInt("INSTANTML_CLOUD_RUN_BENCH_SELECTED_RUNS", 8);
const chartLimit = positiveInt("INSTANTML_CLOUD_RUN_BENCH_CHART_LIMIT", Math.min(5_000, expectedSteps));
const samples = positiveInt("INSTANTML_CLOUD_RUN_BENCH_SAMPLES", 8);
const warmups = positiveInt("INSTANTML_CLOUD_RUN_BENCH_WARMUPS", 2);
const resultPath = process.env.INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH || "";
const enforceBudgets = process.env.INSTANTML_CLOUD_RUN_BENCH_ENFORCE === "1";

if (!apiBaseUrl) {
  throw new Error("Set INSTANTML_CLOUD_RUN_BENCH_API_BASE, INSTANTML_DATA_API_BASE, or INSTANTML_API_BASE.");
}
if (!apiKey) {
  throw new Error("Set INSTANTML_API_KEY or INSTANTML_CLOUD_RUN_BENCH_API_KEY for the hosted data service.");
}
if (!projects.length) throw new Error("At least one benchmark project is required.");
if (!metricKeys.includes(metricKey)) throw new Error(`Metric keys must include ${metricKey}.`);

const apiUrl = new URL(apiBaseUrl);
if (apiUrl.protocol !== "https:" && process.env.INSTANTML_CLOUD_RUN_BENCH_ALLOW_HTTP !== "1") {
  throw new Error("Hosted Cloud Run benchmarks require https; set INSTANTML_CLOUD_RUN_BENCH_ALLOW_HTTP=1 only for a local proxy.");
}

const authorization = `Bearer ${apiKey}`;
await assertReady();

const preflight = await datasetPreflight();
const cases = benchmarkCases(preflight);
await preflightCases(cases);

const measurements = [];
for (const caseDefinition of cases) {
  measurements.push(await measureEndpoint(caseDefinition));
}

const result = sanitizeHostedBenchmarkResult({
  status: "ok",
  generated_at: new Date().toISOString(),
  git: gitMetadata(),
  environment: {
    platform: os.platform(),
    arch: os.arch(),
    node_version: process.version,
    api_mode: apiUrl.hostname.endsWith(".run.app") ? "cloud-run-direct" : "hosted-api",
    api_host: apiUrl.host,
    api_transport: apiUrl.protocol.replace(":", ""),
    warmed: true,
  },
  measurement_protocol: {
    warmups,
    samples,
    p95: "nearest-rank",
    endpoint_order: "fixed",
  },
  dataset: {
    projects,
    configured_min_runs: minRuns,
    observed_runs: preflight.observedRuns,
    observed_metric_points: preflight.observedMetricPoints,
    expected_steps_per_run: expectedSteps,
    chart_limit: chartLimit,
    selected_run_count: preflight.selectedRunIds.length,
    metric_key: metricKey,
    system_metric_key: systemMetricKey,
    metric_keys: preflight.metricKeys,
    status_counts: preflight.statusCounts,
  },
  route: {
    endpoint_host: apiUrl.host,
    provisioner: "cloud-run-data-api",
  },
  budgets_ms: {
    ...HOSTED_BENCHMARK_BUDGETS_MS,
    batched_series: HOSTED_BENCHMARK_BUDGETS_MS.chart,
  },
  measurements,
});

if (resultPath) {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
const failures = budgetFailures(result);
if (enforceBudgets && failures.length) {
  throw new Error(`hosted Cloud Run benchmark budget failures:\n${failures.join("\n")}`);
}

async function assertReady() {
  const health = await requestJson({ method: "GET", path: "/health", auth: false, name: "health" });
  if (health.status !== "ok") throw new Error("/health did not return ok");
  const ready = await requestJson({ method: "GET", path: "/readyz", auth: false, name: "readyz" });
  if (ready.status !== "ok") throw new Error("/readyz did not return ok");
}

async function datasetPreflight() {
  const projectSummaries = [];
  const selectedRunIds = [];
  const statusCounts = {};
  const metricKeySet = new Set(metricKeys);
  let observedRuns = 0;
  let observedMetricPoints = 0;

  for (const project of projects) {
    const summary = await requestJson({
      method: "GET",
      path: `/api/runs/summary?${new URLSearchParams({ project, limit: String(Math.max(selectedRunCount, 25)), sort_by: "created", metric_key: metricKey })}`,
      name: `preflight_${slug(project)}`,
    });
    validateBenchmarkPayload({
      name: `preflight_${project}`,
      kind: "summary",
      limit: Math.max(selectedRunCount, 25),
      require_metric_key: metricKey,
      require_metric_summary_key: metricKey,
    }, summary);
    observedRuns += Number(summary.total || 0);
    for (const key of summary.metric_keys || []) metricKeySet.add(key);
    for (const run of summary.runs || []) {
      if (selectedRunIds.length < selectedRunCount) selectedRunIds.push(run.id);
    }
    projectSummaries.push({ project, summary });

    for (const status of ["failed", "running", "finished"]) {
      const filtered = await requestJson({
        method: "GET",
        path: `/api/runs/summary?${new URLSearchParams({ project, status, limit: "5", sort_by: "created", metric_key: metricKey })}`,
        name: `preflight_${slug(project)}_${status}`,
      });
      validateBenchmarkPayload({
        name: `preflight_${project}_${status}`,
        kind: "summary",
        limit: 5,
        expected_status: status,
      }, filtered);
      statusCounts[status] = (statusCounts[status] || 0) + Number(filtered.total || 0);
    }

    const overview = await requestJson({
      method: "GET",
      path: `/api/overview?${new URLSearchParams({ project, metric_key: metricKey })}`,
      name: `preflight_overview_${slug(project)}`,
    });
    const overviewStats = validateBenchmarkPayload({ name: `preflight_overview_${project}`, kind: "overview" }, overview);
    observedMetricPoints += Number(overviewStats.metric_points || 0);
  }

  if (observedRuns < minRuns) {
    throw new Error(`Cloud benchmark dataset has ${observedRuns} runs across ${projects.join(", ")}, expected at least ${minRuns}. Run npm run seed:hosted-scale first.`);
  }
  if (!selectedRunIds.length) throw new Error("No selected run ids found for chart benchmarks.");

  return {
    projectSummaries,
    selectedRunIds,
    observedRuns,
    observedMetricPoints,
    metricKeys: [...metricKeySet].sort(),
    statusCounts,
  };
}

function benchmarkCases(preflight) {
  const cases = [
    summaryCase("org_newest_25", {}, { group: "summary", require_metric_key: metricKey }),
    summaryCase("org_search_hosted_scale", { q: "hosted-scale" }, { query_fixture: "tag" }),
    summaryCase("org_search_seed_13", { q: "seed-13" }, { query_fixture: "tag" }),
    summaryCase("org_sort_metric_best", { sort_by: "metric-best" }, { require_metric_summary_key: metricKey }),
    {
      name: "org_overview",
      kind: "overview",
      group: "overview",
      method: "GET",
      route_template: "/api/overview",
      path: `/api/overview?${new URLSearchParams({ metric_key: metricKey })}`,
    },
  ];

  for (const { project, summary } of preflight.projectSummaries) {
    const projectSlug = slug(project);
    const latestRunName = summary.runs?.[0]?.name || project;
    cases.push(
      summaryCase(`${projectSlug}_newest_25`, { project, limit: "25" }, { group: "summary", require_metric_key: metricKey }),
      summaryCase(`${projectSlug}_newest_100`, { project, limit: "100" }, { group: "summary", require_metric_key: metricKey }),
      summaryCase(`${projectSlug}_search_latest_name`, { project, q: latestRunName }, { query_fixture: "name" }),
      summaryCase(`${projectSlug}_search_project_tag`, { project, q: project }, { query_fixture: "project_tag" }),
      summaryCase(`${projectSlug}_search_config_transformer`, { project, q: "transformer" }, { query_fixture: "config" }),
      summaryCase(`${projectSlug}_search_notes_scale_validation`, { project, q: "scale validation" }, { query_fixture: "notes" }),
      summaryCase(`${projectSlug}_filter_failed`, { project, status: "failed" }, { expected_status: "failed" }),
      summaryCase(`${projectSlug}_filter_running`, { project, status: "running" }, { expected_status: "running" }),
      summaryCase(`${projectSlug}_filter_finished`, { project, status: "finished" }, { expected_status: "finished" }),
      summaryCase(`${projectSlug}_filter_finished_config`, { project, status: "finished", q: "transformer" }, { expected_status: "finished" }),
      summaryCase(`${projectSlug}_sort_metric_best`, { project, sort_by: "metric-best" }, { require_metric_summary_key: metricKey }),
      {
        name: `${projectSlug}_overview`,
        kind: "overview",
        group: "overview",
        method: "GET",
        route_template: "/api/overview",
        path: `/api/overview?${new URLSearchParams({ project, metric_key: metricKey })}`,
      },
    );
    if (summary.next_cursor) {
      cases.push(summaryCase(`${projectSlug}_cursor_page_2`, { project, cursor: summary.next_cursor, limit: "25" }, { group: "summary", require_metric_key: metricKey }));
    }
  }

  const firstRunId = preflight.selectedRunIds[0];
  cases.push(
    chartCase("chart_eval_return", firstRunId, metricKey),
    chartCase("chart_system_metric", firstRunId, systemMetricKey),
    {
      name: "batched_series_eval_return_selected_runs",
      kind: "batched_series",
      group: "batched_series",
      method: "POST",
      route_template: "/api/metrics/series",
      path: "/api/metrics/series",
      body: { key: metricKey, run_ids: preflight.selectedRunIds, limit: chartLimit },
      limit: chartLimit,
      expected_series: preflight.selectedRunIds.length,
      expect_non_empty: true,
    },
    {
      name: "batched_series_system_window",
      kind: "batched_series",
      group: "batched_series",
      method: "POST",
      route_template: "/api/metrics/series",
      path: "/api/metrics/series",
      body: {
        key: systemMetricKey,
        run_ids: preflight.selectedRunIds,
        limit: Math.min(250, chartLimit),
        start_step: Math.max(1, Math.floor(expectedSteps * 0.4)),
        end_step: Math.max(2, Math.floor(expectedSteps * 0.7)),
      },
      limit: Math.min(250, chartLimit),
      expected_series: preflight.selectedRunIds.length,
      expect_non_empty: true,
    },
  );

  return cases.map((caseDefinition) => ({
    ...caseDefinition,
    budget_ms: budgetForCase(caseDefinition),
  }));
}

function summaryCase(name, params, options = {}) {
  const limit = Number(params.limit || 25);
  return {
    name,
    kind: "summary",
    group: options.group || "search_filter_sort",
    method: "GET",
    route_template: "/api/runs/summary",
    path: `/api/runs/summary?${new URLSearchParams({ limit: String(limit), sort_by: "created", metric_key: metricKey, ...params })}`,
    limit,
    expect_non_empty: true,
    ...options,
  };
}

function chartCase(name, runId, key) {
  return {
    name,
    kind: "chart",
    group: "chart",
    method: "GET",
    route_template: "/runs/:id/metrics",
    path: `/runs/${runId}/metrics?${new URLSearchParams({ key, limit: String(chartLimit) })}`,
    limit: chartLimit,
    expect_non_empty: true,
  };
}

async function preflightCases(cases) {
  for (const caseDefinition of cases) {
    const payload = await requestJson(caseDefinition);
    validateBenchmarkPayload(caseDefinition, payload);
  }
}

async function measureEndpoint(caseDefinition) {
  let stats = null;
  for (let index = 0; index < warmups; index += 1) {
    const payload = await requestJson(caseDefinition);
    stats = validateBenchmarkPayload(caseDefinition, payload);
  }
  const timings = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const payload = await requestJson(caseDefinition);
    timings.push(performance.now() - started);
    stats = validateBenchmarkPayload(caseDefinition, payload);
  }
  return {
    name: caseDefinition.name,
    kind: caseDefinition.kind,
    group: caseDefinition.group,
    method: caseDefinition.method || "GET",
    route_template: caseDefinition.route_template,
    limit: caseDefinition.limit,
    budget_ms: caseDefinition.budget_ms,
    ...summarizeTimings(timings),
    stats,
  };
}

async function requestJson(caseDefinition) {
  const url = new URL(caseDefinition.path, apiBaseUrl);
  const headers = {};
  if (caseDefinition.auth !== false) headers.authorization = authorization;
  let body;
  if ((caseDefinition.method || "GET") !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(caseDefinition.body || {});
  }
  const response = await fetch(url, {
    method: caseDefinition.method || "GET",
    headers,
    body,
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${caseDefinition.name || url.pathname} failed with ${response.status}: ${text}`);
  }
  if (text && !contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${caseDefinition.name || url.pathname} returned ${contentType || "unknown content type"}, expected JSON`);
  }
  return text ? JSON.parse(text) : {};
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

function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function trimSlash(value) {
  return value.replace(/\/$/, "");
}

function slug(value) {
  const text = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return text.slice(0, 48) || "project";
}

function gitMetadata() {
  return {
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
  };
}

function gitValue(args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}
