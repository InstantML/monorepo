"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { formatMetricValue } from "../../../src/charts.js";
import { formatNumber, metricGoal, metricGoalLabel, statusTone } from "../../../src/state.js";
import {
  artifactHasStoredBytes,
  artifactTotalForRun,
  compactValue,
  compareCategory,
  comparePathLabel,
  compareRowRank,
  formatBytes,
  metricNamespace,
  metricTitle,
  runNoteText,
  safeArtifactMediaKind,
  shortValue,
} from "../../dashboard-models";
import type { Artifact, CompareLayout, CompareRowSort, CompareRunSort, RunSummary } from "../../dashboard-types";

type CompareRowView = {
  category: string;
  different: boolean;
  key: string;
  label: string;
  missingCount: number;
  numericSpread: number;
  path: string;
  reference: unknown;
  searchText: string;
  values: Record<string, unknown>;
};

// Run-identity palette: deliberately excludes the brand green, amber, and coral —
// those hues are reserved for delta semantics (green=better, coral=worse, amber=
// differs), so a run's identity swatch can never be mistaken for a value judgement.
// Reference identity is conveyed by the row tint + REF tag, not by swatch color.
const IDENTITY_PALETTE = [
  "#7da1e8", // blue
  "#c084fc", // violet
  "#5eead4", // teal
  "#7c5cc4", // indigo
  "#38bdf8", // sky
  "#f0abfc", // orchid
  "#22d3ee", // cyan
  "#818cf8", // periwinkle
  "#a3b3cc", // slate
  "#2dd4bf", // aqua
];

type SortDir = "asc" | "desc";
type SortState = { col: string; dir: SortDir };

type MetricColumn = { kind: "metric"; key: string; metricKey: string; goal: "minimize" | "maximize" };
type AttrColumn = { kind: "status" | "duration" | "artifacts"; key: string };
type ConfigColumn = { kind: "config"; key: string; configKey: string };
type CompareColumn = MetricColumn | AttrColumn | ConfigColumn;

