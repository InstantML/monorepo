"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { axisTicks, formatAxisValue, svgPointFromClient } from "../../../src/charts.js";
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

function tooltipRows(normalizedSeries: any[], xValue: number, xMode: string, activeRunId?: string) {
  const indexed = normalizedSeries.map((item, index) => ({ item, index }));
  const active = activeRunId ? indexed.find((entry) => entry.item.id === activeRunId) : null;
  const rows = active
    ? [active, ...indexed.filter((entry) => entry.item.id !== activeRunId).slice(0, 4)]
    : indexed.slice(0, 5);
  return rows.map(({ item, index }) => {
    const points = item.normalizedPoints ?? [];
    const nearest = points.reduce((best: any, point: any) => {
      if (!best) return point;
      return Math.abs(point.xValue - xValue) < Math.abs(best.xValue - xValue) ? point : best;
    }, null);
    return {
      id: item.id,
      index,
      name: item.name,
      value: nearest?.value ?? null,
      label: xMode === "time" ? formatAxisValue(nearest?.xValue, xMode) : `Step ${formatNumber(nearest?.step, 0)}`,
    };
  });
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
  const xSpan = Math.max(1, domain.maxX - domain.minX);
  const ySpan = Math.max(1, domain.maxY - domain.minY);
  const miniX = (value: number) => padX + ((value - domain.minX) / xSpan) * (miniWidth - padX * 2);
  const miniY = (value: number) => miniHeight - padY - ((value - domain.minY) / ySpan) * (miniHeight - padY * 2);
  const activeRange = sanitizeRange(draftRange ?? zoomRange, domain);
  const activeMinX = activeRange ? miniX(activeRange.min) : 0;
  const activeMaxX = activeRange ? miniX(activeRange.max) : 0;

  function valueFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, miniWidth, miniHeight);
    const plotX = Math.max(padX, Math.min(miniWidth - padX, point.x));
    const ratio = (plotX - padX) / Math.max(1, miniWidth - padX * 2);
    return domain.minX + ratio * (domain.maxX - domain.minX);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!onZoomRangeChange) return;
    event.preventDefault();
    const value = valueFromPointer(event);
    setDragAnchor(value);
    setDraftRange({ min: value, max: value });
    event.currentTarget.setPointerCapture(event.pointerId);
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
    if (!next || (next.max - next.min) < Math.max(1, (domain.maxX - domain.minX) * 0.03)) {
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
    context.globalAlpha = normalizedSeries.length >= 1000 ? 0.16 : normalizedSeries.length >= 500 ? 0.2 : 0.28;
    context.lineWidth = normalizedSeries.length >= 1000 ? 0.75 : 0.95;
    normalizedSeries.forEach((item, index) => {
      const points = item.normalizedPoints ?? [];
      if (!points.length) return;
      context.strokeStyle = chartColor(index);
      context.fillStyle = chartColor(index);
      if (points.length === 1) {
        context.beginPath();
        context.arc(points[0].x, points[0].y, 1.4, 0, Math.PI * 2);
        context.fill();
        return;
      }
      context.beginPath();
      points.forEach((point: any, pointIndex: number) => {
        if (pointIndex === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
    });
    context.globalAlpha = 1;
  }, [denseChart, height, normalizedSeries, width]);

  if (!domain || normalizedSeries.every((item) => !item.normalizedPoints?.length)) {
    return <div className="chart-area"><div className="empty">{emptyMessage}</div></div>;
  }
  const pointCount = normalizedSeries.reduce((sum, item) => sum + (item.normalizedPoints?.length ?? 0), 0);
  // Per-point <circle> markers are the dominant SVG paint cost on the
  // canvas (one node per data point per series). The polyline already
  // conveys the curve and hover is resolved geometrically by the svg-level
  // onMove handler, so markers only earn their keep on sparse charts.
  const showPointNodes = pointCount <= 240;
  const xTicks = axisTicks(domain.minX, domain.maxX, 5);
  const yTicks = axisTicks(domain.minY, domain.maxY, 5);
  const xSpan = Math.max(1, domain.maxX - domain.minX);
  const ySpan = Math.max(1, domain.maxY - domain.minY);
  const xPos = (value: number) => padding + ((value - domain.minX) / xSpan) * (width - padding * 2);
  const yPos = (value: number) => height - padding - ((value - domain.minY) / ySpan) * (height - padding * 2);
  const hoverRows = hover ? tooltipRows(normalizedSeries, hover.point.xValue, xMode, hover.runId) : [];
  const hoverEdge = hover ? (hover.point.x < width * 0.3 ? "edge-left" : hover.point.x > width * 0.62 ? "edge-right" : "") : "";
  const hoverLeft = hover ? (hoverEdge === "edge-left" ? "16px" : `${Math.min(82, Math.max(18, (hover.point.x / width) * 100))}%`) : "0px";
  const legendLimit = normalizedSeries.length <= 12 ? normalizedSeries.length : 8;
  const legendSeries = normalizedSeries.slice(0, legendLimit);

  return (
    <div className="chart-area">
      <div className="chart-legend">
        {legendSeries.map((item, index) => (
          <span className="legend-chip" key={item.id}><i className={`legend-dot dot-${index % 5}`} style={{ backgroundColor: chartColor(index) }} /> {item.name}</span>
        ))}
        {normalizedSeries.length > legendSeries.length ? <span className="legend-chip legend-overflow">+{normalizedSeries.length - legendSeries.length} more plotted</span> : null}
      </div>
      <div className={`metric-chart-frame${denseChart ? " dense" : ""}`} style={{ aspectRatio: `${width} / ${height}` }}>
        {denseChart ? <canvas ref={canvasRef} className="metric-chart-canvas" aria-hidden="true" /> : null}
        <svg className={`metric-chart${denseChart ? " metric-chart-overlay" : ""}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metricKey} metric chart`} onMouseMove={onMove} onMouseLeave={onLeave}>
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={padding} x2={width - padding} y1={yPos(tick)} y2={yPos(tick)} />
              <text className="tick-label" x={padding - 10} y={yPos(tick) + 4} textAnchor="end">{formatNumber(tick, 2)}</text>
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
          <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>{metricTitle(metricKey)}</text>
          {hover ? <line className="hover-guide" x1={hover.point.x} x2={hover.point.x} y1={padding} y2={height - padding} /> : null}
          {!denseChart ? normalizedSeries.map((item, index) => (
            <g key={item.id}>
              <polyline className={`series series-${index % 5}`} points={item.path} style={{ stroke: chartColor(index) }} />
              {showPointNodes ? (item.normalizedPoints ?? []).map((point: any) => (
                <circle
                  key={`${item.id}-${point.step}-${point.created_at}`}
                  className={`series-point point-${index % 5}`}
                  cx={point.x}
                  cy={point.y}
                  style={{ fill: chartColor(index), stroke: "var(--chart-card-bg, var(--surface))" }}
                  onMouseEnter={() => onPointHover({ runId: item.id, runName: item.name, group: item.group, point, distance: 0 })}
                  r={2.4}
                />
              )) : null}
            </g>
          )) : null}
          {hover ? <circle className="hover-ring" cx={hover.point.x} cy={hover.point.y} r={8} /> : null}
        </svg>
      </div>
      {hover ? (
        <div
          className={`chart-tooltip ${hoverEdge}`}
          style={{ left: hoverLeft, top: `${Math.min(76, Math.max(18, (hover.point.y / height) * 100))}%` }}
        >
          <strong>{xMode === "time" ? formatAxisValue(hover.point.xValue, xMode) : `Step ${formatNumber(hover.point.step, 0)}`}</strong>
          {hoverRows.map((row) => (
            <span className={row.id === hover.runId ? "active" : ""} key={row.id}>
              <i className={`legend-dot dot-${row.index % 5}`} style={{ backgroundColor: chartColor(row.index) }} /> {row.name}
              <b>{formatNumber(row.value, 3)}</b>
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
