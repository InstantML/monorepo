"use client";

import { Square } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useMemo, useState } from "react";

import { bestMetric, canRequestStop, displayStatusForRun, formatMetricValue, formatNumber, metricGoal, visibleSelectionState } from "../../../src/state.js";
import { chartColor, stableChartIndex } from "../../../src/chart-colors.js";
import { formatRunTime, shortMetricName } from "../../dashboard-models";
import type { MetricSeries, RunSummary, TableColumns } from "../../dashboard-types";
import { RunsColumnsMenu } from "./runs-commandbar";

type GroupMode = "flat" | "tag" | "owner";

const SPARK_POINT_LIMIT = 26;

function runOwner(run: RunSummary) {
  const owner = run.metadata?.owner;
  return typeof owner === "string" && owner.trim() ? owner.trim() : "";
}

function runDotClass(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "running") return "run-dot--ok";
  if (normalized === "failed" || normalized === "error" || normalized === "crashed") return "run-dot--crit";
  if (normalized === "killed" || normalized === "stopping" || normalized === "stopped") return "run-dot--warn";
  if (normalized === "queued" || normalized === "pending") return "run-dot--queued";
  return "run-dot--idle";
}

function lossValue(run: RunSummary) {
  const metrics = run.latest_metrics ?? {};
  if (typeof metrics["train/loss"] === "number") return metrics["train/loss"];
  const key = Object.keys(metrics).find((candidate) => /(^|[/_])loss($|[/_])/i.test(candidate));
  return key !== undefined && typeof metrics[key] === "number" ? metrics[key] : null;
}

function latestStep(run: RunSummary, series: MetricSeries[] | undefined) {
  const points = series?.find((item) => item.id === run.id)?.points;
  const seriesStep = points?.length ? points[points.length - 1]?.step : null;
  if (typeof seriesStep === "number" && Number.isFinite(seriesStep)) return seriesStep;
  const aggregateSteps = Object.values(run.metric_aggregates ?? {})
    .map((aggregate) => aggregate?.best_step)
    .filter((step): step is number => typeof step === "number" && Number.isFinite(step));
  return aggregateSteps.length ? Math.max(...aggregateSteps) : null;
}

function totalSteps(run: RunSummary) {
  const raw = run.config?.total_steps;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Mockup formats run budgets as "40k"; keep odd budgets exact instead of lying.
function compactTotal(value: number) {
  if (value >= 1000) {
    const thousands = Math.round((value / 1000) * 10) / 10;
    return `${thousands}k`;
  }
  return value.toLocaleString("en-US");
}

function sparkValues(points: MetricSeries["points"] | undefined) {
  if (!points?.length) return [];
  const values = points.map((point) => point.value).filter((value) => Number.isFinite(value));
  if (values.length <= SPARK_POINT_LIMIT) return values;
  const stride = (values.length - 1) / (SPARK_POINT_LIMIT - 1);
  return Array.from({ length: SPARK_POINT_LIMIT }, (_, index) => values[Math.round(index * stride)]);
}

function TrendSpark({ color, live, values }: { color: string; live: boolean; values: number[] }) {
  if (values.length < 2) return <span className="td-dim">—</span>;
  const width = 64;
  const height = 18;
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = values.map((value, index) => [
    pad + (index * (width - pad * 2)) / (values.length - 1),
    height - pad - ((value - min) / span) * (height - pad * 2),
  ]);
  const path = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1];
  return (
    <svg aria-hidden="true" className="run-trend-spark" height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
      <path d={path} fill="none" style={{ stroke: color }} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} />
      {live ? <circle className="run-trend-live" cx={lastX} cy={lastY} r={2} style={{ fill: color }} /> : null}
    </svg>
  );
}

function RunTags({ values }: { values: string[] }) {
  if (!values.length) return <span className="td-dim">—</span>;
  return (
    <span className="run-tag-list">
      {values.slice(0, 3).map((value) => <span className="run-tag" key={value} title={value}>{value}</span>)}
      {values.length > 3 ? <span className="run-tag run-tag--more" title={values.slice(3).join(", ")}>+{values.length - 3}</span> : null}
    </span>
  );
}

