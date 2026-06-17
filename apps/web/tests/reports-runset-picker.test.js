/**
 * Source-contract tests for the Reports runset pickers (audit RP2) and the
 * list-pane duplicate/template actions (audit RP3 wiring).
 *
 * The React render path needs JSDOM / React Testing Library, which isn't
 * set up in this repo (per AGENTS.md we lean on Playwright for visual
 * smoke) — so, matching run-set-table.test.js, these assert the load-bearing
 * behaviors against the component source.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportsDir = path.join(__dirname, "..", "app", "dashboard", "reports");

function read(...segments) {
  return fs.readFileSync(path.join(reportsDir, ...segments), "utf8");
}

test("panel grid offers a project multi-select picker, not just raw text", () => {
  const src = read("block-types", "panel-grid-block.tsx");
  // Toggleable project chips (click to add/remove, keyboard accessible).
  assert.ok(
    src.includes('className="report-block__project-chip"'),
    "project options must render as picker chips",
  );
  assert.ok(
    src.includes("aria-pressed={selected}"),
    "project chips must expose toggle state via aria-pressed",
  );
  assert.match(src, /toggleProject/, "chips must toggle membership on click");
});

test("comma-separated projects input survives only as the fetch-failure fallback", () => {
  const src = read("block-types", "panel-grid-block.tsx");
  // The old always-on label is gone…
  assert.equal(
    src.includes("Projects (comma-separated, supports cross-project)"),
    false,
    "bare comma-separated input must not be the primary path",
  );
  // …and the raw input is gated behind the /projects fetch failing.
  assert.match(
    src,
    /projectOptions\.status === "error"/,
    "raw text input must be gated on project fetch failure",
  );
  assert.ok(
    src.includes("Project list unavailable"),
    "fallback must explain why raw input is shown",
  );
  // The fetch hook reports failure instead of swallowing it.
  assert.match(src, /status:\s*"error"/);
});

test("pinned runs gain a search-and-pick against the run search endpoint", () => {
  const src = read("block-types", "panel-grid-block.tsx");
  assert.match(src, /function RunSearchPicker/);
  assert.ok(
    src.includes("/api/runs/summary?"),
    "run search must hit the same endpoint as the runs dashboard",
  );
  assert.match(src, /q:\s*trimmed/, "search term must be passed as the q param");
  assert.match(
    src,
    /RUN_SEARCH_LIMIT\s*=\s*10/,
    "search must list at most 10 matches",
  );
  // Matches show name + project; clicking pins the run id.
  assert.ok(src.includes("report-block__run-result-name"));
  assert.ok(src.includes("report-block__run-result-project"));
  assert.match(src, /onPick\(match\.id\)/);
  // Raw pin-by-ID input stays available as the advanced fallback.
  assert.ok(
    src.includes("Advanced: pin by run ID"),
    "advanced raw input must remain available",
  );
  assert.ok(src.includes("run-uuid or project/run-name"));
});

test("reports list wires duplicate and start-from-template actions", () => {
  const src = read("reports-tab-pane.tsx");
  // RP3a: duplicate goes through the shared pure payload helper and the
  // existing create/open flow.
  assert.match(src, /duplicateReportPayload/);
  assert.match(src, /handleDuplicate/);
  assert.ok(src.includes("Duplicate report"));
  // RP3b: template creation uses the testable template module.
  assert.match(src, /experimentReadoutTemplate/);
  assert.ok(src.includes("report-templates.js"), "tab pane must consume src/report-templates.js");
  assert.ok(src.includes("Start from template"));
  // Both the populated-list header and the empty state offer the template.
  const templateButtonCount = src.split("Start from template").length - 1;
  assert.ok(
    templateButtonCount >= 2,
    "template action must appear in the header and the empty state",
  );
});
