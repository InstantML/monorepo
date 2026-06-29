"use client";

import { useClerk } from "@clerk/nextjs";
import { Activity, Square, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { ApiClient, ApiError, isAbortError, queryString, retryTransientRequest } from "../../src/api.js";
import { downloadBlob, filenameFromContentDisposition, safeExportFilename } from "../../src/chart-export.js";
import { buildCheckpointForkBody, checkpointForkIdempotencyKey } from "../../src/checkpoints.js";
import { canonicalDashboardPath, pathFromLegacyHash, postAuthRedirectPath, safeCheckoutRedirectUrl, safeSameOriginInviteUrl, sanitizeNextPath, tabFromPath, tabToPath } from "../../src/routes.js";
import { averageGroupedSeries, chartSummary, smoothSeries } from "../../src/charts.js";
import { adaptiveMetricSeriesLimit, buildRunCategoricalFieldCatalog, buildRunFieldCatalog, categoricalFieldLabel, chunkRunIds, defaultDistributionFields, defaultScatterFields, fieldLabel, histogramFramesFromObjects, mergeMetricSeriesPatches, parseCategoricalFieldId, parseFieldId } from "../../src/dashboard-panels.js";
import { isEditableElement, matchesShortcut, platformModifierLabel } from "../../src/shortcuts.js";
import { canManageOrg as roleCanManageOrg, canWriteRuns as roleCanWriteRuns } from "../../src/roles.js";
import { BULK_SELECT_MATCHING_LIMIT, DEFAULT_SELECTED_RUNS, MAX_SELECTED_RUNS, canRequestStop, capSelectionToMatching, dashboardStatusQueryParams, defaultRunSelection, deselectVisible, displayStatusForRun, filterMetricKeys, formatNumber, groupKeyForRun, identifierForRun, metricFilterIsRegex, metricKeysFromSummary, preferredMetricKey, rangeSelect, runSelectionFromSearch, runSelectionSearchParam, selectAllVisible, toggleSelection, visibleSelectionState } from "../../src/state.js";

import { AlertsTabPane } from "./alerts/tab-pane";
import { ApiTabPane } from "./api/tab-pane";
import { ArtifactsTabPane } from "./artifacts/tab-pane";
import { CompareView } from "./compare/tab-pane";
import { CustomSelect } from "./ui/select";
import { DashboardNav } from "./chrome/nav-rail";
import { AccountWorkspaceMenu, DashboardTopbar } from "./chrome/topbar";
import type { CreateWorkspaceInput, WorkspaceNameAvailability } from "./chrome/topbar";
import { DatasetsTabPane } from "./datasets/tab-pane";
import { DetailTabPane } from "./detail/tab-pane";
import { DistributedTabPane } from "./distributed/tab-pane";
import { InsightsTabPane } from "./insights/tab-pane";
import { MetricsTabPane } from "./metrics/tab-pane";
import { ReportsTabPane } from "./reports/reports-tab-pane";
import { RunsTabPane } from "./runs/tab-pane";
import { RunFilterBar } from "./runs/run-filter-bar";
import { SettingsTabPane } from "./settings/tab-pane";
import { QuickSearchModal } from "./chrome/quick-search";
import { ShortcutHelpModal } from "./chrome/shortcut-help";
import { useFocusTrap } from "./ui/use-focus-trap";
import { isTabId, shellTabFromPath, tabs } from "../dashboard-config";
import type { ShellTabId } from "../dashboard-config";
import {
  buildAlertRows,
  buildApiRows,
  buildDatasetRows,
  buildMetricCatalogRows,
  buildRunMetricRows,
  buildRunTimelineRows,
  buildAutomaticWorkspace,
  COMPARE_ARTIFACT_LIMIT,
  COMPARE_RUN_LIMIT,
  DEFAULT_METRIC_KEY,
  defaultTableColumns,
  metricTitle,
  sanitizePanelLayout,
  sanitizeWorkspaceView,
  stableId,
  workspaceMetricKeys,
  workspacePanelNeedsMetricSeries,
  workspacePanelForMetric,
  workspacePanelTypeLabel,
  workspaceStorageKey,
} from "../dashboard-models";
import { AppLoadingScreen } from "../loading-screen";
import type { Artifact, CompareLayout, CompareRowSort, CompareRunSort, HistogramTimelineState, HoverPoint, LoggedObject, LoggedObjectRow, MetricSeries, Overview, RunSummary, Summary, TabId, TableColumns, WorkspaceCategoricalFieldOption, WorkspaceFieldOption, WorkspacePanel, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceView } from "../dashboard-types";
import type { RunWorkspaceTabId } from "./components/run-workspace";
import { LEGACY_SAVED_VIEW_PREFIX, RUNS_RAIL_COLLAPSED_KEY, SAVED_VIEW_PREFIX, THEME_KEY, WORKSPACE_VIEW_PREFIX } from "./state/storage-keys";
import { useIsMobile } from "./state/use-mobile";
import { workspaceViewFromPayload, workspaceViewSummariesFromPayload } from "./state/workspace-view-api";
import type { components } from "../../src/types/api.generated";

// Bridge types from the utoipa-generated OpenAPI spec. All API request /
// response shapes that have a matching Rust ToSchema struct flow through
// this `components["schemas"]` alias — that way a Rust struct rename or
// field reshape surfaces here at build time via the codegen pipeline.
// See docs/design/2026-05-19-utoipa-migration.md.
type GeneratedSeatRow = components["schemas"]["SeatRow"];
type GeneratedApiKeyRow = components["schemas"]["PublicApiKeyRow"];
type GeneratedInvitationRow = components["schemas"]["PublicInvitationRow"];
type GeneratedOrgMembershipSummary = components["schemas"]["OrganizationMembershipSummary"];
type GeneratedRunControlSummary = components["schemas"]["RunControlSummary"];
type GeneratedRunStopBulkEnvelope = components["schemas"]["RunStopBulkEnvelope"];
type GeneratedRunStopEnvelope = components["schemas"]["RunStopEnvelope"];

type ThemeMode = "light" | "dark";
type ChartZoomRange = { min: number; max: number } | null;
type ShortcutCommand = {
  description?: string;
  enabled: boolean;
  group: string;
  id: string;
  label: string;
  shortcut: string;
};
type QuickSearchItem = {
  description: string;
  group: string;
  id: string;
  label: string;
  onSelect: () => void;
};
type SavedViewOption = {
  label: string;
  project?: string | null;
  source: "control" | "local" | "system";
  updatedAt?: string;
  value: string;
};
type StopDialogSkipCounts = {
  alreadyStopping: number;
  readOnly: number;
  terminal: number;
  unavailable: number;
};
type StopDialogState = {
  idempotencyKey: string;
  reason: string;
  runIds: string[];
  ineligibleRunCount: number;
  skippedCounts: StopDialogSkipCounts;
  skippedRunCount: number;
  source: "single" | "bulk";
} | null;
type WorkspaceViewImportPreview = {
  action?: string;
  dry_run?: boolean;
  name?: string;
  payload_bytes?: number;
  project?: string | null;
  warnings?: string[];
  workspace_view?: { id?: string; updated_at?: string } | null;
};
type DashboardSessionPayload = {
  authenticated?: boolean;
  organization?: { id: string; name: string; slug: string; plan_tier?: string; seat_limit?: number; storage_choice?: string; storage_state?: string };
  user?: { primary_email: string; display_name?: string | null; avatar_url?: string | null };
  membership?: { role: string; status: string };
  memberships?: Array<{ org_id: string; role: string; status: string }>;
};

const SHARED_DEMO_EMAIL = "hello@instantml.ai";
const SHARED_DEMO_ORG = "InstantML Demo";
const DISPLAY_STATUS_VALUES = new Set(["running", "stopping", "stopped", "finished", "failed"]);
const MAX_STOP_DIALOG_RUNS = 100;
const SELECTED_RUN_DETAILS_HYDRATION_LIMIT = Math.max(COMPARE_RUN_LIMIT, MAX_STOP_DIALOG_RUNS);
// Sourced from the generated OpenAPI spec; `list_org_memberships` returns
// an `OrgMembershipsEnvelope { memberships: OrganizationMembershipSummary[] }`.
// Rust struct `domain::OrganizationMembershipSummary`.
type OrgMembershipSummary = GeneratedOrgMembershipSummary;
// Sourced from the generated OpenAPI spec; `list_seats` returns a
// `SeatsEnvelope { seats: SeatRow[] }`. Rust struct `domain::SeatRow`.
type SeatRow = GeneratedSeatRow;
type InvitationRow = GeneratedInvitationRow;
// Sourced from the generated OpenAPI spec; `list_api_keys` returns an
// `ApiKeysEnvelope { api_keys: PublicApiKeyRow[] }`. Rust struct
// `domain::PublicApiKeyRow`. Existing UI code only touches a subset of
// the row's fields, but typing the full row lets us catch field renames at
// build time when the Rust struct changes.
type ApiKeyRow = GeneratedApiKeyRow;
type UsageOrg = {
  org_id: string;
  plan_tier: string;
  usage_period?: UsagePeriod;
  usage: Record<string, number | null | string>;
  limits: Record<string, number>;
  plan?: Record<string, number | null | string>;
  warnings?: Array<{ code?: string; message?: string }>;
};
type UsagePeriod = {
  kind?: string;
  timezone?: string;
  starts_at?: string;
  ends_at?: string;
  reset_at?: string;
};
type UsagePayload = {
  billing_precision?: string;
  usage_period?: UsagePeriod;
  organizations?: UsageOrg[];
};
type BillingPayload = {
  billing?: {
    access_state?: string;
    effective_plan_tier?: string;
    subscription_status?: string | null;
    cancel_at_period_end?: boolean;
    message?: string | null;
  };
};
type CompareArtifactInflightRequest = {
  promise: Promise<Artifact[]>;
  signal: AbortSignal;
};
const SEARCH_DEBOUNCE_MS = 250;
const MAX_METRIC_OPTIONS = 120;
const MAX_METRIC_CATALOG_ROWS = 200;
const MAX_COMPARE_TABLE_METRICS = 12;
const MAX_EXPORT_SELECTED_RUNS = 100;
const MAX_WORKSPACE_VIEW_IMPORT_BYTES = 128 * 1024;
const ARTIFACT_PAGE_LIMIT = 100;
const WORKSPACE_HISTOGRAM_TIMELINE_LIMIT = 3;
const WORKSPACE_HISTORY_LIMIT = 50;
const WAREHOUSE_RETRY_MS = 5_000;
// Cadence for refreshing metric series of in-flight (running) runs so charts
// extend live during training. Matches the dashboard metadata poll cadence.
const LIVE_SERIES_REFRESH_MS = 5_000;
const DASHBOARD_REQUEST_RETRY_DELAYS_MS = [250, 700, 1_500];
const METRIC_SERIES_RETRY_DELAYS_MS = [350, 900, 1_800];
// M4 bucket count passed with every /api/metrics/series request.
// Must match or exceed the widest chart pixel width so the downsampled series
// is lossless for rendering. Reference chart width is 560 px; 1200 gives 2×
// oversampling headroom for full-screen and compare panels and stays well
// below the server's 4096 cap.
const METRIC_SERIES_M4_BUCKETS = 1_200;
const compareLayouts = new Set<CompareLayout>(["auto", "columns", "rows"]);
const compareRowSorts = new Set<CompareRowSort>(["signal", "changed", "missing", "category", "name", "spread"]);
const compareRunSorts = new Set<CompareRunSort>(["selected", "name", "newest", "status", "duration", "metric-latest", "metric-best", "artifacts", "tags", "notes", "config"]);
const RUN_LOAD_STATUS_TABS = new Set<ShellTabId>(["runs", "metrics", "detail", "compare", "artifacts"]);

const EMPTY_OVERVIEW: Overview = { total_runs: 0, active_runs: 0, failed_runs: 0, best_eval_return: null, metric_points: 0 };
// The Overview cockpit lives at a static route segment while every other tab is
// served by the catch-all, so crossing between them remounts the whole shell
// and resets overview state to zero — the telemetry ticker would flash
// "LIVE 0 / PTS 0" until the next load resolves. Cache the last real overview at
// module scope (per browser tab, cleared on full reload) so a remount restores
// the previous numbers instead of flashing placeholders.
let lastKnownOverview: Overview | null = null;

function boundedOptions(options: string[], activeValue: string, limit = MAX_METRIC_OPTIONS) {
  const capped = options.slice(0, limit);
  if (activeValue && options.includes(activeValue) && !capped.includes(activeValue)) return [activeValue, ...capped.slice(0, Math.max(0, limit - 1))];
  return capped;
}

function workspaceHistogramObjectKeys(view: WorkspaceView, search = "", activePanel?: WorkspacePanel | null) {
  const needle = search.trim().toLowerCase();
  const keys: string[] = [];
  const addKey = (key: string) => {
    const trimmed = key.trim();
    if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
  };
  if (activePanel?.type === "histogram_timeline") addKey(activePanel.objectKey);
  for (const section of view.sections) {
    if (section.collapsed) continue;
    const visiblePanels = section.panels.filter((panel) => {
      if (!needle) return true;
      const scatterFields = panel.type === "scatter" ? `${fieldLabel(panel.xField)} ${fieldLabel(panel.yField)}` : "";
      const distributionFields = panel.type === "distribution" ? `${fieldLabel(panel.valueField)} ${panel.groupField ? categoricalFieldLabel(panel.groupField) : ""} ${panel.replicateField ? categoricalFieldLabel(panel.replicateField) : ""}` : "";
      const objectFields = panel.type === "histogram_timeline" ? panel.objectKey : "";
      const searchable = `${section.name} ${panel.title} ${panel.metricKey} ${workspacePanelTypeLabel(panel.type)} ${scatterFields} ${distributionFields} ${objectFields}`;
      return searchable.toLowerCase().includes(needle);
    }).slice(0, 12);
    for (const panel of visiblePanels) {
      if (panel.type !== "histogram_timeline") continue;
      addKey(panel.objectKey);
    }
  }
  return keys;
}

function messageTone(message: string): "error" | "loading" | "ok" {
  if (/starting data warehouse|warehouse is awake/i.test(message)) return "loading";
  if (/unable|invalid|failed|unavailable|not found|access|sign in/i.test(message)) return "error";
  if (/loading|resetting|syncing|starting/i.test(message)) return "loading";
  return "ok";
}

function isWarehouseStartingError(error: unknown) {
  return error instanceof ApiError && error.code === "warehouse_unavailable";
}

function shouldSurfaceRunLoadMessage(tab: ShellTabId) {
  return RUN_LOAD_STATUS_TABS.has(tab);
}

function isOptionalAdminPlaneUnavailable(error: unknown) {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

type RunSearchError = {
  query: string;
  code: string;
  message: string;
  position: number | null;
};

const RUN_SEARCH_ERROR_CODES = new Set(["run_search_invalid", "run_search_regex_unsupported"]);

function searchErrorFromApi(error: unknown, query: string): RunSearchError | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 400 || error.field !== "q" || !RUN_SEARCH_ERROR_CODES.has(error.code)) return null;
  const position = Number.isInteger(error.position) ? Number(error.position) : null;
  return {
    query,
    code: error.code,
    message: error.safeMessage || error.message || "Invalid run search.",
    position,
  };
}

function quickSearchTokenMatches(haystack: string, token: string) {
  const parts = token
    .split(/\.{2,}|…/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts.every((part) => haystack.includes(part));
  return haystack.includes(token);
}

function mergeRunTagsAndNotes(run: RunSummary, tags: string[], notes: string) {
  const metadata = { ...(run.metadata ?? {}) };
  if (notes) metadata.notes = notes;
  else delete metadata.notes;
  return { ...run, tags, metadata };
}

function boundedOwnKeyCount(record: Record<string, unknown> | null | undefined, limit = 64) {
  if (!record || typeof record !== "object") return 0;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count >= limit) return limit;
  }
  return count;
}

function hasOwnRecordKeys(record: Record<string, unknown> | null | undefined) {
  return boundedOwnKeyCount(record, 1) > 0;
}

function fallbackHasAdditionalKeys(primary: Record<string, unknown> | null | undefined, fallback: Record<string, unknown> | null | undefined) {
  if (!fallback || typeof fallback !== "object") return false;
  if (!primary || typeof primary !== "object") return hasOwnRecordKeys(fallback);
  let checked = 0;
  for (const key in fallback) {
    if (!Object.prototype.hasOwnProperty.call(fallback, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(primary, key)) return true;
    checked += 1;
    if (checked >= 64) return true;
  }
  return false;
}

function mergeFreshRecord<T extends Record<string, unknown>>(primary: T | null | undefined, fallback: T | null | undefined): T {
  if (!hasOwnRecordKeys(primary)) return (fallback ?? {}) as T;
  if (!fallbackHasAdditionalKeys(primary, fallback)) return primary as T;
  return { ...(fallback ?? {}), ...primary } as T;
}

function richerRunSummary(primary: RunSummary | null | undefined, fallback: RunSummary | null | undefined) {
  if (!primary) return fallback ?? null;
  if (!fallback) return primary;
  const primaryConfigKeys = boundedOwnKeyCount(primary.config);
  const fallbackConfigKeys = boundedOwnKeyCount(fallback.config);
  const config = fallbackConfigKeys > primaryConfigKeys ? fallback.config : primary.config;
  const metadata = mergeFreshRecord(primary.metadata, fallback.metadata);
  const latestMetrics = mergeFreshRecord(primary.latest_metrics, fallback.latest_metrics);
  const metricAggregates = mergeFreshRecord(primary.metric_aggregates, fallback.metric_aggregates);
  const artifactCounts = primary.artifact_counts ?? fallback.artifact_counts;
  const runControl = primary.run_control ?? fallback.run_control;
  if (
    config === primary.config &&
    metadata === primary.metadata &&
    latestMetrics === primary.latest_metrics &&
    metricAggregates === primary.metric_aggregates &&
    artifactCounts === primary.artifact_counts &&
    runControl === primary.run_control
  ) return primary;
  return {
    ...fallback,
    ...primary,
    config,
    metadata,
    latest_metrics: latestMetrics,
    metric_aggregates: metricAggregates,
    artifact_counts: artifactCounts,
    run_control: runControl,
  };
}

function mergeRunControl(run: RunSummary, control: GeneratedRunControlSummary): RunSummary {
  return { ...run, run_control: control };
}

function normalizeDisplayStatus(value: string | null | undefined) {
  const status = (value ?? "").trim().toLowerCase();
  return DISPLAY_STATUS_VALUES.has(status) ? status : "";
}

function runHasPendingStop(run: RunSummary | null | undefined) {
  const state = run?.run_control?.stop_state;
  return state === "requested" || state === "acknowledged";
}

function adjustOverviewForDisplayStatus(overview: Overview, before: string, after: string): Overview {
  if (before === after) return overview;
  const next = { ...overview };
  if (before === "stopping") next.stopping_runs = Math.max(0, Number(next.stopping_runs ?? 0) - 1);
  if (after === "stopping") next.stopping_runs = Number(next.stopping_runs ?? 0) + 1;
  if (before === "stopped") next.stopped_runs = Math.max(0, Number(next.stopped_runs ?? 0) - 1);
  if (after === "stopped") next.stopped_runs = Number(next.stopped_runs ?? 0) + 1;
  return next;
}

function sanitizeWorkspaceFieldPatch(value: string | undefined) {
  if (typeof value !== "string") return undefined;
  const field = value.slice(0, 512);
  return parseFieldId(field) ? field : undefined;
}

function sanitizeWorkspaceCategoricalFieldPatch(value: string | undefined) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const field = value.slice(0, 512);
  return parseCategoricalFieldId(field) ? field : undefined;
}

function sanitizeWorkspaceObjectKeyPatch(value: string | undefined) {
  if (typeof value !== "string") return undefined;
  const key = value.trim().slice(0, 256);
  return key || undefined;
}

function pruneRunDetails(
  current: Record<string, RunSummary>,
  pageDetails: Record<string, RunSummary>,
  fetchedDetails: Record<string, RunSummary>,
  keepIds: string[],
) {
  const next: Record<string, RunSummary> = {};
  for (const id of keepIds) {
    const run = pageDetails[id] ?? fetchedDetails[id] ?? current[id];
    if (run) next[id] = run;
  }
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  const unchanged = currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === next[key]);
  return unchanged ? current : next;
}

function storageScopeId(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").slice(0, 120);
}

function scopedSavedViewPrefix(scope: string) {
  return scope ? `${SAVED_VIEW_PREFIX}${scope}:` : SAVED_VIEW_PREFIX;
}

function legacyOrgScopeFromSavedViewScope(scope: string) {
  return scope.split(":")[0] ?? "";
}

function legacyOrgSavedViewKeys(scope: string) {
  const orgId = legacyOrgScopeFromSavedViewScope(scope);
  if (!orgId) return [];
  const prefix = legacyOrgSavedViewPrefix(orgId);
  const targetPrefix = scopedSavedViewPrefix(scope);
  return Object.keys(localStorage).filter((key) => {
    if (!key.startsWith(prefix) || key.startsWith(targetPrefix)) return false;
    // Legacy org-scoped views were `${org_id}:${view_name}`. New scoped keys
    // include user/project segments, so do not re-list those as legacy aliases.
    return !key.slice(prefix.length).includes(":");
  });
}

function savedViewStorageKeys(scope = "") {
  const prefix = scopedSavedViewPrefix(scope);
  const keys = Object.keys(localStorage)
    // Scoped authenticated views intentionally exclude legacy global keys;
    // those keys cannot prove which user/org/project created them.
    .filter((key) => scope ? key.startsWith(prefix) : key.startsWith(SAVED_VIEW_PREFIX) || key.startsWith(LEGACY_SAVED_VIEW_PREFIX))
    .concat(scope ? legacyOrgSavedViewKeys(scope) : []);
  return [...new Set(keys)].sort();
}

function localSavedViewOptions(scope = ""): SavedViewOption[] {
  const prefix = scopedSavedViewPrefix(scope);
  return savedViewStorageKeys(scope).map((key) => ({
    label: localSavedViewName(key, scope),
    source: "local" as const,
    value: key,
  }));
}

function legacyOrgSavedViewPrefix(orgId: string) {
  return `${SAVED_VIEW_PREFIX}${orgId}:`;
}

function legacyWorkspaceStorageKeys(project: string, orgId: string) {
  const projectKey = project || "all";
  return [
    orgId ? `${WORKSPACE_VIEW_PREFIX}${orgId}:${projectKey}` : "",
    `${WORKSPACE_VIEW_PREFIX}${projectKey}`,
  ].filter(Boolean);
}

function migrateLegacySavedViewsToScope(orgId: string, scope: string) {
  if (!scope) return;
  const targetPrefix = scopedSavedViewPrefix(scope);
  const legacyOrgPrefix = orgId ? legacyOrgSavedViewPrefix(orgId) : "";
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(targetPrefix)) continue;
    let label = "";
    if (legacyOrgPrefix && key.startsWith(legacyOrgPrefix)) {
      label = key.slice(legacyOrgPrefix.length);
      if (label.includes(":")) label = "";
    } else if (key.startsWith(LEGACY_SAVED_VIEW_PREFIX)) {
      label = key.slice(LEGACY_SAVED_VIEW_PREFIX.length);
    } else if (key.startsWith(SAVED_VIEW_PREFIX)) {
      const suffix = key.slice(SAVED_VIEW_PREFIX.length);
      if (!suffix.includes(":")) label = suffix;
    }
    if (!label) continue;
    const target = `${targetPrefix}${label}`;
    if (!localStorage.getItem(target)) {
      const payload = localStorage.getItem(key);
      if (payload !== null) localStorage.setItem(target, payload);
    }
  }
}

function localSavedViewKey(name: string, scope = "") {
  return `${scopedSavedViewPrefix(scope)}${name}`;
}

function localSavedViewName(key: string, scope = "") {
  if (scope) {
    const prefix = scopedSavedViewPrefix(scope);
    if (key.startsWith(prefix)) return key.slice(prefix.length);
    const legacyOrgPrefix = legacyOrgSavedViewPrefix(legacyOrgScopeFromSavedViewScope(scope));
    if (key.startsWith(legacyOrgPrefix)) return key.slice(legacyOrgPrefix.length);
  }
  return key.replace(SAVED_VIEW_PREFIX, "").replace(LEGACY_SAVED_VIEW_PREFIX, "");
}

function controlSavedViewKey(id: string) {
  return `control:${id}`;
}

function controlSavedViewId(key: string) {
  return key.startsWith("control:") ? key.slice("control:".length) : "";
}

function savedViewString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function savedViewNumber(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function savedViewStringArray(value: unknown, limit: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, limit)
    : [];
}

