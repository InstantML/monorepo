"use client";

import { Activity, Box, Copy, Download, FileText } from "lucide-react";

import { formatBytes, safeArtifactUri } from "../../dashboard-models";
import type { Artifact } from "../../dashboard-types";

function artifactCanUseDownloadRoute(artifact: Artifact) {
  const uri = String(artifact.uri ?? "").toLowerCase();
  return Boolean(artifact.id) && !uri.startsWith("demo://") && !/^https?:\/\//.test(uri);
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function copyText(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

function ArtifactIcon({ type }: { type: string }) {
  if (type === "checkpoint") return <Box size={15} />;
  if (type === "rollout") return <Activity size={15} />;
  return <FileText size={15} />;
}

export function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return <div className="empty">No artifacts logged for the selected run.</div>;
  return (
    <div className="artifact-browser">
      {artifacts.map((artifact) => (
        <article className="browser-row" key={artifact.id}>
          <div className="browser-icon"><ArtifactIcon type={artifact.type} /></div>
          <div>
            <strong>{artifact.name}</strong>
            <small>{safeArtifactUri(artifact.uri)}</small>
          </div>
          <span>{artifact.step === null ? "no step" : `step ${artifact.step}`}</span>
          <span>{formatBytes(artifact.size_bytes)}</span>
          {artifactCanUseDownloadRoute(artifact) ? (
            <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
          ) : (
            <button className="copy-button artifact-download unavailable" disabled title="Download unavailable for metadata-only demo artifact" type="button">
              <Download size={13} /> Unavailable
            </button>
          )}
          <button className="copy-button" type="button" onClick={() => copyText(artifact.id)}><Copy size={13} /> Copy ID</button>
        </article>
      ))}
    </div>
  );
}
