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
  const activeKey = summary?.key ?? rankKey;
  const hasData = Boolean(summary && summary.keys.length);

  const keySelect = (
    <CustomSelect
      id="rank-key"
      label="Rank key"
      onChange={setRankKey}
      options={keyOptions.length ? keyOptions : [{ value: "", label: "No rank keys", disabled: true }]}
      value={rankKey}
    />
  );

  return (
    <div className={`analysis-page distributed-page ${embedded ? "embedded-analysis" : ""}`}>
      {embedded ? (
        <div className="advanced-section-band">
          <span className="seg"><i className="dot" />Distributed rank analysis</span>
          <span className="rule" />
          {hasData ? <div className="band-control">{keySelect}</div> : (
            <span className="hint">{primaryRun ? "no rank metrics" : "no run selected"}</span>
          )}
        </div>
      ) : (
        <header className="analysis-header">
          <div className="analysis-title-block">
            <span className="analysis-eyebrow eyebrow--accent">Distributed</span>
            <h2>Rank <span className="serif-em">reducers</span></h2>
            <p>{primaryRun ? `${primaryRun.name} · selected run` : "No run selected"}</p>
          </div>
          <div className="analysis-controls">{keySelect}</div>
        </header>
      )}

      {error ? <div className="banner error">{error}</div> : null}
      {!primaryRun ? <div className="empty">Select a run to inspect distributed rank metrics.</div> : null}
      {primaryRun && loading && !summary ? <div className="empty">Loading rank metrics...</div> : null}
      {primaryRun && summary && !summary.keys.length ? <div className="empty">No rank metrics logged for this run yet.</div> : null}

      {hasData ? (
        <>
          {summary!.truncated.steps ? <div className="banner">Showing the newest {summary!.limits.step_limit} steps to keep rank reducer reads bounded.</div> : null}
          <div className="rank-tile-strip">
            <Tile label="Ranks reporting" value={latestReducer ? `${latestReducer.rank_count} / ${latestReducer.expected_world_size}` : "-"} sub={latestReducer?.world_size_mismatch ? "world-size mismatch" : "full coverage"} />
            <Tile label="Weighted mean" value={formatNumber(latestReducer?.weighted_mean, 4)} sub={latestReducer ? `${signed(latestReducer.weighted_mean - latestReducer.mean, 4)} vs mean` : ""} />
            <Tile label="Rank spread (p05–p95)" value={latestReducer ? `${formatNumber(latestReducer.p05, 3)} – ${formatNumber(latestReducer.p95, 3)}` : "-"} sub={latestReducer ? `min/max ${formatNumber(latestReducer.min, 3)}–${formatNumber(latestReducer.max, 3)}` : ""} />
            <Tile label="Std dev" value={formatNumber(latestReducer?.stddev, 4)} sub="across ranks" />
          </div>
          <section className="analysis-grid two">
            <ReducerChart metricKey={activeKey} reducers={summary!.reducers} />
            <CoveragePanel coverage={summary!.coverage} />
          </section>
          <section className="analysis-grid two">
            <PerRankPanel heatmap={summary!.heatmap} metricKey={activeKey} />
            <OutlierPanel outliers={summary!.outliers} truncated={summary!.truncated.outliers} worldSize={latestReducer?.expected_world_size ?? 0} />
          </section>
          <section className="analysis-grid one">
            <HeatmapPanel heatmap={summary!.heatmap} truncated={summary!.truncated.heatmap} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <article className="rank-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub ? <small>{sub}</small> : null}
    </article>
  );
}

function ReducerChart({ metricKey, reducers }: { metricKey: string; reducers: RankReducerPoint[] }) {
  const geometry = useMemo(() => chartGeometry(reducers), [reducers]);
  if (!reducers.length || !geometry) {
    return <Card title="Rank reducers"><div className="empty compact-empty">No reducer points.</div></Card>;
  }
  const bandTop = reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.p95)}`);
  const bandBottom = reducers.slice().reverse().map((point) => `${geometry.x(point.step)},${geometry.y(point.p05)}`);
  return (
    <Card title={`${metricTitle(metricKey)} reducers`} badge={metricKey}>
      <svg className="analysis-line-chart" viewBox="0 0 720 280" role="img" aria-label="Rank reducer chart">
        {geometry.yTicks.map((tick) => (
          <g key={tick}>
            <line className="analysis-grid-line" x1="52" x2="700" y1={geometry.y(tick)} y2={geometry.y(tick)} />
            <text className="analysis-tick" x="46" y={geometry.y(tick) + 4} textAnchor="end">{formatNumber(tick, 3)}</text>
          </g>
        ))}
        <line className="analysis-axis-line" x1="52" x2="700" y1="244" y2="244" />
        <polygon className="rank-band-area" points={[...bandTop, ...bandBottom].join(" ")} />
        <polyline className="rank-median-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.p50)}`).join(" ")} />
        <polyline className="rank-mean-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.mean)}`).join(" ")} />
        <polyline className="rank-weighted-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.weighted_mean)}`).join(" ")} />
        <text className="analysis-tick" x="52" y="262">{formatNumber(geometry.minX, 0)}</text>
        <text className="analysis-tick" x="700" y="262" textAnchor="end">{formatNumber(geometry.maxX, 0)}</text>
        <text className="analysis-axis-title" x="376" y="276" textAnchor="middle">step</text>
      </svg>
      <div className="analysis-legend">
        <span><i className="rank-mean" /> mean</span>
        <span><i className="rank-weighted" /> weighted</span>
        <span><i className="rank-median" /> median (p50)</span>
        <span><i className="swatch rank-band" /> p05–p95</span>
      </div>
    </Card>
  );
}

