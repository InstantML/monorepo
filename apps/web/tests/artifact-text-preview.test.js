import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactTextPreviewKind, formatJsonPreview, truncateTextPreview } from "../src/evidence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(path.join(here, "..", relative), "utf8");

test("artifactTextPreviewKind detects csv/json/text by mime then extension", () => {
  assert.equal(artifactTextPreviewKind({ name: "eval-table.csv" }), "csv");
  assert.equal(artifactTextPreviewKind({ name: "results", uri: "s3://bucket/run/results.tsv" }), "csv");
  assert.equal(artifactTextPreviewKind({ name: "config.json" }), "json");
  assert.equal(artifactTextPreviewKind({ name: "events.jsonl" }), "json");
  assert.equal(artifactTextPreviewKind({ name: "notes.md" }), "text");
  assert.equal(artifactTextPreviewKind({ name: "train.log" }), "text");
  assert.equal(artifactTextPreviewKind({ name: "data", mime_type: "application/json" }), "json");
  assert.equal(artifactTextPreviewKind({ name: "data", mime_type: "text/plain" }), "text");
  // Binary and media formats stay out.
  assert.equal(artifactTextPreviewKind({ name: "model.ckpt" }), "");
  assert.equal(artifactTextPreviewKind({ name: "frame.png" }), "");
  assert.equal(artifactTextPreviewKind({}), "");
  assert.equal(artifactTextPreviewKind({ mime_type: null, metadata: null, name: "a.json" }), "json");
});

test("truncateTextPreview bounds by lines and characters and reports the cut", () => {
  const short = truncateTextPreview("a,b\n1,2");
  assert.equal(short.text, "a,b\n1,2");
  assert.equal(short.truncated, false);
  const manyLines = truncateTextPreview(Array.from({ length: 100 }, (_, i) => `row${i}`).join("\n"), { maxLines: 10 });
  assert.equal(manyLines.text.split("\n").length, 10);
  assert.equal(manyLines.truncated, true);
  const longLine = truncateTextPreview("x".repeat(50), { maxChars: 20 });
  assert.equal(longLine.text.length, 20);
  assert.equal(longLine.truncated, true);
});

test("formatJsonPreview pretty-prints valid JSON and rejects fragments", () => {
  assert.equal(formatJsonPreview('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatJsonPreview('{"a":'), null);
  assert.equal(formatJsonPreview('{"a":1}\n{"b":2}'), null, "jsonl is not a single document");
});

test("AR4: artifact browser mounts the bounded text preview", () => {
  const browser = readSource("app/dashboard/artifacts/artifact-browser.tsx");
  assert.match(browser, /<ArtifactTextPreview artifact=\{artifact\} \/>/);
  const preview = readSource("app/dashboard/artifacts/artifact-text-preview.tsx");
  // Rides the existing download route, capped, and yields to media previews.
  assert.match(preview, /\/api\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}\/download/);
  assert.match(preview, /PREVIEW_FETCH_BYTE_CAP = 16_384/);
  assert.match(preview, /fetchBoundedText/);
  assert.match(preview, /safeArtifactMediaKind\(artifact\)/);
  assert.match(preview, /artifactHasStoredBytes\(artifact\)/);
  assert.match(preview, /use Download for the rest/);
});
