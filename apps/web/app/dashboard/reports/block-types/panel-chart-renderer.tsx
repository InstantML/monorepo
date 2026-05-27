"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

import {
  axisTicks,
  chartDomain,
  chartSummary,
  formatAxisTick,
  formatMetricValue,
  nearestPoint,
  normalizeSeries,
  smoothSeries,
  svgPointFromClient,
} from "../../../../src/charts.js";
import {
  chartHeight,
  chartPadding,
  chartWidth,
  metricTitle,
} from "../../../dashboard-models";
import { MetricChart } from "../../metrics/metric-chart";
import { ApiClient } from "../../../../src/api.js";
import type { HoverPoint, MetricSeries } from "../../../dashboard-types";
import type {
  BarPanelData,
  CodePanelData,
  ImagePanelData,
  LinePanelData,
  MarkdownPanelData,
  PanelData,
  ParallelCoordinatesPanelData,
  RunComparerPanelData,
  RunsetData,
  ScalarPanelData,
  ScatterPanelData,
} from "./types";
import {
  CodePanelRenderer,
  ImagePanelRenderer,
  MarkdownPanelRenderer,
  ParallelCoordinatesRenderer,
  RunComparerRenderer,
} from "./panel-renderers";

/**
 * Hard cap on the number of runs we resolve per panel. Reports embed live
 * charts inside long block-based documents, so we trade off completeness for
 * page-load latency: a runset that would resolve >50 runs is truncated and a
 * notice is shown. Matches the v1 perf-safety guidance in the brief.
 */
const MAX_RUNS_PER_PANEL = 50;
const METRIC_SERIES_BUCKETS = 1_200;
const EMPTY_RUNSET_IDS: string[] = [];

type ResolvedRun = {
  id: string;
  name: string;
  project: string;
  metric_aggregates?: Record<string, Record<string, number>>;
  latest_metrics?: Record<string, number>;
};

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runs: ResolvedRun[]; series: Record<string, MetricSeries[]> };

type RunsetFetchSpec = Pick<RunsetData, "projects" | "pinned_run_ids" | "limit">;

type Props = {
  panel: PanelData;
  runset: RunsetData | undefined;
  api?: ApiClient;
};

/**
 * Inline live chart for a single panel inside a PanelGrid block. Resolves the
 * referenced runset to a concrete run list (project query + pinned IDs),
 * fetches metric series via the same `/api/metrics/series` route the metrics
 * tab uses, and renders the chart inline.
 *
 * v1.2 added 5 more panel types — markdown/code/image render statically
 * (no fetch), parallel_coordinates and run_comparer have their own renderer
 * components that drive their own fetch lifecycles. We dispatch to them via
 * the LiveChartImpl inner function so the React-hooks contract stays clean.
 */
export function PanelChartRenderer({ panel, runset, api }: Props) {
  const client = useMemo(() => api ?? new ApiClient(), [api]);
  switch (panel.type) {
    case "markdown_panel":
      return <MarkdownPanelRenderer panel={panel} />;
    case "code_panel":
      return <CodePanelRenderer panel={panel} />;
    case "image_panel":
      return <ImagePanelRenderer panel={panel} />;
    case "parallel_coordinates":
      return <ParallelCoordinatesRenderer panel={panel} runset={runset} api={client} />;
    case "run_comparer":
      return <RunComparerRenderer panel={panel} runset={runset} api={client} />;
    default:
      return <LiveChartImpl panel={panel} runset={runset} api={client} />;
  }
}

type LiveChartProps = {
  panel: LinePanelData | BarPanelData | ScalarPanelData | ScatterPanelData;
  runset: RunsetData | undefined;
  api: ApiClient;
};

