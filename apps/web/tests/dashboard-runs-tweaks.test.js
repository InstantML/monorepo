import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(webRoot, relPath), "utf8");
}

test("run rail hover surfaces tags and notes, not just the name", () => {
  const modelSrc = read("app/dashboard-models.ts");
  // The tooltip helper must fold tags and notes into the hover text.
  const helper = modelSrc.match(/export function runRailTooltip[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(helper, /Tags:/);
  assert.match(helper, /runNoteText\(run\)/);
  assert.match(helper, /Note:/);

  const workspaceSrc = read("app/dashboard/runs/runs-workspace.tsx");
  assert.match(workspaceSrc, /title=\{runRailTooltip\(run\)\}/);
});

test("run rail identity dots use the shared chart palette", () => {
  const workspaceSrc = read("app/dashboard/runs/runs-workspace.tsx");
  const chartsCss = read("app/styles/charts.css");
  assert.match(workspaceSrc, /import \{ chartColor, stableChartIndex \}/);
  assert.match(workspaceSrc, /const runColor = chartColor\(stableChartIndex\(run\.id \|\| run\.name, index\)\)/);
  assert.match(workspaceSrc, /className="legend-dot" style=\{\{ backgroundColor: runColor \}\}/);
  assert.doesNotMatch(workspaceSrc, /dot-\$\{index % 5\}/);
  assert.doesNotMatch(chartsCss, /\.dot-0/);
});

test("workspace charts render at measured CSS-pixel size (no stretch) with dark-mode marker outlines", () => {
  const panelsCss = read("app/styles/panels.css");
  const chartsCss = read("app/styles/charts.css");
  assert.match(panelsCss, /--fullscreen-chart-width: min\(100%, 1120px, calc\(213\.954vh - 509px\)\)/);
  // Frames own the height; no aspect-ratio locks anywhere — the SVG viewBox is
  // the measured frame size, so axis text and strokes never stretch.
  assert.doesNotMatch(chartsCss, /aspect-ratio: 560 \/ 360|aspect-ratio: 920 \/ 430/);
  assert.doesNotMatch(panelsCss, /aspect-ratio: 920 \/ 430|aspect-ratio: 560 \/ 360/);
  assert.match(chartsCss, /\.fullscreen-panel-card \.metric-chart-frame[\s\S]*?width: var\(--fullscreen-chart-width[\s\S]*?height: min\(56vh, 520px\)/);
  assert.match(chartsCss, /\.fullscreen-panel-card \.chart-range-row[\s\S]*?width: var\(--fullscreen-chart-width/);
  assert.match(chartsCss, /\.metric-chart-frame[\s\S]*?height: var\(--chart-frame-height, 360px\)/);
  assert.match(panelsCss, /\.alt-chart-frame[\s\S]*?height: var\(--chart-frame-height, 320px\)/);
  assert.match(panelsCss, /\.workspace-panel-card \.chart-area[\s\S]*?grid-template-rows: minmax\(0, 1fr\) auto auto/);
  assert.match(panelsCss, /\.workspace-panel-grid[\s\S]*?grid-auto-rows: 78px/);
  assert.match(panelsCss, /\.workspace-panel-card[\s\S]*?min-height: 0[\s\S]*?height: 100%/);
  assert.match(panelsCss, /\.workspace-panel-card:not\(\.fullscreen-panel-card\) \.metric-chart-frame[\s\S]*?height: 100%/);
  const metricChartSrc = read("app/dashboard/metrics/metric-chart.tsx");
  const workspacePanelSrc = read("app/dashboard/runs/workspace-panel-card.tsx");
  const measuredHook = read("app/dashboard/ui/use-measured-size.ts");
  // The chart measures its frame and renders viewBox at the measured size.
  assert.match(measuredHook, /ResizeObserver/);
  assert.match(metricChartSrc, /useMeasuredSize\(chartFrameRef, chartWidth, height\)/);
  assert.match(metricChartSrc, /viewBox=\{`0 0 \$\{width\} \$\{frameHeight\}`\}/);
  assert.doesNotMatch(metricChartSrc, /preserveAspectRatio/);
  assert.doesNotMatch(metricChartSrc, /fillFrame/);
  // Alt panels (bar/histogram/scatter/distribution/timeline) measure too.
  assert.match(workspacePanelSrc, /alt-chart-frame/);
  assert.match(workspacePanelSrc, /useMeasuredSize\(frameRef, fallbackWidth, fallbackHeight\)/);
  assert.match(chartsCss, /\.metric-chart-frame[\s\S]*?overflow: visible/);
  assert.match(chartsCss, /\.metric-chart-frame \.metric-chart[\s\S]*?overflow: hidden/);
  assert.doesNotMatch(metricChartSrc, /className="hover-point"/);
  assert.doesNotMatch(metricChartSrc, /hover-stack-point/);
  assert.match(panelsCss, /\.panel-resize-handle[\s\S]*?z-index: 12/);
  assert.match(panelsCss, /\.summary-dot[\s\S]*?stroke: var\(--chart-card-bg, var\(--surface\)\)/);
  assert.match(panelsCss, /\.scatter-dot[\s\S]*?stroke: var\(--chart-card-bg, var\(--surface\)\)/);
});

test("metric charts expose an accessible summary table view", () => {
  const metricChartSrc = read("app/dashboard/metrics/metric-chart.tsx");
  const chartsSrc = read("src/charts.js");
  const chartsCss = read("app/styles/charts.css");

  // The chart/summary switcher lives in the three-dot options menu as a radio
  // group; each option keeps a label + aria-pressed so screen-reader users can
  // toggle the view.
  assert.match(metricChartSrc, /chart-menu-radiogroup/);
  assert.match(metricChartSrc, /<span className="chart-menu-radio-label">Summary table<\/span>/);
  assert.match(metricChartSrc, /aria-pressed=\{chartView === "summary"\}/);
  assert.match(metricChartSrc, /<caption>\{metricTitle\(metricKey\)\} summary table<\/caption>/);
  assert.match(metricChartSrc, /<th scope="col">Run<\/th>/);
  assert.match(metricChartSrc, /<th scope="row" title=\{row\.name\}>/);
  assert.match(chartsSrc, /export function chartSummaryRows/);
  assert.match(chartsSrc, /export function chartSummaryTakeaway/);
  assert.match(chartsCss, /\.chart-summary-table-wrap[\s\S]*?overflow: auto/);
});

test("runs workspace exposes a visible select-all-on-page control with a count", () => {
  const workspaceSrc = read("app/dashboard/runs/runs-workspace.tsx");
  assert.match(workspaceSrc, /workspace-rail-page-select/);
  assert.match(workspaceSrc, /Select all \$\{visibleRunIds\.length\} on this page/);
});

test("initial dashboard data load renders shell with Runs skeletons", () => {
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  assert.match(shellSrc, /dashboardSessionChecked/);
  assert.match(shellSrc, /if \(!dashboardSessionChecked\) return <AppLoadingScreen detail="Checking session" \/>/);
  assert.doesNotMatch(shellSrc, /if \(!initialLoadDone\) return <AppLoadingScreen/);

  const workspaceSrc = read("app/dashboard/runs/runs-workspace.tsx");
  assert.match(workspaceSrc, /const initialRunsLoading = !initialLoadDone && workspaceRuns\.length === 0/);
  assert.match(workspaceSrc, /<RunsRailSkeleton \/>/);
  assert.match(workspaceSrc, /<WorkspaceCanvasSkeleton \/>/);
});

test("dashboard sidebar exposes the persisted theme toggle", () => {
  const navSrc = read("app/dashboard/chrome/nav-rail.tsx");
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  const dashboardCss = read("app/styles/dashboard.css");

  assert.match(navSrc, /onThemeToggle: \(\) => void/);
  assert.match(navSrc, /theme: "light" \| "dark"/);
  assert.match(navSrc, /aria-label=\{themeLabel\}/);
  assert.match(navSrc, /aria-pressed=\{dark\}/);
  assert.match(navSrc, /<span className="tab-label">\{dark \? "Light mode" : "Dark mode"\}<\/span>/);
  assert.match(shellSrc, /onThemeToggle=\{\(\) => setTheme\(\(current\) => current === "dark" \? "light" : "dark"\)\}/);
  assert.match(shellSrc, /theme=\{theme\}/);
  assert.match(dashboardCss, /\.nav-mobile-actions \{\s*display: none;\s*\}/);
});

test("runs workspace lets you jump to a specific page", () => {
  const workspaceSrc = read("app/dashboard/runs/runs-workspace.tsx");
  assert.match(workspaceSrc, /function RunPageJumper/);
  assert.match(workspaceSrc, /onGoToPage\(clamped\)/);

  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  assert.match(shellSrc, /const goToRunPage = useCallback/);
  assert.match(shellSrc, /onGoToPage=\{goToRunPage\}/);
});

test("copy-id buttons spell out what they copy", () => {
  for (const relPath of [
    "app/dashboard/detail/artifact-panel.tsx",
    "app/dashboard/detail/rich-object-panel.tsx",
  ]) {
    const src = read(relPath);
    assert.match(src, /Copy ID/);
    assert.match(src, /Copy this[\s\S]*?unique ID to the clipboard/);
  }
});

test("run detail chart always fetches the opened run's series", () => {
  // Opening a run that is not part of the current chart selection must still
  // fetch its series, otherwise the detail-tab chart renders the empty state.
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  const memo = shellSrc.match(/const seriesFetchRuns = useMemo[\s\S]*?\n  \}, \[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.match(memo, /activeTab === "detail"/);
  assert.match(memo, /\[primaryRun, \.\.\.metricSeriesRuns\]/);
  // The series-loading effect must consume the augmented fetch set.
  assert.match(shellSrc, /const runsForFetch = seriesFetchRuns;/);
  assert.match(shellSrc, /metricKey, seriesFetchRunKey, runWorkspaceTab/);
});
