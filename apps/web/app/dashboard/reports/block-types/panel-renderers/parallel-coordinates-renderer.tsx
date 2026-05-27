"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ApiClient } from "../../../../../src/api.js";
import { chartHeight, chartPadding, chartWidth } from "../../../../dashboard-models";
import type {
  ParallelCoordinatesDimension,
  ParallelCoordinatesPanelData,
  RunsetData,
  RunsetRunSettings,
} from "../types";
import { RUN_COLOR_PALETTE } from "../types";

type ResolvedRun = {
  id: string;
  name: string;
  project: string;
  config: Record<string, unknown>;
  latest_metrics: Record<string, unknown>;
};

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runs: ResolvedRun[] };

const MAX_RUNS_PER_PANEL = 50;

/**
 * Parallel-coordinates panel: one vertical axis per dimension, one polyline
 * per run connecting its values across axes. Categorical axes (string config
 * values) are hashed into a stable rank so the polyline still draws
 * something useful for non-numeric dimensions.
 */
export function ParallelCoordinatesRenderer({
  panel,
  runset,
  api,
}: {
  panel: ParallelCoordinatesPanelData;
  runset: RunsetData | undefined;
  api?: ApiClient;
}) {
  const client = useMemo(() => api ?? new ApiClient(), [api]);
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const seqRef = useRef(0);
  const fetchKey = useMemo(() => {
    if (!runset) return "";
    return [runset.projects.join(","), (runset.pinned_run_ids ?? []).join(",")].join(" ");
  }, [runset]);

  useEffect(() => {
    if (!runset) {
      setState({ kind: "idle" });
      return;
    }
    if (!runset.projects.length && !(runset.pinned_run_ids ?? []).length) {
      setState({ kind: "ready", runs: [] });
      return;
    }
    const seq = ++seqRef.current;
    const controller = new AbortController();
    setState({ kind: "loading" });
    (async () => {
      try {
        const runs = await fetchRuns(client, runset, controller.signal);
        if (seq !== seqRef.current) return;
        setState({ kind: "ready", runs });
      } catch (error) {
        if (seq !== seqRef.current) return;
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed to load runs",
        });
      }
    })();
    return () => controller.abort();
  }, [client, runset, fetchKey]);

  if (!runset) {
    return <div className="panel-chart panel-chart--empty">Runset {panel.runset_index} not configured.</div>;
  }
  if (state.kind === "loading") {
    return <div className="panel-chart panel-chart--loading">Loading parallel coords…</div>;
  }
  if (state.kind === "error") {
    return <div className="panel-chart panel-chart--error">Parallel coords error: {state.message}</div>;
  }
  if (state.kind !== "ready" || !state.runs.length) {
    return (
      <div className="panel-chart panel-chart--empty">No runs match this runset yet.</div>
    );
  }
  if (!panel.dimensions.length) {
    return (
      <div className="panel-chart panel-chart--empty">
        Add at least one dimension (config or metric) to draw parallel coords.
      </div>
    );
  }

  const visibleRuns = state.runs.filter((run) => {
    const settings = runset.run_settings?.[run.id];
    return !(settings?.disabled || settings?.hidden);
  });

  const axes = panel.dimensions.map((dim, index) => buildAxis(visibleRuns, dim, index));
  const width = chartWidth;
  const height = chartHeight;
  const padding = chartPadding;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const axisCount = Math.max(1, axes.length);
  const axisX = (index: number) =>
    padding + (axisCount === 1 ? innerW / 2 : (index / (axisCount - 1)) * innerW);

  return (
    <div className="panel-chart panel-chart--parallel">
      <svg
        className="metric-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Parallel coordinates"
      >
        {axes.map((axis, index) => (
          <g key={axis.label}>
            <line
              className="axis"
              x1={axisX(index)}
              x2={axisX(index)}
              y1={padding}
              y2={height - padding}
            />
            <text
              className="axis-label"
              x={axisX(index)}
              y={padding - 8}
              textAnchor="middle"
            >
              {axis.label}
            </text>
            <text
              className="tick-label"
              x={axisX(index)}
              y={height - padding + 14}
              textAnchor="middle"
            >
              {axis.format(axis.min)}
            </text>
            <text
              className="tick-label"
              x={axisX(index)}
              y={padding - 22}
              textAnchor="middle"
            >
              {axis.format(axis.max)}
            </text>
          </g>
        ))}
        {visibleRuns.map((run, runIndex) => {
          const settings: RunsetRunSettings = runset.run_settings?.[run.id] ?? {};
          const stroke = settings.color ?? RUN_COLOR_PALETTE[runIndex % RUN_COLOR_PALETTE.length];
          const points = axes
            .map((axis, axisIndex) => {
              const value = axis.runValues.get(run.id);
              if (value === undefined) return null;
              const ratio = axis.span === 0 ? 0.5 : (value - axis.min) / axis.span;
              const y = height - padding - ratio * innerH;
              return { x: axisX(axisIndex), y };
            })
            .filter((point): point is { x: number; y: number } => point !== null);
          if (points.length < 2) return null;
          const path = points
            .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
            .join(" ");
          return (
            <path
              key={run.id}
              d={path}
              stroke={stroke}
              strokeWidth={1.5}
              fill="none"
              opacity={0.85}
            >
              <title>{run.name}</title>
            </path>
          );
        })}
      </svg>
    </div>
  );
}

