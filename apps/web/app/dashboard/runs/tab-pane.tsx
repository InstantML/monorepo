import type { Dispatch, RefObject, SetStateAction } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { EmptyWorkspaceSnippet } from "../components/empty-workspace-snippet";
import { PageHead } from "../ui/page-head";
import { PanelEditDrawer } from "./panel-edit-drawer";
import { RunsCommandbar } from "./runs-commandbar";
import { RunsWorkspace } from "./runs-workspace";
import { Stats } from "./runs-stats";
import { WorkspacePanelCard } from "./workspace-panel-card";
import { formatNumber } from "../../../src/state.js";
import type { Overview, RunSummary, TableColumns, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceView } from "../../dashboard-types";
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
  columnMetricFilter: string;
  columnMetricFilterValid: boolean;
  columnMetricOptionsForControls: string[];
  columnsOpen: boolean;
  dashboardLoading: boolean;
  editingPanelContext: EditingPanelContext;
  fullscreenModalRef: RefObject<HTMLDivElement | null>;
  fullscreenPanelContext: FullscreenPanelContext;
  fullscreenPanelIndex: number;
  fullscreenPanelOrder: Array<{ sectionId: string; panelId: string; title: string }>;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  initialLoadDone: boolean;
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
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onCloseEditingPanel: () => void;
  onFullscreenPanelClose: () => void;
  onFullscreenPanelMove: (direction: -1 | 1) => void;
  onInspectRun: (runId: string) => void;
  onMode: (mode: "automatic" | "manual") => void;
  onMovePanel: (sourceSectionId: string, panelId: string, targetSectionId: string, targetIndex: number) => void;
  onNextPage: () => void;
  onOpenRun: (id: string) => void;
  onPageSize: (size: number) => void;
  onPanelSearch: (search: string) => void;
  onPinnedMetric: (metric: string) => void;
  onPreviousPage: () => void;
  onRefresh: () => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onResetWorkspace: () => void;
  onResizePanel: (sectionId: string, panelId: string, layout: WorkspacePanelLayout) => void;
  onRunRailCollapsed: (collapsed: boolean) => void;
  onSelectAllMatching: () => void;
  onSelectAllVisible: () => void;
  onSetAddPanelSection: (sectionId: string) => void;
  onSwitchOrganization: (orgId: string) => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  onToggleRun: (runId: string, options?: { shift?: boolean }) => void;
  onToggleSection: (sectionId: string) => void;
  onUpdateEditingPanel: (patch: { title?: string; type?: WorkspacePanelType; metricKey?: string; settings?: Partial<WorkspacePanelSettings> }) => void;
  orgMemberships: OrgMembershipSummary[];
  orgName: string;
  orgSwitchBusy: boolean;
  overview: Overview;
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
  sortedRuns: RunSummary[];
  status: string;
  summaryTotal: number;
  tableColumns: TableColumns;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
  workspaceView: WorkspaceView;
};

export function RunsTabPane({
  addPanelSectionId,
  allMetricOptions,
  availableWorkspaceMetrics,
  columnMetricFilter,
  columnMetricFilterValid,
  columnMetricOptionsForControls,
  columnsOpen,
  dashboardLoading,
  editingPanelContext,
  fullscreenModalRef,
  fullscreenPanelContext,
  fullscreenPanelIndex,
  fullscreenPanelOrder,
  hasNextPage,
  hasPreviousPage,
  initialLoadDone,
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
  onFullscreenPanel,
  onFullscreenPanelClose,
  onFullscreenPanelMove,
  onInspectRun,
  onMode,
  onMovePanel,
  onNextPage,
  onOpenRun,
  onPageSize,
  onPanelSearch,
  onPinnedMetric,
  onPreviousPage,
  onRefresh,
  onRemovePanel,
  onResetWorkspace,
  onResizePanel,
  onRunRailCollapsed,
  onSelectAllMatching,
  onSelectAllVisible,
  onSetAddPanelSection,
  onSwitchOrganization,
  onTableColumns,
  onToggleRun,
  onToggleSection,
  onUpdateEditingPanel,
  orgMemberships,
  orgName,
  orgSwitchBusy,
  overview,
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
  sortedRuns,
  status,
  summaryTotal,
  tableColumns,
  workspacePanelRuns,
  workspaceSeries,
  workspaceView,
}: Props) {
  const showEmptyCallout = initialLoadDone && !dashboardLoading && summaryTotal === 0 && projects.length === 0 && !project && !query && !status;
  const nonCurrentMemberships = orgMemberships.filter((m) => !m.is_current);

  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Runs"
        emphasis="in flight"
        lede={`${project || "All projects"} · ${metricKey}`}
      />
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
      <div className="runs-workspace-filter">
        <Stats overview={overview} metricKey={metricKey} />
        <RunsCommandbar
          columnsOpen={columnsOpen}
          metricKey={metricKey}
          metricOptions={metricOptionsForControls}
          onColumnsOpen={onColumnsOpen}
          onMetricKey={onChangeMetricKey}
          onPinnedMetricFilter={onColumnMetricFilter}
          onPinnedMetric={onPinnedMetric}
          onRefresh={onRefresh}
          onTableColumns={onTableColumns}
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
        onResetWorkspace={onResetWorkspace}
        onResizePanel={onResizePanel}
        onRunRailCollapsed={onRunRailCollapsed}
        onSelectAllMatching={onSelectAllMatching}
        onSelectAllVisible={onSelectAllVisible}
        onSetAddPanelSection={onSetAddPanelSection}
        onTableColumns={onTableColumns}
        onToggleRun={onToggleRun}
        onToggleSection={onToggleSection}
        selectAllMatchingBusy={selectAllMatchingBusy}
        selectAllMatchingDisabled={selectAllMatchingDisabled}
        hasNextPage={hasNextPage}
        hasPreviousPage={hasPreviousPage}
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
        workspacePanelRuns={workspacePanelRuns}
        workspaceRuns={sortedRuns}
        workspaceSeries={workspaceSeries}
      />
      {editingPanelContext ? (
        <PanelEditDrawer
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
                <span>{fullscreenPanelContext.panel.metricKey ?? "Metric"} · {fullscreenPanelContext.section.name} · {fullscreenPanelIndex + 1} of {fullscreenPanelOrder.length}</span>
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
  );
}
