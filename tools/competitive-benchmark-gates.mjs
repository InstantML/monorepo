#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { budgetFailures } from "./hosted-benchmark-utils.mjs";

const STATUS_ORDER = Object.freeze({ fail: 0, not_measured: 1, pass: 2 });

export const PUBLIC_COMPETITIVE_TARGETS = Object.freeze({
  wandbCloudScaleGuidance: Object.freeze({
    source: "https://docs.wandb.ai/models/track/limits",
    runsPerProject: 10_000,
    stepsPerRun: 500_000,
    metricCardinalityPerProject: 100_000,
    logFrequencyRowsPerMinute: 1_000,
    throughputValuesPerMinute: 100_000,
    videoMbPerMinute: 40,
  }),
  wandbHistoricalPublicApiP95Ms: Object.freeze({
    source: "benchmarks/RESULTS.md",
    caveat: "Historical May 18 W&B public-API comparison used 4,321 visible W&B runs, partial W&B seed coverage, and closest-public-equivalent route labels.",
    tolerance: 1.1,
    newest100: 408,
    searchSeed13: 409,
    metricBest: 305,
    selection1000: 2251,
    chartHistory: 675,
  }),
  neptunePublicMetricScale: Object.freeze({
    source: "https://docs.neptune.ai/about",
    metricKeys: 1_000,
    maxMs: 5_000,
    caveat: "Interprets Neptune's public app claim, 'Visualize and compare thousands of metrics in seconds,' as at least 1,000 metric keys returning within five seconds.",
  }),
});

const HISTORICAL_WANDB_GATES = Object.freeze([
  Object.freeze({
    id: "wandb_historical.newest_100",
    label: "Newest 100 run page",
    targetMs: PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.newest100,
    measurementNames: ["org_newest_100_default_page"],
  }),
  Object.freeze({
    id: "wandb_historical.search_seed_13",
    label: "Search seed-13",
    targetMs: PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.searchSeed13,
    measurementNames: ["org_search_seed_13"],
  }),
  Object.freeze({
    id: "wandb_historical.metric_best",
    label: "Metric-best sort",
    targetMs: PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.metricBest,
    measurementNames: ["org_sort_metric_best"],
  }),
  Object.freeze({
    id: "wandb_historical.selection_1000",
    label: "1,000-run selection page",
    targetMs: PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.selection1000,
    measurementNames: ["org_max_selection_page_1"],
  }),
  Object.freeze({
    id: "wandb_historical.chart_history",
    label: "Sampled chart history",
    targetMs: PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.chartHistory,
    measurementNames: ["chart_eval_return"],
  }),
]);

const NEPTUNE_MEASUREMENT_NAMES = Object.freeze([
  "metric_catalog_1000",
  "metrics_catalog_1000",
  "org_metric_catalog",
  "project_metric_catalog",
  "metric_keys_catalog",
]);

export function competitiveBenchmarkGates(result, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const gates = [
    wandbRunScaleGate(result),
    wandbStepsGate(result),
    wandbMetricCardinalityGate(result),
    wandbIngestThroughputGate(result),
    ...HISTORICAL_WANDB_GATES.map((gate) => historicalWandbGate(result, gate)),
    neptuneMetricScaleGate(result),
    hostedBudgetGate(result),
  ];
  const summary = summarizeGates(gates);
  return {
    version: 1,
    generated_at: generatedAt,
    targets: PUBLIC_COMPETITIVE_TARGETS,
    summary,
    gates,
    notes: [
      "Pass means the matching InstantML benchmark measurement met the public or historical target in this result.",
      "Not measured means the result lacks the dataset size, metric cardinality, ingest-throughput, or route measurement needed for an honest comparison.",
      "Historical W&B gates use a 10% tolerance because the committed W&B public-API comparison was a partial hosted seed and should be treated as directional rather than an immutable service-level objective.",
    ],
  };
}

