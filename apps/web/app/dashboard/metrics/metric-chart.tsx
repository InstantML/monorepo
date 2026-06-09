"use client";

import { FileText, ImageDown, RefreshCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { axisTicks, formatAxisTick, formatAxisValue, formatMetricValue, svgPointFromClient } from "../../../src/charts.js";
import { chartCanvasDashArray, chartColor, chartLineStyleClass, chartStyleIndexesForItems, stableChartIndex } from "../../../src/chart-colors.js";
import { chartExportBlockedReason, chartSeriesToCsv, chartSeriesToSvg, downloadTextFile, safeExportFilename } from "../../../src/chart-export.js";
import { shouldUseDenseChart } from "../../../src/dashboard-panels.js";
import { formatNumber } from "../../../src/state.js";
import { chartHeight, chartPadding, chartWidth, metricTitle } from "../../dashboard-models";
import type { HoverPoint } from "../../dashboard-types";

type ChartZoomRange = { min: number; max: number } | null;

function chartSeriesColorIndex(item: any, fallback: number) {
  return stableChartIndex(item?.id ?? item?.identifier ?? item?.name, fallback);
}

function sanitizeRange(range: ChartZoomRange | undefined, domain: any): ChartZoomRange {
  if (!range || !domain) return null;
  const min = Math.max(domain.minX, Math.min(Number(range.min), Number(range.max)));
  const max = Math.min(domain.maxX, Math.max(Number(range.min), Number(range.max)));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

const TOOLTIP_ROW_LIMIT = 8;
const TOOLTIP_OFFSET = 12;
const TOOLTIP_MARGIN = 8;

type TooltipPlacement = { left: number; top: number; side: "left" | "right"; vertical: "above" | "below" };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function chartTooltipPlacement({
  anchorX,
  anchorY,
  boundsHeight,
  boundsWidth,
  tooltipHeight,
  tooltipWidth,
}: {
  anchorX: number;
  anchorY: number;
  boundsHeight: number;
  boundsWidth: number;
  tooltipHeight: number;
  tooltipWidth: number;
}): TooltipPlacement {
  const width = Math.max(1, tooltipWidth);
  const height = Math.max(1, tooltipHeight);
  const maxLeft = Math.max(TOOLTIP_MARGIN, boundsWidth - width - TOOLTIP_MARGIN);
  const maxTop = Math.max(TOOLTIP_MARGIN, boundsHeight - height - TOOLTIP_MARGIN);
  const rightLeft = anchorX + TOOLTIP_OFFSET;
  const leftLeft = anchorX - width - TOOLTIP_OFFSET;
  const fitsRight = rightLeft + width <= boundsWidth - TOOLTIP_MARGIN;
  const side = fitsRight || leftLeft < TOOLTIP_MARGIN ? "right" : "left";
  const aboveTop = anchorY - height - TOOLTIP_OFFSET;
  const belowTop = anchorY + TOOLTIP_OFFSET;
  const spaceAbove = anchorY - TOOLTIP_MARGIN - TOOLTIP_OFFSET;
  const spaceBelow = boundsHeight - anchorY - TOOLTIP_MARGIN - TOOLTIP_OFFSET;
  const vertical = aboveTop >= TOOLTIP_MARGIN || spaceAbove >= spaceBelow ? "above" : "below";

  return {
    left: Math.round(clamp(side === "right" ? rightLeft : leftLeft, TOOLTIP_MARGIN, maxLeft)),
    top: Math.round(clamp(vertical === "above" ? aboveTop : belowTop, TOOLTIP_MARGIN, maxTop)),
    side,
    vertical,
  };
}

function tooltipRows(normalizedSeries: any[], styleIndexes: number[], xValue: number, xMode: string, useLineStyles: boolean, activeRunId?: string) {
  const rows = normalizedSeries.map((item, index) => {
    const colorIndex = styleIndexes[index] ?? chartSeriesColorIndex(item, index);
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
      rankValue: item.smoothed && Number.isFinite(nearest?.smoothedValue) ? nearest.smoothedValue : nearest?.value ?? null,
      label: xMode === "time" ? formatAxisValue(nearest?.xValue, xMode) : `Step ${formatNumber(nearest?.step, 0)}`,
      colorIndex,
      lineStyleClass: chartLineStyleClass(useLineStyles ? colorIndex : 0),
    };
  });
  // Rank by value at the hovered x (descending) like wandb/neptune, but keep the
  // actively-hovered run pinned to the top so it stays easy to read.
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const av = a.rankValue ?? Number.NEGATIVE_INFINITY;
    const bv = b.rankValue ?? Number.NEGATIVE_INFINITY;
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
  const rangeStyleIndexes = useMemo(() => chartStyleIndexesForItems(normalizedSeries), [normalizedSeries]);
  const useLineStyles = normalizedSeries.length > 12;

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
        {normalizedSeries.slice(0, 5).map((item, index) => {
          const colorIndex = rangeStyleIndexes[index] ?? chartSeriesColorIndex(item, index);
          return (
            <polyline
              className={`range-series series-${colorIndex % 5} ${chartLineStyleClass(useLineStyles ? colorIndex : 0)}`}
              key={item.id}
              points={(item.normalizedPoints ?? []).map((point: any) => `${miniX(point.xValue).toFixed(2)},${miniY(point.value).toFixed(2)}`).join(" ")}
              style={{ stroke: chartColor(colorIndex) }}
            />
          );
        })}
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
  onSmoothingChange,
  padding = chartPadding,
  rangeSeries,
  showRange = true,
  smoothing,
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
  onSmoothingChange?: (smoothing: number) => void;
  padding?: number;
  rangeSeries?: any[];
  showRange?: boolean;
  smoothing?: number;
  width?: number;
  xMode: string;
  zoomRange?: ChartZoomRange;
}) {
  const denseChart = shouldUseDenseChart(normalizedSeries);
  const useLineStyles = normalizedSeries.length > 12;
  // With many overlapping SVG lines, full opacity merges them into an opaque
  // slab. wandb/neptune render large run sets as a translucent density band and
  // isolate one line on hover — so fade each line as the count grows, and dim
  // the non-hovered lines harder when the band is busy. Pure CSS vars, so the
  // canvas/SVG render path and its speed are untouched.
  const seriesCount = normalizedSeries.length;
  const seriesStrokeOpacity = seriesCount > 60 ? 0.5 : seriesCount > 24 ? 0.68 : seriesCount > 8 ? 0.85 : 0.92;
  const seriesMutedOpacity = seriesCount > 60 ? 0.07 : seriesCount > 24 ? 0.1 : seriesCount > 8 ? 0.16 : 0.24;
  const seriesHoverCanvasOpacity = seriesCount > 60 ? 0.38 : seriesCount > 24 ? 0.48 : 0.58;
  const chartFrameStyle = {
    aspectRatio: `${width} / ${height}`,
    "--series-stroke-opacity": seriesStrokeOpacity,
    "--series-muted-opacity": seriesMutedOpacity,
    "--series-hover-canvas-opacity": seriesHoverCanvasOpacity,
  } as CSSProperties;
  const styleIndexes = useMemo(() => chartStyleIndexesForItems(normalizedSeries), [normalizedSeries]);
  const visibleHover = hover;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  const chartFrameRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState<TooltipPlacement | null>(null);
  const hoverIndex = visibleHover ? normalizedSeries.findIndex((item) => item.id === visibleHover.runId) : -1;
  const activeSeries = hoverIndex >= 0 ? normalizedSeries[hoverIndex] : null;
  const drawFocusOverlay = Boolean(activeSeries && (denseChart || seriesCount > 8));
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
      const colorIndex = styleIndexes[index] ?? chartSeriesColorIndex(item, index);
      context.strokeStyle = chartColor(colorIndex);
      context.fillStyle = chartColor(colorIndex);
      context.setLineDash(useLineStyles ? chartCanvasDashArray(colorIndex) : []);
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
    context.setLineDash([]);
    context.globalAlpha = 1;
  }, [denseChart, height, normalizedSeries, styleIndexes, useLineStyles, width]);

  const exportBlockedReason = useMemo(
    () => (exportFilenameBase ? chartExportBlockedReason(normalizedSeries) : ""),
    [exportFilenameBase, normalizedSeries],
  );
  const exportFileBase = safeExportFilename(exportFilenameBase ?? metricKey, "metric-chart");
  const chartInstanceId = useId();
  const exportHelpId = `${chartInstanceId}-chart-export-help`;
  const smoothingControlId = `${chartInstanceId}-chart-smoothing`;
  const showSmoothing = typeof onSmoothingChange === "function";
  const smoothingValue = Math.max(0, Math.min(90, Math.round((Number(smoothing) || 0) / 10) * 10));
  const showActions = Boolean(exportFilenameBase) || showSmoothing;
  // Dragging the slider gives live thumb feedback via local draft state but only
  // commits (persists + pushes one undo entry) on release, so a single gesture
  // doesn't flood the undo stack and toast log with intermediate steps.
  const [smoothingDraft, setSmoothingDraft] = useState<number | null>(null);
  useEffect(() => {
    if (smoothingDraft !== null && smoothingDraft === smoothingValue) setSmoothingDraft(null);
  }, [smoothingDraft, smoothingValue]);
  const displaySmoothing = smoothingDraft ?? smoothingValue;
  function commitSmoothing() {
    if (smoothingDraft !== null && smoothingDraft !== smoothingValue) onSmoothingChange?.(smoothingDraft);
  }
  const hoverRows = visibleHover ? tooltipRows(normalizedSeries, styleIndexes, visibleHover.point.xValue, xMode, useLineStyles, visibleHover.runId) : [];
  const hiddenHoverRows = visibleHover ? Math.max(0, normalizedSeries.length - hoverRows.length) : 0;
  const smoothedHoverRows = hoverRows.some((row) => row.smoothedValue !== null);
  useLayoutEffect(() => {
    if (!visibleHover) {
      setTooltipPlacement(null);
      return;
    }
    const chartArea = chartAreaRef.current;
    const chartFrame = chartFrameRef.current;
    const tooltip = tooltipRef.current;
    if (!chartArea || !chartFrame || !tooltip) return;

    let frame = 0;
    const updatePlacement = () => {
      frame = 0;
      const areaRect = chartArea.getBoundingClientRect();
      const frameRect = chartFrame.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      if (!areaRect.width || !areaRect.height || !frameRect.width || !frameRect.height) return;

      const pointY = visibleHover.point.displayY ?? visibleHover.point.y;
      const anchorX = frameRect.left - areaRect.left + (visibleHover.point.x / width) * frameRect.width;
      const anchorY = frameRect.top - areaRect.top + (pointY / height) * frameRect.height;
      const next = chartTooltipPlacement({
        anchorX,
        anchorY,
        boundsHeight: areaRect.height,
        boundsWidth: areaRect.width,
        tooltipHeight: tooltipRect.height,
        tooltipWidth: tooltipRect.width,
      });

      setTooltipPlacement((current) => (
        current
          && current.left === next.left
          && current.top === next.top
          && current.side === next.side
          && current.vertical === next.vertical
          ? current
          : next
      ));
    };
    const schedulePlacement = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updatePlacement);
    };

    updatePlacement();

    const observers: ResizeObserver[] = [];
    if (typeof ResizeObserver !== "undefined") {
      for (const element of [chartArea, chartFrame, tooltip]) {
        const observer = new ResizeObserver(schedulePlacement);
        observer.observe(element);
        observers.push(observer);
      }
    }
    window.addEventListener("resize", schedulePlacement);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePlacement);
      observers.forEach((observer) => observer.disconnect());
    };
  }, [height, hiddenHoverRows, hoverRows.length, smoothedHoverRows, visibleHover, width, xMode]);
  const tooltipStyle: CSSProperties = tooltipPlacement
    ? { left: `${tooltipPlacement.left}px`, top: `${tooltipPlacement.top}px` }
    : { left: 0, top: 0, visibility: "hidden" };

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
  const legendLimit = normalizedSeries.length <= 12 ? normalizedSeries.length : 8;
  const legendSeries = normalizedSeries.slice(0, legendLimit);
  const hiddenLegendSeries = normalizedSeries.slice(legendSeries.length);
  const hiddenLegendSample = hiddenLegendSeries.slice(0, 6).map((item) => item.identifier ?? item.name);
  const hiddenLegendTitle = hiddenLegendSeries.length
    ? `${hiddenLegendSeries.length} additional plotted series${hiddenLegendSample.length ? `: ${hiddenLegendSample.join(", ")}${hiddenLegendSeries.length > hiddenLegendSample.length ? ", ..." : ""}` : ""}`
    : "";
  const hoverClassFor = (item: any) => visibleHover ? (item.id === visibleHover.runId ? (drawFocusOverlay ? " series-muted" : " series-active") : " series-muted") : "";

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
      ref={chartAreaRef}
      className={`chart-area${showActions ? " chart-area-exportable" : ""}`}
      onMouseLeave={onLeave}
    >
      {showActions ? (
        <div className="chart-export-actions" aria-label="Chart actions">
          {showSmoothing ? (
            <label className="chart-smoothing-control" htmlFor={smoothingControlId} title={`Line smoothing: ${displaySmoothing ? displaySmoothing : "off"}`}>
              <span className="chart-smoothing-label">Smooth</span>
              <input
                aria-label={`Line smoothing for ${metricKey}`}
                aria-valuetext={displaySmoothing ? String(displaySmoothing) : "off"}
                className="chart-smoothing-slider"
                id={smoothingControlId}
                max={90}
                min={0}
                onBlur={commitSmoothing}
                onChange={(event) => setSmoothingDraft(Number(event.target.value))}
                onKeyUp={commitSmoothing}
                onPointerUp={commitSmoothing}
                step={10}
                type="range"
                value={displaySmoothing}
              />
            </label>
          ) : null}
          {exportFilenameBase ? (
          <>
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
          </>
          ) : null}
        </div>
      ) : null}
      <div className="chart-legend">
        {legendSeries.map((item, index) => {
          const colorIndex = styleIndexes[index] ?? chartSeriesColorIndex(item, index);
          return (
            <span className="legend-chip" key={item.id} title={item.identifier ?? item.name}><i className={`legend-line ${chartLineStyleClass(useLineStyles ? colorIndex : 0)}`} style={{ backgroundColor: chartColor(colorIndex), color: chartColor(colorIndex) }} /> {item.identifier ?? item.name}</span>
          );
        })}
        {hiddenLegendSeries.length ? (
          <span
            className="legend-chip legend-overflow"
            title={hiddenLegendTitle}
          >
            +{hiddenLegendSeries.length} more plotted
          </span>
        ) : null}
      </div>
      <div ref={chartFrameRef} className={`metric-chart-frame${denseChart ? " dense" : ""}${activeSeries ? " is-hovering-series" : ""}`} style={chartFrameStyle} onMouseLeave={onLeave}>
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
              <line className="grid-line vertical" x1={xPos(tick)} x2={xPos(tick)} y1={padding} y2={height - padding} />
              <text className="tick-label" x={xPos(tick)} y={height - 25} textAnchor="middle">{formatAxisValue(tick, xMode)}</text>
            </g>
          ))}
          <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
          <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
          <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{xMode === "time" ? "Logged time" : "Training step"}</text>
          <text className="axis-label" x={10} y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`}>{metricTitle(metricKey)}</text>
          {visibleHover ? <line className="hover-guide" x1={visibleHover.point.x} x2={visibleHover.point.x} y1={padding} y2={height - padding} /> : null}
          {!denseChart ? normalizedSeries.map((item, index) => {
            const colorIndex = styleIndexes[index] ?? chartSeriesColorIndex(item, index);
            return (
              <g key={item.id}>
                <polyline
                  className={`series series-${colorIndex % 5} ${chartLineStyleClass(useLineStyles ? colorIndex : 0)}${item.smoothed ? " series-raw" : ""}${hoverClassFor(item)}`}
                  points={item.path}
                  style={{ stroke: chartColor(colorIndex) }}
                />
                {item.smoothed && item.smoothPath ? (
                  <polyline
                    className={`series series-${colorIndex % 5} ${chartLineStyleClass(useLineStyles ? colorIndex : 0)} series-smooth${hoverClassFor(item)}`}
                    points={item.smoothPath}
                    style={{ stroke: chartColor(colorIndex) }}
                  />
                ) : null}
                {(item.normalizedPoints?.length ?? 0) <= sparsePointThreshold ? (item.normalizedPoints ?? []).map((point: any) => (
                  <circle
                    key={`${item.id}-${point.step}-${point.created_at}`}
                    className={`series-point point-${colorIndex % 5}`}
                    cx={point.x}
                    cy={point.displayY ?? point.y}
                    style={{ fill: chartColor(colorIndex), stroke: "var(--chart-card-bg, var(--surface))" }}
                    onMouseEnter={() => onPointHover({ runId: item.id, runName: item.name, identifier: item.identifier ?? item.name, group: item.group, point, distance: 0 })}
                    r={2.4}
                  />
                )) : null}
              </g>
            );
          }) : null}
          {drawFocusOverlay && activeSeries ? (() => {
            const colorIndex = styleIndexes[hoverIndex] ?? chartSeriesColorIndex(activeSeries, hoverIndex);
            const focusPath = activeSeries.smoothed && activeSeries.smoothPath ? activeSeries.smoothPath : activeSeries.path;
            return (
              <g key={`${activeSeries.id}-active-overlay`}>
                {focusPath ? (
                  <polyline
                    className={`series series-focus-halo ${chartLineStyleClass(useLineStyles ? colorIndex : 0)}`}
                    points={focusPath}
                    style={{ stroke: chartColor(colorIndex) }}
                  />
                ) : null}
                <polyline
                  className={`series series-${colorIndex % 5} ${chartLineStyleClass(useLineStyles ? colorIndex : 0)}${activeSeries.smoothed ? " series-raw" : ""} series-active series-focus-overlay`}
                  points={activeSeries.path}
                  style={{ stroke: chartColor(colorIndex) }}
                />
                {activeSeries.smoothed && activeSeries.smoothPath ? (
                  <polyline
                    className={`series series-${colorIndex % 5} ${chartLineStyleClass(useLineStyles ? colorIndex : 0)} series-smooth series-active series-focus-overlay`}
                    points={activeSeries.smoothPath}
                    style={{ stroke: chartColor(colorIndex) }}
                  />
                ) : null}
              </g>
            );
          })() : null}
          {visibleHover ? (
            <>
              <circle
                className="hover-point"
                cx={visibleHover.point.x}
                cy={visibleHover.point.displayY ?? visibleHover.point.y}
                r={3.2}
                style={{ fill: activeSeries ? chartColor(styleIndexes[hoverIndex] ?? chartSeriesColorIndex(activeSeries, hoverIndex)) : "var(--accent)", stroke: "var(--chart-card-bg, var(--surface))" }}
              />
              <circle className="hover-ring" cx={visibleHover.point.x} cy={visibleHover.point.displayY ?? visibleHover.point.y} r={8} />
            </>
          ) : null}
        </svg>
      </div>
      {visibleHover ? (
        <div
          ref={tooltipRef}
          className={`chart-tooltip chart-tooltip-pinned ${tooltipPlacement?.side === "left" ? "side-left" : "side-right"} ${tooltipPlacement?.vertical === "below" ? "is-below" : "is-above"}`}
          role="tooltip"
          style={tooltipStyle}
        >
          <div className="chart-tooltip-head">{xMode === "time" ? formatAxisValue(visibleHover.point.xValue, xMode) : `Step ${formatNumber(visibleHover.point.step, 0)}`}</div>
          <div className="chart-tooltip-cols"><span>{smoothedHoverRows ? "Raw / EMA" : "Value"}</span><span>Name</span></div>
          {hoverRows.map((row) => (
            <span className={`chart-tooltip-row${row.active ? " active" : ""}`} key={row.id}>
              <b style={{ color: chartColor(row.colorIndex) }}>
                {row.smoothedValue !== null ? (
                  <>
                    <span className="tooltip-raw">raw {formatMetricValue(row.value)}</span>
                    <em className="tooltip-smoothed">EMA {formatMetricValue(row.smoothedValue)}</em>
                  </>
                ) : formatMetricValue(row.value)}
              </b>
              <span className="chart-tooltip-name"><i className={`legend-line ${row.lineStyleClass}`} style={{ backgroundColor: chartColor(row.colorIndex), color: chartColor(row.colorIndex) }} /> {row.name}</span>
            </span>
          ))}
          {hiddenHoverRows ? <div className="chart-tooltip-more">Showing {hoverRows.length} of {normalizedSeries.length}</div> : null}
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
