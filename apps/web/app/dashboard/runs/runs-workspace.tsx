"use client";

import { Activity, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent } from "react";

import { MAX_SELECTED_RUNS, statusTone, visibleSelectionState } from "../../../src/state.js";
import { metricTitle, runConfigSummary, runLastSeenLabel, runNoteText, workspacePanelTypeLabel } from "../../dashboard-models";
import { CustomSelect } from "../ui/select";
import { useFocusTrap } from "../ui/use-focus-trap";
import { WorkspaceSectionView } from "./workspace-panel-card";
import type { Dispatch, SetStateAction } from "react";
import type { MetricSeries, RunSummary, TableColumns, WorkspacePanelType, WorkspaceView } from "../../dashboard-types";

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

function visibleTagsForSearch(tags: string[], search: string, limit: number) {
  const normalizedTags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return normalizedTags.slice(0, limit);
  const matched = normalizedTags.filter((tag) => {
    const text = tag.toLowerCase();
    return tokens.some((token) => text.includes(token));
  });
  return [...matched, ...normalizedTags].filter((tag, index, values) => values.indexOf(tag) === index).slice(0, limit);
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

function panelMatchesSearch(section: { name: string }, panel: { title: string; metricKey: string; type: string }, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${section.name} ${panel.title} ${panel.metricKey} ${workspacePanelTypeLabel(panel.type as WorkspacePanelType)}`.toLowerCase().includes(needle);
}

export function RunsWorkspace({
  addPanelSectionId,
  availableMetricKeys,
  onAddPanel,
  onAddSection,
  onClearFilters,
  onColumnsOpen,
  onDuplicatePanel,
  onEditPanel,
  onFullscreenPanel,
  onInspectRun,
  onOpenRun,
  onMode,
  onMovePanel,
  onPanelSearch,
  onRefresh,
  onRemovePanel,
  onResetWorkspace,
  onResizePanel,
  onRunRailCollapsed,
  onSetAddPanelSection,
  onTableColumns,
  onSelectAllMatching,
  onSelectAllVisible,
  onToggleRun,
  onToggleSection,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPageSize,
  onPreviousPage,
  paginationBusy,
  pageEnd,
  pageSize,
  pageStart,
  panelSearch,
  runSearch,
  runRailCollapsed,
  selectAllMatchingBusy,
  selectedRunIds,
  showAddPanelDrawer,
  summaryTotal,
  tableColumns,
  view,
  workspacePanelRuns,
  workspaceRuns,
  workspaceSeries,
}: {
  addPanelSectionId: string;
  availableMetricKeys: string[];
  onAddPanel: (sectionId: string, metricKey: string, type: WorkspacePanelType) => void;
  onAddSection: () => void;
  onClearFilters: () => void;
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onInspectRun: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onMode: (mode: "automatic" | "manual") => void;
  onMovePanel: (sourceSectionId: string, panelId: string, targetSectionId: string, targetIndex: number) => void;
  onPanelSearch: (value: string) => void;
  onRefresh: () => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onResetWorkspace: () => void;
  onResizePanel: (sectionId: string, panelId: string, layout: import("../../dashboard-types").WorkspacePanelLayout) => void;
  onRunRailCollapsed: (collapsed: boolean) => void;
  onSelectAllMatching: () => void;
  onSelectAllVisible: () => void;
  onSetAddPanelSection: (sectionId: string) => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  onToggleRun: (runId: string, options?: { shift?: boolean }) => void;
  onToggleSection: (sectionId: string) => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNextPage: () => void;
  onPageSize: (size: number) => void;
  onPreviousPage: () => void;
  paginationBusy: boolean;
  pageEnd: number;
  pageSize: number;
  pageStart: number;
  panelSearch: string;
  runSearch: string;
  runRailCollapsed: boolean;
  selectAllMatchingBusy: boolean;
  selectedRunIds: string[];
  showAddPanelDrawer: boolean;
  summaryTotal: number;
  tableColumns: TableColumns;
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  const hiddenPanelCount = view.sections.reduce((sum, section) => sum + section.panels.filter((panel) => !panelMatchesSearch(section, panel, panelSearch)).length, 0);
  const addDrawerRef = useFocusTrap<HTMLElement>(
    showAddPanelDrawer,
    () => onSetAddPanelSection(""),
    ".drawer-metric-row:not([disabled]), .quick-add-card:not([disabled]), button[aria-label='Close add panels']",
  );
  const [draggedPanel, setDraggedPanel] = useState<DraggedWorkspacePanel | null>(null);
  const [addPanelType, setAddPanelType] = useState<WorkspacePanelType>("line");
  const draggedPanelRef = useRef<DraggedWorkspacePanel | null>(null);
  const activeAddSectionId = addPanelSectionId || view.sections[0]?.id || "";
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

    function finish() {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
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
  const showSelectAllMatching = matchingOverflow;
  const selectAllMatchingTarget = Math.min(summaryTotal, MAX_SELECTED_RUNS);
  return (
    <div className={`runs-workspace ${showAddPanelDrawer ? "drawer-open" : ""} ${runRailCollapsed ? "run-rail-collapsed" : ""}`}>
      <aside className="workspace-run-rail">
        <div className="workspace-rail-head">
          <label className="workspace-rail-select-all" title={railSelectionLabel}>
            <input
              aria-checked={railSelectionState === "all" ? "true" : railSelectionState === "some" ? "mixed" : "false"}
              aria-label={railSelectionLabel}
              checked={railSelectionState === "all"}
              disabled={visibleRunIds.length === 0}
              onChange={onSelectAllVisible}
              ref={(node) => { if (node) node.indeterminate = railSelectionState === "some"; }}
              type="checkbox"
            />
            <h2>Runs <span>({summaryTotal})</span></h2>
          </label>
          <div className="workspace-rail-actions">
            <button className="icon-button" type="button" aria-label="Refresh runs" onClick={onRefresh}><RefreshCw size={15} /></button>
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
        {showSelectAllMatching ? (
          <div className="workspace-rail-select-banner" role="status" aria-live="polite">
            <span>{selectedRunIds.length} of {summaryTotal} selected.</span>
            <button
              className="link-button"
              disabled={selectAllMatchingBusy}
              onClick={onSelectAllMatching}
              type="button"
            >
              {selectAllMatchingBusy
                ? `Selecting ${selectAllMatchingTarget}...`
                : selectAllMatchingTarget < summaryTotal
                  ? `Select first ${selectAllMatchingTarget} matching filter`
                  : `Select all ${summaryTotal} matching filter`}
            </button>
          </div>
        ) : null}
        <div className="workspace-run-list">
          {workspaceRuns.length ? workspaceRuns.map((run, index) => {
            const selected = selectedRunIds.includes(run.id);
            const compareLabel = selected ? `Deselect ${run.name}` : `Select ${run.name}`;
            const note = runNoteText(run);
            const visibleTags = visibleTagsForSearch(run.tags, runSearch, 3);
            const hiddenTags = run.tags.filter((tag) => !visibleTags.includes(tag));
            return (
              <div
                className={`workspace-run-row ${selected ? "selected" : ""}`}
                key={run.id}
              >
                <button
                  aria-label={compareLabel}
                  aria-pressed={selected}
                  className="workspace-run-select"
                  onClick={(event) => onToggleRun(run.id, { shift: event.shiftKey })}
                  title={selected ? "Remove from comparison" : "Add to comparison"}
                  type="button"
                >
                  <span className="workspace-eye" aria-hidden="true"><span /></span>
                </button>
                <button
                  aria-label={`Open ${run.name}`}
                  className="workspace-run-open"
                  onClick={() => { onInspectRun(run.id); onOpenRun(run.id); }}
                  title={`Open ${run.name}`}
                  type="button"
                >
                  <i className={`legend-dot dot-${index % 5}`} aria-hidden="true" />
                  <span className="workspace-run-body">
                    <strong>{compactRailRunName(run.name)}</strong>
                    <small>{run.project} · {runConfigSummary(run)}</small>
                    <span className="workspace-run-status">
                      <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
                      {run.status === "running" || run.status === "crashed" ? <small>last seen {runLastSeenLabel(run)}</small> : null}
                    </span>
                    <span className="workspace-run-tags" aria-label={`${run.name} tags`}>
                      {visibleTags.map((tag) => <b key={tag}>{tag}</b>)}
                      {hiddenTags.length ? <em title={hiddenTags.join(", ")}>+{hiddenTags.length}</em> : null}
                    </span>
                    {note ? <small className="workspace-run-note" title={note}>{note}</small> : null}
                  </span>
                  <span className="workspace-run-open-hint" aria-hidden="true">Open <ChevronRight size={12} /></span>
                </button>
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
        <div className="workspace-run-footer">
          <CustomSelect
            className="table-footer-select"
            disabled={paginationBusy}
            id="workspace-rows-per-page"
            label="Rows"
            menuPlacement="top"
            onChange={(nextPageSize) => {
              onPageSize(Number(nextPageSize));
            }}
            options={[10, 25, 50, 100].map((size) => ({ value: String(size), label: String(size) }))}
            value={String(pageSize)}
          />
          <strong>{`${pageStart}-${pageEnd} of ${summaryTotal}`}</strong>
          <button className="icon-button framed" disabled={paginationBusy || !hasPreviousPage} onClick={onPreviousPage} type="button" aria-label="Previous page"><ChevronDown className="rotate-90" size={15} /></button>
          <button className="icon-button framed" disabled={paginationBusy || !hasNextPage} onClick={onNextPage} type="button" aria-label="Next page"><ChevronDown className="rotate-neg-90" size={15} /></button>
        </div>
      </aside>

      <section className="workspace-canvas">
        <div className="workspace-panel-toolbar">
          <label className="control workspace-panel-search">
            <span><Search size={14} /> Search panels</span>
            <input id="panel-search" type="search" value={panelSearch} onChange={(event) => onPanelSearch(event.target.value)} placeholder="Search panels" />
          </label>
          <CustomSelect
            className="workspace-mode-select"
            id="workspace-mode"
            label="Mode"
            labelClassName="visually-hidden"
            onChange={(value) => onMode(value === "manual" ? "manual" : "automatic")}
            options={[{ value: "automatic", label: "Automatic" }, { value: "manual", label: "Manual" }]}
            value={view.mode}
          />
          <button className="secondary compact-button" type="button" onClick={onResetWorkspace}><RefreshCw size={15} /> Reset layout</button>
          {!showAddPanelDrawer ? <button className="primary-button" type="button" onClick={() => onSetAddPanelSection(activeAddSectionId)}><Plus size={15} /> Add panels</button> : null}
        </div>

        <div className="workspace-sections">
          {view.sections.map((section) => {
            const visiblePanels = section.panels.filter((panel) => panelMatchesSearch(section, panel, panelSearch)).slice(0, 12);
            return (
              <WorkspaceSectionView
                key={section.id}
                onDuplicatePanel={onDuplicatePanel}
                onEditPanel={onEditPanel}
                onFullscreenPanel={onFullscreenPanel}
                onPanelDragEnd={clearDraggedPanel}
                onPanelDragStart={handlePanelDragStart}
                onPanelDrop={handlePanelDrop}
                onPanelPointerMoveStart={handlePanelPointerMoveStart}
                onRemovePanel={onRemovePanel}
                onResizePanel={onResizePanel}
                onToggleSection={onToggleSection}
                panelSearchActive={Boolean(panelSearch.trim())}
                section={section}
                selectedRunIds={selectedRunIds}
                visiblePanels={visiblePanels}
                view={view}
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

      {showAddPanelDrawer ? (
        <aside className="panel-drawer" role="dialog" aria-modal="true" aria-label="Add panels" ref={addDrawerRef} tabIndex={-1}>
          <div className="drawer-head">
            <h2>Add panels</h2>
            <button className="icon-button" type="button" aria-label="Close add panels" onClick={() => onSetAddPanelSection("")}><X size={16} /></button>
          </div>
          <button className="quick-add-card" type="button" disabled={!availableMetricKeys.length} onClick={() => availableMetricKeys[0] && onAddPanel(activeAddSectionId, availableMetricKeys[0], addPanelType)}>
            <span><Plus size={17} /></span>
            <strong>Quick add</strong>
            <small>Add the next available metric as a {workspacePanelTypeLabel(addPanelType).toLowerCase()} panel.</small>
          </button>
          <div className="chart-type-segment" role="group" aria-label="Chart type">
            {(["line", "bar", "histogram", "dot"] as WorkspacePanelType[]).map((type) => (
              <button
                aria-pressed={addPanelType === type}
                className={addPanelType === type ? "active" : ""}
                key={type}
                onClick={() => setAddPanelType(type)}
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
          <div className="drawer-group">
            <h3>Charts</h3>
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
      ) : null}
    </div>
  );
}
