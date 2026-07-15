import { formatNumber, metricAggregate, metricGoalValue } from "./state.js";

const EVAL_KEY_PATTERNS = [
  { id: "accuracy", label: "Accuracy", patterns: [/accuracy$/i, /eval\/accuracy/i, /val\/accuracy/i] },
  { id: "f1", label: "F1", patterns: [/(^|\/)f1$/i, /macro_f1/i] },
  { id: "precision", label: "Precision", patterns: [/precision$/i] },
  { id: "recall", label: "Recall", patterns: [/recall$/i] },
  { id: "auc", label: "AUC", patterns: [/(^|\/)auc$/i, /roc_auc/i] },
  { id: "loss", label: "Loss", patterns: [/loss$/i] },
  { id: "return", label: "Return", patterns: [/return/i, /reward/i] },
];

export function insightsRunUniverse(selectedRunIds, sortedRuns) {
  const runs = Array.isArray(sortedRuns) ? sortedRuns : [];
  const selected = new Set(Array.isArray(selectedRunIds) ? selectedRunIds : []);
  const selectedRuns = runs.filter((run) => selected.has(run.id));
  return {
    runs: selectedRuns.length ? selectedRuns : runs,
    scopeKind: selectedRuns.length ? "selected" : "page",
    excluded: selected.size > selectedRuns.length ? selected.size - selectedRuns.length : 0,
  };
}

export function insightsScopeLabel(universe) {
  const count = universe?.runs?.length ?? 0;
  const noun = universe?.scopeKind === "selected" ? "selected" : "loaded";
  const base = `Analyzing the ${formatNumber(count, 0)} ${noun} ${count === 1 ? "run" : "runs"}`;
  const excluded = universe?.excluded ?? 0;
  return excluded ? `${base} · ${formatNumber(excluded, 0)} selected without loaded summaries` : base;
}

// Human label for the field groupedRunReducers buckets by ("seed", "tag", a
// config field), or null when runs collapse into a single "all" bucket and
// naming the key would be noise.
export function runGroupingKeyLabel(runs) {
  const field = chooseGroupField(runs);
  if (field === "tag") return "tag";
  if (field === "all") return null;
  if (field.startsWith("config.")) return field.slice("config.".length);
  return null;
}

export function partitionEvaluationCards(cards) {
  const list = Array.isArray(cards) ? cards : [];
  return {
    logged: list.filter((card) => Boolean(card.key)),
    unlogged: list.filter((card) => !card.key),
  };
}

// Per-axis min/max for parallel coordinates, flagging degenerate axes so the
// chart can annotate "constant · value" instead of printing the same number
// twice, and axes with no finite values at all.
export function parallelAxisDomains(rows, fields) {
  const list = Array.isArray(rows) ? rows : [];
  return (Array.isArray(fields) ? fields : []).map((field) => {
    const values = list.map((row) => row?.values?.[field]).filter(isFiniteNumber);
    if (!values.length) return { field, min: null, max: null, constant: false, empty: true };
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { field, min, max, constant: min === max, empty: false };
  });
}

// Heuristic for auto-defaulting an axis to a log scale. Learning rate is the
// canonical case: a 1e-5..1e-2 sweep is unreadable on a linear axis. Kept
// conservative (learning-rate / lr only) so metrics that legitimately cross
// zero (e.g. rewards, deltas) are never silently log-scaled.
export function looksLogarithmicField(field) {
  return /learning[\s_./:-]*rate|(^|[\s_./:-])lr($|[\s_./:-])/i.test(String(field ?? ""));
}

// Scatter geometry generalized over per-axis linear/log scales. Preserves the
// vertical layout the scatter card has always used (y 200..24, degenerate axis
// centered) but maps values through log10 when an axis is logarithmic. A log
// axis cannot place values <= 0, so those points drop from the plotted set
// (counted in `dropped`) while the axis still scales against the positive
// extremes. `options.width` is the rendered frame width in CSS pixels: the SVG
// draws its viewBox at that exact size so axis text keeps a constant pixel
// size instead of scaling with the card. Defaults reproduce the historical
// 520-wide layout (x 48..488).
const SCATTER_X_LEFT = 48;
const SCATTER_X_RIGHT_MARGIN = 32;
const SCATTER_DEFAULT_WIDTH = 520;
const SCATTER_Y_BOTTOM = 200;
const SCATTER_Y_TOP = 24;
const SCATTER_Y_MID = 108;

