"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { fetchBoundedText } from "../../../src/api.js";
import { artifactTextPreviewKind, formatJsonPreview, truncateTextPreview } from "../../../src/evidence.js";
import { artifactHasStoredBytes, safeArtifactMediaKind } from "../../dashboard-models";
import type { Artifact } from "../../dashboard-types";

// Read at most this many bytes from the download stream; previews are a
// glance, the Download button is the full file.
const PREVIEW_FETCH_BYTE_CAP = 16_384;

/**
 * AR4: inline csv/json/text artifact preview. Collapsed by default; the first
 * expand streams a bounded slice of the existing download route — no new
 * backend surface.
 */
export function ArtifactTextPreview({ artifact }: { artifact: Artifact }) {
  const kind = artifactTextPreviewKind(artifact);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; text: string; truncated: boolean }>({ status: "idle", text: "", truncated: false });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  // Media previews win; text preview needs stored bytes to have anything to show.
  if (!kind || safeArtifactMediaKind(artifact) || !artifactHasStoredBytes(artifact)) return null;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || state.status === "ready" || state.status === "loading") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading", text: "", truncated: false });
    fetchBoundedText(`/api/artifacts/${encodeURIComponent(artifact.id)}/download`, { signal: controller.signal, maxBytes: PREVIEW_FETCH_BYTE_CAP })
      .then(({ text, capped }: { text: string; capped: boolean }) => {
        const pretty = kind === "json" && !capped ? formatJsonPreview(text) : null;
        const clipped = truncateTextPreview(pretty ?? text);
        setState({ status: "ready", text: clipped.text, truncated: capped || clipped.truncated });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        void error;
        setState({ status: "error", text: "", truncated: false });
      });
  }

  return (
    <div className="artifact-text-preview-block">
      <button
        aria-expanded={open}
        className="artifact-text-preview-toggle"
        onClick={toggle}
        title={open ? "Hide the inline preview" : `Preview the first lines of this ${kind} file`}
        type="button"
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {open ? "Hide preview" : "Preview"}
      </button>
      {open ? (
        state.status === "loading" || state.status === "idle" ? (
          <div className="artifact-text-preview is-loading">Loading preview...</div>
        ) : state.status === "error" ? (
          <div className="artifact-text-preview is-error">Preview unavailable — download the file instead.</div>
        ) : (
          <>
            <pre className="artifact-text-preview" tabIndex={0}>{state.text || "(empty file)"}</pre>
            {state.truncated ? <small className="artifact-text-preview-note">Showing the beginning of the file — use Download for the rest.</small> : null}
          </>
        )
      ) : null}
    </div>
  );
}
