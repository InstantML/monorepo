import type { MouseEvent, ReactNode } from "react";

import { RunWorkspace, type RunWorkspaceTabId } from "../components/run-workspace";
import type { Artifact, HoverPoint, LoggedObject, LoggedObjectRow, MetricSeries, RunMetricRow, RunSummary, RunTimelineRow } from "../../dashboard-types";

type ChartZoomRange = { min: number; max: number } | null;
type ApiLike = {
  get(path: string, options?: { signal?: AbortSignal }): Promise<any>;
  post(path: string, body?: any, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<any>;
};

type Props = {
  api: ApiLike;
  dataControls: ReactNode;
  hover: HoverPoint;
  loggedObjects: LoggedObject[];
  objectRowsById: Record<number, LoggedObjectRow[]>;
  onChartLeave: () => void;
  onChartMove: (event: MouseEvent<SVGSVGElement>) => void;
  onChartPointHover: (point: HoverPoint) => void;
  onChartZoomRangeChange: (range: ChartZoomRange) => void;
  onForkCheckpoint?: (artifact: Artifact, options: { inheritConfig: boolean; name: string; reason: string }) => Promise<void>;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  onWorkspaceTabChange: (tab: RunWorkspaceTabId) => void;
  primaryDomain: any;
  primaryFullDomain: any;
  primaryNormalizedSeries: MetricSeries[];
  primaryRangeSeries: MetricSeries[];
  primaryChartZoomRange: ChartZoomRange;
  run: RunSummary | null;
  runMetricRows: RunMetricRow[];
  runTimelineRows: RunTimelineRow[];
  runWorkspaceTab: RunWorkspaceTabId;
  selectedRuns: RunSummary[];
  visibleArtifacts: Artifact[];
  xMode: string;
};

export function DetailTabPane({
  api,
  dataControls,
  hover,
  loggedObjects,
  objectRowsById,
  onChartLeave,
  onChartMove,
  onChartPointHover,
  onChartZoomRangeChange,
  onForkCheckpoint,
  onRunMetadataSave,
  onWorkspaceTabChange,
  primaryDomain,
  primaryFullDomain,
  primaryNormalizedSeries,
  primaryRangeSeries,
  primaryChartZoomRange,
  run,
  runMetricRows,
  runTimelineRows,
  runWorkspaceTab,
  selectedRuns,
  visibleArtifacts,
  xMode,
}: Props) {
  return (
    <div className="analysis-page detail-analysis">
      <RunWorkspace
        activeMetricKey=""
        api={api}
        artifacts={visibleArtifacts}
        chartDomain={primaryDomain}
        chartFullDomain={primaryFullDomain}
        chartHover={hover}
        chartNormalizedSeries={primaryNormalizedSeries}
        chartRangeSeries={primaryRangeSeries}
        chartZoomRange={primaryChartZoomRange}
        dataControls={dataControls}
        elementId="run-detail"
        hover={hover}
        loggedObjects={loggedObjects}
        metricRows={runMetricRows}
        objectRowsById={objectRowsById}
        onChartLeave={onChartLeave}
        onChartMove={onChartMove}
        onChartPointHover={onChartPointHover}
        onChartZoomRangeChange={onChartZoomRangeChange}
        onForkCheckpoint={onForkCheckpoint}
        onRunMetadataSave={onRunMetadataSave}
        onWorkspaceTabChange={onWorkspaceTabChange}
        run={run}
        selectedCount={selectedRuns.length}
        selectedRuns={selectedRuns}
        tab={runWorkspaceTab}
        timelineRows={runTimelineRows}
        xMode={xMode}
      />
    </div>
  );
}