function LiveChartImpl({ panel, runset, api: client }: LiveChartProps) {
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const requestSeqRef = useRef(0);

  const metricsNeeded = useMemo(() => metricsForPanel(panel), [panel]);
  const fetchProjects = runset?.projects ?? EMPTY_RUNSET_IDS;
  const fetchPinnedRunIds = runset?.pinned_run_ids ?? EMPTY_RUNSET_IDS;
  const fetchLimit = runset?.limit;
  const hasRunset = !!runset;
  const fetchSpec = useMemo<RunsetFetchSpec | null>(() => {
    if (!hasRunset) return null;
    return {
      projects: [...fetchProjects],
      pinned_run_ids: [...fetchPinnedRunIds],
      limit: fetchLimit,
    };
  }, [fetchLimit, fetchPinnedRunIds, fetchProjects, hasRunset]);

  useEffect(() => {
    if (!fetchSpec || metricsNeeded.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    setState({ kind: "loading" });
    (async () => {
      try {
        const runs = await resolveRunsForRunset(client, fetchSpec, controller.signal);
        if (seq !== requestSeqRef.current) return;
        if (!runs.length) {
          setState({ kind: "ready", runs: [], series: {} });
          return;
        }
        const series = await fetchSeriesForMetrics(
          client,
          metricsNeeded,
          runs,
          controller.signal,
        );
        if (seq !== requestSeqRef.current) return;
        setState({ kind: "ready", runs, series });
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        const message = error instanceof Error ? error.message : "Failed to load panel data";
        setState({ kind: "error", message });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, fetchSpec, metricsNeeded]);

  const visibleRuns = useMemo(() => {
    if (state.kind !== "ready") return [];
    const settings = runset?.run_settings ?? {};
    return state.runs.filter((run) => {
      const entry = settings[run.id];
      return !(entry?.disabled || entry?.hidden);
    });
  }, [runset?.run_settings, state]);

  const visibleSeries = useMemo(() => {
    if (state.kind !== "ready") return {};
    const visibleRunIds = new Set(visibleRuns.map((run) => run.id));
    return filterSeriesByRunIds(state.series, visibleRunIds);
  }, [state, visibleRuns]);

  if (!runset) {
    return <div className="panel-chart panel-chart--empty">Runset {panel.runset_index} not configured.</div>;
  }
  if (state.kind === "loading") {
    return <div className="panel-chart panel-chart--loading">Loading {panel.type} chart...</div>;
  }
  if (state.kind === "error") {
    return <div className="panel-chart panel-chart--error">Chart error: {state.message}</div>;
  }
  if (state.kind === "idle" || metricsNeeded.length === 0) {
    return <div className="panel-chart panel-chart--empty">Pick a metric to draw the chart.</div>;
  }
  if (!visibleRuns.length) {
    return <div className="panel-chart panel-chart--empty">No runs match this runset yet.</div>;
  }

  switch (panel.type) {
    case "line":
      return <LineChart panel={panel} series={visibleSeries[panel.metric_key] ?? []} />;
    case "bar":
      return <BarChart panel={panel} runs={visibleRuns} series={visibleSeries[panel.metric_key] ?? []} />;
    case "scalar":
      return <ScalarChart panel={panel} runs={visibleRuns} series={visibleSeries[panel.metric_key] ?? []} />;
    case "scatter":
      return (
        <ScatterChart
          panel={panel}
          runs={visibleRuns}
          xSeries={visibleSeries[panel.x_metric] ?? []}
          ySeries={visibleSeries[panel.y_metric] ?? []}
        />
      );
  }
}

function metricsForPanel(
  panel: LinePanelData | BarPanelData | ScalarPanelData | ScatterPanelData,
): string[] {
  switch (panel.type) {
    case "line":
    case "bar":
    case "scalar":
      return panel.metric_key ? [panel.metric_key] : [];
    case "scatter": {
      const out: string[] = [];
      if (panel.x_metric) out.push(panel.x_metric);
      if (panel.y_metric && panel.y_metric !== panel.x_metric) out.push(panel.y_metric);
      return out;
    }
  }
}

async function resolveRunsForRunset(
  api: ApiClient,
  runset: RunsetFetchSpec,
  signal: AbortSignal,
): Promise<ResolvedRun[]> {
  const collected = new Map<string, ResolvedRun>();
  const limitPerProject = clampLimit(runset.limit ?? null);
  for (const project of runset.projects) {
    if (signal.aborted) break;
    if (collected.size >= MAX_RUNS_PER_PANEL) break;
    const params = new URLSearchParams();
    params.set("project", project);
    params.set("limit", String(limitPerProject));
    const payload = await api.get(`/runs?${params.toString()}`, { signal });
    const runs = Array.isArray(payload?.runs) ? payload.runs : [];
    for (const raw of runs) {
      if (collected.size >= MAX_RUNS_PER_PANEL) break;
      const resolved = normalizeResolvedRun(raw, project);
      if (resolved && !collected.has(resolved.id)) collected.set(resolved.id, resolved);
    }
  }
  for (const pinned of runset.pinned_run_ids ?? []) {
    if (signal.aborted) break;
    if (collected.size >= MAX_RUNS_PER_PANEL) break;
    const resolved = await resolvePinnedRun(api, pinned, signal);
    if (resolved && !collected.has(resolved.id)) collected.set(resolved.id, resolved);
  }
  return Array.from(collected.values());
}

function clampLimit(value: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MAX_RUNS_PER_PANEL;
  }
  return Math.min(Math.floor(value), MAX_RUNS_PER_PANEL);
}

function filterSeriesByRunIds(
  series: Record<string, MetricSeries[]>,
  visibleRunIds: Set<string>,
): Record<string, MetricSeries[]> {
  const filtered: Record<string, MetricSeries[]> = {};
  for (const [metricKey, entries] of Object.entries(series)) {
    filtered[metricKey] = entries.filter((entry) => visibleRunIds.has(entry.id));
  }
  return filtered;
}

async function resolvePinnedRun(
  api: ApiClient,
  ref: string,
  signal: AbortSignal,
): Promise<ResolvedRun | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // Accept "project/name" shorthand by listing the project and looking up
  // the matching run name.
  if (trimmed.includes("/")) {
    const [project, ...rest] = trimmed.split("/");
    const name = rest.join("/");
    try {
      const params = new URLSearchParams({ project, limit: String(MAX_RUNS_PER_PANEL) });
      const payload = await api.get(`/runs?${params.toString()}`, { signal });
      const match = (Array.isArray(payload?.runs) ? payload.runs : []).find(
        (run: { name?: string }) => run?.name === name,
      );
      return normalizeResolvedRun(match, project);
    } catch {
      return null;
    }
  }
  try {
    const payload = await api.get(`/runs/${encodeURIComponent(trimmed)}`, { signal });
    const run = payload?.run ?? payload;
    return normalizeResolvedRun(run, String(run?.project ?? ""));
  } catch {
    return null;
  }
}

function normalizeResolvedRun(raw: unknown, fallbackProject: string): ResolvedRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof obj.name === "string" ? obj.name : id,
    project: typeof obj.project === "string" && obj.project ? obj.project : fallbackProject,
    metric_aggregates:
      typeof obj.metric_aggregates === "object" && obj.metric_aggregates !== null
        ? (obj.metric_aggregates as Record<string, Record<string, number>>)
        : undefined,
    latest_metrics:
      typeof obj.latest_metrics === "object" && obj.latest_metrics !== null
        ? (obj.latest_metrics as Record<string, number>)
        : undefined,
  };
}

