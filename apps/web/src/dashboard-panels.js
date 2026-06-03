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
const CATEGORICAL_LABEL_MAX_LENGTH = 80;
const CATEGORICAL_VALUE_MAX_LENGTH = 120;
const CATEGORICAL_CATALOG_MAX_FIELDS = 160;
const CATEGORICAL_MAX_GROUPS = 24;
const DISTRIBUTION_STRIP_POINT_LIMIT = 25;
const PARALLEL_AXIS_LIMIT = 8;
const HISTOGRAM_FRAME_LIMIT = 100;
const HISTOGRAM_MAX_BINS = 1024;
const HISTOGRAM_BIN_COMPAT_EPSILON = 1e-9;

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

export function runCategoricalFieldId(field) {
  return field === "first_tag" ? "run:first_tag" : "run:status";
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

export function parseCategoricalFieldId(fieldId) {
  if (typeof fieldId !== "string" || !fieldId || fieldId.length > FIELD_ID_MAX_LENGTH) return null;
  const parts = fieldId.split(":");
  if (parts[0] === "run" && parts.length === 2 && ["status", "first_tag"].includes(parts[1])) {
    return { source: "run", field: parts[1] };
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
  return null;
}

export function categoricalFieldLabel(fieldId) {
  const parsed = parseCategoricalFieldId(fieldId);
  if (!parsed) return fieldId || "Field";
  if (parsed.source === "run") return parsed.field === "first_tag" ? "First tag" : "Status";
  return `${parsed.source}.${parsed.path.join(".")}`.slice(0, FIELD_LABEL_MAX_LENGTH);
}

function fieldText(field) {
  return `${field?.label ?? ""} ${field?.id ?? ""}`.toLowerCase();
}

function isSeedLikeField(field) {
  return /(^|[\s_./:-])seed($|[\s_./:-])/i.test(fieldText(field));
}

function isLearningRateLikeField(field) {
  return /learning[\s_./:-]*rate|(^|[\s_./:-])lr($|[\s_./:-])/i.test(fieldText(field));
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

export function defaultDistributionFields(metricKey, numericFields = [], categoricalFields = []) {
  const metricBest = metricFieldId(metricKey, "best");
  const valueField = parseFieldId(metricBest)
    ? metricBest
    : numericFields.find((field) => field?.source === "metric")?.id ?? numericFields[0]?.id ?? runFieldId("duration_seconds");
  const groupField = preferredDistributionGroupField(categoricalFields);
  const replicateField = preferredReplicateField(categoricalFields);
  return {
    valueField,
    groupField,
    replicateField,
  };
}

export function defaultParallelFields(metricKey, fields = []) {
  const metricBest = metricFieldId(metricKey, "best");
  const axes = [];
  const addAxis = (fieldId) => {
    if (!parseFieldId(fieldId) || axes.includes(fieldId) || axes.length >= PARALLEL_AXIS_LIMIT) return;
    axes.push(fieldId);
  };
  const configFields = (Array.isArray(fields) ? fields : []).filter((field) => field?.source === "config" && !isSeedLikeField(field));
  for (const field of [
    configFields.find(isLearningRateLikeField),
    configFields.find((field) => /batch([\s_./:-]*size)?/i.test(fieldText(field))),
    ...configFields,
  ]) {
    if (field?.id) addAxis(field.id);
  }
  addAxis(runFieldId("duration_seconds"));
  addAxis(metricBest);
  for (const field of Array.isArray(fields) ? fields : []) {
    if (field?.id && !isSeedLikeField(field)) addAxis(field.id);
  }
  return axes.length >= 2 ? axes : [runFieldId("duration_seconds"), parseFieldId(metricBest) ? metricBest : runFieldId("created_at_unix")];
}

export function defaultAxisScales(axisFields, fields = []) {
  const fieldLookup = new Map((Array.isArray(fields) ? fields : []).map((field) => [field.id, field]));
  const scales = {};
  for (const fieldId of axisFields ?? []) {
    const field = fieldLookup.get(fieldId) ?? { id: fieldId, label: fieldLabel(fieldId) };
    if (isLearningRateLikeField(field)) scales[fieldId] = "log";
  }
  return scales;
}

function preferredDistributionGroupField(fields = []) {
  const options = (Array.isArray(fields) ? fields : []).filter((field) => field?.id && field.groupCount >= 2 && field.groupCount <= 12 && !isSeedLikeField(field));
  return options.find((field) => /(^|[\s_./:-])(variant|group|dataset|model|policy|algo|method)($|[\s_./:-])/i.test(fieldText(field)))?.id
    ?? options.find((field) => field.id === runCategoricalFieldId("first_tag"))?.id
    ?? "";
}

function preferredReplicateField(fields = []) {
  return (Array.isArray(fields) ? fields : []).find((field) => field?.id && isSeedLikeField(field))?.id ?? "";
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

function categoricalOrNull(value) {
  if (value === null || value === undefined || typeof value === "object" || typeof value === "function" || typeof value === "symbol") return null;
  const text = String(value).trim();
  if (!text || text.length > CATEGORICAL_VALUE_MAX_LENGTH) return null;
  return text;
}

function walkCategoricalLeaves(value, visit, path = [], budget = { leaves: 0, nodes: 0, keys: 0 }) {
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
    if (categoricalOrNull(child) !== null) {
      budget.leaves += 1;
      visit(childPath);
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      walkCategoricalLeaves(child, visit, childPath, budget);
    }
  }
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

export function categoricalValueForRun(run, fieldId) {
  const parsed = parseCategoricalFieldId(fieldId);
  if (!parsed) return null;
  if (parsed.source === "run") {
    if (parsed.field === "status") return categoricalOrNull(run?.status);
    if (parsed.field === "first_tag") return categoricalOrNull(Array.isArray(run?.tags) ? run.tags[0] : null);
  }
  if (parsed.source === "config") return categoricalOrNull(valueAtPath(run?.config, parsed.path));
  if (parsed.source === "metadata") return categoricalOrNull(valueAtPath(run?.metadata, parsed.path));
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

export function buildRunCategoricalFieldCatalog(runs) {
  const safeRuns = (Array.isArray(runs) ? runs : []).slice(0, FIELD_CATALOG_MAX_RUNS);
  const availableCounts = new Map();
  const groupsById = new Map();
  const markAvailable = (id, value) => {
    if (typeof id !== "string" || id.length > FIELD_ID_MAX_LENGTH || !parseCategoricalFieldId(id)) return;
    availableCounts.set(id, (availableCounts.get(id) ?? 0) + 1);
    if (!groupsById.has(id)) groupsById.set(id, new Set());
    groupsById.get(id).add(value);
  };
  const maybeMark = (run, id) => {
    const value = categoricalValueForRun(run, id);
    if (value !== null) markAvailable(id, value);
  };
  for (const run of safeRuns) {
    maybeMark(run, runCategoricalFieldId("status"));
    maybeMark(run, runCategoricalFieldId("first_tag"));
    walkCategoricalLeaves(run?.config, (path) => maybeMark(run, objectFieldId("config", path)));
    walkCategoricalLeaves(run?.metadata, (path) => maybeMark(run, objectFieldId("metadata", path)));
  }
  return [...availableCounts.entries()]
    .map(([id, availableCount]) => {
      const parsed = parseCategoricalFieldId(id);
      if (!parsed) return null;
      return {
        id,
        label: categoricalFieldLabel(id),
        source: parsed?.source ?? "unknown",
        valueType: "category",
        availableCount,
        missingCount: Math.max(0, safeRuns.length - availableCount),
        groupCount: groupsById.get(id)?.size ?? 0,
      };
    })
    .filter((field) => field?.availableCount > 0)
    .sort((left, right) => (
      categoricalSourceRank(left.source) - categoricalSourceRank(right.source) ||
      Math.abs(left.groupCount - 4) - Math.abs(right.groupCount - 4) ||
      right.availableCount - left.availableCount ||
      left.label.localeCompare(right.label)
    ))
    .slice(0, CATEGORICAL_CATALOG_MAX_FIELDS);
}

function categoricalSourceRank(source) {
  if (source === "config") return 0;
  if (source === "metadata") return 1;
  if (source === "run") return 2;
  return 3;
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

export function distributionSummaryForRuns(runs, valueField, groupField = "", replicateField = "") {
  const groups = new Map();
  let missing = 0;
  let plotted = 0;
  const safeRuns = Array.isArray(runs) ? runs : [];
  for (const [index, run] of safeRuns.entries()) {
    const value = fieldValueForRun(run, valueField);
    const groupValue = groupField ? categoricalValueForRun(run, groupField) : "Ungrouped visible runs";
    if (value === null || groupValue === null) {
      missing += 1;
      continue;
    }
    const groupKey = String(groupValue).slice(0, CATEGORICAL_LABEL_MAX_LENGTH);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({
      id: run?.id ?? `run-${index}`,
      name: run?.name ?? `Run ${index + 1}`,
      value,
      replicate: replicateField ? categoricalValueForRun(run, replicateField) : null,
    });
    plotted += 1;
  }
  const groupSummaries = [...groups.entries()]
    .map(([label, points]) => distributionGroupSummary(label, points))
    .sort((left, right) => right.n - left.n || left.label.localeCompare(right.label))
    .slice(0, CATEGORICAL_MAX_GROUPS);
  return {
    groups: groupSummaries,
    missing,
    plotted,
    total: safeRuns.length,
    truncatedGroups: Math.max(0, groups.size - groupSummaries.length),
  };
}

function distributionGroupSummary(label, points) {
  const sortedValues = points.map((point) => point.value).sort((left, right) => left - right);
  const n = sortedValues.length;
  const mean = n ? sortedValues.reduce((sum, value) => sum + value, 0) / n : null;
  const variance = n > 1 && mean !== null
    ? sortedValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : null;
  const sem = n >= 5 && variance !== null ? Math.sqrt(variance) / Math.sqrt(n) : null;
  const replicates = new Set(points.map((point) => point.replicate).filter((value) => value !== null));
  return {
    label,
    n,
    min: n ? sortedValues[0] : null,
    q1: n >= 5 ? quantile(sortedValues, 0.25) : null,
    median: n ? quantile(sortedValues, 0.5) : null,
    q3: n >= 5 ? quantile(sortedValues, 0.75) : null,
    max: n ? sortedValues[n - 1] : null,
    mean,
    sem,
    replicateCount: replicates.size,
    stripPoints: deterministicSample(points, DISTRIBUTION_STRIP_POINT_LIMIT),
    stripPointTotal: points.length,
  };
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function deterministicSample(points, limit) {
  const ordered = [...points].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (ordered.length <= limit) return ordered;
  const sampled = [];
  const maxIndex = ordered.length - 1;
  for (let index = 0; index < limit; index += 1) {
    sampled.push(ordered[Math.round((maxIndex * index) / (limit - 1))]);
  }
  return sampled;
}

export function parallelCoordinatesForRuns(runs, axisFields, axisScales = {}) {
  const safeRuns = Array.isArray(runs) ? runs : [];
  const safeAxes = (Array.isArray(axisFields) ? axisFields : [])
    .filter((fieldId, index, array) => parseFieldId(fieldId) && array.indexOf(fieldId) === index)
    .slice(0, PARALLEL_AXIS_LIMIT);
  const axes = safeAxes.map((fieldId) => buildParallelAxis(safeRuns, fieldId, axisScales[fieldId])).filter(Boolean);
  const traces = safeRuns.map((run, runIndex) => {
    const points = [];
    for (const [axisIndex, axis] of axes.entries()) {
      const axisValue = axis.valuesByRunId.get(run?.id);
      if (!axisValue) continue;
      points.push({ axisIndex, fieldId: axis.fieldId, raw: axisValue.raw, scaled: axisValue.scaled, normalized: axisValue.normalized });
    }
    return {
      id: run?.id ?? `run-${runIndex}`,
      name: run?.name ?? `Run ${runIndex + 1}`,
      points,
    };
  }).filter((trace) => trace.points.length >= 2);
  return {
    axes,
    traces,
    missingRuns: Math.max(0, safeRuns.length - traces.length),
  };
}

function buildParallelAxis(runs, fieldId, requestedScale) {
  const values = [];
  for (const run of runs) {
    const raw = fieldValueForRun(run, fieldId);
    if (raw === null) continue;
    values.push({ runId: run?.id, raw });
  }
  if (!values.length) return null;
  const positive = values.every((item) => item.raw > 0);
  const scale = requestedScale === "log" && positive ? "log" : "linear";
  const scaledValues = values.map((item) => ({
    ...item,
    scaled: scale === "log" ? Math.log10(item.raw) : item.raw,
  }));
  const min = Math.min(...scaledValues.map((item) => item.scaled));
  const max = Math.max(...scaledValues.map((item) => item.scaled));
  const span = max - min;
  const valuesByRunId = new Map();
  for (const item of scaledValues) {
    if (!item.runId) continue;
    valuesByRunId.set(item.runId, {
      raw: item.raw,
      scaled: item.scaled,
      normalized: span === 0 ? 0.5 : (item.scaled - min) / span,
    });
  }
  return {
    fieldId,
    label: fieldLabel(fieldId),
    scale,
    min,
    max,
    rawMin: Math.min(...values.map((item) => item.raw)),
    rawMax: Math.max(...values.map((item) => item.raw)),
    missingCount: Math.max(0, runs.length - values.length),
    valuesByRunId,
  };
}

export function histogramFramesFromObjects(objects) {
  const frames = [];
  let invalid = 0;
  for (const object of Array.isArray(objects) ? objects : []) {
    const frame = histogramFrameFromObject(object);
    if (frame) frames.push(frame);
    else invalid += 1;
  }
  frames.sort((left, right) => left.step - right.step || left.id - right.id);
  const limited = frames.slice(-HISTOGRAM_FRAME_LIMIT);
  return {
    frames: limited,
    invalid,
    truncated: frames.length > limited.length || frames.length >= HISTOGRAM_FRAME_LIMIT,
    compatibleBins: histogramBinsCompatible(limited),
  };
}

function histogramFrameFromObject(object) {
  const value = object?.value && typeof object.value === "object" ? object.value : {};
  const bins = Array.isArray(value.bins) ? value.bins.map(Number) : [];
  const counts = Array.isArray(value.counts) ? value.counts.map(Number) : [];
  if (!bins.length || !counts.length || bins.length > HISTOGRAM_MAX_BINS + 1 || counts.length > HISTOGRAM_MAX_BINS) return null;
  if (bins.some((value) => !Number.isFinite(value)) || counts.some((value) => !Number.isFinite(value) || value < 0)) return null;
  if (!(bins.length === counts.length || bins.length === counts.length + 1)) return null;
  return {
    id: Number(object?.id ?? 0),
    key: String(object?.key ?? ""),
    step: Number.isFinite(Number(object?.step)) ? Number(object.step) : 0,
    bins,
    counts,
    total: counts.reduce((sum, value) => sum + value, 0),
  };
}

function histogramBinsCompatible(frames) {
  if (frames.length <= 1) return true;
  const reference = frames[0].bins;
  return frames.every((frame) => frame.bins.length === reference.length && frame.bins.every((value, index) => Math.abs(value - reference[index]) <= HISTOGRAM_BIN_COMPAT_EPSILON));
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
