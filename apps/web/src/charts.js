import { metricGoal } from "./state.js";

/**
 * @param {{ min: number, max: number } | null} [xRange]
 * @param {{ scale?: "linear" | "log", range?: { min: number, max: number } | null } | null} [yAxis]
 */
export function normalizeSeries(series, width, height, padding = 28, xKey = "step", metricKey = "", xRange = null, yAxis = null) {
  // Domain stats iterate the nested series arrays directly — flattening via
  // series.flatMap() allocated an O(total points) copy (≈1 MB per call at a
  // 120k-point selection) on every normalization just to take extents.
  const full = seriesXStats(series, xKey, null);
  if (full.count === 0) return [];
  const yScale = yAxis?.scale === "log" ? "log" : "linear";
  const yRange = sanitizeYAxisRange(yAxis?.range, yScale);
  const range = boundedXRange(xRange, full.min, full.max);
  const visible = range ? seriesXStats(series, xKey, range) : full;
  const visibleExtent = range && visible.count > 1 ? visible : null;
  const rawMinStep = visibleExtent ? visibleExtent.min : range?.min ?? full.min;
  const rawMaxStep = visibleExtent ? visibleExtent.max : range?.max ?? full.max;
  const { min: minStep, max: maxStep } = stepDomain(rawMinStep, rawMaxStep);
  // An x-zoom that empties the window falls back to the full data for the y
  // domain, mirroring the old visiblePoints.length ? visiblePoints : points.
  const yDomain = valueDomain(series, xKey, visible.count ? range : null, metricKey, yScale, yRange);
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
    let xMonotonic = true;
    let previousX = Number.NEGATIVE_INFINITY;
    let previousXValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < plottable.length; i += 1) {
      const point = plottable[i];
      const xv = xValue(point, xKey);
      const x = padding + ((xv - minStep) / stepSpan) * innerW;
      if (!Number.isFinite(x) || !Number.isFinite(xv) || x < previousX || xv < previousXValue) {
        xMonotonic = false;
      }
      previousX = x;
      previousXValue = xv;
      const y = mapY(point.value);
      const smoothable = smoothed && Number.isFinite(point.smoothedValue) && (yScale !== "log" || point.smoothedValue > 0);
      const ySmoothed = smoothable ? mapY(point.smoothedValue) : undefined;
      normalizedPoints[i] = { ...point, x, y, ySmoothed, displayY: ySmoothed ?? y, xValue: xv };
      const xs = x.toFixed(2);
      path += `${i ? " " : ""}${xs},${y.toFixed(2)}`;
      if (smoothed) smoothPath += `${i ? " " : ""}${xs},${(ySmoothed ?? y).toFixed(2)}`;
    }
    return { ...item, points: filtered, path, smoothPath, normalizedPoints, domain, hiddenNonPositive: filtered.length - plottable.length, xMonotonic };
  });
}

/**
 * @param {{ min: number, max: number } | null} [xRange]
 * @param {{ scale?: "linear" | "log", range?: { min: number, max: number } | null } | null} [yAxis]
 */
export function chartDomain(series, xKey = "step", metricKey = "", xRange = null, yAxis = null) {
  const full = seriesXStats(series, xKey, null);
  if (full.count === 0) return null;
  const yScale = yAxis?.scale === "log" ? "log" : "linear";
  const yRange = sanitizeYAxisRange(yAxis?.range, yScale);
  const range = boundedXRange(xRange, full.min, full.max);
  const visible = range ? seriesXStats(series, xKey, range) : full;
  const visibleExtent = range && visible.count > 1 ? visible : null;
  const yDomain = valueDomain(series, xKey, visible.count ? range : null, metricKey, yScale, yRange);
  const rawMinX = visibleExtent ? visibleExtent.min : range?.min ?? full.min;
  const rawMaxX = visibleExtent ? visibleExtent.max : range?.max ?? full.max;
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
    const points = item.normalizedPoints ?? [];
    let start = 0;
    let end = points.length - 1;
    if (item.xMonotonic === true && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(maxDistance) && maxDistance > 0) {
      const lower = lowerBoundPoint(points, x - maxDistance, "x");
      const upper = upperBoundPoint(points, x + maxDistance, "x");
      start = Math.max(0, lower - 1);
      end = Math.min(points.length - 1, upper);
    }
    let previous = null;
    for (let index = start; index <= end; index += 1) {
      const point = points[index];
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

export function nearestPointByX(item, targetX) {
  const points = item?.normalizedPoints ?? [];
  if (!points.length) return null;
  if (item?.xMonotonic !== true || !Number.isFinite(targetX)) {
    return linearNearestPointByX(points, targetX);
  }

  const rightIndex = lowerBoundPoint(points, targetX, "xValue");
  if (rightIndex <= 0) return points[0];
  if (rightIndex >= points.length) return points[firstEqualPointIndex(points, points.length - 1, "xValue")];
  const leftIndex = rightIndex - 1;
  const leftDistance = Math.abs(points[leftIndex].xValue - targetX);
  const rightDistance = Math.abs(points[rightIndex].xValue - targetX);
  const selectedIndex = leftDistance <= rightDistance ? leftIndex : rightIndex;
  return points[firstEqualPointIndex(points, selectedIndex, "xValue")];
}

function linearNearestPointByX(points, targetX) {
  let nearest = null;
  for (const point of points) {
    if (!nearest || Math.abs(point.xValue - targetX) < Math.abs(nearest.xValue - targetX)) nearest = point;
  }
  return nearest;
}

function firstEqualPointIndex(points, index, key) {
  return lowerBoundPoint(points, points[index][key], key);
}

function lowerBoundPoint(points, target, key) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle][key] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundPoint(points, target, key) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle][key] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
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

