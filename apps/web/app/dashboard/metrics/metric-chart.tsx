"use client";

import { FileText, ImageDown, LineChart, MoreVertical, RefreshCw, Table2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { axisTicks, chartSummaryRows, chartSummaryTakeaway, formatAxisTick, formatAxisValue, formatMetricValue, logAxisTicks, nearestPoint, normalizeSeries, sanitizeYAxisRange, svgPointFromClient, yMapper } from "../../../src/charts.js";
import { CHART_PALETTE, chartCanvasDashArray, chartColor, chartLineStyleClass, chartStyleIndexesForItems, stableChartIndex } from "../../../src/chart-colors.js";
import { chartExportBlockedReason, chartSeriesToCsv, chartSeriesToSvg, downloadTextFile, safeExportFilename } from "../../../src/chart-export.js";
import { shouldUseDenseChart } from "../../../src/dashboard-panels.js";
import { formatNumber } from "../../../src/state.js";
import { chartHeight, chartPadding, chartWidth, metricTitle } from "../../dashboard-models";
import { useMeasuredSize } from "../ui/use-measured-size";
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
// Series this sparse render per-point markers — a 1–2 point polyline is
// invisible or ambiguous without them.
const SPARSE_POINT_THRESHOLD = 2;

type TooltipPlacement = { left: number; top: number; side: "left" | "right"; vertical: "above" | "below" };
type ChartView = "chart" | "summary";

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

// The chart renders in CSS pixels (viewBox matches the measured frame), so a
// normalized point's x/y are already frame-local coordinates.
function formatSummaryPercent(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatMetricValue(value, 4)}%`;
}

function formatSummaryStep(value: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return formatNumber(Number(value), 0);
}

function ChartSummaryTable({
  metricKey,
  rows,
  tableId,
  takeaway,
}: {
  metricKey: string;
  rows: any[];
  tableId: string;
  takeaway: string;
}) {
  return (
    <section className="chart-summary-panel" id={tableId} aria-label={`${metricKey} summary table`}>
      <p className="chart-summary-takeaway">{takeaway}</p>
      <div className="chart-summary-table-wrap">
        <table className="chart-summary-table">
          <caption>{metricTitle(metricKey)} summary table</caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Final</th>
              <th scope="col">Best</th>
              <th scope="col">Best step</th>
              <th scope="col">Change</th>
              <th scope="col">Rank</th>
              <th scope="col">Trend</th>
              <th scope="col">Points</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" title={row.name}>{row.name}</th>
                <td>{formatMetricValue(row.final)}</td>
                <td>{formatMetricValue(row.best)}</td>
                <td>{formatSummaryStep(row.bestStep)}</td>
                <td>{formatSummaryPercent(row.changePercent)}</td>
                <td>{row.rank ?? "-"}</td>
                <td>{row.trend}</td>
                <td>{formatNumber(row.points, 0)}</td>
                <td>{row.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
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
      point: nearest,
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
  const miniX = (value: number) => padX + ((value - domain.minX) / xSpan) * (miniWidth - padX * 2);
  // Same y scale (incl. log10) as the main plot so the overview matches it.
  const miniY = yMapper(domain, miniHeight, padY);
  const activeRange = sanitizeRange(draftRange ?? zoomRange, domain);
  const activeMinX = activeRange ? miniX(activeRange.min) : 0;
  const activeMaxX = activeRange ? miniX(activeRange.max) : 0;
  const rangeStyleIndexes = useMemo(() => chartStyleIndexesForItems(normalizedSeries), [normalizedSeries]);
  const useLineStyles = normalizedSeries.length > CHART_PALETTE.length;

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

/**
 * Responsive line chart. The component measures its frame and renders the SVG
 * at that exact CSS-pixel size (viewBox == rendered size), so axis text,
 * strokes, and markers never stretch or squeeze with the container — the
 * "squished chart / giant tick label" failure mode of scaling a fixed
 * 560×360 logical space. Series are normalized internally at the measured
 * size; hover hit-testing is internal and surfaced via `onPointHover`.
 */
export function MetricChart({
  emptyMessage = "Select one or more runs and a metric to draw the chart.",
  exportApiRef,
  exportFilenameBase,
  height = chartHeight,
  highlightRunId = null,
  metricKey,
  onPointHover,
  onLeave,
  onZoomRangeChange,
  onSmoothingChange,
  padding = chartPadding,
  series,
  showExportActions = true,
  showLegend = true,
  showRange = true,
  showYAxisControls = true,
  smoothing,
  xMode,
  yScale: yScaleProp,
  zoomRange = null,
}: {
  emptyMessage?: string;
  /** Imperative export handle for owners that render their own export UI. */
  exportApiRef?: { current: { downloadSvg: () => void; downloadCsv: () => void } | null };
  exportFilenameBase?: string;
  /** Frame height in CSS px; the width always tracks the container. */
  height?: number;
  /** External cross-highlight (e.g. hovering a run in the rail or table). */
  highlightRunId?: string | null;
  metricKey: string;
  onPointHover?: (point: HoverPoint) => void;
  onLeave?: () => void;
  onZoomRangeChange?: (range: ChartZoomRange) => void;
  onSmoothingChange?: (smoothing: number) => void;
  padding?: number;
  /** Display series — smoothing already applied by the owner. */
  series: any[];
  /** Hide the in-chart actions row when the owner renders its own controls. */
  showExportActions?: boolean;
  /** Hide the built-in legend when the owner renders its own (e.g. Overview). */
  showLegend?: boolean;
  showRange?: boolean;
  /** Per-panel log toggle + manual y-range; on by default everywhere. */
  showYAxisControls?: boolean;
  smoothing?: number;
  xMode: string;
  /** Controlled y-scale; when set, the owner owns the lin/log toggle. */
  yScale?: "linear" | "log";
  zoomRange?: ChartZoomRange;
}) {
  const [chartView, setChartView] = useState<ChartView>("chart");
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  const chartFrameRef = useRef<HTMLDivElement | null>(null);
  const { width: measuredWidth, height: measuredHeight } = useMeasuredSize(chartFrameRef, chartWidth, height);
  const width = measuredWidth;
  const frameHeight = measuredHeight;
  // Clamp padding so tiny panels keep a usable plot area.
  const pad = Math.min(padding, Math.max(24, Math.min(width, frameHeight) / 4));

  // Per-panel y-axis settings (P0-9): log10 toggle + manual range. State is
  // chart-local so every panel gets the control without owner plumbing.
  const [yScaleState, setYScaleState] = useState<"linear" | "log">("linear");
  const yScale = yScaleProp ?? yScaleState;
  const [yRange, setYRange] = useState<{ min: number; max: number } | null>(null);
  const [yMinDraft, setYMinDraft] = useState("");
  const [yMaxDraft, setYMaxDraft] = useState("");
  // The three-dot options menu (log scale, y-range, smoothing, export) lives in
  // a single disclosure so the toolbar stays just a view switcher + one button.
  const menuDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const yAxisOptions = useMemo(() => ({ scale: yScale, range: yRange }), [yRange, yScale]);

  // The options menu dismisses like every other dropdown in the app:
  // click-away closes it, Escape closes it and returns focus to its trigger.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = menuDetailsRef.current;
      if (!details?.open) return;
      if (event.target instanceof Node && details.contains(event.target)) return;
      details.open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const details = menuDetailsRef.current;
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      const summary = details.querySelector("summary");
      if (summary instanceof HTMLElement) summary.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const normalizedSeries: any[] = useMemo(
    () => normalizeSeries(series, width, frameHeight, pad, xMode, metricKey, zoomRange, yAxisOptions),
    [frameHeight, metricKey, pad, series, width, xMode, yAxisOptions, zoomRange],
  );
  const rangeNormalizedSeries: any[] = useMemo(
    () => (showRange ? normalizeSeries(series, width, frameHeight, pad, xMode, metricKey, null, yAxisOptions) : normalizedSeries),
    [frameHeight, metricKey, normalizedSeries, pad, series, showRange, width, xMode, yAxisOptions],
  );
  const domain = normalizedSeries.find((item) => item.domain)?.domain ?? null;
  const fullDomain = rangeNormalizedSeries.find((item) => item.domain)?.domain ?? domain;

  const [hover, setHover] = useState<HoverPoint>(null);
  const denseChart = shouldUseDenseChart(normalizedSeries);
  const useLineStyles = normalizedSeries.length > CHART_PALETTE.length;
  // With many overlapping SVG lines, full opacity merges them into an opaque
  // slab. wandb/neptune render large run sets as a translucent density band and
  // isolate one line on hover — so fade each line as the count grows, and dim
  // the non-hovered lines harder when the band is busy.
  const seriesCount = normalizedSeries.length;
  const seriesStrokeOpacity =
    seriesCount > 60 ? 0.45 : seriesCount > 24 ? 0.6 : seriesCount > 8 ? 0.72 : seriesCount > 4 ? 0.82 : 0.92;
  const seriesMutedOpacity = seriesCount > 60 ? 0.06 : seriesCount > 24 ? 0.09 : seriesCount > 8 ? 0.13 : 0.2;
  const seriesHoverCanvasOpacity = seriesCount > 60 ? 0.38 : seriesCount > 24 ? 0.48 : 0.58;
  const chartFrameStyle = {
    "--chart-frame-height": `${height}px`,
    "--series-stroke-opacity": seriesStrokeOpacity,
    "--series-muted-opacity": seriesMutedOpacity,
    "--series-hover-canvas-opacity": seriesHoverCanvasOpacity,
  } as CSSProperties;
  const styleIndexes = useMemo(() => chartStyleIndexesForItems(normalizedSeries), [normalizedSeries]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState<TooltipPlacement | null>(null);
  // R6 cross-highlight: legend-chip hover and the external rail/table hover
  // isolate a series exactly like an in-plot hover, minus the tooltip (which
  // needs a real point under the cursor). The highlight resolves only when
  // that run is actually plotted here — otherwise a rail hover would mute
  // every series in unrelated panels, and a stale id (series swapped out by a
  // live poll) would stick.
  const [legendHoverId, setLegendHoverId] = useState<string | null>(null);
  // Expanding the legend reveals the runs hidden behind the "+N more" chip so
  // they can be hover-highlighted like the always-visible ones.
  const [legendExpanded, setLegendExpanded] = useState(false);
  const requestedRunId = hover?.runId ?? legendHoverId ?? highlightRunId ?? null;
  const hoverIndex = requestedRunId ? normalizedSeries.findIndex((item) => item.id === requestedRunId) : -1;
  const activeRunId = hoverIndex >= 0 ? requestedRunId : null;
  const activeSeries = hoverIndex >= 0 ? normalizedSeries[hoverIndex] : null;
  const drawFocusOverlay = Boolean(activeSeries && (denseChart || seriesCount > 8));

  const hoverRef = useRef<HoverPoint>(null);
  const moveFrameRef = useRef(0);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);

  function emitHover(next: HoverPoint) {
    // Bail when nothing changed — raw mousemove fires far faster than the
    // hovered point changes, and every emit re-renders the owner too.
    const current = hoverRef.current;
    if (!current && !next) return;
    if (current && next && current.runId === next.runId && current.point === next.point) return;
    hoverRef.current = next;
    setHover(next);
    onPointHover?.(next);
  }

  // Coalesce hit-testing to one nearestPoint pass per frame; dense charts have
  // tens of thousands of points and mousemove can fire at 120Hz+.
  function handleMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    pendingMoveRef.current = svgPointFromClient(rect, event.clientX, event.clientY, width, frameHeight);
    if (moveFrameRef.current) return;
    moveFrameRef.current = window.requestAnimationFrame(() => {
      moveFrameRef.current = 0;
      const point = pendingMoveRef.current;
      if (!point) return;
      emitHover(nearestPoint(normalizedSeries, point.x, point.y) ?? null);
    });
  }

  useEffect(() => () => {
    if (moveFrameRef.current) window.cancelAnimationFrame(moveFrameRef.current);
  }, []);

  function handleLeave() {
    if (moveFrameRef.current) {
      window.cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = 0;
    }
    pendingMoveRef.current = null;
    hoverRef.current = null;
    setHover(null);
    onLeave?.();
  }

  useEffect(() => {
    if (!denseChart) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(frameHeight * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, frameHeight);
    context.lineCap = "round";
    context.lineJoin = "round";
    // A manual y-range can put data outside the plot window; clip it like the
    // SVG path does.
    const clipToPlot = Boolean(yRange);
    if (clipToPlot) {
      context.save();
      context.beginPath();
      context.rect(pad, pad, width - pad * 2, frameHeight - pad * 2);
      context.clip();
    }
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
    if (clipToPlot) context.restore();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }, [denseChart, frameHeight, normalizedSeries, pad, styleIndexes, useLineStyles, width, yRange]);

  const exportBlockedReason = useMemo(
    () => (exportFilenameBase ? chartExportBlockedReason(normalizedSeries) : ""),
    [exportFilenameBase, normalizedSeries],
  );
  const exportFileBase = safeExportFilename(exportFilenameBase ?? metricKey, "metric-chart");
  const chartInstanceId = useId();
  const exportHelpId = `${chartInstanceId}-chart-export-help`;
  const chartPanelId = `${chartInstanceId}-chart-panel`;
  const smoothingControlId = `${chartInstanceId}-chart-smoothing`;
  const showViewToggle = true;
  const showInlineControls = chartView === "chart" && showExportActions;
  const showSmoothing = showInlineControls && typeof onSmoothingChange === "function";
  const smoothingValue = Math.max(0, Math.min(90, Math.round((Number(smoothing) || 0) / 10) * 10));
  // What lands in the three-dot menu: y-axis scale/range, smoothing, exports.
  const menuHasYAxis = showInlineControls && showYAxisControls;
  const menuHasExport = showInlineControls && Boolean(exportFilenameBase);
  const hasMenu = menuHasYAxis || showSmoothing || menuHasExport;
  const showActions = showViewToggle || hasMenu;
  const displaySmoothing = smoothingValue;
  const plotClipId = `chart-plot-clip-${chartInstanceId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hiddenLogPoints = yScale === "log" ? normalizedSeries.reduce((sum, item) => sum + (item.hiddenNonPositive ?? 0), 0) : 0;
  const summaryRows = useMemo(() => chartSummaryRows(normalizedSeries, metricKey), [metricKey, normalizedSeries]);
  const summaryTakeaway = useMemo(() => chartSummaryTakeaway(normalizedSeries, metricKey), [metricKey, normalizedSeries]);
  const hoverRows = hover ? tooltipRows(normalizedSeries, styleIndexes, hover.point.xValue, xMode, useLineStyles, hover.runId) : [];
  const hiddenHoverRows = hover ? Math.max(0, normalizedSeries.length - hoverRows.length) : 0;
  const smoothedHoverRows = hoverRows.some((row) => row.smoothedValue !== null);
  useLayoutEffect(() => {
    if (!hover) {
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

      // viewBox == rendered size, so normalized coordinates ARE frame-local px.
      const anchorX = frameRect.left - areaRect.left + hover.point.x;
      const anchorY = frameRect.top - areaRect.top + (hover.point.displayY ?? hover.point.y);
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
  }, [hiddenHoverRows, hover, hoverRows.length, smoothedHoverRows, xMode]);
  const tooltipStyle: CSSProperties = tooltipPlacement
    ? { left: `${tooltipPlacement.left}px`, top: `${tooltipPlacement.top}px` }
    : { left: 0, top: 0, visibility: "hidden" };

  function toggleYScale() {
    const next = yScale === "log" ? "linear" : "log";
    // A manual floor at or below zero can't survive the switch to log.
    if (next === "log" && yRange && yRange.min <= 0) setYRange(null);
    setYScaleState(next);
  }

  function downloadChartCsv() {
    if (exportBlockedReason) return;
    downloadTextFile(`${exportFileBase}.csv`, chartSeriesToCsv({ metricKey, series: normalizedSeries, xMode }), "text/csv;charset=utf-8");
  }

  function downloadChartSvg() {
    if (exportBlockedReason) return;
    downloadTextFile(`${exportFileBase}.svg`, chartSeriesToSvg({ metricKey, series: normalizedSeries, width, height: frameHeight, padding: pad, xMode }), "image/svg+xml;charset=utf-8");
  }

  // Owners with their own export UI (e.g. the metrics panel head) trigger the
  // same exports through this handle; refreshed every render so it always
  // closes over the latest normalized series.
  useEffect(() => {
    if (!exportApiRef) return undefined;
    exportApiRef.current = { downloadSvg: downloadChartSvg, downloadCsv: downloadChartCsv };
    return () => {
      exportApiRef.current = null;
    };
  });

  // One-sided entries fall back to the current domain bound, so "cap the top
  // at 1" doesn't require typing the floor too.
  function draftYRange() {
    const min = yMinDraft.trim() === "" ? (domain ? domain.minY : Number.NaN) : Number(yMinDraft);
    const max = yMaxDraft.trim() === "" ? (domain ? domain.maxY : Number.NaN) : Number(yMaxDraft);
    return sanitizeYAxisRange({ min, max }, yScale);
  }

  // Apply/Auto commit the range but leave the menu open so the user can keep
  // nudging the bounds and watch the plot update behind the popover.
  function applyYRangeDraft() {
    const next = draftYRange();
    if (!next) return;
    setYRange(next);
  }

  function clearYRange() {
    setYRange(null);
    setYMinDraft("");
    setYMaxDraft("");
  }

  const yDraftDirty = yMinDraft.trim() !== "" || yMaxDraft.trim() !== "";
  const yDraftValid = !yDraftDirty || Boolean(draftYRange());
  const yRangeKeyDown = (event: { key: string; preventDefault: () => void }) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyYRangeDraft();
    }
  };

  const actionsRow = showActions ? (
    <div className="chart-export-actions" aria-label="Chart actions">
      {showViewToggle ? (
        <div className="chart-view-switch" role="group" aria-label={`${metricKey} view`} data-view={chartView}>
          {/* The thumb slides under the active icon; the live region below the
              chart announces the change for screen-reader users. */}
          <span className="chart-view-switch-thumb" aria-hidden="true" />
          <button
            aria-controls={chartPanelId}
            aria-label={`Show ${metricKey} as a chart`}
            aria-pressed={chartView === "chart"}
            className={`chart-view-switch-btn${chartView === "chart" ? " selected" : ""}`}
            onClick={() => setChartView("chart")}
            title="Chart"
            type="button"
          >
            <LineChart size={15} aria-hidden="true" />
          </button>
          <button
            aria-controls={chartPanelId}
            aria-label={`Show ${metricKey} as a summary table`}
            aria-pressed={chartView === "summary"}
            className={`chart-view-switch-btn${chartView === "summary" ? " selected" : ""}`}
            onClick={() => setChartView("summary")}
            title="Summary table"
            type="button"
          >
            <Table2 size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {hasMenu ? (
        <details
          className="chart-menu"
          onToggle={(event) => {
            if ((event.currentTarget as HTMLDetailsElement).open && yRange) {
              setYMinDraft(String(yRange.min));
              setYMaxDraft(String(yRange.max));
            }
          }}
          ref={menuDetailsRef}
        >
          <summary aria-label={`${metricKey} chart options`} title="Chart options">
            <MoreVertical size={16} aria-hidden="true" />
          </summary>
          <div className="chart-menu-pop" aria-label={`${metricKey} chart options`}>
            {menuHasYAxis ? (
              <>
                <button
                  aria-pressed={yScale === "log"}
                  className={`chart-menu-row chart-log-toggle${yScale === "log" ? " active" : ""}`}
                  onClick={toggleYScale}
                  title={yScale === "log"
                    ? `Logarithmic y-axis${hiddenLogPoints ? ` — ${hiddenLogPoints} non-positive points hidden` : ""}. Click for linear.`
                    : "Switch to a logarithmic y-axis (plots positive values only)"}
                  type="button"
                >
                  <span className="chart-menu-row-label">Logarithmic y-axis</span>
                  <span className="chart-menu-switch" aria-hidden="true" />
                </button>
                <div className="chart-menu-section">
                  <span className="chart-menu-section-label">Y-axis range</span>
                  <div className="chart-y-range-pop">
                    <label className="chart-y-range-field">
                      <span>Min</span>
                      <input
                        aria-label="Manual y-axis minimum"
                        onChange={(event) => setYMinDraft(event.currentTarget.value)}
                        onKeyDown={yRangeKeyDown}
                        placeholder={domain ? formatAxisTick(domain.minY) : "min"}
                        step="any"
                        type="number"
                        value={yMinDraft}
                      />
                    </label>
                    <label className="chart-y-range-field">
                      <span>Max</span>
                      <input
                        aria-label="Manual y-axis maximum"
                        onChange={(event) => setYMaxDraft(event.currentTarget.value)}
                        onKeyDown={yRangeKeyDown}
                        placeholder={domain ? formatAxisTick(domain.maxY) : "max"}
                        step="any"
                        type="number"
                        value={yMaxDraft}
                      />
                    </label>
                    <div className="chart-y-range-actions">
                      <button className="secondary compact-button" disabled={!yDraftDirty || !yDraftValid} onClick={applyYRangeDraft} type="button">Apply</button>
                      <button className="secondary compact-button" onClick={clearYRange} type="button">Auto</button>
                    </div>
                    {yDraftDirty && !yDraftValid ? (
                      <small className="chart-y-range-hint">{yScale === "log" ? "Log scale needs 0 < min < max." : "Needs min < max."}</small>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}
            {showSmoothing ? (
              <label className="chart-menu-slider chart-smoothing-control" htmlFor={smoothingControlId} title={`Line smoothing (EMA): ${displaySmoothing ? displaySmoothing : "off"}`}>
                <span className="chart-smoothing-label">Smoothing</span>
                <span className="chart-smoothing-value" aria-hidden="true">{displaySmoothing ? `.${displaySmoothing}` : "off"}</span>
                <input
                  aria-label={`Line smoothing for ${metricKey}`}
                  aria-valuetext={displaySmoothing ? String(displaySmoothing) : "off"}
                  className="chart-smoothing-slider"
                  id={smoothingControlId}
                  max={90}
                  min={0}
                  onChange={(event) => onSmoothingChange?.(Number(event.currentTarget.value))}
                  onInput={(event) => onSmoothingChange?.(Number(event.currentTarget.value))}
                  step={10}
                  type="range"
                  value={displaySmoothing}
                />
              </label>
            ) : null}
            {menuHasExport ? (
              <>
                <div className="chart-menu-divider" role="separator" />
                <button
                  aria-label={`Download ${metricKey} plotted data CSV`}
                  aria-describedby={exportBlockedReason ? exportHelpId : undefined}
                  aria-disabled={Boolean(exportBlockedReason) || undefined}
                  className="chart-menu-item"
                  onClick={downloadChartCsv}
                  title={exportBlockedReason || "Download plotted chart data as CSV"}
                  type="button"
                >
                  <FileText size={14} aria-hidden="true" /> Download data (CSV)
                </button>
                <button
                  aria-label={`Download ${metricKey} chart image`}
                  aria-describedby={exportBlockedReason ? exportHelpId : undefined}
                  aria-disabled={Boolean(exportBlockedReason) || undefined}
                  className="chart-menu-item"
                  onClick={downloadChartSvg}
                  title={exportBlockedReason || "Download chart image as SVG"}
                  type="button"
                >
                  <ImageDown size={14} aria-hidden="true" /> Download image (SVG)
                </button>
                {exportBlockedReason ? <span className="chart-export-helper" id={exportHelpId}>{exportBlockedReason}</span> : null}
              </>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  ) : null;

  if (!domain || normalizedSeries.every((item) => !item.normalizedPoints?.length)) {
    // Log scale can legitimately blank a chart whose data is all <= 0 — keep
    // the actions row mounted so the user can flip the axis back. Only blame
    // the log scale when it actually dropped points (an x-zoom can also empty
    // the window).
    const logHidEverything = yScale === "log" && normalizedSeries.some((item) => (item.hiddenNonPositive ?? 0) > 0);
    return (
      <div id={chartPanelId} className={`chart-area${showActions ? " chart-area-exportable" : ""}`} onMouseLeave={handleLeave}>
        {actionsRow}
        <span className="visually-hidden" role="status" aria-live="polite">{chartView === "summary" ? `${metricKey} summary table selected.` : `${metricKey} chart selected.`}</span>
        {chartView === "summary" ? (
          <ChartSummaryTable metricKey={metricKey} rows={summaryRows} tableId={`${chartInstanceId}-summary-table`} takeaway={summaryTakeaway} />
        ) : (
          <div className="empty">
            {logHidEverything
              ? "Log scale plots positive values only and this window has none above zero. Switch the y-axis back to linear."
              : emptyMessage}
          </div>
        )}
      </div>
    );
  }
  const xTicks = axisTicks(domain.minX, domain.maxX, Math.max(3, Math.min(8, Math.round(width / 140))));
  const yTickCount = Math.max(3, Math.min(7, Math.round(frameHeight / 70)));
  const yTicks = domain.yScale === "log"
    ? logAxisTicks(domain.minY, domain.maxY, yTickCount)
    : axisTicks(domain.minY, domain.maxY, yTickCount);
  // Use the real domain span (never clamp to 1) so gridlines + tick labels line
  // up with the data on tiny-magnitude charts. The `|| 1` is just a
  // divide-by-zero guard. yMapper shares the exact scale (linear or log10)
  // that normalizeSeries used for the paths.
  const xSpan = (domain.maxX - domain.minX) || 1;
  const xPos = (value: number) => pad + ((value - domain.minX) / xSpan) * (width - pad * 2);
  const yPos = yMapper(domain, frameHeight, pad);
  const legendLimit = normalizedSeries.length <= 12 ? normalizedSeries.length : 8;
  const collapsedLegendSeries = normalizedSeries.slice(0, legendLimit);
  const hiddenLegendSeries = normalizedSeries.slice(collapsedLegendSeries.length);
  const legendExpandable = hiddenLegendSeries.length > 0;
  const legendShowingAll = legendExpanded && legendExpandable;
  // When expanded, every run gets its own chip so the whole set is hoverable;
  // collapsed, we fall back to the first slice plus the "+N more" toggle.
  const legendSeries = legendShowingAll ? normalizedSeries : collapsedLegendSeries;
  const hiddenLegendSample = hiddenLegendSeries.slice(0, 6).map((item) => item.identifier ?? item.name);
  const hiddenLegendTitle = hiddenLegendSeries.length
    ? `${hiddenLegendSeries.length} additional plotted series${hiddenLegendSample.length ? `: ${hiddenLegendSample.join(", ")}${hiddenLegendSeries.length > hiddenLegendSample.length ? ", ..." : ""}` : ""}`
    : "";
  const hoverClassFor = (item: any) => activeRunId ? (item.id === activeRunId ? (drawFocusOverlay ? " series-muted" : " series-active") : " series-muted") : "";

  return (
    <div
      id={chartPanelId}
      ref={chartAreaRef}
      className={`chart-area${showActions ? " chart-area-exportable" : ""}`}
      onMouseLeave={handleLeave}
    >
      {actionsRow}
      <span className="visually-hidden" role="status" aria-live="polite">{chartView === "summary" ? `${metricKey} summary table selected.` : `${metricKey} chart selected.`}</span>
      {chartView === "summary" ? (
        <ChartSummaryTable metricKey={metricKey} rows={summaryRows} tableId={`${chartInstanceId}-summary-table`} takeaway={summaryTakeaway} />
      ) : (
        <>
      {showLegend ? (
      <div className={`chart-legend${activeRunId ? " has-active" : ""}${legendShowingAll ? " chart-legend-expanded" : ""}`}>
        {legendSeries.map((item, index) => {
          const colorIndex = styleIndexes[index] ?? chartSeriesColorIndex(item, index);
          return (
            <span
              className={`legend-chip${item.id === activeRunId ? " legend-chip-active" : ""}`}
              key={item.id}
              onBlur={() => setLegendHoverId((current) => (current === item.id ? null : current))}
              onFocus={() => setLegendHoverId(item.id)}
              onMouseEnter={() => setLegendHoverId(item.id)}
              onMouseLeave={() => setLegendHoverId((current) => (current === item.id ? null : current))}
              tabIndex={0}
              title={item.identifier ?? item.name}
            ><i className={`legend-line ${chartLineStyleClass(useLineStyles ? colorIndex : 0)}`} style={{ backgroundColor: chartColor(colorIndex), color: chartColor(colorIndex) }} /> {item.identifier ?? item.name}</span>
          );
        })}
        {legendExpandable ? (
          <button
            type="button"
            className="legend-chip legend-overflow"
            aria-expanded={legendShowingAll}
            title={legendShowingAll ? "Hide the additional plotted runs" : hiddenLegendTitle}
            onClick={() => setLegendExpanded((open) => !open)}
          >
            {legendShowingAll ? "Show fewer" : `+${hiddenLegendSeries.length} more plotted`}
          </button>
        ) : null}
        {yScale === "log" && hiddenLogPoints > 0 ? (
          <span className="legend-chip legend-overflow" title="Log scale plots positive values only; switch back to linear to see these points.">
            {hiddenLogPoints} {hiddenLogPoints === 1 ? "point" : "points"} ≤ 0 hidden
          </span>
        ) : null}
      </div>
      ) : null}
      <div ref={chartFrameRef} className={`metric-chart-frame${denseChart ? " dense" : ""}${activeSeries ? " is-hovering-series" : ""}`} style={chartFrameStyle} onMouseLeave={handleLeave}>
        {denseChart ? <canvas ref={canvasRef} className="metric-chart-canvas" aria-hidden="true" /> : null}
        <svg className={`metric-chart${denseChart ? " metric-chart-overlay" : ""}`} viewBox={`0 0 ${width} ${frameHeight}`} role="img" aria-label={`${metricKey} metric chart`} onMouseMove={handleMove} onMouseLeave={handleLeave}>
          {yRange ? (
            <defs>
              <clipPath id={plotClipId}>
                <rect x={pad} y={pad} width={Math.max(0, width - pad * 2)} height={Math.max(0, frameHeight - pad * 2)} />
              </clipPath>
            </defs>
          ) : null}
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={pad} x2={width - pad} y1={yPos(tick)} y2={yPos(tick)} />
              <text className="tick-label" x={pad - 6} y={yPos(tick) + 4} textAnchor="end">{formatAxisTick(tick)}</text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={`x-${tick}`}>
              <line className="grid-line vertical" x1={xPos(tick)} x2={xPos(tick)} y1={pad} y2={frameHeight - pad} />
              <text className="tick-label" x={xPos(tick)} y={frameHeight - pad + 18} textAnchor="middle">{formatAxisValue(tick, xMode)}</text>
            </g>
          ))}
          <line className="axis" x1={pad} x2={width - pad} y1={frameHeight - pad} y2={frameHeight - pad} />
          <line className="axis" x1={pad} x2={pad} y1={pad} y2={frameHeight - pad} />
          <text className="axis-label axis-label-x" x={width - pad} y={frameHeight - 6} textAnchor="end">{xMode === "time" ? "Time" : "Step"}</text>
          {hover ? <line className="hover-guide" x1={hover.point.x} x2={hover.point.x} y1={pad} y2={frameHeight - pad} /> : null}
          {/* A manual y-range can leave data outside the plot window; clip the
              series (and hover ring) to the plot rect so lines don't overdraw
              the axis gutters. */}
          <g clipPath={yRange ? `url(#${plotClipId})` : undefined}>
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
                {(item.normalizedPoints?.length ?? 0) <= SPARSE_POINT_THRESHOLD ? (item.normalizedPoints ?? []).map((point: any) => (
                  <circle
                    key={`${item.id}-${point.step}-${point.created_at}`}
                    className={`series-point point-${colorIndex % 5}`}
                    cx={point.x}
                    cy={point.displayY ?? point.y}
                    style={{ fill: chartColor(colorIndex), stroke: "var(--chart-card-bg, var(--surface))" }}
                    onMouseEnter={() => emitHover({ runId: item.id, runName: item.name, identifier: item.identifier ?? item.name, group: item.group, point, distance: 0 })}
                    r={3.2}
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
          {hover ? (
            <circle className="hover-ring" cx={hover.point.x} cy={hover.point.displayY ?? hover.point.y} r={8} />
          ) : null}
          </g>
        </svg>
      </div>
      {hover ? (
        <div
          ref={tooltipRef}
          className={`chart-tooltip chart-tooltip-pinned ${tooltipPlacement?.side === "left" ? "side-left" : "side-right"} ${tooltipPlacement?.vertical === "below" ? "is-below" : "is-above"}`}
          role="tooltip"
          style={tooltipStyle}
        >
          <div className="chart-tooltip-head">{xMode === "time" ? formatAxisValue(hover.point.xValue, xMode) : `Step ${formatNumber(hover.point.step, 0)}`}</div>
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
          <div className={`chart-tooltip-more${hiddenHoverRows ? "" : " chart-tooltip-more-placeholder"}`}>
            Showing {hoverRows.length} of {normalizedSeries.length}
          </div>
        </div>
      ) : null}
      {showRange ? (
        <div className="chart-range-row">
          <MiniRange
            domain={fullDomain ?? domain}
            normalizedSeries={rangeNormalizedSeries}
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
        </>
      )}
    </div>
  );
}
