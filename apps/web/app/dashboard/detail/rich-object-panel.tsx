"use client";

import { Copy, FileText } from "lucide-react";
import { Fragment } from "react";

import { compactValue, formatBytes, shortValue } from "../../dashboard-models";
import { ArtifactMediaPreview } from "./artifact-panel";
import type { Artifact, LoggedObject, LoggedObjectRow } from "../../dashboard-types";

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Visible IDs/snippets remain selectable when clipboard permission is denied.
  }
}

function artifactFromLoggedObject(object: LoggedObject): Artifact | null {
  if (!object.artifact_id || !object.artifact) return null;
  return {
    id: object.artifact_id,
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

function TableObjectPreview({ object, rows }: { object: LoggedObject; rows: LoggedObjectRow[] }) {
  const summaryColumns = Array.isArray(object.summary?.columns)
    ? object.summary.columns.filter((value): value is string => typeof value === "string")
    : [];
  const rowObjects = rows.map((item) => item.row).slice(0, 20);
  const inferred = rowObjects.flatMap((row) => Object.keys(row));
  const columns = [...new Set([...summaryColumns, ...inferred])].slice(0, 8);
  if (!columns.length) return <small>Table preview is empty.</small>;
  return (
    <div className="rich-table-preview" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(96px, 1fr))` }}>
      {columns.map((column) => <strong key={column} title={column}>{column}</strong>)}
      {rowObjects.map((row, rowIndex) => columns.map((column) => (
        <span key={`${rowIndex}-${column}`} title={compactValue(row[column])}>{shortValue(compactValue(row[column]))}</span>
      )))}
      {Number(object.summary?.row_count ?? rowObjects.length) > rowObjects.length ? (
        <small className="rich-table-more">Showing {rowObjects.length} of {String(object.summary?.row_count)} rows</small>
      ) : null}
    </div>
  );
}

function HistogramObjectPreview({ object }: { object: LoggedObject }) {
  const value = object.value && typeof object.value === "object" ? object.value as Record<string, unknown> : {};
  const counts = Array.isArray(value.counts) ? value.counts.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).slice(0, 64) : [];
  const max = Math.max(1, ...counts);
  if (!counts.length) return <small>Histogram preview is empty.</small>;
  return (
    <div className="histogram-preview" aria-label={`${object.key} histogram preview`}>
      {counts.map((count, index) => (
        <span key={index} title={String(count)} style={{ height: `${Math.max(6, (count / max) * 76)}px` }} />
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

function CurveSparkline({
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
  const rows = Array.isArray(points) ? points.map(recordValue) : [];
  const coords = rows
    .map((row) => ({ x: numericValue(row[xKey]), y: numericValue(row[yKey]) }))
    .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null)
    .slice(0, 200);
  if (!coords.length) return <small className="eval-empty">{label} curve unavailable.</small>;
  const path = coords.map((point, index) => {
    const x = 8 + Math.max(0, Math.min(1, point.x)) * 124;
    const y = 46 - Math.max(0, Math.min(1, point.y)) * 38;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <div className="eval-sparkline">
      <strong>{label}</strong>
      <svg viewBox="0 0 140 54" role="img" aria-label={`${label} curve`}>
        <line x1="8" x2="132" y1="46" y2="46" />
        <line x1="8" x2="8" y1="8" y2="46" />
        {label === "ROC" ? <line className="eval-baseline" x1="8" x2="132" y1="46" y2="8" /> : null}
        <path d={path} />
        <text x="8" y="52">0</text>
        <text x="130" y="52" textAnchor="end">1</text>
        <text x="3" y="11">1</text>
      </svg>
    </div>
  );
}

function ClassificationEvalPreview({ object }: { object: LoggedObject }) {
  const value = recordValue(object.value);
  const classNames = Array.isArray(value.class_names) ? value.class_names.filter((item): item is string => typeof item === "string").slice(0, 2) : [];
  const matrix = Array.isArray(value.confusion_matrix) ? value.confusion_matrix : [];
  const cells = matrix.flatMap((row, rowIndex) => (
    Array.isArray(row) ? row.slice(0, 2).map((cell, columnIndex) => ({ rowIndex, columnIndex, value: numericValue(cell) ?? 0 })) : []
  )).slice(0, 4);
  const maxCell = Math.max(1, ...cells.map((cell) => cell.value));
  const perClass = Array.isArray(value.per_class) ? value.per_class.map(recordValue).slice(0, 2) : [];
  const predictions = Array.isArray(value.predictions) ? value.predictions.map(recordValue).slice(0, 5) : [];
  return (
    <div className="classification-eval-preview" aria-label={`${object.key} classification evaluation`}>
      <div className="eval-metric-strip">
        <span><strong>{formatEvalMetric(value.accuracy)}</strong><small>Accuracy</small></span>
        <span><strong>{formatEvalMetric(value.macro_f1)}</strong><small>Macro F1</small></span>
        <span><strong>{String(value.sample_count ?? "-")}</strong><small>Samples</small></span>
      </div>
      <div className="eval-curve-grid">
        <CurveSparkline label="PR" points={value.pr_curve} xKey="recall" yKey="precision" />
        <CurveSparkline label="ROC" points={value.roc_curve} xKey="fpr" yKey="tpr" />
      </div>
      {cells.length === 4 ? (
        <div className="eval-confusion" style={{ gridTemplateColumns: "auto repeat(2, minmax(54px, 1fr))" }}>
          <span />
          {classNames.map((label) => <b key={`pred-${label}`}>Pred {label}</b>)}
          {classNames.map((label, rowIndex) => (
            <Fragment key={`row-${label}`}>
              <b key={`true-${label}`}>True {label}</b>
              {cells.filter((cell) => cell.rowIndex === rowIndex).map((cell) => (
                <span
                  key={`${cell.rowIndex}-${cell.columnIndex}`}
                  style={{ backgroundColor: `rgba(47, 128, 237, ${0.08 + (cell.value / maxCell) * 0.34})` }}
                >
                  {cell.value}
                </span>
              ))}
            </Fragment>
          ))}
        </div>
      ) : <small className="eval-empty">Confusion matrix unavailable.</small>}
      {perClass.length ? (
        <div className="eval-per-class">
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
        <div className="eval-predictions">
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

function RichObjectCard({ object, rows }: { object: LoggedObject; rows: LoggedObjectRow[] }) {
  const artifact = artifactFromLoggedObject(object);
  return (
    <article className={`rich-object-card kind-${object.kind}`}>
      <div className="rich-object-head">
        <span className="chip">{object.kind}</span>
        <strong title={object.key}>{object.key}</strong>
        <small>{object.step === null ? "no step" : `step ${object.step}`}</small>
      </div>
      {object.kind === "table" ? <TableObjectPreview object={object} rows={rows} /> : null}
      {object.kind === "histogram" ? <HistogramObjectPreview object={object} /> : null}
      {object.kind === "classification_eval" ? <ClassificationEvalPreview object={object} /> : null}
      {artifact ? <ArtifactMediaPreview artifact={artifact} fallback /> : null}
      {object.kind !== "table" && object.kind !== "histogram" && object.kind !== "classification_eval" && !artifact ? (
        <small className="artifact-media-fallback">Preview unavailable.</small>
      ) : null}
      <div className="artifact-actions">
        {artifact ? <span>{formatBytes(artifact.size_bytes)}</span> : null}
        <button
          className="copy-button"
          onClick={() => void copyText(String(object.id))}
          title="Copy this object's unique ID to the clipboard (use it with the SDK/API to reference this object)"
          type="button"
        ><Copy size={13} /> Copy ID</button>
      </div>
    </article>
  );
}

export function RichObjectPanel({
  objects,
  rowsByObjectId = {},
  title = "Rich Objects",
}: {
  objects: LoggedObject[];
  rowsByObjectId?: Record<number, LoggedObjectRow[]>;
  title?: string;
}) {
  if (!objects.length) {
    return (
      <section className="detail-section rich-object-section">
        <h3><FileText size={15} /> {title}</h3>
        <small>No rich objects logged.</small>
      </section>
    );
  }
  return (
    <section className="detail-section rich-object-section">
      <h3><FileText size={15} /> {title} ({objects.length})</h3>
      <div className="rich-object-grid">
        {objects.slice(0, 12).map((object) => (
          <RichObjectCard key={object.id} object={object} rows={rowsByObjectId[object.id] ?? []} />
        ))}
      </div>
    </section>
  );
}
