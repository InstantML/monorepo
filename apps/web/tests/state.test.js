import assert from "node:assert/strict";
import test from "node:test";

import { averageGroupedSeries, axisTicks, chartDomain, chartSummary, formatAxisTick, formatAxisValue, formatMetricValue, nearestPoint, normalizeSeries, smoothSeries, svgPointFromClient } from "../src/charts.js";
import { adaptiveMetricSeriesLimit, adaptiveMetricSeriesPatchSize, chartPointCount, chunkRunIds, histogramBins, indexedAxisTicks, latestMetricValues, mergeMetricSeriesPatches, shouldUseDenseChart } from "../src/dashboard-panels.js";
import { buildEvidenceSections, firstEvidenceItem } from "../src/evidence.js";
import {
  MAX_SELECTED_RUNS,
  DEFAULT_SELECTED_RUNS,
  BULK_SELECT_MATCHING_LIMIT,
  bestMetric,
  capSelectionToMatching,
  defaultRunSelection,
  deselectVisible,
  durationLabel,
  filterMetricKeys,
  formatNumber,
  groupKeyForRun,
  identifierForRun,
  isInternalInstantMlMetric,
  metricFilterIsRegex,
  metricAggregate,
  metricGoal,
  metricGoalLabel,
  metricGoalValue,
  metricKeysFromSummary,
  preferredMetricKey,
  rangeSelect,
  selectAllVisible,
  sortRuns,
  statusTone,
  toggleSelection,
  uploadHealthForRun,
  visibleSelectionState,
} from "../src/state.js";
import { ApiClient, ApiError, isAbortError, isTransientApiError, queryString, retryTransientRequest } from "../src/api.js";
import { buildCheckpointForkBody, buildCheckpointResumeCode, checkpointForkIdempotencyKey, defaultForkRunName } from "../src/checkpoints.js";
import { DEFAULT_DASHBOARD_TAB, canonicalDashboardPath, isStorageReadyState, normalizeDeviceUserCode, onboardingRedirectPath, pathFromLegacyHash, postAuthRedirectPath, safeCheckoutRedirectUrl, safeSameOriginInviteUrl, safeStripeRedirectUrl, sanitizeNextPath, sessionRequiresStorageOnboarding, tabFromPath, tabToPath } from "../src/routes.js";
import { evaluationCards, groupedRunReducers, insightsRunUniverse, kMeansClusters, numericFieldRows } from "../src/research-insights.js";
import { isEditableElement, matchesShortcut, platformModifierLabel } from "../src/shortcuts.js";
import { ansiTokens, terminalWindow } from "../src/terminal.js";
import { deriveClerkSlug, slugify } from "../src/workspace.js";

test("selection is capped and toggled", () => {
  let selected = [];
  const ids = Array.from({ length: MAX_SELECTED_RUNS + 1 }, (_, index) => `run-${index}`);
  for (const id of ids) selected = toggleSelection(selected, id);
  assert.equal(selected.length, MAX_SELECTED_RUNS);
  assert.equal(selected.includes("run-0"), false);
  assert.equal(selected.at(-1), `run-${MAX_SELECTED_RUNS}`);
  assert.deepEqual(toggleSelection(selected, "run-4"), selected.filter((id) => id !== "run-4"));
});

test("research insights helpers scope runs, extract fields, cluster, and detect eval metrics", () => {
  const runs = [
    {
      id: "a",
      name: "run-a",
      tags: ["base"],
      config: { seed: 1, optimizer: { lr: 0.001 }, width: 128 },
      latest_metrics: { "eval/accuracy": 0.8, "eval/f1": 0.7, "train/loss": 0.4 },
      metric_aggregates: { "eval/accuracy": { max: 0.82, latest: 0.8 }, "train/loss": { min: 0.3, latest: 0.4 } },
    },
    {
      id: "b",
      name: "run-b",
      tags: ["base"],
      config: { seed: 2, optimizer: { lr: 0.002 }, width: 256 },
      latest_metrics: { "eval/accuracy": 0.9, "eval/f1": 0.8, "train/loss": 0.2 },
      metric_aggregates: { "eval/accuracy": { max: 0.92, latest: 0.9 }, "train/loss": { min: 0.2, latest: 0.2 } },
    },
    {
      id: "c",
      name: "run-c",
      tags: ["alt"],
      config: { seed: 3, optimizer: { lr: 0.003 }, width: 512 },
      latest_metrics: { "eval/accuracy": 0.7, "eval/f1": 0.6, "train/loss": 0.8 },
      metric_aggregates: { "eval/accuracy": { max: 0.72, latest: 0.7 }, "train/loss": { min: 0.6, latest: 0.8 } },
    },
  ];
  const universe = insightsRunUniverse(["a", "missing"], runs);
  assert.deepEqual(universe.runs.map((run) => run.id), ["a"]);
  assert.equal(universe.excluded, 1);
  const grouped = groupedRunReducers(runs, "eval/accuracy");
  assert.equal(grouped.length, 3);
  const fields = numericFieldRows(runs, "eval/accuracy").fields;
  assert(fields.includes("config.optimizer.lr"));
  assert(fields.includes("metric.best.eval/accuracy"));
  const clusters = kMeansClusters(runs, "eval/accuracy", 2);
  assert.equal(clusters.points.length, 3);
  assert(clusters.clusters.length >= 1);
  const cards = evaluationCards(runs);
  assert.equal(cards.find((card) => card.id === "accuracy").key, "eval/accuracy");
  assert.equal(cards.find((card) => card.id === "f1").count, 3);
});

test("dashboard panel helpers chunk large selections and merge patches in run order", () => {
  const runs = Array.from({ length: 125 }, (_, index) => ({ id: `run-${index}`, name: `Run ${index}` }));
  assert.deepEqual(chunkRunIds(runs).map((chunk) => chunk.length), [100, 25]);
  assert.deepEqual(chunkRunIds(Array.from({ length: 2000 }, (_, index) => ({ id: `run-${index}` }))).map((chunk) => chunk.length), [2000]);
  const chunks = chunkRunIds(runs, 50);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 25]);
  assert.equal(adaptiveMetricSeriesLimit(20), 1000);
  assert.equal(adaptiveMetricSeriesLimit(50), 500);
  assert.equal(adaptiveMetricSeriesLimit(150), 250);
  assert.equal(adaptiveMetricSeriesLimit(300), 160);
  assert.equal(adaptiveMetricSeriesLimit(500), 120);
  assert.equal(adaptiveMetricSeriesLimit(1000), 80);
  assert.equal(adaptiveMetricSeriesLimit(2000), 60);
  assert.equal(adaptiveMetricSeriesPatchSize(249), 100);
  assert.equal(adaptiveMetricSeriesPatchSize(250), 250);
  assert.equal(adaptiveMetricSeriesPatchSize(500), 500);
  assert.equal(adaptiveMetricSeriesPatchSize(2000), 2000);
  const merged = mergeMetricSeriesPatches(runs.slice(0, 3), [{ id: "run-0", name: "Run 0", points: [] }], [{ id: "run-2", name: "Run 2", points: [{ step: 1, value: 2 }] }]);
  assert.deepEqual(merged.map((series) => series.id), ["run-0", "run-1", "run-2"]);
  assert.deepEqual(merged[2].points, [{ step: 1, value: 2 }]);
});

