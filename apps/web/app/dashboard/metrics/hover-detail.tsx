"use client";

import { formatNumber } from "../../../src/state.js";
import type { HoverPoint } from "../../dashboard-types";

export function HoverDetail({ hover, metricKey }: { hover: HoverPoint; metricKey: string }) {
  if (!hover) return <div className="empty">Hover a chart point to inspect the run at that timestamp.</div>;
  return (
    <div className="readout">
      <div className="readout-card">
        <span className="subtle">{hover.runName}</span>
        <strong>{formatNumber(hover.point.value, 4)}</strong>
        <small>{metricKey} at step {hover.point.step}</small>
        <small>{hover.point.created_at ? new Date(hover.point.created_at).toLocaleString() : "No timestamp"}</small>
      </div>
    </div>
  );
}
