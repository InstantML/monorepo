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

// The standalone Compare page + bottom selection toast collapsed into the
// Runs → Table view: selecting runs renders the comparison inline, so the
// floating tray (and its separate Compare destination) is gone.
test("comparison is embedded in the runs table view, not a floating toast", () => {
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  assert.doesNotMatch(shellSrc, /<SelectionTray/);
  assert.doesNotMatch(shellSrc, /selectTab\("compare"\)/);
  // The slim comparison is passed into the runs table view as a slot.
  assert.match(shellSrc, /<CompareView/);
  assert.match(shellSrc, /compareSlot=\{/);
  const paneSrc = read("app/dashboard/runs/tab-pane.tsx");
  assert.match(paneSrc, /\{compareSlot\}/);
  const compareSrc = read("app/dashboard/compare/tab-pane.tsx");
  assert.match(compareSrc, /Comparing /);
  assert.match(compareSrc, /Export CSV/);
  assert.match(compareSrc, /Clear/);
  // The removed tray's styles are gone too.
  assert.doesNotMatch(read("app/styles/overhaul.css"), /\.selection-tray \{/);
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
  for (const id of ["runs", "metrics", "distributed", "insights", "artifacts", "objects", "reports", "alerts", "datasets", "settings", "agent"]) {
    assert.match(configSrc, new RegExp(`id: "${id}"`), `tab id ${id} must survive the regroup`);
  }
  // CK2: the Checkpoints tab merged into Run Detail; its nav slot is gone but
  // old /dashboard/checkpoints (and /dashboard/models) links canonicalize.
  assert.doesNotMatch(configSrc, /id: "checkpoints"/);
  // The standalone Compare page collapsed into the Runs → Table view; its nav
  // slot is gone but old /dashboard/compare links canonicalize to runs.
  assert.doesNotMatch(configSrc, /id: "compare"/);
  const routesSrc = read("src/routes.js");
  assert.match(routesSrc, /\["checkpoints", "detail"\]/);
  assert.match(routesSrc, /\["models", "detail"\]/);
  assert.match(routesSrc, /\["compare", "runs"\]/);
  assert.match(routesSrc, /\["api", "agent"\]/);
  const runDetailSrc = read("app/dashboard/detail/run-detail.tsx");
  assert.match(runDetailSrc, /checkpoint-uri/);
  assert.match(runDetailSrc, /eval_return/);
});

test("objects workspace filters round-trip through shareable URL params", () => {
  const objectsSrc = read("app/dashboard/objects/tab-pane.tsx");
  assert.match(objectsSrc, /function objectUrlState/, "Objects tab should initialize filters from the URL");
  assert.match(objectsSrc, /params\.get\("kind"\)/, "Objects tab should read the object kind URL filter");
  assert.match(objectsSrc, /setOrDelete\("kind", state\.kind\)/, "Objects tab should write the object kind URL filter");
  assert.match(objectsSrc, /setOrDelete\("from_step", state\.fromStep\)/, "Objects tab should write step-range filters");
  assert.match(objectsSrc, /window\.addEventListener\("popstate", syncFromUrl\)/, "Objects tab should handle browser back/forward filter state");
});

test("objects workspace invalidates stale pages immediately and uses native button semantics", () => {
  const objectsSrc = read("app/dashboard/objects/tab-pane.tsx");
  assert.match(objectsSrc, /filterEpochRef\.current \+= 1/);
  assert.match(objectsSrc, /loadMoreControllerRef\.current\?\.abort\(\)/);
  assert.match(objectsSrc, /\[fromStep, key, kind, project, refreshNonce, runQuery, toStep\]/);
  assert.match(objectsSrc, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.doesNotMatch(objectsSrc, /role="listbox"/);
  assert.doesNotMatch(objectsSrc, /role="option"/);
  assert.doesNotMatch(objectsSrc, /role="tablist"/);
});

// R1 — the runs table is mounted behind a panels/table view toggle.
test("runs tab offers a persisted panels/table view toggle", () => {
  const paneSrc = read("app/dashboard/runs/tab-pane.tsx");
  const commandbarSrc = read("app/dashboard/runs/runs-commandbar.tsx");
  assert.match(commandbarSrc, /runs-view-switch/);
  assert.match(paneSrc, /<RunsTable/);
  assert.match(paneSrc, /instantml:next:runs-view/);
  // The toggle is the shared SegmentedToggle, wired to viewMode with a "table"
  // option; the aria-pressed state binding now lives in that component.
  assert.match(commandbarSrc, /<SegmentedToggle/);
  assert.match(commandbarSrc, /value=\{viewMode\}/);
  assert.match(commandbarSrc, /value: "table"/);
  const toggleSrc = read("app/dashboard/components/segmented-toggle.tsx");
  assert.match(toggleSrc, /aria-pressed=\{value === optionValue\}/);
});

// V2 — superseded by main's header simplification (#189): the serif flourish
// is gone from every dashboard page header, including Runs.
test("dashboard page headers carry no serif flourish", () => {
  const flourishFiles = [
    "app/dashboard/alerts/tab-pane.tsx",
    "app/dashboard/agent/tab-pane.tsx",
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

test("agent capability overflow chips expand hidden tools inline", () => {
  const paneSrc = read("app/dashboard/agent/tab-pane.tsx");
  const css = read("app/styles/overhaul.css");

  assert.match(paneSrc, /const \[expandedTools, setExpandedTools\] = useState<Record<string, boolean>>\(\{\}\)/);
  assert.match(paneSrc, /const expanded = Boolean\(expandedTools\[title\]\)/);
  assert.match(paneSrc, /const visibleTools = expanded \? tools : tools\.slice\(0, VISIBLE_TOOL_CHIPS\)/);
  assert.match(paneSrc, /className="agent-capability-tools-toggle"/);
  assert.match(paneSrc, /aria-expanded=\{expanded\}/);
  assert.match(paneSrc, /aria-label=\{expanded \? `Collapse \$\{title\} tools` : `Show \$\{tools\.length - VISIBLE_TOOL_CHIPS\} more \$\{title\} tools`\}/);
  assert.match(paneSrc, /setExpandedTools\(\(prev\) => \(\{ \.\.\.prev, \[title\]: !expanded \}\)\)/);
  assert.match(paneSrc, /\{expanded \? "less" : `\+\$\{tools\.length - VISIBLE_TOOL_CHIPS\} more`\}/);
  assert.doesNotMatch(paneSrc, /title=\{tools\.slice\(VISIBLE_TOOL_CHIPS\)/);

  assert.match(css, /\.agent-capability-tools code,\s*\.agent-capability-tools-toggle/);
  assert.match(css, /\.agent-capability-tools-toggle:hover,\s*\.agent-capability-tools-toggle:focus-visible/);
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

test("distributed standalone page shows the run once via the selector band", () => {
  const src = read("app/dashboard/distributed/tab-pane.tsx");
  assert.match(src, /<PageHead title="Rank reducers" \/>/);
  assert.match(src, /className="distributed-control-band"/);
  // The run name/meta is shown only by the Run selector — no separate summary
  // block and no PageHead lede duplicating it.
  assert.doesNotMatch(src, /className="distributed-run-summary"/);
  assert.doesNotMatch(src, /lede=/);
  assert.match(src, /description: \[run\.project, run\.status\]/);
  const css = read("app/styles/research.css");
  assert.match(css, /\.distributed-toolbar \.distributed-run-select \{[\s\S]*flex: 1\.4 1 320px/);
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
