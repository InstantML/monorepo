"use client";

import { Download, Copy } from "lucide-react";

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
  safeArtifactUri,
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

function compareDatesDesc(left: string, right: string) {
  return compareNumbersDesc(Date.parse(left), Date.parse(right));
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
  const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : null;
  const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return 1;
  if (rightNumber === null) return -1;
  return leftNumber - rightNumber;
}

function compareMetricBest(left: RunSummary, right: RunSummary, metricKey: string) {
  const goal = metricGoal(metricKey);
  const leftValue = goal === "minimize" ? left.metric_aggregates?.[metricKey]?.min : left.metric_aggregates?.[metricKey]?.max;
  const rightValue = goal === "minimize" ? right.metric_aggregates?.[metricKey]?.min : right.metric_aggregates?.[metricKey]?.max;
  return goal === "minimize" ? compareNumbersAsc(leftValue, rightValue) : compareNumbersDesc(leftValue, rightValue);
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

function statusPriority(status: string) {
  if (status === "failed") return 0;
  if (status === "running") return 1;
  if (status === "finished") return 2;
  return 3;
}

function relativeDeltaLabel(value: unknown, reference: unknown) {
  if (typeof value !== "number" || typeof reference !== "number" || !Number.isFinite(value) || !Number.isFinite(reference)) return "";
  const delta = value - reference;
  if (delta === 0) return "0";
  if (reference === 0) return `${delta > 0 ? "+" : ""}${formatNumber(delta, 3)}`;
  const percent = (delta / Math.abs(reference)) * 100;
  return `${percent > 0 ? "+" : ""}${formatNumber(percent, 1)}%`;
}

function compareMetricValueForRun(rows: CompareRowView[], runId: string, metricKey: string, reducer: string) {
  const row = rows.find((candidate) => candidate.path === `metric/${metricKey}/${reducer}`);
  const value = row?.values?.[runId];
  return value === undefined || value === null ? null : value;
}

function compareMetricBestValueForRun(rows: CompareRowView[], runId: string, metricKey: string) {
  const reducers = metricGoal(metricKey) === "minimize" ? ["min", "latest", "mean"] : ["max", "latest", "mean"];
  for (const reducer of reducers) {
    const value = compareMetricValueForRun(rows, runId, metricKey, reducer);
    if (value !== null) return value;
  }
  return null;
}

function compareMetricBestRunFromRows(runs: RunSummary[], rows: CompareRowView[], metricKey: string) {
  const goal = metricGoal(metricKey);
  const candidates = runs
    .map((run) => {
      const value = compareMetricBestValueForRun(rows, run.id, metricKey);
      return typeof value === "number" && Number.isFinite(value) ? { run, value } : null;
    })
    .filter((item): item is { run: RunSummary; value: number } => Boolean(item));
  if (!candidates.length) return null;
  return candidates.sort((left, right) => goal === "minimize" ? left.value - right.value : right.value - left.value)[0];
}

function metricBestValue(run: RunSummary | undefined, metricKey: string) {
  if (!run) return null;
  const aggregate = run.metric_aggregates?.[metricKey];
  return metricGoal(metricKey) === "minimize" ? aggregate?.min : aggregate?.max;
}

function bestRunByMetric(runs: RunSummary[], metricKey: string) {
  return [...runs].sort((left, right) => compareMetricBest(left, right, metricKey))[0] ?? null;
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

function sortCompareRuns(runs: RunSummary[], runSort: CompareRunSort, metricKey: string, configSortKey: string, artifactsByRun: Record<string, Artifact[]>) {
  const selectedOrder = new Map(runs.map((run, index) => [run.id, index]));
  return [...runs].sort((left, right) => {
    const tie = (selectedOrder.get(left.id) ?? 0) - (selectedOrder.get(right.id) ?? 0) || left.name.localeCompare(right.name);
    if (runSort === "selected") return tie;
    if (runSort === "name") return left.name.localeCompare(right.name) || tie;
    if (runSort === "newest") return compareDatesDesc(left.created_at, right.created_at) || tie;
    if (runSort === "status") return statusPriority(left.status) - statusPriority(right.status) || left.status.localeCompare(right.status) || tie;
    if (runSort === "duration") return compareNumbersDesc(runDurationMs(left), runDurationMs(right)) || tie;
    if (runSort === "metric-latest") return compareNumbersDesc(left.latest_metrics?.[metricKey], right.latest_metrics?.[metricKey]) || tie;
    if (runSort === "metric-best") return compareMetricBest(left, right, metricKey) || tie;
    if (runSort === "artifacts") return compareNumbersDesc(artifactTotalForRun(left) + (artifactsByRun[left.id]?.length ?? 0), artifactTotalForRun(right) + (artifactsByRun[right.id]?.length ?? 0)) || tie;
    if (runSort === "tags") return compareNumbersDesc(left.tags?.length ?? 0, right.tags?.length ?? 0) || (left.tags ?? []).join(" ").localeCompare((right.tags ?? []).join(" ")) || tie;
    if (runSort === "notes") {
      const leftNote = runNoteText(left);
      const rightNote = runNoteText(right);
      return Number(Boolean(rightNote)) - Number(Boolean(leftNote)) || leftNote.localeCompare(rightNote) || tie;
    }
    if (runSort === "config") return compareConfigValues(left.config?.[configSortKey], right.config?.[configSortKey]) || tie;
    return tie;
  });
}

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

function buildCompareRows(rawRows: any[], runs: RunSummary[], artifactsByRun: Record<string, Artifact[]>): CompareRowView[] {
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

function artifactMediaKind(artifact: Artifact) {
  const mime = String(artifact.mime_type ?? artifact.metadata?.mime_type ?? artifact.metadata?.mimeType ?? artifact.metadata?.content_type ?? artifact.metadata?.contentType ?? "").toLowerCase();
  const name = `${artifact.name} ${artifact.uri}`.toLowerCase();
  if (mime.includes("image") || /\.(png|jpe?g|webp|gif)(?:$|[?#])/.test(name)) return "image";
  if (mime.includes("audio") || /\.(mp3|m4a|wav|aac)(?:$|[?#])/.test(name)) return "audio";
  if (mime.includes("video") || /\.(mp4|mov|webm)(?:$|[?#])/.test(name)) return "video";
  return "";
}

function artifactCanUseDownloadRoute(artifact: Artifact) {
  return artifactHasStoredBytes(artifact);
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function ArtifactMediaPreview({ artifact, compact = false, fallback = false }: { artifact: Artifact; compact?: boolean; fallback?: boolean }) {
  const kind = artifactMediaKind(artifact);
  if (!kind) return fallback ? <small className="artifact-media-fallback">Preview unavailable.</small> : null;
  const canPlay = artifactCanUseDownloadRoute(artifact);
  if (!canPlay) return <small className="artifact-media-fallback">{compact ? "Preview unavailable" : "Media preview unavailable; download or copy ID."}</small>;
  const src = artifactDownloadUrl(artifact);
  if (kind === "image") return <img alt={artifact.name} className="artifact-media artifact-image" loading="lazy" src={src} />;
  return kind === "audio" ? <audio className="artifact-media" controls preload="metadata" src={src} /> : <video className="artifact-media" controls preload="metadata" src={src} />;
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

function CompareArtifactStrip({ artifactsByRun, runs }: { artifactsByRun: Record<string, Artifact[]>; runs: RunSummary[] }) {
  const runArtifacts = runs.map((run) => ({
    run,
    artifacts: (artifactsByRun[run.id] ?? []).slice(0, 3),
    expected: Boolean(artifactsByRun[run.id]),
  }));
  if (!runArtifacts.some((item) => item.artifacts.length || !item.expected)) return null;
  return (
    <section className="compare-artifact-strip">
      {runArtifacts.map(({ run, artifacts, expected }) => (
        <article className="compare-artifact-run" key={run.id}>
          <strong title={run.name}>{run.name}</strong>
          {artifacts.length ? artifacts.map((artifact) => (
            <div className="compare-artifact-card" key={artifact.id}>
              <strong>{artifact.name}</strong>
              <small>{artifact.step === null ? "no step" : `step ${artifact.step}`} · {formatBytes(artifact.size_bytes)}</small>
              <ArtifactMediaPreview artifact={artifact} compact />
            </div>
          )) : <small>{expected ? "Loading metadata..." : "No artifacts"}</small>}
          {artifacts.length > 2 ? <small>+{artifacts.length - 2} more</small> : null}
        </article>
      ))}
    </section>
  );
}

function CompareRunHead({ referenceRunId, run }: { referenceRunId: string; run: RunSummary }) {
  return (
    <div className={`compare-run-head ${run.id === referenceRunId ? "reference" : ""}`}>
      <strong title={run.name}>{run.name}</strong>
      <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
      {run.id === referenceRunId ? <small className="compare-reference-badge">Reference</small> : null}
    </div>
  );
}

function CompareEvidenceHead({ row }: { row: CompareRowView }) {
  return (
    <div className="compare-row-head compare-evidence-head" title={row.path}>
      <small>{row.category}</small>
      <strong>{row.label}</strong>
    </div>
  );
}

function splitCompareHeaderLabel(label: string) {
  const slash = label.lastIndexOf("/");
  if (slash < 0) return { prefix: "", suffix: label };
  return { prefix: label.slice(0, slash + 1), suffix: label.slice(slash + 1) };
}

function CompareMatrix({ referenceRunId, rows, runs }: { referenceRunId: string; rows: CompareRowView[]; runs: RunSummary[] }) {
  return (
    <div className="compare-matrix" style={{ gridTemplateColumns: `minmax(210px, 0.85fr) repeat(${runs.length}, minmax(180px, 1fr))` }}>
      <div className="compare-head compare-attribute">Attribute</div>
      {runs.map((run) => (
        <CompareRunHead referenceRunId={referenceRunId} run={run} key={run.id} />
      ))}
      {rows.map((row) => (
        <div className="compare-row-fragment" key={row.key} role="row">
          <div className={`compare-attribute ${row.different ? "changed" : ""}`}>
            <small>{row.category}</small>
            <strong title={row.path}>{row.label}</strong>
          </div>
          {runs.map((run) => {
            const value = compactValue(row.values?.[run.id]);
            const referenceValue = row.values?.[referenceRunId];
            const changed = run.id !== referenceRunId && value !== compactValue(referenceValue);
            const delta = run.id === referenceRunId ? "" : relativeDeltaLabel(row.values?.[run.id], referenceValue);
            return (
              <div className={`compare-cell ${run.id === referenceRunId ? "reference" : ""} ${changed ? "changed" : ""}`} key={`${row.key}-${run.id}`} title={value}>
                <span>{shortValue(value)}</span>
                {delta ? <small className={delta.startsWith("+") ? "positive" : delta.startsWith("-") ? "negative" : ""}>{delta}</small> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CompareRunRows({
  allRows,
  configSortKey,
  metricKey,
  onOpenRunArtifacts,
  onRunSort,
  onRunSortMetricKey,
  referenceRunId,
  rows,
  runSort,
  runs,
  sortMetricKey,
  tableMetricKeys,
}: {
  allRows: CompareRowView[];
  configSortKey: string;
  metricKey: string;
  onOpenRunArtifacts?: (runId: string) => void;
  onRunSort?: (sort: CompareRunSort) => void;
  onRunSortMetricKey?: (metric: string) => void;
  referenceRunId: string;
  rows: CompareRowView[];
  runSort: CompareRunSort;
  runs: RunSummary[];
  sortMetricKey: string;
  tableMetricKeys: string[];
}) {
  const metricColumns = tableMetricKeys.length ? tableMetricKeys : [metricKey];
  const evidenceRows = rows.slice(0, Math.max(4, 8 - Math.max(0, metricColumns.length - 1)));
  const omittedEvidenceCount = Math.max(0, rows.length - evidenceRows.length);
  const fixedColumns = `280px repeat(${metricColumns.length}, minmax(148px, 170px)) 230px 96px 118px repeat(${evidenceRows.length}, 138px)`;
  const requestRunSort = (nextSort: CompareRunSort, nextMetricKey?: string) => {
    if (nextMetricKey) onRunSortMetricKey?.(nextMetricKey);
    onRunSort?.(nextSort);
  };
  return (
    <div className="compare-run-layout">
      <div className="compare-run-table" role="grid" style={{ gridTemplateColumns: fixedColumns }}>
        <button aria-label="Sort compared runs by name" className={`compare-row-head compare-sort-head sticky-run-cell ${runSort === "name" ? "active" : ""}`} onClick={() => requestRunSort("name")} type="button">Run</button>
        {metricColumns.map((tableMetricKey) => (
          <button
            aria-label={`Sort compared runs by ${tableMetricKey}`}
            className={`compare-row-head compare-sort-head ${sortMetricKey === tableMetricKey && (runSort === "metric-best" || runSort === "metric-latest") ? "active" : ""}`}
            key={tableMetricKey}
            onClick={() => requestRunSort("metric-best", tableMetricKey)}
            title={tableMetricKey}
            type="button"
          >
            <span>{metricTitle(tableMetricKey)}</span>
            <small>{metricNamespace(tableMetricKey)} · {metricGoalLabel(tableMetricKey)}</small>
          </button>
        ))}
        <button aria-label="Sort compared runs by annotations" className={`compare-row-head compare-sort-head ${runSort === "notes" || runSort === "tags" ? "active" : ""}`} onClick={() => requestRunSort(runSort === "notes" ? "tags" : "notes")} type="button">Annotations</button>
        <button aria-label="Sort compared runs by artifact count" className={`compare-row-head compare-sort-head ${runSort === "artifacts" ? "active" : ""}`} onClick={() => requestRunSort("artifacts")} type="button">Artifacts</button>
        <button aria-label={`Sort compared runs by ${configSortKey || "config"}`} className={`compare-row-head compare-sort-head ${runSort === "config" ? "active" : ""}`} onClick={() => requestRunSort("config")} type="button">{configSortKey || "Config"}</button>
        {evidenceRows.map((row) => <CompareEvidenceHead key={row.key} row={row} />)}
        {runs.map((run) => {
          const note = runNoteText(run);
          const artifactCount = artifactTotalForRun(run);
          return (
            <div className="compare-run-line" key={run.id} role="row">
              <div className={`compare-run-identity sticky-run-cell ${run.id === referenceRunId ? "reference" : ""}`}>
                <strong title={run.name}>{run.name}</strong>
                <span className="compare-run-meta-line">
                  <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
                  {run.id === referenceRunId ? <small className="compare-reference-badge">Reference</small> : <small>{run.project}</small>}
                </span>
              </div>
              {metricColumns.map((tableMetricKey) => {
                const aggregate = run.metric_aggregates?.[tableMetricKey];
                const referenceAggregate = runs.find((candidate) => candidate.id === referenceRunId)?.metric_aggregates?.[tableMetricKey];
                const latestValue = compareMetricValueForRun(allRows, run.id, tableMetricKey, "latest") ?? run.latest_metrics?.[tableMetricKey];
                const bestValue = compareMetricBestValueForRun(allRows, run.id, tableMetricKey) ?? (metricGoal(tableMetricKey) === "minimize" ? aggregate?.min : aggregate?.max);
                const referenceBestValue = compareMetricBestValueForRun(allRows, referenceRunId, tableMetricKey)
                  ?? (metricGoal(tableMetricKey) === "minimize" ? referenceAggregate?.min : referenceAggregate?.max);
                const delta = relativeDeltaLabel(bestValue, referenceBestValue);
                return (
                  <div className={`compare-run-cell compare-signal-cell compare-metric-cell ${tableMetricKey === metricKey ? "primary" : ""}`} key={`${run.id}-${tableMetricKey}`} title={tableMetricKey}>
                    <strong>{compactValue(bestValue)}</strong>
                    <small>latest {compactValue(latestValue)}{delta ? ` · ${delta}` : ""}</small>
                  </div>
                );
              })}
              <div className="compare-run-cell compare-annotations">
                <TagList tags={run.tags} />
                <small title={note}>{note || "No note"}</small>
              </div>
              <div className="compare-run-cell compare-artifact-count">
                {artifactCount && onOpenRunArtifacts ? (
                  <button
                    aria-label={`Open artifacts for ${run.name}`}
                    className="compare-artifact-count-button"
                    onClick={() => onOpenRunArtifacts(run.id)}
                    title={`Open ${formatNumber(artifactCount, 0)} artifacts for ${run.name}`}
                    type="button"
                  >
                    {formatNumber(artifactCount, 0)}
                  </button>
                ) : (
                  <span>{formatNumber(artifactCount, 0)}</span>
                )}
              </div>
              <div className="compare-run-cell">{configSortKey ? compactValue(run.config?.[configSortKey]) : "-"}</div>
              {evidenceRows.map((row) => {
                const value = compactValue(row.values?.[run.id]);
                const referenceValue = row.values?.[referenceRunId];
                const changed = run.id !== referenceRunId && value !== compactValue(referenceValue);
                return (
                  <div className={`compare-run-cell ${changed ? "changed" : ""}`} key={`${run.id}-${row.key}`} title={value}>{shortValue(value)}</div>
                );
              })}
            </div>
          );
        })}
      </div>
      {omittedEvidenceCount ? (
        <small className="matrix-note compare-evidence-note">Showing the top {evidenceRows.length} evidence fields in row mode; {omittedEvidenceCount} more are available through search, sorting, or column layout.</small>
      ) : null}
    </div>
  );
}

function CompareSummary({ metricKey, referenceRunId, rows, runs }: { metricKey: string; referenceRunId: string; rows: CompareRowView[]; runs: RunSummary[] }) {
  const bestRunFromRows = compareMetricBestRunFromRows(runs, rows, metricKey);
  const bestRun = bestRunFromRows?.run ?? bestRunByMetric(runs, metricKey);
  const referenceRun = runs.find((run) => run.id === referenceRunId);
  const bestValue = bestRunFromRows?.value ?? metricBestValue(bestRun, metricKey);
  const referenceValue = metricBestValue(referenceRun, metricKey);
  const delta = relativeDeltaLabel(bestValue, referenceValue);
  if (!bestRun) return null;
  return (
    <div className="compare-summary">
      <div className="compare-summary-cell">
        <span className="analysis-eyebrow">{metricGoalLabel(metricKey)} run · {metricKey}</span>
        <strong>{bestRun.name}</strong>
        <em>{formatNumber(bestValue, 3)}{delta ? ` (${delta} vs reference)` : ""}</em>
      </div>
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
  onRunSort,
  onRunSortMetricKey,
  payload,
  referenceRunId: selectedReferenceRunId = "",
  rowSort = "signal",
  runSort = "selected",
  runSortMetricKey,
  search = "",
  tableMetrics,
}: {
  artifactsByRun?: Record<string, Artifact[]>;
  configSortKey?: string;
  diffOnly?: boolean;
  layout?: CompareLayout;
  metricKey: string;
  onOpenRunArtifacts?: (runId: string) => void;
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
  if (!payload?.rows?.length) return <div className="empty">Select runs to compare configs, metrics, and attributes.</div>;
  const rawRuns = (payload.runs ?? []) as RunSummary[];
  const effectiveRunSortMetricKey = runSortMetricKey || metricKey;
  const metricTableKeys = uniqueMetricKeys([metricKey, ...(tableMetrics ?? [])]).slice(0, 7);
  const sortedRuns = sortCompareRuns(rawRuns, runSort, effectiveRunSortMetricKey, configSortKey, artifactsByRun);
  const searchTokens = compareSearchTokens(search);
  const runMatches = searchTokens.length
    ? sortedRuns.filter((run) => searchTokens.every((token) => compareRunSearchText(run, artifactsByRun).includes(token)))
    : sortedRuns;
  const runSearchActive = searchTokens.length > 0 && runMatches.length > 0;
  const selectedReferenceRun = selectedReferenceRunId ? sortedRuns.find((run) => run.id === selectedReferenceRunId) : null;
  const referencePreservedBySearch = Boolean(runSearchActive && selectedReferenceRun && !runMatches.some((run) => run.id === selectedReferenceRun.id));
  const visibleRuns = runSearchActive
    ? referencePreservedBySearch && selectedReferenceRun
      ? [selectedReferenceRun, ...runMatches]
      : runMatches
    : sortedRuns;
  const referenceRunId = (selectedReferenceRunId && visibleRuns.some((run) => run.id === selectedReferenceRunId) ? selectedReferenceRunId : "")
    || (payload.reference_run_id && visibleRuns.some((run: RunSummary) => run.id === payload.reference_run_id) ? payload.reference_run_id : "")
    || visibleRuns[0]?.id
    || sortedRuns[0]?.id
    || rawRuns[0]?.id
    || "";
  const resolvedLayout = layout === "auto" ? "rows" : layout;
  const allRows = buildCompareRows(payload.rows ?? [], visibleRuns, artifactsByRun).map((row) => ({
    ...row,
    different: compareRowIsDifferent(row, visibleRuns, referenceRunId),
    reference: row.values?.[referenceRunId],
  }));
  const diffRows = diffOnly ? allRows.filter((row) => row.different) : allRows;
  const searchedRows = runSearchActive ? diffRows : filterCompareRows(diffRows, search);
  const sortedRows = sortCompareRows(searchedRows, rowSort);
  const rowLimit = resolvedLayout === "rows" ? 40 : 80;
  const rows = sortedRows.slice(0, rowLimit);
  const hiddenCount = Math.max(0, sortedRows.length - rows.length);
  const searchActive = search.trim().length > 0;
  const hasRows = rows.length > 0;

  return (
    <div className="panel-body side-by-side" id="side-by-side">
      {runSearchActive ? (
        <small className="matrix-note search-scope-note">
          Search matched {runMatches.length} of {sortedRuns.length} compared runs by name, tags, notes, config, or artifacts{referencePreservedBySearch ? "; reference preserved for deltas" : ""}.
        </small>
      ) : null}
      {hasRows ? (
        <>
          <CompareSummary metricKey={metricKey} referenceRunId={referenceRunId} rows={sortedRows} runs={visibleRuns} />
          {resolvedLayout === "rows" ? (
            <CompareRunRows
              allRows={allRows}
              configSortKey={configSortKey}
              metricKey={metricKey}
              onOpenRunArtifacts={onOpenRunArtifacts}
              onRunSort={onRunSort}
              onRunSortMetricKey={onRunSortMetricKey}
              referenceRunId={referenceRunId}
              rows={rows}
              runSort={runSort}
              sortMetricKey={effectiveRunSortMetricKey}
              tableMetricKeys={metricTableKeys}
              runs={visibleRuns}
            />
          ) : (
            <CompareMatrix
              referenceRunId={referenceRunId}
              rows={rows}
              runs={visibleRuns}
            />
          )}
          <CompareArtifactStrip artifactsByRun={artifactsByRun} runs={visibleRuns} />
        </>
      ) : null}
      {!hasRows ? <div className="empty">No compared runs or rows match the current search.</div> : null}
      {hiddenCount ? (
        <small className="matrix-note">
          Showing {rows.length} of {sortedRows.length} rows{searchActive && !runSearchActive ? " after row search" : runSearchActive ? " for the matched runs" : ""}. Narrow the search or switch sorting to pull different evidence forward.
        </small>
      ) : null}
    </div>
  );
}
