"use client";

import { DistributedTabPane } from "../distributed/tab-pane";
import { InsightsTabPane } from "../insights/tab-pane";
import { formatNumber } from "../../../src/state.js";
import type { RunSummary } from "../../dashboard-types";

type Props = {
  api: { get: (path: string, options?: Record<string, unknown>) => Promise<any> };
  metricKey: string;
  primaryRun: RunSummary | null;
  selectedRunIds: string[];
  sortedRuns: RunSummary[];
};

export function AdvancedTabPane({ api, metricKey, primaryRun, selectedRunIds, sortedRuns }: Props) {
  const scopeCount = selectedRunIds.length || sortedRuns.length;
  return (
    <div className="analysis-page advanced-page">
      <header className="analysis-header">
        <div className="analysis-title-block">
          <span className="analysis-eyebrow eyebrow--accent">Advanced</span>
          <h2>Distributed reducers <span className="serif-em">&amp; research insights</span></h2>
          <p>
            {primaryRun ? `${primaryRun.name} · ` : ""}
            {formatNumber(scopeCount, 0)} runs in scope
          </p>
        </div>
      </header>

      <div className="advanced-view-stack">
        <DistributedTabPane api={api} embedded primaryRun={primaryRun} />
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
