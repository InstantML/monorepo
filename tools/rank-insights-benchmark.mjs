#!/usr/bin/env node
import { performance } from "node:perf_hooks";

import {
  evaluationCards,
  groupedRunReducers,
  insightsRunUniverse,
  kMeansClusters,
  numericFieldRows,
} from "../apps/web/src/research-insights.js";

const RUNS = Number.parseInt(process.env.INSTANTML_RANK_INSIGHTS_RUNS ?? "1000", 10);
const SAMPLES = Number.parseInt(process.env.INSTANTML_RANK_INSIGHTS_SAMPLES ?? "8", 10);

function syntheticRuns(count) {
  return Array.from({ length: count }, (_, index) => {
    const lr = 0.0005 + (index % 50) * 0.00005;
    const width = 128 + (index % 4) * 64;
    const accuracy = 0.6 + Math.sin(index / 17) * 0.05 + (width / 1024) * 0.1 - lr * 8;
    return {
      id: `run-${index}`,
      name: `bench-${index}`,
      tags: [index % 2 ? "candidate" : "baseline"],
      config: { seed: index, optimizer: { lr }, width, dropout: (index % 3) * 0.05 },
      latest_metrics: {
        "eval/accuracy": accuracy,
        "eval/f1": accuracy - 0.03,
        "train/loss": 1 - accuracy,
      },
      metric_aggregates: {
        "eval/accuracy": { latest: accuracy, max: accuracy + 0.01 },
        "eval/f1": { latest: accuracy - 0.03, max: accuracy - 0.02 },
        "train/loss": { latest: 1 - accuracy, min: 0.98 - accuracy },
      },
    };
  });
}

function timeCase(name, fn) {
  const durations = [];
  let result = null;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const started = performance.now();
    result = fn();
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  return {
    name,
    p50_ms: round(durations[Math.floor((durations.length - 1) * 0.5)]),
    p95_ms: round(durations[Math.ceil((durations.length - 1) * 0.95)]),
    result_size: Array.isArray(result) ? result.length : Object.keys(result ?? {}).length,
  };
}

const runs = syntheticRuns(RUNS);
const selected = runs.slice(0, Math.min(250, RUNS)).map((run) => run.id);
const cases = [
  timeCase("run_universe", () => insightsRunUniverse(selected, runs)),
  timeCase("grouped_reducers", () => groupedRunReducers(runs, "eval/accuracy")),
  timeCase("numeric_fields", () => numericFieldRows(runs, "eval/accuracy").fields),
  timeCase("kmeans", () => kMeansClusters(runs, "eval/accuracy")),
  timeCase("evaluation_cards", () => evaluationCards(runs)),
];

console.log(JSON.stringify({
  benchmark: "rank-insights",
  runs: RUNS,
  samples: SAMPLES,
  cases,
}, null, 2));

function round(value) {
  return Math.round(value * 100) / 100;
}
