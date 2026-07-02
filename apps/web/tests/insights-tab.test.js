import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluationCards,
  insightsRunUniverse,
  insightsScopeLabel,
  looksLogarithmicField,
  parallelAxisDomains,
  parallelSummaryRows,
  partitionEvaluationCards,
  runGroupingKeyLabel,
  scatterGeometry,
  scatterSummaryRows,
} from "../src/research-insights.js";
import { formatAxisTick } from "../src/charts.js";

const paneSource = readFileSync(new URL("../app/dashboard/insights/tab-pane.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/styles/research.css", import.meta.url), "utf8");
const helpersSource = readFileSync(new URL("../src/research-insights.js", import.meta.url), "utf8");

function run(id, overrides = {}) {
  return { id, name: `run-${id}`, tags: [], config: {}, latest_metrics: {}, metric_aggregates: {}, ...overrides };
}

test("insights scope label reads as plain English instead of 'Using N current loaded page'", () => {
  const runs = [run("a"), run("b")];
  assert.equal(insightsScopeLabel(insightsRunUniverse([], runs)), "Analyzing the 2 loaded runs");
  assert.equal(insightsScopeLabel(insightsRunUniverse(["a"], runs)), "Analyzing the 1 selected run");
  assert.equal(
    insightsScopeLabel(insightsRunUniverse(["a", "ghost"], runs)),
    "Analyzing the 1 selected run · 1 selected without loaded summaries",
  );
  assert.equal(insightsScopeLabel(insightsRunUniverse([], [])), "Analyzing the 0 loaded runs");
});

test("grouping key label names the field grouped reducers bucket by", () => {
  const seeded = [run("a", { config: { seed: 17 } }), run("b", { config: { seed: 7 } })];
  assert.equal(runGroupingKeyLabel(seeded), "seed");

  const tagged = [run("a", { tags: ["base"] }), run("b", { tags: ["alt"] })];
  assert.equal(runGroupingKeyLabel(tagged), "tag");

  const configOnly = [
    run("a", { config: { optimizer: { lr: 0.001 } } }),
    run("b", { config: { optimizer: { lr: 0.002 } } }),
  ];
  assert.equal(runGroupingKeyLabel(configOnly), "optimizer.lr");

  // Nothing to group by collapses to one "all" bucket; no key worth naming.
  assert.equal(runGroupingKeyLabel([run("a"), run("b")]), null);
  assert.equal(runGroupingKeyLabel([]), null);
});

test("evaluation cards partition into logged and unlogged tiles", () => {
  const runs = [
    run("a", {
      latest_metrics: { "eval/accuracy": 0.8, "train/loss": 0.4 },
      metric_aggregates: { "eval/accuracy": { max: 0.82, latest: 0.8 }, "train/loss": { min: 0.3, latest: 0.4 } },
    }),
    run("b", {
      latest_metrics: { "eval/accuracy": 0.9, "train/loss": 0.2 },
      metric_aggregates: { "eval/accuracy": { max: 0.92, latest: 0.9 }, "train/loss": { min: 0.2, latest: 0.2 } },
    }),
  ];
  const cards = evaluationCards(runs);
  const { logged, unlogged } = partitionEvaluationCards(cards);
  assert.deepEqual(logged.map((card) => card.id).sort(), ["accuracy", "loss"]);
  assert.equal(logged.length + unlogged.length, cards.length);
  assert.ok(unlogged.length >= 1);
  assert.ok(unlogged.every((card) => card.key === null));
  // Defensive: non-array input partitions to empty buckets instead of throwing.
  assert.deepEqual(partitionEvaluationCards(undefined), { logged: [], unlogged: [] });
});

test("parallel axis domains flag constant and empty axes", () => {
  const rows = [
    { run: { id: "a" }, values: { "config.lr": 0.1, "config.epochs": 160, "config.gap": Number.NaN } },
    { run: { id: "b" }, values: { "config.lr": 0.2, "config.epochs": 160 } },
  ];
  const domains = parallelAxisDomains(rows, ["config.lr", "config.epochs", "config.gap", "config.missing"]);
  assert.deepEqual(domains[0], { field: "config.lr", min: 0.1, max: 0.2, constant: false, empty: false });
  assert.deepEqual(domains[1], { field: "config.epochs", min: 160, max: 160, constant: true, empty: false });
  assert.deepEqual(domains[2], { field: "config.gap", min: null, max: null, constant: false, empty: true });
  assert.deepEqual(domains[3], { field: "config.missing", min: null, max: null, constant: false, empty: true });
  assert.deepEqual(parallelAxisDomains(undefined, undefined), []);
});