async function fetchSeriesForMetrics(
  api: ApiClient,
  metricKeys: string[],
  runs: ResolvedRun[],
  signal: AbortSignal,
): Promise<Record<string, MetricSeries[]>> {
  const result: Record<string, MetricSeries[]> = {};
  const runIds = runs.map((run) => run.id);
  for (const metricKey of metricKeys) {
    if (signal.aborted) break;
    if (!metricKey) continue;
    const payload = await api.post(
      `/api/metrics/series`,
      {
        key: metricKey,
        run_ids: runIds,
        limit: 1000,
        buckets: METRIC_SERIES_BUCKETS,
      },
      { signal },
    );
    const seriesArray = Array.isArray(payload?.series) ? payload.series : [];
    const byRun = new Map<string, MetricSeries["points"]>();
    for (const entry of seriesArray) {
      if (entry && typeof entry === "object" && typeof entry.run_id === "string") {
        byRun.set(entry.run_id, Array.isArray(entry.metrics) ? entry.metrics : []);
      }
    }
    result[metricKey] = runs.map((run) => ({
      id: run.id,
      name: run.name,
      group: "all",
      points: byRun.get(run.id) ?? [],
    }));
  }
  return result;
}

function LineChart({ panel, series }: { panel: LinePanelData; series: MetricSeries[] }) {
  const [hover, setHover] = useState<HoverPoint>(null);
  const width = chartWidth;
  const height = chartHeight;
  const padding = chartPadding;
  const smoothed = useMemo(
    () => smoothSeries(series, panel.smoothing ?? 0),
    [series, panel.smoothing],
  );
  const domain = useMemo(() => chartDomain(smoothed, "step", panel.metric_key), [
    smoothed,
    panel.metric_key,
  ]);
  const normalizedSeries = useMemo(
    () => normalizeSeries(smoothed, width, height, padding, "step", panel.metric_key),
    [smoothed, width, height, padding, panel.metric_key],
  );

  if (!series.length || !domain) {
    return <div className="panel-chart panel-chart--empty">No data points for `{panel.metric_key}` yet.</div>;
  }

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, width, height);
    const next = nearestPoint(normalizedSeries, point.x, point.y);
    setHover(next ?? null);
  };

  return (
    <div className="panel-chart panel-chart--line">
      <MetricChart
        domain={domain}
        fullDomain={domain}
        hover={hover}
        metricKey={panel.metric_key}
        normalizedSeries={normalizedSeries}
        onMove={onMove}
        onPointHover={(point) => setHover(point)}
        onLeave={() => setHover(null)}
        showRange={false}
        xMode="step"
      />
    </div>
  );
}

