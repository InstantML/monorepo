"use client";

import { LineChart, Plus, Table2, X } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";

import {
  evaluationCards,
  groupedRunReducers,
  insightsRunUniverse,
  insightsScopeLabel,
  kMeansClusters,
  looksLogarithmicField,
  numericFieldRows,
  parallelAxisDomains,
  parallelSummaryRows,
  partitionEvaluationCards,
  runGroupingKeyLabel,
  scatterGeometry,
  scatterSummaryRows,
} from "../../../src/research-insights.js";
import { formatAxisTick, formatMetricValue } from "../../../src/charts.js";
import { formatNumber, metricGoal, metricGoalValue } from "../../../src/state.js";
import { metricTitle } from "../../dashboard-models";
import type { RunSummary } from "../../dashboard-types";
import { SegmentedToggle } from "../components/segmented-toggle";
import { AnalysisCard } from "../ui/analysis-card";
import { chartTooltipPlacement, type TooltipPlacement } from "../ui/chart-tooltip-placement";
import { CustomSelect, type SelectOption } from "../ui/select";
import { useChartFrameWidth } from "../ui/use-measured-size";
import { SystemUsageInsightsPane } from "./system-usage-pane";

const AUTO_AXIS = "__auto__";
const MAX_AXIS_OPTIONS = 80;
const MAX_PARALLEL_AXES = 5;

// Chart frames render their SVG viewBox at the measured frame width (see
// useChartFrameWidth) so axis text keeps a constant pixel size instead of
// scaling up with the card — the "giant uppercase axis label" failure mode of
// stretching a fixed viewBox. Heights are fixed in CSS pixels; the min widths
// match the frames' CSS min-width, below which the frame scrolls.
const SCATTER_FRAME_WIDTH = 520;
const SCATTER_FRAME_HEIGHT = 232;
const PARALLEL_FRAME_WIDTH = 720;
const PARALLEL_FRAME_HEIGHT = 264;

type TipAnchor = { x: number; y: number };

/**
 * Point-anchored hover tooltip matching the Runs tab metric chart: a floating
 * .chart-tooltip card placed beside the hovered mark (flipping at the shell's
 * edges via the shared placement helper) instead of a readout row below the
 * chart. The shell — a position:relative wrapper around the chart frame — is
 * the placement bounds. Since the SVG viewBox renders at the measured frame
 * width, chart coordinates ARE frame-local CSS pixels.
 */
function ChartPointTip({
  anchor,
  children,
  shellRef,
}: {
  anchor: TipAnchor;
  children: ReactNode;
  shellRef: { current: HTMLDivElement | null };
}) {
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  // The anchor object is recreated every render, so bail out of identical
  // placements to avoid a measure → set-state loop while hovering.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const tip = tipRef.current;
    if (!shell || !tip) return;
    const bounds = shell.getBoundingClientRect();
    const rect = tip.getBoundingClientRect();
    const next = chartTooltipPlacement({
      anchorX: anchor.x,
      anchorY: anchor.y,
      boundsHeight: bounds.height,
      boundsWidth: bounds.width,
      tooltipHeight: rect.height,
      tooltipWidth: rect.width,
    });
    setPlacement((current) => (
      current && current.left === next.left && current.top === next.top ? current : next
    ));
  }, [anchor.x, anchor.y, children, shellRef]);
  const style: CSSProperties = placement
    ? { left: `${placement.left}px`, top: `${placement.top}px` }
    : { left: 0, top: 0, visibility: "hidden" };
  return (
    <div className="chart-tooltip analysis-point-tip" ref={tipRef} role="tooltip" style={style}>
      {children}
    </div>
  );
}

type Props = {
  api: { get: (path: string, options?: Record<string, unknown>) => Promise<any> };
  embedded?: boolean;
  metricKey: string;
  /** Optional: invoked with the run id when a scatter point or parallel line is clicked. */
  onSelectRun?: (runId: string) => void;
  project?: string;
  selectedRunIds: string[];
  sortedRuns: RunSummary[];
};

export function InsightsTabPane({ api, embedded = false, metricKey, onSelectRun = () => {}, project = "", selectedRunIds, sortedRuns }: Props) {
  const [activeView, setActiveView] = useState<"usage" | "run-analysis">("run-analysis");

  return (
    <div className={`analysis-page insights-page ${embedded ? "embedded-analysis" : ""}`}>
      {!embedded ? (
        <header className="analysis-header">
          <div className="analysis-title-block">
            <h2>Insights</h2>
          </div>
          <SegmentedToggle
            ariaLabel="Insights view"
            className="insights-view-switch"
            onChange={setActiveView}
            options={[
              { value: "usage", label: "GPU & System" },
              { value: "run-analysis", label: "Run Analysis" },
            ]}
            value={activeView}
          />
        </header>
      ) : null}

      {!embedded && activeView === "usage" ? (
        <SystemUsageInsightsPane api={api} project={project} selectedRunIds={selectedRunIds} sortedRuns={sortedRuns} onSelectRun={onSelectRun} />
      ) : (
        <RunAnalysisInsightsPane embedded={embedded} metricKey={metricKey} onSelectRun={onSelectRun} selectedRunIds={selectedRunIds} sortedRuns={sortedRuns} />
      )}
    </div>
  );
}

