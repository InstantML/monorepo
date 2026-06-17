"use client";

import { ChevronDown, CopyPlus, GripVertical, Maximize2, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { averageGroupedSeries, axisTicks, formatAxisTick, formatAxisValue, formatMetricValue, smoothSeries } from "../../../src/charts.js";
import { chartColor, chartStyleIndexesForItems, stableChartIndex } from "../../../src/chart-colors.js";
import { categoricalFieldLabel, distributionSummaryForRuns, fieldLabel, histogramBins, indexedAxisTicks, latestMetricValues, parseFieldId, scatterPointsForRuns } from "../../../src/dashboard-panels.js";
import { MAX_SELECTED_RUNS, groupKeyForRun, formatNumber } from "../../../src/state.js";
import { useMeasuredSize } from "../ui/use-measured-size";
import {
  chartHeight,
  chartPadding,
  chartWidth,
  MIN_LINE_WORKSPACE_PANEL_ROWS,
  MIN_WORKSPACE_PANEL_ROWS,
  metricTitle,
  workspacePanelTypeLabel,
} from "../../dashboard-models";
import { MetricChart } from "../metrics/metric-chart";
import { CustomSelect } from "../ui/select";
import { useDetailsDismiss } from "../ui/use-details-dismiss";
import { normalizedPanelLayout, resolveWorkspaceSettings } from "./panel-settings";
import type { HistogramTimelineState, HoverPoint, MetricSeries, RunSummary, WorkspacePanel, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceSection, WorkspaceView } from "../../dashboard-types";

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
  const distributionFields = panel.type === "distribution" ? `${fieldLabel(panel.valueField)} ${panel.groupField ? categoricalFieldLabel(panel.groupField) : ""} ${panel.replicateField ? categoricalFieldLabel(panel.replicateField) : ""}` : "";
  const objectFields = panel.type === "histogram_timeline" ? panel.objectKey : "";
  return `${section.name} ${panel.title} ${panel.metricKey} ${workspacePanelTypeLabel(panel.type)} ${scatterFields} ${distributionFields} ${objectFields}`.toLowerCase().includes(needle);
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
  height: fallbackHeight,
  metricKey,
  padding,
  type,
  values,
  width: fallbackWidth,
}: {
  height: number;
  metricKey: string;
  padding: number;
  type: Exclude<WorkspacePanelType, "line" | "scatter">;
  values: Array<{ id: string; index: number; name: string; value: number }>;
  width: number;
}) {
  const [hover, setHover] = useState<AltChartHover | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useMeasuredSize(frameRef, fallbackWidth, fallbackHeight);
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
      <div className="alt-chart-frame" ref={frameRef}>
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
      </div>
      <div className="chart-legend compact-legend">
        <span className="legend-chip">{values.length} latest values</span>
        {type === "histogram" ? <span className="legend-chip">{bins.length} bins</span> : <span className="legend-chip">{metricKey}</span>}
      </div>
    </div>
  );
}

function ScatterPanelChart({
  height: fallbackHeight,
  missingCount,
  points,
  scopeLabel,
  width: fallbackWidth,
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
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useMeasuredSize(frameRef, fallbackWidth, fallbackHeight);
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
      <div className="alt-chart-frame" ref={frameRef}>
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
      </div>
      <div className="chart-legend compact-legend">
        <span className="legend-chip">{points.length} plotted / {scopeLabel}</span>
        {missingCount ? <span className="legend-chip">{missingCount} missing fields</span> : null}
        <span className="legend-chip" title={`${xLabel} x ${yLabel}`}>{compactPairLabel}</span>
      </div>
    </div>
  );
}

