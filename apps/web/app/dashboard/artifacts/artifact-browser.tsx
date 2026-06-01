"use client";

import { Activity, Box, Copy, Download, FileText } from "lucide-react";

import { artifactHasStoredBytes, formatBytes, safeArtifactMediaKind, safeArtifactUri } from "../../dashboard-models";
import type { Artifact } from "../../dashboard-types";

function artifactCanUseDownloadRoute(artifact: Artifact) {
  return artifactHasStoredBytes(artifact);
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Visible IDs/snippets remain selectable when clipboard permission is denied.
  }
}

function ArtifactIcon({ type }: { type: string }) {
  if (type === "checkpoint") return <Box size={15} />;
  if (type === "rollout") return <Activity size={15} />;
  return <FileText size={15} />;
}

function ArtifactBrowserPreview({ artifact }: { artifact: Artifact }) {
  const kind = safeArtifactMediaKind(artifact);
  if (!kind || !artifactCanUseDownloadRoute(artifact)) return null;
  const src = artifactDownloadUrl(artifact);
  if (kind === "image") {
    return <img alt={artifact.name} className="artifact-media artifact-image browser-artifact-media" loading="lazy" src={src} />;
  }
  if (kind === "audio") {
    return <audio aria-label={`Audio preview for ${artifact.name}`} className="artifact-media browser-artifact-media" controls preload="metadata" src={src} />;
  }
  return <video aria-label={`Video preview for ${artifact.name}`} className="artifact-media browser-artifact-media" controls preload="metadata" src={src} />;
}

export function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return <div className="empty">No artifacts logged for the selected run.</div>;
  return (
    <div className="artifact-browser">
      {artifacts.map((artifact) => (
        <article className="browser-row" key={artifact.id}>
          <div className="browser-icon"><ArtifactIcon type={artifact.type} /></div>
          <div className="browser-main">
            <strong>{artifact.name}</strong>
            <small>{safeArtifactUri(artifact.uri)}</small>
            <ArtifactBrowserPreview artifact={artifact} />
          </div>
          <span>{artifact.step === null ? "no step" : `step ${artifact.step}`}</span>
          <span>{formatBytes(artifact.size_bytes)}</span>
          {artifactCanUseDownloadRoute(artifact) ? (
            <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
          ) : (
            <button className="copy-button artifact-download unavailable" disabled title="Download unavailable for metadata-only artifacts" type="button">
              <Download size={13} /> Unavailable
            </button>
          )}
          <button className="copy-button" type="button" onClick={() => void copyText(artifact.id)}><Copy size={13} /> Copy ID</button>
        </article>
      ))}
    </div>
  );
}
