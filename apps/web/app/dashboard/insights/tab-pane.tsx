"use client";

import { useMemo } from "react";

import {
  evaluationCards,
  groupedRunReducers,
  insightsRunUniverse,
  kMeansClusters,
  numericFieldRows,
} from "../../../src/research-insights.js";
import { formatNumber } from "../../../src/state.js";
import { metricTitle } from "../../dashboard-models";
import type { RunSummary } from "../../dashboard-types";

type Props = {
  embedded?: boolean;
  metricKey: string;
  selectedRunIds: string[];
  sortedRuns: RunSummary[];
};

export function InsightsTabPane({ embedded = false, metricKey, selectedRunIds, sortedRuns }: Props) {
  const universe = useMemo(() => insightsRunUniverse(selectedRunIds, sortedRuns), [selectedRunIds, sortedRuns]);
  const grouped = useMemo(() => groupedRunReducers(universe.runs, metricKey), [universe.runs, metricKey]);
  const numeric = useMemo(() => numericFieldRows(universe.runs, metricKey), [universe.runs, metricKey]);
  const clusters = useMemo(() => kMeansClusters(universe.runs, metricKey), [universe.runs, metricKey]);
  const evalCards = useMemo(() => evaluationCards(universe.runs), [universe.runs]);
  const scatterFields = numeric.fields.slice(0, 2);

  return (
    <div className={`analysis-page insights-page ${embedded ? "embedded-analysis" : ""}`}>
      <header className="analysis-header">
        <div>
          <p className="eyebrow">{embedded ? "Advanced graphs" : "Insights"}</p>
          <h1>{embedded ? "Run Clusters And Fields" : "Loaded Run Analysis"}</h1>
          <span>
            Using {formatNumber(universe.runs.length, 0)} {universe.scope}
            {universe.excluded ? ` · ${formatNumber(universe.excluded, 0)} selected without loaded summaries` : ""}
          </span>
        </div>
      </header>

      {!universe.runs.length ? <div className="empty">No loaded runs available for insights.</div> : null}

      <section className="analysis-grid two">
        <GroupedReducersCard grouped={grouped} metricKey={metricKey} />
        <EvaluationCardGrid cards={evalCards} />
      </section>
      <section className="analysis-grid two">
        <ScatterCard fields={scatterFields} rows={numeric.rows} />
        <ClusterCard clusters={clusters.clusters} fields={clusters.fields} points={clusters.points} />
      </section>
      <section className="analysis-grid one">
        <ParallelCoordinatesCard fields={numeric.fields.slice(0, 5)} rows={numeric.rows.slice(0, 80)} />
      </section>
    </div>
  );
}

function GroupedReducersCard({ grouped, metricKey }: { grouped: any[]; metricKey: string }) {
  return (
    <article className="analysis-card">
      <h2>{metricTitle(metricKey)} by group</h2>
      <div className="analysis-table">
        {grouped.slice(0, 8).map((item) => (
          <div className="analysis-row" key={item.group}>
            <span>{item.group}</span>
            <span>{formatNumber(item.count, 0)} runs</span>
            <strong>{formatNumber(item.mean, 4)}</strong>
            <span>{formatNumber(item.min, 3)}-{formatNumber(item.max, 3)}</span>
          </div>
        ))}
        {!grouped.length ? <div className="empty compact-empty">No grouped values for the active metric.</div> : null}
      </div>
    </article>
  );
}

