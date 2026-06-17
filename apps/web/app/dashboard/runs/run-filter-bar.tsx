"use client";

import { ChevronDown, CircleHelp, Download, RefreshCw, Save, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CustomSelect } from "../ui/select";
import type { SelectOption } from "../ui/select";
import type { Overview } from "../../dashboard-types";

type RunSearchError = {
  message: string;
  position: number | null;
} | null;

function countSuffix(count: number) {
  return ` (${new Intl.NumberFormat("en-US").format(Math.max(0, count))})`;
}

// The run filter row (status / search / sort / active-filter chips / status
// message / saved-view actions). It lives inside the Runs tab — project scope is
// a global control in the topbar, so it is not repeated here. Status/search/sort
// narrow the run list; the chips summarize and clear active filters.
export function RunFilterBar({
  overview,
  status,
  onStatus,
  query,
  onQuery,
  sortBy,
  onSortBy,
  project,
  onProject,
  searchError,
  searchErrorStale,
  savedViews,
  savedViewKey,
  viewName,
  onViewName,
  onSaveView,
  canSaveView,
  onExportSavedView,
  onImportSavedView,
  onDeleteSavedView,
  canExportSavedView,
  canDeleteSavedView,
  onApplySavedView,
  onClearFilters,
  onRefresh,
  message,
  tone,
}: {
  overview: Overview;
  status: string;
  onStatus: (status: string) => void;
  query: string;
  onQuery: (value: string) => void;
  sortBy: string;
  onSortBy: (value: string) => void;
  project: string;
  onProject: (project: string) => void;
  searchError: RunSearchError;
  searchErrorStale: boolean;
  savedViews: SelectOption[];
  savedViewKey: string;
  viewName: string;
  onViewName: (value: string) => void;
  onSaveView: () => void;
  canSaveView: boolean;
  onExportSavedView: () => void;
  onImportSavedView: () => void;
  onDeleteSavedView: () => void;
  canExportSavedView: boolean;
  canDeleteSavedView: boolean;
  onApplySavedView: (key: string) => void;
  onClearFilters: () => void;
  onRefresh: () => void;
  message: string;
  tone: "error" | "loading" | "ok";
}) {
  const [searchHelpOpen, setSearchHelpOpen] = useState(false);
  const [viewActionsOpen, setViewActionsOpen] = useState(false);
  const searchHelpRef = useRef<HTMLDivElement>(null);
  const viewActionsRef = useRef<HTMLDivElement>(null);
  const viewActionsTriggerRef = useRef<HTMLButtonElement>(null);

  const showStatusCounts = !status;
  const stoppingRuns = Number(overview.stopping_runs ?? 0);
  const stoppedRuns = Number(overview.stopped_runs ?? 0);
  const runningRuns = Math.max(0, overview.active_runs - stoppingRuns);
  const failedRuns = Math.max(0, overview.failed_runs - stoppedRuns);
  const finishedRuns = Math.max(0, overview.total_runs - runningRuns - failedRuns - stoppingRuns - stoppedRuns);
  const statusOptions: SelectOption[] = [
    { value: "", label: `All${showStatusCounts ? countSuffix(overview.total_runs) : ""}` },
    { value: "running", label: `Running${showStatusCounts ? countSuffix(runningRuns) : ""}` },
    { value: "stopping", label: `Stopping${showStatusCounts ? countSuffix(stoppingRuns) : ""}` },
    { value: "finished", label: `Finished${showStatusCounts ? countSuffix(finishedRuns) : ""}` },
    { value: "failed", label: `Failed${showStatusCounts ? countSuffix(failedRuns) : ""}` },
    { value: "stopped", label: `Stopped${showStatusCounts ? countSuffix(stoppedRuns) : ""}` },
  ];
  const searchErrorPositionSuffix = searchError?.position !== null && searchError?.position !== undefined && !/\bcol(?:umn)?\s+\d+\b/i.test(searchError.message)
    ? ` Column ${searchError.position}.`
    : "";
  const searchErrorText = searchError ? `${searchError.message}${searchErrorPositionSuffix}` : "";
  const searchErrorHelp = "Try tag:baseline status:finished, name:\"long context\", or -tag:debug.";
  const activeFilters = [
    project ? { key: "project", label: `Project: ${project}`, onClear: () => onProject("") } : null,
    status ? { key: "status", label: `Status: ${status}`, onClear: () => onStatus("") } : null,
    query.trim() ? { key: "search", label: `Search: ${query.trim()}`, onClear: () => onQuery("") } : null,
    sortBy !== "created" ? { key: "sort", label: `Sort: ${sortBy.replace("-", " ")}`, onClear: () => onSortBy("created") } : null,
  ].filter((item): item is { key: string; label: string; onClear: () => void } => Boolean(item));
  const filterSummaryLabel = activeFilters.length
    ? activeFilters.map((filter) => filter.label).join(", ")
    : "No active run filters";

  useEffect(() => {
    if (!searchHelpOpen) return undefined;
    function closeFromOutside(event: globalThis.PointerEvent) {
      if (!searchHelpRef.current?.contains(event.target as Node)) setSearchHelpOpen(false);
    }
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setSearchHelpOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [searchHelpOpen]);

  useEffect(() => {
    if (!viewActionsOpen) return undefined;
    function closeFromOutside(event: globalThis.PointerEvent) {
      if (!viewActionsRef.current?.contains(event.target as Node)) setViewActionsOpen(false);
    }
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setViewActionsOpen(false);
        viewActionsTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [viewActionsOpen]);

  return (
    <div className="workbar runs-filterbar" role="toolbar" aria-label="Run filters">
      <CustomSelect
        id="status-filter"
        label="Status"
        value={status}
        onChange={onStatus}
        options={statusOptions}
      />
      <span className="workbar-divider" aria-hidden="true" />
      <div
        className={`workbar-search-group ${searchError ? "has-error" : ""} ${searchErrorStale ? "stale-error" : ""}`}
        ref={searchHelpRef}
      >
        <label className="workbar-search">
          <Search size={13} />
          <input
            aria-describedby={`run-search-help-note${searchError && !searchErrorStale ? " run-search-error" : ""}`}
            aria-invalid={Boolean(searchError && !searchErrorStale)}
            id="search"
            onChange={(event) => onQuery(event.target.value)}
            placeholder="runs, tags, notes, config"
            type="search"
            value={query}
            aria-label="Search runs"
          />
        </label>
        <button
          aria-controls="run-search-help"
          aria-expanded={searchHelpOpen}
          aria-label="Run search syntax"
          className="icon-button workbar-search-help"
          onClick={() => setSearchHelpOpen((open) => !open)}
          title="Run search syntax"
          type="button"
        >
          <CircleHelp size={14} />
        </button>
        <span className="visually-hidden" id="run-search-help-note">
          Search supports bare text, field filters, uppercase boolean operators, quoted phrases, and explicit regex.
        </span>
        {searchHelpOpen ? (
          <div className="workbar-search-popover" id="run-search-help" role="note" aria-label="Run search syntax">
            <strong>Run search</strong>
            <code>reward stability</code>
            <code>tag:baseline status:finished</code>
            <code>name:"long context" -tag:debug</code>
            <code>(tag:baseline OR tag:candidate) notes:ablated</code>
            <code>re:/seed-(13|14)/</code>
            <span>Fields: all, name, project, notes, config, metadata, tag/tags, status, id.</span>
          </div>
        ) : null}
        {searchError ? (
          <span
            className="workbar-search-error"
            id="run-search-error"
            role="status"
            aria-live="polite"
            title={`${searchErrorText} ${searchErrorHelp}`}
          >
            <strong>{searchErrorText}</strong>
            <em>{searchErrorHelp}</em>
          </span>
        ) : null}
      </div>
      <CustomSelect
        className="compact"
        id="sort-select"
        label="Sort"
        onChange={onSortBy}
        options={[
          { value: "created", label: "Newest" },
          { value: "metric-latest", label: "Latest metric" },
          { value: "metric-best", label: "Best metric" },
          { value: "name", label: "Name" },
          { value: "status", label: "Status" },
          { value: "duration", label: "Duration" },
        ]}
        value={sortBy}
      />
      <div className="active-filter-strip" aria-label={filterSummaryLabel}>
        <span className="visually-hidden" role="status" aria-live="polite">{filterSummaryLabel}</span>
        <span className="active-filter-title">Filters</span>
        {activeFilters.length ? (
          activeFilters.map((filter) => (
            <button
              aria-label={`Clear ${filter.label}`}
              className="active-filter-chip"
              key={filter.key}
              onClick={filter.onClear}
              title={`Clear ${filter.label}`}
              type="button"
            >
              <span>{filter.label}</span>
              <X size={12} aria-hidden="true" />
            </button>
          ))
        ) : (
          <span className="active-filter-empty">All runs</span>
        )}
        {activeFilters.length ? (
          <button className="active-filter-reset" onClick={onClearFilters} type="button">
            Reset
          </button>
        ) : null}
        {searchError ? (
          <span
            className={`active-filter-error ${searchErrorStale ? "stale" : ""}`}
            aria-hidden="true"
            title={`${searchErrorText} ${searchErrorHelp}`}
          >
            <span>Fix search: {searchErrorText}</span>
            <em>Try tag:baseline status:finished</em>
          </span>
        ) : null}
      </div>
      <span className={`status-message ${tone}`} id="status-message" role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} tabIndex={-1} title={message}>{message}</span>
      <div className="workbar-spacer" />
      <div className="view-actions-menu" ref={viewActionsRef}>
        <button
          aria-controls="view-actions-popover"
          aria-expanded={viewActionsOpen}
          aria-haspopup="dialog"
          className="secondary compact-button view-actions-trigger"
          data-view-actions-trigger="true"
          onClick={() => setViewActionsOpen((open) => !open)}
          ref={viewActionsTriggerRef}
          type="button"
        >
          <Save size={14} /> View actions <ChevronDown size={12} aria-hidden="true" />
        </button>
        {viewActionsOpen ? (
          <div className="view-actions-popover" id="view-actions-popover" role="dialog" aria-label="Saved view actions">
            <label className="control compact view-actions-name">
              Name
              <input aria-label="Saved view name" id="view-name" value={viewName} onChange={(event) => onViewName(event.target.value)} placeholder="view name" />
            </label>
            <button className="primary-button" disabled={!canSaveView} id="save-view" title={canSaveView ? "Save view" : "Read only workspaces cannot save shared views"} type="button" onClick={onSaveView}><Save size={14} /> Save view</button>
            {!canSaveView ? <span className="view-actions-help">Read-only demo workspaces cannot save shared views.</span> : null}
            <CustomSelect
              className="compact"
              id="saved-view-select"
              label="View"
              menuAlign="right"
              onChange={onApplySavedView}
              options={[{ value: "", label: "Unsaved" }, ...savedViews]}
              value={savedViewKey}
            />
            <button className="secondary compact-button" type="button" aria-label="Refresh dashboard data" onClick={() => { setViewActionsOpen(false); onRefresh(); }}><RefreshCw size={14} /> Refresh data</button>
            <div className="view-actions-divider" aria-hidden="true" />
            <button className="secondary compact-button" disabled={!canExportSavedView} type="button" aria-label="Export saved view" title={canExportSavedView ? "Export saved view JSON" : "Select a shared saved view to export"} onClick={() => { setViewActionsOpen(false); onExportSavedView(); }}><Download size={14} /> Export JSON</button>
            <button className="secondary compact-button" disabled={!canSaveView} type="button" aria-label="Import saved view" title={canSaveView ? "Import saved view JSON" : "Read-only workspaces cannot import shared views"} onClick={() => { setViewActionsOpen(false); onImportSavedView(); }}><Upload size={14} /> Import JSON</button>
            <button className="secondary compact-button danger" disabled={!canDeleteSavedView} type="button" aria-label="Delete saved view" title={canDeleteSavedView ? "Delete saved view" : "Select a shared saved view to delete"} onClick={() => { setViewActionsOpen(false); onDeleteSavedView(); }}><Trash2 size={14} /> Delete view</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
