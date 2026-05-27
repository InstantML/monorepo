"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ApiClient } from "../../../../../src/api.js";
import type { RunComparerPanelData, RunsetData } from "../types";

type RunSummary = {
  id: string;
  name: string;
  project: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  latest_metrics: Record<string, unknown>;
  status: string;
};

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runs: RunSummary[] };

/**
 * Side-by-side run comparer panel. Dotted field paths (e.g. `config.lr` or
 * `summary.val_acc`) tunnel into the run's config / summary objects so a user
 * can build an ablation-style diff table without leaving the report.
 */
export function RunComparerRenderer({
  panel,
  runset,
  api,
}: {
  panel: RunComparerPanelData;
  runset: RunsetData | undefined;
  api?: ApiClient;
}) {
  const client = useMemo(() => api ?? new ApiClient(), [api]);
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const seqRef = useRef(0);

  const fetchKey = useMemo(() => panel.run_ids.slice().sort().join(","), [panel.run_ids]);

  useEffect(() => {
    if (!panel.run_ids.length) {
      setState({ kind: "ready", runs: [] });
      return;
    }
    const seq = ++seqRef.current;
    const controller = new AbortController();
    setState({ kind: "loading" });
    (async () => {
      try {
        const runs = await Promise.all(
          panel.run_ids.map((id) => fetchRunById(client, id, controller.signal)),
        );
        if (seq !== seqRef.current) return;
        setState({ kind: "ready", runs: runs.filter((run): run is RunSummary => run !== null) });
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
  }, [client, fetchKey, panel.run_ids]);

  if (!runset) {
    return <div className="panel-chart panel-chart--empty">Runset {panel.runset_index} not configured.</div>;
  }
  if (state.kind === "loading") {
    return <div className="panel-chart panel-chart--loading">Loading run comparer…</div>;
  }
  if (state.kind === "error") {
    return <div className="panel-chart panel-chart--error">Run comparer error: {state.message}</div>;
  }
  if (state.kind === "idle" || !state.runs.length) {
    return (
      <div className="panel-chart panel-chart--empty">
        Add run IDs and fields to populate the run comparer.
      </div>
    );
  }

  const fields = panel.fields.length ? panel.fields : ["config", "summary"];

  return (
    <div className="panel-chart panel-chart--run-comparer">
      <table className="panel-chart__compare">
        <thead>
          <tr>
            <th>Field</th>
            {state.runs.map((run) => (
              <th key={run.id} title={`${run.project} / ${run.name}`}>
                {run.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field}>
              <th scope="row">{field}</th>
              {state.runs.map((run) => (
                <td key={`${run.id}-${field}`}>{formatCell(extractField(run, field))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function fetchRunById(
  api: ApiClient,
  id: string,
  signal: AbortSignal,
): Promise<RunSummary | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;
  try {
    const payload = await api.get(`/runs/${encodeURIComponent(trimmed)}`, { signal });
    const run = payload?.run ?? payload;
    if (!run || typeof run !== "object") return null;
    return normalizeRunSummary(run as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    return null;
  }
}

function normalizeRunSummary(raw: Record<string, unknown>): RunSummary | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const objectField = (field: string): Record<string, unknown> =>
    typeof raw[field] === "object" && raw[field] !== null
      ? (raw[field] as Record<string, unknown>)
      : {};
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    project: typeof raw.project === "string" ? raw.project : "",
    config: objectField("config"),
    summary: objectField("summary"),
    latest_metrics: objectField("latest_metrics"),
    status: typeof raw.status === "string" ? raw.status : "unknown",
  };
}

function extractField(run: RunSummary, dotted: string): unknown {
  if (!dotted) return undefined;
  const segments = dotted.split(".");
  let cursor: unknown = run as unknown;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 1000 || (value !== 0 && Math.abs(value) < 0.001)) {
      return value.toExponential(3);
    }
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
