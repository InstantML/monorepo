import type { MouseEvent } from "react";
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
  normalizedSeries: MetricSeries[];
  domain: any;
  fullDomain: any;
  rangeSeries: MetricSeries[];
  summaries: any[];
  zoomRange: ChartZoomRange;
};

type Props = {
  activeMetricCatalogRow: MetricCatalogRow | null;
  chartSummaries: any[];
  chartZoomRange: ChartZoomRange;
  domain: any;
  fullDomain: any;
  groupAverage: boolean;
  groupBy: string;
  hover: HoverPoint;
  hoverMetricKey: string;
  metricCatalogRows: MetricCatalogRow[];
  metricFilter: string;
  metricFilterValid: boolean;
  metricKey: string;
  metricOptionsForControls: string[];
  normalizedSeries: MetricSeries[];
  onGroupAverage: (checked: boolean) => void;
  onGroupBy: (group: string) => void;
  onMetricFilter: (filter: string) => void;
  onMetricKey: (key: string) => void;
  onChartLeave: () => void;
  onChartMove: (event: MouseEvent<SVGSVGElement>) => void;
  onChartMoveFor: (event: MouseEvent<SVGSVGElement>, chartSeries: MetricSeries[], chartMetricKey: string) => void;
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
  rangeSeries: MetricSeries[];
  selectedRuns: RunSummary[];
  smoothing: number;
  sortedRuns: RunSummary[];
  visibleMetricCatalogRows: MetricCatalogRow[];
  xMode: string;
};

export function MetricsTabPane({
  activeMetricCatalogRow,
  chartSummaries,
  chartZoomRange,
  domain,
  fullDomain,
  groupAverage,
  groupBy,
  hover,
  hoverMetricKey,
  metricCatalogRows,
  metricFilter,
  metricFilterValid,
  metricKey,
  metricOptionsForControls,
  normalizedSeries,
  onGroupAverage,
  onGroupBy,
  onMetricFilter,
  onMetricKey,
  onChartLeave,
  onChartMove,
  onChartMoveFor,
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
  rangeSeries,
  selectedRuns,
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
          <h2>{metricTitle(metricKey)} <span className="serif-em">over time</span></h2>
          <p>
            {activeMetricCatalogRow
              ? `${activeMetricCatalogRow.selectedCount}/${activeMetricCatalogRow.runCount} selected runs · ${formatNumber(activeMetricCatalogRow.pointCount, 0)} points · ${metricGoalLabel(metricKey)} objective`
              : `${selectedRuns.length || sortedRuns.length} runs in scope · ${metricGoalLabel(metricKey)} objective`}
          </p>
        </div>
        <div className="analysis-stat-strip">
          <div className="analysis-stat"><span>Available</span><strong>{formatNumber(metricCatalogRows.length, 0)}</strong></div>
          <div className="analysis-stat"><span>Pinned</span><strong>{formatNumber(pinnedMetrics.length, 0)}</strong></div>
          <div className="analysis-stat"><span>Series</span><strong>{formatNumber(chartSummaries.length, 0)}</strong></div>
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
            domain={domain}
            exportFilenameBase={`instantml-${metricKey}`}
            fullDomain={fullDomain}
            hover={hover}
            metricKey={metricKey}
            normalizedSeries={normalizedSeries}
            onMove={onChartMove}
            onPointHover={(point) => onPointHoverChange(point, metricKey)}
            onLeave={onChartLeave}
            onZoomRangeChange={onZoomRangeChange}
            rangeSeries={rangeSeries}
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
                    domain={panel.domain}
                    exportFilenameBase={`instantml-${panel.metric}`}
                    fullDomain={panel.fullDomain}
                    hover={hover}
                    metricKey={panel.metric}
                    normalizedSeries={panel.normalizedSeries}
                    onMove={(event) => onChartMoveFor(event, panel.normalizedSeries, panel.metric)}
                    onPointHover={(point) => onPointHoverChange(point, panel.metric)}
                    onLeave={onChartLeave}
                    onZoomRangeChange={(range) => onPinnedChartZoomRangeChange(panel.metric, range)}
                    rangeSeries={panel.rangeSeries}
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
