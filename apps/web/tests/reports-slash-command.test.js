import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCK_PICKER_CATALOG,
  detectSlashTrigger,
  filterBlockPicker,
  resolvePickerKind,
} from "../app/dashboard/reports/slash-command-core.js";

test("detectSlashTrigger opens on a leading / at the start of a line", () => {
  const result = detectSlashTrigger("/", 1);
  assert.equal(result.active, true);
  assert.equal(result.query, "");
  assert.equal(result.triggerOffset, 0);
});

test("detectSlashTrigger reports the filter query after the slash", () => {
  const result = detectSlashTrigger("/head", 5);
  assert.equal(result.active, true);
  assert.equal(result.query, "head");
});

test("detectSlashTrigger stays closed when the line doesn't start with /", () => {
  const result = detectSlashTrigger("hello /world", 12);
  assert.equal(result.active, false);
});

test("detectSlashTrigger closes when a whitespace appears after /", () => {
  const result = detectSlashTrigger("/head info", 10);
  assert.equal(result.active, false);
});

test("detectSlashTrigger respects backslash escape", () => {
  const result = detectSlashTrigger("\\/", 2);
  assert.equal(result.active, false);
});

test("detectSlashTrigger works on multi-line input", () => {
  const text = "first line\n/heading";
  const result = detectSlashTrigger(text, text.length);
  assert.equal(result.active, true);
  assert.equal(result.query, "heading");
});

test("detectSlashTrigger is inactive when caret precedes the slash", () => {
  const result = detectSlashTrigger("/heading", 0);
  assert.equal(result.active, false);
});

test("filterBlockPicker returns all entries on empty query", () => {
  const result = filterBlockPicker("", BLOCK_PICKER_CATALOG);
  assert.equal(result.length, BLOCK_PICKER_CATALOG.length);
});

test("filterBlockPicker narrows by label prefix", () => {
  const result = filterBlockPicker("head", BLOCK_PICKER_CATALOG);
  assert.ok(result.length >= 3);
  assert.ok(result.every((entry) => entry.label.toLowerCase().includes("head")));
});

test("filterBlockPicker ranks exact match above prefix", () => {
  const result = filterBlockPicker("paragraph", BLOCK_PICKER_CATALOG);
  assert.equal(result[0].id, "paragraph");
});

test("filterBlockPicker matches keywords (h1, hr, chart)", () => {
  assert.equal(filterBlockPicker("h1", BLOCK_PICKER_CATALOG)[0].id, "heading-1");
  assert.equal(filterBlockPicker("hr", BLOCK_PICKER_CATALOG)[0].id, "horizontal_rule");
  assert.equal(filterBlockPicker("chart", BLOCK_PICKER_CATALOG)[0].id, "panel_grid");
});

test("filterBlockPicker returns empty when nothing matches", () => {
  const result = filterBlockPicker("zzzzz-no-match", BLOCK_PICKER_CATALOG);
  assert.equal(result.length, 0);
});

test("resolvePickerKind maps ids to block kinds", () => {
  assert.deepEqual(resolvePickerKind("heading-1"), { kind: "heading", headingLevel: 1 });
  assert.deepEqual(resolvePickerKind("heading-3"), { kind: "heading", headingLevel: 3 });
  assert.deepEqual(resolvePickerKind("paragraph"), { kind: "paragraph" });
  assert.deepEqual(resolvePickerKind("panel_grid"), { kind: "panel_grid" });
  assert.equal(resolvePickerKind("nope"), null);
});
