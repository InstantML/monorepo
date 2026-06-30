"use client";

import { BarChart3, ChevronRight, Copy, FileText, Image, Music, RefreshCw, Search, Table2, Video } from "lucide-react";
import { Fragment, useDeferredValue, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";

import { isAbortError, queryString, retryTransientRequest } from "../../../src/api.js";
import { compactValue, formatBytes, shortValue } from "../../dashboard-models";
import { ArtifactMediaPreview } from "../detail/artifact-panel";
import { PageHead } from "../ui/page-head";
import type { Artifact, LoggedObjectRow, ObjectExplorerEnvelope, ObjectExplorerItem } from "../../dashboard-types";

const KIND_OPTIONS = [
  { value: "", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "text", label: "Text" },
  { value: "table", label: "Tables" },
  { value: "histogram", label: "Histograms" },
  { value: "classification_eval", label: "Evals" },
] as const;

const PAGE_LIMIT = 50;
const KIND_OPTION_VALUES: Set<string> = new Set(KIND_OPTIONS.map((option) => option.value));

type Props = {
  api: {
    get: <T = unknown>(path: string, options?: { signal?: AbortSignal }) => Promise<T>;
  };
  initialRunQuery?: string;
  project: string;
};

type ObjectUrlState = {
  fromStep: string;
  key: string;
  kind: string;
  runQuery: string;
  toStep: string;
};

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // The visible IDs remain selectable when clipboard permission is denied.
  }
}

function objectUrlState(initialRunQuery: string): ObjectUrlState {
  if (typeof window === "undefined") {
    return { fromStep: "", key: "", kind: "", runQuery: initialRunQuery, toStep: "" };
  }
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("kind") ?? "";
  return {
    fromStep: params.get("from_step") ?? "",
    key: params.get("key") ?? "",
    kind: KIND_OPTION_VALUES.has(kind) ? kind : "",
    runQuery: params.get("q") ?? initialRunQuery,
    toStep: params.get("to_step") ?? "",
  };
}

function replaceObjectUrl(state: ObjectUrlState) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const setOrDelete = (key: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) url.searchParams.set(key, trimmed);
    else url.searchParams.delete(key);
  };
  setOrDelete("kind", state.kind);
  setOrDelete("q", state.runQuery);
  setOrDelete("key", state.key);
  setOrDelete("from_step", state.fromStep);
  setOrDelete("to_step", state.toStep);
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", query ? `${url.pathname}?${query}` : url.pathname);
}

function artifactFromObject(object: ObjectExplorerItem): Artifact | null {
  if (!object.artifact_id || !object.artifact) return null;
  return {
    id: object.artifact_id,
    run_id: object.run_id,
    type: object.kind === "video" ? "rollout" : "file",
    name: object.artifact.name ?? object.key,
    uri: object.artifact.uri ?? "",
    step: object.step,
    size_bytes: object.artifact.size_bytes,
    mime_type: object.artifact.mime_type,
    storage_backend: object.artifact.storage_backend,
    metadata: {
      kind: object.kind,
      mime_type: object.artifact.mime_type,
      ...object.metadata,
    },
  };
}

function objectIcon(kind: string) {
  if (kind === "image") return <Image size={15} aria-hidden="true" />;
  if (kind === "video") return <Video size={15} aria-hidden="true" />;
  if (kind === "audio") return <Music size={15} aria-hidden="true" />;
  if (kind === "table") return <Table2 size={15} aria-hidden="true" />;
  if (kind === "histogram") return <BarChart3 size={15} aria-hidden="true" />;
  if (kind === "classification_eval") return <BarChart3 size={15} aria-hidden="true" />;
  return <FileText size={15} aria-hidden="true" />;
}

function objectStepLabel(object: ObjectExplorerItem) {
  return object.step === null || object.step === undefined ? "no step" : `step ${object.step}`;
}

function tableColumns(rows: LoggedObjectRow[], object: ObjectExplorerItem) {
  const summaryColumns = Array.isArray(object.summary?.columns)
    ? object.summary.columns.filter((value): value is string => typeof value === "string")
    : [];
  const inferred = rows.flatMap((row) => Object.keys(row.row));
  return [...new Set([...summaryColumns, ...inferred])].slice(0, 8);
}

function TextPreview({ object }: { object: ObjectExplorerItem }) {
  const text = object.preview?.text ?? "";
  if (!text) return <small className="objects-empty-note">No text preview available.</small>;
  return (
    <pre className="objects-text-preview">
      {text}
      {object.preview?.truncated ? "\n..." : ""}
    </pre>
  );
}

