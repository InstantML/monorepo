"use client";

import { ChevronDown, CopyPlus, GripVertical, Maximize2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { averageGroupedSeries, axisTicks, chartDomain, formatAxisValue, nearestPoint, normalizeSeries, smoothSeries, svgPointFromClient } from "../../../src/charts.js";
import { histogramBins, indexedAxisTicks, latestMetricValues } from "../../../src/dashboard-panels.js";
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
import { resolveWorkspaceSettings, normalizedPanelLayout } from "./panel-edit-drawer";
import type { HoverPoint, MetricSeries, RunSummary, WorkspacePanel, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceSection, WorkspaceView } from "../../dashboard-types";

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

function panelMatchesSearch(section: WorkspaceSection, panel: WorkspacePanel, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${section.name} ${panel.title} ${panel.metricKey} ${workspacePanelTypeLabel(panel.type)}`.toLowerCase().includes(needle);
}

type DraggedWorkspacePanel = {
  panelId: string;
  sectionId: string;
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
  type: Exclude<WorkspacePanelType, "line">;
  values: Array<{ id: string; index: number; name: string; value: number }>;
  width: number;
}) {
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
    <div className="chart-area alt-panel-chart" aria-label={`${workspacePanelTypeLabel(type)} chart for ${metricKey}`}>
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
          return (
            <rect
              className="histogram-bar"
              height={barHeight}
              key={`${bin.min}-${bin.max}`}
              rx="3"
              width={Math.max(2, widthPerBin - 4)}
              x={(bins.length === 1 ? padding : histogramXFor(bin.min)) + 2}
              y={height - padding - barHeight}
            >
              <title>{`${formatAxisValue(bin.min)}-${formatAxisValue(bin.max)}: ${bin.count}`}</title>
            </rect>
          );
        }) : null}
        {type === "bar" ? values.map((item, index) => {
          const y = yFor(Math.max(item.value, paddedMin));
          const zeroY = yFor(0);
          const top = Math.min(y, zeroY);
          const barHeight = Math.max(2, Math.abs(zeroY - y));
          return (
            <rect
              className="summary-bar"
              height={barHeight}
              key={item.id}
              rx="3"
              width={barWidth}
              x={xFor(index) - barWidth / 2}
              y={top}
            >
              <title>{`${item.name}: ${formatAxisValue(item.value)}`}</title>
            </rect>
          );
        }) : null}
        {type === "dot" ? values.map((item, index) => (
          <circle className="summary-dot" cx={xFor(index)} cy={yFor(item.value)} key={item.id} r="4">
            <title>{`${item.name}: ${formatAxisValue(item.value)}`}</title>
          </circle>
        )) : null}
      </svg>
      <div className="chart-legend compact-legend">
        <span>{values.length} latest values</span>
        {type === "histogram" ? <span>{bins.length} bins</span> : <span>{metricKey}</span>}
      </div>
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
  const workspaceRunLookup = useMemo(() => new Map(workspacePanelRuns.map((run) => [run.id, run])), [workspacePanelRuns]);
  const selectedVisibleRuns = useMemo(() => (
    selectedRunIds.length
      ? selectedRunIds.map((runId) => workspaceRunLookup.get(runId)).filter(Boolean) as RunSummary[]
      : []
  ), [selectedRunIds, workspaceRunLookup]);
  const panelRuns = useMemo(() => (
    selectedVisibleRuns.length
      ? selectedVisibleRuns.slice(0, MAX_SELECTED_RUNS)
      : workspacePanelRuns.slice(0, settings.maxRuns)
  ), [selectedVisibleRuns, settings.maxRuns, workspacePanelRuns]);
  const selectedOverflow = selectedVisibleRuns.length > panelRuns.length;
  const panelRunIds = useMemo(() => new Set(panelRuns.map((run) => run.id)), [panelRuns]);
  const runLookup = useMemo(() => new Map(panelRuns.map((run) => [run.id, run])), [panelRuns]);
  const linePanel = panel.type === "line";
  const hasFetchedMetric = !linePanel || Object.prototype.hasOwnProperty.call(workspaceSeries, panel.metricKey);
  const rawSeries = useMemo(() => (
    (workspaceSeries[panel.metricKey] ?? []).filter((item) => panelRunIds.has(item.id) && (item.points?.length ?? 0) > 0)
  ), [panel.metricKey, panelRunIds, workspaceSeries]);
  const latestValues = useMemo(() => latestMetricValues(panelRuns, panel.metricKey), [panel.metricKey, panelRuns]);
  const loadingSeries = linePanel && panelRuns.length > 0 && !hasFetchedMetric;
  const plottedSeriesCount = linePanel ? rawSeries.length : latestValues.length;
  const missingSeriesCount = Math.max(0, panelRuns.length - plottedSeriesCount);
  const plottedRunLabel = selectedVisibleRuns.length
    ? loadingSeries
      ? `loading ${panelRuns.length} selected`
      : `${plottedSeriesCount} plotted / ${panelRuns.length} selected`
    : loadingSeries
      ? `loading ${panelRuns.length} visible`
      : `${plottedSeriesCount}/${panelRuns.length} visible`;
  const groupedSeries = useMemo(() => rawSeries.map((item) => {
    const run = runLookup.get(item.id);
    return { ...item, group: run ? groupKeyForRun(run, settings.groupBy) : item.group ?? "all" };
  }), [rawSeries, runLookup, settings.groupBy]);
  const preparedSeries = useMemo(() => (
    smoothSeries(settings.groupAverage ? averageGroupedSeries(groupedSeries) : groupedSeries, settings.smoothing)
  ), [groupedSeries, settings.groupAverage, settings.smoothing]);
  const fullDomain = useMemo(() => chartDomain(preparedSeries, settings.xMode, panel.metricKey), [panel.metricKey, preparedSeries, settings.xMode]);
  const rangeSeries = useMemo(() => (
    normalizeSeries(preparedSeries, panelChartWidth, panelChartHeight, panelChartPadding, settings.xMode, panel.metricKey)
  ), [panel.metricKey, panelChartHeight, panelChartPadding, panelChartWidth, preparedSeries, settings.xMode]);
  const normalized = useMemo(() => (
    normalizeSeries(preparedSeries, panelChartWidth, panelChartHeight, panelChartPadding, settings.xMode, panel.metricKey, panelZoomRange)
  ), [panel.metricKey, panelChartHeight, panelChartPadding, panelChartWidth, panelZoomRange, preparedSeries, settings.xMode]);
  const domain = useMemo(() => chartDomain(preparedSeries, settings.xMode, panel.metricKey, panelZoomRange), [panel.metricKey, panelZoomRange, preparedSeries, settings.xMode]);
  useEffect(() => {
    setPanelHover(null);
    setPanelZoomRange(null);
  }, [panel.metricKey, panel.type, settings.xMode, settings.groupBy, settings.groupAverage, settings.smoothing, settings.maxRuns, selectedRunKey]);
  function handlePanelChartMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, panelChartWidth, panelChartHeight);
    setPanelHover(nearestPoint(normalized, point.x, point.y, 28) as HoverPoint);
  }
  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!onResize) return;
    const commitResize = onResize;
    event.preventDefault();
    event.stopPropagation();
    const card = event.currentTarget.closest<HTMLElement>(".workspace-panel-card");
    const grid = event.currentTarget.closest<HTMLElement>(".workspace-panel-grid");
    if (!card || !grid) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLayout = normalizedPanelLayout(panel.layout);
    const columnUnit = Math.max(1, grid.getBoundingClientRect().width / 12);
    const rowUnit = 78;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    const target = event.currentTarget;
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
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
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
          <small>{workspacePanelTypeLabel(panel.type)} · {panel.metricKey} · {plottedRunLabel}</small>
        </div>
        <div className="panel-card-actions">
          {onEdit ? <button className="icon-button" type="button" aria-label={`Edit ${panel.title}`} onClick={onEdit}><Pencil size={15} /></button> : null}
          {onDuplicate ? <button className="icon-button" type="button" aria-label={`Duplicate ${panel.title}`} onClick={onDuplicate}><CopyPlus size={15} /></button> : null}
          {onFullscreen ? <button className="icon-button" type="button" aria-label={`Fullscreen ${panel.title}`} onClick={onFullscreen}><Maximize2 size={15} /></button> : null}
          {onRemove ? <button className="icon-button" type="button" aria-label={`Remove ${panel.title}`} onClick={onRemove}><Trash2 size={15} /></button> : null}
        </div>
      </div>
      <div className="workspace-panel-meta">
        <span>{settings.xMode === "time" ? "Logged time" : "Step"}</span>
        <span>{settings.groupBy ? `Grouped by ${settings.groupBy}` : "Ungrouped"}</span>
        <span>{settings.smoothing ? `Smooth ${settings.smoothing}` : "Full fidelity"}</span>
        {selectedVisibleRuns.length ? <span>{selectedOverflow ? `${panelRuns.length}/${selectedVisibleRuns.length} selected` : `${panelRuns.length} selected`}</span> : <span>{panelRuns.length} visible</span>}
        {missingSeriesCount && !loadingSeries ? <span className="panel-data-gap">{missingSeriesCount} no data for metric</span> : null}
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
            fullDomain={fullDomain}
            height={panelChartHeight}
            hover={panelHover}
            metricKey={panel.metricKey}
            normalizedSeries={normalized}
            onMove={handlePanelChartMove}
            onPointHover={setPanelHover}
            onLeave={() => setPanelHover(null)}
            onZoomRangeChange={setPanelZoomRange}
            padding={panelChartPadding}
            rangeSeries={rangeSeries}
            width={panelChartWidth}
            xMode={settings.xMode}
            zoomRange={panelZoomRange}
          />
        ) : (
          <LatestMetricPanelChart
            height={panelChartHeight}
            metricKey={panel.metricKey}
            padding={panelChartPadding}
            type={panel.type as Exclude<WorkspacePanelType, "line">}
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
