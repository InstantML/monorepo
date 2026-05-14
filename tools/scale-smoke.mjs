#!/usr/bin/env node
import { performance } from "node:perf_hooks";

import { createStore, emptyState } from "../apps/server/src/db.js";

const runCount = Number(process.env.RLOBS_SCALE_RUNS ?? 50);
const metricCount = Number(process.env.RLOBS_SCALE_METRICS ?? 20);
const pointCount = Number(process.env.RLOBS_SCALE_POINTS ?? 1000);
const store = createStore(emptyState());

const ingestStart = performance.now();
for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
  const run = store.createRun({
    project: "scale-smoke",
    name: `scale-run-${String(runIndex).padStart(2, "0")}`,
    config: { seed: runIndex, algo: runIndex % 2 ? "ppo" : "sac" },
    tags: [runIndex % 2 ? "baseline" : "candidate"],
  });
  for (let step = 0; step < pointCount; step += 1) {
    const metrics = {};
    for (let metricIndex = 0; metricIndex < metricCount; metricIndex += 1) {
      metrics[`metric/${metricIndex}`] = Math.sin(step / 25 + metricIndex) + runIndex * 0.01;
    }
    store.logMetrics(run.id, { step, metrics });
  }
}
const ingestMs = performance.now() - ingestStart;

const summaryStart = performance.now();
const summary = store.runsSummary({ project: "scale-smoke", limit: runCount });
const summaryMs = performance.now() - summaryStart;

const chartStart = performance.now();
const chartPoints = store.getMetrics(summary.runs[0].id, { key: "metric/0", limit: pointCount });
const chartMs = performance.now() - chartStart;

if (summary.total !== runCount) throw new Error(`expected ${runCount} runs, saw ${summary.total}`);
if (summary.runs.length !== runCount) throw new Error(`expected ${runCount} summary rows, saw ${summary.runs.length}`);
if (chartPoints.length !== pointCount) throw new Error(`expected ${pointCount} chart points, saw ${chartPoints.length}`);
if (summary.runs[0].metric_aggregates["metric/0"].count !== pointCount) throw new Error("metric aggregate count mismatch");

console.log(
  JSON.stringify(
    {
      runs: runCount,
      metrics_per_run: metricCount,
      points_per_metric: pointCount,
      total_metric_points: runCount * metricCount * pointCount,
      ingest_ms: Math.round(ingestMs),
      summary_ms: Math.round(summaryMs),
      chart_query_ms: Math.round(chartMs),
    },
    null,
    2,
  ),
);
