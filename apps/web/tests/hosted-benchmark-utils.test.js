import assert from "node:assert/strict";
import test from "node:test";

import {
  budgetForCase,
  budgetFailures,
  percentile,
  sanitizeHostedBenchmarkResult,
  summarizeTimings,
  validateBenchmarkPayload,
} from "../../../tools/hosted-benchmark-utils.mjs";

test("budget helpers use explicit, grouped, and fallback budgets", () => {
  assert.equal(budgetForCase({ budget_ms: 123 }), 123);
  assert.equal(budgetForCase({ budget_group: "summary" }), 750);
  assert.equal(budgetForCase({ kind: "chart" }), 750);
  assert.equal(budgetForCase({ kind: "batched_series" }), 750);
  assert.equal(budgetForCase({ group: "unknown" }), 1000);
  assert.equal(percentile([], 0.95), 0);
});

test("summarizeTimings returns nearest-rank p95 and rounded timing stats", () => {
  assert.deepEqual(summarizeTimings([42.4, 10.2, 18.8, 21.1]), {
    samples: 4,
    p50_ms: 19,
    p95_ms: 42,
    min_ms: 10,
    max_ms: 42,
    timings_ms: [10, 19, 21, 42],
  });
  assert.deepEqual(summarizeTimings([]), {
    samples: 0,
    p50_ms: 0,
    p95_ms: 0,
    min_ms: 0,
    max_ms: 0,
    timings_ms: [],
  });
});

test("validateBenchmarkPayload accepts a bounded summary page", () => {
  const stats = validateBenchmarkPayload(
    {
      name: "runs_newest_25",
      kind: "summary",
      limit: 25,
      require_metric_key: "eval/return_mean",
      require_metric_summary_key: "eval/return_mean",
    },
    {
      total: 100000,
      metric_keys: ["eval/return_mean", "train/loss"],
      runs: [
        {
          id: "run-1",
          status: "finished",
          latest_metrics: { "eval/return_mean": 321 },
          metric_aggregates: { "eval/return_mean": { latest: 321, max: 321 } },
        },
      ],
    },
  );
  assert.deepEqual(stats, {
    kind: "summary",
    rows: 1,
    total: 100000,
    metric_keys: 2,
    statuses: { finished: 1 },
  });
});

test("validateBenchmarkPayload rejects fake-fast or malformed summary responses", () => {
  assert.throws(
    () => validateBenchmarkPayload({ name: "empty_search", kind: "summary", limit: 25 }, { total: 0, runs: [] }),
    /empty page/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "wrong_status", kind: "summary", limit: 25, expected_status: "failed" }, { total: 1, runs: [{ status: "finished" }] }),
    /expected failed/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "too_many", kind: "summary", limit: 1 }, { total: 2, runs: [{}, {}] }),
    /limit 1/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "missing_metric", kind: "summary", limit: 25, require_metric_key: "eval/return_mean" }, { total: 1, runs: [{}], metric_keys: ["train/loss"] }),
    /metric key eval\/return_mean/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "not_json", kind: "summary" }, []),
    /non-object JSON/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "bad_total", kind: "summary" }, { total: -1, runs: [{}] }),
    /invalid total/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "zero_total", kind: "summary", expect_non_empty: false }, { total: 0, runs: [] }),
    /non-positive total/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "missing_summary", kind: "summary", require_metric_summary_key: "eval/return_mean" }, { total: 1, runs: [{}] }),
    /metric summary eval\/return_mean/,
  );
});

test("validateBenchmarkPayload validates overview and chart shapes", () => {
  assert.deepEqual(
    validateBenchmarkPayload(
      { name: "overview_project", kind: "overview" },
      { overview: { total_runs: 100000, active_runs: 9000, failed_runs: 1000, metric_points: 180000 } },
    ),
    {
      kind: "overview",
      total_runs: 100000,
      active_runs: 9000,
      failed_runs: 1000,
      metric_points: 180000,
    },
  );
  assert.deepEqual(
    validateBenchmarkPayload(
      { name: "chart_eval_return_5000", kind: "chart", limit: 5000 },
      { metrics: [{ step: 1 }, { step: 5000 }] },
    ),
    {
      kind: "chart",
      rows: 2,
      first_step: 1,
      last_step: 5000,
    },
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "bad_overview", kind: "overview" }, { overview: { total_runs: "nope" } }),
    /total_runs/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "missing_overview", kind: "overview" }, { overview: [] }),
    /malformed overview/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "missing_chart", kind: "chart" }, { metrics: null }),
    /malformed metrics/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "bad_chart", kind: "chart", limit: 1 }, { metrics: [{}, {}] }),
    /limit 1/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "empty_chart", kind: "chart" }, { metrics: [] }),
    /empty metric series/,
  );
});