function RunAnalysisInsightsPane({
  embedded = false,
  metricKey,
  onSelectRun,
  selectedRunIds,
  sortedRuns,
}: {
  embedded?: boolean;
  metricKey: string;
  onSelectRun: (runId: string) => void;
  selectedRunIds: string[];
  sortedRuns: RunSummary[];
}) {
  const universe = useMemo(() => insightsRunUniverse(selectedRunIds, sortedRuns), [selectedRunIds, sortedRuns]);
  const grouped = useMemo(() => groupedRunReducers(universe.runs, metricKey), [universe.runs, metricKey]);
  const groupingKey = useMemo(() => runGroupingKeyLabel(universe.runs), [universe.runs]);
  const numeric = useMemo(() => numericFieldRows(universe.runs, metricKey), [universe.runs, metricKey]);
  const clusterDefaults = useMemo(() => kMeansClusters(universe.runs, metricKey), [universe.runs, metricKey]);
  const evalCards = useMemo(() => evaluationCards(universe.runs), [universe.runs]);
  const scatterDefaults = useMemo(() => chooseScatterFields(numeric), [numeric]);
  const [scatterX, setScatterX] = useState(AUTO_AXIS);
  const [scatterY, setScatterY] = useState(AUTO_AXIS);
  const [clusterX, setClusterX] = useState(AUTO_AXIS);
  const [clusterY, setClusterY] = useState(AUTO_AXIS);
  const [parallelAxes, setParallelAxes] = useState<string[]>([]);
  const scatterFields = resolveAxisPair(numeric.fields, scatterDefaults, scatterX, scatterY);
  const clusterAxisFields = resolveAxisPair(clusterDefaults.fields, clusterDefaults.axes, clusterX, clusterY);
  const clusters = useMemo(
    () => kMeansClusters(universe.runs, metricKey, 3, 12, clusterAxisFields),
    [clusterAxisFields[0], clusterAxisFields[1], metricKey, universe.runs],
  );
  const parallelFields = resolveParallelFields(numeric.fields, numeric.fields.slice(0, 5), parallelAxes);
  const scope = insightsScopeLabel(universe);

  return (
    <>
      {embedded ? (
        <div className="advanced-section-band">
          <span className="seg"><i className="dot" />Run-level insights</span>
          <span className="rule" />
          <span className="hint">{scope}</span>
        </div>
      ) : null}
      {!universe.runs.length ? (
        <div className="empty">No loaded runs available for insights.</div>
      ) : (
        <>
          <section className="analysis-grid two">
            <GroupedReducersCard grouped={grouped} groupingKey={groupingKey} metricKey={metricKey} />
            <EvaluationCardGrid cards={evalCards} total={universe.runs.length} />
          </section>
          <section className="analysis-grid two">
            <ScatterCard
              allFields={numeric.fields}
              fields={scatterFields}
              rows={numeric.rows}
              xAxis={scatterX}
              yAxis={scatterY}
              onSelectRun={onSelectRun}
              onXAxisChange={setScatterX}
              onYAxisChange={setScatterY}
            />
            <ClusterCard
              allFields={clusters.fields}
              axes={clusters.axes}
              clusters={clusters.clusters}
              fields={clusters.fields}
              points={clusters.points}
              xAxis={clusterX}
              yAxis={clusterY}
              onXAxisChange={setClusterX}
              onYAxisChange={setClusterY}
              plotted={clusters.plotted}
              clustered={clusters.clustered}
            />
          </section>
          <section className="analysis-grid one">
            <ParallelCoordinatesCard
              allFields={numeric.fields}
              fields={parallelFields}
              metricKey={metricKey}
              onAxesChange={setParallelAxes}
              onSelectRun={onSelectRun}
              rows={numeric.rows}
              selectedAxes={parallelAxes}
            />
          </section>
        </>
      )}
    </>
  );
}

function GroupedReducersCard({ grouped, groupingKey, metricKey }: { grouped: any[]; groupingKey: string | null; metricKey: string }) {
  const maxMean = Math.max(1e-9, ...grouped.map((item) => Math.abs(item.mean)));
  const help = (
    <>
      <strong>{metricTitle(metricKey)} averaged within each run group.</strong>
      <br />
      Loaded runs are bucketed (by seed, tag, or config) and the active metric is
      reduced to a mean per group. The bar visualises each group&apos;s mean
      relative to the largest, so you can compare cohorts at a glance.
    </>
  );
  return (
    <AnalysisCard title={`${metricTitle(metricKey)} by group`} badge={grouped.length ? `${grouped.length} groups` : undefined} help={help}>
      {grouped.length && groupingKey ? <p className="analysis-sublabel">Grouped by {groupingKey}</p> : null}
      <div className="analysis-table">
        <div className="analysis-row head"><span>{groupingKey ?? "group"}</span><span>mean</span><span>spread</span><span>runs</span></div>
        {grouped.slice(0, 8).map((item) => (
          <div className="analysis-row" key={item.group}>
            <span title={item.group}>{item.group}</span>
            <strong>{formatNumber(item.mean, 4)}</strong>
            <span><span className="group-bar"><i style={{ width: `${Math.max(4, (Math.abs(item.mean) / maxMean) * 100)}%` }} /></span></span>
            <span>{formatNumber(item.count, 0)}</span>
          </div>
        ))}
        {!grouped.length ? <div className="empty compact-empty">No grouped values for the active metric.</div> : null}
      </div>
    </AnalysisCard>
  );
}

