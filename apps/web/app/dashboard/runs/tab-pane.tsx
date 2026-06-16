"use client";

import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { EmptyWorkspaceSnippet } from "../components/empty-workspace-snippet";
import { PageHead } from "../ui/page-head";
import { PanelEditDrawer } from "./panel-edit-drawer";
import { RunsCommandbar, type RunsViewMode } from "./runs-commandbar";
import { RunsTable } from "./runs-table";
import { RunsWorkspace } from "./runs-workspace";
import { WorkspacePanelCard } from "./workspace-panel-card";
import { fieldLabel } from "../../../src/dashboard-panels.js";
import type { HistogramTimelineState, Overview, RunSummary, TableColumns, WorkspaceCategoricalFieldOption, WorkspaceFieldOption, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceView } from "../../dashboard-types";
import type { MetricSeries } from "../../dashboard-types";
import type { components } from "../../../src/types/api.generated";

type OrgMembershipSummary = components["schemas"]["OrganizationMembershipSummary"];

type EditingPanelContext = {
  section: WorkspaceView["sections"][number];
  panel: WorkspaceView["sections"][number]["panels"][number];
} | null;

type FullscreenPanelContext = EditingPanelContext;

type Props = {
  addPanelSectionId: string;
  allMetricOptions: string[];
  availableWorkspaceMetrics: string[];
  canControlRuns: boolean;
  columnMetricFilter: string;
  columnMetricFilterValid: boolean;
  columnMetricOptionsForControls: string[];
  columnsOpen: boolean;
  dashboardLoading: boolean;
  editingPanelContext: EditingPanelContext;
  exportSelectedBusy: boolean;
  fullscreenModalRef: RefObject<HTMLDivElement | null>;
  fullscreenPanelContext: FullscreenPanelContext;
  fullscreenPanelIndex: number;
  fullscreenPanelOrder: Array<{ sectionId: string; panelId: string; title: string }>;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  initialLoadDone: boolean;
  filterBar?: ReactNode;
  metricKey: string;
  metricOptionsForControls: string[];
  onAddPanel: (sectionId: string, panelMetric: string, type?: WorkspacePanelType) => void;
  onAddSection: () => void;
  onChangeMetricKey: (key: string) => void;
  onClearFilters: () => void;
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onColumnMetricFilter: (filter: string) => void;
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onExportSelectedRuns: () => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onCloseEditingPanel: () => void;
  onFullscreenPanelClose: () => void;
  onFullscreenPanelMove: (direction: -1 | 1) => void;
  onInspectRun: (runId: string) => void;
  primaryRunId: string;
  onMode: (mode: "automatic" | "manual") => void;
  onMovePanel: (sourceSectionId: string, panelId: string, targetSectionId: string, targetIndex: number) => void;
  onGoToPage: (page: number) => void;
  onNextPage: () => void;
  onOpenRun: (id: string) => void;
  onPageSize: (size: number) => void;
  onPanelSearch: (search: string) => void;
  onPinnedMetric: (metric: string) => void;
  onPreviousPage: () => void;
  onRefresh: () => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onRequestStop: (runIds: string[]) => void;
  onResetWorkspace: () => void;
  onResizePanel: (sectionId: string, panelId: string, layout: WorkspacePanelLayout) => void;
  onPanelSmoothing: (sectionId: string, panelId: string, smoothing: number) => void;
  onRunRailCollapsed: (collapsed: boolean) => void;
  onSelectAllMatching: () => void;
  onClearSelection: () => void;
  onSelectAllVisible: () => void;
  onSelectProject: (project: string) => void;
  onSetAddPanelSection: (sectionId: string) => void;
  onSwitchOrganization: (orgId: string) => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  onToggleRun: (runId: string, options?: { shift?: boolean }) => void;
  onToggleSection: (sectionId: string) => void;
  onUpdateEditingPanel: (patch: {
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
  }) => void;
  orgMemberships: OrgMembershipSummary[];
  orgName: string;
  orgSwitchBusy: boolean;
  pageEnd: number;
  pageSize: number;
  pageStart: number;
  paginationBusy: boolean;
  panelSearch: string;
  pinnedMetrics: string[];
  project: string;
  projects: string[];
  query: string;
  queryInput: string;
  runsRailCollapsed: boolean;
  selectAllMatchingBusy: boolean;
  selectAllMatchingDisabled: boolean;
  selectedRunIds: string[];
  selectedRunExportDisabled: boolean;
  selectedRunExportTitle: string;
  selectedStopCandidateCount: number;
  selectedStopDisabledReason: string;
  sortedRuns: RunSummary[];
  status: string;
  summaryTotal: number;
  tableColumns: TableColumns;
  workspaceCategoricalFieldOptions: WorkspaceCategoricalFieldOption[];
  workspaceFieldOptions: WorkspaceFieldOption[];
  workspaceHistogramTimelines: Record<string, HistogramTimelineState>;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
  workspaceView: WorkspaceView;
};