test("dense chart helper switches for many series or many points", () => {
  const sparse = Array.from({ length: 3 }, (_, index) => ({ id: `run-${index}`, normalizedPoints: [{ x: index, y: index }] }));
  const manySeries = Array.from({ length: 121 }, (_, index) => ({ id: `run-${index}`, normalizedPoints: [{ x: index, y: index }] }));
  const manyPoints = [{ id: "run-heavy", normalizedPoints: Array.from({ length: 8001 }, (_, index) => ({ x: index, y: index })) }];
  assert.equal(chartPointCount(sparse), 3);
  assert.equal(shouldUseDenseChart(sparse), false);
  assert.equal(shouldUseDenseChart(manySeries), true);
  assert.equal(shouldUseDenseChart(manyPoints), true);
});

test("latest-value panel helpers derive chart data from run summaries", () => {
  const runs = [
    { id: "a", name: "A", metric_aggregates: { reward: { latest: 1 } } },
    { id: "b", name: "B", metric_aggregates: { reward: { latest: 3 } } },
    { id: "c", name: "C", metric_aggregates: { reward: { latest: "bad" } } },
  ];
  assert.deepEqual(latestMetricValues(runs, "reward").map((item) => [item.id, item.value]), [["a", 1], ["b", 3]]);
  assert.deepEqual(histogramBins([1, 2, 3, 4], 4).reduce((sum, bin) => sum + bin.count, 0), 4);
  assert.deepEqual(histogramBins([2, 2, 2], 8), [{ min: 2, max: 2, count: 3 }]);
  assert.deepEqual(indexedAxisTicks(12, 5), [0, 3, 6, 8, 11]);
  assert.deepEqual(indexedAxisTicks(1, 5), [0]);
  assert.deepEqual(indexedAxisTicks(0, 5), []);
});

test("visibleSelectionState reports none/some/all", () => {
  assert.equal(visibleSelectionState([], []), "none");
  assert.equal(visibleSelectionState([], ["a", "b"]), "none");
  assert.equal(visibleSelectionState(["a"], ["a", "b"]), "some");
  assert.equal(visibleSelectionState(["a", "b"], ["a", "b"]), "all");
  assert.equal(visibleSelectionState(["a", "b", "c"], ["a", "b"]), "all");
  assert.equal(visibleSelectionState(["z"], ["a", "b"]), "none");
});

