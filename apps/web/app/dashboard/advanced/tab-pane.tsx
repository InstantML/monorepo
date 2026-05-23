"use client";

import { DistributedTabPane } from "../distributed/tab-pane";
import { InsightsTabPane } from "../insights/tab-pane";
import type { RunSummary } from "../../dashboard-types";

type Props = {
  api: { get: (path: string, options?: Record<string, unknown>) => Promise<any> };
  metricKey: string;
  primaryRun: RunSummary | null;
  selectedRunIds: string[];
  sortedRuns: RunSummary[];
};

export function AdvancedTabPane({ api, metricKey, primaryRun, selectedRunIds, sortedRuns }: Props) {
  return (
    <div className="analysis-page advanced-page">
      <header className="analysis-header">
        <div>
          <p className="eyebrow">Advanced</p>
          <h1>Advanced Reducer View</h1>
          <span>Rank reduce graphs, grouped reducers, k-means, scatter, and parallel-coordinate analysis.</span>
        </div>
      </header>

      <div className="advanced-view-stack">
        <DistributedTabPane
          api={api}
          embedded
          primaryRun={primaryRun}
        />
        <InsightsTabPane
          embedded
          metricKey={metricKey}
          selectedRunIds={selectedRunIds}
          sortedRuns={sortedRuns}
        />
      </div>
    </div>
  );
}