function CoveragePanel({ coverage }: { coverage: RankCoveragePoint[] }) {
  const latest = coverage.at(-1);
  // Downsample the FULL step range into buckets keeping the worst coverage per
  // bucket, so a partial/missing-rank window anywhere in training stays visible
  // (a tail-only view would hide earlier gaps).
  const buckets = useMemo(() => coverageBuckets(coverage, 64), [coverage]);
  const gaps = coverage.filter((point) => point.rank_count < point.expected_world_size).length;
  return (
    <Card title="Rank coverage">
      <div className="coverage-strip">
        {buckets.map((bucket) => (
          <span key={bucket.step} className={bucket.mismatch ? "mismatch" : bucket.ratio < 1 ? "partial" : ""} style={{ height: `${Math.max(8, bucket.ratio * 100)}%` }} title={`~step ${formatNumber(bucket.step, 0)}: ${formatNumber(bucket.ratio * 100, 0)}% ranks reporting`} />
        ))}
      </div>
      <p className="analysis-note">
        {latest ? `${latest.rank_count}/${latest.expected_world_size} ranks at step ${formatNumber(latest.step, 0)}` : "No coverage points."}
        {gaps ? ` · ${formatNumber(gaps, 0)} step(s) with partial coverage` : " · full coverage across logged steps"}
      </p>
      {latest?.missing_ranks?.length ? (
        <div className="rank-chip-row">
          {latest.missing_ranks.slice(0, 24).map((rank) => <span key={rank}>missing r{rank}</span>)}
        </div>
      ) : null}
    </Card>
  );
}

function coverageBuckets(coverage: RankCoveragePoint[], count: number) {
  if (!coverage.length) return [] as Array<{ step: number; ratio: number; mismatch: boolean }>;
  const size = Math.max(1, Math.ceil(coverage.length / count));
  const buckets: Array<{ step: number; ratio: number; mismatch: boolean }> = [];
  for (let i = 0; i < coverage.length; i += size) {
    const slice = coverage.slice(i, i + size);
    let worst = Infinity;
    let mismatch = false;
    let worstPoint = slice[0];
    for (const point of slice) {
      const ratio = point.expected_world_size ? Math.min(1, point.rank_count / point.expected_world_size) : 0;
      if (ratio < worst) { worst = ratio; worstPoint = point; }
      if (point.world_size_mismatch) mismatch = true;
    }
    buckets.push({ step: worstPoint.step, ratio: worst === Infinity ? 0 : worst, mismatch });
  }
  return buckets;
}

