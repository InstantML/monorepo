import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { workspaceViewFromPayload, workspaceViewSummariesFromPayload } from "../src/workspace-view-api.js";

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
  const invite = readFileSync(`${root}app/invite/page.tsx`, "utf8");
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  // globals.css is now a thin @import chain; rules live in styles/*.css.
  // The nav-label rule was moved to styles/overhaul.css during the 2026-05-18
  // globals-css-audit refactor. See docs/design/2026-05-18-globals-css-audit.md.
  const css = readFileSync(`${root}app/styles/overhaul.css`, "utf8");

  assert.match(authFlow, /payload\.mode === "signin"/, "dev sign-in should preserve the requested next dashboard route when storage is ready");
  assert.match(authFlow, /postAuthRedirectPath\(sessionPayload, nextPath\)/, "dev sign-in should send unready storage sessions back to onboarding before dashboard");
  assert.match(shell, /postAuthRedirectPath\(session, window\.location\.pathname \|\| "\/dashboard\/runs"\)/, "direct dashboard loads should redirect unready storage sessions to onboarding");
  assert.match(invite, /postAuthRedirectPath\(payload, "\/dashboard\/runs"\)/, "accepted invitations should not bypass storage onboarding");
  assert.match(authFlow, /StorageSetupPending/, "onboarding should block SDK-key creation while hosted storage is still provisioning");
  assert.match(authFlow, /StorageSetupBlocked/, "unready BYOC member sessions should not render the owner/admin ClickHouse form");
  assert.match(authFlow, /role === "owner" \|\| role === "admin"/, "only owners/admins should manage workspace storage from onboarding");
  assert.match(authFlow, /useState\("personal"\)/, "signup should default to the personal workspace account type");
  assert.match(authFlow, /> Personal</, "signup should label the one-seat path as Personal, not legacy Customer");
  assert.match(authFlow, /accountType === "business" \? "Organization" : "Workspace"/, "personal signup should label the name field as a workspace");

  assert.match(shell, /userTouchedDashboardFiltersRef/, "dashboard should track local filter edits while preferences load");
  assert.match(
    shell,
    /names\.includes\(selectedProject\) && !userTouchedDashboardFiltersRef\.current/,
    "stale saved project preferences must not overwrite a project the user just picked",
  );
  assert.match(shell, /projectPreferenceReady/, "dashboard runs should wait for project preferences before initial load");
  assert.match(shell, /if \(!dashboardAuthorized \|\| !projectPreferenceReady\) return;/, "initial dashboard load should not race the persisted project preference");
  assert.match(shell, /previousOrgIdRef/, "org switches should invalidate cached project preferences");
  assert.match(shell, /\}, \[activeOrgId, dashboardAuthorized, loadProjects\]\);/, "project preference loading should be keyed by org, not saved-view scope changes");
  assert.match(shell, /if \(queryInput === query\) return undefined;/, "search debounce should avoid duplicate stale loads for unchanged queries");
  assert.match(shell, /resetRunPagination\(\);\s*setQuery\(queryInput\);/s, "pagination should reset once when debounced search commits");
  const queryInputHandler = shell.match(/const changeRunQueryInput = useCallback\([\s\S]*?\}, \[\]\);/)?.[0] ?? "";
  assert.doesNotMatch(queryInputHandler, /resetRunPagination\(\);/, "typing in the search box should not reset pagination before the debounced query exists");
  assert.match(shell, /setSavedViewKey\(option\.value\)/, "saving a view should optimistically select the saved option");
  assert.match(shell, /localSavedViewProjectScope/, "local fallback view keys should include the active project scope");
  assert.match(shell, /project \|\| "all"/, "all-project local fallback views should get an explicit project scope");
  assert.match(shell, /localSavedViewKey\(name, localSavedViewProjectScope\)/, "local fallback view saves should use scoped keys");
  assert.match(shell, /scopedWorkspaceStorageKey/, "workspace layout storage should be scoped by active org/user/project");
  assert.match(shell, /workspaceStorageKey\(project, localSavedViewScope \? localSavedViewProjectScope : ""\)/, "workspace layouts should not share one project-only key across users");
  assert.match(shell, /legacyWorkspaceStorageKeys\(project, activeOrgId\)/, "authenticated workspace layout loads should migrate old org/project layout keys into the scoped key");
  assert.match(shell, /upsertOption\(\{ label: name, source: "control"/, "control-plane view saves should appear without a reload");
  assert.match(shell, /upsertOption\(\{ label: name, source: "local"/, "local fallback view saves should appear without a reload");
  assert.equal(/ADVANCED_REDUCERS_VIEW_KEY/.test(shell), false, "advanced reducer preset should be removed with the Advanced tab");
  assert.equal(/selectTab\("advanced"\)/.test(shell), false, "advanced route should not be opened from saved views");
  assert.match(shell, /setOrgSwitchError\(detail\);[\s\S]*?setMessage\(detail\);/, "failed workspace switches should remain visible after the menu closes");
  assert.match(shell, /metricCatalogSelectionIds/, "metric catalog counts should use the effective chart run scope");
  assert.match(shell, /selectedRunIds\.length \? selectedRunIds : sortedRuns\.map/, "no explicit run selection should count visible runs as selected for metrics");
  assert.match(shell, /migrateLegacySavedViewsToScope\(activeOrgId, localSavedViewProjectScope\)/, "legacy local saved views should migrate into the active org/user/project scope");
  assert.match(shell, /safeCheckoutRedirectUrl\(payload\?\.billing_checkout\?\.url\)/, "workspace creation checkout URLs should use the shared redirect allowlist");
  assert.match(shell, /if \(payload\?\.billing_checkout\?\.url\) throw new Error\("Billing checkout URL was not trusted\."\);/, "untrusted workspace creation checkout URLs should not be opened");
  assert.match(shell, /if \(payload\?\.checkout\?\.url\) throw new Error\("Billing checkout URL was not trusted\."\);/, "untrusted plan-change checkout URLs should not be opened");
  assert.match(shell, /if \(payload\?\.checkout\) \{[\s\S]*?Retry from billing settings/, "checkout failures should leave a retry path in settings");
  assert.match(shell, /selectedFetchRunKey/, "metric-series fetches should wait for selected run details to resolve");
  assert.match(shell, /const runsForFetch = metricSeriesRuns;/, "metric-series fetches should use selected runs or visible runs when no explicit selection exists");
  assert.match(shell, /useLayoutEffect\(\(\) => \{[\s\S]*dashboardSelectionFilterKeyRef\.current = dashboardSelectionFilterKey/, "selection filter guard should update before synchronous select-all interactions");
  assert.match(shell, /api\.get\(`\/runs\/\$\{id\}`, \{ signal: controller\.signal \}\)/, "off-page selected run hydration should be abortable");
  assert.match(shell, /runWithConcurrency\(tasks, 6\)/, "off-page selected run hydration should cap API fanout");
  assert.match(shell, /compareArtifactCacheRef/, "compare artifacts should reuse already-fetched run artifacts");
  assert.match(shell, /compareArtifactInflightRef/, "compare artifacts should dedupe concurrent per-run requests");
  assert.match(shell, /\}, \[activeTab, api, compareRunKey, runMetadataVersion\]\);/, "compare artifact cache invalidation should restart the compare artifact load");
  assert.match(shell, /inFlight\.signal === controller\.signal && !inFlight\.signal\.aborted/, "compare artifact in-flight reuse should not reuse aborted requests from old selections");
  assert.match(shell, /compareArtifactInflightRef\.current\.get\(runId\) === entry/, "settled older artifact requests must not delete newer in-flight promises");
  assert.match(shell, /if \(queryInput !== query\) \{[\s\S]*setQuery\(queryInput\);[\s\S]*Select matching runs again[\s\S]*return;/, "select-all matching should not run against a stale debounced search query");
  assert.match(shell, /function searchErrorFromApi\(error: unknown, query: string\): RunSearchError \| null/, "dashboard should only surface allowlisted structured run-search errors");
  assert.match(shell, /setSearchError\(nextSearchError\);[\s\S]*setMessage\(previousMessage\);[\s\S]*return;/, "invalid run-search loads should keep the last valid results and message");
  assert.match(shell, /searchError=\{searchError\}/, "topbar should receive committed-query search validation state");
  assert.match(shell, /selectAllMatchingDisabled=\{queryInput !== query \|\| Boolean\(searchError && searchError\.query === query\)\}/, "bulk selection should stay disabled for stale or invalid committed searches");
  const artifactLoadEffect = shell.match(/async function loadArtifacts\(\)[\s\S]*?\}, \[[^\]]+\]\);/)?.[0] ?? "";
  assert.doesNotMatch(artifactLoadEffect, /runWorkspaceTab/, "artifact loads should not refetch on summary/data/files subtab changes");
  assert.match(shell, /artifactsRunId === primaryRun\?\.id/, "artifact rows should be keyed to the selected run before rendering checkpoint fork actions");
  assert.match(shell, /checkpointForkIdempotencyKey\(artifact, primaryRun, body\)/, "checkpoint fork retries should reuse a stable idempotency key for the same body");
  assert.match(shell, /artifact\.run_id && artifact\.run_id !== primaryRun\.id/, "checkpoint fork actions should reject stale artifact/run pairings");

  const runWorkspace = readFileSync(`${root}app/dashboard/components/run-workspace.tsx`, "utf8");
  assert.match(runWorkspace, /const visibleLineage = lineage\?\.run\?\.id === run\.id \? lineage : null;/, "lineage UI should not render stale graph payloads after switching runs");
  assert.match(runWorkspace, /setLineage\(null\);[\s\S]*api\.get\(`\/api\/runs\/\$\{run\.id\}\/lineage`/, "lineage fetches should clear prior graph state before loading a new run");

  const runDetail = readFileSync(`${root}app/dashboard/detail/run-detail.tsx`, "utf8");
  assert.match(runDetail, /\["_rlobs", "source", "git", "commit"\]/, "run detail source panel should read SDK privacy-safe git metadata");

  const quickSearch = readFileSync(`${root}app/dashboard/chrome/quick-search.tsx`, "utf8");
  assert.match(quickSearch, /className="workspace-modal command-modal"/, "quick search should keep a full-screen backdrop");
  assert.match(quickSearch, /onMouseDown=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?\}\}/, "backdrop mouse-down should stop click-through before closing");
  assert.match(quickSearch, /onClick=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?onClose\(\);[\s\S]*?\}\}/, "backdrop click should close after swallowing the page click");
  assert.equal(/onMouseDown=\{\(event\)[\s\S]{0,240}onClose\(\)/.test(quickSearch), false, "mouse-down must not close before the paired click is swallowed");

  const runsWorkspace = readFileSync(`${root}app/dashboard/runs/runs-workspace.tsx`, "utf8");
  assert.match(runsWorkspace, /const showSelectAllMatching = matchingOverflow;/, "overflowed result sets should offer bulk select even when no rows are selected");
  assert.match(runsWorkspace, /disabled=\{selectAllMatchingBusy \|\| selectAllMatchingDisabled\}/, "select-all matching should honor invalid-search disabled state");
  assert.match(runsWorkspace, /pointerDragCleanupRef/, "pointer drag listeners should be cleaned up on unmount or interrupted drag");
  assert.match(runsWorkspace, /removeEventListener\("pointercancel"/, "pointer drag cleanup should remove cancellation listeners");

  const topbar = readFileSync(`${root}app/dashboard/chrome/topbar.tsx`, "utf8");
  assert.match(topbar, /workbar-search-popover/, "run search should include syntax help beside the actual search box");
  assert.match(topbar, /aria-invalid=\{Boolean\(searchError && !searchErrorStale\)\}/, "search syntax errors should be associated with the input without marking stale edits invalid");

  const workspacePanelCard = readFileSync(`${root}app/dashboard/runs/workspace-panel-card.tsx`, "utf8");
  assert.match(workspacePanelCard, /resizeCleanupRef/, "panel resize listeners should be cleaned up on unmount or interrupted resize");
  assert.match(workspacePanelCard, /addEventListener\("pointercancel"/, "panel resize should handle pointer cancellation");
  assert.match(workspacePanelCard, /hoverFrameRef/, "workspace panel chart hover should be animation-frame throttled for dense selections");
  assert.match(workspacePanelCard, /cancelAnimationFrame\(hoverFrameRef\.current\)/, "workspace panel chart hover should cancel pending work on leave/unmount");

  const metricChart = readFileSync(`${root}app/dashboard/metrics/metric-chart.tsx`, "utf8");
  assert.doesNotMatch(metricChart, /visibleHover\s*=\s*denseChart\s*\?\s*null/, "dense canvas charts should keep hover marker and tooltip rendering");
  assert.doesNotMatch(metricChart, /onMouseMove=\{denseChart\s*\?\s*undefined\s*:\s*onMove\}/, "dense canvas charts should keep the SVG hover hit target");

  const distributedPane = readFileSync(`${root}app/dashboard/distributed/tab-pane.tsx`, "utf8");
  assert.doesNotMatch(distributedPane, /if \(!rankKey && next\.key\) setRankKey\(next\.key\)/, "rank metrics should not double-fetch the server default key");
  assert.match(distributedPane, /function changeRankKey[\s\S]*setSummary\(null\)/, "rank-key changes should clear old reducer data before relabeling charts");

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
  assert.match(topbar, /useFocusTrap<HTMLDivElement>\(true, onClose, "input\[name='workspace-name'\]"\)/, "create modal should initially focus the workspace name field");
  assert.match(topbar, /kind === "personal" \? "Workspace name" : "Organization name"/, "personal creation should use workspace-oriented copy");
  assert.match(topbar, /initial_invitations: invitesAllowed && inviteEmail\.trim\(\)/, "personal workspace creation should not submit teammate invitations");
  assert.match(topbar, /> New workspace</, "menu action should match the mixed personal/org creation modal");
  assert.equal(/account-workspace-list" role="listbox"/.test(topbar), false, "account workspace menu should not claim listbox semantics without arrow-key handling");
  assert.match(css, /\.account-workspace-search:focus-within/, "account workspace search should have a visible keyboard focus state");
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.account-workspace-current \{[\s\S]*?display: block;/, "mobile account trigger should keep the current workspace visible");
});

test("workspace view API normalizes generated and legacy envelopes", () => {
  const normalizer = readFileSync(`${root}src/workspace-view-api.js`, "utf8");
  const typedWrapper = readFileSync(`${root}app/dashboard/state/workspace-view-api.ts`, "utf8");
  const generated = readFileSync(`${root}src/types/api.generated.ts`, "utf8");
  const row = { id: "view-1", name: "Research", project: "demo", created_at: "now", updated_at: "now", payload: { metricKey: "loss" } };

  assert.match(generated, /WorkspaceViewEnvelope: \{\s*workspace_view:/, "generated OpenAPI type exposes runtime singular workspace_view envelope");
  assert.match(generated, /WorkspaceViewSummariesEnvelope: \{[\s\S]*next_cursor\?:[\s\S]*workspace_views:/, "generated OpenAPI type exposes runtime workspace_views envelope and cursor");
  assert.match(typedWrapper, /components\["schemas"\]\["WorkspaceViewSummary"\]/, "typed wrapper should keep generated summary row linkage");
  assert.match(typedWrapper, /components\["schemas"\]\["WorkspaceViewRow"\]/, "typed wrapper should keep generated row linkage");
  assert.match(normalizer, /workspace_views/, "normalizer should accept runtime list envelopes");
  assert.match(normalizer, /\.views/, "normalizer should preserve compatibility with generated legacy list envelopes");
  assert.match(normalizer, /workspace_view/, "normalizer should accept runtime row envelopes");
  assert.match(normalizer, /\.view/, "normalizer should preserve compatibility with generated legacy row envelopes");
  assert.deepEqual(workspaceViewSummariesFromPayload({ workspace_views: [row, { id: 2, name: "bad" }] }), [row]);
  assert.deepEqual(workspaceViewSummariesFromPayload({ views: [row] }), [row]);
  assert.deepEqual(workspaceViewFromPayload({ workspace_view: row }), row);
  assert.deepEqual(workspaceViewFromPayload({ view: row }), row);
  assert.equal(workspaceViewFromPayload({ view: { id: "bad", name: "Bad", payload: [] } }), null);
});

test("API key UI does not expose admin controls to read-only members", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const apiPane = readFileSync(`${root}app/dashboard/api/tab-pane.tsx`, "utf8");

  assert.match(shell, /!activeOrgId \|\| !canManageOrg/, "dashboard should skip API-key loads for non-admin members");
  assert.match(shell, /if \(!activeOrgId \|\| !canManageOrg\) \{[\s\S]*?API key management is available to workspace admins\.[\s\S]*?return;[\s\S]*?\}[\s\S]*setAdminBusy\(true\);[\s\S]*Creating API key/, "API-key create handler should reject non-admin invocation");
  assert.match(shell, /if \(!activeOrgId \|\| !keyId \|\| !canManageOrg\) \{[\s\S]*?API key management is available to workspace admins\.[\s\S]*?return;[\s\S]*?\}[\s\S]*setAdminBusy\(true\);[\s\S]*Revoking API key/, "API-key revoke handler should reject non-admin invocation");
  assert.match(shell, /canManageOrg=\{canManageOrg\}/, "API tab should receive membership capabilities");
  assert.match(apiPane, /PageHead eyebrow=\{canManageOrg \? "Admin" : "Read-only"\}/, "API tab should label read-only access");
  assert.match(apiPane, /const visibleApiKeys = canManageOrg \? apiKeys : \[\];/, "API tab should hide stale key rows from read-only members");
  assert.match(apiPane, /const visibleNewApiKey = canManageOrg \? newApiKey : "";/, "API tab should hide stale copy-once keys from read-only members");
  assert.match(apiPane, /\{canManageOrg \? \(/, "API-key creation controls should be gated");
  assert.match(apiPane, /disabled=\{adminBusy \|\| !canManageOrg\}/, "manual API-key refresh should be disabled for read-only members");
  assert.match(apiPane, /\{canManageOrg \? \([\s\S]*?onRevokeApiKey/, "API-key revoke controls should be gated");
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
  assert.match(settings, /Retry Pro/, "Settings should expose a retry action for failed Pro checkout");
  assert.match(settings, /Retry Premium/, "Settings should expose a retry action for failed Premium checkout");
});
