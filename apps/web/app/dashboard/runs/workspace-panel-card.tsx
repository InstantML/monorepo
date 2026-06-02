"use client";

import { ChevronDown, CopyPlus, GripVertical, Maximize2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { averageGroupedSeries, axisTicks, chartDomain, formatAxisTick, formatAxisValue, formatMetricValue, nearestPoint, normalizeSeries, smoothSeries, svgPointFromClient } from "../../../src/charts.js";
import { chartColor, chartStyleIndexesForItems, stableChartIndex } from "../../../src/chart-colors.js";
import { fieldLabel, histogramBins, indexedAxisTicks, latestMetricValues, parseFieldId, scatterPointsForRuns } from "../../../src/dashboard-panels.js";
import { MAX_SELECTED_RUNS, groupKeyForRun, formatNumber } from "../../../src/state.js";
import {
  chartHeight,
  chartPadding,
  chartWidth,
  metricTitle,
  workspacePanelTypeLabel,
} from "../../dashboard-models";
import { MetricChart } from "../metrics/metric-chart";
import { CustomSelect } from "../ui/select";
import { normalizedPanelLayout, resolveWorkspaceSettings } from "./panel-settings";
import type { HoverPoint, MetricSeries, RunSummary, WorkspacePanel, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceSection, WorkspaceView } from "../../dashboard-types";

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 8) return value.slice(0, maxLength);
  const keep = maxLength - 3;
  const start = Math.ceil(keep / 2);
  const end = Math.floor(keep / 2);
  return `${value.slice(0, start)}...${value.slice(value.length - end)}`;
}

function panelMatchesSearch(section: WorkspaceSection, panel: WorkspacePanel, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const scatterFields = panel.type === "scatter" ? `${fieldLabel(panel.xField)} ${fieldLabel(panel.yField)}` : "";
  return `${section.name} ${panel.title} ${panel.metricKey} ${workspacePanelTypeLabel(panel.type)} ${scatterFields}`.toLowerCase().includes(needle);
}

function isCreatedTimeField(fieldId: string) {
  const parsed = parseFieldId(fieldId);
  return parsed?.source === "run" && parsed.field === "created_at_unix";
}

function formatUtcTime(seconds: number, mode: "tick" | "title", peerValues: number[]) {
  const millis = seconds * 1000;
  if (!Number.isFinite(millis)) return "-";
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "-";
  if (mode === "title") return date.toISOString();
  const span = peerValues.length ? Math.max(...peerValues) - Math.min(...peerValues) : 0;
  if (span <= 60 * 60 * 24) return date.toISOString().slice(11, 19);
  if (span <= 60 * 60 * 24 * 366) return date.toISOString().slice(5, 10);
  return date.toISOString().slice(0, 10);
}

function formatScatterTick(value: number, fieldId: string, peerValues: number[]) {
  if (isCreatedTimeField(fieldId)) return formatUtcTime(value, "tick", peerValues);
  const span = peerValues.length ? Math.max(...peerValues) - Math.min(...peerValues) : 0;
  if (span > 0 && span < 100) {
    const neededDecimals = Math.max(0, Math.ceil(-Math.log10(span / 4)) + 1);
    if (neededDecimals > 6 || (Math.abs(value) > 0 && Math.abs(value) < 0.0001)) return formatAxisTick(value);
    const decimals = Math.min(6, neededDecimals);
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: decimals });
  }
  return formatAxisTick(value);
}

function formatScatterValue(value: number, fieldId: string, peerValues: number[]) {
  if (isCreatedTimeField(fieldId)) return formatUtcTime(value, "title", peerValues);
  return formatMetricValue(value, 6);
}

type DraggedWorkspacePanel = {
  panelId: string;
  sectionId: string;
};

type AltChartHover = {
  detail?: string;
  id: string;
  title: string;
  value: string;
  x: number;
  y: number;
};

function readDraggedPanel(event: DragEvent<HTMLElement>): DraggedWorkspacePanel | null {
  try {
    const raw = event.dataTransfer.getData("application/x-instantml-panel");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraggedWorkspacePanel>;
    return typeof parsed.sectionId === "string" && typeof parsed.panelId === "string"
      ? { sectionId: parsed.sectionId, panelId: parsed.panelId }
      : null;
  } catch {
    return null;
  }
}

