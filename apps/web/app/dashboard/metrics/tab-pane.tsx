import { X } from "lucide-react";

import { ChartControls } from "./chart-controls";
import { HoverDetail } from "./hover-detail";
import { MetricCatalog } from "./metric-catalog";
import { MetricChart } from "./metric-chart";
import { MetricLeaderboard } from "./metric-leaderboard";
import { SeriesSummary } from "./series-summary";
import { formatNumber, metricGoalLabel } from "../../../src/state.js";
import { metricTitle } from "../../dashboard-models";
import type { HoverPoint, MetricCatalogRow, MetricSeries, RunSummary } from "../../dashboard-types";

type ChartZoomRange = { min: number; max: number } | null;

type PinnedChartPanel = {
  metric: string;
  series: MetricSeries[];
  summaries: any[];
  zoomRange: ChartZoomRange;
};

type Props = {
  activeMetricCatalogRow: MetricCatalogRow | null;
  chartSummaries: any[];
  chartZoomRange: ChartZoomRange;
  groupAverage: boolean;
  groupBy: string;
  hover: HoverPoint;
  hoverMetricKey: string;
  metricCatalogRows: MetricCatalogRow[];
  metricFilter: string;
  metricFilterValid: boolean;
  metricKey: string;
  metricOptionsForControls: string[];
  onGroupAverage: (checked: boolean) => void;
  onGroupBy: (group: string) => void;
  onMetricFilter: (filter: string) => void;
  onMetricKey: (key: string) => void;
  onChartLeave: () => void;
  onPinnedMetric: (metric: string) => void;
  onPointHoverChange: (point: HoverPoint, metricKey: string) => void;
  onPinnedChartZoomRangeChange: (metric: string, range: ChartZoomRange) => void;
  onSmoothing: (value: number) => void;
  onXMode: (mode: string) => void;
  identifierMode: string;
  onIdentifierMode: (mode: string) => void;
  onZoomRangeChange: (range: ChartZoomRange) => void;
  pinnedChartPanels: PinnedChartPanel[];
  pinnedMetrics: string[];
  selectedRuns: RunSummary[];
  series: MetricSeries[];
  smoothing: number;
  sortedRuns: RunSummary[];
  visibleMetricCatalogRows: MetricCatalogRow[];
  xMode: string;
};

export function MetricsTabPane({
  activeMetricCatalogRow,
  chartSummaries,
  chartZoomRange,
  groupAverage,
  groupBy,
  hover,
  hoverMetricKey,
  metricCatalogRows,
  metricFilter,
  metricFilterValid,
  metricKey,
  metricOptionsForControls,
  onGroupAverage,
  onGroupBy,
  onMetricFilter,
  onMetricKey,
  onChartLeave,
  onPinnedMetric,
  onPointHoverChange,
  onPinnedChartZoomRangeChange,
  onSmoothing,
  onXMode,
  identifierMode,
  onIdentifierMode,
  onZoomRangeChange,
  pinnedChartPanels,
  pinnedMetrics,
  selectedRuns,
  series,
  smoothing,
  sortedRuns,
  visibleMetricCatalogRows,
  xMode,
}: Props) {
  return (
    <div className="analysis-page metrics-analysis">
      <header className="analysis-header">
        <div className="analysis-title-block">
          <span className="analysis-eyebrow eyebrow--accent">Metrics</span>
          <h2>{metricTitle(metricKey)} over time</h2>
          <p>
            {activeMetricCatalogRow
              ? `${activeMetricCatalogRow.selectedCount}/${activeMetricCatalogRow.runCount} selected runs · ${formatNumber(activeMetricCatalogRow.pointCount, 0)} points · ${metricGoalLabel(metricKey)} objective`
              : `${selectedRuns.length || sortedRuns.length} runs in scope · ${metricGoalLabel(metricKey)} objective`}
          </p>
        </div>
        <div className="analysis-stat-strip">
          <div className="analysis-stat"><span>Metrics</span><strong>{formatNumber(metricCatalogRows.length, 0)}</strong></div>
          <div className="analysis-stat"><span>Pinned charts</span><strong>{formatNumber(pinnedMetrics.length, 0)}</strong></div>
          <div className="analysis-stat"><span>Runs plotted</span><strong>{formatNumber(chartSummaries.length, 0)}</strong></div>
        </div>
      </header>
      <div className="metrics-grid metrics-workbench">
        <section className="panel analysis-card metric-catalog-panel">
          <div className="panel-head"><h2>Metric Catalog <span>({visibleMetricCatalogRows.length}/{metricCatalogRows.length})</span></h2></div>
          <div className="panel-body">
            <MetricCatalog activeMetric={metricKey} rows={visibleMetricCatalogRows} pinnedMetrics={pinnedMetrics} onMetricKey={onMetricKey} onPinnedMetric={onPinnedMetric} />
          </div>
        </section>
        <section className="chart-card analysis-card metrics-chart-surface">
          <div className="analysis-toolbar chart-analysis-toolbar">
            <ChartControls
              metricFilter={metricFilter}
              metricFilterValid={metricFilterValid}
              metricKey={metricKey}
              metricOptions={metricOptionsForControls}
              groupBy={groupBy}
              xMode={xMode}
              smoothing={smoothing}
              groupAverage={groupAverage}
              identifierMode={identifierMode}
              pinnedMetrics={pinnedMetrics}
              onMetricFilter={onMetricFilter}
              onMetricKey={onMetricKey}
              onGroupBy={onGroupBy}
              onXMode={onXMode}
              onSmoothing={onSmoothing}
              onIdentifierMode={onIdentifierMode}
              onGroupAverage={onGroupAverage}
              onPinnedMetric={onPinnedMetric}
            />
          </div>
          <MetricChart
            exportFilenameBase={`instantml-${metricKey}`}
            height={400}
            metricKey={metricKey}
            onPointHover={(point) => onPointHoverChange(point, metricKey)}
            onLeave={onChartLeave}
            onZoomRangeChange={onZoomRangeChange}
            series={series}
            xMode={xMode}
            zoomRange={chartZoomRange}
          />
          {pinnedChartPanels.length ? (
            <div className="pinned-chart-grid">
              {pinnedChartPanels.map((panel) => (
                <article className="metric-panel" key={panel.metric}>
                  <div className="metric-panel-head">
                    <h3>{metricTitle(panel.metric)}</h3>
                    <button className="icon-button" type="button" aria-label={`Unpin ${panel.metric}`} onClick={() => onPinnedMetric(panel.metric)}><X size={14} /></button>
                  </div>
                  <MetricChart
                    exportFilenameBase={`instantml-${panel.metric}`}
                    height={300}
                    metricKey={panel.metric}
                    onPointHover={(point) => onPointHoverChange(point, panel.metric)}
                    onLeave={onChartLeave}
                    onZoomRangeChange={(range) => onPinnedChartZoomRangeChange(panel.metric, range)}
                    series={panel.series}
                    xMode={xMode}
                    zoomRange={panel.zoomRange}
                  />
                </article>
              ))}
            </div>
          ) : null}
        </section>
        <section className="panel analysis-card metric-insights-panel">
          <div className="panel-head"><h2>Signal Context</h2></div>
          <div className="panel-body">
            <HoverDetail hover={hover} metricKey={hover ? hoverMetricKey : metricKey} />
            <MetricLeaderboard metricKey={metricKey} runs={selectedRuns.length ? selectedRuns : sortedRuns} />
            <SeriesSummary summaries={chartSummaries} />
          </div>
        </section>
      </div>
    </div>
  );
}
