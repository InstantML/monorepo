"use client";

import { Activity, ChevronDown, CircleStop, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { chartColor, stableChartIndex } from "../../../src/chart-colors.js";
import { categoricalFieldLabel, fieldLabel } from "../../../src/dashboard-panels.js";
import { BULK_SELECT_MATCHING_LIMIT, canRequestStop, displayStatusForRun, uploadHealthForRun, visibleSelectionState } from "../../../src/state.js";
import { WORKSPACE_PANEL_TYPES, metricTitle, runConfigSummary, runRailTooltip, shortMetricName, workspacePanelTypeLabel } from "../../dashboard-models";
import { CustomSelect } from "../ui/select";
import { Skeleton, SkeletonChartLines } from "../ui/skeleton";
import { useFocusTrap } from "../ui/use-focus-trap";
import { WorkspaceSectionView } from "./workspace-panel-card";
import type { HistogramTimelineState, MetricSeries, RunSummary, WorkspacePanelType, WorkspaceView } from "../../dashboard-types";

type DraggedWorkspacePanel = {
  panelId: string;
  sectionId: string;
};

function compactRailRunName(name: string) {
  if (name.length <= 30) return name;
  const seedMatch = name.match(/^(.*?)-seed-(.+)$/);
  if (seedMatch) return `${seedMatch[1].slice(0, 18)}...seed-${seedMatch[2]}`;
  return `${name.slice(0, 18)}...${name.slice(-10)}`;
}

function compactRailConfigValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    if (absolute > 0 && absolute < 0.01) return value.toExponential(0).replace("e-0", "e-").replace("e+", "e");
    if (absolute >= 1000) return Math.round(value).toLocaleString("en-US");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  return String(value);
}

function compactRailConfigSummary(run: RunSummary) {
  const config = run.config ?? {};
  const keys = ["learning_rate", "lr", "batch_size", "seed", "optimizer", "model"];
  const parts = keys
    .filter((key) => config[key] !== undefined && config[key] !== null && config[key] !== "")
    .slice(0, 2)
    .map((key) => `${key.replace("learning_rate", "lr")} ${compactRailConfigValue(config[key])}`);
  return parts.length ? parts.join(" · ") : "no config";
}

function compactRailMetricValue(value: number) {
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 0.001) return value.toExponential(2).replace("e-0", "e-").replace("e+", "e");
  if (absolute >= 100000) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(value);
}

function runStatusClass(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "stopping" || normalized === "stopped" || normalized === "killed") return "warn";
  if (normalized === "finished" || normalized === "completed" || normalized === "succeeded") return "finished";
  return "neutral";
}

// The run rail is draggable wider than its 270px floor so long names, configs,
// and tags can read in full; the width persists across visits.
const RAIL_MIN_WIDTH = 270;
const RAIL_MAX_WIDTH = 600;
const RAIL_WIDTH_STORAGE_KEY = "instantml:next:runs-rail-width";

type RunRailTip = { text: string; rect: DOMRect };

// A styled hover card for a rail run, portalled to <body> and pinned just to the
// right of the rail so it never overlaps the row it describes (the native title
// tooltip it replaces sat on top of the card and could not be styled). It shows
// the full untruncated name, every tag, and the note — the bits the bounded row
// has to abbreviate.
function RunRailTooltip({ tip }: { tip: RunRailTip | null }) {
  if (!tip || typeof document === "undefined") return null;
  const [name, ...details] = tip.text.split("\n");
  const margin = 10;
  const width = 280;
  const { rect } = tip;
  let left = rect.right + margin;
  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, rect.left - width - margin);
  }
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - 180));
  return createPortal(
    <div className="run-rail-tooltip" role="tooltip" style={{ left, top, maxWidth: width }}>
      <strong>{name}</strong>
      {details.map((line, index) => <span key={index}>{line}</span>)}
    </div>,
    document.body,
  );
}

function preferredHistogramObjectKey(metricKeys: string[]) {
  return metricKeys.find((key) => /histogram|distribution|score/i.test(key)) ?? metricKeys[0] ?? "";
}

