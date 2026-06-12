/**
 * @param {{ min: number, max: number } | null} [xRange]
 * @param {{ scale?: "linear" | "log", range?: { min: number, max: number } | null } | null} [yAxis]
 */
export function normalizeSeries(series, width, height, padding = 28, xKey = "step", metricKey = "", xRange = null, yAxis = null) {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return [];
  const yScale = yAxis?.scale === "log" ? "log" : "linear";
  const yRange = sanitizeYAxisRange(yAxis?.range, yScale);
  // Iterative extent (no intermediate xValues array, no Math.min(...spread) —
  // the spread form is both slower and overflows the call stack past ~100k pts).
  const { min: fullMinX, max: fullMaxX } = xExtent(points, xKey);
  const range = boundedXRange(xRange, fullMinX, fullMaxX);
  const visiblePoints = range ? points.filter((point) => pointInRange(point, xKey, range)) : points;
  const domainPoints = visiblePoints.length ? visiblePoints : points;
  const visibleExtent = range && visiblePoints.length > 1 ? xExtent(visiblePoints, xKey) : null;
  const rawMinStep = visibleExtent ? visibleExtent.min : range?.min ?? fullMinX;
  const rawMaxStep = visibleExtent ? visibleExtent.max : range?.max ?? fullMaxX;
  const { min: minStep, max: maxStep } = stepDomain(rawMinStep, rawMaxStep);
  const yDomain = valueDomain(domainPoints, metricKey, yScale, yRange);
  const minValue = yDomain.minY;
  const maxValue = yDomain.maxY;
  // Spans are guaranteed positive by stepDomain/valueDomain, so we never clamp
  // to 1 here — clamping was what squished tiny-magnitude metrics to the floor.
  const stepSpan = maxStep - minStep;
  const innerW = width - padding * 2;
  const domain = { minX: minStep, maxX: maxStep, minY: minValue, maxY: maxValue, yScale, yRangeManual: Boolean(yRange) };
  const mapY = yMapper(domain, height, padding);
  return series.map((item) => {
    const filtered = range ? item.points.filter((point) => pointInRange(point, xKey, range)) : item.points;
    // Log scale can only place positive values; non-positive points drop from
    // the plot (counted so the UI can say so) while `points` keeps the raw set.
    const positive = yScale === "log" ? filtered.filter((point) => Number(point.value) > 0) : filtered;
    // Points arrive in step order; wall-clock timestamps from concurrent runs
    // interleave, so time mode must re-sort or the path sweeps back and forth.
    // Decorate-sort-undecorate keeps the comparator cheap (one Date parse per
    // point here; the render loop below re-derives xValue as it always has).
    const plottable = xKey === "time"
      ? positive
          .map((point) => [xValue(point, xKey), point])
          .sort((left, right) => left[0] - right[0])
          .map((pair) => pair[1])
      : positive;
    const smoothed = Boolean(item.smoothed);
    // Single pass builds normalizedPoints + both path strings, and computes
    // xValue once per point (it parses a Date in time mode — calling it twice
    // doubled that cost on every render).
    const normalizedPoints = new Array(plottable.length);
    let path = "";
    let smoothPath = "";
    for (let i = 0; i < plottable.length; i += 1) {
      const point = plottable[i];
      const xv = xValue(point, xKey);
      const x = padding + ((xv - minStep) / stepSpan) * innerW;
      const y = mapY(point.value);
      const smoothable = smoothed && Number.isFinite(point.smoothedValue) && (yScale !== "log" || point.smoothedValue > 0);
      const ySmoothed = smoothable ? mapY(point.smoothedValue) : undefined;
      normalizedPoints[i] = { ...point, x, y, ySmoothed, displayY: ySmoothed ?? y, xValue: xv };
      const xs = x.toFixed(2);
      path += `${i ? " " : ""}${xs},${y.toFixed(2)}`;
      if (smoothed) smoothPath += `${i ? " " : ""}${xs},${(ySmoothed ?? y).toFixed(2)}`;
    }
    return { ...item, points: filtered, path, smoothPath, normalizedPoints, domain, hiddenNonPositive: filtered.length - plottable.length };
  });
}

