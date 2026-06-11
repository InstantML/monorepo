import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

// AL1 — identical per-run warnings collapse into grouped rows.
test("alert rows dedupe same-kind warnings into grouped findings", () => {
  const modelsSrc = read("app/dashboard-models.ts");
  assert.match(modelsSrc, /export function dedupeAlertRows/);
  assert.match(modelsSrc, /runs have no checkpoints/);
  assert.match(modelsSrc, /return dedupeAlertRows\(rows\)\.slice\(0, 20\)/);
  const alertsSrc = read("app/dashboard/alerts/tab-pane.tsx");
  assert.match(alertsSrc, /title="Run health"/);
  assert.doesNotMatch(alertsSrc, /emphasis="worth watching"/);
});

// Section 3 — selection tray renders only with a selection and derives
// everything from the shell's selection state.
test("selection tray is selection-driven chrome with compare/export/clear", () => {
  const traySrc = read("app/dashboard/chrome/selection-tray.tsx");
  assert.match(traySrc, /if \(count <= 0\) return null/);
  assert.match(traySrc, /Compare/);
  assert.match(traySrc, /Export CSV/);
  assert.match(traySrc, /Clear/);
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  assert.match(shellSrc, /<SelectionTray/);
  assert.match(shellSrc, /onExport=\{exportSelectedRunsCsv\}/);
  const css = read("app/styles/overhaul.css");
  assert.match(css, /\.selection-tray \{/);
});

// Section 3 — number keys jump tabs, guarded against editable elements (the
// guard lives above in the handler via isEditableElement early-return).
test("number-key tab navigation exists and respects rail order", () => {
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  assert.match(shellSrc, /\/\^\[1-9\]\$\/\.test\(event\.key\)/);
  assert.match(shellSrc, /tabs\[Number\(event\.key\) - 1\]/);
  const handlerStart = shellSrc.indexOf("globalKeyHandlerRef.current = (event");
  const editableGuard = shellSrc.indexOf("if (isEditableElement(event.target)) return;", handlerStart);
  const numberBranch = shellSrc.indexOf("/^[1-9]$/", handlerStart);
  assert.ok(editableGuard > -1 && numberBranch > editableGuard, "editable-element guard must run before number-key navigation");
});

// Section 3 — nav regroup: rarely-daily tabs live under "More"; ids unchanged.
test("nav groups demote adoption tabs under More without changing ids", () => {
  const configSrc = read("app/dashboard-config.tsx");
  assert.match(configSrc, /id: "more"/);
  assert.match(configSrc, /id: "alerts", label: "Run health"/);
  for (const id of ["runs", "metrics", "distributed", "compare", "insights", "artifacts", "reports", "alerts", "datasets", "imports", "checkpoints", "settings", "api"]) {
    assert.match(configSrc, new RegExp(`id: "${id}"`), `tab id ${id} must survive the regroup`);
  }
});

// R1 — the runs table is mounted behind a panels/table view toggle.
test("runs tab offers a persisted panels/table view toggle", () => {
  const paneSrc = read("app/dashboard/runs/tab-pane.tsx");
  assert.match(paneSrc, /runs-view-toggle/);
  assert.match(paneSrc, /<RunsTable/);
  assert.match(paneSrc, /instantml:next:runs-view/);
  assert.match(paneSrc, /aria-pressed=\{runsView === "table"\}/);
});

// C4 — compare artifact strips group duplicate filenames into version chips.
test("compare artifact strip groups versions by name", () => {
  const src = read("app/dashboard/compare/side-by-side.tsx");
  assert.match(src, /export function groupCompareArtifacts/);
  assert.match(src, /versions/);
  assert.match(src, /cmp-table-shell/);
});

// V2 — the italic-serif flourish stays on the Runs workspace header only.
test("serif flourishes are limited to the runs workspace header", () => {
  const flourishFiles = [
    "app/dashboard/alerts/tab-pane.tsx",
    "app/dashboard/api/tab-pane.tsx",
    "app/dashboard/artifacts/tab-pane.tsx",
    "app/dashboard/checkpoints/tab-pane.tsx",
    "app/dashboard/compare/tab-pane.tsx",
    "app/dashboard/datasets/tab-pane.tsx",
    "app/dashboard/distributed/tab-pane.tsx",
    "app/dashboard/insights/tab-pane.tsx",
    "app/dashboard/metrics/tab-pane.tsx",
    "app/dashboard/reports/reports-tab-pane.tsx",
    "app/dashboard/settings/tab-pane.tsx",
  ];
  for (const file of flourishFiles) {
    const src = read(file);
    assert.doesNotMatch(src, /serif-em|emphasis=/, `${file} must not use the serif flourish`);
  }
  assert.match(read("app/dashboard/runs/tab-pane.tsx"), /emphasis/);
});

// ST1 — settings no longer echoes transient filter/selection state.
test("settings drops the debug state echo", () => {
  const src = read("app/dashboard/settings/tab-pane.tsx");
  assert.doesNotMatch(src, /API route mode/);
  assert.doesNotMatch(src, /label="Selected runs"/);
});

// T1 — theme toggle is reachable from the account menu.
test("account menu exposes the theme toggle", () => {
  const src = read("app/dashboard/chrome/topbar.tsx");
  assert.match(src, /Switch to light theme/);
  assert.match(src, /onToggleTheme/);
});

// AP1/S3 — API key revocation confirms before the irreversible call.
test("api key revoke asks for confirmation", () => {
  const src = read("app/dashboard/dashboard-shell.tsx");
  assert.match(src, /window\.confirm\("Revoke this API key\?/);
});

// DS3/DS5 — heatmap uses the colorblind-safe ramp; z-scores read by magnitude.
test("distributed visuals avoid red/green-only and signed z coloring", () => {
  const src = read("app/dashboard/distributed/tab-pane.tsx");
  assert.match(src, /var\(--amber\)" : "var\(--blue\)/);
  assert.match(src, /z-mag/);
  const css = read("app/styles/research.css");
  assert.match(css, /var\(--blue\), var\(--surface-2\), var\(--amber\)/);
});
