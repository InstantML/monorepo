"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { smoothSeries } from "../../../../src/charts.js";
import { distributionSummaryForRuns, latestMetricValues, scatterPointsForRuns } from "../../../../src/dashboard-panels.js";
import { parseEmbedTokenLocation } from "../../../../src/embed-token.js";
import type { components } from "../../../../src/types/api.generated";
import { metricTitle } from "../../../dashboard-models";
import { MetricChart, type ChartZoomRange } from "../../../dashboard/metrics/metric-chart";
import { DistributionPanelChart, LatestMetricPanelChart, ScatterPanelChart } from "../../../dashboard/runs/summary-panel-charts";

type EmbedCurrentSessionResponse = components["schemas"]["EmbedCurrentSessionResponse"];
type WorkspaceViewDataResponse = components["schemas"]["WorkspaceViewDataResponse"];
type WorkspaceViewData = components["schemas"]["WorkspaceViewData"];
type WorkspacePanelResult = components["schemas"]["WorkspaceViewDataPanelResult"];
type LatestPanelType = "bar" | "dot" | "histogram" | "value_histogram";

type ChartSeries = {
  id: string;
  name: string;
  identifier?: string;
  group: string;
  points: Array<{
    key: string;
    step: number;
    value: number;
    created_at?: string;
    smoothedValue?: number;
  }>;
};

type EmbeddedPanelBase = {
  id: string;
  metricKey: string;
  plottedLabel: string;
  title: string;
  warnings: string[];
};

type EmbeddedLinePanel = EmbeddedPanelBase & {
  kind: "line";
  series: ChartSeries[];
};

type EmbeddedLatestPanel = EmbeddedPanelBase & {
  kind: LatestPanelType;
  values: Array<{ id: string; index: number; name: string; value: number }>;
};

type EmbeddedScatterPanel = EmbeddedPanelBase & {
  kind: "scatter";
  missingCount: number;
  points: Array<{ id: string; name: string; x: number; y: number }>;
  xField: string;
  yField: string;
};

type EmbeddedDistributionPanel = EmbeddedPanelBase & {
  groupField?: string;
  kind: "distribution";
  replicateField?: string;
  summary: ReturnType<typeof distributionSummaryForRuns>;
  valueField: string;
};

type EmbeddedUnsupportedPanel = EmbeddedPanelBase & {
  kind: "unsupported";
  message: string;
};

type EmbeddedPanel =
  | EmbeddedLinePanel
  | EmbeddedLatestPanel
  | EmbeddedScatterPanel
  | EmbeddedDistributionPanel
  | EmbeddedUnsupportedPanel;