function readDraggedPanel(event: DragEvent<HTMLElement>): DraggedWorkspacePanel | null {
  try {
    const raw = event.dataTransfer.getData("application/x-instantml-panel");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraggedWorkspacePanel>;
    return typeof parsed.sectionId === "string" && typeof parsed.panelId === "string"
      ? { sectionId: parsed.sectionId, panelId: parsed.panelId }
      : null;
  } catch {
    return null;
  }
}

function panelMatchesSearch(section: { name: string }, panel: { title: string; metricKey: string; type: string; xField?: string; yField?: string; valueField?: string; groupField?: string; replicateField?: string; objectKey?: string }, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const scatterFields = panel.type === "scatter" ? `${fieldLabel(panel.xField)} ${fieldLabel(panel.yField)}` : "";
  const distributionFields = panel.type === "distribution" ? `${fieldLabel(panel.valueField)} ${panel.groupField ? categoricalFieldLabel(panel.groupField) : ""} ${panel.replicateField ? categoricalFieldLabel(panel.replicateField) : ""}` : "";
  const objectFields = panel.type === "histogram_timeline" ? panel.objectKey : "";
  return `${section.name} ${panel.title} ${panel.metricKey} ${workspacePanelTypeLabel(panel.type as WorkspacePanelType)} ${scatterFields} ${distributionFields} ${objectFields}`.toLowerCase().includes(needle);
}

