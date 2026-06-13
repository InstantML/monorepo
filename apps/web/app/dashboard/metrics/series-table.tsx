"use client";

import { useMemo } from "react";

import { formatMetricValue } from "../../../src/charts.js";
import { chartColor, chartStyleIndexesForItems } from "../../../src/chart-colors.js";
import { metricGoal } from "../../../src/state.js";
import type { MetricSeries, RunSummary } from "../../dashboard-types";

export function siStep(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1).replace(/\.0$/, "")}b`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}m`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

type SeriesRow = {
  id: string;
  name: string;
  colorIndex: number;
  live: boolean;
  last: number | null;
  min: number | null;
  max: number | null;
  bestStep: number | null;
  points: number;
  hidden: boolean;
};

/**
 * SERIES legend table (mockup parity: dtable). One row per plotted series with
 * raw-value stats; doubles as the chart legend (color tick) and visibility
 * control (eye toggle). The best value in the goal column goes signal green.
 */
export function SeriesTable({
  hiddenIds,
  metricKey,
  onToggleVisibility,
  runs,
  series,
}: {
  hiddenIds: string[];
  metricKey: string;
  onToggleVisibility: (id: string) => void;
  runs: RunSummary[];
  series: MetricSeries[];
}) {
  const goal = metricGoal(metricKey);
  const rows = useMemo<SeriesRow[]>(() => {
    const styleIndexes = chartStyleIndexesForItems(series);
    const statusById = new Map(runs.map((run) => [run.id, run.status]));
    return series.map((item, index) => {
      let min: number | null = null;
      let max: number | null = null;
      let bestStep: number | null = null;
      for (const point of item.points) {
        if (!Number.isFinite(point.value)) continue;
        if (min === null || point.value < min) min = point.value;
        if (max === null || point.value > max) {
          max = point.value;
        }
      }
      const bestValue = goal === "minimize" ? min : max;
      if (bestValue !== null) {
        const bestPoint = item.points.find((point) => point.value === bestValue);
        bestStep = bestPoint ? bestPoint.step : null;
      }
      const last = item.points.length ? item.points[item.points.length - 1].value : null;
      return {
        id: item.id,
        name: item.identifier ?? item.name,
        colorIndex: styleIndexes[index] ?? index,
        live: statusById.get(item.id) === "running",
        last,
        min,
        max,
        bestStep,
        points: item.points.length,
        hidden: hiddenIds.includes(item.id),
      };
    });
  }, [goal, hiddenIds, runs, series]);

  if (!rows.length) {
    return <div className="mx-empty">No runs have logged {metricKey || "this metric"} yet.</div>;
  }

  const bestOverall = goal === "minimize"
    ? rows.reduce<number | null>((acc, row) => (row.min === null ? acc : acc === null ? row.min : Math.min(acc, row.min)), null)
    : rows.reduce<number | null>((acc, row) => (row.max === null ? acc : acc === null ? row.max : Math.max(acc, row.max)), null);

  return (
    <table className="mx-table" aria-label={`Series for ${metricKey}`}>
      <thead>
        <tr>
          <th className="mx-th-tick" aria-label="Series color" />
          <th>Run</th>
          <th className="mx-th-num">Last</th>
          <th className="mx-th-num">Min</th>
          <th className="mx-th-num">Max</th>
          <th className="mx-th-num">Best @ step</th>
          <th className="mx-th-num">Points</th>
          <th className="mx-th-eye" aria-label="Visibility" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isBest = goal === "minimize"
            ? bestOverall !== null && row.min === bestOverall
            : bestOverall !== null && row.max === bestOverall;
          return (
            <tr className={row.hidden ? "is-hidden" : undefined} key={row.id}>
              <td><i className="mx-tick" style={{ background: chartColor(row.colorIndex) }} /></td>
              <td className="mx-td-name">
                {row.name}
                {row.live ? <span className="mx-chip-live">live</span> : null}
              </td>
              <td className="mx-td-num mx-td-last">{formatMetricValue(row.last)}</td>
              <td className={`mx-td-num${goal === "minimize" && isBest ? " is-best" : ""}`}>{formatMetricValue(row.min)}</td>
              <td className={`mx-td-num${goal !== "minimize" && isBest ? " is-best" : ""}`}>{formatMetricValue(row.max)}</td>
              <td className="mx-td-num">{siStep(row.bestStep)}</td>
              <td className="mx-td-num mx-td-dim">{row.points}</td>
              <td className="mx-td-eye">
                <button
                  aria-label={`${row.hidden ? "Show" : "Hide"} ${row.name}`}
                  aria-pressed={!row.hidden}
                  className={`mx-eye${row.hidden ? " is-off" : ""}`}
                  onClick={() => onToggleVisibility(row.id)}
                  type="button"
                >
                  {row.hidden ? "◌" : "◉"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
