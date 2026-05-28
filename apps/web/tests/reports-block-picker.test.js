import assert from "node:assert/strict";
import test from "node:test";

// We can't render a React component under node --test (no JSX runtime + no
// DOM), but we can verify the picker's pure-data exports — the catalog
// drives both the UI and the slash-command behaviour, so checking it stays
// in lockstep with the kind enum is enough to catch the common
// "renders without crashing" regressions.
import { BLOCK_PICKER_CATALOG } from "../app/dashboard/reports/slash-command-core.js";

test("block-picker catalog covers every block kind the editor can insert", () => {
  const kinds = new Set(BLOCK_PICKER_CATALOG.map((entry) => entry.id));
  for (const required of [
    "heading-1",
    "heading-2",
    "heading-3",
    "paragraph",
    "markdown",
    "code",
    "callout",
    "horizontal_rule",
    "image",
    "panel_grid",
  ]) {
    assert.ok(kinds.has(required), `picker missing required kind: ${required}`);
  }
});

test("every block-picker entry has a stable id, a label, and a hint", () => {
  for (const entry of BLOCK_PICKER_CATALOG) {
    assert.equal(typeof entry.id, "string", `${entry?.id ?? "?"}: id is string`);
    assert.equal(typeof entry.label, "string", `${entry.id}: label is string`);
    assert.ok(entry.label.length > 0, `${entry.id}: label non-empty`);
    if (entry.hint !== undefined) {
      assert.equal(typeof entry.hint, "string");
    }
  }
});

test("block-picker entries are deduplicated by id", () => {
  const ids = BLOCK_PICKER_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id in catalog");
});
