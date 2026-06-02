import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_EXPORT_MAX_POINTS,
  CHART_EXPORT_MAX_SERIES,
  chartExportBlockedReason,
  chartExportStats,
  chartSeriesToCsv,
  chartSeriesToSvg,
  filenameFromContentDisposition,
  safeExportFilename,
} from "../src/chart-export.js";

const plottedSeries = [
  {
    id: "run-1",
    name: "Run 1",
    group: "baseline",
    path: "28.00,100.00 200.00,50.00",
    domain: { minX: 0, maxX: 1, minY: 0.5, maxY: 1 },
    normalizedPoints: [
      { step: 0, value: 0.5, created_at: "2026-05-31T00:00:00.000Z", xValue: 0, x: 28, y: 100 },
      { step: 1, value: 1, created_at: "2026-05-31T00:00:01.000Z", xValue: 1, x: 200, y: 50 },
    ],
  },
];

test("chart export stats and caps describe the plotted series", () => {
  assert.deepEqual(chartExportStats(plottedSeries), { series: 1, points: 2 });
  assert.equal(chartExportBlockedReason(plottedSeries), "");
  assert.match(chartExportBlockedReason([]), /No plotted points/);
  assert.match(chartExportBlockedReason(Array.from({ length: CHART_EXPORT_MAX_SERIES + 1 }, (_, index) => ({
    id: `run-${index}`,
    normalizedPoints: [{ step: 0, value: 1 }],
  }))), /up to 120 plotted series/);
  assert.match(chartExportBlockedReason([{ id: "heavy", normalizedPoints: Array.from({ length: CHART_EXPORT_MAX_POINTS + 1 }, () => ({ step: 0, value: 1 })) }]), /20,000 plotted points/);
});

test("chart CSV exports plotted points and neutralizes spreadsheet formulas", () => {
  const csv = chartSeriesToCsv({
    metricKey: "=cmd",
    series: [{ ...plottedSeries[0], name: "+SUM(A1:A2)" }],
    xMode: "step",
  });
  assert.match(csv, /^metric_key,series_id,series_type,run_id,run_name,group,source_count,step,value/m);
  assert.match(csv, /'=cmd,run-1,run,run-1,'\+SUM\(A1:A2\),baseline,,0,0\.5/);
  assert.match(chartSeriesToCsv({ metricKey: "\tplain", series: plottedSeries }), /'\tplain/);
  assert.match(chartSeriesToCsv({ metricKey: "\nplain", series: plottedSeries }), /"'\nplain"/);
  assert.match(chartSeriesToCsv({ metricKey: "\u000b=cmd", series: plottedSeries }), /'\u000b=cmd/);
  assert.match(chartSeriesToCsv({ metricKey: "\ufeff=cmd", series: plottedSeries }), /'\ufeff=cmd/);
});

test("chart CSV distinguishes aggregate series from run series", () => {
  const csv = chartSeriesToCsv({
    metricKey: "loss",
    series: [{ ...plottedSeries[0], id: "baseline", name: "baseline avg", seriesType: "aggregate", sourceRunCount: 3 }],
    xMode: "step",
  });
  assert.match(csv, /loss,baseline,aggregate,,baseline avg,baseline,3,0,0\.5/);
});

test("chart SVG export escapes text and keeps path geometry", () => {
  const svg = chartSeriesToSvg({ metricKey: "loss<&", series: plottedSeries, width: 240, height: 160, padding: 28, xMode: "step" });
  assert.match(svg, /<svg /);
  assert.match(svg, /loss&lt;&amp;/);
  assert.match(svg, /points="28\.00,100\.00 200\.00,50\.00"/);
  assert.match(svg, /<line x1="28" x2="212"/);
  assert.match(svg, /Run 1/);
  assert.doesNotMatch(svg, /var\(--/);
});

test("chart SVG export can align axes to rendered chart padding", () => {
  const paddedSeries = [{
    ...plottedSeries[0],
    path: "56.00,104.00 184.00,56.00",
    normalizedPoints: [
      { ...plottedSeries[0].normalizedPoints[0], x: 56, y: 104 },
      { ...plottedSeries[0].normalizedPoints[1], x: 184, y: 56 },
    ],
  }];
  const svg = chartSeriesToSvg({ metricKey: "loss", series: paddedSeries, width: 240, height: 160, padding: 56, xMode: "step" });
  assert.match(svg, /points="56\.00,104\.00 184\.00,56\.00"/);
  assert.match(svg, /<line x1="56" x2="184"/);
  assert.match(svg, /<line x1="56" x2="56" y1="56" y2="104"/);
});

test("chart SVG export avoids small-series color collisions", () => {
  const svg = chartSeriesToSvg({
    metricKey: "loss",
    series: [
      { ...plottedSeries[0], id: "baseline", name: "baseline" },
      { ...plottedSeries[0], id: "12-layer", name: "12-layer" },
      { ...plottedSeries[0], id: "bottleneck-512", name: "bottleneck-512" },
    ],
    width: 240,
    height: 160,
    padding: 28,
    xMode: "step",
  });
  const strokes = [...svg.matchAll(/<polyline[^>]+stroke="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(strokes).size, 3);
  assert.doesNotMatch(svg, /stroke-dasharray/);
});

test("export filenames are filesystem-friendly and content-disposition aware", () => {
  assert.equal(safeExportFilename("Eval/Loss final.csv"), "eval-loss-final.csv");
  assert.equal(safeExportFilename("   "), "export");
  assert.equal(filenameFromContentDisposition("attachment; filename=\"instantml-export.csv\""), "instantml-export.csv");
  assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''runs%20export.csv"), "runs export.csv");
  assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''%E0%A4%A"), "");
  assert.throws(() => chartSeriesToCsv({
    metricKey: "heavy",
    series: [{ id: "heavy", normalizedPoints: Array.from({ length: CHART_EXPORT_MAX_POINTS + 1 }, () => ({ step: 0, value: 1 })) }],
  }), /20,000 plotted points/);
});
