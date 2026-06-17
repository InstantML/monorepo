"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { isAbortError, queryString } from "../../../src/api.js";
import { formatNumber } from "../../../src/state.js";
import { metricTitle } from "../../dashboard-models";
import type { RunSummary } from "../../dashboard-types";
import { AnalysisCard } from "../ui/analysis-card";
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

type ReducerMode = "central" | "mean" | "weighted" | "median" | "bounds";

type Props = {
  api: { get: (path: string, options?: Record<string, unknown>) => Promise<any> };
  availableRuns?: RunSummary[];
  embedded?: boolean;
  onSelectRun?: (runId: string) => void;
  primaryRun: RunSummary | null;
  onMeta?: (meta: { worldSize: number; rankKeys: number }) => void;
};

export function DistributedTabPane({ api, availableRuns = [], embedded = false, onSelectRun, primaryRun, onMeta }: Props) {
  const [summary, setSummary] = useState<RankSummary | null>(null);
  const [rankKey, setRankKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  function changeRankKey(nextKey: string) {
    setRankKey(nextKey);
    setSummary(null);
    setError("");
  }

  useEffect(() => {
    setRankKey("");
    setSummary(null);
    setError("");
  }, [primaryRun?.id]);

  useEffect(() => {
    if (!primaryRun?.id) {
      setSummary(null);
      onMetaRef.current?.({ worldSize: 0, rankKeys: 0 });
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
      onMetaRef.current?.({ worldSize: next.reducers.at(-1)?.expected_world_size ?? 0, rankKeys: next.keys.length });
    }).catch((err) => {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "Unable to load rank metrics.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, primaryRun?.id, rankKey]);

  const keyOptions = (summary?.keys ?? []).map((key) => ({ value: key, label: key }));
  const latestReducer = summary?.reducers.at(-1) ?? null;
  const activeKey = rankKey || summary?.key || "";
  const hasData = Boolean(summary && summary.keys.length);

  const keySelect = (
    <CustomSelect
      id="rank-key"
      label="Rank key"
      onChange={changeRankKey}
      options={keyOptions.length ? keyOptions : [{ value: "", label: "No rank keys", disabled: true }]}
      value={activeKey}
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
            <h2>Rank reducers</h2>
            <p>{primaryRun ? `${primaryRun.name} · selected run` : "No run selected"}</p>
          </div>
          <div className="analysis-controls">
            {onSelectRun && availableRuns.length ? (
              <CustomSelect
                id="distributed-run"
                label="Run"
                onChange={(value) => { if (value) onSelectRun(value); }}
                options={availableRuns.map((run) => ({ value: run.id, label: run.name }))}
                value={primaryRun?.id ?? ""}
              />
            ) : null}
            {keySelect}
          </div>
        </header>
      )}

      {error ? <div className="banner error">{error}</div> : null}
      {!primaryRun ? <RankMetricsEmptyState selected={false} /> : null}
      {primaryRun && loading && !summary ? <div className="empty">Loading rank metrics...</div> : null}
      {primaryRun && summary && !summary.keys.length ? <RankMetricsEmptyState selected /> : null}

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
            <OutlierPanel outliers={summary!.outliers} truncated={summary!.truncated.outliers} worldSize={latestReducer?.expected_world_size ?? 0} />
          </section>
          <section className="analysis-grid two">
            <PerRankPanel heatmap={summary!.heatmap} metricKey={activeKey} />
            <CoveragePanel coverage={summary!.coverage} />
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
  const [mode, setMode] = useState<ReducerMode>("central");
  const geometry = useMemo(() => chartGeometry(reducers, mode), [mode, reducers]);
  const help = (
    <>
      <strong>{metricTitle(metricKey)} reduced across ranks at each step.</strong>
      <br />
      The lines are the unweighted mean, the sample-count weighted mean, and the
      median (p50) across all reporting ranks. The shaded band spans the p05–p95
      range, so a widening band means ranks are diverging from each other.
    </>
  );
  if (!reducers.length || !geometry) {
    return <AnalysisCard title="Rank reducers" help={help}><div className="empty compact-empty">No reducer points.</div></AnalysisCard>;
  }
  const bandTop = reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.p95)}`);
  const bandBottom = reducers.slice().reverse().map((point) => `${geometry.x(point.step)},${geometry.y(point.p05)}`);
  return (
    <AnalysisCard title={`${metricTitle(metricKey)} reducers`} badge={metricKey} help={help}>
      <div className="analysis-control-row">
        <CustomSelect
          className="axis-select"
          id="rank-reducer-mode"
          label="Y series"
          onChange={(value) => setMode(value as ReducerMode)}
          options={[
            { value: "central", label: "Mean, weighted, median", description: "Show central tendency with p05-p95 band" },
            { value: "mean", label: "Mean only", description: "Unweighted mean across ranks" },
            { value: "weighted", label: "Weighted mean only", description: "Sample-count weighted mean" },
            { value: "median", label: "Median only", description: "p50 across ranks" },
            { value: "bounds", label: "Min/max bounds", description: "Show min, p05, p95, and max" },
          ]}
          value={mode}
        />
      </div>
      <div className="analysis-chart-frame analysis-chart-frame--wide">
        <svg className="analysis-line-chart" viewBox="0 0 720 280" role="img" aria-label={`Rank reducer chart showing ${reducerModeLabel(mode)} for ${metricKey}`}>
          {geometry.yTicks.map((tick) => (
            <g key={tick}>
              <line className="analysis-grid-line" x1="52" x2="700" y1={geometry.y(tick)} y2={geometry.y(tick)} />
              <text className="analysis-tick" x="46" y={geometry.y(tick) + 4} textAnchor="end">{formatNumber(tick, 3)}</text>
            </g>
          ))}
          <line className="analysis-axis-line" x1="52" x2="700" y1="244" y2="244" />
          {["central", "bounds"].includes(mode) ? <polygon className="rank-band-area" points={[...bandTop, ...bandBottom].join(" ")} /> : null}
          {["central", "median"].includes(mode) ? <polyline className="rank-median-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.p50)}`).join(" ")} /> : null}
          {["central", "mean"].includes(mode) ? <polyline className="rank-mean-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.mean)}`).join(" ")} /> : null}
          {["central", "weighted"].includes(mode) ? <polyline className="rank-weighted-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.weighted_mean)}`).join(" ")} /> : null}
          {mode === "bounds" ? <polyline className="rank-min-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.min)}`).join(" ")} /> : null}
          {mode === "bounds" ? <polyline className="rank-max-line" points={reducers.map((point) => `${geometry.x(point.step)},${geometry.y(point.max)}`).join(" ")} /> : null}
          <text className="analysis-tick" x="52" y="262">{formatNumber(geometry.minX, 0)}</text>
          <text className="analysis-tick" x="700" y="262" textAnchor="end">{formatNumber(geometry.maxX, 0)}</text>
          <text className="analysis-axis-title" x="376" y="276" textAnchor="middle">step</text>
        </svg>
      </div>
      <div className="analysis-legend">
        {["central", "mean"].includes(mode) ? <span><i className="rank-mean" /> mean</span> : null}
        {["central", "weighted"].includes(mode) ? <span><i className="rank-weighted" /> weighted</span> : null}
        {["central", "median"].includes(mode) ? <span><i className="rank-median" /> median (p50)</span> : null}
        {["central", "bounds"].includes(mode) ? <span><i className="swatch rank-band" /> p05–p95</span> : null}
        {mode === "bounds" ? <span><i className="rank-min" /> min</span> : null}
        {mode === "bounds" ? <span><i className="rank-max" /> max</span> : null}
      </div>
    </AnalysisCard>
  );
}

function CoveragePanel({ coverage }: { coverage: RankCoveragePoint[] }) {
  const latest = coverage.at(-1);
  // Downsample the FULL step range into buckets keeping the worst coverage per
  // bucket, so a partial/missing-rank window anywhere in training stays visible
  // (a tail-only view would hide earlier gaps).
  const buckets = useMemo(() => coverageBuckets(coverage, 64), [coverage]);
  const gaps = coverage.filter((point) => point.rank_count < point.expected_world_size).length;
  const help = (
    <>
      <strong>How many ranks reported each step vs. the expected world size.</strong>
      <br />
      Each bar is a sampled window of training; its height is the share of ranks
      that logged at that point. Short or coloured bars flag steps where ranks
      were missing or the world size changed — often a sign of a stalled or
      crashed worker.
    </>
  );
  return (
    <AnalysisCard title="Rank coverage" help={help}>
      <div className="coverage-strip">
        {buckets.map((bucket) => (
          <span key={bucket.step} className={bucket.mismatch ? "mismatch" : bucket.ratio < 1 ? "partial" : ""} style={{ height: `${Math.max(8, bucket.ratio * 100)}%` }} title={`~step ${formatNumber(bucket.step, 0)}: ${formatNumber(bucket.ratio * 100, 0)}% ranks reporting`} />
        ))}
      </div>
      <div className="coverage-legend" aria-label="Coverage states">
        <span><i className="full" />full</span>
        <span><i className="partial" />partial</span>
        <span><i className="mismatch" />world-size mismatch</span>
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
    </AnalysisCard>
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
  const help = (
    <>
      <strong>Each rank&apos;s value for this metric at the latest logged step.</strong>
      <br />
      Bars are anchored to the same step so ranks are directly comparable. Bars
      shown in red are stragglers — ranks more than 1.6× the mean absolute
      deviation away from the across-rank mean.
    </>
  );
  if (!snapshot.rows.length) {
    return <AnalysisCard title="Per-rank snapshot" help={help}><div className="empty compact-empty">No per-rank values.</div></AnalysisCard>;
  }
  const { rows, step } = snapshot;
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1e-9);
  const meanAbsDelta = rows.reduce((sum, row) => sum + Math.abs(row.delta_from_mean), 0) / rows.length || 1e-9;
  return (
    <AnalysisCard title="Per-rank snapshot" badge={metricKey} help={help}>
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
    </AnalysisCard>
  );
}

function HeatmapPanel({ heatmap, truncated }: { heatmap: RankHeatmapPoint[]; truncated: boolean }) {
  const grid = useMemo(() => heatmapGrid(heatmap), [heatmap]);
  const help = (
    <>
      <strong>Per-rank deviation from the across-rank mean, over time.</strong>
      <br />
      Rows are ranks, columns are steps. Warm cells are above the step mean, cool
      cells below; stronger colour means a larger deviation. A persistently warm
      or cool row points to one rank consistently out of line with the others.
    </>
  );
  if (!grid) {
    return <AnalysisCard title="Rank heatmap" help={help}><div className="empty compact-empty">No heatmap cells.</div></AnalysisCard>;
  }
  return (
    <AnalysisCard title="Rank heatmap" badge="Δ from mean" help={help}>
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
              // Blue/orange diverging ramp (colorblind-safe) with opacity as the
              // magnitude channel; exact values stay one hover away via title.
              const color = cell.delta_from_mean >= 0 ? "var(--amber)" : "var(--blue)";
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
        <span>cooler {signed(-grid.maxDelta, 3)}</span>
        <span className="ramp" />
        <span>warmer {signed(grid.maxDelta, 3)}</span>
        <span style={{ color: "var(--faint)" }}>Δ from rank mean</span>
      </div>
    </AnalysisCard>
  );
}

function OutlierPanel({ outliers, truncated, worldSize }: { outliers: RankOutlierPoint[]; truncated: boolean; worldSize: number }) {
  const shown = outliers.slice(0, 8);
  const help = (
    <>
      <strong>The rank/step pairs that deviate most from their peers.</strong>
      <br />
      The z-score is how many standard deviations a rank&apos;s value sits from the
      mean of all ranks at that step. Large positive or negative z-scores are the
      ranks worth investigating first.
    </>
  );
  return (
    <AnalysisCard title="Rank outliers" badge={shown.length ? `top ${shown.length}` : undefined} help={help}>
      <div className="analysis-table">
        <div className="analysis-row head"><span>rank</span><span>step</span><span>value</span><span>z-score</span></div>
        {shown.map((item) => (
          <div className="analysis-row" key={`${item.step}-${item.rank}`}>
            <span>r{item.rank}</span>
            <span>step {formatNumber(item.step, 0)}</span>
            <strong>{formatNumber(item.value, 4)}</strong>
            {/* Deviation direction isn't inherently good or bad — emphasize magnitude, not sign. */}
            <span className="z-mag" style={{ opacity: 0.55 + Math.min(0.45, Math.abs(item.z_score) / 6) }}>{signed(item.z_score, 2)}z</span>
          </div>
        ))}
        {!shown.length ? <div className="empty compact-empty">No outlier ranks detected.</div> : null}
      </div>
      <p className="analysis-note">
        {truncated || outliers.length > shown.length ? "Highest-deviation rank/step pairs. " : ""}
        z-scores computed across the {worldSize || "reporting"} ranks at each step.
      </p>
    </AnalysisCard>
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

function chartGeometry(points: RankReducerPoint[], mode: ReducerMode = "central") {
  if (!points.length) return null;
  const minX = Math.min(...points.map((point) => point.step));
  const maxX = Math.max(...points.map((point) => point.step));
  const values = points.flatMap((point) => reducerModeValues(point, mode));
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
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

function reducerModeValues(point: RankReducerPoint, mode: ReducerMode) {
  if (mode === "mean") return [point.mean];
  if (mode === "weighted") return [point.weighted_mean];
  if (mode === "median") return [point.p50];
  if (mode === "bounds") return [point.min, point.p05, point.p95, point.max];
  // Keep the default robust to a single straggler by using percentile bounds and
  // central lines, not raw min/max.
  return [point.p05, point.p95, point.mean, point.weighted_mean, point.p50];
}

function reducerModeLabel(mode: ReducerMode) {
  if (mode === "mean") return "mean";
  if (mode === "weighted") return "weighted mean";
  if (mode === "median") return "median";
  if (mode === "bounds") return "min and max bounds";
  return "mean, weighted mean, and median";
}

function signed(value: number | undefined, digits: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${formatNumber(value, digits)}`;
}

function RankMetricsEmptyState({ selected }: { selected: boolean }) {
  return (
    <div className="analysis-empty-state" role="status">
      <strong>{selected ? "No rank metrics logged for this run yet." : "Select a run to inspect distributed rank metrics."}</strong>
      <span>
        {selected
          ? "Rank-aware panels appear after the SDK logs per-worker values with rank and world_size."
          : "The Distributed page is scoped to one selected run and shows reducer lines, rank coverage, heatmaps, and outliers."}
      </span>
      <code>{'run.log_rank_metrics({"train/loss": loss}, step=step, rank=rank, world_size=world_size)'}</code>
    </div>
  );
}
