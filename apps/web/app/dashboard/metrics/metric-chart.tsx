"use client";

import { FileText, ImageDown, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { axisTicks, formatAxisTick, formatAxisValue, formatMetricValue, svgPointFromClient } from "../../../src/charts.js";
import { chartExportBlockedReason, chartSeriesToCsv, chartSeriesToSvg, downloadTextFile, safeExportFilename } from "../../../src/chart-export.js";
import { shouldUseDenseChart } from "../../../src/dashboard-panels.js";
import { formatNumber } from "../../../src/state.js";
import { chartHeight, chartPadding, chartWidth, metricTitle } from "../../dashboard-models";
import type { HoverPoint } from "../../dashboard-types";

type ChartZoomRange = { min: number; max: number } | null;

const chartPalette = [
  "#dc5b55",
  "#5d89dd",
  "var(--accent)",
  "var(--warm)",
  "#8b7cf6",
  "#2ec4b6",
  "#e45f8c",
  "#7bc96f",
  "#14b8a6",
  "#f4a261",
  "#9ca3af",
  "#cbd5e1",
];

function chartColor(index: number) {
  return chartPalette[index % chartPalette.length];
}

function sanitizeRange(range: ChartZoomRange | undefined, domain: any): ChartZoomRange {
  if (!range || !domain) return null;
  const min = Math.max(domain.minX, Math.min(Number(range.min), Number(range.max)));
  const max = Math.min(domain.maxX, Math.max(Number(range.min), Number(range.max)));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

const TOOLTIP_ROW_LIMIT = 8;

function tooltipRows(normalizedSeries: any[], xValue: number, xMode: string, activeRunId?: string) {
  const rows = normalizedSeries.map((item, index) => {
    const points = item.normalizedPoints ?? [];
    const nearest = points.reduce((best: any, point: any) => {
      if (!best) return point;
      return Math.abs(point.xValue - xValue) < Math.abs(best.xValue - xValue) ? point : best;
    }, null);
    return {
      id: item.id,
      index,
      active: item.id === activeRunId,
      name: item.identifier ?? item.name,
      value: nearest?.value ?? null,
      smoothedValue: item.smoothed && Number.isFinite(nearest?.smoothedValue) ? nearest.smoothedValue : null,
      label: xMode === "time" ? formatAxisValue(nearest?.xValue, xMode) : `Step ${formatNumber(nearest?.step, 0)}`,
    };
  });
  // Rank by value at the hovered x (descending) like wandb/neptune, but keep the
  // actively-hovered run pinned to the top so it stays easy to read.
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const av = a.value ?? Number.NEGATIVE_INFINITY;
    const bv = b.value ?? Number.NEGATIVE_INFINITY;
    return bv - av;
  });
  return rows.slice(0, TOOLTIP_ROW_LIMIT);
}

