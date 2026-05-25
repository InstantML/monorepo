"use client";

import { formatMetricValue } from "../../../src/charts.js";
import { formatNumber, metricGoalLabel } from "../../../src/state.js";
import { metricTitle } from "../../dashboard-models";
import type { Overview } from "../../dashboard-types";

export function Stats({ overview, metricKey }: { overview: Overview; metricKey: string }) {
  const stats = [
    ["Total runs", formatNumber(overview.total_runs, 0)],
    ["Active", formatNumber(overview.active_runs, 0)],
    ["Failed", formatNumber(overview.failed_runs, 0)],
    [`${metricGoalLabel(metricKey)} ${metricTitle(metricKey)}`, formatMetricValue(overview.best_eval_return)],
    ["Metric points", formatNumber(overview.metric_points, 0)],
  ];
  return (
    <section className="stat-grid" aria-label="Overview">
      {stats.map(([label, value]) => (
        <div className="stat" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}