/**
 * @param {{ min: number, max: number } | null} [xRange]
 * @param {{ scale?: "linear" | "log", range?: { min: number, max: number } | null } | null} [yAxis]
 */
export function chartDomain(series, xKey = "step", metricKey = "", xRange = null, yAxis = null) {
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) return null;
  const yScale = yAxis?.scale === "log" ? "log" : "linear";
  const yRange = sanitizeYAxisRange(yAxis?.range, yScale);
  const { min: fullMinX, max: fullMaxX } = xExtent(points, xKey);
  const range = boundedXRange(xRange, fullMinX, fullMaxX);
  const visiblePoints = range ? points.filter((point) => pointInRange(point, xKey, range)) : points;
  const visibleExtent = range && visiblePoints.length > 1 ? xExtent(visiblePoints, xKey) : null;
  const yDomain = valueDomain(visiblePoints.length ? visiblePoints : points, metricKey, yScale, yRange);
  const rawMinX = visibleExtent ? visibleExtent.min : range?.min ?? fullMinX;
  const rawMaxX = visibleExtent ? visibleExtent.max : range?.max ?? fullMaxX;
  const xDomain = stepDomain(rawMinX, rawMaxX);
  return {
    minX: xDomain.min,
    maxX: xDomain.max,
    minY: yDomain.minY,
    maxY: yDomain.maxY,
    yScale,
  };
}

/**
 * Validate a manual y-range. Returns null (meaning "use the data domain") for
 * anything unusable: non-numeric bounds, an empty window, or a non-positive
 * floor on a log scale.
 * @param {{ min: number, max: number } | null | undefined} range
 * @param {"linear" | "log"} [yScale]
 */
export function sanitizeYAxisRange(range, yScale = "linear") {
  if (!range) return null;
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  if (yScale === "log" && min <= 0) return null;
  return { min, max };
}

/**
 * Value→pixel mapper for the y axis, shared by series normalization, axis
 * gridlines, the mini range overview, and SVG export so all four stay on the
 * exact same scale (linear or log10).
 * @param {{ minY: number, maxY: number, yScale?: string } | null} domain
 */
export function yMapper(domain, height, padding) {
  const innerH = height - padding * 2;
  if (domain?.yScale === "log") {
    const logMin = Math.log10(domain.minY);
    const logSpan = (Math.log10(domain.maxY) - logMin) || 1;
    return (value) => height - padding - ((Math.log10(value) - logMin) / logSpan) * innerH;
  }
  const minY = domain?.minY ?? 0;
  const span = ((domain?.maxY ?? 1) - minY) || 1;
  return (value) => height - padding - ((value - minY) / span) * innerH;
}

// Log-axis ticks: 1-2-5 mantissas across the covered decades, thinned to ~count
// so a 6-decade loss curve labels 1e-4 / 1e-2 / 1 rather than 30 cramped ticks.
// Sub-decade windows (e.g. 3..8) fall back to the linear nice-tick family,
// which is correct there — within one decade a log axis is locally linear-ish
// and 1-2-5 candidates may not exist inside the window at all.
export function logAxisTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return [];
  if (min === max) return [min];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const decades = Math.log10(hi / lo);
  const mantissas = decades > Math.max(2, count) ? [1] : [1, 2, 5];
  const candidates = [];
  for (let exp = Math.floor(Math.log10(lo)); exp <= Math.ceil(Math.log10(hi)); exp += 1) {
    for (const mantissa of mantissas) {
      const value = Number((mantissa * Math.pow(10, exp)).toPrecision(12));
      if (value >= lo * (1 - 1e-9) && value <= hi * (1 + 1e-9)) candidates.push(value);
    }
  }
  if (candidates.length < 2) {
    return axisTicks(lo, hi, count).filter((tick) => tick > 0);
  }
  const stride = Math.max(1, Math.ceil(candidates.length / Math.max(2, count)));
  const ticks = [];
  for (let index = 0; index < candidates.length; index += stride) ticks.push(candidates[index]);
  // End on the top candidate by replacing (not appending) the final stride
  // tick, so spacing stays even instead of cramming two ticks at the top.
  const last = candidates[candidates.length - 1];
  if (ticks[ticks.length - 1] !== last) {
    if (ticks.length > 1) ticks[ticks.length - 1] = last;
    else ticks.push(last);
  }
  return ticks;
}