export function scatterGeometry(points, options = {}) {
  const xScale = options.xScale === "log" ? "log" : "linear";
  const yScale = options.yScale === "log" ? "log" : "linear";
  const width = Number.isFinite(options.width) && options.width > 0 ? options.width : SCATTER_DEFAULT_WIDTH;
  const left = SCATTER_X_LEFT;
  const right = Math.max(left + 40, width - SCATTER_X_RIGHT_MARGIN);
  const midX = (left + right) / 2;
  const finite = (Array.isArray(points) ? points : []).filter(
    (point) => isFiniteNumber(point?.x) && isFiniteNumber(point?.y),
  );
  const plottable = finite.filter(
    (point) => (xScale !== "log" || point.x > 0) && (yScale !== "log" || point.y > 0),
  );
  if (!plottable.length) {
    // Keep a uniform shape (x/y present) so consumers see one object type, not a
    // union; nothing is drawn when empty so these mappers are never called.
    return {
      xScale, yScale, minX: 0, maxX: 0, minY: 0, maxY: 0,
      xDegenerate: true, yDegenerate: true,
      points: [], dropped: finite.length, empty: true,
      left, right, midX,
      x: () => midX,
      y: () => SCATTER_Y_MID,
    };
  }
  const sx = (value) => (xScale === "log" ? Math.log10(value) : value);
  const sy = (value) => (yScale === "log" ? Math.log10(value) : value);
  const xs = plottable.map((point) => point.x);
  const ys = plottable.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xDegenerate = maxX - minX < 1e-12;
  const yDegenerate = maxY - minY < 1e-12;
  const sMinX = sx(minX);
  const sSpanX = Math.max(1e-12, sx(maxX) - sMinX);
  const sMinY = sy(minY);
  const sSpanY = Math.max(1e-12, sy(maxY) - sMinY);
  return {
    xScale,
    yScale,
    minX,
    maxX,
    minY,
    maxY,
    xDegenerate,
    yDegenerate,
    points: plottable,
    dropped: finite.length - plottable.length,
    empty: false,
    left, right, midX,
    x: (value) => (xDegenerate ? midX : left + ((sx(value) - sMinX) / sSpanX) * (right - left)),
    y: (value) => (yDegenerate ? SCATTER_Y_MID : SCATTER_Y_BOTTOM - ((sy(value) - sMinY) / sSpanY) * (SCATTER_Y_BOTTOM - SCATTER_Y_TOP)),
  };
}

// Accessible summary rows for the scatter explorer: one row per plotted run,
// ranked by the Y field (descending) so the table mirrors "best at top". The
// component formats values; this stays pure for unit coverage.
export function scatterSummaryRows(points) {
  return (Array.isArray(points) ? points : [])
    .filter((point) => isFiniteNumber(point?.x) && isFiniteNumber(point?.y))
    .map((point) => ({ id: point.run?.id ?? "", name: point.run?.name ?? "", x: point.x, y: point.y }))
    .sort((left, right) => right.y - left.y || String(left.name).localeCompare(String(right.name)));
}

// Accessible summary rows for the parallel-coordinates explorer: one row per
// drawn run with its raw value on each axis, plus a flag for the best run on the
// active metric. `fields` is the axis order; missing values surface as null so
// the table can render "—".
/** @param {string | null | undefined} [bestRunId] */
export function parallelSummaryRows(rows, fields, bestRunId = null) {
  const safeFields = Array.isArray(fields) ? fields : [];
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row?.run?.id ?? "",
    name: row?.run?.name ?? "",
    best: bestRunId != null && row?.run?.id === bestRunId,
    values: Object.fromEntries(
      safeFields.map((field) => {
        const value = row?.values?.[field];
        return [field, isFiniteNumber(value) ? value : null];
      }),
    ),
  }));
}