export function competitiveGateFailures(report, options = {}) {
  const strictNotMeasured = options.strictNotMeasured === true;
  return (report.gates || [])
    .filter((gate) => gate.status === "fail" || (strictNotMeasured && gate.status === "not_measured"))
    .map((gate) => `${gate.id}: ${gate.message}`);
}

export function renderCompetitiveGateMarkdown(report) {
  const lines = [
    "# Competitive Benchmark Gates",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "| Status | Gate | Target | Observed | Notes |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const gate of sortGates(report.gates || [])) {
    lines.push(`| ${gate.status} | \`${gate.id}\` | ${escapeTable(gate.target)} | ${escapeTable(gate.observed)} | ${escapeTable(gate.message)} |`);
  }
  lines.push(
    "",
    "Sources:",
    "",
    `- W&B scale guidance: ${PUBLIC_COMPETITIVE_TARGETS.wandbCloudScaleGuidance.source}`,
    `- Historical W&B public-API comparison: ${PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.source}`,
    `- Neptune public app claim: ${PUBLIC_COMPETITIVE_TARGETS.neptunePublicMetricScale.source}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.not_measured} not measured.`,
  );
  return `${lines.join("\n")}\n`;
}

function wandbRunScaleGate(result) {
  const target = PUBLIC_COMPETITIVE_TARGETS.wandbCloudScaleGuidance.runsPerProject;
  const observed = numberFrom(result?.dataset?.observed_runs, result?.dataset?.observedRuns, result?.dataset?.seeded_runs, result?.dataset?.configured_runs);
  if (!Number.isFinite(observed)) {
    return notMeasured("wandb_scale.runs", `>= ${formatCount(target)} runs`, "missing observed run count");
  }
  return thresholdGate({
    id: "wandb_scale.runs",
    target: `>= ${formatCount(target)} runs`,
    observed: `${formatCount(observed)} runs`,
    pass: observed >= target,
    message: observed >= target
      ? `Observed run count meets W&B's published ${formatCount(target)} runs/project guidance.`
      : `Observed run count is below W&B's published ${formatCount(target)} runs/project guidance.`,
  });
}

function wandbStepsGate(result) {
  const target = PUBLIC_COMPETITIVE_TARGETS.wandbCloudScaleGuidance.stepsPerRun;
  const observed = numberFrom(result?.dataset?.expected_steps_per_run, result?.dataset?.long_run_steps, result?.dataset?.steps_per_run);
  if (!Number.isFinite(observed)) {
    return notMeasured("wandb_scale.steps_per_run", `>= ${formatCount(target)} steps/run`, "missing steps-per-run metadata");
  }
  return thresholdGate({
    id: "wandb_scale.steps_per_run",
    target: `>= ${formatCount(target)} steps/run`,
    observed: `${formatCount(observed)} steps/run`,
    pass: observed >= target,
    message: observed >= target
      ? `Observed steps/run meets W&B's published ${formatCount(target)} steps/run guidance.`
      : `Observed steps/run is below W&B's published ${formatCount(target)} steps/run guidance; current hosted dashboard benchmarks focus on many runs with bounded chart reads.`,
  });
}

function wandbMetricCardinalityGate(result) {
  const target = PUBLIC_COMPETITIVE_TARGETS.wandbCloudScaleGuidance.metricCardinalityPerProject;
  const metricKeys = metricKeysFrom(result);
  const observed = numberFrom(result?.dataset?.metric_cardinality_per_project, result?.dataset?.observed_metric_cardinality, metricKeys.length || undefined);
  if (!Number.isFinite(observed)) {
    return notMeasured("wandb_scale.metric_cardinality", `>= ${formatCount(target)} metric keys`, "missing metric-key cardinality metadata");
  }
  return thresholdGate({
    id: "wandb_scale.metric_cardinality",
    target: `>= ${formatCount(target)} metric keys`,
    observed: `${formatCount(observed)} metric keys`,
    pass: observed >= target,
    message: observed >= target
      ? `Observed metric cardinality meets W&B's published ${formatCount(target)} metric-cardinality/project guidance.`
      : `Observed metric cardinality is below W&B's published ${formatCount(target)} metric-cardinality/project guidance.`,
  });
}