function DistributionPanelChart({
  groupField,
  height: fallbackHeight,
  replicateField,
  scopeLabel,
  summary,
  valueField,
  width: fallbackWidth,
}: {
  groupField?: string;
  height: number;
  replicateField?: string;
  scopeLabel: string;
  summary: ReturnType<typeof distributionSummaryForRuns>;
  valueField: string;
  width: number;
}) {
  const [hover, setHover] = useState<AltChartHover | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useMeasuredSize(frameRef, fallbackWidth, fallbackHeight);
  const valueLabel = fieldLabel(valueField);
  const groupLabel = groupField ? categoricalFieldLabel(groupField) : "Ungrouped";
  const replicateLabel = replicateField ? categoricalFieldLabel(replicateField) : "";
  const groups = summary.groups;
  const replicateValues = groups.reduce((sum, group) => sum + group.replicateCount, 0);
  const semGroups = groups.filter((group) => group.sem !== null).length;
  const sampledGroups = groups.filter((group) => group.stripPointTotal > group.stripPoints.length).length;
  if (!groups.length) {
    return (
      <div className="chart-area" aria-label={`Distribution chart for ${valueLabel}`}>
        <div className="empty">No finite values for this distribution in the current scope.</div>
      </div>
    );
  }
  const padding = 58;
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const minValue = Math.min(...groups.map((group) => group.min ?? Infinity));
  const maxValue = Math.max(...groups.map((group) => group.max ?? -Infinity));
  const domainMin = minValue === maxValue ? minValue - 1 : minValue;
  const domainMax = minValue === maxValue ? maxValue + 1 : maxValue;
  const yFor = (value: number) => height - padding - ((value - domainMin) / Math.max(1e-9, domainMax - domainMin)) * innerHeight;
  const xFor = (index: number) => padding + (groups.length === 1 ? innerWidth / 2 : (index / (groups.length - 1)) * innerWidth);
  const yTicks = axisTicks(domainMin, domainMax, 4);
  const groupWidth = Math.max(24, Math.min(72, innerWidth / Math.max(1, groups.length) * 0.5));
  return (
    <div className="chart-area alt-panel-chart distribution-panel-chart" aria-label={`Distribution chart for ${valueLabel}`} onMouseLeave={() => setHover(null)}>
      <div className="alt-chart-frame" ref={frameRef}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {yTicks.map((tick: number) => {
          const y = yFor(tick);
          return (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={padding} x2={width - padding} y1={y} y2={y} />
              <text className="tick-label" x={padding - 10} y={y + 4} textAnchor="end">{formatAxisTick(tick)}</text>
            </g>
          );
        })}
        <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{truncateMiddle(groupLabel, 34)}</text>
        <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>{truncateMiddle(valueLabel, 34)}</text>
        {groups.map((group, groupIndex) => {
          const x = xFor(groupIndex);
          const color = chartColor(groupIndex);
          const canBox = group.n >= 5 && group.q1 !== null && group.q3 !== null && group.min !== null && group.max !== null && group.median !== null;
          return (
            <g key={group.label}>
              <line className="grid-line vertical" x1={x} x2={x} y1={padding} y2={height - padding} />
              <text className="tick-label" x={x} y={height - padding + 20} textAnchor="middle">
                <title>{group.label}</title>{truncateMiddle(group.label, Math.max(8, Math.floor(44 / groups.length)))}
              </text>
              {canBox ? (
                <>
                  <line className="distribution-whisker" x1={x} x2={x} y1={yFor(group.min as number)} y2={yFor(group.max as number)} stroke={color} />
                  <rect
                    className="distribution-box"
                    fill={color}
                    height={Math.max(2, yFor(group.q1 as number) - yFor(group.q3 as number))}
                    opacity="0.18"
                    rx="4"
                    stroke={color}
                    width={groupWidth}
                    x={x - groupWidth / 2}
                    y={yFor(group.q3 as number)}
                  />
                </>
              ) : null}
              {group.median !== null ? (
                <line className="distribution-median" x1={x - groupWidth / 2} x2={x + groupWidth / 2} y1={yFor(group.median)} y2={yFor(group.median)} stroke={color} />
              ) : null}
              {group.mean !== null && group.sem !== null ? (
                <g className="distribution-sem" aria-hidden="true">
                  <line x1={x + groupWidth * 0.68} x2={x + groupWidth * 0.68} y1={yFor(group.mean - group.sem)} y2={yFor(group.mean + group.sem)} stroke={color} />
                  <line x1={x + groupWidth * 0.54} x2={x + groupWidth * 0.82} y1={yFor(group.mean - group.sem)} y2={yFor(group.mean - group.sem)} stroke={color} />
                  <line x1={x + groupWidth * 0.54} x2={x + groupWidth * 0.82} y1={yFor(group.mean + group.sem)} y2={yFor(group.mean + group.sem)} stroke={color} />
                </g>
              ) : null}
              {group.stripPoints.map((point, pointIndex) => {
                const jitter = ((pointIndex % 7) - 3) * 3;
                const pointX = x + jitter;
                const pointY = yFor(point.value);
                return (
                  <circle
                    className={`summary-dot${hover?.id === `${group.label}-${point.id}` ? " active" : ""}`}
                    cx={pointX}
                    cy={pointY}
                    fill={color}
                    key={`${group.label}-${point.id}`}
                    onMouseEnter={() => setHover({ id: `${group.label}-${point.id}`, title: point.name, value: formatAxisValue(point.value), detail: `${group.label} · n=${group.n}`, x: pointX, y: pointY })}
                    r="3"
                  >
                    <title>{`${point.name}: ${formatAxisValue(point.value)} (${group.label})`}</title>
                  </circle>
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover ? <AltChartTooltip hover={hover} width={width} height={height} /> : null}
      </div>
      <div className="chart-legend compact-legend">
        <span className="legend-chip">{summary.plotted} plotted / {scopeLabel}</span>
        {summary.missing ? <span className="legend-chip">{summary.missing} missing</span> : null}
        <span className="legend-chip">{groups.length} {groups.length === 1 ? "group" : "groups"} · median</span>
        {replicateField ? <span className="legend-chip" title={replicateLabel}>{replicateValues} replicate values</span> : null}
        {semGroups ? <span className="legend-chip">{semGroups} SEM estimates</span> : null}
        {sampledGroups ? <span className="legend-chip">Strip points sampled</span> : null}
        {groups.some((group) => group.n < 5) ? <span className="legend-chip">Small groups: strip + median</span> : null}
      </div>
    </div>
  );
}

function HistogramTimelinePanelChart({
  height: fallbackHeight,
  objectKey,
  timeline,
  width: fallbackWidth,
}: {
  height: number;
  objectKey: string;
  timeline?: HistogramTimelineState;
  width: number;
}) {
  const frames = timeline?.frames ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hover, setHover] = useState<AltChartHover | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useMeasuredSize(frameRef, fallbackWidth, fallbackHeight);
  useEffect(() => {
    setSelectedIndex(Math.max(0, frames.length - 1));
    setHover(null);
  }, [frames.length, objectKey, timeline?.runId]);

  if (!objectKey) {
    return (
      <div className="chart-area alt-panel-chart histogram-timeline-panel-chart" aria-label="Logged histogram timeline">
        <div className="empty">Choose a histogram object key.</div>
      </div>
    );
  }
  if (timeline?.capped) {
    return (
      <div className="chart-area alt-panel-chart histogram-timeline-panel-chart" aria-label={`Logged histogram timeline for ${objectKey}`}>
        <div className="empty">Only the first 3 visible logged histogram timelines load frames.</div>
      </div>
    );
  }
  if (timeline?.loading) {
    return (
      <div className="chart-area workspace-chart-loading" aria-label={`Loading logged histogram timeline for ${objectKey}`}>
        <div className="chart-loading-frame">
          <span />
          <span />
          <span />
        </div>
        <div className="empty">Loading logged histogram frames...</div>
      </div>
    );
  }
  if (timeline?.error) {
    return (
      <div className="chart-area alt-panel-chart histogram-timeline-panel-chart" aria-label={`Logged histogram timeline for ${objectKey}`}>
        <div className="empty">{timeline.error}</div>
      </div>
    );
  }
  if (!timeline) {
    return (
      <div className="chart-area alt-panel-chart histogram-timeline-panel-chart" aria-label={`Logged histogram timeline for ${objectKey}`}>
        <div className="empty">Select one run to load logged histogram frames.</div>
      </div>
    );
  }
  if (!frames.length) {
    return (
      <div className="chart-area alt-panel-chart histogram-timeline-panel-chart" aria-label={`Logged histogram timeline for ${objectKey}`}>
        <div className="empty">No histogram frames for this key in the primary run.</div>
        <div className="chart-legend compact-legend">
          <span className="legend-chip">Primary run only</span>
          {timeline.invalid ? <span className="legend-chip">{timeline.invalid} invalid frames hidden</span> : null}
        </div>
      </div>
    );
  }

  const latestIndex = frames.length - 1;
  const boundedIndex = Math.min(Math.max(0, selectedIndex), latestIndex);
  const selectedFrame = frames[boundedIndex] ?? frames[latestIndex];
  const padding = 58;
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const maxCount = Math.max(1, ...frames.flatMap((frame) => frame.counts));
  const heatmapBinCount = timeline.compatibleBins ? Math.max(...frames.map((frame) => frame.counts.length)) : 0;
  const heatmapStride = Math.max(1, Math.ceil(heatmapBinCount / 96));
  const heatmapRows = timeline.compatibleBins ? Math.ceil(heatmapBinCount / heatmapStride) : 0;
  const xForFrame = (index: number) => padding + (index / Math.max(1, frames.length)) * innerWidth;
  const frameCellWidth = Math.max(1, innerWidth / Math.max(1, frames.length));
  const rowCellHeight = Math.max(1, innerHeight / Math.max(1, heatmapRows));
  const selectedX = xForFrame(boundedIndex);
  const selectedYTicks = axisTicks(0, Math.max(1, ...selectedFrame.counts), 4);
  const barStride = Math.max(1, Math.ceil(selectedFrame.counts.length / 80));
  const bars = Array.from({ length: Math.ceil(selectedFrame.counts.length / barStride) }, (_, index) => {
    const start = index * barStride;
    const end = Math.min(selectedFrame.counts.length, start + barStride);
    return {
      count: selectedFrame.counts.slice(start, end).reduce((sum, count) => sum + count, 0),
      end,
      start,
    };
  });
  const barMax = Math.max(1, ...bars.map((bar) => bar.count));
  const yForBarCount = (count: number) => height - padding - (count / Math.max(1, barMax)) * innerHeight;
  const barWidth = Math.max(1, innerWidth / Math.max(1, bars.length) - 2);

  function binLabel(start: number, end: number) {
    const bins = selectedFrame.bins;
    if (bins.length === selectedFrame.counts.length + 1) {
      return `${formatAxisTick(bins[start])}-${formatAxisTick(bins[Math.min(end, bins.length - 1)])}`;
    }
    const first = bins[start];
    const last = bins[Math.max(start, Math.min(end - 1, bins.length - 1))];
    return first === last || last === undefined ? formatAxisTick(first) : `${formatAxisTick(first)}-${formatAxisTick(last)}`;
  }

  return (
    <div className="chart-area alt-panel-chart histogram-timeline-panel-chart" aria-label={`Logged histogram timeline for ${objectKey}`} onMouseLeave={() => setHover(null)}>
      <div className="alt-chart-frame" ref={frameRef}>
      {timeline.compatibleBins ? (
        <svg viewBox={`0 0 ${width} ${height}`} role="img">
          <title>{`${objectKey} logged histogram timeline`}</title>
          {frames.map((frame, frameIndex) => Array.from({ length: heatmapRows }, (_, rowIndex) => {
            const start = rowIndex * heatmapStride;
            const end = Math.min(frame.counts.length, start + heatmapStride);
            const count = frame.counts.slice(start, end).reduce((sum, value) => sum + value, 0);
            const x = xForFrame(frameIndex);
            const y = padding + (heatmapRows - rowIndex - 1) * rowCellHeight;
            const opacity = count <= 0 ? 0.04 : Math.min(0.9, 0.08 + Math.sqrt(count / maxCount) * 0.72);
            return (
              <rect
                className="histogram-heat-cell"
                fill={chartColor(2)}
                fillOpacity={opacity}
                height={Math.max(1, rowCellHeight)}
                key={`${frame.id}-${rowIndex}`}
                onMouseEnter={() => setHover({ id: `${frame.id}-${rowIndex}`, title: `Step ${formatNumber(frame.step, 0)}`, value: `${formatNumber(count, 0)} count`, detail: binLabel(start, end), x: x + frameCellWidth / 2, y })}
                width={Math.max(1, frameCellWidth)}
                x={x}
                y={y}
              >
                <title>{`step ${frame.step}, ${binLabel(start, end)}: ${count}`}</title>
              </rect>
            );
          }))}
          <rect className="histogram-selected-frame" fill="none" height={innerHeight} width={frameCellWidth} x={selectedX} y={padding} />
          <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
          <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
          <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">Frames by step</text>
          <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>Bins</text>
          {[0, Math.floor(latestIndex / 2), latestIndex].filter((value, index, values) => values.indexOf(value) === index).map((index) => (
            <text className="tick-label" key={index} x={xForFrame(index) + frameCellWidth / 2} y={height - padding + 18} textAnchor="middle">{formatNumber(frames[index].step, 0)}</text>
          ))}
        </svg>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img">
          <title>{`${objectKey} latest histogram frame`}</title>
          {selectedYTicks.map((tick) => {
            const y = yForBarCount(tick);
            return (
              <g key={tick}>
                <line className="grid-line" x1={padding} x2={width - padding} y1={y} y2={y} />
                <text className="tick-label" x={padding - 10} y={y + 4} textAnchor="end">{formatNumber(tick, 0)}</text>
              </g>
            );
          })}
          <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
          <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
          <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">Bins</text>
          <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>Count</text>
          {bars.map((bar, index) => {
            const barHeight = (bar.count / Math.max(1, barMax)) * innerHeight;
            const x = padding + (index / Math.max(1, bars.length)) * innerWidth + 1;
            const y = height - padding - barHeight;
            const label = binLabel(bar.start, bar.end);
            return (
              <rect
                className="histogram-bar"
                height={barHeight}
                key={`${bar.start}-${bar.end}`}
                onMouseEnter={() => setHover({ id: label, title: `Step ${formatNumber(selectedFrame.step, 0)}`, value: `${formatNumber(bar.count, 0)} count`, detail: label, x: x + barWidth / 2, y })}
                rx="2"
                width={barWidth}
                x={x}
                y={y}
              >
                <title>{`${label}: ${bar.count}`}</title>
              </rect>
            );
          })}
        </svg>
      )}
      {hover ? <AltChartTooltip hover={hover} width={width} height={height} /> : null}
      </div>
      <label className="histogram-frame-control">
        <span>Frame {boundedIndex + 1}/{frames.length}</span>
        <input
          aria-label="Histogram frame"
          max={latestIndex}
          min={0}
          onChange={(event) => setSelectedIndex(Number(event.target.value))}
          type="range"
          value={boundedIndex}
        />
        <strong>step {formatNumber(selectedFrame.step, 0)}</strong>
      </label>
      <div className="chart-legend compact-legend">
        <span className="legend-chip">{frames.length} frames</span>
        <span className="legend-chip">{timeline.compatibleBins ? "Compatible bins" : "Latest frame: bins changed"}</span>
        {timeline.truncated ? <span className="legend-chip">Latest 100 shown</span> : null}
        {timeline.invalid ? <span className="legend-chip">{timeline.invalid} invalid hidden</span> : null}
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

function closeEnclosingMenu(event: MouseEvent<HTMLButtonElement>) {
  const details = event.currentTarget.closest("details");
  if (details instanceof HTMLDetailsElement) details.open = false;
}

// The panel's lifecycle actions, rendered as a single set of menu rows. They
// live inside the chart's three-dot menu for line panels and a head kebab for
// the other panel types, so a panel never sprouts a separate row of icons.
function panelActionMenuItems({
  onDuplicate,
  onEdit,
  onFullscreen,
  onRemove,
  title,
}: {
  onDuplicate?: () => void;
  onEdit?: () => void;
  onFullscreen?: () => void;
  onRemove?: () => void;
  title: string;
}): ReactNode {
  if (!onEdit && !onDuplicate && !onFullscreen && !onRemove) return null;
  return (
    <>
      {onEdit ? <button className="chart-menu-item" type="button" aria-label={`Edit ${title}`} onClick={(event) => { closeEnclosingMenu(event); onEdit(); }}><Pencil size={14} aria-hidden="true" /> Edit panel</button> : null}
      {onDuplicate ? <button className="chart-menu-item" type="button" aria-label={`Duplicate ${title}`} onClick={(event) => { closeEnclosingMenu(event); onDuplicate(); }}><CopyPlus size={14} aria-hidden="true" /> Duplicate panel</button> : null}
      {onFullscreen ? <button className="chart-menu-item" type="button" aria-label={`Fullscreen ${title}`} onClick={(event) => { closeEnclosingMenu(event); onFullscreen(); }}><Maximize2 size={14} aria-hidden="true" /> Open fullscreen</button> : null}
      {onRemove ? <button className="chart-menu-item chart-menu-item-danger" type="button" aria-label={`Remove ${title}`} onClick={(event) => { closeEnclosingMenu(event); onRemove(); }}><Trash2 size={14} aria-hidden="true" /> Remove panel</button> : null}
    </>
  );
}

// Standalone kebab for panel types without a chart toolbar (scatter,
// distribution, histogram timeline) to hang their actions off.
function PanelHeadMenu({ items, label }: { items: ReactNode; label: string }) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  useDetailsDismiss(detailsRef);
  return (
    <details className="chart-menu panel-head-menu" ref={detailsRef}>
      <summary aria-label={label} title="Panel options">
        <MoreVertical size={16} aria-hidden="true" />
      </summary>
      <div className="chart-menu-pop" aria-label={label}>
        {items}
      </div>
    </details>
  );
}

export function WorkspacePanelCard({
  className = "",
  highlightRunId = null,
  onDragEnd,
  onDragStart,
  onDropBefore,
  onDuplicate,
  onEdit,
  onFullscreen,
  onHighlightRun,
  onPointerMoveStart,
  onRemove,
  onResize,
  onSmoothingChange,
  panel,
  panelSearchActive = false,
  section,
  selectedRunIds,
  view,
  workspaceHistogramTimelines,
  workspacePanelRuns,
  workspaceSeries,
}: {
  className?: string;
  /** R6 cross-highlight from the runs rail; line panels isolate this series. */
  highlightRunId?: string | null;
  onDragEnd?: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDropBefore?: (event: DragEvent<HTMLElement>) => void;
  onDuplicate?: () => void;
  onEdit?: () => void;
  onFullscreen?: () => void;
  /** Reports the hovered series so the rail can highlight the matching run. */
  onHighlightRun?: (runId: string | null) => void;
  onPointerMoveStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onRemove?: () => void;
  onResize?: (layout: WorkspacePanelLayout) => void;
  onSmoothingChange?: (smoothing: number) => void;
  panel: WorkspacePanel;
  panelSearchActive?: boolean;
  section: WorkspaceSection;
  selectedRunIds: string[];
  view: WorkspaceView;
  workspaceHistogramTimelines: Record<string, HistogramTimelineState>;
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
  const layoutMinRows = panel.type === "line" ? MIN_LINE_WORKSPACE_PANEL_ROWS : MIN_WORKSPACE_PANEL_ROWS;
  const layout = useMemo(() => resizePreview ?? normalizedPanelLayout(panel.layout, panel.type), [panel.layout, panel.type, resizePreview]);
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
  const distributionPanel = panel.type === "distribution";
  const histogramTimelinePanel = panel.type === "histogram_timeline";
  const summaryOnlyCappedPanel = scatterPanel || distributionPanel;
  const explicitSelectionActive = selectedRunIds.length > 0;
  const panelRuns = useMemo(() => (
    explicitSelectionActive
      ? workspacePanelRuns.slice(0, summaryOnlyCappedPanel ? settings.maxRuns : MAX_SELECTED_RUNS)
      : workspacePanelRuns.slice(0, settings.maxRuns)
  ), [explicitSelectionActive, settings.maxRuns, summaryOnlyCappedPanel, workspacePanelRuns]);
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
  const distributionValueField = panel.valueField;
  const distributionValueLabel = distributionValueField ? fieldLabel(distributionValueField) : "Value field";
  const distributionGroupLabel = panel.groupField ? categoricalFieldLabel(panel.groupField) : "Ungrouped";
  const histogramObjectKey = panel.objectKey ?? "";
  const histogramTimeline = histogramTimelinePanel ? workspaceHistogramTimelines[histogramObjectKey] : undefined;
  const hasFetchedMetric = !linePanel || Object.prototype.hasOwnProperty.call(workspaceSeries, panel.metricKey);
  const rawSeries = useMemo(() => (
    !linePanel || !panelRunIds ? [] :
    (workspaceSeries[panel.metricKey] ?? []).filter((item) => panelRunIds.has(item.id) && (item.points?.length ?? 0) > 0)
  ), [linePanel, panel.metricKey, panelRunIds, workspaceSeries]);
  const latestValues = useMemo(() => (
    linePanel || scatterPanel || distributionPanel || histogramTimelinePanel ? [] : latestMetricValues(panelRuns, panel.metricKey)
  ), [distributionPanel, histogramTimelinePanel, linePanel, panel.metricKey, panelRuns, scatterPanel]);
  const scatterPoints = useMemo(() => (
    scatterPanel && scatterXField && scatterYField
      ? scatterPointsForRuns(panelRuns, scatterXField, scatterYField)
      : { points: [], missing: scatterPanel ? panelRuns.length : 0 }
  ), [panelRuns, scatterPanel, scatterXField, scatterYField]);
  const distributionSummary = useMemo(() => (
    distributionPanel && distributionValueField
      ? distributionSummaryForRuns(panelRuns, distributionValueField, panel.groupField, panel.replicateField)
      : { groups: [], missing: distributionPanel ? panelRuns.length : 0, plotted: 0, total: panelRuns.length, truncatedGroups: 0 }
  ), [distributionPanel, distributionValueField, panel.groupField, panel.replicateField, panelRuns]);
  const loadingSeries = linePanel && panelRuns.length > 0 && !hasFetchedMetric;
  const plottedSeriesCount = linePanel
    ? rawSeries.length
    : scatterPanel
      ? scatterPoints.points.length
      : distributionPanel
        ? distributionSummary.plotted
        : histogramTimelinePanel
            ? histogramTimeline?.frames.length ?? 0
            : latestValues.length;
  const missingSeriesCount = scatterPanel
    ? scatterPoints.missing
    : distributionPanel
      ? distributionSummary.missing
      : histogramTimelinePanel
        ? 0
      : Math.max(0, panelRuns.length - plottedSeriesCount);
  const plottedRunLabel = explicitSelectionActive
    ? histogramTimelinePanel
      ? histogramTimeline?.loading ? "loading primary run" : `${histogramTimeline?.frames.length ?? 0} frames`
      : loadingSeries
      ? `loading ${panelScopeLabel}`
      : `${plottedSeriesCount} plotted / ${panelScopeLabel}`
    : histogramTimelinePanel
      ? histogramTimeline?.loading ? "loading primary run" : `${histogramTimeline?.frames.length ?? 0} frames`
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
  useEffect(() => {
    setPanelHover(null);
    setPanelZoomRange(null);
  }, [distributionValueField, histogramObjectKey, panel.metricKey, panel.type, scatterXField, scatterYField, settings.xMode, settings.groupBy, settings.groupAverage, settings.smoothing, settings.maxRuns, selectedRunKey]);
  useEffect(() => () => {
    if (hoverFrameRef.current !== null) window.cancelAnimationFrame(hoverFrameRef.current);
    resizeCleanupRef.current();
  }, []);
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
    const startLayout = normalizedPanelLayout(panel.layout, panel.type);
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
        h: Math.max(layoutMinRows, Math.min(10, Math.round(startLayout.h + (pointerEvent.clientY - startY) / rowUnit))),
      };
      setResizePreview(next);
    }
    function handlePointerUp(pointerEvent: globalThis.PointerEvent) {
      const next = {
        w: Math.max(3, Math.min(12, Math.round(startLayout.w + (pointerEvent.clientX - startX) / columnUnit))),
        h: Math.max(layoutMinRows, Math.min(10, Math.round(startLayout.h + (pointerEvent.clientY - startY) / rowUnit))),
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
  const panelActionItems = panelActionMenuItems({ onDuplicate, onEdit, onFullscreen, onRemove, title: panel.title });
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
          <small title={scatterPanel ? scatterPairLabel : distributionPanel ? `${distributionValueLabel} grouped by ${distributionGroupLabel}` : histogramTimelinePanel ? histogramObjectKey : panel.metricKey}>
            {
              scatterPanel
                ? truncateMiddle(scatterPairLabel, 84)
                : distributionPanel
                  ? truncateMiddle(`${distributionValueLabel} by ${distributionGroupLabel}`, 84)
                  : histogramTimelinePanel
                      ? truncateMiddle(histogramObjectKey, 84)
                      : panel.metricKey
            }
          </small>
        </div>
        {/* Line panels fold these actions into the chart's three-dot menu; the
            other panel types have no chart toolbar, so they get a head kebab. */}
        {!linePanel && panelActionItems ? (
          <div className="panel-card-actions">
            <PanelHeadMenu items={panelActionItems} label={`${panel.title} panel options`} />
          </div>
        ) : null}
      </div>
      <div className="workspace-panel-meta">
        {scatterPanel ? (
          <>
            <span title={scatterXLabel}>X {truncateMiddle(scatterXLabel, 44)}</span>
            <span title={scatterYLabel}>Y {truncateMiddle(scatterYLabel, 44)}</span>
            <span>Summary values</span>
          </>
        ) : distributionPanel ? (
          <>
            <span title={distributionValueLabel}>Value {truncateMiddle(distributionValueLabel, 38)}</span>
            <span title={distributionGroupLabel}>{truncateMiddle(distributionGroupLabel, 44)}</span>
            <span>Visible-sample distribution</span>
          </>
        ) : histogramTimelinePanel ? (
          <>
            <span title={histogramObjectKey}>Object {truncateMiddle(histogramObjectKey, 44)}</span>
            <span>Primary run</span>
            <span>Latest frames</span>
          </>
        ) : (
          // Only surface line settings that deviate from the default (step axis,
          // ungrouped, full fidelity) — the defaults are just noise.
          <>
            {settings.xMode === "time" ? <span>Logged time</span> : null}
            {settings.groupBy ? <span>Grouped by {settings.groupBy}</span> : null}
            {settings.smoothing ? <span>Smooth {settings.smoothing}</span> : null}
          </>
        )}
        <span>{plottedRunLabel}</span>
        {missingSeriesCount && !loadingSeries ? <span className="panel-data-gap">{scatterPanel || distributionPanel ? `${missingSeriesCount} missing field values` : `${missingSeriesCount} no data for metric`}</span> : null}
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
            emptyMessage={panelRuns.length ? "No logged series for this metric in the current run set." : undefined}
            exportFilenameBase={`instantml-${panel.metricKey}`}
            height={panelChartHeight}
            highlightRunId={highlightRunId}
            metricKey={panel.metricKey}
            onPointHover={(point) => {
              setPanelHover(point);
              onHighlightRun?.(point?.runId ?? null);
            }}
            onLeave={() => {
              clearPanelHover();
              onHighlightRun?.(null);
            }}
            onZoomRangeChange={setPanelZoomRange}
            padding={panelChartPadding}
            panelMenuItems={panelActionItems}
            series={preparedSeries}
            smoothing={settings.smoothing}
            onSmoothingChange={onSmoothingChange}
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
        ) : distributionPanel ? (
          distributionValueField ? (
            <DistributionPanelChart
              groupField={panel.groupField}
              height={panelChartHeight}
              replicateField={panel.replicateField}
              scopeLabel={cappedPanelScopeLabel}
              summary={distributionSummary}
              valueField={distributionValueField}
              width={panelChartWidth}
            />
          ) : (
            <div className="chart-area" aria-label={`Missing distribution field for ${panel.title}`}>
              <div className="empty">Select a numeric value field for this distribution panel.</div>
            </div>
          )
        ) : histogramTimelinePanel ? (
          <HistogramTimelinePanelChart
            height={panelChartHeight}
            objectKey={histogramObjectKey}
            timeline={histogramTimeline}
            width={panelChartWidth}
          />
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
        >
          <svg className="panel-resize-grip" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <path d="M14.5 5.5 5.5 14.5M14.5 9.5 9.5 14.5M14.5 13.5 13.5 14.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </article>
  );
}

export function WorkspaceSectionView({
  highlightRunId = null,
  onDuplicatePanel,
  onEditPanel,
  onFullscreenPanel,
  onHighlightRun,
  onPanelDragEnd,
  onPanelDragStart,
  onPanelDrop,
  onPanelPointerMoveStart,
  onRemovePanel,
  onResizePanel,
  onPanelSmoothing,
  onToggleSection,
  panelSearchActive,
  section,
  selectedRunIds,
  visiblePanels,
  view,
  workspaceHistogramTimelines,
  workspacePanelRuns,
  workspaceSeries,
}: {
  highlightRunId?: string | null;
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onHighlightRun?: (runId: string | null) => void;
  onPanelDragEnd: () => void;
  onPanelDragStart: (event: DragEvent<HTMLElement>, sectionId: string, panelId: string) => void;
  onPanelDrop: (event: DragEvent<HTMLElement>, targetSectionId: string, targetIndex: number) => void;
  onPanelPointerMoveStart: (event: ReactPointerEvent<HTMLElement>, sectionId: string, panelId: string) => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onResizePanel: (sectionId: string, panelId: string, layout: WorkspacePanelLayout) => void;
  onPanelSmoothing: (sectionId: string, panelId: string, smoothing: number) => void;
  onToggleSection: (sectionId: string) => void;
  panelSearchActive: boolean;
  section: WorkspaceSection;
  selectedRunIds: string[];
  visiblePanels: WorkspacePanel[];
  view: WorkspaceView;
  workspaceHistogramTimelines: Record<string, HistogramTimelineState>;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  // In a generated workspace, line panels whose metric has loaded but matches no run
  // in the current scope are hidden behind a disclosure instead of rendering
  // tall "no data for metric" charts (panel search always shows everything).
  const [showEmptyPanels, setShowEmptyPanels] = useState(false);
  const panelRunIdSet = useMemo(() => new Set(workspacePanelRuns.map((run) => run.id)), [workspacePanelRuns]);
  const isEmptyGeneratedPanel = (panel: WorkspacePanel) =>
    view.mode === "automatic"
    && panel.type === "line"
    && workspacePanelRuns.length > 0
    && Object.prototype.hasOwnProperty.call(workspaceSeries, panel.metricKey)
    && !(workspaceSeries[panel.metricKey] ?? []).some((item) => panelRunIdSet.has(item.id) && (item.points?.length ?? 0) > 0);
  const hideEmpties = !panelSearchActive && !showEmptyPanels;
  const emptyPanelCount = panelSearchActive ? 0 : visiblePanels.filter(isEmptyGeneratedPanel).length;
  const shownPanels = hideEmpties ? visiblePanels.filter((panel) => !isEmptyGeneratedPanel(panel)) : visiblePanels;
  return (
    <section className={`workspace-section ${section.collapsed ? "collapsed" : ""}`} data-section-id={section.id}>
      <div className="workspace-section-head">
        <button className="section-title-button" type="button" onClick={() => onToggleSection(section.id)}>
          <ChevronDown size={15} /> <strong>{section.name}</strong> <span>{section.panels.length}</span>
        </button>
        {emptyPanelCount > 0 ? (
          <button
            className="section-empty-toggle"
            onClick={() => setShowEmptyPanels((current) => !current)}
            type="button"
          >
            {showEmptyPanels
              ? "Hide panels without data"
              : `${emptyPanelCount} hidden · no data for current runs`}
          </button>
        ) : null}
      </div>
      {!section.collapsed ? (
        <div
          className="workspace-panel-grid"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => onPanelDrop(event, section.id, section.panels.length)}
        >
          {shownPanels.length ? shownPanels.map((panel) => {
            const panelIndex = Math.max(0, section.panels.findIndex((item) => item.id === panel.id));
            return (
              <WorkspacePanelCard
                key={panel.id}
                highlightRunId={highlightRunId}
                onHighlightRun={onHighlightRun}
                onDragEnd={onPanelDragEnd}
                onDragStart={(event) => onPanelDragStart(event, section.id, panel.id)}
                onDropBefore={(event) => onPanelDrop(event, section.id, panelIndex)}
                onDuplicate={() => onDuplicatePanel(section.id, panel.id)}
                onEdit={() => onEditPanel(section.id, panel.id)}
                onFullscreen={() => onFullscreenPanel(section.id, panel.id)}
                onPointerMoveStart={(event) => onPanelPointerMoveStart(event, section.id, panel.id)}
                onRemove={() => onRemovePanel(section.id, panel.id)}
                onResize={(layout) => onResizePanel(section.id, panel.id, layout)}
                onSmoothingChange={(smoothing) => onPanelSmoothing(section.id, panel.id, smoothing)}
                panel={panel}
                panelSearchActive={panelSearchActive}
                section={section}
                selectedRunIds={selectedRunIds}
                view={view}
                workspaceHistogramTimelines={workspaceHistogramTimelines}
                workspacePanelRuns={workspacePanelRuns}
                workspaceSeries={workspaceSeries}
              />
            );
          }) : emptyPanelCount > 0
            ? <div className="empty workspace-empty">All {emptyPanelCount} panels in this section have no data for the current runs.</div>
            : <div className="empty workspace-empty">No panels in this section yet. Drag a panel here or add one from the top toolbar.</div>}
        </div>
      ) : null}
    </section>
  );
}