export function groupedRunReducers(runs, metricKey) {
  const groupField = chooseGroupField(runs);
  const groups = new Map();
  for (const run of runs) {
    const value = metricGoalValue(run, metricKey);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const group = groupValue(run, groupField);
    const bucket = groups.get(group) ?? [];
    bucket.push({ run, value });
    groups.set(group, bucket);
  }
  return [...groups.entries()].map(([group, items]) => {
    const values = items.map((item) => item.value).sort((a, b) => a - b);
    return {
      group,
      count: values.length,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      min: values[0],
      max: values[values.length - 1],
      median: values[Math.floor(values.length / 2)],
      bestRun: items.slice().sort((a, b) => a.value - b.value)[0]?.run?.name ?? "",
    };
  }).sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

// Shared flatten/bucket pass for numericFieldRows and chooseGroupField: each
// run's config is flattened exactly once, and the per-run flattened maps are
// kept so row construction doesn't repeat the recursive walk.
function collectNumericFields(runs, metricKey) {
  const fields = new Map();
  const flattenedRuns = runs.map((run) => {
    const flattened = flattenNumericObject(run.config ?? {}, "config");
    for (const [key, value] of Object.entries(run.latest_metrics ?? {})) {
      // The focus metric is added once below as its goal-aware "best"; skip its
      // near-identical "latest" so it doesn't render as a duplicate axis/field
      // with the same shortened label.
      if (key === metricKey) continue;
      if (isFiniteNumber(value)) flattened[`metric.latest.${key}`] = Number(value);
    }
    const best = metricGoalValue(run, metricKey);
    if (isFiniteNumber(best)) flattened[`metric.best.${metricKey}`] = Number(best);
    for (const [field, value] of Object.entries(flattened)) {
      const bucket = fields.get(field) ?? [];
      bucket.push({ run, value });
      fields.set(field, bucket);
    }
    return { run, flattened };
  });
  const usable = [...fields.entries()]
    .filter(([, values]) => values.length >= Math.min(2, runs.length))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return { fieldNames: usable.map(([field]) => field), flattenedRuns };
}

export function numericFieldRows(runs, metricKey) {
  const { fieldNames, flattenedRuns } = collectNumericFields(runs, metricKey);
  return {
    fields: fieldNames,
    rows: flattenedRuns.map(({ run, flattened }) => ({
      run,
      values: Object.fromEntries(fieldNames.map((field) => [field, flattened[field]])),
    })),
  };
}

export function kMeansClusters(runs, metricKey, k = 3, iterations = 12, displayAxes = []) {
  const { fields, rows } = numericFieldRows(runs, metricKey);
  // Cluster on configuration features only. Seed-like fields are run identifiers
  // (index noise), and metric fields would leak the outcome into the feature
  // space — making clusters partly "accuracy bins" and any later
  // "this cluster scores higher" reading circular. Fall back to all non-seed
  // numeric fields if a run logged no usable config fields.
  const configFields = fields.filter((field) => field.startsWith("config.") && !/(^|[._])seed$/i.test(field));
  const nonSeedFields = fields.filter((field) => !/(^|[._])seed$/i.test(field));
  const selectedFields = (configFields.length >= 2 ? configFields : nonSeedFields).slice(0, 6);
  const vectors = rows
    .map((row) => ({ run: row.run, vector: selectedFields.map((field) => row.values[field]) }))
    .filter((row) => row.vector.every(isFiniteNumber));
  if (vectors.length < 3 || selectedFields.length < 2) {
    return { clusters: [], fields: selectedFields, axes: selectedFields.slice(0, 2), points: [], plotted: 0, clustered: 0 };
  }
  const normalized = normalizeVectors(vectors.map((row) => row.vector));
  const clusterCount = Math.min(k, vectors.length);
  let centroids = Array.from({ length: clusterCount }, (_, index) => {
    const position = Math.round((index / Math.max(1, clusterCount - 1)) * (normalized.length - 1));
    return normalized[position].slice();
  });
  let assignments = new Array(normalized.length).fill(0);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    assignments = normalized.map((vector) => nearestCentroid(vector, centroids));
    // Single accumulation pass per iteration. The filter-per-cluster form
    // allocated k member arrays and rescanned every vector k times per
    // iteration (k × iterations full scans). Sums accumulate in index order,
    // so the means match the previous reduce bit-for-bit.
    const sums = centroids.map((centroid) => new Array(centroid.length).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let index = 0; index < normalized.length; index += 1) {
      const vector = normalized[index];
      const sum = sums[assignments[index]];
      counts[assignments[index]] += 1;
      for (let dimension = 0; dimension < vector.length; dimension += 1) sum[dimension] += vector[dimension];
    }
    centroids = centroids.map((centroid, cluster) => {
      if (!counts[cluster]) return centroid;
      return sums[cluster].map((total) => total / counts[cluster]);
    });
  }
  const clusters = centroids.map((centroid, cluster) => {
    const members = vectors.filter((_, index) => assignments[index] === cluster);
    return {
      id: cluster,
      count: members.length,
      centroid,
      label: `Cluster ${cluster + 1}`,
      topRuns: members.slice(0, 3).map((item) => item.run.name),
    };
  }).filter((cluster) => cluster.count > 0);
  // Project onto the two highest-resolution dimensions so the scatter spreads
  // points instead of collapsing low-cardinality fields onto a coarse grid.
  const distinctCount = (field) => new Set(vectors.map((item) => item.vector[selectedFields.indexOf(field)])).size;
  const axisOrder = selectedFields
    .map((field, index) => ({ index, distinct: distinctCount(field) }))
    .sort((a, b) => b.distinct - a.distinct);
  const requestedX = selectedFields.indexOf(displayAxes[0]);
  const requestedY = selectedFields.indexOf(displayAxes[1]);
  const xDim = requestedX >= 0 ? requestedX : axisOrder[0]?.index ?? 0;
  const yDim = requestedY >= 0 && requestedY !== xDim
    ? requestedY
    : (axisOrder.find((axis) => axis.index !== xDim)?.index ?? Math.min(1, selectedFields.length - 1));
  const points = vectors.map((item, index) => ({
    id: item.run.id,
    name: item.run.name,
    cluster: assignments[index],
    x: normalized[index][xDim],
    y: normalized[index][yDim],
  }));
  return { clusters, fields: selectedFields, axes: [selectedFields[xDim], selectedFields[yDim]], points, plotted: points.length, clustered: vectors.length };
}