export function chartSummaryRows(series, metricKey = "") {
  const goal = metricGoal(metricKey);
  const rows = (series ?? []).map((item, index) => {
    const points = chartSummaryPoints(item);
    const first = points[0] ?? null;
    const final = points[points.length - 1] ?? null;
    const best = bestSummaryPoint(points, goal);
    const changePercent = first && final && Number(first.value) !== 0
      ? ((Number(final.value) - Number(first.value)) / Math.abs(Number(first.value))) * 100
      : null;
    const trend = trendForSummaryPoints(points, goal);
    const notes = [];
    if (item?.seriesType === "aggregate") notes.push(`aggregate${item.sourceRunCount ? ` of ${item.sourceRunCount}` : ""}`);
    if (item?.smoothed) notes.push("chart smoothed");
    if (!points.length) notes.push("no plotted points");
    return {
      id: item?.id ?? `series-${index}`,
      name: item?.identifier ?? item?.name ?? `Series ${index + 1}`,
      first: first ? Number(first.value) : null,
      final: final ? Number(final.value) : null,
      best: best ? Number(best.value) : null,
      bestStep: best ? best.step ?? null : null,
      changePercent,
      points: points.length,
      rank: null,
      trend,
      notes: notes.length ? notes.join("; ") : "complete",
    };
  });
  const ranked = rows
    .filter((row) => Number.isFinite(row.final))
    .sort((a, b) => goal === "minimize" ? a.final - b.final : b.final - a.final);
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function chartSummaryTakeaway(series, metricKey = "") {
  const rows = chartSummaryRows(series, metricKey);
  return chartSummaryTakeawayFromRows(rows, metricKey);
}

export function chartSummaryModel(series, metricKey = "") {
  const rows = chartSummaryRows(series, metricKey);
  return { rows, takeaway: chartSummaryTakeawayFromRows(rows, metricKey) };
}

function chartSummaryTakeawayFromRows(rows, metricKey) {
  const goal = metricGoal(metricKey);
  const direction = goal === "minimize" ? "Lower is better" : "Higher is better";
  const plottedRows = rows.filter((row) => row.points > 0);
  if (!plottedRows.length) return `${metricKey} has no plotted series.`;
  const best = plottedRows.find((row) => row.rank === 1);
  const runnerUp = plottedRows.find((row) => row.rank === 2);
  const improvingRows = plottedRows.filter((row) => row.trend === "improving");
  const worseningRows = plottedRows.filter((row) => row.trend === "worsening");
  const trendNote = improvingRows.length
    ? `${improvingRows[0].name} is improving overall.`
    : worseningRows.length
      ? `${worseningRows[0].name} is worsening overall.`
      : "The plotted series are mostly flat overall.";
  const bestSentence = best
    ? `${best.name} has the best final value at ${formatMetricValue(best.final)}${runnerUp ? `, followed by ${runnerUp.name} at ${formatMetricValue(runnerUp.final)}` : ""}.`
    : "No finite final values are available.";
  return `${metricKey} across ${plottedRows.length} plotted ${plottedRows.length === 1 ? "series" : "series"}. ${direction}. ${bestSentence} ${trendNote}`;
}

function chartSummaryPoints(item) {
  const useNormalized = Boolean(item?.normalizedPoints?.length);
  const source = useNormalized ? item.normalizedPoints : item?.points ?? [];
  // Lean rows: the summary only reads value/step/xValue, so spread-cloning
  // every normalized point (~10 fields each) was pure allocation churn at
  // 2,000 × 60 points.
  const points = [];
  for (const point of source) {
    const value = Number(point?.value);
    if (!Number.isFinite(value)) continue;
    const xRaw = Number(point.xValue);
    points.push({ step: point.step, value, xValue: Number.isFinite(xRaw) ? xRaw : Number(point.step) });
  }
  // Normalized points flagged monotonic are already in x order; raw/legacy
  // inputs keep the sort.
  if (!(useNormalized && item.xMonotonic === true)) points.sort((a, b) => a.xValue - b.xValue);
  return points;
}

function bestSummaryPoint(points, goal) {
  return points.reduce((best, point) => {
    if (!best) return point;
    return goal === "minimize"
      ? point.value < best.value ? point : best
      : point.value > best.value ? point : best;
  }, null);
}

function trendForSummaryPoints(points, goal) {
  if (points.length < 2) return "not enough data";
  const first = points[0].value;
  const final = points[points.length - 1].value;
  const scale = Math.max(1e-12, Math.abs(first));
  const relative = (final - first) / scale;
  const better = goal === "minimize" ? relative < -0.01 : relative > 0.01;
  const worse = goal === "minimize" ? relative > 0.01 : relative < -0.01;
  if (better) return "improving";
  if (worse) return "worsening";
  return "flat";
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
  // Sub-0.01 magnitudes use trimmed scientific notation so the labels stay narrow
  // enough to clear the rotated axis title. The hover tooltip / readout keep full
  // decimal precision via formatMetricValue.
  if (abs < 1e-2) {
    return num.toExponential(2).replace(/\.?0+e/, "e").replace("e+", "e");
  }
  // Large magnitudes (5+ digits) use compact k/M/B/T suffixes so the right-anchored
  // y-axis ticks stay narrow enough not to clip against the axis inset — e.g.
  // tokens/sec around 40k previously rendered as "40000" and ran off the left edge.
  if (abs >= 1e4) {
    const units = [
      { value: 1e12, suffix: "T" },
      { value: 1e9, suffix: "B" },
      { value: 1e6, suffix: "M" },
      { value: 1e3, suffix: "k" },
    ];
    const unit = units.find((entry) => abs >= entry.value);
    if (unit) {
      const scaled = num / unit.value;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${parseFloat(scaled.toFixed(digits))}${unit.suffix}`;
    }
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

// Point count plus min/max of the x dimension in one nested pass, optionally
// restricted to an x range. Iterates the per-series arrays in place: no
// flattened copy, no mapped values array, no Math.min(...spread) (which is
// O(n) to spread and throws RangeError on very large series).
function seriesXStats(series, xKey, range) {
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const item of series) {
    for (const point of item.points) {
      const value = xValue(point, xKey);
      if (range && !(value >= range.min && value <= range.max)) continue;
      count += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return { count, min, max };
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

function valueDomain(series, xKey, range, metricKey = "", yScale = "linear", yRange = null) {
  // A manual range IS the domain; data outside it gets clipped by the chart.
  if (yRange) return { minY: yRange.min, maxY: yRange.max };
  let minY = Infinity;
  let maxY = -Infinity;
  for (const item of series) {
    for (const point of item.points) {
      if (range && !pointInRange(point, xKey, range)) continue;
      const value = Number(point.value);
      if (!Number.isFinite(value)) continue;
      if (yScale === "log" && value <= 0) continue;
      if (value < minY) minY = value;
      if (value > maxY) maxY = value;
    }
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

// Ensure the y window is usable. For a spread of values we round the bounds out
// to "nice" tick boundaries (d3.nice-style) so the curve sits *inside* the
// gridlines — with a labeled tick at or below the minimum — instead of the
// lowest point landing flush on the x-axis (which reads as clipped). The step
// scales with the data span (the same 1-2-5 family axisTicks uses), so this
// keeps the "squished to the floor" fix intact: tiny-magnitude metrics still
// fill most of the plot height rather than collapsing under a Math.max(1, span)
// clamp. For a degenerate single value we open a magnitude-relative window so
// the lone point sits mid-chart instead of dividing by a zero span.
function padDomain(minY, maxY) {
  if (minY === maxY) {
    const magnitude = Math.abs(minY);
    const pad = magnitude > 0 ? magnitude * 0.5 : 1;
    return { minY: minY - pad, maxY: maxY + pad };
  }
  return niceDomain(minY, maxY);
}

// Round [min, max] outward to the nearest multiple of a "nice" 1-2-5 step sized
// for ~`count` gridlines, so the domain bounds align with axis ticks and the
// data keeps a little breathing room from the top and bottom axes. Data already
// on nice boundaries (e.g. a metric that bottoms out at 0) is left untouched.
function niceDomain(min, max, count = 5) {
  const rawStep = (max - min) / Math.max(1, count - 1);
  if (!(rawStep > 0)) return { minY: min, maxY: max };
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceUnit = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  const step = niceUnit * magnitude;
  // Snap float drift (e.g. 0.30000000000000004) back to the clean multiple.
  return {
    minY: Number((Math.floor(min / step) * step).toFixed(10)),
    maxY: Number((Math.ceil(max / step) * step).toFixed(10)),
  };
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
