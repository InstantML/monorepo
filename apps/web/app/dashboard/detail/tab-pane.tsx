"use client";

import { Activity, Copy, Database, GitBranch, GitFork, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { isAbortError, queryString, retryTransientRequest } from "../../../src/api.js";
import { defaultForkRunName } from "../../../src/checkpoints.js";
import { smoothSeries } from "../../../src/charts.js";
import { canRequestStop, displayStatusForRun, formatMetricValue, formatNumber, isInternalInstantMlMetric, metricGoal, preferredMetricKey } from "../../../src/state.js";
import { compactValue, formatRunTime } from "../../dashboard-models";
import { MetricChart } from "../metrics/metric-chart";
import { RunEvidenceExplorer, RunGraphPanel, RunLogsPanel, RunSystemPanel } from "../components/run-workspace";
import type { RunWorkspaceTabId } from "../components/run-workspace";
import { formatDuration } from "../ui/duration";
import { Skeleton } from "../ui/skeleton";
import { RunMetricTable } from "./run-detail";
import { TraceMetricTimeline } from "./trace-timeline";
import { ConfigPanel, ForkCheckpointDialog, OverviewTab, newestCheckpoint } from "./overview";
import type { ForkCheckpointOptions, OverviewChartSpec } from "./overview";
import type { Artifact, HoverPoint, LoggedObject, LoggedObjectRow, MetricPoint, MetricSeries, RunLineage, RunMetricRow, RunSummary, RunTimelineRow } from "../../dashboard-types";
import type { components } from "../../../src/types/api.generated";

type ChartZoomRange = { min: number; max: number } | null;
type TraceSummary = components["schemas"]["TraceSummaryItem"];
type TraceStepSummary = components["schemas"]["TraceStepSummaryResponse"];
type ApiLike = {
  get(path: string, options?: { signal?: AbortSignal }): Promise<any>;
  post(path: string, body?: any, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<any>;
};

type Props = {
  api: ApiLike;
  canControlRuns: boolean;
  dataControls: ReactNode;
  hover: HoverPoint;
  loggedObjects: LoggedObject[];
  objectRowsById: Record<number, LoggedObjectRow[]>;
  onChartLeave: () => void;
  onChartPointHover: (point: HoverPoint) => void;
  onChartZoomRangeChange: (range: ChartZoomRange) => void;
  onForkCheckpoint?: (artifact: Artifact, options: ForkCheckpointOptions) => Promise<void>;
  onRequestStop?: (runIds: string[]) => void;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  onWorkspaceTabChange: (tab: RunWorkspaceTabId) => void;
  primarySeries: MetricSeries[];
  primaryChartZoomRange: ChartZoomRange;
  run: RunSummary | null;
  runMetricRows: RunMetricRow[];
  runTimelineRows: RunTimelineRow[];
  runWorkspaceTab: RunWorkspaceTabId;
  selectedRuns: RunSummary[];
  visibleArtifacts: Artifact[];
  xMode: string;
};

/* ------------------------------------------------------------------ */
/* Metric key selection for the overview chart grid                    */
/* ------------------------------------------------------------------ */

function firstKeyMatching(rows: RunMetricRow[], pattern: RegExp, exclude = "") {
  const matches = rows.filter((row) => pattern.test(row.key) && row.key !== exclude).map((row) => row.key).sort();
  const trainFirst = matches.find((key) => /^train/i.test(key));
  return trainFirst ?? matches[0] ?? "";
}

function overviewMetricKeys(rows: RunMetricRow[]) {
  const ret = preferredMetricKey(rows.map((row) => row.key)) || "";
  const loss = firstKeyMatching(rows, /loss/i, ret);
  const grad = firstKeyMatching(rows, /grad[-_]?norm/i, ret);
  const lr = firstKeyMatching(rows, /(^|[/_])(lr|learning[-_]?rate)$/i, ret);
  return { grad, loss, lr, ret };
}

function throughputKey(rows: RunMetricRow[]) {
  return firstKeyMatching(rows, /tokens?[-_]?per[-_]?sec|tok[-_]?s$|throughput|samples?[-_]?per[-_]?sec/i);
}

function gpuUtilKey(rows: RunMetricRow[]) {
  return rows.filter((row) => /gpu/i.test(row.key) && /util/i.test(row.key)).map((row) => row.key).sort()[0] ?? "";
}

/* ------------------------------------------------------------------ */
/* KPI helpers                                                         */
/* ------------------------------------------------------------------ */

function compactSteps(value: number) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1000) {
    const thousands = value / 1000;
    return `${formatNumber(thousands, Math.abs(thousands) >= 100 ? 0 : 1)}k`;
  }
  return formatNumber(value, 0);
}