function wandbIngestThroughputGate(result) {
  const target = PUBLIC_COMPETITIVE_TARGETS.wandbCloudScaleGuidance.throughputValuesPerMinute;
  const observed = numberFrom(
    result?.dataset?.ingest_values_per_minute,
    result?.dataset?.throughput_values_per_minute,
    result?.ingest?.values_per_minute,
  );
  if (!Number.isFinite(observed)) {
    return notMeasured("wandb_scale.ingest_throughput", `>= ${formatCount(target)} values/minute`, "missing ingest-throughput measurement");
  }
  return thresholdGate({
    id: "wandb_scale.ingest_throughput",
    target: `>= ${formatCount(target)} values/minute`,
    observed: `${formatCount(observed)} values/minute`,
    pass: observed >= target,
    message: observed >= target
      ? `Observed ingest throughput meets W&B's published ${formatCount(target)} values/minute guidance.`
      : `Observed ingest throughput is below W&B's published ${formatCount(target)} values/minute guidance.`,
  });
}

function historicalWandbGate(result, gate) {
  const measurement = findMeasurement(result, gate.measurementNames);
  const tolerance = PUBLIC_COMPETITIVE_TARGETS.wandbHistoricalPublicApiP95Ms.tolerance;
  const targetWithTolerance = Math.round(gate.targetMs * tolerance);
  if (!measurement) {
    return notMeasured(gate.id, `p95 <= ${targetWithTolerance} ms`, `missing measurement: ${gate.measurementNames.join(" or ")}`);
  }
  const observed = Number(measurement.p95_ms);
  if (!Number.isFinite(observed)) {
    return notMeasured(gate.id, `p95 <= ${targetWithTolerance} ms`, `${measurement.name} is missing p95_ms`);
  }
  return thresholdGate({
    id: gate.id,
    target: `p95 <= ${targetWithTolerance} ms`,
    observed: `${observed} ms p95 (${measurement.name})`,
    pass: observed <= targetWithTolerance,
    message: observed <= targetWithTolerance
      ? `${gate.label} is on par with the historical W&B public-API p95 plus 10% tolerance.`
      : `${gate.label} is slower than the historical W&B public-API p95 plus 10% tolerance.`,
  });
}

function neptuneMetricScaleGate(result) {
  const target = PUBLIC_COMPETITIVE_TARGETS.neptunePublicMetricScale;
  const metricKeys = metricKeysFrom(result);
  const metricKeyCount = numberFrom(result?.dataset?.metric_cardinality_per_project, result?.dataset?.observed_metric_cardinality, metricKeys.length || undefined);
  const measurement = findMeasurement(result, NEPTUNE_MEASUREMENT_NAMES);
  if (!Number.isFinite(metricKeyCount) || metricKeyCount < target.metricKeys) {
    return notMeasured(
      "neptune.metric_scale_seconds",
      `>= ${formatCount(target.metricKeys)} metric keys and p95 <= ${target.maxMs} ms`,
      `dataset reports ${Number.isFinite(metricKeyCount) ? formatCount(metricKeyCount) : "unknown"} metric keys`,
    );
  }
  if (!measurement) {
    return notMeasured(
      "neptune.metric_scale_seconds",
      `>= ${formatCount(target.metricKeys)} metric keys and p95 <= ${target.maxMs} ms`,
      "missing metric-catalog or metric-comparison measurement for >=1,000 metric keys",
    );
  }
  const observed = Number(measurement.p95_ms);
  if (!Number.isFinite(observed)) {
    return notMeasured("neptune.metric_scale_seconds", `p95 <= ${target.maxMs} ms`, `${measurement.name} is missing p95_ms`);
  }
  return thresholdGate({
    id: "neptune.metric_scale_seconds",
    target: `>= ${formatCount(target.metricKeys)} metric keys and p95 <= ${target.maxMs} ms`,
    observed: `${formatCount(metricKeyCount)} metric keys, ${observed} ms p95 (${measurement.name})`,
    pass: observed <= target.maxMs,
    message: observed <= target.maxMs
      ? "Metric-scale route meets the conservative Neptune public-claim gate."
      : "Metric-scale route exceeds the conservative Neptune public-claim gate.",
  });
}

