import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  chartDomain,
  logAxisTicks,
  normalizeSeries,
  sanitizeYAxisRange,
  yMapper,
} from "../src/charts.js";
import { chartSeriesToSvg } from "../src/chart-export.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(path.join(here, "..", relative), "utf8");

const series = (values, extra = {}) => [{
  id: "run-1",
  name: "run-1",
  points: values.map((value, step) => ({ key: "loss", step, value })),
  ...extra,
}];

test("logAxisTicks emits power-of-ten ticks across wide ranges", () => {
  const ticks = logAxisTicks(1e-4, 1, 5);
  assert.ok(ticks.length >= 2 && ticks.length <= 7, `got ${ticks.length} ticks`);
  for (const tick of ticks) {
    const mantissa = tick / Math.pow(10, Math.floor(Math.log10(tick)));
    assert.ok(Math.abs(mantissa - 1) < 1e-6, `${tick} is not a power of ten`);
  }
  assert.ok(ticks[0] >= 1e-4 && ticks[ticks.length - 1] <= 1 + 1e-9);
});

test("logAxisTicks uses 1-2-5 mantissas on narrow ranges and rejects non-positive bounds", () => {
  const narrow = logAxisTicks(1, 30, 5);
  assert.ok(narrow.includes(2) || narrow.includes(5), `expected 1-2-5 family, got ${narrow}`);
  for (const tick of narrow) {
    const mantissa = Number((tick / Math.pow(10, Math.floor(Math.log10(tick)))).toPrecision(6));
    assert.ok([1, 2, 5].includes(mantissa), `${tick} not in the 1-2-5 family`);
  }
  assert.deepEqual(logAxisTicks(0, 10), []);
  assert.deepEqual(logAxisTicks(-5, 10), []);
  assert.deepEqual(logAxisTicks(3, 3), [3]);
  // Sub-decade windows fall back to positive linear ticks.
  const subDecade = logAxisTicks(3, 8, 4);
  assert.ok(subDecade.length >= 2);
  assert.ok(subDecade.every((tick) => tick > 0));
});

test("sanitizeYAxisRange rejects empty, inverted, and log-invalid windows", () => {
  assert.equal(sanitizeYAxisRange(null), null);
  assert.equal(sanitizeYAxisRange({ min: 2, max: 1 }), null);
  assert.equal(sanitizeYAxisRange({ min: 1, max: 1 }), null);
  assert.equal(sanitizeYAxisRange({ min: Number.NaN, max: 1 }), null);
  assert.deepEqual(sanitizeYAxisRange({ min: -1, max: 1 }), { min: -1, max: 1 });
  assert.equal(sanitizeYAxisRange({ min: -1, max: 1 }, "log"), null);
  assert.equal(sanitizeYAxisRange({ min: 0, max: 1 }, "log"), null);
  assert.deepEqual(sanitizeYAxisRange({ min: 0.001, max: 1 }, "log"), { min: 0.001, max: 1 });
});

test("normalizeSeries log scale spaces decades evenly and drops non-positive points", () => {
  const [item] = normalizeSeries(series([0.01, 0.1, 1, -5, 0]), 400, 300, 30, "step", "loss", null, { scale: "log" });
  assert.equal(item.hiddenNonPositive, 2);
  assert.equal(item.normalizedPoints.length, 3);
  assert.equal(item.domain.yScale, "log");
  assert.equal(item.domain.minY, 0.01);
  assert.equal(item.domain.maxY, 1);
  const [a, b, c] = item.normalizedPoints;
  // 0.01 → bottom, 1 → top, 0.1 → exactly midway on a log10 axis.
  assert.ok(Math.abs(b.y - (a.y + c.y) / 2) < 1e-6, `mid-decade point not centered: ${a.y}, ${b.y}, ${c.y}`);
  assert.ok(a.y > b.y && b.y > c.y, "log y positions should descend as values grow");
});

test("normalizeSeries log scale keeps raw points for export and survives all-non-positive data", () => {
  const [item] = normalizeSeries(series([0.5, -1, 2]), 400, 300, 30, "step", "loss", null, { scale: "log" });
  assert.equal(item.points.length, 3, "raw points stay intact for CSV export");
  const [empty] = normalizeSeries(series([-1, -2, 0]), 400, 300, 30, "step", "loss", null, { scale: "log" });
  assert.equal(empty.normalizedPoints.length, 0);
  assert.equal(empty.hiddenNonPositive, 3);
  assert.ok(empty.domain.minY > 0, "fallback log domain must stay positive");
});

test("smoothed values map onto the log scale only when positive", () => {
  const smoothedSeries = [{
    id: "run-1",
    name: "run-1",
    smoothed: true,
    points: [
      { key: "loss", step: 0, value: 1, smoothedValue: 1 },
      { key: "loss", step: 1, value: 0.1, smoothedValue: -0.2 },
    ],
  }];
  const [item] = normalizeSeries(smoothedSeries, 400, 300, 30, "step", "loss", null, { scale: "log" });
  assert.equal(item.normalizedPoints.length, 2);
  assert.equal(item.normalizedPoints[1].ySmoothed, undefined, "non-positive EMA value cannot be placed on a log axis");
  assert.equal(item.normalizedPoints[1].displayY, item.normalizedPoints[1].y);
});