function configTotalSteps(config: Record<string, unknown>) {
  for (const key of ["total_steps", "max_steps", "steps", "num_steps", "train_steps"]) {
    const value = Number(config?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function runPoints(seriesMap: Record<string, MetricSeries[]>, key: string, runId: string): MetricPoint[] {
  if (!key) return [];
  return seriesMap[key]?.find((item) => item.id === runId)?.points ?? [];
}

// Steps per second from the freshest stretch of a series; powers the ETA cell.
function recentStepRate(points: MetricPoint[]) {
  if (points.length < 2) return null;
  const window = points.slice(-12);
  const first = window[0];
  const last = window[window.length - 1];
  const seconds = (new Date(last.created_at).getTime() - new Date(first.created_at).getTime()) / 1000;
  const steps = last.step - first.step;
  if (!Number.isFinite(seconds) || !Number.isFinite(steps) || seconds <= 1 || steps <= 0) return null;
  return steps / seconds;
}

function etaLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds > 90 * 86_400) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.max(0, Math.round((seconds % 3600) / 60));
  if (hours >= 48) return `${Math.round(hours / 24)}d ${hours % 24}h`;
  return hours ? `${hours}h ${minutes}m` : `${Math.max(1, minutes)}m`;
}

type KpiCell = {
  delta?: { text: string; tone: "up" | "down" | "flat" };
  id: string;
  label: string;
  meterPercent?: number;
  suffix?: string;
  title?: string;
  tone?: string;
  value: string;
};

function buildKpiCells({
  run,
  running,
  seriesMap,
  userRows,
}: {
  run: RunSummary;
  running: boolean;
  seriesMap: Record<string, MetricSeries[]>;
  userRows: RunMetricRow[];
}): KpiCell[] {
  const cells: KpiCell[] = [];
  const keys = overviewMetricKeys(userRows);
  const allRows = [...userRows];

  // STEP — progress meter only when the run declared a target step count.
  const latestSteps = userRows.map((row) => row.latestStep).filter((step): step is number => typeof step === "number" && Number.isFinite(step));
  const seriesSteps = Object.values(seriesMap).flatMap((list) => list.filter((item) => item.id === run.id).flatMap((item) => item.points.map((point) => point.step)));
  const stepNow = Math.max(...latestSteps, ...seriesSteps, Number.NEGATIVE_INFINITY);
  const totalSteps = configTotalSteps(run.config ?? {});
  if (Number.isFinite(stepNow) && stepNow >= 0) {
    cells.push({
      id: "step",
      label: "Step",
      meterPercent: totalSteps ? Math.max(0, Math.min(100, (stepNow / totalSteps) * 100)) : undefined,
      suffix: totalSteps ? ` /${compactSteps(totalSteps)}` : undefined,
      value: formatNumber(stepNow, 0),
    });
  }

  // Headline eval metric — green, with "best yet" when latest is the extreme.
  const aggregates = run.metric_aggregates ?? {};
  const evalAgg = keys.ret ? aggregates[keys.ret] : undefined;
  if (keys.ret && evalAgg && Number.isFinite(evalAgg.latest)) {
    const goal = metricGoal(keys.ret);
    const best = goal === "minimize" ? evalAgg.min : evalAgg.max;
    const isBest = Number.isFinite(best) && Math.abs(evalAgg.latest - best) <= Math.abs(best || 1) * 1e-9;
    const points = runPoints(seriesMap, keys.ret, run.id);
    const previous = points.length >= 2 ? points[points.length - 2].value : null;
    const delta = previous === null ? null : points[points.length - 1].value - previous;
    cells.push({
      delta: isBest
        ? { text: `${goal === "minimize" ? "▼" : "▲"}${delta !== null && Number.isFinite(delta) ? ` ${formatMetricValue(Math.abs(delta), 3)}` : ""} best yet`, tone: "up" }
        : { text: `best ${formatMetricValue(best, 4)}`, tone: "flat" },
      id: "eval",
      label: keys.ret,
      title: keys.ret,
      tone: "good",
      value: formatMetricValue(evalAgg.latest, 4),
    });
  }

  // Loss — slope per 1k steps when the series spans enough ground.
  const lossAgg = keys.loss ? aggregates[keys.loss] : undefined;
  if (keys.loss && lossAgg && Number.isFinite(lossAgg.latest)) {
    const points = runPoints(seriesMap, keys.loss, run.id);
    let delta: KpiCell["delta"];
    if (points.length >= 2) {
      const last = points[points.length - 1];
      const anchor = [...points].reverse().find((point) => last.step - point.step >= 1000) ?? points[0];
      const span = last.step - anchor.step;
      if (span >= 100) {
        const perK = ((last.value - anchor.value) / span) * 1000;
        const arrow = perK > 0 ? "▲" : "▼";
        const tone = Math.abs(perK) < 1e-6 ? "flat" : perK > 0 ? "down" : "up";
        delta = { text: `${tone === "flat" ? "—" : arrow} ${formatMetricValue(Math.abs(perK), 3)} / 1k steps`, tone };
      }
    }
    cells.push({
      delta,
      id: "loss",
      label: keys.loss,
      title: keys.loss,
      value: formatMetricValue(lossAgg.latest, 4),
    });
  }

  // Throughput + GPU util — only when system metrics exist.
  const tputKey = throughputKey(allRows);
  const tputRow = allRows.find((row) => row.key === tputKey);
  if (tputRow && tputRow.latest !== null && Number.isFinite(tputRow.latest)) {
    const tokens = /tok/i.test(tputKey);
    const unit = tokens ? " tok/s" : /sample/i.test(tputKey) ? " samples/s" : "/s";
    const big = Math.abs(tputRow.latest) >= 10_000;
    cells.push({
      delta: tputRow.mean !== null && Number.isFinite(tputRow.mean) ? { text: `avg ${formatMetricValue(tputRow.mean, 3)}`, tone: "flat" } : undefined,
      id: "throughput",
      label: "Throughput",
      suffix: big ? `k${unit}` : unit,
      title: tputKey,
      value: big ? formatNumber(tputRow.latest / 1000, 1) : formatNumber(tputRow.latest, 1),
    });
  }
  const gpuKey = gpuUtilKey(allRows);
  const gpuRow = allRows.find((row) => row.key === gpuKey);
  if (gpuRow && gpuRow.latest !== null && Number.isFinite(gpuRow.latest)) {
    const percentLike = gpuRow.latest > 1 && gpuRow.latest <= 100;
    cells.push({
      delta: gpuRow.mean !== null && Number.isFinite(gpuRow.mean) ? { text: `avg ${formatNumber(gpuRow.mean, 1)}${percentLike ? "%" : ""}`, tone: "flat" } : undefined,
      id: "gpu",
      label: "GPU util",
      suffix: percentLike ? "%" : undefined,
      title: gpuKey,
      value: formatNumber(gpuRow.latest, 1),
    });
  }

  // ETA — recent step rate x remaining steps, running runs with a target only.
  if (running && totalSteps && Number.isFinite(stepNow) && stepNow > 0 && stepNow < totalSteps) {
    const ratePoints = [keys.loss, keys.ret, tputKey]
      .map((key) => runPoints(seriesMap, key, run.id))
      .find((points) => points.length >= 2) ?? [];
    const rate = recentStepRate(ratePoints);
    const label = rate ? etaLabel((totalSteps - stepNow) / rate) : "";
    if (label) {
      cells.push({
        delta: { text: `${compactSteps(totalSteps - stepNow)} steps left`, tone: "flat" },
        id: "eta",
        label: "ETA",
        value: label,
      });
    }
  }

  return cells;
}

/* ------------------------------------------------------------------ */
/* Header helpers                                                      */
/* ------------------------------------------------------------------ */

function metadataScalar(metadata: Record<string, unknown>, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function nestedMetadataScalar(metadata: Record<string, unknown>, path: string[]) {
  let current: unknown = metadata;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? current : null;
}

function runOwner(run: RunSummary) {
  const owner = metadataScalar(run.metadata, "owner")
    ?? metadataScalar(run.metadata, "user")
    ?? metadataScalar(run.metadata, "username")
    ?? metadataScalar(run.metadata, "created_by");
  return owner ? String(owner) : "";
}

function startedUtcLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function StatusChip({ status }: { status: string }) {
  if (status === "running") {
    return <span className="pd-chip pd-chip--live"><span className="pd-pulse" />Live</span>;
  }
  if (status === "failed") return <span className="pd-chip pd-chip--crit">Failed</span>;
  if (status === "stopping" || status === "stopped") return <span className="pd-chip pd-chip--warn">{status}</span>;
  return <span className="pd-chip pd-chip--done">{status === "finished" ? "Finished" : status}</span>;
}

/* ------------------------------------------------------------------ */
/* Config + source tab                                                 */
/* ------------------------------------------------------------------ */

function ConfigTab({ metricRows, parent, run }: { metricRows: RunMetricRow[]; parent: RunSummary | null; run: RunSummary }) {
  const commit = metadataScalar(run.metadata, "git_commit")
    ?? metadataScalar(run.metadata, "commit")
    ?? nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "commit"]);
  const gitAvailable = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "available"]);
  const gitDirty = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "dirty"]);
  const gitDirtyUnknown = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "dirty_unknown"]);
  const entrypoint = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "entrypoint"]);
  const dirtyLabel = gitDirty === true ? "yes" : gitDirty === false ? "no" : gitDirtyUnknown === true ? "unknown" : "-";
  const gitLabel = gitAvailable === false ? "unavailable" : gitAvailable === true || commit ? "available" : "-";
  const hostValue = run.metadata.hostname ?? run.metadata.host;
  const pythonValue = metadataScalar(run.metadata, "python");
  const platformValue = metadataScalar(run.metadata, "platform");
  const copyable = (value: unknown) => (value === null || value === undefined ? undefined : String(value));
  const sourceRows: Array<{ copy?: string; label: string; value: string }> = [
    { label: "Start time", value: formatRunTime(run.started_at ?? run.created_at) },
    { label: "End time", value: run.finished_at ? formatRunTime(run.finished_at) : "-" },
    { label: "Entry point", value: compactValue(entrypoint ?? "-"), copy: copyable(entrypoint) },
    { label: "Git", value: compactValue(gitLabel) },
    { label: "Host", value: compactValue(hostValue ?? "-"), copy: copyable(hostValue) },
    { label: "PID", value: compactValue(run.metadata.pid ?? "-") },
    { label: "Commit", value: compactValue(commit ?? "-"), copy: copyable(commit) },
    { label: "Dirty", value: compactValue(dirtyLabel) },
    { label: "Python", value: compactValue(pythonValue ?? "-"), copy: copyable(pythonValue) },
    { label: "Platform", value: compactValue(platformValue ?? "-"), copy: copyable(platformValue) },
  ];
  const stopRows = stopControlRows(run);
  return (
    <div className="pd-grid">
      <div className="pd-col-main">
        <ConfigPanel parent={parent} run={run} />
        <details className="detail-section raw-detail pd-rawdetail">
          <summary><Database size={15} /> Raw configuration</summary>
          <pre>{JSON.stringify(run.config, null, 2)}</pre>
        </details>
      </div>
      <aside className="pd-col-side">
        <div className="pd-panel">
          <div className="pd-panel-head"><span className="pd-mlabel">Source</span></div>
          <div className="pd-panel-body pd-source-rows">
            {sourceRows.map(({ copy, label, value }) => (
              <div className="detail-row" key={label}>
                <span>{label}</span>
                <strong className="detail-value" title={copy}>
                  {value}
                  {copy && copy !== "-" ? (
                    <button
                      aria-label={`Copy ${label.toLowerCase()}`}
                      className="detail-copy"
                      onClick={() => { navigator.clipboard?.writeText(copy).catch(() => { /* value stays selectable */ }); }}
                      type="button"
                    >
                      <Copy size={12} />
                    </button>
                  ) : null}
                </strong>
              </div>
            ))}
          </div>
        </div>
        {stopRows.length ? (
          <div className="pd-panel">
            <div className="pd-panel-head"><span className="pd-mlabel"><Square size={13} /> Stop Request</span></div>
            <div className="pd-panel-body pd-source-rows">
              {stopRows.map(([label, value]) => (
                <div className="detail-row" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail pane                                                         */
/* ------------------------------------------------------------------ */

const SERIES_LIMIT = 1_000;
const SERIES_BUCKETS = 600;
const LIVE_SERIES_POLL_MS = 45_000;

const DETAIL_TABS: Array<{ id: RunWorkspaceTabId; label: string }> = [
  { id: "summary", label: "Overview" },
  { id: "data", label: "Metrics" },
  { id: "traces", label: "Traces" },
  { id: "files", label: "Artifacts" },
  { id: "logs", label: "Logs" },
  { id: "system", label: "Config" },
  { id: "graph", label: "Lineage" },
];
const RECENT_TRACE_LIMIT = 20;

function artifactCountForRun(run: RunSummary, loadedCount: number) {
  const counted = Object.values(run.artifact_counts ?? {}).reduce((total, value) => (
    total + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  ), 0);
  return counted || loadedCount;
}

function stopControlRows(run: RunSummary) {
  const control = run.run_control;
  if (!control?.stop_requested) return [];
  return [
    ["State", compactValue(control.display_status ?? control.stop_state ?? "-")],
    ["Reason", compactValue(control.reason ?? "-")],
    ["Completion note", compactValue(control.completion_message ?? "-")],
    ["Actor", compactValue(control.actor ?? "-")],
    ["Requested", control.stop_requested_at ? formatRunTime(control.stop_requested_at) : "-"],
    ["Acknowledged", control.stop_acknowledged_at ? formatRunTime(control.stop_acknowledged_at) : "-"],
    ["Completed", control.stop_completed_at ? formatRunTime(control.stop_completed_at) : "-"],
  ];
}

export function DetailTabPane({
  api,
  canControlRuns,
  dataControls,
  hover,
  loggedObjects,
  objectRowsById,
  onChartLeave,
  onChartPointHover,
  onChartZoomRangeChange,
  onForkCheckpoint,
  onRequestStop,
  onRunMetadataSave,
  onWorkspaceTabChange,
  primarySeries,
  primaryChartZoomRange,
  run,
  runMetricRows,
  runTimelineRows,
  runWorkspaceTab,
  selectedRuns,
  visibleArtifacts,
  xMode,
}: Props) {
  const [lineage, setLineage] = useState<RunLineage | null>(null);
  const [seriesMap, setSeriesMap] = useState<Record<string, MetricSeries[]>>({});
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [liveTick, setLiveTick] = useState(0);
  const [forkArtifact, setForkArtifact] = useState<Artifact | null>(null);
  const [recentTraces, setRecentTraces] = useState<TraceSummary[]>([]);
  const [recentTracesLoading, setRecentTracesLoading] = useState(false);
  const [recentTracesError, setRecentTracesError] = useState("");
  const [traceSteps, setTraceSteps] = useState<{ runId: string; payload: TraceStepSummary } | null>(null);
  const [traceStepsLoading, setTraceStepsLoading] = useState(false);
  const [traceStepsError, setTraceStepsError] = useState("");
  const [traceMetricKey, setTraceMetricKey] = useState("");
  // Scoped by run+metric so a failure can never be misattributed to a
  // different key or run that early-returns out of the fetch effect.
  const [traceSeriesError, setTraceSeriesError] = useState<{ scope: string; message: string } | null>(null);
  const [traceRefreshKey, setTraceRefreshKey] = useState(0);
  // Entries carry the run and live-poll tick they were fetched for, so a run
  // switch can never paint another run's line (even for the one frame before
  // the reset effect flushes) and live runs refresh on the shared poll cadence.
  const [traceSeriesCache, setTraceSeriesCache] = useState<Record<string, { runId: string; tick: number; series: MetricSeries[] }>>({});
  const [selectedTraceStep, setSelectedTraceStep] = useState<number | null>(null);

  const runId = run?.id ?? "";
  const userRows = useMemo(() => runMetricRows.filter((row) => !isInternalInstantMlMetric(row.key)), [runMetricRows]);
  const userMetricKeys = useMemo(() => userRows.map((row) => row.key), [userRows]);
  const userMetricKeySignature = userMetricKeys.join("|");
  const keys = useMemo(() => overviewMetricKeys(userRows), [userRows]);
  const tputKey = useMemo(() => throughputKey(userRows), [userRows]);
  const chartKeys = useMemo(
    () => [...new Set([keys.ret, keys.loss, keys.grad, keys.lr, tputKey].filter(Boolean))],
    [keys.grad, keys.loss, keys.lr, keys.ret, tputKey],
  );
  const chartKeySignature = chartKeys.join("|");
  const parentRun = run?.parent_run_id && lineage?.run?.id === runId ? lineage.parent ?? null : null;
  const parentRunId = parentRun?.id ?? "";
  const status = run ? displayStatusForRun(run) : "";
  const liveRun = run?.status === "running";
  const running = status === "running";

  // Reset per-run UI state when the inspected run changes.
  useEffect(() => {
    setForkArtifact(null);
    setSelectedTraceStep(null);
    setTraceSeriesCache({});
    setTraceSteps(null);
  }, [runId]);

  // Default (and self-heal) the timeline metric key to the run's preferred user
  // metric. Re-runs when the key set changes (late-loading rows, run switch) so
  // a stale key from a previous run never sticks.
  useEffect(() => {
    setTraceMetricKey((current) => (current && userMetricKeys.includes(current) ? current : preferredMetricKey(userMetricKeys)));
  }, [userMetricKeySignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lineage feeds the "forked from" header line, config diff, and parent
  // ghost curve. Only forked runs need it.
  useEffect(() => {
    if (!runId || !run?.parent_run_id) {
      setLineage(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    api.get(`/api/runs/${runId}/lineage`, { signal: controller.signal })
      .then((payload) => {
        if (!cancelled) setLineage(payload as RunLineage);
      })
      .catch(() => {
        if (!cancelled) setLineage(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, run?.parent_run_id, runId]);

  // Overview/KPI series: one bounded request per headline metric key, plus
  // the parent run on the headline eval metric for the dashed ghost curve.
  useEffect(() => {
    if (!runId || !chartKeys.length) {
      setSeriesMap({});
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setSeriesLoading(true);
    (async () => {
      const next: Record<string, MetricSeries[]> = {};
      await Promise.all(chartKeys.map(async (key) => {
        const runIds = key === keys.ret && parentRunId ? [runId, parentRunId] : [runId];
        try {
          const payload = await api.post(
            "/api/metrics/series",
            { buckets: SERIES_BUCKETS, key, limit: SERIES_LIMIT, run_ids: runIds },
            { signal: controller.signal },
          );
          const byRunId = new Map<string, MetricPoint[]>();
          for (const entry of Array.isArray(payload?.series) ? payload.series : []) {
            if (entry && typeof entry.run_id === "string") byRunId.set(entry.run_id, Array.isArray(entry.metrics) ? entry.metrics : []);
          }
          next[key] = runIds
            .map((id) => ({
              group: "detail",
              id,
              name: id === runId ? run?.name ?? id : parentRun?.name ?? id,
              points: byRunId.get(id) ?? [],
            }))
            .filter((item) => item.points.length || item.id === runId);
        } catch (caught) {
          if (!isAbortError(caught)) next[key] = [];
        }
      }));
      if (!cancelled) {
        setSeriesMap(next);
        setSeriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chartKeySignature, keys.ret, liveTick, parentRunId, runId]);

  // Keep the overview fresh while the run is live. Ticks are gated on tab
  // visibility (B6, mirrors the dashboard shell poll): a hidden tab stops
  // refetching KPI series, and returning to the tab refreshes once
  // immediately via the visibilitychange listener.
  useEffect(() => {
    if (!liveRun) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      setLiveTick((current) => current + 1);
    };
    const timer = window.setInterval(poll, LIVE_SERIES_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [liveRun]);

  // Live runs re-poll the trace list and step aggregates on the shared series
  // cadence; the ref lets a poll refresh keep the current rows on screen
  // instead of flashing the skeleton every tick.
  const tracesPollTick = liveRun ? liveTick : 0;
  const tracesLoadedForRef = useRef("");
  useEffect(() => {
    if (runWorkspaceTab !== "traces" || !run) {
      setRecentTraces([]);
      setRecentTracesError("");
      setRecentTracesLoading(false);
      tracesLoadedForRef.current = "";
      return;
    }
    const scopeKey = `${runId}:${selectedTraceStep ?? "all"}`;
    const isRefresh = tracesLoadedForRef.current === scopeKey;
    const controller = new AbortController();
    let cancelled = false;
    if (!isRefresh) {
      setRecentTraces([]);
      setRecentTracesLoading(true);
      // Invalidate immediately: if this pass is aborted (rapid scope toggling),
      // returning to the previous scope must re-show the skeleton rather than a
      // false empty state over the wiped rows.
      tracesLoadedForRef.current = "";
    }
    setRecentTracesError("");
    retryTransientRequest(
      () => api.get(`/api/traces${queryString(runTraceListQuery(run, selectedTraceStep))}`, { signal: controller.signal }),
      { signal: controller.signal },
    )
      .then((payload) => {
        if (cancelled) return;
        setRecentTraces(((payload?.traces ?? []) as TraceSummary[]).slice(0, RECENT_TRACE_LIMIT));
        tracesLoadedForRef.current = scopeKey;
      })
      .catch((caught) => {
        if (!cancelled && !isAbortError(caught)) {
          setRecentTraces([]);
          tracesLoadedForRef.current = "";
          setRecentTracesError(caught instanceof Error ? caught.message : "Unable to load traces.");
        }
      })
      .finally(() => {
        if (!cancelled) setRecentTracesLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, run?.started_at, runId, runWorkspaceTab, selectedTraceStep, traceRefreshKey, tracesPollTick]);

  // Per-step trace aggregates for the correlation timeline. Independent of the
  // list fetch above and the metric-series fetch below: one failing must not
  // block the others. Tab-gated + abortable, mirroring the recent-traces effect.
  const stepsLoadedForRef = useRef("");
  useEffect(() => {
    if (runWorkspaceTab !== "traces" || !run) {
      setTraceSteps(null);
      setTraceStepsError("");
      setTraceStepsLoading(false);
      setSelectedTraceStep(null);
      stepsLoadedForRef.current = "";
      return;
    }
    const isRefresh = stepsLoadedForRef.current === runId;
    const controller = new AbortController();
    let cancelled = false;
    if (!isRefresh) {
      setTraceSteps(null);
      setTraceStepsLoading(true);
      stepsLoadedForRef.current = "";
    }
    setTraceStepsError("");
    retryTransientRequest(
      () => api.get(`/api/runs/${runId}/traces/steps`, { signal: controller.signal }),
      { signal: controller.signal },
    )
      .then((payload) => {
        if (cancelled || !payload) return;
        setTraceSteps({ runId, payload: payload as TraceStepSummary });
        stepsLoadedForRef.current = runId;
      })
      .catch((caught) => {
        if (!cancelled && !isAbortError(caught)) {
          setTraceSteps(null);
          stepsLoadedForRef.current = "";
          setTraceStepsError(caught instanceof Error ? caught.message : "Unable to load trace activity.");
        }
      })
      .finally(() => {
        if (!cancelled) setTraceStepsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, run?.started_at, runId, runWorkspaceTab, traceRefreshKey, tracesPollTick]);

  // Metric line for the timeline's selected key. Reuse the headline seriesMap
  // cache when the key is already loaded; otherwise fetch it once (same request
  // shape as the overview effect) into a per-key cache. Tab-gated + abortable.
  useEffect(() => {
    if (runWorkspaceTab !== "traces" || !runId || !traceMetricKey) return undefined;
    if (seriesMap[traceMetricKey]) return undefined;
    const cached = traceSeriesCache[traceMetricKey];
    // A cache hit is only final for finished runs; live runs refetch on the
    // shared poll tick so the timeline tracks the training loop like the
    // overview charts do.
    if (cached && cached.runId === runId && (!liveRun || cached.tick === liveTick)) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    const errorScope = `${runId}:${traceMetricKey}`;
    setTraceSeriesError((current) => (current?.scope === errorScope ? null : current));
    retryTransientRequest(
      () => api.post(
        "/api/metrics/series",
        { buckets: SERIES_BUCKETS, key: traceMetricKey, limit: SERIES_LIMIT, run_ids: [runId] },
        { signal: controller.signal },
      ),
      { signal: controller.signal },
    )
      .then((payload) => {
        if (cancelled) return;
        const byRunId = new Map<string, MetricPoint[]>();
        for (const entry of Array.isArray(payload?.series) ? payload.series : []) {
          if (entry && typeof entry.run_id === "string") byRunId.set(entry.run_id, Array.isArray(entry.metrics) ? entry.metrics : []);
        }
        setTraceSeriesCache((prev) => ({
          ...prev,
          [traceMetricKey]: {
            runId,
            tick: liveTick,
            series: [{ group: "detail", id: runId, name: run?.name ?? runId, points: byRunId.get(runId) ?? [] }],
          },
        }));
      })
      .catch((caught) => {
        // Failures are surfaced, never cached: the caption stays honest and
        // the next effect pass (metric switch, tab re-entry, refresh, poll
        // tick) retries.
        if (!cancelled && !isAbortError(caught)) {
          setTraceSeriesError({ scope: errorScope, message: caught instanceof Error ? caught.message : "Unable to load the metric series." });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, liveRun, liveTick, run?.name, runId, runWorkspaceTab, seriesMap, traceMetricKey, traceRefreshKey, traceSeriesCache]);

  const kpiCells = useMemo(() => (
    run ? buildKpiCells({ run, running, seriesMap, userRows }) : []
  ), [run, running, seriesMap, userRows]);

  // Timeline metric line: prefer the headline seriesMap (already fetched for the
  // overview), falling back to the per-key trace cache. Scope to this run only.
  const traceMetricSeries = useMemo<MetricSeries[]>(() => {
    if (!traceMetricKey) return [];
    const fromMap = seriesMap[traceMetricKey];
    if (fromMap) return fromMap.filter((item) => item.id === runId);
    const cached = traceSeriesCache[traceMetricKey];
    return cached && cached.runId === runId ? cached.series : [];
  }, [runId, seriesMap, traceMetricKey, traceSeriesCache]);

  const chartSpecs = useMemo<OverviewChartSpec[]>(() => {
    if (!run) return [];
    const specs: OverviewChartSpec[] = [];
    if (keys.ret) {
      const mine = seriesMap[keys.ret]?.filter((item) => item.id === run.id) ?? [];
      const ghost = seriesMap[keys.ret]?.filter((item) => item.id === parentRunId && item.points.length) ?? [];
      specs.push({
        key: keys.ret,
        modifier: `pd-chart--ret${ghost.length ? " pd-chart--ghosted" : ""}`,
        series: [...mine, ...ghost],
        unit: ghost.length && parentRun ? `vs ${parentRun.name}` : undefined,
      });
    }
    if (keys.loss) {
      specs.push({
        key: keys.loss,
        modifier: "pd-chart--loss",
        series: smoothSeries(seriesMap[keys.loss] ?? [], 60),
        unit: "smoothed .6",
      });
    }
    if (keys.grad) {
      specs.push({ key: keys.grad, modifier: "pd-chart--grad", series: seriesMap[keys.grad] ?? [] });
    }
    if (keys.lr) {
      const schedule = run.config?.lr_schedule ?? run.config?.lr_scheduler ?? run.config?.schedule;
      specs.push({
        key: keys.lr,
        modifier: "pd-chart--lr",
        series: seriesMap[keys.lr] ?? [],
        unit: typeof schedule === "string" ? schedule : undefined,
      });
    }
    if (tputKey) {
      specs.push({
        fullWidth: true,
        key: tputKey,
        modifier: "pd-chart--tput",
        series: seriesMap[tputKey] ?? [],
        unit: "per-step",
      });
    }
    return specs;
  }, [keys.grad, keys.loss, keys.lr, keys.ret, parentRun, parentRunId, run, seriesMap, tputKey]);

  if (!run) {
    return (
      <div className="analysis-page detail-analysis pd-page" id="run-detail">
        <div className="empty compact-empty run-detail-empty">
          <strong>No run open</strong>
          <span>Pick a run from the Runs workspace to inspect its summary, logs, files, and system metrics. Checkpoints live here too — open a run to download, resume, or fork from its checkpoints.</span>
          <a className="secondary compact-button" href="/dashboard/runs">Go to Runs</a>
        </div>
      </div>
    );
  }

  const artifactCount = artifactCountForRun(run, visibleArtifacts.length);
  const canStop = Boolean(run && onRequestStop && canRequestStop(run, canControlRuns));
  const owner = runOwner(run);
  const started = startedUtcLabel(run.started_at ?? run.created_at);
  const seed = run.config?.seed;
  const headerForkTarget = onForkCheckpoint ? newestCheckpoint(visibleArtifacts) : null;
  const parentLabel = parentRun?.name ?? (run.parent_run_id ? `${String(run.parent_run_id).slice(0, 8)}…` : "");

  function confirmStop() {
    if (!run || !onRequestStop) return;
    onRequestStop([run.id]);
  }

  // Comparison now lives in the Runs → Table view. Make sure this run is in the
  // selection, open that view, and land on the Runs tab.
  function openCompare() {
    try { localStorage.setItem("instantml:next:runs-view", "table"); } catch { /* storage may be unavailable */ }
    const params = new URLSearchParams(window.location.search);
    const selected = (params.get("runs") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (run && !selected.includes(run.id)) selected.unshift(run.id);
    if (selected.length) params.set("runs", selected.join(","));
    const query = params.toString();
    window.location.assign(`/dashboard/runs${query ? `?${query}` : ""}`);
  }

  const metricsCount = userRows.length;

  return (
    <div className="analysis-page detail-analysis pd-page" id="run-detail">
      <header className="pd-head rise">
        <div className="pd-head-main">
          <div className="pd-crumb pd-mlabel">
            <a href="/dashboard/runs">runs</a>
            <span className="pd-sep">/</span>
            <span title={run.id}>{run.id.slice(0, 8)}</span>
          </div>
          <h1 className="pd-title">
            <span className="pd-name run-workspace-name" title={run.name}>{run.name}</span>
            <StatusChip status={status} />
          </h1>
          <div className="pd-meta pd-mlabel">
            {run.parent_run_id ? (
              <>
                forked from{" "}
                <button className="pd-meta-link" onClick={() => onWorkspaceTabChange("graph")} type="button">
                  {parentLabel}{run.forked_from_step !== null && run.forked_from_step !== undefined ? ` @ ${compactSteps(run.forked_from_step)}` : ""}
                </button>
                <span className="pd-meta-sep">·</span>
              </>
            ) : null}
            {seed !== undefined && seed !== null ? <>seed {compactValue(seed)}<span className="pd-meta-sep">·</span></> : null}
            {owner ? <>{owner}<span className="pd-meta-sep">·</span></> : null}
            {started ? <>started {started}</> : null}
          </div>
        </div>
        <div className="pd-actions">
          {headerForkTarget ? (
            <button className="pd-btn pd-btn--ghost" onClick={() => setForkArtifact(headerForkTarget)} type="button">
              <GitFork size={13} /> Fork
            </button>
          ) : null}
          <button className="pd-btn pd-btn--primary" onClick={openCompare} type="button">Compare</button>
          {canStop ? (
            <button className="pd-btn pd-btn--stop" onClick={confirmStop} type="button">
              <Square size={12} /> Request stop
            </button>
          ) : null}
        </div>
      </header>

      {kpiCells.length ? (
        <div className="pd-kpis rise" style={{ gridTemplateColumns: `repeat(${kpiCells.length}, minmax(0, 1fr))` }}>
          {kpiCells.map((cell) => (
            <div className="pd-kpi" key={cell.id}>
              <div className="pd-mlabel" title={cell.title ?? cell.label}>{cell.label}</div>
              <div className={`pd-kpi-value num ${cell.tone ?? ""}`}>
                {cell.value}
                {cell.suffix ? <small>{cell.suffix}</small> : null}
              </div>
              {cell.meterPercent !== undefined ? <div className="pd-meter"><i style={{ width: `${cell.meterPercent}%` }} /></div> : null}
              {cell.delta ? <div className={`pd-kpi-delta ${cell.delta.tone}`}>{cell.delta.text}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      <nav className="pd-tabs run-workspace-tabs rise" aria-label="Run workspace sections">
        {DETAIL_TABS.map((item) => {
          const count = item.id === "data" ? metricsCount : item.id === "files" ? artifactCount : null;
          return (
            <button
              aria-pressed={runWorkspaceTab === item.id}
              className={`pd-tab run-workspace-tab ${runWorkspaceTab === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => onWorkspaceTabChange(item.id)}
              type="button"
            >
              {item.label}
              {count ? <span className="pd-tab-n">{formatNumber(count, 0)}</span> : null}
            </button>
          );
        })}
      </nav>

      {runWorkspaceTab === "summary" ? (
        <OverviewTab
          alertMetricKey={keys.ret || "eval/return_mean"}
          api={api}
          artifactCount={artifactCount}
          artifacts={visibleArtifacts}
          charts={chartSpecs}
          loadingSeries={seriesLoading}
          onOpenLogs={() => onWorkspaceTabChange("logs")}
          onRequestFork={onForkCheckpoint ? setForkArtifact : undefined}
          onRunMetadataSave={onRunMetadataSave}
          parent={parentRun}
          run={run}
          running={running}
          timelineRows={runTimelineRows}
        />
      ) : null}

      {runWorkspaceTab === "data" ? (
        <div className="pd-stack">
          {selectedRuns.length ? (
            <div className="pd-selnote pd-mlabel">{selectedRuns.length} runs selected for charts</div>
          ) : null}
          <section className="pd-panel pd-data-panel">
            <div className="pd-panel-head">
              <span className="pd-mlabel">Metric curve</span>
              {dataControls ? <div className="run-data-controls">{dataControls}</div> : null}
              <span className="pd-unit">bounded series</span>
            </div>
            <div className="pd-panel-body">
              <MetricChart
                height={320}
                metricKey=""
                emptyMessage={`${run.name} has not logged the selected metric. Pick one of its logged metrics from the Metric selector above.`}
                onLeave={onChartLeave}
                onPointHover={onChartPointHover}
                onZoomRangeChange={onChartZoomRangeChange}
                padding={48}
                series={primarySeries}
                showRange={false}
                xMode={xMode}
                zoomRange={primaryChartZoomRange}
              />
            </div>
          </section>
          {hover ? <div className="detail-row highlight"><span>Hovered point</span><strong>{hover.runName} / step {hover.point.step} / {formatNumber(hover.point.value, 4)}</strong></div> : null}
          <section className="pd-panel">
            <div className="pd-panel-head">
              <span className="pd-mlabel">Metric Summary</span>
              <span className="pd-unit">user metrics · SDK telemetry lives under Config</span>
            </div>
            <div className="pd-panel-body">
              <RunMetricTable rows={userRows} />
            </div>
          </section>
          <details className="detail-section raw-detail pd-rawdetail">
            <summary><GitBranch size={15} /> Latest metrics</summary>
            <pre>{JSON.stringify(run.latest_metrics, null, 2)}</pre>
          </details>
        </div>
      ) : null}

      {runWorkspaceTab === "logs" ? <RunLogsPanel api={api as any} run={run} /> : null}

      {runWorkspaceTab === "traces" ? (
        <div className="pd-stack pd-traces-panel">
          <TraceMetricTimeline
            key={runId}
            error={traceStepsError}
            loading={traceStepsLoading}
            metricKey={traceMetricKey}
            metricKeys={userMetricKeys}
            onMetricKeyChange={setTraceMetricKey}
            onRefresh={() => {
              setTraceSeriesCache((prev) => {
                const next = { ...prev };
                delete next[traceMetricKey];
                return next;
              });
              setTraceRefreshKey((key) => key + 1);
            }}
            onStepSelect={setSelectedTraceStep}
            runName={run.name}
            selectedStep={selectedTraceStep}
            series={traceMetricSeries}
            seriesError={traceSeriesError && traceSeriesError.scope === `${runId}:${traceMetricKey}` ? traceSeriesError.message : ""}
            steps={traceSteps && traceSteps.runId === runId ? traceSteps.payload : null}
          />
          <RecentTracesPanel
            error={recentTracesError}
            loading={recentTracesLoading}
            onClearStep={() => setSelectedTraceStep(null)}
            run={run}
            selectedStep={selectedTraceStep}
            selectedStepTraceCount={
              selectedTraceStep !== null && traceSteps && traceSteps.runId === runId
                ? traceSteps.payload.steps.find((bucket) => bucket.step === selectedTraceStep)?.trace_count ?? null
                : null
            }
            traces={recentTraces}
          />
        </div>
      ) : null}

      {runWorkspaceTab === "files" ? (
        <RunEvidenceExplorer artifacts={visibleArtifacts} objects={loggedObjects} rowsByObjectId={objectRowsById} run={run} />
      ) : null}

      {runWorkspaceTab === "system" ? (
        <div className="pd-stack">
          <ConfigTab metricRows={runMetricRows} parent={parentRun} run={run} />
          <RunSystemPanel metricRows={runMetricRows} run={run} />
        </div>
      ) : null}

      {runWorkspaceTab === "graph" ? <RunGraphPanel api={api as any} run={run} /> : null}

      {forkArtifact && onForkCheckpoint ? (
        <ForkCheckpointDialog
          artifact={forkArtifact}
          defaultName={defaultForkRunName(forkArtifact, run)}
          onClose={() => setForkArtifact(null)}
          onForkCheckpoint={onForkCheckpoint}
          run={run}
        />
      ) : null}
    </div>
  );
}

function RecentTracesPanel({
  error,
  loading,
  onClearStep,
  run,
  selectedStep,
  selectedStepTraceCount,
  traces,
}: {
  error: string;
  loading: boolean;
  onClearStep: () => void;
  run: RunSummary;
  selectedStep: number | null;
  selectedStepTraceCount: number | null;
  traces: TraceSummary[];
}) {
  const stepLabel = selectedStep !== null ? formatNumber(selectedStep, 0) : "";
  // Disclose the cap honestly when a pinned step holds more traces than the
  // list shows, mirroring the unpinned "last N" unit.
  const pinnedUnit = selectedStep !== null && selectedStepTraceCount !== null && selectedStepTraceCount > traces.length && traces.length > 0 && !loading && !error
    ? `first ${traces.length} of ${formatNumber(selectedStepTraceCount, 0)} at this step`
    : "";
  return (
    <section className="pd-panel">
      <div className="pd-panel-head">
        <span className="pd-mlabel"><Activity size={14} /> Recent traces</span>
        {selectedStep !== null ? (
          <button
            aria-label={`Clear step ${stepLabel} filter`}
            className="pd-trace-filter-chip"
            onClick={onClearStep}
            type="button"
          >
            step {stepLabel}<X size={12} aria-hidden="true" />
          </button>
        ) : null}
        {selectedStep === null ? (
          <span className="pd-unit">last {RECENT_TRACE_LIMIT} for this run</span>
        ) : pinnedUnit ? (
          <span className="pd-unit">{pinnedUnit}</span>
        ) : null}
      </div>
      <div className="pd-panel-body">
        {error ? <div className="status-strip">{error}</div> : null}
        {loading ? (
          <div className="pd-trace-list-skeleton" aria-label="Loading traces" role="status">
            {[0, 1, 2].map((row) => <Skeleton height={20} key={row} width={`${88 - row * 9}%`} />)}
          </div>
        ) : null}
        {!loading && !error && !traces.length ? (
          <div className="empty compact-empty">
            {selectedStep !== null ? `No traces at step ${stepLabel} for ${run.name}.` : `No traces logged for ${run.name} yet.`}
          </div>
        ) : null}
        {traces.length ? (
          <div className="pd-trace-list" role="list" aria-label={`Recent traces for ${run.name}${selectedStep !== null ? ` at step ${stepLabel}` : ""}`}>
            {traces.map((trace) => (
              <a className="pd-trace-row" href={traceHref(trace)} key={`${trace.run_id}:${trace.trace_id}`} role="listitem">
                <span className={`trace-status ${trace.status}`}>{trace.status}</span>
                <span className="pd-trace-main">
                  <strong>{trace.root_name || trace.trace_id.slice(0, 8)}</strong>
                  <small>{trace.kinds.slice(0, 3).join(", ") || "custom"} · {trace.thread_id || trace.rollout_id || trace.trace_id.slice(0, 8)}</small>
                </span>
                <span className="pd-trace-meta">{formatNumber(trace.span_count, 0)} spans</span>
                <span className="pd-trace-meta">{formatDuration(trace.duration_ms)}</span>
                <span className="pd-trace-meta">{formatRunTime(trace.updated_at)}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function traceHref(trace: TraceSummary) {
  return `/dashboard/traces${queryString({
    run_id: trace.run_id,
    trace_id: trace.trace_id,
    span_id: trace.root_span_id || undefined,
  })}`;
}

function runTraceListQuery(run: RunSummary, step: number | null) {
  return {
    run_id: run.id,
    limit: RECENT_TRACE_LIMIT,
    ...(step !== null ? { min_step: step, max_step: step } : {}),
  };
}