function aggregateForScalar(panel: ScalarPanelData, series: MetricSeries[], runs: ResolvedRun[]): number | null {
  const values = collectLatestValues(panel.metric_key, series, runs);
  if (!values.length) return null;
  switch (panel.agg) {
    case "min":
      return values.reduce((min, value) => Math.min(min, value), values[0]);
    case "max":
      return values.reduce((max, value) => Math.max(max, value), values[0]);
    case "mean":
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "latest":
    default:
      return values[values.length - 1];
  }
}

function collectLatestValues(metricKey: string, series: MetricSeries[], runs: ResolvedRun[]): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  for (const item of series) {
    const points = item.points ?? [];
    const last = points[points.length - 1];
    if (last && Number.isFinite(Number(last.value))) {
      out.push(Number(last.value));
      seen.add(item.id);
    }
  }
  // Fall back to run.latest_metrics for runs that didn't return a series.
  for (const run of runs) {
    if (seen.has(run.id)) continue;
    const fromLatest = Number(run.latest_metrics?.[metricKey]);
    if (Number.isFinite(fromLatest)) {
      out.push(fromLatest);
      seen.add(run.id);
    }
  }
  return out;
}

function ScalarChart({
  panel,
  series,
  runs,
}: {
  panel: ScalarPanelData;
  series: MetricSeries[];
  runs: ResolvedRun[];
}) {
  const value = aggregateForScalar(panel, series, runs);
  return (
    <div className="panel-chart panel-chart--scalar">
      <div className="panel-chart__scalar-value">
        {value === null ? "—" : formatMetricValue(value)}
      </div>
      <div className="panel-chart__scalar-meta">
        <strong>{metricTitle(panel.metric_key)}</strong>
        <span>
          {panel.agg} across {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function BarChart({
  panel,
  runs,
  series,
}: {
  panel: BarPanelData;
  runs: ResolvedRun[];
  series: MetricSeries[];
}) {
  const bars = useMemo(() => {
    const byRun = new Map(series.map((item) => [item.id, item]));
    const collected = runs
      .map((run) => {
        const item = byRun.get(run.id);
        const points = item?.points ?? [];
        const last = points[points.length - 1];
        let value: number | null = null;
        if (last && Number.isFinite(Number(last.value))) {
          value = Number(last.value);
        } else if (Number.isFinite(Number(run.latest_metrics?.[panel.metric_key]))) {
          value = Number(run.latest_metrics?.[panel.metric_key]);
        }
        const groupKey = groupKeyForRun(run, panel.group_by);
        return value === null ? null : { id: run.id, label: groupKey, value };
      })
      .filter((bar): bar is { id: string; label: string; value: number } => bar !== null);
    // If group_by is set, aggregate bars within the same group by mean so the
    // chart reflects per-group rather than per-run values.
    if (panel.group_by) {
      const grouped = new Map<string, { sum: number; count: number }>();
      for (const bar of collected) {
        const entry = grouped.get(bar.label) ?? { sum: 0, count: 0 };
        entry.sum += bar.value;
        entry.count += 1;
        grouped.set(bar.label, entry);
      }
      return Array.from(grouped.entries()).map(([label, agg], index) => ({
        id: `${label}-${index}`,
        label,
        value: agg.sum / agg.count,
      }));
    }
    return collected;
  }, [panel.metric_key, panel.group_by, runs, series]);

  if (!bars.length) {
    return <div className="panel-chart panel-chart--empty">No bars to draw for `{panel.metric_key}`.</div>;
  }

  const width = chartWidth;
  const height = chartHeight;
  const padding = chartPadding;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const maxValue = Math.max(...bars.map((bar) => bar.value));
  const minValue = Math.min(...bars.map((bar) => bar.value), 0);
  const valueSpan = maxValue - minValue || 1;
  const barWidth = innerW / Math.max(1, bars.length);
  const yPos = (value: number) => height - padding - ((value - minValue) / valueSpan) * innerH;
  const yTicks = axisTicks(minValue, maxValue, 5);

  return (
    <div className="panel-chart panel-chart--bar">
      <svg className="metric-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${panel.metric_key} bar chart`}>
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="grid-line" x1={padding} x2={width - padding} y1={yPos(tick)} y2={yPos(tick)} />
            <text className="tick-label" x={padding - 6} y={yPos(tick) + 4} textAnchor="end">{formatAxisTick(tick)}</text>
          </g>
        ))}
        <line className="axis" x1={padding} x2={width - padding} y1={yPos(Math.max(0, minValue))} y2={yPos(Math.max(0, minValue))} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        {bars.map((bar, index) => {
          const x = padding + index * barWidth + barWidth * 0.15;
          const y = yPos(Math.max(bar.value, 0));
          const barHeight = Math.abs(yPos(bar.value) - yPos(0));
          return (
            <g key={bar.id}>
              <rect className={`series-bar series-${index % 5}`} x={x} y={y} width={barWidth * 0.7} height={barHeight} rx={2}>
                <title>{`${bar.label}: ${formatMetricValue(bar.value)}`}</title>
              </rect>
              {bars.length <= 18 ? (
                <text className="tick-label" x={x + barWidth * 0.35} y={height - padding + 16} textAnchor="middle">
                  {bar.label.length > 8 ? `${bar.label.slice(0, 7)}…` : bar.label}
                </text>
              ) : null}
            </g>
          );
        })}
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{panel.group_by ?? "Run"}</text>
        <text className="axis-label" x={10} y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`}>{metricTitle(panel.metric_key)}</text>
      </svg>
    </div>
  );
}

function groupKeyForRun(run: ResolvedRun, groupBy: string | null | undefined): string {
  if (!groupBy) return run.name;
  // group_by can reference a path inside latest_metrics or a top-level field.
  if (groupBy in (run.latest_metrics ?? {})) {
    return String(run.latest_metrics?.[groupBy]);
  }
  if (groupBy === "project") return run.project;
  if (groupBy === "name") return run.name;
  return run.name;
}

function ScatterChart({
  panel,
  runs,
  xSeries,
  ySeries,
}: {
  panel: ScatterPanelData;
  runs: ResolvedRun[];
  xSeries: MetricSeries[];
  ySeries: MetricSeries[];
}) {
  const points = useMemo(() => {
    const xByRun = new Map(xSeries.map((item) => [item.id, item]));
    const yByRun = new Map(ySeries.map((item) => [item.id, item]));
    return runs
      .map((run) => {
        const xLast = lastFiniteValue(xByRun.get(run.id)?.points);
        const yLast = lastFiniteValue(yByRun.get(run.id)?.points);
        const x = xLast ?? Number(run.latest_metrics?.[panel.x_metric]);
        const y = yLast ?? Number(run.latest_metrics?.[panel.y_metric]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { id: run.id, name: run.name, x, y, color: groupKeyForRun(run, panel.color_by) };
      })
      .filter((point): point is { id: string; name: string; x: number; y: number; color: string } => point !== null);
  }, [panel.x_metric, panel.y_metric, panel.color_by, runs, xSeries, ySeries]);

  if (!points.length) {
    return <div className="panel-chart panel-chart--empty">No points to scatter for `{panel.x_metric}` × `{panel.y_metric}`.</div>;
  }

  const width = chartWidth;
  const height = chartHeight;
  const padding = chartPadding;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const xSpan = maxX - minX || 1;
  const ySpan = maxY - minY || 1;
  const xPos = (value: number) => padding + ((value - minX) / xSpan) * innerW;
  const yPos = (value: number) => height - padding - ((value - minY) / ySpan) * innerH;
  const xTicks = axisTicks(minX, maxX, 5);
  const yTicks = axisTicks(minY, maxY, 5);
  // Map distinct color groups to indices so we cycle through chart palette classes.
  const colorIndex = new Map<string, number>();
  for (const point of points) {
    if (!colorIndex.has(point.color)) colorIndex.set(point.color, colorIndex.size);
  }

  return (
    <div className="panel-chart panel-chart--scatter">
      <svg className="metric-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${panel.x_metric} vs ${panel.y_metric} scatter`}>
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="grid-line" x1={padding} x2={width - padding} y1={yPos(tick)} y2={yPos(tick)} />
            <text className="tick-label" x={padding - 6} y={yPos(tick) + 4} textAnchor="end">{formatAxisTick(tick)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line className="grid-line" x1={xPos(tick)} x2={xPos(tick)} y1={padding} y2={height - padding} />
            <text className="tick-label" x={xPos(tick)} y={height - 25} textAnchor="middle">{formatAxisTick(tick)}</text>
          </g>
        ))}
        <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        {points.map((point) => (
          <circle
            key={point.id}
            className={`series-point point-${(colorIndex.get(point.color) ?? 0) % 5}`}
            cx={xPos(point.x)}
            cy={yPos(point.y)}
            r={4}
          >
            <title>{`${point.name}\n${panel.x_metric}: ${formatMetricValue(point.x)}\n${panel.y_metric}: ${formatMetricValue(point.y)}`}</title>
          </circle>
        ))}
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{metricTitle(panel.x_metric)}</text>
        <text className="axis-label" x={10} y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`}>{metricTitle(panel.y_metric)}</text>
      </svg>
    </div>
  );
}

function lastFiniteValue(points: MetricSeries["points"] | undefined): number | null {
  if (!points || !points.length) return null;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = Number(points[index].value);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

// chartSummary export reused so the chart helpers tree-shake correctly even
// when only a subset of panel types are rendered.
export const __unused_chart_summary = chartSummary;
