export const MAX_SELECTED_RUNS = 2000;
export const DEFAULT_SELECTED_RUNS = 100;
// Cap for the one-click "select all matching filter" action. Kept well below the
// 2000 hard cap because rendering many hundreds of SVG series degrades chart
// interactivity; 500 stays responsive while being a meaningful bulk step beyond
// the 100 runs auto-selected on load.
export const BULK_SELECT_MATCHING_LIMIT = 500;
export const INTERNAL_INSTANTML_METRIC_PREFIX = "system/instantml/";
const UPLOAD_HEALTH_HEARTBEAT_KEY = `${INTERNAL_INSTANTML_METRIC_PREFIX}upload_health_unix_seconds`;
const UPLOAD_HEALTH_LAG_KEY = `${INTERNAL_INSTANTML_METRIC_PREFIX}upload_lag_seconds`;
const UPLOAD_HEALTH_QUEUED_KEY = `${INTERNAL_INSTANTML_METRIC_PREFIX}queued_events`;
const UPLOAD_HEALTH_FAILED_KEY = `${INTERNAL_INSTANTML_METRIC_PREFIX}failed_events`;
const UPLOAD_HEALTH_DROPPED_KEY = `${INTERNAL_INSTANTML_METRIC_PREFIX}dropped_events`;
const UPLOAD_HEALTH_STALE_SECONDS = 30;
const UPLOAD_HEALTH_LAG_SECONDS = 5;

export function toggleSelection(selected, runId) {
  if (selected.includes(runId)) return selected.filter((id) => id !== runId);
  return [...selected, runId].slice(-MAX_SELECTED_RUNS);
}

export function visibleSelectionState(selected, visibleIds) {
  if (!Array.isArray(visibleIds) || visibleIds.length === 0) return "none";
  const selectedSet = new Set(selected);
  let count = 0;
  for (const id of visibleIds) if (selectedSet.has(id)) count += 1;
  if (count === 0) return "none";
  if (count === visibleIds.length) return "all";
  return "some";
}

export function selectAllVisible(selected, visibleIds) {
  if (!Array.isArray(visibleIds) || visibleIds.length === 0) return selected;
  const existing = new Set(selected);
  const merged = [...selected];
  for (const id of visibleIds) {
    if (!existing.has(id)) {
      merged.push(id);
      existing.add(id);
    }
  }
  return merged.slice(-MAX_SELECTED_RUNS);
}

export function deselectVisible(selected, visibleIds) {
  if (!Array.isArray(visibleIds) || visibleIds.length === 0) return selected;
  const removeSet = new Set(visibleIds);
  return selected.filter((id) => !removeSet.has(id));
}

export function rangeSelect(selected, orderedIds, anchorId, targetId) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return selected;
  const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
  const targetIndex = orderedIds.indexOf(targetId);
  if (targetIndex < 0) return selected;
  if (anchorIndex < 0 || anchorIndex === targetIndex) return toggleSelection(selected, targetId);
  const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  const range = orderedIds.slice(from, to + 1);
  return selectAllVisible(selected, range);
}

export function capSelectionToMatching(matchingIds, limit = BULK_SELECT_MATCHING_LIMIT) {
  if (!Array.isArray(matchingIds)) return [];
  return matchingIds.slice(0, limit);
}

export function defaultRunSelection(currentIds, runs, defaultInitialized) {
  const current = Array.isArray(currentIds) ? currentIds : [];
  if (current.length || defaultInitialized) {
    return { ids: current, initialized: defaultInitialized };
  }
  const ids = (Array.isArray(runs) ? runs : []).slice(0, DEFAULT_SELECTED_RUNS).map((run) => run?.id).filter(Boolean);
  if (!ids.length) return { ids: current, initialized: false };
  return { ids, initialized: ids.length > 0 };
}

export function metricKeysFromSummary(summary) {
  return [...new Set((summary?.metric_keys ?? []).filter((key) => key && !isInternalInstantMlMetric(key)))].sort();
}

export function isInternalInstantMlMetric(key) {
  return String(key ?? "").startsWith(INTERNAL_INSTANTML_METRIC_PREFIX);
}

const PREFERRED_METRIC_PATTERNS = [
  /^eval\/return_mean$/,
  /^test\/accuracy$/,
  /^test\/macro_f1$/,
  /^val\/accuracy$/,
  /^val\/r2$/,
  /^eval\//,
  /^test\//,
  /^val\//,
  /^train\/loss$/,
  /^train\//,
];

const MINIMIZE_METRIC_PATTERN = /(^|\/|_)(loss|error|err|perplexity|ppl|wer|cer|mae|mse|rmse|nll|kl|regret)(\/|_|$)/i;

export function preferredMetricKey(keys) {
  const uniqueKeys = [...new Set((keys ?? []).filter(Boolean))].sort();
  for (const pattern of PREFERRED_METRIC_PATTERNS) {
    const match = uniqueKeys.find((key) => pattern.test(key));
    if (match) return match;
  }
  return uniqueKeys[0] ?? "";
}

export function metricFilterIsRegex(pattern) {
  const trimmed = String(pattern ?? "").trim();
  if (!trimmed) return true;
  try {
    new RegExp(trimmed, "i");
    return true;
  } catch {
    return false;
  }
}

