"use client";

import { useMemo, useRef, useState } from "react";

import { axisTicks, formatAxisTick, formatAxisValue, formatMetricValue } from "../../../src/charts.js";
import { chartColor, chartStyleIndexesForItems, stableChartIndex } from "../../../src/chart-colors.js";
import { categoricalFieldLabel, distributionSummaryForRuns, fieldLabel, histogramBins, indexedAxisTicks } from "../../../src/dashboard-panels.js";
import { formatNumber } from "../../../src/state.js";
import { metricTitle, workspacePanelTypeLabel } from "../../dashboard-models";
import type { WorkspacePanelType } from "../../dashboard-types";
import { useMeasuredSize } from "../ui/use-measured-size";

type LatestPanelType = Extract<WorkspacePanelType, "bar" | "histogram" | "dot"> | "value_histogram";

export type AltChartHover = {
  detail?: string;
  id: string;
  title: string;
  value: string;
  x: number;
  y: number;
};

export function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 8) return value.slice(0, maxLength);
  const keep = maxLength - 3;
  const start = Math.ceil(keep / 2);
  const end = Math.floor(keep / 2);
  return `${value.slice(0, start)}...${value.slice(value.length - end)}`;
}

function isCreatedTimeField(fieldId: string) {
  const parsed = fieldId.split(":");
  return parsed[0] === "run" && parsed[1] === "created_at_unix";
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

function latestPanelTypeLabel(type: LatestPanelType) {
  return type === "value_histogram" ? "Value histogram" : workspacePanelTypeLabel(type);
}

function isHistogramPanel(type: LatestPanelType) {
  return type === "histogram" || type === "value_histogram";
}

function integerCountTicks(maxCount: number, target = 4) {
  const upper = Math.max(1, Math.ceil(maxCount));
  const tickCount = Math.max(2, Math.min(Math.floor(target), upper + 1));
  const ticks = [];
  for (let index = 0; index < tickCount; index += 1) {
    ticks.push(Math.round((upper * index) / (tickCount - 1)));
  }
  return [...new Set(ticks)];
}

export function LatestMetricPanelChart({
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
  type: LatestPanelType;
  values: Array<{ id: string; index: number; name: string; value: number }>;
  width: number;
}) {
  const [hover, setHover] = useState<AltChartHover | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useMeasuredSize(frameRef, fallbackWidth, fallbackHeight);
  const valueStyleIndexes = useMemo(() => chartStyleIndexesForItems(values), [values]);
  const histogram = isHistogramPanel(type);
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
  const categoricalSlot = innerWidth / Math.max(1, values.length);
  const xFor = (index: number) => padding + categoricalSlot * (index + 0.5);
  const bins = histogram ? histogramBins(metricValues, 12) : [];
  const maxBinCount = bins.length ? Math.max(...bins.map((bin: { count: number }) => bin.count), 1) : 1;
  const yTicks = histogram ? integerCountTicks(maxBinCount, 4) : axisTicks(valueMin, valueMax, 4);
  const xTicks = histogram ? axisTicks(minValue, maxValue, 4) : indexedAxisTicks(values.length, 5);
  const histogramSpan = Math.max(1, maxValue - minValue);
  const histogramXFor = (value: number) => padding + ((value - minValue) / histogramSpan) * innerWidth;
  const countYFor = (count: number) => height - padding - (count / Math.max(1, maxBinCount)) * innerHeight;
  const barWidth = type === "bar" ? Math.max(2, categoricalSlot - 3) : 0;
  return (
    <div className="chart-area alt-panel-chart" aria-label={`${latestPanelTypeLabel(type)} chart for ${metricKey}`} onMouseLeave={() => setHover(null)}>
      <div className="alt-chart-frame" ref={frameRef}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {yTicks.map((tick: number) => {
          const y = histogram ? countYFor(tick) : yFor(tick);
          return (
            <g key={`y-${tick}`}>
              <line className="grid-line" x1={padding} x2={width - padding} y1={y} y2={y} />
              <text className="tick-label" x={padding - 10} y={y + 4} textAnchor="end">{histogram ? formatNumber(tick, 0) : formatNumber(tick, 2)}</text>
            </g>
          );
        })}
        {xTicks.map((tick: number) => {
          const x = histogram ? histogramXFor(tick) : xFor(tick);
          const label = histogram ? formatAxisValue(tick) : `#${tick + 1}`;
          return (
            <g key={`x-${tick}`}>
              <line className="grid-line vertical" x1={x} x2={x} y1={padding} y2={height - padding} />
              <text className="tick-label" x={x} y={height - padding + 20} textAnchor="middle">{label}</text>
            </g>
          );
        })}
        <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{histogram ? metricTitle(metricKey) : "Selected run order"}</text>
        <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>{histogram ? "Count" : metricTitle(metricKey)}</text>
        {histogram ? bins.map((bin: { min: number; max: number; count: number }) => {
          const widthPerBin = bins.length === 1 ? innerWidth : histogramXFor(bin.max) - histogramXFor(bin.min);
          const barHeight = (bin.count / Math.max(1, maxBinCount)) * innerHeight;
          const binX = (bins.length === 1 ? padding : histogramXFor(bin.min)) + 2;
          const binY = height - padding - barHeight;
          const binLabel = `${formatAxisValue(bin.min)}-${formatAxisValue(bin.max)}`;
          const binHover = { id: binLabel, title: binLabel, value: `${bin.count} run${bin.count === 1 ? "" : "s"}`, detail: metricTitle(metricKey), x: binX + Math.max(2, widthPerBin - 4) / 2, y: binY };
          return (
            <rect
              aria-label={`${binLabel}: ${bin.count} runs`}
              className={`histogram-bar${hover?.id === binLabel ? " active" : ""}`}
              height={barHeight}
              key={`${bin.min}-${bin.max}`}
              onBlur={() => setHover((current) => current?.id === binLabel ? null : current)}
              onFocus={() => setHover(binHover)}
              onMouseEnter={() => setHover(binHover)}
              role="img"
              rx="3"
              tabIndex={0}
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
          const itemHover = { id: item.id, title: item.name, value: formatAxisValue(item.value), detail: metricTitle(metricKey), x: xFor(index), y: top };
          return (
            <rect
              aria-label={label}
              className={`summary-bar${hover?.id === item.id ? " active" : ""}`}
              height={barHeight}
              key={item.id}
              onBlur={() => setHover((current) => current?.id === item.id ? null : current)}
              onFocus={() => setHover(itemHover)}
              onMouseEnter={() => setHover(itemHover)}
              role="img"
              rx="3"
              style={{ fill: chartColor(colorIndex) }}
              tabIndex={0}
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
          const itemHover = { id: item.id, title: item.name, value: formatAxisValue(item.value), detail: metricTitle(metricKey), x, y };
          return (
            <circle
              aria-label={label}
              className={`summary-dot${hover?.id === item.id ? " active" : ""}`}
              cx={x}
              cy={y}
              fill={chartColor(colorIndex)}
              key={item.id}
              onBlur={() => setHover((current) => current?.id === item.id ? null : current)}
              onFocus={() => setHover(itemHover)}
              onMouseEnter={() => setHover(itemHover)}
              r="3.8"
              role="img"
              tabIndex={0}
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
        {histogram ? <span className="legend-chip">{bins.length} bins</span> : <span className="legend-chip">{metricKey}</span>}
      </div>
    </div>
  );
}

export function ScatterPanelChart({
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
          const pointHover = { id: point.id, title: point.name, value: `${compactXLabel}: ${xValue}`, detail: `${compactYLabel}: ${yValue}`, x, y };
          return (
            <circle
              aria-label={label}
              className={`scatter-dot${hover?.id === point.id ? " active" : ""}`}
              cx={x}
              cy={y}
              fill={chartColor(pointStyleIndexes[index] ?? stableChartIndex(point.id || point.name, index))}
              key={point.id}
              onBlur={() => setHover((current) => current?.id === point.id ? null : current)}
              onFocus={() => setHover(pointHover)}
              onMouseEnter={() => setHover(pointHover)}
              r="4"
              role="img"
              tabIndex={0}
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

export function DistributionPanelChart({
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
                const pointId = `${group.label}-${point.id}`;
                const pointHover = { id: pointId, title: point.name, value: formatAxisValue(point.value), detail: `${group.label} / n=${group.n}`, x: pointX, y: pointY };
                return (
                  <circle
                    aria-label={`${point.name}: ${formatAxisValue(point.value)} (${group.label})`}
                    className={`summary-dot${hover?.id === pointId ? " active" : ""}`}
                    cx={pointX}
                    cy={pointY}
                    fill={color}
                    key={pointId}
                    onBlur={() => setHover((current) => current?.id === pointId ? null : current)}
                    onFocus={() => setHover(pointHover)}
                    onMouseEnter={() => setHover(pointHover)}
                    r="3"
                    role="img"
                    tabIndex={0}
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
        <span className="legend-chip">{groups.length} {groups.length === 1 ? "group" : "groups"} / median</span>
        {replicateField ? <span className="legend-chip" title={replicateLabel}>{replicateValues} replicate values</span> : null}
        {semGroups ? <span className="legend-chip">{semGroups} SEM estimates</span> : null}
        {sampledGroups ? <span className="legend-chip">Strip points sampled</span> : null}
        {groups.some((group) => group.n < 5) ? <span className="legend-chip">Small groups: strip + median</span> : null}
      </div>
    </div>
  );
}

export function AltChartTooltip({ height, hover, width }: { height: number; hover: AltChartHover; width: number }) {
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