// Reuse the shell's history-based router (popstate -> applyRouteTab) so the
// selection bar can open Compare/Metrics without new shell props. The current
// search string carries ?project= and the ?runs= selection mirror.
function navigateToTab(path: "/dashboard/compare" | "/dashboard/metrics") {
  window.history.pushState(null, "", path + window.location.search);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function RunsTable({
  canControlRuns,
  columns,
  columnsOpen,
  hasNextPage,
  hasPreviousPage,
  metricKey,
  onClearFilters,
  onClearSelection,
  onColumnsOpen,
  onInspectRun,
  onNextPage,
  onOpenRun,
  onPreviousPage,
  onPinnedMetric,
  onPinnedMetricFilter,
  onRequestStop,
  onSelectAllVisible,
  onTableColumns,
  onToggleRun,
  pageSize,
  pageStart,
  paginationBusy,
  pinnedMetricFilter,
  pinnedMetricFilterValid,
  pinnedMetricOptions,
  pinnedMetrics,
  primaryRunId,
  query,
  runs,
  selectedRunIds,
  status,
  summaryTotal,
  workspaceSeries,
}: {
  canControlRuns: boolean;
  columns: TableColumns;
  columnsOpen: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  metricKey: string;
  onClearFilters: () => void;
  onClearSelection: () => void;
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onInspectRun: (runId: string) => void;
  onNextPage: () => void;
  onOpenRun: (runId: string) => void;
  onPreviousPage: () => void;
  onPinnedMetric: (metric: string) => void;
  onPinnedMetricFilter: (value: string) => void;
  onRequestStop: (runIds: string[]) => void;
  onSelectAllVisible: () => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  onToggleRun: (runId: string) => void;
  pageSize: number;
  pageStart: number;
  paginationBusy: boolean;
  pinnedMetricFilter: string;
  pinnedMetricFilterValid: boolean;
  pinnedMetricOptions: string[];
  pinnedMetrics: string[];
  primaryRunId: string;
  query: string;
  runs: RunSummary[];
  selectedRunIds: string[];
  status: string;
  summaryTotal: number;
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const filteredRuns = runs;

  const metricSeries = workspaceSeries[metricKey];
  const goal = metricGoal(metricKey);
  const metricValues = filteredRuns
    .map((run) => bestMetric(run, metricKey))
    .filter((value): value is number => typeof value === "number");
  const viewBest = metricValues.length
    ? goal === "minimize" ? Math.min(...metricValues) : Math.max(...metricValues)
    : null;

  const groups = useMemo(() => {
    if (groupMode === "flat") return [{ key: "", runs: filteredRuns }];
    const buckets = new Map<string, RunSummary[]>();
    for (const run of filteredRuns) {
      const key = groupMode === "tag" ? run.tags[0] || "untagged" : runOwner(run) || "unassigned";
      const bucket = buckets.get(key);
      if (bucket) bucket.push(run);
      else buckets.set(key, [run]);
    }
    return Array.from(buckets, ([key, bucketRuns]) => ({ key, runs: bucketRuns }));
  }, [filteredRuns, groupMode]);

  // status/query come from the server-side filters above the view; the only
  // existing dropper is the shared clear-all, so each token routes there.
  const filterTokens = [
    ...(status ? [{ key: "status", value: status }] : []),
    ...(query ? [{ key: "query", value: query }] : []),
  ];

  const visibleRunIds = filteredRuns.map((run) => run.id);
  const selectionState = visibleSelectionState(selectedRunIds, visibleRunIds);
  const totalPages = Math.max(1, Math.ceil(Math.max(summaryTotal, runs.length) / Math.max(1, pageSize)));
  const currentPage = summaryTotal ? Math.floor((pageStart - 1) / Math.max(1, pageSize)) + 1 : 1;
  const visibleColumnCount = 5
    + (columns.status ? 1 : 0)
    + (columns.latest ? 1 : 0)
    + (columns.duration ? 1 : 0)
    + (columns.notes ? 1 : 0)
    + (columns.tags ? 1 : 0)
    + (columns.started ? 1 : 0)
    + pinnedMetrics.length;
  const runIndexById = new Map(runs.map((run, index) => [run.id, index]));

  function renderRunRow(run: RunSummary) {
    const selected = selectedRunIds.includes(run.id);
    const inspected = run.id === primaryRunId;
    const metricValue = bestMetric(run, metricKey);
    const isBest = typeof metricValue === "number" && viewBest !== null && metricValue === viewBest;
    const loss = lossValue(run);
    const step = latestStep(run, metricSeries);
    const total = totalSteps(run);
    const owner = runOwner(run);
    const displayStatus = displayStatusForRun(run);
    const running = run.status === "running";
    const canStopRun = canRequestStop(run, canControlRuns);
    const values = sparkValues(metricSeries?.find((item) => item.id === run.id)?.points);
    const sparkColor = running
      ? chartColor(stableChartIndex(run.id || run.name, runIndexById.get(run.id) ?? 0))
      : "var(--chart-tick)";
    return (
      <tr key={run.id} className={`${selected ? "selected" : ""} ${inspected ? "inspected" : ""}`}>
        <td className="col-check">
          <input
            aria-label={`Include ${run.name} in comparison`}
            checked={selected}
            className="cbx"
            onChange={() => onToggleRun(run.id)}
            type="checkbox"
          />
        </td>
        {columns.status ? (
          <td className="col-dot">
            <span className={`run-dot ${runDotClass(displayStatus)}`} role="img" aria-label={displayStatus} title={displayStatus} />
          </td>
        ) : null}
        <td className="td-name">
          <button
            aria-label={`Open ${run.name}`}
            className="run-name-button"
            onClick={() => { onInspectRun(run.id); onOpenRun(run.id); }}
            type="button"
          >
            {run.name}
          </button>
          <span className="run-id" title={run.id}>{run.id.slice(0, 8)}</span>
        </td>
        <td className="col-trend"><TrendSpark color={sparkColor} live={running} values={values} /></td>
        {columns.latest ? (
          <td className={`td-num ${isBest ? "is-best" : ""}`}>{typeof metricValue === "number" ? formatNumber(metricValue, 2) : "—"}</td>
        ) : null}
        <td className="td-num">{typeof loss === "number" ? formatMetricValue(loss, 3) : "—"}</td>
        {columns.duration ? (
          <td className="td-num">
            {typeof step === "number"
              ? <>{step.toLocaleString("en-US")}{total ? <span className="td-dim">/{compactTotal(total)}</span> : null}</>
              : "—"}
          </td>
        ) : null}
        {columns.notes ? <td className="td-owner">{owner || <span className="td-dim">—</span>}</td> : null}
        {columns.tags ? <td className="col-tags"><RunTags values={run.tags} /></td> : null}
        {columns.started ? <td className="td-num td-dim">{formatRunTime(run.started_at ?? run.created_at)}</td> : null}
        {pinnedMetrics.map((metric) => (
          <td className="td-num" key={`${run.id}-${metric}`}>{formatNumber(bestMetric(run, metric), 2)}</td>
        ))}
        <td className="col-stop">
          {canStopRun ? (
            <button
              aria-label={`Request stop for ${run.name}`}
              className="run-row-stop-button"
              onClick={() => onRequestStop([run.id])}
              title="Request stop"
              type="button"
            >
              <Square size={13} />
            </button>
          ) : null}
        </td>
      </tr>
    );
  }

  return (
    <div className="runs-table-panel">
      <div className="runs-tablebar">
        {filterTokens.map((token) => (
          <span className="query-token" key={token.key}>
            <b>{token.key}:</b>{token.value}
            <button
              aria-label={`Clear filters (removes ${token.key} filter)`}
              className="x"
              onClick={onClearFilters}
              title="Clears all run filters"
              type="button"
            >
              ×
            </button>
          </span>
        ))}
        <div className="seg" role="group" aria-label="Group runs">
          {([
            ["flat", "Flat"],
            ["tag", "Group: Tag"],
            ["owner", "Owner"],
          ] as Array<[GroupMode, string]>).map(([mode, label]) => (
            <button
              aria-pressed={groupMode === mode}
              className={groupMode === mode ? "is-active" : ""}
              key={mode}
              onClick={() => setGroupMode(mode)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <RunsColumnsMenu
          columnsOpen={columnsOpen}
          onColumnsOpen={onColumnsOpen}
          onPinnedMetric={onPinnedMetric}
          onPinnedMetricFilter={onPinnedMetricFilter}
          onTableColumns={onTableColumns}
          pinnedMetricFilter={pinnedMetricFilter}
          pinnedMetricFilterValid={pinnedMetricFilterValid}
          pinnedMetricOptions={pinnedMetricOptions}
          pinnedMetrics={pinnedMetrics}
          tableColumns={columns}
        />
        <span className="mlabel runs-tablebar-count">
          {filteredRuns.length.toLocaleString("en-US")} of {Math.max(summaryTotal, filteredRuns.length).toLocaleString("en-US")}
        </span>
      </div>

      {/* Selecting runs here drives the comparison panel above (CompareView):
          pick a set with the checkboxes and they render side by side inline. */}
      <div className="runs-dtable-scroll">
        <table className="runs-dtable">
          <thead>
            <tr>
              <th className="col-check">
                <input
                  aria-checked={selectionState === "all" ? "true" : selectionState === "some" ? "mixed" : "false"}
                  aria-label={selectionState === "all" ? "Deselect all visible runs" : "Select all visible runs"}
                  checked={selectionState === "all"}
                  className="cbx"
                  disabled={!visibleRunIds.length}
                  onChange={onSelectAllVisible}
                  ref={(node) => { if (node) node.indeterminate = selectionState === "some"; }}
                  type="checkbox"
                />
              </th>
              {columns.status ? <th className="col-dot"><span className="visually-hidden">Status</span></th> : null}
              <th>Run</th>
              <th>Trend</th>
              {columns.latest ? <th className="is-num is-sorted" id="table-metric-label" title={metricKey}>{metricKey}</th> : null}
              <th className="is-num">train/loss</th>
              {columns.duration ? <th className="is-num">Step</th> : null}
              {columns.notes ? <th>Owner</th> : null}
              {columns.tags ? <th>Tags</th> : null}
              {columns.started ? <th className="is-num">Started</th> : null}
              {pinnedMetrics.map((metric) => <th className="is-num" key={metric} title={metric}>{shortMetricName(metric)}</th>)}
              <th className="col-stop"><span className="visually-hidden">Run actions</span></th>
            </tr>
          </thead>
          <tbody>
            {filteredRuns.length ? groups.map((group) => {
              if (groupMode === "flat") return group.runs.map(renderRunRow);
              const groupValues = group.runs
                .map((run) => bestMetric(run, metricKey))
                .filter((value): value is number => typeof value === "number");
              const groupBest = groupValues.length
                ? goal === "minimize" ? Math.min(...groupValues) : Math.max(...groupValues)
                : null;
              return [
                <tr className="group-row" key={`group-${group.key}`}>
                  <td colSpan={visibleColumnCount}>
                    <b>{group.key}</b> · {group.runs.length} {group.runs.length === 1 ? "run" : "runs"}
                    {groupBest !== null ? <> · best {groupBest.toFixed(1)}</> : null}
                  </td>
                </tr>,
                ...group.runs.map(renderRunRow),
              ];
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

      <div className="runs-tablefoot">
        <span className="mlabel">
          {totalPages > 1
            ? `Page ${currentPage.toLocaleString("en-US")} / ${totalPages.toLocaleString("en-US")}`
            : `${filteredRuns.length.toLocaleString("en-US")} ${filteredRuns.length === 1 ? "run" : "runs"}`}
        </span>
        {totalPages > 1 ? (
          <div className="runs-tablefoot-pager">
            <button
              aria-label="Previous page"
              className="parity-btn parity-btn--icon"
              disabled={paginationBusy || !hasPreviousPage}
              onClick={onPreviousPage}
              type="button"
            >
              ‹
            </button>
            <span className="parity-btn parity-btn--icon is-current" aria-current="page">{currentPage.toLocaleString("en-US")}</span>
            <button
              aria-label="Next page"
              className="parity-btn parity-btn--icon"
              disabled={paginationBusy || !hasNextPage}
              onClick={onNextPage}
              type="button"
            >
              ›
            </button>
          </div>
        ) : null}
        <span className="mlabel">Row height 36px</span>
      </div>
    </div>
  );
}
