/**
 * Smoke tests for the v1.2 run-set table widget.
 *
 * These tests cover the module surface — the actual React render path needs
 * JSDOM / React Testing Library, which isn't set up in this repo (per
 * AGENTS.md, we lean on Playwright for visual smoke). We verify:
 *   1. The component file exists and exports the expected name.
 *   2. The TypeScript source references the load-bearing behaviors
 *      (selection, eye toggle, color picker, search/filter/sort/group,
 *      pagination, empty-state copy).
 *   3. The Rust types we depend on (run_settings.hidden) are documented in
 *      the TS type module.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHART_PALETTE } from "../src/chart-colors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const blockTypesDir = path.join(
  __dirname,
  "..",
  "app",
  "dashboard",
  "reports",
  "block-types",
);

function read(file) {
  return fs.readFileSync(path.join(blockTypesDir, file), "utf8");
}

test("RunSetTable module exists and exports the component", () => {
  const filePath = path.join(blockTypesDir, "run-set-table.tsx");
  assert.ok(fs.existsSync(filePath), "run-set-table.tsx must exist in block-types/");
  const src = fs.readFileSync(filePath, "utf8");
  assert.ok(/export function RunSetTable/.test(src), "RunSetTable must be exported");
});

test("RunSetTable wires the v1.2 load-bearing behaviors", () => {
  const src = read("run-set-table.tsx");
  // Selection states: included+visible, included+hidden, excluded.
  assert.ok(src.includes("disabled"), "table must read run_settings.disabled");
  assert.ok(src.includes("hidden"), "table must read run_settings.hidden");
  assert.ok(src.includes("color"), "table must read run_settings.color");
  // Toolbar actions.
  assert.ok(src.includes("Search runs"), "toolbar must have search placeholder");
  assert.ok(src.includes("Filter") && src.includes("Sort") && src.includes("Group"));
  // Pagination (10/page).
  assert.ok(/PAGE_SIZE\s*=\s*10/.test(src), "pagination defaults to 10/page");
  // Empty-state copy.
  assert.ok(
    src.includes("Add a project to populate runs."),
    "no-projects empty state copy must be present",
  );
  assert.ok(
    src.includes("No runs match this query."),
    "no-matches empty state copy must be present",
  );
});

test("Runset type carries the v1.2 run_settings shape", () => {
  const src = read("types.ts");
  assert.ok(/RunsetRunSettings/.test(src), "RunsetRunSettings type must exist");
  assert.ok(/hidden\?: boolean/.test(src), "RunsetRunSettings.hidden must be optional bool");
  assert.ok(/disabled\?: boolean/.test(src), "RunsetRunSettings.disabled must be optional bool");
  assert.ok(/color\?: string/.test(src), "RunsetRunSettings.color must be optional string");
  assert.ok(/RUN_COLOR_PALETTE/.test(src), "8-color palette constant must be exported");
});

test("Runset default colors intentionally mirror the shared dashboard palette", () => {
  const typesSrc = read("types.ts");
  const tableSrc = read("run-set-table.tsx");
  assert.deepEqual(CHART_PALETTE.slice(0, 8), [
    "#15a35d",
    "#3b82e0",
    "#bd8113",
    "#c44fb2",
    "#7a5fe0",
    "#1b9c8f",
    "#e06a38",
    "#6f9a3f",
  ]);
  assert.match(typesSrc, /RUN_COLOR_PALETTE:\s*string\[\]\s*=\s*CHART_PALETTE\.slice\(0,\s*8\)/);
  assert.match(tableSrc, /settings\.color\s*\?\?\s*RUN_COLOR_PALETTE\[index\s*%\s*RUN_COLOR_PALETTE\.length\]/);
});

test("AddPanelModal module exists and exposes both tabs", () => {
  const filePath = path.join(blockTypesDir, "add-panel-modal.tsx");
  assert.ok(fs.existsSync(filePath), "add-panel-modal.tsx must exist in block-types/");
  const src = fs.readFileSync(filePath, "utf8");
  assert.ok(/export function AddPanelModal/.test(src));
  assert.ok(src.includes("From other reports"), "modal must offer the org panel tab");
  assert.ok(src.includes("/api/reports/panels"), "modal must fetch the new endpoint");
});

test("Panel renderers ship for the 5 new types", () => {
  const renderersDir = path.join(blockTypesDir, "panel-renderers");
  for (const file of [
    "markdown-panel-renderer.tsx",
    "code-panel-renderer.tsx",
    "image-panel-renderer.tsx",
    "run-comparer-renderer.tsx",
    "parallel-coordinates-renderer.tsx",
    "index.ts",
  ]) {
    assert.ok(
      fs.existsSync(path.join(renderersDir, file)),
      `panel-renderers/${file} must exist`,
    );
  }
});

test("PanelChartRenderer dispatches the new panel types", () => {
  const src = read("panel-chart-renderer.tsx");
  for (const type of [
    "markdown_panel",
    "code_panel",
    "image_panel",
    "parallel_coordinates",
    "run_comparer",
  ]) {
    assert.ok(src.includes(`"${type}"`), `dispatcher must handle ${type}`);
  }
});

test("Picker catalog omits unshipped panel placeholders", () => {
  const src = read("types.ts");
  assert.equal(src.includes("parameter_importance"), false);
  assert.equal(src.includes("custom_chart"), false);
  assert.equal(src.includes("video_panel"), false);
});