// "Nice" axis ticks: round the tick step to the 1-2-5 family so labels land on
// human-friendly values (50/100/150 rather than 128.3/192.9/257.5) and integer
// domains like training step never show fractional ticks (20/40/60 not 20.8/40.5).
// Ticks are emitted on multiples of the nice step that fall within [min, max], so
// they position correctly under the chart's linear value→pixel scale.
export function axisTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const target = Math.max(2, count);
  const rawStep = (max - min) / (target - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceUnit = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  const step = niceUnit * magnitude;
  const ticks = [];
  const first = Math.ceil(min / step) * step;
  for (let value = first, index = 0; value <= max + step * 1e-9 && index < 1000; value += step, index += 1) {
    // Snap floating-point drift (e.g. 60.00000000001) back to the clean value.
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks.length ? ticks : [min, max];
}

export function nearestPoint(normalizedSeries, x, y, maxDistance = 18) {
  let nearest = null;
  const consider = (item, point, distance) => {
    if (distance <= maxDistance && (!nearest || distance < nearest.distance)) {
      nearest = { runId: item.id, runName: item.name, identifier: item.identifier ?? item.name, group: item.group, point, distance };
    }
  };
  for (const item of normalizedSeries) {
    let previous = null;
    for (const point of item.normalizedPoints ?? []) {
      // Hit-test against the displayed line: the smoothed curve when smoothing
      // is on, otherwise the raw line.
      const pointY = point.displayY ?? point.y;
      consider(item, point, Math.hypot(point.x - x, pointY - y));
      if (previous) {
        const previousY = previous.displayY ?? previous.y;
        const segmentHit = distanceToSegment(x, y, previous.x, previousY, point.x, pointY);
        consider(item, segmentHit.t <= 0.5 ? previous : point, segmentHit.distance);
      }
      previous = point;
    }
  }
  return nearest;
}

export function svgPointFromClient(rect, clientX, clientY, width, height, options = {}) {
  const rectWidth = Math.max(1, Number(rect?.width ?? 0));
  const rectHeight = Math.max(1, Number(rect?.height ?? 0));
  if (options.preserveAspectRatio === "none") {
    return {
      x: ((clientX - Number(rect?.left ?? 0)) / rectWidth) * width,
      y: ((clientY - Number(rect?.top ?? 0)) / rectHeight) * height,
    };
  }
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

// EMA smoothing. Unlike a destructive smoother, this keeps each point's raw
// `value` intact and attaches a parallel `smoothedValue`, so the chart can draw
// the faded raw series with the opaque smoothed curve overlaid on top.
export function smoothSeries(series, factor = 0) {
  if (factor <= 0) return series;
  const alpha = Math.max(0.01, Math.min(1, 1 - factor / 100));
  return series.map((item) => {
    let previous = null;
    return {
      ...item,
      smoothed: true,
      points: item.points.map((point) => {
        previous = previous === null ? point.value : alpha * point.value + (1 - alpha) * previous;
        return { ...point, smoothedValue: previous };
      }),
    };
  });
}

// Adaptive metric formatter: up to 5 significant figures with trailing zeros
// trimmed. Small magnitudes keep enough decimals to stay legible (e.g. 1.2345e-5
// renders as 0.000012345) instead of collapsing to "0".
export function formatMetricValue(value, sig = 5) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const num = Number(value);
  if (num === 0) return "0";
  const abs = Math.abs(num);
  if (abs >= 1e7 || abs < 1e-7) {
    return num.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, "e");
  }
  const magnitude = Math.floor(Math.log10(abs));
  const decimals = Math.min(12, Math.max(0, sig - 1 - magnitude));
  const fixed = num.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
}

