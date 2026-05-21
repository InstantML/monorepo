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

test("dashboard workbar dropdown menus are not clipped by the filter row", () => {
  const topbarSrc = read("app/dashboard/chrome/topbar.tsx");
  assert.match(topbarSrc, /<CustomSelect id="project-filter"/);
  assert.match(topbarSrc, /id="status-filter"/);

  const css = read("app/styles/overhaul.css");
  const workbarRule = css.match(/\.workbar\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(workbarRule, /overflow:\s*visible;/);
  assert.match(workbarRule, /position:\s*relative;/);
  assert.match(workbarRule, /z-index:\s*1;/);
  assert.doesNotMatch(workbarRule, /overflow:\s*hidden;/);
});
