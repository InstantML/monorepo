"use client";

import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChartControls } from "./chart-controls";
import { MetricCatalog } from "./metric-catalog";
import { MetricChart } from "./metric-chart";
import { SeriesTable, siStep } from "./series-table";
import { PageHead } from "../ui/page-head";
import { formatNumber } from "../../../src/state.js";
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
  hover: _hover,
  hoverMetricKey: _hoverMetricKey,
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
  const searchRef = useRef<HTMLInputElement | null>(null);
  const exportApiRef = useRef<{ downloadSvg: () => void; downloadCsv: () => void } | null>(null);
  const [yScale, setYScale] = useState<"linear" | "log">("linear");
  const [hiddenRunIds, setHiddenRunIds] = useState<string[]>([]);

  // Mockup parity: "/" focuses the metric search from anywhere on the page
  // (unless the user is already typing somewhere).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const visibleSeries = useMemo(
    () => (hiddenRunIds.length ? series.filter((item) => !hiddenRunIds.includes(item.id)) : series),
    [hiddenRunIds, series],
  );
  const seriesRuns = selectedRuns.length ? selectedRuns : sortedRuns;
  const windowLabel = chartZoomRange
    ? `window ${siStep(chartZoomRange.min)} – ${siStep(chartZoomRange.max)}`
    : `${series.length} series`;

  function toggleSeriesVisibility(id: string) {
    setHiddenRunIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <div className="analysis-page metrics-analysis metrics-parity">
      <PageHead
        title="Metrics"
        lede={activeMetricCatalogRow
          ? `${chartSummaries.length} runs plotted · ${formatNumber(activeMetricCatalogRow.pointCount, 0)} points`
          : `${seriesRuns.length} runs in scope`}
      />
      <div className="mx-grid">
        <section className="mx-panel mx-browser" aria-label="Metric browser">
          <div className="mx-panel-head">
            <span className="mx-mlabel">Metric browser</span>
            <span className="mx-unit">{formatNumber(metricCatalogRows.length, 0)}</span>
          </div>
          <div className="mx-search">
            <input
              aria-label="Search metrics"
              className="mx-input"
              id="metric-filter"
              onChange={(event) => onMetricFilter(event.target.value)}
              placeholder="Search  /  to focus"
              ref={searchRef}
              type="search"
              value={metricFilter}
            />
            {metricFilterValid ? null : <small className="mx-hint">Invalid regex — matching as plain text.</small>}
          </div>
          <MetricCatalog
            activeMetric={metricKey}
            onMetricKey={onMetricKey}
            onPinnedMetric={onPinnedMetric}
            pinnedMetrics={pinnedMetrics}
            rows={visibleMetricCatalogRows}
          />
        </section>
        <div className="mx-main">
          <section className="mx-panel mx-chart-panel" aria-label="Metric chart">
            <div className="mx-panel-head">
              <span className="mx-mlabel mx-chart-title">{metricKey || "metric"} · {chartSummaries.length} {chartSummaries.length === 1 ? "run" : "runs"}</span>
              <div className="mx-smooth">
                <span className="mx-mlabel-tight">Smooth</span>
                <input
                  aria-label="Smoothing"
                  id="smoothing"
                  max={90}
                  min={0}
                  onChange={(event) => onSmoothing(Number(event.currentTarget.value))}
                  onInput={(event) => onSmoothing(Number(event.currentTarget.value))}
                  step={10}
                  type="range"
                  value={smoothing}
                />
                <span className="mx-smooth-val">{smoothing ? `.${smoothing}` : "0"}</span>
              </div>
              <div className="mx-seg" role="group" aria-label="X axis">
                <button aria-pressed={xMode !== "time"} className={xMode !== "time" ? "is-active" : ""} id="x-mode-step" onClick={() => onXMode("step")} type="button">Step</button>
                <button aria-pressed={xMode === "time"} className={xMode === "time" ? "is-active" : ""} id="x-mode-time" onClick={() => onXMode("time")} type="button">Time</button>
              </div>
              <div className="mx-seg" role="group" aria-label="Y scale">
                <button aria-pressed={yScale === "linear"} className={yScale === "linear" ? "is-active" : ""} id="y-scale-lin" onClick={() => setYScale("linear")} type="button">Lin</button>
                <button aria-pressed={yScale === "log"} className={yScale === "log" ? "is-active" : ""} id="y-scale-log" onClick={() => setYScale("log")} type="button">Log</button>
              </div>
              <button
                aria-label={`Download ${metricKey} chart image as SVG`}
                className="mx-ghost-btn"
                disabled={!visibleSeries.length}
                onClick={() => exportApiRef.current?.downloadSvg()}
                type="button"
              >
                ⤓ SVG
              </button>
            </div>
            <div className="mx-chart-body">
              <MetricChart
                exportApiRef={exportApiRef}
                exportFilenameBase={`instantml-${metricKey}`}
                height={320}
                metricKey={metricKey}
                onPointHover={(point) => onPointHoverChange(point, metricKey)}
                onLeave={onChartLeave}
                onZoomRangeChange={onZoomRangeChange}
                series={visibleSeries}
                showExportActions={false}
                showYAxisControls={false}
                xMode={xMode}
                yScale={yScale}
                zoomRange={chartZoomRange}
              />
            </div>
            <ChartControls
              metricKey={metricKey}
              metricOptions={metricOptionsForControls}
              groupBy={groupBy}
              groupAverage={groupAverage}
              identifierMode={identifierMode}
              pinnedMetrics={pinnedMetrics}
              onMetricKey={onMetricKey}
              onGroupBy={onGroupBy}
              onIdentifierMode={onIdentifierMode}
              onGroupAverage={onGroupAverage}
              onPinnedMetric={onPinnedMetric}
            />
          </section>
          {pinnedChartPanels.length ? (
            <div className="mx-pinned-grid">
              {pinnedChartPanels.map((panel) => (
                <section className="mx-panel mx-pinned-panel" key={panel.metric} aria-label={`Pinned chart ${panel.metric}`}>
                  <div className="mx-panel-head">
                    <span className="mx-mlabel">{panel.metric}</span>
                    <button className="icon-button mx-unpin" type="button" aria-label={`Unpin ${panel.metric}`} onClick={() => onPinnedMetric(panel.metric)}><X size={13} /></button>
                  </div>
                  <div className="mx-chart-body">
                    <MetricChart
                      exportFilenameBase={`instantml-${panel.metric}`}
                      height={260}
                      metricKey={panel.metric}
                      onPointHover={(point) => onPointHoverChange(point, panel.metric)}
                      onLeave={onChartLeave}
                      onZoomRangeChange={(range) => onPinnedChartZoomRangeChange(panel.metric, range)}
                      series={panel.series}
                      xMode={xMode}
                      zoomRange={panel.zoomRange}
                    />
                  </div>
                </section>
              ))}
            </div>
          ) : null}
          <section className="mx-panel mx-series-panel" aria-label="Series">
            <div className="mx-panel-head">
              <span className="mx-mlabel">Series</span>
              <span className="mx-unit">{windowLabel}</span>
            </div>
            <div className="mx-series-scroll">
              <SeriesTable
                hiddenIds={hiddenRunIds}
                metricKey={metricKey}
                onToggleVisibility={toggleSeriesVisibility}
                runs={seriesRuns}
                series={series}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
