import assert from "node:assert/strict";
import test from "node:test";

import {
  competitiveBenchmarkGates,
  competitiveGateFailures,
  renderCompetitiveGateMarkdown,
} from "../competitive-benchmark-gates.mjs";

function measurement(name, p95Ms, budgetMs = 2_500) {
  return {
    name,
    kind: name.startsWith("chart") ? "chart" : "summary",
    samples: 8,
    p50_ms: Math.max(1, Math.round(p95Ms * 0.75)),
    p95_ms: p95Ms,
    min_ms: Math.max(1, Math.round(p95Ms * 0.5)),
    max_ms: p95Ms,
    budget_ms: budgetMs,
  };
}

function hostedResult(overrides = {}) {
  return {
    dataset: {
      observed_runs: 100_000,
      expected_steps_per_run: 1_000,
      metric_keys: [
        "eval/return_mean",
        "eval/success_rate",
        "train/loss",
        "train/reward_mean",
        "system/cpu_percent",
        "system/gpu_util",
      ],
      ...overrides.dataset,
    },
    measurements: [
      ...(overrides.measurements || []),
      measurement("org_newest_100_default_page", 370, 750),
      measurement("org_search_seed_13", 380, 1_000),
      measurement("org_sort_metric_best", 300, 1_000),
      measurement("org_max_selection_page_1", 1_800, 2_500),
      measurement("chart_eval_return", 500, 750),
    ],
  };
}

function gateById(report, id) {
  const gate = report.gates.find((candidate) => candidate.id === id);
  assert.ok(gate, `missing gate ${id}`);
  return gate;
}

test("competitive gates pass historical W&B read targets and preserve unmeasured scale claims", () => {
  const report = competitiveBenchmarkGates(hostedResult(), { generatedAt: "2026-07-03T00:00:00.000Z" });

  assert.equal(gateById(report, "wandb_scale.runs").status, "pass");
  assert.equal(gateById(report, "wandb_historical.newest_100").status, "pass");
  assert.equal(gateById(report, "wandb_historical.search_seed_13").status, "pass");
  assert.equal(gateById(report, "wandb_historical.metric_best").status, "pass");
  assert.equal(gateById(report, "wandb_historical.selection_1000").status, "pass");
  assert.equal(gateById(report, "wandb_historical.chart_history").status, "pass");
  assert.equal(gateById(report, "internal.hosted_budgets").status, "pass");
  assert.equal(gateById(report, "wandb_scale.ingest_throughput").status, "not_measured");
  assert.equal(gateById(report, "neptune.metric_scale_seconds").status, "not_measured");
  assert.equal(report.summary.pass, 7);
});

test("competitive gates fail measured public scale dimensions that are below target", () => {
  const report = competitiveBenchmarkGates(hostedResult());

  assert.equal(gateById(report, "wandb_scale.steps_per_run").status, "fail");
  assert.equal(gateById(report, "wandb_scale.metric_cardinality").status, "fail");
  assert.match(gateById(report, "wandb_scale.steps_per_run").message, /below W&B/);
  assert.match(gateById(report, "wandb_scale.metric_cardinality").observed, /6 metric keys/);
});

test("competitive gates report fully measured public scale pass when payload contains it", () => {
  const report = competitiveBenchmarkGates(hostedResult({
    dataset: {
      expected_steps_per_run: 500_000,
      metric_cardinality_per_project: 100_000,
      ingest_values_per_minute: 125_000,
    },
    measurements: [
      measurement("metric_catalog_1000", 4_000, 5_000),
    ],
  }));

  assert.equal(gateById(report, "wandb_scale.steps_per_run").status, "pass");
  assert.equal(gateById(report, "wandb_scale.metric_cardinality").status, "pass");
  assert.equal(gateById(report, "wandb_scale.ingest_throughput").status, "pass");
  assert.equal(gateById(report, "neptune.metric_scale_seconds").status, "pass");
});

test("competitive gates read SDK producer throughput summaries", () => {
  const report = competitiveBenchmarkGates({
    ingest: {
      scope: "sdk_hot_loop_producer",
      case: "instantml-async-queue",
      values_per_minute: 125_000,
    },
    measurements: [],
  });

  assert.equal(gateById(report, "wandb_scale.ingest_throughput").status, "pass");
  assert.match(gateById(report, "wandb_scale.ingest_throughput").observed, /125,000 values\/minute/);
  assert.equal(gateById(report, "wandb_scale.runs").status, "not_measured");
  assert.equal(gateById(report, "internal.hosted_budgets").status, "not_measured");
});

test("competitive gate failures include historical and internal budget regressions", () => {
  const report = competitiveBenchmarkGates(hostedResult({
    measurements: [
      measurement("chart_eval_return", 900, 750),
      measurement("custom_slow_case", 3_000, 2_000),
    ],
  }));
  const failures = competitiveGateFailures(report);

  assert.equal(gateById(report, "wandb_historical.chart_history").status, "fail");
  assert.equal(gateById(report, "internal.hosted_budgets").status, "fail");
  assert.ok(failures.some((failure) => failure.includes("wandb_historical.chart_history")));
  assert.ok(failures.some((failure) => failure.includes("internal.hosted_budgets")));
});

test("strict failures can require not-measured public gates", () => {
  const report = competitiveBenchmarkGates(hostedResult());
  const defaultFailures = competitiveGateFailures(report);
  const strictFailures = competitiveGateFailures(report, { strictNotMeasured: true });

  assert.ok(defaultFailures.every((failure) => !failure.includes("not measured")));
  assert.ok(strictFailures.some((failure) => failure.includes("wandb_scale.ingest_throughput")));
  assert.ok(strictFailures.some((failure) => failure.includes("neptune.metric_scale_seconds")));
});

test("markdown renderer includes sources and gate statuses", () => {
  const markdown = renderCompetitiveGateMarkdown(competitiveBenchmarkGates(hostedResult(), {
    generatedAt: "2026-07-03T00:00:00.000Z",
  }));

  assert.match(markdown, /# Competitive Benchmark Gates/);
  assert.match(markdown, /https:\/\/docs\.wandb\.ai\/models\/track\/limits/);
  assert.match(markdown, /https:\/\/docs\.neptune\.ai\/about/);
  assert.match(markdown, /\| pass \| `wandb_historical.newest_100`/);
  assert.match(markdown, /\| not_measured \| `neptune.metric_scale_seconds`/);
});
