"use client";

import { useCallback, useMemo, useState } from "react";

import { DistributedTabPane } from "../distributed/tab-pane";
import { InsightsTabPane } from "../insights/tab-pane";
import { insightsRunUniverse, kMeansClusters } from "../../../src/research-insights.js";
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
  const [distMeta, setDistMeta] = useState({ worldSize: 0, rankKeys: 0 });
  const handleMeta = useCallback((meta: { worldSize: number; rankKeys: number }) => setDistMeta(meta), []);

  const universe = useMemo(() => insightsRunUniverse(selectedRunIds, sortedRuns), [selectedRunIds, sortedRuns]);
  const clusters = useMemo(() => kMeansClusters(universe.runs, metricKey), [universe.runs, metricKey]);
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
        <div className="analysis-stat-strip">
          <div className="analysis-stat"><span>World size</span><strong>{distMeta.worldSize ? formatNumber(distMeta.worldSize, 0) : "—"}</strong></div>
          <div className="analysis-stat"><span>Rank keys</span><strong>{distMeta.rankKeys ? formatNumber(distMeta.rankKeys, 0) : "—"}</strong></div>
          <div className="analysis-stat"><span>Runs</span><strong>{formatNumber(scopeCount, 0)}</strong></div>
          <div className="analysis-stat"><span>Clusters</span><strong>{clusters.clusters.length ? formatNumber(clusters.clusters.length, 0) : "—"}</strong></div>
        </div>
      </header>

      <div className="advanced-view-stack">
        <DistributedTabPane api={api} embedded primaryRun={primaryRun} onMeta={handleMeta} />
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
