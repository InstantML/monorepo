"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, Loader2 } from "lucide-react";

import { formatRelativeSavedAt } from "./auto-save";

export type AutoSaveStatus =
  | { state: "idle" }
  | { state: "dirty" }
  | { state: "saving" }
  | { state: "saved"; at: number }
  | { state: "error"; message: string };

type Props = {
  status: AutoSaveStatus;
  onRetry?: () => void;
};

/**
 * Compact status pill rendered in the editor toolbar. Cycles between
 * Editing / Saving / Saved · {relative} / Save failed states. Polls the
 * clock on a 5s interval while in the "saved" state so the relative
 * timestamp stays fresh without busy-rendering the editor.
 */
export function AutoSavePill({ status, onRetry }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.state !== "saved") return undefined;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [status.state]);

  if (status.state === "dirty") {
    return (
      <span
        className="report-auto-save-pill report-auto-save-pill--dirty"
        role="status"
        aria-live="polite"
      >
        <Circle size={10} aria-hidden="true" />
        <span>Editing</span>
      </span>
    );
  }
  if (status.state === "saving") {
    return (
      <span
        className="report-auto-save-pill report-auto-save-pill--saving"
        role="status"
        aria-live="polite"
      >
        <Loader2 size={12} aria-hidden="true" className="spin" />
        <span>Saving…</span>
      </span>
    );
  }
  if (status.state === "saved") {
    return (
      <span
        className="report-auto-save-pill report-auto-save-pill--saved"
        role="status"
        aria-live="polite"
        title={new Date(status.at).toLocaleString()}
      >
        <Check size={12} aria-hidden="true" />
        <span>Saved · {formatRelativeSavedAt(now, status.at)}</span>
      </span>
    );
  }
  if (status.state === "error") {
    return (
      <span
        className="report-auto-save-pill report-auto-save-pill--error"
        role="alert"
        title={status.message}
      >
        <AlertTriangle size={12} aria-hidden="true" />
        <span>Save failed</span>
        {onRetry ? (
          <button
            type="button"
            className="report-auto-save-pill__retry"
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <span
      className="report-auto-save-pill report-auto-save-pill--idle"
      role="status"
      aria-live="polite"
    >
      <Check size={12} aria-hidden="true" />
      <span>All changes saved</span>
    </span>
  );
}
