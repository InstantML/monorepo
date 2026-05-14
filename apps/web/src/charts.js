/**
 * @param {{ min: number, max: number } | null} [xRange]
 */
export function normalizeSeries(series, width, height, padding = 28, xKey = "step", metricKey = "", xRange = null) {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return [];
  const xValues = points.map((point) => xValue(point, xKey));
  const fullMinX = Math.min(...xValues);
  const fullMaxX = Math.max(...xValues);
  const range = boundedXRange(xRange, fullMinX, fullMaxX);
  const visiblePoints = range ? points.filter((point) => pointInRange(point, xKey, range)) : points;
  const domainPoints = visiblePoints.length ? visiblePoints : points;
  const visibleXValues = range && visiblePoints.length > 1 ? visiblePoints.map((point) => xValue(point, xKey)) : [];
  const minStep = visibleXValues.length ? Math.min(...visibleXValues) : range?.min ?? fullMinX;
  const maxStep = visibleXValues.length ? Math.max(...visibleXValues) : range?.max ?? fullMaxX;
  const yDomain = valueDomain(domainPoints, metricKey);
  const minValue = yDomain.minY;
  const maxValue = yDomain.maxY;
  const stepSpan = Math.max(1, maxStep - minStep);
  const valueSpan = Math.max(1, maxValue - minValue);
  return series.map((item) => ({
    ...item,
    points: range ? item.points.filter((point) => pointInRange(point, xKey, range)) : item.points,
    path: (range ? item.points.filter((point) => pointInRange(point, xKey, range)) : item.points)
      .map((point) => {
        const x = padding + ((xValue(point, xKey) - minStep) / stepSpan) * (width - padding * 2);
        const y = height - padding - ((point.value - minValue) / valueSpan) * (height - padding * 2);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" "),
    normalizedPoints: (range ? item.points.filter((point) => pointInRange(point, xKey, range)) : item.points).map((point) => {
      const x = padding + ((xValue(point, xKey) - minStep) / stepSpan) * (width - padding * 2);
      const y = height - padding - ((point.value - minValue) / valueSpan) * (height - padding * 2);
      return { ...point, x, y, xValue: xValue(point, xKey) };
    }),
    domain: { minX: minStep, maxX: maxStep, minY: minValue, maxY: maxValue },
  }));
}

/**
 * @param {{ min: number, max: number } | null} [xRange]
 */
export function chartDomain(series, xKey = "step", metricKey = "", xRange = null) {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return null;
  const xValues = points.map((point) => xValue(point, xKey));
  const fullMinX = Math.min(...xValues);
  const fullMaxX = Math.max(...xValues);
  const range = boundedXRange(xRange, fullMinX, fullMaxX);
  const visiblePoints = range ? points.filter((point) => pointInRange(point, xKey, range)) : points;
  const visibleXValues = range && visiblePoints.length > 1 ? visiblePoints.map((point) => xValue(point, xKey)) : [];
  const yDomain = valueDomain(visiblePoints.length ? visiblePoints : points, metricKey);
  return {
    minX: visibleXValues.length ? Math.min(...visibleXValues) : range?.min ?? fullMinX,
    maxX: visibleXValues.length ? Math.max(...visibleXValues) : range?.max ?? fullMaxX,
    minY: yDomain.minY,
    maxY: yDomain.maxY,
  };
}

export function axisTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const ticks = [];
  const step = (max - min) / Math.max(1, count - 1);
  for (let index = 0; index < count; index += 1) ticks.push(min + step * index);
  return ticks;
}

export function nearestPoint(normalizedSeries, x, y, maxDistance = 18) {
  let nearest = null;
  for (const item of normalizedSeries) {
    for (const point of item.normalizedPoints ?? []) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= maxDistance && (!nearest || distance < nearest.distance)) {
        nearest = { runId: item.id, runName: item.name, group: item.group, point, distance };
      }
    }
  }
  return nearest;
}

export function svgPointFromClient(rect, clientX, clientY, width, height) {
  const rectWidth = Math.max(1, Number(rect?.width ?? 0));
  const rectHeight = Math.max(1, Number(rect?.height ?? 0));
  const scale = Math.min(rectWidth / width, rectHeight / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const offsetX = (rectWidth - renderedWidth) / 2;
  const offsetY = (rectHeight - renderedHeight) / 2;
  return {
    x: (clientX - Number(rect?.left ?? 0) - offsetX) / scale,
    y: (clientY - Number(rect?.top ?? 0) - offsetY) / scale,
  };
}

export function formatAxisValue(value, mode = "step") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  if (mode === "time") return new Date(Number(value)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function chartSummary(series) {
  return series.map((item) => {
    const last = item.points[item.points.length - 1];
    return { id: item.id, name: item.name, last: last ? last.value : null };
  });
}

export function smoothSeries(series, factor = 0) {
  if (factor <= 0) return series;
  const alpha = Math.max(0.01, Math.min(1, 1 - factor / 100));
  return series.map((item) => {
    let previous = null;
    return {
      ...item,
      points: item.points.map((point) => {
        previous = previous === null ? point.value : alpha * point.value + (1 - alpha) * previous;
        return { ...point, value: previous };
      }),
    };
  });
}

export function averageGroupedSeries(series) {
  const groups = new Map();
  for (const item of series) {
    const key = item.group ?? item.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([group, items]) => {
    const byStep = new Map();
    for (const item of items) {
      for (const point of item.points) {
        const key = point.step;
        if (!byStep.has(key)) byStep.set(key, { values: [], timestamps: [] });
        const bucket = byStep.get(key);
        bucket.values.push(point.value);
        const timestamp = point.created_at ? new Date(point.created_at).getTime() : Number.NaN;
        if (Number.isFinite(timestamp)) bucket.timestamps.push(timestamp);
      }
    }
    const points = [...byStep.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, bucket]) => {
        const point = {
          key: group,
          step,
          value: bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length,
        };
        if (bucket.timestamps.length) {
          point.created_at = new Date(bucket.timestamps.reduce((sum, value) => sum + value, 0) / bucket.timestamps.length).toISOString();
        }
        return point;
      });
    return { id: group, name: `${group} avg`, group, points };
  });
}

function xValue(point, xKey) {
  if (xKey === "time" && point.created_at) {
    const value = new Date(point.created_at).getTime();
    if (Number.isFinite(value)) return value;
  }
  return point.step;
}

function boundedXRange(range, minX, maxX) {
  if (!range || !Number.isFinite(minX) || !Number.isFinite(maxX) || minX === maxX) return null;
  const rawMin = Number(range.min);
  const rawMax = Number(range.max);
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return null;
  const min = Math.max(minX, Math.min(rawMin, rawMax));
  const max = Math.min(maxX, Math.max(rawMin, rawMax));
  if (max <= min) return null;
  return { min, max };
}

function pointInRange(point, xKey, range) {
  const value = xValue(point, xKey);
  return value >= range.min && value <= range.max;
}

function valueDomain(points, metricKey = "") {
  const values = points.map((point) => point.value);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  if (usesUnitDomain(metricKey, minY, maxY)) return { minY: 0, maxY: 1 };
  return { minY, maxY };
}

function usesUnitDomain(metricKey, minY, maxY) {
  if (minY < 0 || maxY > 1) return false;
  const tokens = String(metricKey ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return false;
  const boundedTokens = new Set(["acc", "accuracy", "auc", "auroc", "auprc", "f1", "precision", "recall", "sensitivity", "specificity"]);
  if (tokens.some((token) => boundedTokens.has(token))) return true;
  if (tokens.includes("rate") && !tokens.includes("learning") && !tokens.includes("lr")) return true;
  return false;
}