type Axis = {
  label: string;
  min: number;
  max: number;
  span: number;
  runValues: Map<string, number>;
  format: (value: number) => string;
};

function buildAxis(
  runs: ResolvedRun[],
  dimension: ParallelCoordinatesDimension,
  fallbackIndex: number,
): Axis {
  const label = dimension.metric_key ?? dimension.config_key ?? `dim-${fallbackIndex + 1}`;
  const numericValues = new Map<string, number>();
  const categoricalRanks: string[] = [];
  let allNumeric = true;
  for (const run of runs) {
    let raw: unknown;
    if (dimension.metric_key) {
      raw =
        readPath(run, prefixedPath("latest_metrics", dimension.metric_key)) ??
        readPath(run, dimension.metric_key.split("."));
    } else if (dimension.config_key) {
      raw =
        readPath(run, prefixedPath("config", dimension.config_key)) ??
        readPath(run, dimension.config_key.split("."));
    }
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      numericValues.set(run.id, raw);
    } else {
      allNumeric = false;
      const stringValue = String(raw);
      if (!categoricalRanks.includes(stringValue)) categoricalRanks.push(stringValue);
      numericValues.set(run.id, categoricalRanks.indexOf(stringValue));
    }
  }
  if (!allNumeric) {
    // Already mapped to ranks above.
  }
  const values = Array.from(numericValues.values());
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min;
  const format = (value: number) =>
    allNumeric
      ? Math.abs(value) >= 100 || Math.abs(value) < 0.01
        ? value.toExponential(2)
        : value.toFixed(2)
      : categoricalRanks[Math.round(value)] ?? "—";
  return { label, min, max, span, runValues: numericValues, format };
}

function prefixedPath(prefix: string, key: string): string[] {
  if (!key) return [prefix];
  if (key.startsWith(`${prefix}.`)) {
    return key.split(".");
  }
  return [prefix, ...key.split(".")];
}

function readPath(run: ResolvedRun, segments: string[]): unknown {
  let cursor: unknown = run as unknown;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

async function fetchRuns(
  api: ApiClient,
  runset: RunsetData,
  signal: AbortSignal,
): Promise<ResolvedRun[]> {
  const collected = new Map<string, ResolvedRun>();
  const limit = Math.min(MAX_RUNS_PER_PANEL, runset.limit ?? MAX_RUNS_PER_PANEL);
  for (const project of runset.projects) {
    if (signal.aborted) break;
    if (collected.size >= MAX_RUNS_PER_PANEL) break;
    const params = new URLSearchParams({ project, limit: String(limit) });
    const payload = await api.get(`/runs?${params.toString()}`, { signal });
    const runs = Array.isArray(payload?.runs) ? payload.runs : [];
    for (const raw of runs) {
      if (collected.size >= MAX_RUNS_PER_PANEL) break;
      const resolved = normalize(raw, project);
      if (resolved && !collected.has(resolved.id)) collected.set(resolved.id, resolved);
    }
  }
  return Array.from(collected.values());
}

function normalize(raw: unknown, fallbackProject: string): ResolvedRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof obj.name === "string" ? obj.name : id,
    project: typeof obj.project === "string" && obj.project ? obj.project : fallbackProject,
    config:
      typeof obj.config === "object" && obj.config !== null
        ? (obj.config as Record<string, unknown>)
        : {},
    latest_metrics:
      typeof obj.latest_metrics === "object" && obj.latest_metrics !== null
        ? (obj.latest_metrics as Record<string, unknown>)
        : {},
  };
}