function compareSearchTokens(search: string) {
  return search.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function compareRunSearchText(run: RunSummary, artifactsByRun: Record<string, Artifact[]>) {
  return [
    run.name,
    run.status,
    run.project,
    run.tags?.join(" "),
    runNoteText(run),
    ...Object.entries(run.config ?? {}).map(([key, value]) => `${key} ${compactValue(value)}`),
    ...(artifactsByRun[run.id] ?? []).map((artifact) => `${artifact.name} ${artifact.type}`),
  ].filter(Boolean).join(" ").toLowerCase();
}

function compareNumbersDesc(left: unknown, right: unknown) {
  const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : null;
  const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return 1;
  if (rightNumber === null) return -1;
  return rightNumber - leftNumber;
}

function compareNumbersAsc(left: unknown, right: unknown) {
  return -compareNumbersDesc(left, right);
}

// Numeric column sort that always pushes missing values (null/NaN) to the bottom,
// regardless of ascending/descending direction — a run with no value for the sorted
// metric should never jump to the top of an ascending sort.
function numericNullsLast(left: number | null, right: number | null, dir: number) {
  const l = typeof left === "number" && Number.isFinite(left) ? left : null;
  const r = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (l === null && r === null) return 0;
  if (l === null) return 1;
  if (r === null) return -1;
  return (l - r) * dir;
}

function compareConfigValues(left: unknown, right: unknown) {
  const leftMissing = left === undefined || left === null || left === "";
  const rightMissing = right === undefined || right === null || right === "";
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return compactValue(left).localeCompare(compactValue(right), undefined, { numeric: true });
}

function runDurationMs(run: RunSummary) {
  const start = Date.parse(run.started_at ?? run.created_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function formatDuration(ms: number | null) {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function metricBestValue(run: RunSummary | undefined, metricKey: string) {
  if (!run) return null;
  const aggregate = run.metric_aggregates?.[metricKey];
  const value = metricGoal(metricKey) === "minimize" ? aggregate?.min : aggregate?.max;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Goal-aware delta vs the reference run. "Better" is lower for minimize metrics and
// higher for maximize metrics, so the tone (green/coral) reflects the objective —
// not the raw sign (a -4% loss is an improvement, and must read green).
function metricDelta(value: number | null, reference: number | null, goal: "minimize" | "maximize") {
  if (value === null || reference === null) return null;
  if (value === reference) return { text: "0%", tone: "flat" as const, title: "Equal to reference" };
  const diff = value - reference;
  const improved = goal === "minimize" ? value < reference : value > reference;
  const tone = improved ? ("up" as const) : ("down" as const);
  const absText = `${diff > 0 ? "+" : ""}${formatMetricValue(diff)} vs reference`;
  if (reference === 0) return { text: `${diff > 0 ? "+" : ""}${formatMetricValue(diff)}`, tone, title: absText };
  const percent = (diff / Math.abs(reference)) * 100;
  return { text: `${percent > 0 ? "+" : ""}${formatNumber(percent, 1)}%`, tone, title: absText };
}

type MetricLookup = {
  best: (runId: string, metricKey: string) => number | null;
  latest: (runId: string, metricKey: string) => number | null;
};

// Compare data lives in the side-by-side payload's `rows` (paths like
// `metric/<key>/<reducer>`), not on the lightweight run objects, so metric values
// are read from there first and only fall back to the run's own aggregates.
function buildMetricLookup(rawRows: any[], runs: RunSummary[]): MetricLookup {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const row of rawRows ?? []) byPath.set(String(row.path), (row.values ?? {}) as Record<string, unknown>);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const rowVal = (metricKey: string, reducer: string, runId: string) => {
    const value = byPath.get(`metric/${metricKey}/${reducer}`)?.[runId];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return {
    best(runId, metricKey) {
      const reducers = metricGoal(metricKey) === "minimize" ? ["min", "latest", "mean"] : ["max", "latest", "mean"];
      for (const reducer of reducers) {
        const value = rowVal(metricKey, reducer, runId);
        if (value !== null) return value;
      }
      return metricBestValue(runById.get(runId), metricKey);
    },
    latest(runId, metricKey) {
      const fromRows = rowVal(metricKey, "latest", runId);
      if (fromRows !== null) return fromRows;
      const latest = runById.get(runId)?.latest_metrics?.[metricKey];
      return typeof latest === "number" && Number.isFinite(latest) ? latest : null;
    },
  };
}

function bestRunByMetric(runs: RunSummary[], metricKey: string, lookup: MetricLookup) {
  const goal = metricGoal(metricKey);
  return [...runs].sort((left, right) => {
    const lv = lookup.best(left.id, metricKey);
    const rv = lookup.best(right.id, metricKey);
    return goal === "minimize" ? compareNumbersAsc(lv, rv) : compareNumbersDesc(lv, rv);
  })[0] ?? null;
}

function uniqueMetricKeys(keys: string[]) {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const norm = key.toLowerCase();
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
}

function deriveConfigKeys(runs: RunSummary[]) {
  const counts = new Map<string, number>();
  const distinct = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const [key, value] of Object.entries(run.config ?? {})) {
      if (value && typeof value === "object") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!distinct.has(key)) distinct.set(key, new Set());
      distinct.get(key)!.add(compactValue(value));
    }
  }
  // Prioritise config keys that vary across runs (the interesting ones), then by
  // how widely they're populated, then alphabetically for a stable order.
  return [...counts.keys()].sort((left, right) => {
    const leftVaries = (distinct.get(left)?.size ?? 0) > 1 ? 1 : 0;
    const rightVaries = (distinct.get(right)?.size ?? 0) > 1 ? 1 : 0;
    return rightVaries - leftVaries || (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || left.localeCompare(right);
  });
}

function configValuesDiffer(runs: RunSummary[], key: string) {
  const seen = new Set<string>();
  for (const run of runs) seen.add(compactValue(run.config?.[key]));
  return seen.size > 1;
}

// ── matrix (transposed) helpers — unchanged behaviour ─────────────────────────
function compareRowIsDifferent(row: CompareRowView, runs: RunSummary[], referenceRunId: string) {
  const referenceValue = compactValue(row.values?.[referenceRunId]);
  return runs.some((run) => run.id !== referenceRunId && compactValue(row.values?.[run.id]) !== referenceValue);
}

function filterCompareRows(rows: CompareRowView[], search: string) {
  const tokens = compareSearchTokens(search);
  if (!tokens.length) return rows;
  return rows.filter((row) => tokens.every((token) => row.searchText.includes(token)));
}

function sortCompareRows(rows: CompareRowView[], rowSort: CompareRowSort) {
  return [...rows].sort((left, right) => {
    if (rowSort === "changed") {
      const changed = Number(right.different) - Number(left.different);
      if (changed) return changed;
    }
    if (rowSort === "missing") {
      const missing = right.missingCount - left.missingCount;
      if (missing) return missing;
    }
    if (rowSort === "spread") {
      const spread = right.numericSpread - left.numericSpread;
      if (spread) return spread;
    }
    if (rowSort === "category") {
      const category = left.category.localeCompare(right.category);
      if (category) return category;
    }
    if (rowSort === "name") {
      const label = left.label.localeCompare(right.label);
      if (label) return label;
    }
    return compareRowRank(left.path) - compareRowRank(right.path) || left.label.localeCompare(right.label);
  });
}

function buildCompareRows(rawRows: any[], runs: RunSummary[]): CompareRowView[] {
  const seenRows = new Set<string>();
  return rawRows
    .map((row, index) => {
      const category = compareCategory(row.path);
      const label = comparePathLabel(row.path);
      const values = row.values ?? {};
      const compactValues = runs.map((run) => compactValue(values?.[run.id]));
      const numericValues = runs.map((run) => values?.[run.id]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const missingCount = compactValues.filter((value) => value === "-").length;
      const numericSpread = numericValues.length > 1 ? Math.max(...numericValues) - Math.min(...numericValues) : 0;
      const key = [category, label, ...compactValues].join("::");
      return {
        category,
        different: Boolean(row.different),
        key: `${index}:${key}`,
        label,
        missingCount,
        numericSpread,
        path: row.path,
        reference: row.reference,
        searchText: [category, label, row.path, ...compactValues].join(" ").toLowerCase(),
        values,
      };
    })
    .filter((row) => {
      const dedupeKey = row.key.replace(/^\d+:/, "");
      if (seenRows.has(dedupeKey)) return false;
      seenRows.add(dedupeKey);
      return true;
    });
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function ArtifactMediaPreview({ artifact, compact = false, fallback = false }: { artifact: Artifact; compact?: boolean; fallback?: boolean }) {
  const kind = safeArtifactMediaKind(artifact);
  if (!kind) return fallback ? <small className="artifact-media-fallback">Preview unavailable.</small> : null;
  if (!artifactHasStoredBytes(artifact)) return <small className="artifact-media-fallback">{compact ? "Preview unavailable" : "Media preview unavailable; download or copy ID."}</small>;
  const src = artifactDownloadUrl(artifact);
  if (kind === "image") return <img alt={artifact.name} className="artifact-media artifact-image" loading="lazy" src={src} />;
  return kind === "audio" ? (
    <audio aria-label={`Audio preview for ${artifact.name}`} className="artifact-media" controls preload="metadata" src={src} />
  ) : (
    <video aria-label={`Video preview for ${artifact.name}`} className="artifact-media" controls preload="metadata" src={src} />
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags?.length) return <span className="compare-empty">No tags</span>;
  return (
    <div className="chips">
      {tags.slice(0, 4).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
      {tags.length > 4 ? <span className="chip">+{tags.length - 4}</span> : null}
    </div>
  );
}

// Duplicate filenames are versions of the same artifact: show the latest once
// with a version-count chip instead of listing identical names side by side.
export function groupCompareArtifacts(artifacts: Artifact[]) {
  const byName = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const list = byName.get(artifact.name) ?? [];
    list.push(artifact);
    byName.set(artifact.name, list);
  }
  return [...byName.values()].map((versions) => {
    const sorted = [...versions].sort((a, b) => (b.step ?? -1) - (a.step ?? -1));
    return { latest: sorted[0], versionCount: sorted.length };
  });
}

function CompareArtifactStrip({ artifactsByRun, runs }: { artifactsByRun: Record<string, Artifact[]>; runs: RunSummary[] }) {
  const runArtifacts = runs.map((run) => ({
    run,
    groups: groupCompareArtifacts(artifactsByRun[run.id] ?? []).slice(0, 3),
    expected: Boolean(artifactsByRun[run.id]),
  }));
  if (!runArtifacts.some((item) => item.groups.length || !item.expected)) return null;
  return (
    <section className="compare-artifact-strip">
      {runArtifacts.map(({ run, groups, expected }) => (
        <article className="compare-artifact-run" key={run.id}>
          <strong title={run.name}>{run.name}</strong>
          {groups.length ? groups.map(({ latest, versionCount }) => (
            <div className="compare-artifact-card" key={latest.id}>
              <strong>{latest.name}</strong>
              <small>
                {latest.step === null ? "no step" : `step ${latest.step}`} · {formatBytes(latest.size_bytes)}
                {versionCount > 1 ? ` · ${versionCount} versions` : ""}
              </small>
              <ArtifactMediaPreview artifact={latest} compact />
            </div>
          )) : <small>{expected ? "Loading metadata..." : "No artifacts"}</small>}
        </article>
      ))}
    </section>
  );
}

function CompareRunHead({ referenceRunId, run, color }: { referenceRunId: string; run: RunSummary; color: string }) {
  return (
    <div className={`compare-run-head ${run.id === referenceRunId ? "reference" : ""}`}>
      <span className="cmp-swatch" style={{ background: color }} aria-hidden />
      <strong title={run.name}>{run.name}</strong>
      <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
      {run.id === referenceRunId ? <small className="compare-reference-badge">Reference</small> : null}
    </div>
  );
}

function CompareMatrix({ referenceRunId, rows, runs, colorByRunId }: { referenceRunId: string; rows: CompareRowView[]; runs: RunSummary[]; colorByRunId: Map<string, string> }) {
  return (
    <div className="compare-matrix" style={{ gridTemplateColumns: `minmax(210px, 0.85fr) repeat(${runs.length}, minmax(180px, 1fr))` }}>
      <div className="compare-head compare-attribute">Attribute</div>
      {runs.map((run) => (
        <CompareRunHead referenceRunId={referenceRunId} run={run} color={colorByRunId.get(run.id) ?? "var(--dim)"} key={run.id} />
      ))}
      {rows.map((row) => (
        <div className="compare-row-fragment" key={row.key} role="row">
          <div className={`compare-attribute ${row.different ? "changed" : ""}`}>
            <small>{row.category}</small>
            <strong title={row.path}>{row.label}</strong>
          </div>
          {runs.map((run) => {
            const raw = row.values?.[run.id];
            const value = compactValue(raw);
            const referenceValue = row.values?.[referenceRunId];
            const changed = run.id !== referenceRunId && value !== compactValue(referenceValue);
            // Numbers use the shared metric formatter so precision matches the rows view.
            const display = typeof raw === "number" && Number.isFinite(raw) ? formatMetricValue(raw) : shortValue(value);
            return (
              <div className={`compare-cell ${run.id === referenceRunId ? "reference" : ""} ${changed ? "changed" : ""}`} key={`${row.key}-${run.id}`} title={value}>
                <span>{display}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SortHead({
  active,
  align,
  dir,
  label,
  meta,
  onSort,
  sticky = false,
  title,
}: {
  active: boolean;
  align?: "num";
  dir: SortDir;
  label: string;
  meta?: string;
  onSort: () => void;
  sticky?: boolean;
  title?: string;
}) {
  const Chevron = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  const sortLabel = active ? `${label}, sorted ${dir === "asc" ? "ascending" : "descending"}` : `Sort by ${label}`;
  const sortState = active ? (dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <div
      aria-sort={sortState}
      className={`cmp-th-cell ${sticky ? "sticky" : ""}`}
      role="columnheader"
    >
      <button
        aria-label={sortLabel}
        className={`cmp-th ${active ? "sorted" : ""} ${align === "num" ? "num" : ""}`}
        onClick={onSort}
        title={title ?? `Sort by ${label}`}
        type="button"
      >
        <span className="cmp-th-label">{label}<Chevron className="cmp-th-chev" size={12} /></span>
        {meta ? <span className="cmp-th-meta">{meta}</span> : null}
      </button>
    </div>
  );
}

function CompareRunTable({
  columns,
  colorByRunId,
  lookup,
  metricKey,
  onOpenRunArtifacts,
  onReference,
  referenceRunId,
  runs,
  sort,
  onSort,
}: {
  columns: CompareColumn[];
  colorByRunId: Map<string, string>;
  lookup: MetricLookup;
  metricKey: string;
  onOpenRunArtifacts?: (runId: string) => void;
  onReference?: (runId: string) => void;
  referenceRunId: string;
  runs: RunSummary[];
  sort: SortState;
  onSort: (col: string, preferAsc: boolean) => void;
}) {
  const referenceRun = runs.find((run) => run.id === referenceRunId);
  const gridTemplate = `minmax(220px, 1.4fr) ${columns.map((column) => column.kind === "metric" ? "minmax(132px, 1fr)" : "minmax(96px, 0.7fr)").join(" ")}`;
  return (
    <div className="cmp-table-shell">
    <div className="cmp-table-wrap">
      <div className="cmp-table" role="table" style={{ "--cmp-cols": gridTemplate } as CSSProperties}>
        <div className="cmp-row cmp-head-row" role="row">
          <SortHead active={sort.col === "identity"} dir={sort.dir} label="Run" onSort={() => onSort("identity", true)} sticky title="Sort by run name" />
          {columns.map((column) => {
            if (column.kind === "metric") {
              return (
                <SortHead
                  active={sort.col === column.key}
                  align="num"
                  dir={sort.dir}
                  key={column.key}
                  label={metricTitle(column.metricKey)}
                  meta={`${metricNamespace(column.metricKey)} · ${metricGoalLabel(column.metricKey)}`}
                  onSort={() => onSort(column.key, column.goal === "minimize")}
                  title={column.metricKey}
                />
              );
            }
            if (column.kind === "config") {
              return (
                <SortHead active={sort.col === column.key} align="num" dir={sort.dir} key={column.key} label={column.configKey} meta="config" onSort={() => onSort(column.key, true)} />
              );
            }
            const labels: Record<string, [string, string | undefined, boolean]> = {
              status: ["Status", undefined, false],
              duration: ["Duration", "wall clock", true],
              artifacts: ["Artifacts", undefined, true],
            };
            const [label, meta, numeric] = labels[column.kind];
            return <SortHead active={sort.col === column.key} align={numeric ? "num" : undefined} dir={sort.dir} key={column.key} label={label} meta={meta} onSort={() => onSort(column.key, column.kind !== "duration")} />;
          })}
        </div>
        {runs.map((run) => {
          const isReference = run.id === referenceRunId;
          const color = colorByRunId.get(run.id) ?? "var(--dim)";
          return (
            <div className={`cmp-row ${isReference ? "reference" : ""}`} key={run.id} role="row">
              <div className="cmp-cell cmp-identity sticky" role="cell">
                <span className="cmp-swatch" style={{ background: color }} aria-hidden />
                <span className="cmp-identity-meta">
                  <span className="cmp-run-name" title={run.name}>{run.name}</span>
                  <span className="cmp-identity-sub">
                    <span className={`pill cmp-status ${statusTone(run.status)}`}>{run.status}</span>
                    {isReference ? <span className="cmp-ref-tag">Reference</span> : <span className="cmp-proj">{run.project}</span>}
                  </span>
                </span>
                {onReference ? (
                  <button
                    aria-label={isReference ? `${run.name} is the reference run` : `Set ${run.name} as reference`}
                    aria-pressed={isReference}
                    className={`cmp-anchor ${isReference ? "on" : ""}`}
                    onClick={() => onReference(run.id)}
                    title={isReference ? "Reference run" : "Set as reference"}
                    type="button"
                  >
                    {isReference ? "◆" : "◇"}
                  </button>
                ) : null}
              </div>
              {columns.map((column) => {
                if (column.kind === "metric") {
                  const best = lookup.best(run.id, column.metricKey);
                  const latest = lookup.latest(run.id, column.metricKey);
                  const referenceBest = referenceRun ? lookup.best(referenceRun.id, column.metricKey) : null;
                  const delta = isReference ? null : metricDelta(best, referenceBest, column.goal);
                  return (
                    <div className={`cmp-cell cmp-metric num ${column.metricKey === metricKey ? "primary" : ""}`} key={column.key} role="cell">
                      <span className="cmp-metric-val">{best === null ? <span className="cmp-dash">—</span> : formatMetricValue(best)}</span>
                      <span className="cmp-metric-sub">
                        {isReference ? (
                          <span className="cmp-baseline">reference</span>
                        ) : (
                          <>
                            {delta ? <span className={`cmp-delta ${delta.tone}`} title={delta.title}>{delta.text}</span> : null}
                            {typeof latest === "number" && Number.isFinite(latest) && (best === null || formatMetricValue(latest) !== formatMetricValue(best)) ? <span className="cmp-latest">latest {formatMetricValue(latest)}</span> : null}
                          </>
                        )}
                      </span>
                    </div>
                  );
                }
                if (column.kind === "config") {
                  const value = run.config?.[column.configKey];
                  const differs = !isReference && compactValue(value) !== compactValue(referenceRun?.config?.[column.configKey]);
                  return (
                    <div className={`cmp-cell num ${differs ? "diff" : ""}`} key={column.key} role="cell" title={compactValue(value)}>
                      {compactValue(value) === "-" ? <span className="cmp-dash">—</span> : shortValue(compactValue(value))}
                    </div>
                  );
                }
                if (column.kind === "status") {
                  return (
                    <div className="cmp-cell" key={column.key} role="cell">
                      <span className={`pill cmp-status ${statusTone(run.status)}`}>{run.status}</span>
                    </div>
                  );
                }
                if (column.kind === "duration") {
                  return <div className="cmp-cell num" key={column.key} role="cell">{formatDuration(runDurationMs(run))}</div>;
                }
                const artifactCount = artifactTotalForRun(run);
                return (
                  <div className="cmp-cell num" key={column.key} role="cell">
                    {artifactCount && onOpenRunArtifacts ? (
                      <button aria-label={`Open ${formatNumber(artifactCount, 0)} artifacts for ${run.name}`} className="cmp-artifact-link" onClick={() => onOpenRunArtifacts(run.id)} type="button">
                        {formatNumber(artifactCount, 0)}
                      </button>
                    ) : (
                      <span>{artifactCount ? formatNumber(artifactCount, 0) : <span className="cmp-dash">—</span>}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
    </div>
  );
}

function CompareSummary({ metricKey, referenceRunId, runs, color, lookup }: { metricKey: string; referenceRunId: string; runs: RunSummary[]; color: string; lookup: MetricLookup }) {
  const bestRun = bestRunByMetric(runs, metricKey, lookup);
  const bestValue = bestRun ? lookup.best(bestRun.id, metricKey) : null;
  const referenceValue = lookup.best(referenceRunId, metricKey);
  const delta = bestRun && bestRun.id !== referenceRunId ? metricDelta(bestValue, referenceValue, metricGoal(metricKey)) : null;
  if (!bestRun) return null;
  return (
    <div className="cmp-best-banner">
      <span className="cmp-swatch lg" style={{ background: color }} aria-hidden />
      <div className="cmp-best-meta">
        <span className="analysis-eyebrow">{metricGoalLabel(metricKey)} run · {metricTitle(metricKey)}</span>
        <strong title={bestRun.name}>{bestRun.name}</strong>
      </div>
      <span className="cmp-best-val">{bestValue === null ? "—" : formatMetricValue(bestValue)}</span>
      {bestRun.id === referenceRunId ? (
        <span className="cmp-best-delta">reference</span>
      ) : delta ? (
        <span className={`cmp-best-delta cmp-delta ${delta.tone}`} title={delta.title}>{delta.text} vs reference</span>
      ) : null}
    </div>
  );
}

export function SideBySide({
  artifactsByRun = {},
  configSortKey = "",
  diffOnly = false,
  layout = "auto",
  metricKey,
  onOpenRunArtifacts,
  onReferenceRunId,
  payload,
  referenceRunId: selectedReferenceRunId = "",
  rowSort = "signal",
  search = "",
  tableMetrics,
}: {
  artifactsByRun?: Record<string, Artifact[]>;
  configSortKey?: string;
  diffOnly?: boolean;
  layout?: CompareLayout;
  metricKey: string;
  onOpenRunArtifacts?: (runId: string) => void;
  onReferenceRunId?: (id: string) => void;
  onRunSort?: (sort: CompareRunSort) => void;
  onRunSortMetricKey?: (metric: string) => void;
  payload: any;
  referenceRunId?: string;
  rowSort?: CompareRowSort;
  runSort?: CompareRunSort;
  runSortMetricKey?: string;
  search?: string;
  tableMetrics?: string[];
}) {
  const metricTableKeys = useMemo(() => uniqueMetricKeys([metricKey, ...(tableMetrics ?? [])]).slice(0, 7), [metricKey, tableMetrics]);
  const defaultSortCol = `metric:${metricKey}`;
  const [sort, setSort] = useState<SortState>({ col: defaultSortCol, dir: metricGoal(metricKey) === "minimize" ? "asc" : "desc" });

  if (!payload?.rows?.length) return <div className="empty">Select runs to compare configs, metrics, and attributes.</div>;
  const rawRuns = (payload.runs ?? []) as RunSummary[];

  // Stable run-identity color by selected order (independent of sort), so a run
  // keeps the same swatch across re-sorts and matches the charts' color identity.
  const colorByRunId = new Map(rawRuns.map((run, index) => [run.id, IDENTITY_PALETTE[index % IDENTITY_PALETTE.length]]));

  const searchTokens = compareSearchTokens(search);
  const runMatches = searchTokens.length
    ? rawRuns.filter((run) => searchTokens.every((token) => compareRunSearchText(run, artifactsByRun).includes(token)))
    : rawRuns;
  const runSearchActive = searchTokens.length > 0;
  const visibleRuns = runSearchActive && runMatches.length ? runMatches : runSearchActive ? [] : rawRuns;

  const referenceRunId = (selectedReferenceRunId && visibleRuns.some((run) => run.id === selectedReferenceRunId) ? selectedReferenceRunId : "")
    || (payload.reference_run_id && visibleRuns.some((run: RunSummary) => run.id === payload.reference_run_id) ? payload.reference_run_id : "")
    || visibleRuns[0]?.id
    || rawRuns[0]?.id
    || "";

  const resolvedLayout = layout === "auto" ? "rows" : layout;
  const lookup = buildMetricLookup(payload.rows ?? [], rawRuns);

  // Columns for the rows table: metric columns, then status/duration/artifacts, then
  // config columns (variation-first). "Diff only" hides config columns identical
  // across every run.
  const configKeys = deriveConfigKeys(visibleRuns);
  const orderedConfigKeys = configSortKey ? [configSortKey, ...configKeys.filter((key) => key !== configSortKey)] : configKeys;
  const visibleConfigKeys = (diffOnly ? orderedConfigKeys.filter((key) => configValuesDiffer(visibleRuns, key)) : orderedConfigKeys).slice(0, 5);
  // Drop the Artifacts column entirely when no compared run has any — an all-"—"
  // column is dead weight that just pushes config columns off-screen.
  const anyArtifacts = visibleRuns.some((run) => artifactTotalForRun(run) > 0 || (artifactsByRun[run.id]?.length ?? 0) > 0);
  const columns: CompareColumn[] = [
    ...metricTableKeys.map((key): MetricColumn => ({ kind: "metric", key: `metric:${key}`, metricKey: key, goal: metricGoal(key) })),
    { kind: "status", key: "status" },
    { kind: "duration", key: "duration" },
    ...(anyArtifacts ? [{ kind: "artifacts", key: "artifacts" } as AttrColumn] : []),
    ...visibleConfigKeys.map((key): ConfigColumn => ({ kind: "config", key: `config:${key}`, configKey: key })),
  ];

  // If the actively-sorted column was removed (e.g. a metric column deleted), fall
  // back to the default sort so the row order is never silently ambiguous.
  const sortColValid = sort.col === "identity" || columns.some((column) => column.key === sort.col);
  const effectiveSort: SortState = sortColValid ? sort : { col: defaultSortCol, dir: metricGoal(metricKey) === "minimize" ? "asc" : "desc" };
  const sortedRuns = sortRunsForTable(visibleRuns, effectiveSort, referenceRunId, lookup);

  const onSortColumn = (col: string, preferAsc: boolean) => {
    setSort((current) => current.col === col ? { col, dir: current.dir === "asc" ? "desc" : "asc" } : { col, dir: preferAsc ? "asc" : "desc" });
  };

  const handleReference = onReferenceRunId ? (runId: string) => onReferenceRunId(runId) : undefined;

  // ── matrix (transposed) layout state ────────────────────────────────────────
  const matrixRows = resolvedLayout === "columns"
    ? (() => {
        const all = buildCompareRows(payload.rows ?? [], visibleRuns).map((row) => ({
          ...row,
          different: compareRowIsDifferent(row, visibleRuns, referenceRunId),
          reference: row.values?.[referenceRunId],
        }));
        const diffRows = diffOnly ? all.filter((row) => row.different) : all;
        const searched = runSearchActive ? diffRows : filterCompareRows(diffRows, search);
        return sortCompareRows(searched, rowSort).slice(0, 80);
      })()
    : [];

  const referenceColor = colorByRunId.get(bestRunByMetric(visibleRuns, metricKey, lookup)?.id ?? "") ?? "var(--accent)";
  const hasRuns = visibleRuns.length > 0;

  return (
    <div className="panel-body side-by-side cmp-redesign" id="side-by-side">
      {runSearchActive ? (
        <small className="matrix-note search-scope-note">
          Search matched {runMatches.length} of {rawRuns.length} compared runs by name, tags, notes, config, or artifacts.
        </small>
      ) : null}
      {hasRuns ? (
        <>
          <CompareSummary metricKey={metricKey} referenceRunId={referenceRunId} runs={visibleRuns} color={referenceColor} lookup={lookup} />
          {resolvedLayout === "rows" ? (
            <CompareRunTable
              columns={columns}
              colorByRunId={colorByRunId}
              lookup={lookup}
              metricKey={metricKey}
              onOpenRunArtifacts={onOpenRunArtifacts}
              onReference={handleReference}
              referenceRunId={referenceRunId}
              runs={sortedRuns}
              sort={effectiveSort}
              onSort={onSortColumn}
            />
          ) : (
            <CompareMatrix referenceRunId={referenceRunId} rows={matrixRows} runs={visibleRuns} colorByRunId={colorByRunId} />
          )}
          <CompareArtifactStrip artifactsByRun={artifactsByRun} runs={visibleRuns} />
        </>
      ) : (
        <div className="empty">No compared runs match the current search.</div>
      )}
    </div>
  );
}

// Sort the visible runs by the active column, then pin the reference run to the top
// so deltas always read against a fixed anchor row.
function sortRunsForTable(runs: RunSummary[], sort: SortState, referenceRunId: string, lookup: MetricLookup) {
  const selectedOrder = new Map(runs.map((run, index) => [run.id, index]));
  const tie = (left: RunSummary, right: RunSummary) => (selectedOrder.get(left.id) ?? 0) - (selectedOrder.get(right.id) ?? 0);
  const dir = sort.dir === "asc" ? 1 : -1;
  const sorted = [...runs].sort((left, right) => {
    let result = 0;
    if (sort.col === "identity") result = left.name.localeCompare(right.name) * dir;
    else if (sort.col.startsWith("metric:")) {
      const key = sort.col.slice("metric:".length);
      result = numericNullsLast(lookup.best(left.id, key), lookup.best(right.id, key), dir);
    } else if (sort.col.startsWith("config:")) {
      const key = sort.col.slice("config:".length);
      result = compareConfigValues(left.config?.[key], right.config?.[key]) * dir;
    } else if (sort.col === "status") result = left.status.localeCompare(right.status) * dir;
    else if (sort.col === "duration") result = numericNullsLast(runDurationMs(left), runDurationMs(right), dir);
    else if (sort.col === "artifacts") result = numericNullsLast(artifactTotalForRun(left), artifactTotalForRun(right), dir);
    return result || tie(left, right);
  });
  const reference = sorted.find((run) => run.id === referenceRunId);
  return reference ? [reference, ...sorted.filter((run) => run.id !== referenceRunId)] : sorted;
}
