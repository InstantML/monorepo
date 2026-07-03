import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DASHBOARD_TAB_IDS, tabFromPath, tabToPath } from "../src/routes.js";

const configSource = readFileSync(new URL("../app/dashboard-config.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../app/dashboard/dashboard-shell.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("../app/dashboard/detail/tab-pane.tsx", import.meta.url), "utf8");
const paneSource = readFileSync(new URL("../app/dashboard/traces/tab-pane.tsx", import.meta.url), "utf8");
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
  assert.match(detailSource, /\/api\/traces\$\{queryString\(runTraceListQuery\(run\)\)\}/);
  assert.match(detailSource, /run_id: run\.id/);
  assert.match(detailSource, /limit: RECENT_TRACE_LIMIT/);
  assert.doesNotMatch(detailSource, /params\.from\s*=/);
  assert.doesNotMatch(detailSource, /params\.to\s*=/);
  assert.match(detailSource, /\/dashboard\/traces\$\{queryString\(\{/);
  assert.match(detailSource, /span_id: trace\.root_span_id \|\| undefined/);
  assert.match(runDetailStyles, /\.pd-trace-row/);
  assert.match(runDetailStyles, /grid-template-columns: 84px minmax\(0, 1fr\) 82px 78px 132px/);
});
