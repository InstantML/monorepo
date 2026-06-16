import assert from "node:assert/strict";
import test from "node:test";

import {
  CHART_PALETTE,
  chartCanvasDashArray,
  chartColor,
  chartLineStyleClass,
  chartSvgDashAttr,
  chartStyleIndexesForItems,
  stableChartIndex,
} from "../src/chart-colors.js";

test("chart colors cycle through the shared dashboard palette", () => {
  assert.equal(CHART_PALETTE.length, 12);
  assert.equal(chartColor(0), CHART_PALETTE[0]);
  assert.equal(chartColor(CHART_PALETTE.length), CHART_PALETTE[0]);
  assert.equal(chartColor(-1), CHART_PALETTE[1]);
  assert.equal(chartColor(Number.NaN), CHART_PALETTE[0]);
});

test("chart palette keeps thin strokes legible on light and dark chart surfaces", () => {
  for (const color of CHART_PALETTE) {
    assert.ok(
      contrastRatio(color, "#ffffff") >= 3,
      `${color} must meet non-text contrast against white chart surfaces`,
    );
    assert.ok(
      contrastRatio(color, "#0e1116") >= 3,
      `${color} must meet non-text contrast against dark chart surfaces`,
    );
  }
});

test("stable chart indexes stay deterministic and bounded", () => {
  const first = stableChartIndex("run-baseline", 4);
  const second = stableChartIndex("run-baseline", 9);
  assert.equal(first, second);
  assert.ok(first >= 0);
  assert.ok(first < CHART_PALETTE.length * 4);
  assert.equal(stableChartIndex("", CHART_PALETTE.length * 2 + 3), CHART_PALETTE.length * 2 + 3);
});

test("chart style indexes avoid visible collisions before the palette is exhausted", () => {
  const names = ["baseline", "12-layer", "bottleneck-512"];
  const styleIndexes = chartStyleIndexesForItems(names.map((name) => ({ id: name })));
  assert.equal(new Set(styleIndexes.map((index) => chartColor(index))).size, names.length);
});

test("chart style indexes keep twelve visible series distinguishable", () => {
  const styleIndexes = chartStyleIndexesForItems(Array.from({ length: 12 }, (_, index) => ({ id: `run-${index}` })));
  assert.equal(new Set(styleIndexes.map((index) => chartColor(index))).size, 12);
  assert.equal(new Set(styleIndexes.map((index) => chartLineStyleClass(index))).size, 1);
});

test("chart style indexes use dash cycles after the palette is exhausted", () => {
  const styleIndexes = chartStyleIndexesForItems(Array.from({ length: CHART_PALETTE.length + 1 }, () => ({})), () => "");
  assert.equal(new Set(styleIndexes).size, CHART_PALETTE.length + 1);
  assert.ok(styleIndexes.some((index) => chartLineStyleClass(index) !== "line-style-0"));
});

test("line style helpers expose matching css, canvas, and svg dash patterns", () => {
  assert.equal(chartLineStyleClass(0), "line-style-0");
  assert.equal(chartLineStyleClass(CHART_PALETTE.length), "line-style-1");
  assert.equal(chartLineStyleClass(CHART_PALETTE.length * 2), "line-style-2");
  assert.equal(chartLineStyleClass(CHART_PALETTE.length * 3), "line-style-3");
  assert.equal(chartLineStyleClass(CHART_PALETTE.length * 4), "line-style-0");

  assert.deepEqual(chartCanvasDashArray(0), []);
  assert.deepEqual(chartCanvasDashArray(CHART_PALETTE.length), [6, 4]);
  assert.deepEqual(chartCanvasDashArray(CHART_PALETTE.length * 2), [2, 4]);
  assert.deepEqual(chartCanvasDashArray(CHART_PALETTE.length * 3), [9, 3, 2, 3]);

  assert.equal(chartSvgDashAttr(0), "");
  assert.equal(chartSvgDashAttr(CHART_PALETTE.length), ' stroke-dasharray="6 4"');
});

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex) {
  const [r, g, b] = hex
    .replace("#", "")
    .match(/.{2}/g)
    .map((part) => parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
