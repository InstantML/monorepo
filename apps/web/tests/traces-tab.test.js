import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DASHBOARD_TAB_IDS, tabFromPath, tabToPath } from "../src/routes.js";

const configSource = readFileSync(new URL("../app/dashboard-config.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../app/dashboard/dashboard-shell.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("../app/dashboard/detail/tab-pane.tsx", import.meta.url), "utf8");
const paneSource = readFileSync(new URL("../app/dashboard/traces/tab-pane.tsx", import.meta.url), "utf8");
const timelineSource = readFileSync(new URL("../app/dashboard/detail/trace-timeline.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/styles/traces.css", import.meta.url), "utf8");
const runDetailStyles = readFileSync(new URL("../app/styles/run-detail.css", import.meta.url), "utf8");

test("traces is a first-class dashboard route and nav item", () => {
  assert.ok(DASHBOARD_TAB_IDS.includes("traces"));
  assert.equal(tabFromPath("/dashboard/traces"), "traces");
  assert.equal(tabToPath("traces"), "/dashboard/traces");
  assert.match(configSource, /id: "traces", label: "Traces"/);
  assert.match(shellSource, /<TracesTabPane/);
  assert.match(shellSource, /visibleTab === "traces"/);
});

test("traces tab uses bounded list, detail, and child endpoints", () => {
  assert.match(paneSource, /\/api\/traces/);
  assert.match(paneSource, /\/api\/runs\/\$\{encodeURIComponent\(selectedRunId\)\}\/traces\/\$\{encodeURIComponent\(selectedTraceId\)\}/);
  assert.match(paneSource, /\/spans\$\{queryString/);
  assert.match(paneSource, /TRACE_PAGE_LIMIT = 50/);
  assert.match(paneSource, /TRACE_SPAN_LIMIT = 500/);
  assert.match(paneSource, /TRACE_CHILD_LIMIT = 100/);
  assert.match(paneSource, /listRequestRef/);
  assert.match(paneSource, /useDebouncedValue\(query, 300\)/);
  assert.match(paneSource, /urlStateReady/);
  assert.match(paneSource, /if \(!urlStateReady\) \{/);
  assert.match(paneSource, /traceIdForActions/);
  assert.match(paneSource, /setDetail\(null\);/);
  assert.match(paneSource, /detail\?\.trace\.run_id === selectedRunId && detail\.trace\.trace_id === selectedTraceId/);
  assert.match(paneSource, /function traceListQueryParams/);
  assert.match(paneSource, /const scopedRunId = runFilter \|\| undefined/);
  assert.match(paneSource, /project: scopedRunId \? undefined : project/);
  assert.match(paneSource, /run_id: scopedRunId/);
  assert.doesNotMatch(paneSource, /from:/);
  assert.doesNotMatch(paneSource, /to:/);
});

test("traces tab exposes tree, inspector, status, and responsive styles", () => {
  assert.match(styles, /\.traces-workspace/);
  assert.match(styles, /\.trace-table/);
  assert.match(styles, /\.trace-node-button/);
  assert.match(styles, /\.trace-inspector/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(paneSource, /<CustomSelect/);
  assert.match(paneSource, /role="listbox"/);
  assert.match(paneSource, /role="option"/);
  assert.match(paneSource, /aria-selected=/);
  assert.match(paneSource, /outside the loaded tree window/);
  assert.match(paneSource, /summary=\{inspectorSummary\}/);
  assert.match(paneSource, /selectedDetail \? indexDisplayedSpans\(selectedDetail\.spans, childrenByParent\)/);
  assert.doesNotMatch(paneSource, /\?\? all\[0\]/);
  assert.doesNotMatch(paneSource, /role="table"/);
  assert.doesNotMatch(styles, /border-radius:\s*8px/);
  assert.doesNotMatch(styles, /font-size:\s*11px/);
  assert.doesNotMatch(styles, /font-size:\s*12px/);
});

test("run detail exposes recent traces lazily with exact deep links", () => {
  assert.match(detailSource, /id: "traces", label: "Traces"/);
  assert.match(detailSource, /runWorkspaceTab !== "traces"/);
  assert.match(detailSource, /\/api\/traces\$\{queryString\(runTraceListQuery\(run, selectedTraceStep\)\)\}/);
  assert.match(detailSource, /run_id: run\.id/);
  assert.match(detailSource, /limit: RECENT_TRACE_LIMIT/);
  assert.doesNotMatch(detailSource, /params\.from\s*=/);
  assert.doesNotMatch(detailSource, /params\.to\s*=/);
  assert.match(detailSource, /\/dashboard\/traces\$\{queryString\(\{/);
  assert.match(detailSource, /span_id: trace\.root_span_id \|\| undefined/);
  assert.match(runDetailStyles, /\.pd-trace-row/);
  assert.match(runDetailStyles, /grid-template-columns: 84px minmax\(0, 1fr\) 82px 78px 132px/);
});

test("run detail correlates traces with metrics on a shared step timeline", () => {
  // The timeline component exists and draws the metric line + activity lane.
  assert.match(timelineSource, /export function TraceMetricTimeline/);
  assert.match(timelineSource, /normalizeSeries/);
  assert.match(timelineSource, /yMapper/);
  // The metric line carries the run's identity color, matching Overview/Metrics.
  assert.match(timelineSource, /chartColor\(stableChartIndex\(series\[0\]\?\.id \?\? runName\)\)/);
  // Markers encode trace health via tonal classes; the semantic color tokens
  // live in run-detail.css so both themes resolve automatically.
  assert.match(timelineSource, /function markerTone\(bucket: StepBucket\)/);
  assert.match(timelineSource, /return "err";[\s\S]*?return "run";[\s\S]*?return "ok";/);
  assert.match(runDetailStyles, /\.pd-trace-marker\.err\s*\{[^}]*var\(--danger\)/);
  assert.match(runDetailStyles, /\.pd-trace-marker\.ok\s*\{[^}]*var\(--accent\)/);
  assert.match(runDetailStyles, /\.pd-trace-marker\.run\s*\{[^}]*var\(--muted\)/);
  // Contiguous error steps get a full-height danger wash band.
  assert.match(timelineSource, /pd-trace-error-band/);
  assert.match(runDetailStyles, /\.pd-trace-error-band\s*\{[^}]*var\(--danger\)/);
  // Marker motion respects prefers-reduced-motion.
  assert.match(runDetailStyles, /prefers-reduced-motion: reduce\)\s*\{\s*\.pd-trace-marker/);
  // Clickable, keyboard-operable markers with aria state.
  assert.match(timelineSource, /pd-trace-marker-btn/);
  assert.match(timelineSource, /aria-pressed=\{selectedStep === bucket\.step\}/);
  assert.match(timelineSource, /onStepSelect\(selectedStepRef\.current === step \? null : step\)/);
  // Hover derives from the anchor step at render, so poll refreshes can't
  // strand a stale tooltip; mousemove hit-testing is rAF-coalesced.
  assert.match(timelineSource, /const \[hoverStep, setHoverStep\] = useState<number \| null>\(null\)/);
  assert.match(timelineSource, /requestAnimationFrame/);
  // Marker/button layers are memoized so hover churn doesn't redraw them.
  assert.match(timelineSource, /const markersLayer = useMemo/);
  assert.match(timelineSource, /const buttonsLayer = useMemo/);
  // Series failures caption honestly and are retried, never cached.
  assert.match(timelineSource, /Couldn't load/);
  assert.match(detailSource, /setTraceSeriesError/);
  // Manual refresh for finished runs.
  assert.match(timelineSource, /aria-label="Refresh trace activity"/);
  assert.match(detailSource, /setTraceRefreshKey\(\(key\) => key \+ 1\)/);

  // The timeline is imported and rendered only inside the traces tab.
  assert.match(detailSource, /import \{ TraceMetricTimeline \}/);
  assert.match(detailSource, /runWorkspaceTab === "traces" \?/);
  assert.match(detailSource, /<TraceMetricTimeline/);

  // Lazy, abortable, run-scoped steps fetch mirroring the recent-traces effect.
  assert.match(detailSource, /\/api\/runs\/\$\{runId\}\/traces\/steps/);
  assert.match(detailSource, /new AbortController\(\)/);
  assert.match(detailSource, /isAbortError/);
  assert.match(detailSource, /retryTransientRequest/);
  assert.match(detailSource, /setTraceSteps\(null\)/);

  // Step selection threads min_step/max_step into the list query and refetches.
  assert.match(detailSource, /min_step: step, max_step: step/);
  // The list and step effects participate in the live-run poll cadence.
  assert.match(detailSource, /runWorkspaceTab, selectedTraceStep, traceRefreshKey, tracesPollTick\]/);
  assert.match(detailSource, /runWorkspaceTab, traceRefreshKey, tracesPollTick\]/);
  assert.match(detailSource, /const tracesPollTick = liveRun \? liveTick : 0;/);
  assert.match(detailSource, /selectedStep=\{selectedTraceStep\}/);
  assert.match(detailSource, /onStepSelect=\{setSelectedTraceStep\}/);

  // Styles: new timeline classes exist, tokens only (no raw px font sizes).
  const timelineCss = runDetailStyles.slice(runDetailStyles.indexOf("Trace × metric correlation timeline"));
  assert.ok(timelineCss.length > 0, "timeline CSS block present");
  assert.match(timelineCss, /\.pd-trace-timeline-frame/);
  assert.match(timelineCss, /\.pd-trace-marker-btn/);
  assert.match(timelineCss, /\.pd-trace-filter-chip/);
  assert.doesNotMatch(timelineCss, /font-size:\s*\d/);
});
