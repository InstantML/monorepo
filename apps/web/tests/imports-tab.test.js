import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../app/dashboard/imports/tab-pane.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/styles/imports.css", import.meta.url), "utf8");

test("imports tab copy commands are dry-run first and shell-quoted", () => {
  assert.match(source, /--dry-run/);
  assert.match(source, /function shellQuote/);
  assert.match(source, /replaceAll\("'", "'\\\\''"\)/);
  assert.doesNotMatch(source, /Create dry-run job/);
  assert.doesNotMatch(source, /--watch --watch-interval/);
});

test("imports tab uses generated API types and mobile-safe layout constraints", () => {
  assert.match(source, /components\["schemas"\]\["ImportJobRow"\]/);
  assert.doesNotMatch(source, /Promise<any>/);
  assert.match(styles, /\.imports-grid[\s\S]*grid-template-columns: minmax\(0, 280px\) minmax\(0, 1fr\) minmax\(0, 320px\)/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.imports-modes[\s\S]*grid-template-columns: 1fr/);
  assert.match(styles, /\.imports-table-scroll[\s\S]*max-width: 100%/);
});