test("manual y-range overrides the data domain on both scales", () => {
  const linear = chartDomain(series([1, 2, 3]), "step", "loss", null, { range: { min: 0, max: 10 } });
  assert.equal(linear.minY, 0);
  assert.equal(linear.maxY, 10);
  assert.equal(linear.yScale, "linear");
  const log = chartDomain(series([1, 2, 3]), "step", "loss", null, { scale: "log", range: { min: 0.1, max: 100 } });
  assert.equal(log.minY, 0.1);
  assert.equal(log.maxY, 100);
  // Invalid log range (floor <= 0) falls back to the data domain.
  const fallback = chartDomain(series([1, 2, 3]), "step", "loss", null, { scale: "log", range: { min: -1, max: 100 } });
  assert.equal(fallback.minY, 1);
  assert.equal(fallback.maxY, 3);
  const [item] = normalizeSeries(series([1, 2, 3]), 400, 300, 30, "step", "loss", null, { range: { min: 0, max: 10 } });
  assert.equal(item.domain.yRangeManual, true);
});

test("yMapper matches normalizeSeries placement on both scales", () => {
  for (const yAxis of [null, { scale: "log" }]) {
    const [item] = normalizeSeries(series([0.5, 2, 8]), 400, 300, 30, "step", "loss", null, yAxis);
    const map = yMapper(item.domain, 300, 30);
    for (const point of item.normalizedPoints) {
      assert.ok(Math.abs(map(point.value) - point.y) < 1e-9, `mapper drift on ${yAxis?.scale ?? "linear"} scale`);
    }
  }
});

test("a degenerate single log value opens a decade window around itself", () => {
  const domain = chartDomain(series([0.4, 0.4]), "step", "loss", null, { scale: "log" });
  assert.equal(domain.minY, 0.2);
  assert.equal(domain.maxY, 0.8);
});

test("SVG export renders log charts with log ticks on the shared mapper", () => {
  const normalized = normalizeSeries(series([0.001, 0.1, 10]), 560, 360, 28, "step", "loss", null, { scale: "log" });
  const svg = chartSeriesToSvg({ metricKey: "loss", series: normalized, width: 560, height: 360, padding: 28 });
  // Power-of-ten tick labels (formatAxisTick renders 0.001 as 1e-3).
  assert.ok(svg.includes("1e-3"), "expected a 1e-3 log tick label in the exported SVG");
  const exportSource = readSource("src/chart-export.js");
  assert.match(exportSource, /yScale === "log" \? logAxisTicks/);
  assert.match(exportSource, /yMapper\(domain, safeHeight, safePadding\)/);
});

test("MetricChart wires the y-axis controls, log empty state, and plot clipping", () => {
  const source = readSource("app/dashboard/metrics/metric-chart.tsx");
  const chartsCss = readSource("app/styles/charts.css");
  const dashboardCss = readSource("app/styles/dashboard.css");
  // Per-panel toggle with pressed state + non-positive disclosure.
  assert.match(source, /chart-log-toggle/);
  assert.match(source, /aria-pressed=\{yScale === "log"\}/);
  assert.match(source, /hiddenNonPositive/);
  // Manual range popover applies through the shared sanitizer.
  assert.match(source, /sanitizeYAxisRange\(\{ min, max \}, yScale\)/);
  assert.match(source, /chart-y-range-pop/);
  // Log ticks + shared mapper for gridlines.
  assert.match(source, /logAxisTicks\(domain\.minY, domain\.maxY/);
  assert.match(source, /yMapper\(domain, frameHeight, pad\)/);
  // Manual ranges clip series to the plot rect in both renderers.
  assert.match(source, /clipPath id=\{plotClipId\}/);
  assert.match(source, /context\.clip\(\)/);
  // The all-non-positive log state keeps the actions row mounted.
  assert.match(source, /Log scale plots positive values only/);
  // The mini range overview shares the same y scale as the main plot
  // (memoized so hover re-renders reuse the mapper and polyline geometry).
  assert.match(source, /const miniY = useMemo\(\(\) => yMapper\(domain, miniHeight, padY\), \[domain, miniHeight, padY\]\)/);
  // The unzoomed range and hidden summary view must not duplicate the full
  // normalization / summary scans on every chart render.
  assert.match(source, /const rangeActive = showRange && Boolean\(zoomRange\)/);
  assert.match(source, /rangeActive\s*\n?\s*\? normalizeSeries/);
  assert.match(source, /chartView === "summary" \? chartSummaryModel/);
  assert.match(source, /normalizeSeries\(series\.slice\(0, MINI_RANGE_SERIES_LIMIT\)/);
  assert.match(source, /rangeActive \? chartDomain\(series, xMode, metricKey, null, yAxisOptions\)/);
  assert.match(source, /styleIndexes=\{styleIndexes\}/);
  assert.match(source, /useLineStyles=\{useLineStyles\}/);
  // Overview + full-domain memos key on rangeActive — never on the zoomRange
  // object — so re-zooming to a new window reuses both cached results instead
  // of re-scanning the full domain per gesture.
  assert.doesNotMatch(source, /\[frameHeight, metricKey, pad, rangeActive, series, width, xMode, yAxisOptions, zoomRange\]/);
  assert.match(source, /\[metricKey, rangeActive, series, xMode, yAxisOptions\]/);
  // Style slots hash series identity only; keying on the raw series keeps the
  // array referentially stable across zoom-window renormalizations.
  assert.match(source, /chartStyleIndexesForItems\(series\), \[series\]/);
  // Tooltip rows rank lean rows first and resolve display fields only for the
  // sliced top rows (Intl formatting per series cost ~30ms/hover at 2,000).
  assert.match(source, /ranked\.slice\(0, TOOLTIP_ROW_LIMIT\)\.map/);
  // Number inputs must shrink inside the compact popover instead of keeping
  // their intrinsic browser width and spilling past the panel edge.
  assert.match(chartsCss, /\.chart-y-range-field input \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;/);
  assert.match(dashboardCss, /\.shell input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\),[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;/);
});
