export const HOSTED_BENCHMARK_BUDGETS_MS = Object.freeze({
  summary: 750,
  selection_projection: 2500,
  search_filter_sort: 1000,
  overview: 1000,
  chart: 750,
  batched_series: 2500,
});

export function budgetForCase(caseDefinition) {
  if (caseDefinition.budget_ms) return caseDefinition.budget_ms;
  const group = caseDefinition.budget_group || caseDefinition.group || caseDefinition.kind;
  return HOSTED_BENCHMARK_BUDGETS_MS[group] || HOSTED_BENCHMARK_BUDGETS_MS.search_filter_sort;
}

export function summarizeTimings(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  if (!sorted.length) {
    return {
      samples: 0,
      p50_ms: 0,
      p95_ms: 0,
      min_ms: 0,
      max_ms: 0,
      timings_ms: [],
    };
  }
  return {
    samples: sorted.length,
    p50_ms: roundMs(percentile(sorted, 0.5)),
    p95_ms: roundMs(percentile(sorted, 0.95)),
    min_ms: roundMs(sorted[0]),
    max_ms: roundMs(sorted[sorted.length - 1]),
    timings_ms: sorted.map(roundMs),
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

export function validateBenchmarkPayload(caseDefinition, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${caseDefinition.name} returned a non-object JSON payload`);
  }
  if (caseDefinition.kind === "overview") return validateOverview(caseDefinition, payload);
  if (caseDefinition.kind === "chart") return validateChart(caseDefinition, payload);
  if (caseDefinition.kind === "batched_series") return validateBatchedSeries(caseDefinition, payload);
  return validateSummary(caseDefinition, payload);
}

export function budgetFailures(result) {
  const measurements = result.measurements || [];
  return measurements
    .filter((measurement) => Number.isFinite(measurement.budget_ms) && measurement.p95_ms > measurement.budget_ms)
    .map((measurement) => `${measurement.name} p95 ${measurement.p95_ms}ms exceeded ${measurement.budget_ms}ms`);
}

export function sanitizeHostedBenchmarkResult(raw) {
  const result = {
    status: raw.status || "ok",
    generated_at: raw.generated_at,
    git: compactObject({
      commit: raw.git?.commit,
      branch: raw.git?.branch,
    }),
    environment: compactObject({
      platform: raw.environment?.platform,
      arch: raw.environment?.arch,
      node_version: raw.environment?.node_version,
      api_mode: raw.environment?.api_mode,
      api_host: hostOnly(raw.environment?.api_host),
      api_transport: raw.environment?.api_transport,
      warmed: raw.environment?.warmed,
    }),
    measurement_protocol: compactObject({
      warmups: raw.measurement_protocol?.warmups,
      samples: raw.measurement_protocol?.samples,
      p95: raw.measurement_protocol?.p95,
      endpoint_order: raw.measurement_protocol?.endpoint_order,
    }),
    dataset: compactObject({
      project: raw.dataset?.project,
      projects: raw.dataset?.projects,
      configured_runs: raw.dataset?.configured_runs,
      configured_min_runs: raw.dataset?.configured_min_runs,
      seeded_runs: raw.dataset?.seeded_runs,
      observed_runs: raw.dataset?.observed_runs,
      seeded_metric_points: raw.dataset?.seeded_metric_points,
      observed_metric_points: raw.dataset?.observed_metric_points,
      long_run_steps: raw.dataset?.long_run_steps,
      expected_steps_per_run: raw.dataset?.expected_steps_per_run,
      chart_limit: raw.dataset?.chart_limit,
      m4_buckets: raw.dataset?.m4_buckets,
      selected_run_count: raw.dataset?.selected_run_count,
      default_selected_run_count: raw.dataset?.default_selected_run_count,
      search_selected_run_count: raw.dataset?.search_selected_run_count,
      max_selected_run_count: raw.dataset?.max_selected_run_count,
      selection_search_query: raw.dataset?.selection_search_query,
      metric_key: raw.dataset?.metric_key,
      system_metric_key: raw.dataset?.system_metric_key,
      metric_keys: raw.dataset?.metric_keys,
      status_counts: raw.dataset?.status_counts,
    }),
    route: compactObject({
      provisioner: raw.route?.provisioner,
      endpoint_host: hostOnly(raw.route?.endpoint_host || raw.route?.endpoint),
      clickhouse_provider: raw.route?.clickhouse_provider,
      clickhouse_region: raw.route?.clickhouse_region,
    }),
    budgets_ms: compactObject(raw.budgets_ms || HOSTED_BENCHMARK_BUDGETS_MS),
    measurements: (raw.measurements || []).map(sanitizeMeasurement),
    notes: raw.notes,
  };
  const failures = budgetFailures(result);
  result.passed = failures.length === 0;
  result.failures = failures;
  return compactObject(result);
}

function validateSummary(caseDefinition, payload) {
  if (!Array.isArray(payload.runs)) throw new Error(`${caseDefinition.name} returned malformed runs payload`);
  const total = Number(payload.total);
  if (!Number.isFinite(total) || total < 0) throw new Error(`${caseDefinition.name} returned an invalid total`);
  const limit = Number(caseDefinition.limit || Number.POSITIVE_INFINITY);
  if (payload.runs.length > limit) {
    throw new Error(`${caseDefinition.name} returned ${payload.runs.length} rows for limit ${limit}`);
  }
  if (caseDefinition.expect_non_empty !== false && payload.runs.length === 0) {
    throw new Error(`${caseDefinition.name} returned an empty page for a known non-empty query`);
  }
  if (caseDefinition.expect_positive_total !== false && total <= 0) {
    throw new Error(`${caseDefinition.name} returned a non-positive total for a known non-empty query`);
  }
  if (caseDefinition.expected_status) {
    const mismatch = payload.runs.find((run) => run?.status !== caseDefinition.expected_status);
    if (mismatch) throw new Error(`${caseDefinition.name} returned status ${mismatch.status}, expected ${caseDefinition.expected_status}`);
  }
  if (caseDefinition.require_metric_key) {
    const keys = Array.isArray(payload.metric_keys) ? payload.metric_keys : [];
    if (!keys.includes(caseDefinition.require_metric_key)) {
      throw new Error(`${caseDefinition.name} did not include metric key ${caseDefinition.require_metric_key}`);
    }
  }
  if (caseDefinition.require_metric_summary_key && !payload.runs.some((run) => runHasMetricSummary(run, caseDefinition.require_metric_summary_key))) {
    throw new Error(`${caseDefinition.name} did not include metric summary ${caseDefinition.require_metric_summary_key}`);
  }
  if (caseDefinition.selection_projection && payload.projection !== "selection") {
    throw new Error(`${caseDefinition.name} did not return the selection projection`);
  }
  return {
    kind: "summary",
    rows: payload.runs.length,
    total,
    metric_keys: Array.isArray(payload.metric_keys) ? payload.metric_keys.length : 0,
    statuses: statusCounts(payload.runs),
  };
}

function validateOverview(caseDefinition, payload) {
  const overview = payload.overview;
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) {
    throw new Error(`${caseDefinition.name} returned malformed overview payload`);
  }
  for (const key of ["total_runs", "active_runs", "failed_runs", "metric_points"]) {
    if (!Number.isFinite(Number(overview[key]))) throw new Error(`${caseDefinition.name} overview.${key} is not numeric`);
  }
  return {
    kind: "overview",
    total_runs: Number(overview.total_runs),
    active_runs: Number(overview.active_runs),
    failed_runs: Number(overview.failed_runs),
    metric_points: Number(overview.metric_points),
  };
}

function validateChart(caseDefinition, payload) {
  if (!Array.isArray(payload.metrics)) throw new Error(`${caseDefinition.name} returned malformed metrics payload`);
  const limit = Number(caseDefinition.limit || Number.POSITIVE_INFINITY);
  if (payload.metrics.length > limit) throw new Error(`${caseDefinition.name} returned ${payload.metrics.length} metrics for limit ${limit}`);
  if (caseDefinition.expect_non_empty !== false && payload.metrics.length === 0) {
    throw new Error(`${caseDefinition.name} returned an empty metric series`);
  }
  return {
    kind: "chart",
    rows: payload.metrics.length,
    first_step: payload.metrics[0]?.step,
    last_step: payload.metrics.at(-1)?.step,
  };
}

function validateBatchedSeries(caseDefinition, payload) {
  if (!Array.isArray(payload.series)) {
    throw new Error(`${caseDefinition.name} returned malformed batched series payload`);
  }
  if (caseDefinition.expected_series !== undefined && payload.series.length !== caseDefinition.expected_series) {
    throw new Error(`${caseDefinition.name} returned ${payload.series.length} series, expected ${caseDefinition.expected_series}`);
  }
  const limit = Number(caseDefinition.limit || Number.POSITIVE_INFINITY);
  let rows = 0;
  let non_empty_series = 0;
  for (const series of payload.series) {
    if (!Array.isArray(series.metrics)) {
      throw new Error(`${caseDefinition.name} returned a series without metrics`);
    }
    if (series.metrics.length > limit) {
      throw new Error(`${caseDefinition.name} returned ${series.metrics.length} metrics for limit ${limit}`);
    }
    rows += series.metrics.length;
    if (series.metrics.length > 0) non_empty_series += 1;
  }
  if (caseDefinition.expect_non_empty !== false && rows === 0) {
    throw new Error(`${caseDefinition.name} returned empty batched series`);
  }
  if (caseDefinition.total_point_cap !== undefined) {
    const cap = Number(caseDefinition.total_point_cap);
    const effectiveLimit = Number(payload.effective_limit ?? limit);
    if (!Number.isFinite(effectiveLimit) || effectiveLimit * payload.series.length > cap) {
      throw new Error(`${caseDefinition.name} did not enforce total point cap ${cap}`);
    }
    if (rows > cap) {
      throw new Error(`${caseDefinition.name} returned ${rows} rows beyond total point cap ${cap}`);
    }
  }
  return compactObject({
    kind: "batched_series",
    series: payload.series.length,
    non_empty_series,
    rows,
    max_rows_per_series: payload.series.reduce((max, series) => Math.max(max, series.metrics.length), 0),
    requested_limit: payload.requested_limit,
    effective_limit: payload.effective_limit,
    requested_buckets: payload.requested_buckets,
    effective_buckets: payload.effective_buckets,
    total_point_cap: payload.total_point_cap,
  });
}

function sanitizeMeasurement(measurement) {
  return compactObject({
    name: measurement.name,
    kind: measurement.kind,
    group: measurement.group,
    method: measurement.method || "GET",
    route_template: measurement.route_template,
    limit: measurement.limit,
    budget_ms: measurement.budget_ms,
    samples: measurement.samples,
    p50_ms: measurement.p50_ms,
    p95_ms: measurement.p95_ms,
    min_ms: measurement.min_ms,
    max_ms: measurement.max_ms,
    timings_ms: Array.isArray(measurement.timings_ms) ? measurement.timings_ms.map(roundMs) : undefined,
    stats: compactObject(measurement.stats || {}),
    passed: Number.isFinite(measurement.budget_ms) ? measurement.p95_ms <= measurement.budget_ms : undefined,
  });
}

function runHasMetricSummary(run, key) {
  if (!run || typeof run !== "object") return false;
  if (run.latest_metrics && Object.prototype.hasOwnProperty.call(run.latest_metrics, key)) return true;
  const aggregate = run.metric_aggregates?.[key];
  return aggregate && Object.keys(aggregate).length > 0;
}

function statusCounts(runs) {
  const counts = {};
  for (const run of runs) {
    const status = run?.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function hostOnly(value) {
  if (!value) return undefined;
  try {
    const host = new URL(value).host;
    if (host) return host;
  } catch {
  }
  return String(value).split("/")[0];
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") continue;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const compacted = compactObject(entry);
      if (Object.keys(compacted).length > 0) result[key] = compacted;
      continue;
    }
    result[key] = entry;
  }
  return result;
}

function roundMs(value) {
  return Math.round(value);
}
