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
  // Project is a global control in the topbar; status stays in the run filter row.
  assert.match(topbarSrc, /id="project-filter"/);
  assert.match(topbarSrc, /id="status-filter"/);

  const css = read("app/styles/overhaul.css");
  const workbarRule = css.match(/\.workbar\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

  assert.match(workbarRule, /overflow:\s*visible;/);
  assert.match(workbarRule, /position:\s*relative;/);
  assert.match(workbarRule, /z-index:\s*1;/);
  assert.doesNotMatch(workbarRule, /overflow:\s*hidden;/);
});

test("mobile workbar dropdowns stay inside the viewport while filters are open", () => {
  const selectSrc = read("app/dashboard/ui/select.tsx");
  assert.match(selectSrc, /--select-menu-left/);
  assert.match(selectSrc, /--select-menu-width/);
  assert.match(selectSrc, /clampMenuToViewport/);
  assert.match(selectSrc, /selectMenuViewportPosition/);

  const mobileCss = read("app/styles/mobile.css");
  const openWorkbarRule = mobileCss.match(/\.topbar--workbar\.mobile-filters-open\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";
  assert.match(openWorkbarRule, /height:\s*auto;/);

  const mobileRunsFilterRule = mobileCss.match(/\.runs-workspace-filter\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";
  assert.match(mobileRunsFilterRule, /position:\s*sticky;/);
  assert.match(mobileRunsFilterRule, /top:\s*var\(--topbar-height\);/);
  assert.doesNotMatch(mobileRunsFilterRule, /position:\s*static;/);

  const selectMenuRule = mobileCss.match(/\.select-menu\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";
  assert.match(selectMenuRule, /left:\s*var\(--select-menu-left,\s*0\)\s*!important;/);
  assert.match(selectMenuRule, /right:\s*auto\s*!important;/);
  assert.match(selectMenuRule, /width:\s*var\(--select-menu-width,/);
  assert.doesNotMatch(selectMenuRule, /right:\s*0\s*!important;/);
});

test("expanded mobile filters publish the measured topbar height for sticky offsets", () => {
  const topbarSrc = read("app/dashboard/chrome/topbar.tsx");

  assert.match(topbarSrc, /const topbarRef = useRef<HTMLElement>\(null\)/);
  assert.match(topbarSrc, /new ResizeObserver\(queueSyncHeight\)/);
  assert.match(topbarSrc, /getBoundingClientRect\(\)\.height/);
  assert.match(topbarSrc, /Math\.ceil\(height\)/);
  assert.match(topbarSrc, /ref=\{topbarRef\}/);
});

test("mobile navigation closes without leaving focus inside the hidden drawer", () => {
  const topbarSrc = read("app/dashboard/chrome/topbar.tsx");
  const shellSrc = read("app/dashboard/dashboard-shell.tsx");
  const navSrc = read("app/dashboard/chrome/nav-rail.tsx");

  assert.match(topbarSrc, /data-mobile-menu-button="true"/);
  assert.match(shellSrc, /function closeMobileNav/);
  assert.match(shellSrc, /afterFocus\?: \(\) => void/);
  assert.match(shellSrc, /querySelector<HTMLButtonElement>\('\[data-mobile-menu-button="true"\]'\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(shellSrc, /afterFocus\?\.\(\);/);
  assert.match(shellSrc, /onShortcutHelp=\{\(\) => closeMobileNav\(\{ afterFocus: openShortcutHelp \}\)\}/);
  assert.doesNotMatch(shellSrc, /onShortcutHelp=\{\(\) => \{ closeMobileNav\(\{ restoreFocus: false \}\); openShortcutHelp\(\); \}\}/);
  assert.match(navSrc, /onMobileClose\?\.\(\);\n\s+onSelect\(tabId\);/);
});

test("selected run export is natively disabled when validation has feedback", () => {
  const commandbarSrc = read("app/dashboard/runs/runs-commandbar.tsx");

  assert.match(commandbarSrc, /aria-disabled=\{selectedRunExportDisabled \|\| undefined\}/);
  assert.match(commandbarSrc, /disabled=\{selectedRunExportDisabled \|\| exportSelectedBusy\}/);
  assert.match(commandbarSrc, /selectedRunExportDisabled \? <span className="export-selected-runs-help">\{selectedRunExportTitle\}<\/span> : null/);
});

test("topbar project selector labels the empty project scope as all projects", () => {
  const topbarSrc = read("app/dashboard/chrome/topbar.tsx");
  // The empty scope is the project select's first option.
  assert.match(topbarSrc, /value: "", label: "All projects"/);
  assert.doesNotMatch(topbarSrc, /\{project \|\| "demo"\}/);
});