function EvaluationCardGrid({ cards, total }: { cards: any[]; total: number }) {
  const [showUnlogged, setShowUnlogged] = useState(false);
  const { logged, unlogged } = partitionEvaluationCards(cards);
  const visible = showUnlogged ? [...logged, ...unlogged] : logged;
  const help = (
    <>
      <strong>Latest value of each standard evaluation metric, averaged across loaded runs.</strong>
      <br />
      Each tile shows the mean of a known metric (accuracy, loss, AUC, etc.) over the
      runs that logged it, plus how many of the loaded runs reported it. Metrics that
      no loaded run recorded are tucked behind the &ldquo;not logged&rdquo; chip.
    </>
  );
  return (
    <AnalysisCard title="Evaluation metrics" help={help}>
      {visible.length ? (
        <div className="eval-card-grid">
          {visible.map((card) => (
            <div className={`eval-mini-card ${card.key ? "" : "missing"}`} key={card.id}>
              <span>{card.label}</span>
              <strong>{card.key ? formatNumber(card.latest, 4) : "—"}</strong>
              <small>{card.key ? `avg · ${formatNumber(card.count, 0)}/${formatNumber(total, 0)} runs` : "not logged"}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty compact-empty">No standard evaluation metrics logged by the loaded runs.</div>
      )}
      {unlogged.length ? (
        <button
          aria-expanded={showUnlogged}
          className="eval-unlogged-toggle"
          onClick={() => setShowUnlogged((value) => !value)}
          type="button"
        >
          {showUnlogged ? `Hide ${formatNumber(unlogged.length, 0)} not logged ▴` : `+${formatNumber(unlogged.length, 0)} not logged ▾`}
        </button>
      ) : null}
    </AnalysisCard>
  );
}

const SCATTER_MAX_DRAWN = 500;

function ScatterCard({
  allFields,
  fields,
  rows,
  xAxis,
  yAxis,
  onSelectRun,
  onXAxisChange,
  onYAxisChange,
}: {
  allFields: string[];
  fields: string[];
  rows: any[];
  xAxis: string;
  yAxis: string;
  onSelectRun: (runId: string) => void;
  onXAxisChange: (value: string) => void;
  onYAxisChange: (value: string) => void;
}) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [xScaleOverride, setXScaleOverride] = useState<"linear" | "log" | null>(null);
  const [yScaleOverride, setYScaleOverride] = useState<"linear" | "log" | null>(null);
  const tableId = useId();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const { frameRef, width } = useChartFrameWidth(SCATTER_FRAME_WIDTH);

  const points = rows
    .map((row) => ({ run: row.run, x: row.values[fields[0]], y: row.values[fields[1]] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  // Auto-default a learning-rate-like axis to log; respect an explicit override.
  const xScale = xScaleOverride ?? (looksLogarithmicField(fields[0]) ? "log" : "linear");
  const yScale = yScaleOverride ?? (looksLogarithmicField(fields[1]) ? "log" : "linear");
  const geometry = scatterGeometry(points, { xScale, yScale, width });
  const plotted = geometry && !geometry.empty ? geometry.points : [];
  const visiblePoints = plotted.slice(0, SCATTER_MAX_DRAWN);
  // The table is the accessible alternative and shows every run with both
  // fields, independent of any log-axis drop, so a screen-reader user never
  // loses rows a visual log scale can't place.
  const summaryRows = scatterSummaryRows(points);
  const activePoint = activeRunId ? plotted.find((point) => point.run.id === activeRunId) : null;
  const missingCount = Math.max(0, rows.length - points.length);
  const droppedCount = geometry?.dropped ?? 0;
  const truncated = visiblePoints.length < plotted.length;
  const scaleNote = `${xScale === "log" ? "log" : "linear"} x · ${yScale === "log" ? "log" : "linear"} y`;
  const plottedNote = `${truncated ? `${formatNumber(visiblePoints.length, 0)} shown of ` : ""}${formatNumber(plotted.length, 0)} run${plotted.length === 1 ? "" : "s"} with both fields`;
  const coverageLabel = truncated ? `${visiblePoints.length} of ${plotted.length}` : `${plotted.length}`;
  const hasPlot = fields.length >= 2 && geometry && !geometry.empty;
  const help = (
    <>
      <strong>Relationship between two numeric fields across loaded runs.</strong>
      <br />
      Each dot is one run, positioned by the selected X and Y fields. Auto uses
      the most-varied config field against the active metric. Toggle log scaling
      per axis (learning rate defaults to log), hover a dot for exact values, or
      open the table view for an accessible, sortable readout.
    </>
  );
  return (
    <AnalysisCard title="Hyperparameter scatter" badge={fields.length >= 2 ? `${shortLabel(fields[0])} × ${shortLabel(fields[1])}` : undefined} help={help}>
      <div className="analysis-controls-row">
        <AxisPairControls
          allFields={allFields}
          idPrefix="insights-scatter"
          xAxis={xAxis}
          xDefault={fields[0]}
          xLabel="X axis"
          yAxis={yAxis}
          yDefault={fields[1]}
          yLabel="Y axis"
          onXAxisChange={onXAxisChange}
          onYAxisChange={onYAxisChange}
        />
        <div className="analysis-control-aside">
          <div className="analysis-scale-controls" role="group" aria-label="Axis scale">
            <span className="analysis-scale-label">Scale</span>
            <button
              aria-pressed={xScale === "log"}
              className={`analysis-scale-button${xScale === "log" ? " active" : ""}`}
              onClick={() => setXScaleOverride(xScale === "log" ? "linear" : "log")}
              title="Toggle a logarithmic X axis"
              type="button"
            >X: {xScale === "log" ? "log" : "linear"}</button>
            <button
              aria-pressed={yScale === "log"}
              className={`analysis-scale-button${yScale === "log" ? " active" : ""}`}
              onClick={() => setYScaleOverride(yScale === "log" ? "linear" : "log")}
              title="Toggle a logarithmic Y axis"
              type="button"
            >Y: {yScale === "log" ? "log" : "linear"}</button>
          </div>
          <SegmentedToggle
            ariaLabel="Scatter view"
            className="analysis-view-switch"
            onChange={setView}
            options={[
              { value: "chart", label: "Chart", icon: LineChart },
              { value: "table", label: "Table", icon: Table2 },
            ]}
            value={view}
          />
        </div>
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {view === "table" ? "Scatter summary table selected." : "Scatter chart selected."}
      </span>
      {fields.length < 2 ? (
        <div className="empty compact-empty">Need two numeric fields.</div>
      ) : view === "table" ? (summaryRows.length ? (
        <>
          <ScatterSummaryTable rows={summaryRows} tableId={tableId} xLabel={shortLabel(fields[0])} yLabel={shortLabel(fields[1])} />
          <p className="analysis-note">{formatNumber(summaryRows.length, 0)} runs · ranked by {shortLabel(fields[1])}</p>
        </>
      ) : (
        <div className="empty compact-empty">No runs have both selected fields.</div>
      )) : hasPlot ? (
        <>
          <div className="analysis-chart-shell" ref={shellRef}>
          <div className="analysis-chart-frame analysis-chart-frame--scatter" ref={frameRef}>
            <svg
              className="analysis-scatter"
              onBlur={() => setActiveRunId(null)}
              onFocus={() => setActiveRunId(visiblePoints[0]?.run.id ?? null)}
              role="img"
              tabIndex={0}
              viewBox={`0 0 ${width} ${SCATTER_FRAME_HEIGHT}`}
              aria-label={`Hyperparameter scatter plotting ${fields[0]} (${xScale}) against ${fields[1]} (${yScale}) for ${coverageLabel} runs`}
            >
              <line className="analysis-axis-line" x1={geometry.left} x2={geometry.right} y1="200" y2="200" />
              <line className="analysis-axis-line" x1={geometry.left} x2={geometry.left} y1="16" y2="200" />
              {geometry.xDegenerate ? (
                <text className="analysis-tick" x={geometry.midX} y="214" textAnchor="middle">{formatAxisTick(geometry.minX)}</text>
              ) : (
                <>
                  <text className="analysis-tick" x={geometry.left} y="214">{formatAxisTick(geometry.minX)}</text>
                  <text className="analysis-tick" x={geometry.right} y="214" textAnchor="end">{formatAxisTick(geometry.maxX)}</text>
                </>
              )}
              {geometry.yDegenerate ? (
                <text className="analysis-tick" x="44" y="112" textAnchor="end">{formatAxisTick(geometry.minY)}</text>
              ) : (
                <>
                  <text className="analysis-tick" x="44" y="200" textAnchor="end">{formatAxisTick(geometry.minY)}</text>
                  <text className="analysis-tick" x="44" y="24" textAnchor="end">{formatAxisTick(geometry.maxY)}</text>
                </>
              )}
              <text className="analysis-axis-title" x={geometry.midX} y="228" textAnchor="middle">{shortLabel(fields[0])}{xScale === "log" ? " (log)" : ""}</text>
              <text className="analysis-axis-title" x="16" y="108" textAnchor="middle" transform="rotate(-90 16 108)">{shortLabel(fields[1])}{yScale === "log" ? " (log)" : ""}</text>
              {visiblePoints.map((point) => {
                const label = `${point.run.name}: ${fields[0]}=${formatMetricValue(point.x)}, ${fields[1]}=${formatMetricValue(point.y)}`;
                const active = activeRunId === point.run.id;
                return (
                  <circle
                    aria-label={label}
                    className={active ? "active-point" : undefined}
                    key={point.run.id}
                    cx={geometry.x(point.x)}
                    cy={geometry.y(point.y)}
                    onClick={() => onSelectRun(point.run.id)}
                    onMouseEnter={() => setActiveRunId(point.run.id)}
                    onMouseLeave={() => setActiveRunId(null)}
                    r={active ? "5.5" : "4"}
                  />
                );
              })}
            </svg>
          </div>
          {activePoint ? (
            <ChartPointTip
              anchor={{ x: geometry.x(activePoint.x) - (frameRef.current?.scrollLeft ?? 0), y: geometry.y(activePoint.y) }}
              shellRef={shellRef}
            >
              <div className="chart-tooltip-head">{activePoint.run.name}</div>
              <div className="tip-rows">
                <span>{shortLabel(fields[0])} <b>{formatMetricValue(activePoint.x)}</b></span>
                <span>{shortLabel(fields[1])} <b>{formatMetricValue(activePoint.y)}</b></span>
              </div>
            </ChartPointTip>
          ) : null}
          </div>
          <span className="visually-hidden" role="status" aria-live="polite">
            {activePoint ? `${activePoint.run.name}: ${shortLabel(fields[0])} ${formatMetricValue(activePoint.x)}, ${shortLabel(fields[1])} ${formatMetricValue(activePoint.y)}` : ""}
          </span>
          <p className="analysis-note">{plottedNote}{missingCount ? ` · ${formatNumber(missingCount, 0)} missing one axis` : ""}{droppedCount ? ` · ${formatNumber(droppedCount, 0)} hidden by log scale` : ""} · {scaleNote}</p>
        </>
      ) : (
        <div className="empty compact-empty">No points to plot — switch a log axis back to linear or pick different fields.</div>
      )}
    </AnalysisCard>
  );
}

function ScatterSummaryTable({ rows, tableId, xLabel, yLabel }: { rows: any[]; tableId: string; xLabel: string; yLabel: string }) {
  return (
    <div className="chart-summary-table-wrap analysis-summary-table-wrap">
      <table className="chart-summary-table" id={tableId}>
        <caption>Scatter values: {xLabel} and {yLabel} per run, ranked by {yLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">{xLabel}</th>
            <th scope="col">{yLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.name}>
              <th scope="row" title={row.name}>{row.name}</th>
              <td>{formatMetricValue(row.x)}</td>
              <td>{formatMetricValue(row.y)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClusterCard({
  allFields,
  clusters,
  fields,
  axes,
  points,
  xAxis,
  yAxis,
  onXAxisChange,
  onYAxisChange,
  plotted,
  clustered,
}: {
  allFields: string[];
  clusters: any[];
  fields: string[];
  axes?: string[];
  points: any[];
  xAxis: string;
  yAxis: string;
  onXAxisChange: (value: string) => void;
  onYAxisChange: (value: string) => void;
  plotted: number;
  clustered: number;
}) {
  const [activePointId, setActivePointId] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const { frameRef, width } = useChartFrameWidth(SCATTER_FRAME_WIDTH);
  const geometry = pointGeometry(points, width);
  const axisFields = axes && axes.length === 2 ? axes : fields.slice(0, 2);
  const visiblePoints = points.slice(0, 500);
  const activePoint = activePointId ? points.find((point) => point.id === activePointId) : null;
  const help = (
    <>
      <strong>Runs grouped into k=3 clusters by their standardized config features.</strong>
      <br />
      Numeric config fields are standardized and k-means assigns each run to one
      of three clusters; colour shows the cluster. Axis selectors change the 2D
      projection, while cluster assignment continues to use the full feature set.
    </>
  );
  return (
    <AnalysisCard title="K-means clusters" badge={clusters.length ? `k=${clusters.length}` : undefined} help={help}>
      <AxisPairControls
        allFields={allFields}
        idPrefix="insights-clusters"
        xAxis={xAxis}
        xDefault={axisFields[0]}
        xLabel="X projection"
        yAxis={yAxis}
        yDefault={axisFields[1]}
        yLabel="Y projection"
        onXAxisChange={onXAxisChange}
        onYAxisChange={onYAxisChange}
      />
      {!clusters.length || !geometry ? <div className="empty compact-empty">Need at least three runs and two numeric fields.</div> : (
        <>
          <div className="analysis-chart-shell" ref={shellRef}>
          <div className="analysis-chart-frame analysis-chart-frame--scatter" ref={frameRef}>
            <svg
              className="analysis-scatter clusters"
              onBlur={() => setActivePointId(null)}
              onFocus={() => setActivePointId(visiblePoints[0]?.id ?? null)}
              role="img"
              tabIndex={0}
              viewBox={`0 0 ${width} ${SCATTER_FRAME_HEIGHT}`}
              aria-label={`K-means cluster projection using ${axisFields[0]} and ${axisFields[1]} for ${points.length} runs`}
            >
              <line className="analysis-axis-line" x1="48" x2={geometry.right} y1="200" y2="200" />
              <line className="analysis-axis-line" x1="48" x2="48" y1="16" y2="200" />
              <text className="analysis-axis-title" x={geometry.midX} y="224" textAnchor="middle">{shortLabel(axisFields[0])} (std)</text>
              <text className="analysis-axis-title" x="16" y="108" textAnchor="middle" transform="rotate(-90 16 108)">{shortLabel(axisFields[1])} (std)</text>
              {visiblePoints.map((point) => {
                const pointLabel = `${point.name}: ${axisFields[0]} ${formatNumber(point.x, 2)}, ${axisFields[1]} ${formatNumber(point.y, 2)}, cluster ${point.cluster + 1}`;
                const active = activePointId === point.id;
                return (
                  <circle
                    aria-label={pointLabel}
                    className={`cluster-dot cluster-${point.cluster % 4}${active ? " active-point" : ""}`}
                    key={point.id}
                    cx={geometry.x(point.x)}
                    cy={geometry.y(point.y)}
                    onMouseEnter={() => setActivePointId(point.id)}
                    onMouseLeave={() => setActivePointId(null)}
                    r={active ? "5.5" : "4"}
                  />
                );
              })}
            </svg>
          </div>
          {activePoint ? (
            <ChartPointTip
              anchor={{ x: geometry.x(activePoint.x) - (frameRef.current?.scrollLeft ?? 0), y: geometry.y(activePoint.y) }}
              shellRef={shellRef}
            >
              <div className="chart-tooltip-head">{activePoint.name}</div>
              <div className="tip-rows">
                <span>cluster <b>{activePoint.cluster + 1}</b></span>
                <span>{shortLabel(axisFields[0])} <b>{formatNumber(activePoint.x, 2)}</b></span>
                <span>{shortLabel(axisFields[1])} <b>{formatNumber(activePoint.y, 2)}</b></span>
              </div>
            </ChartPointTip>
          ) : null}
          </div>
          <span className="visually-hidden" role="status" aria-live="polite">
            {activePoint ? `${activePoint.name}: cluster ${activePoint.cluster + 1}, ${shortLabel(axisFields[0])} ${formatNumber(activePoint.x, 2)}, ${shortLabel(axisFields[1])} ${formatNumber(activePoint.y, 2)}` : ""}
          </span>
          <div className="cluster-list">
            {clusters.map((cluster) => <span key={cluster.id}><i className={`cluster-${cluster.id % 4}`} />{cluster.label}: {formatNumber(cluster.count, 0)}</span>)}
          </div>
          <p className="analysis-note">k fixed at 3 · projection shows {shortLabel(axisFields[0])} × {shortLabel(axisFields[1])} · {clusterCoverageNote(visiblePoints.length, plotted || points.length, clustered || points.length)}</p>
        </>
      )}
    </AnalysisCard>
  );
}

const parallelHelp = (
  <>
    <strong>Each run drawn as a line across several numeric fields at once.</strong>
    <br />
    Every vertical axis is one field, scaled to its own min/max. A run is a line
    connecting its value on each axis, so you can trace how individual runs trade off
    across hyperparameters and metrics. The best run for the active metric is highlighted.
  </>
);

const PARALLEL_AXIS_TOP = 32;
const PARALLEL_AXIS_BOTTOM = 220;
const PARALLEL_AXIS_MID = (PARALLEL_AXIS_TOP + PARALLEL_AXIS_BOTTOM) / 2;

const PARALLEL_MAX_DRAWN = 200;

function ParallelCoordinatesCard({
  allFields,
  fields,
  rows,
  metricKey,
  selectedAxes,
  onAxesChange,
  onSelectRun,
}: {
  allFields: string[];
  fields: string[];
  rows: any[];
  metricKey: string;
  selectedAxes: string[];
  onAxesChange: (fields: string[]) => void;
  onSelectRun: (runId: string) => void;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  // Hovered/focused run plus the shell-local point the tooltip anchors to:
  // mouse entry position for a hovered line, the first axis for keyboard focus.
  const [tip, setTip] = useState<{ runId: string; x: number; y: number } | null>(null);
  const tableId = useId();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const { frameRef, width } = useChartFrameWidth(PARALLEL_FRAME_WIDTH);

  if (fields.length < 2) {
    return (
      <AnalysisCard title="Parallel coordinates" help={parallelHelp}>
        <ParallelAxisControls allFields={allFields} fields={fields} onAxesChange={onAxesChange} selectedAxes={selectedAxes} />
        <div className="empty compact-empty">Need at least two numeric fields.</div>
      </AnalysisCard>
    );
  }
  // Cap drawn lines so a 1000-run universe doesn't paint 1000 SVG polylines, and
  // disclose the cap honestly (the prior silent slice(0, 80) read as "80 runs").
  const drawnRows = rows.slice(0, PARALLEL_MAX_DRAWN);
  const truncated = rows.length > drawnRows.length;
  const domains = parallelAxisDomains(drawnRows, fields);
  const xFor = (index: number) => 50 + (index / Math.max(1, fields.length - 1)) * (width - 80);
  const yFor = (value: number, index: number) => {
    const domain = domains[index];
    if (!Number.isFinite(value) || domain.min === null || domain.max === null) return Number.NaN;
    // A constant axis has no spread to scale against; pin every run to the
    // middle so lines pass through it cleanly instead of hugging the bottom.
    if (domain.constant) return PARALLEL_AXIS_MID;
    const span = Math.max(1e-9, domain.max - domain.min);
    return PARALLEL_AXIS_BOTTOM - ((value - domain.min) / span) * 180;
  };
  // Pick the best run by the metric's own goal direction (max for accuracy/auc,
  // min for loss). Sorting ascending unconditionally would highlight the worst
  // run for maximize metrics.
  const minimize = metricGoal(metricKey) === "minimize";
  const bestRunId: string | undefined = drawnRows
    .map((row) => ({ id: row.run.id, value: metricGoalValue(row.run, metricKey) }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => minimize ? (a.value ?? 0) - (b.value ?? 0) : (b.value ?? 0) - (a.value ?? 0))[0]?.id;
  const summaryRows = parallelSummaryRows(drawnRows, fields, bestRunId);
  const coverageNote = `${truncated ? `${formatNumber(drawnRows.length, 0)} shown of ${formatNumber(rows.length, 0)}` : formatNumber(rows.length, 0)} run${rows.length === 1 ? "" : "s"} · best for ${metricTitle(metricKey)} highlighted`;
  const tipRun = tip ? drawnRows.find((row) => row.run.id === tip.runId) : null;
  const chartAriaLabel = `Parallel coordinate chart with axes ${fields.map((field) => shortLabel(field)).join(", ")} for ${truncated ? `${drawnRows.length} of ${rows.length}` : drawnRows.length} runs. Activate to read the best run.`;
  // Keyboard focus anchors the tooltip where the run meets its first axis.
  function focusTipFor(runId: string | null) {
    const row = runId ? drawnRows.find((item) => item.run.id === runId) : null;
    if (!row) return null;
    const y = yFor(row.values[fields[0]], 0);
    return { runId: row.run.id, x: xFor(0) - (frameRef.current?.scrollLeft ?? 0), y: Number.isFinite(y) ? y : PARALLEL_AXIS_MID };
  }
  function lineTipFor(runId: string, event: ReactMouseEvent<SVGPolylineElement>) {
    const bounds = shellRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { runId, x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }
  return (
    <AnalysisCard title="Parallel coordinates" badge={`${fields.length} fields`} help={parallelHelp}>
      <div className="analysis-controls-row">
        <ParallelAxisControls allFields={allFields} fields={fields} onAxesChange={onAxesChange} selectedAxes={selectedAxes} />
        <div className="analysis-control-aside">
          <SegmentedToggle
            ariaLabel="Parallel coordinates view"
            className="analysis-view-switch"
            onChange={(next) => { setView(next); if (next === "table") setTip(null); }}
            options={[
              { value: "chart", label: "Chart", icon: LineChart },
              { value: "table", label: "Table", icon: Table2 },
            ]}
            value={view}
          />
        </div>
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {view === "table" ? "Parallel coordinates summary table selected." : "Parallel coordinates chart selected."}
      </span>
      {view === "table" ? (
        <>
          <ParallelSummaryTable fields={fields} rows={summaryRows} tableId={tableId} />
          <p className="analysis-note">{coverageNote}</p>
        </>
      ) : (
        <>
          <div className="analysis-chart-shell" ref={shellRef}>
          <div className="analysis-chart-frame analysis-chart-frame--wide" ref={frameRef}>
            <svg
              className="parallel-chart"
              viewBox={`0 0 ${width} ${PARALLEL_FRAME_HEIGHT}`}
              role="img"
              tabIndex={0}
              aria-label={chartAriaLabel}
              onFocus={() => setTip(focusTipFor(bestRunId ?? drawnRows[0]?.run.id ?? null))}
              onBlur={() => setTip(null)}
            >
              {fields.map((field, index) => {
                const anchor = edgeAwareTextAnchor(index, fields.length);
                const domain = domains[index];
                const constant = Boolean(domain.constant);
                return (
                  <g key={field}>
                    <line className={`parallel-axis${constant ? " constant" : ""}`} x1={xFor(index)} x2={xFor(index)} y1={PARALLEL_AXIS_TOP} y2={PARALLEL_AXIS_BOTTOM} />
                    {constant ? (
                      // Run the constant readout vertically along its own axis so
                      // neighbouring constant labels can't collide horizontally — with
                      // every config field constant (a single hyperparameter sweep)
                      // the old horizontal labels overran each other.
                      <text
                        className="analysis-tick constant"
                        x={xFor(index) - 4}
                        y={PARALLEL_AXIS_MID}
                        textAnchor="middle"
                        transform={`rotate(-90 ${xFor(index) - 4} ${PARALLEL_AXIS_MID})`}
                      >
                        constant · {formatAxisTick(domain.max)}
                      </text>
                    ) : (
                      <>
                        <text className="analysis-tick" x={xFor(index)} y="26" textAnchor={anchor}>{formatAxisTick(domain.max)}</text>
                        <text className="analysis-tick" x={xFor(index)} y="234" textAnchor={anchor}>{formatAxisTick(domain.min)}</text>
                      </>
                    )}
                    <text className="analysis-axis-title" x={xFor(index)} y="252" textAnchor={anchor}>
                      <title>{field}</title>
                      {shortLabel(field, 14)}
                    </text>
                  </g>
                );
              })}
              {drawnRows.map((row) => {
                const coords = fields.map((field, index) => [xFor(index), yFor(row.values[field], index)]);
                if (coords.some(([, y]) => !Number.isFinite(y))) return null;
                const highlight = row.run.id === bestRunId;
                return (
                  <polyline
                    className={`parallel-line ${highlight ? "highlight" : ""}`}
                    key={row.run.id}
                    onClick={() => onSelectRun(row.run.id)}
                    onMouseEnter={(event) => setTip(lineTipFor(row.run.id, event))}
                    onMouseLeave={() => setTip((current) => (current?.runId === row.run.id ? null : current))}
                    points={coords.map(([x, y]) => `${x},${y}`).join(" ")}
                  />
                );
              })}
            </svg>
          </div>
          {tip && tipRun ? (
            <ChartPointTip anchor={{ x: tip.x, y: tip.y }} shellRef={shellRef}>
              <div className="chart-tooltip-head">{tipRun.run.name}</div>
              <div className="tip-rows">
                {tipRun.run.id === bestRunId ? <span>best for <b>{metricTitle(metricKey)}</b></span> : null}
                {fields.slice(0, 3).map((field) => (
                  <span key={field}>{shortLabel(field)} <b>{Number.isFinite(tipRun.values[field]) ? formatMetricValue(tipRun.values[field]) : "—"}</b></span>
                ))}
              </div>
            </ChartPointTip>
          ) : null}
          </div>
          <span className="visually-hidden" role="status" aria-live="polite">
            {tipRun ? `${tipRun.run.name}${tipRun.run.id === bestRunId ? `, best for ${metricTitle(metricKey)}` : ""}` : ""}
          </span>
          <p className="analysis-note">{coverageNote}</p>
        </>
      )}
    </AnalysisCard>
  );
}

function ParallelSummaryTable({ fields, rows, tableId }: { fields: string[]; rows: any[]; tableId: string }) {
  return (
    <div className="chart-summary-table-wrap analysis-summary-table-wrap">
      <table className="chart-summary-table" id={tableId}>
        <caption>Parallel coordinates values per run across {fields.length} axes</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            {fields.map((field) => <th scope="col" key={field}>{shortLabel(field)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.name} className={row.best ? "is-best" : undefined}>
              <th scope="row" title={row.name}>{row.best ? "★ " : ""}{row.name}</th>
              {fields.map((field) => <td key={field}>{row.values[field] == null ? "—" : formatMetricValue(row.values[field])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pointGeometry(points: Array<{ x: number; y: number }>, width = SCATTER_FRAME_WIDTH) {
  if (!points.length) return null;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  // A field with no spread (every run shares the value, e.g. a constant
  // batch_size) would otherwise pin every point to the axis origin and print the
  // same number at both ends. Center those points and flag the axis so the
  // renderer can show a single tick instead of a duplicated min/max pair.
  const xDegenerate = maxX - minX < 1e-9;
  const yDegenerate = maxY - minY < 1e-9;
  const xSpan = Math.max(1e-9, maxX - minX);
  const ySpan = Math.max(1e-9, maxY - minY);
  const right = Math.max(88, width - 32);
  const midX = (48 + right) / 2;
  return {
    x: (value: number) => (xDegenerate ? midX : 48 + ((value - minX) / xSpan) * (right - 48)),
    y: (value: number) => (yDegenerate ? 108 : 200 - ((value - minY) / ySpan) * 176),
    minX, maxX, minY, maxY, xDegenerate, yDegenerate, right, midX,
  };
}

// "N shown of M/M clustered runs" was noise: plotted and clustered only differ
// when the 500-point draw cap kicks in, so disclose the cap only when it does.
function clusterCoverageNote(shown: number, plotted: number, clustered: number) {
  const total = Math.max(plotted, clustered);
  if (shown < total) return `${formatNumber(shown, 0)} shown of ${formatNumber(total, 0)} clustered runs`;
  return `${formatNumber(total, 0)} clustered run${total === 1 ? "" : "s"}`;
}

function chooseScatterFields(numeric: { fields: string[]; rows: any[] }): string[] {
  const distinct = (field: string) => new Set(numeric.rows.map((row) => row.values[field]).filter(Number.isFinite)).size;
  const configFields = numeric.fields.filter((field) => field.startsWith("config."));
  const xField = configFields.slice().sort((a, b) => distinct(b) - distinct(a))[0];
  const metricField = numeric.fields.find((field) => field.startsWith("metric.best.")) ?? numeric.fields.find((field) => field.startsWith("metric."));
  if (xField && metricField && xField !== metricField) return [xField, metricField];
  return numeric.fields.slice(0, 2);
}

function AxisPairControls({
  allFields,
  idPrefix,
  xAxis,
  xDefault,
  xLabel,
  yAxis,
  yDefault,
  yLabel,
  onXAxisChange,
  onYAxisChange,
}: {
  allFields: string[];
  idPrefix: string;
  xAxis: string;
  xDefault: string;
  xLabel: string;
  yAxis: string;
  yDefault: string;
  yLabel: string;
  onXAxisChange: (value: string) => void;
  onYAxisChange: (value: string) => void;
}) {
  return (
    <div className="axis-control-grid two">
      <AxisSelect
        allFields={allFields}
        id={`${idPrefix}-x`}
        label={xLabel}
        onChange={onXAxisChange}
        selectedValue={validControlValue(xAxis, allFields)}
        disabledFields={new Set([yAxis === AUTO_AXIS ? yDefault : yAxis].filter(Boolean))}
        autoLabel={`Auto: ${shortLabel(xDefault)}`}
      />
      <AxisSelect
        allFields={allFields}
        id={`${idPrefix}-y`}
        label={yLabel}
        onChange={onYAxisChange}
        selectedValue={validControlValue(yAxis, allFields)}
        disabledFields={new Set([xAxis === AUTO_AXIS ? xDefault : xAxis].filter(Boolean))}
        autoLabel={`Auto: ${shortLabel(yDefault)}`}
      />
    </div>
  );
}

function ParallelAxisControls({
  allFields,
  fields,
  selectedAxes,
  onAxesChange,
}: {
  allFields: string[];
  fields: string[];
  selectedAxes: string[];
  onAxesChange: (fields: string[]) => void;
}) {
  const controls = selectedAxes.length ? selectedAxes : fields.map(() => AUTO_AXIS);
  function replaceAxis(index: number, value: string) {
    const next = controls.slice();
    next[index] = value;
    onAxesChange(next);
  }
  function addAxis() {
    if (controls.length >= MAX_PARALLEL_AXES) return;
    onAxesChange([...controls, AUTO_AXIS]);
  }
  function removeAxis(index: number) {
    if (controls.length <= 2) return;
    const next = fields.filter((_, itemIndex) => itemIndex !== index);
    onAxesChange(next.length >= 2 ? next : controls.filter((_, itemIndex) => itemIndex !== index));
  }
  return (
    <div className="parallel-axis-controls">
      <div className="axis-control-grid parallel">
        {controls.map((value, index) => {
          const resolvedField = fields[index] ?? "";
          const selectedValue = value !== AUTO_AXIS && value === resolvedField ? value : AUTO_AXIS;
          return (
            <div className="parallel-axis-control" key={`${index}-${resolvedField || value}`}>
              <AxisSelect
                allFields={allFields}
                autoLabel={`Auto: ${shortLabel(resolvedField || allFields[index] || "")}`}
                disabledFields={new Set(fields.filter((entry, itemIndex) => itemIndex !== index && entry))}
                id={`insights-parallel-axis-${index}`}
                label={`Axis ${index + 1}`}
                onChange={(next) => replaceAxis(index, next)}
                selectedValue={validControlValue(selectedValue, allFields)}
              />
              <button
                aria-label={`Remove axis ${index + 1}`}
                className="axis-icon-button"
                disabled={controls.length <= 2}
                onClick={() => removeAxis(index)}
                type="button"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button className="axis-add-button" disabled={controls.length >= MAX_PARALLEL_AXES} onClick={addAxis} type="button">
        <Plus size={14} aria-hidden="true" /> Add axis
      </button>
    </div>
  );
}

function AxisSelect({
  allFields,
  autoLabel,
  disabledFields = new Set(),
  id,
  label,
  onChange,
  selectedValue,
}: {
  allFields: string[];
  autoLabel: string;
  disabledFields?: Set<string>;
  id: string;
  label: string;
  onChange: (value: string) => void;
  selectedValue: string;
}) {
  const options = axisOptions(allFields, autoLabel, selectedValue, disabledFields);
  return (
    <CustomSelect
      className="axis-select"
      disabled={!allFields.length}
      id={id}
      label={label}
      onChange={onChange}
      options={options}
      value={selectedValue}
    />
  );
}

function axisOptions(fields: string[], autoLabel: string, selectedValue: string, disabledFields: Set<string>): SelectOption[] {
  const limited = fields.slice(0, MAX_AXIS_OPTIONS);
  const visible = selectedValue !== AUTO_AXIS && fields.includes(selectedValue) && !limited.includes(selectedValue)
    ? [...limited, selectedValue]
    : limited;
  return [
    { value: AUTO_AXIS, label: autoLabel || "Auto" },
    ...visible.map((field) => ({
      value: field,
      label: shortLabel(field, 28),
      disabled: disabledFields.has(field),
    })),
  ];
}

function resolveAxisPair(fields: string[], defaults: string[], xOverride: string, yOverride: string): string[] {
  const x = validField(xOverride, fields) ? xOverride : defaults.find((field) => validField(field, fields)) ?? fields[0] ?? "";
  const y = validField(yOverride, fields) && yOverride !== x
    ? yOverride
    : defaults.find((field) => validField(field, fields) && field !== x) ?? fields.find((field) => field !== x) ?? "";
  return [x, y].filter(Boolean);
}

function resolveParallelFields(fields: string[], defaults: string[], overrides: string[]): string[] {
  const chosen: string[] = [];
  const slots = Math.max(2, Math.min(MAX_PARALLEL_AXES, overrides.length || defaults.length || 2));
  for (let index = 0; index < slots; index += 1) {
    const requested = overrides[index];
    const fallback = defaults.find((field) => validField(field, fields) && !chosen.includes(field))
      ?? fields.find((field) => !chosen.includes(field));
    const field = validField(requested, fields) && !chosen.includes(requested) ? requested : fallback;
    if (field && fields.includes(field) && !chosen.includes(field)) chosen.push(field);
  }
  return chosen;
}

function validControlValue(value: string, fields: string[]) {
  return value !== AUTO_AXIS && fields.includes(value) ? value : AUTO_AXIS;
}

function validField(value: string | undefined, fields: string[]) {
  return Boolean(value && value !== AUTO_AXIS && fields.includes(value));
}

function edgeAwareTextAnchor(index: number, count: number): "start" | "middle" | "end" {
  if (index === 0) return "start";
  if (index === count - 1) return "end";
  return "middle";
}

function shortLabel(label: string, max = 18) {
  const compact = label.replace(/^config\./, "").replace(/^metric\.(latest|best)\./, "");
  return compact.length > max ? `${compact.slice(0, Math.max(1, max - 1))}…` : compact;
}