function MiniRange({
  domain,
  normalizedSeries,
  onZoomRangeChange,
  width,
  xMode,
  zoomRange,
}: {
  domain: any;
  normalizedSeries: any[];
  onZoomRangeChange?: (range: ChartZoomRange) => void;
  width: number;
  xMode: string;
  zoomRange?: ChartZoomRange;
}) {
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  const [draftRange, setDraftRange] = useState<ChartZoomRange>(null);
  const miniWidth = width;
  const miniHeight = 46;
  const padX = 12;
  const padY = 8;
  const xSpan = (domain.maxX - domain.minX) || 1;
  const ySpan = (domain.maxY - domain.minY) || 1;
  const miniX = (value: number) => padX + ((value - domain.minX) / xSpan) * (miniWidth - padX * 2);
  const miniY = (value: number) => miniHeight - padY - ((value - domain.minY) / ySpan) * (miniHeight - padY * 2);
  const activeRange = sanitizeRange(draftRange ?? zoomRange, domain);
  const activeMinX = activeRange ? miniX(activeRange.min) : 0;
  const activeMaxX = activeRange ? miniX(activeRange.max) : 0;

  function valueFromClient(target: SVGSVGElement, clientX: number, clientY: number) {
    const rect = target.getBoundingClientRect();
    const point = svgPointFromClient(rect, clientX, clientY, miniWidth, miniHeight);
    const plotX = Math.max(padX, Math.min(miniWidth - padX, point.x));
    const ratio = (plotX - padX) / Math.max(1, miniWidth - padX * 2);
    return domain.minX + ratio * (domain.maxX - domain.minX);
  }

  function valueFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    return valueFromClient(event.currentTarget, event.clientX, event.clientY);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!onZoomRangeChange) return;
    event.preventDefault();
    const value = valueFromPointer(event);
    setDragAnchor(value);
    setDraftRange({ min: value, max: value });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events in browser tests may not have an active pointer capture target.
    }
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragAnchor === null) return;
    setDraftRange({ min: dragAnchor, max: valueFromPointer(event) });
  }

  function finishPointerRange(event: ReactPointerEvent<SVGSVGElement>) {
    if (!onZoomRangeChange || dragAnchor === null) return;
    const next = sanitizeRange({ min: dragAnchor, max: valueFromPointer(event) }, domain);
    setDragAnchor(null);
    setDraftRange(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!next || (next.max - next.min) < Math.max(Number.EPSILON, (domain.maxX - domain.minX) * 0.03)) {
      onZoomRangeChange(null);
      return;
    }
    onZoomRangeChange(next);
  }

  function handleMouseDown(event: MouseEvent<SVGSVGElement>) {
    if (!onZoomRangeChange) return;
    event.preventDefault();
    const value = valueFromClient(event.currentTarget, event.clientX, event.clientY);
    setDragAnchor(value);
    setDraftRange({ min: value, max: value });
  }

  function handleMouseMove(event: MouseEvent<SVGSVGElement>) {
    if (dragAnchor === null) return;
    setDraftRange({ min: dragAnchor, max: valueFromClient(event.currentTarget, event.clientX, event.clientY) });
  }

  function finishMouseRange(event: MouseEvent<SVGSVGElement>) {
    if (!onZoomRangeChange || dragAnchor === null) return;
    const next = sanitizeRange({ min: dragAnchor, max: valueFromClient(event.currentTarget, event.clientX, event.clientY) }, domain);
    setDragAnchor(null);
    setDraftRange(null);
    if (!next || (next.max - next.min) < Math.max(Number.EPSILON, (domain.maxX - domain.minX) * 0.03)) {
      onZoomRangeChange(null);
      return;
    }
    onZoomRangeChange(next);
  }

  return (
    <div className="chart-range" aria-label={`${xMode === "time" ? "Time" : "Step"} range overview`}>
      <svg
        viewBox={`0 0 ${miniWidth} ${miniHeight}`}
        aria-label={`Drag to zoom ${xMode === "time" ? "time" : "step"} range`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={finishMouseRange}
        onPointerCancel={finishPointerRange}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerRange}
        role="img"
      >
        {normalizedSeries.slice(0, 5).map((item, index) => (
          <polyline
            className={`range-series series-${index % 5}`}
            key={item.id}
            points={(item.normalizedPoints ?? []).map((point: any) => `${miniX(point.xValue).toFixed(2)},${miniY(point.value).toFixed(2)}`).join(" ")}
          />
        ))}
        {activeRange ? (
          <>
            <rect className="range-window" x={activeMinX} y={3} width={Math.max(2, activeMaxX - activeMinX)} height={miniHeight - 6} />
            <line className="range-handle" x1={activeMinX} x2={activeMinX} y1={3} y2={miniHeight - 3} />
            <line className="range-handle" x1={activeMaxX} x2={activeMaxX} y1={3} y2={miniHeight - 3} />
          </>
        ) : null}
      </svg>
    </div>
  );
}

