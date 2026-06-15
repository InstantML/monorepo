/**
 * Tests for the Reports list pure helpers (audit RP3): the
 * "Experiment readout" starter template and the duplicate-report payload.
 * These run against src/report-templates.js — the same module the reports
 * tab pane consumes — so the shapes asserted here are the shapes POSTed
 * to /api/reports.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  duplicateReportPayload,
  duplicateReportTitle,
  experimentReadoutTemplate,
} from "../src/report-templates.js";

test("experiment readout template carries the prefilled readout sections", () => {
  const template = experimentReadoutTemplate();
  assert.equal(template.title, "Experiment readout");
  assert.equal(typeof template.description, "string");
  assert.ok(template.description.length > 0, "template ships a description");
  assert.equal(template.visibility, "private");
  assert.ok(Array.isArray(template.blocks));

  const kinds = template.blocks.map((block) => block.kind);
  assert.deepEqual(kinds, [
    "heading",
    "paragraph",
    "heading",
    "panel_grid",
    "heading",
    "paragraph",
  ]);

  const headings = template.blocks.filter((block) => block.kind === "heading");
  assert.deepEqual(
    headings.map((block) => block.text),
    ["Summary", "Results", "Next steps"],
  );
  for (const heading of headings) {
    assert.ok(
      [1, 2, 3].includes(heading.level),
      "heading levels must be valid HeadingLevel values",
    );
  }
});

test("experiment readout template panel grid starts with one empty runset", () => {
  const template = experimentReadoutTemplate();
  const grid = template.blocks.find((block) => block.kind === "panel_grid");
  assert.ok(grid, "template must include a panel_grid block");
  assert.deepEqual(grid.panels, []);
  assert.equal(grid.runsets.length, 1);
  const [runset] = grid.runsets;
  assert.equal(typeof runset.name, "string");
  assert.ok(runset.name.length > 0);
  assert.deepEqual(runset.projects, []);
  assert.deepEqual(runset.pinned_run_ids, []);
});

test("experiment readout template returns a fresh object per call", () => {
  const first = experimentReadoutTemplate();
  first.title = "mutated";
  first.blocks[0].text = "mutated";
  first.blocks.find((block) => block.kind === "panel_grid").runsets[0].projects.push("p");
  const second = experimentReadoutTemplate();
  assert.equal(second.title, "Experiment readout");
  assert.equal(second.blocks[0].text, "Summary");
  assert.deepEqual(
    second.blocks.find((block) => block.kind === "panel_grid").runsets[0].projects,
    [],
  );
});

test("duplicateReportTitle appends (copy) with an untitled fallback", () => {
  assert.equal(duplicateReportTitle("Ablation sweep"), "Ablation sweep (copy)");
  assert.equal(duplicateReportTitle("  padded  "), "padded (copy)");
  assert.equal(duplicateReportTitle(""), "Untitled report (copy)");
  assert.equal(duplicateReportTitle("   "), "Untitled report (copy)");
  assert.equal(duplicateReportTitle(undefined), "Untitled report (copy)");
  assert.equal(duplicateReportTitle(null), "Untitled report (copy)");
});

test("duplicateReportPayload copies title/description/blocks and stays private", () => {
  const source = {
    id: "00000000-0000-0000-0000-000000000010",
    title: "Readout",
    description: "Q2 results",
    visibility: "public",
    share_token: "instantml_share_abc",
    blocks: [
      { kind: "heading", level: 1, text: "H" },
      { kind: "panel_grid", runsets: [{ name: "r", projects: ["demo"] }], panels: [] },
    ],
  };
  const payload = duplicateReportPayload(source);
  assert.equal(payload.title, "Readout (copy)");
  assert.equal(payload.description, "Q2 results");
  assert.deepEqual(payload.blocks, source.blocks);
  // Copies never inherit the source's audience: no share token field, and
  // visibility resets to private.
  assert.equal(payload.visibility, "private");
  assert.equal("share_token" in payload, false);
  assert.equal("id" in payload, false);
});

test("duplicateReportPayload deep-copies blocks so the copy cannot mutate the source", () => {
  const source = {
    title: "Readout",
    blocks: [{ kind: "panel_grid", runsets: [{ name: "r", projects: ["demo"] }], panels: [] }],
  };
  const payload = duplicateReportPayload(source);
  payload.blocks[0].runsets[0].projects.push("other");
  assert.deepEqual(source.blocks[0].runsets[0].projects, ["demo"]);
});

test("duplicateReportPayload tolerates missing description and blocks", () => {
  const payload = duplicateReportPayload({ title: "Bare" });
  assert.equal(payload.title, "Bare (copy)");
  assert.equal(payload.description, "");
  assert.deepEqual(payload.blocks, []);
});
