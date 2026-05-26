import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The UI overhaul centralised browser-persistence keys into
// app/dashboard/state/storage-keys.ts. These literals are a stable contract:
// users' saved views / workspace layouts / theme are addressed by these exact
// strings. This guard fails loudly if a refactor ever drifts them.

const root = fileURLToPath(new URL("../", import.meta.url));
const storageKeys = readFileSync(`${root}app/dashboard/state/storage-keys.ts`, "utf8");

const REQUIRED = {
  THEME_KEY: "instantml:next:theme",
  NAV_PINNED_KEY: "instantml:next:nav-pinned",
  RUNS_RAIL_COLLAPSED_KEY: "instantml:next:runs-rail-collapsed",
  SAVED_VIEW_PREFIX: "instantml:next:local:view:",
  LEGACY_SAVED_VIEW_PREFIX: "instantml:next:view:",
  WORKSPACE_VIEW_PREFIX: "instantml:next:local:workspace:",
};

test("storage-keys preserves the exact persistence-key contract", () => {
  for (const [name, value] of Object.entries(REQUIRED)) {
    assert.match(
      storageKeys,
      new RegExp(`export const ${name} = "${value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`),
      `${name} must remain "${value}" — renaming it silently invalidates persisted user state`,
    );
  }
});

test("shell + models no longer redeclare raw persistence-key literals", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const models = readFileSync(`${root}app/dashboard-models.ts`, "utf8");
  // The literal strings should now live only in storage-keys.ts. The shell may
  // still reference savedView label-stripping inline, but must not re-declare
  // the theme / nav / rail / view-prefix consts.
  assert.equal(/const\s+THEME_KEY\s*=/.test(shell), false, "shell must import THEME_KEY, not redeclare it");
  assert.equal(/const\s+SAVED_VIEW_PREFIX\s*=/.test(shell), false, "shell must import SAVED_VIEW_PREFIX, not redeclare it");
  assert.equal(/const\s+WORKSPACE_VIEW_PREFIX\s*=/.test(models), false, "models must import WORKSPACE_VIEW_PREFIX, not redeclare it");
});

test("workspace model accepts the revised panel schema and non-line types", () => {
  const models = readFileSync(`${root}app/dashboard-models.ts`, "utf8");
  const types = readFileSync(`${root}app/dashboard-types.ts`, "utf8");
  assert.match(models, /WORKSPACE_SCHEMA_VERSION\s*=\s*2/, "workspace schema should migrate to v2");
  assert.match(types, /WorkspacePanelType\s*=\s*"line"\s*\|\s*"bar"\s*\|\s*"histogram"\s*\|\s*"dot"/, "panel types should include the first non-line chart set");
  assert.match(models, /panel\.type !== "line"/, "only line panels should fetch full metric series");
});