function EvaluationCardGrid({ cards }: { cards: any[] }) {
  return (
    <article className="analysis-card">
      <h2>Evaluation</h2>
      <div className="eval-card-grid">
        {cards.map((card) => (
          <div className="eval-mini-card" key={card.id}>
            <span>{card.label}</span>
            <strong>{formatNumber(card.latest, 4)}</strong>
            <small>{card.key ?? "missing"} · {formatNumber(card.count, 0)} runs</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function ScatterCard({ fields, rows }: { fields: string[]; rows: any[] }) {
  const points = rows
    .map((row) => ({ run: row.run, x: row.values[fields[0]], y: row.values[fields[1]] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const geometry = pointGeometry(points);
  return (
    <article className="analysis-card">
      <h2>Hyperparameter Scatter</h2>
      {fields.length < 2 || !geometry ? <div className="empty compact-empty">Need two numeric fields.</div> : (
        <>
          <svg className="analysis-scatter" viewBox="0 0 520 280" role="img" aria-label="Hyperparameter scatter">
            {points.slice(0, 500).map((point) => (
              <circle key={point.run.id} cx={geometry.x(point.x)} cy={geometry.y(point.y)} r="4">
                <title>{`${point.run.name}: ${fields[0]}=${formatNumber(point.x, 3)}, ${fields[1]}=${formatNumber(point.y, 3)}`}</title>
              </circle>
            ))}
          </svg>
          <p className="analysis-note">{fields[0]} × {fields[1]}</p>
        </>
      )}
    </article>
  );
}

function ClusterCard({ clusters, fields, points }: { clusters: any[]; fields: string[]; points: any[] }) {
  const geometry = pointGeometry(points);
  return (
    <article className="analysis-card">
      <h2>K-means Clusters</h2>
      {!clusters.length || !geometry ? <div className="empty compact-empty">Need at least three runs and two numeric fields.</div> : (
        <>
          <svg className="analysis-scatter clusters" viewBox="0 0 520 220" role="img" aria-label="K-means clusters">
            {points.slice(0, 500).map((point) => (
              <circle className={`cluster-dot cluster-${point.cluster % 4}`} key={point.id} cx={geometry.x(point.x)} cy={geometry.y(point.y)} r="4">
                <title>{point.name}</title>
              </circle>
            ))}
          </svg>
          <div className="cluster-list">
            {clusters.map((cluster) => <span key={cluster.id}>{cluster.label}: {formatNumber(cluster.count, 0)}</span>)}
          </div>
          <p className="analysis-note">{fields.slice(0, 3).join(" · ")}</p>
        </>
      )}
    </article>
  );
}

function ParallelCoordinatesCard({ fields, rows }: { fields: string[]; rows: any[] }) {
  if (fields.length < 2) {
    return <article className="analysis-card"><h2>Parallel Coordinates</h2><div className="empty compact-empty">Need at least two numeric fields.</div></article>;
  }
  const domains = fields.map((field) => {
    const values = rows.map((row) => row.values[field]).filter(Number.isFinite);
    return { min: Math.min(...values), max: Math.max(...values) };
  });
  const xFor = (index: number) => 40 + (index / Math.max(1, fields.length - 1)) * 640;
  const yFor = (value: number, index: number) => {
    const domain = domains[index];
    const span = Math.max(1e-9, domain.max - domain.min);
    return 236 - ((value - domain.min) / span) * 190;
  };
  return (
    <article className="analysis-card wide-card">
      <h2>Parallel Coordinates</h2>
      <svg className="parallel-chart" viewBox="0 0 720 280" role="img" aria-label="Parallel coordinate chart">
        {fields.map((field, index) => (
          <g key={field}>
            <line className="parallel-axis" x1={xFor(index)} x2={xFor(index)} y1="36" y2="236" />
            <text className="tick-label" x={xFor(index)} y="260" textAnchor="middle">{shortLabel(field)}</text>
          </g>
        ))}
        {rows.map((row) => {
          const points = fields.map((field, index) => [xFor(index), yFor(row.values[field], index)]);
          if (points.some(([, y]) => !Number.isFinite(y))) return null;
          return <polyline className="parallel-line" key={row.run.id} points={points.map(([x, y]) => `${x},${y}`).join(" ")} />;
        })}
      </svg>
    </article>
  );
}

function pointGeometry(points: Array<{ x: number; y: number }>) {
  if (!points.length) return null;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const xSpan = Math.max(1e-9, maxX - minX);
  const ySpan = Math.max(1e-9, maxY - minY);
  return {
    x: (value: number) => 34 + ((value - minX) / xSpan) * 452,
    y: (value: number) => 244 - ((value - minY) / ySpan) * 204,
  };
}

function shortLabel(label: string) {
  return label.replace(/^config\./, "").replace(/^metric\.(latest|best)\./, "").slice(0, 18);
}
