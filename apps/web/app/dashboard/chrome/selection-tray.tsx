"use client";

import { Download, GitCompare, X } from "lucide-react";

import { formatNumber } from "../../../src/state.js";

/**
 * Persistent run-selection tray. Renders only while a selection exists so the
 * dashboard never reserves dead space; large selections summarize instead of
 * listing names. Selection state itself lives in the shell (and the ?runs=
 * URL parameter) — this is purely chrome over it.
 */
export function SelectionTray({
  count,
  exportDisabled,
  exportTitle,
  onClear,
  onCompare,
  onExport,
  sampleNames,
}: {
  count: number;
  exportDisabled: boolean;
  exportTitle: string;
  onClear: () => void;
  onCompare: () => void;
  onExport: () => void;
  sampleNames: string[];
}) {
  if (count <= 0) return null;
  const sample = sampleNames.slice(0, 3).join(" · ");
  const overflow = count - Math.min(3, sampleNames.length);
  return (
    <div aria-label="Run selection actions" className="selection-tray" role="toolbar">
      <strong className="selection-tray-count">{formatNumber(count, 0)} selected</strong>
      <span className="selection-tray-names" title={sample}>
        {sample}
        {overflow > 0 ? ` · +${formatNumber(overflow, 0)} more` : ""}
      </span>
      <span className="selection-tray-spacer" />
      <button className="primary-button compact-button" onClick={onCompare} type="button">
        <GitCompare size={14} /> Compare {formatNumber(Math.min(count, 50), 0)}
      </button>
      <button
        aria-disabled={exportDisabled || undefined}
        className="secondary compact-button"
        onClick={() => { if (!exportDisabled) onExport(); }}
        title={exportTitle}
        type="button"
      >
        <Download size={14} /> Export CSV
      </button>
      <button className="ghost compact-button" onClick={onClear} type="button">
        <X size={14} /> Clear
      </button>
    </div>
  );
}
