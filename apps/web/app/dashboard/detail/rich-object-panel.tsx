"use client";

import { Copy, FileText } from "lucide-react";

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
      {artifact ? <ArtifactMediaPreview artifact={artifact} fallback /> : null}
      {object.kind !== "table" && object.kind !== "histogram" && !artifact ? (
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
