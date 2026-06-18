import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatEnergy,
  formatGpuHours,
  formatPercentValue,
  formatSamples,
  normalizeSystemUsagePayload,
  sortedAttentionCards,
  systemUsageQuery,
  systemUsageState,
} from "../src/system-usage-insights.js";

const paneSource = readFileSync(new URL("../app/dashboard/insights/system-usage-pane.tsx", import.meta.url), "utf8");
const tabSource = readFileSync(new URL("../app/dashboard/insights/tab-pane.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/styles/research.css", import.meta.url), "utf8");

test("system usage query defaults to the GPU insights MVP contract", () => {
  assert.deepEqual(systemUsageQuery(), {
    family: "gpu",
    range: "14d",
    group_by: "actor",
    project: "",
    actor: "",
    gpu_model: "",
    min_coverage_pct: "",
    limit: 100,
  });
  assert.equal(systemUsageQuery({ range: "30d", groupBy: "project", project: "core" }).project, "core");
});

test("system usage payload normalization is defensive", () => {
  const empty = normalizeSystemUsagePayload(null);
  assert.equal(empty.summary.observed_gpu_hours, 0);
  assert.deepEqual(empty.groups, []);
  const payload = normalizeSystemUsagePayload({ summary: { observed_gpu_hours: 2 }, groups: [{ key: "a" }] });
  assert.equal(payload.summary.observed_gpu_hours, 2);
  assert.equal(payload.summary.sample_count, 0);
  assert.equal(payload.groups.length, 1);
});

test("system usage states distinguish no-runs, no-gpu, partial, and ready", () => {
  assert.equal(systemUsageState({ coverage: { runs_in_scope: 0 } }), "no_runs");
  assert.equal(systemUsageState({ coverage: { runs_in_scope: 2, runs_with_gpu_metrics: 0 } }), "no_gpu_metrics");
  assert.equal(systemUsageState({ coverage: { runs_in_scope: 2, runs_with_gpu_metrics: 1, coverage_pct: 35 } }), "partial");
  assert.equal(systemUsageState({ coverage: { runs_in_scope: 2, runs_with_gpu_metrics: 2, coverage_pct: 90 } }), "ready");
});

test("attention cards sort by severity before magnitude", () => {
  const sorted = sortedAttentionCards([
    { id: "info-big", severity: "info", value: 99 },
    { id: "warn-small", severity: "warn", value: 1 },
    { id: "bad", severity: "bad", value: 2 },
  ]);
  assert.deepEqual(sorted.map((card) => card.id), ["bad", "warn-small", "info-big"]);
});

test("GPU-hour formatting stays compact for small and large values", () => {
  assert.equal(formatGpuHours(0), "0h");
  assert.equal(formatGpuHours(0.004), "<0.01h");
  assert.equal(formatGpuHours(12.34), "12.3h");
  assert.equal(formatGpuHours("nope"), "-");
  assert.equal(formatPercentValue(74.4), "74%");
  assert.equal(formatPercentValue(null), "-");
  assert.equal(formatPercentValue(undefined), "-");
  assert.equal(formatPercentValue(0), "0%");
  assert.equal(formatEnergy(3.456), "3.46 kWh");
  assert.equal(formatEnergy(0), "-");
  assert.equal(formatSamples(1200), "1,200 samples");
  assert.equal(formatSamples("nope"), "0 samples");
});

test("GPU usage pane wires accessible loading, errors, tables, and controls", () => {
  assert.match(paneSource, /role="alert"/);
  assert.match(paneSource, /aria-live="polite"/);
  assert.match(paneSource, /aria-busy=\{loading\}/);
  assert.match(paneSource, /<caption>Observed GPU usage grouped by/);
  assert.match(paneSource, /scope="col"/);
  assert.match(paneSource, /scope="row"/);
  assert.match(paneSource, /role="img"/);
  assert.match(paneSource, /aria-label="Refresh GPU usage insights"/);
  assert.match(paneSource, /id="usage-project"/);
  assert.match(paneSource, /state === "ready" \|\| state === "partial"/);
  assert.match(tabSource, /aria-pressed=\{activeView === "usage"\}/);
  assert.match(tabSource, /SystemUsageInsightsPane/);
  assert.match(tabSource, /RunAnalysisInsightsPane/);
  assert.match(styles, /\.usage-kpi-strip/);
  assert.match(styles, /repeat\(auto-fit, minmax\(132px, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 900px\)/);
});