test("I5: insights header copy says 'Analyzing the N loaded runs'", () => {
  assert.match(paneSource, /insightsScopeLabel\(universe\)/);
  assert.match(helpersSource, /Analyzing the \$\{formatNumber\(count, 0\)\}/);
  assert.doesNotMatch(paneSource, /current loaded page/);
  assert.doesNotMatch(helpersSource, /current loaded page/);
});

test("I1: grouped reducer panel surfaces the grouping key", () => {
  assert.match(paneSource, /Grouped by \{groupingKey\}/);
  // The table's first column header names the key instead of the generic "group".
  assert.match(paneSource, /<span>\{groupingKey \?\? "group"\}<\/span>/);
  assert.match(styles, /\.analysis-sublabel \{/);
});

test("I2: unlogged evaluation cards hide behind a disclosure chip", () => {
  assert.match(paneSource, /partitionEvaluationCards\(cards\)/);
  assert.match(paneSource, /showUnlogged \? \[\.\.\.logged, \.\.\.unlogged\] : logged/);
  assert.match(paneSource, /not logged ▾/);
  assert.match(paneSource, /not logged ▴/);
  assert.match(paneSource, /aria-expanded=\{showUnlogged\}/);
  assert.match(styles, /\.eval-unlogged-toggle \{/);
});

test("I3: constant parallel axes get one centered label and a dimmed line", () => {
  // Domains are computed over the capped, drawn row set (see PARALLEL_MAX_DRAWN).
  assert.match(paneSource, /parallelAxisDomains\(drawnRows, fields\)/);
  // Axis value labels use the magnitude-aware formatter so a learning-rate axis
  // (e.g. 1e-4) never collapses to "0".
  assert.match(paneSource, /constant · \{formatAxisTick\(domain\.max\)\}/);
  assert.match(paneSource, /parallel-axis\$\{constant \? " constant" : ""\}/);
  // Constant axes pin run lines to the axis midpoint rather than the bottom.
  assert.match(paneSource, /if \(domain\.constant\) return PARALLEL_AXIS_MID;/);
  assert.match(styles, /\.parallel-axis\.constant \{ opacity: 0\.35; stroke-dasharray: 3 4; \}/);
});

test("I4: scatter points and parallel lines are clickable and identify the run on hover", () => {
  // Optional prop with a no-op default so the dashboard shell needs no changes.
  assert.match(paneSource, /onSelectRun\?: \(runId: string\) => void/);
  assert.match(paneSource, /onSelectRun = \(\) => \{\}/);
  assert.match(paneSource, /onClick=\{\(\) => onSelectRun\(point\.run\.id\)\}/);
  assert.match(paneSource, /onClick=\{\(\) => onSelectRun\(row\.run\.id\)\}/);
  // Hover identification comes from the point-anchored tooltip; native svg
  // <title> would pop a second, laggy browser tooltip on top of it.
  assert.match(paneSource, /onMouseEnter=\{\(event\) => setTip\(lineTipFor\(row\.run\.id, event\)\)\}/);
  assert.doesNotMatch(paneSource, /<title>\{label\}<\/title>/);
  assert.doesNotMatch(paneSource, /<title>\{row\.run\.name\}<\/title>/);
  assert.match(styles, /\.parallel-line \{[^}]*pointer-events: stroke;/);
  assert.match(styles, /\.analysis-scatter:not\(\.clusters\) circle \{ cursor: pointer; \}/);
});

test("looksLogarithmicField only flags learning-rate-like axes", () => {
  assert.equal(looksLogarithmicField("config.learning_rate"), true);
  assert.equal(looksLogarithmicField("config.lr"), true);
  assert.equal(looksLogarithmicField("lr"), true);
  assert.equal(looksLogarithmicField("metric.latest.train/lr"), true);
  // Conservative: metrics that can cross zero (loss, rewards) and noise fields
  // are never silently log-scaled.
  assert.equal(looksLogarithmicField("metric.best.eval/loss"), false);
  assert.equal(looksLogarithmicField("config.seed"), false);
  assert.equal(looksLogarithmicField("config.batch_size"), false);
  assert.equal(looksLogarithmicField(undefined), false);
});

test("scatterGeometry maps a linear axis to the SVG plot extents", () => {
  const points = [
    { run: { id: "a", name: "a" }, x: 0, y: 0 },
    { run: { id: "b", name: "b" }, x: 10, y: 100 },
  ];
  const geo = scatterGeometry(points, { xScale: "linear", yScale: "linear" });
  assert.equal(geo.empty, false);
  assert.equal(Math.round(geo.x(0)), 48);
  assert.equal(Math.round(geo.x(10)), 488);
  assert.equal(Math.round(geo.x(5)), 268);
  assert.equal(Math.round(geo.y(0)), 200);
  assert.equal(Math.round(geo.y(100)), 24);
  assert.equal(geo.dropped, 0);
});

test("scatterGeometry log axis maps log10 and drops non-positive values", () => {
  const points = [
    { run: { id: "neg", name: "neg" }, x: -1, y: 5 },
    { run: { id: "lo", name: "lo" }, x: 1, y: 10 },
    { run: { id: "mid", name: "mid" }, x: 10, y: 15 },
    { run: { id: "hi", name: "hi" }, x: 100, y: 20 },
  ];
  const geo = scatterGeometry(points, { xScale: "log", yScale: "linear" });
  assert.equal(geo.dropped, 1); // x=-1 cannot sit on a log axis
  assert.equal(geo.points.length, 3);
  // log10(1)=0 -> left, log10(100)=2 -> right, log10(10)=1 -> midpoint
  assert.equal(Math.round(geo.x(1)), 48);
  assert.equal(Math.round(geo.x(100)), 488);
  assert.equal(Math.round(geo.x(10)), 268);
});

test("scatterGeometry returns an empty result when a log axis has no positive values", () => {
  const points = [
    { run: { id: "a", name: "a" }, x: -1, y: 1 },
    { run: { id: "b", name: "b" }, x: 0, y: 2 },
  ];
  const geo = scatterGeometry(points, { xScale: "log", yScale: "linear" });
  assert.equal(geo.empty, true);
  assert.equal(geo.dropped, 2);
});

test("scatterSummaryRows ranks plotted runs by the Y field and drops non-finite", () => {
  const points = [
    { run: { id: "a", name: "alpha" }, x: 1, y: 5 },
    { run: { id: "b", name: "beta" }, x: 2, y: 9 },
    { run: { id: "c", name: "gamma" }, x: Number.NaN, y: 3 },
  ];
  const rows = scatterSummaryRows(points);
  assert.deepEqual(rows.map((row) => row.id), ["b", "a"]); // gamma dropped (NaN x)
  assert.equal(rows[0].y, 9);
});

test("parallelSummaryRows flags the best run and nulls missing axis values", () => {
  const rows = [
    { run: { id: "a", name: "alpha" }, values: { "config.lr": 0.1, "config.bs": 32 } },
    { run: { id: "b", name: "beta" }, values: { "config.lr": 0.2 } },
  ];
  const fields = ["config.lr", "config.bs"];
  const summary = parallelSummaryRows(rows, fields, "b");
  assert.equal(summary[0].best, false);
  assert.equal(summary[1].best, true);
  assert.equal(summary[0].values["config.bs"], 32);
  assert.equal(summary[1].values["config.bs"], null); // missing -> null, not NaN
});

test("scatter explorer wires log scaling, a chart/table toggle, and an accessible table", () => {
  assert.match(paneSource, /scatterGeometry\(points, \{ xScale, yScale, width \}\)/);
  assert.match(paneSource, /analysis-scale-button/);
  assert.match(paneSource, /Toggle a logarithmic [XY] axis/);
  assert.match(paneSource, /ariaLabel="Scatter view"/);
  assert.match(paneSource, /function ScatterSummaryTable/);
  // Accessible table reuses the established summary-table markup.
  assert.match(paneSource, /<table className="chart-summary-table"/);
  assert.match(paneSource, /scope="row"/);
});

test("parallel coordinates explorer is keyboard-focusable, capped, and disclosed", () => {
  // The chart svg becomes focusable with a live readout (was role=img only).
  assert.match(paneSource, /className="parallel-chart"[\s\S]*?tabIndex=\{0\}/);
  assert.match(paneSource, /setTip\(focusTipFor\(bestRunId \?\? drawnRows\[0\]\?\.run\.id \?\? null\)\)/);
  assert.match(paneSource, /function ParallelSummaryTable/);
  assert.match(paneSource, /ariaLabel="Parallel coordinates view"/);
  // Honest truncation: a named cap and disclosed "shown of" copy, not a silent slice.
  assert.match(paneSource, /PARALLEL_MAX_DRAWN = 200/);
  assert.match(paneSource, /shown of/);
  // The pane no longer pre-slices parallel rows to a silent 80.
  assert.doesNotMatch(paneSource, /numeric\.rows\.slice\(0, 80\)/);
});

test("explorer control styles exist for the scale toggle and summary tables", () => {
  assert.match(styles, /\.analysis-scale-button \{/);
  assert.match(styles, /\.analysis-scale-button\.active \{/);
  assert.match(styles, /\.analysis-summary-table-wrap \{/);
  assert.match(styles, /\.chart-summary-table tr\.is-best/);
});

test("scatter axis labels use formatAxisTick so a log learning-rate axis never reads '0'", () => {
  // Regression guard: formatNumber(1e-5, 3) === "0" collapses tiny LR ticks to
  // zero — the exact failure log scale exists to fix. Ticks must use the
  // magnitude-aware formatter, and the hover/readout the adaptive metric one.
  assert.match(paneSource, /formatAxisTick\(geometry\.minX\)/);
  assert.match(paneSource, /formatAxisTick\(geometry\.maxX\)/);
  assert.match(paneSource, /formatAxisTick\(geometry\.minY\)/);
  assert.match(paneSource, /formatAxisTick\(geometry\.maxY\)/);
  assert.doesNotMatch(paneSource, /formatNumber\(geometry\.(min|max)[XY], \d\)/);
  assert.match(paneSource, /fields\[0\]\}=\$\{formatMetricValue\(point\.x\)/);
  // Sanity check the helper itself: a learning-rate-scale tick is not "0".
  assert.equal(formatAxisTick(1e-5) === "0", false);
});

test("scatterGeometry spreads the x extents across a wider measured frame", () => {
  const points = [
    { run: { id: "a", name: "a" }, x: 0, y: 0 },
    { run: { id: "b", name: "b" }, x: 10, y: 100 },
  ];
  const geo = scatterGeometry(points, { xScale: "linear", yScale: "linear", width: 1040 });
  assert.equal(Math.round(geo.x(0)), 48);
  assert.equal(Math.round(geo.x(10)), 1008); // width - 32
  assert.equal(Math.round(geo.x(5)), 528);
  // Vertical layout is fixed — only the width tracks the container.
  assert.equal(Math.round(geo.y(0)), 200);
  assert.equal(Math.round(geo.y(100)), 24);
});

test("insight charts render the viewBox at the measured frame width so SVG text stays UI-sized", () => {
  // A fixed viewBox stretched to width:100% scales axis text with the card —
  // the "giant uppercase axis label" bug. Every chart must measure its frame.
  assert.match(paneSource, /useChartFrameWidth\(SCATTER_FRAME_WIDTH\)/);
  assert.match(paneSource, /useChartFrameWidth\(PARALLEL_FRAME_WIDTH\)/);
  assert.match(paneSource, /viewBox=\{`0 0 \$\{width\} \$\{SCATTER_FRAME_HEIGHT\}`\}/);
  assert.match(paneSource, /viewBox=\{`0 0 \$\{width\} \$\{PARALLEL_FRAME_HEIGHT\}`\}/);
  assert.doesNotMatch(paneSource, /viewBox="0 0 \d+ \d+"/);
});

test("hover details render as a point-anchored tooltip, not a readout row below the chart", () => {
  // The tooltip reuses the Runs-tab .chart-tooltip skin and shared placement
  // helper, floats over the chart shell (so hovering never reflows the card),
  // and fully replaces the old .analysis-readout strip.
  assert.match(paneSource, /chartTooltipPlacement/);
  assert.match(paneSource, /className="chart-tooltip analysis-point-tip"/);
  assert.match(paneSource, /className="analysis-chart-shell"/);
  assert.doesNotMatch(paneSource, /analysis-readout/);
  assert.match(styles, /\.analysis-chart-shell \{/);
  assert.match(styles, /\.analysis-point-tip \{/);
  assert.doesNotMatch(styles, /\.analysis-readout \{/);
});

test("scatter Table view is gated on its own rows, not on a plottable chart", () => {
  // A log axis that drops every point (hasPlot=false) must NOT hide the table —
  // the table is the scale-independent accessibility fallback.
  assert.match(paneSource, /view === "table" \? \(summaryRows\.length \?/);
  assert.match(paneSource, /\) : hasPlot \? \(/);
});
