"use client";

import { useEffect, useMemo, useState } from "react";

import { isAbortError, queryString } from "../../../src/api.js";
import { formatNumber } from "../../../src/state.js";
import { metricTitle } from "../../dashboard-models";
import type { RunSummary } from "../../dashboard-types";
import { CustomSelect } from "../ui/select";

type RankReducerPoint = {
  step: number;
  rank_count: number;
  expected_world_size: number;
  world_size_mismatch: boolean;
  mean: number;
  weighted_mean: number;
  min: number;
  max: number;
  stddev: number;
  p05: number;
  p50: number;
  p95: number;
};

type RankHeatmapPoint = {
  step: number;
  rank: number;
  value: number;
  delta_from_mean: number;
};

type RankOutlierPoint = {
  rank: number;
  step: number;
  value: number;
  delta_from_mean: number;
  z_score: number;
};

type RankCoveragePoint = {
  step: number;
  rank_count: number;
  expected_world_size: number;
  missing_rank_count: number;
  missing_ranks: number[];
  world_size_mismatch: boolean;
};

type RankSummary = {
  keys: string[];
  key: string | null;
  reducers: RankReducerPoint[];
  heatmap: RankHeatmapPoint[];
  outliers: RankOutlierPoint[];
  coverage: RankCoveragePoint[];
  limits: { max_canonical_rows: number; max_heatmap_cells: number; outlier_limit: number; step_limit: number };
  truncated: { steps: boolean; heatmap: boolean; outliers: boolean };
};

type Props = {
  api: { get: (path: string, options?: Record<string, unknown>) => Promise<any> };
  embedded?: boolean;
  primaryRun: RunSummary | null;
};

