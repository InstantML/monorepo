"use client";

import { AlertTriangle, BarChart3, Cpu, Gauge, RefreshCw, Server, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError, isAbortError, queryString, retryTransientRequest } from "../../../src/api.js";
import {
  formatCompact,
  formatEnergy,
  formatGpuHours,
  formatPercentValue,
  formatSamples,
  normalizeSystemUsagePayload,
  sortedAttentionCards,
  systemUsageQuery,
  systemUsageState,
  SYSTEM_USAGE_GROUPS,
  SYSTEM_USAGE_RANGES,
} from "../../../src/system-usage-insights.js";
import type { RunSummary } from "../../dashboard-types";
import type { components } from "../../../src/types/api.generated";
import { AnalysisCard, ChartHelp } from "../ui/analysis-card";
import { CustomSelect } from "../ui/select";

type SystemUsagePayload = components["schemas"]["SystemUsageInsightsEnvelope"];
type BreakdownRow = components["schemas"]["SystemUsageBreakdownRow"];
type RunRow = components["schemas"]["SystemUsageRunRow"];
type AttentionCard = components["schemas"]["SystemUsageAttentionCard"];

type UsageFilters = {
  actor: string;
  gpuModel: string;
  groupBy: "actor" | "project" | "gpu_model" | "run";
  minCoveragePct: string;
  project: string;
  range: "7d" | "14d" | "30d";
};

const COVERAGE_OPTIONS = [
  { value: "", label: "Any coverage", description: "Show all rows" },
  { value: "25", label: "25%+", description: "Some telemetry" },
  { value: "50", label: "50%+", description: "Useful estimates" },
  { value: "80", label: "80%+", description: "High confidence" },
];

const INITIAL_FILTERS: UsageFilters = {
  actor: "",
  gpuModel: "",
  groupBy: "actor",
  minCoveragePct: "",
  project: "",
  range: "14d",
};

type Props = {
  api: { get: (path: string, options?: Record<string, unknown>) => Promise<any> };
  project?: string;
  selectedRunIds: string[];
  sortedRuns: RunSummary[];
  onSelectRun?: (runId: string) => void;
};

