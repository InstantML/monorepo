import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { groupArtifactsByName } from "../src/evidence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(webRoot, relPath), "utf8");
}

test("reference-only artifacts get an explicit chip and explanatory tooltip", () => {
  const browserSrc = read("app/dashboard/artifacts/artifact-browser.tsx");
  assert.match(browserSrc, /artifact-reference-chip/);
  assert.match(browserSrc, /reference only/);
  assert.match(browserSrc, /REFERENCE_ONLY_HELP/);
  assert.match(browserSrc, /bytes were not uploaded/);
  assert.match(browserSrc, /Metadata only/);
  assert.match(browserSrc, /artifactHasStoredBytes/);

  const css = read("app/styles/compare.css");
  assert.match(css, /\.browser-row\.reference-only \{\n  border-style: dashed;/);
  assert.match(css, /\.artifact-reference-chip \{/);
});

test("raw artifact rows expose a copy-URI action with the full URI on hover", () => {
  const browserSrc = read("app/dashboard/artifacts/artifact-browser.tsx");
  assert.match(browserSrc, /Copy URI/);
  assert.match(browserSrc, /`Copy URI: \$\{artifact\.uri\}`/);
  assert.match(browserSrc, /<small title=\{artifact\.uri\}>/);
  assert.match(browserSrc, /onCopy\("uri", artifact\)/);
  assert.match(browserSrc, /onCopy\("id", artifact\)/);
});

test("raw artifacts sharing a name collapse into one row with a version chip", () => {
  const browserSrc = read("app/dashboard/artifacts/artifact-browser.tsx");
  assert.match(browserSrc, /groupArtifactsByName/);
  assert.match(browserSrc, /artifact-version-count-chip/);
  assert.match(browserSrc, /\{olderCount \+ 1\} versions/);
  assert.match(browserSrc, /aria-expanded=\{expanded\}/);
  assert.match(browserSrc, /olderVersion/);
});

test("artifacts page drops the topline totals strip and folds empty panels", () => {
  const paneSrc = read("app/dashboard/artifacts/tab-pane.tsx");
  // AR6: the topline totals strip (files/checkpoints/rollouts/inspected run) is
  // gone — it implied the whole catalog was run-scoped when only raw artifacts are.
  assert.doesNotMatch(paneSrc, /analysis-stat-strip artifact-stat-strip/);
  assert.doesNotMatch(paneSrc, /Inspected run/);
  assert.doesNotMatch(paneSrc, /Selected page totals/);
  assert.doesNotMatch(paneSrc, /artifact-totals-panel/);
  // The raw-artifacts panel names the inspected run, since it is the only
  // run-scoped section of the page.
  assert.match(paneSrc, /Raw run artifacts <span>\{primaryRun\?\.name/);
  // AR1-lite: empty collections collapse to a one-line note; empty detail panels
  // fold into a single hint panel.
  assert.match(paneSrc, /collectionsCollapsed/);
  assert.match(paneSrc, /artifact-note-panel/);
  assert.match(paneSrc, /artifact-hint-panel/);
  assert.match(paneSrc, /Select a collection or version/);
  // Search/filter controls stay reachable whenever a query or filter is active.
  assert.match(paneSrc, /!collectionQuery && !typeFilter/);
});

test("groupArtifactsByName keeps the highest-step artifact as latest", () => {
  const a = { id: "a", name: "model.pt", step: 10 };
  const b = { id: "b", name: "model.pt", step: 30 };
  const c = { id: "c", name: "model.pt", step: 20 };
  const groups = groupArtifactsByName([a, b, c]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "model.pt");
  assert.equal(groups[0].latest, b);
  assert.deepEqual(groups[0].older, [a, c]);
  assert.equal(groups[0].count, 3);
});

test("groupArtifactsByName falls back to input order when steps are missing", () => {
  const newest = { id: "n", name: "notes.json", step: null };
  const oldest = { id: "o", name: "notes.json", step: null };
  const groups = groupArtifactsByName([newest, oldest]);
  assert.equal(groups[0].latest, newest);
  assert.deepEqual(groups[0].older, [oldest]);

  // A stepped entry beats step-less entries regardless of order.
  const stepped = { id: "s", name: "notes.json", step: 4 };
  const mixed = groupArtifactsByName([newest, stepped, oldest]);
  assert.equal(mixed[0].latest, stepped);
  assert.deepEqual(mixed[0].older, [newest, oldest]);
});

test("groupArtifactsByName keeps distinct names separate in first-seen order", () => {
  const checkpoint = { id: "c1", name: "ckpt.pt", step: 5 };
  const rollout = { id: "r1", name: "rollout.mp4", step: 5 };
  const checkpoint2 = { id: "c2", name: "ckpt.pt", step: 9 };
  const groups = groupArtifactsByName([checkpoint, rollout, checkpoint2]);
  assert.deepEqual(groups.map((group) => [group.name, group.count]), [
    ["ckpt.pt", 2],
    ["rollout.mp4", 1],
  ]);
  assert.equal(groups[0].latest, checkpoint2);
  assert.deepEqual(groups[1].older, []);
});

test("groupArtifactsByName tolerates empty and malformed input", () => {
  assert.deepEqual(groupArtifactsByName(), []);
  assert.deepEqual(groupArtifactsByName([]), []);
  assert.deepEqual(groupArtifactsByName(null), []);
  const anonymous = { id: "x", step: null };
  const groups = groupArtifactsByName([null, anonymous, undefined]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].latest, anonymous);
});
