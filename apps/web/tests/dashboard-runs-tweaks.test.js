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

test("runs workspace exposes a visible select-all-on-page control with a count", () => {
  const workspaceSrc = read("app/dashboard/runs/runs-workspace.tsx");
  assert.match(workspaceSrc, /workspace-rail-page-select/);
  assert.match(workspaceSrc, /Select all \$\{visibleRunIds\.length\} on this page/);
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
