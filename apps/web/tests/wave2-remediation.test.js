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

// Mockup parity (2026-06): nav regrouped to OPERATE / DATA / SYSTEM; ids
// unchanged so routes/deep-links survive. The Overview landing tab was later
// removed (OPERATE now leads with Runs), so it must be absent from the config.
test("nav groups follow the OPERATE/DATA/SYSTEM mockup without changing ids", () => {
  const configSrc = read("app/dashboard-config.tsx");
  assert.match(configSrc, /id: "operate"/);
  assert.match(configSrc, /id: "data"/);
  assert.match(configSrc, /id: "system"/);
  assert.doesNotMatch(configSrc, /id: "overview"/);
  assert.match(configSrc, /id: "alerts", label: "Run Health"/);
  for (const id of ["runs", "metrics", "distributed", "compare", "insights", "artifacts", "reports", "alerts", "datasets", "settings", "api"]) {
    assert.match(configSrc, new RegExp(`id: "${id}"`), `tab id ${id} must survive the regroup`);
  }
  // CK2: the Checkpoints tab merged into Run Detail; its nav slot is gone but
  // old /dashboard/checkpoints (and /dashboard/models) links canonicalize.
  assert.doesNotMatch(configSrc, /id: "checkpoints"/);
  const routesSrc = read("src/routes.js");
  assert.match(routesSrc, /\["checkpoints", "detail"\]/);
  assert.match(routesSrc, /\["models", "detail"\]/);
  const runDetailSrc = read("app/dashboard/detail/run-detail.tsx");
  assert.match(runDetailSrc, /checkpoint-uri/);
  assert.match(runDetailSrc, /eval_return/);
});

// R1 — the runs table is mounted behind a panels/table view toggle.
test("runs tab offers a persisted panels/table view toggle", () => {
  const paneSrc = read("app/dashboard/runs/tab-pane.tsx");
  const commandbarSrc = read("app/dashboard/runs/runs-commandbar.tsx");
  assert.match(commandbarSrc, /runs-view-switch/);
  assert.match(paneSrc, /<RunsTable/);
  assert.match(paneSrc, /instantml:next:runs-view/);
  assert.match(commandbarSrc, /aria-pressed=\{viewMode === "table"\}/);
});

// C4 — compare artifact strips group duplicate filenames into version chips.
test("compare artifact strip groups versions by name", () => {
  const src = read("app/dashboard/compare/side-by-side.tsx");
  assert.match(src, /export function groupCompareArtifacts/);
  assert.match(src, /versions/);
  assert.match(src, /cmp-table-shell/);
});

// V2 — superseded by main's header simplification (#189): the serif flourish
// is gone from every dashboard page header, including Runs.
test("dashboard page headers carry no serif flourish", () => {
  const flourishFiles = [
    "app/dashboard/alerts/tab-pane.tsx",
    "app/dashboard/api/tab-pane.tsx",
    "app/dashboard/artifacts/tab-pane.tsx",
    "app/dashboard/compare/tab-pane.tsx",
    "app/dashboard/datasets/tab-pane.tsx",
    "app/dashboard/distributed/tab-pane.tsx",
    "app/dashboard/insights/tab-pane.tsx",
    "app/dashboard/metrics/tab-pane.tsx",
    "app/dashboard/reports/reports-tab-pane.tsx",
    "app/dashboard/runs/tab-pane.tsx",
    "app/dashboard/settings/tab-pane.tsx",
  ];
  for (const file of flourishFiles) {
    const src = read(file);
    assert.doesNotMatch(src, /serif-em|emphasis=/, `${file} must not use the serif flourish`);
  }
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

test("distributed standalone page uses a full-width selector band", () => {
  const src = read("app/dashboard/distributed/tab-pane.tsx");
  assert.match(src, /<PageHead[\s\S]*title="Rank reducers"/);
  assert.match(src, /className="distributed-control-band"/);
  assert.match(src, /className="distributed-run-summary"/);
  assert.match(src, /description: \[run\.project, run\.status\]/);
  const css = read("app/styles/research.css");
  assert.match(css, /\.distributed-control-band \{[\s\S]*grid-template-columns: minmax\(220px, 0\.9fr\) minmax\(0, 1\.8fr\)/);
  assert.match(css, /\.distributed-toolbar \.distributed-run-select \{[\s\S]*flex-basis: 320px/);
  const helpTriggerRule = css.match(/\.chart-help-trigger \{[^}]+\}/)?.[0] ?? "";
  assert.match(helpTriggerRule, /background: transparent/);
  assert.match(helpTriggerRule, /border: 0/);
  assert.doesNotMatch(helpTriggerRule, /border: 1px solid var\(--line\)/);
});

// AL2 (reverted 2026-06): the health cards were removed from the Runs header —
// they duplicated the Run health tab and pushed the run list below the fold.
// The cards (and their stats) remain on the Run health tab.
test("runs workspace header no longer duplicates the run health cards", () => {
  const paneSrc = read("app/dashboard/runs/tab-pane.tsx");
  assert.doesNotMatch(paneSrc, /runs-health-cards/);
  const alertsSrc = read("app/dashboard/alerts/tab-pane.tsx");
  // Mockup-parity stat strip (parity-health): failed/active run stats live in
  // hp-panel stat cards instead of MetricCards.
  assert.match(alertsSrc, /<span className="hp-mlabel">Failed runs<\/span>/);
  assert.match(alertsSrc, /overview\.active_runs/);
});

// A2 — the shared-demo spotlight still lights up when /signin?intent=demo is
// reached directly. The landing no longer advertises a live-demo CTA, so the
// entry point lives in the auth flow only.
test("auth flow spotlights the shared demo for intent=demo", () => {
  const landing = read("components/landing/LandingPage.tsx");
  assert.ok(!landing.includes("intent=demo"));
  const auth = read("app/auth-flow.tsx");
  assert.match(auth, /get\("intent"\) === "demo"/);
  assert.match(auth, /iml-btn--demo-spotlight/);
  assert.match(read("app/auth.css"), /\.iml-btn--demo-spotlight/);
});
