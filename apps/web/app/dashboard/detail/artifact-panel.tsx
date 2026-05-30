"use client";

import { Copy, Download } from "lucide-react";

import { artifactHasStoredBytes, formatBytes, safeArtifactMediaKind, safeArtifactUri } from "../../dashboard-models";
import type { Artifact } from "../../dashboard-types";

function artifactCanUseDownloadRoute(artifact: Artifact) {
  return artifactHasStoredBytes(artifact);
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function copyText(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

export function ArtifactMediaPreview({ artifact, compact = false, fallback = false }: { artifact: Artifact; compact?: boolean; fallback?: boolean }) {
  const kind = safeArtifactMediaKind(artifact);
  if (!kind) return fallback ? <small className="artifact-media-fallback">Preview unavailable.</small> : null;
  const canPlay = artifactCanUseDownloadRoute(artifact);
  if (!canPlay) {
    return <small className="artifact-media-fallback">{compact ? "Preview unavailable" : "Media preview unavailable; download or copy ID."}</small>;
  }
  const src = artifactDownloadUrl(artifact);
  if (kind === "image") {
    return <img alt={artifact.name} className="artifact-media artifact-image" loading="lazy" src={src} />;
  }
  return kind === "audio" ? (
    <audio aria-label={`Audio preview for ${artifact.name}`} className="artifact-media" controls preload="metadata" src={src} />
  ) : (
    <video aria-label={`Video preview for ${artifact.name}`} className="artifact-media" controls preload="metadata" src={src} />
  );
}

export function ArtifactPanel({ title, items }: { title: string; items: Artifact[] }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="panel-body artifact-list">
        {items.length ? items.map((artifact) => (
          <article className="artifact-card" key={artifact.id}>
            <strong>{artifact.name}</strong>
            <small>{artifact.step === null ? "no step" : `step ${artifact.step}`}</small>
            <small>{safeArtifactUri(artifact.uri)}</small>
            <ArtifactMediaPreview artifact={artifact} />
            <div className="artifact-actions">
              <span>{formatBytes(artifact.size_bytes)}</span>
              {artifactCanUseDownloadRoute(artifact) ? (
                <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
              ) : null}
              <button
                className="copy-button"
                onClick={() => copyText(artifact.id)}
                title="Copy this artifact's unique ID to the clipboard (use it with the SDK/API to reference this file)"
                type="button"
              ><Copy size={13} /> Copy ID</button>
            </div>
          </article>
        )) : <div className="empty">Nothing logged yet.</div>}
      </div>
    </section>
  );
}