function HistogramPreview({ object }: { object: ObjectExplorerItem }) {
  const counts = Array.isArray(object.preview?.histogram?.counts)
    ? object.preview?.histogram?.counts.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).slice(0, 64)
    : [];
  const max = Math.max(1, ...counts);
  if (!counts.length) return <small className="objects-empty-note">No histogram preview available.</small>;
  return (
    <div className="objects-histogram" aria-label={`${object.key} histogram preview`}>
      {counts.map((count, index) => (
        <span key={index} title={String(count)} style={{ height: `${Math.max(6, (count / max) * 120)}px` }} />
      ))}
    </div>
  );
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatEvalMetric(value: unknown) {
  const number = numericValue(value);
  return number === null ? "-" : `${(number * 100).toFixed(number >= 0.995 ? 0 : 1)}%`;
}

function CurvePreview({
  label,
  points,
  xKey,
  yKey,
}: {
  label: string;
  points: unknown;
  xKey: string;
  yKey: string;
}) {
  const coords = (Array.isArray(points) ? points.map(recordValue) : [])
    .map((row) => ({ x: numericValue(row[xKey]), y: numericValue(row[yKey]) }))
    .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null)
    .slice(0, 200);
  if (!coords.length) return <small className="objects-empty-note">{label} curve unavailable.</small>;
  const path = coords.map((point, index) => {
    const x = 8 + Math.max(0, Math.min(1, point.x)) * 124;
    const y = 46 - Math.max(0, Math.min(1, point.y)) * 38;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <div className="objects-eval-curve">
      <strong>{label}</strong>
      <svg viewBox="0 0 140 54" role="img" aria-label={`${label} curve`}>
        <line x1="8" x2="132" y1="46" y2="46" />
        <line x1="8" x2="8" y1="8" y2="46" />
        {label === "ROC" ? <line className="objects-eval-baseline" x1="8" x2="132" y1="46" y2="8" /> : null}
        <path d={path} />
        <text x="8" y="52">0</text>
        <text x="130" y="52" textAnchor="end">1</text>
        <text x="3" y="11">1</text>
      </svg>
    </div>
  );
}