function LatestMetricPanelChart({
  height,
  metricKey,
  padding,
  type,
  values,
  width,
}: {
  height: number;
  metricKey: string;
  padding: number;
  type: Exclude<WorkspacePanelType, "line" | "scatter">;
  values: Array<{ id: string; index: number; name: string; value: number }>;
  width: number;
}) {
  const [hover, setHover] = useState<AltChartHover | null>(null);
  const valueStyleIndexes = useMemo(() => chartStyleIndexesForItems(values), [values]);
  if (!values.length) {
    return <div className="chart-area"><div className="empty">No latest values for this metric in the current run set.</div></div>;
  }
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const metricValues = values.map((item) => item.value);
  const minValue = Math.min(...metricValues);
  const maxValue = Math.max(...metricValues);
  const paddedMin = minValue === maxValue ? minValue - 1 : minValue;
  const paddedMax = minValue === maxValue ? maxValue + 1 : maxValue;
  const valueMin = type === "bar" ? Math.min(0, paddedMin) : paddedMin;
  const valueMax = type === "bar" ? Math.max(0, paddedMax) : paddedMax;
  const yFor = (value: number) => padding + innerHeight - ((value - valueMin) / (valueMax - valueMin || 1)) * innerHeight;
  const xFor = (index: number) => padding + (values.length === 1 ? innerWidth / 2 : (index / (values.length - 1)) * innerWidth);
  const bins = type === "histogram" ? histogramBins(metricValues, 12) : [];
  const maxBinCount = bins.length ? Math.max(...bins.map((bin: { count: number }) => bin.count), 1) : 1;
  const yTicks = type === "histogram" ? axisTicks(0, maxBinCount, 4) : axisTicks(valueMin, valueMax, 4);
  const xTicks = type === "histogram" ? axisTicks(minValue, maxValue, 4) : indexedAxisTicks(values.length, 5);
  const histogramSpan = Math.max(1, maxValue - minValue);
  const histogramXFor = (value: number) => padding + ((value - minValue) / histogramSpan) * innerWidth;
  const countYFor = (count: number) => height - padding - (count / Math.max(1, maxBinCount)) * innerHeight;
  const barWidth = type === "bar" ? Math.max(2, innerWidth / values.length - 3) : 0;
  return (
    <div className="chart-area alt-panel-chart" aria-label={`${workspacePanelTypeLabel(type)} chart for ${metricKey}`} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {yTicks.map((tick: number) => {
          const y = type === "histogram" ? countYFor(tick) : yFor(tick);
          return (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={padding} x2={width - padding} y1={y} y2={y} />
              <text className="tick-label" x={padding - 10} y={y + 4} textAnchor="end">{type === "histogram" ? formatNumber(tick, 0) : formatNumber(tick, 2)}</text>
            </g>
          );
        })}
        {xTicks.map((tick: number) => {
          const x = type === "histogram" ? histogramXFor(tick) : xFor(tick);
          const label = type === "histogram" ? formatAxisValue(tick) : `#${tick + 1}`;
          return (
            <g key={`x-${tick}`}>
              <line className="grid-line vertical" x1={x} x2={x} y1={padding} y2={height - padding} />
              <text className="tick-label" x={x} y={height - padding + 20} textAnchor="middle">{label}</text>
            </g>
          );
        })}
        <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{type === "histogram" ? metricTitle(metricKey) : "Selected run order"}</text>
        <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>{type === "histogram" ? "Count" : metricTitle(metricKey)}</text>
        {type === "histogram" ? bins.map((bin: { min: number; max: number; count: number }, index: number) => {
          const widthPerBin = bins.length === 1 ? innerWidth : histogramXFor(bin.max) - histogramXFor(bin.min);
          const barHeight = (bin.count / Math.max(1, maxBinCount)) * innerHeight;
          const binX = (bins.length === 1 ? padding : histogramXFor(bin.min)) + 2;
          const binY = height - padding - barHeight;
          const binLabel = `${formatAxisValue(bin.min)}-${formatAxisValue(bin.max)}`;
          return (
            <rect
              aria-label={`${binLabel}: ${bin.count} runs`}
              className={`histogram-bar${hover?.id === binLabel ? " active" : ""}`}
              height={barHeight}
              key={`${bin.min}-${bin.max}`}
              onMouseEnter={() => setHover({ id: binLabel, title: binLabel, value: `${bin.count} run${bin.count === 1 ? "" : "s"}`, detail: metricTitle(metricKey), x: binX + Math.max(2, widthPerBin - 4) / 2, y: binY })}
              rx="3"
              width={Math.max(2, widthPerBin - 4)}
              x={binX}
              y={binY}
            >
              <title>{`${binLabel}: ${bin.count}`}</title>
            </rect>
          );
        }) : null}
        {type === "bar" ? values.map((item, index) => {
          const y = yFor(Math.max(item.value, paddedMin));
          const zeroY = yFor(0);
          const top = Math.min(y, zeroY);
          const barHeight = Math.max(2, Math.abs(zeroY - y));
          const label = `${item.name}: ${formatAxisValue(item.value)}`;
          const colorIndex = valueStyleIndexes[index] ?? stableChartIndex(item.id || item.name, index);
          return (
            <rect
              aria-label={label}
              className={`summary-bar${hover?.id === item.id ? " active" : ""}`}
              height={barHeight}
              key={item.id}
              onMouseEnter={() => setHover({ id: item.id, title: item.name, value: formatAxisValue(item.value), detail: metricTitle(metricKey), x: xFor(index), y: top })}
              rx="3"
              style={{ fill: chartColor(colorIndex) }}
              width={barWidth}
              x={xFor(index) - barWidth / 2}
              y={top}
            >
              <title>{label}</title>
            </rect>
          );
        }) : null}
        {type === "dot" ? values.map((item, index) => {
          const x = xFor(index);
          const y = yFor(item.value);
          const label = `${item.name}: ${formatAxisValue(item.value)}`;
          const colorIndex = valueStyleIndexes[index] ?? stableChartIndex(item.id || item.name, index);
          return (
            <circle
              aria-label={label}
              className={`summary-dot${hover?.id === item.id ? " active" : ""}`}
              cx={x}
              cy={y}
              fill={chartColor(colorIndex)}
              key={item.id}
              onMouseEnter={() => setHover({ id: item.id, title: item.name, value: formatAxisValue(item.value), detail: metricTitle(metricKey), x, y })}
              r="3.8"
            >
              <title>{label}</title>
            </circle>
          );
        }) : null}
      </svg>
      {hover ? <AltChartTooltip hover={hover} width={width} height={height} /> : null}
      <div className="chart-legend compact-legend">
        <span className="legend-chip">{values.length} latest values</span>
        {type === "histogram" ? <span className="legend-chip">{bins.length} bins</span> : <span className="legend-chip">{metricKey}</span>}
      </div>
    </div>
  );
}

