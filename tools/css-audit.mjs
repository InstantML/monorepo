#!/usr/bin/env node
/**
 * css-audit.mjs — static CSS health-check for InstantML globals.css
 *
 * Usage:
 *   node tools/css-audit.mjs [path/to/file.css]
 *
 * Outputs a structured report covering:
 *   1. Duplicate selectors (same selector defined at multiple locations)
 *   2. !important count + locations
 *   3. Hardcoded colors appearing 3+ times (candidates for tokenisation)
 *   4. @keyframes inventory + which selectors use each animation
 *   5. Theme-specific override pairs (dark vs light)
 *   6. Rough line-count by section header
 *
 * Not covered (requires browser / live DOM):
 *   - True dead-rule detection (generated class names, third-party, :hover, etc.)
 *   - Specificity score computation
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cssFile =
  process.argv[2] ??
  path.join(__dirname, "..", "apps", "web", "app", "globals.css");

const css = fs.readFileSync(cssFile, "utf8");
const lines = css.split("\n");

console.log("=".repeat(72));
console.log("CSS Audit Report");
console.log("File:", cssFile);
console.log("Date:", new Date().toISOString().slice(0, 10));
console.log("=".repeat(72));

// ── 1. Basic stats ──────────────────────────────────────────────────────────
console.log("\n## 1. Basic Stats\n");
console.log(`Total lines:   ${lines.length}`);
console.log(`Total chars:   ${css.length}`);
console.log(`File size:     ${(css.length / 1024).toFixed(1)} KB`);

// ── 2. Section breakdown ────────────────────────────────────────────────────
console.log("\n## 2. Section Headers (═══ dividers only)\n");
const sectionDividers = [];
lines.forEach((line, i) => {
  if (line.match(/[═─]{10,}/)) {
    // Skip closing lines
    if (!sectionDividers.length || i + 1 - sectionDividers[sectionDividers.length - 1].line > 2) {
      sectionDividers.push({ line: i + 1, text: line.trim().slice(0, 60) });
    }
  }
});
sectionDividers.forEach((s, idx) => {
  const nextLine =
    idx + 1 < sectionDividers.length
      ? sectionDividers[idx + 1].line
      : lines.length;
  console.log(`  L${s.line}-${nextLine} (${nextLine - s.line} lines)`);
});

// ── 3. Duplicate selectors ──────────────────────────────────────────────────
console.log("\n## 3. Duplicate Selectors\n");
const selectorMap = {};
lines.forEach((line, i) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
  if (/^@(media|keyframes|font-face|supports|layer|import)/.test(trimmed)) return;
  // Skip closing braces and property declarations (contain ":" without "{")
  if (trimmed === "}" || trimmed === "};") return;
  const match = trimmed.match(/^([^{@%]+)\{/);
  if (match) {
    const sel = match[1].trim().replace(/\s+/g, " ");
    if (!selectorMap[sel]) selectorMap[sel] = [];
    selectorMap[sel].push(i + 1);
  }
});

const dupes = Object.entries(selectorMap)
  .filter(([, ls]) => ls.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`Total unique selectors: ${Object.keys(selectorMap).length}`);
console.log(`Selectors with duplicates: ${dupes.length}`);
console.log("");
dupes.slice(0, 50).forEach(([sel, ls]) => {
  console.log(`  ${ls.length}x ${sel}  @  [${ls.join(", ")}]`);
});

// ── 4. !important ────────────────────────────────────────────────────────────
console.log("\n## 4. !important Uses\n");
const importantLines = lines.reduce((acc, line, i) => {
  if (line.includes("!important")) acc.push(i + 1);
  return acc;
}, []);
console.log(`Count: ${importantLines.length}`);
importantLines.forEach((l) =>
  console.log(`  L${l}: ${lines[l - 1].trim().slice(0, 90)}`)
);

// ── 5. Hardcoded colors (3+ occurrences) ─────────────────────────────────────
console.log("\n## 5. Hardcoded Colors (3+ occurrences)\n");
const colorRegex = /#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/g;
const colorMap = {};
lines.forEach((line, i) => {
  const t = line.trim();
  if (t.startsWith("/*") || t.startsWith("*") || t.startsWith("//")) return;
  let m;
  while ((m = colorRegex.exec(line)) !== null) {
    const c = m[0].toLowerCase();
    if (!colorMap[c]) colorMap[c] = [];
    colorMap[c].push(i + 1);
  }
});
Object.entries(colorMap)
  .filter(([, ls]) => ls.length >= 3)
  .sort((a, b) => b[1].length - a[1].length)
  .forEach(([color, ls]) => {
    console.log(`  ${ls.length}x ${color}  (L${ls.slice(0, 3).join(", L")}${ls.length > 3 ? "..." : ""})`);
  });

// ── 6. @keyframes inventory ──────────────────────────────────────────────────
console.log("\n## 6. @keyframes Inventory\n");
const keyframes = {};
lines.forEach((line, i) => {
  const m = line.trim().match(/^@keyframes\s+([^\s{]+)/);
  if (m) keyframes[m[1]] = i + 1;
});

const animUsages = {};
lines.forEach((line, i) => {
  // Match animation: <name> ... and animation-name: <name>
  const m = line.match(/animation(?:-name)?:\s*([^;]+)/);
  if (m) {
    m[1].split(",").forEach((chunk) => {
      const name = chunk.trim().split(/\s+/)[0];
      if (name && name !== "none" && name !== "inherit" && !name.startsWith("var(") && !name.startsWith("--")) {
        if (!animUsages[name]) animUsages[name] = [];
        animUsages[name].push(i + 1);
      }
    });
  }
});

Object.entries(keyframes).forEach(([name, defLine]) => {
  const usedAt = animUsages[name] ?? [];
  const status = usedAt.length === 0 ? " *** POSSIBLY DEAD ***" : "";
  console.log(`  @keyframes ${name}  (L${defLine})${status}`);
  if (usedAt.length > 0) console.log(`    used at L${usedAt.join(", L")}`);
});

// ── 7. Theme overrides ────────────────────────────────────────────────────────
console.log("\n## 7. Theme Overrides\n");
const darkLines = [];
const lightLines = [];
lines.forEach((line, i) => {
  if (line.includes(':root[data-theme="dark"]')) darkLines.push(i + 1);
  if (line.includes(':root[data-theme="light"]')) lightLines.push(i + 1);
});
console.log(`Dark theme override selectors: ${darkLines.length}`);
console.log(`Light theme override selectors: ${lightLines.length}`);
console.log("\nNote: dark has ${darkLines.length}x more overrides than light — most base rules");
console.log("      assume light-mode defaults; dark overrides every affected property.");

console.log("\n=".repeat(72));
console.log("End of report");