export function RunsTabPane({
  addPanelSectionId,
  allMetricOptions,
  availableWorkspaceMetrics,
  canControlRuns,
  columnMetricFilter,
  columnMetricFilterValid,
  columnMetricOptionsForControls,
  columnsOpen,
  dashboardLoading,
  editingPanelContext,
  exportSelectedBusy,
  fullscreenModalRef,
  fullscreenPanelContext,
  fullscreenPanelIndex,
  fullscreenPanelOrder,
  hasNextPage,
  hasPreviousPage,
  initialLoadDone,
  filterBar,
  metricKey,
  metricOptionsForControls,
  onAddPanel,
  onAddSection,
  onChangeMetricKey,
  onClearFilters,
  onColumnsOpen,
  onColumnMetricFilter,
  onDuplicatePanel,
  onCloseEditingPanel,
  onEditPanel,
  onExportSelectedRuns,
  onFullscreenPanel,
  onFullscreenPanelClose,
  onFullscreenPanelMove,
  onInspectRun,
  primaryRunId,
  onMode,
  onMovePanel,
  onGoToPage,
  onNextPage,
  onOpenRun,
  onPageSize,
  onPanelSearch,
  onPinnedMetric,
  onPreviousPage,
  onRefresh,
  onRemovePanel,
  onRequestStop,
  onResetWorkspace,
  onResizePanel,
  onPanelSmoothing,
  onRunRailCollapsed,
  onSelectAllMatching,
  onClearSelection,
  onSelectAllVisible,
  onSelectProject,
  onSetAddPanelSection,
  onSwitchOrganization,
  onTableColumns,
  onToggleRun,
  onToggleSection,
  onUpdateEditingPanel,
  orgMemberships,
  orgName,
  orgSwitchBusy,
  pageEnd,
  pageSize,
  pageStart,
  paginationBusy,
  panelSearch,
  pinnedMetrics,
  project,
  projects,
  query,
  queryInput,
  runsRailCollapsed,
  selectAllMatchingBusy,
  selectAllMatchingDisabled,
  selectedRunIds,
  selectedRunExportDisabled,
  selectedRunExportTitle,
  selectedStopCandidateCount,
  selectedStopDisabledReason,
  sortedRuns,
  status,
  summaryTotal,
  tableColumns,
  workspaceCategoricalFieldOptions,
  workspaceFieldOptions,
  workspaceHistogramTimelines,
  workspacePanelRuns,
  workspaceSeries,
  workspaceView,
}: Props) {
  // Panels (rail + chart canvas) vs a flat sortable runs table. Persisted
  // per-browser; additive key, never renamed (see state/storage-keys.ts).
  const [runsView, setRunsView] = useState<RunsViewMode>("panels");
  useEffect(() => {
    if (localStorage.getItem("instantml:next:runs-view") === "table") setRunsView("table");
  }, []);
  function changeRunsView(view: RunsViewMode) {
    setRunsView(view);
    localStorage.setItem("instantml:next:runs-view", view);
  }
  const showEmptyCallout = initialLoadDone && !dashboardLoading && summaryTotal === 0 && projects.length === 0 && !project && !query && !status;
  const nonCurrentMemberships = orgMemberships.filter((m) => !m.is_current);
  // The sticky run rail and panel toolbar sit directly below the sticky filter
  // bar, offset by --runs-filter-sticky-height. That filter wraps to different
  // heights depending on viewport width and command-bar content, so a hardcoded
  // reservation leaves a transparent gap the charts scroll through (or overlaps
  // them). Measure the real height and publish it so the offset stays flush.
  const filterRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const filter = filterRef.current;
    if (!filter || typeof ResizeObserver === "undefined") return undefined;
    // Scope the measured height to the tab pane (whose stylesheet owns the
    // fallback). Bail rather than fall back to :root — leaking the runs filter
    // height there would offset every other tab that reads the var.
    const scope = filter.closest(".tab-pane") as HTMLElement | null;
    if (!scope) return undefined;
    // The mobile layout (<=900px, matching mobile.css) pins the filter at the
    // topbar and forces the offset to 0; an inline measurement would clobber
    // that and reintroduce the dead gap. Clear our override and stand down.
    const mobile = window.matchMedia("(max-width: 900px)");
    let frame = 0;
    const syncFilterHeight = () => {
      if (mobile.matches) {
        scope.style.removeProperty("--runs-filter-sticky-height");
        return;
      }
      const height = filter.getBoundingClientRect().height;
      if (height && Number.isFinite(height)) {
        scope.style.setProperty("--runs-filter-sticky-height", `${Math.ceil(height)}px`);
      }
    };
    const queueSync = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncFilterHeight);
    };
    const observer = new ResizeObserver(queueSync);
    observer.observe(filter);
    queueSync();
    window.addEventListener("resize", queueSync);
    mobile.addEventListener("change", queueSync);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", queueSync);
      mobile.removeEventListener("change", queueSync);
      scope.style.removeProperty("--runs-filter-sticky-height");
    };
  }, []);
  const fullscreenPanelSubtitle = fullscreenPanelContext
    ? fullscreenPanelContext.panel.type === "scatter" && fullscreenPanelContext.panel.xField && fullscreenPanelContext.panel.yField
      ? `${fieldLabel(fullscreenPanelContext.panel.xField)} x ${fieldLabel(fullscreenPanelContext.panel.yField)}`
      : fullscreenPanelContext.panel.metricKey ?? "Metric"
    : "Metric";

  return (
    <>
      <PageHead eyebrow="Workspace" title="Runs" />
      <>
      {/* The run filter row (status / search / sort / saved views) lives in the
          Runs tab, between the page head and the metric/Runs-actions row. */}
      {filterBar}
      {/* The Run health summary cards were removed from this header (2026-06):
          they duplicated the Run health tab and pushed the actual run list
          below the fold. Health stats live on /dashboard/alerts. */}
      {showEmptyCallout ? (
        <>
          {nonCurrentMemberships.length ? (
            <div className="org-empty-callout" role="status">
              <div className="org-empty-callout__copy">
                <strong>Wrong workspace?</strong>
                <span>
                  {orgName ? `${orgName} has no runs yet.` : "No runs yet."} You belong to other workspaces — switch below, or follow the SDK quick-start.
                </span>
              </div>
              <div className="org-empty-callout__actions">
                {nonCurrentMemberships.slice(0, 3).map((membership) => (
                  <button
                    className="ghost-kbd"
                    disabled={orgSwitchBusy}
                    key={membership.org_id}
                    onClick={() => onSwitchOrganization(membership.org_id)}
                    type="button"
                  >
                    Switch to {membership.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <EmptyWorkspaceSnippet orgName={orgName} />
        </>
      ) : null}
      <div className="runs-workspace-filter" ref={filterRef}>
        <RunsCommandbar
          columnsOpen={columnsOpen}
          exportSelectedBusy={exportSelectedBusy}
          metricKey={metricKey}
          metricOptions={metricOptionsForControls}
          onColumnsOpen={onColumnsOpen}
          onExportSelectedRuns={onExportSelectedRuns}
          onMetricKey={onChangeMetricKey}
          onPinnedMetricFilter={onColumnMetricFilter}
          onPinnedMetric={onPinnedMetric}
          onRefresh={onRefresh}
          onTableColumns={onTableColumns}
          onViewMode={changeRunsView}
          pinnedMetricFilter={columnMetricFilter}
          pinnedMetricFilterValid={columnMetricFilterValid}
          pinnedMetricOptions={columnMetricOptionsForControls}
          pinnedMetrics={pinnedMetrics}
          selectedRunCount={selectedRunIds.length}
          selectedRunExportDisabled={selectedRunExportDisabled}
          selectedRunExportTitle={selectedRunExportTitle}
          selectedStopCandidateCount={selectedStopCandidateCount}
          selectedStopDisabledReason={selectedStopDisabledReason}
          tableColumns={tableColumns}
          onRequestSelectedStop={() => onRequestStop(selectedRunIds)}
          viewMode={runsView}
        />
      </div>
      {runsView === "table" ? (
        <div className="runs-table-view">
          <RunsTable
            canControlRuns={canControlRuns}
            columns={tableColumns}
            hasNextPage={hasNextPage}
            hasPreviousPage={hasPreviousPage}
            metricKey={metricKey}
            onClearFilters={onClearFilters}
            onClearSelection={onClearSelection}
            onInspectRun={onInspectRun}
            onNextPage={onNextPage}
            onOpenRun={onOpenRun}
            onPreviousPage={onPreviousPage}
            onRequestStop={onRequestStop}
            onSelectAllVisible={onSelectAllVisible}
            onToggleRun={(runId) => onToggleRun(runId)}
            pageSize={pageSize}
            pageStart={pageStart}
            paginationBusy={paginationBusy}
            pinnedMetrics={pinnedMetrics}
            primaryRunId={primaryRunId}
            query={query}
            runs={sortedRuns}
            selectedRunIds={selectedRunIds}
            status={status}
            summaryTotal={summaryTotal}
            workspaceSeries={workspaceSeries}
          />
        </div>
      ) : (
      <RunsWorkspace
        addPanelSectionId={addPanelSectionId}
        availableMetricKeys={availableWorkspaceMetrics}
        canControlRuns={canControlRuns}
        onAddPanel={onAddPanel}
        onAddSection={onAddSection}
        onClearFilters={onClearFilters}
        onColumnsOpen={onColumnsOpen}
        onDuplicatePanel={onDuplicatePanel}
        onEditPanel={onEditPanel}
        onFullscreenPanel={onFullscreenPanel}
        onInspectRun={onInspectRun}
        onOpenRun={onOpenRun}
        onMode={onMode}
        onMovePanel={onMovePanel}
        onPanelSearch={onPanelSearch}
        onRefresh={onRefresh}
        onRemovePanel={onRemovePanel}
        onRequestStop={onRequestStop}
        onResetWorkspace={onResetWorkspace}
        onResizePanel={onResizePanel}
        onPanelSmoothing={onPanelSmoothing}
        onRunRailCollapsed={onRunRailCollapsed}
        onSelectAllMatching={onSelectAllMatching}
        onClearSelection={onClearSelection}
        onSelectAllVisible={onSelectAllVisible}
        onSetAddPanelSection={onSetAddPanelSection}
        onTableColumns={onTableColumns}
        onToggleRun={onToggleRun}
        onToggleSection={onToggleSection}
        metricKey={metricKey}
        selectAllMatchingBusy={selectAllMatchingBusy}
        selectAllMatchingDisabled={selectAllMatchingDisabled}
        hasNextPage={hasNextPage}
        hasPreviousPage={hasPreviousPage}
        initialLoadDone={initialLoadDone}
        onGoToPage={onGoToPage}
        onNextPage={onNextPage}
        onPageSize={onPageSize}
        onPreviousPage={onPreviousPage}
        paginationBusy={paginationBusy}
        pageEnd={pageEnd}
        pageSize={pageSize}
        pageStart={pageStart}
        panelSearch={panelSearch}
        runSearch={queryInput}
        runRailCollapsed={runsRailCollapsed}
        selectedRunIds={selectedRunIds}
        showAddPanelDrawer={Boolean(addPanelSectionId)}
        summaryTotal={summaryTotal}
        tableColumns={tableColumns}
        view={workspaceView}
        workspaceHistogramTimelines={workspaceHistogramTimelines}
        workspacePanelRuns={workspacePanelRuns}
        workspaceRuns={sortedRuns}
        workspaceSeries={workspaceSeries}
      />
      )}
      </>
      {editingPanelContext ? (
        <PanelEditDrawer
          categoricalFieldOptions={workspaceCategoricalFieldOptions}
          fieldOptions={workspaceFieldOptions}
          metricOptions={allMetricOptions}
          onClose={onCloseEditingPanel}
          onUpdate={onUpdateEditingPanel}
          panel={editingPanelContext.panel}
          section={editingPanelContext.section}
          view={workspaceView}
        />
      ) : null}
      {fullscreenPanelContext ? (
        <div
          className="workspace-modal fullscreen-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${fullscreenPanelContext.panel.title} fullscreen`}
          ref={fullscreenModalRef}
          tabIndex={-1}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
              event.stopPropagation();
              onFullscreenPanelClose();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onFullscreenPanelClose();
          }}
        >
          <div className="workspace-modal-card fullscreen-modal-card">
            <div className="drawer-head">
              <div className="fullscreen-title-block">
                <h2>{fullscreenPanelContext.panel.title}</h2>
                <span>{fullscreenPanelSubtitle} · {fullscreenPanelContext.section.name} · {fullscreenPanelIndex + 1} of {fullscreenPanelOrder.length}</span>
              </div>
              <div className="fullscreen-nav-actions">
                <button
                  aria-label="Previous fullscreen panel"
                  className="icon-button"
                  disabled={fullscreenPanelIndex <= 0}
                  onClick={() => onFullscreenPanelMove(-1)}
                  title="Previous panel"
                  type="button"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  aria-label="Next fullscreen panel"
                  className="icon-button"
                  disabled={fullscreenPanelIndex < 0 || fullscreenPanelIndex >= fullscreenPanelOrder.length - 1}
                  onClick={() => onFullscreenPanelMove(1)}
                  title="Next panel"
                  type="button"
                >
                  <ChevronRight size={16} />
                </button>
                <button className="icon-button" type="button" aria-label="Close fullscreen panel" onClick={onFullscreenPanelClose}><X size={16} /></button>
              </div>
            </div>
            <WorkspacePanelCard
              className="fullscreen-panel-card"
              onSmoothingChange={(smoothing) => onPanelSmoothing(fullscreenPanelContext.section.id, fullscreenPanelContext.panel.id, smoothing)}
              panel={fullscreenPanelContext.panel}
              section={fullscreenPanelContext.section}
              selectedRunIds={selectedRunIds}
              view={workspaceView}
              workspaceHistogramTimelines={workspaceHistogramTimelines}
              workspacePanelRuns={workspacePanelRuns}
              workspaceSeries={workspaceSeries}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
