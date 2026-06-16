"use client";

import { ChevronDown, Columns3, Download, RefreshCw, Search, SlidersHorizontal, Square } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

import { shortMetricName } from "../../dashboard-models";
import { CustomSelect } from "../ui/select";
import type { TableColumns } from "../../dashboard-types";

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
  columnsOpen,
  exportSelectedBusy,
  metricKey,
  metricOptions,
  onColumnsOpen,
  onExportSelectedRuns,
  onMetricKey,
  onPinnedMetricFilter,
  onPinnedMetric,
  onRefresh,
  onRequestSelectedStop,
  onTableColumns,
  pinnedMetricFilter,
  pinnedMetricFilterValid,
  pinnedMetricOptions,
  pinnedMetrics,
  selectedRunCount,
  selectedRunExportDisabled,
  selectedRunExportTitle,
  selectedStopCandidateCount = 0,
  selectedStopDisabledReason = "",
  tableColumns,
}: {
  columnsOpen: boolean;
  exportSelectedBusy: boolean;
  metricKey: string;
  metricOptions: string[];
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onExportSelectedRuns: () => void;
  onMetricKey: (value: string) => void;
  onPinnedMetricFilter: (value: string) => void;
  onPinnedMetric: (metric: string) => void;
  onRefresh: () => void;
  onRequestSelectedStop?: () => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  pinnedMetricFilter: string;
  pinnedMetricFilterValid: boolean;
  pinnedMetricOptions: string[];
  pinnedMetrics: string[];
  selectedRunCount: number;
  selectedRunExportDisabled: boolean;
  selectedRunExportTitle: string;
  selectedStopCandidateCount?: number;
  selectedStopDisabledReason?: string;
  tableColumns: TableColumns;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  const columnsTriggerRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (!actionsOpen) onColumnsOpen(false);
  }, [actionsOpen, onColumnsOpen]);

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
                    <input aria-label="Pinned metric filter" id="column-metric-filter" type="search" value={pinnedMetricFilter} onChange={(event) => onPinnedMetricFilter(event.target.value)} placeholder="metric regex" />
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
            <button className="secondary compact-button" type="button" aria-label="Refresh runs" onClick={() => { setActionsOpen(false); onRefresh(); }}><RefreshCw size={15} /> Refresh runs</button>
          </div>
        ) : null}
      </div>
      <span className="visually-hidden" id={exportHelpId}>{selectedRunExportTitle}</span>
      {selectedStopDisabledReason ? <span className="visually-hidden" id={stopHelpId}>{selectedStopDisabledReason}</span> : null}
    </div>
  );
}