function ClassificationEvalPreview({ object }: { object: ObjectExplorerItem }) {
  const value = recordValue(object.preview?.evaluation);
  const classNames = Array.isArray(value.class_names) ? value.class_names.filter((item): item is string => typeof item === "string").slice(0, 2) : [];
  const displayClasses = classNames.length === 2 ? classNames : ["0", "1"];
  const matrix = Array.isArray(value.confusion_matrix) ? value.confusion_matrix : [];
  const cells = matrix.flatMap((row, rowIndex) => (
    Array.isArray(row) ? row.slice(0, 2).map((cell, columnIndex) => ({ rowIndex, columnIndex, value: numericValue(cell) ?? 0 })) : []
  )).slice(0, 4);
  const maxCell = Math.max(1, ...cells.map((cell) => cell.value));
  const perClass = Array.isArray(value.per_class) ? value.per_class.map(recordValue).slice(0, 2) : [];
  const predictions = Array.isArray(value.predictions) ? value.predictions.map(recordValue).slice(0, 5) : [];
  if (!Object.keys(value).length) return <small className="objects-empty-note">Classification evaluation preview unavailable.</small>;
  return (
    <div className="objects-eval-preview" aria-label={`${object.key} classification evaluation`}>
      <div className="objects-eval-metrics">
        <span><strong>{formatEvalMetric(value.accuracy)}</strong><small>Accuracy</small></span>
        <span><strong>{formatEvalMetric(value.macro_f1)}</strong><small>Macro F1</small></span>
        <span><strong>{String(value.sample_count ?? "-")}</strong><small>Samples</small></span>
      </div>
      <div className="objects-eval-curves">
        <CurvePreview label="PR" points={value.pr_curve} xKey="recall" yKey="precision" />
        <CurvePreview label="ROC" points={value.roc_curve} xKey="fpr" yKey="tpr" />
      </div>
      {cells.length === 4 ? (
        <div className="objects-eval-confusion" style={{ gridTemplateColumns: "auto repeat(2, minmax(54px, 1fr))" }}>
          <span />
          {displayClasses.map((label) => <b key={`pred-${label}`}>Pred {label}</b>)}
          {displayClasses.map((label, rowIndex) => (
            <Fragment key={`row-${label}`}>
              <b>True {label}</b>
              {cells.filter((cell) => cell.rowIndex === rowIndex).map((cell) => (
                <span
                  key={`${cell.rowIndex}-${cell.columnIndex}`}
                  style={{ backgroundColor: `color-mix(in srgb, var(--accent) ${((0.08 + (cell.value / maxCell) * 0.34) * 100).toFixed(1)}%, transparent)` }}
                >
                  {cell.value}
                </span>
              ))}
            </Fragment>
          ))}
        </div>
      ) : <small className="objects-empty-note">Confusion matrix unavailable.</small>}
      {perClass.length ? (
        <div className="objects-eval-per-class">
          <strong>Class</strong><strong>Precision</strong><strong>Recall</strong><strong>F1</strong>
          {perClass.flatMap((row, index) => [
            <span key={`${index}-class`} title={String(row.class_name ?? "")}>{String(row.class_name ?? "-")}</span>,
            <span key={`${index}-precision`}>{formatEvalMetric(row.precision)}</span>,
            <span key={`${index}-recall`}>{formatEvalMetric(row.recall)}</span>,
            <span key={`${index}-f1`}>{formatEvalMetric(row.f1)}</span>,
          ])}
        </div>
      ) : null}
      {predictions.length ? (
        <div className="objects-eval-predictions">
          {predictions.map((row, index) => (
            <span key={`${row.id ?? index}`} title={compactValue(row)}>
              <b>{shortValue(String(row.id ?? index))}</b>
              <em>{shortValue(String(row.true_label ?? "-"))} {"->"} {shortValue(String(row.predicted_label ?? "-"))}</em>
              <strong>{formatEvalMetric(row.score)}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TablePreview({ object, rows, loading }: { object: ObjectExplorerItem; rows: LoggedObjectRow[]; loading: boolean }) {
  if (loading) return <small className="objects-empty-note">Loading table rows...</small>;
  const columns = tableColumns(rows, object);
  if (!columns.length) return <small className="objects-empty-note">No table rows available.</small>;
  return (
    <div className="objects-table-preview" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(112px, 1fr))` }}>
      {columns.map((column) => <strong key={column} title={column}>{column}</strong>)}
      {rows.slice(0, 20).flatMap((row, rowIndex) => columns.map((column) => (
        <span key={`${row.row_index}-${rowIndex}-${column}`} title={compactValue(row.row[column])}>
          {shortValue(compactValue(row.row[column]))}
        </span>
      )))}
    </div>
  );
}

function ObjectPreview({
  object,
  tableLoading,
  tableRows,
}: {
  object: ObjectExplorerItem;
  tableLoading: boolean;
  tableRows: LoggedObjectRow[];
}) {
  if (object.kind === "text") return <TextPreview object={object} />;
  if (object.kind === "histogram") return <HistogramPreview object={object} />;
  if (object.kind === "classification_eval") return <ClassificationEvalPreview object={object} />;
  if (object.kind === "table") return <TablePreview object={object} rows={tableRows} loading={tableLoading} />;
  const artifact = artifactFromObject(object);
  if (artifact) return <ArtifactMediaPreview artifact={artifact} fallback />;
  return <small className="objects-empty-note">Preview unavailable for this object.</small>;
}

function ObjectResultButton({
  active,
  object,
  onSelect,
}: {
  active: boolean;
  object: ObjectExplorerItem;
  onSelect: (object: ObjectExplorerItem) => void;
}) {
  return (
    <button
      aria-selected={active}
      className={`objects-result${active ? " selected" : ""}`}
      id={`object-${object.object_id}`}
      onClick={() => onSelect(object)}
      role="option"
      type="button"
    >
      <span className="objects-result-icon">{objectIcon(object.kind)}</span>
      <span className="objects-result-main">
        <strong title={object.key}>{object.key}</strong>
        <small title={object.run_name}>{object.run_name}</small>
      </span>
      <span className="objects-result-meta">
        <em>{object.kind}</em>
        <small>{objectStepLabel(object)}</small>
      </span>
      <ChevronRight size={15} aria-hidden="true" />
    </button>
  );
}

export function ObjectsTabPane({ api, initialRunQuery = "", project }: Props) {
  const [kind, setKind] = useState("");
  const [key, setKey] = useState("");
  const [runQuery, setRunQuery] = useState(initialRunQuery);
  const [fromStep, setFromStep] = useState("");
  const [toStep, setToStep] = useState("");
  const [urlStateReady, setUrlStateReady] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const deferredKey = useDeferredValue(key.trim());
  const deferredRunQuery = useDeferredValue(runQuery.trim());
  const deferredFromStep = useDeferredValue(fromStep.trim());
  const deferredToStep = useDeferredValue(toStep.trim());
  const [objects, setObjects] = useState<ObjectExplorerItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [tableRows, setTableRows] = useState<LoggedObjectRow[]>([]);
  const [tableLoading, setTableLoading] = useState(false);

  const selected = useMemo(
    () => objects.find((object) => object.object_id === selectedId) ?? objects[0] ?? null,
    [objects, selectedId],
  );
  const histogramCount = objects.filter((object) => object.kind === "histogram").length;
  const mediaCount = objects.filter((object) => ["image", "video", "audio"].includes(object.kind)).length;
  const textCount = objects.filter((object) => object.kind === "text").length;
  const evalCount = objects.filter((object) => object.kind === "classification_eval").length;

  useEffect(() => {
    if (!urlStateReady) return;
    replaceObjectUrl({ fromStep, key, kind, runQuery, toStep });
  }, [fromStep, key, kind, runQuery, toStep, urlStateReady]);

  useEffect(() => {
    function syncFromUrl() {
      const next = objectUrlState(initialRunQuery);
      setKind(next.kind);
      setKey(next.key);
      setRunQuery(next.runQuery);
      setFromStep(next.fromStep);
      setToStep(next.toStep);
      setUrlStateReady(true);
    }
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [initialRunQuery]);

  useEffect(() => {
    if (!urlStateReady) return;
    const controller = new AbortController();
    let cancelled = false;
    async function loadObjects() {
      setLoading(true);
      setError("");
      const payload = await retryTransientRequest(
        () => api.get<ObjectExplorerEnvelope>(`/api/objects/explorer${queryString({
          project,
          q: deferredRunQuery,
          kind,
          key: deferredKey,
          from_step: deferredFromStep,
          to_step: deferredToStep,
          limit: PAGE_LIMIT,
        })}`, { signal: controller.signal }),
        { signal: controller.signal },
      );
      if (cancelled) return;
      const nextObjects: ObjectExplorerItem[] = Array.isArray(payload.objects) ? payload.objects : [];
      setObjects(nextObjects);
      setNextCursor(typeof payload.next_cursor === "string" ? payload.next_cursor : null);
      setSelectedId((current) => nextObjects.some((object) => object.object_id === current) ? current : nextObjects[0]?.object_id ?? "");
      setLoading(false);
    }
    loadObjects().catch((caught) => {
      if (cancelled || isAbortError(caught)) return;
      setObjects([]);
      setNextCursor(null);
      setSelectedId("");
      setError(caught instanceof Error ? caught.message : "Unable to load object explorer.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, deferredFromStep, deferredKey, deferredRunQuery, deferredToStep, kind, project, refreshNonce, urlStateReady]);

  useEffect(() => {
    const object = selected;
    if (!object || object.kind !== "table") {
      setTableRows([]);
      setTableLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setTableLoading(true);
    api.get<{ rows?: LoggedObjectRow[] }>(`/api/objects/${object.id}/rows${queryString({ limit: 20 })}`, { signal: controller.signal })
      .then((payload) => {
        if (!cancelled) setTableRows(Array.isArray(payload.rows) ? payload.rows : []);
      })
      .catch((caught) => {
        if (!cancelled && !isAbortError(caught)) setTableRows([]);
      })
      .finally(() => {
        if (!cancelled) setTableLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, selected]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const payload = await api.get<ObjectExplorerEnvelope>(`/api/objects/explorer${queryString({
        project,
        q: deferredRunQuery,
        kind,
        key: deferredKey,
        from_step: deferredFromStep,
        to_step: deferredToStep,
        limit: PAGE_LIMIT,
        cursor: nextCursor,
      })}`);
      const more: ObjectExplorerItem[] = Array.isArray(payload.objects) ? payload.objects : [];
      setObjects((current) => [...current, ...more]);
      setNextCursor(typeof payload.next_cursor === "string" ? payload.next_cursor : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load more objects.");
    } finally {
      setLoadingMore(false);
    }
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!objects.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, objects.findIndex((object) => object.object_id === selected?.object_id));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? objects.length - 1
        : event.key === "ArrowDown"
          ? Math.min(objects.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
    setSelectedId(objects[nextIndex]?.object_id ?? "");
  }

  return (
    <div className="objects-workspace">
      <PageHead
        eyebrow="Rich evidence"
        title="Objects"
        lede={`${objects.length}${nextCursor ? "+" : ""} loaded`}
      />

      <section className="objects-filter-band" aria-label="Object filters">
        <div className="objects-kind-tabs" role="tablist" aria-label="Object kind">
          {KIND_OPTIONS.map((option) => (
            <button
              aria-pressed={kind === option.value}
              className={kind === option.value ? "selected" : ""}
              key={option.value || "all"}
              onClick={() => setKind(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="objects-search-control">
          <Search size={14} aria-hidden="true" />
          <span className="visually-hidden">Run query</span>
          <input value={runQuery} onChange={(event) => setRunQuery(event.target.value)} placeholder="Run query" />
        </label>
        <label className="objects-search-control">
          <span>Key</span>
          <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="eval/" />
        </label>
        <label className="objects-step-control">
          <span>From</span>
          <input inputMode="numeric" value={fromStep} onChange={(event) => setFromStep(event.target.value)} placeholder="step" />
        </label>
        <label className="objects-step-control">
          <span>To</span>
          <input inputMode="numeric" value={toStep} onChange={(event) => setToStep(event.target.value)} placeholder="step" />
        </label>
        <button className="icon-button framed" type="button" aria-label="Refresh objects" onClick={() => setRefreshNonce((value) => value + 1)}>
          <RefreshCw size={15} />
        </button>
      </section>

      <section className="objects-stat-strip" aria-label="Loaded object summary">
        <span><strong>{mediaCount}</strong><small>media</small></span>
        <span><strong>{textCount}</strong><small>text</small></span>
        <span><strong>{histogramCount}</strong><small>histograms</small></span>
        <span><strong>{evalCount}</strong><small>evals</small></span>
      </section>

      {error ? <div className="objects-error" role="alert">{error}</div> : null}

      <div className="objects-layout">
        <div className="objects-results-panel">
          <div className="objects-results-head">
            <strong>Results</strong>
            <small>{loading ? "Loading..." : `${objects.length} objects`}</small>
          </div>
          <div
            aria-activedescendant={selected ? `object-${selected.object_id}` : undefined}
            aria-label="Object results"
            className="objects-results"
            onKeyDown={handleListKeyDown}
            role="listbox"
            tabIndex={0}
          >
            {loading ? <div className="objects-placeholder">Loading objects...</div> : null}
            {!loading && !objects.length ? <div className="objects-placeholder">No objects match these filters.</div> : null}
            {!loading ? objects.map((object) => (
              <ObjectResultButton
                active={selected?.object_id === object.object_id}
                key={object.object_id}
                object={object}
                onSelect={(nextObject) => setSelectedId(nextObject.object_id)}
              />
            )) : null}
          </div>
          {nextCursor ? (
            <button className="secondary objects-load-more" disabled={loadingMore} type="button" onClick={() => void loadMore()}>
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          ) : null}
        </div>

        <aside className="objects-inspector" aria-label="Selected object inspector">
          {selected ? (
            <>
              <div className="objects-inspector-head">
                <span className="objects-result-icon">{objectIcon(selected.kind)}</span>
                <div>
                  <strong title={selected.key}>{selected.key}</strong>
                  <small>{selected.run_name} / {selected.project} / {objectStepLabel(selected)}</small>
                </div>
                <button className="copy-button" type="button" onClick={() => void copyText(selected.object_id)} title="Copy object ID">
                  <Copy size={13} /> ID
                </button>
              </div>
              <ObjectPreview object={selected} tableLoading={tableLoading} tableRows={tableRows} />
              <div className="objects-detail-grid">
                <span><small>Kind</small><strong>{selected.kind}</strong></span>
                <span><small>Run</small><strong title={selected.run_name}>{shortValue(selected.run_name)}</strong></span>
                <span><small>Size</small><strong>{formatBytes(selected.artifact?.size_bytes)}</strong></span>
                <span><small>Created</small><strong>{new Date(selected.created_at).toLocaleString()}</strong></span>
              </div>
              {Object.keys(selected.summary ?? {}).length ? (
                <details className="objects-json-details">
                  <summary>Summary</summary>
                  <pre>{JSON.stringify(selected.summary, null, 2)}</pre>
                </details>
              ) : null}
            </>
          ) : (
            <div className="objects-placeholder">Select an object to inspect details.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