function PerRankPanel({ heatmap, metricKey }: { heatmap: RankHeatmapPoint[]; metricKey: string }) {
  const snapshot = useMemo(() => perRankAtLatestStep(heatmap), [heatmap]);
  if (!snapshot.rows.length) {
    return <Card title="Per-rank snapshot"><div className="empty compact-empty">No per-rank values.</div></Card>;
  }
  const { rows, step } = snapshot;
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1e-9);
  const meanAbsDelta = rows.reduce((sum, row) => sum + Math.abs(row.delta_from_mean), 0) / rows.length || 1e-9;
  return (
    <Card title="Per-rank snapshot" badge={metricKey}>
      <div className="rank-bar-list">
        {rows.map((row) => {
          const straggler = Math.abs(row.delta_from_mean) > meanAbsDelta * 1.6;
          return (
            <div className={`rank-bar-row ${straggler ? "straggler" : ""}`} key={row.rank}>
              <span className="rank-id">r{row.rank}</span>
              <span className="rank-track"><i style={{ width: `${Math.max(3, (Math.abs(row.value) / max) * 100)}%` }} /></span>
              <span className="rank-val">{formatNumber(row.value, 4)}</span>
            </div>
          );
        })}
      </div>
      <p className="analysis-note">All ranks at step {formatNumber(step, 0)} · stragglers (&gt;1.6× mean abs deviation from rank mean) in red.</p>
    </Card>
  );
}

function HeatmapPanel({ heatmap, truncated }: { heatmap: RankHeatmapPoint[]; truncated: boolean }) {
  const grid = useMemo(() => heatmapGrid(heatmap), [heatmap]);
  if (!grid) {
    return <Card title="Rank heatmap"><div className="empty compact-empty">No heatmap cells.</div></Card>;
  }
  return (
    <Card title="Rank heatmap" badge="Δ from mean">
      {truncated ? <p className="analysis-note" style={{ marginTop: 0, marginBottom: 12 }}>Steps sampled evenly to stay under the cell cap.</p> : null}
      <div className="rank-heatmap-wrap">
        <div className="rank-heatmap-axis" style={{ gridTemplateRows: `repeat(${grid.ranks.length}, 15px)` }}>
          {grid.ranks.map((rank) => <span key={rank}>r{rank}</span>)}
        </div>
        <div>
          <div className="rank-heatmap" style={{ gridTemplateColumns: `repeat(${grid.steps.length}, minmax(5px, 1fr))` }}>
            {grid.ranks.map((rank) => grid.steps.map((step) => {
              const cell = grid.lookup.get(`${rank}:${step}`);
              if (!cell) return <i key={`${rank}-${step}`} style={{ background: "var(--surface-3)", opacity: 0.5 }} title={`r${rank} step ${step}: no data`} />;
              const intensity = Math.min(1, Math.abs(cell.delta_from_mean) / grid.maxDelta);
              const color = cell.delta_from_mean >= 0 ? "var(--coral)" : "var(--series-2)";
              return <i key={`${rank}-${step}`} style={{ background: color, opacity: 0.16 + intensity * 0.8 }} title={`r${rank} step ${step}: ${formatNumber(cell.value, 4)} (${signed(cell.delta_from_mean, 4)})`} />;
            }))}
          </div>
          <div className="rank-heatmap-foot">
            <span>step {formatNumber(grid.steps[0], 0)}</span>
            <span>step {formatNumber(grid.steps.at(-1) ?? 0, 0)}</span>
          </div>
        </div>
      </div>
      <div className="heatmap-scale">
        <span>{signed(-grid.maxDelta, 3)}</span>
        <span className="ramp" />
        <span>{signed(grid.maxDelta, 3)}</span>
        <span style={{ color: "var(--faint)" }}>Δ from rank mean</span>
      </div>
    </Card>
  );
}

