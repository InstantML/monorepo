"use client";

import { Star } from "lucide-react";

import { formatNumber } from "../../../src/state.js";
import type { MetricCatalogRow } from "../../dashboard-types";

export function MetricCatalog({
  activeMetric,
  onMetricKey,
  onPinnedMetric,
  pinnedMetrics,
  rows,
}: {
  activeMetric: string;
  onMetricKey: (metric: string) => void;
  onPinnedMetric: (metric: string) => void;
  pinnedMetrics: string[];
  rows: MetricCatalogRow[];
}) {
  if (!rows.length) return <div className="empty">No metrics are available for the current run filters.</div>;
  return (
    <div className="metric-catalog">
      {rows.map((row) => {
        const pinned = pinnedMetrics.includes(row.key);
        const active = row.key === activeMetric;
        return (
          <article className={`metric-catalog-row ${active ? "active" : ""}`} key={row.key}>
            <button className="metric-catalog-main" onClick={() => onMetricKey(row.key)} type="button">
              <span>
                <strong>{row.label}</strong>
                <small>{row.namespace} · {row.selectedCount}/{row.runCount} selected · {formatNumber(row.pointCount, 0)} pts</small>
              </span>
              <b>{formatNumber(row.best, 3)}</b>
            </button>
            <button
              aria-label={pinned ? `Unpin ${row.key}` : `Pin ${row.key}`}
              aria-pressed={pinned}
              className={`icon-button metric-pin ${pinned ? "active" : ""}`}
              onClick={() => onPinnedMetric(row.key)}
              title={pinned ? "Pinned metric" : "Pin metric"}
              type="button"
            >
              <Star size={13} />
            </button>
          </article>
        );
      })}
    </div>
  );
}