test("dashboard shell protects control-plane state from stale UI interactions", () => {
  const authFlow = readFileSync(`${root}app/auth-flow.tsx`, "utf8");
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  // globals.css is now a thin @import chain; rules live in styles/*.css.
  // The nav-label rule was moved to styles/overhaul.css during the 2026-05-18
  // globals-css-audit refactor. See docs/design/2026-05-18-globals-css-audit.md.
  const css = readFileSync(`${root}app/styles/overhaul.css`, "utf8");

  assert.match(authFlow, /payload\.mode === "signin"/, "dev sign-in should preserve the requested next dashboard route");
  assert.match(authFlow, /window\.location\.assign\(nextPath\)/, "dev sign-in must not bounce returning users through onboarding");
  assert.match(authFlow, /useState\("personal"\)/, "signup should default to the personal workspace account type");
  assert.match(authFlow, /> Personal</, "signup should label the one-seat path as Personal, not legacy Customer");
  assert.match(authFlow, /accountType === "business" \? "Organization" : "Workspace"/, "personal signup should label the name field as a workspace");

  assert.match(shell, /userTouchedDashboardFiltersRef/, "dashboard should track local filter edits while preferences load");
  assert.match(
    shell,
    /names\.includes\(selectedProject\) && !userTouchedDashboardFiltersRef\.current/,
    "stale saved project preferences must not overwrite a project the user just picked",
  );
  assert.match(shell, /setSavedViewKey\(option\.value\)/, "saving a view should optimistically select the saved option");
  assert.match(shell, /upsertOption\(\{ label: name, source: "control"/, "control-plane view saves should appear without a reload");
  assert.match(shell, /upsertOption\(\{ label: name, source: "local"/, "local fallback view saves should appear without a reload");
  assert.match(shell, /ADVANCED_REDUCERS_VIEW_KEY\s*=\s*"system:advanced-reducers"/, "advanced reducer preset should be a built-in view, not the default route");
  assert.match(shell, /selectTab\("advanced"\)/, "advanced reducer preset should open the advanced route");

  const quickSearch = readFileSync(`${root}app/dashboard/chrome/quick-search.tsx`, "utf8");
  assert.match(quickSearch, /className="workspace-modal command-modal"/, "quick search should keep a full-screen backdrop");
  assert.match(quickSearch, /onMouseDown=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?\}\}/, "backdrop mouse-down should stop click-through before closing");
  assert.match(quickSearch, /onClick=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?onClose\(\);[\s\S]*?\}\}/, "backdrop click should close after swallowing the page click");
  assert.equal(/onMouseDown=\{\(event\)[\s\S]{0,240}onClose\(\)/.test(quickSearch), false, "mouse-down must not close before the paired click is swallowed");

  const runsWorkspace = readFileSync(`${root}app/dashboard/runs/runs-workspace.tsx`, "utf8");
  assert.match(runsWorkspace, /const showSelectAllMatching = matchingOverflow;/, "overflowed result sets should offer bulk select even when no rows are selected");

  assert.match(css, /\.shell:not\(\.nav-pinned\) \.tab-label \{[\s\S]*?max-width: 0;[\s\S]*?opacity: 0;/, "collapsed nav labels should stay hidden instead of intercepting run controls");
});

test("settings seat summary falls back to org membership metadata for read-only users", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");

  assert.match(shell, /activeMembershipSummary/, "dashboard should retain the current membership summary");
  assert.match(
    shell,
    /activeUsageOrg\?\.usage\?\.seats \?\? activeMembershipSummary\?\.member_count \?\? seats\.length/,
    "read-only users should see the active member count instead of a misleading 0 seats when seat details are admin-only",
  );
});

test("workspace creation UI keeps the active workspace visible and waits for availability", () => {
  const topbar = readFileSync(`${root}app/dashboard/chrome/topbar.tsx`, "utf8");
  const css = readFileSync(`${root}app/styles/overhaul.css`, "utf8");

  assert.match(topbar, /availability\?\.available === true && availability\.checkedName === trimmedName/, "create-workspace should wait for positive availability for the current name before submit");
  assert.match(topbar, /disabled=\{busy \|\| personalBlocked \|\| !trimmedName \|\| !nameAvailable\}/, "create button should stay disabled while availability is unknown");
  assert.match(topbar, /kind === "personal" \? "Workspace name" : "Organization name"/, "personal creation should use workspace-oriented copy");
  assert.match(topbar, /> New workspace</, "menu action should match the mixed personal/org creation modal");
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.account-workspace-current \{[\s\S]*?display: block;/, "mobile account trigger should keep the current workspace visible");
});

test("dashboard plan usage surfaces API request usage", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const settings = readFileSync(`${root}app/dashboard/settings/tab-pane.tsx`, "utf8");
  const topbar = readFileSync(`${root}app/dashboard/chrome/topbar.tsx`, "utf8");

  assert.match(shell, /activeUsage\.api_requests/, "dashboard shell should read API request usage");
  assert.match(shell, /activeLimits\.api_requests/, "dashboard shell should read API request limits");
  assert.match(settings, /API requests this month/, "Settings should show API request usage");
  assert.match(settings, /aria-label="API request usage"/, "Settings should expose an API request usage meter");
  assert.match(settings, /General API rate/, "Settings should show the per-second general rate policy");
  assert.match(settings, /Ingest API rate/, "Settings should show the per-second ingest rate policy");
  assert.match(settings, /Monthly reset/, "Settings should show monthly reset timing");
  assert.match(topbar, /apiRequestPercent/, "topbar plan badge should include API request pressure");
});
