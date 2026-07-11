import assert from "node:assert/strict";
import test from "node:test";

import { chartDomain, nearestPoint, nearestPointByX, normalizeSeries } from "../src/charts.js";

function legacyDistanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (!Number.isFinite(lengthSq) || lengthSq <= 0) return { distance: Math.hypot(x - x1, y - y1), t: 0 };
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
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
        const segmentHit = legacyDistanceToSegment(x, y, previous.x, previousY, point.x, pointY);
        consider(item, segmentHit.t <= 0.5 ? previous : point, segmentHit.distance);
      }
      previous = point;
    }
  }
  return nearest;
}

function legacyNearestPointByX(item, targetX) {
  let nearest = null;
  for (const point of item?.normalizedPoints ?? []) {
    if (!nearest || Math.abs(point.xValue - targetX) < Math.abs(nearest.xValue - targetX)) nearest = point;
  }
  return nearest;
}

test("indexed chart hover preserves the legacy point and segment result", () => {
  const series = Array.from({ length: 4 }, (_, seriesIndex) => ({
    id: `run-${seriesIndex}`,
    name: `Run ${seriesIndex}`,
    points: Array.from({ length: 80 }, (_, pointIndex) => ({
      step: pointIndex,
      value: Math.sin(pointIndex / 7 + seriesIndex) + seriesIndex / 5,
      smoothedValue: Math.sin(pointIndex / 9 + seriesIndex) + seriesIndex / 5,
    })),
    smoothed: seriesIndex % 2 === 0,
  }));
  const normalized = normalizeSeries(series, 900, 360, 28, "step", "train/loss");
  assert.equal(normalized.every((item) => item.xMonotonic === true), true);

  const queries = [
    [28, 28, 18],
    [450, 180, 18],
    [872, 332, 18],
    [445.25, 117.75, 3],
    [999, 999, 18],
    [450, 180, 0],
    [450, 180, -1],
    [450, 180, Number.NaN],
    [450, 180, Number.POSITIVE_INFINITY],
    [Number.NaN, 180, 18],
  ];
  for (const [x, y, maxDistance] of queries) {
    assert.deepEqual(
      nearestPoint(normalized, x, y, maxDistance),
      legacyNearestPoint(normalized, x, y, maxDistance),
      `indexed result drifted for x=${x}, y=${y}, maxDistance=${maxDistance}`,
    );
  }

  const longSegment = [{
    id: "long",
    name: "Long segment",
    xMonotonic: true,
    normalizedPoints: [
      { step: 0, xValue: 0, x: 0, y: 100 },
      { step: 1, xValue: 1, x: 1000, y: 100 },
    ],
  }];
  assert.deepEqual(nearestPoint(longSegment, 500, 100, 1), legacyNearestPoint(longSegment, 500, 100, 1));

  const tiedSeries = [longSegment[0], { ...longSegment[0], id: "second", name: "Second" }];
  assert.equal(nearestPoint(tiedSeries, 500, 100, 1).runId, "long", "equal-distance series keep first encounter order");
  assert.equal(nearestPoint(longSegment, 500, 100, 1).point.step, 0, "segment midpoint keeps the earlier endpoint");
});

test("indexed nearest-x lookup preserves midpoint and duplicate ordering", () => {
  const points = [
    { id: "zero", x: 0, xValue: 0 },
    { id: "ten-first", x: 10, xValue: 10 },
    { id: "ten-second", x: 10, xValue: 10 },
    { id: "twenty", x: 20, xValue: 20 },
    { id: "thirty-first", x: 30, xValue: 30 },
    { id: "thirty-second", x: 30, xValue: 30 },
  ];
  const item = { xMonotonic: true, normalizedPoints: points };
  for (const target of [-10, 0, 5, 10, 15, 29, 30, 99, Number.NaN]) {
    assert.equal(nearestPointByX(item, target), legacyNearestPointByX(item, target), `nearest-x drifted at ${target}`);
  }
  assert.equal(nearestPointByX(item, 10).id, "ten-first");
  assert.equal(nearestPointByX(item, 15).id, "ten-first");
  assert.equal(nearestPointByX(item, 99).id, "thirty-first");

  const unsorted = {
    xMonotonic: false,
    normalizedPoints: [
      { id: "first", x: 20, xValue: 20 },
      { id: "second", x: 0, xValue: 0 },
      { id: "third", x: 10, xValue: 10 },
    ],
  };
  assert.equal(nearestPointByX(unsorted, 9), legacyNearestPointByX(unsorted, 9));
  assert.equal(nearestPointByX({ xMonotonic: true, normalizedPoints: [] }, 1), null);
});

test("normalization marks non-finite or decreasing x coordinates unsafe for indexing", () => {
  const malformed = normalizeSeries([{
    id: "malformed",
    name: "Malformed",
    points: [{ step: 0, value: 1 }, { step: Number.NaN, value: 2 }, { step: 2, value: 3 }],
  }], 100, 80);
  const infinite = normalizeSeries([{
    id: "infinite",
    name: "Infinite",
    points: [{ step: 0, value: 1 }, { step: Number.POSITIVE_INFINITY, value: 2 }, { step: 2, value: 3 }],
  }], 100, 80);
  const decreasing = normalizeSeries([{
    id: "decreasing",
    name: "Decreasing",
    points: [{ step: 0, value: 1 }, { step: 2, value: 2 }, { step: 1, value: 3 }],
  }], 100, 80);
  assert.equal(malformed[0].xMonotonic, false);
  assert.equal(infinite[0].xMonotonic, false);
  assert.equal(decreasing[0].xMonotonic, false);
  assert.deepEqual(nearestPoint(decreasing, 50, 40), legacyNearestPoint(decreasing, 50, 40));
});

test("range overview domains include outliers after the five rendered preview series", () => {
  const ordinary = Array.from({ length: 5 }, (_, index) => ({
    id: `ordinary-${index}`,
    points: [
      { step: 0, value: 1, created_at: "2026-01-01T00:00:00.000Z" },
      { step: 10, value: 2, created_at: "2026-01-01T00:00:10.000Z" },
    ],
  }));
  const outlier = {
    id: "later-outlier",
    points: [
      { step: 0, value: 1, created_at: "2026-01-01T00:00:00.000Z" },
      { step: 1_000, value: 100, created_at: "2026-01-01T00:16:40.000Z" },
    ],
  };
  const allSeries = [...ordinary, outlier];
  const stepDomain = chartDomain(allSeries, "step", "train/loss");
  const slicedStepDomain = chartDomain(ordinary, "step", "train/loss");
  assert.ok(stepDomain.maxX > slicedStepDomain.maxX);
  assert.ok(stepDomain.maxY > slicedStepDomain.maxY);

  const timeDomain = chartDomain(allSeries, "time", "train/loss");
  const slicedTimeDomain = chartDomain(ordinary, "time", "train/loss");
  assert.ok(timeDomain.maxX > slicedTimeDomain.maxX);

  const logDomain = chartDomain(allSeries, "step", "train/loss", null, { scale: "log" });
  assert.equal(logDomain.yScale, "log");
  assert.ok(logDomain.maxY >= 100);

  const manualDomain = chartDomain(allSeries, "step", "train/loss", null, { range: { min: 0.5, max: 200 } });
  assert.equal(manualDomain.maxX, stepDomain.maxX);
  assert.equal(manualDomain.minY, 0.5);
  assert.equal(manualDomain.maxY, 200);
});
