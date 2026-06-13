"use client";

import { chartColor, chartStyleIndexesForItems } from "../../../src/chart-colors.js";
import { formatMetricValue } from "../../../src/charts.js";
import { bestMetric, formatNumber } from "../../../src/state.js";
import { MetricChart } from "../metrics/metric-chart";
import { compactCount, MiniSpark, tickerShortRunName } from "../chrome/ticker";
import type { ShellTabId } from "../../dashboard-config";
import type { AlertRow, MetricSeries, Overview, RunSummary } from "../../dashboard-types";

// Overview — the cockpit page from docs/design/reimagine/overview.html,
// composed strictly from data the shell already loads: `overview` counters,
// alertRows, the page's running runs, and their metric series. Anything the
// mock fakes (ETA, GPUs, fleet throughput, ingest rates) is omitted.

const ALERT_FEED_LIMIT = 5;

const SEVERITY_WEIGHT: Record<string, number> = { critical: 0, warning: 1, active: 2, info: 3 };

function alertSeverityRank(row: AlertRow) {
  return SEVERITY_WEIGHT[row.severity] ?? 3;
}

function alertDotTone(row: AlertRow) {
  if (row.tone === "bad") return "crit";
  if (row.tone === "warn") return "warn";
  // "still running" rows are informational in a health feed — blue, not green
  // (green stays reserved for live/best markers).
  return "info";
}