function ScatterPanelChart({
  height,
  missingCount,
  points,
  scopeLabel,
  width,
  xField,
  yField,
}: {
  height: number;
  missingCount: number;
  points: Array<{ id: string; name: string; x: number; y: number }>;
  scopeLabel: string;
  width: number;
  xField: string;
  yField: string;
}) {
  const [hover, setHover] = useState<AltChartHover | null>(null);
  const pointStyleIndexes = useMemo(() => chartStyleIndexesForItems(points), [points]);
  const xLabel = fieldLabel(xField);
  const yLabel = fieldLabel(yField);
  const title = `Scatter chart for ${xLabel} and ${yLabel}`;
  if (!points.length) {
    const emptyMessage = missingCount > 0
      ? "Selected fields are not available as numeric values in the current page or selection."
      : "No runs in the current panel scope.";
    return <div className="chart-area" aria-label={title}><div className="empty">{emptyMessage}</div></div>;
  }
  const padding = isCreatedTimeField(yField) ? 68 : 54;
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const xDomain = minX === maxX ? { min: minX - 1, max: maxX + 1 } : { min: minX, max: maxX };
  const yDomain = minY === maxY ? { min: minY - 1, max: maxY + 1 } : { min: minY, max: maxY };
  const xScaleSpan = Math.max(1e-9, xDomain.max - xDomain.min);
  const yScaleSpan = Math.max(1e-9, yDomain.max - yDomain.min);
  const xFor = (value: number) => padding + ((value - xDomain.min) / xScaleSpan) * innerWidth;
  const yFor = (value: number) => height - padding - ((value - yDomain.min) / yScaleSpan) * innerHeight;
  const xTicks = axisTicks(xDomain.min, xDomain.max, 5);
  const yTicks = axisTicks(yDomain.min, yDomain.max, 4);
  const compactXLabel = truncateMiddle(xLabel, 34);
  const compactYLabel = truncateMiddle(yLabel, 34);
  const compactPairLabel = `${truncateMiddle(xLabel, 34)} x ${truncateMiddle(yLabel, 34)}`;
  return (
    <div className="chart-area alt-panel-chart scatter-panel-chart" aria-label={title} onMouseLeave={() => setHover(null)}>
      <svg aria-label={title} viewBox={`0 0 ${width} ${height}`} role="img">
        <title>{title}</title>
        {yTicks.map((tick: number) => {
          const y = yFor(tick);
          const label = formatScatterTick(tick, yField, yTicks);
          return (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={padding} x2={width - padding} y1={y} y2={y} />
              <text className="tick-label" x={padding - 10} y={y + 4} textAnchor="end">{label}</text>
            </g>
          );
        })}
        {xTicks.map((tick: number) => {
          const x = xFor(tick);
          const label = formatScatterTick(tick, xField, xTicks);
          return (
            <g key={`x-${tick}`}>
              <line className="grid-line vertical" x1={x} x2={x} y1={padding} y2={height - padding} />
              <text className="tick-label" x={x} y={height - padding + 20} textAnchor="middle">{label}</text>
            </g>
          );
        })}
        <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle"><title>{xLabel}</title>{compactXLabel}</text>
        <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}><title>{yLabel}</title>{compactYLabel}</text>
        {points.map((point, index) => {
          const x = xFor(point.x);
          const y = yFor(point.y);
          const xValue = formatScatterValue(point.x, xField, xTicks);
          const yValue = formatScatterValue(point.y, yField, yTicks);
          const label = `${point.name}: ${xLabel} ${xValue}, ${yLabel} ${yValue}`;
          return (
            <circle
              aria-label={label}
              className={`scatter-dot${hover?.id === point.id ? " active" : ""}`}
              cx={x}
              cy={y}
              fill={chartColor(pointStyleIndexes[index] ?? stableChartIndex(point.id || point.name, index))}
              key={point.id}
              onMouseEnter={() => setHover({ id: point.id, title: point.name, value: `${compactXLabel}: ${xValue}`, detail: `${compactYLabel}: ${yValue}`, x, y })}
              r="4"
            >
              <title>{label}</title>
            </circle>
          );
        })}
      </svg>
      {hover ? <AltChartTooltip hover={hover} width={width} height={height} /> : null}
      <div className="chart-legend compact-legend">
        <span className="legend-chip">{points.length} plotted / {scopeLabel}</span>
        {missingCount ? <span className="legend-chip">{missingCount} missing fields</span> : null}
        <span className="legend-chip" title={`${xLabel} x ${yLabel}`}>{compactPairLabel}</span>
      </div>
    </div>
  );
}