export function evaluationCards(runs) {
  // Accumulate the key set directly — flatMap materialized a runs×keys
  // intermediate array (≈100k entries at 2,000 runs) just to feed a Set.
  const keySet = new Set();
  for (const run of runs) {
    for (const key of Object.keys(run.latest_metrics ?? {})) keySet.add(key);
  }
  const keys = [...keySet];
  return EVAL_KEY_PATTERNS.map((definition) => {
    const key = keys.find((candidate) => definition.patterns.some((pattern) => pattern.test(candidate)));
    if (!key) return { ...definition, key: null, count: 0, latest: null, best: null, missing: runs.length };
    // One pass per matched key instead of two full runs.map scans.
    const values = [];
    const bestValues = [];
    for (const run of runs) {
      const latest = metricAggregate(run, key, "latest");
      if (isFiniteNumber(latest)) values.push(latest);
      const best = metricGoalValue(run, key);
      if (isFiniteNumber(best)) bestValues.push(best);
    }
    return {
      ...definition,
      key,
      count: values.length,
      latest: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      best: bestValues.length ? bestValues.sort((a, b) => a - b)[Math.floor(bestValues.length / 2)] : null,
      missing: runs.length - values.length,
    };
  });
}

function chooseGroupField(runs) {
  if (runs.some((run) => run.config?.seed !== undefined)) return "config.seed";
  if (runs.some((run) => run.tags?.length)) return "tag";
  // Field names only — building the full row matrix here doubled the flatten
  // cost of every insights recompute for sweeps without seeds/tags.
  const numeric = collectNumericFields(runs, "").fieldNames.find((field) => field.startsWith("config."));
  return numeric ?? "all";
}

function groupValue(run, field) {
  if (field === "tag") return run.tags?.[0] ?? "untagged";
  if (field === "all") return "all";
  if (field.startsWith("config.")) {
    const path = field.slice("config.".length).split(".");
    let value = run.config;
    for (const part of path) value = value && typeof value === "object" ? value[part] : undefined;
    return String(value ?? "missing");
  }
  return "all";
}


function flattenNumericObject(value, prefix, out = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (isFiniteNumber(item)) out[path] = Number(item);
    else if (item && typeof item === "object" && !Array.isArray(item)) flattenNumericObject(item, path, out);
  }
  return out;
}

function normalizeVectors(vectors) {
  const dimensions = vectors[0]?.length ?? 0;
  const means = Array.from({ length: dimensions }, (_, dimension) => (
    vectors.reduce((sum, vector) => sum + vector[dimension], 0) / vectors.length
  ));
  const stddevs = means.map((mean, dimension) => {
    const variance = vectors.reduce((sum, vector) => sum + (vector[dimension] - mean) ** 2, 0) / vectors.length;
    return Math.sqrt(variance) || 1;
  });
  return vectors.map((vector) => vector.map((value, dimension) => (value - means[dimension]) / stddevs[dimension]));
}

function nearestCentroid(vector, centroids) {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  centroids.forEach((centroid, index) => {
    const distance = vector.reduce((sum, value, dimension) => sum + (value - centroid[dimension]) ** 2, 0);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