test("validateBenchmarkPayload validates batched selected-run series", () => {
  assert.deepEqual(
    validateBenchmarkPayload(
      { name: "batched", kind: "batched_series", limit: 3, expected_series: 2 },
      { series: [{ run_id: "run-1", metrics: [{ step: 1 }, { step: 2 }] }, { run_id: "run-2", metrics: [{ step: 1 }] }] },
    ),
    {
      kind: "batched_series",
      series: 2,
      non_empty_series: 2,
      rows: 3,
      max_rows_per_series: 2,
    },
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "bad_batch", kind: "batched_series" }, { series: null }),
    /malformed batched series/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "wrong_count", kind: "batched_series", expected_series: 2 }, { series: [{ metrics: [] }] }),
    /expected 2/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "too_many_rows", kind: "batched_series", limit: 1 }, { series: [{ metrics: [{}, {}] }] }),
    /limit 1/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "missing_metrics", kind: "batched_series" }, { series: [{}] }),
    /without metrics/,
  );
  assert.throws(
    () => validateBenchmarkPayload({ name: "empty_batch", kind: "batched_series" }, { series: [{ metrics: [] }] }),
    /empty batched series/,
  );
});

test("sanitizeHostedBenchmarkResult keeps benchmark metadata but strips sensitive identifiers", () => {
  const sanitized = sanitizeHostedBenchmarkResult({
    status: "ok",
    generated_at: "2026-05-14T12:00:00.000Z",
    git: { commit: "abc123", branch: "codex/clickhouse-query-benchmarks" },
    environment: { platform: "darwin", arch: "arm64", node_version: "v22.0.0", api_mode: "cloud-run-direct", api_host: "https://service.run.app/path?secret=nope", api_transport: "https", warmed: true },
    measurement_protocol: { warmups: 2, samples: 8, p95: "nearest-rank", endpoint_order: "fixed" },
    dataset: {
      project: "instantml-demo-100k",
      projects: ["hosted-scale-control", "hosted-scale-data"],
      configured_runs: 100000,
      configured_min_runs: 100000,
      seeded_runs: 100000,
      observed_runs: 100000,
      seeded_metric_points: 180000,
      observed_metric_points: 600000,
      long_run_steps: 20000,
      expected_steps_per_run: 1000,
      chart_limit: 1000,
      selected_run_count: 8,
      metric_key: "eval/return_mean",
      system_metric_key: "system/gpu_util",
      metric_keys: ["eval/return_mean", "system/gpu_util"],
      status_counts: { finished: 90000 },
      org_id: "should-not-leak",
    },
    route: {
      provisioner: "cloud-service",
      endpoint: "https://default:super-secret-password@clickhouse.example.com/default?password=bad",
      service_id: "svc-secret",
      clickhouse_provider: "aws",
      clickhouse_region: "us-west-2",
    },
    measurements: [
      {
        name: "runs_newest_25",
        kind: "summary",
        group: "summary",
        route_template: "/api/runs/summary",
        budget_ms: 750,
        samples: 8,
        p50_ms: 20,
        p95_ms: 30,
        min_ms: 18,
        max_ms: 35,
        stats: { rows: 25, total: 100000 },
        cookie: "secret-cookie",
      },
    ],
  });
  const json = JSON.stringify(sanitized);
  assert.equal(sanitized.route.endpoint_host, "clickhouse.example.com");
  assert.equal(sanitized.environment.api_host, "service.run.app");
  assert.deepEqual(sanitized.dataset.projects, ["hosted-scale-control", "hosted-scale-data"]);
  assert.equal(sanitized.passed, true);
  assert.equal(json.includes("super-secret-password"), false);
  assert.equal(json.includes("secret-cookie"), false);
  assert.equal(json.includes("service_id"), false);
  assert.equal(json.includes("org_id"), false);
  assert.equal(json.includes("should-not-leak"), false);

  const fallbackHost = sanitizeHostedBenchmarkResult({ route: { endpoint_host: "plain-host/path?secret=nope" } });
  assert.equal(fallbackHost.route.endpoint_host, "plain-host");
  const hostWithPort = sanitizeHostedBenchmarkResult({ route: { endpoint_host: "clickhouse.example.com:8443" } });
  assert.equal(hostWithPort.route.endpoint_host, "clickhouse.example.com:8443");
});

test("budgetFailures identifies over-budget hosted p95 measurements", () => {
  const result = sanitizeHostedBenchmarkResult({
    measurements: [
      { name: "fast", p95_ms: 100, budget_ms: 750 },
      { name: "slow", p95_ms: 1200, budget_ms: 1000, timings_ms: [1000.4, 1200.1], stats: { rows: 1 } },
      { name: "no_budget", p95_ms: 2000 },
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.measurements[1].passed, false);
  assert.deepEqual(budgetFailures(result), ["slow p95 1200ms exceeded 1000ms"]);
});
