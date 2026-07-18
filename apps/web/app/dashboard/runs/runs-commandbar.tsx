"use client";

import { Archive, ChevronDown, Columns3, Download, LayoutGrid, RefreshCw, RotateCcw, Search, SlidersHorizontal, Square, Table2, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

import { shortMetricName } from "../../dashboard-models";
import { DebouncedTextInput } from "../components/debounced-text-input";
import { SegmentedToggle } from "../components/segmented-toggle";
import { CustomSelect } from "../ui/select";
import type { TableColumns } from "../../dashboard-types";

export type RunsViewMode = "panels" | "table";

// Keys are persisted (TableColumns); labels track the parity table columns
// each key now controls: notes drives Owner, duration drives Step.
const tableColumnLabels: Array<[keyof TableColumns, string]> = [
  ["status", "Status"],
  ["tags", "Tags"],
  ["notes", "Owner"],
  ["started", "Started"],
  ["duration", "Step"],
  ["latest", "Metric"],
];

export function RunsCommandbar({
  exportSelectedBusy,
  metricKey,
  metricOptions,
  onExportSelectedRuns,
  onMetricKey,
  onRefresh,
  onRequestSelectedLifecycle,
  onRequestSelectedStop,
  onViewMode,
  selectedRunCount,
  selectedRunExportDisabled,
  selectedRunExportTitle,
  selectedLifecycleCandidateCounts = { archive: 0, delete: 0, restore: 0 },
  selectedStopCandidateCount = 0,
  selectedStopDisabledReason = "",
  viewMode,
}: {
  exportSelectedBusy: boolean;
  metricKey: string;
  metricOptions: string[];
  onExportSelectedRuns: () => void;
  onMetricKey: (value: string) => void;
  onRefresh: () => void;
  onRequestSelectedLifecycle?: (action: "archive" | "restore" | "delete") => void;
  onRequestSelectedStop?: () => void;
  onViewMode: (view: RunsViewMode) => void;
  selectedRunCount: number;
  selectedRunExportDisabled: boolean;
  selectedRunExportTitle: string;
  selectedLifecycleCandidateCounts?: { archive: number; restore: number; delete: number };
  selectedStopCandidateCount?: number;
  selectedStopDisabledReason?: string;
  viewMode: RunsViewMode;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const exportHelpId = "selected-runs-export-help";
  const stopHelpId = "selected-runs-stop-help";

  useEffect(() => {
    if (!actionsOpen) return undefined;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && actionsMenuRef.current?.contains(target)) return;
      setActionsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActionsOpen(false);
        actionsTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  return (
    <div className="runs-commandbar">
      <CustomSelect
        className="command-select metric-command"
        disabled={!metricOptions.length}
        id="runs-metric-select"
        label="Metric"
        labelClassName="command-label"
        onChange={onMetricKey}
        options={metricOptions.length ? metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
        value={metricOptions.length ? metricKey : ""}
      />
      <div className="command-spacer" />
      <SegmentedToggle
        ariaLabel="Runs view"
        className="runs-view-switch"
        onChange={onViewMode}
        options={[
          { value: "panels", label: "Panels", icon: LayoutGrid, title: "Run selector with chart panels" },
          { value: "table", label: "Table", icon: Table2, title: "Flat sortable runs table" },
        ]}
        value={viewMode}
      />
      <div className="runs-actions-menu" ref={actionsMenuRef}>
        <button
          aria-controls="runs-actions-popover"
          aria-expanded={actionsOpen}
          aria-haspopup="dialog"
          className="secondary compact-button runs-actions-trigger"
          onClick={() => setActionsOpen((open) => !open)}
          ref={actionsTriggerRef}
          type="button"
        >
          <SlidersHorizontal size={15} /> Runs actions <ChevronDown size={12} aria-hidden="true" />
        </button>
        {actionsOpen ? (
          <div className="runs-actions-popover" id="runs-actions-popover" role="dialog" aria-label="Runs actions">
            <button
              aria-label={selectedRunCount ? `Export ${selectedRunCount} selected runs as CSV` : "Export selected runs as CSV"}
              aria-disabled={selectedRunExportDisabled || undefined}
              aria-describedby={exportHelpId}
              className="secondary compact-button export-selected-runs-button"
              disabled={selectedRunExportDisabled || exportSelectedBusy}
              onClick={() => {
                setActionsOpen(false);
                onExportSelectedRuns();
              }}
              title={selectedRunExportTitle}
              type="button"
            >
              <Download size={15} /> {exportSelectedBusy ? "Exporting" : "Export CSV"}
            </button>
            {selectedRunExportDisabled ? <span className="export-selected-runs-help">{selectedRunExportTitle}</span> : null}
            {onRequestSelectedStop ? (
              <>
                <button
                  aria-describedby={!selectedStopCandidateCount && selectedStopDisabledReason ? stopHelpId : undefined}
                  aria-label={selectedStopCandidateCount ? `Review stop request for ${selectedStopCandidateCount} selected runs` : selectedStopDisabledReason || "No selected running runs can be stopped"}
                  className="secondary compact-button stop-selected-runs-button"
                  disabled={!selectedStopCandidateCount}
                  onClick={() => {
                    setActionsOpen(false);
                    onRequestSelectedStop();
                  }}
                  title={selectedStopCandidateCount ? `Review stop request for ${selectedStopCandidateCount} selected runs` : selectedStopDisabledReason || "Select running runs that are not already stopping."}
                  type="button"
                >
                  <Square size={15} /> Review stop{selectedStopCandidateCount === 1 ? " request" : " requests"}{selectedStopCandidateCount ? ` ${selectedStopCandidateCount}` : ""}
                </button>
                {!selectedStopCandidateCount && selectedStopDisabledReason ? <span className="stop-selected-runs-help">{selectedStopDisabledReason}</span> : null}
              </>
            ) : null}
            {onRequestSelectedLifecycle ? (
              <>
                <button
                  aria-label={selectedLifecycleCandidateCounts.archive ? `Archive ${selectedLifecycleCandidateCounts.archive} selected runs` : "No selected active runs can be archived"}
                  className="secondary compact-button lifecycle-selected-runs-button"
                  disabled={!selectedLifecycleCandidateCounts.archive}
                  onClick={() => {
                    setActionsOpen(false);
                    onRequestSelectedLifecycle("archive");
                  }}
                  title={selectedLifecycleCandidateCounts.archive ? `Archive ${selectedLifecycleCandidateCounts.archive} selected runs` : "Select active runs to archive."}
                  type="button"
                >
                  <Archive size={15} /> Archive{selectedLifecycleCandidateCounts.archive ? ` ${selectedLifecycleCandidateCounts.archive}` : ""}
                </button>
                <button
                  aria-label={selectedLifecycleCandidateCounts.restore ? `Restore ${selectedLifecycleCandidateCounts.restore} selected archived runs` : "No selected archived runs can be restored"}
                  className="secondary compact-button lifecycle-selected-runs-button"
                  disabled={!selectedLifecycleCandidateCounts.restore}
                  onClick={() => {
                    setActionsOpen(false);
                    onRequestSelectedLifecycle("restore");
                  }}
                  title={selectedLifecycleCandidateCounts.restore ? `Restore ${selectedLifecycleCandidateCounts.restore} selected archived runs` : "Select archived runs to restore."}
                  type="button"
                >
                  <RotateCcw size={15} /> Restore{selectedLifecycleCandidateCounts.restore ? ` ${selectedLifecycleCandidateCounts.restore}` : ""}
                </button>
                <button
                  aria-label={selectedLifecycleCandidateCounts.delete ? `Delete ${selectedLifecycleCandidateCounts.delete} selected runs` : "No selected runs can be deleted"}
                  className="secondary compact-button lifecycle-selected-runs-button danger"
                  disabled={!selectedLifecycleCandidateCounts.delete}
                  onClick={() => {
                    setActionsOpen(false);
                    onRequestSelectedLifecycle("delete");
                  }}
                  title={selectedLifecycleCandidateCounts.delete ? `Delete ${selectedLifecycleCandidateCounts.delete} selected runs` : "Select active or archived runs to delete."}
                  type="button"
                >
                  <Trash2 size={15} /> Delete{selectedLifecycleCandidateCounts.delete ? ` ${selectedLifecycleCandidateCounts.delete}` : ""}
                </button>
              </>
            ) : null}
            <button className="secondary compact-button" type="button" aria-label="Refresh runs" onClick={() => { setActionsOpen(false); onRefresh(); }}><RefreshCw size={15} /> Refresh runs</button>
          </div>
        ) : null}
      </div>
      <span className="visually-hidden" id={exportHelpId}>{selectedRunExportTitle}</span>
      {selectedStopDisabledReason ? <span className="visually-hidden" id={stopHelpId}>{selectedStopDisabledReason}</span> : null}
    </div>
  );
}

export function RunsColumnsMenu({
  columnsOpen,
  onColumnsOpen,
  onPinnedMetric,
  onPinnedMetricFilter,
  onTableColumns,
  pinnedMetricFilter,
  pinnedMetricFilterValid,
  pinnedMetricOptions,
  pinnedMetrics,
  tableColumns,
}: {
  columnsOpen: boolean;
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onPinnedMetric: (metric: string) => void;
  onPinnedMetricFilter: (value: string) => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  pinnedMetricFilter: string;
  pinnedMetricFilterValid: boolean;
  pinnedMetricOptions: string[];
  pinnedMetrics: string[];
  tableColumns: TableColumns;
}) {
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  const columnsTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!columnsOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && columnsMenuRef.current?.contains(target)) return;
      onColumnsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onColumnsOpen(false);
        columnsTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [columnsOpen, onColumnsOpen]);

  return (
    <div className="columns-menu" ref={columnsMenuRef}>
      <button className="secondary compact-button" type="button" aria-expanded={columnsOpen} aria-controls="columns-popover" onClick={() => onColumnsOpen((current) => !current)} ref={columnsTriggerRef}><Columns3 size={15} /> Columns</button>
      {columnsOpen ? (
        <div className="column-popover" id="columns-popover">
          <strong>Visible columns</strong>
          {tableColumnLabels.map(([key, label]) => (
            <label key={key}>
              <input
                aria-label={`Show ${label} column`}
                checked={tableColumns[key]}
                onChange={(event) => onTableColumns((current) => ({ ...current, [key]: event.target.checked }))}
                type="checkbox"
              />
              {label}
            </label>
          ))}
          <strong>Pinned metrics</strong>
          <label className={`metric-filter-row ${pinnedMetricFilterValid ? "" : "invalid"}`}>
            <Search size={13} />
            {/* Draft state stays inside DebouncedTextInput so typing doesn't
                re-render the shell (and the mounted runs table) per keystroke. */}
            <DebouncedTextInput aria-label="Pinned metric filter" id="column-metric-filter" type="search" value={pinnedMetricFilter} onCommit={onPinnedMetricFilter} placeholder="metric regex" />
          </label>
          {pinnedMetricOptions.slice(0, 8).map((metric) => (
            <label key={metric} title={metric}>
              <input
                aria-label={`Pin ${metric}`}
                checked={pinnedMetrics.includes(metric)}
                onChange={() => onPinnedMetric(metric)}
                type="checkbox"
              />
              {shortMetricName(metric)}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
