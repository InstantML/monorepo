import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

import { metricFieldId, objectFieldId, parseFieldId } from "../src/dashboard-panels.js";
import { workspaceViewFromPayload, workspaceViewSummariesFromPayload } from "../src/workspace-view-api.js";

// The UI overhaul centralised browser-persistence keys into
// app/dashboard/state/storage-keys.ts. These literals are a stable contract:
// users' saved views / workspace layouts / theme are addressed by these exact
// strings. This guard fails loudly if a refactor ever drifts them.

const root = fileURLToPath(new URL("../", import.meta.url));
const storageKeys = readFileSync(`${root}app/dashboard/state/storage-keys.ts`, "utf8");

async function importDashboardModelsForTest() {
  const tempDir = mkdtempSync(join(tmpdir(), "instantml-dashboard-models-"));
  const storageModulePath = join(tempDir, "storage-keys.mjs");
  const modelsModulePath = join(tempDir, "dashboard-models.mjs");
  writeFileSync(storageModulePath, `export const WORKSPACE_VIEW_PREFIX = ${JSON.stringify(REQUIRED.WORKSPACE_VIEW_PREFIX)};\n`);
  const compiled = ts.transpileModule(readFileSync(`${root}app/dashboard-models.ts`, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
    .replace(/from "\.\.\/src\/api\.js"/g, `from ${JSON.stringify(pathToFileURL(`${root}src/api.js`).href)}`)
    .replace(/from "\.\.\/src\/dashboard-panels\.js"/g, `from ${JSON.stringify(pathToFileURL(`${root}src/dashboard-panels.js`).href)}`)
    .replace(/from "\.\.\/src\/state\.js"/g, `from ${JSON.stringify(pathToFileURL(`${root}src/state.js`).href)}`)
    .replace(/from "\.\/dashboard\/state\/storage-keys"/g, `from ${JSON.stringify(pathToFileURL(storageModulePath).href)}`);
  writeFileSync(modelsModulePath, compiled);
  try {
    return await import(`${pathToFileURL(modelsModulePath).href}?t=${Date.now()}`);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

const REQUIRED = {
  THEME_KEY: "instantml:next:theme",
  // v2 migration (2026-06): the v1 key was auto-written "false" by the old
  // unpinned default, so it cannot distinguish an explicit unpin.
  NAV_PINNED_KEY: "instantml:next:nav-pinned-v2",
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
  const editDrawer = readFileSync(`${root}app/dashboard/runs/panel-edit-drawer.tsx`, "utf8");
  const runsWorkspace = readFileSync(`${root}app/dashboard/runs/runs-workspace.tsx`, "utf8");
  assert.match(models, /WORKSPACE_SCHEMA_VERSION\s*=\s*2/, "workspace schema should migrate to v2");
  assert.match(models, /export const WORKSPACE_PANEL_TYPES:[\s\S]*"distribution"[\s\S]*"histogram_timeline"/, "workspace chart type options should have one exported source of truth");
  assert.doesNotMatch(models, /WORKSPACE_PANEL_TYPES:[\s\S]*"parallel"/, "parallel coordinates should stay in Insights, not saved Runs workspace panels");
  assert.match(types, /\|\s*"scatter"[\s\S]*\|\s*"distribution"[\s\S]*\|\s*"histogram_timeline"/, "panel types should include the saved second-slice research charts");
  assert.match(types, /type: "scatter";[\s\S]*xField: string;[\s\S]*yField: string;/, "scatter panels should require explicit numeric field references");
  assert.match(types, /type: "distribution";[\s\S]*valueField: string;[\s\S]*groupField\?: string;[\s\S]*replicateField\?: string;/, "distribution panels should persist value, group, and replicate fields");
  assert.doesNotMatch(types, /type: "parallel"/, "parallel coordinates should not be part of the saved Runs workspace schema");
  assert.match(types, /type: "histogram_timeline";[\s\S]*objectKey: string;/, "logged histogram timeline panels should persist an explicit object key");
  assert.match(types, /type: "bar" \| "histogram" \| "dot";[\s\S]*xField\?: never;[\s\S]*yField\?: never;/, "summary panels should reject scatter-only fields at the type layer");
  assert.match(types, /WorkspaceFieldSource\s*=\s*"metric"\s*\|\s*"config"\s*\|\s*"metadata"\s*\|\s*"run"/, "workspace field options should expose literal field sources");
  assert.match(types, /valueType: "number";/, "workspace field options should stay numeric-only until another field type is designed");
  assert.match(models, /panel\.type === "line"/, "only line panels should fetch full metric series");
  assert.match(models, /type === "distribution"[\s\S]*sanitizeCategoricalFieldRef/, "distribution panels should validate categorical fields during migration");
  assert.match(models, /type === "histogram_timeline"[\s\S]*sanitizeObjectKey/, "logged histogram panels should validate object keys during migration");
  assert.match(models, /parseFieldId\(field\) \? field : undefined/, "persisted scatter field references should be semantically validated");
  assert.match(editDrawer, /defaultScatterFields\(panel\.metricKey, fieldOptions\)/, "scatter edit defaults should use one parser-safe field helper");
  assert.doesNotMatch(editDrawer, /FieldId\s*=[^;\n]*""/, "scatter edit defaults should not fall back to an empty field id");
  assert.match(editDrawer, /WORKSPACE_PANEL_TYPES\.map/, "edit drawer chart options should use the shared panel type list");
  assert.match(editDrawer, /Value field[\s\S]*Group field[\s\S]*Replicate field/, "distribution edit controls should expose value, group, and replicate fields");
  assert.doesNotMatch(editDrawer, /Axis \$\{index \+ 1\}|axisFields|axisScales/, "Runs workspace edit controls should not expose parallel-coordinate axes");
  assert.match(editDrawer, /Histogram object key/, "logged histogram edit controls should expose explicit object keys");
  assert.match(runsWorkspace, /WORKSPACE_PANEL_TYPES\.map/, "add-panel chart options should use the shared panel type list");
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  assert.match(shell, /mergeFreshRecord\(primary\.metric_aggregates, fallback\.metric_aggregates\)/, "richer selected runs should preserve cached metric aggregates while fresh values win");
  assert.match(shell, /return primary;/, "run summary merges should avoid new object allocation when fallback data adds nothing");
});

test("runs workspace panel drawer remains reachable on mobile", () => {
  const mobileCss = readFileSync(`${root}app/styles/mobile.css`, "utf8");
  const drawerRule = mobileCss.match(/\.panel-drawer,\s*\n\s*\.runs-workspace\.drawer-open \.panel-drawer\s*\{(?<body>[\s\S]*?)\n\s*\}/)?.groups?.body ?? "";
  assert.match(drawerRule, /position:\s*fixed;/, "mobile add-panel drawer should render as a fixed bottom sheet");
  assert.match(drawerRule, /inset:\s*auto 0 0 0;/, "mobile add-panel drawer should be anchored to the viewport bottom");
  assert.match(drawerRule, /max-height:\s*86vh;/, "mobile add-panel drawer should stay inside the viewport");
});

test("logged histogram and eval previews keep bounded object-only contracts", () => {
  const models = readFileSync(`${root}app/dashboard-models.ts`, "utf8");
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const card = readFileSync(`${root}app/dashboard/runs/workspace-panel-card.tsx`, "utf8");
  const richObjectPanel = readFileSync(`${root}app/dashboard/detail/rich-object-panel.tsx`, "utf8");

  assert.match(models, /workspacePanelNeedsMetricSeries[\s\S]*panel\.type === "line"/, "only line workspace panels should fetch metric series");
  assert.match(shell, /WORKSPACE_HISTOGRAM_TIMELINE_LIMIT\s*=\s*3/, "logged histogram timelines should cap visible object-key requests");
  assert.match(shell, /function workspaceHistogramObjectKeys[\s\S]*section\.collapsed[\s\S]*slice\(0, 12\)/, "histogram timeline fetch keys should come from rendered, non-collapsed workspace panels");
  assert.match(shell, /workspaceHistogramKeys\.slice\(WORKSPACE_HISTOGRAM_TIMELINE_LIMIT\)[\s\S]*capped: true/, "histogram timeline panels beyond the visible request cap should get an explicit capped state");
  assert.match(shell, /kind: "histogram"[\s\S]*key: objectKey[\s\S]*limit: 100/, "histogram timelines should use selected-run bounded object reads");
  assert.match(card, /timeline\?\.capped[\s\S]*first 3 visible logged histogram timelines[\s\S]*Compatible bins[\s\S]*Latest frame: bins changed/, "histogram timelines should render capped states, compatible-bin heatmaps, and incompatible-bin fallbacks");
  assert.match(richObjectPanel, /object\.kind === "classification_eval"[\s\S]*ClassificationEvalPreview/, "classification eval objects should have a rich-object preview");
  assert.match(richObjectPanel, /CurveSparkline label="PR"[\s\S]*CurveSparkline label="ROC"[\s\S]*eval-confusion/, "classification eval previews should show PR, ROC, and confusion matrix views");
});

test("workspace sanitizer round-trips scatter panels and keeps non-scatter migration compatible", async () => {
  const models = await importDashboardModelsForTest();
  const yField = metricFieldId("eval/return_mean", "best");
  const sanitized = models.sanitizeWorkspaceView({
    schemaVersion: 1,
    id: "workspace-scatter",
    name: "Scatter workspace",
    mode: "manual",
    project: "demo",
    settings: { maxRuns: 99, hideEmptySections: true, sectionOrganization: "manual" },
    sections: [{
      id: "section-a",
      name: "Charts",
      panels: [
        {
          id: "scatter-a",
          type: "scatter",
          title: "Return scatter",
          metricKey: "eval/return_mean",
          xField: "run:duration_seconds",
          yField,
          settings: { maxRuns: 99 },
        },
        {
          id: "line-a",
          type: "line",
          title: "Loss",
          metricKey: "train/loss",
          layout: { w: 12, h: 3 },
          xField: "run:duration_seconds",
          yField,
        },
        {
          id: "scatter-invalid",
          type: "scatter",
          title: "Invalid scatter",
          metricKey: "train/loss",
          xField: "",
          yField: "not-a-field",
        },
        {
          id: "scatter-bad-pointer",
          type: "scatter",
          title: "Bad pointer",
          metricKey: "train/loss",
          xField: "config:foo",
          yField,
        },
        {
          id: "scatter-bad-encoding",
          type: "scatter",
          title: "Bad encoding",
          metricKey: "train/loss",
          xField: "metadata:%E0%A4%A",
          yField,
        },
        {
          id: "scatter-bad-metric",
          type: "scatter",
          title: "Bad metric",
          metricKey: "train/loss",
          xField: "run:created_at_unix",
          yField: "metric:%E0%A4%A:best",
        },
      ],
    }],
    updatedAt: "2026-06-02T00:00:00.000Z",
  }, ["eval/return_mean", "train/loss"], "demo");

  assert.equal(sanitized.schemaVersion, models.WORKSPACE_SCHEMA_VERSION);
  assert.equal(sanitized.settings.maxRuns, 25);
  assert.equal(sanitized.settings.hideEmptySections, true);
  assert.equal(sanitized.settings.sectionOrganization, "manual");
  const panels = sanitized.sections[0].panels;
  assert.equal(panels.length, 2, "invalid scatter panels should be dropped during migration");
  const scatter = panels.find((panel) => panel.id === "scatter-a");
  assert.equal(scatter.type, "scatter");
  assert.equal(scatter.xField, "run:duration_seconds");
  assert.equal(scatter.yField, yField);
  assert.equal(scatter.settings.maxRuns, 25);
  const line = panels.find((panel) => panel.id === "line-a");
  assert.equal(line.type, "line");
  assert.equal(line.xField, undefined);
  assert.equal(line.yField, undefined);
  assert.deepEqual(line.layout, { w: 12, h: models.MIN_LINE_WORKSPACE_PANEL_ROWS }, "saved short line charts should migrate to a usable minimum height");
});

test("workspace sanitizer round-trips second-slice research panels", async () => {
  const models = await importDashboardModelsForTest();
  const valueField = metricFieldId("eval/return_mean", "best");
  const groupField = objectFieldId("config", ["variant"]);
  const seedField = objectFieldId("config", ["seed"]);
  const sanitized = models.sanitizeWorkspaceView({
    schemaVersion: models.WORKSPACE_SCHEMA_VERSION,
    id: "research-panels",
    name: "Research panels",
    mode: "manual",
    project: "demo",
    sections: [{
      id: "research-section",
      name: "Research",
      panels: [
        {
          id: "dist-a",
          type: "distribution",
          title: "Return by variant",
          metricKey: "eval/return_mean",
          valueField,
          groupField,
          replicateField: seedField,
        },
        {
          id: "hist-timeline-a",
          type: "histogram_timeline",
          title: "Score distribution",
          metricKey: "eval/score_distribution",
          objectKey: "eval/score_distribution",
        },
        {
          id: "dist-bad",
          type: "distribution",
          title: "Bad distribution",
          metricKey: "eval/return_mean",
          valueField: "not-a-field",
        },
        {
          id: "hist-bad",
          type: "histogram_timeline",
          title: "Bad histogram",
          metricKey: "eval/score_distribution",
          objectKey: "",
        },
      ],
    }],
  }, ["eval/return_mean"], "demo");

  const panels = sanitized.sections[0].panels;
  assert.deepEqual(panels.map((panel) => panel.id), ["dist-a", "hist-timeline-a"]);
  assert.equal(panels[0].type, "distribution");
  assert.equal(panels[0].valueField, valueField);
  assert.equal(panels[0].groupField, groupField);
  assert.equal(panels[0].replicateField, seedField);
  assert.equal(panels[1].type, "histogram_timeline");
  assert.equal(panels[1].objectKey, "eval/score_distribution");
});

test("workspace sanitizer preserves legacy v1 panel payloads without scatter fields", async () => {
  const models = await importDashboardModelsForTest();
  const legacyPanels = [
    { id: "line-old", type: "line", title: "Loss", metricKey: "train/loss" },
    { id: "bar-old", type: "bar", title: "Accuracy bars", metricKey: "eval/accuracy" },
    { id: "hist-old", type: "histogram", title: "Reward histogram", metricKey: "eval/reward" },
    { id: "dot-old", type: "dot", title: "Latency dots", metricKey: "system/latency_ms" },
    { id: "unknown-old", type: "area", title: "Legacy unknown", metricKey: "custom/value" },
  ];
  const sanitized = models.sanitizeWorkspaceView({
    schemaVersion: 1,
    id: "legacy-workspace",
    name: "Legacy workspace",
    mode: "manual",
    project: "demo",
    settings: { maxRuns: 5, hideEmptySections: false, sectionOrganization: "manual" },
    sections: [{
      id: "legacy-section",
      name: "Legacy charts",
      panels: legacyPanels,
    }],
    updatedAt: "2026-05-31T00:00:00.000Z",
  }, legacyPanels.map((panel) => panel.metricKey), "demo");

  assert.equal(sanitized.schemaVersion, models.WORKSPACE_SCHEMA_VERSION);
  assert.equal(sanitized.sections.length, 1);
  assert.deepEqual(
    sanitized.sections[0].panels.map((panel) => [panel.id, panel.type, panel.metricKey, panel.xField, panel.yField]),
    [
      ["line-old", "line", "train/loss", undefined, undefined],
      ["bar-old", "bar", "eval/accuracy", undefined, undefined],
      ["hist-old", "histogram", "eval/reward", undefined, undefined],
      ["dot-old", "dot", "system/latency_ms", undefined, undefined],
      ["unknown-old", "line", "custom/value", undefined, undefined],
    ],
  );
  assert.deepEqual(models.workspaceMetricKeys(sanitized), ["custom/value", "train/loss"]);
  assert.equal(sanitized.sections[0].panels[0].layout.h, models.MIN_LINE_WORKSPACE_PANEL_ROWS);
  assert.equal(sanitized.sections[0].panels[1].layout.h, 4);
  assert.equal(sanitized.sections[0].panels[4].layout.h, models.MIN_LINE_WORKSPACE_PANEL_ROWS);
});

test("workspace scatter panel creation emits parser-safe default field ids", async () => {
  const models = await importDashboardModelsForTest();
  const line = models.workspacePanelForMetric("eval/return_mean", "line");
  assert.equal(line.layout.h, models.MIN_LINE_WORKSPACE_PANEL_ROWS);

  const normalScatter = models.workspacePanelForMetric("eval/return_mean", "scatter");
  assert.equal(normalScatter.type, "scatter");
  assert.equal(normalScatter.layout.h, 4);
  assert.equal(parseFieldId(normalScatter.xField)?.source, "run");
  assert.equal(parseFieldId(normalScatter.yField)?.source, "metric");

  const encodedLengthExpansionMetric = "é".repeat(190);
  const fallbackScatter = models.workspacePanelForMetric(encodedLengthExpansionMetric, "scatter");
  assert.equal(fallbackScatter.type, "scatter");
  assert.equal(parseFieldId(fallbackScatter.xField)?.source, "run");
  assert.equal(parseFieldId(fallbackScatter.yField)?.source, "run");
  assert.notEqual(fallbackScatter.yField, "", "scatter fallback y field should never persist an empty field id");

  const sanitized = models.sanitizeWorkspaceView({
    schemaVersion: models.WORKSPACE_SCHEMA_VERSION,
    id: "scatter-created",
    name: "Scatter created",
    mode: "manual",
    project: "demo",
    sections: [{ id: "section-created", name: "Created", panels: [fallbackScatter] }],
  }, [encodedLengthExpansionMetric], "demo");
  assert.equal(sanitized.sections[0].panels.length, 1, "parser-safe scatter defaults should survive reload sanitization");
  assert.equal(sanitized.sections[0].panels[0].type, "scatter");
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
  assert.match(shell, /upsertOption\(\{\s*label: name,[\s\S]*?source: "control"/, "control-plane view saves should appear without a reload");
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
  // #136 (live-update metric charts) renamed selectedFetchRunKey -> workspaceFetchRunKey;
  // it still keys the metric-series fetch effect on the resolved run set.
  assert.match(shell, /workspaceFetchRunKey/, "metric-series fetches should be keyed on the resolved workspace fetch run set");
  assert.match(shell, /const runsForFetch = metricSeriesRuns;/, "metric-series fetches should use selected runs or visible runs when no explicit selection exists");
  assert.match(shell, /useLayoutEffect\(\(\) => \{[\s\S]*dashboardSelectionFilterKeyRef\.current = dashboardSelectionFilterKey/, "selection filter guard should update before synchronous select-all interactions");
  assert.match(shell, /api\.get\(`\/runs\/\$\{id\}`, \{ signal: controller\.signal \}\)/, "off-page selected run hydration should be abortable");
  assert.match(shell, /runWithConcurrency\(tasks, 6\)/, "off-page selected run hydration should cap API fanout");
  assert.match(shell, /compareArtifactCacheRef/, "compare artifacts should reuse already-fetched run artifacts");
  assert.match(shell, /compareArtifactInflightRef/, "compare artifacts should dedupe concurrent per-run requests");
  assert.match(shell, /\}, \[compareSurfaceActive, api, compareRunKey, runMetadataVersion\]\);/, "compare artifact cache invalidation should restart the compare artifact load");
  assert.match(shell, /inFlight\.signal === controller\.signal && !inFlight\.signal\.aborted/, "compare artifact in-flight reuse should not reuse aborted requests from old selections");
  assert.match(shell, /compareArtifactInflightRef\.current\.get\(runId\) === entry/, "settled older artifact requests must not delete newer in-flight promises");
  assert.match(shell, /if \(queryInput !== query\) \{[\s\S]*setQuery\(queryInput\);[\s\S]*Select matching runs again[\s\S]*return;/, "select-all matching should not run against a stale debounced search query");
  assert.match(shell, /function searchErrorFromApi\(error: unknown, query: string\): RunSearchError \| null/, "dashboard should only surface allowlisted structured run-search errors");
  assert.match(shell, /RUN_LOAD_STATUS_TABS/, "background run loading should only update status copy on run-data tabs");
  assert.match(shell, /!shouldSurfaceRunLoadMessage\(activeTabRef\.current\)/, "reports and other independent tabs should not show unrelated run-load failures");
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
  assert.match(runsWorkspace, /const showSelectAllMatching = matchingOverflow && selectedRunIds\.length > 0;/, "overflowed result sets should defer cross-page bulk selection until row selection starts");
  assert.match(runsWorkspace, /disabled=\{selectAllMatchingBusy \|\| selectAllMatchingDisabled\}/, "select-all matching should honor invalid-search disabled state");
  assert.match(runsWorkspace, /pointerDragCleanupRef/, "pointer drag listeners should be cleaned up on unmount or interrupted drag");
  assert.match(runsWorkspace, /removeEventListener\("pointercancel"/, "pointer drag cleanup should remove cancellation listeners");

  const filterBar = readFileSync(`${root}app/dashboard/runs/run-filter-bar.tsx`, "utf8");
  assert.match(filterBar, /workbar-search-popover/, "run search should include syntax help beside the actual search box");
  assert.match(filterBar, /aria-invalid=\{Boolean\(searchError && !searchErrorStale\)\}/, "search syntax errors should be associated with the input without marking stale edits invalid");

  const navRail = readFileSync(`${root}app/dashboard/chrome/nav-rail.tsx`, "utf8");
  assert.doesNotMatch(shell, /\bnavPinned\b|nav-pinned/, "dashboard shell should always render the side nav unpinned");
  assert.doesNotMatch(navRail, /\bpinned\b/, "side nav should not expose a pinned state");

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
  assert.match(css, /\.tab-group-label \{[\s\S]*?display: block;[\s\S]*?min-height: 17px;[\s\S]*?opacity: 0;[\s\S]*?visibility: hidden;/, "collapsed nav group labels should reserve title spacer height without showing title text");
  assert.match(css, /\.shell\.nav-pinned \.tab-group-label,[\s\S]*?\.shell:not\(\.nav-pinned\)\.nav-auto-open \.tab-group-label,[\s\S]*?\.shell:not\(\.nav-pinned\) \.tabs:has\(:focus-visible\) \.tab-group-label \{[\s\S]*?opacity: 1;[\s\S]*?visibility: visible;/, "expanded nav should reveal group titles without inserting new vertical space");
  assert.match(css, /\.shell:not\(\.nav-pinned\) \.tab-button \{[\s\S]*?justify-content: flex-start;[\s\S]*?gap: 0;[\s\S]*?padding: 8px 12px;/, "collapsed nav icons should keep the same origin as expanded nav items");
  assert.match(css, /\.shell:not\(\.nav-pinned\)\.nav-auto-open \.tab-button,[\s\S]*?\.shell:not\(\.nav-pinned\) \.tabs:has\(:focus-visible\) \.tab-button \{[\s\S]*?justify-content: flex-start;[\s\S]*?gap: 8px;[\s\S]*?padding: 8px 12px;/, "auto-open nav should reveal labels without shifting icons");
  assert.match(css, /\.tab-button svg \{ flex: 0 0 16px; \}/, "nav icons should use a fixed flex slot");
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
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.account-workspace-current \{[\s\S]*?display: block;/, "mobile account trigger should keep the current workspace visible");
  assert.match(css, /\.account-workspace-option\.selected \.org-switcher-option-name \{[\s\S]*?color: var\(--text\);[\s\S]*?-webkit-text-fill-color: var\(--text\);/, "selected workspace name should keep primary text color even when the current workspace button is disabled");
});

test("workspace view API normalizes generated and legacy envelopes", () => {
  const normalizer = readFileSync(`${root}src/workspace-view-api.js`, "utf8");
  const typedWrapper = readFileSync(`${root}app/dashboard/state/workspace-view-api.ts`, "utf8");
  const generated = readFileSync(`${root}src/types/api.generated.ts`, "utf8");
  const row = { id: "view-1", name: "Research", project: "demo", created_at: "now", updated_at: "now", payload: { metricKey: "loss" } };

  assert.match(generated, /WorkspaceViewEnvelope: \{\s*workspace_view:/, "generated OpenAPI type exposes runtime singular workspace_view envelope");
  assert.match(generated, /WorkspaceViewSummariesEnvelope: \{[\s\S]*next_cursor\?:[\s\S]*workspace_views:/, "generated OpenAPI type exposes runtime workspace_views envelope and cursor");
  assert.match(generated, /"\/api\/workspace-views\/\{view_id\}\/export"/, "generated OpenAPI type exposes view export route");
  assert.match(generated, /"\/api\/workspace-views\/import"/, "generated OpenAPI type exposes view import route");
  assert.match(generated, /"\/api\/workspace-view-data"/, "generated OpenAPI type exposes agent view data route");
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

test("saved-view import requires a current dry-run preview and bounded JSON", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");

  assert.match(shell, /const MAX_WORKSPACE_VIEW_IMPORT_BYTES = 128 \* 1024;/, "client should mirror the 128 KiB import body cap");
  assert.match(shell, /file\.size > MAX_WORKSPACE_VIEW_IMPORT_BYTES/, "selected files should be rejected before reading oversized JSON into the textarea");
  assert.match(shell, /workspaceViewImportByteLength\(previewText\) > MAX_WORKSPACE_VIEW_IMPORT_BYTES/, "pasted JSON should be size checked before preview");
  assert.match(shell, /const requestId = viewImportRequestRef\.current \+ 1;/, "file imports should capture a request id before async file reads");
  assert.match(shell, /if \(requestId !== viewImportRequestRef\.current\) return;/, "stale async file reads should not replace newer import text");
  assert.match(shell, /viewImportPreviewText !== viewImportTextRef\.current/, "confirm should require the previewed payload to still be current");
  assert.match(shell, /JSON\.parse\(viewImportPreviewText\)/, "confirm should submit the exact JSON that was dry-run previewed");
  assert.match(shell, /previewCurrent=\{Boolean\(viewImportPreview && viewImportPreviewText && viewImportPreviewText === viewImportText\)\}/, "import button should disable when the preview no longer matches the textarea");
});

test("workspace saved-view controls stay reachable on mobile and local layout edits do not refetch series", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const css = readFileSync(`${root}app/styles/overhaul.css`, "utf8");
  const filterBar = readFileSync(`${root}app/dashboard/runs/run-filter-bar.tsx`, "utf8");

  assert.match(filterBar, /data-view-actions-trigger="true"/, "saved-view modals should have a stable focus-return target");
  assert.match(shell, /"#workspace-view-import-file",\s*"\[data-view-actions-trigger='true'\]"/, "import modal should return focus to the View actions trigger");
  assert.match(shell, /"button\[data-delete-view-cancel='true'\]",\s*"\[data-view-actions-trigger='true'\]"/, "delete modal should focus Cancel first and return to the View actions trigger");
  assert.match(shell, /const workspaceSeriesViewKey = workspaceView\.id;/, "series fetch signatures should not include updatedAt from local layout edits");
  assert.doesNotMatch(shell, /workspaceSeriesViewKey = useMemo\(\(\) => `\$\{workspaceView\.id\}\\u0000\$\{workspaceView\.updatedAt\}`/, "layout timestamps should not force workspace metric refetches");
  assert.match(css, /\.workbar > #save-view,/, "mobile workbar hide rule should only target direct children");
  assert.match(css, /\.workbar > \.custom-select-control\.compact,/, "mobile workbar hide rule should not hide controls inside the View actions popover");
});

test("workspace view API paths are redacted before telemetry logging", () => {
  const apiClient = readFileSync(`${root}src/api.js`, "utf8");

  assert.match(apiClient, /workspace-views", ":view_id", "export"/, "view export route should redact dynamic IDs");
  assert.match(apiClient, /"workspace-views\/import"/, "view import route should be a static known route");
  assert.match(apiClient, /"workspace-view-data"/, "agent view data route should be a static known route");
});

test("API key UI does not expose admin controls to read-only members", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const apiPane = readFileSync(`${root}app/dashboard/api/tab-pane.tsx`, "utf8");
  const css = readFileSync(`${root}app/styles/overhaul.css`, "utf8");
  const darkCss = readFileSync(`${root}app/styles/dark-overrides.css`, "utf8");

  assert.match(shell, /!activeOrgId \|\| !canManageOrg/, "dashboard should skip API-key loads for non-admin members");
  assert.match(shell, /if \(!activeOrgId \|\| !canManageOrg\) \{[\s\S]*?API key management is available to workspace admins\.[\s\S]*?return;[\s\S]*?\}[\s\S]*setAdminBusy\(true\);[\s\S]*Creating API key/, "API-key create handler should reject non-admin invocation");
  assert.match(shell, /if \(!activeOrgId \|\| !keyId \|\| !canManageOrg\) \{[\s\S]*?API key management is available to workspace admins\.[\s\S]*?return;[\s\S]*?\}[\s\S]*setAdminBusy\(true\);[\s\S]*Revoking API key/, "API-key revoke handler should reject non-admin invocation");
  assert.match(shell, /async function copyTextToClipboard/, "copy-once API keys should use an explicit clipboard helper");
  assert.match(shell, /document\.execCommand\("copy"\)/, "copy-once API keys should fall back when the async clipboard API is unavailable");
  assert.doesNotMatch(shell, /navigator\.clipboard\?\.\s*writeText\(newApiKey\)/, "optional chaining must not make missing clipboard support look successful");
  assert.match(shell, /canManageOrg=\{canManageOrg\}/, "API tab should receive membership capabilities");
  assert.match(apiPane, /const visibleApiKeys = canManageOrg \? apiKeys : \[\];/, "API tab should hide stale key rows from read-only members");
  assert.match(apiPane, /const visibleNewApiKey = canManageOrg \? newApiKey : "";/, "API tab should hide stale copy-once keys from read-only members");
  assert.match(apiPane, /\{canManageOrg \? \(/, "API-key creation controls should be gated");
  assert.match(apiPane, /disabled=\{adminBusy \|\| !canManageOrg\}/, "manual API-key refresh should be disabled for read-only members");
  assert.match(apiPane, /\{canManageOrg \? \([\s\S]*?onRevokeApiKey/, "API-key revoke controls should be gated");
  assert.match(css, /\.api-key-reveal code[\s\S]*background: color-mix\(in srgb, var\(--surface\) 82%, var\(--surface-2\)\)/, "copy-once key reveal should use theme surfaces instead of a hard black code well");
  assert.doesNotMatch(darkCss, /preview-chip\.good,[\s\S]*?api-key-reveal/, "dark mode should not force API key reveals into the green preview-chip treatment");
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
