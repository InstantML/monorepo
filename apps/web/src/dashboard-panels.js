import { metricGoal } from "./state.js";

export const METRIC_SERIES_PATCH_SIZE = 100;
export const DENSE_CHART_SERIES_THRESHOLD = 120;
export const DENSE_CHART_POINT_THRESHOLD = 8000;
export const FIELD_AGGREGATIONS = ["latest", "min", "max", "mean", "best"];
const FIELD_SEGMENT_MAX_LENGTH = 192;
const FIELD_ID_MAX_LENGTH = 512;
const FIELD_LABEL_MAX_LENGTH = 240;
const FIELD_CATALOG_MAX_FIELDS = 240;
const FIELD_CATALOG_MAX_RUNS = 25;
const FIELD_CATALOG_MAX_METRIC_KEYS = 240;
const FIELD_CATALOG_MAX_OBJECT_DEPTH = 8;
const FIELD_CATALOG_MAX_OBJECT_LEAVES_PER_RUN = 120;
const FIELD_CATALOG_MAX_OBJECT_NODES_PER_RUN = 500;
const FIELD_CATALOG_MAX_OBJECT_KEYS_PER_RUN = 500;
const FIELD_CATALOG_MAX_METRIC_KEYS_PER_RUN = FIELD_CATALOG_MAX_METRIC_KEYS * 2;
const FIELD_CATALOG_MAX_SUPPLEMENTAL_METRIC_KEYS = FIELD_CATALOG_MAX_METRIC_KEYS * 2;
const NUMERIC_STRING_MAX_LENGTH = 64;
const NUMERIC_STRING_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function wellFormedFieldSegment(value) {
  const source = String(value);
  if (!source || source.length > FIELD_SEGMENT_MAX_LENGTH) return null;
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += source[index] + source[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
    } else {
      result += source[index];
    }
  }
  return result;
}

export function encodeFieldSegment(value) {
  const segment = wellFormedFieldSegment(value);
  if (!segment) return "";
  try {
    return encodeURIComponent(segment);
  } catch {
    return "";
  }
}

export function decodeFieldSegment(value) {
  const segment = String(value);
  if (!segment || segment.length > FIELD_ID_MAX_LENGTH) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded && decoded.length <= FIELD_SEGMENT_MAX_LENGTH ? decoded : null;
  } catch {
    return null;
  }
}

