"use client";

import { Activity, Box, ChevronDown, ChevronUp, Copy, Download, FileText, Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import { groupArtifactsByName } from "../../../src/evidence.js";
import { artifactHasStoredBytes, formatBytes, safeArtifactMediaKind, safeArtifactUri } from "../../dashboard-models";
import type { Artifact } from "../../dashboard-types";

const REFERENCE_ONLY_HELP = "Reference-only artifact: file bytes were not uploaded, so only the URI and metadata are stored. There is nothing to download.";

type ArtifactNameGroup = { name: string; latest: Artifact; older: Artifact[]; count: number };

function artifactCanUseDownloadRoute(artifact: Artifact) {
  return artifactHasStoredBytes(artifact);
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

async function copyText(value: string) {
  if (!value) return false;
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Visible IDs/snippets remain selectable when clipboard permission is denied.
    return false;
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

function ArtifactRow({
  artifact,
  copiedKey,
  expanded = false,
  olderCount = 0,
  olderVersion = false,
  onCopy,
  onToggleVersions,
}: {
  artifact: Artifact;
  copiedKey: string;
  expanded?: boolean;
  olderCount?: number;
  olderVersion?: boolean;
  onCopy: (kind: "id" | "uri", artifact: Artifact) => Promise<void>;
  onToggleVersions?: () => void;
}) {
  const hasStoredBytes = artifactCanUseDownloadRoute(artifact);
  const rowClass = ["browser-row", hasStoredBytes ? "" : "reference-only", olderVersion ? "older-version" : ""].filter(Boolean).join(" ");
  return (
    <article className={rowClass}>
      <div className="browser-icon"><ArtifactIcon type={artifact.type} /></div>
      <div className="browser-main">
        <span className="browser-name">
          <strong>{artifact.name}</strong>
          {hasStoredBytes ? null : <span className="artifact-reference-chip" title={REFERENCE_ONLY_HELP}>reference only</span>}
          {onToggleVersions ? (
            <button
              aria-expanded={expanded}
              className="artifact-version-count-chip"
              title={expanded ? "Hide older entries with this name" : "Show older entries with this name"}
              type="button"
              onClick={onToggleVersions}
            >
              {olderCount + 1} versions {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          ) : null}
        </span>
        <small title={artifact.uri}>{safeArtifactUri(artifact.uri)}</small>
        <ArtifactBrowserPreview artifact={artifact} />
      </div>
      <span>{artifact.step === null ? "no step" : `step ${artifact.step}`}</span>
      <span>{formatBytes(artifact.size_bytes)}</span>
      {hasStoredBytes ? (
        <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
      ) : (
        <span
          aria-label={REFERENCE_ONLY_HELP}
          className="copy-button artifact-download unavailable"
          role="status"
          title={REFERENCE_ONLY_HELP}
        >
          <Download size={13} /> Metadata only
        </span>
      )}
      <button
        aria-live="polite"
        className="copy-button"
        title={copiedKey === `uri:${artifact.id}` ? "Copied artifact URI" : `Copy URI: ${artifact.uri}`}
        type="button"
        onClick={() => void onCopy("uri", artifact)}
      >
        <Link2 size={13} /> {copiedKey === `uri:${artifact.id}` ? "Copied" : "Copy URI"}
      </button>
      <button
        aria-live="polite"
        className="copy-button"
        title={copiedKey === `id:${artifact.id}` ? "Copied artifact ID" : "Copy artifact ID"}
        type="button"
        onClick={() => void onCopy("id", artifact)}
      >
        <Copy size={13} /> {copiedKey === `id:${artifact.id}` ? "Copied" : "Copy ID"}
      </button>
    </article>
  );
}

export function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  const [copiedKey, setCopiedKey] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!copiedKey) return undefined;
    const timer = window.setTimeout(() => setCopiedKey(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  async function handleCopy(kind: "id" | "uri", artifact: Artifact) {
    const value = kind === "id" ? artifact.id : artifact.uri;
    if (await copyText(value)) setCopiedKey(`${kind}:${artifact.id}`);
  }

  if (!artifacts.length) return <div className="empty">No artifacts logged for the selected run.</div>;
  const groups = groupArtifactsByName(artifacts) as ArtifactNameGroup[];
  return (
    <div className="artifact-browser">
      {groups.map((group) => {
        const expanded = Boolean(expandedGroups[group.name]);
        return (
          <div className="artifact-name-group" key={group.latest.id}>
            <ArtifactRow
              artifact={group.latest}
              copiedKey={copiedKey}
              expanded={expanded}
              olderCount={group.older.length}
              onCopy={handleCopy}
              onToggleVersions={group.older.length ? () => setExpandedGroups((current) => ({ ...current, [group.name]: !current[group.name] })) : undefined}
            />
            {expanded ? group.older.map((artifact) => (
              <ArtifactRow artifact={artifact} copiedKey={copiedKey} key={artifact.id} olderVersion onCopy={handleCopy} />
            )) : null}
          </div>
        );
      })}
    </div>
  );
}