test("selectAllVisible adds visible ids without duplicating, preserving prior selection", () => {
  assert.deepEqual(selectAllVisible([], ["a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(selectAllVisible(["x"], ["a", "b"]), ["x", "a", "b"]);
  assert.deepEqual(selectAllVisible(["a"], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(selectAllVisible(["a", "b"], []), ["a", "b"]);
});

test("selectAllVisible respects MAX_SELECTED_RUNS by dropping oldest entries", () => {
  const existing = Array.from({ length: MAX_SELECTED_RUNS - 1 }, (_, index) => `old-${index}`);
  const visible = ["new-0", "new-1", "new-2"];
  const next = selectAllVisible(existing, visible);
  assert.equal(next.length, MAX_SELECTED_RUNS);
  assert.equal(next.at(-1), "new-2");
  assert.equal(next.includes("old-0"), false);
  assert.equal(next.includes("new-0"), true);
});

test("deselectVisible removes only the requested ids", () => {
  assert.deepEqual(deselectVisible(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(deselectVisible(["a"], []), ["a"]);
  assert.deepEqual(deselectVisible(["a", "b"], ["a", "b", "c"]), []);
});

test("rangeSelect selects an inclusive range between anchor and target", () => {
  const ordered = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rangeSelect([], ordered, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeSelect([], ordered, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rangeSelect(["a"], ordered, "b", "d"), ["a", "b", "c", "d"]);
});

test("rangeSelect with no anchor or matching anchor falls back to toggle", () => {
  const ordered = ["a", "b", "c"];
  assert.deepEqual(rangeSelect([], ordered, "", "b"), ["b"]);
  assert.deepEqual(rangeSelect(["b"], ordered, "b", "b"), []);
  assert.deepEqual(rangeSelect([], ordered, "z", "b"), ["b"]);
});

test("rangeSelect ignores targets not in the ordered list", () => {
  assert.deepEqual(rangeSelect(["a"], ["a", "b"], "a", "missing"), ["a"]);
});

test("deselectVisible leaves cross-page selections in place so callers can detect them", () => {
  const visible = ["a", "b"];
  const selected = ["a", "b", "x", "y"];
  const remaining = deselectVisible(selected, visible);
  assert.deepEqual(remaining, ["x", "y"]);
  // If selectAllVisible reports "all" but selected.length > visible.length the caller
  // should clear instead of calling deselectVisible — these helpers do not collapse
  // the cross-page set automatically.
  assert.equal(visibleSelectionState(selected, visible), "all");
});

test("capSelectionToMatching truncates at BULK_SELECT_MATCHING_LIMIT by default", () => {
  assert.ok(BULK_SELECT_MATCHING_LIMIT < MAX_SELECTED_RUNS, "bulk limit should stay below the hard cap");
  const ids = Array.from({ length: BULK_SELECT_MATCHING_LIMIT + 17 }, (_, index) => `id-${index}`);
  const capped = capSelectionToMatching(ids);
  assert.equal(capped.length, BULK_SELECT_MATCHING_LIMIT);
  assert.equal(capped[0], "id-0");
  assert.equal(capped.at(-1), `id-${BULK_SELECT_MATCHING_LIMIT - 1}`);
  assert.deepEqual(capSelectionToMatching(null), []);
});

test("capSelectionToMatching honours an explicit limit", () => {
  const ids = Array.from({ length: 50 }, (_, index) => `id-${index}`);
  assert.equal(capSelectionToMatching(ids, 10).length, 10);
  assert.equal(capSelectionToMatching(ids, MAX_SELECTED_RUNS).length, 50);
});

test("defaultRunSelection only auto-selects once", () => {
  const runs = Array.from({ length: DEFAULT_SELECTED_RUNS + 8 }, (_, index) => ({ id: `run-${index}` }));
  const selected = defaultRunSelection([], runs, false);
  assert.equal(selected.initialized, true);
  assert.equal(selected.ids.length, DEFAULT_SELECTED_RUNS);
  assert.equal(selected.ids[0], "run-0");
  assert.equal(selected.ids.at(-1), `run-${DEFAULT_SELECTED_RUNS - 1}`);
  assert.deepEqual(defaultRunSelection([], runs, true), { ids: [], initialized: true });
  assert.deepEqual(defaultRunSelection(["chosen"], runs, false), { ids: ["chosen"], initialized: false });
  const emptySelection = [];
  assert.equal(defaultRunSelection(emptySelection, [], false).ids, emptySelection);
});

test("shortcut helpers detect platform commands and editable targets", () => {
  assert.equal(platformModifierLabel("MacIntel"), "Cmd");
  assert.equal(platformModifierLabel("Linux x86_64"), "Ctrl");
  assert.equal(matchesShortcut({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, "quick-search", "MacIntel"), true);
  assert.equal(matchesShortcut({ key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, "quick-search", "Linux"), true);
  assert.equal(matchesShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, "undo", "MacIntel"), true);
  assert.equal(matchesShortcut({ key: "Z", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }, "redo", "MacIntel"), true);
  assert.equal(matchesShortcut({ key: "y", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, "redo", "Linux"), true);
  assert.equal(matchesShortcut({ key: ".", code: "Period", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, "runs-rail", "Linux"), true);
  assert.equal(matchesShortcut({ key: "j", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, "focus-workspace", "MacIntel"), true);
  assert.equal(matchesShortcut({ key: "x", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, "platform-mod", "MacIntel"), true);
  assert.equal(matchesShortcut({ key: "x", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, "unknown", "Linux"), false);
  assert.equal(matchesShortcut({ key: "?", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false }, "help", "MacIntel"), true);

  const textInput = {
    nodeType: 1,
    tagName: "INPUT",
    isContentEditable: false,
    getAttribute: () => "search",
    closest: () => null,
  };
  const checkbox = {
    nodeType: 1,
    tagName: "INPUT",
    isContentEditable: false,
    getAttribute: () => "checkbox",
    closest: () => null,
  };
  const contentEditable = {
    nodeType: 1,
    tagName: "DIV",
    isContentEditable: true,
    closest: () => null,
  };
  assert.equal(isEditableElement(textInput), true);
  assert.equal(isEditableElement(checkbox), false);
  assert.equal(isEditableElement(contentEditable), true);
});

test("redirect URL helpers allow only intended destinations", () => {
  assert.equal(safeSameOriginInviteUrl("/invite#t=abc", "https://app.instantml.ai"), "https://app.instantml.ai/invite#t=abc");
  assert.equal(safeSameOriginInviteUrl("https://app.instantml.ai/invite?x=1#t=abc", "https://app.instantml.ai"), "https://app.instantml.ai/invite?x=1#t=abc");
  assert.equal(safeSameOriginInviteUrl("https://evil.example/invite#t=abc", "https://app.instantml.ai"), "");
  assert.equal(safeSameOriginInviteUrl("/dashboard/runs#t=abc", "https://app.instantml.ai"), "");
  assert.equal(safeSameOriginInviteUrl("javascript:alert(1)", "https://app.instantml.ai"), "");

  assert.equal(safeStripeRedirectUrl("https://checkout.stripe.com/c/pay/cs_test"), "https://checkout.stripe.com/c/pay/cs_test");
  assert.equal(safeStripeRedirectUrl("https://billing.stripe.com/p/session/test"), "https://billing.stripe.com/p/session/test");
  assert.equal(safeStripeRedirectUrl("http://checkout.stripe.com/c/pay/cs_test"), "");
  assert.equal(safeStripeRedirectUrl("https://checkout.stripe.evil.example/c/pay/cs_test"), "");
  assert.equal(safeStripeRedirectUrl("javascript:alert(1)"), "");

  assert.equal(safeCheckoutRedirectUrl("/billing/return?session_id=cs_test_instantml__abc12345", "https://app.instantml.ai"), "https://app.instantml.ai/billing/return?session_id=cs_test_instantml__abc12345");
  assert.equal(safeCheckoutRedirectUrl("https://app.instantml.ai/billing/return?session_id=cs_live_12345678", "https://app.instantml.ai"), "https://app.instantml.ai/billing/return?session_id=cs_live_12345678");
  assert.equal(safeCheckoutRedirectUrl("/billing/return?session_id=bad", "https://app.instantml.ai"), "");
  assert.equal(safeCheckoutRedirectUrl("/billing/return?session_id=cs_test_12345678&next=//evil.example", "https://app.instantml.ai"), "");
  assert.equal(safeCheckoutRedirectUrl("/dashboard/settings?session_id=cs_test_12345678", "https://app.instantml.ai"), "");
});

test("summary helpers format stable UI values", () => {
  assert.deepEqual(metricKeysFromSummary({ metric_keys: ["b", "a", "a", "system/instantml/queued_events"] }), ["a", "b"]);
  assert.equal(isInternalInstantMlMetric("system/instantml/queued_events"), true);
  assert.equal(isInternalInstantMlMetric("train/system/instantml/queued_events"), false);
  assert.deepEqual(filterMetricKeys(["train/loss", "eval/return_mean", "train/reward", "system/instantml/queued_events"], "train/.*"), ["train/loss", "train/reward"]);
  assert.deepEqual(filterMetricKeys(["train/loss", "eval/return_mean"], "[bad"), []);
  assert.equal(metricFilterIsRegex("train/.*"), true);
  assert.equal(metricFilterIsRegex("[bad"), false);
  assert.equal(preferredMetricKey(["model/weight_norm", "val/r2", "train/loss"]), "val/r2");
  assert.equal(preferredMetricKey(["model/weight_norm", "test/accuracy", "val/r2"]), "test/accuracy");
  assert.equal(preferredMetricKey(["model/weight_norm"]), "model/weight_norm");
  assert.equal(preferredMetricKey([]), "");
  assert.equal(metricGoal("train/loss"), "minimize");
  assert.equal(metricGoal("val/error_rate"), "minimize");
  assert.equal(metricGoal("eval/return_mean"), "maximize");
  assert.equal(metricGoalLabel("train/loss"), "Lowest");
  assert.equal(bestMetric({ latest_metrics: { "eval/return_mean": 2 } }), 2);
  assert.equal(formatNumber(1234.567, 1), "1,234.6");
  assert.equal(statusTone("finished"), "good");
  assert.equal(statusTone("failed"), "bad");
  assert.equal(statusTone("running"), "live");
  assert.equal(durationLabel({ started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:02.000Z" }), "2s");
});

test("upload health derives compact state from SDK heartbeat metrics", () => {
  const at = 1_000;
  assert.deepEqual(uploadHealthForRun({ latest_metrics: {} }, at), { tone: "neutral", label: "upload unknown", state: "unknown" });
  assert.deepEqual(uploadHealthForRun({ latest_metrics: { "system/instantml/upload_health_unix_seconds": 990 } }, at), { tone: "good", label: "synced", state: "synced" });
  assert.deepEqual(
    uploadHealthForRun({ latest_metrics: { "system/instantml/upload_health_unix_seconds": 990, "system/instantml/queued_events": 12 } }, at),
    { tone: "live", label: "syncing 12", state: "syncing" },
  );
  assert.deepEqual(
    uploadHealthForRun({ latest_metrics: { "system/instantml/upload_health_unix_seconds": 990, "system/instantml/upload_lag_seconds": 9 } }, at),
    { tone: "live", label: "syncing", state: "syncing" },
  );
  assert.deepEqual(
    uploadHealthForRun({ latest_metrics: { "system/instantml/upload_health_unix_seconds": 900 } }, at),
    { tone: "neutral", label: "upload stale", state: "stale" },
  );
  assert.deepEqual(
    uploadHealthForRun({ latest_metrics: { "system/instantml/upload_health_unix_seconds": 990, "system/instantml/failed_events": 1 } }, at),
    { tone: "bad", label: "upload errors", state: "errors" },
  );
});

test("chart helpers normalize series and summarize last values", () => {
  const series = [{ id: "a", name: "run-a", points: [{ step: 0, value: 1, created_at: "2026-01-01T00:00:00.000Z" }, { step: 10, value: 3, created_at: "2026-01-01T00:00:01.000Z" }] }];
  const normalized = normalizeSeries(series, 100, 80);
  assert.match(normalized[0].path, /28\.00/);
  assert.equal(normalized[0].normalizedPoints.length, 2);
  assert.deepEqual(chartDomain(series), { minX: 0, maxX: 10, minY: 1, maxY: 3 });
  const zoomedSeries = [{
    id: "zoom",
    name: "zoomed",
    points: [
      { step: 0, value: 1 },
      { step: 10, value: 50 },
      { step: 20, value: 60 },
      { step: 30, value: 200 },
    ],
  }];
  assert.deepEqual(chartDomain(zoomedSeries, "step", "eval/return_mean", { min: 8, max: 22 }), { minX: 10, maxX: 20, minY: 50, maxY: 60 });
  const zoomedNormalized = normalizeSeries(zoomedSeries, 100, 80, 28, "step", "eval/return_mean", { min: 8, max: 22 });
  assert.deepEqual(zoomedNormalized[0].normalizedPoints.map((point) => point.step), [10, 20]);
  assert.deepEqual(axisTicks(0, 10, 3), [0, 5, 10]);
  assert.deepEqual(axisTicks(2, 2, 3), [2]);
  assert.deepEqual(axisTicks(Number.NaN, 10), []);
  assert.equal(formatAxisValue(10), "10");
  assert.match(formatAxisValue(new Date("2026-01-01T00:00:00.000Z").getTime(), "time"), /:/);
  assert.equal(formatAxisValue(null), "-");
  assert.equal(nearestPoint(normalized, normalized[0].normalizedPoints[0].x, normalized[0].normalizedPoints[0].y).runName, "run-a");
  assert.equal(nearestPoint(normalized, 50, 40, 1).runName, "run-a");
  assert.equal(nearestPoint(normalized, 999, 999), null);
  assert.deepEqual(svgPointFromClient({ left: 10, top: 20, width: 560, height: 360 }, 290, 200, 560, 640), { x: 280, y: 320 });
  assert.deepEqual(chartDomain([{ id: "acc", name: "accuracy", points: [{ step: 0, value: 0.52 }, { step: 1, value: 1 }] }], "step", "train/accuracy"), { minX: 0, maxX: 1, minY: 0, maxY: 1 });
  assert.deepEqual(chartDomain([{ id: "loss", name: "loss", points: [{ step: 0, value: 0.52 }, { step: 1, value: 1 }] }], "step", "train/loss"), { minX: 0, maxX: 1, minY: 0.52, maxY: 1 });
  assert.match(normalizeSeries([{ id: "acc", name: "accuracy", points: [{ step: 0, value: 0.5 }, { step: 1, value: 1 }] }], 100, 80, 28, "step", "train/accuracy")[0].path, /40\.00/);
  assert.match(normalizeSeries(series, 100, 80, 28, "time")[0].path, /28\.00/);
  assert.deepEqual(chartSummary(series), [{ id: "a", name: "run-a", last: 3 }]);
  assert.deepEqual(normalizeSeries([], 100, 80), []);
});

test("tiny-magnitude metrics fill the plot height instead of squishing to the floor", () => {
  // Three runs, three points, all values < 0.01. The fix removes the
  // Math.max(1, span) clamp that previously pinned these to the bottom.
  const series = [
    { id: "a", name: "a", points: [{ step: 0, value: 0.001 }, { step: 1, value: 0.005 }, { step: 2, value: 0.009 }] },
  ];
  const height = 80;
  const padding = 28;
  const normalized = normalizeSeries(series, 100, height, padding, "step", "train/loss");
  const ys = normalized[0].normalizedPoints.map((point) => point.y);
  // Min value maps to the bottom plot edge, max value to the top edge.
  assert.ok(Math.abs(ys[0] - (height - padding)) < 0.001, `min should sit on the floor, got ${ys[0]}`);
  assert.ok(Math.abs(ys[2] - padding) < 0.001, `max should reach the ceiling, got ${ys[2]}`);
  // The window uses the real (tiny) data range, not a clamped span of 1.
  assert.deepEqual(chartDomain(series, "step", "train/loss"), { minX: 0, maxX: 2, minY: 0.001, maxY: 0.009 });
});

test("a single / flat value opens a magnitude-relative window so the line is centered", () => {
  const flat = [{ id: "f", name: "f", points: [{ step: 5, value: 0.00004 }] }];
  const domain = chartDomain(flat, "step", "train/loss");
  assert.ok(domain.minY < 0.00004 && domain.maxY > 0.00004, "degenerate value should be padded");
  assert.equal(domain.minX < 5 && domain.maxX > 5, true, "single x value should be centered");
});

test("smoothSeries keeps raw values and attaches a smoothed value", () => {
  const series = [{ id: "s", name: "s", points: [{ step: 0, value: 0 }, { step: 1, value: 10 }, { step: 2, value: 0 }] }];
  const smoothed = smoothSeries(series, 50);
  assert.equal(smoothed[0].smoothed, true);
  // Raw values are preserved untouched.
  assert.deepEqual(smoothed[0].points.map((point) => point.value), [0, 10, 0]);
  // Smoothed values are a damped EMA that stays within the raw envelope.
  const sv = smoothed[0].points.map((point) => point.smoothedValue);
  assert.equal(sv[0], 0);
  assert.ok(sv[1] > 0 && sv[1] < 10);
  // factor 0 is a no-op (no smoothed flag).
  assert.equal(smoothSeries(series, 0)[0].smoothed, undefined);
  // Normalized output carries both raw and smoothed paths.
  const normalized = normalizeSeries(smoothed, 100, 80, 28, "step", "train/loss");
  assert.ok(normalized[0].smoothPath.length > 0);
  assert.ok(Number.isFinite(normalized[0].normalizedPoints[1].ySmoothed));
});

test("formatMetricValue gives up to 5 significant figures across magnitudes", () => {
  assert.equal(formatMetricValue(2.83702), "2.837");
  assert.equal(formatMetricValue(0.0001), "0.0001");
  assert.equal(formatMetricValue(0.00001234), "0.00001234");
  assert.equal(formatMetricValue(0), "0");
  assert.equal(formatMetricValue(12345.6), "12346");
  assert.equal(formatMetricValue(null), "-");
  assert.match(formatMetricValue(1.2e-9), /e-9$/);
});

test("formatAxisTick stays compact: scientific for tiny/huge, plain for mid-range", () => {
  assert.equal(formatAxisTick(0), "0");
  assert.equal(formatAxisTick(2.913), "2.913");
  assert.equal(formatAxisTick(0.25), "0.25");
  // below 1e-2 switches to trimmed scientific so labels clear the rotated axis
  // title (the hover tooltip keeps full decimal precision separately).
  assert.equal(formatAxisTick(0.005103), "5.1e-3");
  assert.equal(formatAxisTick(0.00899), "8.99e-3");
  assert.equal(formatAxisTick(0.0000366), "3.66e-5");
  assert.equal(formatAxisTick(0.0000155), "1.55e-5");
  assert.equal(formatAxisTick(150000), "1.5e5");
});

test("identifierForRun resolves name, notes and tags with fallbacks", () => {
  const run = { name: "run-42", tags: ["baseline", "v2"], metadata: { notes: "best so far" } };
  assert.equal(identifierForRun(run, "name"), "run-42");
  assert.equal(identifierForRun(run, "notes"), "best so far");
  assert.equal(identifierForRun(run, "tags"), "baseline, v2");
  assert.equal(identifierForRun({ name: "x", tags: [], metadata: {} }, "notes"), "x");
  assert.equal(identifierForRun({ name: "x", tags: [], metadata: {} }, "tags"), "x");
});

test("terminal helpers tokenize ansi safely and calculate virtual windows", () => {
  assert.deepEqual(ansiTokens("plain"), [{ text: "plain", className: "" }]);
  assert.deepEqual(ansiTokens("\u001b[31mred\u001b[0m ok"), [
    { text: "red", className: "ansi-fg-red" },
    { text: " ok", className: "" },
  ]);
  assert.deepEqual(terminalWindow(100, 56, 28, 84, 1), {
    start: 1,
    end: 6,
    offsetTop: 28,
    totalHeight: 2800,
  });
});

test("evidence helpers group and filter current artifact/object surfaces", () => {
  const checkpoint = { id: "a1", type: "checkpoint", name: "model.pt", uri: "s3://model", step: 12 };
  const file = { id: "a2", type: "file", name: "notes.json", uri: "s3://notes", step: null };
  const object = { id: 4, kind: "table", key: "eval/samples", metadata: { split: "eval" }, step: 2 };
  const sections = buildEvidenceSections({ artifacts: [checkpoint, file], objects: [object] });
  assert.deepEqual(sections.map((section) => [section.id, section.items.length]), [
    ["checkpoints", 1],
    ["objects", 1],
    ["files", 1],
  ]);
  assert.equal(firstEvidenceItem(sections).label, "model.pt");
  assert.equal(firstEvidenceItem([]), null);
  const filtered = buildEvidenceSections({ artifacts: [checkpoint, file], objects: [object], search: "samples" });
  assert.deepEqual(filtered.map((section) => section.items.length), [0, 1, 0]);
});

test("checkpoint resume helper copies a runnable project-scoped snippet", () => {
  const artifact = {
    id: "artifact-1",
    type: "checkpoint",
    name: "checkpoint step 12.json",
    step: 12,
    metadata: { checkpoint: { step: 12 } },
  };
  const run = {
    id: "run-1",
    project: "demo",
    name: "seed-44",
    config: { seed: 44, optimizer: { lr: 0.01 }, use_amp: false },
  };
  const code = buildCheckpointResumeCode(artifact, run, { baseUrl: "https://api.instantml.ai", apiKey: "instantml_test" });

  assert.match(code, /api = im\.Api\(base_url="https:\/\/api\.instantml\.ai", api_key="instantml_test"\)/);
  assert.match(code, /project="checkpoints"/);
  assert.match(code, /"resume_from_checkpoint":/);
  assert.match(code, /"checkpoint_id": "artifact-1"/);
  assert.match(code, /"source_run_id": "run-1"/);
  assert.match(code, /"checkpoint_step": 12/);
  assert.match(code, /"use_amp": False/);
  assert.match(code, /checkpoints\/checkpoint-step-12\.json/);
});

test("checkpoint resume helper handles fallback metadata and python literals", () => {
  const code = buildCheckpointResumeCode(
    {
      id: "artifact/2",
      type: "checkpoint",
      name: "",
      step: null,
      metadata: { checkpoint: { step: 9 } },
    },
    {
      id: "run-2",
      project: "demo",
      name: "fallback",
      config: {
        layers: [64, 32],
        empty: [],
        empty_obj: {},
        nullable: null,
        bad_number: Number.POSITIVE_INFINITY,
        omit_me: undefined,
        callback: () => "unused",
      },
    },
  );

  assert.match(code, /name="resume-from-fallback-step-9"/);
  assert.match(code, /"artifact\/2"/);
  assert.match(code, /"checkpoint_step": 9/);
  assert.match(code, /"layers": \[\n {12}64,\n {12}32,\n {8}\]/);
  assert.match(code, /"empty": \[\]/);
  assert.match(code, /"empty_obj": \{\}/);
  assert.match(code, /"nullable": None/);
  assert.match(code, /"bad_number": None/);
  assert.match(code, /"callback": "\(\) => \\"unused\\""/);
  assert.doesNotMatch(code, /omit_me/);

  const invalidMetadataCode = buildCheckpointResumeCode(
    { id: "artifact-3", type: "checkpoint", name: undefined, step: null, metadata: { checkpoint: [] } },
    { id: "run-3", project: "demo", name: "no-step", config: {} },
  );
  assert.match(invalidMetadataCode, /name="resume-from-no-step"/);
  assert.match(invalidMetadataCode, /checkpoints\/artifact-3\.ckpt/);
  assert.match(invalidMetadataCode, /"checkpoint_step": None/);
});

test("checkpoint fork helper builds same-project fork payloads", () => {
  const artifact = {
    id: "artifact-1",
    type: "checkpoint",
    name: "checkpoint step 12.json",
    step: null,
    metadata: { checkpoint: { step: 12 } },
  };
  const run = { id: "run-1", project: "demo", name: "seed-44" };

  assert.equal(defaultForkRunName(artifact, run), "fork-of-seed-44-step-12");
  assert.deepEqual(buildCheckpointForkBody(artifact, run, {
    inheritConfig: false,
    reason: "retry after nan",
    tags: ["retry"],
  }), {
    name: "fork-of-seed-44-step-12",
    checkpoint_artifact_id: "artifact-1",
    inherit_config: false,
    metadata: { reason: "retry after nan" },
    step: 12,
    tags: ["retry"],
  });
  const body = buildCheckpointForkBody(artifact, run, { inheritConfig: true, reason: "retry after nan" });
  const key = checkpointForkIdempotencyKey(artifact, run, body);
  assert.match(key, /^instantml-fork-[0-9a-f]{32}$/);
  assert.equal(key, checkpointForkIdempotencyKey(artifact, run, body));
  assert.notEqual(
    checkpointForkIdempotencyKey(artifact, run, body),
    checkpointForkIdempotencyKey(artifact, run, { ...body, name: "different retry" }),
  );
});

test("comparison helpers sort, aggregate, group, smooth, and average runs", () => {
  const runs = [
    {
      id: "a",
      name: "zed",
      status: "finished",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:10.000Z",
      tags: ["candidate"],
      config: { seed: 1, algo: "ppo" },
      latest_metrics: { reward: 2, "train/loss": 0.4 },
      metric_aggregates: { reward: { latest: 2, max: 5 }, "train/loss": { latest: 0.4, min: 0.2, max: 0.7 } },
    },
    {
      id: "b",
      name: "alpha",
      status: "failed",
      created_at: "2026-01-02T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      tags: ["baseline"],
      config: { seed: 2, algo: "sac" },
      latest_metrics: { reward: 7, "train/loss": 0.6 },
      metric_aggregates: { reward: { latest: 7, max: 7 }, "train/loss": { latest: 0.6, min: 0.6, max: 1.1 } },
    },
  ];
  assert.equal(metricAggregate(runs[0], "reward", "max"), 5);
  assert.equal(metricGoalValue({ metric_aggregates: { "train/loss": { min: 0.2, max: 2 } } }, "train/loss"), 0.2);
  assert.equal(metricGoalValue({ metric_aggregates: { "eval/return_mean": { min: 2, max: 9 } } }, "eval/return_mean"), 9);
  assert.deepEqual(sortRuns(runs, "name").map((run) => run.id), ["b", "a"]);
  assert.deepEqual(sortRuns(runs, "status").map((run) => run.id), ["b", "a"]);
  assert.deepEqual(sortRuns(runs, "metric-latest", "reward").map((run) => run.id), ["b", "a"]);
  assert.deepEqual(sortRuns(runs, "metric-best", "reward").map((run) => run.id), ["b", "a"]);
  assert.deepEqual(sortRuns(runs, "metric-best", "train/loss").map((run) => run.id), ["a", "b"]);
  assert.deepEqual(sortRuns(runs, "duration").map((run) => run.id), ["a", "b"]);
  assert.deepEqual(sortRuns(runs, "created").map((run) => run.id), ["b", "a"]);
  assert.equal(groupKeyForRun(runs[0], "seed"), "1");
  assert.equal(groupKeyForRun(runs[0], "tag"), "candidate");
  assert.equal(groupKeyForRun(runs[0], "config:algo"), "ppo");
  assert.equal(groupKeyForRun(runs[0], "none"), "all");

  const series = [
    { id: "a", name: "run-a", group: "g", points: [{ step: 0, value: 0, created_at: "2026-01-01T00:00:00.000Z" }, { step: 1, value: 10, created_at: "2026-01-01T00:00:10.000Z" }] },
    { id: "b", name: "run-b", group: "g", points: [{ step: 0, value: 2, created_at: "2026-01-01T00:00:02.000Z" }, { step: 1, value: 12, created_at: "2026-01-01T00:00:12.000Z" }] },
  ];
  // Smoothing is non-destructive now: raw value stays, EMA lands on smoothedValue.
  assert.equal(smoothSeries(series, 50)[0].points[1].value, 10);
  assert.equal(smoothSeries(series, 50)[0].points[1].smoothedValue, 5);
  assert.equal(smoothSeries(series, 0), series);
  assert.deepEqual(averageGroupedSeries(series)[0].points.map((point) => point.value), [1, 11]);
  assert.deepEqual(averageGroupedSeries(series)[0].points.map((point) => point.created_at), ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:11.000Z"]);
});

test("api client handles query strings and malformed responses", async (t) => {
  assert.equal(queryString({ a: 1, b: "", c: "x", d: null, e: undefined }), "?a=1&c=x");
  assert.equal(queryString({ a: "" }), "");
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError(new Error("plain")), false);
  assert.equal(isTransientApiError(new ApiError("temporary", { status: 500 })), true);
  assert.equal(isTransientApiError(new ApiError("rate limit", { status: 429 })), true);
  assert.equal(isTransientApiError(new ApiError("bad", { status: 400 })), false);
  const apiError = new ApiError("Safe message.", { code: "forbidden", requestId: "req_test", status: 403 });
  assert.equal(apiError.status, 403);
  assert.equal(apiError.code, "forbidden");
  assert.equal(apiError.requestId, "req_test");
  assert.match(apiError.message, /req_test/);
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;
  const originalApiLogs = process.env.NEXT_PUBLIC_INSTANTML_API_LOGS;
  const restoreApiTestGlobals = () => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
    console.info = originalInfo;
    if (originalApiLogs === undefined) {
      delete process.env.NEXT_PUBLIC_INSTANTML_API_LOGS;
    } else {
      process.env.NEXT_PUBLIC_INSTANTML_API_LOGS = originalApiLogs;
    }
  };
  t.after(restoreApiTestGlobals);
  const loggedApiEvents = [];
  console.warn = (label, event) => loggedApiEvents.push({ level: "warn", label, event });
  console.error = (label, event) => loggedApiEvents.push({ level: "error", label, event });
  console.info = (label, event) => loggedApiEvents.push({ level: "info", label, event });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, headers: new Headers({ "x-request-id": "srv_req" }), json: async () => ({ ok: true }) };
  };
  assert.deepEqual(await new ApiClient("/base").post("/runs", { a: 1 }, { headers: { "X-Test": "1" } }), { ok: true });
  assert.equal(calls[0].url, "/base/runs");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.get("X-Test"), "1");
  assert.match(calls[0].options.headers.get("x-request-id"), /^web-/);
  assert.deepEqual(await new ApiClient("/base").patch("/runs/run-1", { notes: "ready" }), { ok: true });
  assert.equal(calls[1].url, "/base/runs/run-1");
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(calls[1].options.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await new ApiClient("/base").put("/api/dashboard/preferences", { selected_project: "demo" }), { ok: true });
  assert.equal(calls[2].url, "/base/api/dashboard/preferences");
  assert.equal(calls[2].options.method, "PUT");
  assert.equal(calls[2].options.headers.get("Content-Type"), "application/json");
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "x-request-id": "srv_download", "content-disposition": "attachment; filename=\"runs.csv\"" }),
      blob: async () => new Blob(["record_type\n"]),
    };
  };
  const download = await new ApiClient("/base").download("/api/export?format=csv");
  assert.equal(calls[3].url, "/base/api/export?format=csv");
  assert.equal(calls[3].options.method, "GET");
  assert.match(calls[3].options.headers.get("x-request-id"), /^web-/);
  assert.equal(download.headers.get("content-disposition"), "attachment; filename=\"runs.csv\"");
  assert.equal(await download.blob.text(), "record_type\n");
  assert.equal(loggedApiEvents.some((event) => event.level === "info"), false);
  globalThis.fetch = async () => ({ ok: true, text: async () => "[]" });
  await assert.rejects(() => new ApiClient().get("/bad"), /malformed/);
  globalThis.fetch = async () => ({ ok: true, text: async () => "not json" });
  await assert.rejects(() => new ApiClient().get("/bad-json"), /invalid JSON/);
  globalThis.fetch = async () => ({ ok: false, status: 405, text: async () => "" });
  await assert.rejects(() => new ApiClient().get("/empty-error"), /Request failed/);
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "<html>oops</html>" });
  await assert.rejects(() => new ApiClient().get("/html-error"), /Server is unavailable/);
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ code: "validation_error", request_id: "req_1" }) });
  await assert.rejects(() => new ApiClient().get("/bad-request"), /Request was invalid.+req_1/);
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: new Headers({ "x-request-id": "user@example.com" }),
    json: async () => ({ error: "internal secret", request_id: "also unsafe" }),
  });
  await assert.rejects(() => new ApiClient().get("/api/reports/share/sensitive-token?debug=secret"), (error) => {
    assert(error instanceof ApiError);
    assert.match(error.requestId, /^web-/);
    return /do not have access/.test(error.message);
  });
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/reports/share/:share_token");
  assert.equal(loggedApiEvents.at(-1).event.path.includes("sensitive-token"), false);
  assert.equal(loggedApiEvents.at(-1).event.path.includes("debug"), false);
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    headers: new Headers({ "x-request-id": "instantml_live_secret" }),
    json: async () => ({ code: "validation_error" }),
  });
  await assert.rejects(() => new ApiClient().get("/api/orgs/name-availability?name=secret"), (error) => {
    assert(error instanceof ApiError);
    assert.match(error.requestId, /^web-/);
    return /Request was invalid/.test(error.message);
  });
  assert.equal(loggedApiEvents.at(-1).event.requestId.startsWith("instantml_live_"), false);
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/orgs/name-availability");
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    headers: new Headers({ "x-request-id": "sk_test_abc123" }),
    json: async () => ({ code: "service_unavailable" }),
  });
  await assert.rejects(() => new ApiClient().post("/api/storage/clickhouse-connections/validate", { endpoint: "secret" }), (error) => {
    assert(error instanceof ApiError);
    assert.match(error.requestId, /^web-/);
    return /InstantML API is starting/.test(error.message);
  });
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/storage/clickhouse-connections/validate");
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    headers: new Headers({ "x-request-id": "instantml_abc123" }),
    json: async () => ({}),
  });
  await assert.rejects(() => new ApiClient().get("/api/unknown/sk_test_short?secret=true"), (error) => {
    assert(error instanceof ApiError);
    assert.match(error.requestId, /^web-/);
    return /do not have access/.test(error.message);
  });
  assert.equal(loggedApiEvents.at(-1).event.requestId.startsWith("instantml_"), false);
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/unknown/:token");
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "Invalid run search: regex is invalid at column 6.", code: "run_search_invalid", field: "q", position: 6 }),
  });
  await assert.rejects(
    () => new ApiClient().get("/bad-search"),
    (error) => error instanceof ApiError
      && error.code === "run_search_invalid"
      && error.field === "q"
      && error.position === 6
      && /Invalid run search/.test(error.message),
  );
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ code: "warehouse_unavailable" }) });
  await assert.rejects(async () => {
    await new ApiClient().get("/warehouse");
  }, (error) => error instanceof ApiError
    && error.code === "warehouse_unavailable"
    && /Starting data warehouse/.test(error.message));
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ code: "service_unavailable" }) });
  await assert.rejects(() => new ApiClient().get("/starting"), /InstantML API is starting/);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => new ApiClient().get("/auth"), /Sign in required/);
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "internal secret" }) });
  await assert.rejects(() => new ApiClient().get("/forbidden"), /do not have access/);
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => new ApiClient().get("/missing"), /not found/);
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({}) });
  await assert.rejects(() => new ApiClient().get("/conflict"), /conflicted/);
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(() => new ApiClient().get("/rate-limit"), /Too many requests/);
  globalThis.fetch = async () => ({ ok: false, status: 418, json: async () => ({}) });
  await assert.rejects(() => new ApiClient().get("/unknown"), /Request failed/);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "nope" }) });
  await assert.rejects(() => new ApiClient().get("/nope"), /Server is unavailable/);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => new ApiClient().get("/nope"), /Server is unavailable/);
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(() => new ApiClient().get("/api/runs/summary?q=secret"), (error) => (
    error instanceof ApiError
      && error.code === "network_error"
      && error.status === 0
      && isTransientApiError(error)
  ));
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/runs/summary");
  await assert.rejects(() => new ApiClient().get("/api/unknown/a@b.co?token=secret"), /Network request failed/);
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/unknown/:token");
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const beforeAbortLogCount = loggedApiEvents.length;
  globalThis.fetch = async () => {
    throw abortError;
  };
  await assert.rejects(() => new ApiClient().get("/api/runs/summary"), (error) => error.name === "AbortError");
  assert.equal(loggedApiEvents.length, beforeAbortLogCount);
  process.env.NEXT_PUBLIC_INSTANTML_API_LOGS = "1";
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ "x-request-id": "srv_success" }), json: async () => ({ ok: true }) });
  await new ApiClient().get("/runs/run-secret/metrics?key=secret");
  assert.equal(loggedApiEvents.at(-1).level, "info");
  assert.equal(loggedApiEvents.at(-1).event.path, "/runs/:run_id/metrics");
  await new ApiClient().post("/api/imports/jobs/job-123/chunks", { content_hash: "secret" });
  assert.equal(loggedApiEvents.at(-1).event.path, "/api/imports/jobs/:job_id/chunks");
  restoreApiTestGlobals();
});