function configTotalSteps(run: RunSummary): number | null {
  const raw = run.config?.total_steps ?? run.config?.steps;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function latestStep(run: RunSummary, metricKey: string): number | null {
  const primary = run.metric_aggregates?.[metricKey]?.latest_step;
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  let best: number | null = null;
  for (const aggregate of Object.values(run.metric_aggregates ?? {})) {
    const step = aggregate?.latest_step;
    if (typeof step === "number" && Number.isFinite(step)) best = best === null ? step : Math.max(best, step);
  }
  return best;
}

function splitCompact(value: number): { num: string; suffix: string } {
  const compact = compactCount(value);
  const match = compact.match(/^([\d.]+)([A-Za-z]*)$/);
  return match ? { num: match[1], suffix: match[2] } : { num: compact, suffix: "" };
}

export function OverviewTabPane({
  alertRows,
  initialLoadDone,
  metricKey,
  onOpenRun,
  onSelectTab,
  overview,
  project,
  runningRuns,
  series,
  sparkValues,
}: {
  alertRows: AlertRow[];
  initialLoadDone: boolean;
  metricKey: string;
  onOpenRun: (runId: string) => void;
  onSelectTab: (tab: ShellTabId) => void;
  overview: Overview;
  project: string;
  runningRuns: RunSummary[];
  series: MetricSeries[];
  sparkValues: Record<string, number[]>;
}) {
  const chartSeries = series.filter((item) => item.points.length > 0);
  const styleIndexes = chartStyleIndexesForItems(chartSeries);
  const critCount = alertRows.filter((row) => row.severity === "critical").length;
  const warnCount = alertRows.filter((row) => row.severity === "warning").length;
  const points = splitCompact(overview.metric_points);
  const bestRunning = runningRuns.reduce<number | null>((best, run) => {
    const value = bestMetric(run, metricKey);
    if (value === null) return best;
    return best === null ? value : Math.max(best, value);
  }, null);

  return (
    <div className="ov">
      <div className="ov-page-head">
        <div>
          <div className="mlabel ov-crumb">instantml<span className="ov-sep">/</span>{project || "all projects"}</div>
          <h1>Overview</h1>
        </div>
      </div>

      {/* Stat strip */}
      <div className="ov-grid">
        <section className="ov-panel ov-col-3">
          <div className="ov-panel-head">
            <span className="mlabel">Active runs</span>
            {overview.active_runs > 0 ? <span className="pulse" aria-hidden="true" /> : null}
          </div>
          <div className="ov-panel-body ov-stat">
            <span className="ov-stat-value">
              {formatNumber(overview.active_runs, 0)}
              <small> / {formatNumber(overview.total_runs, 0)} total</small>
            </span>
          </div>
        </section>
        <section className="ov-panel ov-col-3">
          <div className="ov-panel-head"><span className="mlabel">Failed runs</span></div>
          <div className="ov-panel-body ov-stat">
            <span className={`ov-stat-value ${overview.failed_runs ? "is-crit" : ""}`}>
              {formatNumber(overview.failed_runs, 0)}
            </span>
          </div>
        </section>
        <section className="ov-panel ov-col-3">
          <div className="ov-panel-head"><span className="mlabel">Metric points</span><span className="ov-unit">pts</span></div>
          <div className="ov-panel-body ov-stat">
            <span className="ov-stat-value">
              {points.num}
              {points.suffix ? <small>{points.suffix}</small> : null}
            </span>
          </div>
        </section>
        <section className="ov-panel ov-col-3">
          <div className="ov-panel-head"><span className="mlabel">Open alerts</span></div>
          <div className="ov-panel-body ov-stat">
            {/* Count only actionable findings (crit + warn) so the headline
                reconciles with its breakdown; "still running" is informational. */}
            <span className={`ov-stat-value ${critCount ? "is-crit" : ""}`}>
              {formatNumber(critCount + warnCount, 0)}
              {critCount + warnCount ? <small> {critCount} crit · {warnCount} warn</small> : null}
            </span>
          </div>
        </section>
      </div>

      {/* Main chart + alert feed */}
      <div className="ov-grid">
        <section className="ov-panel ov-col-8">
          <div className="ov-panel-head">
            <span className="mlabel">{metricKey} — active runs</span>
            {runningRuns.length ? (
              <span className="ov-chip ov-chip--live"><span className="pulse pulse--sm" aria-hidden="true" />Streaming</span>
            ) : null}
            <span className="ov-unit">step</span>
          </div>
          <div className="ov-panel-body ov-panel-body--chart">
            <MetricChart
              emptyMessage={initialLoadDone ? "No active runs are streaming this metric." : "Loading runs..."}
              height={224}
              metricKey={metricKey}
              series={chartSeries}
              showLegend={false}
              showRange={false}
              showYAxisControls={false}
              xMode="step"
            />
            {chartSeries.length ? (
              <div className="ov-legend">
                {chartSeries.map((item, index) => (
                  <span className="ov-legend-item" key={item.id}>
                    <i style={{ background: chartColor(styleIndexes[index] ?? index) }} />
                    {item.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        <section className="ov-panel ov-col-4">
          <div className="ov-panel-head">
            <span className="mlabel">Alert feed</span>
            <button className="mlabel ov-link" onClick={() => onSelectTab("alerts")} type="button">View all →</button>
          </div>
          <div className="ov-panel-body ov-panel-body--flush">
            {alertRows.length ? (
              [...alertRows].sort((a, b) => alertSeverityRank(a) - alertSeverityRank(b)).slice(0, ALERT_FEED_LIMIT).map((row) => (
                <div className="ov-feed-row" key={row.id}>
                  <span className={`ov-dot ov-dot--${alertDotTone(row)}`} aria-hidden="true" />
                  <div className="ov-feed-body">
                    <div className="ov-feed-title">{row.title}</div>
                    <div className="ov-feed-meta">{row.detail} · <span className="ov-tag">{row.label}</span></div>
                  </div>
                </div>
              ))
            ) : (
              <div className="ov-empty">{initialLoadDone ? "No open alerts." : "Loading alerts..."}</div>
            )}
          </div>
        </section>
      </div>

      {/* Active runs table */}
      <div className="ov-grid">
        <section className="ov-panel ov-col-12">
          <div className="ov-panel-head">
            <span className="mlabel">Active runs</span>
            <button className="mlabel ov-link" onClick={() => onSelectTab("runs")} type="button">All runs →</button>
          </div>
          <div className="ov-panel-body ov-panel-body--flush" style={{ overflowX: "auto" }}>
            <table className="ov-dtable">
              <thead>
                <tr>
                  <th aria-label="Status dot" />
                  <th>Run</th>
                  <th>Trend</th>
                  <th style={{ textAlign: "right" }}>{metricKey}</th>
                  <th>Progress</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {runningRuns.length ? (
                  runningRuns.map((run, index) => {
                    const latest = bestMetric(run, metricKey);
                    const total = configTotalSteps(run);
                    const step = latestStep(run, metricKey);
                    const pct = total && step !== null ? Math.max(0, Math.min(100, Math.round((step / total) * 100))) : null;
                    const spark = sparkValues[run.id];
                    return (
                      <tr key={run.id} onClick={() => onOpenRun(run.id)}>
                        <td style={{ width: 24 }}><span className="ov-dot ov-dot--ok" aria-hidden="true" /></td>
                        <td className="ov-td-name">
                          {run.name}
                          <span className="ov-td-dim ov-td-id">{run.id.slice(0, 8)}</span>
                        </td>
                        <td>
                          {spark && spark.length >= 2 ? (
                            <MiniSpark color={chartColor(index)} height={18} live values={spark} width={76} />
                          ) : (
                            <span className="ov-td-dim">—</span>
                          )}
                        </td>
                        <td className={`ov-td-num ${latest !== null && latest === bestRunning ? "is-best" : ""}`}>
                          {latest === null ? "—" : formatMetricValue(latest)}
                        </td>
                        <td>
                          {pct !== null ? (
                            <span className="ov-meter-cell">
                              <span className="ov-meter"><i style={{ width: `${pct}%` }} /></span>
                              <span className="ov-td-dim ov-meter-pct">{pct}%</span>
                            </span>
                          ) : step !== null ? (
                            <span className="ov-td-dim">step {formatNumber(step, 0)}</span>
                          ) : (
                            <span className="ov-td-dim">—</span>
                          )}
                        </td>
                        <td><span className="ov-chip ov-chip--live">running</span></td>
                      </tr>
                    );
                  })
                ) : (
                  <tr className="ov-row-empty">
                    <td colSpan={6}>{initialLoadDone ? "No active runs." : "Loading runs..."}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
