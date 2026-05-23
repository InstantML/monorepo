import { metricAggregate, metricGoalValue } from "./state.js";

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
    scope: selectedRuns.length ? "selected loaded runs" : "current loaded page",
    excluded: selected.size > selectedRuns.length ? selected.size - selectedRuns.length : 0,
  };
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

export function numericFieldRows(runs, metricKey) {
  const fields = new Map();
  for (const run of runs) {
    const flattened = flattenNumericObject(run.config ?? {}, "config");
    for (const [key, value] of Object.entries(run.latest_metrics ?? {})) {
      if (isFiniteNumber(value)) flattened[`metric.latest.${key}`] = Number(value);
    }
    const best = metricGoalValue(run, metricKey);
    if (isFiniteNumber(best)) flattened[`metric.best.${metricKey}`] = Number(best);
    for (const [field, value] of Object.entries(flattened)) {
      const bucket = fields.get(field) ?? [];
      bucket.push({ run, value });
      fields.set(field, bucket);
    }
  }
  const usable = [...fields.entries()]
    .filter(([, values]) => values.length >= Math.min(2, runs.length))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return {
    fields: usable.map(([field]) => field),
    rows: runs.map((run) => ({ run, values: rowValues(run, usable.map(([field]) => field), metricKey) })),
  };
}

export function kMeansClusters(runs, metricKey, k = 3, iterations = 12) {
  const { fields, rows } = numericFieldRows(runs, metricKey);
  const selectedFields = fields.slice(0, 6);
  const vectors = rows
    .map((row) => ({ run: row.run, vector: selectedFields.map((field) => row.values[field]) }))
    .filter((row) => row.vector.every(isFiniteNumber));
  if (vectors.length < 3 || selectedFields.length < 2) {
    return { clusters: [], fields: selectedFields, points: [] };
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
    centroids = centroids.map((centroid, cluster) => {
      const members = normalized.filter((_, index) => assignments[index] === cluster);
      if (!members.length) return centroid;
      return centroid.map((_, dimension) => members.reduce((sum, item) => sum + item[dimension], 0) / members.length);
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
  const points = vectors.map((item, index) => ({
    id: item.run.id,
    name: item.run.name,
    cluster: assignments[index],
    x: normalized[index][0],
    y: normalized[index][1],
  }));
  return { clusters, fields: selectedFields, points };
}

export function evaluationCards(runs) {
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run.latest_metrics ?? {})))];
  return EVAL_KEY_PATTERNS.map((definition) => {
    const key = keys.find((candidate) => definition.patterns.some((pattern) => pattern.test(candidate)));
    if (!key) return { ...definition, key: null, count: 0, latest: null, best: null, missing: runs.length };
    const values = runs.map((run) => metricAggregate(run, key, "latest")).filter(isFiniteNumber);
    const bestValues = runs.map((run) => metricGoalValue(run, key)).filter(isFiniteNumber);
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
  const numeric = numericFieldRows(runs, "").fields.find((field) => field.startsWith("config."));
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

function rowValues(run, fields, metricKey) {
  const flattened = flattenNumericObject(run.config ?? {}, "config");
  for (const [key, value] of Object.entries(run.latest_metrics ?? {})) {
    if (isFiniteNumber(value)) flattened[`metric.latest.${key}`] = Number(value);
  }
  const best = metricGoalValue(run, metricKey);
  if (isFiniteNumber(best)) flattened[`metric.best.${metricKey}`] = Number(best);
  return Object.fromEntries(fields.map((field) => [field, flattened[field]]));
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
