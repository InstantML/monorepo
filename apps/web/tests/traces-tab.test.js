import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DASHBOARD_TAB_IDS, tabFromPath, tabToPath } from "../src/routes.js";

const configSource = readFileSync(new URL("../app/dashboard-config.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("../app/dashboard/dashboard-shell.tsx", import.meta.url), "utf8");
const paneSource = readFileSync(new URL("../app/dashboard/traces/tab-pane.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/styles/traces.css", import.meta.url), "utf8");

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
});

test("traces tab exposes tree, inspector, status, and responsive styles", () => {
  assert.match(styles, /\.traces-workspace/);
  assert.match(styles, /\.trace-table/);
  assert.match(styles, /\.trace-node-button/);
  assert.match(styles, /\.trace-inspector/);
  assert.match(styles, /@media \(max-width: 720px\)/);
});
