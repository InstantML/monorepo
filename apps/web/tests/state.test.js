import assert from "node:assert/strict";
import test from "node:test";

import { averageGroupedSeries, axisTicks, chartDomain, chartSummary, formatAxisValue, nearestPoint, normalizeSeries, smoothSeries, svgPointFromClient } from "../src/charts.js";
import { buildEvidenceSections, firstEvidenceItem } from "../src/evidence.js";
import {
  MAX_SELECTED_RUNS,
  bestMetric,
  capSelectionToMatching,
  deselectVisible,
  durationLabel,
  filterMetricKeys,
  formatNumber,
  groupKeyForRun,
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
  visibleSelectionState,
} from "../src/state.js";
import { ApiClient, ApiError, isAbortError, queryString } from "../src/api.js";
import { canonicalDashboardPath, pathFromLegacyHash, sanitizeNextPath, tabFromPath, tabToPath } from "../src/routes.js";
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

test("capSelectionToMatching truncates at MAX_SELECTED_RUNS", () => {
  const ids = Array.from({ length: MAX_SELECTED_RUNS + 17 }, (_, index) => `id-${index}`);
  const capped = capSelectionToMatching(ids);
  assert.equal(capped.length, MAX_SELECTED_RUNS);
  assert.equal(capped[0], "id-0");
  assert.equal(capped.at(-1), `id-${MAX_SELECTED_RUNS - 1}`);
  assert.deepEqual(capSelectionToMatching(null), []);
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

test("summary helpers format stable UI values", () => {
  assert.deepEqual(metricKeysFromSummary({ metric_keys: ["b", "a", "a"] }), ["a", "b"]);
  assert.deepEqual(filterMetricKeys(["train/loss", "eval/return_mean", "train/reward"], "train/.*"), ["train/loss", "train/reward"]);
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
  assert.equal(nearestPoint(normalized, 999, 999), null);
  assert.deepEqual(svgPointFromClient({ left: 10, top: 20, width: 560, height: 360 }, 290, 200, 560, 640), { x: 280, y: 320 });
  assert.deepEqual(chartDomain([{ id: "acc", name: "accuracy", points: [{ step: 0, value: 0.52 }, { step: 1, value: 1 }] }], "step", "train/accuracy"), { minX: 0, maxX: 1, minY: 0, maxY: 1 });
  assert.deepEqual(chartDomain([{ id: "loss", name: "loss", points: [{ step: 0, value: 0.52 }, { step: 1, value: 1 }] }], "step", "train/loss"), { minX: 0, maxX: 1, minY: 0.52, maxY: 1 });
  assert.match(normalizeSeries([{ id: "acc", name: "accuracy", points: [{ step: 0, value: 0.5 }, { step: 1, value: 1 }] }], 100, 80, 28, "step", "train/accuracy")[0].path, /40\.00/);
  assert.match(normalizeSeries(series, 100, 80, 28, "time")[0].path, /28\.00/);
  assert.deepEqual(chartSummary(series), [{ id: "a", name: "run-a", last: 3 }]);
  assert.deepEqual(normalizeSeries([], 100, 80), []);
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
  assert.equal(smoothSeries(series, 50)[0].points[1].value, 5);
  assert.equal(smoothSeries(series, 0), series);
  assert.deepEqual(averageGroupedSeries(series)[0].points.map((point) => point.value), [1, 11]);
  assert.deepEqual(averageGroupedSeries(series)[0].points.map((point) => point.created_at), ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:11.000Z"]);
});

test("api client handles query strings and malformed responses", async () => {
  assert.equal(queryString({ a: 1, b: "", c: "x", d: null, e: undefined }), "?a=1&c=x");
  assert.equal(queryString({ a: "" }), "");
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError(new Error("plain")), false);
  const apiError = new ApiError("Safe message.", { code: "forbidden", requestId: "req_test", status: 403 });
  assert.equal(apiError.status, 403);
  assert.equal(apiError.code, "forbidden");
  assert.equal(apiError.requestId, "req_test");
  assert.match(apiError.message, /req_test/);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  assert.deepEqual(await new ApiClient("/base").post("/runs", { a: 1 }, { headers: { "X-Test": "1" } }), { ok: true });
  assert.equal(calls[0].url, "/base/runs");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Test"], "1");
  assert.deepEqual(await new ApiClient("/base").patch("/runs/run-1", { notes: "ready" }), { ok: true });
  assert.equal(calls[1].url, "/base/runs/run-1");
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
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
  globalThis.fetch = originalFetch;
});

test("route helpers canonicalize dashboard paths and safe auth redirects", () => {
  assert.equal(tabToPath("metrics"), "/dashboard/metrics");
  assert.equal(tabToPath("unknown"), "/dashboard/runs");
  assert.equal(tabFromPath("/dashboard/compare?x=1"), "compare");
  assert.equal(tabFromPath("/dashboard/not-real"), "runs");
  assert.equal(canonicalDashboardPath("/dashboard"), "/dashboard/runs");
  assert.equal(pathFromLegacyHash("#detail"), "/dashboard/detail");
  assert.equal(pathFromLegacyHash("#/detail"), "");
  assert.equal(sanitizeNextPath("/dashboard/metrics"), "/dashboard/metrics");
  assert.equal(sanitizeNextPath("/onboarding"), "/onboarding");
  assert.equal(sanitizeNextPath("/"), "/");
  assert.equal(sanitizeNextPath("https://evil.example/dashboard"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("//evil.example/dashboard"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/signin"), "/dashboard/runs");
  assert.equal(sanitizeNextPath("/dashboard/runs\u0000"), "/dashboard/runs");
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