export function MetricChart({
  domain,
  emptyMessage = "Select one or more runs and a metric to draw the chart.",
  exportFilenameBase,
  fullDomain,
  height = chartHeight,
  hover,
  metricKey,
  normalizedSeries,
  onMove,
  onPointHover,
  onLeave,
  onZoomRangeChange,
  padding = chartPadding,
  rangeSeries,
  showRange = true,
  width = chartWidth,
  xMode,
  zoomRange = null,
}: {
  domain: any;
  emptyMessage?: string;
  exportFilenameBase?: string;
  fullDomain?: any;
  height?: number;
  hover: HoverPoint;
  metricKey: string;
  normalizedSeries: any[];
  onMove: (event: MouseEvent<SVGSVGElement>) => void;
  onPointHover: (point: HoverPoint) => void;
  onLeave: () => void;
  onZoomRangeChange?: (range: ChartZoomRange) => void;
  padding?: number;
  rangeSeries?: any[];
  showRange?: boolean;
  width?: number;
  xMode: string;
  zoomRange?: ChartZoomRange;
}) {
  const denseChart = shouldUseDenseChart(normalizedSeries);
  const visibleHover = hover;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!denseChart) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    const baseAlpha = normalizedSeries.length >= 1000 ? 0.16 : normalizedSeries.length >= 500 ? 0.2 : 0.28;
    const baseWidth = normalizedSeries.length >= 1000 ? 0.75 : 0.95;
    const strokePoints = (points: any[], key: "y" | "ySmoothed") => {
      context.beginPath();
      let started = false;
      for (const point of points) {
        const value = key === "ySmoothed" ? (point.ySmoothed ?? point.y) : point.y;
        if (!started) {
          context.moveTo(point.x, value);
          started = true;
        } else {
          context.lineTo(point.x, value);
        }
      }
      context.stroke();
    };
    normalizedSeries.forEach((item, index) => {
      const points = item.normalizedPoints ?? [];
      if (!points.length) return;
      context.strokeStyle = chartColor(index);
      context.fillStyle = chartColor(index);
      if (points.length === 1) {
        context.globalAlpha = baseAlpha;
        context.beginPath();
        context.arc(points[0].x, points[0].displayY ?? points[0].y, 1.4, 0, Math.PI * 2);
        context.fill();
        return;
      }
      if (item.smoothed) {
        // Faded raw envelope underneath, opaque smoothed curve on top.
        context.globalAlpha = baseAlpha * 0.45;
        context.lineWidth = baseWidth;
        strokePoints(points, "y");
        context.globalAlpha = Math.min(1, baseAlpha * 2.6);
        context.lineWidth = baseWidth * 1.4;
        strokePoints(points, "ySmoothed");
      } else {
        context.globalAlpha = baseAlpha;
        context.lineWidth = baseWidth;
        strokePoints(points, "y");
      }
    });
    context.globalAlpha = 1;
  }, [denseChart, height, normalizedSeries, width]);

  const exportBlockedReason = useMemo(
    () => (exportFilenameBase ? chartExportBlockedReason(normalizedSeries) : ""),
    [exportFilenameBase, normalizedSeries],
  );
  const exportFileBase = safeExportFilename(exportFilenameBase ?? metricKey, "metric-chart");
  const chartInstanceId = useId();
  const exportHelpId = `${chartInstanceId}-chart-export-help`;

  if (!domain || normalizedSeries.every((item) => !item.normalizedPoints?.length)) {
    return <div className="chart-area" onMouseLeave={onLeave}><div className="empty">{emptyMessage}</div></div>;
  }
  // Lines render solid. Per-point markers are only drawn for genuinely sparse
  // series (1–2 samples) where a bare polyline would be invisible/ambiguous;
  // multi-point series read as a clean continuous line. Hovering still surfaces
  // a marker (the hover ring + dot below), and hit-testing is geometric via the
  // svg-level onMove handler, so markers aren't needed for interactivity.
  const sparsePointThreshold = 2;
  const xTicks = axisTicks(domain.minX, domain.maxX, 5);
  const yTicks = axisTicks(domain.minY, domain.maxY, 5);
  // Use the real domain span (never clamp to 1) so gridlines + tick labels line
  // up with the data on tiny-magnitude charts. chartDomain already guarantees a
  // non-degenerate window; the `|| 1` is just a divide-by-zero guard.
  const xSpan = (domain.maxX - domain.minX) || 1;
  const ySpan = (domain.maxY - domain.minY) || 1;
  const xPos = (value: number) => padding + ((value - domain.minX) / xSpan) * (width - padding * 2);
  const yPos = (value: number) => height - padding - ((value - domain.minY) / ySpan) * (height - padding * 2);
  const hoverRows = visibleHover ? tooltipRows(normalizedSeries, visibleHover.point.xValue, xMode, visibleHover.runId) : [];
  const hoverEdge = visibleHover ? (visibleHover.point.x < width * 0.3 ? "edge-left" : visibleHover.point.x > width * 0.62 ? "edge-right" : "") : "";
  const hoverLeft = visibleHover ? (hoverEdge === "edge-left" ? "16px" : `${Math.min(82, Math.max(18, (visibleHover.point.x / width) * 100))}%`) : "0px";
  const hoverIndex = visibleHover ? normalizedSeries.findIndex((item) => item.id === visibleHover.runId) : -1;
  const legendLimit = normalizedSeries.length <= 12 ? normalizedSeries.length : 8;
  const legendSeries = normalizedSeries.slice(0, legendLimit);

  function downloadChartCsv() {
    if (exportBlockedReason) return;
    downloadTextFile(`${exportFileBase}.csv`, chartSeriesToCsv({ metricKey, series: normalizedSeries, xMode }), "text/csv;charset=utf-8");
  }

  function downloadChartSvg() {
    if (exportBlockedReason) return;
    downloadTextFile(`${exportFileBase}.svg`, chartSeriesToSvg({ metricKey, series: normalizedSeries, width, height, padding, xMode }), "image/svg+xml;charset=utf-8");
  }

  return (
    <div
      className={`chart-area${exportFilenameBase ? " chart-area-exportable" : ""}`}
      onMouseLeave={onLeave}
    >
      {exportFilenameBase ? (
        <div className="chart-export-actions" aria-label="Chart export actions">
          <button
            aria-label={`Download ${metricKey} plotted data CSV`}
            aria-describedby={exportBlockedReason ? exportHelpId : undefined}
            aria-disabled={Boolean(exportBlockedReason) || undefined}
            className="icon-button chart-export-button"
            onClick={downloadChartCsv}
            title={exportBlockedReason || "Download plotted chart data as CSV"}
            type="button"
          >
            <FileText size={14} />
          </button>
          <button
            aria-label={`Download ${metricKey} chart image`}
            aria-describedby={exportBlockedReason ? exportHelpId : undefined}
            aria-disabled={Boolean(exportBlockedReason) || undefined}
            className="icon-button chart-export-button"
            onClick={downloadChartSvg}
            title={exportBlockedReason || "Download chart image as SVG"}
            type="button"
          >
            <ImageDown size={14} />
          </button>
          {exportBlockedReason ? <span className="chart-export-helper" id={exportHelpId}>{exportBlockedReason}</span> : null}
        </div>
      ) : null}
      <div className="chart-legend">
        {legendSeries.map((item, index) => (
          <span className="legend-chip" key={item.id} title={item.identifier ?? item.name}><i className={`legend-dot dot-${index % 5}`} style={{ backgroundColor: chartColor(index) }} /> {item.identifier ?? item.name}</span>
        ))}
        {normalizedSeries.length > legendSeries.length ? <span className="legend-chip legend-overflow" title={normalizedSeries.slice(legendSeries.length).map((item) => item.identifier ?? item.name).join(", ")}>+{normalizedSeries.length - legendSeries.length} more plotted</span> : null}
      </div>
      <div className={`metric-chart-frame${denseChart ? " dense" : ""}`} style={{ aspectRatio: `${width} / ${height}` }} onMouseLeave={onLeave}>
        {denseChart ? <canvas ref={canvasRef} className="metric-chart-canvas" aria-hidden="true" /> : null}
        <svg className={`metric-chart${denseChart ? " metric-chart-overlay" : ""}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metricKey} metric chart`} onMouseMove={onMove} onMouseLeave={onLeave}>
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={padding} x2={width - padding} y1={yPos(tick)} y2={yPos(tick)} />
              <text className="tick-label" x={padding - 6} y={yPos(tick) + 4} textAnchor="end">{formatAxisTick(tick)}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={`x-${tick}`}>
              <line className="grid-line" x1={xPos(tick)} x2={xPos(tick)} y1={padding} y2={height - padding} />
              <text className="tick-label" x={xPos(tick)} y={height - 25} textAnchor="middle">{formatAxisValue(tick, xMode)}</text>
            </g>
          ))}
          <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
          <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
          <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{xMode === "time" ? "Logged time" : "Training step"}</text>
          <text className="axis-label" x={10} y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`}>{metricTitle(metricKey)}</text>
          {visibleHover ? <line className="hover-guide" x1={visibleHover.point.x} x2={visibleHover.point.x} y1={padding} y2={height - padding} /> : null}
          {!denseChart ? normalizedSeries.map((item, index) => (
            <g key={item.id}>
              <polyline
                className={`series series-${index % 5}${item.smoothed ? " series-raw" : ""}`}
                points={item.path}
                style={{ stroke: chartColor(index) }}
              />
              {item.smoothed && item.smoothPath ? (
                <polyline className={`series series-${index % 5} series-smooth`} points={item.smoothPath} style={{ stroke: chartColor(index) }} />
              ) : null}
              {(item.normalizedPoints?.length ?? 0) <= sparsePointThreshold ? (item.normalizedPoints ?? []).map((point: any) => (
                <circle
                  key={`${item.id}-${point.step}-${point.created_at}`}
                  className={`series-point point-${index % 5}`}
                  cx={point.x}
                  cy={point.displayY ?? point.y}
                  style={{ fill: chartColor(index), stroke: "var(--chart-card-bg, var(--surface))" }}
                  onMouseEnter={() => onPointHover({ runId: item.id, runName: item.name, identifier: item.identifier ?? item.name, group: item.group, point, distance: 0 })}
                  r={2.4}
                />
              )) : null}
            </g>
          )) : null}
          {visibleHover ? (
            <>
              <circle
                className="hover-point"
                cx={visibleHover.point.x}
                cy={visibleHover.point.displayY ?? visibleHover.point.y}
                r={3.2}
                style={{ fill: hoverIndex >= 0 ? chartColor(hoverIndex) : "var(--accent)", stroke: "var(--chart-card-bg, var(--surface))" }}
              />
              <circle className="hover-ring" cx={visibleHover.point.x} cy={visibleHover.point.displayY ?? visibleHover.point.y} r={8} />
            </>
          ) : null}
        </svg>
      </div>
      {visibleHover ? (
        <div
          className={`chart-tooltip ${hoverEdge}`}
          style={{ left: hoverLeft, top: `${Math.min(76, Math.max(18, ((visibleHover.point.displayY ?? visibleHover.point.y) / height) * 100))}%` }}
        >
          <div className="chart-tooltip-head">{xMode === "time" ? formatAxisValue(visibleHover.point.xValue, xMode) : `Step ${formatNumber(visibleHover.point.step, 0)}`}</div>
          <div className="chart-tooltip-cols"><span>Value</span><span>Name</span></div>
          {hoverRows.map((row) => (
            <span className={`chart-tooltip-row${row.active ? " active" : ""}`} key={row.id}>
              <b style={{ color: chartColor(row.index) }}>
                {formatMetricValue(row.value)}
                {row.smoothedValue !== null ? <em className="tooltip-smoothed"> ({formatMetricValue(row.smoothedValue)})</em> : null}
              </b>
              <span className="chart-tooltip-name"><i className="legend-dot" style={{ backgroundColor: chartColor(row.index) }} /> {row.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {showRange ? (
        <div className="chart-range-row">
          <MiniRange
            domain={fullDomain ?? domain}
            normalizedSeries={rangeSeries ?? normalizedSeries}
            onZoomRangeChange={onZoomRangeChange}
            width={width}
            xMode={xMode}
            zoomRange={zoomRange}
          />
          {zoomRange && onZoomRangeChange ? (
            <button className="chart-zoom-reset" type="button" onClick={() => onZoomRangeChange(null)}>
              <RefreshCw size={13} /> Reset zoom
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
