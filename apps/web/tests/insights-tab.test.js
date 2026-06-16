import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluationCards,
  insightsRunUniverse,
  insightsScopeLabel,
  parallelAxisDomains,
  partitionEvaluationCards,
  runGroupingKeyLabel,
} from "../src/research-insights.js";

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
  assert.match(paneSource, /parallelAxisDomains\(rows, fields\)/);
  assert.match(paneSource, /constant · \{formatNumber\(domain\.max, 2\)\}/);
  assert.match(paneSource, /parallel-axis\$\{constant \? " constant" : ""\}/);
  // Constant axes pin run lines to the axis midpoint rather than the bottom.
  assert.match(paneSource, /if \(domain\.constant\) return PARALLEL_AXIS_MID;/);
  assert.match(styles, /\.parallel-axis\.constant \{ opacity: 0\.35; stroke-dasharray: 3 4; \}/);
});

test("I4: scatter points and parallel lines are clickable and name the run on hover", () => {
  // Optional prop with a no-op default so the dashboard shell needs no changes.
  assert.match(paneSource, /onSelectRun\?: \(runId: string\) => void/);
  assert.match(paneSource, /onSelectRun = \(\) => \{\}/);
  assert.match(paneSource, /onClick=\{\(\) => onSelectRun\(point\.run\.id\)\}/);
  assert.match(paneSource, /onClick=\{\(\) => onSelectRun\(row\.run\.id\)\}/);
  // svg <title> as the hover-tooltip floor on both marks.
  assert.match(paneSource, /<title>\{label\}<\/title>/);
  assert.match(paneSource, /<title>\{row\.run\.name\}<\/title>/);
  assert.match(styles, /\.parallel-line \{[^}]*pointer-events: stroke;/);
  assert.match(styles, /\.analysis-scatter:not\(\.clusters\) circle \{ cursor: pointer; \}/);
});