export function filterMetricKeys(keys, pattern) {
  const uniqueKeys = [...new Set((keys ?? []).filter((key) => key && !isInternalInstantMlMetric(key)))].sort();
  const trimmed = String(pattern ?? "").trim();
  if (!trimmed) return uniqueKeys;
  try {
    const regex = new RegExp(trimmed, "i");
    return uniqueKeys.filter((key) => regex.test(key));
  } catch {
    const lowered = trimmed.toLowerCase();
    return uniqueKeys.filter((key) => key.toLowerCase().includes(lowered));
  }
}

export function uploadHealthForRun(run, nowSeconds = Date.now() / 1000) {
  const metrics = run?.latest_metrics ?? {};
  const heartbeat = numericMetric(metrics[UPLOAD_HEALTH_HEARTBEAT_KEY]);
  if (heartbeat === null) return { tone: "neutral", label: "upload unknown", state: "unknown" };
  const failed = numericMetric(metrics[UPLOAD_HEALTH_FAILED_KEY]) ?? 0;
  const dropped = numericMetric(metrics[UPLOAD_HEALTH_DROPPED_KEY]) ?? 0;
  const queued = numericMetric(metrics[UPLOAD_HEALTH_QUEUED_KEY]) ?? 0;
  const lag = numericMetric(metrics[UPLOAD_HEALTH_LAG_KEY]) ?? 0;
  const stale = nowSeconds - heartbeat > UPLOAD_HEALTH_STALE_SECONDS;
  if (failed > 0 || dropped > 0) return { tone: "bad", label: "upload errors", state: "errors" };
  if (stale) return { tone: "neutral", label: "upload stale", state: "stale" };
  if (queued > 0 || lag > UPLOAD_HEALTH_LAG_SECONDS) {
    return { tone: "live", label: queued > 0 ? `syncing ${formatNumber(queued, 0)}` : "syncing", state: "syncing" };
  }
  return { tone: "good", label: "synced", state: "synced" };
}

export function bestMetric(run, key = "eval/return_mean") {
  const value = run?.latest_metrics?.[key];
  return typeof value === "number" ? value : null;
}

export function metricAggregate(run, key, aggregate = "latest") {
  const value = run?.metric_aggregates?.[key]?.[aggregate] ?? run?.latest_metrics?.[key];
  return typeof value === "number" ? value : null;
}

export function metricGoal(key = "") {
  return MINIMIZE_METRIC_PATTERN.test(String(key)) ? "minimize" : "maximize";
}

export function metricGoalLabel(key = "") {
  return metricGoal(key) === "minimize" ? "Lowest" : "Best";
}

export function metricGoalValue(run, key) {
  const aggregate = metricGoal(key) === "minimize" ? "min" : "max";
  return metricAggregate(run, key, aggregate);
}

export function sortRuns(runs, sortBy, metricKey) {
  const copy = [...runs];
  if (sortBy === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (sortBy === "status") return copy.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));
  if (sortBy === "metric-latest") return copy.sort((a, b) => numericDesc(metricAggregate(a, metricKey, "latest"), metricAggregate(b, metricKey, "latest")));
  if (sortBy === "metric-best") return metricGoal(metricKey) === "minimize"
    ? copy.sort((a, b) => numericAsc(metricGoalValue(a, metricKey), metricGoalValue(b, metricKey)))
    : copy.sort((a, b) => numericDesc(metricGoalValue(a, metricKey), metricGoalValue(b, metricKey)));
  if (sortBy === "duration") return copy.sort((a, b) => numericDesc(durationSeconds(a), durationSeconds(b)));
  return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function groupKeyForRun(run, groupBy) {
  if (groupBy === "seed") return String(run.config?.seed ?? "no-seed");
  if (groupBy === "tag") return run.tags?.[0] ?? "untagged";
  if (groupBy?.startsWith("config:")) return String(run.config?.[groupBy.slice(7)] ?? "missing");
  return "all";
}

// Resolve the label used to identify a run in chart legends, tooltips and the
// hover readout. Falls back to the run name whenever the chosen field is empty.
export function identifierForRun(run, mode) {
  if (!run) return undefined;
  if (mode === "notes") {
    const notes = typeof run.metadata?.notes === "string" ? run.metadata.notes.trim() : "";
    return notes || run.name;
  }
  if (mode === "tags") {
    const tags = Array.isArray(run.tags) ? run.tags.filter(Boolean) : [];
    return tags.length ? tags.join(", ") : run.name;
  }
  return run.name;
}

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function numericDesc(left, right) {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return rightValue - leftValue;
}

function numericMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericAsc(left, right) {
  const leftValue = left ?? Number.POSITIVE_INFINITY;
  const rightValue = right ?? Number.POSITIVE_INFINITY;
  return leftValue - rightValue;
}

function durationSeconds(run) {
  if (!run?.started_at || !run?.finished_at) return null;
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

export function durationLabel(run) {
  if (!run?.started_at || !run?.finished_at) return run?.status === "running" ? "running" : "-";
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

export function displayStatusForRun(run) {
  return run?.run_control?.display_status || run?.status || "";
}

export function canRequestStop(run, canControl = true) {
  if (!canControl || !run || run.status !== "running") return false;
  const state = run.run_control?.stop_state || "none";
  return state !== "requested" && state !== "acknowledged";
}

export function statusTone(status) {
  if (status === "finished") return "good";
  if (status === "failed") return "bad";
  if (status === "stopped") return "warning";
  if (status === "stopping") return "warning";
  return "live";
}