export function SystemUsageInsightsPane({ api, project = "", selectedRunIds, sortedRuns, onSelectRun }: Props) {
  const [filters, setFilters] = useState<UsageFilters>({ ...INITIAL_FILTERS, project });
  const [payload, setPayload] = useState<SystemUsagePayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    setFilters((current) => ({ ...current, project }));
  }, [project]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = systemUsageQuery({
      range: filters.range,
      groupBy: filters.groupBy,
      project: filters.project,
      actor: filters.actor,
      gpuModel: filters.gpuModel,
      minCoveragePct: filters.minCoveragePct,
      limit: 100,
    });
    retryTransientRequest(
      () => api.get(`/api/insights/system-usage${queryString(query)}`, { signal: controller.signal }),
      { signal: controller.signal },
    ).then((next) => {
      setPayload(normalizeSystemUsagePayload(next) as SystemUsagePayload);
    }).catch((loadError) => {
      if (isAbortError(loadError)) return;
      const message = loadError instanceof ApiError ? loadError.safeMessage : loadError instanceof Error ? loadError.message : "Unable to load GPU usage insights.";
      setError(message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, filters.actor, filters.gpuModel, filters.groupBy, filters.minCoveragePct, filters.project, filters.range, refreshVersion]);

  const data = useMemo(() => normalizeSystemUsagePayload(payload) as SystemUsagePayload, [payload]);
  const state = systemUsageState(data);
  const attention = useMemo(() => sortedAttentionCards(data.attention) as AttentionCard[], [data.attention]);
  const selectedLoaded = selectedRunIds.filter((id) => sortedRuns.some((run) => run.id === id)).length;
  const busy = loading && !payload;
  const hasInitialError = Boolean(error && !payload && !loading);
  const showContent = !busy && !hasInitialError && (state === "ready" || state === "partial");
  const displayedGroupBy = String(data.filters?.group_by || filters.groupBy);

  return (
    <div className="usage-insights" aria-busy={loading}>
      <UsageScopeBar
        data={data}
        filters={filters}
        loading={loading}
        selectedLoaded={selectedLoaded}
        totalLoaded={sortedRuns.length}
        onChange={setFilters}
        onRefresh={() => setRefreshVersion((version) => version + 1)}
      />
      {error ? <UsageErrorBanner message={error} onRetry={() => setRefreshVersion((version) => version + 1)} /> : null}
      {loading && payload ? <div className="usage-refresh-status" role="status" aria-live="polite">Refreshing usage estimates...</div> : null}
      {busy ? <UsageSkeleton /> : null}
      {!busy && !hasInitialError && state === "no_runs" ? <UsageEmptyState kind="no_runs" /> : null}
      {!busy && !hasInitialError && state === "no_gpu_metrics" ? <UsageEmptyState kind="no_gpu_metrics" /> : null}
      {showContent ? (
        <>
          <UsageKpiStrip data={data} />
          {state === "partial" ? (
            <div className="usage-warning" role="status">
              Telemetry coverage is partial. Treat low usage as an estimate until more system metrics are logged.
            </div>
          ) : null}
          <section className="analysis-grid two">
            <UsageAttentionCards cards={attention} />
            <CoveragePanel data={data} />
          </section>
          <section className="analysis-grid two">
            <UsageBreakdownTable rows={data.groups as BreakdownRow[]} groupBy={displayedGroupBy} />
            <TopUsageRunsTable rows={data.top_runs as RunRow[]} onSelectRun={onSelectRun} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function UsageScopeBar({
  data,
  filters,
  loading,
  selectedLoaded,
  totalLoaded,
  onChange,
  onRefresh,
}: {
  data: SystemUsagePayload;
  filters: UsageFilters;
  loading: boolean;
  selectedLoaded: number;
  totalLoaded: number;
  onChange: (next: UsageFilters) => void;
  onRefresh: () => void;
}) {
  const projectOptions = [{ value: "", label: "All projects", description: "No project filter" }, ...(data.available_filters?.projects ?? [])];
  const actorOptions = [{ value: "", label: "All employees", description: "No actor filter" }, ...(data.available_filters?.actors ?? [])];
  const gpuOptions = [{ value: "", label: "All GPUs", description: "No model filter" }, ...(data.available_filters?.gpu_models ?? [])];
  return (
    <section className="usage-scope-bar" aria-label="GPU usage filters">
      <div className="usage-scope-summary">
        <span>GPU & system usage</span>
        <strong>{periodLabel(data)}</strong>
        <small>
          {formatCompact(totalLoaded, 0)} loaded runs
          {selectedLoaded ? ` · ${formatCompact(selectedLoaded, 0)} selected` : ""}
          {" · "}
          last updated {data.generated_at ? new Date(data.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"}
        </small>
      </div>
      <div className="usage-filter-row">
        <CustomSelect id="usage-range" label="Window" onChange={(range) => onChange({ ...filters, range: range as UsageFilters["range"] })} options={SYSTEM_USAGE_RANGES} value={filters.range} />
        <CustomSelect id="usage-group" label="Group" onChange={(groupBy) => onChange({ ...filters, groupBy: groupBy as UsageFilters["groupBy"] })} options={SYSTEM_USAGE_GROUPS} value={filters.groupBy} />
        <CustomSelect id="usage-project" label="Project" onChange={(project) => onChange({ ...filters, project })} options={projectOptions} value={filters.project} />
        <CustomSelect id="usage-actor" label="Employee" onChange={(actor) => onChange({ ...filters, actor })} options={actorOptions} value={filters.actor} />
        <CustomSelect id="usage-gpu-model" label="GPU" onChange={(gpuModel) => onChange({ ...filters, gpuModel })} options={gpuOptions} value={filters.gpuModel} />
        <CustomSelect id="usage-coverage" label="Coverage" onChange={(minCoveragePct) => onChange({ ...filters, minCoveragePct })} options={COVERAGE_OPTIONS} value={filters.minCoveragePct} />
        <button className="icon-button framed usage-refresh-button" type="button" onClick={onRefresh} aria-label="Refresh GPU usage insights" disabled={loading}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function UsageKpiStrip({ data }: { data: SystemUsagePayload }) {
  const kpis = [
    {
      icon: Gauge,
      label: "Observed GPU time",
      value: formatGpuHours(data.summary.observed_gpu_hours),
      sub: `${formatSamples(data.summary.sample_count)} logged`,
      help: "Estimated from GPU utilization samples and their logged timestamps.",
    },
    {
      icon: Zap,
      label: "Utilized GPU time",
      value: formatGpuHours(data.summary.utilized_gpu_hours),
      sub: `${formatPercentValue(data.summary.avg_gpu_utilization_percent)} average util`,
      help: "Observed GPU time weighted by utilization percent.",
    },
    {
      icon: AlertTriangle,
      label: "Low utilization",
      value: formatGpuHours(data.summary.low_utilization_gpu_hours),
      sub: "below 30% utilization",
      help: "Observed time where utilization samples fell below 30%.",
    },
    {
      icon: BarChart3,
      label: "Memory pressure",
      value: formatPercentValue(data.summary.max_gpu_memory_percent),
      sub: "max observed memory",
      help: "Highest GPU memory percentage reported in the selected window.",
    },
    {
      icon: Server,
      label: "Coverage",
      value: formatPercentValue(data.summary.coverage_pct),
      sub: `${formatCompact(data.coverage.runs_with_gpu_metrics, 0)} / ${formatCompact(data.coverage.runs_in_scope, 0)} runs`,
      help: "Observed GPU telemetry divided by the run time window where telemetry was expected.",
    },
    {
      icon: Cpu,
      label: "Energy",
      value: formatEnergy(data.summary.energy_kwh),
      sub: "when power is logged",
      help: "Estimated from GPU power samples. Hidden when the SDK cannot report power.",
    },
  ];
  return (
    <section className="usage-kpi-strip" aria-label="GPU usage summary">
      {kpis.map((item) => {
        const Icon = item.icon;
        return (
          <article className="usage-kpi" key={item.label}>
            <span><Icon size={14} aria-hidden="true" />{item.label}</span>
            <strong>{item.value}</strong>
            <small>{item.sub}</small>
            <ChartHelp label={item.label}>{item.help}</ChartHelp>
          </article>
        );
      })}
    </section>
  );
}

function UsageAttentionCards({ cards }: { cards: AttentionCard[] }) {
  return (
    <AnalysisCard title="Attention" badge={cards.length ? `${cards.length} signals` : undefined} help="Signals are simple heuristics over logged GPU, CPU, memory, and run status data.">
      {cards.length ? (
        <div className="usage-attention-list">
          {cards.map((card) => (
            <article className={`usage-attention-card ${card.severity}`} key={card.id}>
              <span>{card.title}</span>
              <strong>{card.metric === "gpu_hours" ? formatGpuHours(card.value) : formatCompact(card.value, 0)}</strong>
              <p>{card.message}</p>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty compact-empty">No usage signals for this window.</div>
      )}
    </AnalysisCard>
  );
}

function CoveragePanel({ data }: { data: SystemUsagePayload }) {
  return (
    <AnalysisCard title="Telemetry coverage" badge={formatPercentValue(data.coverage.coverage_pct)} help="Coverage shows how much logged GPU telemetry InstantML observed relative to the selected run window.">
      <dl className="usage-coverage-grid">
        <div><dt>Runs in scope</dt><dd>{formatCompact(data.coverage.runs_in_scope, 0)}</dd></div>
        <div><dt>With GPU metrics</dt><dd>{formatCompact(data.coverage.runs_with_gpu_metrics, 0)}</dd></div>
        <div><dt>Missing GPU metrics</dt><dd>{formatCompact(data.coverage.runs_missing_gpu_metrics, 0)}</dd></div>
        <div><dt>Low-confidence attribution</dt><dd>{formatCompact(data.coverage.low_confidence_attribution_rows, 0)}</dd></div>
      </dl>
      <UtilizationBucketBar buckets={data.summary.utilization_buckets ?? []} />
      {data.coverage.aggregate_truncated ? <p className="usage-note" role="status">Result set capped to keep the query bounded.</p> : null}
    </AnalysisCard>
  );
}

function UsageBreakdownTable({ rows, groupBy }: { rows: BreakdownRow[]; groupBy: string }) {
  return (
    <AnalysisCard title="Breakdown" badge={groupLabel(groupBy)} help="Rows are grouped server-side and every value is estimated from logged telemetry.">
      {rows.length ? (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption>Observed GPU usage grouped by {groupLabel(groupBy).toLowerCase()}</caption>
            <thead>
              <tr>
                <th scope="col">{groupLabel(groupBy)}</th>
                <th scope="col">GPU hours</th>
                <th scope="col">Utilization</th>
                <th scope="col">Coverage</th>
                <th scope="col">Runs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <span className="usage-row-title">{row.label}</span>
                    {row.actor_confidence ? <AttributionBadge source={row.actor_source ?? ""} confidence={row.actor_confidence} /> : null}
                  </th>
                  <td>{formatGpuHours(row.observed_gpu_hours)}</td>
                  <td>{formatPercentValue(row.avg_gpu_utilization_percent)}</td>
                  <td><CoverageBadge value={row.coverage_pct} /></td>
                  <td>{formatCompact(row.run_count, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact-empty">No grouped usage rows match the filters.</div>
      )}
    </AnalysisCard>
  );
}

function TopUsageRunsTable({ rows, onSelectRun }: { rows: RunRow[]; onSelectRun?: (runId: string) => void }) {
  return (
    <AnalysisCard title="Top runs" badge={rows.length ? `${rows.length} runs` : undefined} help="Highest observed GPU-hour runs in the selected window.">
      {rows.length ? (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption>Runs with the highest observed GPU usage</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">GPU hours</th>
                <th scope="col">Utilization</th>
                <th scope="col">Memory</th>
                <th scope="col">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.run_id}>
                  <th scope="row">
                    <button className="usage-run-link" type="button" onClick={() => onSelectRun?.(row.run_id)}>
                      {row.run_name}
                    </button>
                    <span>{row.project} / {row.status}</span>
                  </th>
                  <td>{formatGpuHours(row.observed_gpu_hours)}</td>
                  <td>{formatPercentValue(row.avg_gpu_utilization_percent)}</td>
                  <td>{formatPercentValue(row.max_gpu_memory_percent)}</td>
                  <td><CoverageBadge value={row.coverage_pct} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty compact-empty">No run-level GPU usage in this window.</div>
      )}
    </AnalysisCard>
  );
}

function UtilizationBucketBar({ buckets }: { buckets: Array<{ bucket: string; gpu_hours: number }> }) {
  const total = buckets.reduce((sum, bucket) => sum + Number(bucket.gpu_hours || 0), 0);
  if (!total) return <div className="empty compact-empty">No utilization bucket samples yet.</div>;
  return (
    <div className="usage-bucket-bar" role="img" aria-label={`GPU utilization bucket distribution across ${formatGpuHours(total)}`}>
      {buckets.map((bucket) => (
        <span key={bucket.bucket} style={{ width: `${Math.max(3, (Number(bucket.gpu_hours || 0) / total) * 100)}%` }}>
          <i>{bucket.bucket}%</i>
        </span>
      ))}
    </div>
  );
}

function CoverageBadge({ value }: { value?: number | null }) {
  const numeric = Number(value);
  const tone = Number.isFinite(numeric) && numeric >= 80 ? "good" : Number.isFinite(numeric) && numeric >= 50 ? "warn" : "low";
  return <span className={`usage-coverage-badge ${tone}`}>{formatPercentValue(value)}</span>;
}

function AttributionBadge({ source, confidence }: { source: string; confidence: string }) {
  return <span className={`usage-attribution-badge ${confidence}`}>{confidence} / {source || "unknown"}</span>;
}

function UsageErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="usage-error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div className="usage-skeleton" aria-live="polite">
      <div className="usage-kpi-strip">
        {Array.from({ length: 6 }, (_, index) => <span className="usage-skeleton-tile" key={index} />)}
      </div>
      <section className="analysis-grid two">
        <span className="usage-skeleton-panel" />
        <span className="usage-skeleton-panel" />
      </section>
    </div>
  );
}

function UsageEmptyState({ kind }: { kind: "no_runs" | "no_gpu_metrics" }) {
  return (
    <div className="analysis-empty-state" role="status">
      <strong>{kind === "no_runs" ? "No runs in this window." : "No GPU metrics found."}</strong>
      <p>{kind === "no_runs" ? "Choose a wider time range or project to inspect usage." : "Enable SDK system metrics to collect GPU utilization, memory, and power telemetry."}</p>
    </div>
  );
}

function groupLabel(groupBy: string) {
  if (groupBy === "project") return "Project";
  if (groupBy === "gpu_model") return "GPU model";
  if (groupBy === "run") return "Run";
  return "Employee";
}

function periodLabel(data: SystemUsagePayload) {
  const range = data.period?.range ? `${data.period.range} window` : "Selected window";
  const coverage = data.summary?.coverage_pct == null ? "coverage unknown" : `${formatPercentValue(data.summary.coverage_pct)} coverage`;
  return `${range} / ${coverage}`;
}
