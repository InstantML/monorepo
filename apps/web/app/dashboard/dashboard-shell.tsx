"use client";

import { useClerk } from "@clerk/nextjs";
import {
  Activity,
  AlertTriangle,
  Archive,
  BarChart3,
  Box,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileBarChart,
  FileText,
  Gauge,
  GitCompare,
  KeyRound,
  Layers3,
  Package,
  Plug,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Star,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { ApiClient, ApiError, isAbortError, queryString, retryTransientRequest } from "../../src/api.js";
import { canonicalDashboardPath, pathFromLegacyHash, sanitizeNextPath, tabFromPath, tabToPath } from "../../src/routes.js";
import { averageGroupedSeries, chartDomain, chartSummary, nearestPoint, normalizeSeries, smoothSeries, svgPointFromClient } from "../../src/charts.js";
import { adaptiveMetricSeriesLimit, chunkRunIds, mergeMetricSeriesPatches } from "../../src/dashboard-panels.js";
import { isEditableElement, matchesShortcut, platformModifierLabel } from "../../src/shortcuts.js";
import { DEFAULT_SELECTED_RUNS, MAX_SELECTED_RUNS, capSelectionToMatching, defaultRunSelection, deselectVisible, filterMetricKeys, formatNumber, groupKeyForRun, metricFilterIsRegex, metricGoalLabel, metricKeysFromSummary, preferredMetricKey, rangeSelect, selectAllVisible, toggleSelection, visibleSelectionState } from "../../src/state.js";

import {
  AlertList,
  ApiTable,
  ArtifactBrowser,
  ArtifactPanel,
  ChartControls,
  CustomSelect,
  DashboardNav,
  DashboardTopbar,
  DatasetTable,
  HoverDetail,
  IntegrationCard,
  MetricCatalog,
  MetricCard,
  MetricChart,
  MetricLeaderboard,
  RichObjectPanel,
  ModelContext,
  ModelLineage,
  PanelEditDrawer,
  QuickSearchModal,
  ReportList,
  RunDetail,
  RunMetadataEditor,
  RunsCommandbar,
  RunsChartStrip,
  RunsTable,
  RunsWorkspace,
  SeriesSummary,
  SettingRow,
  SideBySide,
  Stats,
  ShortcutHelpModal,
  useFocusTrap,
  WorkspacePanelCard,
} from "../dashboard-components";
import { buildIntegrationRows, tabs } from "../dashboard-config";
import {
  artifactTotalsForRuns,
  buildAlertRows,
  buildApiRows,
  buildDatasetRows,
  buildMetricCatalogRows,
  buildModelRows,
  buildReportRows,
  buildRunMetricRows,
  buildRunTimelineRows,
  buildAutomaticWorkspace,
  buildManualWorkspace,
  COMPARE_ARTIFACT_LIMIT,
  COMPARE_RUN_LIMIT,
  chartHeight,
  chartPadding,
  chartWidth,
  defaultTableColumns,
  metricTitle,
  sanitizePanelLayout,
  sanitizeWorkspaceView,
  shortMetricName,
  stableId,
  workspaceMetricKeys,
  workspacePanelForMetric,
  workspaceStorageKey,
} from "../dashboard-models";
import { AppLoadingScreen } from "../loading-screen";
import type { Artifact, CompareLayout, CompareRowSort, CompareRunSort, HoverPoint, LoggedObject, LoggedObjectRow, MetricSeries, Overview, RunSummary, Summary, TabId, TableColumns, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceView } from "../dashboard-types";
import { RunWorkspace, type RunWorkspaceTabId } from "./components/run-workspace";
import { LEGACY_SAVED_VIEW_PREFIX, NAV_PINNED_KEY, RUNS_RAIL_COLLAPSED_KEY, SAVED_VIEW_PREFIX, THEME_KEY } from "./state/storage-keys";
import { useIsMobile } from "./state/use-mobile";
import { PageHead } from "./ui/page-head";

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
  source: "control" | "local";
  value: string;
};
type WorkspaceViewSummaryPayload = {
  id: string;
  name: string;
  project?: string | null;
  created_at?: string;
  updated_at?: string;
};
type DashboardSessionPayload = {
  authenticated?: boolean;
  organization?: { id: string; name: string; slug: string; plan_tier?: string; seat_limit?: number };
  user?: { primary_email: string; display_name?: string | null };
  membership?: { role: string; status: string };
};
type SeatRow = {
  membership: { id: string; role: string; status: string; created_at: string };
  user: { id: string; primary_email: string; display_name?: string | null };
};
type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
};
type UsageOrg = {
  org_id: string;
  plan_tier: string;
  usage_period?: UsagePeriod;
  usage: Record<string, number | null | string>;
  limits: Record<string, number>;
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
const SEARCH_DEBOUNCE_MS = 250;
const MAX_METRIC_OPTIONS = 120;
const MAX_METRIC_CATALOG_ROWS = 200;
const MAX_COMPARE_TABLE_METRICS = 12;
const ARTIFACT_PAGE_LIMIT = 100;
const WORKSPACE_HISTORY_LIMIT = 50;
const WAREHOUSE_RETRY_MS = 5_000;
const DASHBOARD_REQUEST_RETRY_DELAYS_MS = [250, 700, 1_500];
const METRIC_SERIES_RETRY_DELAYS_MS = [350, 900, 1_800];
const compareLayouts = new Set<CompareLayout>(["auto", "columns", "rows"]);
const compareRowSorts = new Set<CompareRowSort>(["signal", "changed", "missing", "category", "name", "spread"]);
const compareRunSorts = new Set<CompareRunSort>(["selected", "name", "newest", "status", "duration", "metric-latest", "metric-best", "artifacts", "tags", "notes", "config"]);

function boundedOptions(options: string[], activeValue: string, limit = MAX_METRIC_OPTIONS) {
  const capped = options.slice(0, limit);
  if (activeValue && options.includes(activeValue) && !capped.includes(activeValue)) return [activeValue, ...capped.slice(0, Math.max(0, limit - 1))];
  return capped;
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

function savedViewStorageKeys() {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(SAVED_VIEW_PREFIX) || key.startsWith(LEGACY_SAVED_VIEW_PREFIX))
    .sort();
}

function localSavedViewOptions(): SavedViewOption[] {
  return savedViewStorageKeys().map((key) => ({
    label: key.replace(SAVED_VIEW_PREFIX, "").replace(LEGACY_SAVED_VIEW_PREFIX, ""),
    source: "local" as const,
    value: key,
  }));
}

function controlSavedViewKey(id: string) {
  return `control:${id}`;
}

function controlSavedViewId(key: string) {
  return key.startsWith("control:") ? key.slice("control:".length) : "";
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

function initialActiveTab(initialTab: TabId) {
  if (typeof window === "undefined") return initialTab;
  const legacyPath = pathFromLegacyHash(window.location.hash);
  return legacyPath ? tabFromPath(legacyPath) as TabId : tabFromPath(window.location.pathname) as TabId;
}

export function DashboardShell({ initialTab = "runs" }: { initialTab?: TabId }) {
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
  const projectPreferenceLoadedRef = useRef(false);
  const userTouchedDashboardFiltersRef = useRef(false);
  const defaultSelectionInitializedRef = useRef(false);
  const runDirectoryRef = useRef<Map<string, RunSummary>>(new Map());
  const [activeTab, setActiveTab] = useState<TabId>(() => initialActiveTab(initialTab));
  const [dashboardAuthorized, setDashboardAuthorized] = useState(false);
  const [dashboardAuthMessage, setDashboardAuthMessage] = useState("Checking session...");
  const [sessionPayload, setSessionPayload] = useState<DashboardSessionPayload | null>(null);
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("created");
  const [metricKey, setMetricKey] = useState("eval/return_mean");
  const [metricFilter, setMetricFilter] = useState("");
  const [columnMetricFilter, setColumnMetricFilter] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [xMode, setXMode] = useState("step");
  const [smoothing, setSmoothing] = useState(0);
  const [groupAverage, setGroupAverage] = useState(false);
  const [diffOnly, setDiffOnly] = useState(false);
  const [referenceRunId, setReferenceRunId] = useState("");
  const [compareLayout, setCompareLayout] = useState<CompareLayout>("rows");
  const [compareRowSort, setCompareRowSort] = useState<CompareRowSort>("signal");
  const [compareRunSort, setCompareRunSort] = useState<CompareRunSort>("metric-best");
  const [compareSortMetricKey, setCompareSortMetricKey] = useState("eval/return_mean");
  const [compareTableMetrics, setCompareTableMetrics] = useState<string[]>([]);
  const [compareSearch, setCompareSearch] = useState("");
  const [compareConfigSortKey, setCompareConfigSortKey] = useState("");
  const [compareEditRunId, setCompareEditRunId] = useState("");
  const [runMetadataVersion, setRunMetadataVersion] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_SELECTED_RUNS);
  const [pageOffset, setPageOffset] = useState(0);
  const [pageCursorStack, setPageCursorStack] = useState<string[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [pageNavigationPending, setPageNavigationPending] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary>({ runs: [], metric_keys: [], total: 0 });
  const [overview, setOverview] = useState<Overview>({ total_runs: 0, active_runs: 0, failed_runs: 0, best_eval_return: null, metric_points: 0 });
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [selectedRunDetails, setSelectedRunDetails] = useState<Record<string, RunSummary>>({});
  const [primaryRunId, setPrimaryRunId] = useState("");
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [panelSeries, setPanelSeries] = useState<Record<string, MetricSeries[]>>({});
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loggedObjects, setLoggedObjects] = useState<LoggedObject[]>([]);
  const [objectRowsById, setObjectRowsById] = useState<Record<number, LoggedObjectRow[]>>({});
  const [runWorkspaceTab, setRunWorkspaceTab] = useState<RunWorkspaceTabId>("summary");
  const [compareArtifactsByRun, setCompareArtifactsByRun] = useState<Record<string, Artifact[]>>({});
  const [sideBySide, setSideBySide] = useState<any>(null);
  const [hover, setHover] = useState<HoverPoint>(null);
  const [hoverMetricKey, setHoverMetricKey] = useState(metricKey);
  const [message, setMessage] = useState("Loading runs...");
  const [loadingDetail, setLoadingDetail] = useState("Loading workspace");
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedViewOption[]>([]);
  const [savedViewKey, setSavedViewKey] = useState("");
  const [viewName, setViewName] = useState("");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [tableColumns, setTableColumns] = useState<TableColumns>(defaultTableColumns);
  const [pinnedMetrics, setPinnedMetrics] = useState<string[]>([]);
  const [navPinned, setNavPinned] = useState(false);
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
  const [runsRailCollapsed, setRunsRailCollapsed] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [quickSearchInput, setQuickSearchInput] = useState("");
  const [quickSearchActiveIndex, setQuickSearchActiveIndex] = useState(0);
  const [workspaceUndoStack, setWorkspaceUndoStack] = useState<WorkspaceView[]>([]);
  const [workspaceRedoStack, setWorkspaceRedoStack] = useState<WorkspaceView[]>([]);
  const [chartZoomRange, setChartZoomRange] = useState<ChartZoomRange>(null);
  const [primaryChartZoomRange, setPrimaryChartZoomRange] = useState<ChartZoomRange>(null);
  const [pinnedChartZoomRanges, setPinnedChartZoomRanges] = useState<Record<string, ChartZoomRange>>({});
  const [usagePayload, setUsagePayload] = useState<UsagePayload | null>(null);
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [apiKeyName, setApiKeyName] = useState("Dashboard SDK key");
  const [newApiKey, setNewApiKey] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);

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
    actualMetricOptions.length ? actualMetricOptions : ["eval/return_mean", "train/reward", "train/loss"]
  ), [actualMetricOptions]);
  const metricOptions = useMemo(() => filterMetricKeys(allMetricOptions, metricFilter), [allMetricOptions, metricFilter]);
  const metricFilterValid = useMemo(() => metricFilterIsRegex(metricFilter), [metricFilter]);
  const columnMetricOptions = useMemo(() => filterMetricKeys(allMetricOptions, columnMetricFilter), [allMetricOptions, columnMetricFilter]);
  const columnMetricFilterValid = useMemo(() => metricFilterIsRegex(columnMetricFilter), [columnMetricFilter]);
  const metricOptionsForControls = useMemo(() => boundedOptions(metricOptions, metricKey), [metricKey, metricOptions]);
  const columnMetricOptionsForControls = useMemo(() => boundedOptions(columnMetricOptions, "", 80), [columnMetricOptions]);

  const sortedRuns = summary.runs;
  const selectedRuns = useMemo(() => {
    // Remember every run we've ever seen so a selected run stays resolvable
    // after it scrolls off the current page. Without this, paginating drops
    // off-page selected runs from selectedRuns, which churns the workspace
    // series fetch and makes the chart reload even though the selection is
    // unchanged.
    const directory = runDirectoryRef.current;
    for (const run of sortedRuns) directory.set(run.id, run);
    for (const run of Object.values(selectedRunDetails)) directory.set(run.id, run);
    return selectedRunIds
      .map((id) => selectedRunDetails[id] ?? directory.get(id) ?? sortedRuns.find((run) => run.id === id))
      .filter(Boolean) as RunSummary[];
  }, [selectedRunDetails, selectedRunIds, sortedRuns]);
  const primaryRun = selectedRunDetails[primaryRunId] ?? sortedRuns.find((run) => run.id === primaryRunId) ?? selectedRuns[0] ?? sortedRuns[0] ?? null;
  const handleRunWorkspaceTabChange = useCallback((nextTab: RunWorkspaceTabId) => {
    setRunWorkspaceTab(nextTab);
  }, []);
  const selectedRunKey = selectedRunIds.join(",");
  const compareRunIds = useMemo(() => selectedRuns.map((run) => run.id).slice(0, COMPARE_RUN_LIMIT), [selectedRuns]);
  const compareRunKey = compareRunIds.join(",");
  const compareRuns = useMemo(() => (
    compareRunIds
      .map((id) => selectedRunDetails[id] ?? sortedRuns.find((run) => run.id === id))
      .filter(Boolean) as RunSummary[]
  ), [compareRunIds, selectedRunDetails, sortedRuns]);
  const compareOverflowCount = Math.max(0, selectedRuns.length - compareRunIds.length);
  const referenceRun = compareRuns.find((run) => run.id === referenceRunId) ?? compareRuns[0] ?? null;
  const compareEditRun = compareRuns.find((run) => run.id === compareEditRunId) ?? referenceRun ?? compareRuns[0] ?? null;
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
  const visibleArtifacts = useMemo(() => artifacts.slice(0, ARTIFACT_PAGE_LIMIT), [artifacts]);
  const currentMessageTone = messageTone(message);
  const seriesWithGroups = useMemo(() => series.map((item) => {
    const run = selectedRunDetails[item.id] ?? sortedRuns.find((candidate) => candidate.id === item.id);
    return { ...item, group: run ? groupKeyForRun(run, groupBy) : item.group ?? "all" };
  }), [groupBy, selectedRunDetails, series, sortedRuns]);

  const displaySeries = useMemo(() => {
    const grouped = groupAverage ? averageGroupedSeries(seriesWithGroups) : seriesWithGroups;
    return smoothSeries(grouped, smoothing);
  }, [groupAverage, seriesWithGroups, smoothing]);

  const fullDomain = useMemo(() => chartDomain(displaySeries, xMode, metricKey), [displaySeries, metricKey, xMode]);
  const rangeSeries = useMemo(() => normalizeSeries(displaySeries, chartWidth, chartHeight, chartPadding, xMode, metricKey), [displaySeries, metricKey, xMode]);
  const normalizedSeries = useMemo(() => normalizeSeries(displaySeries, chartWidth, chartHeight, chartPadding, xMode, metricKey, chartZoomRange), [chartZoomRange, displaySeries, metricKey, xMode]);
  const domain = useMemo(() => chartDomain(displaySeries, xMode, metricKey, chartZoomRange), [chartZoomRange, displaySeries, metricKey, xMode]);
  const chartSummaries = useMemo(() => chartSummary(displaySeries), [displaySeries]);
  const metricCatalogRows = useMemo(() => buildMetricCatalogRows(sortedRuns, metricOptions, selectedRunIds), [metricOptions, selectedRunIds, sortedRuns]);
  const visibleMetricCatalogRows = useMemo(() => metricCatalogRows.slice(0, MAX_METRIC_CATALOG_ROWS), [metricCatalogRows]);
  const activeMetricCatalogRow = useMemo(() => metricCatalogRows.find((row) => row.key === metricKey) ?? null, [metricCatalogRows, metricKey]);
  const primaryDisplaySeries = useMemo(() => {
    const found = seriesWithGroups.find((item) => item.id === primaryRun?.id);
    return found ? smoothSeries([found], smoothing) : [];
  }, [primaryRun?.id, seriesWithGroups, smoothing]);
  const primaryFullDomain = useMemo(() => chartDomain(primaryDisplaySeries, xMode, metricKey), [metricKey, primaryDisplaySeries, xMode]);
  const primaryRangeSeries = useMemo(() => normalizeSeries(primaryDisplaySeries, chartWidth, chartHeight, chartPadding, xMode, metricKey), [metricKey, primaryDisplaySeries, xMode]);
  const primaryNormalizedSeries = useMemo(() => normalizeSeries(primaryDisplaySeries, chartWidth, chartHeight, chartPadding, xMode, metricKey, primaryChartZoomRange), [metricKey, primaryChartZoomRange, primaryDisplaySeries, xMode]);
  const primaryDomain = useMemo(() => chartDomain(primaryDisplaySeries, xMode, metricKey, primaryChartZoomRange), [metricKey, primaryChartZoomRange, primaryDisplaySeries, xMode]);
  const pinnedChartPanels = useMemo(() => (
    pinnedMetrics
      .filter((metric) => metric && metric !== metricKey)
      .map((metric) => {
        const rawSeries = panelSeries[metric] ?? [];
        const groupedSeries = rawSeries.map((item) => {
          const run = selectedRunDetails[item.id] ?? sortedRuns.find((candidate) => candidate.id === item.id);
          return { ...item, group: run ? groupKeyForRun(run, groupBy) : item.group ?? "all" };
        });
        const preparedSeries = smoothSeries(groupAverage ? averageGroupedSeries(groupedSeries) : groupedSeries, smoothing);
        const zoomRange = pinnedChartZoomRanges[metric] ?? null;
        return {
          metric,
          series: preparedSeries,
          normalizedSeries: normalizeSeries(preparedSeries, chartWidth, chartHeight, chartPadding, xMode, metric, zoomRange),
          domain: chartDomain(preparedSeries, xMode, metric, zoomRange),
          fullDomain: chartDomain(preparedSeries, xMode, metric),
          rangeSeries: normalizeSeries(preparedSeries, chartWidth, chartHeight, chartPadding, xMode, metric),
          summaries: chartSummary(preparedSeries),
          zoomRange,
        };
      })
  ), [groupAverage, groupBy, metricKey, panelSeries, pinnedChartZoomRanges, pinnedMetrics, selectedRunDetails, smoothing, sortedRuns, xMode]);
  const inspectedPoint = hover;
  const alertRows = useMemo(() => buildAlertRows(sortedRuns, metricKey), [metricKey, sortedRuns]);
  const datasetRows = useMemo(() => buildDatasetRows(sortedRuns, metricKey), [metricKey, sortedRuns]);
  const artifactTotals = useMemo(() => artifactTotalsForRuns(sortedRuns), [sortedRuns]);
  const modelRows = useMemo(() => buildModelRows(primaryRun, visibleArtifacts), [primaryRun, visibleArtifacts]);
  const runMetricRows = useMemo(() => buildRunMetricRows(primaryRun), [primaryRun]);
  const runTimelineRows = useMemo(() => buildRunTimelineRows(primaryRun, visibleArtifacts, metricKey), [metricKey, primaryRun, visibleArtifacts]);
  const reportRows = useMemo(() => buildReportRows(savedViews), [savedViews]);
  const integrationRows = useMemo(() => buildIntegrationRows(), []);
  const apiRows = useMemo(() => buildApiRows(metricKey, project, status), [metricKey, project, status]);
  const activeOrgId = sessionPayload?.organization?.id ?? "";
  const activeUsageOrg = useMemo(() => usagePayload?.organizations?.find((org) => org.org_id === activeOrgId) ?? usagePayload?.organizations?.[0] ?? null, [activeOrgId, usagePayload]);
  const activeUsage = activeUsageOrg?.usage ?? {};
  const activeLimits = activeUsageOrg?.limits ?? {};
  const usageAvailable = Boolean(activeUsageOrg);
  const storageUsed = Number(activeUsage.storage_bytes_for_warnings ?? activeUsage.warehouse_storage_bytes_exact ?? activeUsage.estimated_storage_bytes_for_warnings ?? activeUsage.artifact_bytes_exact ?? 0);
  const storageLimit = Number(activeLimits.included_storage_bytes ?? 0);
  const storagePercent = storageLimit ? Math.min(100, Math.round((storageUsed / storageLimit) * 100)) : 0;
  const metricUsed = Number(activeUsage.metric_points ?? 0);
  const metricLimit = Number(activeLimits.metric_points ?? 0);
  const metricPercent = metricLimit ? Math.min(100, Math.round((metricUsed / metricLimit) * 100)) : 0;
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
    pageNavigationPendingRef.current = false;
    setPageNavigationPending(false);
    setPageCursorStack([]);
    setPageOffset(0);
  }, []);
  const changeProject = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setProject(value);
    if (projectPreferenceLoadedRef.current) {
      api.put("/api/dashboard/preferences", { selected_project: value || null }).catch(() => {
        // Project preference persistence should never block filtering.
      });
    }
  }, [api, resetRunPagination]);
  const changeStatus = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setStatus(value);
  }, [resetRunPagination]);
  const changeRunQueryInput = useCallback((value: string) => {
    userTouchedDashboardFiltersRef.current = true;
    resetRunPagination();
    setQueryInput(value);
  }, [resetRunPagination]);
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
  const workspacePanelMetrics = useMemo(() => workspaceMetricKeys(workspaceView, panelSearch), [panelSearch, workspaceView]);
  const workspacePanelMetricKey = useMemo(() => workspacePanelMetrics.join("\u0000"), [workspacePanelMetrics]);
  const availableWorkspaceMetrics = useMemo(() => allMetricOptions.slice(0, MAX_METRIC_OPTIONS), [allMetricOptions]);
  const maxWorkspacePanelRuns = useMemo(() => {
    const values = workspaceView.sections.flatMap((section) => section.panels.map((panel) => panel.settings?.maxRuns ?? section.settings?.maxRuns ?? workspaceView.settings.maxRuns));
    return Math.max(1, Math.min(25, ...values, workspaceView.settings.maxRuns));
  }, [workspaceView]);
  const workspacePanelRuns = useMemo(() => (
    selectedRuns.length ? selectedRuns.slice(0, MAX_SELECTED_RUNS) : sortedRuns
  ), [selectedRuns, sortedRuns]);
  const workspaceFetchRuns = useMemo(() => {
    if (selectedRuns.length) return selectedRuns.slice(0, MAX_SELECTED_RUNS);
    return sortedRuns.slice(0, maxWorkspacePanelRuns);
  }, [maxWorkspacePanelRuns, selectedRuns, sortedRuns]);
  const workspaceFetchRunKey = useMemo(() => workspaceFetchRuns.map((run) => run.id).join("\u0000"), [workspaceFetchRuns]);
  const editingPanelContext = useMemo(() => {
    if (!editingPanelRef) return null;
    const section = workspaceView.sections.find((item) => item.id === editingPanelRef.sectionId);
    const panel = section?.panels.find((item) => item.id === editingPanelRef.panelId);
    return section && panel ? { section, panel } : null;
  }, [editingPanelRef, workspaceView]);
  const fullscreenPanelContext = useMemo(() => {
    if (!fullscreenPanelRef) return null;
    const section = workspaceView.sections.find((item) => item.id === fullscreenPanelRef.sectionId);
    const panel = section?.panels.find((item) => item.id === fullscreenPanelRef.panelId);
    return section && panel ? { section, panel } : null;
  }, [fullscreenPanelRef, workspaceView]);
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
        description: `${run.project} · ${run.status} · ${(run.tags ?? []).join(" ")} · ${run.metadata?.notes ?? ""}`,
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
        description: view.source === "control" ? "Apply saved workspace view" : "Apply local saved view",
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

  const loadProjects = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    try {
      const projectPayload = await api.get("/projects", options);
      const names = (projectPayload.projects ?? []).map((item: { name: string }) => item.name);
      setProjects(names);
      if (!projectPreferenceLoadedRef.current) {
        projectPreferenceLoadedRef.current = true;
        try {
          const preferencePayload = await api.get("/api/dashboard/preferences", options);
          const selectedProject = preferencePayload?.preferences?.selected_project;
          if (typeof selectedProject === "string" && names.includes(selectedProject) && !userTouchedDashboardFiltersRef.current) {
            setProject((current) => current || selectedProject);
          }
        } catch (error) {
          if (!isAbortError(error)) {
            // Preferences are control-plane convenience state. Runs should still load if they fail.
            setSavedViews((current) => current.length ? current : localSavedViewOptions());
          }
        }
      }
    } catch (error) {
      if (!isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load projects.");
    }
  }, [api]);

  const loadSavedViews = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    const localOptions = localSavedViewOptions();
    try {
      const payload = await api.get("/api/workspace-views", options);
      const controlOptions = Array.isArray(payload?.workspace_views)
        ? (payload.workspace_views as WorkspaceViewSummaryPayload[]).map((view) => ({
          label: view.name,
          source: "control" as const,
          value: controlSavedViewKey(view.id),
        }))
        : [];
      setSavedViews([...controlOptions, ...localOptions]);
    } catch (error) {
      if (!isAbortError(error)) setSavedViews(localOptions);
    }
  }, [api]);

  const loadDashboard = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    const requestOptions = options && "signal" in options ? options : {};
    const requestId = dashboardRequestRef.current + 1;
    if (warehouseRetryTimerRef.current) {
      window.clearTimeout(warehouseRetryTimerRef.current);
      warehouseRetryTimerRef.current = null;
    }
    dashboardRequestRef.current = requestId;
    setDashboardLoading(true);
    setLoadingDetail("Loading runs");
    setMessage("Loading runs...");
    let keepLoadingScreen = false;
    try {
      const params = currentPageCursor
        ? { project, status, q: query, limit: pageSize, cursor: currentPageCursor, sort_by: sortBy, metric_key: metricKey }
        : { project, status, q: query, limit: pageSize, offset: pageOffset, sort_by: sortBy, metric_key: metricKey };
      const retryOptions = { signal: options.signal, delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS };
      const [overviewResult, summaryResult] = await Promise.allSettled([
        retryTransientRequest(() => api.get(`/api/overview${queryString({ project, status, q: query, metric_key: metricKey })}`, requestOptions), retryOptions),
        retryTransientRequest(() => api.get(`/api/runs/summary${queryString(params)}`, requestOptions), retryOptions),
      ]);
      if (requestId !== dashboardRequestRef.current) return;
      if (summaryResult.status === "rejected") throw summaryResult.reason;
      const summaryPayload = summaryResult.value;
      const nextSummary = summaryPayload as Summary;
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
      if (overviewResult.status === "rejected" && !isWarehouseStartingError(overviewResult.reason)) {
        setMessage("Runs loaded. Overview is still syncing.");
      } else {
        setMessage(runsPageMessage(nextSummary.total, pageOffset, nextSummary.runs.length));
      }
    } catch (error) {
      if (requestId === dashboardRequestRef.current && !isAbortError(error)) {
        const detail = error instanceof Error ? error.message : "Unable to load runs.";
        setMessage(detail);
        if (isWarehouseStartingError(error) && !options.signal?.aborted) {
          setLoadingDetail("Starting data warehouse");
          keepLoadingScreen = !initialLoadDone;
          warehouseRetryTimerRef.current = window.setTimeout(() => {
            warehouseRetryTimerRef.current = null;
            if (!options.signal?.aborted) void loadDashboard();
          }, WAREHOUSE_RETRY_MS);
        }
      }
    } finally {
      if (requestId === dashboardRequestRef.current) {
        setDashboardLoading(keepLoadingScreen);
        pageNavigationPendingRef.current = false;
        setPageNavigationPending(false);
        if (!keepLoadingScreen && !options.signal?.aborted) setInitialLoadDone(true);
      }
    }
  }, [api, currentPageCursor, initialLoadDone, metricKey, pageOffset, pageSize, project, query, sortBy, status]);

  useEffect(() => {
    const controller = new AbortController();
    async function checkSession() {
      try {
        const session = await api.get("/api/auth/session", { signal: controller.signal });
        if (session.authenticated) {
          setSessionPayload(session as DashboardSessionPayload);
          setDashboardAuthorized(true);
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
        setInitialLoadDone(true);
      }
    }
    checkSession();
    return () => controller.abort();
  }, [api]);

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/auth/logout", {});
      await clerk.signOut({ redirectUrl: "/signin" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to sign out.";
      setDashboardAuthMessage(detail);
      setMessage(detail);
    }
  }, [api, clerk]);

  useEffect(() => {
    if (!dashboardAuthorized) return;
    const controller = new AbortController();
    loadProjects({ signal: controller.signal });
    loadSavedViews({ signal: controller.signal });
    return () => controller.abort();
  }, [dashboardAuthorized, loadProjects, loadSavedViews]);

  useEffect(() => {
    if (!dashboardAuthorized) return;
    const controller = new AbortController();
    loadDashboard({ signal: controller.signal });
    return () => controller.abort();
  }, [dashboardAuthorized, loadDashboard]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

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
    };
  }, []);

  useEffect(() => {
    function applyRouteTab() {
      const legacyPath = pathFromLegacyHash(window.location.hash);
      if (legacyPath) {
        window.history.replaceState(null, "", legacyPath);
      } else {
        const canonicalPath = canonicalDashboardPath(window.location.pathname);
        if (window.location.pathname !== canonicalPath) window.history.replaceState(null, "", canonicalPath);
      }
      const nextTab = tabFromPath(window.location.pathname) as TabId;
      setActiveTab(nextTab);
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
    setSavedViews(localSavedViewOptions());
    setNavPinned(localStorage.getItem(NAV_PINNED_KEY) === "true");
    setRunsRailCollapsed(localStorage.getItem(RUNS_RAIL_COLLAPSED_KEY) === "true");
    const storedTheme = localStorage.getItem(THEME_KEY);
    const nextTheme = storedTheme === "dark" || storedTheme === "light"
      ? storedTheme
      : "dark";
    setTheme(nextTheme);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    workspaceViewRef.current = workspaceView;
  }, [workspaceView]);

  useEffect(() => {
    if (project && !summaryMatchesProject) {
      setWorkspaceReady(false);
      setWorkspaceSeries({});
      return;
    }
    const raw = safeSavedView(localStorage.getItem(workspaceStorageKey(project)));
    setWorkspaceView(sanitizeWorkspaceView(raw, actualMetricOptions, project));
    setWorkspaceReady(Boolean(raw) || actualMetricOptions.length > 0);
    setWorkspaceSeries({});
    setAddPanelSectionId("");
    setEditingPanelRef(null);
    setFullscreenPanelRef(null);
    setWorkspaceUndoStack([]);
    setWorkspaceRedoStack([]);
  }, [actualMetricOptions, actualMetricSignature, project, summaryMatchesProject]);

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
    localStorage.setItem(workspaceStorageKey(project), JSON.stringify({ ...workspaceView, updatedAt: new Date().toISOString() }));
  }, [project, workspaceReady, workspaceView]);

  useEffect(() => {
    localStorage.setItem(NAV_PINNED_KEY, String(navPinned));
  }, [navPinned]);

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

  useEffect(() => {
    let cancelled = false;
    const keepIds = [...new Set([...selectedRunIds, primaryRunId, referenceRunId].filter(Boolean))];
    const pageDetails = Object.fromEntries(sortedRuns.filter((run) => keepIds.includes(run.id)).map((run) => [run.id, run]));
    const missingIds = keepIds
      .filter((id) => !selectedRunDetails[id] && !pageDetails[id])
      .slice(0, COMPARE_RUN_LIMIT);
    if (!missingIds.length) {
      setSelectedRunDetails((current) => pruneRunDetails(current, pageDetails, {}, keepIds));
      return () => {
        cancelled = true;
      };
    };
    Promise.all(
      missingIds.map(async (id) => {
        try {
          const payload = await api.get(`/runs/${id}`);
          return payload.run as RunSummary;
        } catch {
          return null;
        }
      }),
    ).then((runs) => {
      if (cancelled) return;
      const found = runs.filter(Boolean) as RunSummary[];
      const fetchedDetails = Object.fromEntries(found.map((run) => [run.id, run]));
      const validIds = new Set([...selectedRunIds, ...Object.keys(pageDetails), ...Object.keys(fetchedDetails)]);
      setSelectedRunIds((current) => {
        const retained = current.filter((id) => validIds.has(id));
        if (retained.length) return retained;
        if (current.length) return current;
        const next = defaultRunSelection(current, sortedRuns, defaultSelectionInitializedRef.current);
        defaultSelectionInitializedRef.current = next.initialized;
        return next.ids;
      });
      setPrimaryRunId((current) => current && validIds.has(current) ? current : sortedRuns[0]?.id ?? "");
      setReferenceRunId((current) => current && validIds.has(current) ? current : "");
      setSelectedRunDetails((current) => pruneRunDetails(current, pageDetails, fetchedDetails, [...validIds]));
    });
    return () => {
      cancelled = true;
    };
  }, [api, primaryRunId, referenceRunId, selectedRunDetails, selectedRunIds, sortedRuns]);

  useEffect(() => {
    setRunWorkspaceTab("summary");
  }, [primaryRun?.id]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadMetricSeries() {
      const shouldLoad = activeTab === "metrics" || (activeTab === "detail" && runWorkspaceTab === "data");
      if (!shouldLoad || !metricKey || !selectedRuns.length) {
        setSeries([]);
        return;
      }
      setSeries([]);
      const metricPayloads = await fetchBatchedMetricSeries(api, metricKey, selectedRuns, controller.signal, (patch) => {
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
  }, [activeTab, api, metricKey, runWorkspaceTab, selectedRuns]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadPinnedMetricSeries() {
      const metricsToLoad = pinnedMetrics.filter((metric) => metric && metric !== metricKey);
      if (activeTab !== "metrics" || !metricsToLoad.length || !selectedRuns.length) {
        setPanelSeries({});
        return;
      }
      setPanelSeries({});
      const next = await fetchMetricSeriesForMetrics(api, metricsToLoad, selectedRuns, controller.signal, (metric, patch) => {
        if (!cancelled) setPanelSeries((current) => ({ ...current, [metric]: patch }));
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
  }, [activeTab, api, metricKey, pinnedMetrics, selectedRuns]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadWorkspaceSeries() {
      if (activeTab !== "runs" || !workspacePanelMetrics.length || !workspaceFetchRuns.length) {
        setWorkspaceSeries({});
        return;
      }
      setWorkspaceSeries({});
      const next = await fetchMetricSeriesForMetrics(api, workspacePanelMetrics, workspaceFetchRuns, controller.signal, (metric, patch) => {
        if (!cancelled) setWorkspaceSeries((current) => ({ ...current, [metric]: patch }));
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
  }, [activeTab, api, workspaceFetchRunKey, workspacePanelMetricKey]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadArtifacts() {
      const shouldLoad = (activeTab === "detail" && runWorkspaceTab === "files") || activeTab === "artifacts" || activeTab === "models";
      if (!shouldLoad || !primaryRun?.id) {
        setArtifacts([]);
        return;
      }
      try {
        const artifactPayload = await api.get(`/api/runs/${primaryRun.id}/artifacts${queryString({ limit: ARTIFACT_PAGE_LIMIT })}`, { signal: controller.signal });
        if (!cancelled) setArtifacts((artifactPayload.artifacts ?? []).slice(0, ARTIFACT_PAGE_LIMIT));
      } catch (error) {
        if (isAbortError(error)) return;
        if (isNotFoundError(error)) {
          if (!cancelled) setArtifacts([]);
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
  }, [activeTab, api, primaryRun?.id, runWorkspaceTab]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadLoggedObjects() {
      const shouldLoad = (activeTab === "detail" && runWorkspaceTab === "files") || activeTab === "artifacts";
      if (!shouldLoad || !primaryRun?.id) {
        setLoggedObjects([]);
        setObjectRowsById({});
        return;
      }
      setLoggedObjects([]);
      setObjectRowsById({});
      try {
        const payload = await api.get(`/api/runs/${primaryRun.id}/objects${queryString({ limit: 100 })}`, { signal: controller.signal });
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
      if (!((activeTab === "detail" && runWorkspaceTab === "files") || activeTab === "artifacts") || !tableObjectIds.length) {
        setObjectRowsById({});
        return;
      }
      const entries = await Promise.all(tableObjectIds.map(async (objectId) => {
        const payload = await api.get(`/api/objects/${objectId}/rows${queryString({ limit: 20 })}`, { signal: controller.signal });
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
    const runIds = [...compareRunIds];
    async function loadCompareArtifacts() {
      if (activeTab !== "compare" || !runIds.length) {
        setCompareArtifactsByRun({});
        return;
      }
      const next: Record<string, Artifact[]> = {};
      let cursor = 0;
      async function worker() {
        while (!cancelled && cursor < runIds.length) {
          const runId = runIds[cursor];
          cursor += 1;
          try {
            const artifactPayload = await api.get(`/api/runs/${runId}/artifacts${queryString({ limit: COMPARE_ARTIFACT_LIMIT })}`, { signal: controller.signal });
            next[runId] = (artifactPayload.artifacts ?? []).slice(0, COMPARE_ARTIFACT_LIMIT);
          } catch (error) {
            if (isAbortError(error)) throw error;
            next[runId] = [];
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, runIds.length) }, () => worker()));
      if (!cancelled && runIds.join(",") === compareRunKey) setCompareArtifactsByRun(next);
    }
    loadCompareArtifacts().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load compare artifacts.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, compareRunIds, compareRunKey]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadSideBySide() {
      if (activeTab !== "compare" || !compareRunIds.length) {
        setSideBySide(null);
        return;
      }
      const sidePayload = await api.get(`/api/runs/side-by-side${queryString({ run_ids: compareRunKey, reference_run_id: referenceRun?.id, diff_only: diffOnly })}`, { signal: controller.signal });
      if (!cancelled) setSideBySide(sidePayload);
    }
    loadSideBySide().catch((error) => {
      if (!cancelled && !isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load side-by-side comparison.");
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, api, compareRunIds.length, compareRunKey, diffOnly, referenceRun?.id, runMetadataVersion]);

  useEffect(() => {
    if (compareRuns.length && !compareRuns.some((run) => run.id === referenceRunId)) setReferenceRunId(compareRuns[0].id);
    if (!compareRuns.length && referenceRunId) setReferenceRunId("");
  }, [compareRuns, referenceRunId]);

  useEffect(() => {
    if (compareRuns.length && !compareRuns.some((run) => run.id === compareEditRunId)) setCompareEditRunId(referenceRun?.id ?? compareRuns[0].id);
    if (!compareRuns.length && compareEditRunId) setCompareEditRunId("");
  }, [compareEditRunId, compareRuns, referenceRun?.id]);

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

  const changeRunPageSize = useCallback((size: number) => {
    setPageSize(size);
    resetRunPagination();
  }, [resetRunPagination]);

  const loadUsage = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (!activeOrgId) return;
    try {
      const usage = await api.get("/api/usage", options);
      setUsagePayload(usage as UsagePayload);
    } catch (error) {
      if (!isAbortError(error)) setUsagePayload(null);
    }
  }, [activeOrgId, api]);

  const loadOrgSettings = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (!activeOrgId) return;
    try {
      const [usage, seatPayload] = await Promise.all([
        api.get("/api/usage", options),
        api.get(`/api/orgs/${activeOrgId}/seats`, options),
      ]);
      setUsagePayload(usage as UsagePayload);
      setSeats(Array.isArray(seatPayload.seats) ? seatPayload.seats as SeatRow[] : []);
    } catch (error) {
      if (!isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load workspace settings.");
    }
  }, [activeOrgId, api]);

  useEffect(() => {
    if (!dashboardAuthorized || !activeOrgId) return;
    const controller = new AbortController();
    void loadUsage({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, dashboardAuthorized, loadUsage]);

  const loadApiKeys = useCallback(async (options: { signal?: AbortSignal } = {}) => {
    if (!activeOrgId) return;
    try {
      const payload = await api.get(`/api/orgs/${activeOrgId}/api-keys`, options);
      setApiKeys(Array.isArray(payload.api_keys) ? payload.api_keys as ApiKeyRow[] : []);
    } catch (error) {
      if (!isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to load API keys.");
    }
  }, [activeOrgId, api]);

  useEffect(() => {
    if (!dashboardAuthorized || activeTab !== "settings" || !activeOrgId) return;
    const controller = new AbortController();
    void loadOrgSettings({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, activeTab, dashboardAuthorized, loadOrgSettings]);

  useEffect(() => {
    if (!dashboardAuthorized || activeTab !== "api" || !activeOrgId) return;
    const controller = new AbortController();
    void loadApiKeys({ signal: controller.signal });
    return () => controller.abort();
  }, [activeOrgId, activeTab, dashboardAuthorized, loadApiKeys]);

  async function inviteSeat() {
    if (!activeOrgId || !inviteEmail.trim()) return;
    setAdminBusy(true);
    setMessage("Reserving seat...");
    try {
      await api.post(`/api/orgs/${activeOrgId}/seats`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteEmail("");
      await loadOrgSettings();
      setMessage("Seat reserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reserve seat.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function createDashboardApiKey() {
    if (!activeOrgId) return;
    setAdminBusy(true);
    setNewApiKey("");
    setMessage("Creating API key...");
    try {
      const payload = await api.post(`/api/orgs/${activeOrgId}/api-keys`, {
        name: apiKeyName.trim() || "Dashboard SDK key",
      });
      if (typeof payload.api_key === "string") setNewApiKey(payload.api_key);
      await loadApiKeys();
      setMessage("API key created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create API key.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function revokeDashboardApiKey(keyId: string) {
    if (!activeOrgId || !keyId) return;
    setAdminBusy(true);
    setMessage("Revoking API key...");
    try {
      await api.post(`/api/orgs/${activeOrgId}/api-keys/${keyId}/revoke`, {});
      await loadApiKeys();
      setMessage("API key revoked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to revoke API key.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function copyNewApiKey() {
    if (!newApiKey) return;
    await navigator.clipboard?.writeText(newApiKey);
    setMessage("API key copied.");
  }

  async function saveView() {
    const fallbackName = `${project || "all"}:${metricKey || "metric"}`;
    const name = (viewName.trim() || fallbackName).replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 64);
    setViewName(name);
    setMessage("Saving view...");
    const payload = {
      project,
      status,
      query: queryInput,
      sortBy,
      metricKey,
      metricFilter,
      groupBy,
      xMode,
      smoothing,
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
        const withoutSame = current.filter((item) => item.value !== option.value && item.label !== option.label);
        return [option, ...withoutSame];
      });
      setSavedViewKey(option.value);
    };
    try {
      const existingControlId = controlSavedViewId(savedViewKey);
      const response = existingControlId
        ? await api.put(`/api/workspace-views/${existingControlId}`, { name, project: project || null, payload })
        : await api.post("/api/workspace-views", { name, project: project || null, payload });
      const id = response?.workspace_view?.id;
      if (typeof id === "string") {
        upsertOption({ label: name, source: "control", value: controlSavedViewKey(id) });
        await loadSavedViews();
      }
    } catch (error) {
      const key = `${SAVED_VIEW_PREFIX}${name}`;
      localStorage.setItem(key, JSON.stringify(payload));
      upsertOption({ label: name, source: "local", value: key });
    }
    setMessage("Saved view.");
  }

  async function applySavedView(key: string) {
    setSavedViewKey(key);
    if (!key) return;
    applyingSavedViewRef.current = true;
    userTouchedDashboardFiltersRef.current = true;
    let view: Record<string, any> | null = null;
    let resolvedName = key.replace(SAVED_VIEW_PREFIX, "").replace(LEGACY_SAVED_VIEW_PREFIX, "");
    const controlId = controlSavedViewId(key);
    if (controlId) {
      try {
        const payload = await api.get(`/api/workspace-views/${controlId}`);
        view = payload?.workspace_view?.payload && typeof payload.workspace_view.payload === "object"
          ? payload.workspace_view.payload
          : null;
        resolvedName = payload?.workspace_view?.name ?? resolvedName;
      } catch {
        view = null;
      }
    } else {
      view = safeSavedView(localStorage.getItem(key));
    }
    if (!view) {
      applyingSavedViewRef.current = false;
      setMessage("Saved view could not be applied.");
      return;
    }
    setProject(view.project ?? "");
    setStatus(view.status ?? "");
    setQueryInput(typeof view.query === "string" ? view.query : "");
    setQuery(typeof view.query === "string" ? view.query : "");
    setSortBy(view.sortBy ?? "created");
    setMetricKey(view.metricKey ?? "eval/return_mean");
    setMetricFilter(view.metricFilter ?? "");
    setGroupBy(view.groupBy ?? "");
    setXMode(view.xMode ?? "step");
    setSmoothing(view.smoothing ?? 0);
    setGroupAverage(Boolean(view.groupAverage));
    setDiffOnly(Boolean(view.diffOnly));
    setCompareLayout(compareLayouts.has(view.compareLayout) ? (view.compareLayout === "auto" ? "rows" : view.compareLayout) : "rows");
    setCompareRowSort(compareRowSorts.has(view.compareRowSort) ? view.compareRowSort : "signal");
    setCompareRunSort(compareRunSorts.has(view.compareRunSort) ? view.compareRunSort : "metric-best");
    setCompareSortMetricKey(typeof view.compareSortMetricKey === "string" ? view.compareSortMetricKey : view.metricKey ?? "eval/return_mean");
    setCompareTableMetrics(Array.isArray(view.compareTableMetrics) ? view.compareTableMetrics.filter((item: unknown): item is string => typeof item === "string").slice(0, Math.max(0, MAX_COMPARE_TABLE_METRICS - 1)) : []);
    setCompareSearch(typeof view.compareSearch === "string" ? view.compareSearch : "");
    setCompareConfigSortKey(typeof view.compareConfigSortKey === "string" ? view.compareConfigSortKey : "");
    setSelectedRunIds(Array.isArray(view.selectedRunIds) ? view.selectedRunIds.filter((item: unknown): item is string => typeof item === "string").slice(0, MAX_SELECTED_RUNS) : []);
    setSelectedRunDetails({});
    setPrimaryRunId(view.primaryRunId ?? "");
    setReferenceRunId(view.referenceRunId ?? "");
    setTableColumns({ ...defaultTableColumns, ...(typeof view.tableColumns === "object" && !Array.isArray(view.tableColumns) ? view.tableColumns : {}) });
    setPinnedMetrics(Array.isArray(view.pinnedMetrics) ? view.pinnedMetrics.slice(0, 4) : []);
    if (view.workspaceView) {
      const nextWorkspace = sanitizeWorkspaceView(view.workspaceView, allMetricOptions, view.project ?? project);
      workspaceViewRef.current = nextWorkspace;
      localStorage.setItem(workspaceStorageKey(view.project ?? project), JSON.stringify(nextWorkspace));
      setWorkspaceView(nextWorkspace);
    }
    setPageSize([10, 25, 50, 100].includes(view.pageSize) ? view.pageSize : 25);
    setPageCursorStack([]);
    setPageOffset(0);
    window.setTimeout(() => {
      applyingSavedViewRef.current = false;
    }, 0);
    setViewName(view.viewName ?? resolvedName);
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
    userTouchedDashboardFiltersRef.current = true;
    setSelectAllMatchingBusy(true);
    setMessage(`Selecting up to ${MAX_SELECTED_RUNS} runs matching the current filter...`);
    try {
      const pageLimit = Math.min(1000, MAX_SELECTED_RUNS);
      const matchingRuns: RunSummary[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let total = 0;
      while (matchingRuns.length < MAX_SELECTED_RUNS) {
        const params = {
          project,
          status,
          q: query,
          limit: Math.min(pageLimit, MAX_SELECTED_RUNS - matchingRuns.length),
          offset,
          projection: "selection",
          sort_by: sortBy,
          metric_key: metricKey,
        };
        const payload = await retryTransientRequest(
          () => api.get(`/api/runs/summary${queryString(params)}`),
          { delays: DASHBOARD_REQUEST_RETRY_DELAYS_MS },
        );
        const pageRuns = Array.isArray(payload?.runs) ? payload.runs as RunSummary[] : [];
        total = Number.isFinite(Number(payload?.total)) ? Number(payload.total) : Math.max(total, offset + pageRuns.length);
        for (const run of pageRuns) {
          if (!run?.id || seen.has(run.id)) continue;
          matchingRuns.push(run);
          seen.add(run.id);
          if (matchingRuns.length >= MAX_SELECTED_RUNS) break;
        }
        offset += pageRuns.length;
        if (!pageRuns.length || !payload?.page_info?.has_next_page || offset >= total) break;
      }
      const ids = capSelectionToMatching(matchingRuns.map((run) => run.id).filter(Boolean));
      setSelectedRunDetails((current) => {
        const next = { ...current };
        for (const run of matchingRuns) if (run?.id) next[run.id] = run;
        return next;
      });
      setSelectedRunIds(ids);
      if (ids.length) selectionAnchorRunIdRef.current = ids[0];
      setMessage(`${ids.length} runs selected (filter matched ${total || ids.length}).`);
    } catch (error) {
      if (!isAbortError(error)) setMessage(error instanceof Error ? error.message : "Unable to select matching runs.");
    } finally {
      setSelectAllMatchingBusy(false);
    }
  }

  async function updateRunTagsAndNotes(runId: string, patch: { tags: string[]; notes: string }) {
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

  function clearFilters() {
    setProject("");
    setStatus("");
    setQueryInput("");
    setQuery("");
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

  function commitWorkspace(mutator: (current: WorkspaceView) => WorkspaceView, nextMessage = "Workspace autosaved. Undo available.") {
    const previous = workspaceViewRef.current ?? workspaceView;
    const next = { ...mutator(previous), updatedAt: new Date().toISOString() };
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
    updateWorkspace((current) => ({
      ...current,
      mode: current.mode === "manual" ? "manual" : current.mode,
      sections: current.sections.map((section) => section.id === sectionId
        ? { ...section, panels: [...section.panels, { ...workspacePanelForMetric(panelMetric, type), id: `panel-${stableId(`${type}-${panelMetric}`)}-${Date.now().toString(36)}` }] }
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
            ? { ...panel, layout: sanitizePanelLayout(layout) }
            : panel),
        }
        : section),
    }), "Panel size saved. Undo available.");
  }

  function updateEditingPanel(patch: { title?: string; type?: WorkspacePanelType; metricKey?: string; settings?: Partial<WorkspacePanelSettings> }) {
    if (!editingPanelRef) return;
    updateWorkspace((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === editingPanelRef.sectionId
        ? {
          ...section,
          panels: section.panels.map((panel) => panel.id === editingPanelRef.panelId
            ? {
              ...panel,
              type: patch.type ?? panel.type,
              title: patch.title ?? panel.title,
              metricKey: patch.metricKey ?? panel.metricKey,
              settings: patch.settings ? { ...(panel.settings ?? {}), ...patch.settings } : panel.settings,
            }
            : panel),
        }
        : section),
    }));
  }

  function setWorkspaceMode(mode: "automatic" | "manual") {
    commitWorkspace(() => mode === "automatic" ? buildAutomaticWorkspace(allMetricOptions, project) : buildManualWorkspace(project), `Workspace switched to ${mode} mode. Undo available.`);
    setAddPanelSectionId("");
  }

  function resetWorkspaceLayout() {
    commitWorkspace(() => buildAutomaticWorkspace(allMetricOptions, project), "Workspace layout reset. Undo available.");
    setPanelSearch("");
  }

  function closeTransientSurfaces() {
    setAddPanelSectionId("");
    setEditingPanelRef(null);
    setFullscreenPanelRef(null);
    setColumnsOpen(false);
  }

  function focusRouteStatus() {
    window.setTimeout(() => document.getElementById("status-message")?.focus({ preventScroll: true }), 0);
  }

  function selectTab(tabId: TabId) {
    const label = tabs.find((tab) => tab.id === tabId)?.label ?? tabId;
    closeTransientSurfaces();
    setActiveTab(tabId);
    setMobileNavOpen(false);
    setMessage(tabId === "runs" && summary.total ? runsPageMessage(summary.total, pageOffset, sortedRuns.length) : `Opened ${label}.`);
    window.history.replaceState(null, "", tabToPath(tabId));
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
    item.onSelect();
    setQuickSearchOpen(false);
    setQuickSearchInput("");
    setMessage(item.group === "View" ? "Saved view applied." : `Opened ${item.label}.`);
  }

  function dismissTopOverlay() {
    if (quickSearchOpen) {
      setQuickSearchOpen(false);
      return true;
    }
    if (shortcutHelpOpen) {
      setShortcutHelpOpen(false);
      return true;
    }
    if (fullscreenPanelRef) {
      setFullscreenPanelRef(null);
      return true;
    }
    if (editingPanelRef) {
      setEditingPanelRef(null);
      return true;
    }
    if (addPanelSectionId) {
      setAddPanelSectionId("");
      return true;
    }
    if (columnsOpen) {
      setColumnsOpen(false);
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

  function handleChartMove(event: MouseEvent<SVGSVGElement>) {
    handleChartMoveFor(event, normalizedSeries, metricKey);
  }

  function handleChartMoveFor(event: MouseEvent<SVGSVGElement>, chartSeries: any[], chartMetricKey: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, chartWidth, chartHeight);
    pendingHoverRef.current = { chartMetricKey, chartSeries, x: point.x, y: point.y };
    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const pending = pendingHoverRef.current;
      if (!pending) return;
      const nextHover = nearestPoint(pending.chartSeries, pending.x, pending.y, 10000) as HoverPoint;
      setHover(nextHover);
      if (nextHover) setHoverMetricKey(pending.chartMetricKey);
    });
  }

  useEffect(() => {
    function handleGlobalKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && dismissTopOverlay()) {
        event.preventDefault();
        return;
      }
      if (quickSearchOpen || shortcutHelpOpen) return;
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
      }
    }
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  });

  const activeTabIcon = tabs.find((tab) => tab.id === activeTab)?.icon ?? Activity;
  const ActiveIcon = activeTabIcon;

  if (!initialLoadDone) return <AppLoadingScreen detail={loadingDetail} />;
  if (!dashboardAuthorized) {
    return (
      <main className="auth-page" aria-busy="false">
        <section className="auth-card">
          <p className="eyebrow">Session</p>
          <h1>Sign in required</h1>
          <p>{dashboardAuthMessage}</p>
          <a className="button-link" href={`/signin?next=${encodeURIComponent("/dashboard/runs")}`}>Open sign in</a>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <DashboardTopbar
        activeIcon={ActiveIcon}
        activeTab={activeTab}
        detailRunName={primaryRun?.name ?? ""}
        message={message}
        mobileNavOpen={mobileNavOpen}
        onApplySavedView={applySavedView}
        onMobileMenuToggle={() => setMobileNavOpen((open) => !open)}
        onProject={changeProject}
        onQuery={changeRunQueryInput}
        onQuickSearch={() => setQuickSearchOpen(true)}
        onRefresh={loadDashboard}
        onSaveView={saveView}
        onSelectTab={selectTab}
        onSignOut={signOut}
        onShortcutHelp={openShortcutHelp}
        onSortBy={changeRunSort}
        onStatus={changeStatus}
        onThemeToggle={() => setTheme((current) => current === "dark" ? "light" : "dark")}
        onViewName={setViewName}
        metricUsagePercent={metricPercent}
        planLabel={activePlan}
        project={project}
        projects={projects}
        query={queryInput}
        savedViewKey={savedViewKey}
        savedViews={savedViews}
        sortBy={sortBy}
        status={status}
        storageUsagePercent={storagePercent}
        theme={theme}
        tone={currentMessageTone}
        usageAvailable={usageAvailable}
        usageResetLabel={usageResetLabel}
        viewName={viewName}
      />

      {isMobile && mobileNavOpen ? (
        <div
          className="mobile-nav-scrim"
          aria-hidden="true"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      <section className={`shell ${navPinned ? "nav-pinned" : ""} ${navAutoOpen ? "nav-auto-open" : ""} ${mobileNavOpen ? "mobile-nav-open" : ""}`}>
        <DashboardNav
          activeTab={activeTab}
          onAutoOpenChange={setNavAutoOpen}
          onPinnedChange={setNavPinned}
          onSelect={selectTab}
          onShortcutHelp={() => { setMobileNavOpen(false); openShortcutHelp(); }}
          onSignOut={signOut}
          onThemeToggle={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          pinned={navPinned}
          theme={theme}
        />

        <section className={`tab-pane ${activeTab === "runs" ? "active" : ""}`} aria-label="Runs">
          {activeTab === "runs" ? (
            <>
          <PageHead
            eyebrow="Workspace"
            title="Runs"
            emphasis="in flight"
            lede={`${project || "All projects"} · ${metricKey}`}
          />
          <div className="runs-workspace-filter">
            <Stats overview={overview} metricKey={metricKey} />
            <RunsCommandbar
              columnsOpen={columnsOpen}
              metricKey={metricKey}
              metricOptions={metricOptionsForControls}
              onColumnsOpen={setColumnsOpen}
              onMetricKey={changeMetricKey}
              onPinnedMetricFilter={setColumnMetricFilter}
              onPinnedMetric={togglePinnedMetric}
              onRefresh={loadDashboard}
              onTableColumns={setTableColumns}
              pinnedMetricFilter={columnMetricFilter}
              pinnedMetricFilterValid={columnMetricFilterValid}
              pinnedMetricOptions={columnMetricOptionsForControls}
              pinnedMetrics={pinnedMetrics}
              tableColumns={tableColumns}
            />
          </div>
          <RunsWorkspace
            addPanelSectionId={addPanelSectionId}
            availableMetricKeys={availableWorkspaceMetrics}
            onAddPanel={addWorkspacePanel}
            onAddSection={addWorkspaceSection}
            onClearFilters={clearFilters}
            onColumnsOpen={setColumnsOpen}
            onDuplicatePanel={duplicateWorkspacePanel}
            onEditPanel={(sectionId, panelId) => setEditingPanelRef({ sectionId, panelId })}
            onFullscreenPanel={(sectionId, panelId) => setFullscreenPanelRef({ sectionId, panelId })}
            onInspectRun={setPrimaryRunId}
            onOpenRun={(id) => { setPrimaryRunId(id); selectTab("detail"); }}
            onMode={setWorkspaceMode}
            onMovePanel={moveWorkspacePanel}
            onPanelSearch={setPanelSearch}
            onRefresh={loadDashboard}
            onRemovePanel={removeWorkspacePanel}
            onResetWorkspace={resetWorkspaceLayout}
            onResizePanel={resizeWorkspacePanel}
            onRunRailCollapsed={(collapsed) => {
              setRunsRailCollapsed(collapsed);
              setMessage(collapsed ? "Runs selector collapsed." : "Runs selector restored.");
            }}
            onSelectAllMatching={selectAllMatchingRuns}
            onSelectAllVisible={selectAllVisibleRuns}
            onSetAddPanelSection={setAddPanelSectionId}
            onTableColumns={setTableColumns}
            onToggleRun={toggleRun}
            onToggleSection={toggleWorkspaceSection}
            selectAllMatchingBusy={selectAllMatchingBusy}
            hasNextPage={hasNextPage}
            hasPreviousPage={hasPreviousPage}
            onNextPage={goToNextRunPage}
            onPageSize={changeRunPageSize}
            onPreviousPage={goToPreviousRunPage}
            paginationBusy={paginationBusy}
            pageEnd={pageEnd}
            pageSize={pageSize}
            pageStart={pageStart}
            panelSearch={panelSearch}
            runSearch={queryInput}
            runRailCollapsed={runsRailCollapsed}
            selectedRunIds={selectedRunIds}
            showAddPanelDrawer={Boolean(addPanelSectionId)}
            summaryTotal={summary.total}
            tableColumns={tableColumns}
            view={workspaceView}
            workspacePanelRuns={workspacePanelRuns}
            workspaceRuns={sortedRuns}
            workspaceSeries={workspaceSeries}
          />
          {editingPanelContext ? (
            <PanelEditDrawer
              metricOptions={allMetricOptions}
              onClose={() => setEditingPanelRef(null)}
              onUpdate={updateEditingPanel}
              panel={editingPanelContext.panel}
              section={editingPanelContext.section}
              view={workspaceView}
            />
          ) : null}
          {fullscreenPanelContext ? (
            <div className="workspace-modal fullscreen-modal" role="dialog" aria-modal="true" aria-label={`${fullscreenPanelContext.panel.title} fullscreen`} ref={fullscreenModalRef} tabIndex={-1}>
              <div className="workspace-modal-card fullscreen-modal-card">
                <div className="drawer-head">
                  <div className="fullscreen-title-block">
                    <h2>{fullscreenPanelContext.panel.title}</h2>
                    <span>{fullscreenPanelContext.panel.metricKey ?? "Metric"} · {fullscreenPanelContext.section.name} · {fullscreenPanelIndex + 1} of {fullscreenPanelOrder.length}</span>
                  </div>
                  <div className="fullscreen-nav-actions">
                    <button
                      aria-label="Previous fullscreen panel"
                      className="icon-button"
                      disabled={fullscreenPanelIndex <= 0}
                      onClick={() => moveFullscreenPanel(-1)}
                      title="Previous panel"
                      type="button"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      aria-label="Next fullscreen panel"
                      className="icon-button"
                      disabled={fullscreenPanelIndex < 0 || fullscreenPanelIndex >= fullscreenPanelOrder.length - 1}
                      onClick={() => moveFullscreenPanel(1)}
                      title="Next panel"
                      type="button"
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button className="icon-button" type="button" aria-label="Close fullscreen panel" onClick={() => setFullscreenPanelRef(null)}><X size={16} /></button>
                  </div>
                </div>
                <WorkspacePanelCard
                  className="fullscreen-panel-card"
                  panel={fullscreenPanelContext.panel}
                  section={fullscreenPanelContext.section}
                  selectedRunIds={selectedRunIds}
                  view={workspaceView}
                  workspacePanelRuns={workspacePanelRuns}
                  workspaceSeries={workspaceSeries}
                />
              </div>
            </div>
          ) : null}
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "metrics" ? "active" : ""}`} aria-label="Metrics">
          {activeTab === "metrics" ? (
            <>
          <div className="analysis-page metrics-analysis">
            <header className="analysis-header">
              <div className="analysis-title-block">
                <span className="analysis-eyebrow eyebrow--accent">Metrics</span>
                <h2>{metricTitle(metricKey)} <span className="serif-em">over time</span></h2>
                <p>
                  {activeMetricCatalogRow
                    ? `${activeMetricCatalogRow.selectedCount}/${activeMetricCatalogRow.runCount} selected runs · ${formatNumber(activeMetricCatalogRow.pointCount, 0)} points · ${metricGoalLabel(metricKey)} objective`
                    : `${selectedRuns.length || sortedRuns.length} runs in scope · ${metricGoalLabel(metricKey)} objective`}
                </p>
              </div>
              <div className="analysis-stat-strip">
                <div className="analysis-stat"><span>Available</span><strong>{formatNumber(metricCatalogRows.length, 0)}</strong></div>
                <div className="analysis-stat"><span>Pinned</span><strong>{formatNumber(pinnedMetrics.length, 0)}</strong></div>
                <div className="analysis-stat"><span>Series</span><strong>{formatNumber(chartSummaries.length, 0)}</strong></div>
              </div>
            </header>
            <div className="metrics-grid metrics-workbench">
              <section className="panel analysis-card metric-catalog-panel">
                <div className="panel-head"><h2>Metric Catalog <span>({visibleMetricCatalogRows.length}/{metricCatalogRows.length})</span></h2></div>
                <div className="panel-body">
                  <MetricCatalog activeMetric={metricKey} rows={visibleMetricCatalogRows} pinnedMetrics={pinnedMetrics} onMetricKey={changeMetricKey} onPinnedMetric={togglePinnedMetric} />
                </div>
              </section>
              <section className="chart-card analysis-card metrics-chart-surface">
                <div className="analysis-toolbar chart-analysis-toolbar">
                  <ChartControls
                    metricFilter={metricFilter}
                    metricFilterValid={metricFilterValid}
                    metricKey={metricKey}
                    metricOptions={metricOptionsForControls}
                    groupBy={groupBy}
                    xMode={xMode}
                    smoothing={smoothing}
                    groupAverage={groupAverage}
                    pinnedMetrics={pinnedMetrics}
                    onMetricFilter={setMetricFilter}
                    onMetricKey={changeMetricKey}
                    onGroupBy={setGroupBy}
                    onXMode={setXMode}
                    onSmoothing={setSmoothing}
                    onGroupAverage={setGroupAverage}
                    onPinnedMetric={togglePinnedMetric}
                  />
                </div>
                <MetricChart
                  domain={domain}
                  fullDomain={fullDomain}
                  hover={hover}
                  metricKey={metricKey}
                  normalizedSeries={normalizedSeries}
                  onMove={handleChartMove}
                  onPointHover={(point) => {
                    setHoverMetricKey(metricKey);
                    setHover(point);
                  }}
                  onLeave={() => setHover(null)}
                  onZoomRangeChange={setChartZoomRange}
                  rangeSeries={rangeSeries}
                  xMode={xMode}
                  zoomRange={chartZoomRange}
                />
                {pinnedChartPanels.length ? (
                  <div className="pinned-chart-grid">
                    {pinnedChartPanels.map((panel) => (
                      <article className="metric-panel" key={panel.metric}>
                        <div className="metric-panel-head">
                          <h3>{metricTitle(panel.metric)}</h3>
                          <button className="icon-button" type="button" aria-label={`Unpin ${panel.metric}`} onClick={() => togglePinnedMetric(panel.metric)}><X size={14} /></button>
                        </div>
                        <MetricChart
                          domain={panel.domain}
                          fullDomain={panel.fullDomain}
                          hover={hover}
                          metricKey={panel.metric}
                          normalizedSeries={panel.normalizedSeries}
                          onMove={(event) => handleChartMoveFor(event, panel.normalizedSeries, panel.metric)}
                          onPointHover={(point) => {
                            setHoverMetricKey(panel.metric);
                            setHover(point);
                          }}
                          onLeave={() => setHover(null)}
                          onZoomRangeChange={(range) => {
                            setPinnedChartZoomRanges((current) => ({ ...current, [panel.metric]: range }));
                          }}
                          rangeSeries={panel.rangeSeries}
                          xMode={xMode}
                          zoomRange={panel.zoomRange}
                        />
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
              <section className="panel analysis-card metric-insights-panel">
                <div className="panel-head"><h2>Signal Context</h2></div>
                <div className="panel-body">
                  <HoverDetail hover={inspectedPoint} metricKey={hover ? hoverMetricKey : metricKey} />
                  <MetricLeaderboard metricKey={metricKey} runs={selectedRuns.length ? selectedRuns : sortedRuns} />
                  <SeriesSummary summaries={chartSummaries} />
                </div>
              </section>
            </div>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "detail" ? "active" : ""}`} aria-label="Run Detail">
          {activeTab === "detail" ? (
            <>
          <div className="analysis-page detail-analysis">
            <RunWorkspace
              activeMetricKey={metricKey}
              api={api}
              artifacts={visibleArtifacts}
              chartDomain={primaryDomain}
              chartFullDomain={primaryFullDomain}
              chartHover={hover}
              chartNormalizedSeries={primaryNormalizedSeries}
              chartRangeSeries={primaryRangeSeries}
              chartZoomRange={primaryChartZoomRange}
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
              elementId="run-detail"
              hover={inspectedPoint}
              loggedObjects={loggedObjects}
              metricRows={runMetricRows}
              objectRowsById={objectRowsById}
              onChartLeave={() => setHover(null)}
              onChartMove={(event) => handleChartMoveFor(event, primaryNormalizedSeries, metricKey)}
              onChartPointHover={(point) => {
                setHoverMetricKey(metricKey);
                setHover(point);
              }}
              onChartZoomRangeChange={setPrimaryChartZoomRange}
              onRunMetadataSave={updateRunTagsAndNotes}
              onWorkspaceTabChange={handleRunWorkspaceTabChange}
              run={primaryRun}
              selectedCount={selectedRuns.length}
              selectedRuns={selectedRuns}
              tab={runWorkspaceTab}
              timelineRows={runTimelineRows}
              xMode={xMode}
            />
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "compare" ? "active" : ""}`} aria-label="Compare">
          {activeTab === "compare" ? (
            <>
          <div className="analysis-page compare-analysis">
            <section className="panel analysis-card compare-shell">
              <header className="analysis-header compare-analysis-header">
                <div className="analysis-title-block">
                  <span className="analysis-eyebrow eyebrow--accent">Compare</span>
                  <h2>{compareRunIds.length}{compareOverflowCount ? `/${selectedRunIds.length}` : ""} runs <span className="serif-em">side by side</span></h2>
                  <p>{metricKey} · {metricGoalLabel(metricKey)} objective · row-first evidence scan</p>
                </div>
                <div className="analysis-stat-strip">
                  <div className="analysis-stat"><span>Reference</span><strong title={referenceRun?.name}>{referenceRun?.name ?? "-"}</strong></div>
                  <div className="analysis-stat"><span>Cap</span><strong>{COMPARE_RUN_LIMIT}</strong></div>
                  <div className="analysis-stat"><span>Mode</span><strong>{compareLayout === "columns" ? "Columns" : "Rows"}</strong></div>
                </div>
                {compareOverflowCount ? <span className="compare-limit-note">First {COMPARE_RUN_LIMIT} selected runs are compared; {compareOverflowCount} remain selected outside Compare.</span> : null}
              </header>
              <div className="analysis-toolbar compare-toolbar">
                <label className="control compare-search-control">
                  Search
                  <input id="compare-search" placeholder="runs, evidence, tags, notes, artifacts" value={compareSearch} onChange={(event) => setCompareSearch(event.target.value)} />
                </label>
                <CustomSelect
                  id="reference-run"
                  label="Reference"
                  onChange={setReferenceRunId}
                  options={compareRuns.length ? compareRuns.map((run) => ({ value: run.id, label: run.name })) : [{ value: "", label: "No selected runs", disabled: true }]}
                  value={referenceRun?.id ?? ""}
                />
                <CustomSelect
                  id="compare-metric"
                  label="Metric"
	                  onChange={(value) => {
	                    changeMetricKey(value);
	                    setCompareSortMetricKey(value);
	                  }}
                  options={metricOptionsForControls.length ? metricOptionsForControls.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
                  value={metricOptionsForControls.length ? metricKey : ""}
                />
                <CustomSelect
                  disabled={!compareAddMetricOptions.length || compareTableMetricKeys.length >= MAX_COMPARE_TABLE_METRICS}
                  id="compare-add-metric"
                  label="Add metric"
                  onChange={addCompareTableMetric}
                  options={compareAddMetricOptions.length && compareTableMetricKeys.length < MAX_COMPARE_TABLE_METRICS
                    ? [{ value: "", label: "Add metric", disabled: true }, ...compareAddMetricOptions.map((metric) => ({ value: metric, label: metric }))]
                    : [{ value: "", label: "All metrics added", disabled: true }]}
                  value=""
                />
                <CustomSelect
                  id="compare-layout"
                  label="Layout"
                  onChange={(value) => setCompareLayout(value === "columns" ? "columns" : "rows")}
                  options={[
                    { value: "rows", label: "Runs as rows" },
                    { value: "columns", label: "Runs as columns" },
                  ]}
                  value={compareLayout === "columns" ? "columns" : "rows"}
                />
                <CustomSelect
                  id="compare-row-sort"
                  label="Evidence"
                  onChange={(value) => setCompareRowSort(compareRowSorts.has(value as CompareRowSort) ? value as CompareRowSort : "signal")}
                  options={[
                    { value: "signal", label: "Signal" },
                    { value: "changed", label: "Changed first" },
                    { value: "missing", label: "Missing first" },
                    { value: "category", label: "Category" },
                    { value: "name", label: "Name" },
                    { value: "spread", label: "Numeric spread" },
                  ]}
                  value={compareRowSort}
                />
                <CustomSelect
                  id="compare-run-sort"
                  label="Runs"
                  onChange={(value) => setCompareRunSort(compareRunSorts.has(value as CompareRunSort) ? value as CompareRunSort : "metric-best")}
                  options={[
                    { value: "metric-best", label: "Metric best" },
                    { value: "metric-latest", label: "Metric latest" },
                    { value: "selected", label: "Selected order" },
                    { value: "name", label: "Name" },
                    { value: "newest", label: "Newest" },
                    { value: "status", label: "Status" },
                    { value: "duration", label: "Duration" },
                    { value: "artifacts", label: "Artifacts" },
                    { value: "tags", label: "Tags" },
                    { value: "notes", label: "Notes" },
                    { value: "config", label: "Config key" },
                  ]}
                  value={compareRunSort}
                />
                <CustomSelect
                  disabled={!compareConfigKeys.length}
                  id="compare-config-key"
                  label="Config"
                  onChange={setCompareConfigSortKey}
                  options={compareConfigKeys.length ? compareConfigKeys.map((key) => ({ value: key, label: key })) : [{ value: "", label: "No config keys", disabled: true }]}
                  value={compareConfigKeys.length ? compareConfigSortKey : ""}
                />
                <label className="control checkbox-control">
                  Diff only
                  <input id="diff-only" type="checkbox" checked={diffOnly} onChange={(event) => setDiffOnly(event.target.checked)} />
                </label>
              </div>
              <div className="compare-metric-strip" aria-label="Compare table metric columns">
                <span>Metric columns</span>
                {compareTableMetricKeys.map((metric) => (
                  <div className={`compare-metric-pill ${compareSortMetricKey === metric ? "active" : ""}`} key={metric}>
                    <button
                      aria-label={`Sort compared runs by ${metric}`}
                      className="compare-metric-label"
                      onClick={() => {
                        setCompareSortMetricKey(metric);
                        setCompareRunSort("metric-best");
                      }}
                      title={metric}
                      type="button"
                    >
                      {metricTitle(metric)}
                    </button>
                    {metric !== metricKey ? (
                      <button aria-label={`Remove ${metric} column`} className="compare-metric-remove" onClick={() => removeCompareTableMetric(metric)} title="Remove metric column" type="button">
                        <X size={12} />
                      </button>
                    ) : null}
                  </div>
                ))}
                <div className="compare-metric-strip-actions">
                  <button
                    className="compare-metric-action"
                    disabled={!compareAddMetricOptions.length || compareTableMetricKeys.length >= MAX_COMPARE_TABLE_METRICS}
                    onClick={addAllCompareTableMetrics}
                    title={`Add up to ${MAX_COMPARE_TABLE_METRICS} metric columns`}
                    type="button"
                  >
                    <Plus size={12} /> Add all
                  </button>
                  <button
                    className="compare-metric-action"
                    disabled={compareTableMetricKeys.length <= 1}
                    onClick={resetCompareTableMetrics}
                    title="Reset to the primary metric column"
                    type="button"
                  >
                    Reset
                  </button>
                </div>
              </div>
              <SideBySide
                artifactsByRun={compareArtifactsByRun}
                configSortKey={compareConfigSortKey}
                diffOnly={diffOnly}
                layout={compareLayout}
                metricKey={metricKey}
                onOpenRunArtifacts={(runId) => {
                  setPrimaryRunId(runId);
                  selectTab("artifacts");
                }}
                onRunSort={setCompareRunSort}
                onRunSortMetricKey={setCompareSortMetricKey}
                payload={sideBySide}
                referenceRunId={referenceRun?.id ?? ""}
                rowSort={compareRowSort}
                runSort={compareRunSort}
                runSortMetricKey={compareSortMetricKey}
                search={compareSearch}
                tableMetrics={compareTableMetricKeys}
              />
              {compareRuns.length ? (
                <details className="compare-annotation-details">
                  <summary>
                    <span>Annotate compared run</span>
                    <strong title={compareEditRun?.name}>{compareEditRun?.name ?? "-"}</strong>
                  </summary>
                  <div className="compare-metadata-editor">
                    <CustomSelect
                      id="compare-edit-run"
                      label="Annotate"
                      onChange={setCompareEditRunId}
                      options={compareRuns.map((run) => ({ value: run.id, label: run.name }))}
                      value={compareEditRun?.id ?? ""}
                    />
                    <RunMetadataEditor compact onSave={updateRunTagsAndNotes} run={compareEditRun} title="Tags and notes" />
                  </div>
                </details>
              ) : null}
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "alerts" ? "active" : ""}`} aria-label="Alerts">
          {activeTab === "alerts" ? (
            <>
          <PageHead eyebrow="Workspace" title="Alerts" emphasis="worth watching" lede={`${alertRows.length} active · run health`} />
          <div className="tab-grid two-col">
            <section className="panel">
              <div className="panel-head">
                <h2><AlertTriangle size={15} /> Alerts <span>({alertRows.length})</span></h2>
                <button className="icon-button framed" type="button" aria-label="Refresh alerts" onClick={() => loadDashboard()}><RefreshCw size={16} /></button>
              </div>
              <div className="panel-body">
                <AlertList rows={alertRows} />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><ShieldCheck size={15} /> Run Health</h2></div>
              <div className="panel-body insight-stack">
                <MetricCard label="Failed runs" value={formatNumber(overview.failed_runs, 0)} tone={overview.failed_runs ? "bad" : "good"} />
                <MetricCard label="Active runs" value={formatNumber(overview.active_runs, 0)} tone={overview.active_runs ? "live" : "neutral"} />
                <MetricCard label="Metric points" value={formatNumber(overview.metric_points, 0)} tone="neutral" />
                <MetricCard label={`${metricGoalLabel(metricKey)} ${shortMetricName(metricKey)}`} value={formatNumber(overview.best_eval_return, 2)} tone="good" />
              </div>
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "datasets" ? "active" : ""}`} aria-label="Datasets">
          {activeTab === "datasets" ? (
            <>
          <PageHead eyebrow="Workspace" title="Datasets" emphasis="in scope" lede={`config-derived · ${datasetRows.length} keys`} />
          <div className="tab-grid two-col">
            <section className="panel">
              <div className="panel-head"><h2><Database size={15} /> Config-derived Datasets <span>({datasetRows.length})</span></h2></div>
              <div className="panel-body">
                <DatasetTable rows={datasetRows} metricKey={metricKey} />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Gauge size={15} /> Coverage</h2></div>
              <div className="panel-body insight-stack">
                <MetricCard label="Projects" value={formatNumber(projects.length, 0)} tone="neutral" />
                <MetricCard label="Runs in view" value={formatNumber(sortedRuns.length, 0)} tone="neutral" />
                <MetricCard label="Dataset keys" value={formatNumber(datasetRows.length, 0)} tone={datasetRows.length ? "good" : "neutral"} />
              </div>
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "artifacts" ? "active" : ""}`} aria-label="Artifacts">
          {activeTab === "artifacts" ? (
            <>
          <PageHead eyebrow="Workspace" title="Artifacts" emphasis="and lineage" lede={`${visibleArtifacts.length} for ${primaryRun?.name ?? "inspected run"}`} />
          <div className="tab-grid two-col">
            <section className="panel">
              <div className="panel-head"><h2><Package size={15} /> Selected-run Artifacts <span>({visibleArtifacts.length})</span></h2></div>
              <div className="panel-body">
                <RichObjectPanel objects={loggedObjects} rowsByObjectId={objectRowsById} title="Logged Objects" />
                <ArtifactBrowser artifacts={visibleArtifacts} />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Archive size={15} /> Artifact Totals</h2></div>
              <div className="panel-body insight-stack">
                <MetricCard label="Files" value={formatNumber(artifactTotals.file, 0)} tone="neutral" />
                <MetricCard label="Checkpoints" value={formatNumber(artifactTotals.checkpoint, 0)} tone="good" />
                <MetricCard label="Rollouts" value={formatNumber(artifactTotals.rollout, 0)} tone="live" />
                <MetricCard label="Inspected run" value={primaryRun?.name ?? "-"} tone="neutral" />
              </div>
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "models" ? "active" : ""}`} aria-label="Models">
          {activeTab === "models" ? (
            <>
          <PageHead eyebrow="Workspace" title="Checkpoints" emphasis="and lineage" lede={`${modelRows.length} tracked · ${primaryRun?.name ?? "no run"}`} />
          <div className="tab-grid two-col">
            <section className="panel">
              <div className="panel-head"><h2><Box size={15} /> Checkpoint Lineage <span>({modelRows.length})</span></h2></div>
              <div className="panel-body">
                <ModelLineage rows={modelRows} />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Layers3 size={15} /> Model Context</h2></div>
              <div className="panel-body"><ModelContext run={primaryRun} /></div>
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "reports" ? "active" : ""}`} aria-label="Reports">
          {activeTab === "reports" ? (
            <>
          <PageHead eyebrow="Workspace" title="Saved views" emphasis="on tap" lede={`${reportRows.length} local · ${shortMetricName(metricKey)}`} />
          <div className="tab-grid two-col">
            <section className="panel">
              <div className="panel-head"><h2><FileBarChart size={15} /> Local Saved Views <span>({reportRows.length})</span></h2></div>
              <div className="panel-body">
                <ReportList rows={reportRows} />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Activity size={15} /> Snapshot</h2></div>
              <div className="panel-body insight-stack">
                <MetricCard label="Runs" value={formatNumber(summary.total, 0)} tone="neutral" />
                <MetricCard label="Selected" value={formatNumber(selectedRunIds.length, 0)} tone="live" />
                <MetricCard label="Metric" value={shortMetricName(metricKey)} tone="neutral" />
                <MetricCard label={`${metricGoalLabel(metricKey)} return`} value={formatNumber(overview.best_eval_return, 2)} tone="good" />
              </div>
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "settings" ? "active" : ""}`} aria-label="Settings">
          {activeTab === "settings" ? (
            <>
          <PageHead eyebrow="Admin" title="Workspace" emphasis="settings" lede={`${activePlan} · usage · seats`} />
          <div className="tab-grid settings-grid">
            <section className="panel">
              <div className="panel-head"><h2><Gauge size={15} /> Plan Usage</h2><button className="ghost" disabled={adminBusy} onClick={() => loadOrgSettings()} type="button"><RefreshCw size={14} /> Refresh</button></div>
              <div className="panel-body insight-stack">
                <MetricCard label="Plan" value={activePlan} tone="good" />
                <MetricCard label="Seats" value={`${formatNumber(Number(activeUsage.seats ?? seats.length), 0)} / ${formatNumber(Number(activeLimits.included_seats ?? sessionPayload?.organization?.seat_limit ?? 0), 0)}`} tone="neutral" />
                <MetricCard label="Warehouse data" value={`${formatBytes(storageUsed)} / ${storageLimit ? formatBytes(storageLimit) : "-"}`} tone={storagePercent > 90 ? "bad" : storagePercent > 70 ? "live" : "neutral"} />
                <div className="usage-meter" aria-label="Warehouse data usage">
                  <span style={{ width: `${storagePercent}%` }} />
                </div>
                <MetricCard label="Metric points this month" value={`${formatNumber(metricUsed, 0)} / ${metricLimit ? formatNumber(metricLimit, 0) : "-"}`} tone={metricPercent > 90 ? "bad" : metricPercent > 70 ? "live" : "neutral"} />
                <div className="usage-meter" aria-label="Metric point usage">
                  <span style={{ width: `${metricPercent}%` }} />
                </div>
                <SettingRow label="Metric reset" value={usageResetLabel ? `${usageResetLabel} UTC` : "-"} />
                {(activeUsageOrg?.warnings ?? []).length ? (
                  <div className="admin-alert-list">
                    {(activeUsageOrg?.warnings ?? []).map((warning, index) => (
                      <div className="api-row" key={`${warning.code ?? "warning"}-${index}`}>
                        <AlertTriangle size={14} />
                        <strong>{warning.message ?? warning.code ?? "Usage warning"}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><UserPlus size={15} /> Seats</h2></div>
              <div className="panel-body admin-stack">
                <div className="admin-form-row">
                  <input aria-label="Invite email" onChange={(event) => setInviteEmail(event.target.value)} placeholder="teammate@example.com" type="email" value={inviteEmail} />
                  <CustomSelect
                    id="seat-role"
                    label="Role"
                    onChange={setInviteRole}
                    options={[
                      { value: "member", label: "Member" },
                      { value: "admin", label: "Admin" },
                      { value: "viewer", label: "Viewer" },
                    ]}
                    value={inviteRole}
                  />
                  <button className="primary-button" disabled={adminBusy || !inviteEmail.trim()} onClick={inviteSeat} type="button"><UserPlus size={14} /> Invite</button>
                </div>
                <div className="admin-list">
                  {seats.map((seat) => (
                    <div className="api-row" key={seat.membership.id}>
                      <span>{seat.membership.status}</span>
                      <strong>{seat.user.primary_email}</strong>
                      <code>{seat.membership.role}</code>
                    </div>
                  ))}
                  {!seats.length ? <p className="empty">No seats loaded.</p> : null}
                </div>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Settings size={15} /> Workspace</h2></div>
              <div className="panel-body settings-list">
                <SettingRow label="Organization" value={sessionPayload?.organization?.name ?? "Workspace"} />
                <SettingRow label="Plan tier" value={activeUsageOrg?.plan_tier ?? sessionPayload?.organization?.plan_tier ?? "free"} />
                <SettingRow label="Project filter" value={project || "All projects"} />
                <SettingRow label="Status filter" value={status || "All statuses"} />
                <SettingRow label="Selected runs" value={formatNumber(selectedRunIds.length, 0)} />
                <SettingRow label="API route mode" value="Same-origin proxy" />
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Gauge size={15} /> Defaults</h2></div>
              <div className="panel-body settings-list">
                <CustomSelect
                  className="full"
                  disabled={!metricOptionsForControls.length}
                  id="settings-metric-select"
                  label="Default metric"
                  onChange={setMetricKey}
                  options={metricOptionsForControls.length ? metricOptionsForControls.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
                  value={metricOptionsForControls.length ? metricKey : ""}
                />
                <CustomSelect
                  className="full"
                  id="settings-x-mode"
                  label="X axis"
                  onChange={setXMode}
                  options={[
                    { value: "step", label: "Step" },
                    { value: "time", label: "Logged time" },
                  ]}
                  value={xMode}
                />
                <SettingRow label="Summary row limit" value="100" />
                <SettingRow label="Metric point limit" value="1,000 per selected run" />
              </div>
            </section>
          </div>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "integrations" ? "active" : ""}`} aria-label="Integrations">
          {activeTab === "integrations" ? (
            <>
          <PageHead eyebrow="Admin" title="Integrations" emphasis="and imports" lede="SDK · API · migration paths" />
          <section className="panel">
            <div className="panel-head"><h2><Plug size={15} /> Integrations</h2></div>
            <div className="panel-body integration-grid">
              {integrationRows.map((item) => <IntegrationCard item={item} key={item.name} />)}
            </div>
          </section>
            </>
          ) : null}
        </section>

        <section className={`tab-pane ${activeTab === "api" ? "active" : ""}`} aria-label="API">
          {activeTab === "api" ? (
            <>
          <PageHead eyebrow="Admin" title="API" emphasis="keys" lede={`${apiKeys.filter((key) => !key.revoked_at).length} active · documented REST routes`} />
          <div className="tab-grid two-col">
            <section className="panel">
              <div className="panel-head"><h2><KeyRound size={15} /> API Keys</h2><button className="ghost" disabled={adminBusy} onClick={() => loadApiKeys()} type="button"><RefreshCw size={14} /> Refresh</button></div>
              <div className="panel-body admin-stack">
                <div className="admin-form-row">
                  <input aria-label="API key name" onChange={(event) => setApiKeyName(event.target.value)} value={apiKeyName} />
                  <button className="primary-button" disabled={adminBusy || !activeOrgId} onClick={createDashboardApiKey} type="button"><Plus size={14} /> Create</button>
                </div>
                {newApiKey ? (
                  <div className="api-key-reveal" role="status" aria-live="polite">
                    <strong>Copy-once API key</strong>
                    <code>{newApiKey}</code>
                    <button className="secondary" onClick={copyNewApiKey} type="button"><Copy size={14} /> Copy</button>
                  </div>
                ) : null}
                <div className="admin-list">
                  {apiKeys.map((key) => (
                    <div className={`api-row ${key.revoked_at ? "muted" : ""}`} key={key.id}>
                      <span>{key.revoked_at ? "Revoked" : "Active"}</span>
                      <strong>{key.name}</strong>
                      <code>{key.key_prefix}</code>
                      <button className="ghost" disabled={adminBusy || Boolean(key.revoked_at)} onClick={() => revokeDashboardApiKey(key.id)} type="button" aria-label={`Revoke ${key.name}`}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {!apiKeys.length ? <p className="empty">No API keys loaded.</p> : null}
                </div>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2><Code2 size={15} /> API Surface</h2></div>
              <div className="panel-body">
                <ApiTable rows={apiRows} />
                <pre>{JSON.stringify({ org_id: activeOrgId || null, project: project || null, status: status || null, metric_key: metricKey, inspected_run_id: primaryRun?.id ?? null, selected_run_ids: selectedRunIds }, null, 2)}</pre>
              </div>
            </section>
          </div>
            </>
          ) : null}
        </section>
      </section>
      {quickSearchOpen ? (
        <QuickSearchModal
          activeIndex={quickSearchActiveIndex}
          items={filteredQuickSearchItems}
          onActiveIndex={setQuickSearchActiveIndex}
          onClose={() => setQuickSearchOpen(false)}
          onQuery={setQuickSearchInput}
          onSelect={selectQuickSearchItem}
          query={quickSearchInput}
        />
      ) : null}
      {shortcutHelpOpen ? (
        <ShortcutHelpModal
          commands={shortcutCommands}
          modifierLabel={modifierLabel}
          onClose={() => setShortcutHelpOpen(false)}
        />
      ) : null}
    </main>
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

function formatUsageResetLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
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
  const payload = await retryMetricSeriesRequest(
    () => api.post(
      `/api/metrics/series`,
      { key: metricKey, run_ids: runIds, limit: adaptiveMetricSeriesLimit(runs.length) },
      { signal },
    ),
    signal,
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

async function retryMetricSeriesRequest<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= METRIC_SERIES_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (isAbortError(error) || signal.aborted || !isTransientMetricSeriesError(error) || attempt === METRIC_SERIES_RETRY_DELAYS_MS.length) {
        throw error;
      }
      lastError = error;
      await sleepWithAbort(METRIC_SERIES_RETRY_DELAYS_MS[attempt], signal);
    }
  }
  throw lastError;
}

function isTransientMetricSeriesError(error: unknown) {
  if (error instanceof ApiError) return error.status === 429 || error.status === 408 || error.status >= 500;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /fetch failed|network|timeout|timed out|etimedout|econnreset|server is unavailable/i.test(message);
}

function sleepWithAbort(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
