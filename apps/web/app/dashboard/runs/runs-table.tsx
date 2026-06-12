"use client";

import { Star } from "lucide-react";

import { bestMetric, durationLabel, formatNumber, statusTone } from "../../../src/state.js";
import { formatRunTime, runConfigSummary, runNoteText, shortMetricName } from "../../dashboard-models";
import type { RunSummary, TableColumns } from "../../dashboard-types";

function Chips({ values }: { values: string[] }) {
  return (
    <div className="chips">
      {values.map((value) => <span className="chip" title={value} key={value}>{value}</span>)}
    </div>
  );
}

export function RunsTable({
  columns,
  metricKey,
  onClearFilters,
  onInspectRun,
  onOpenRun,
  onToggleRun,
  pinnedMetrics,
  primaryRunId,
  runs,
  selectedRunIds,
}: {
  columns: TableColumns;
  metricKey: string;
  onClearFilters: () => void;
  onInspectRun: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onToggleRun: (runId: string) => void;
  pinnedMetrics: string[];
  primaryRunId: string;
  runs: RunSummary[];
  selectedRunIds: string[];
}) {
  const visibleColumnCount = 2 + Object.values(columns).filter(Boolean).length + pinnedMetrics.length;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="col-select" aria-label="Compare selection" />
            <th className="col-run">Run</th>
            {columns.status ? <th className="col-status">Status</th> : null}
            {columns.tags ? <th className="col-tags">Tags</th> : null}
            {columns.notes ? <th className="col-notes">Notes</th> : null}
            {columns.started ? <th className="col-started">Started</th> : null}
            {columns.duration ? <th className="col-duration">Dur.</th> : null}
            {columns.latest ? <th className="col-latest" id="table-metric-label" title={metricKey}>Latest {shortMetricName(metricKey)}</th> : null}
            {pinnedMetrics.map((metric) => <th className="col-pinned" key={metric} title={metric}>{shortMetricName(metric)}</th>)}
          </tr>
        </thead>
        <tbody>
          {runs.length ? runs.map((run) => {
            const selected = selectedRunIds.includes(run.id);
            const inspected = run.id === primaryRunId;
            const note = runNoteText(run);
            return (
              <tr key={run.id} className={`${selected ? "selected" : ""} ${inspected ? "inspected" : ""}`}>
                <td className="col-select">
                  <label className="row-check">
                    <input
                      aria-label={`Include ${run.name} in comparison`}
                      checked={selected}
                      onChange={() => onToggleRun(run.id)}
                      type="checkbox"
                    />
                  </label>
                </td>
                <td className="col-run">
                  <div className="run-name">
                    <button className="run-name-button" aria-label={`Open ${run.name}`} onClick={() => { onInspectRun(run.id); onOpenRun(run.id); }} type="button">
                      <Star size={13} /> {run.name}
                    </button>
                    <small>{run.project} · {runConfigSummary(run)}</small>
                  </div>
                </td>
                {columns.status ? <td className="col-status"><span className={`pill ${statusTone(run.status)}`}>{run.status}</span></td> : null}
                {columns.tags ? <td className="col-tags"><Chips values={run.tags} /></td> : null}
                {columns.notes ? <td className="col-notes"><span className="note-preview" title={note}>{note || "-"}</span></td> : null}
                {columns.started ? <td className="col-started">{formatRunTime(run.started_at ?? run.created_at)}</td> : null}
                {columns.duration ? <td className="col-duration">{durationLabel(run)}</td> : null}
                {columns.latest ? <td className="col-latest">{formatNumber(bestMetric(run, metricKey), 2)}</td> : null}
                {pinnedMetrics.map((metric) => <td className="col-pinned" key={`${run.id}-${metric}`}>{formatNumber(bestMetric(run, metric), 2)}</td>)}
              </tr>
            );
          }) : (
            <tr className="empty-row">
              <td colSpan={visibleColumnCount}>
                <div className="table-empty">
                  <strong>No runs match the current filters.</strong>
                  <span>Clear search, project, and status filters to return to the run list.</span>
                  <button className="secondary compact-button" type="button" onClick={onClearFilters}>Clear filters</button>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
