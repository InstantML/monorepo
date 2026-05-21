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
    assert.doesNotMatch(src, /startsWith\("demo:\/\/"\)/);
    assert.doesNotMatch(src, /\^https\?:/);
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
