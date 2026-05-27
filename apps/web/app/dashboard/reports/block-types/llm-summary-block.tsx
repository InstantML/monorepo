"use client";

import { Sparkles } from "lucide-react";

import type { LlmSummaryAngle, LlmSummaryBlockData } from "./types";
import { SUPPORTED_LLM_ANGLES } from "./types";

type Props = {
  block: LlmSummaryBlockData;
  readOnly?: boolean;
  busy?: boolean;
  onChange?: (next: LlmSummaryBlockData) => void;
  onRefresh?: () => void;
};

/**
 * One-mode LLM-summary block. Always renders the synthesized paragraph as
 * the primary surface (or an empty-state nudge if none yet); on hover the
 * angle / PanelGrid-index controls + refresh button surface. There's no
 * second "preview" pane — the rendered paragraph IS the preview.
 */
export function LlmSummaryBlock({
  block,
  readOnly = false,
  busy = false,
  onChange,
  onRefresh,
}: Props) {
  const generatedAt = block.generated_at;
  const text = block.generated_text ?? "";
  // The same surface is used in both modes; in readOnly we suppress the
  // editor chrome that would otherwise appear on hover/focus.
  return (
    <aside
      className={`report-render__llm${readOnly ? " report-render__llm--readonly" : ""}`}
    >
      <header className="report-render__llm-head">
        <Sparkles size={14} aria-hidden="true" />
        <span>LLM summary · {angleLabel(block.angle)}</span>
        {!readOnly ? (
          <div className="report-block__llm-controls">
            <select
              className="report-block__select report-block__select--inline"
              value={block.angle}
              onChange={(event) =>
                onChange?.({ ...block, angle: event.target.value as LlmSummaryAngle })
              }
              aria-label="LLM summary angle"
            >
              {SUPPORTED_LLM_ANGLES.map((angle) => (
                <option key={angle} value={angle}>
                  {angleLabel(angle)}
                </option>
              ))}
            </select>
            <label
              className="report-block__llm-grid-label"
              title="PanelGrid block index to summarize"
            >
              Grid #
              <input
                className="report-block__inline-input report-block__inline-input--num"
                type="number"
                min={0}
                value={block.panelgrid_index}
                onChange={(event) =>
                  onChange?.({ ...block, panelgrid_index: Number(event.target.value) })
                }
                aria-label="PanelGrid block index"
              />
            </label>
            {onRefresh ? (
              <button
                type="button"
                className="report-block__action report-block__action--secondary"
                onClick={onRefresh}
                disabled={busy}
                aria-label="Refresh LLM summary"
                title="Refresh"
              >
                {busy ? "Refreshing…" : "Refresh"}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {text ? (
        <p className="report-render__llm-text">{text}</p>
      ) : (
        <p className="report-render__llm-empty">
          {readOnly
            ? "No summary generated yet. The block will populate the first time the report owner refreshes it."
            : "Click Refresh to generate a summary from the bound PanelGrid."}
        </p>
      )}
      {!readOnly && block.angle === "free-form" ? (
        <textarea
          className="report-block__textarea report-block__textarea--inline-prompt"
          rows={2}
          value={block.custom_prompt ?? ""}
          placeholder="Custom prompt — what should the model focus on?"
          onChange={(event) =>
            onChange?.({ ...block, custom_prompt: event.target.value })
          }
          aria-label="Custom prompt"
        />
      ) : null}
      {generatedAt ? (
        <footer className="report-render__llm-footer">
          Generated {new Date(generatedAt).toLocaleString()}
          {block.provider ? ` · ${block.provider}` : null}
        </footer>
      ) : null}
    </aside>
  );
}

function angleLabel(angle: LlmSummaryAngle): string {
  switch (angle) {
    case "what-worked":
      return "What worked";
    case "outliers":
      return "Outliers";
    case "config-diffs":
      return "Config diffs that mattered";
    case "next-steps":
      return "What to try next";
    case "free-form":
      return "Free-form prompt";
  }
}
