import { execFileSync } from "node:child_process";
import os from "node:os";
import { performance } from "node:perf_hooks";

import {
  chartDomain,
  chartSummaryModel,
  chartSummaryRows,
  chartSummaryTakeaway,
  nearestPoint,
  nearestPointByX,
  normalizeSeries,
  smoothSeries,
  yMapper,
} from "../apps/web/src/charts.js";

const WIDTH = 900;
const HEIGHT = 360;
const PADDING = 28;
const SAMPLES = Number(process.env.INSTANTML_CHART_BENCH_SAMPLES ?? 9);
const WARMUPS = Number(process.env.INSTANTML_CHART_BENCH_WARMUPS ?? 2);

if (typeof global.gc !== "function") {
  throw new Error("Run with node --expose-gc (or npm run benchmark:charts).");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)] ?? 0;
}

function measure(fn, samples = SAMPLES, warmups = WARMUPS) {
  for (let index = 0; index < warmups; index += 1) fn();
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    fn();
    values.push(performance.now() - started);
  }
  return { medianMs: median(values), p95Ms: percentile(values, 95), samples: values };
}

function measurePaired(left, right, samples = SAMPLES, warmups = WARMUPS) {
  for (let index = 0; index < warmups; index += 1) {
    left();
    right();
  }
  const leftValues = [];
  const rightValues = [];
  const run = (fn, values) => {
    const started = performance.now();
    fn();
    values.push(performance.now() - started);
  };
  for (let index = 0; index < samples; index += 1) {
    if (index % 2 === 0) {
      run(left, leftValues);
      run(right, rightValues);
    } else {
      run(right, rightValues);
      run(left, leftValues);
    }
  }
  return {
    left: { medianMs: median(leftValues), p95Ms: percentile(leftValues, 95), samples: leftValues },
    right: { medianMs: median(rightValues), p95Ms: percentile(rightValues, 95), samples: rightValues },
  };
}

function retainedHeap(fn) {
  global.gc();
  const before = process.memoryUsage().heapUsed;
  globalThis.__instantmlChartBenchmarkRetained = fn();
  global.gc();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  globalThis.__instantmlChartBenchmarkRetained = null;
  global.gc();
  return retainedBytes;
}

function retainedHeapMedian(fn) {
  return median(Array.from({ length: Math.max(5, Math.ceil(SAMPLES / 2)) }, () => retainedHeap(fn)));
}

function xValue(point, xMode) {
  if (xMode === "time" && point.created_at) {
    const value = new Date(point.created_at).getTime();
    if (Number.isFinite(value)) return value;
  }
  return point.step;
}

// Frozen pre-optimization normalizer for benchmark comparison. It intentionally
// omits xMonotonic bookkeeping and always constructs a fresh output.
function legacyNormalizeSeries(series, width, height, padding = 28, xMode = "step", metricKey = "", xRange = null, yAxis = null) {
  const domain = chartDomain(series, xMode, metricKey, xRange, yAxis);
  if (!domain) return [];
  const minStep = domain.minX;
  const maxStep = domain.maxX;
  const stepSpan = maxStep - minStep;
  const innerWidth = width - padding * 2;
  const yScale = yAxis?.scale === "log" ? "log" : "linear";
  const mapY = yMapper(domain, height, padding);
  const range = xRange && Number.isFinite(Number(xRange.min)) && Number.isFinite(Number(xRange.max))
    ? { min: Math.min(Number(xRange.min), Number(xRange.max)), max: Math.max(Number(xRange.min), Number(xRange.max)) }
    : null;
  return series.map((item) => {
    const filtered = range ? item.points.filter((point) => {
      const value = xValue(point, xMode);
      return value >= range.min && value <= range.max;
    }) : item.points;
    const positive = yScale === "log" ? filtered.filter((point) => Number(point.value) > 0) : filtered;
    const plottable = xMode === "time"
      ? positive
          .map((point) => [xValue(point, xMode), point])
          .sort((left, right) => left[0] - right[0])
          .map((pair) => pair[1])
      : positive;
    const smoothed = Boolean(item.smoothed);
    const normalizedPoints = new Array(plottable.length);
    let path = "";
    let smoothPath = "";
    for (let index = 0; index < plottable.length; index += 1) {
      const point = plottable[index];
      const pointXValue = xValue(point, xMode);
      const x = padding + ((pointXValue - minStep) / stepSpan) * innerWidth;
      const y = mapY(point.value);
      const smoothable = smoothed && Number.isFinite(point.smoothedValue) && (yScale !== "log" || point.smoothedValue > 0);
      const ySmoothed = smoothable ? mapY(point.smoothedValue) : undefined;
      normalizedPoints[index] = { ...point, x, y, ySmoothed, displayY: ySmoothed ?? y, xValue: pointXValue };
      const xString = x.toFixed(2);
      path += `${index ? " " : ""}${xString},${y.toFixed(2)}`;
      if (smoothed) smoothPath += `${index ? " " : ""}${xString},${(ySmoothed ?? y).toFixed(2)}`;
    }
    return { ...item, points: filtered, path, smoothPath, normalizedPoints, domain, hiddenNonPositive: filtered.length - plottable.length };
  });
}

function legacyDistanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSquared) || lengthSquared <= 0) return { distance: Math.hypot(x - x1, y - y1), t: 0 };
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return { distance: Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)), t };
}

function legacyNearestPoint(normalizedSeries, x, y, maxDistance = 18) {
  let nearest = null;
  const consider = (item, point, distance) => {
    if (distance <= maxDistance && (!nearest || distance < nearest.distance)) {
      nearest = { runId: item.id, runName: item.name, identifier: item.identifier ?? item.name, group: item.group, point, distance };
    }
  };
  for (const item of normalizedSeries) {
    let previous = null;
    for (const point of item.normalizedPoints ?? []) {
      const pointY = point.displayY ?? point.y;
      consider(item, point, Math.hypot(point.x - x, pointY - y));
      if (previous) {
        const previousY = previous.displayY ?? previous.y;
        const segment = legacyDistanceToSegment(x, y, previous.x, previousY, point.x, pointY);
        consider(item, segment.t <= 0.5 ? previous : point, segment.distance);
      }
      previous = point;
    }
  }
  return nearest;
}

function legacyNearestPointByX(item, targetX) {
  let nearest = null;
  for (const point of item.normalizedPoints ?? []) {
    if (!nearest || Math.abs(point.xValue - targetX) < Math.abs(nearest.xValue - targetX)) nearest = point;
  }
  return nearest;
}

function tooltipRows(normalizedSeries, targetX, nearestByX) {
  const rows = normalizedSeries.map((item, index) => {
    const point = nearestByX(item, targetX);
    return { id: item.id, index, value: item.smoothed && Number.isFinite(point?.smoothedValue) ? point.smoothedValue : point?.value ?? null };
  });
  rows.sort((left, right) => (right.value ?? Number.NEGATIVE_INFINITY) - (left.value ?? Number.NEGATIVE_INFINITY));
  return rows.slice(0, 8);
}

function makeSeries(runCount, pointCount, { timeMode = false } = {}) {
  return Array.from({ length: runCount }, (_, runIndex) => ({
    id: `run-${runIndex}`,
    name: `Run ${runIndex}`,
    points: Array.from({ length: pointCount }, (_, pointIndex) => ({
      step: pointIndex,
      value: 1.5 + Math.sin(pointIndex / 11 + runIndex / 17) + runIndex / 10_000,
      created_at: timeMode ? new Date(Date.UTC(2026, 0, 1, 0, 0, pointIndex, runIndex % 1000)).toISOString() : undefined,
    })),
  }));
}

function querySuite() {
  return Array.from({ length: 20 }, (_, index) => ({
    x: index === 19 ? WIDTH + 200 : PADDING + ((index + 0.35) / 19) * (WIDTH - PADDING * 2),
    y: index % 5 === 0 ? HEIGHT + 100 : PADDING + ((index * 47) % (HEIGHT - PADDING * 2)),
  }));
}

function benchmarkShape(runCount, pointCount) {
  const series = makeSeries(runCount, pointCount);
  const normalizeArgs = [series, WIDTH, HEIGHT, PADDING, "step", "train/loss", null, null];
  const normalized = normalizeSeries(...normalizeArgs);
  const queries = querySuite();
  const targetXValues = queries.map((query) => ((query.x - PADDING) / (WIDTH - PADDING * 2)) * Math.max(1, pointCount - 1));

  const singlePair = measurePaired(() => legacyNormalizeSeries(...normalizeArgs), () => normalizeSeries(...normalizeArgs));
  const legacySingle = singlePair.left;
  const indexedSingle = singlePair.right;
  const renderPair = measurePaired(
    () => [legacyNormalizeSeries(...normalizeArgs), legacyNormalizeSeries(...normalizeArgs)],
    () => normalizeSeries(...normalizeArgs),
  );
  const legacyDouble = renderPair.left;
  const reusedSingle = renderPair.right;
  const legacyHit = measure(() => queries.map((query) => legacyNearestPoint(normalized, query.x, query.y)));
  const indexedHit = measure(() => queries.map((query) => nearestPoint(normalized, query.x, query.y)));
  const legacyTooltip = measure(() => targetXValues.map((target) => tooltipRows(normalized, target, legacyNearestPointByX)));
  const indexedTooltip = measure(() => targetXValues.map((target) => tooltipRows(normalized, target, nearestPointByX)));
  const legacyCombined = measure(() => queries.map((query, index) => {
    const hit = legacyNearestPoint(normalized, query.x, query.y);
    return hit ? tooltipRows(normalized, hit.point.xValue ?? targetXValues[index], legacyNearestPointByX) : [];
  }));
  const indexedCombined = measure(() => queries.map((query, index) => {
    const hit = nearestPoint(normalized, query.x, query.y);
    return hit ? tooltipRows(normalized, hit.point.xValue ?? targetXValues[index], nearestPointByX) : [];
  }));
  const eagerSummaryPair = measure(() => [chartSummaryRows(normalized, "train/loss"), chartSummaryTakeaway(normalized, "train/loss")]);
  const summaryModel = measure(() => chartSummaryModel(normalized, "train/loss"));

  return {
    runs: runCount,
    pointsPerRun: pointCount,
    totalPoints: runCount * pointCount,
    legacySingleMs: legacySingle.medianMs,
    indexedSingleMs: indexedSingle.medianMs,
    singleRegressionRatio: indexedSingle.medianMs / legacySingle.medianMs,
    legacyDoubleMs: legacyDouble.medianMs,
    reusedSingleMs: reusedSingle.medianMs,
    defaultRenderSpeedup: legacyDouble.medianMs / reusedSingle.medianMs,
    legacyDoubleRetainedMb: retainedHeapMedian(() => [legacyNormalizeSeries(...normalizeArgs), legacyNormalizeSeries(...normalizeArgs)]) / 1_048_576,
    reusedSingleRetainedMb: retainedHeapMedian(() => normalizeSeries(...normalizeArgs)) / 1_048_576,
    hitTestLegacyMs: legacyHit.medianMs,
    hitTestIndexedMs: indexedHit.medianMs,
    hitTestSpeedup: legacyHit.medianMs / indexedHit.medianMs,
    tooltipLegacyMs: legacyTooltip.medianMs,
    tooltipIndexedMs: indexedTooltip.medianMs,
    tooltipSpeedup: legacyTooltip.medianMs / indexedTooltip.medianMs,
    combinedLegacyMs: legacyCombined.medianMs,
    combinedIndexedMs: indexedCombined.medianMs,
    combinedSpeedup: legacyCombined.medianMs / indexedCombined.medianMs,
    eagerSummaryPairMs: eagerSummaryPair.medianMs,
    lazySummaryModelMs: summaryModel.medianMs,
  };
}