// Compact form for axis tick labels. Full-precision decimals like "0.0024967"
// overflow the y-axis gutter, so very small / very large magnitudes switch to
// trimmed scientific notation (e.g. "2.5e-3", "3.66e-5"). Mid-range values keep
// a plain ≤4 significant-figure decimal.
export function formatAxisTick(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const num = Number(value);
  if (num === 0) return "0";
  const abs = Math.abs(num);
  // Sub-0.01 (and very large) magnitudes use compact scientific notation so the
  // labels stay narrow enough to clear the rotated axis title. The hover tooltip
  // / readout keep full decimal precision via formatMetricValue.
  if (abs < 1e-2 || abs >= 1e5) {
    return num.toExponential(2).replace(/\.?0+e/, "e").replace("e+", "e");
  }
  return formatMetricValue(num, 4);
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
    return { id: group, name: `${group} avg`, group, points, seriesType: "aggregate", sourceRunCount: items.length };
  });
}

function xValue(point, xKey) {
  if (xKey === "time" && point.created_at) {
    const value = new Date(point.created_at).getTime();
    if (Number.isFinite(value)) return value;
  }
  return point.step;
}

// Min/max of the x dimension computed in a single pass. Avoids allocating a
// mapped values array and avoids Math.min(...array) (which is O(n) to spread
// and throws RangeError on very large series).
function xExtent(points, xKey) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = xValue(point, xKey);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
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

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSq) || lengthSq <= 0) {
    return { distance: Math.hypot(x - x1, y - y1), t: 0 };
  }
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return { distance: Math.hypot(x - px, y - py), t };
}

function valueDomain(points, metricKey = "", yScale = "linear", yRange = null) {
  // A manual range IS the domain; data outside it gets clipped by the chart.
  if (yRange) return { minY: yRange.min, maxY: yRange.max };
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const value = Number(point.value);
    if (!Number.isFinite(value)) continue;
    if (yScale === "log" && value <= 0) continue;
    if (value < minY) minY = value;
    if (value > maxY) maxY = value;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    // No usable values (e.g. log scale over all-negative data) still needs a
    // drawable window so the axes render under the empty-state message.
    return yScale === "log" ? { minY: 0.1, maxY: 1 } : { minY: 0, maxY: 1 };
  }
  if (yScale === "log") {
    // Log axes span the positive data exactly; a degenerate single value opens
    // a symmetric window around it (clamped so values near MAX_VALUE don't
    // overflow the top bound to Infinity).
    if (minY === maxY) return { minY: minY / 2, maxY: Math.min(maxY * 2, Number.MAX_VALUE) };
    return { minY, maxY };
  }
  if (usesUnitDomain(metricKey, minY, maxY)) {
    // Bounded metrics (accuracy/rate/…) keep a 0 baseline, but the top fits the
    // data plus a little headroom instead of always pinning to 1 — otherwise a
    // curve that tops out at 0.7 wastes the upper third of the plot.
    const top = Math.min(1, maxY * 1.08);
    return { minY: 0, maxY: top > 0 ? top : 1 };
  }
  return padDomain(minY, maxY);
}

// Ensure the y window is usable. For a real range we keep the exact data
// extremes (the genuine fix for the "squished to the floor" bug was dropping
// the Math.max(1, span) clamp in normalizeSeries, which is what forced tiny
// magnitudes flat). For a degenerate single value we open a magnitude-relative
// window so the lone point sits mid-chart instead of dividing by a zero span.
function padDomain(minY, maxY) {
  if (minY === maxY) {
    const magnitude = Math.abs(minY);
    const pad = magnitude > 0 ? magnitude * 0.5 : 1;
    return { minY: minY - pad, maxY: maxY + pad };
  }
  return { minY, maxY };
}

// Keep the x window strictly positive so single-point / zoomed series don't
// divide by a clamped span. A lone x value is centered in the plot.
function stepDomain(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.max(1, Math.abs(min) * 0.5) : 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
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
