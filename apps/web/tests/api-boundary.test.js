import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

test("product API calls stay behind ApiClient fetch instrumentation", () => {
  const allowedRawFetchFiles = new Set([
    path.join(webRoot, "src", "api.js"),
    // Static docs markdown copy helper; not a product API call.
    path.join(webRoot, "app", "docs", "docs-agent-markdown-button.tsx"),
    // Embed routes use short-lived fragment tokens and must omit browser credentials.
    path.join(webRoot, "app", "embed", "runs", "[session_id]", "embedded-runs-canvas.tsx"),
  ]);
  const files = listSourceFiles(path.join(webRoot, "app"))
    .concat(listSourceFiles(path.join(webRoot, "components")))
    .concat(listSourceFiles(path.join(webRoot, "src")));
  const offenders = [];
  for (const file of files) {
    if (allowedRawFetchFiles.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("fetch(")) offenders.push(path.relative(webRoot, file));
  }
  assert.deepEqual(offenders, []);
});

function listSourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(full));
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}
