"use client";

import { formatNumber } from "../../../src/state.js";
import { shortMetricName } from "../../dashboard-models";
import type { DatasetRow } from "../../dashboard-types";

export function DatasetTable({ rows, metricKey }: { rows: DatasetRow[]; metricKey: string }) {
  if (!rows.length) return <div className="empty">No dataset or environment metadata found in the current run configs.</div>;
  return (
    <div className="compact-table">
      <div className="compact-row compact-head">
        <span>Dataset</span>
        <span>Runs</span>
        <span>Seeds</span>
        <span>{shortMetricName(metricKey)}</span>
      </div>
      {rows.map((row) => (
        <div className="compact-row" key={row.name}>
          <strong>{row.name}</strong>
          <span>{row.runs}</span>
          <span>{row.seeds.join(", ") || "-"}</span>
          <span>{formatNumber(row.best, 2)}</span>
        </div>
      ))}
    </div>
  );
}
