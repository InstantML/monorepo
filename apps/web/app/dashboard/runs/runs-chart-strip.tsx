"use client";

import type { CSSProperties } from "react";

export function RunsChartStrip({ smoothing, groupAverage, onSmoothing, onGroupAverage }: { smoothing: number; groupAverage: boolean; onSmoothing: (value: number) => void; onGroupAverage: (value: boolean) => void }) {
  return (
    <div className="runs-chart-strip">
      <label className="control smoothing-control">
        <span>Smoothing</span>
        <input aria-label="Run chart smoothing" id="runs-smoothing" type="range" min="0" max="90" step="10" value={smoothing} style={{ "--range-fill": `${(smoothing / 90) * 100}%` } as CSSProperties} onChange={(event) => onSmoothing(Number(event.target.value))} />
        <strong>{(smoothing / 100).toFixed(1)}</strong>
      </label>
      <label className="toggle-control">
        <span>Grouped avg</span>
        <input aria-label="Run chart group average" id="runs-group-average" type="checkbox" checked={groupAverage} onChange={(event) => onGroupAverage(event.target.checked)} />
      </label>
    </div>
  );
}