function AltChartTooltip({ height, hover, width }: { height: number; hover: AltChartHover; width: number }) {
  return (
    <div
      className="alt-chart-tooltip"
      role="tooltip"
      style={{
        left: `${Math.min(82, Math.max(18, (hover.x / width) * 100))}%`,
        top: `${Math.min(76, Math.max(18, (hover.y / height) * 100))}%`,
      }}
    >
      <strong>{hover.title}</strong>
      <span>{hover.value}</span>
      {hover.detail ? <em>{hover.detail}</em> : null}
    </div>
  );
}

export function WorkspacePanelCard({
  className = "",
  onDragEnd,
  onDragStart,
  onDropBefore,
  onDuplicate,
  onEdit,
  onFullscreen,
  onPointerMoveStart,
  onRemove,
  onResize,
  panel,
  panelSearchActive = false,
  section,
  selectedRunIds,
  view,
  workspacePanelRuns,
  workspaceSeries,
}: {
  className?: string;
  onDragEnd?: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDropBefore?: (event: DragEvent<HTMLElement>) => void;
  onDuplicate?: () => void;
  onEdit?: () => void;
  onFullscreen?: () => void;
  onPointerMoveStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onRemove?: () => void;
  onResize?: (layout: WorkspacePanelLayout) => void;
  panel: WorkspacePanel;
  panelSearchActive?: boolean;
  section: WorkspaceSection;
  selectedRunIds: string[];
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  const [panelHover, setPanelHover] = useState<HoverPoint>(null);
  const [panelZoomRange, setPanelZoomRange] = useState<{ min: number; max: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<WorkspacePanelLayout | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{ x: number; y: number } | null>(null);
  const resizeCleanupRef = useRef<() => void>(() => {});
  const settings = useMemo(() => resolveWorkspaceSettings(view, section, panel), [panel, section, view]);
  const layout = useMemo(() => resizePreview ?? normalizedPanelLayout(panel.layout), [panel.layout, resizePreview]);
  const isFullscreenPanel = className.split(/\s+/).includes("fullscreen-panel-card");
  const panelChartWidth = isFullscreenPanel ? 920 : chartWidth;
  const panelChartHeight = isFullscreenPanel ? 430 : chartHeight;
  const panelChartPadding = isFullscreenPanel ? 60 : chartPadding;
  const panelStyle = {
    "--panel-grid-span": layout.w,
    "--panel-row-span": layout.h,
    "--panel-min-height": `${layout.h * 78}px`,
    "--panel-chart-min-height": `${layout.h * 54}px`,
  } as CSSProperties;
  const selectedRunKey = useMemo(() => selectedRunIds.join("\u0000"), [selectedRunIds]);
  const linePanel = panel.type === "line";
  const scatterPanel = panel.type === "scatter";
  const explicitSelectionActive = selectedRunIds.length > 0;
  const panelRuns = useMemo(() => (
    explicitSelectionActive
      ? workspacePanelRuns.slice(0, scatterPanel ? settings.maxRuns : MAX_SELECTED_RUNS)
      : workspacePanelRuns.slice(0, settings.maxRuns)
  ), [explicitSelectionActive, scatterPanel, settings.maxRuns, workspacePanelRuns]);
  const selectedOverflow = explicitSelectionActive && workspacePanelRuns.length > panelRuns.length;
  const panelScopeLabel = explicitSelectionActive
    ? selectedOverflow ? `${panelRuns.length}/${workspacePanelRuns.length} selected` : `${panelRuns.length} selected`
    : `${panelRuns.length} current page`;
  const cappedPanelScopeLabel = selectedOverflow ? `${panelScopeLabel} (capped)` : panelScopeLabel;
  const panelRunIds = useMemo(() => linePanel ? new Set(panelRuns.map((run) => run.id)) : null, [linePanel, panelRuns]);
  const runLookup = useMemo(() => linePanel ? new Map(panelRuns.map((run) => [run.id, run])) : null, [linePanel, panelRuns]);
  const scatterXField = panel.xField;
  const scatterYField = panel.yField;
  const scatterXLabel = scatterXField ? fieldLabel(scatterXField) : "X field";
  const scatterYLabel = scatterYField ? fieldLabel(scatterYField) : "Y field";
  const scatterPairLabel = `${scatterXLabel} x ${scatterYLabel}`;
  const hasFetchedMetric = !linePanel || Object.prototype.hasOwnProperty.call(workspaceSeries, panel.metricKey);
  const rawSeries = useMemo(() => (
    !linePanel || !panelRunIds ? [] :
    (workspaceSeries[panel.metricKey] ?? []).filter((item) => panelRunIds.has(item.id) && (item.points?.length ?? 0) > 0)
  ), [linePanel, panel.metricKey, panelRunIds, workspaceSeries]);
  const latestValues = useMemo(() => (
    linePanel || scatterPanel ? [] : latestMetricValues(panelRuns, panel.metricKey)
  ), [linePanel, panel.metricKey, panelRuns, scatterPanel]);
  const scatterPoints = useMemo(() => (
    scatterPanel && scatterXField && scatterYField
      ? scatterPointsForRuns(panelRuns, scatterXField, scatterYField)
      : { points: [], missing: scatterPanel ? panelRuns.length : 0 }
  ), [panelRuns, scatterPanel, scatterXField, scatterYField]);
  const loadingSeries = linePanel && panelRuns.length > 0 && !hasFetchedMetric;
  const plottedSeriesCount = linePanel ? rawSeries.length : scatterPanel ? scatterPoints.points.length : latestValues.length;
  const missingSeriesCount = scatterPanel ? scatterPoints.missing : Math.max(0, panelRuns.length - plottedSeriesCount);
  const plottedRunLabel = explicitSelectionActive
    ? loadingSeries
      ? `loading ${panelScopeLabel}`
      : `${plottedSeriesCount} plotted / ${panelScopeLabel}`
    : loadingSeries
      ? `loading ${panelRuns.length} current page`
      : `${plottedSeriesCount}/${panelRuns.length} current page`;
  const groupedSeries = useMemo(() => rawSeries.map((item) => {
    if (!linePanel) return item;
    const run = runLookup?.get(item.id);
    return { ...item, group: run ? groupKeyForRun(run, settings.groupBy) : item.group ?? "all" };
  }), [linePanel, rawSeries, runLookup, settings.groupBy]);
  const preparedSeries = useMemo(() => (
    !linePanel ? [] :
    smoothSeries(settings.groupAverage ? averageGroupedSeries(groupedSeries) : groupedSeries, settings.smoothing)
  ), [groupedSeries, linePanel, settings.groupAverage, settings.smoothing]);
  const fullDomain = useMemo(() => (
    linePanel ? chartDomain(preparedSeries, settings.xMode, panel.metricKey) : null
  ), [linePanel, panel.metricKey, preparedSeries, settings.xMode]);
  const rangeSeries = useMemo(() => (
    !linePanel ? [] :
    normalizeSeries(preparedSeries, panelChartWidth, panelChartHeight, panelChartPadding, settings.xMode, panel.metricKey)
  ), [linePanel, panel.metricKey, panelChartHeight, panelChartPadding, panelChartWidth, preparedSeries, settings.xMode]);
  const normalized = useMemo(() => (
    !linePanel ? [] :
    normalizeSeries(preparedSeries, panelChartWidth, panelChartHeight, panelChartPadding, settings.xMode, panel.metricKey, panelZoomRange)
  ), [linePanel, panel.metricKey, panelChartHeight, panelChartPadding, panelChartWidth, panelZoomRange, preparedSeries, settings.xMode]);
  const domain = useMemo(() => (
    linePanel ? chartDomain(preparedSeries, settings.xMode, panel.metricKey, panelZoomRange) : null
  ), [linePanel, panel.metricKey, panelZoomRange, preparedSeries, settings.xMode]);
  useEffect(() => {
    setPanelHover(null);
    setPanelZoomRange(null);
  }, [panel.metricKey, panel.type, scatterXField, scatterYField, settings.xMode, settings.groupBy, settings.groupAverage, settings.smoothing, settings.maxRuns, selectedRunKey]);
  useEffect(() => () => {
    if (hoverFrameRef.current !== null) window.cancelAnimationFrame(hoverFrameRef.current);
    resizeCleanupRef.current();
  }, []);
  function handlePanelChartMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, panelChartWidth, panelChartHeight);
    pendingHoverRef.current = { x: point.x, y: point.y };
    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const pending = pendingHoverRef.current;
      if (!pending) return;
      setPanelHover(nearestPoint(normalized, pending.x, pending.y, 28) as HoverPoint);
    });
  }
  function clearPanelHover() {
    pendingHoverRef.current = null;
    if (hoverFrameRef.current !== null) {
      window.cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }
    setPanelHover(null);
  }
  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!onResize) return;
    const commitResize = onResize;
    event.preventDefault();
    event.stopPropagation();
    const card = event.currentTarget.closest<HTMLElement>(".workspace-panel-card");
    const grid = event.currentTarget.closest<HTMLElement>(".workspace-panel-grid");
    if (!card || !grid) return;
    resizeCleanupRef.current();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLayout = normalizedPanelLayout(panel.layout);
    const columnUnit = Math.max(1, grid.getBoundingClientRect().width / 12);
    const rowUnit = 78;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Synthetic pointer events in browser tests may not have an active pointer capture target.
    }
    function cleanupResizeListeners() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch {
        // The target may be gone if React unmounted during a drag.
      }
      resizeCleanupRef.current = () => {};
    }
    function handlePointerMove(pointerEvent: globalThis.PointerEvent) {
      const next = {
        w: Math.max(3, Math.min(12, Math.round(startLayout.w + (pointerEvent.clientX - startX) / columnUnit))),
        h: Math.max(3, Math.min(10, Math.round(startLayout.h + (pointerEvent.clientY - startY) / rowUnit))),
      };
      setResizePreview(next);
    }
    function handlePointerUp(pointerEvent: globalThis.PointerEvent) {
      const next = {
        w: Math.max(3, Math.min(12, Math.round(startLayout.w + (pointerEvent.clientX - startX) / columnUnit))),
        h: Math.max(3, Math.min(10, Math.round(startLayout.h + (pointerEvent.clientY - startY) / rowUnit))),
      };
      setResizePreview(null);
      commitResize(next);
      cleanupResizeListeners();
    }
    function handlePointerCancel() {
      setResizePreview(null);
      cleanupResizeListeners();
    }
    resizeCleanupRef.current = cleanupResizeListeners;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerCancel, { once: true });
  }
  return (
    <article
      className={`workspace-panel-card ${className}`}
      data-panel-id={panel.id}
      data-panel-width={layout.w}
      data-panel-height={layout.h}
      onDragOver={(event) => {
        if (onDropBefore) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDropBefore) return;
        event.preventDefault();
        event.stopPropagation();
        onDropBefore(event);
      }}
      style={panelStyle}
    >
      <div className="workspace-panel-head">
        <div>
          <h3>
            {onDragStart ? (
              <span
                aria-hidden="true"
                className="panel-drag-handle"
                draggable={!panelSearchActive}
                onDragEnd={onDragEnd}
                onDragStart={(event) => {
                  if (panelSearchActive) {
                    event.preventDefault();
                    return;
                  }
                  onDragStart(event);
                }}
                onPointerDown={(event) => {
                  if (panelSearchActive) {
                    event.preventDefault();
                    return;
                  }
                  onPointerMoveStart?.(event);
                }}
                title={panelSearchActive ? "Clear panel search before rearranging panels" : "Drag to move panel"}
              >
                <GripVertical size={14} />
              </span>
            ) : null}
            <span className="panel-title-text">{panel.title}</span>
          </h3>
          <small title={scatterPanel ? scatterPairLabel : panel.metricKey}>{workspacePanelTypeLabel(panel.type)} · {scatterPanel ? truncateMiddle(scatterPairLabel, 84) : panel.metricKey} · {plottedRunLabel}</small>
        </div>
        <div className="panel-card-actions">
          {onEdit ? <button className="icon-button" type="button" aria-label={`Edit ${panel.title}`} onClick={onEdit}><Pencil size={15} /></button> : null}
          {onDuplicate ? <button className="icon-button" type="button" aria-label={`Duplicate ${panel.title}`} onClick={onDuplicate}><CopyPlus size={15} /></button> : null}
          {onFullscreen ? <button className="icon-button" type="button" aria-label={`Fullscreen ${panel.title}`} onClick={onFullscreen}><Maximize2 size={15} /></button> : null}
          {onRemove ? <button className="icon-button" type="button" aria-label={`Remove ${panel.title}`} onClick={onRemove}><Trash2 size={15} /></button> : null}
        </div>
      </div>
      <div className="workspace-panel-meta">
        {scatterPanel ? (
          <>
            <span title={scatterXLabel}>X {truncateMiddle(scatterXLabel, 44)}</span>
            <span title={scatterYLabel}>Y {truncateMiddle(scatterYLabel, 44)}</span>
            <span>Summary values</span>
          </>
        ) : (
          <>
            <span>{settings.xMode === "time" ? "Logged time" : "Step"}</span>
            <span>{settings.groupBy ? `Grouped by ${settings.groupBy}` : "Ungrouped"}</span>
            <span>{settings.smoothing ? `Smooth ${settings.smoothing}` : "Full fidelity"}</span>
          </>
        )}
        <span>{cappedPanelScopeLabel}</span>
        {missingSeriesCount && !loadingSeries ? <span className="panel-data-gap">{scatterPanel ? `${missingSeriesCount} missing field values` : `${missingSeriesCount} no data for metric`}</span> : null}
      </div>
      {loadingSeries ? (
        <div className="chart-area workspace-chart-loading" aria-label={`Loading ${panel.title} metric series`}>
          <div className="chart-loading-frame">
            <span />
            <span />
            <span />
          </div>
          <div className="empty">Loading metric series...</div>
        </div>
      ) : (
        linePanel ? (
          <MetricChart
            domain={domain}
            emptyMessage={panelRuns.length ? "No logged series for this metric in the current run set." : undefined}
            exportFilenameBase={`instantml-${panel.metricKey}`}
            fullDomain={fullDomain}
            height={panelChartHeight}
            hover={panelHover}
            metricKey={panel.metricKey}
            normalizedSeries={normalized}
            onMove={handlePanelChartMove}
            onPointHover={setPanelHover}
            onLeave={clearPanelHover}
            onZoomRangeChange={setPanelZoomRange}
            padding={panelChartPadding}
            rangeSeries={rangeSeries}
            width={panelChartWidth}
            xMode={settings.xMode}
            zoomRange={panelZoomRange}
          />
        ) : scatterPanel ? (
          scatterXField && scatterYField ? (
            <ScatterPanelChart
              height={panelChartHeight}
              missingCount={scatterPoints.missing}
              points={scatterPoints.points}
              scopeLabel={cappedPanelScopeLabel}
              width={panelChartWidth}
              xField={scatterXField}
              yField={scatterYField}
            />
          ) : (
            <div className="chart-area" aria-label={`Missing scatter fields for ${panel.title}`}>
              <div className="empty">Select numeric X and Y fields for this scatter panel.</div>
            </div>
          )
        ) : (
          <LatestMetricPanelChart
            height={panelChartHeight}
            metricKey={panel.metricKey}
            padding={panelChartPadding}
            type={panel.type as Exclude<WorkspacePanelType, "line" | "scatter">}
            values={latestValues}
            width={panelChartWidth}
          />
        )
      )}
      {onResize ? (
        <button
          aria-label={`Resize ${panel.title}`}
          className="panel-resize-handle"
          onPointerDown={handleResizeStart}
          title="Drag to resize panel"
          type="button"
        />
      ) : null}
    </article>
  );
}