function OutlierPanel({ outliers, truncated, worldSize }: { outliers: RankOutlierPoint[]; truncated: boolean; worldSize: number }) {
  return (
    <Card title="Rank outliers" badge={outliers.length ? `top ${outliers.length}` : undefined}>
      <div className="analysis-table">
        <div className="analysis-row head"><span>rank</span><span>step</span><span>value</span><span>z-score</span></div>
        {outliers.map((item) => (
          <div className="analysis-row" key={`${item.step}-${item.rank}`}>
            <span>r{item.rank}</span>
            <span>step {formatNumber(item.step, 0)}</span>
            <strong>{formatNumber(item.value, 4)}</strong>
            <span className={item.z_score >= 0 ? "pos" : "neg"}>{signed(item.z_score, 2)}z</span>
          </div>
        ))}
        {!outliers.length ? <div className="empty compact-empty">No outlier ranks detected.</div> : null}
      </div>
      <p className="analysis-note">
        {truncated ? "Highest-deviation rank/step pairs. " : ""}
        z-scores computed across the {worldSize || "reporting"} ranks at each step.
      </p>
    </Card>
  );
}

function Card({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  return (
    <article className="analysis-card">
      <div className="analysis-card-head">
        <h2>{title}{badge ? <span className="card-badge">{badge}</span> : null}</h2>
      </div>
      <div className="analysis-card-body">{children}</div>
    </article>
  );
}

function perRankAtLatestStep(heatmap: RankHeatmapPoint[]) {
  if (!heatmap.length) return { rows: [] as RankHeatmapPoint[], step: 0 };
  // Anchor every rank to the same (latest) step so the bars are comparable
  // rather than each rank reporting from a different point in training.
  const step = Math.max(...heatmap.map((point) => point.step));
  const rows = heatmap.filter((point) => point.step === step).sort((a, b) => a.rank - b.rank);
  return { rows, step };
}

function heatmapGrid(heatmap: RankHeatmapPoint[]) {
  if (!heatmap.length) return null;
  const ranks = [...new Set(heatmap.map((point) => point.rank))].sort((a, b) => a - b);
  const steps = [...new Set(heatmap.map((point) => point.step))].sort((a, b) => a - b);
  const lookup = new Map<string, RankHeatmapPoint>();
  for (const point of heatmap) lookup.set(`${point.rank}:${point.step}`, point);
  const maxDelta = Math.max(1e-6, ...heatmap.map((point) => Math.abs(point.delta_from_mean)));
  return { ranks, steps, lookup, maxDelta };
}

function chartGeometry(points: RankReducerPoint[]) {
  if (!points.length) return null;
  const minX = Math.min(...points.map((point) => point.step));
  const maxX = Math.max(...points.map((point) => point.step));
  // Scale to the robust p05-p95 band and the central lines, not raw min/max,
  // so a single straggler rank does not stretch the axis and crush the band.
  const minY = Math.min(...points.flatMap((point) => [point.p05, point.mean, point.weighted_mean]));
  const maxY = Math.max(...points.flatMap((point) => [point.p95, point.mean, point.weighted_mean]));
  const xSpan = Math.max(1, maxX - minX);
  const ySpan = Math.max(1e-9, maxY - minY);
  const pad = ySpan * 0.08;
  const lo = minY - pad;
  const hi = maxY + pad;
  const span = hi - lo;
  const x = (value: number) => 52 + ((value - minX) / xSpan) * 648;
  const y = (value: number) => 244 - ((value - lo) / span) * 212;
  const yTicks = [lo + span * 0.1, lo + span * 0.5, hi - span * 0.1];
  return { x, y, yTicks, minX, maxX };
}

function signed(value: number | undefined, digits: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${formatNumber(value, digits)}`;
}
