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

test("artifact UI gates downloads on stored-byte backends", () => {
  const modelSrc = read("app/dashboard-models.ts");
  assert.match(modelSrc, /export function artifactHasStoredBytes/);
  assert.match(modelSrc, /storage_backend === "local" \|\| artifact\.storage_backend === "r2"/);

  for (const relPath of [
    "app/dashboard/artifacts/artifact-browser.tsx",
    "app/dashboard/detail/artifact-panel.tsx",
    "app/dashboard/compare/side-by-side.tsx",
  ]) {
    const src = read(relPath);
    assert.match(src, /artifactHasStoredBytes/);
    assert.match(src, /safeArtifactMediaKind/);
    assert.doesNotMatch(src, /startsWith\("demo:\/\/"\)/);
    assert.doesNotMatch(src, /\^https\?:/);
    assert.doesNotMatch(src, /mime\.includes\("image"\)/);
  }
});

test("artifact UI does not model or display raw storage internals", () => {
  const typesSrc = read("app/dashboard-types.ts");
  assert.doesNotMatch(typesSrc, /storage_key/);
  assert.doesNotMatch(typesSrc, /storage_path/);

  const workspaceSrc = read("app/dashboard/components/run-workspace.tsx");
  assert.match(workspaceSrc, /safeArtifactUri\(item\.artifact\.uri\)/);
  assert.doesNotMatch(workspaceSrc, /<strong>\{item\.artifact\.uri\}<\/strong>/);
});

test("rich-object media previews preserve stored-byte artifact backends", () => {
  const typesSrc = read("app/dashboard-types.ts");
  const richObjectSrc = read("app/dashboard/detail/rich-object-panel.tsx");
  assert.match(typesSrc, /storage_backend\?: string \| null/);
  assert.match(richObjectSrc, /storage_backend: object\.artifact\.storage_backend/);
  assert.match(richObjectSrc, /ArtifactMediaPreview artifact=\{artifact\}/);
});

test("artifact lineage UI uses versioned artifact endpoints and keeps raw run artifacts separate", () => {
  const paneSrc = read("app/dashboard/artifacts/tab-pane.tsx");
  const apiSrc = read("src/api.js");

  assert.match(paneSrc, /\/api\/artifact-collections/);
  assert.match(paneSrc, /\/api\/artifact-versions\/\$\{encodeURIComponent\(selectedVersion\.id\)\}\/manifest/);
  assert.match(paneSrc, /offset: manifestEntries\.length/);
  assert.match(paneSrc, /manifestHasMore/);
  assert.match(paneSrc, /manifestCountLabel/);
  assert.match(paneSrc, /\/api\/artifact-versions\/\$\{encodeURIComponent\(selectedVersion\.id\)\}\/lineage/);
  assert.match(paneSrc, /\/api\/artifact-entries\/\$\{encodeURIComponent\(entry\.id\)\}\/download/);
  assert.match(paneSrc, /collection_id === collection\.id/);
  assert.match(paneSrc, /retention_mode: retentionMode/);
  assert.match(paneSrc, /updateRetention\("keep_forever"\)/);
  assert.doesNotMatch(paneSrc, /updateRetention\("forever"\)/);
  assert.match(paneSrc, /Raw run artifacts/);
  assert.match(paneSrc, /canManageArtifacts/);

  assert.match(apiSrc, /async delete\(path, body = \{\}, options = \{\}\)/);
  assert.match(apiSrc, /artifact-collections/);
  assert.match(apiSrc, /artifact-versions/);
  assert.match(apiSrc, /artifact-entries/);
});