export function WorkspaceSectionView({
  onDuplicatePanel,
  onEditPanel,
  onFullscreenPanel,
  onPanelDragEnd,
  onPanelDragStart,
  onPanelDrop,
  onPanelPointerMoveStart,
  onRemovePanel,
  onResizePanel,
  onToggleSection,
  panelSearchActive,
  section,
  selectedRunIds,
  visiblePanels,
  view,
  workspacePanelRuns,
  workspaceSeries,
}: {
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onPanelDragEnd: () => void;
  onPanelDragStart: (event: DragEvent<HTMLElement>, sectionId: string, panelId: string) => void;
  onPanelDrop: (event: DragEvent<HTMLElement>, targetSectionId: string, targetIndex: number) => void;
  onPanelPointerMoveStart: (event: ReactPointerEvent<HTMLElement>, sectionId: string, panelId: string) => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onResizePanel: (sectionId: string, panelId: string, layout: WorkspacePanelLayout) => void;
  onToggleSection: (sectionId: string) => void;
  panelSearchActive: boolean;
  section: WorkspaceSection;
  selectedRunIds: string[];
  visiblePanels: WorkspacePanel[];
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  return (
    <section className={`workspace-section ${section.collapsed ? "collapsed" : ""}`} data-section-id={section.id}>
      <div className="workspace-section-head">
        <button className="section-title-button" type="button" onClick={() => onToggleSection(section.id)}>
          <ChevronDown size={15} /> <strong>{section.name}</strong> <span>{section.panels.length}</span>
        </button>
      </div>
      {!section.collapsed ? (
        <div
          className="workspace-panel-grid"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => onPanelDrop(event, section.id, section.panels.length)}
        >
          {visiblePanels.length ? visiblePanels.map((panel) => {
            const panelIndex = Math.max(0, section.panels.findIndex((item) => item.id === panel.id));
            return (
              <WorkspacePanelCard
                key={panel.id}
                onDragEnd={onPanelDragEnd}
                onDragStart={(event) => onPanelDragStart(event, section.id, panel.id)}
                onDropBefore={(event) => onPanelDrop(event, section.id, panelIndex)}
                onDuplicate={() => onDuplicatePanel(section.id, panel.id)}
                onEdit={() => onEditPanel(section.id, panel.id)}
                onFullscreen={() => onFullscreenPanel(section.id, panel.id)}
                onPointerMoveStart={(event) => onPanelPointerMoveStart(event, section.id, panel.id)}
                onRemove={() => onRemovePanel(section.id, panel.id)}
                onResize={(layout) => onResizePanel(section.id, panel.id, layout)}
                panel={panel}
                panelSearchActive={panelSearchActive}
                section={section}
                selectedRunIds={selectedRunIds}
                view={view}
                workspacePanelRuns={workspacePanelRuns}
                workspaceSeries={workspaceSeries}
              />
            );
          }) : <div className="empty workspace-empty">No panels in this section yet. Drag a panel here or add one from the top toolbar.</div>}
        </div>
      ) : null}
    </section>
  );
}