function hostedBudgetGate(result) {
  const measurements = Array.isArray(result?.measurements) ? result.measurements : [];
  const budgetedMeasurements = measurements.filter((measurement) => Number.isFinite(measurement?.budget_ms));
  if (!budgetedMeasurements.length) {
    return notMeasured(
      "internal.hosted_budgets",
      "all measurement p95 values <= committed budgets",
      "missing hosted benchmark measurements with budget_ms",
    );
  }
  const failures = budgetFailures(result);
  if (failures.length === 0) {
    return thresholdGate({
      id: "internal.hosted_budgets",
      target: "all measurement p95 values <= committed budgets",
      observed: "no budget failures",
      pass: true,
      message: "All measurements with committed hosted budgets passed.",
    });
  }
  return thresholdGate({
    id: "internal.hosted_budgets",
    target: "all measurement p95 values <= committed budgets",
    observed: `${failures.length} budget failure${failures.length === 1 ? "" : "s"}`,
    pass: false,
    message: failures.join("; "),
  });
}

function thresholdGate({ id, target, observed, pass, message }) {
  return {
    id,
    status: pass ? "pass" : "fail",
    target,
    observed,
    message,
  };
}

function notMeasured(id, target, message) {
  return {
    id,
    status: "not_measured",
    target,
    observed: "not measured",
    message,
  };
}

function findMeasurement(result, names) {
  const measurements = Array.isArray(result?.measurements) ? result.measurements : [];
  for (const name of names) {
    const exact = measurements.find((measurement) => measurement?.name === name);
    if (exact) return exact;
  }
  for (const name of names) {
    const partial = measurements.find((measurement) => typeof measurement?.name === "string" && measurement.name.includes(name));
    if (partial) return partial;
  }
  return undefined;
}

function metricKeysFrom(result) {
  const keys = result?.dataset?.metric_keys;
  if (Array.isArray(keys)) return keys;
  if (typeof keys === "string") return keys.split(",").map((key) => key.trim()).filter(Boolean);
  return [];
}

function summarizeGates(gates) {
  const summary = { pass: 0, fail: 0, not_measured: 0 };
  for (const gate of gates) {
    summary[gate.status] = (summary[gate.status] || 0) + 1;
  }
  summary.total = gates.length;
  return summary;
}

function sortGates(gates) {
  return [...gates].sort((a, b) => {
    const statusDelta = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDelta !== 0) return statusDelta;
    return a.id.localeCompare(b.id);
  });
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return Number.NaN;
}

function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}

function escapeTable(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseArgs(argv) {
  const args = { format: "json", strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[index + 1];
      index += 1;
    } else if (arg === "--format") {
      args.format = argv[index + 1];
      index += 1;
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage: npm run benchmark:competitive-gates -- --input /tmp/instantml-cloud-run-benchmark.json [--format json|markdown] [--strict]

Reads a sanitized hosted benchmark result and reports pass/fail/not_measured
against public W&B scale guidance, the committed historical W&B comparison, and
a conservative Neptune metric-scale gate.
`;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.input) throw new Error(`Missing --input.\n${usage()}`);
  if (!["json", "markdown"].includes(args.format)) throw new Error("--format must be json or markdown");
  const result = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const report = competitiveBenchmarkGates(result);
  if (args.format === "markdown") {
    process.stdout.write(renderCompetitiveGateMarkdown(report));
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  const failures = competitiveGateFailures(report, { strictNotMeasured: args.strict });
  if (failures.length) {
    throw new Error(`competitive benchmark gate failures:\n${failures.join("\n")}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
