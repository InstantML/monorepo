"use client";

import { formatMetricValue } from "../../../src/charts.js";
import { metricGoal, metricGoalLabel, metricGoalValue } from "../../../src/state.js";
import { compactValue } from "../../dashboard-models";
import type { RunSummary } from "../../dashboard-types";

export function MetricLeaderboard({ metricKey, runs }: { metricKey: string; runs: RunSummary[] }) {
  const goal = metricGoal(metricKey);
  const ranked = runs
    .map((run) => ({ run, aggregate: run.metric_aggregates?.[metricKey], value: metricGoalValue(run, metricKey) }))
    .filter((item) => item.aggregate)
    .sort((left, right) => goal === "minimize"
      ? (left.value ?? Number.POSITIVE_INFINITY) - (right.value ?? Number.POSITIVE_INFINITY)
      : (right.value ?? Number.NEGATIVE_INFINITY) - (left.value ?? Number.NEGATIVE_INFINITY))
    .slice(0, 6);
  if (!ranked.length) return <div className="empty compact-empty">No selected runs have {metricKey} yet.</div>;
  return (
    <div className="leaderboard-list">
      <h3 className="subsection-title">{metricGoalLabel(metricKey)} Leaderboard</h3>
      {ranked.map(({ run, aggregate, value }, index) => (
        <article className="leaderboard-row" key={run.id}>
          <span className="rank">{index + 1}</span>
          <span>
            <strong title={run.name}>{run.name}</strong>
            <small>{goal === "minimize" ? "minimum value" : `best step ${compactValue(aggregate?.best_step ?? "-")}`}</small>
          </span>
          <b>{formatMetricValue(value)}</b>
        </article>
      ))}
    </div>
  );
}