export function pointerFromPath(path) {
  return `/${path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

export function pathFromPointer(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer.length > FIELD_ID_MAX_LENGTH) return null;
  const rawSegments = pointer.slice(1).split("/");
  if (!rawSegments.length || rawSegments.length > FIELD_CATALOG_MAX_OBJECT_DEPTH) return null;
  const path = [];
  for (const segment of rawSegments) {
    if (/(^|[^~])~([^01]|$)/.test(segment) || segment.length > FIELD_SEGMENT_MAX_LENGTH) return null;
    path.push(segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return path;
}

function roundTrippableFieldId(candidate) {
  return typeof candidate === "string" && candidate.length <= FIELD_ID_MAX_LENGTH && parseFieldId(candidate) ? candidate : "";
}

export function metricFieldId(metricKey, aggregation = "latest") {
  const encodedKey = encodeFieldSegment(metricKey);
  if (!encodedKey) return "";
  const agg = FIELD_AGGREGATIONS.includes(aggregation) ? aggregation : "latest";
  return roundTrippableFieldId(`metric:${encodedKey}:${agg}`);
}

export function objectFieldId(source, path) {
  const pointer = pointerFromPath(path);
  if (pointer.length > FIELD_SEGMENT_MAX_LENGTH) return "";
  const encodedPointer = encodeFieldSegment(pointer);
  if (!encodedPointer) return "";
  const safeSource = source === "metadata" ? "metadata" : "config";
  return roundTrippableFieldId(`${safeSource}:${encodedPointer}`);
}

export function runFieldId(field) {
  return field === "created_at_unix" ? "run:created_at_unix" : "run:duration_seconds";
}

export function parseFieldId(fieldId) {
  if (typeof fieldId !== "string" || !fieldId || fieldId.length > FIELD_ID_MAX_LENGTH) return null;
  const parts = fieldId.split(":");
  if (parts[0] === "metric" && parts.length === 3) {
    const aggregation = parts.at(-1);
    if (!FIELD_AGGREGATIONS.includes(aggregation)) return null;
    const key = decodeFieldSegment(parts[1]);
    if (!key) return null;
    return {
      source: "metric",
      key,
      aggregation,
    };
  }
  if ((parts[0] === "config" || parts[0] === "metadata") && parts.length === 2) {
    const pointer = decodeFieldSegment(parts[1]);
    const path = pathFromPointer(pointer);
    if (!path) return null;
    return {
      source: parts[0],
      path,
    };
  }
  if (parts[0] === "run" && parts.length === 2 && ["duration_seconds", "created_at_unix"].includes(parts[1])) {
    return { source: "run", field: parts[1] };
  }
  return null;
}

export function fieldLabel(fieldId) {
  const parsed = parseFieldId(fieldId);
  if (!parsed) return fieldId || "Field";
  if (parsed.source === "metric") {
    const direction = parsed.aggregation === "best" ? ` (${metricGoal(parsed.key) === "minimize" ? "min" : "max"})` : "";
    return `${parsed.key} ${parsed.aggregation}${direction}`.slice(0, FIELD_LABEL_MAX_LENGTH);
  }
  if (parsed.source === "run") return parsed.field === "created_at_unix" ? "Created time" : "Duration";
  return `${parsed.source}.${parsed.path.join(".")}`.slice(0, FIELD_LABEL_MAX_LENGTH);
}

function fieldText(field) {
  return `${field?.label ?? ""} ${field?.id ?? ""}`.toLowerCase();
}

export function preferredScatterXField(fields) {
  const options = Array.isArray(fields) ? fields.filter((field) => field?.id) : [];
  const configFields = options.filter((field) => field.source === "config");
  const preferredConfig = configFields.find((field) => /learning[\s_./:-]*rate|(^|[\s_./:-])lr($|[\s_./:-])/i.test(fieldText(field)))
    ?? configFields.find((field) => /batch([\s_./:-]*size)?/i.test(fieldText(field)))
    ?? configFields.find((field) => /(^|[\s_./:-])seed($|[\s_./:-])/i.test(fieldText(field)))
    ?? configFields[0];
  return preferredConfig?.id ?? options[0]?.id;
}

export function defaultScatterFields(metricKey, fields = []) {
  const fallbackX = runFieldId("duration_seconds");
  const fallbackY = runFieldId("created_at_unix");
  const preferredX = preferredScatterXField(fields);
  const bestY = metricFieldId(metricKey, "best");
  return {
    xField: parseFieldId(preferredX) ? preferredX : fallbackX,
    yField: parseFieldId(bestY) ? bestY : fallbackY,
  };
}

function finiteOrNull(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > NUMERIC_STRING_MAX_LENGTH || !NUMERIC_STRING_PATTERN.test(text)) return null;
    value = text;
  }
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function valueAtPath(value, path) {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = current[segment];
  }
  return current;
}

function walkNumericLeaves(value, visit, path = [], budget = { leaves: 0, nodes: 0, keys: 0 }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (path.length >= FIELD_CATALOG_MAX_OBJECT_DEPTH || budget.nodes >= FIELD_CATALOG_MAX_OBJECT_NODES_PER_RUN) return;
  budget.nodes += 1;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (
      budget.leaves >= FIELD_CATALOG_MAX_OBJECT_LEAVES_PER_RUN ||
      budget.nodes >= FIELD_CATALOG_MAX_OBJECT_NODES_PER_RUN ||
      budget.keys >= FIELD_CATALOG_MAX_OBJECT_KEYS_PER_RUN
    ) return;
    if (String(key).length > FIELD_SEGMENT_MAX_LENGTH) continue;
    budget.keys += 1;
    const child = value[key];
    const childPath = [...path, key];
    if (finiteOrNull(child) !== null) {
      budget.leaves += 1;
      visit(childPath);
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      walkNumericLeaves(child, visit, childPath, budget);
    }
  }
}

function runDurationSeconds(run) {
  const started = Date.parse(run?.started_at ?? "");
  const finished = Date.parse(run?.finished_at ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return (finished - started) / 1000;
}

function runCreatedUnix(run) {
  const created = Date.parse(run?.created_at ?? "");
  return Number.isFinite(created) ? created / 1000 : null;
}

export function fieldValueForRun(run, fieldId) {
  const parsed = parseFieldId(fieldId);
  if (!parsed) return null;
  if (parsed.source === "metric") {
    const aggregate = run?.metric_aggregates?.[parsed.key];
    if (!aggregate) return null;
    if (parsed.aggregation === "best") {
      return finiteOrNull(metricGoal(parsed.key) === "minimize" ? aggregate.min : aggregate.max);
    }
    return finiteOrNull(aggregate[parsed.aggregation]);
  }
  if (parsed.source === "config") return finiteOrNull(valueAtPath(run?.config, parsed.path));
  if (parsed.source === "metadata") return finiteOrNull(valueAtPath(run?.metadata, parsed.path));
  if (parsed.source === "run") return parsed.field === "created_at_unix" ? runCreatedUnix(run) : runDurationSeconds(run);
  return null;
}

export function buildRunFieldCatalog(runs, metricKeys = []) {
  const safeRuns = (Array.isArray(runs) ? runs : []).slice(0, FIELD_CATALOG_MAX_RUNS);
  const availableCounts = new Map();
  const keys = new Set();
  const addMetricKey = (key) => {
    if (typeof key !== "string" || !key || key.length > FIELD_SEGMENT_MAX_LENGTH) return false;
    if (keys.has(key)) return true;
    if (keys.size >= FIELD_CATALOG_MAX_METRIC_KEYS) return false;
    keys.add(key);
    return true;
  };
  const markAvailable = (id) => {
    if (typeof id !== "string" || id.length > FIELD_ID_MAX_LENGTH || !parseFieldId(id)) return;
    availableCounts.set(id, (availableCounts.get(id) ?? 0) + 1);
  };
  for (const run of safeRuns) {
    const aggregates = run?.metric_aggregates ?? {};
    let metricKeysSeen = 0;
    for (const key in aggregates) {
      if (!Object.prototype.hasOwnProperty.call(aggregates, key)) continue;
      if (metricKeysSeen >= FIELD_CATALOG_MAX_METRIC_KEYS_PER_RUN) break;
      metricKeysSeen += 1;
      const keyAccepted = addMetricKey(key);
      if (!keyAccepted && !keys.has(key)) continue;
      const aggregate = aggregates[key];
      for (const aggregation of FIELD_AGGREGATIONS) {
        const value = aggregation === "best"
          ? metricGoal(key) === "minimize" ? aggregate?.min : aggregate?.max
          : aggregate?.[aggregation];
        if (finiteOrNull(value) !== null) markAvailable(metricFieldId(key, aggregation));
      }
    }
    walkNumericLeaves(run?.config, (path) => markAvailable(objectFieldId("config", path)));
    walkNumericLeaves(run?.metadata, (path) => markAvailable(objectFieldId("metadata", path)));
  }
  let supplementalMetricKeysSeen = 0;
  for (const key of Array.isArray(metricKeys) ? metricKeys : []) {
    if (keys.size >= FIELD_CATALOG_MAX_METRIC_KEYS || supplementalMetricKeysSeen >= FIELD_CATALOG_MAX_SUPPLEMENTAL_METRIC_KEYS) break;
    supplementalMetricKeysSeen += 1;
    addMetricKey(key);
  }
  for (const key of [...keys].sort()) {
    for (const aggregation of FIELD_AGGREGATIONS) {
      const id = metricFieldId(key, aggregation);
      if (id && !availableCounts.has(id)) availableCounts.set(id, 0);
    }
  }
  for (const runField of [runFieldId("duration_seconds"), runFieldId("created_at_unix")]) {
    for (const run of safeRuns) {
      if (fieldValueForRun(run, runField) !== null) markAvailable(runField);
    }
    if (!availableCounts.has(runField)) availableCounts.set(runField, 0);
  }

  return [...availableCounts.entries()]
    .map(([id, availableCount]) => {
      const parsed = parseFieldId(id);
      if (!parsed) return null;
      return {
        id,
        label: fieldLabel(id),
        source: parsed?.source ?? "unknown",
        valueType: "number",
        availableCount,
        missingCount: Math.max(0, safeRuns.length - availableCount),
      };
    })
    .filter((field) => field?.availableCount > 0)
    .sort((left, right) => (
      sourceRank(left.source) - sourceRank(right.source) ||
      right.availableCount - left.availableCount ||
      left.label.localeCompare(right.label)
    ))
    .slice(0, FIELD_CATALOG_MAX_FIELDS);
}

function sourceRank(source) {
  if (source === "config") return 0;
  if (source === "run") return 1;
  if (source === "metric") return 2;
  if (source === "metadata") return 3;
  return 4;
}

export function scatterPointsForRuns(runs, xField, yField) {
  const points = [];
  let missing = 0;
  for (const [index, run] of (runs ?? []).entries()) {
    const x = fieldValueForRun(run, xField);
    const y = fieldValueForRun(run, yField);
    if (x === null || y === null) {
      missing += 1;
      continue;
    }
    points.push({
      id: run?.id ?? `run-${index}`,
      name: run?.name ?? `Run ${index + 1}`,
      run,
      x,
      y,
    });
  }
  return { points, missing };
}

export function adaptiveMetricSeriesLimit(runCount) {
  if (runCount >= 1500) return 60;
  if (runCount >= 800) return 80;
  if (runCount >= 400) return 120;
  if (runCount >= 250) return 160;
  if (runCount >= 100) return 250;
  if (runCount >= 50) return 500;
  return 1000;
}

export function adaptiveMetricSeriesPatchSize(runCount) {
  if (runCount >= 1500) return 2000;
  if (runCount >= 500) return 500;
  if (runCount >= 250) return 250;
  return METRIC_SERIES_PATCH_SIZE;
}

export function chunkRunIds(runs, size = adaptiveMetricSeriesPatchSize(runs.length)) {
  const ids = runs.map((run) => run?.id).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export function mergeMetricSeriesPatches(runs, current, patch) {
  const byId = new Map(current.map((series) => [series.id, series]));
  for (const series of patch) byId.set(series.id, series);
  return runs
    .filter((run) => run?.id)
    .map((run) => byId.get(run.id) ?? { id: run.id, name: run.name, group: "all", points: [] });
}

export function latestMetricValues(runs, metricKey) {
  return runs
    .map((run, index) => {
      const latest = run?.metric_aggregates?.[metricKey]?.latest;
      return {
        id: run?.id ?? `run-${index}`,
        index,
        name: run?.name ?? `Run ${index + 1}`,
        value: Number(latest),
      };
    })
    .filter((item) => Number.isFinite(item.value));
}

export function histogramBins(values, requestedBins = 12) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return [{ min, max, count: finite.length }];
  const binCount = Math.max(1, Math.min(requestedBins, Math.ceil(Math.sqrt(finite.length))));
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    min: min + index * width,
    max: index === binCount - 1 ? max : min + (index + 1) * width,
    count: 0,
  }));
  for (const value of finite) {
    const rawIndex = Math.floor((value - min) / width);
    const index = Math.max(0, Math.min(bins.length - 1, rawIndex));
    bins[index].count += 1;
  }
  return bins;
}

export function indexedAxisTicks(length, count = 5) {
  const safeLength = Math.floor(Number(length));
  if (!Number.isFinite(safeLength) || safeLength <= 0) return [];
  if (safeLength === 1) return [0];
  const tickCount = Math.max(2, Math.min(Math.floor(count), safeLength));
  const maxIndex = safeLength - 1;
  const ticks = [];
  for (let index = 0; index < tickCount; index += 1) {
    ticks.push(Math.round((maxIndex * index) / (tickCount - 1)));
  }
  return [...new Set(ticks)];
}

export function chartPointCount(series) {
  return (series ?? []).reduce((sum, item) => sum + (item?.normalizedPoints?.length ?? item?.points?.length ?? 0), 0);
}

export function shouldUseDenseChart(series) {
  const plottedSeries = (series ?? []).filter((item) => (item?.normalizedPoints?.length ?? item?.points?.length ?? 0) > 0);
  return plottedSeries.length > DENSE_CHART_SERIES_THRESHOLD || chartPointCount(plottedSeries) > DENSE_CHART_POINT_THRESHOLD;
}