function benchmarkVariant(name, series, xMode = "step", xRange = null, yAxis = null) {
  const args = [series, WIDTH, HEIGHT, PADDING, xMode, "train/loss", xRange, yAxis];
  const pair = measurePaired(() => legacyNormalizeSeries(...args), () => normalizeSeries(...args));
  const legacy = pair.left;
  const indexed = pair.right;
  return { name, legacyMs: legacy.medianMs, indexedMs: indexed.medianMs, regressionRatio: indexed.medianMs / legacy.medianMs };
}

function benchmarkZoomOverview(series) {
  const legacy = measure(() => legacyNormalizeSeries(series, WIDTH, HEIGHT, PADDING, "step", "train/loss", null, null));
  const amended = measure(() => [
    chartDomain(series, "step", "train/loss", null, null),
    normalizeSeries(series.slice(0, 5), WIDTH, HEIGHT, PADDING, "step", "train/loss", null, null),
  ]);
  return {
    legacyAllSeriesMs: legacy.medianMs,
    amendedDomainPlusFiveSeriesMs: amended.medianMs,
    speedup: legacy.medianMs / amended.medianMs,
  };
}

const shapes = [[100, 250], [1000, 80], [2000, 60]].map(([runs, points]) => benchmarkShape(runs, points));
const variantBase = makeSeries(100, 250);
const variants = [
  benchmarkVariant("time", makeSeries(100, 250, { timeMode: true }), "time"),
  benchmarkVariant("smoothed", smoothSeries(variantBase, 60)),
  benchmarkVariant("log", variantBase, "step", null, { scale: "log" }),
  benchmarkVariant("zoomed-main", variantBase, "step", { min: 50, max: 180 }),
];
const zoomOverview = benchmarkZoomOverview(makeSeries(2_000, 60));

const result = {
  generatedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  node: process.version,
  platform: `${process.platform}-${process.arch} ${os.release()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  width: WIDTH,
  height: HEIGHT,
  padding: PADDING,
  samples: SAMPLES,
  warmups: WARMUPS,
  shapes,
  variants,
  zoomOverview,
};

console.log(JSON.stringify(result, null, 2));

const largest = shapes.at(-1);
const failures = [];
if (largest.defaultRenderSpeedup < 1 / 0.65) failures.push(`default render speedup ${largest.defaultRenderSpeedup.toFixed(2)}x < 1.54x`);
if (largest.reusedSingleRetainedMb > largest.legacyDoubleRetainedMb * 0.65) failures.push("retained heap reduction below 35%");
if (largest.hitTestSpeedup < 5) failures.push(`hit-test speedup ${largest.hitTestSpeedup.toFixed(2)}x < 5x`);
if (largest.combinedSpeedup < 3) failures.push(`combined hover speedup ${largest.combinedSpeedup.toFixed(2)}x < 3x`);
if (shapes.some((shape) => shape.singleRegressionRatio > 1.1)) failures.push("indexed single normalization regressed by more than 10%");
if (variants.some((variant) => variant.regressionRatio > 1.1)) failures.push("a variant normalization regressed by more than 10%");
if (zoomOverview.speedup < 1.5) failures.push(`zoom overview speedup ${zoomOverview.speedup.toFixed(2)}x < 1.5x`);
if (failures.length) {
  console.error(`Chart benchmark failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
}
