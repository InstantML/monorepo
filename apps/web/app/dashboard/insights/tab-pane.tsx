"use client";

import { useMemo } from "react";

import {
  evaluationCards,
  groupedRunReducers,
  insightsRunUniverse,
  kMeansClusters,
  numericFieldRows,
} from "../../../src/research-insights.js";
import { formatNumber, metricGoal, metricGoalValue } from "../../../src/state.js";
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
  const scatterFields = useMemo(() => chooseScatterFields(numeric), [numeric]);
  const scope = `Using ${formatNumber(universe.runs.length, 0)} ${universe.scope}${universe.excluded ? ` · ${formatNumber(universe.excluded, 0)} selected without loaded summaries` : ""}`;

  return (
    <div className={`analysis-page insights-page ${embedded ? "embedded-analysis" : ""}`}>
      {embedded ? (
        <div className="advanced-section-band">
          <span className="seg"><i className="dot" />Run-level insights</span>
          <span className="rule" />
          <span className="hint">{scope}</span>
        </div>
      ) : (
        <header className="analysis-header">
          <div className="analysis-title-block">
            <span className="analysis-eyebrow eyebrow--accent">Insights</span>
            <h2>Loaded run <span className="serif-em">analysis</span></h2>
            <p>{scope}</p>
          </div>
        </header>
      )}

      {!universe.runs.length ? <div className="empty">No loaded runs available for insights.</div> : (
        <>
          <section className="analysis-grid two">
            <GroupedReducersCard grouped={grouped} metricKey={metricKey} />
            <EvaluationCardGrid cards={evalCards} total={universe.runs.length} />
          </section>
          <section className="analysis-grid two">
            <ScatterCard fields={scatterFields} rows={numeric.rows} />
            <ClusterCard clusters={clusters.clusters} fields={clusters.fields} points={clusters.points} />
          </section>
          <section className="analysis-grid one">
            <ParallelCoordinatesCard fields={numeric.fields.slice(0, 5)} rows={numeric.rows.slice(0, 80)} metricKey={metricKey} />
          </section>
        </>
      )}
    </div>
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

function GroupedReducersCard({ grouped, metricKey }: { grouped: any[]; metricKey: string }) {
  const maxMean = Math.max(1e-9, ...grouped.map((item) => Math.abs(item.mean)));
  return (
    <Card title={`${metricTitle(metricKey)} by group`} badge={grouped.length ? `${grouped.length} groups` : undefined}>
      <div className="analysis-table">
        <div className="analysis-row head"><span>group</span><span>mean</span><span>spread</span><span>runs</span></div>
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
    </Card>
  );
}

function EvaluationCardGrid({ cards, total }: { cards: any[]; total: number }) {
  return (
    <Card title="Evaluation metrics">
      <div className="eval-card-grid">
        {cards.map((card) => (
          <div className={`eval-mini-card ${card.key ? "" : "missing"}`} key={card.id}>
            <span>{card.label}</span>
            <strong>{card.key ? formatNumber(card.latest, 4) : "—"}</strong>
            <small>{card.key ? `avg · ${formatNumber(card.count, 0)}/${formatNumber(total, 0)} runs` : "not logged"}</small>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ScatterCard({ fields, rows }: { fields: string[]; rows: any[] }) {
  const points = rows
    .map((row) => ({ run: row.run, x: row.values[fields[0]], y: row.values[fields[1]] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const geometry = pointGeometry(points);
  return (
    <Card title="Hyperparameter scatter" badge={fields.length >= 2 ? `${shortLabel(fields[0])} × ${shortLabel(fields[1])}` : undefined}>
      {fields.length < 2 || !geometry ? <div className="empty compact-empty">Need two numeric fields.</div> : (
        <>
          <svg className="analysis-scatter" viewBox="0 0 520 232" role="img" aria-label="Hyperparameter scatter">
            <line className="analysis-axis-line" x1="48" x2="488" y1="200" y2="200" />
            <line className="analysis-axis-line" x1="48" x2="48" y1="16" y2="200" />
            <text className="analysis-tick" x="48" y="214">{formatNumber(geometry.minX, 3)}</text>
            <text className="analysis-tick" x="488" y="214" textAnchor="end">{formatNumber(geometry.maxX, 3)}</text>
            <text className="analysis-tick" x="44" y="200" textAnchor="end">{formatNumber(geometry.minY, 2)}</text>
            <text className="analysis-tick" x="44" y="24" textAnchor="end">{formatNumber(geometry.maxY, 2)}</text>
            <text className="analysis-axis-title" x="270" y="228" textAnchor="middle">{shortLabel(fields[0])}</text>
            <text className="analysis-axis-title" x="16" y="108" textAnchor="middle" transform="rotate(-90 16 108)">{shortLabel(fields[1])}</text>
            {points.slice(0, 500).map((point) => (
              <circle key={point.run.id} cx={geometry.x(point.x)} cy={geometry.y(point.y)} r="4">
                <title>{`${point.run.name}: ${fields[0]}=${formatNumber(point.x, 3)}, ${fields[1]}=${formatNumber(point.y, 3)}`}</title>
              </circle>
            ))}
          </svg>
          <p className="analysis-note">{formatNumber(points.length, 0)} runs with both fields · linear axes</p>
        </>
      )}
    </Card>
  );
}

function ClusterCard({ clusters, fields, axes, points }: { clusters: any[]; fields: string[]; axes?: string[]; points: any[] }) {
  const geometry = pointGeometry(points);
  const axisFields = axes && axes.length === 2 ? axes : fields.slice(0, 2);
  return (
    <Card title="K-means clusters" badge={clusters.length ? `k=${clusters.length}` : undefined}>
      {!clusters.length || !geometry ? <div className="empty compact-empty">Need at least three runs and two numeric fields.</div> : (
        <>
          <svg className="analysis-scatter clusters" viewBox="0 0 520 232" role="img" aria-label="K-means clusters">
            <line className="analysis-axis-line" x1="48" x2="488" y1="200" y2="200" />
            <line className="analysis-axis-line" x1="48" x2="48" y1="16" y2="200" />
            <text className="analysis-axis-title" x="270" y="224" textAnchor="middle">{shortLabel(axisFields[0])} (std)</text>
            <text className="analysis-axis-title" x="16" y="108" textAnchor="middle" transform="rotate(-90 16 108)">{shortLabel(axisFields[1])} (std)</text>
            {points.slice(0, 500).map((point) => (
              <circle className={`cluster-dot cluster-${point.cluster % 4}`} key={point.id} cx={geometry.x(point.x)} cy={geometry.y(point.y)} r="4">
                <title>{point.name}</title>
              </circle>
            ))}
          </svg>
          <div className="cluster-list">
            {clusters.map((cluster) => <span key={cluster.id}><i className={`cluster-${cluster.id % 4}`} />{cluster.label}: {formatNumber(cluster.count, 0)}</span>)}
          </div>
          <p className="analysis-note">k fixed at 3 · axes show 2 of {fields.length} standardized config features clustered: {fields.slice(0, 5).map(shortLabel).join(" · ")}</p>
        </>
      )}
    </Card>
  );
}

function ParallelCoordinatesCard({ fields, rows, metricKey }: { fields: string[]; rows: any[]; metricKey: string }) {
  if (fields.length < 2) {
    return <Card title="Parallel coordinates"><div className="empty compact-empty">Need at least two numeric fields.</div></Card>;
  }
  const domains = fields.map((field) => {
    const values = rows.map((row) => row.values[field]).filter(Number.isFinite);
    return { min: Math.min(...values), max: Math.max(...values) };
  });
  const xFor = (index: number) => 50 + (index / Math.max(1, fields.length - 1)) * 640;
  const yFor = (value: number, index: number) => {
    const domain = domains[index];
    const span = Math.max(1e-9, domain.max - domain.min);
    return 220 - ((value - domain.min) / span) * 180;
  };
  // Pick the best run by the metric's own goal direction (max for accuracy/auc,
  // min for loss). Sorting ascending unconditionally would highlight the worst
  // run for maximize metrics.
  const minimize = metricGoal(metricKey) === "minimize";
  const bestRunId = rows
    .map((row) => ({ id: row.run.id, value: metricGoalValue(row.run, metricKey) }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => minimize ? (a.value ?? 0) - (b.value ?? 0) : (b.value ?? 0) - (a.value ?? 0))[0]?.id;
  return (
    <Card title="Parallel coordinates" badge={`${fields.length} fields`}>
      <svg className="parallel-chart" viewBox="0 0 720 264" role="img" aria-label="Parallel coordinate chart">
        {fields.map((field, index) => (
          <g key={field}>
            <line className="parallel-axis" x1={xFor(index)} x2={xFor(index)} y1="32" y2="220" />
            <text className="analysis-tick" x={xFor(index)} y="26" textAnchor="middle">{formatNumber(domains[index].max, 2)}</text>
            <text className="analysis-tick" x={xFor(index)} y="234" textAnchor="middle">{formatNumber(domains[index].min, 2)}</text>
            <text className="analysis-axis-title" x={xFor(index)} y="252" textAnchor="middle">{shortLabel(field)}</text>
          </g>
        ))}
        {rows.map((row) => {
          const coords = fields.map((field, index) => [xFor(index), yFor(row.values[field], index)]);
          if (coords.some(([, y]) => !Number.isFinite(y))) return null;
          const highlight = row.run.id === bestRunId;
          return <polyline className={`parallel-line ${highlight ? "highlight" : ""}`} key={row.run.id} points={coords.map(([x, y]) => `${x},${y}`).join(" ")} />;
        })}
      </svg>
      <p className="analysis-note">{formatNumber(rows.length, 0)} runs · best run for {metricTitle(metricKey)} highlighted</p>
    </Card>
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
    x: (value: number) => 48 + ((value - minX) / xSpan) * 440,
    y: (value: number) => 200 - ((value - minY) / ySpan) * 176,
    minX, maxX, minY, maxY,
  };
}

function chooseScatterFields(numeric: { fields: string[]; rows: any[] }): string[] {
  const distinct = (field: string) => new Set(numeric.rows.map((row) => row.values[field]).filter(Number.isFinite)).size;
  const configFields = numeric.fields.filter((field) => field.startsWith("config."));
  const xField = configFields.slice().sort((a, b) => distinct(b) - distinct(a))[0];
  const metricField = numeric.fields.find((field) => field.startsWith("metric.best.")) ?? numeric.fields.find((field) => field.startsWith("metric."));
  if (xField && metricField && xField !== metricField) return [xField, metricField];
  return numeric.fields.slice(0, 2);
}

function shortLabel(label: string) {
  return label.replace(/^config\./, "").replace(/^metric\.(latest|best)\./, "").slice(0, 18);
}