export function EmbeddedRunsCanvas({ sessionId }: { sessionId: string }) {
  const tokenRef = useRef("");
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [session, setSession] = useState<EmbedCurrentSessionResponse["embed_session"] | null>(null);
  const [viewData, setViewData] = useState<WorkspaceViewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const [smoothing, setSmoothing] = useState(0);
  const [zoomRangesByPanelId, setZoomRangesByPanelId] = useState<Record<string, ChartZoomRange>>({});

  const load = useCallback(async (refreshReason: "initial" | "manual") => {
    const token = tokenRef.current;
    if (!token) return;
    const sequence = requestSeqRef.current + 1;
    requestSeqRef.current = sequence;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setRefreshing(refreshReason !== "initial");
    if (refreshReason === "initial") setLoading(true);
    try {
      const current = await embedRequest<EmbedCurrentSessionResponse>(
        `/api/embed/sessions/${encodeURIComponent(sessionId)}/current`,
        token,
        { signal: controller.signal },
      );
      const data = await embedRequest<WorkspaceViewDataResponse>(
        `/api/embed/sessions/${encodeURIComponent(sessionId)}/runs/data`,
        token,
        {
          body: JSON.stringify({
            refresh_reason: refreshReason,
            options: {
              max_panels: 8,
              metric_point_limit: 500,
            },
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        },
      );
      if (requestSeqRef.current !== sequence) return;
      setSession(current.embed_session);
      setViewData(data.view_data);
      setLastUpdated(new Date().toISOString());
    } catch (loadError) {
      if (isAbortError(loadError) || requestSeqRef.current !== sequence) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load embedded runs.");
    } finally {
      if (requestSeqRef.current === sequence) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    const result = extractAndScrubEmbedToken();
    if (!result.token) {
      setError(result.error);
      setLoading(false);
      return undefined;
    }
    tokenRef.current = result.token;
    void load("initial");
    return () => {
      abortRef.current?.abort();
      tokenRef.current = "";
    };
  }, [load]);

  const panels = useMemo(() => (
    viewData ? embedPanelsFromViewData(viewData, smoothing) : []
  ), [smoothing, viewData]);
  const panelIds = useMemo(() => panels.map((panel) => panel.id), [panels]);
  const warningText = viewData?.warnings?.filter(Boolean).slice(0, 2).join(" ") ?? "";
  const expiresLabel = session ? shortDateTime(session.expires_at) : "";
  const updatedLabel = lastUpdated ? shortTime(lastUpdated) : "";

  useEffect(() => {
    const activePanelIds = new Set(panelIds);
    setZoomRangesByPanelId((current) => {
      let changed = false;
      const next: Record<string, ChartZoomRange> = {};
      for (const [panelId, range] of Object.entries(current)) {
        if (activePanelIds.has(panelId)) {
          next[panelId] = range;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [panelIds]);

  return (
    <main className="embed-shell" aria-busy={loading || refreshing}>
      <header className="embed-header">
        <div>
          <p className="embed-eyebrow">InstantML embed</p>
          <h1>Run metrics</h1>
        </div>
        <button
          aria-label="Refresh embedded run data"
          className="embed-icon-button"
          disabled={loading || refreshing || !tokenRef.current}
          onClick={() => void load("manual")}
          title="Refresh data"
          type="button"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>

      <section className="embed-meta" aria-label="Embed status">
        <span>{viewData ? `${viewData.run_ids.length} runs` : "Loading runs"}</span>
        {viewData ? <span>{pluralCount(viewData.metric_keys.length, "metric")}</span> : null}
        {expiresLabel ? <span>Expires {expiresLabel}</span> : null}
        {updatedLabel ? <span>Updated {updatedLabel}</span> : null}
      </section>

      {loading ? <div className="embed-state" role="status">Loading run diagram...</div> : null}
      {error ? <div className="embed-state embed-state-error" role="alert">{error}</div> : null}
      {!loading && !error && warningText ? <div className="embed-warning" role="status">{warningText}</div> : null}
      {!loading && !error && panels.length === 0 ? (
        <div className="embed-state" role="status">No metric panels are available for these runs.</div>
      ) : null}

      {!loading && !error && panels.length > 0 ? (
        <section className="embed-panel-grid" aria-label="Embedded metric charts">
          {panels.map((panel) => (
            <article className="embed-run-panel" key={panel.id}>
              <div className="embed-panel-head">
                <div>
                  <h2 title={panel.title}>{panel.title}</h2>
                  <p>{metricTitle(panel.metricKey)}</p>
                </div>
                <span>{panel.plottedLabel}</span>
              </div>
              {panel.warnings.length ? <p className="embed-panel-warning">{panel.warnings.slice(0, 2).join(" ")}</p> : null}
              {panel.kind === "line" ? (
                <MetricChart
                  emptyMessage="No logged series for this metric in the embedded run set."
                  height={260}
                  metricKey={panel.metricKey}
                  onSmoothingChange={setSmoothing}
                  onZoomRangeChange={(range) => {
                    setZoomRangesByPanelId((current) => {
                      const next = { ...current };
                      if (range) {
                        next[panel.id] = range;
                      } else {
                        delete next[panel.id];
                      }
                      return next;
                    });
                  }}
                  padding={34}
                  series={panel.series}
                  showChartOptions
                  showExportActions={false}
                  showLegend
                  showRange
                  showYAxisControls
                  smoothing={smoothing}
                  xMode="step"
                  zoomRange={zoomRangesByPanelId[panel.id] ?? null}
                />
              ) : panel.kind === "bar" || panel.kind === "dot" || panel.kind === "histogram" || panel.kind === "value_histogram" ? (
                <LatestMetricPanelChart
                  height={260}
                  metricKey={panel.metricKey}
                  padding={42}
                  type={panel.kind}
                  values={panel.values}
                  width={520}
                />
              ) : panel.kind === "scatter" ? (
                <ScatterPanelChart
                  height={260}
                  missingCount={panel.missingCount}
                  points={panel.points}
                  scopeLabel={viewData ? `${viewData.run_ids.length} runs` : "embedded runs"}
                  width={520}
                  xField={panel.xField}
                  yField={panel.yField}
                />
              ) : panel.kind === "distribution" ? (
                <DistributionPanelChart
                  groupField={panel.groupField}
                  height={260}
                  replicateField={panel.replicateField}
                  scopeLabel={viewData ? `${viewData.run_ids.length} runs` : "embedded runs"}
                  summary={panel.summary}
                  valueField={panel.valueField}
                  width={520}
                />
              ) : panel.kind === "unsupported" ? (
                <div className="chart-area" aria-label={`Unsupported panel ${panel.title}`}>
                  <div className="empty">{panel.message}</div>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}

async function embedRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "omit",
    headers,
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(embedErrorMessage(response.status, payload));
  }
  return payload as T;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function extractAndScrubEmbedToken() {
  try {
    const result = parseEmbedTokenLocation(window.location);
    window.history.replaceState(null, "", result.cleanUrl);
    return result;
  } catch {
    return {
      token: "",
      error: "This embed link is missing or has an invalid token.",
    };
  }
}

function embedPanelsFromViewData(viewData: WorkspaceViewData, smoothing: number): EmbeddedPanel[] {
  const runs = embeddedRuns(viewData);
  return viewData.panels
    .map((panel): EmbeddedPanel => {
      const base = embeddedPanelBase(panel);
      const type = normalizePanelType(panel.type);
      if (type === "line") {
        const series = smoothSeries(seriesForPanel(viewData, panel), smoothing);
        return {
          ...base,
          kind: "line",
          plottedLabel: `${series.length} plotted`,
          series,
        };
      }
      if (type === "bar" || type === "dot" || type === "histogram" || type === "value_histogram") {
        const values = latestMetricValues(runs, panel.metric_key);
        return {
          ...base,
          kind: type,
          plottedLabel: `${values.length} values`,
          values,
        };
      }
      if (type === "scatter") {
        const xField = fieldString(panel.x_field);
        const yField = fieldString(panel.y_field);
        if (!xField || !yField) {
          return {
            ...base,
            kind: "unsupported",
            message: "This scatter panel is missing numeric X and Y fields.",
            plottedLabel: "needs fields",
          };
        }
        const scatter = scatterPointsForRuns(runs, xField, yField);
        return {
          ...base,
          kind: "scatter",
          missingCount: scatter.missing,
          plottedLabel: `${scatter.points.length} plotted`,
          points: scatter.points,
          xField,
          yField,
        };
      }
      if (type === "distribution") {
        const valueField = fieldString(panel.value_field);
        if (!valueField) {
          return {
            ...base,
            kind: "unsupported",
            message: "This distribution panel is missing a numeric value field.",
            plottedLabel: "needs field",
          };
        }
        const groupField = fieldString(panel.group_field);
        const replicateField = fieldString(panel.replicate_field);
        const summary = distributionSummaryForRuns(runs, valueField, groupField, replicateField);
        return {
          ...base,
          groupField,
          kind: "distribution",
          plottedLabel: `${summary.plotted} plotted`,
          replicateField,
          summary,
          valueField,
        };
      }
      return {
        ...base,
        kind: "unsupported",
        message: `Panel type "${panel.type}" is not supported in run embeds yet.`,
        plottedLabel: "unsupported",
      };
    })
    .slice(0, 8);
}

function embeddedPanelBase(panel: WorkspacePanelResult): EmbeddedPanelBase {
  const warnings = Array.isArray(panel.warnings)
    ? panel.warnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0)
    : [];
  return {
    id: panel.id,
    title: panel.title || metricTitle(panel.metric_key),
    metricKey: panel.metric_key,
    plottedLabel: "",
    warnings,
  };
}

function normalizePanelType(type: string) {
  if (type === "line" || type === "bar" || type === "dot" || type === "histogram" || type === "value_histogram" || type === "scatter" || type === "distribution") {
    return type;
  }
  return "unsupported";
}

function fieldString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function embeddedRuns(viewData: WorkspaceViewData) {
  return viewData.runs.filter((run) => run && typeof run === "object" && !Array.isArray(run)) as Array<Record<string, unknown>>;
}

function seriesForPanel(viewData: WorkspaceViewData, panel: WorkspacePanelResult): ChartSeries[] {
  const seriesKey = panel.series_key ?? panel.metric_key;
  const metricSeries = viewData.metric_series.find((item) => item.metric_key === seriesKey);
  if (!metricSeries || !Array.isArray(metricSeries.series)) return [];
  const runNames = runNameLookup(viewData);
  return metricSeries.series
    .map((item): ChartSeries | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as { run_id?: unknown; metrics?: unknown };
      const runId = typeof record.run_id === "string" ? record.run_id : "";
      if (!runId || !Array.isArray(record.metrics)) return null;
      const points = record.metrics
        .map(metricPoint)
        .filter((point): point is ChartSeries["points"][number] => Boolean(point));
      if (!points.length) return null;
      const name = runNames.get(runId) ?? runId.slice(0, 8);
      return { id: runId, name, identifier: name, group: "embedded", points };
    })
    .filter((item): item is ChartSeries => Boolean(item));
}

function runNameLookup(viewData: WorkspaceViewData) {
  const lookup = new Map<string, string>();
  for (const item of viewData.runs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { id?: unknown; name?: unknown };
    if (typeof record.id === "string") {
      lookup.set(record.id, typeof record.name === "string" && record.name ? record.name : record.id.slice(0, 8));
    }
  }
  return lookup;
}

function metricPoint(value: unknown): ChartSeries["points"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as { key?: unknown; step?: unknown; value?: unknown; created_at?: unknown };
  const step = Number(point.step);
  const metricValue = Number(point.value);
  if (!Number.isFinite(step) || !Number.isFinite(metricValue)) return null;
  return {
    key: typeof point.key === "string" ? point.key : "",
    step,
    value: metricValue,
    created_at: typeof point.created_at === "string" ? point.created_at : undefined,
  };
}

function embedErrorMessage(status: number, payload: unknown) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const maybeError = (payload as { error?: unknown }).error;
    if (typeof maybeError === "string" && maybeError.length <= 180) return maybeError;
  }
  if (status === 401) return "This embed token is invalid or expired.";
  if (status === 403) return "This embed is no longer active.";
  if (status === 404) return "This embed was not found.";
  if (status === 429) return "This embed is refreshing too quickly. Try again shortly.";
  if (status >= 500) return "InstantML is unavailable. Try again shortly.";
  return "Unable to load embedded runs.";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function shortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function shortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function pluralCount(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
