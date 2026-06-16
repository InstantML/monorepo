import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(path.join(here, "..", relative), "utf8");

test("R6: MetricChart accepts an external highlight and exposes legend hover", () => {
  const chart = readSource("app/dashboard/metrics/metric-chart.tsx");
  // External highlight + legend hover resolve through one active id, hover wins.
  assert.match(chart, /hover\?\.runId \?\? legendHoverId \?\? highlightRunId \?\? null/);
  // Muting keys off the merged active id, not just the in-plot hover.
  assert.match(chart, /const hoverClassFor = \(item: any\) => activeRunId/);
  // Legend chips drive and reflect the highlight.
  assert.match(chart, /onMouseEnter=\{\(\) => setLegendHoverId\(item\.id\)\}/);
  assert.match(chart, /legend-chip-active/);
  assert.match(chart, /chart-legend\$\{activeRunId \? " has-active" : ""\}/);
});

test("R6: rail rows and line panels share one highlight channel", () => {
  const workspace = readSource("app/dashboard/runs/runs-workspace.tsx");
  assert.match(workspace, /const \[highlightRunId, setHighlightRunId\] = useState<string \| null>\(null\)/);
  assert.match(workspace, /onMouseEnter=\{\(\) => setHighlightRunId\(run\.id\)\}/);
  assert.match(workspace, /is-highlighted/);
  assert.match(workspace, /highlightRunId=\{highlightRunId\}/);
  assert.match(workspace, /onHighlightRun=\{setHighlightRunId\}/);

  const panelCard = readSource("app/dashboard/runs/workspace-panel-card.tsx");
  // Section view forwards both directions to every panel card; line panels
  // report chart hover back up so the rail row lights too.
  assert.match(panelCard, /highlightRunId=\{highlightRunId\}/);
  assert.match(panelCard, /onHighlightRun\?\.\(point\?\.runId \?\? null\)/);
  assert.match(panelCard, /onHighlightRun\?\.\(null\)/);

  // Both themes style the lit rail row.
  assert.match(readSource("app/styles/dashboard-runs.css"), /\.workspace-run-row\.is-highlighted/);
  assert.match(readSource("app/styles/dark-overrides.css"), /\.workspace-run-row\.is-highlighted/);
});