export function DistributedTabPane({ api, embedded = false, primaryRun }: Props) {
  const [summary, setSummary] = useState<RankSummary | null>(null);
  const [rankKey, setRankKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!primaryRun?.id) {
      setSummary(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.get(
      `/api/runs/${primaryRun.id}/rank-metrics/summary${queryString({ key: rankKey, limit: 1000 })}`,
      { signal: controller.signal },
    ).then((payload) => {
      const next = payload as RankSummary;
      setSummary(next);
      if (!rankKey && next.key) setRankKey(next.key);
    }).catch((err) => {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "Unable to load rank metrics.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, primaryRun?.id, rankKey]);

  const keyOptions = (summary?.keys ?? []).map((key) => ({ value: key, label: key }));
  const latestReducer = summary?.reducers.at(-1) ?? null;

  return (
    <div className={`analysis-page distributed-page ${embedded ? "embedded-analysis" : ""}`}>
      <header className="analysis-header">
        <div>
          <p className="eyebrow">{embedded ? "Reduce graphs" : "Distributed"}</p>
          <h1>{embedded ? "Rank Reducers" : "Rank Metrics"}</h1>
          <span>{primaryRun ? `${primaryRun.name} · selected run` : "No run selected"}</span>
        </div>
        <div className="analysis-controls">
          <CustomSelect
            id="rank-key"
            label="Rank key"
            onChange={setRankKey}
            options={keyOptions.length ? keyOptions : [{ value: "", label: "No rank keys", disabled: true }]}
            value={rankKey}
          />
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {!primaryRun ? <div className="empty">Select a run to inspect distributed rank metrics.</div> : null}
      {primaryRun && loading && !summary ? <div className="empty">Loading rank metrics...</div> : null}
      {primaryRun && summary && !summary.keys.length ? <div className="empty">No rank metrics logged for this run yet.</div> : null}

      {summary && summary.keys.length ? (
        <>
          {summary.truncated.steps ? <div className="banner">Showing the newest {summary.limits.step_limit} steps to keep rank reducer reads bounded.</div> : null}
          <section className="analysis-grid four">
            <MetricTile label="Ranks" value={latestReducer ? `${latestReducer.rank_count}/${latestReducer.expected_world_size}` : "-"} />
            <MetricTile label="Weighted mean" value={formatNumber(latestReducer?.weighted_mean, 4)} />
            <MetricTile label="Range" value={latestReducer ? `${formatNumber(latestReducer.min, 3)}-${formatNumber(latestReducer.max, 3)}` : "-"} />
            <MetricTile label="Stddev" value={formatNumber(latestReducer?.stddev, 4)} />
          </section>
          <section className="analysis-grid two">
            <ReducerChart metricKey={summary.key ?? rankKey} reducers={summary.reducers} />
            <CoveragePanel coverage={summary.coverage} />
          </section>
          <section className="analysis-grid two">
            <HeatmapPanel heatmap={summary.heatmap} truncated={summary.truncated.heatmap} />
            <OutlierPanel outliers={summary.outliers} truncated={summary.truncated.outliers} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <article className="analysis-card metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ReducerChart({ metricKey, reducers }: { metricKey: string; reducers: RankReducerPoint[] }) {
  const geometry = useMemo(() => chartGeometry(reducers), [reducers]);
  if (!reducers.length || !geometry) return <div className="analysis-card"><div className="empty compact-empty">No reducer points.</div></div>;
  return (
    <article className="analysis-card chart-card">
      <h2>{metricTitle(metricKey)} reducers</h2>
      <svg className="analysis-line-chart" viewBox="0 0 720 280" role="img" aria-label="Rank reducer chart">
        {geometry.yTicks.map((tick) => (
          <g key={tick}>
            <line className="grid-line" x1="46" x2="700" y1={geometry.y(tick)} y2={geometry.y(tick)} />
            <text className="tick-label" x="38" y={geometry.y(tick) + 4} textAnchor="end">{formatNumber(tick, 2)}</text>
          </g>
        ))}
        <polyline className="rank-band-line min" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.min)}`).join(" ")} />
        <polyline className="rank-band-line max" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.max)}`).join(" ")} />
        <polyline className="rank-mean-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.mean)}`).join(" ")} />
        <polyline className="rank-weighted-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.weighted_mean)}`).join(" ")} />
      </svg>
      <div className="analysis-legend">
        <span><i className="legend-dot rank-mean" /> mean</span>
        <span><i className="legend-dot rank-weighted" /> weighted</span>
        <span><i className="legend-dot rank-band" /> min/max</span>
      </div>
    </article>
  );
}

function CoveragePanel({ coverage }: { coverage: RankCoveragePoint[] }) {
  const latest = coverage.at(-1);
  return (
    <article className="analysis-card">
      <h2>Coverage</h2>
      <div className="coverage-strip">
        {coverage.slice(-80).map((point) => {
          const ratio = point.expected_world_size ? point.rank_count / point.expected_world_size : 0;
          return <span key={point.step} style={{ opacity: 0.25 + ratio * 0.75 }} title={`Step ${point.step}: ${point.rank_count}/${point.expected_world_size}`} />;
        })}
      </div>
      <p className="analysis-note">
        {latest ? `${latest.rank_count}/${latest.expected_world_size} ranks at step ${formatNumber(latest.step, 0)}` : "No coverage points."}
        {latest?.world_size_mismatch ? " · world-size mismatch" : ""}
      </p>
      {latest?.missing_ranks?.length ? <div className="rank-chip-row">{latest.missing_ranks.slice(0, 24).map((rank) => <span key={rank}>r{rank}</span>)}</div> : null}
    </article>
  );
}

function HeatmapPanel({ heatmap, truncated }: { heatmap: RankHeatmapPoint[]; truncated: boolean }) {
  const maxDelta = Math.max(0.000001, ...heatmap.map((point) => Math.abs(point.delta_from_mean)));
  return (
    <article className="analysis-card">
      <h2>Rank Heatmap</h2>
      {truncated ? <p className="analysis-note">Sampled to stay under the heatmap cell cap.</p> : null}
      <div className="rank-heatmap">
        {heatmap.map((point, index) => {
          const intensity = Math.min(1, Math.abs(point.delta_from_mean) / maxDelta);
          const hue = point.delta_from_mean >= 0 ? "var(--color-danger, #dc5b55)" : "var(--accent)";
          return (
            <span
              key={`${point.step}-${point.rank}-${index}`}
              style={{ backgroundColor: hue, opacity: 0.18 + intensity * 0.78 }}
              title={`step ${point.step} rank ${point.rank}: ${formatNumber(point.value, 4)}`}
            />
          );
        })}
      </div>
    </article>
  );
}

function OutlierPanel({ outliers, truncated }: { outliers: RankOutlierPoint[]; truncated: boolean }) {
  return (
    <article className="analysis-card">
      <h2>Outliers</h2>
      {truncated ? <p className="analysis-note">Showing highest-deviation ranks.</p> : null}
      <div className="analysis-table">
        {outliers.map((item) => (
          <div className="analysis-row" key={`${item.step}-${item.rank}`}>
            <span>r{item.rank}</span>
            <span>step {formatNumber(item.step, 0)}</span>
            <strong>{formatNumber(item.value, 4)}</strong>
            <span>{formatNumber(item.z_score, 2)}z</span>
          </div>
        ))}
        {!outliers.length ? <div className="empty compact-empty">No outliers.</div> : null}
      </div>
    </article>
  );
}

function chartGeometry(points: RankReducerPoint[]) {
  if (!points.length) return null;
  const minX = Math.min(...points.map((point) => point.step));
  const maxX = Math.max(...points.map((point) => point.step));
  const minY = Math.min(...points.flatMap((point) => [point.min, point.mean, point.weighted_mean]));
  const maxY = Math.max(...points.flatMap((point) => [point.max, point.mean, point.weighted_mean]));
  const xSpan = Math.max(1, maxX - minX);
  const ySpan = Math.max(1e-9, maxY - minY);
  const x = (value: number) => 46 + ((value - minX) / xSpan) * 654;
  const y = (value: number) => 244 - ((value - minY) / ySpan) * 200;
  const yTicks = [minY, minY + ySpan / 2, maxY];
  return { x, y, yTicks };
}
