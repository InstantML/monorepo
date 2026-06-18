export const SYSTEM_USAGE_RANGES = [
  { value: "7d", label: "7 days", description: "Newest week" },
  { value: "14d", label: "14 days", description: "Recommended" },
  { value: "30d", label: "30 days", description: "Maximum window" },
];

export const SYSTEM_USAGE_GROUPS = [
  { value: "actor", label: "Employee", description: "Attribution label" },
  { value: "project", label: "Project", description: "Training project" },
  { value: "gpu_model", label: "GPU model", description: "Observed device" },
  { value: "run", label: "Run", description: "Individual runs" },
];

export function systemUsageQuery(filters = {}) {
  return {
    family: "gpu",
    range: filters.range || "14d",
    group_by: filters.groupBy || "actor",
    project: filters.project || "",
    actor: filters.actor || "",
    gpu_model: filters.gpuModel || "",
    min_coverage_pct: filters.minCoveragePct || "",
    limit: filters.limit || 100,
  };
}

export function normalizeSystemUsagePayload(payload) {
  const empty = {
    family: "gpu",
    generated_at: "",
    is_invoice_grade: false,
    period: { start: "", end: "", range: "14d", timezone: "UTC" },
    filters: { group_by: "actor", project: null, actor: null, gpu_model: null, min_coverage_pct: 0, limit: 100 },
    summary: {
      observed_gpu_hours: 0,
      utilized_gpu_hours: 0,
      low_utilization_gpu_hours: 0,
      avg_gpu_utilization_percent: null,
      max_gpu_memory_percent: null,
      energy_kwh: 0,
      sample_count: 0,
      run_count: 0,
      coverage_pct: null,
      utilization_buckets: [],
    },
    coverage: {
      runs_in_scope: 0,
      runs_with_gpu_metrics: 0,
      runs_missing_gpu_metrics: 0,
      sample_count: 0,
      coverage_pct: null,
      aggregate_truncated: false,
      low_confidence_attribution_rows: 0,
    },
    groups: [],
    top_runs: [],
    attention: [],
    available_filters: { projects: [], actors: [], gpu_models: [] },
    notes: [],
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty;
  return {
    ...empty,
    ...payload,
    period: { ...empty.period, ...(payload.period && typeof payload.period === "object" ? payload.period : {}) },
    filters: { ...empty.filters, ...(payload.filters && typeof payload.filters === "object" ? payload.filters : {}) },
    summary: { ...empty.summary, ...(payload.summary && typeof payload.summary === "object" ? payload.summary : {}) },
    coverage: { ...empty.coverage, ...(payload.coverage && typeof payload.coverage === "object" ? payload.coverage : {}) },
    available_filters: {
      ...empty.available_filters,
      ...(payload.available_filters && typeof payload.available_filters === "object" ? payload.available_filters : {}),
    },
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    top_runs: Array.isArray(payload.top_runs) ? payload.top_runs : [],
    attention: Array.isArray(payload.attention) ? payload.attention : [],
    notes: Array.isArray(payload.notes) ? payload.notes : [],
  };
}

export function systemUsageState(payload) {
  const data = normalizeSystemUsagePayload(payload);
  if (!data.coverage.runs_in_scope) return "no_runs";
  if (!data.coverage.runs_with_gpu_metrics) return "no_gpu_metrics";
  if (Number(data.coverage.coverage_pct ?? 0) < 50) return "partial";
  return "ready";
}

export function usageSeverityRank(severity) {
  if (severity === "crit" || severity === "bad") return 0;
  if (severity === "warn") return 1;
  return 2;
}

export function sortedAttentionCards(cards) {
  return [...(Array.isArray(cards) ? cards : [])].sort((a, b) => {
    const severity = usageSeverityRank(a?.severity) - usageSeverityRank(b?.severity);
    if (severity !== 0) return severity;
    return Number(b?.value ?? 0) - Number(a?.value ?? 0);
  });
}

export function formatGpuHours(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  if (numeric < 0.01 && numeric > 0) return "<0.01h";
  return `${formatCompact(numeric, numeric >= 10 ? 1 : 2)}h`;
}

export function formatPercentValue(value) {
  if (value == null || value === "") return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${formatCompact(numeric, numeric >= 10 ? 0 : 1)}%`;
}

export function formatEnergy(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "-";
  return `${formatCompact(numeric, numeric >= 10 ? 1 : 2)} kWh`;
}

export function formatSamples(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0 samples";
  return `${formatCompact(numeric, 0)} samples`;
}

export function formatCompact(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
    notation: Math.abs(numeric) >= 10000 ? "compact" : "standard",
  }).format(numeric);
}