test("retryTransientRequest retries only recoverable API failures", async () => {
  let attempts = 0;
  const result = await retryTransientRequest(async () => {
    attempts += 1;
    if (attempts < 3) throw new ApiError("Server is unavailable.", { status: 503 });
    return { ok: true };
  }, { delays: [1, 1], sleep: () => Promise.resolve() });
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    () => retryTransientRequest(async () => {
      attempts += 1;
      throw new ApiError("Request was invalid.", { status: 400 });
    }, { delays: [1, 1], sleep: () => Promise.resolve() }),
    /Request was invalid/,
  );
  assert.equal(attempts, 1);
});

test("route helpers canonicalize dashboard paths and safe auth redirects", () => {
  assert.equal(DEFAULT_DASHBOARD_TAB, "runs");
  assert.equal(tabToPath("metrics"), "/dashboard/metrics");
  assert.equal(tabToPath("distributed"), "/dashboard/distributed");
  assert.equal(tabToPath("checkpoints"), "/dashboard/checkpoints");
  assert.equal(tabToPath("imports"), "/dashboard/imports");
  assert.equal(tabToPath("models"), "/dashboard/checkpoints");
  assert.equal(tabToPath("insights"), "/dashboard/insights");
  assert.equal(tabToPath("unknown"), "/dashboard/runs");
  assert.equal(tabFromPath("/dashboard/advanced?x=1"), "runs");
  assert.equal(tabFromPath("/dashboard/models?x=1"), "checkpoints");
  assert.equal(tabFromPath("/dashboard/integrations?x=1"), "runs");
  assert.equal(tabFromPath("/dashboard/imports?x=1"), "imports");
  assert.equal(tabFromPath("/dashboard/compare?x=1"), "compare");
  assert.equal(tabFromPath("/dashboard/reports/report_123"), "reports");
  assert.equal(tabFromPath("/dashboard/not-real"), "runs");
  assert.equal(canonicalDashboardPath("/dashboard"), "/dashboard/runs");
  assert.equal(canonicalDashboardPath("/dashboard/reports/report_123"), "/dashboard/reports/report_123");
  assert.equal(canonicalDashboardPath("/dashboard/models"), "/dashboard/checkpoints");
  assert.equal(canonicalDashboardPath("/dashboard/integrations"), "/dashboard/runs");
  assert.equal(canonicalDashboardPath("/dashboard/imports"), "/dashboard/imports");
  assert.equal(canonicalDashboardPath("/dashboard/metrics/extra"), "/dashboard/metrics");
  assert.equal(pathFromLegacyHash("#detail"), "/dashboard/detail");
  assert.equal(pathFromLegacyHash("#/detail"), "");
  assert.equal(sanitizeNextPath("/dashboard/metrics"), "/dashboard/metrics");
  assert.equal(sanitizeNextPath("/onboarding"), "/onboarding");
  assert.equal(sanitizeNextPath("/auth/device"), "/auth/device");
  assert.equal(sanitizeNextPath("/auth/device?code=ABCDEFGH"), "/auth/device?code=ABCD-EFGH");
  assert.equal(sanitizeNextPath("/auth/device?code=ABCD-EFGH"), "/auth/device?code=ABCD-EFGH");
  assert.equal(sanitizeNextPath("/"), "/");
  assert.equal(sanitizeNextPath("https://evil.example/dashboard"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("//evil.example/dashboard"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/signin"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/auth/logout"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/auth/device?code=ABCD-EFGH&next=/dashboard"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/auth/device?code=<script>"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/dashboard/runs\u0000"), "/dashboard/runs");
  assert.equal(normalizeDeviceUserCode("abcdefgh"), "ABCD-EFGH");
  assert.equal(normalizeDeviceUserCode("ABCD-EFGH"), "ABCD-EFGH");
  assert.equal(normalizeDeviceUserCode("A-BCDEFGH"), "");
  assert.equal(normalizeDeviceUserCode("abc<script>"), "");
});

test("post-auth redirects keep unready storage in onboarding", () => {
  const readySession = {
    authenticated: true,
    organization: {
      id: "org-ready",
      storage_choice: "customer-clickhouse",
      storage_state: "storage_ready",
    },
  };
  const lockedSession = {
    authenticated: true,
    organization: {
      id: "org-locked",
      storage_choice: "customer-clickhouse",
      storage_state: "storage_locked",
    },
  };
  const validatingSession = {
    authenticated: true,
    organization: {
      id: "org-validating",
      storage_choice: "customer-clickhouse",
      storage_state: "storage_validating",
    },
  };
  const unconfiguredHostedSession = {
    authenticated: true,
    organization: {
      id: "org-hosted",
      storage_choice: "instantml-hosted",
      storage_state: "storage_unconfigured",
    },
  };
  const legacyHostedSession = {
    authenticated: true,
    organization: {
      id: "org-legacy",
      storage_choice: "instantml-hosted",
    },
  };
  const emptyStateHostedSession = {
    authenticated: true,
    organization: {
      id: "org-empty",
      storage_choice: "instantml-hosted",
      storage_state: "",
    },
  };
  const legacyByocSession = {
    authenticated: true,
    organization: {
      id: "org-byoc",
      storage_choice: "customer-clickhouse",
    },
  };

  assert.equal(isStorageReadyState("storage_ready"), true);
  assert.equal(isStorageReadyState("storage_locked"), true);
  assert.equal(isStorageReadyState("storage_validating"), false);
  assert.equal(sessionRequiresStorageOnboarding(readySession), false);
  assert.equal(sessionRequiresStorageOnboarding(lockedSession), false);
  assert.equal(sessionRequiresStorageOnboarding(validatingSession), true);
  assert.equal(sessionRequiresStorageOnboarding(unconfiguredHostedSession), true);
  assert.equal(sessionRequiresStorageOnboarding(legacyHostedSession), false);
  assert.equal(sessionRequiresStorageOnboarding(emptyStateHostedSession), true);
  assert.equal(sessionRequiresStorageOnboarding(legacyByocSession), true);
  assert.equal(postAuthRedirectPath(readySession, "/dashboard/settings"), "/dashboard/settings");
  assert.equal(postAuthRedirectPath(lockedSession, "/dashboard/runs"), "/dashboard/runs");
  assert.equal(onboardingRedirectPath("/dashboard/settings"), "/onboarding?next=%2Fdashboard%2Fsettings");
  assert.equal(onboardingRedirectPath("/onboarding"), "/onboarding");
  assert.equal(postAuthRedirectPath(validatingSession, "/dashboard/runs"), "/onboarding?next=%2Fdashboard%2Fruns");
  assert.equal(postAuthRedirectPath(unconfiguredHostedSession, "/dashboard/runs"), "/onboarding?next=%2Fdashboard%2Fruns");
  assert.equal(postAuthRedirectPath(legacyHostedSession, "/dashboard/runs"), "/dashboard/runs");
  assert.equal(postAuthRedirectPath(emptyStateHostedSession, "/dashboard/runs"), "/onboarding?next=%2Fdashboard%2Fruns");
  assert.equal(postAuthRedirectPath(legacyByocSession, "/dashboard/runs"), "/onboarding?next=%2Fdashboard%2Fruns");
  assert.equal(postAuthRedirectPath({ authenticated: false }, "/dashboard/runs"), "/dashboard/runs");
  assert.equal(postAuthRedirectPath(readySession, "https://evil.example/dashboard"), "/dashboard/runs");
});

test("deriveClerkSlug derives workspace slug from display name", () => {
  // Display name preferred over email handle.
  assert.equal(deriveClerkSlug("Tony Xin", "tony@example.com"), "tony-xin");
  assert.equal(deriveClerkSlug("Ada Lovelace!", "ada@example.com"), "ada-lovelace");
  // Multiple spaces/specials collapse.
  assert.equal(deriveClerkSlug("  My Research  Lab  ", "user@example.com"), "my-research-lab");
});

test("deriveClerkSlug falls back to email handle when display name is blank", () => {
  assert.equal(deriveClerkSlug("", "ada@example.com"), "ada");
  assert.equal(deriveClerkSlug("   ", "researcher@lab.ai"), "researcher");
});

test("slugify matches server-side rules", () => {
  assert.equal(slugify("Tony Xin"), "tony-xin");
  assert.equal(slugify("!!!"), "workspace");
  assert.equal(slugify("  My Fancy Workspace! "), "my-fancy-workspace");
  // Long strings are clamped to 63 characters.
  assert.equal(slugify("a".repeat(100)).length, 63);
});