export function RunsWorkspace({
  addPanelSectionId,
  availableMetricKeys,
  canControlRuns,
  onAddPanel,
  onAddSection,
  onClearFilters,
  onDuplicatePanel,
  onEditPanel,
  onFullscreenPanel,
  onInspectRun,
  onOpenRun,
  onMovePanel,
  onPanelSearch,
  onRefresh,
  onRemovePanel,
  onRequestStop,
  onResetWorkspace,
  onResizePanel,
  onPanelSmoothing,
  onRunRailCollapsed,
  onSetAddPanelSection,
  onClearSelection,
  onSelectAllMatching,
  onSelectAllVisible,
  onToggleRun,
  onToggleSection,
  metricKey,
  hasNextPage,
  hasPreviousPage,
  initialLoadDone,
  onGoToPage,
  onNextPage,
  onPageSize,
  onPreviousPage,
  paginationBusy,
  pageEnd,
  pageSize,
  pageStart,
  panelSearch,
  runRailCollapsed,
  selectAllMatchingBusy,
  selectAllMatchingDisabled,
  selectedRunIds,
  showAddPanelDrawer,
  summaryTotal,
  view,
  workspacePanelRuns,
  workspaceRuns,
  workspaceSeries,
  workspaceHistogramTimelines,
}: {
  addPanelSectionId: string;
  availableMetricKeys: string[];
  canControlRuns: boolean;
  onAddPanel: (sectionId: string, metricKey: string, type: WorkspacePanelType) => void;
  onAddSection: () => void;
  onClearFilters: () => void;
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onInspectRun: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onMovePanel: (sourceSectionId: string, panelId: string, targetSectionId: string, targetIndex: number) => void;
  onPanelSearch: (value: string) => void;
  onRefresh: () => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onRequestStop: (runIds: string[]) => void;
  onResetWorkspace: () => void;
  onResizePanel: (sectionId: string, panelId: string, layout: import("../../dashboard-types").WorkspacePanelLayout) => void;
  onPanelSmoothing: (sectionId: string, panelId: string, smoothing: number) => void;
  onRunRailCollapsed: (collapsed: boolean) => void;
  onClearSelection: () => void;
  onSelectAllMatching: () => void;
  onSelectAllVisible: () => void;
  onSetAddPanelSection: (sectionId: string) => void;
  onToggleRun: (runId: string, options?: { shift?: boolean }) => void;
  onToggleSection: (sectionId: string) => void;
  metricKey: string;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  initialLoadDone: boolean;
  onGoToPage: (page: number) => void;
  onNextPage: () => void;
  onPageSize: (size: number) => void;
  onPreviousPage: () => void;
  paginationBusy: boolean;
  pageEnd: number;
  pageSize: number;
  pageStart: number;
  panelSearch: string;
  runRailCollapsed: boolean;
  selectAllMatchingBusy: boolean;
  selectAllMatchingDisabled: boolean;
  selectedRunIds: string[];
  showAddPanelDrawer: boolean;
  summaryTotal: number;
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
  workspaceHistogramTimelines: Record<string, HistogramTimelineState>;
}) {
  const hiddenPanelCount = view.sections.reduce((sum, section) => sum + section.panels.filter((panel) => !panelMatchesSearch(section, panel, panelSearch)).length, 0);
  const addDrawerRef = useFocusTrap<HTMLElement>(
    showAddPanelDrawer,
    () => onSetAddPanelSection(""),
    "input[aria-label='Histogram object key to add'], .drawer-metric-row:not([disabled]), .quick-add-card:not([disabled]), button[aria-label='Close add panels']",
    "[data-add-panel-trigger='true']",
  );
  const [draggedPanel, setDraggedPanel] = useState<DraggedWorkspacePanel | null>(null);
  // R6 cross-highlight: hovering a rail run isolates its series in every line
  // panel; hovering a chart series lights up the matching rail run.
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null);
  const [railTip, setRailTip] = useState<RunRailTip | null>(null);
  const [railWidth, setRailWidth] = useState(RAIL_MIN_WIDTH);
  const [addPanelType, setAddPanelType] = useState<WorkspacePanelType>("line");
  const [addHistogramObjectKey, setAddHistogramObjectKey] = useState("");
  const [bulkPromptEnabled, setBulkPromptEnabled] = useState(false);
  const draggedPanelRef = useRef<DraggedWorkspacePanel | null>(null);
  const pointerDragCleanupRef = useRef<() => void>(() => {});
  const activeAddSectionId = addPanelSectionId || view.sections[0]?.id || "";
  const histogramObjectKey = addHistogramObjectKey.trim();
  const canQuickAddPanel = addPanelType === "histogram_timeline" ? Boolean(histogramObjectKey) : Boolean(availableMetricKeys.length);
  useEffect(() => () => {
    pointerDragCleanupRef.current();
  }, []);
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(saved) && saved > RAIL_MIN_WIDTH) {
        setRailWidth(Math.min(RAIL_MAX_WIDTH, Math.round(saved)));
      }
    } catch {
      // localStorage can be unavailable (privacy mode); fall back to the default.
    }
  }, []);
  function persistRailWidth(width: number) {
    try {
      window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Ignore storage failures — the width still applies for this session.
    }
  }
  function handleRailResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth;
    const target = event.currentTarget;
    let nextWidth = startWidth;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events in tests may not support capture.
    }
    function handleMove(moveEvent: globalThis.PointerEvent) {
      nextWidth = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, startWidth + (moveEvent.clientX - startX)));
      setRailWidth(nextWidth);
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      try {
        if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      } catch {
        // The handle may have unmounted mid-drag.
      }
      persistRailWidth(nextWidth);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }
  function handleRailResizeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    setRailWidth((current) => {
      const next = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, current + step));
      persistRailWidth(next);
      return next;
    });
  }
  function resetRailWidth() {
    setRailWidth(RAIL_MIN_WIDTH);
    try {
      window.localStorage.removeItem(RAIL_WIDTH_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }
  function handlePanelDragStart(event: DragEvent<HTMLElement>, sectionId: string, panelId: string) {
    const payload = { sectionId, panelId };
    draggedPanelRef.current = payload;
    setDraggedPanel(payload);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-instantml-panel", JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", panelId);
  }
  function clearDraggedPanel() {
    draggedPanelRef.current = null;
    setDraggedPanel(null);
  }
  function handlePanelPointerMoveStart(event: ReactPointerEvent<HTMLElement>, sectionId: string, panelId: string) {
    if (event.button !== 0) return;
    const payload = { sectionId, panelId };
    const startX = event.clientX;
    const startY = event.clientY;
    const ownerDocument = event.currentTarget.ownerDocument;
    draggedPanelRef.current = payload;
    setDraggedPanel(payload);
    event.preventDefault();
    event.stopPropagation();
    pointerDragCleanupRef.current();

    function cleanupPointerDrag() {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      pointerDragCleanupRef.current = () => {};
    }
    function finish() {
      cleanupPointerDrag();
      clearDraggedPanel();
    }
    function handlePointerCancel() {
      finish();
    }
    function handlePointerUp(pointerEvent: globalThis.PointerEvent) {
      const moved = Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY);
      if (moved < 8) {
        finish();
        return;
      }
      const target = ownerDocument.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      const unsectionedDrop = target?.closest?.(".workspace-unsectioned-drop-zone");
      if (unsectionedDrop) {
        onMovePanel(payload.sectionId, payload.panelId, "__unsectioned__", Number.MAX_SAFE_INTEGER);
        finish();
        return;
      }
      const targetSection = target?.closest?.(".workspace-section") as HTMLElement | null | undefined;
      const targetSectionId = targetSection?.dataset.sectionId;
      if (!targetSectionId) {
        finish();
        return;
      }
      const targetCard = target?.closest?.(".workspace-panel-card") as HTMLElement | null | undefined;
      const cards = Array.from(targetSection.querySelectorAll<HTMLElement>(".workspace-panel-card"));
      const targetIndex = targetCard ? Math.max(0, cards.indexOf(targetCard)) : Number.MAX_SAFE_INTEGER;
      onMovePanel(payload.sectionId, payload.panelId, targetSectionId, targetIndex);
      finish();
    }

    pointerDragCleanupRef.current = cleanupPointerDrag;
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }
  function handlePanelDrop(event: DragEvent<HTMLElement>, targetSectionId: string, targetIndex: number) {
    event.preventDefault();
    const payload = draggedPanelRef.current ?? draggedPanel ?? readDraggedPanel(event);
    if (!payload) return;
    onMovePanel(payload.sectionId, payload.panelId, targetSectionId, targetIndex);
    clearDraggedPanel();
  }
  const visibleRunIds = workspaceRuns.map((run) => run.id);
  const railSelectionState = visibleSelectionState(selectedRunIds, visibleRunIds);
  const hasCrossPageSelection = railSelectionState === "all" && selectedRunIds.length > visibleRunIds.length;
  const railSelectionLabel = railSelectionState === "all"
    ? hasCrossPageSelection
      ? `Clear all ${selectedRunIds.length} selected runs`
      : `Deselect all ${visibleRunIds.length} visible runs`
    : `Select all ${visibleRunIds.length} visible runs`;
  const matchingOverflow = summaryTotal > visibleRunIds.length;
  const showSelectAllMatching = matchingOverflow && selectedRunIds.length > 0;
  const selectAllMatchingTarget = Math.min(summaryTotal, BULK_SELECT_MATCHING_LIMIT);
  const initialRunsLoading = !initialLoadDone && workspaceRuns.length === 0;

  useEffect(() => {
    if (!selectedRunIds.length) setBulkPromptEnabled(false);
  }, [selectedRunIds.length]);

  function handleSelectAllVisible() {
    setBulkPromptEnabled(true);
    onSelectAllVisible();
  }

  return (
    <div
      className={`runs-workspace ${showAddPanelDrawer ? "drawer-open" : ""} ${runRailCollapsed ? "run-rail-collapsed" : ""}`}
      style={{ "--rail-width": `${railWidth}px` } as CSSProperties}
    >
      <aside className="workspace-run-rail">
        <div className="workspace-rail-head">
          <label className="workspace-rail-select-all" title={railSelectionLabel}>
            <input
              aria-checked={railSelectionState === "all" ? "true" : railSelectionState === "some" ? "mixed" : "false"}
              aria-label={railSelectionLabel}
              checked={railSelectionState === "all"}
              disabled={visibleRunIds.length === 0 || initialRunsLoading}
              onChange={handleSelectAllVisible}
              ref={(node) => { if (node) node.indeterminate = railSelectionState === "some"; }}
              type="checkbox"
            />
            <h2>Runs {initialRunsLoading ? <Skeleton height={13} radius={999} style={{ display: "inline-block", verticalAlign: "-1px" }} width={30} /> : <span>({summaryTotal})</span>}</h2>
          </label>
          <div className="workspace-rail-actions">
            {!runRailCollapsed ? (
              <button className="icon-button" type="button" aria-label="Refresh runs" title="Refresh runs" onClick={onRefresh}><RefreshCw size={15} /></button>
            ) : null}
            <button
              aria-label={runRailCollapsed ? "Restore runs selector" : "Collapse runs selector"}
              aria-pressed={runRailCollapsed}
              className="icon-button"
              onClick={() => onRunRailCollapsed(!runRailCollapsed)}
              title={runRailCollapsed ? "Restore runs selector" : "Collapse runs selector"}
              type="button"
            >
              {runRailCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </div>
        </div>
        {visibleRunIds.length && !initialRunsLoading ? (
          <div className="workspace-rail-page-select">
            <button
              aria-pressed={railSelectionState === "all"}
              className="link-button"
              onClick={handleSelectAllVisible}
              type="button"
            >
              {railSelectionState === "all"
                ? hasCrossPageSelection
                  ? `Clear all ${selectedRunIds.length} selected`
                  : `Clear ${visibleRunIds.length} on this page`
                : `Select all ${visibleRunIds.length} on this page`}
            </button>
            {railSelectionState !== "none" ? (
              <span className="workspace-rail-page-count">
                {selectedRunIds.length} selected
                {railSelectionState === "some" ? (
                  <>
                    {" · "}
                    <button className="link-button" onClick={onClearSelection} type="button">Clear</button>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}
        {showSelectAllMatching && !initialRunsLoading ? (
          <div className={`workspace-rail-select-banner ${bulkPromptEnabled ? "" : "quiet"}`} role="status" aria-live="polite">
            <span>{bulkPromptEnabled ? `${selectedRunIds.length} of ${summaryTotal} selected.` : "More runs match the current filters."}</span>
            {selectAllMatchingDisabled ? (
              <span className="visually-hidden">Refresh or fix the current search before selecting all matching runs.</span>
            ) : null}
            <button
              className="link-button"
              disabled={selectAllMatchingBusy || selectAllMatchingDisabled}
              onClick={onSelectAllMatching}
              title={selectAllMatchingDisabled ? "Refresh or fix the current search before selecting all matching runs." : undefined}
              type="button"
            >
              {selectAllMatchingBusy
                ? `Selecting ${selectAllMatchingTarget}...`
                : !bulkPromptEnabled
                  ? "Bulk select matching"
                  : selectAllMatchingTarget < summaryTotal
                  ? `Select first ${selectAllMatchingTarget} matching filter`
                  : `Select all ${summaryTotal} matching filter`}
            </button>
          </div>
        ) : null}
        <div className="workspace-run-list">
          {initialRunsLoading ? (
            <RunsRailSkeleton />
          ) : workspaceRuns.length ? workspaceRuns.map((run, index) => {
            const selected = selectedRunIds.includes(run.id);
            const compareLabel = selected ? `Deselect ${run.name}` : `Select ${run.name}`;
            const railTooltip = runRailTooltip(run);
            const uploadHealth = uploadHealthForRun(run);
            const configSummary = runConfigSummary(run);
            const compactConfigSummary = compactRailConfigSummary(run);
            const statusLabel = displayStatusForRun(run) || run.status || "unknown";
            const canStop = canRequestStop(run, canControlRuns);
            const latestMetricValue = metricKey ? run.latest_metrics?.[metricKey] : undefined;
            const hasLatestMetricValue = typeof latestMetricValue === "number" && Number.isFinite(latestMetricValue);
            const runColor = chartColor(stableChartIndex(run.id || run.name, index));
            return (
              <div
                className={`workspace-run-row ${selected ? "selected" : ""}${run.id === highlightRunId ? " is-highlighted" : ""}`}
                key={run.id}
                onMouseEnter={(event) => {
                  setHighlightRunId(run.id);
                  setRailTip({ text: railTooltip, rect: event.currentTarget.getBoundingClientRect() });
                }}
                onMouseLeave={() => {
                  setHighlightRunId((current) => (current === run.id ? null : current));
                  setRailTip(null);
                }}
              >
                <button
                  aria-label={compareLabel}
                  aria-pressed={selected}
                  className="workspace-run-select"
                  onClick={(event) => {
                    setBulkPromptEnabled(true);
                    onToggleRun(run.id, { shift: event.shiftKey });
                  }}
                  title={selected ? "Remove from comparison" : "Add to comparison"}
                  type="button"
                >
                  <span className="workspace-eye" aria-hidden="true"><span /></span>
                </button>
                <button
                  aria-label={`Open ${run.name}`}
                  className="workspace-run-open"
                  data-rail-tooltip={railTooltip}
                  onClick={() => { onInspectRun(run.id); onOpenRun(run.id); }}
                  type="button"
                >
                  <i className="legend-dot" style={{ backgroundColor: runColor }} aria-hidden="true" />
                  <span className="workspace-run-body">
                    <strong>{compactRailRunName(run.name)}</strong>
                    <small title={`${run.project} · ${configSummary}`}>{run.project} · {compactConfigSummary}</small>
                    <span className="workspace-run-evidence">
                      <span className={`workspace-run-status ${runStatusClass(statusLabel)}`}>{statusLabel}</span>
                      {hasLatestMetricValue ? (
                        <span className="workspace-run-metric-chip" title={`${metricKey}: ${latestMetricValue}`}>
                          <span className="wrm-name">{shortMetricName(metricKey)}</span>
                          <span className="wrm-value">{compactRailMetricValue(latestMetricValue)}</span>
                        </span>
                      ) : null}
                      {/* Exception-only: synced is the unmarked default. */}
                      {uploadHealth.state !== "unknown" && uploadHealth.state !== "synced" ? (
                        <span className={`upload-health-chip ${uploadHealth.tone}`} title={uploadHealth.detail || undefined}>{uploadHealth.label}</span>
                      ) : null}
                    </span>
                    {/* Tags + note moved off the card to keep rows a fixed size;
                        they surface in the hover tooltip (RunRailTooltip). */}
                  </span>
                </button>
                {canStop ? (
                  <button
                    aria-label={`Review stop request for ${run.name}`}
                    className="workspace-run-stop"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRequestStop([run.id]);
                    }}
                    title="Review stop request"
                    type="button"
                  >
                    <CircleStop size={15} />
                  </button>
                ) : null}
              </div>
            );
          }) : (
            <div className="empty compact-empty">
              <strong>No runs match the current filters.</strong>
              <span>Clear search, project, and status filters to return to the run list.</span>
              <button className="secondary compact-button" type="button" onClick={onClearFilters}>Clear filters</button>
            </div>
          )}
        </div>
        <RunRailTooltip tip={railTip} />
        <div className="workspace-run-footer">
          <CustomSelect
            className="table-footer-select"
            disabled={paginationBusy || initialRunsLoading}
            id="workspace-rows-per-page"
            label="Rows"
            menuPlacement="top"
            onChange={(nextPageSize) => {
              onPageSize(Number(nextPageSize));
            }}
            options={[10, 25, 50, 100].map((size) => ({ value: String(size), label: String(size) }))}
            value={String(pageSize)}
          />
          <strong>{initialRunsLoading ? <Skeleton height={11} radius={999} style={{ display: "inline-block", verticalAlign: "-1px" }} width={78} /> : `${pageStart}-${pageEnd} of ${summaryTotal}`}</strong>
          <div className="workspace-run-pager">
            <button className="icon-button framed" disabled={paginationBusy || initialRunsLoading || !hasPreviousPage} onClick={onPreviousPage} type="button" aria-label="Previous page" title="Previous page"><ChevronDown className="rotate-90" size={15} /></button>
            <RunPageJumper
              disabled={paginationBusy || initialRunsLoading || summaryTotal === 0}
              onGoToPage={onGoToPage}
              pageSize={pageSize}
              pageStart={pageStart}
              summaryTotal={summaryTotal}
            />
            <button className="icon-button framed" disabled={paginationBusy || initialRunsLoading || !hasNextPage} onClick={onNextPage} type="button" aria-label="Next page" title="Next page"><ChevronDown className="rotate-neg-90" size={15} /></button>
          </div>
        </div>
      </aside>

      <div
        aria-label="Drag to resize the runs panel"
        aria-orientation="vertical"
        aria-valuemin={RAIL_MIN_WIDTH}
        aria-valuemax={RAIL_MAX_WIDTH}
        aria-valuenow={railWidth}
        className="rail-resize-handle"
        onDoubleClick={resetRailWidth}
        onKeyDown={handleRailResizeKey}
        onPointerDown={handleRailResizeStart}
        role="separator"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
      />

      <section className="workspace-canvas">
        <div className="workspace-panel-toolbar">
          <label className="control workspace-panel-search">
            <span><Search size={14} /> Search panels</span>
            <input aria-label="Search panels" id="panel-search" type="search" value={panelSearch} onChange={(event) => onPanelSearch(event.target.value)} placeholder="Search panels" />
          </label>
          {view.mode === "manual" ? <button className="icon-button framed" type="button" onClick={onResetWorkspace} aria-label="Rebuild layout" title="Rebuild layout from logged metrics"><RefreshCw size={15} /></button> : null}
          {!showAddPanelDrawer ? <button className="primary-button icon-only" data-add-panel-trigger="true" type="button" aria-label="Add panels" title="Add panels" onClick={() => onSetAddPanelSection(activeAddSectionId)}><Plus size={15} /></button> : null}
        </div>

        <div className="workspace-sections">
          {initialRunsLoading ? <WorkspaceCanvasSkeleton /> : view.sections.map((section) => {
            const visiblePanels = section.panels.filter((panel) => panelMatchesSearch(section, panel, panelSearch)).slice(0, 12);
            return (
              <WorkspaceSectionView
                key={section.id}
                highlightRunId={highlightRunId}
                onHighlightRun={setHighlightRunId}
                onDuplicatePanel={onDuplicatePanel}
                onEditPanel={onEditPanel}
                onFullscreenPanel={onFullscreenPanel}
                onPanelDragEnd={clearDraggedPanel}
                onPanelDragStart={handlePanelDragStart}
                onPanelDrop={handlePanelDrop}
                onPanelPointerMoveStart={handlePanelPointerMoveStart}
                onRemovePanel={onRemovePanel}
                onResizePanel={onResizePanel}
                onPanelSmoothing={onPanelSmoothing}
                onToggleSection={onToggleSection}
                panelSearchActive={Boolean(panelSearch.trim())}
                section={section}
                selectedRunIds={selectedRunIds}
                visiblePanels={visiblePanels}
                view={view}
                workspaceHistogramTimelines={workspaceHistogramTimelines}
                workspacePanelRuns={workspacePanelRuns}
                workspaceSeries={workspaceSeries}
              />
            );
          })}
          {panelSearch && hiddenPanelCount ? <small className="workspace-search-note">{hiddenPanelCount} panels hidden by the current search.</small> : null}
        </div>

        <div
          className={`workspace-unsectioned-drop-zone ${draggedPanel ? "active" : ""}`}
          onDragOver={(event) => {
            if (draggedPanel) event.preventDefault();
          }}
          onDrop={(event) => handlePanelDrop(event, "__unsectioned__", Number.MAX_SAFE_INTEGER)}
        >
          Drop here to move a panel outside named sections.
        </div>

        <div className="workspace-add-section">
          <button className="secondary" type="button" onClick={onAddSection}><Plus size={15} /> Add section</button>
        </div>
      </section>

      {showAddPanelDrawer && typeof document !== "undefined" ? createPortal(
        <>
          <div className="panel-drawer-backdrop" aria-hidden="true" onMouseDown={() => onSetAddPanelSection("")} />
          <aside className="panel-drawer" role="dialog" aria-modal="true" aria-label="Add panels" ref={addDrawerRef} tabIndex={-1}>
            <div className="drawer-head">
              <h2>Add panels</h2>
              <button className="icon-button" type="button" aria-label="Close add panels" onClick={() => onSetAddPanelSection("")}><X size={16} /></button>
            </div>
            <button
              className="quick-add-card"
              type="button"
              disabled={!canQuickAddPanel}
              onClick={() => {
                const key = addPanelType === "histogram_timeline" ? histogramObjectKey : availableMetricKeys[0];
                if (key) onAddPanel(activeAddSectionId, key, addPanelType);
              }}
            >
              <span><Plus size={17} /></span>
              <strong>Quick add</strong>
              <small>
                {addPanelType === "histogram_timeline"
                  ? "Create a selected-run timeline for the histogram object key."
                  : `Add the next available metric as a ${workspacePanelTypeLabel(addPanelType).toLowerCase()} panel.`}
              </small>
            </button>
            <div className="chart-type-segment" role="group" aria-label="Chart type">
              {WORKSPACE_PANEL_TYPES.map((type) => (
                <button
                  aria-pressed={addPanelType === type}
                  className={addPanelType === type ? "active" : ""}
                  key={type}
                  onClick={() => {
                    setAddPanelType(type);
                    if (type === "histogram_timeline" && !addHistogramObjectKey.trim()) setAddHistogramObjectKey(preferredHistogramObjectKey(availableMetricKeys));
                  }}
                  type="button"
                >
                  {workspacePanelTypeLabel(type)}
                </button>
              ))}
            </div>
            <CustomSelect
              className="full"
              id="add-panel-section"
              label="Add to"
              onChange={onSetAddPanelSection}
              options={view.sections.map((section) => ({ value: section.id, label: section.name }))}
              value={activeAddSectionId}
            />
            {addPanelType === "histogram_timeline" ? (
              <label className="control full">
                Histogram object key
                <input
                  aria-label="Histogram object key to add"
                  onChange={(event) => setAddHistogramObjectKey(event.target.value)}
                  placeholder="eval/score_distribution"
                  value={addHistogramObjectKey}
                />
                <small>Use the exact key passed to `log_histogram(...)` or a histogram rich object.</small>
              </label>
            ) : null}
            <div className="drawer-group">
              <h3>{addPanelType === "histogram_timeline" ? "Metric-key suggestions" : "Charts"}</h3>
              {availableMetricKeys.slice(0, 18).map((metric) => (
                <button className="drawer-metric-row" key={metric} type="button" onClick={() => onAddPanel(activeAddSectionId, metric, addPanelType)}>
                  <Activity size={16} />
                  <span>
                    <strong>{metricTitle(metric)}</strong>
                    <small>{metric}</small>
                  </span>
                </button>
              ))}
              {!availableMetricKeys.length ? <div className="empty compact-empty">No metrics are available for the current filters yet.</div> : null}
            </div>
          </aside>
        </>,
        document.body,
      ) : null}
    </div>
  );
}

function RunsRailSkeleton() {
  // Rows shimmer in a top-down wave (--skel-delay staggers the sheen) so the
  // rail reads as filling in rather than sitting frozen.
  return (
    <div className="workspace-run-loading" role="status" aria-label="Loading runs">
      {Array.from({ length: 7 }, (_, index) => (
        <div className="workspace-run-skeleton-row" key={index} style={{ "--skel-delay": `${index * 90}ms` } as CSSProperties}>
          <span className="workspace-run-skeleton-check" />
          <span className="workspace-run-skeleton-body">
            <span className="workspace-skeleton-line is-title" />
            <span className="workspace-skeleton-line is-meta" />
            <span className="workspace-skeleton-line is-evidence" />
          </span>
        </div>
      ))}
    </div>
  );
}

function WorkspaceCanvasSkeleton() {
  return (
    <div className="workspace-loading-skeleton" role="status" aria-label="Loading run workspace">
      <div className="workspace-loading-section-head">
        <span className="workspace-skeleton-line is-heading" />
        <span className="workspace-skeleton-line is-count" />
      </div>
      <div className="workspace-loading-panel-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="workspace-loading-panel" key={index} style={{ "--skel-delay": `${index * 160}ms` } as CSSProperties}>
            <div className="workspace-loading-panel-head">
              <span className="workspace-skeleton-line is-panel-title" />
              <span className="workspace-skeleton-line is-panel-meta" />
            </div>
            <div className="workspace-loading-panel-body">
              <SkeletonChartLines />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunPageJumper({
  disabled,
  onGoToPage,
  pageSize,
  pageStart,
  summaryTotal,
}: {
  disabled: boolean;
  onGoToPage: (page: number) => void;
  pageSize: number;
  pageStart: number;
  summaryTotal: number;
}) {
  const totalPages = Math.max(1, Math.ceil(summaryTotal / Math.max(1, pageSize)));
  const currentPage = summaryTotal ? Math.floor((pageStart - 1) / Math.max(1, pageSize)) + 1 : 1;
  const [draft, setDraft] = useState(String(currentPage));
  // Keep the input in sync when the page changes via prev/next or page-size.
  useEffect(() => {
    setDraft(String(currentPage));
  }, [currentPage]);

  function commit() {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(currentPage));
      return;
    }
    const clamped = Math.min(Math.max(1, parsed), totalPages);
    setDraft(String(clamped));
    if (clamped !== currentPage) onGoToPage(clamped);
  }

  return (
    <form
      className="workspace-run-page-jump"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        aria-label={`Page number, ${currentPage} of ${totalPages}`}
        disabled={disabled}
        inputMode="numeric"
        max={totalPages}
        min={1}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
        type="text"
        value={draft}
      />
      <span>/ {totalPages}</span>
    </form>
  );
}