function safeSavedView(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

function initialActiveTab(initialTab: ShellTabId) {
  if (typeof window === "undefined") return initialTab;
  const legacyPath = pathFromLegacyHash(window.location.hash);
  return legacyPath ? shellTabFromPath(legacyPath) : shellTabFromPath(window.location.pathname);
}

function workspaceViewImportByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

export function DashboardShell({ initialTab = "runs" }: { initialTab?: ShellTabId }) {
  const api = useMemo(() => new ApiClient(), []);
  const clerk = useClerk();
  const dashboardRequestRef = useRef(0);
  const applyingSavedViewRef = useRef(false);
  const pageNavigationPendingRef = useRef(false);
  const hoverFrameRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{ chartMetricKey: string; chartSeries: any[]; x: number; y: number } | null>(null);
  const workspaceViewRef = useRef<WorkspaceView | null>(null);
  const workspaceFocusRegionRef = useRef<"runs" | "canvas">("canvas");
  const summaryTotalRef = useRef(0);
  const warehouseRetryTimerRef = useRef<number | null>(null);
  const globalKeyHandlerRef = useRef<((event: globalThis.KeyboardEvent) => void) | null>(null);
  const projectPreferenceLoadedRef = useRef(false);
  const previousOrgIdRef = useRef("");
  const userTouchedDashboardFiltersRef = useRef(false);
  // True once a default page selection has been applied OR the URL supplied an
  // explicit ?runs= selection (which must never be replaced by the default).
  const defaultSelectionInitializedRef = useRef(
    typeof window !== "undefined" && runSelectionFromSearch(window.location.search).length > 0,
  );
  // URL sync starts enabled only for deep links; it switches on permanently the
  // first time the user changes the selection themselves, so default
  // auto-selections never spray run ids into the address bar.
  const selectionUrlSyncRef = useRef(
    typeof window !== "undefined" && runSelectionFromSearch(window.location.search).length > 0,
  );
  // One-shot guard: a popstate-restored ?runs= selection must survive the
  // project/filter clear effect that fires in the same render batch.
  const applyingUrlSelectionRef = useRef(false);
  const runDirectoryRef = useRef<Map<string, RunSummary>>(new Map());
  // Signatures of the last series fetch per chart group. When only the live
  // refresh tick changes (signature unchanged), we refetch in place without
  // clearing, so running charts extend smoothly instead of blanking.
  const seriesSignatureRef = useRef("");
  const panelSeriesSignatureRef = useRef("");
  const workspaceSeriesSignatureRef = useRef("");
  // Tracks whether the live-refresh loop was active, so we can issue one final
  // refresh when a run stops to capture the tail of the curve.
  const liveSeriesActiveRef = useRef(false);
  const preserveRunWorkspaceTabOnceRef = useRef(false);
  const selectedRunsRef = useRef<RunSummary[]>([]);
  const dashboardSelectionFilterKeyRef = useRef("");
  const selectAllMatchingControllerRef = useRef<AbortController | null>(null);
  const applySavedViewRequestRef = useRef(0);
  const viewImportTextRef = useRef("");
  const viewImportRequestRef = useRef(0);
  const projectPreferenceWriteTimerRef = useRef<number | null>(null);
  const compareArtifactCacheRef = useRef<Map<string, Artifact[]>>(new Map());
  const compareArtifactInflightRef = useRef<Map<string, CompareArtifactInflightRequest>>(new Map());
  const compareArtifactCacheVersionRef = useRef(0);
  const messageRef = useRef("Loading runs...");
  const [activeTab, setActiveTab] = useState<ShellTabId>(() => initialActiveTab(initialTab));
  const activeTabRef = useRef(activeTab);
  const [dashboardAuthorized, setDashboardAuthorized] = useState(false);
  const [dashboardSessionChecked, setDashboardSessionChecked] = useState(false);
  const [dashboardAuthMessage, setDashboardAuthMessage] = useState("Checking session...");
  const [sessionPayload, setSessionPayload] = useState<DashboardSessionPayload | null>(null);
  const [projectPreferenceReady, setProjectPreferenceReady] = useState(false);
  const [orgMemberships, setOrgMemberships] = useState<OrgMembershipSummary[]>([]);
  const [orgSwitchBusy, setOrgSwitchBusy] = useState(false);
  const [orgSwitchError, setOrgSwitchError] = useState("");
  // Seed the project from ?project=… so that direct deep-links and the back/forward
  // gestures restore the previously-selected project. The `loadProjects` effect
  // below will reset to "" if the URL referenced a project the user no longer has
  // access to, and the preferences loader runs only when this is empty.
  const [project, setProject] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("project") ?? "")
  );
  const [status, setStatus] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState<RunSearchError | null>(null);
  const [sortBy, setSortBy] = useState("created");
  const [metricKey, setMetricKey] = useState(DEFAULT_METRIC_KEY);
  const [metricFilter, setMetricFilter] = useState("");
  const [columnMetricFilter, setColumnMetricFilter] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [xMode, setXMode] = useState("step");
  const [smoothing, setSmoothing] = useState(0);
  const [identifierMode, setIdentifierMode] = useState("name");
  const [groupAverage, setGroupAverage] = useState(false);
  const [diffOnly, setDiffOnly] = useState(false);
  const [referenceRunId, setReferenceRunId] = useState("");
  const [compareLayout, setCompareLayout] = useState<CompareLayout>("rows");
  const [compareRowSort, setCompareRowSort] = useState<CompareRowSort>("signal");
  const [compareRunSort, setCompareRunSort] = useState<CompareRunSort>("metric-best");
  const [compareSortMetricKey, setCompareSortMetricKey] = useState(DEFAULT_METRIC_KEY);
  const [compareTableMetrics, setCompareTableMetrics] = useState<string[]>([]);
  const [compareSearch, setCompareSearch] = useState("");
  const [compareConfigSortKey, setCompareConfigSortKey] = useState("");
  const [runMetadataVersion, setRunMetadataVersion] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_SELECTED_RUNS);
  const [pageOffset, setPageOffset] = useState(0);
  const [pageCursorStack, setPageCursorStack] = useState<string[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [pageNavigationPending, setPageNavigationPending] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary>({ runs: [], metric_keys: [], total: 0 });
  const [overview, setOverviewState] = useState<Overview>(() => lastKnownOverview ?? EMPTY_OVERVIEW);
  // Persist every real overview to the module cache so a shell remount (Overview
  // route ⇄ catch-all tabs) restores the last numbers instead of flashing zero.
  const setOverview = useCallback((value: Overview | ((current: Overview) => Overview)) => {
    setOverviewState((current) => {
      const next = typeof value === "function" ? (value as (c: Overview) => Overview)(current) : value;
      lastKnownOverview = next;
      return next;
    });
  }, []);
  // Seed selection from ?runs=… so compare links survive reloads and can be
  // shared. The default auto-select skips when the URL provided a selection.
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : runSelectionFromSearch(window.location.search));
  const [exportSelectedBusy, setExportSelectedBusy] = useState(false);
  const [selectedRunDetails, setSelectedRunDetails] = useState<Record<string, RunSummary>>({});
  const [primaryRunId, setPrimaryRunId] = useState("");
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [liveSeriesTick, setLiveSeriesTick] = useState(0);
  const [panelSeries, setPanelSeries] = useState<Record<string, MetricSeries[]>>({});
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsRunId, setArtifactsRunId] = useState("");
  const [loggedObjects, setLoggedObjects] = useState<LoggedObject[]>([]);
  const [objectRowsById, setObjectRowsById] = useState<Record<number, LoggedObjectRow[]>>({});
  const [runWorkspaceTab, setRunWorkspaceTab] = useState<RunWorkspaceTabId>("summary");
  const [compareArtifactsByRun, setCompareArtifactsByRun] = useState<Record<string, Artifact[]>>({});
  const [sideBySide, setSideBySide] = useState<any>(null);
  // The comparison surface now lives inside the Runs → Table view (the Table
  // toggle owns its own panels/table state and mirrors it here), so compare
  // data only loads while that view is actually on screen.
  const [runsViewIsTable, setRunsViewIsTable] = useState(false);
  const compareSurfaceActive = activeTab === "runs" && runsViewIsTable;
  const [hover, setHover] = useState<HoverPoint>(null);
  const [hoverMetricKey, setHoverMetricKey] = useState(metricKey);
  const [message, setMessage] = useState("Loading runs...");
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedViewOption[]>([]);
  const [savedViewKey, setSavedViewKey] = useState("");
  const [viewName, setViewName] = useState("");
  const [viewImportOpen, setViewImportOpen] = useState(false);
  const [viewImportText, setViewImportText] = useState("");
  const [viewImportFileName, setViewImportFileName] = useState("");
  const [viewImportPreview, setViewImportPreview] = useState<WorkspaceViewImportPreview | null>(null);
  const [viewImportPreviewText, setViewImportPreviewText] = useState("");
  const [viewImportBusy, setViewImportBusy] = useState(false);
  const [viewImportError, setViewImportError] = useState("");
  const [deleteViewTarget, setDeleteViewTarget] = useState<SavedViewOption | null>(null);
  const [viewActionBusy, setViewActionBusy] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [tableColumns, setTableColumns] = useState<TableColumns>(defaultTableColumns);
  const [pinnedMetrics, setPinnedMetrics] = useState<string[]>([]);
  const [navAutoOpen, setNavAutoOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isMobile = useIsMobile();
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(() => buildAutomaticWorkspace([], ""));
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [panelSearch, setPanelSearch] = useState("");
  const [addPanelSectionId, setAddPanelSectionId] = useState("");
  const [editingPanelRef, setEditingPanelRef] = useState<{ sectionId: string; panelId: string } | null>(null);
  const [fullscreenPanelRef, setFullscreenPanelRef] = useState<{ sectionId: string; panelId: string } | null>(null);
  const [workspaceSeries, setWorkspaceSeries] = useState<Record<string, MetricSeries[]>>({});
  const [workspaceHistogramTimelines, setWorkspaceHistogramTimelines] = useState<Record<string, HistogramTimelineState>>({});
  const [runsRailCollapsed, setRunsRailCollapsed] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [quickSearchInput, setQuickSearchInput] = useState("");
  const [quickSearchActiveIndex, setQuickSearchActiveIndex] = useState(0);
  const [stopDialog, setStopDialog] = useState<StopDialogState>(null);
  const [stopSubmitting, setStopSubmitting] = useState(false);
  const [stopError, setStopError] = useState("");
  const [workspaceUndoStack, setWorkspaceUndoStack] = useState<WorkspaceView[]>([]);
  const [workspaceRedoStack, setWorkspaceRedoStack] = useState<WorkspaceView[]>([]);
  const [chartZoomRange, setChartZoomRange] = useState<ChartZoomRange>(null);
  const [primaryChartZoomRange, setPrimaryChartZoomRange] = useState<ChartZoomRange>(null);
  const [pinnedChartZoomRanges, setPinnedChartZoomRanges] = useState<Record<string, ChartZoomRange>>({});
  const [usagePayload, setUsagePayload] = useState<UsagePayload | null>(null);
  const [billingPayload, setBillingPayload] = useState<BillingPayload | null>(null);
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [invitationLinks, setInvitationLinks] = useState<Record<string, string>>({});
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  // Empty by default; the input shows a placeholder and create falls back to
  // "Dashboard SDK key" so typed names never append to prefilled text.
  const [apiKeyName, setApiKeyName] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [apiAdminMessage, setApiAdminMessage] = useState("");
  const [apiAdminTone, setApiAdminTone] = useState<"status" | "error">("status");
  const [adminBusy, setAdminBusy] = useState(false);

  const hasSeriesRef = useRef(false);
  const hasPanelSeriesRef = useRef(false);
  const hasWorkspaceSeriesRef = useRef(false);
  const summaryMatchesProject = !project || summary.runs.every((run) => run.project === project);
  // Key the metric option list on its content, not on `summary` identity.
  // Otherwise every pagination produces a new array reference even when the
  // metric keys are unchanged, which re-runs the workspace-reset effect and
  // clears workspaceSeries, making the chart reload on every page change.
  const actualMetricSignature = useMemo(
    () => (summaryMatchesProject ? metricKeysFromSummary(summary) : []).join("\u0000"),
    [summary, summaryMatchesProject],
  );
  const actualMetricOptions = useMemo(
    () => (actualMetricSignature ? actualMetricSignature.split("\u0000") : []),
    [actualMetricSignature],
  );
  const allMetricOptions = useMemo(() => (
    actualMetricOptions.length ? actualMetricOptions : [DEFAULT_METRIC_KEY, "train/reward", "train/loss"]
  ), [actualMetricOptions]);
  const metricOptions = useMemo(() => filterMetricKeys(allMetricOptions, metricFilter), [allMetricOptions, metricFilter]);
  const metricFilterValid = useMemo(() => metricFilterIsRegex(metricFilter), [metricFilter]);
  const columnMetricOptions = useMemo(() => filterMetricKeys(allMetricOptions, columnMetricFilter), [allMetricOptions, columnMetricFilter]);
  const columnMetricFilterValid = useMemo(() => metricFilterIsRegex(columnMetricFilter), [columnMetricFilter]);
  const metricOptionsForControls = useMemo(() => boundedOptions(metricOptions, metricKey), [metricKey, metricOptions]);
  const columnMetricOptionsForControls = useMemo(() => boundedOptions(columnMetricOptions, "", 80), [columnMetricOptions]);

  const sortedRuns = summary.runs;
  const selectedRuns = useMemo(() => {
    const directory = runDirectoryRef.current;
    return selectedRunIds
      .map((id) => {
        const pageRun = sortedRuns.find((run) => run.id === id);
        const cachedRun = directory.get(id);
        return richerRunSummary(selectedRunDetails[id] ?? pageRun ?? cachedRun, cachedRun ?? pageRun);
      })
      .filter(Boolean) as RunSummary[];
  }, [selectedRunDetails, selectedRunIds, sortedRuns]);
  const metricSeriesRuns = useMemo(
    () => (selectedRunIds.length ? selectedRuns : sortedRuns).slice(0, MAX_SELECTED_RUNS),
    [selectedRunIds.length, selectedRuns, sortedRuns],
  );
  // Stable identity for the runs feeding the metric charts: changes only when
  // the set of run ids changes, not on every metadata poll (which replaces the
  // run objects). Lets the series effects gate on selection, not poll churn.
  const metricSeriesRunKey = useMemo(() => metricSeriesRuns.map((run) => run.id).join(","), [metricSeriesRuns]);
  const hasLiveMetricSeriesRun = useMemo(() => metricSeriesRuns.some((run) => run.status === "running"), [metricSeriesRuns]);
  const primaryRun = selectedRunDetails[primaryRunId] ?? sortedRuns.find((run) => run.id === primaryRunId) ?? selectedRuns[0] ?? sortedRuns[0] ?? null;
  // The run detail chart plots the primary (opened) run, which may not belong to
  // the current chart selection — e.g. opening a run beyond the auto-selected
  // set. Always fetch its series on the detail tab so the curve renders instead
  // of the empty "select runs" state.
  const seriesFetchRuns = useMemo(() => {
    if (activeTab === "detail" && primaryRun && !metricSeriesRuns.some((run) => run.id === primaryRun.id)) {
      return [primaryRun, ...metricSeriesRuns].slice(0, MAX_SELECTED_RUNS);
    }
    return metricSeriesRuns;
  }, [activeTab, metricSeriesRuns, primaryRun?.id]);
  const seriesFetchRunKey = useMemo(() => seriesFetchRuns.map((run) => run.id).join(","), [seriesFetchRuns]);
  const dashboardSelectionFilterKey = [project, status, queryInput, query, sortBy, metricKey].join("\u0000");
  useEffect(() => {
    hasSeriesRef.current = series.length > 0;
    hasPanelSeriesRef.current = Object.keys(panelSeries).length > 0;
    hasWorkspaceSeriesRef.current = Object.keys(workspaceSeries).length > 0;
  }, [panelSeries, series, workspaceSeries]);
  useEffect(() => {
    // Remember runs after commit so interrupted renders do not mutate the
    // directory. This keeps off-page selected runs resolvable without making
    // render phase impure.
    const directory = runDirectoryRef.current;
    for (const run of sortedRuns) directory.set(run.id, richerRunSummary(run, directory.get(run.id)) ?? run);
    for (const run of Object.values(selectedRunDetails)) directory.set(run.id, richerRunSummary(run, directory.get(run.id)) ?? run);
  }, [selectedRunDetails, sortedRuns]);
  useEffect(() => {
    selectedRunsRef.current = selectedRuns;
  }, [selectedRuns]);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useLayoutEffect(() => {
    dashboardSelectionFilterKeyRef.current = dashboardSelectionFilterKey;
  }, [dashboardSelectionFilterKey]);
  const handleRunWorkspaceTabChange = useCallback((nextTab: RunWorkspaceTabId) => {
    setRunWorkspaceTab(nextTab);
  }, []);
  const selectedRunKey = selectedRunIds.join(",");
  const selectedRunExportDisabled = selectedRunIds.length === 0 || selectedRunIds.length > MAX_EXPORT_SELECTED_RUNS;
  const selectedRunExportTitle = selectedRunIds.length === 0
    ? "Select one or more runs to export their data as CSV."
    : selectedRunIds.length > MAX_EXPORT_SELECTED_RUNS
      ? `Synchronous CSV export supports up to ${MAX_EXPORT_SELECTED_RUNS} selected runs.`
      : `Export ${selectedRunIds.length} selected runs, metrics, attributes, and artifacts as CSV.`;
  const compareRunIds = useMemo(() => selectedRuns.map((run) => run.id).slice(0, COMPARE_RUN_LIMIT), [selectedRuns]);
  const compareRunKey = compareRunIds.join(",");
  const compareRuns = useMemo(() => (
    compareRunIds
      .map((id) => {
        const pageRun = sortedRuns.find((run) => run.id === id);
        const cachedRun = runDirectoryRef.current.get(id);
        return richerRunSummary(selectedRunDetails[id] ?? pageRun ?? cachedRun, cachedRun ?? pageRun);
      })
      .filter(Boolean) as RunSummary[]
  ), [compareRunIds, selectedRunDetails, sortedRuns]);
  const compareOverflowCount = Math.max(0, selectedRuns.length - compareRunIds.length);
  const referenceRun = compareRuns.find((run) => run.id === referenceRunId) ?? compareRuns[0] ?? null;
  const compareConfigKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const run of compareRuns) {
      for (const key of Object.keys(run.config ?? {})) keys.add(key);
    }
    return [...keys].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).slice(0, 80);
  }, [compareRuns]);
  const compareTableMetricKeys = useMemo(() => {
    const seen = new Set<string>();
    return [metricKey, ...compareTableMetrics]
      .filter((metric) => {
        if (!metric || seen.has(metric) || !allMetricOptions.includes(metric)) return false;
        seen.add(metric);
        return true;
      })
      .slice(0, MAX_COMPARE_TABLE_METRICS);
  }, [allMetricOptions, compareTableMetrics, metricKey]);
  const compareAddMetricOptions = useMemo(() => {
    const selectedMetrics = new Set(compareTableMetricKeys);
    return metricOptionsForControls.filter((metric) => !selectedMetrics.has(metric)).slice(0, MAX_METRIC_OPTIONS);
  }, [compareTableMetricKeys, metricOptionsForControls]);
  const visibleArtifacts = useMemo(() => (
    artifactsRunId === primaryRun?.id ? artifacts.slice(0, ARTIFACT_PAGE_LIMIT) : []
  ), [artifacts, artifactsRunId, primaryRun?.id]);
  const currentMessageTone = messageTone(message);
  const seriesWithGroups = useMemo(() => series.map((item) => {
    const run = selectedRunDetails[item.id] ?? sortedRuns.find((candidate) => candidate.id === item.id);
    return {
      ...item,
      group: run ? groupKeyForRun(run, groupBy) : item.group ?? "all",
      identifier: (run ? identifierForRun(run, identifierMode) : undefined) ?? item.name,
    };
  }), [groupBy, identifierMode, selectedRunDetails, series, sortedRuns]);

  const displaySeries = useMemo(() => {
    const grouped = groupAverage ? averageGroupedSeries(seriesWithGroups) : seriesWithGroups;
    return smoothSeries(grouped, smoothing);
  }, [groupAverage, seriesWithGroups, smoothing]);

  const chartSummaries = useMemo(() => chartSummary(displaySeries), [displaySeries]);
  const metricCatalogSelectionIds = useMemo(
    () => (selectedRunIds.length ? selectedRunIds : sortedRuns.map((run) => run.id)),
    [selectedRunIds, sortedRuns],
  );
  const metricCatalogRows = useMemo(() => buildMetricCatalogRows(sortedRuns, metricOptions, metricCatalogSelectionIds), [metricCatalogSelectionIds, metricOptions, sortedRuns]);
  const visibleMetricCatalogRows = useMemo(() => metricCatalogRows.slice(0, MAX_METRIC_CATALOG_ROWS), [metricCatalogRows]);
  const activeMetricCatalogRow = useMemo(() => metricCatalogRows.find((row) => row.key === metricKey) ?? null, [metricCatalogRows, metricKey]);
  const primaryDisplaySeries = useMemo(() => {
    const found = seriesWithGroups.find((item) => item.id === primaryRun?.id);
    return found ? smoothSeries([found], smoothing) : [];
  }, [primaryRun?.id, seriesWithGroups, smoothing]);
  const pinnedChartPanels = useMemo(() => (
    pinnedMetrics
      .filter((metric) => metric && metric !== metricKey)
      .map((metric) => {
        const rawSeries = panelSeries[metric] ?? [];
        const groupedSeries = rawSeries.map((item) => {
          const run = selectedRunDetails[item.id] ?? sortedRuns.find((candidate) => candidate.id === item.id);
          return {
            ...item,
            group: run ? groupKeyForRun(run, groupBy) : item.group ?? "all",
            identifier: (run ? identifierForRun(run, identifierMode) : undefined) ?? item.name,
          };
        });
        const preparedSeries = smoothSeries(groupAverage ? averageGroupedSeries(groupedSeries) : groupedSeries, smoothing);
        const zoomRange = pinnedChartZoomRanges[metric] ?? null;
        return {
          metric,
          series: preparedSeries,
          summaries: chartSummary(preparedSeries),
          zoomRange,
        };
      })
  ), [groupAverage, groupBy, identifierMode, metricKey, panelSeries, pinnedChartZoomRanges, pinnedMetrics, selectedRunDetails, smoothing, sortedRuns]);
  const inspectedPoint = hover;
  const alertRows = useMemo(() => buildAlertRows(sortedRuns, metricKey), [metricKey, sortedRuns]);
  const datasetRows = useMemo(() => buildDatasetRows(sortedRuns, metricKey), [metricKey, sortedRuns]);
  const runMetricRows = useMemo(() => buildRunMetricRows(primaryRun), [primaryRun]);
  const runTimelineRows = useMemo(() => buildRunTimelineRows(primaryRun, visibleArtifacts, metricKey), [metricKey, primaryRun, visibleArtifacts]);
  const apiStatusParams = useMemo(() => dashboardStatusQueryParams(status, status), [status]);
  const apiRows = useMemo(() => buildApiRows(metricKey, project, apiStatusParams), [apiStatusParams, metricKey, project]);
  const activeOrgId = sessionPayload?.organization?.id ?? "";
  const localSavedViewScope = useMemo(
    () => storageScopeId([activeOrgId, sessionPayload?.user?.primary_email ?? ""].filter(Boolean).join(":")),
    [activeOrgId, sessionPayload?.user?.primary_email],
  );
  const localSavedViewProjectScope = useMemo(
    () => storageScopeId([localSavedViewScope, project || "all"].filter(Boolean).join(":")),
    [localSavedViewScope, project],
  );
  const scopedWorkspaceStorageKey = useMemo(
    () => workspaceStorageKey(project, localSavedViewScope ? localSavedViewProjectScope : ""),
    [localSavedViewProjectScope, localSavedViewScope, project],
  );
  const activeMembershipRole = sessionPayload?.membership?.role ?? "";
  const canWriteRuns = roleCanWriteRuns(activeMembershipRole);
  const sharedDemoSession = isSharedDemoSession(sessionPayload);
  const canManageOrg = roleCanManageOrg(activeMembershipRole) && !sharedDemoSession;
  const canWriteWorkspace = canWriteRuns && !sharedDemoSession;
  const canControlRuns = canWriteRuns && !sharedDemoSession;
  const selectedStopCandidateTotal = useMemo(
    () => selectedRuns.filter((run) => canRequestStop(run, canControlRuns)).length,
    [canControlRuns, selectedRuns],
  );
  const selectedStopCandidateCount = Math.min(MAX_STOP_DIALOG_RUNS, selectedStopCandidateTotal);
  const selectedStopDisabledReason = selectedStopCandidateCount
    ? ""
    : !canControlRuns
      ? "Your role can view runs but cannot stop them."
      : selectedRunIds.length
        ? "Selected runs are not running or are already stopping."
        : "Select running runs that are not already stopping.";
  const canEditReports = canWriteWorkspace;
  const activeMembershipSummary = useMemo(
    () => orgMemberships.find((membership) => membership.org_id === activeOrgId)
      ?? orgMemberships.find((membership) => membership.is_current)
      ?? null,
    [activeOrgId, orgMemberships],
  );
  const activeUsageOrg = useMemo(() => {
    if (!usagePayload) return null;
    if (!activeOrgId) return usagePayload.organizations?.[0] ?? null;
    return usagePayload.organizations?.find((org) => org.org_id === activeOrgId) ?? null;
  }, [activeOrgId, usagePayload]);
  const activeUsage = activeUsageOrg?.usage ?? {};
  const activeLimits = activeUsageOrg?.limits ?? {};
  const usageAvailable = Boolean(activeUsageOrg);
  const storageUsed = Number(activeUsage.storage_bytes_for_warnings ?? activeUsage.warehouse_storage_bytes_exact ?? activeUsage.estimated_storage_bytes_for_warnings ?? activeUsage.artifact_bytes_exact ?? 0);
  const storageLimit = Number(activeLimits.included_storage_bytes ?? 0);
  const storagePercent = storageLimit ? Math.min(100, Math.round((storageUsed / storageLimit) * 100)) : 0;
  const byocStorageAccounting = sessionPayload?.organization?.storage_choice === "customer-clickhouse";
  const storageUsageLabel = byocStorageAccounting ? "Artifact storage" : "Storage";
  const storageUsageDescription = byocStorageAccounting
    ? "BYOC warehouse bytes stay in your ClickHouse account; InstantML counts only artifact bytes stored by us."
    : "";
  const metricUsed = Number(activeUsage.metric_points ?? 0);
  const metricLimit = Number(activeLimits.metric_points ?? 0);
  const metricPercent = metricLimit ? Math.min(100, Math.round((metricUsed / metricLimit) * 100)) : 0;
  const apiRequestsUsed = Number(activeUsage.api_requests ?? 0);
  const apiRequestsLimit = Number(activeLimits.api_requests ?? 0);
  const apiRequestsPercent = apiRequestsLimit ? Math.min(100, Math.round((apiRequestsUsed / apiRequestsLimit) * 100)) : 0;
  const activePlanDetails = activeUsageOrg?.plan ?? {};
  const generalRateLimitLabel = formatRateLimitLabel(activePlanDetails.rate_limit_rps, activePlanDetails.rate_limit_burst);
  const ingestRateLimitLabel = formatRateLimitLabel(
    activePlanDetails.ingest_rate_limit_rps,
    Math.min(
      Number(activePlanDetails.rate_limit_burst ?? 0),
      Number(activePlanDetails.ingest_rate_limit_rps ?? 0) * 5,
    ),
  );
  const activePlan = planDisplayName(activeUsageOrg?.plan_tier ?? sessionPayload?.organization?.plan_tier);
  const usagePeriod = activeUsageOrg?.usage_period ?? usagePayload?.usage_period;
  const usageResetLabel = formatUsageResetLabel(usagePeriod?.reset_at ?? usagePeriod?.ends_at);
  const pageStart = summary.total ? pageOffset + 1 : 0;
  const pageEnd = summary.total ? Math.min(pageOffset + sortedRuns.length, summary.total) : 0;
  const hasPreviousPage = pageOffset > 0;
  const hasNextPage = summary.page_info ? Boolean(summary.page_info.has_next_page) : pageOffset + pageSize < summary.total;
  const currentPageCursor = pageCursorStack.length ? pageCursorStack[pageCursorStack.length - 1] : "";
  const paginationBusy = dashboardLoading || pageNavigationPending;
  const resetRunPagination = useCallback(() => {
    selectAllMatchingControllerRef.current?.abort();
    selectAllMatchingControllerRef.current = null;
    pageNavigationPendingRef.current = false;
    setPageNavigationPending(false);
    setPageCursorStack([]);
    setPageOffset(0);
  }, []);
  const changeProject = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setProject(value);
    // Push the project change onto history so the browser back/forward
    // gestures can restore the prior selection.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (value) params.set("project", value);
      else params.delete("project");
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : "");
      if (url !== window.location.pathname + window.location.search) {
        window.history.pushState(null, "", url);
      }
    }
    if (projectPreferenceLoadedRef.current) {
      if (projectPreferenceWriteTimerRef.current) window.clearTimeout(projectPreferenceWriteTimerRef.current);
      projectPreferenceWriteTimerRef.current = window.setTimeout(() => {
        projectPreferenceWriteTimerRef.current = null;
        api.put("/api/dashboard/preferences", { selected_project: value || null }).catch(() => {
          // Project preference persistence should never block filtering.
        });
      }, 250);
    }
  }, [api, resetRunPagination]);
  const changeStatus = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setStatus(value);
  }, [resetRunPagination]);
  const changeRunQueryInput = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    setQueryInput(value);
  }, []);
  const changeRunSort = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setSortBy(value);
  }, [resetRunPagination]);
  const changeMetricKey = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setMetricKey(value);
  }, [resetRunPagination]);
  useEffect(() => {
    if (previousOrgIdRef.current === activeOrgId) return;
    // First session load is not an org switch: keep the ?project= deep link
    // seeded into state instead of wiping it (the wipe let a stale persisted
    // preference win over the URL).
    const isInitialSession = previousOrgIdRef.current === "";
    previousOrgIdRef.current = activeOrgId;
    if (isInitialSession) return;
    projectPreferenceLoadedRef.current = false;
    userTouchedDashboardFiltersRef.current = false;
    setProjectPreferenceReady(false);
    setProject("");
    setSelectedRunIds([]);
    setSelectedRunDetails({});
    setPrimaryRunId("");
    setReferenceRunId("");
    setSearchError(null);
    resetRunPagination();
  }, [activeOrgId, resetRunPagination]);
  const workspacePanelMetrics = useMemo(() => workspaceMetricKeys(workspaceView, panelSearch), [panelSearch, workspaceView]);
  const workspacePanelMetricKey = useMemo(() => workspacePanelMetrics.join("\u0000"), [workspacePanelMetrics]);
  const workspaceSeriesViewKey = workspaceView.id;
  const availableWorkspaceMetrics = useMemo(() => allMetricOptions.slice(0, MAX_METRIC_OPTIONS), [allMetricOptions]);
  const maxWorkspacePanelRuns = useMemo(() => {
    const values = workspaceView.sections.flatMap((section) => (
      section.panels
        .filter((panel) => workspacePanelNeedsMetricSeries(panel))
        .map((panel) => panel.settings?.maxRuns ?? section.settings?.maxRuns ?? workspaceView.settings.maxRuns)
    ));
    return Math.max(1, Math.min(25, ...values, workspaceView.settings.maxRuns));
  }, [workspaceView]);
  const workspacePanelRuns = useMemo(() => (
    selectedRuns.length ? selectedRuns.slice(0, MAX_SELECTED_RUNS) : sortedRuns
  ), [selectedRuns, sortedRuns]);
  const editingPanelContext = useMemo(() => {
    if (!editingPanelRef) return null;
    const section = workspaceView.sections.find((item) => item.id === editingPanelRef.sectionId);
    const panel = section?.panels.find((item) => item.id === editingPanelRef.panelId);
    return section && panel ? { section, panel } : null;
  }, [editingPanelRef, workspaceView]);
  const editingFieldCatalogMaxRuns = useMemo(() => {
    if (!editingPanelContext || !["scatter", "distribution"].includes(editingPanelContext.panel.type)) return 0;
    return Math.max(1, Math.min(
      25,
      editingPanelContext.panel.settings?.maxRuns
        ?? editingPanelContext.section.settings?.maxRuns
        ?? workspaceView.settings.maxRuns
        ?? 10,
    ));
  }, [
    editingPanelContext,
    editingPanelContext?.panel.settings?.maxRuns,
    editingPanelContext?.section.settings?.maxRuns,
    workspaceView.settings.maxRuns,
  ]);
  const workspaceFieldOptions = useMemo(
    () => {
      if (!editingFieldCatalogMaxRuns) return [];
      return buildRunFieldCatalog(workspacePanelRuns.slice(0, editingFieldCatalogMaxRuns), allMetricOptions) as WorkspaceFieldOption[];
    },
    [allMetricOptions, editingFieldCatalogMaxRuns, workspacePanelRuns],
  );
  const workspaceCategoricalFieldOptions = useMemo(
    () => {
      if (!editingFieldCatalogMaxRuns) return [];
      return buildRunCategoricalFieldCatalog(workspacePanelRuns.slice(0, editingFieldCatalogMaxRuns)) as WorkspaceCategoricalFieldOption[];
    },
    [editingFieldCatalogMaxRuns, workspacePanelRuns],
  );
  const workspaceFetchRuns = useMemo(() => {
    // Always fetch the visible page's runs so the Runs-table Trend column keeps
    // its sparklines no matter what is selected — and so toggling a *visible*
    // row never changes this set (which would otherwise clear workspaceSeries
    // and collapse every Trend cell mid-reload). Union in any off-page selected
    // runs so the workspace line panels (which filter series by run id) still
    // plot selections that aren't on the current page.
    const pageRuns = sortedRuns.slice(0, maxWorkspacePanelRuns);
    if (!selectedRuns.length) return pageRuns;
    const seen = new Set(pageRuns.map((run) => run.id));
    const merged = pageRuns.slice();
    for (const run of selectedRuns) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      merged.push(run);
      if (merged.length >= MAX_SELECTED_RUNS) break;
    }
    return merged.slice(0, MAX_SELECTED_RUNS);
  }, [maxWorkspacePanelRuns, selectedRuns, sortedRuns]);
  const workspaceFetchRunKey = useMemo(() => workspaceFetchRuns.map((run) => run.id).join("\u0000"), [workspaceFetchRuns]);
  const hasLiveWorkspaceRun = useMemo(() => workspaceFetchRuns.some((run) => run.status === "running"), [workspaceFetchRuns]);
  const fullscreenPanelContext = useMemo(() => {
    if (!fullscreenPanelRef) return null;
    const section = workspaceView.sections.find((item) => item.id === fullscreenPanelRef.sectionId);
    const panel = section?.panels.find((item) => item.id === fullscreenPanelRef.panelId);
    return section && panel ? { section, panel } : null;
  }, [fullscreenPanelRef, workspaceView]);
  const workspaceHistogramKeys = useMemo(
    () => workspaceHistogramObjectKeys(workspaceView, panelSearch, fullscreenPanelContext?.panel ?? null),
    [fullscreenPanelContext?.panel, panelSearch, workspaceView],
  );
  const workspaceHistogramKey = useMemo(() => workspaceHistogramKeys.join("\u0000"), [workspaceHistogramKeys]);
  const workspaceHistogramLiveTick = primaryRun?.status === "running" ? liveSeriesTick : 0;
  const fullscreenPanelOrder = useMemo(() => (
    workspaceView.sections.flatMap((section) => section.panels.map((panel) => ({ sectionId: section.id, panelId: panel.id, title: panel.title })))
  ), [workspaceView]);
  const fullscreenPanelIndex = useMemo(() => (
    fullscreenPanelRef
      ? fullscreenPanelOrder.findIndex((item) => item.sectionId === fullscreenPanelRef.sectionId && item.panelId === fullscreenPanelRef.panelId)
      : -1
  ), [fullscreenPanelOrder, fullscreenPanelRef]);
  const modifierLabel = useMemo(() => platformModifierLabel(typeof navigator === "undefined" ? "" : navigator.platform), []);
  const shortcutCommands = useMemo<ShortcutCommand[]>(() => [
    { id: "quick-search", group: "General", label: "Open quick search", shortcut: `${modifierLabel}+K`, enabled: true, description: "Jump to tabs, runs, metrics, projects, saved views, and artifacts." },
    { id: "shortcut-help", group: "General", label: "Show keyboard shortcuts", shortcut: "?", enabled: true },
    { id: "escape", group: "General", label: "Close top overlay", shortcut: "Esc", enabled: true },
    { id: "undo-workspace", group: "Workspace", label: "Undo workspace change", shortcut: `${modifierLabel}+Z`, enabled: workspaceUndoStack.length > 0 },
    { id: "redo-workspace", group: "Workspace", label: "Redo workspace change", shortcut: `${modifierLabel}+Shift+Z`, enabled: workspaceRedoStack.length > 0 },
    { id: "tab-jump", group: "Navigation", label: "Jump to tab (rail order)", shortcut: "1-9", enabled: true, description: "1 opens Runs, 2 Metrics, and so on down the sidebar." },
    { id: "runs-rail", group: "Navigation", label: runsRailCollapsed ? "Restore Runs selector" : "Collapse Runs selector", shortcut: `${modifierLabel}+.`, enabled: activeTab === "runs" },
    { id: "focus-workspace", group: "Navigation", label: "Focus Runs selector or workspace", shortcut: `${modifierLabel}+J`, enabled: activeTab === "runs" },
    { id: "fullscreen-prev", group: "Panels", label: "Previous fullscreen panel", shortcut: "Left Arrow", enabled: Boolean(fullscreenPanelContext && fullscreenPanelIndex > 0) },
    { id: "fullscreen-next", group: "Panels", label: "Next fullscreen panel", shortcut: "Right Arrow", enabled: Boolean(fullscreenPanelContext && fullscreenPanelIndex >= 0 && fullscreenPanelIndex < fullscreenPanelOrder.length - 1) },
  ], [activeTab, fullscreenPanelContext, fullscreenPanelIndex, fullscreenPanelOrder.length, modifierLabel, runsRailCollapsed, workspaceRedoStack.length, workspaceUndoStack.length]);
  const fullscreenModalRef = useFocusTrap<HTMLDivElement>(
    Boolean(fullscreenPanelContext),
    () => setFullscreenPanelRef(null),
    "button[aria-label='Close fullscreen panel']",
  );
  const stopDialogRef = useFocusTrap<HTMLDivElement>(
    Boolean(stopDialog),
    closeStopDialog,
    "#stop-reason",
  );
  const quickSearchItems = useMemo<QuickSearchItem[]>(() => {
    const items: QuickSearchItem[] = [
      ...tabs.map((tab) => ({
        id: `tab:${tab.id}`,
        group: "Tab",
        label: tab.label,
        description: `Open ${tab.label}`,
        onSelect: () => selectTab(tab.id),
      })),
      ...projects.map((item) => ({
        id: `project:${item}`,
        group: "Project",
        label: item,
        description: "Filter dashboard by project",
        onSelect: () => {
          changeProject(item);
          selectTab("runs");
        },
      })),
      ...sortedRuns.slice(0, 80).map((run) => ({
        id: `run:${run.id}`,
        group: "Run",
        label: run.name,
        description: `${run.project} · ${displayStatusForRun(run)} · ${(run.tags ?? []).join(" ")} · ${run.metadata?.notes ?? ""}`,
        onSelect: () => {
          setPrimaryRunId(run.id);
          selectTab("detail");
        },
      })),
      ...allMetricOptions.slice(0, 80).map((metric) => ({
        id: `metric:${metric}`,
        group: "Metric",
        label: metricTitle(metric),
        description: metric,
        onSelect: () => {
          changeMetricKey(metric);
          selectTab("metrics");
        },
      })),
      ...savedViews.map((view) => ({
        id: `view:${view.value}`,
        group: "View",
        label: view.label,
        description: view.source === "system" ? "Open built-in research view" : view.source === "control" ? "Apply saved workspace view" : "Apply local saved view",
        onSelect: () => applySavedView(view.value),
      })),
      ...visibleArtifacts.slice(0, 30).map((artifact) => ({
        id: `artifact:${artifact.id}`,
        group: "Artifact",
        label: artifact.name,
        description: `${artifact.type}${artifact.step === null ? "" : ` · step ${artifact.step}`}`,
        onSelect: () => selectTab("artifacts"),
      })),
      {
        id: "command:toggle-theme",
        group: "Command",
        label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        description: "Toggle app appearance",
        onSelect: () => setTheme((current) => current === "dark" ? "light" : "dark"),
      },
      {
        id: "command:toggle-runs-rail",
        group: "Command",
        label: runsRailCollapsed ? "Restore Runs selector" : "Collapse Runs selector",
        description: "Reclaim workspace width on the Runs page",
        onSelect: () => {
          setRunsRailCollapsed((current) => !current);
          selectTab("runs");
        },
      },
    ];
    return items;
  }, [allMetricOptions, changeMetricKey, changeProject, projects, runsRailCollapsed, savedViews, sortedRuns, theme, visibleArtifacts]);
  const filteredQuickSearchItems = useMemo(() => {
    const queryParts = quickSearchInput.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = queryParts.length
      ? quickSearchItems.filter((item) => {
        const haystack = `${item.group} ${item.label} ${item.description}`.toLowerCase();
        return queryParts.every((part) => quickSearchTokenMatches(haystack, part));
      })
      : quickSearchItems;
    return filtered.slice(0, 24);
  }, [quickSearchInput, quickSearchItems]);
  const selectedControlSavedView = useMemo(
    () => savedViews.find((view) => view.value === savedViewKey && view.source === "control") ?? null,
    [savedViewKey, savedViews],
  );

  const loadProjects = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    try {
      const retryOptions = { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS };
      const projectPayload = await retryTransientRequest(() => api.get("/projects", options), retryOptions);
      const names = (projectPayload.projects ?? []).map((item: { name: string }) => item.name);
      setProjects(names);
      setProject((current) => current && !names.includes(current) ? "" : current);
      if (!projectPreferenceLoadedRef.current) {
        projectPreferenceLoadedRef.current = true;
        try {
          const preferencePayload = await retryTransientRequest(() => api.get("/api/dashboard/preferences", options), retryOptions);
          const selectedProject = preferencePayload?.preferences?.selected_project;
          if (typeof selectedProject === "string" && names.includes(selectedProject) && !userTouchedDashboardFiltersRef.current) {
            setProject((current) => current || selectedProject);
          }
        } catch (error) {
          if (isAbortError(error)) return;
          // Preferences are control-plane convenience state. Runs should still load if they fail.
        }
      }
    } catch (error) {
      if (!isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load projects.");
    } finally {
      if (!options.signal?.aborted) setProjectPreferenceReady(true);
    }
  }, [api]);

  const loadSavedViews = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (activeOrgId) migrateLegacySavedViewsToScope(activeOrgId, localSavedViewProjectScope);
    const localOptions = localSavedViewOptions(localSavedViewProjectScope);
    try {
      const payload = await api.get("/api/workspace-views", options);
      const controlOptions = workspaceViewSummariesFromPayload(payload)
        .map((view) => ({
          label: view.name,
          project: view.project ?? null,
          source: "control" as const,
          updatedAt: view.updated_at,
          value: controlSavedViewKey(view.id),
        }));
      setSavedViews([...controlOptions, ...localOptions]);
    } catch (error) {
      if (!isAbortError(error)) setSavedViews(localOptions);
    }
  }, [activeOrgId, api, localSavedViewProjectScope]);

  const loadDashboard = useCallback(async (options: { signal?: AbortSignal; silent?: boolean } = {}) => {
    const silent = Boolean(options.silent);
    const requestOptions = options.signal ? { signal: options.signal } : {};
    const requestId = dashboardRequestRef.current + 1;
    const previousMessage = messageRef.current;
    if (warehouseRetryTimerRef.current) {
      window.clearTimeout(warehouseRetryTimerRef.current);
      warehouseRetryTimerRef.current = null;
    }
    dashboardRequestRef.current = requestId;
    if (!silent) {
      setDashboardLoading(true);
      // Only surface the "Loading runs..." copy on the genuine first load. On
      // subsequent reloads (sorting, filtering, paging) keep the prior status
      // message stable so it doesn't flicker through transient loading text.
      if (!initialLoadDone && shouldSurfaceRunLoadMessage(activeTabRef.current)) setMessage("Loading runs...");
    }
    let keepInitialRunsLoading = false;
    try {
      const displayStatus = normalizeDisplayStatus(status);
      const statusParams = dashboardStatusQueryParams(displayStatus, status);
      const params = currentPageCursor
        ? { project, ...statusParams, q: query, limit: pageSize, cursor: currentPageCursor, sort_by: sortBy, metric_key: metricKey }
        : { project, ...statusParams, q: query, limit: pageSize, offset: pageOffset, sort_by: sortBy, metric_key: metricKey };
      const retryOptions = { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS };
      let summaryPayload: Summary;
      try {
        summaryPayload = await retryTransientRequest(
          () => api.get(`/api/runs/summary${queryString(params)}`, requestOptions),
          retryOptions,
        ) as Summary;
      } catch (error) {
        const nextSearchError = searchErrorFromApi(error, query);
        if (nextSearchError) {
          if (requestId !== dashboardRequestRef.current) return;
          setSearchError(nextSearchError);
          if (!silent) setMessage(previousMessage);
          return;
        }
        throw error;
      }
      if (requestId !== dashboardRequestRef.current) return;
      const overviewResult = await retryTransientRequest(
        () => api.get(`/api/overview${queryString({ project, ...statusParams, q: query, metric_key: metricKey })}`, requestOptions),
        retryOptions,
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (requestId !== dashboardRequestRef.current) return;
      const nextSummary = summaryPayload as Summary;
      setSearchError(null);
      if (overviewResult.status === "fulfilled") {
        setOverview(overviewResult.value.overview as Overview);
      }
      setSummary(nextSummary);
      if (nextSummary.total > 0 && pageOffset >= nextSummary.total) {
        setPageCursorStack([]);
        setPageOffset(Math.floor((nextSummary.total - 1) / pageSize) * pageSize);
      }
      setSelectedRunIds((current) => {
        const next = defaultRunSelection(current, nextSummary.runs, defaultSelectionInitializedRef.current);
        defaultSelectionInitializedRef.current = next.initialized;
        return next.ids;
      });
      setPrimaryRunId((current) => current || nextSummary.runs[0]?.id || "");
      if (silent) {
        // Keep the user's current status message stable during background polls.
      } else if (!shouldSurfaceRunLoadMessage(activeTabRef.current)) {
        // Non-run tabs (notably Reports) own their visible error/status copy.
        // The shared run directory can refresh in the background without
        // making a healthy tab look broken because an unrelated data route
        // failed.
      } else if (overviewResult.status === "rejected" && !isAbortError(overviewResult.reason) && !isWarehouseStartingError(overviewResult.reason)) {
        setMessage("Runs loaded. Overview is still syncing.");
      } else {
        setMessage(runsPageMessage(nextSummary.total, pageOffset, nextSummary.runs.length));
      }
    } catch (error) {
      if (requestId === dashboardRequestRef.current && !isAbortError(error)) {
        const detail = error instanceof Error ? error.message : "Unable to load runs.";
        if (!silent && shouldSurfaceRunLoadMessage(activeTabRef.current)) setMessage(detail);
        if (isWarehouseStartingError(error) && !options.signal?.aborted) {
          keepInitialRunsLoading = shouldSurfaceRunLoadMessage(activeTabRef.current) && !initialLoadDone;
          warehouseRetryTimerRef.current = window.setTimeout(() => {
            warehouseRetryTimerRef.current = null;
            if (!options.signal?.aborted) void loadDashboard();
          }, WAREHOUSE_RETRY_MS);
        }
      }
    } finally {
      if (requestId === dashboardRequestRef.current) {
        if (!silent) setDashboardLoading(keepInitialRunsLoading);
        pageNavigationPendingRef.current = false;
        setPageNavigationPending(false);
        if (!keepInitialRunsLoading && !options.signal?.aborted) setInitialLoadDone(true);
      }
    }
  }, [api, currentPageCursor, initialLoadDone, metricKey, pageOffset, pageSize, project, query, sortBy, status]);

  useEffect(() => {
    const controller = new AbortController();
    async function checkSession() {
      try {
        const session = await api.get("/api/auth/session", { signal: controller.signal });
        if (session.authenticated) {
          const destination = postAuthRedirectPath(session, window.location.pathname || "/dashboard/runs");
          if (destination.startsWith("/onboarding")) {
            setDashboardAuthMessage("Finish storage setup before opening the dashboard.");
            window.location.replace(destination);
            return;
          }
          setSessionPayload(session as DashboardSessionPayload);
          setDashboardAuthorized(true);
          setDashboardSessionChecked(true);
          return;
        }
        const next = sanitizeNextPath(window.location.pathname || "/dashboard/runs");
        window.location.replace(`/signin?next=${encodeURIComponent(next)}`);
      } catch (error) {
        if (isAbortError(error)) return;
        if (error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 401) {
          const next = sanitizeNextPath(window.location.pathname || "/dashboard/runs");
          window.location.replace(`/signin?next=${encodeURIComponent(next)}`);
          return;
        }
        setDashboardAuthMessage(error instanceof Error ? error.message : "Unable to check your session.");
        setDashboardSessionChecked(true);
        setInitialLoadDone(true);
      }
    }
    checkSession();
    return () => controller.abort();
  }, [api]);

  const signOut = useCallback(async () => {
    setDashboardAuthorized(false);
    setSessionPayload(null);
    try {
      await api.post("/api/auth/logout", {}).catch(() => undefined);
      await clerk.signOut({ redirectUrl: "/signin?signed_out=1" }).catch(() => undefined);
      window.location.replace("/signin?signed_out=1");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to sign out.";
      setDashboardAuthMessage(detail);
      setMessage(detail);
    }
  }, [api, clerk]);

  const loadOrgMemberships = useCallback(
    async (options: { signal?: AbortSignal } = {}) => {
      try {
        const payload = await api.get("/api/orgs/memberships", options);
        if (Array.isArray(payload?.memberships)) {
          setOrgMemberships(payload.memberships as OrgMembershipSummary[]);
        }
      } catch (error) {
        if (isAbortError(error)) return;
        // Don't surface — switcher hides when memberships is empty, which is
        // the safe behavior on a transient list failure. The user can refresh.
      }
    },
    [api],
  );

  // Switch the session's bound org. The backend returns a refreshed session
  // cookie and payload; the hard reload makes every org-scoped panel re-query
  // instead of carrying run or metric selection across workspace boundaries.
  const switchOrganization = useCallback(
    async (targetOrgId: string) => {
      if (!targetOrgId) return;
      if (sessionPayload?.organization?.id === targetOrgId) return;
      setOrgSwitchBusy(true);
      setOrgSwitchError("");
      try {
        await api.post("/api/auth/switch-organization", { org_id: targetOrgId });
        // Hard reload so all per-org caches (runs, metrics, usage, api keys,
        // saved views) re-fetch under the new session.org_id. Reloading is the
        // boring choice — it also wipes any client-side selection that was
        // scoped to the previous org's run ids.
        window.location.assign(window.location.pathname);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unable to switch organization.";
        setOrgSwitchError(detail);
        setMessage(detail);
        if (error instanceof ApiError && error.status === 403) {
          // Membership was revoked mid-session — refresh the list so the
          // dropdown drops the now-unreachable org instead of showing it.
          loadOrgMemberships();
        }
      } finally {
        setOrgSwitchBusy(false);
      }
    },
    [api, loadOrgMemberships, sessionPayload?.organization?.id],
  );

  const checkWorkspaceName = useCallback(
    async (name: string): Promise<WorkspaceNameAvailability> => {
      return await api.get(`/api/orgs/name-availability${queryString({ name })}`) as WorkspaceNameAvailability;
    },
    [api],
  );

  const createWorkspace = useCallback(
    async (input: CreateWorkspaceInput) => {
      setOrgSwitchBusy(true);
      setOrgSwitchError("");
      setMessage(input.plan_tier === "free" ? "Creating workspace..." : "Opening checkout...");
      try {
        const payload = await api.post("/api/orgs/current-user", input);
        const checkoutUrl = safeCheckoutRedirectUrl(payload?.billing_checkout?.url);
        if (checkoutUrl) {
          window.location.assign(checkoutUrl);
          return;
        }
        if (payload?.billing_checkout?.url) throw new Error("Billing checkout URL was not trusted.");
        if (payload?.billing_checkout) {
          setMessage("Workspace created, but checkout could not be opened. Retry from billing settings.");
          window.location.assign("/dashboard/settings");
          return;
        }
        window.location.assign(window.location.pathname);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unable to create workspace.";
        setOrgSwitchError(detail);
        setMessage(detail);
        throw error;
      } finally {
        setOrgSwitchBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!dashboardAuthorized) return;
    const controller = new AbortController();
    loadOrgMemberships({ signal: controller.signal });
    return () => controller.abort();
  }, [dashboardAuthorized, loadOrgMemberships]);

  useEffect(() => {
    if (!dashboardAuthorized) return;
    const controller = new AbortController();
    if (!projectPreferenceLoadedRef.current) setProjectPreferenceReady(false);
    loadProjects({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, dashboardAuthorized, loadProjects]);

  useEffect(() => {
    if (!dashboardAuthorized) return;
    const controller = new AbortController();
    loadSavedViews({ signal: controller.signal });
    return () => controller.abort();
  }, [dashboardAuthorized, loadSavedViews]);

  useEffect(() => {
    if (!dashboardAuthorized || !projectPreferenceReady) return;
    const controller = new AbortController();
    loadDashboard({ signal: controller.signal });
    return () => controller.abort();
  }, [dashboardAuthorized, loadDashboard, projectPreferenceReady]);

  useEffect(() => {
    if (!dashboardAuthorized || !initialLoadDone) return undefined;
    let controller: AbortController | null = null;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      void loadDashboard({ signal: controller.signal, silent: true });
    };
    const interval = window.setInterval(poll, 5_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
      controller?.abort();
    };
  }, [dashboardAuthorized, initialLoadDone, loadDashboard]);

  // Drive live chart refreshes while runs are training. Bumping the tick on a
  // timer re-runs the series effects below, which refetch in place (no clear)
  // so loss curves extend live. Only runs when a charted run is "running" and
  // the relevant tab is visible, so idle dashboards stay quiet.
  useEffect(() => {
    if (!dashboardAuthorized || !initialLoadDone) return undefined;
    const onMetricChart = activeTab === "metrics" || (activeTab === "detail" && runWorkspaceTab === "data");
    const onWorkspaceChart = activeTab === "runs" && workspacePanelMetrics.length > 0;
    const live = (onMetricChart && hasLiveMetricSeriesRun) || (onWorkspaceChart && hasLiveWorkspaceRun);
    if (!live) {
      // A run just stopped (or we left a chart tab): one last refresh so the
      // curve shows its final points instead of freezing a tick short.
      if (liveSeriesActiveRef.current) {
        liveSeriesActiveRef.current = false;
        setLiveSeriesTick((value) => value + 1);
      }
      return undefined;
    }
    liveSeriesActiveRef.current = true;
    const tick = () => {
      if (document.visibilityState === "visible") setLiveSeriesTick((value) => value + 1);
    };
    const interval = window.setInterval(tick, LIVE_SERIES_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [activeTab, dashboardAuthorized, hasLiveMetricSeriesRun, hasLiveWorkspaceRun, initialLoadDone, runWorkspaceTab, workspacePanelMetrics.length]);

  useEffect(() => {
    if (queryInput === query) return undefined;
    const timer = window.setTimeout(() => {
      resetRunPagination();
      setQuery(queryInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, queryInput, resetRunPagination]);

  useEffect(() => {
    setPageCursorStack([]);
    setPageOffset(0);
  }, [metricKey, sortBy]);

  useEffect(() => {
    setChartZoomRange(null);
    setPrimaryChartZoomRange(null);
    setPinnedChartZoomRanges({});
    setHover(null);
  }, [groupAverage, groupBy, metricKey, selectedRunKey, smoothing, xMode]);

  useEffect(() => {
    setPageCursorStack([]);
    setPageOffset(0);
    if (applyingSavedViewRef.current) {
      applyingSavedViewRef.current = false;
      return;
    }
    if (applyingUrlSelectionRef.current) {
      applyingUrlSelectionRef.current = false;
      return;
    }
    // Programmatic project fills (preference load on mount) must not wipe a
    // URL-seeded or explicitly made selection — only user-driven filter
    // changes reset the selection.
    if (!userTouchedDashboardFiltersRef.current && selectionUrlSyncRef.current) return;
    setSelectedRunIds([]);
    setPrimaryRunId("");
    setReferenceRunId("");
  }, [project, query, status]);

  useEffect(() => {
    summaryTotalRef.current = summary.total;
  }, [summary.total]);

  useEffect(() => {
    return () => {
      if (warehouseRetryTimerRef.current) window.clearTimeout(warehouseRetryTimerRef.current);
      if (projectPreferenceWriteTimerRef.current) window.clearTimeout(projectPreferenceWriteTimerRef.current);
      selectAllMatchingControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    function applyRouteTab() {
      // Preserve any query string (notably ?project=…) when normalizing the path,
      // so back/forward navigation through pushed history entries doesn't strip
      // the project selection.
      const search = window.location.search;
      const legacyPath = pathFromLegacyHash(window.location.hash);
      if (legacyPath) {
        window.history.replaceState(null, "", legacyPath + search);
      } else {
        const canonicalPath = canonicalDashboardPath(window.location.pathname);
        if (window.location.pathname !== canonicalPath) window.history.replaceState(null, "", canonicalPath + search);
      }
      const nextTab = shellTabFromPath(window.location.pathname);
      setActiveTab(nextTab);
      // Sync project state from the URL on popstate so back/forward restores
      // the previously-selected project.
      const projectParam = new URLSearchParams(window.location.search).get("project") ?? "";
      setProject(projectParam);
      // Restore an explicit run selection carried by the history entry. The
      // one-shot ref stops the project/filter clear effect from wiping the
      // restored selection in the same render batch.
      const urlRunIds = runSelectionFromSearch(window.location.search);
      if (urlRunIds.length) {
        defaultSelectionInitializedRef.current = true;
        selectionUrlSyncRef.current = true;
        applyingUrlSelectionRef.current = true;
        setSelectedRunIds(urlRunIds);
      }
      const label = tabs.find((tab) => tab.id === nextTab)?.label ?? nextTab;
      const summaryTotal = summaryTotalRef.current;
      setMessage(nextTab === "runs" && summaryTotal ? runsPageMessage(summaryTotal, 0, 0) : `Opened ${label}.`);
    }
    applyRouteTab();
    window.addEventListener("popstate", applyRouteTab);
    window.addEventListener("hashchange", applyRouteTab);
    return () => {
      window.removeEventListener("popstate", applyRouteTab);
      window.removeEventListener("hashchange", applyRouteTab);
    };
  }, []);

  useEffect(() => {
    const label = tabs.find((tab) => tab.id === activeTab)?.label ?? activeTab;
    const expected = activeTab === "runs" && summary.total ? runsPageMessage(summary.total, pageOffset, sortedRuns.length) : `Opened ${label}.`;
    setMessage((current) => current.startsWith("Opened ") && current !== expected ? expected : current);
  }, [activeTab, pageOffset, sortedRuns.length, summary.total]);

  useEffect(() => {
    setHover(null);
    setHoverMetricKey(metricKey);
  }, [activeTab, metricKey]);

  useEffect(() => {
    if (!metricOptions.includes(metricKey)) {
      resetRunPagination();
      setMetricKey(preferredMetricKey(metricOptions));
    }
  }, [metricKey, metricOptions, resetRunPagination]);

  useEffect(() => {
    setCompareTableMetrics((current) => {
      const seen = new Set<string>();
      return current
        .filter((metric) => {
          if (!metric || metric === metricKey || seen.has(metric) || !allMetricOptions.includes(metric)) return false;
          seen.add(metric);
          return true;
        })
        .slice(0, Math.max(0, MAX_COMPARE_TABLE_METRICS - 1));
    });
    setCompareSortMetricKey((current) => (current && allMetricOptions.includes(current) ? current : metricKey));
  }, [allMetricOptions, metricKey]);

  useEffect(() => {
    if (!compareConfigKeys.length) {
      if (compareConfigSortKey) setCompareConfigSortKey("");
      return;
    }
    if (!compareConfigSortKey || !compareConfigKeys.includes(compareConfigSortKey)) {
      setCompareConfigSortKey(compareConfigKeys.includes("seed") ? "seed" : compareConfigKeys[0]);
    }
  }, [compareConfigKeys, compareConfigSortKey]);

  useEffect(() => {
    setPinnedMetrics((current) => current.filter((metric) => allMetricOptions.includes(metric)).slice(0, 4));
  }, [allMetricOptions]);

  useEffect(() => {
    setSavedViews(localSavedViewOptions(localSavedViewProjectScope));
    setRunsRailCollapsed(localStorage.getItem(RUNS_RAIL_COLLAPSED_KEY) === "true");
    const storedTheme = localStorage.getItem(THEME_KEY);
    const nextTheme = storedTheme === "dark" || storedTheme === "light"
      ? storedTheme
      : "light";
    setTheme(nextTheme);
    setThemeReady(true);
  }, [localSavedViewProjectScope]);

  useEffect(() => {
    if (!activeOrgId || !localSavedViewProjectScope) return;
    migrateLegacySavedViewsToScope(activeOrgId, localSavedViewProjectScope);
    setSavedViews((current) => {
      const localOptions = localSavedViewOptions(localSavedViewProjectScope);
      const nonLocalOptions = current.filter((option) => option.source !== "local");
      const seen = new Set(nonLocalOptions.map((option) => option.value));
      return [
        ...nonLocalOptions,
        ...localOptions.filter((option) => !seen.has(option.value)),
      ];
    });
  }, [activeOrgId, localSavedViewProjectScope]);

  useEffect(() => {
    workspaceViewRef.current = workspaceView;
  }, [workspaceView]);

  useEffect(() => {
    if (project && !summaryMatchesProject) {
      setWorkspaceReady(false);
      if (hasWorkspaceSeriesRef.current) setWorkspaceSeries({});
      return;
    }
    let raw = safeSavedView(localStorage.getItem(scopedWorkspaceStorageKey));
    if (!raw && localSavedViewScope) {
      for (const legacyKey of legacyWorkspaceStorageKeys(project, activeOrgId)) {
        const legacyRaw = safeSavedView(localStorage.getItem(legacyKey));
        if (!legacyRaw) continue;
        raw = legacyRaw;
        localStorage.setItem(scopedWorkspaceStorageKey, JSON.stringify(legacyRaw));
        break;
      }
    } else if (!raw) {
      raw = safeSavedView(localStorage.getItem(workspaceStorageKey(project)));
    }
    setWorkspaceView(sanitizeWorkspaceView(raw, actualMetricOptions, project));
    setWorkspaceReady(Boolean(raw) || actualMetricOptions.length > 0);
    if (hasWorkspaceSeriesRef.current) setWorkspaceSeries({});
    setAddPanelSectionId("");
    setEditingPanelRef(null);
    setFullscreenPanelRef(null);
    setWorkspaceUndoStack([]);
    setWorkspaceRedoStack([]);
  }, [activeOrgId, actualMetricOptions, actualMetricSignature, localSavedViewScope, project, scopedWorkspaceStorageKey, summaryMatchesProject]);

  useEffect(() => {
    if (!summaryMatchesProject || !actualMetricOptions.length) return;
    setWorkspaceReady(true);
    setWorkspaceView((current) => {
      if (current.project !== (project || null) || current.mode !== "automatic") return current;
      const present = current.sections.flatMap((section) => section.panels.map((panel) => panel.metricKey));
      const expected = new Set(actualMetricOptions);
      const hasProjectMismatch = present.length !== expected.size || present.some((key) => !expected.has(key));
      if (!hasProjectMismatch && current.sections.some((section) => section.panels.length)) return current;
      return buildAutomaticWorkspace(actualMetricOptions, project);
    });
  }, [actualMetricOptions, actualMetricSignature, project, summaryMatchesProject]);

  useEffect(() => {
    if (!workspaceReady) return;
    if (workspaceView.project !== (project || null)) return;
    localStorage.setItem(scopedWorkspaceStorageKey, JSON.stringify({ ...workspaceView, updatedAt: new Date().toISOString() }));
  }, [project, scopedWorkspaceStorageKey, workspaceReady, workspaceView]);

  // Mirror explicit run selections into ?runs=… (replaceState, capped) so the
  // current compare/chart context survives reloads and can be shared.
  useEffect(() => {
    if (typeof window === "undefined" || !selectionUrlSyncRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const encoded = runSelectionSearchParam(selectedRunIds);
    if ((params.get("runs") ?? "") === encoded) return;
    if (encoded) params.set("runs", encoded);
    else params.delete("runs");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, [selectedRunIds]);

  useEffect(() => {
    localStorage.setItem(RUNS_RAIL_COLLAPSED_KEY, String(runsRailCollapsed));
  }, [runsRailCollapsed]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (themeReady) localStorage.setItem(THEME_KEY, theme);
  }, [theme, themeReady]);

  useEffect(() => {
    setQuickSearchActiveIndex(0);
  }, [quickSearchInput]);

  useEffect(() => {
    if (quickSearchActiveIndex >= filteredQuickSearchItems.length) {
      setQuickSearchActiveIndex(Math.max(0, filteredQuickSearchItems.length - 1));
    }
  }, [filteredQuickSearchItems.length, quickSearchActiveIndex]);

  useEffect(() => () => {
    if (hoverFrameRef.current !== null) window.cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  // This effect owns selectedRunDetails hydration. Key it on the selection and
  // current page data, not selectedRunDetails itself, so pruning/replacing page
  // detail objects cannot schedule a render loop.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const keepIds = [...new Set([...selectedRunIds, primaryRunId, referenceRunId].filter(Boolean))];
    const pageDetails = Object.fromEntries(sortedRuns.filter((run) => keepIds.includes(run.id)).map((run) => [run.id, run]));
    const missingIds = keepIds
      .filter((id) => (!selectedRunDetails[id] && !pageDetails[id]) || (runHasPendingStop(selectedRunDetails[id]) && !pageDetails[id]))
      .slice(0, SELECTED_RUN_DETAILS_HYDRATION_LIMIT);
    if (!missingIds.length) {
      setSelectedRunDetails((current) => pruneRunDetails(current, pageDetails, {}, keepIds));
      return () => {
        cancelled = true;
        controller.abort();
      };
    };
    const results: Array<{ id: string; run: RunSummary | null; notFound: boolean }> = [];
    const tasks = missingIds.map((id) => async () => {
      try {
        const payload = await api.get(`/runs/${id}`, { signal: controller.signal });
        results.push({ id, run: payload.run as RunSummary, notFound: false });
      } catch (error) {
        if (isAbortError(error)) throw error;
        results.push({ id, run: null, notFound: isNotFoundError(error) });
      }
    });
    runWithConcurrency(tasks, 6).then(() => {
      if (cancelled || controller.signal.aborted) return;
      const found = results.map((result) => result.run).filter(Boolean) as RunSummary[];
      const fetchedDetails = Object.fromEntries(found.map((run) => [run.id, run]));
      const invalidIds = new Set(results.filter((result) => result.notFound).map((result) => result.id));
      const keepValidatedIds = keepIds.filter((id) => !invalidIds.has(id));
      setSelectedRunIds((current) => {
        // Identity-stable when nothing pruned: a new array here re-triggers
        // this effect and can fetch-loop while detail requests are failing.
        if (invalidIds.size === 0) return current;
        const retained = current.filter((id) => !invalidIds.has(id));
        if (retained.length) return retained;
        if (current.length) return [];
        const next = defaultRunSelection([], sortedRuns, defaultSelectionInitializedRef.current);
        defaultSelectionInitializedRef.current = next.initialized;
        return next.ids;
      });
      setPrimaryRunId((current) => current && !invalidIds.has(current) ? current : sortedRuns[0]?.id ?? "");
      setReferenceRunId((current) => current && !invalidIds.has(current) ? current : "");
      setSelectedRunDetails((current) => pruneRunDetails(current, pageDetails, fetchedDetails, keepValidatedIds));
    }).catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load selected runs.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, primaryRunId, referenceRunId, selectedRunIds, sortedRuns]);

  useEffect(() => {
    if (preserveRunWorkspaceTabOnceRef.current) {
      preserveRunWorkspaceTabOnceRef.current = false;
      return;
    }
    setRunWorkspaceTab("summary");
  }, [primaryRun?.id]);

  useEffect(() => {
    compareArtifactCacheVersionRef.current += 1;
    compareArtifactCacheRef.current.clear();
    compareArtifactInflightRef.current.clear();
  }, [runMetadataVersion]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const signature = `${activeTab}|${runWorkspaceTab}|${metricKey}|${seriesFetchRunKey}`;
    const isLiveRefresh = signature === seriesSignatureRef.current;
    seriesSignatureRef.current = signature;
    async function loadMetricSeries() {
      const shouldLoad = activeTab === "metrics" || (activeTab === "detail" && runWorkspaceTab === "data");
      const runsForFetch = seriesFetchRuns;
      if (!shouldLoad || !metricKey || !runsForFetch.length) {
        if (hasSeriesRef.current) setSeries([]);
        return;
      }
      // Live refreshes (only the tick changed) keep the current curve on screen
      // and swap in the new points atomically; selection/metric changes clear
      // first and stream chunks for responsiveness.
      if (!isLiveRefresh && hasSeriesRef.current) setSeries([]);
      const metricPayloads = await fetchBatchedMetricSeries(api, metricKey, runsForFetch, controller.signal, isLiveRefresh ? undefined : (patch) => {
        if (!cancelled) setSeries(patch);
      });
      if (!cancelled) setSeries(metricPayloads);
    }
    loadMetricSeries().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load metric series.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, metricKey, seriesFetchRunKey, runWorkspaceTab, liveSeriesTick]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const pinnedKey = pinnedMetrics.join(",");
    const signature = `${activeTab}|${metricKey}|${metricSeriesRunKey}|${pinnedKey}`;
    const isLiveRefresh = signature === panelSeriesSignatureRef.current;
    panelSeriesSignatureRef.current = signature;
    async function loadPinnedMetricSeries() {
      const metricsToLoad = pinnedMetrics.filter((metric) => metric && metric !== metricKey);
      const runsForFetch = metricSeriesRuns;
      if (activeTab !== "metrics" || !metricsToLoad.length || !runsForFetch.length) {
        if (hasPanelSeriesRef.current) setPanelSeries({});
        return;
      }
      if (!isLiveRefresh && hasPanelSeriesRef.current) setPanelSeries({});
      const next = await fetchMetricSeriesForMetrics(api, metricsToLoad, runsForFetch, controller.signal, (metric, patch) => {
        if (!cancelled && !isLiveRefresh) setPanelSeries((current) => ({ ...current, [metric]: patch }));
      });
      if (!cancelled) setPanelSeries(next);
    }
    loadPinnedMetricSeries().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load pinned metric panels.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, metricKey, metricSeriesRunKey, pinnedMetrics, liveSeriesTick]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const signature = `${activeTab}|${workspaceSeriesViewKey}|${workspaceFetchRunKey}|${workspacePanelMetricKey}`;
    const isLiveRefresh = signature === workspaceSeriesSignatureRef.current;
    workspaceSeriesSignatureRef.current = signature;
    async function loadWorkspaceSeries() {
      if (activeTab !== "runs" || !workspacePanelMetrics.length || !workspaceFetchRuns.length) {
        if (hasWorkspaceSeriesRef.current) setWorkspaceSeries({});
        return;
      }
      if (!isLiveRefresh && hasWorkspaceSeriesRef.current) setWorkspaceSeries({});
      const next = await fetchMetricSeriesForMetrics(api, workspacePanelMetrics, workspaceFetchRuns, controller.signal, (metric, patch) => {
        if (!cancelled && !isLiveRefresh) setWorkspaceSeries((current) => ({ ...current, [metric]: patch }));
      });
      if (!cancelled) setWorkspaceSeries(next);
    }
    loadWorkspaceSeries().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load workspace panels.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, workspaceFetchRunKey, workspacePanelMetricKey, workspaceSeriesViewKey, liveSeriesTick]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadWorkspaceHistograms() {
      const runId = primaryRun?.id ?? "";
      if (activeTab !== "runs" || !runId || !workspaceHistogramKeys.length) {
        setWorkspaceHistogramTimelines({});
        return;
      }
      const requestedKeys = workspaceHistogramKeys.slice(0, WORKSPACE_HISTOGRAM_TIMELINE_LIMIT);
      const cappedStates = Object.fromEntries(workspaceHistogramKeys.slice(WORKSPACE_HISTOGRAM_TIMELINE_LIMIT).map((objectKey) => [objectKey, {
        runId,
        objectKey,
        frames: [],
        invalid: 0,
        truncated: false,
        compatibleBins: true,
        capped: true,
      } satisfies HistogramTimelineState]));
      setWorkspaceHistogramTimelines({ ...Object.fromEntries(requestedKeys.map((objectKey) => [objectKey, {
        runId,
        objectKey,
        frames: [],
        invalid: 0,
        truncated: false,
        compatibleBins: true,
        loading: true,
      } satisfies HistogramTimelineState])), ...cappedStates });

      const next: Record<string, HistogramTimelineState> = {};
      for (const objectKey of requestedKeys) {
        try {
          const payload = await retryTransientRequest(
            () => api.get(`/api/runs/${runId}/objects${queryString({ kind: "histogram", key: objectKey, limit: 100 })}`, { signal: controller.signal }),
            { signal: controller.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
          );
          const parsed = histogramFramesFromObjects(payload.objects ?? []);
          next[objectKey] = {
            runId,
            objectKey,
            frames: parsed.frames,
            invalid: parsed.invalid,
            truncated: parsed.truncated,
            compatibleBins: parsed.compatibleBins,
          };
        } catch (error) {
          if (isAbortError(error)) return;
          next[objectKey] = {
            runId,
            objectKey,
            frames: [],
            invalid: 0,
            truncated: false,
            compatibleBins: true,
            error: error instanceof Error ? error.message : "Unable to load logged histogram frames.",
          };
        }
        if (!cancelled) setWorkspaceHistogramTimelines({ ...next, ...cappedStates });
      }
      if (!cancelled) setWorkspaceHistogramTimelines({ ...next, ...cappedStates });
    }
    loadWorkspaceHistograms().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load logged histogram frames.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, primaryRun?.id, workspaceHistogramKey, workspaceHistogramLiveTick]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadArtifacts() {
      const shouldLoad = activeTab === "detail" || activeTab === "artifacts";
      if (!shouldLoad || !primaryRun?.id) {
        setArtifacts([]);
        setArtifactsRunId("");
        return;
      }
      const runId = primaryRun.id;
      setArtifacts([]);
      setArtifactsRunId(runId);
      try {
        const artifactPayload = await retryTransientRequest(
          () => api.get(`/api/runs/${runId}/artifacts${queryString({ limit: ARTIFACT_PAGE_LIMIT })}`, { signal: controller.signal }),
          { signal: controller.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
        );
        const rows = (artifactPayload.artifacts ?? []).slice(0, ARTIFACT_PAGE_LIMIT);
        if (!cancelled) {
          setArtifacts(rows);
          setArtifactsRunId(runId);
          compareArtifactCacheRef.current.set(runId, rows.slice(0, COMPARE_ARTIFACT_LIMIT));
        }
      } catch (error) {
        if (isAbortError(error)) return;
        if (isNotFoundError(error)) {
          if (!cancelled) {
            setArtifacts([]);
            setArtifactsRunId(runId);
          }
          return;
        }
        throw error;
      }
    }
    loadArtifacts().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load artifacts.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, primaryRun?.id]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadLoggedObjects() {
      const shouldLoad = activeTab === "artifacts" || (activeTab === "detail" && runWorkspaceTab === "files");
      if (!shouldLoad || !primaryRun?.id) {
        setLoggedObjects([]);
        setObjectRowsById({});
        return;
      }
      setLoggedObjects([]);
      setObjectRowsById({});
      try {
        const payload = await retryTransientRequest(
          () => api.get(`/api/runs/${primaryRun.id}/objects${queryString({ limit: 100 })}`, { signal: controller.signal }),
          { signal: controller.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
        );
        if (!cancelled) setLoggedObjects((payload.objects ?? []).slice(0, 100));
      } catch (error) {
        if (isAbortError(error)) return;
        if (isNotFoundError(error)) {
          if (!cancelled) {
            setLoggedObjects([]);
            setObjectRowsById({});
          }
          return;
        }
        throw error;
      }
    }
    loadLoggedObjects().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load rich objects.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, primaryRun?.id, runWorkspaceTab]);

  const tableObjectIds = useMemo(
    () => loggedObjects.filter((object) => object.kind === "table").slice(0, 12).map((object) => object.id),
    [loggedObjects],
  );
  const tableObjectKey = tableObjectIds.join(",");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadObjectRows() {
      const shouldLoad = activeTab === "artifacts" || (activeTab === "detail" && runWorkspaceTab === "files");
      if (!shouldLoad || !tableObjectIds.length) {
        setObjectRowsById({});
        return;
      }
      const entries = await Promise.all(tableObjectIds.map(async (objectId) => {
        const payload = await retryTransientRequest(
          () => api.get(`/api/objects/${objectId}/rows${queryString({ limit: 20 })}`, { signal: controller.signal }),
          { signal: controller.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
        );
        return [objectId, payload.rows ?? []] as const;
      }));
      if (!cancelled && tableObjectKey === tableObjectIds.join(",")) setObjectRowsById(Object.fromEntries(entries));
    }
    loadObjectRows().catch((error) => {
      if (!cancelled && !isAbortError(error) && !isNotFoundError(error)) setMessage(error instanceof Error ? error.message : "Unable to load table rows.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, runWorkspaceTab, tableObjectIds, tableObjectKey]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const runIds = compareRunKey ? compareRunKey.split(",").filter(Boolean) : [];
    const cacheVersion = compareArtifactCacheVersionRef.current;
    async function loadCompareArtifacts() {
      if (!compareSurfaceActive || !runIds.length) {
        setCompareArtifactsByRun({});
        return;
      }
      const next: Record<string, Artifact[]> = {};
      const tasks = runIds.map((runId) => async () => {
        if (cancelled || controller.signal.aborted) return;
        const cached = compareArtifactCacheRef.current.get(runId);
        if (cached) {
          next[runId] = cached;
          return;
        }
        const inFlight = compareArtifactInflightRef.current.get(runId);
        let request = inFlight && inFlight.signal === controller.signal && !inFlight.signal.aborted
          ? inFlight.promise
          : null;
        if (!request) {
          const entry: CompareArtifactInflightRequest = {
            signal: controller.signal,
            promise: api
              .get(`/api/runs/${runId}/artifacts${queryString({ limit: COMPARE_ARTIFACT_LIMIT })}`, { signal: controller.signal })
              .then((artifactPayload) => (artifactPayload.artifacts ?? []).slice(0, COMPARE_ARTIFACT_LIMIT)),
          };
          entry.promise = entry.promise.finally(() => {
            if (compareArtifactInflightRef.current.get(runId) === entry) {
              compareArtifactInflightRef.current.delete(runId);
            }
          });
          request = entry.promise;
          compareArtifactInflightRef.current.set(runId, entry);
        }
        try {
          const rows = await request;
          if (cancelled || controller.signal.aborted || cacheVersion !== compareArtifactCacheVersionRef.current) return;
          compareArtifactCacheRef.current.set(runId, rows);
          next[runId] = rows;
        } catch (error) {
          if (isAbortError(error)) throw error;
          next[runId] = [];
        }
      });
      await runWithConcurrency(tasks, 6);
      if (!cancelled && runIds.join(",") === compareRunKey && cacheVersion === compareArtifactCacheVersionRef.current) {
        setCompareArtifactsByRun(next);
      }
    }
    loadCompareArtifacts().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load compare artifacts.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [compareSurfaceActive, api, compareRunKey, runMetadataVersion]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadSideBySide() {
      if (!compareSurfaceActive || compareRunIds.length < 2) {
        setSideBySide(null);
        return;
      }
      const sidePayload = await retryTransientRequest(
        () => api.get(`/api/runs/side-by-side${queryString({ run_ids: compareRunKey, reference_run_id: referenceRun?.id, diff_only: diffOnly })}`, { signal: controller.signal }),
        { signal: controller.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
      );
      if (!cancelled) setSideBySide(sidePayload);
    }
    loadSideBySide().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load side-by-side comparison.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [compareSurfaceActive, api, compareRunIds.length, compareRunKey, diffOnly, referenceRun?.id, runMetadataVersion]);

  useEffect(() => {
    if (compareRuns.length && !compareRuns.some((run) => run.id === referenceRunId)) setReferenceRunId(compareRuns[0].id);
    if (!compareRuns.length && referenceRunId) setReferenceRunId("");
  }, [compareRuns, referenceRunId]);

  const goToNextRunPage = useCallback(() => {
    if (!hasNextPage || dashboardLoading || pageNavigationPendingRef.current) return;
    pageNavigationPendingRef.current = true;
    setPageNavigationPending(true);
    if (summary.next_cursor) {
      setPageCursorStack((current) => [...current, summary.next_cursor as string]);
    }
    setPageOffset((current) => current + pageSize);
  }, [dashboardLoading, hasNextPage, pageSize, summary.next_cursor]);

  const goToPreviousRunPage = useCallback(() => {
    if (!hasPreviousPage || dashboardLoading || pageNavigationPendingRef.current) return;
    pageNavigationPendingRef.current = true;
    setPageNavigationPending(true);
    setPageCursorStack((current) => current.slice(0, -1));
    setPageOffset((current) => Math.max(0, current - pageSize));
  }, [dashboardLoading, hasPreviousPage, pageSize]);

  const goToRunPage = useCallback((page: number) => {
    if (dashboardLoading || pageNavigationPendingRef.current) return;
    const totalPages = Math.max(1, Math.ceil(summary.total / pageSize));
    const target = Math.min(Math.max(1, Math.floor(page)), totalPages);
    const nextOffset = (target - 1) * pageSize;
    if (nextOffset === pageOffset && pageCursorStack.length === 0) return;
    pageNavigationPendingRef.current = true;
    setPageNavigationPending(true);
    // Jumping to an arbitrary page can't reuse the cursor stack (cursors only
    // step one page at a time), so fall back to offset paging for the jump.
    setPageCursorStack([]);
    setPageOffset(nextOffset);
  }, [dashboardLoading, pageCursorStack.length, pageOffset, pageSize, summary.total]);

  const changeRunPageSize = useCallback((size: number) => {
    setPageSize(size);
    resetRunPagination();
  }, [resetRunPagination]);

  const loadUsage = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (!activeOrgId || !canManageOrg) {
      setUsagePayload(null);
      return;
    }
    if (sharedDemoSession) {
      setUsagePayload(null);
      return;
    }
    try {
      const usage = await retryTransientRequest(
        () => api.get("/api/usage", options),
        { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
      );
      setUsagePayload(usage as UsagePayload);
    } catch (error) {
      if (!isAbortError(error)) setUsagePayload(null);
    }
  }, [activeOrgId, api, canManageOrg, sharedDemoSession]);

  const loadOrgSettings = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (!activeOrgId) return;
    if (!canManageOrg) {
      setSeats([]);
      setInvitations([]);
      setBillingPayload(null);
      setUsagePayload(null);
      return;
    }
    if (sharedDemoSession) {
      setSeats([]);
      setInvitations([]);
      setBillingPayload(null);
      setUsagePayload(null);
      return;
    }
    const [usageResult, seatResult, invitationResult, billingResult] = await Promise.allSettled([
      retryTransientRequest(() => api.get("/api/usage", options), { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS }),
      retryTransientRequest(() => api.get(`/api/orgs/${activeOrgId}/seats`, options), { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS }),
      retryTransientRequest(() => api.get(`/api/orgs/${activeOrgId}/invitations`, options), { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS }),
      retryTransientRequest(() => api.get("/api/billing/status", options), { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS }),
    ]);
    if (options.signal?.aborted) return;
    const shouldSurfaceError = (error: unknown) => !isAbortError(error);
    let loadError = "";
    if (usageResult.status === "fulfilled") {
      setUsagePayload(usageResult.value as UsagePayload);
    } else {
      setUsagePayload(null);
      if (shouldSurfaceError(usageResult.reason) && !isOptionalAdminPlaneUnavailable(usageResult.reason)) {
        loadError = usageResult.reason instanceof Error ? usageResult.reason.message : "Unable to load usage.";
      }
    }
    if (seatResult.status === "fulfilled") {
      const seatPayload = seatResult.value as { seats?: unknown };
      setSeats(Array.isArray(seatPayload.seats) ? seatPayload.seats as SeatRow[] : []);
    } else {
      setSeats([]);
      if (shouldSurfaceError(seatResult.reason) && !loadError) {
        loadError = seatResult.reason instanceof Error ? seatResult.reason.message : "Unable to load seats.";
      }
    }
    if (invitationResult.status === "fulfilled") {
      const invitationPayload = invitationResult.value as { invitations?: unknown };
      setInvitations(Array.isArray(invitationPayload.invitations) ? invitationPayload.invitations as InvitationRow[] : []);
    } else {
      setInvitations([]);
      if (shouldSurfaceError(invitationResult.reason) && !loadError) {
        loadError = invitationResult.reason instanceof Error ? invitationResult.reason.message : "Unable to load invitations.";
      }
    }
    if (billingResult.status === "fulfilled") {
      setBillingPayload(billingResult.value as BillingPayload | null);
    } else {
      setBillingPayload(null);
      if (shouldSurfaceError(billingResult.reason) && !isOptionalAdminPlaneUnavailable(billingResult.reason) && !loadError) {
        loadError = billingResult.reason instanceof Error ? billingResult.reason.message : "Unable to load billing.";
      }
    }
    if (loadError) setMessage(loadError);
  }, [activeOrgId, api, canManageOrg, sharedDemoSession]);

  useEffect(() => {
    if (!dashboardAuthorized || !activeOrgId) return;
    const controller = new AbortController();
    void loadUsage({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, dashboardAuthorized, loadUsage]);

  const loadApiKeys = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (!activeOrgId || !canManageOrg) {
      setApiKeys([]);
      setNewApiKey("");
      return;
    }
    if (sharedDemoSession) {
      setApiKeys([]);
      setNewApiKey("");
      return;
    }
    try {
      const payload = await api.get(`/api/orgs/${activeOrgId}/api-keys`, options);
      setApiKeys(Array.isArray(payload.api_keys) ? payload.api_keys as ApiKeyRow[] : []);
      setApiAdminMessage("");
    } catch (error) {
      if (!isAbortError(error)) {
        const detail = error instanceof Error ? error.message : "Unable to load API keys.";
        setApiAdminTone("error");
        setApiAdminMessage(detail);
        setMessage(detail);
      }
    }
  }, [activeOrgId, api, canManageOrg, sharedDemoSession]);

  useEffect(() => {
    if (!dashboardAuthorized || activeTab !== "settings" || !activeOrgId) return;
    const controller = new AbortController();
    void loadOrgSettings({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, activeTab, dashboardAuthorized, loadOrgSettings]);

  useEffect(() => {
    if (!dashboardAuthorized || activeTab !== "api" || !activeOrgId || !canManageOrg) {
      if (!canManageOrg) {
        setApiKeys([]);
        setNewApiKey("");
      }
      return;
    }
    const controller = new AbortController();
    void loadApiKeys({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, activeTab, canManageOrg, dashboardAuthorized, loadApiKeys]);

  async function copyTextToClipboard(value: string) {
    if (!value) return false;
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall through to the selection-based path for browsers that deny the async clipboard API.
      }
    }
    if (typeof document === "undefined") return false;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selection = window.getSelection();
    const selectedRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      document.body.removeChild(textarea);
      if (selection) {
        selection.removeAllRanges();
        selectedRanges.forEach((range) => selection.addRange(range));
      }
      activeElement?.focus();
    }
    return copied;
  }

  async function inviteSeat() {
    if (!activeOrgId || !inviteEmail.trim()) return;
    if (!canManageOrg) {
      setMessage("Seat management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setMessage("Sending invitation...");
    try {
      const payload = await api.post(`/api/orgs/${activeOrgId}/invitations`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteEmail("");
      const deliveryError = typeof payload.delivery_error === "string" ? payload.delivery_error : "";
      const previewLink = typeof payload.preview_link === "string" ? payload.preview_link : "";
      const invitationId = typeof payload.invitation?.id === "string" ? payload.invitation.id : "";
      if (previewLink && invitationId) {
        setInvitationLinks((current) => ({ ...current, [invitationId]: previewLink }));
      }
      setMessage(deliveryError ? `Invitation created, but email delivery failed: ${deliveryError}` : previewLink ? "Invitation link ready." : "Invitation sent.");
      void loadOrgSettings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send invitation.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function resendInvitation(invitationId: string) {
    if (!activeOrgId) return;
    if (!canManageOrg) {
      setMessage("Seat management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setMessage("Resending invitation...");
    try {
      const payload = await api.post(`/api/orgs/${activeOrgId}/invitations/${invitationId}/resend`, {});
      const deliveryError = typeof payload.delivery_error === "string" ? payload.delivery_error : "";
      const previewLink = typeof payload.preview_link === "string" ? payload.preview_link : "";
      if (previewLink) {
        setInvitationLinks((current) => ({ ...current, [invitationId]: previewLink }));
      }
      setMessage(deliveryError ? `Invitation updated, but email delivery failed: ${deliveryError}` : previewLink ? "Invitation link updated." : "Invitation resent.");
      void loadOrgSettings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to resend invitation.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function revokeInvitation(invitationId: string) {
    if (!activeOrgId) return;
    if (!canManageOrg) {
      setMessage("Seat management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setMessage("Revoking invitation...");
    try {
      await api.post(`/api/orgs/${activeOrgId}/invitations/${invitationId}/revoke`, {});
      setInvitationLinks((current) => {
        const next = { ...current };
        delete next[invitationId];
        return next;
      });
      setMessage("Invitation revoked.");
      void loadOrgSettings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to revoke invitation.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function copyInvitationLink(invitationId: string) {
    const link = invitationLinks[invitationId];
    if (!link) return;
    const safeLink = safeSameOriginInviteUrl(link);
    if (!safeLink) {
      setMessage("Invitation link was not a valid InstantML invite URL.");
      return;
    }
    try {
      if (!await copyTextToClipboard(safeLink)) throw new Error("copy failed");
      setMessage("Invitation link copied.");
    } catch {
      setMessage("Copy failed. Select and copy the invitation link manually.");
    }
  }

  function openInvitationLink(invitationId: string) {
    const link = invitationLinks[invitationId];
    if (!link) return;
    const safeLink = safeSameOriginInviteUrl(link);
    if (!safeLink) {
      setMessage("Invitation link was not a valid InstantML invite URL.");
      return;
    }
    window.open(safeLink, "_blank", "noopener,noreferrer");
  }

  async function openBillingPortal() {
    if (!canManageOrg) {
      setMessage("Billing management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setMessage("Opening billing portal...");
    try {
      const payload = await api.post("/api/billing/portal", {});
      const url = safeCheckoutRedirectUrl(payload.url);
      if (!url) throw new Error("Billing portal URL was not trusted.");
      window.location.assign(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to open billing portal.");
      setAdminBusy(false);
    }
  }

  async function changeBillingPlan(plan: "free" | "pro" | "premium") {
    if (!canManageOrg) {
      setMessage("Billing management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setMessage(`Changing billing plan to ${planDisplayName(plan)}...`);
    try {
      const payload = await api.post("/api/billing/change-plan", { plan_tier: plan });
      const checkoutUrl = safeCheckoutRedirectUrl(payload?.checkout?.url);
      if (checkoutUrl) {
        window.location.assign(checkoutUrl);
        return;
      }
      if (payload?.checkout?.url) throw new Error("Billing checkout URL was not trusted.");
      if (payload?.checkout) {
        await loadOrgSettings();
        setMessage("Checkout could not be opened. Retry from billing settings.");
        return;
      }
      await loadOrgSettings();
      setMessage("Billing plan updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to change billing plan.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function cancelBilling() {
    if (!canManageOrg) {
      setMessage("Billing management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setMessage("Scheduling cancellation...");
    try {
      await api.post("/api/billing/cancel", { at_period_end: true });
      await loadOrgSettings();
      setMessage("Cancellation recorded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to cancel billing.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function createDashboardApiKey() {
    if (!activeOrgId || !canManageOrg) {
      setMessage("API key management is available to workspace admins.");
      return;
    }
    setAdminBusy(true);
    setNewApiKey("");
    setApiAdminTone("status");
    setApiAdminMessage("Creating API key...");
    setMessage("Creating API key...");
    try {
      const payload = await api.post(`/api/orgs/${activeOrgId}/api-keys`, {
        name: apiKeyName.trim() || "Dashboard SDK key",
      });
      if (typeof payload.api_key === "string") setNewApiKey(payload.api_key);
      await loadApiKeys();
      setApiAdminTone("status");
      setApiAdminMessage("API key created. Copy it now; the secret will not be shown again.");
      setMessage("API key created.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to create API key.";
      setApiAdminTone("error");
      setApiAdminMessage(detail);
      setMessage(detail);
    } finally {
      setAdminBusy(false);
    }
  }

  async function revokeDashboardApiKey(keyId: string) {
    if (!activeOrgId || !keyId || !canManageOrg) {
      setMessage("API key management is available to workspace admins.");
      return;
    }
    // Irreversible for any SDK still using the key — always confirm.
    if (!window.confirm("Revoke this API key? SDK clients using it stop authenticating immediately. This cannot be undone.")) return;
    setAdminBusy(true);
    setApiAdminTone("status");
    setApiAdminMessage("Revoking API key...");
    setMessage("Revoking API key...");
    try {
      await api.post(`/api/orgs/${activeOrgId}/api-keys/${keyId}/revoke`, {});
      await loadApiKeys();
      setApiAdminTone("status");
      setApiAdminMessage("API key revoked.");
      setMessage("API key revoked.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to revoke API key.";
      setApiAdminTone("error");
      setApiAdminMessage(detail);
      setMessage(detail);
    } finally {
      setAdminBusy(false);
    }
  }

  async function copyNewApiKey() {
    if (!newApiKey) return;
    try {
      if (!await copyTextToClipboard(newApiKey)) throw new Error("copy failed");
      setApiAdminTone("status");
      setApiAdminMessage("API key copied.");
      setMessage("API key copied.");
    } catch {
      setApiAdminTone("error");
      setApiAdminMessage("Copy failed. Select the key above and copy it manually.");
      setMessage("Copy failed. Select the key above and copy it manually.");
    }
  }

  async function saveView() {
    if (!canWriteWorkspace) {
      setMessage("Read only workspaces can view runs and metrics but cannot save shared views.");
      return;
    }
    const fallbackName = `${project || "all"}:${metricKey || "metric"}`;
    const name = (viewName.trim() || fallbackName).replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 64);
    setViewName(name);
    setMessage("Saving view...");
    const payload = {
      project,
      activeTab,
      status,
      query: queryInput,
      sortBy,
      metricKey,
      metricFilter,
      groupBy,
      xMode,
      smoothing,
      identifierMode,
      groupAverage,
      diffOnly,
      compareLayout,
      compareRowSort,
      compareRunSort,
      compareSortMetricKey,
      compareTableMetrics,
      compareSearch,
      compareConfigSortKey,
      selectedRunIds,
      primaryRunId,
      referenceRunId,
      tableColumns,
      pinnedMetrics,
      pageSize,
      viewName: name,
      workspaceView,
    };
    const upsertOption = (option: SavedViewOption) => {
      setSavedViews((current) => {
        const withoutSame = current.filter((item) => item.source === "system" || (item.value !== option.value && item.label !== option.label));
        return [option, ...withoutSame];
      });
      setSavedViewKey(option.value);
    };
    try {
      const existingControlId = controlSavedViewId(savedViewKey);
      const response = existingControlId
        ? await api.put(`/api/workspace-views/${existingControlId}`, { name, project: project || null, payload })
        : await api.post("/api/workspace-views", { name, project: project || null, payload });
      const savedView = workspaceViewFromPayload(response);
      if (savedView) {
        upsertOption({
          label: name,
          project: savedView.project ?? null,
          source: "control",
          updatedAt: savedView.updated_at,
          value: controlSavedViewKey(savedView.id),
        });
        await loadSavedViews();
        setMessage("Saved view.");
        return;
      }
      throw new Error("Shared saved view response was empty.");
    } catch (error) {
      const key = localSavedViewKey(name, localSavedViewProjectScope);
      localStorage.setItem(key, JSON.stringify(payload));
      upsertOption({ label: name, source: "local", value: key });
      setMessage("Saved view locally. Shared save unavailable.");
      return;
    }
  }

  async function exportSavedView() {
    const controlId = controlSavedViewId(savedViewKey);
    if (!controlId || !selectedControlSavedView) {
      setMessage("Choose a shared saved view before exporting.");
      return;
    }
    setViewActionBusy(true);
    setMessage("Exporting saved view...");
    try {
      const { blob, headers } = await api.download(`/api/workspace-views/${controlId}/export`, {
        credentials: "same-origin",
      });
      const serverName = filenameFromContentDisposition(headers.get("content-disposition"));
      const fallbackName = `${safeExportFilename(selectedControlSavedView.label, "workspace-view")}.instantml-view.json`;
      const safeName = safeExportFilename(serverName || fallbackName, fallbackName);
      downloadBlob(blob, safeName.endsWith(".json") ? safeName : `${safeName}.json`);
      setMessage("Exported saved view.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to export saved view.");
    } finally {
      setViewActionBusy(false);
    }
  }

  function openImportSavedView() {
    if (!canWriteWorkspace) {
      setMessage("Read only workspaces cannot import shared views.");
      return;
    }
    setViewImportError("");
    setViewImportPreview(null);
    setViewImportPreviewText("");
    setViewImportOpen(true);
  }

  function updateImportSavedViewText(value: string) {
    viewImportTextRef.current = value;
    viewImportRequestRef.current += 1;
    setViewImportText(value);
    setViewImportPreview(null);
    setViewImportPreviewText("");
    setViewImportError(
      workspaceViewImportByteLength(value) > MAX_WORKSPACE_VIEW_IMPORT_BYTES
        ? "Import JSON must be 128 KiB or smaller."
        : "",
    );
  }

  async function updateImportSavedViewFile(file: File | null) {
    setViewImportError("");
    setViewImportPreview(null);
    setViewImportPreviewText("");
    const requestId = viewImportRequestRef.current + 1;
    viewImportRequestRef.current = requestId;
    if (!file) {
      setViewImportFileName("");
      return;
    }
    setViewImportFileName(file.name);
    if (file.size > MAX_WORKSPACE_VIEW_IMPORT_BYTES) {
      viewImportTextRef.current = "";
      setViewImportText("");
      setViewImportError("Import JSON files must be 128 KiB or smaller.");
      return;
    }
    try {
      const text = await file.text();
      if (requestId !== viewImportRequestRef.current) return;
      if (workspaceViewImportByteLength(text) > MAX_WORKSPACE_VIEW_IMPORT_BYTES) {
        viewImportTextRef.current = "";
        setViewImportText("");
        setViewImportError("Import JSON files must be 128 KiB or smaller.");
        return;
      }
      viewImportTextRef.current = text;
      setViewImportText(text);
    } catch {
      if (requestId !== viewImportRequestRef.current) return;
      setViewImportError("Unable to read import file.");
    }
  }

  async function previewImportSavedView() {
    if (viewImportBusy) return;
    const previewText = viewImportTextRef.current;
    if (workspaceViewImportByteLength(previewText) > MAX_WORKSPACE_VIEW_IMPORT_BYTES) {
      setViewImportError("Import JSON must be 128 KiB or smaller.");
      setViewImportPreview(null);
      setViewImportPreviewText("");
      return;
    }
    setViewImportError("");
    setViewImportPreview(null);
    setViewImportPreviewText("");
    let exportedView: unknown = null;
    try {
      exportedView = JSON.parse(previewText);
    } catch {
      setViewImportError("Import file must be valid JSON.");
      return;
    }
    const requestId = viewImportRequestRef.current;
    setViewImportBusy(true);
    try {
      const preview = await api.post("/api/workspace-views/import", {
        exported_view: exportedView,
        dry_run: true,
        conflict_strategy: "create",
      }) as WorkspaceViewImportPreview;
      if (requestId !== viewImportRequestRef.current || previewText !== viewImportTextRef.current) {
        setViewImportError("Import JSON changed. Preview it again before importing.");
        return;
      }
      setViewImportPreview(preview);
      setViewImportPreviewText(previewText);
      setMessage("Import preview ready.");
    } catch (error) {
      setViewImportError(error instanceof Error ? error.message : "Unable to preview import.");
    } finally {
      setViewImportBusy(false);
    }
  }

  async function confirmImportSavedView() {
    if (viewImportBusy || !viewImportPreview) return;
    if (!viewImportPreviewText || viewImportPreviewText !== viewImportTextRef.current) {
      setViewImportError("Import JSON changed. Preview it again before importing.");
      setViewImportPreview(null);
      setViewImportPreviewText("");
      return;
    }
    setViewImportError("");
    let exportedView: unknown = null;
    try {
      exportedView = JSON.parse(viewImportPreviewText);
    } catch {
      setViewImportError("Import file must be valid JSON.");
      return;
    }
    setViewImportBusy(true);
    try {
      const response = await api.post("/api/workspace-views/import", {
        exported_view: exportedView,
        dry_run: false,
        conflict_strategy: "create",
      }) as WorkspaceViewImportPreview;
      const savedView = response.workspace_view;
      await loadSavedViews();
      if (savedView?.id) {
        const key = controlSavedViewKey(savedView.id);
        await applySavedView(key);
        setSavedViewKey(key);
      }
      setViewImportOpen(false);
      setViewImportText("");
      viewImportTextRef.current = "";
      setViewImportFileName("");
      setViewImportPreview(null);
      setViewImportPreviewText("");
      setMessage("Imported saved view.");
    } catch (error) {
      setViewImportError(error instanceof Error ? error.message : "Unable to import saved view.");
    } finally {
      setViewImportBusy(false);
    }
  }

  function requestDeleteSavedView() {
    if (!selectedControlSavedView) {
      setMessage("Choose a shared saved view before deleting.");
      return;
    }
    if (!selectedControlSavedView.updatedAt) {
      setMessage("Refreshing saved views before delete...");
      loadSavedViews();
      return;
    }
    setDeleteViewTarget(selectedControlSavedView);
  }

  async function confirmDeleteSavedView() {
    const target = deleteViewTarget;
    const controlId = target ? controlSavedViewId(target.value) : "";
    if (!target || !controlId || !target.updatedAt || viewActionBusy) return;
    setViewActionBusy(true);
    setMessage("Deleting saved view...");
    try {
      await api.delete(`/api/workspace-views/${controlId}${queryString({ expected_updated_at: target.updatedAt })}`);
      setSavedViews((current) => current.filter((view) => view.value !== target.value));
      if (savedViewKey === target.value) {
        setSavedViewKey("");
        setViewName("");
      }
      setDeleteViewTarget(null);
      await loadSavedViews();
      setMessage("Deleted saved view.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete saved view.");
    } finally {
      setViewActionBusy(false);
    }
  }

  async function applySavedView(key: string) {
    const requestId = applySavedViewRequestRef.current + 1;
    applySavedViewRequestRef.current = requestId;
    setSavedViewKey(key);
    if (!key) {
      applyingSavedViewRef.current = false;
      setSearchError(null);
      return;
    }
    applyingSavedViewRef.current = true;
    userTouchedDashboardFiltersRef.current = true;
    let view: Record<string, any> | null = null;
    let resolvedName = localSavedViewName(key, localSavedViewProjectScope);
    const controlId = controlSavedViewId(key);
    if (controlId) {
      try {
        const payload = await api.get(`/api/workspace-views/${controlId}`);
        if (requestId !== applySavedViewRequestRef.current) return;
        const savedView = workspaceViewFromPayload(payload);
        view = savedView?.payload && typeof savedView.payload === "object"
          ? savedView.payload as Record<string, any>
          : null;
        resolvedName = savedView?.name ?? resolvedName;
      } catch {
        if (requestId !== applySavedViewRequestRef.current) return;
        view = null;
      }
    } else {
      view = safeSavedView(localStorage.getItem(key));
    }
    if (requestId !== applySavedViewRequestRef.current) return;
    if (!view) {
      applyingSavedViewRef.current = false;
      setMessage("Saved view could not be applied.");
      return;
    }
    const viewProject = savedViewString(view.project);
    const viewMetricKey = savedViewString(view.metricKey) || DEFAULT_METRIC_KEY;
    setProject(viewProject);
    const nextActiveTab = typeof view.activeTab === "string" && isTabId(view.activeTab) && view.activeTab !== "detail"
      ? view.activeTab as TabId
      : null;
    setStatus(savedViewString(view.status));
    setSearchError(null);
    setQueryInput(savedViewString(view.query));
    setQuery(savedViewString(view.query));
    setSortBy(savedViewString(view.sortBy, "created"));
    setMetricKey(viewMetricKey);
    setMetricFilter(savedViewString(view.metricFilter));
    setGroupBy(savedViewString(view.groupBy));
    setXMode(savedViewString(view.xMode, "step") === "time" ? "time" : "step");
    setSmoothing(savedViewNumber(view.smoothing, 0, 0, 100));
    setIdentifierMode(["name", "notes", "tags"].includes(view.identifierMode) ? view.identifierMode : "name");
    setGroupAverage(Boolean(view.groupAverage));
    setDiffOnly(Boolean(view.diffOnly));
    setCompareLayout(compareLayouts.has(view.compareLayout) ? (view.compareLayout === "auto" ? "rows" : view.compareLayout) : "rows");
    setCompareRowSort(compareRowSorts.has(view.compareRowSort) ? view.compareRowSort : "signal");
    setCompareRunSort(compareRunSorts.has(view.compareRunSort) ? view.compareRunSort : "metric-best");
    setCompareSortMetricKey(savedViewString(view.compareSortMetricKey, viewMetricKey));
    setCompareTableMetrics(savedViewStringArray(view.compareTableMetrics, Math.max(0, MAX_COMPARE_TABLE_METRICS - 1)));
    setCompareSearch(savedViewString(view.compareSearch));
    setCompareConfigSortKey(savedViewString(view.compareConfigSortKey));
    // Saved views restore an explicit selection; reflect it in the URL too.
    selectionUrlSyncRef.current = true;
    defaultSelectionInitializedRef.current = true;
    setSelectedRunIds(savedViewStringArray(view.selectedRunIds, MAX_SELECTED_RUNS));
    setSelectedRunDetails({});
    setPrimaryRunId(savedViewString(view.primaryRunId));
    setReferenceRunId(savedViewString(view.referenceRunId));
    setTableColumns({ ...defaultTableColumns, ...(typeof view.tableColumns === "object" && !Array.isArray(view.tableColumns) ? view.tableColumns : {}) });
    setPinnedMetrics(savedViewStringArray(view.pinnedMetrics, 4));
    if (view.workspaceView) {
      const nextWorkspace = sanitizeWorkspaceView(view.workspaceView, allMetricOptions, viewProject || project);
      const workspaceProject = viewProject || project;
      const workspaceScope = localSavedViewScope
        ? storageScopeId([localSavedViewScope, workspaceProject || "all"].filter(Boolean).join(":"))
        : "";
      workspaceViewRef.current = nextWorkspace;
      localStorage.setItem(workspaceStorageKey(workspaceProject, workspaceScope), JSON.stringify(nextWorkspace));
      setWorkspaceView(nextWorkspace);
    }
    const nextPageSize = savedViewNumber(view.pageSize, 25, 10, 100);
    setPageSize([10, 25, 50, 100].includes(nextPageSize) ? nextPageSize : 25);
    setPageCursorStack([]);
    setPageOffset(0);
    window.setTimeout(() => {
      applyingSavedViewRef.current = false;
    }, 0);
    setViewName(view.viewName ?? resolvedName);
    if (nextActiveTab) selectTab(nextActiveTab);
    setMessage("Saved view applied.");
  }

  function addCompareTableMetric(nextMetric: string) {
    if (!nextMetric || nextMetric === metricKey) return;
    setCompareTableMetrics((current) => {
      const seen = new Set<string>();
      return [...current, nextMetric]
        .filter((metric) => {
          if (!metric || metric === metricKey || seen.has(metric)) return false;
          seen.add(metric);
          return true;
        })
        .slice(0, Math.max(0, MAX_COMPARE_TABLE_METRICS - 1));
    });
    setCompareSortMetricKey(nextMetric);
    setCompareRunSort("metric-best");
  }

  function removeCompareTableMetric(metric: string) {
    setCompareTableMetrics((current) => current.filter((item) => item !== metric));
    if (compareSortMetricKey === metric) setCompareSortMetricKey(metricKey);
  }

  function addAllCompareTableMetrics() {
    setCompareTableMetrics(
      metricOptionsForControls
        .filter((metric) => metric && metric !== metricKey)
        .slice(0, Math.max(0, MAX_COMPARE_TABLE_METRICS - 1)),
    );
  }

  function resetCompareTableMetrics() {
    setCompareTableMetrics([]);
    setCompareSortMetricKey(metricKey);
  }

  const selectionAnchorRunIdRef = useRef<string>("");
  const [selectAllMatchingBusy, setSelectAllMatchingBusy] = useState(false);

  function toggleRun(runId: string, options?: { shift?: boolean }) {
    selectionUrlSyncRef.current = true;
    if (options?.shift && selectionAnchorRunIdRef.current && selectionAnchorRunIdRef.current !== runId) {
      const orderedIds = sortedRuns.map((run) => run.id);
      setSelectedRunIds((current) => rangeSelect(current, orderedIds, selectionAnchorRunIdRef.current, runId));
      selectionAnchorRunIdRef.current = runId;
      return;
    }
    setSelectedRunIds((current) => toggleSelection(current, runId));
    selectionAnchorRunIdRef.current = runId;
  }

  function selectAllVisibleRuns() {
    selectionUrlSyncRef.current = true;
    const visibleIds = sortedRuns.map((run) => run.id);
    const state = visibleSelectionState(selectedRunIds, visibleIds);
    if (state === "all") {
      const visibleSet = new Set(visibleIds);
      const hasCrossPageSelection = selectedRunIds.some((id) => !visibleSet.has(id));
      if (hasCrossPageSelection) {
        setSelectedRunIds([]);
        selectionAnchorRunIdRef.current = "";
      } else {
        setSelectedRunIds((current) => deselectVisible(current, visibleIds));
      }
    } else {
      setSelectedRunIds((current) => selectAllVisible(current, visibleIds));
      if (!selectionAnchorRunIdRef.current && visibleIds.length) selectionAnchorRunIdRef.current = visibleIds[0];
    }
  }

  async function selectAllMatchingRuns() {
    if (selectAllMatchingBusy) return;
    selectionUrlSyncRef.current = true;
    if (queryInput !== query) {
      resetRunPagination();
      setQuery(queryInput);
      setMessage("Applying the latest search filter. Select matching runs again after the results refresh.");
      return;
    }
    if (searchError?.query === query) {
      setMessage("Fix the run search syntax before selecting matching runs.");
      return;
    }
    selectAllMatchingControllerRef.current?.abort();
    const controller = new AbortController();
    selectAllMatchingControllerRef.current = controller;
    const requestFilterKey = dashboardSelectionFilterKeyRef.current;
    userTouchedDashboardFiltersRef.current = true;
    setSelectAllMatchingBusy(true);
    setMessage(`Selecting up to ${BULK_SELECT_MATCHING_LIMIT} runs matching the current filter...`);
    try {
      const pageLimit = Math.min(1000, BULK_SELECT_MATCHING_LIMIT);
      const matchingRuns: RunSummary[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let cursor = "";
      let total = 0;
      const displayStatus = normalizeDisplayStatus(status);
      const statusParams = dashboardStatusQueryParams(displayStatus, status);
      while (matchingRuns.length < BULK_SELECT_MATCHING_LIMIT) {
        if (controller.signal.aborted || requestFilterKey !== dashboardSelectionFilterKeyRef.current) {
          controller.abort();
          setMessage("Selection cancelled because filters changed.");
          return;
        }
        const params = cursor ? {
          project,
          ...statusParams,
          q: query,
          limit: Math.min(pageLimit, BULK_SELECT_MATCHING_LIMIT - matchingRuns.length),
          cursor,
          projection: "selection",
          sort_by: sortBy,
          metric_key: metricKey,
        } : {
          project,
          ...statusParams,
          q: query,
          limit: Math.min(pageLimit, BULK_SELECT_MATCHING_LIMIT - matchingRuns.length),
          offset,
          projection: "selection",
          sort_by: sortBy,
          metric_key: metricKey,
        };
        const payload = await retryTransientRequest(
          () => api.get(`/api/runs/summary${queryString(params)}`, { signal: controller.signal }),
          { signal: controller.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
        );
        if (controller.signal.aborted || requestFilterKey !== dashboardSelectionFilterKeyRef.current) {
          controller.abort();
          setMessage("Selection cancelled because filters changed.");
          return;
        }
        const pageRuns = Array.isArray(payload?.runs) ? payload.runs as RunSummary[] : [];
        total = Number.isFinite(Number(payload?.total)) ? Number(payload.total) : Math.max(total, offset + pageRuns.length);
        for (const run of pageRuns) {
          if (!run?.id || seen.has(run.id)) continue;
          matchingRuns.push(run);
          seen.add(run.id);
          if (matchingRuns.length >= BULK_SELECT_MATCHING_LIMIT) break;
        }
        const nextCursor = typeof payload?.next_cursor === "string" ? payload.next_cursor : "";
        const hasNextPage = Boolean(payload?.page_info?.has_next_page || nextCursor);
        cursor = nextCursor;
        offset += pageRuns.length;
        if (!pageRuns.length || !hasNextPage || offset >= total) break;
      }
      const ids = capSelectionToMatching(matchingRuns.map((run) => run.id).filter(Boolean));
      setSelectedRunDetails((current) => {
        const next = { ...current };
        for (const run of matchingRuns) {
          if (!run?.id) continue;
          const cached = runDirectoryRef.current.get(run.id) ?? sortedRuns.find((candidate) => candidate.id === run.id);
          next[run.id] = richerRunSummary(run, current[run.id] ?? cached) ?? run;
        }
        return next;
      });
      setSelectedRunIds(ids);
      if (ids.length) selectionAnchorRunIdRef.current = ids[0];
      setMessage(`${ids.length} runs selected (filter matched ${total || ids.length}).`);
    } catch (error) {
      if (!isAbortError(error) && requestFilterKey === dashboardSelectionFilterKeyRef.current) setMessage(error instanceof Error ? error.message : "Unable to select matching runs.");
    } finally {
      if (selectAllMatchingControllerRef.current === controller) selectAllMatchingControllerRef.current = null;
      setSelectAllMatchingBusy(false);
    }
  }

  async function exportSelectedRunsCsv() {
    if (exportSelectedBusy) return;
    if (!selectedRunIds.length) {
      setMessage("Select one or more runs before exporting CSV.");
      return;
    }
    if (selectedRunIds.length > MAX_EXPORT_SELECTED_RUNS) {
      setMessage(`CSV export supports up to ${MAX_EXPORT_SELECTED_RUNS} selected runs at a time.`);
      return;
    }
    setExportSelectedBusy(true);
    setMessage(`Exporting ${selectedRunIds.length} selected runs...`);
    try {
      const { blob, headers } = await api.download(`/api/export${queryString({ format: "csv", run_ids: selectedRunIds.join(",") })}`, {
        credentials: "same-origin",
      });
      const today = new Date().toISOString().slice(0, 10);
      const serverName = filenameFromContentDisposition(headers.get("content-disposition"));
      const fallbackName = `instantml-selected-runs-${selectedRunIds.length}-${today}.csv`;
      const rawName = serverName && serverName !== "instantml-export.csv" ? serverName : fallbackName;
      const safeName = safeExportFilename(rawName, fallbackName);
      const filename = safeName.endsWith(".csv") ? safeName : `${safeName}.csv`;
      downloadBlob(blob, filename);
      const truncated = headers.get("x-instantml-export-truncated") === "true";
      setMessage(truncated
        ? `Exported ${selectedRunIds.length} selected runs as CSV. Some data was capped by synchronous export limits.`
        : `Exported ${selectedRunIds.length} selected runs as CSV.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to export selected runs.");
    } finally {
      setExportSelectedBusy(false);
    }
  }

  async function updateRunTagsAndNotes(runId: string, patch: { tags: string[]; notes: string }) {
    if (!canWriteWorkspace) {
      throw new Error("Read only workspaces can view run data but cannot edit run metadata.");
    }
    const tags = patch.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 16);
    const notes = patch.notes.trim();
    const payload = await api.patch(`/runs/${runId}`, { tags, notes });
    const updated = payload.run as Partial<RunSummary> | undefined;
    const nextTags = Array.isArray(updated?.tags) ? updated.tags : tags;
    const nextNotes = typeof updated?.metadata?.notes === "string" ? updated.metadata.notes : notes;
    setSummary((current) => ({
      ...current,
      runs: current.runs.map((run) => (run.id === runId ? mergeRunTagsAndNotes(run, nextTags, nextNotes) : run)),
    }));
    setSelectedRunDetails((current) => {
      const existing = current[runId];
      if (!existing) return current;
      return { ...current, [runId]: mergeRunTagsAndNotes(existing, nextTags, nextNotes) };
    });
    setSideBySide((current: any) => current ? {
      ...current,
      runs: (current.runs ?? []).map((run: RunSummary) => (run.id === runId ? mergeRunTagsAndNotes(run, nextTags, nextNotes) : run)),
    } : current);
    setRunMetadataVersion((current) => current + 1);
    setMessage("Run tags and notes saved.");
  }

  async function forkCheckpointRun(artifact: Artifact, options: { inheritConfig: boolean; name: string; reason: string }) {
    if (!primaryRun) throw new Error("No source run is selected.");
    if (artifact.run_id && artifact.run_id !== primaryRun.id) {
      throw new Error("Checkpoint no longer belongs to the selected run. Reload artifacts and try again.");
    }
    const body = buildCheckpointForkBody(artifact, primaryRun, {
      inheritConfig: options.inheritConfig,
      name: options.name.trim(),
      reason: options.reason,
      tags: ["retry", "checkpoint"],
    });
    const idempotencyKey = checkpointForkIdempotencyKey(artifact, primaryRun, body);
    const payload = await api.post(`/api/runs/${primaryRun.id}/forks`, body, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const child = payload.run as RunSummary | undefined;
    if (!child?.id) throw new Error("Server returned an invalid fork response.");
    const childKnownBefore = runDirectoryRef.current.has(child.id);
    runDirectoryRef.current.set(child.id, child);
    setSummary((current) => {
      const alreadyPresent = current.runs.some((run) => run.id === child.id);
      const sameProjectVisible = !project || project === child.project;
      const runs = alreadyPresent
        ? current.runs.map((run) => (run.id === child.id ? child : run))
        : sameProjectVisible
          ? [child, ...current.runs]
          : current.runs;
      return {
        ...current,
        runs,
        total: alreadyPresent || !sameProjectVisible ? current.total : current.total + 1,
      };
    });
    if (!childKnownBefore) {
      setOverview((current) => ({
        ...current,
        total_runs: current.total_runs + 1,
        active_runs: current.active_runs + (child.status === "running" ? 1 : 0),
      }));
    }
    setSelectedRunDetails((current) => ({ ...current, [child.id]: child }));
    // Forking is an explicit selection change; keep the URL in sync with it.
    selectionUrlSyncRef.current = true;
    defaultSelectionInitializedRef.current = true;
    setSelectedRunIds((current) => [child.id, ...current.filter((id) => id !== child.id)].slice(0, MAX_SELECTED_RUNS));
    preserveRunWorkspaceTabOnceRef.current = true;
    setPrimaryRunId(child.id);
    setRunWorkspaceTab("graph");
    setMessage("Forked run created. InstantML did not start training.");
  }

  function runSummaryForId(runId: string) {
    return selectedRunDetails[runId]
      ?? sortedRuns.find((run) => run.id === runId)
      ?? runDirectoryRef.current.get(runId)
      ?? null;
  }

  function stopCandidatesForIds(runIds: string[]) {
    const seen = new Set<string>();
    const runs: RunSummary[] = [];
    const skippedCounts: StopDialogSkipCounts = {
      alreadyStopping: 0,
      readOnly: 0,
      terminal: 0,
      unavailable: 0,
    };
    for (const runId of runIds) {
      if (seen.has(runId)) continue;
      seen.add(runId);
      const run = runSummaryForId(runId);
      if (!run) {
        skippedCounts.unavailable += 1;
        continue;
      }
      if (!canControlRuns) {
        skippedCounts.readOnly += 1;
        continue;
      }
      if (run.status !== "running") {
        skippedCounts.terminal += 1;
        continue;
      }
      if (!canRequestStop(run, canControlRuns)) {
        skippedCounts.alreadyStopping += displayStatusForRun(run) === "stopping" || ["requested", "acknowledged"].includes(run.run_control?.stop_state || "")
          ? 1
          : 0;
        skippedCounts.unavailable += displayStatusForRun(run) === "stopping" || ["requested", "acknowledged"].includes(run.run_control?.stop_state || "")
          ? 0
          : 1;
        continue;
      }
      runs.push(run);
    }
    const cappedRuns = runs.slice(0, MAX_STOP_DIALOG_RUNS);
    const ineligibleRunCount = Object.values(skippedCounts).reduce((total, count) => total + count, 0);
    return {
      runs: cappedRuns,
      ineligibleRunCount,
      skippedCounts,
      skippedRunCount: Math.max(0, runs.length - cappedRuns.length),
    };
  }

  function nextStopIdempotencyKey(source: "single" | "bulk") {
    const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `instantml-stop:${source}:${entropy}`;
  }

  function openStopDialogForRuns(runIds: string[], source: "single" | "bulk" = "single") {
    if (!canControlRuns) {
      setMessage("Read only workspaces can view runs but cannot stop them.");
      return;
    }
    const { runs: candidates, ineligibleRunCount, skippedCounts, skippedRunCount } = stopCandidatesForIds(runIds);
    if (!candidates.length) {
      setMessage(source === "bulk" ? "No selected running runs can be stopped." : "This run cannot be stopped.");
      return;
    }
    const dialogSource = source === "bulk" || candidates.length > 1 ? "bulk" : "single";
    setStopError("");
    setStopDialog({
      idempotencyKey: nextStopIdempotencyKey(dialogSource),
      ineligibleRunCount,
      reason: "",
      runIds: candidates.map((run) => run.id),
      skippedCounts,
      skippedRunCount,
      source: dialogSource,
    });
  }

  function closeStopDialog() {
    if (stopSubmitting) return;
    setStopDialog(null);
    setStopError("");
  }

  function setStopDialogReason(reason: string) {
    setStopDialog((current) => current ? { ...current, reason } : current);
  }

  function collectStopControls(payload: GeneratedRunStopEnvelope | GeneratedRunStopBulkEnvelope) {
    const controls = new Map<string, GeneratedRunControlSummary>();
    const failures: string[] = [];
    let terminalCount = 0;
    if ("results" in payload) {
      for (const result of payload.results ?? []) {
        if (result.run_control?.stop_requested) controls.set(result.run_id, result.run_control);
        if (result.ok && result.already_terminal) terminalCount += 1;
        if (!result.ok) failures.push(result.error || `Unable to stop ${result.run_id}.`);
      }
    } else {
      if (payload.run_control?.stop_requested) controls.set(payload.run_id, payload.run_control);
      if (payload.ok && payload.already_terminal) terminalCount += 1;
    }
    return { controls, failures, terminalCount };
  }

  async function submitStopDialog() {
    if (!stopDialog || stopSubmitting) return;
    const runIds = stopDialog.runIds.slice(0, MAX_STOP_DIALOG_RUNS);
    if (!runIds.length) {
      setStopError("No eligible runs remain.");
      return;
    }
    setStopSubmitting(true);
    setStopError("");
    try {
      const reason = stopDialog.reason.trim();
      const headers = { "Idempotency-Key": stopDialog.idempotencyKey };
      const payload = stopDialog.source === "single" && runIds.length === 1
        ? await api.post(`/api/runs/${runIds[0]}/stop`, { reason: reason || null }, { headers }) as GeneratedRunStopEnvelope
        : await api.post("/api/runs/stop", { run_ids: runIds, reason: reason || null }, { headers }) as GeneratedRunStopBulkEnvelope;
      const { controls, failures, terminalCount } = collectStopControls(payload);
      const okCount = controls.size;
      if (!okCount && failures.length) throw new Error(failures[0]);
      if (!okCount && terminalCount) {
        setStopError("These runs are no longer running. Refresh the run list and try again if needed.");
        return;
      }
      setStopDialog(null);
      setStopError("");
      setMessage(failures.length
        ? `Stop requested for ${okCount} ${okCount === 1 ? "run" : "runs"}. ${failures.length + terminalCount} could not be updated.`
        : `Stop requested for ${okCount} ${okCount === 1 ? "run" : "runs"}. Waiting for SDK acknowledgement.`);
      setSummary((current) => {
        let removed = 0;
        const activeDisplayStatus = normalizeDisplayStatus(status);
        const runs = current.runs.flatMap((run) => {
          if (!controls.has(run.id)) return [run];
          const next = mergeRunControl(run, controls.get(run.id)!);
          if (activeDisplayStatus && displayStatusForRun(next) !== activeDisplayStatus) {
            removed += 1;
            return [];
          }
          return [next];
        });
        return {
          ...current,
          runs,
          total: removed > 0 ? Math.max(0, current.total - removed) : current.total,
        };
      });
      setSelectedRunDetails((current) => {
        let changed = false;
        const next = { ...current };
        for (const [runId, control] of controls.entries()) {
          const existing = next[runId] ?? sortedRuns.find((run) => run.id === runId) ?? runDirectoryRef.current.get(runId);
          if (!existing) continue;
          next[runId] = mergeRunControl(existing, control);
          runDirectoryRef.current.set(runId, next[runId]);
          changed = true;
        }
        return changed ? next : current;
      });
      setSideBySide((current: any) => current ? {
        ...current,
        runs: (current.runs ?? []).map((run: RunSummary) => controls.has(run.id) ? mergeRunControl(run, controls.get(run.id)!) : run),
      } : current);
      setOverview((current) => {
        let next = current;
        for (const [runId, control] of controls.entries()) {
          const before = displayStatusForRun(runSummaryForId(runId));
          const after = normalizeDisplayStatus(control.display_status) || before;
          next = adjustOverviewForDisplayStatus(next, before, after);
        }
        return next;
      });
      void loadDashboard({ silent: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to request stop.";
      setStopError(detail);
      setMessage(detail);
    } finally {
      setStopSubmitting(false);
    }
  }

  function clearFilters() {
    setProject("");
    setStatus("");
    setSortBy("created");
    setQueryInput("");
    setQuery("");
    setSearchError(null);
    setPageCursorStack([]);
    setPageOffset(0);
    setMessage("Filters cleared.");
  }

  function togglePinnedMetric(metric: string) {
    if (!metric) return;
    setPinnedMetrics((current) => {
      if (current.includes(metric)) return current.filter((item) => item !== metric);
      return [...current, metric].slice(-4);
    });
  }

  function commitWorkspace(
    mutator: (current: WorkspaceView) => WorkspaceView,
    nextMessage = "Workspace autosaved. Undo available.",
    options: { markCustomized?: boolean } = {},
  ) {
    const previous = workspaceViewRef.current ?? workspaceView;
    const mutated = mutator(previous);
    const next = {
      ...mutated,
      mode: options.markCustomized === false ? mutated.mode : "manual",
      updatedAt: new Date().toISOString(),
    };
    workspaceViewRef.current = next;
    setWorkspaceUndoStack((current) => [...current, previous].slice(-WORKSPACE_HISTORY_LIMIT));
    setWorkspaceRedoStack([]);
    setWorkspaceView(next);
    setMessage(nextMessage);
  }

  function updateWorkspace(mutator: (current: WorkspaceView) => WorkspaceView) {
    commitWorkspace(mutator);
  }

  function undoWorkspace() {
    const previous = workspaceUndoStack.at(-1);
    if (!previous) {
      setMessage("Nothing to undo.");
      return;
    }
    const current = workspaceViewRef.current ?? workspaceView;
    const next = { ...previous, updatedAt: new Date().toISOString() };
    workspaceViewRef.current = next;
    setWorkspaceUndoStack((stack) => stack.slice(0, -1));
    setWorkspaceRedoStack((stack) => [...stack, current].slice(-WORKSPACE_HISTORY_LIMIT));
    setWorkspaceView(next);
    setMessage("Workspace change undone. Redo available.");
  }

  function redoWorkspace() {
    const nextRedo = workspaceRedoStack.at(-1);
    if (!nextRedo) {
      setMessage("Nothing to redo.");
      return;
    }
    const current = workspaceViewRef.current ?? workspaceView;
    const next = { ...nextRedo, updatedAt: new Date().toISOString() };
    workspaceViewRef.current = next;
    setWorkspaceRedoStack((stack) => stack.slice(0, -1));
    setWorkspaceUndoStack((stack) => [...stack, current].slice(-WORKSPACE_HISTORY_LIMIT));
    setWorkspaceView(next);
    setMessage("Workspace change redone. Undo available.");
  }

  function addWorkspacePanel(sectionId: string, panelMetric: string, type: WorkspacePanelType = "line") {
    if (!sectionId || !panelMetric) return;
    const basePanel = workspacePanelForMetric(panelMetric, type);
    const panelId = `panel-${stableId(`${type}-${panelMetric}`)}-${Date.now().toString(36)}`;
    const panelSeedRuns = (selectedRuns.length ? selectedRuns : sortedRuns).slice(0, 10);
    const numericFields = buildRunFieldCatalog(panelSeedRuns, allMetricOptions) as WorkspaceFieldOption[];
    const categoricalFields = buildRunCategoricalFieldCatalog(panelSeedRuns) as WorkspaceCategoricalFieldOption[];
    const title = basePanel.title;
    const metricKey = basePanel.metricKey;
    const layout = basePanel.layout;
    const settings = basePanel.settings;
    const panel: WorkspacePanel = type === "scatter"
      ? {
        id: panelId,
        type: "scatter",
        title,
        metricKey,
        layout,
        settings,
        ...defaultScatterFields(panelMetric, numericFields),
      }
      : type === "distribution"
        ? {
          id: panelId,
          type: "distribution",
          title,
          metricKey,
          layout,
          settings,
          ...defaultDistributionFields(panelMetric, numericFields, categoricalFields),
        }
        : type === "histogram_timeline"
            ? {
              id: panelId,
              type: "histogram_timeline",
              title,
              metricKey,
              layout,
              settings,
              objectKey: panelMetric,
            }
      : {
        id: panelId,
        type,
        title,
        metricKey,
        layout,
        settings,
      };
    updateWorkspace((current) => ({
      ...current,
      mode: current.mode === "manual" ? "manual" : current.mode,
      sections: current.sections.map((section) => section.id === sectionId
        ? { ...section, panels: [...section.panels, panel] }
        : section),
    }));
    setAddPanelSectionId("");
  }

  function addWorkspaceSection() {
    const id = `section-${Date.now().toString(36)}`;
    updateWorkspace((current) => ({
      ...current,
      mode: "manual",
      sections: [...current.sections, { id, name: `Panel Section ${current.sections.length + 1}`, collapsed: false, panels: [] }],
    }));
  }

  function toggleWorkspaceSection(sectionId: string) {
    updateWorkspace((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === sectionId ? { ...section, collapsed: !section.collapsed } : section),
    }));
  }

  function duplicateWorkspacePanel(sectionId: string, panelId: string) {
    updateWorkspace((current) => ({
      ...current,
      sections: current.sections.map((section) => {
        if (section.id !== sectionId) return section;
        const panel = section.panels.find((item) => item.id === panelId);
        if (!panel) return section;
        return { ...section, panels: [...section.panels, { ...panel, id: `${panel.id}-copy-${Date.now().toString(36)}`, title: `${panel.title} copy` }] };
      }),
    }));
  }

  function removeWorkspacePanel(sectionId: string, panelId: string) {
    updateWorkspace((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === sectionId ? { ...section, panels: section.panels.filter((panel) => panel.id !== panelId) } : section),
    }));
  }

  function moveWorkspacePanel(sourceSectionId: string, panelId: string, targetSectionId: string, targetIndex: number) {
    if (!sourceSectionId || !panelId || !targetSectionId) return;
    commitWorkspace((current) => {
      const sourceSection = current.sections.find((section) => section.id === sourceSectionId);
      const sourceIndex = sourceSection?.panels.findIndex((panel) => panel.id === panelId) ?? -1;
      const movingPanel = sourceSection?.panels[sourceIndex];
      if (!movingPanel) return current;

      const resolvedTargetId = targetSectionId === "__unsectioned__" ? "section-unsectioned" : targetSectionId;
      let nextSections = current.sections.map((section) => section.id === sourceSectionId
        ? { ...section, panels: section.panels.filter((panel) => panel.id !== panelId) }
        : section);

      if (!nextSections.some((section) => section.id === resolvedTargetId)) {
        nextSections = [...nextSections, { id: resolvedTargetId, name: "Unsectioned", collapsed: false, panels: [] }];
      }

      const insertionTarget = nextSections.find((section) => section.id === resolvedTargetId);
      if (!insertionTarget) return current;
      const adjustedIndex = sourceSectionId === resolvedTargetId && sourceIndex >= 0 && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      const boundedIndex = Math.max(0, Math.min(adjustedIndex, insertionTarget.panels.length));
      nextSections = nextSections.map((section) => {
        if (section.id !== resolvedTargetId) return section;
        const panels = [...section.panels];
        panels.splice(boundedIndex, 0, movingPanel);
        return { ...section, panels };
      });

      return { ...current, mode: "manual", sections: nextSections };
    }, "Panel placement saved. Undo available.");
  }

  function resizeWorkspacePanel(sectionId: string, panelId: string, layout: WorkspacePanelLayout) {
    commitWorkspace((current) => ({
      ...current,
      mode: "manual",
      sections: current.sections.map((section) => section.id === sectionId
        ? {
          ...section,
          panels: section.panels.map((panel) => panel.id === panelId
            ? { ...panel, layout: sanitizePanelLayout(layout, panel.type) }
            : panel),
        }
        : section),
    }), "Panel size saved. Undo available.");
  }

  function setWorkspacePanelSmoothing(sectionId: string, panelId: string, smoothing: number) {
    const next = Math.max(0, Math.min(90, Math.round(Number(smoothing) / 10) * 10));
    if (!Number.isFinite(next)) return;
    commitWorkspace((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === sectionId
        ? {
          ...section,
          panels: section.panels.map((panel) => panel.id === panelId
            ? { ...panel, settings: { ...(panel.settings ?? {}), smoothing: next } }
            : panel),
        }
        : section),
    }), next ? `Smoothing set to ${next}. Undo available.` : "Smoothing cleared. Undo available.");
  }

  function updateEditingPanel(patch: {
    title?: string;
    type?: WorkspacePanelType;
    metricKey?: string;
    xField?: string;
    yField?: string;
    valueField?: string;
    groupField?: string;
    replicateField?: string;
    objectKey?: string;
    settings?: Partial<WorkspacePanelSettings>;
  }) {
    if (!editingPanelRef) return;
    updateWorkspace((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === editingPanelRef.sectionId
        ? {
          ...section,
          panels: section.panels.map((panel) => {
            if (panel.id !== editingPanelRef.panelId) return panel;
            const type = patch.type ?? panel.type;
            const title = patch.title ?? panel.title;
            const metricKey = patch.metricKey ?? panel.metricKey;
            const settings = patch.settings ? { ...(panel.settings ?? {}), ...patch.settings } : panel.settings;
            if (type === "scatter") {
              const defaults = defaultScatterFields(metricKey, workspaceFieldOptions);
              const xField = sanitizeWorkspaceFieldPatch(patch.xField)
                ?? (panel.type === "scatter" ? panel.xField : undefined)
                ?? defaults.xField;
              const yField = sanitizeWorkspaceFieldPatch(patch.yField)
                ?? (panel.type === "scatter" ? panel.yField : undefined)
                ?? defaults.yField;
              return {
                id: panel.id,
                type: "scatter",
                title,
                metricKey,
                layout: panel.layout,
                settings,
                xField,
                yField,
              };
            }
            if (type === "distribution") {
              const defaults = defaultDistributionFields(metricKey, workspaceFieldOptions, workspaceCategoricalFieldOptions);
              const valueField = sanitizeWorkspaceFieldPatch(patch.valueField)
                ?? (panel.type === "distribution" ? panel.valueField : undefined)
                ?? defaults.valueField;
              const groupField = Object.prototype.hasOwnProperty.call(patch, "groupField")
                ? sanitizeWorkspaceCategoricalFieldPatch(patch.groupField)
                : (panel.type === "distribution" ? panel.groupField : undefined) ?? defaults.groupField;
              const replicateField = Object.prototype.hasOwnProperty.call(patch, "replicateField")
                ? sanitizeWorkspaceCategoricalFieldPatch(patch.replicateField)
                : (panel.type === "distribution" ? panel.replicateField : undefined) ?? defaults.replicateField;
              return {
                id: panel.id,
                type: "distribution",
                title,
                metricKey,
                layout: panel.layout,
                settings,
                valueField,
                groupField,
                replicateField,
              };
            }
            if (type === "histogram_timeline") {
              const objectKey = sanitizeWorkspaceObjectKeyPatch(patch.objectKey)
                ?? (panel.type === "histogram_timeline" ? panel.objectKey : undefined)
                ?? metricKey;
              return {
                id: panel.id,
                type: "histogram_timeline",
                title,
                metricKey: metricKey || objectKey,
                layout: panel.layout,
                settings,
                objectKey,
              };
            }
            return {
              id: panel.id,
              type,
              title,
              metricKey,
              layout: panel.layout,
              settings,
            };
          }),
        }
        : section),
    }));
  }

  function resetWorkspaceLayout() {
    commitWorkspace(
      () => buildAutomaticWorkspace(allMetricOptions, project),
      "Workspace rebuilt from logged metrics. Undo available.",
      { markCustomized: false },
    );
    setPanelSearch("");
  }

  function clearChartHover() {
    pendingHoverRef.current = null;
    if (hoverFrameRef.current !== null) {
      window.cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }
    setHover(null);
  }

  function closeTransientSurfaces() {
    clearChartHover();
    setAddPanelSectionId("");
    setEditingPanelRef(null);
    setFullscreenPanelRef(null);
    setColumnsOpen(false);
  }

  function focusRouteStatus() {
    window.setTimeout(() => document.getElementById("status-message")?.focus({ preventScroll: true }), 0);
  }

  function closeMobileNav({ restoreFocus = true, afterFocus }: { restoreFocus?: boolean; afterFocus?: () => void } = {}) {
    setMobileNavOpen(false);
    if (!restoreFocus) {
      afterFocus?.();
      return;
    }
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('[data-mobile-menu-button="true"]')?.focus({ preventScroll: true });
      afterFocus?.();
    }, 0);
  }

  function selectTab(tabId: TabId) {
    const label = tabs.find((tab) => tab.id === tabId)?.label ?? tabId;
    closeTransientSurfaces();
    setActiveTab(tabId);
    setMobileNavOpen(false);
    setMessage(tabId === "runs" && summary.total ? runsPageMessage(summary.total, pageOffset, sortedRuns.length) : `Opened ${label}.`);
    // Push a fresh history entry on tab change so the browser back gesture
    // returns to the previously-active tab. Preserve any query string
    // (notably ?project=…) so projects survive tab switches.
    const url = tabToPath(tabId) + window.location.search;
    if (url !== window.location.pathname + window.location.search) {
      window.history.pushState(null, "", url);
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    focusRouteStatus();
  }

  function openQuickSearch() {
    closeTransientSurfaces();
    setShortcutHelpOpen(false);
    setQuickSearchInput("");
    setQuickSearchActiveIndex(0);
    setQuickSearchOpen(true);
  }

  function openShortcutHelp() {
    closeTransientSurfaces();
    setQuickSearchOpen(false);
    setShortcutHelpOpen(true);
  }

  function selectQuickSearchItem(item: QuickSearchItem) {
    clearChartHover();
    item.onSelect();
    setQuickSearchOpen(false);
    setQuickSearchInput("");
    setMessage(item.group === "View" ? "Saved view applied." : `Opened ${item.label}.`);
  }

function dismissTopOverlay() {
  if (stopDialog) {
    closeStopDialog();
    return true;
  }
  if (deleteViewTarget) {
    clearChartHover();
    setDeleteViewTarget(null);
    return true;
    }
  if (viewImportOpen) {
    clearChartHover();
    setViewImportOpen(false);
    return true;
  }
    if (quickSearchOpen) {
      clearChartHover();
      setQuickSearchOpen(false);
      return true;
    }
    if (shortcutHelpOpen) {
      clearChartHover();
      setShortcutHelpOpen(false);
      return true;
    }
    if (fullscreenPanelRef) {
      clearChartHover();
      setFullscreenPanelRef(null);
      return true;
    }
    if (editingPanelRef) {
      clearChartHover();
      setEditingPanelRef(null);
      return true;
    }
    if (addPanelSectionId) {
      clearChartHover();
      setAddPanelSectionId("");
      return true;
    }
    if (columnsOpen) {
      clearChartHover();
      setColumnsOpen(false);
      return true;
    }
    if (mobileNavOpen) {
      clearChartHover();
      closeMobileNav();
      return true;
    }
    return false;
  }

  function moveFullscreenPanel(direction: -1 | 1) {
    if (fullscreenPanelIndex < 0) return;
    const next = fullscreenPanelOrder[fullscreenPanelIndex + direction];
    if (next) setFullscreenPanelRef({ sectionId: next.sectionId, panelId: next.panelId });
  }

  function focusWorkspaceRegion() {
    selectTab("runs");
    const nextRegion = workspaceFocusRegionRef.current === "runs" ? "canvas" : "runs";
    workspaceFocusRegionRef.current = nextRegion;
    if (nextRegion === "runs") setRunsRailCollapsed(false);
    window.setTimeout(() => {
      const selector = nextRegion === "runs" ? ".workspace-run-main, .workspace-rail-head button" : "#panel-search, .workspace-panel-card button";
      const target = document.querySelector<HTMLElement>(selector);
      target?.focus();
      setMessage(nextRegion === "runs" ? "Focused Runs selector." : "Focused workspace panels.");
    }, 0);
  }

  globalKeyHandlerRef.current = (event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape" && dismissTopOverlay()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && hover) {
      event.preventDefault();
      clearChartHover();
      return;
    }
    if (quickSearchOpen || shortcutHelpOpen) return;
    if (stopDialog) return;
    if (fullscreenPanelRef && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      moveFullscreenPanel(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (isEditableElement(event.target)) return;
    const platform = typeof navigator === "undefined" ? "" : navigator.platform;
    if (matchesShortcut(event, "quick-search", platform)) {
      event.preventDefault();
      openQuickSearch();
    } else if (matchesShortcut(event, "help", platform)) {
      event.preventDefault();
      openShortcutHelp();
    } else if (matchesShortcut(event, "redo", platform)) {
      event.preventDefault();
      redoWorkspace();
    } else if (matchesShortcut(event, "undo", platform)) {
      event.preventDefault();
      undoWorkspace();
    } else if (matchesShortcut(event, "runs-rail", platform)) {
      event.preventDefault();
      setRunsRailCollapsed((current) => {
        const next = !current;
        setMessage(next ? "Runs selector collapsed." : "Runs selector restored.");
        return next;
      });
      selectTab("runs");
    } else if (matchesShortcut(event, "focus-workspace", platform)) {
      event.preventDefault();
      focusWorkspaceRegion();
    } else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !fullscreenPanelRef) {
      // Number keys jump between nav tabs (1 = Runs … in rail order).
      const target = tabs[Number(event.key) - 1];
      if (target) {
        event.preventDefault();
        selectTab(target.id);
      }
    }
  };

  useEffect(() => {
    function handleGlobalKey(event: globalThis.KeyboardEvent) {
      globalKeyHandlerRef.current?.(event);
    }
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, []);

  const activeTabIcon = tabs.find((tab) => tab.id === activeTab)?.icon ?? Activity;
  const ActiveIcon = activeTabIcon;
  const stopDialogRuns = stopDialog
    ? stopDialog.runIds.map((runId) => runSummaryForId(runId)).filter(Boolean) as RunSummary[]
    : [];
  const stopDialogTitle = stopDialogRuns.length === 1
    ? `Request stop for ${stopDialogRuns[0]?.name ?? "run"}`
    : `Request stop for ${stopDialogRuns.length} runs`;
  const stopDialogSkipRows = stopDialog
    ? [
        { count: stopDialog.skippedCounts.alreadyStopping, label: "Already stopping" },
        { count: stopDialog.skippedCounts.terminal, label: "Terminal" },
        { count: stopDialog.skippedCounts.unavailable, label: "Unavailable" },
        { count: stopDialog.skippedCounts.readOnly, label: "Read only" },
      ].filter((row) => row.count > 0)
    : [];
  const stopDialogSkippedSummary = stopDialogSkipRows.length
    ? stopDialogSkipRows.map((row) => `${row.label.toLowerCase()}: ${row.count}`).join("; ")
    : "";

  if (!dashboardSessionChecked) return <AppLoadingScreen detail="Checking session" />;
  if (!dashboardAuthorized) {
    return (
      <main className="auth-page" aria-busy="false">
        <section className="auth-card">
          <h1>Sign in required</h1>
          <p>{dashboardAuthMessage}</p>
          <SignInLink />
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <DashboardTopbar
        activeIcon={ActiveIcon}
        activeTab={activeTab}
        accountUser={sessionPayload?.user ?? null}
        detailRunName={primaryRun?.name ?? ""}
        mobileNavOpen={mobileNavOpen}
        onMobileMenuToggle={() => setMobileNavOpen((open) => !open)}
        onProject={changeProject}
        onQuickSearch={() => setQuickSearchOpen(true)}
        onCheckWorkspaceName={checkWorkspaceName}
        onCreateWorkspace={createWorkspace}
        onOpenBilling={() => selectTab("settings")}
        onOpenSettings={() => selectTab("settings")}
        onSelectTab={selectTab}
        onSignOut={signOut}
        onShortcutHelp={openShortcutHelp}
        onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
        theme={theme}
        orgMemberships={orgMemberships}
        orgSwitchBusy={orgSwitchBusy}
        orgSwitchError={orgSwitchError}
        onSwitchOrg={switchOrganization}
        metricUsagePercent={metricPercent}
        apiRequestUsagePercent={apiRequestsPercent}
        planLabel={activePlan}
        project={project}
        projects={projects}
        storageUsagePercent={storagePercent}
        usageAvailable={usageAvailable}
        usageResetLabel={usageResetLabel}
        workspaceName={sessionPayload?.organization?.name ?? ""}
        workspaceId={activeOrgId}
      />

      {stopDialog ? (
        <div className="workspace-modal checkpoint-fork-modal" role="dialog" aria-modal="true" aria-labelledby="stop-dialog-title">
          <div className="workspace-modal-card checkpoint-fork-card" ref={stopDialogRef} tabIndex={-1}>
            <div className="drawer-head">
              <div>
                <span className="analysis-eyebrow eyebrow--accent">Cooperative stop</span>
                <h2 id="stop-dialog-title">{stopDialogTitle}</h2>
              </div>
              <button aria-label="Close stop dialog" className="icon-button framed" disabled={stopSubmitting} onClick={closeStopDialog} type="button">
                <X size={16} />
              </button>
            </div>
            <div className="checkpoint-fork-body">
              <p className="checkpoint-fork-notice">InstantML records a cooperative stop request and waits for SDK code that polls stop-signal to acknowledge it. Old, offline, or non-polling loops cannot be force-terminated from the dashboard.</p>
              <div className="checkpoint-fork-grid stop-request-grid">
                <div><span>Eligible runs</span><strong>{stopDialogRuns.length}</strong></div>
                <div><span>Mode</span><strong>{stopDialog.source === "bulk" ? "bulk" : "single"}</strong></div>
                {stopDialogSkipRows.map((row) => (
                  <div key={row.label}><span>{row.label}</span><strong>{row.count}</strong></div>
                ))}
                {stopDialog.skippedRunCount > 0 ? <div><span>Skipped</span><strong>{stopDialog.skippedRunCount}</strong></div> : null}
              </div>
              {stopDialogSkippedSummary ? (
                <p className="checkpoint-fork-notice">Skipped selected runs ({stopDialogSkippedSummary}). Only eligible running runs receive a new stop request.</p>
              ) : null}
              {stopDialog.skippedRunCount > 0 ? (
                <p className="checkpoint-fork-notice">Only the first {MAX_STOP_DIALOG_RUNS} eligible selected runs are included. {stopDialog.skippedRunCount} more will be left untouched.</p>
              ) : null}
              <div className="stop-request-list" aria-label="Runs to stop">
                {stopDialogRuns.slice(0, 6).map((run) => (
                  <span key={run.id} title={run.name}>{run.name}</span>
                ))}
                {stopDialogRuns.length > 6 ? <em>+{stopDialogRuns.length - 6} more</em> : null}
              </div>
              <label className="checkpoint-fork-field">
                <span>Reason</span>
                <textarea
                  aria-label="Stop reason"
                  id="stop-reason"
                  maxLength={500}
                  onChange={(event) => setStopDialogReason(event.target.value)}
                  placeholder="Optional note for the run history"
                  rows={3}
                  value={stopDialog.reason}
                />
              </label>
              {stopError ? <div className="checkpoint-fork-error" role="alert">{stopError}</div> : null}
            </div>
            <div className="checkpoint-fork-actions">
              <button className="secondary" disabled={stopSubmitting} onClick={closeStopDialog} type="button">Cancel</button>
              <button className="primary-button stop-dialog-submit" disabled={stopSubmitting || !stopDialogRuns.length} onClick={submitStopDialog} type="button">
                <Square size={14} /> {stopSubmitting ? "Requesting..." : "Send stop request"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isMobile && mobileNavOpen ? (
        <div
          className="mobile-nav-scrim"
          aria-hidden="true"
          onClick={() => closeMobileNav()}
        />
      ) : null}

      <section className={`shell ${navAutoOpen ? "nav-auto-open" : ""} ${mobileNavOpen ? "mobile-nav-open" : ""}`}>
        <DashboardNav
          activeTab={activeTab}
          compactNav={isMobile}
          mobileOpen={mobileNavOpen}
          onAutoOpenChange={setNavAutoOpen}
          onMobileClose={closeMobileNav}
          onSelect={selectTab}
          onShortcutHelp={() => closeMobileNav({ afterFocus: openShortcutHelp })}
          onThemeToggle={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          theme={theme}
        />

        <section className={`tab-pane ${activeTab === "runs" ? "active" : ""}`} aria-label="Runs">
          {activeTab === "runs" ? (
            <RunsTabPane
              addPanelSectionId={addPanelSectionId}
              primaryRunId={primaryRun?.id ?? ""}
              allMetricOptions={allMetricOptions}
              availableWorkspaceMetrics={availableWorkspaceMetrics}
              canControlRuns={canControlRuns}
              columnMetricFilter={columnMetricFilter}
              columnMetricFilterValid={columnMetricFilterValid}
              columnMetricOptionsForControls={columnMetricOptionsForControls}
              columnsOpen={columnsOpen}
              dashboardLoading={dashboardLoading}
              editingPanelContext={editingPanelContext}
              exportSelectedBusy={exportSelectedBusy}
              fullscreenModalRef={fullscreenModalRef}
              fullscreenPanelContext={fullscreenPanelContext}
              fullscreenPanelIndex={fullscreenPanelIndex}
              fullscreenPanelOrder={fullscreenPanelOrder}
              hasNextPage={hasNextPage}
              hasPreviousPage={hasPreviousPage}
              initialLoadDone={initialLoadDone}
              filterBar={(
                <RunFilterBar
                  overview={overview}
                  status={status}
                  onStatus={changeStatus}
                  query={queryInput}
                  onQuery={changeRunQueryInput}
                  sortBy={sortBy}
                  onSortBy={changeRunSort}
                  project={project}
                  onProject={changeProject}
                  searchError={searchError}
                  searchErrorStale={Boolean(searchError && searchError.query !== queryInput)}
                  savedViews={savedViews}
                  savedViewKey={savedViewKey}
                  viewName={viewName}
                  onViewName={setViewName}
                  onSaveView={saveView}
                  canSaveView={canWriteWorkspace}
                  onExportSavedView={exportSavedView}
                  onImportSavedView={openImportSavedView}
                  onDeleteSavedView={requestDeleteSavedView}
                  canExportSavedView={Boolean(selectedControlSavedView) && !viewActionBusy}
                  canDeleteSavedView={Boolean(selectedControlSavedView?.updatedAt) && canWriteWorkspace && !viewActionBusy}
                  onApplySavedView={applySavedView}
                  onClearFilters={clearFilters}
                  onRefresh={loadDashboard}
                  message={message}
                  tone={currentMessageTone}
                />
              )}
              compareSlot={(
                <CompareView
                  addAllCompareTableMetrics={addAllCompareTableMetrics}
                  addCompareTableMetric={addCompareTableMetric}
                  compareAddMetricOptions={compareAddMetricOptions}
                  compareArtifactsByRun={compareArtifactsByRun}
                  compareOverflowCount={compareOverflowCount}
                  compareRuns={compareRuns}
                  compareTableMetricKeys={compareTableMetricKeys}
                  exportSelectedBusy={exportSelectedBusy}
                  MAX_COMPARE_TABLE_METRICS={MAX_COMPARE_TABLE_METRICS}
                  metricKey={metricKey}
                  metricOptionsForControls={metricOptionsForControls}
                  onChangeMetricKeyAndSortKey={(value) => { changeMetricKey(value); setCompareSortMetricKey(value); }}
                  onClearSelection={() => {
                    defaultSelectionInitializedRef.current = true;
                    selectionUrlSyncRef.current = true;
                    selectionAnchorRunIdRef.current = "";
                    setSelectedRunIds([]);
                  }}
                  onExportSelectedRuns={exportSelectedRunsCsv}
                  onOpenRunArtifacts={(runId) => { setPrimaryRunId(runId); selectTab("artifacts"); }}
                  onReferenceRunId={setReferenceRunId}
                  onResetCompareTableMetrics={resetCompareTableMetrics}
                  referenceRun={referenceRun}
                  removeCompareTableMetric={removeCompareTableMetric}
                  selectedRunExportDisabled={selectedRunExportDisabled}
                  selectedRunExportTitle={selectedRunExportTitle}
                  sideBySide={sideBySide}
                />
              )}
              onRunsViewChange={(view) => setRunsViewIsTable(view === "table")}
              metricKey={metricKey}
              metricOptionsForControls={metricOptionsForControls}
              onAddPanel={addWorkspacePanel}
              onAddSection={addWorkspaceSection}
              onChangeMetricKey={changeMetricKey}
              onClearFilters={clearFilters}
              onCloseEditingPanel={() => setEditingPanelRef(null)}
              onColumnsOpen={setColumnsOpen}
              onColumnMetricFilter={setColumnMetricFilter}
              onDuplicatePanel={duplicateWorkspacePanel}
              onEditPanel={(sectionId, panelId) => setEditingPanelRef({ sectionId, panelId })}
              onExportSelectedRuns={exportSelectedRunsCsv}
              onFullscreenPanel={(sectionId, panelId) => setFullscreenPanelRef({ sectionId, panelId })}
              onFullscreenPanelClose={() => setFullscreenPanelRef(null)}
              onFullscreenPanelMove={moveFullscreenPanel}
              onInspectRun={setPrimaryRunId}
              onMovePanel={moveWorkspacePanel}
              onGoToPage={goToRunPage}
              onNextPage={goToNextRunPage}
              onOpenRun={(id) => { setPrimaryRunId(id); selectTab("detail"); }}
              onPageSize={changeRunPageSize}
              onPanelSearch={setPanelSearch}
              onPinnedMetric={togglePinnedMetric}
              onPreviousPage={goToPreviousRunPage}
              onRefresh={loadDashboard}
              onRemovePanel={removeWorkspacePanel}
              onRequestStop={(runIds) => openStopDialogForRuns(runIds, runIds.length > 1 ? "bulk" : "single")}
              onResetWorkspace={resetWorkspaceLayout}
              onResizePanel={resizeWorkspacePanel}
              onPanelSmoothing={setWorkspacePanelSmoothing}
              onRunRailCollapsed={(collapsed) => {
                setRunsRailCollapsed(collapsed);
                setMessage(collapsed ? "Runs selector collapsed." : "Runs selector restored.");
              }}
              onSelectAllMatching={selectAllMatchingRuns}
              onClearSelection={() => {
                selectionUrlSyncRef.current = true;
                selectionAnchorRunIdRef.current = "";
                setSelectedRunIds([]);
              }}
              onSelectAllVisible={selectAllVisibleRuns}
              onSelectProject={changeProject}
              onSetAddPanelSection={setAddPanelSectionId}
              onSwitchOrganization={switchOrganization}
              onTableColumns={setTableColumns}
              onToggleRun={toggleRun}
              onToggleSection={toggleWorkspaceSection}
              onUpdateEditingPanel={updateEditingPanel}
              orgMemberships={orgMemberships}
              orgName={sessionPayload?.organization?.name ?? ""}
              orgSwitchBusy={orgSwitchBusy}
              pageEnd={pageEnd}
              pageSize={pageSize}
              pageStart={pageStart}
              paginationBusy={paginationBusy}
              panelSearch={panelSearch}
              pinnedMetrics={pinnedMetrics}
              project={project}
              projects={projects}
              query={query}
              queryInput={queryInput}
              runsRailCollapsed={runsRailCollapsed}
              selectAllMatchingBusy={selectAllMatchingBusy}
              selectAllMatchingDisabled={queryInput !== query || Boolean(searchError && searchError.query === query)}
              selectedRunIds={selectedRunIds}
              selectedRunExportDisabled={selectedRunExportDisabled}
              selectedRunExportTitle={selectedRunExportTitle}
              selectedStopCandidateCount={selectedStopCandidateCount}
              selectedStopDisabledReason={selectedStopDisabledReason}
              sortedRuns={sortedRuns}
              status={status}
              summaryTotal={summary.total}
              tableColumns={tableColumns}
              workspaceHistogramTimelines={workspaceHistogramTimelines}
              workspacePanelRuns={workspacePanelRuns}
              workspaceCategoricalFieldOptions={workspaceCategoricalFieldOptions}
              workspaceFieldOptions={workspaceFieldOptions}
              workspaceSeries={workspaceSeries}
              workspaceView={workspaceView}
            />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "metrics" ? "active" : ""}`} aria-label="Metrics">
          {activeTab === "metrics" ? (
            <MetricsTabPane
              activeMetricCatalogRow={activeMetricCatalogRow}
              chartSummaries={chartSummaries}
              chartZoomRange={chartZoomRange}
              groupAverage={groupAverage}
              groupBy={groupBy}
              hover={hover}
              hoverMetricKey={hoverMetricKey}
              metricCatalogRows={metricCatalogRows}
              metricFilter={metricFilter}
              metricFilterValid={metricFilterValid}
              metricKey={metricKey}
              metricOptionsForControls={metricOptionsForControls}
              onGroupAverage={setGroupAverage}
              onGroupBy={setGroupBy}
              onMetricFilter={setMetricFilter}
              onMetricKey={changeMetricKey}
              onChartLeave={() => setHover(null)}
              onPinnedMetric={togglePinnedMetric}
              onPointHoverChange={(point, key) => { setHoverMetricKey(key); setHover(point); }}
              onPinnedChartZoomRangeChange={(metric, range) => setPinnedChartZoomRanges((current) => ({ ...current, [metric]: range }))}
              onSmoothing={setSmoothing}
              onXMode={setXMode}
              identifierMode={identifierMode}
              onIdentifierMode={setIdentifierMode}
              onZoomRangeChange={setChartZoomRange}
              pinnedChartPanels={pinnedChartPanels}
              pinnedMetrics={pinnedMetrics}
              selectedRuns={metricSeriesRuns}
              series={displaySeries}
              smoothing={smoothing}
              sortedRuns={sortedRuns}
              visibleMetricCatalogRows={visibleMetricCatalogRows}
              xMode={xMode}
            />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "distributed" ? "active" : ""}`} aria-label="Distributed">
          {activeTab === "distributed" ? (
            <DistributedTabPane
              api={api}
              availableRuns={sortedRuns}
              onSelectRun={setPrimaryRunId}
              primaryRun={primaryRun}
            />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "detail" ? "active" : ""}`} aria-label="Run Detail">
          {activeTab === "detail" ? (
            <DetailTabPane
              api={api}
              canControlRuns={canControlRuns}
              dataControls={
                <>
                  <CustomSelect
                    id="detail-metric-select"
                    label="Metric"
                    onChange={setMetricKey}
                    options={metricOptionsForControls.length ? metricOptionsForControls.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
                    value={metricOptionsForControls.length ? metricKey : ""}
                  />
                  <CustomSelect
                    id="detail-x-mode"
                    label="X axis"
                    onChange={setXMode}
                    options={[{ value: "step", label: "Step" }, { value: "time", label: "Time" }]}
                    value={xMode}
                  />
                </>
              }
              hover={inspectedPoint}
              loggedObjects={loggedObjects}
              objectRowsById={objectRowsById}
              onChartLeave={() => setHover(null)}
              onChartPointHover={(point) => { setHoverMetricKey(metricKey); setHover(point); }}
              onChartZoomRangeChange={setPrimaryChartZoomRange}
              onForkCheckpoint={canWriteWorkspace ? forkCheckpointRun : undefined}
              onRequestStop={(runIds) => openStopDialogForRuns(runIds, runIds.length > 1 ? "bulk" : "single")}
              onRunMetadataSave={canWriteWorkspace ? updateRunTagsAndNotes : undefined}
              onWorkspaceTabChange={handleRunWorkspaceTabChange}
              primarySeries={primaryDisplaySeries}
              primaryChartZoomRange={primaryChartZoomRange}
              run={primaryRun}
              runMetricRows={runMetricRows}
              runTimelineRows={runTimelineRows}
              runWorkspaceTab={runWorkspaceTab}
              selectedRuns={selectedRuns}
              visibleArtifacts={visibleArtifacts}
              xMode={xMode}
            />
          ) : null}
        </section>


        <section className={`tab-pane ${activeTab === "alerts" ? "active" : ""}`} aria-label="Alerts">
          {activeTab === "alerts" ? (
            <AlertsTabPane alertRows={alertRows} metricKey={metricKey} overview={overview} onRefresh={loadDashboard} />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "datasets" ? "active" : ""}`} aria-label="Datasets">
          {activeTab === "datasets" ? (
            <DatasetsTabPane datasetRows={datasetRows} metricKey={metricKey} />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "insights" ? "active" : ""}`} aria-label="Insights">
          {activeTab === "insights" ? (
            <InsightsTabPane
              api={api}
              metricKey={metricKey}
              onSelectRun={setPrimaryRunId}
              project={project}
              selectedRunIds={selectedRunIds}
              sortedRuns={sortedRuns}
            />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "artifacts" ? "active" : ""}`} aria-label="Artifacts">
          {activeTab === "artifacts" ? (
            <ArtifactsTabPane
              api={api}
              canManageArtifacts={canManageOrg}
              loggedObjects={loggedObjects}
              objectRowsById={objectRowsById}
              primaryRun={primaryRun}
              project={project}
              visibleArtifacts={visibleArtifacts}
            />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "reports" ? "active" : ""}`} aria-label="Reports">
          {activeTab === "reports" ? <ReportsTabPane canEditReports={canEditReports} /> : null}
        </section>

        <section className={`tab-pane ${activeTab === "settings" ? "active" : ""}`} aria-label="Settings">
          {activeTab === "settings" ? (
            <SettingsTabPane
              accountUser={sessionPayload?.user ?? null}
              activeLimitIncludedSeats={Number(activeLimits.included_seats ?? sessionPayload?.organization?.seat_limit ?? 0)}
              activePlan={activePlan}
              activeUsageWarnings={activeUsageOrg?.warnings ?? []}
              adminBusy={adminBusy}
              canManageOrg={canManageOrg}
              formatBytes={formatBytes}
              inviteEmail={inviteEmail}
              inviteRole={inviteRole}
              invitations={invitations}
              invitationLinks={invitationLinks}
              metricKey={metricKey}
              metricOptionsForControls={metricOptionsForControls}
              metricPercent={metricPercent}
              metricUsed={metricUsed}
              metricLimit={metricLimit}
              apiRequestsPercent={apiRequestsPercent}
              apiRequestsUsed={apiRequestsUsed}
              apiRequestsLimit={apiRequestsLimit}
              generalRateLimitLabel={generalRateLimitLabel}
              ingestRateLimitLabel={ingestRateLimitLabel}
              onInviteEmail={setInviteEmail}
              onInviteRole={setInviteRole}
              onInviteSeat={inviteSeat}
              onCopyInvitationLink={copyInvitationLink}
              onOpenInvitationLink={openInvitationLink}
              onResendInvitation={resendInvitation}
              onRevokeInvitation={revokeInvitation}
              onOpenBillingPortal={openBillingPortal}
              onChangeBillingPlan={changeBillingPlan}
              onCancelBilling={cancelBilling}
              onLoadOrgSettings={loadOrgSettings}
              onMetricKey={setMetricKey}
              onXMode={setXMode}
              orgName={sessionPayload?.organization?.name ?? ""}
              orgPlanTier={activeUsageOrg?.plan_tier ?? sessionPayload?.organization?.plan_tier ?? "free"}
              reservedSeatCount={Number(activeUsageOrg?.usage?.seats ?? activeMembershipSummary?.member_count ?? seats.length)}
              seats={seats}
              storagePercent={storagePercent}
              storageUsed={storageUsed}
              storageLimit={storageLimit}
              storageUsageLabel={storageUsageLabel}
              storageUsageDescription={storageUsageDescription}
              usageResetLabel={usageResetLabel}
              usageAvailable={usageAvailable}
              xMode={xMode}
              billingStatus={billingPayload?.billing ?? null}
            />
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "api" ? "active" : ""}`} aria-label="API">
          {activeTab === "api" ? (
            <ApiTabPane
              activeOrgId={activeOrgId}
              adminBusy={adminBusy}
              adminMessage={apiAdminMessage}
              adminMessageTone={apiAdminTone}
              apiKeyName={apiKeyName}
              apiKeys={apiKeys}
              apiRows={apiRows}
              canManageOrg={canManageOrg}
              metricKey={metricKey}
              newApiKey={newApiKey}
              onApiKeyNameChange={setApiKeyName}
              onCopyNewApiKey={copyNewApiKey}
              onCreateApiKey={createDashboardApiKey}
              onLoadApiKeys={loadApiKeys}
              onRevokeApiKey={revokeDashboardApiKey}
              primaryRunId={primaryRun?.id ?? null}
              project={project}
              selectedRunIds={selectedRunIds}
              status={status}
            />
          ) : null}
        </section>
      </section>
      {quickSearchOpen ? (
        <QuickSearchModal
          activeIndex={quickSearchActiveIndex}
          items={filteredQuickSearchItems}
          onActiveIndex={setQuickSearchActiveIndex}
          onClose={() => { clearChartHover(); setQuickSearchOpen(false); }}
          onQuery={setQuickSearchInput}
          onSelect={selectQuickSearchItem}
          query={quickSearchInput}
          returnFocusSelector="[data-quick-search-trigger='true']"
        />
      ) : null}
      {shortcutHelpOpen ? (
        <ShortcutHelpModal
          commands={shortcutCommands}
          modifierLabel={modifierLabel}
          onClose={() => { clearChartHover(); setShortcutHelpOpen(false); }}
          returnFocusSelector="[data-shortcut-help-trigger='true']"
        />
      ) : null}
      {viewImportOpen ? (
        <WorkspaceViewImportModal
          busy={viewImportBusy}
          error={viewImportError}
          fileName={viewImportFileName}
          onClose={() => {
            clearChartHover();
            setViewImportOpen(false);
          }}
          onConfirm={confirmImportSavedView}
          onFile={updateImportSavedViewFile}
          onPreview={previewImportSavedView}
          onText={updateImportSavedViewText}
          preview={viewImportPreview}
          previewCurrent={Boolean(viewImportPreview && viewImportPreviewText && viewImportPreviewText === viewImportText)}
          text={viewImportText}
        />
      ) : null}
      {deleteViewTarget ? (
        <WorkspaceViewDeleteModal
          busy={viewActionBusy}
          name={deleteViewTarget.label}
          onClose={() => setDeleteViewTarget(null)}
          onConfirm={confirmDeleteSavedView}
          updatedAt={deleteViewTarget.updatedAt ?? ""}
        />
      ) : null}
    </main>
  );
}

function WorkspaceViewImportModal({
  busy,
  error,
  fileName,
  onClose,
  onConfirm,
  onFile,
  onPreview,
  onText,
  preview,
  previewCurrent,
  text,
}: {
  busy: boolean;
  error: string;
  fileName: string;
  onClose: () => void;
  onConfirm: () => void;
  onFile: (file: File | null) => void;
  onPreview: () => void;
  onText: (value: string) => void;
  preview: WorkspaceViewImportPreview | null;
  previewCurrent: boolean;
  text: string;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(
    true,
    onClose,
    "#workspace-view-import-file",
    "[data-view-actions-trigger='true']",
  );
  const canPreview = Boolean(text.trim()) && !busy && workspaceViewImportByteLength(text) <= MAX_WORKSPACE_VIEW_IMPORT_BYTES;
  const canConfirm = Boolean(preview) && previewCurrent && !busy;
  return (
    <div className="workspace-modal-backdrop" role="presentation">
      <section className="workspace-create-modal workspace-view-modal" role="dialog" aria-modal="true" aria-label="Import saved view" ref={dialogRef} tabIndex={-1}>
        <div className="workspace-create-head">
          <div>
            <h2>Import saved view</h2>
            <p>{fileName || "Select an exported InstantML view JSON file."}</p>
          </div>
          <button className="icon-button framed" type="button" aria-label="Close import saved view" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="workspace-create-form">
          <div className="workspace-create-body workspace-view-import-body">
            <label className="workspace-create-field">
              JSON file
              <input
                accept="application/json,.json"
                id="workspace-view-import-file"
                onChange={(event) => onFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <label className="workspace-create-field">
              JSON payload
              <textarea
                aria-label="Saved view JSON payload"
                className="workspace-view-import-text"
                onChange={(event) => onText(event.target.value)}
                spellCheck={false}
                value={text}
              />
            </label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {preview ? (
              <div className="workspace-view-preview" role="status">
                <div><span>Name</span><strong>{preview.name ?? "Untitled view"}</strong></div>
                <div><span>Project</span><strong>{preview.project || "All projects"}</strong></div>
                <div><span>Payload</span><strong>{formatBytes(preview.payload_bytes ?? 0)}</strong></div>
                {preview.warnings?.length ? (
                  <ul>
                    {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="workspace-create-actions">
            <button className="secondary" disabled={busy} type="button" onClick={onClose}>Cancel</button>
            <button className="secondary" disabled={!canPreview} type="button" onClick={onPreview}>{busy ? "Checking..." : "Preview"}</button>
            <button className="primary-button" disabled={!canConfirm} type="button" onClick={onConfirm}>{busy ? "Importing..." : "Import"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function WorkspaceViewDeleteModal({
  busy,
  name,
  onClose,
  onConfirm,
  updatedAt,
}: {
  busy: boolean;
  name: string;
  onClose: () => void;
  onConfirm: () => void;
  updatedAt: string;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(
    true,
    onClose,
    "button[data-delete-view-cancel='true']",
    "[data-view-actions-trigger='true']",
  );
  return (
    <div className="workspace-modal-backdrop" role="presentation">
      <section className="workspace-create-modal workspace-view-modal compact" role="dialog" aria-modal="true" aria-label="Delete saved view" ref={dialogRef} tabIndex={-1}>
        <div className="workspace-create-head">
          <div>
            <h2>Delete saved view</h2>
            <p>{name}</p>
          </div>
          <button className="icon-button framed" type="button" aria-label="Close delete saved view" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="workspace-create-form">
          <div className="workspace-create-body workspace-view-delete-body">
            <p>This removes the shared view for your workspace account.</p>
            <dl>
              <dt>Last saved</dt>
              <dd>{updatedAt || "Unknown"}</dd>
            </dl>
          </div>
          <div className="workspace-create-actions">
            <button className="secondary" data-delete-view-cancel="true" disabled={busy} type="button" onClick={onClose}>Cancel</button>
            <button className="secondary danger-action" data-delete-view-confirm="true" disabled={busy} type="button" onClick={onConfirm}>{busy ? "Deleting..." : "Delete"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function planDisplayName(value?: string) {
  if (value === "premium" || value === "growth") return "Premium";
  if (value === "pro" || value === "lab" || value === "startup") return "Pro";
  return "Free";
}

function isSharedDemoSession(session: DashboardSessionPayload | null) {
  return session?.user?.primary_email === SHARED_DEMO_EMAIL
    || session?.organization?.name === SHARED_DEMO_ORG
    || session?.organization?.slug === "instantml-demo";
}

function formatUsageResetLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function formatRateLimitLabel(rps?: unknown, burst?: unknown) {
  const requestsPerSecond = Number(rps ?? 0);
  const burstSize = Number(burst ?? 0);
  if (!requestsPerSecond) return "";
  return `${formatNumber(requestsPerSecond, 0)} req/sec${burstSize ? `, burst ${formatNumber(burstSize, 0)}` : ""}`;
}

function runsPageMessage(total: number, offset: number, visibleCount: number) {
  if (!total) return "No runs match the current filters.";
  const start = Math.max(1, offset + 1);
  const count = visibleCount > 0 ? visibleCount : Math.min(25, Math.max(1, total - offset));
  const end = Math.min(total, offset + count);
  return `${formatNumber(start, 0)}-${formatNumber(end, 0)} of ${formatNumber(total, 0)} matching runs`;
}

async function fetchBatchedMetricSeries(
  api: ApiClient,
  metricKey: string,
  runs: RunSummary[],
  signal: AbortSignal,
  onPatch?: (series: MetricSeries[]) => void,
): Promise<MetricSeries[]> {
  if (!runs.length || !metricKey) return [];
  let merged: MetricSeries[] = [];
  for (const ids of chunkRunIds(runs)) {
    if (signal.aborted) break;
    const patch = await fetchMetricSeriesPatch(api, metricKey, runs, ids, signal);
    merged = mergeMetricSeriesPatches(runs, merged, patch);
    onPatch?.(merged);
  }
  return merged;
}

async function fetchMetricSeriesForMetrics(
  api: ApiClient,
  metricKeys: string[],
  runs: RunSummary[],
  signal: AbortSignal,
  onMetricPatch: (metricKey: string, series: MetricSeries[]) => void,
) {
  const uniqueMetricKeys = [...new Set(metricKeys.filter(Boolean))];
  const mergedByMetric = new Map<string, MetricSeries[]>();
  const tasks: Array<() => Promise<void>> = [];
  for (const metricKey of uniqueMetricKeys) {
    for (const ids of chunkRunIds(runs)) {
      tasks.push(async () => {
        if (signal.aborted) return;
        const patch = await fetchMetricSeriesPatch(api, metricKey, runs, ids, signal);
        const merged = mergeMetricSeriesPatches(runs, mergedByMetric.get(metricKey) ?? [], patch);
        mergedByMetric.set(metricKey, merged);
        onMetricPatch(metricKey, merged);
      });
    }
  }
  await runWithConcurrency(tasks, 2);
  return Object.fromEntries(uniqueMetricKeys.map((metric) => [metric, mergedByMetric.get(metric) ?? []]));
}

async function fetchMetricSeriesPatch(
  api: ApiClient,
  metricKey: string,
  runs: RunSummary[],
  runIds: string[],
  signal: AbortSignal,
): Promise<MetricSeries[]> {
  if (!runIds.length) return [];
  const runLookup = new Map(runs.map((run) => [run.id, run]));
  const payload = await retryTransientRequest(
    () => api.post(
      `/api/metrics/series`,
      {
        key: metricKey,
        run_ids: runIds,
        limit: adaptiveMetricSeriesLimit(runs.length),
        buckets: METRIC_SERIES_M4_BUCKETS,
      },
      { signal },
    ),
    { signal, delays: METRIC_SERIES_RETRY_DELAYS_MS },
  );
  const seriesArray = Array.isArray(payload?.series) ? payload.series : [];
  const pointsByRunId = new Map<string, MetricSeries["points"]>();
  for (const entry of seriesArray) {
    if (entry && typeof entry === "object" && typeof entry.run_id === "string") {
      pointsByRunId.set(entry.run_id, Array.isArray(entry.metrics) ? entry.metrics : []);
    }
  }
  return runIds.map((id) => ({
    id,
    name: runLookup.get(id)?.name ?? id,
    group: "all",
    points: pointsByRunId.get(id) ?? [],
  }));
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, concurrency: number) {
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (tasks.length) {
      const task = tasks.shift();
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

function SignInLink() {
  // The real destination (current path + query) is only known in the browser;
  // resolve it after mount so server and client render the same initial href.
  const [next, setNext] = useState("/dashboard/runs");
  useEffect(() => {
    setNext(`${window.location.pathname}${window.location.search}`);
  }, []);
  return (
    <Link className="button-link" href={`/signin?next=${encodeURIComponent(next)}`}>
      Open sign in
    </Link>
  );
}
