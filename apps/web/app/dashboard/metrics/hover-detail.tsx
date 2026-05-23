"use client";

import { formatMetricValue } from "../../../src/charts.js";
import { formatNumber } from "../../../src/state.js";
import type { HoverPoint } from "../../dashboard-types";

export function HoverDetail({ hover, metricKey }: { hover: HoverPoint; metricKey: string }) {
  if (!hover) return <div className="empty">Hover a chart point to inspect the run at that timestamp.</div>;
  const identifier = hover.identifier ?? hover.runName;
  const smoothed = Number.isFinite(hover.point.smoothedValue) ? hover.point.smoothedValue : null;
  return (
    <div className="readout">
      <div className="readout-card">
        <span className="subtle">{identifier}</span>
        <strong>{formatMetricValue(hover.point.value)}</strong>
        {smoothed !== null ? <small>Smoothed {formatMetricValue(smoothed)}</small> : null}
        <small>{metricKey} at step {formatNumber(hover.point.step, 0)}</small>
        {identifier !== hover.runName ? <small>Run {hover.runName}</small> : null}
        <small>{hover.point.created_at ? new Date(hover.point.created_at).toLocaleString() : "No timestamp"}</small>
      </div>
    </div>
  );
}
