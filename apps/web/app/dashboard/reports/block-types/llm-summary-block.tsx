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
 * LLM summary block — the differentiator. Users pick a framing angle
 * ("what worked", "outliers", "config diffs that mattered", "what to try
 * next") and bind the block to a sibling PanelGrid by index. The block then
 * shows the model-generated paragraph plus a refresh button to re-run.
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
  if (readOnly) {
    return (
      <aside className="report-render__llm">
        <header className="report-render__llm-head">
          <Sparkles size={14} aria-hidden="true" />
          <span>LLM summary · {angleLabel(block.angle)}</span>
        </header>
        {text ? (
          <p className="report-render__llm-text">{text}</p>
        ) : (
          <p className="report-render__llm-empty">
            No summary generated yet. The block will populate the first time the report owner
            refreshes it.
          </p>
        )}
        {generatedAt ? (
          <footer className="report-render__llm-footer">
            Generated {new Date(generatedAt).toLocaleString()}
            {block.provider ? ` · ${block.provider}` : null}
          </footer>
        ) : null}
      </aside>
    );
  }
  return (
    <div className="report-block report-block--llm-summary">
      <header className="report-block__section-head">
        <h4>
          <Sparkles size={14} aria-hidden="true" /> LLM summary
        </h4>
        {onRefresh ? (
          <button
            type="button"
            className="report-block__action"
            onClick={onRefresh}
            disabled={busy}
            aria-label="Refresh LLM summary"
          >
            {busy ? "Refreshing..." : "Refresh"}
          </button>
        ) : null}
      </header>
      <label className="report-block__label">Angle</label>
      <select
        className="report-block__select"
        value={block.angle}
        onChange={(event) =>
          onChange?.({ ...block, angle: event.target.value as LlmSummaryAngle })
        }
      >
        {SUPPORTED_LLM_ANGLES.map((angle) => (
          <option key={angle} value={angle}>
            {angleLabel(angle)}
          </option>
        ))}
      </select>
      <label className="report-block__label">
        Bind to PanelGrid at block index
      </label>
      <input
        className="report-block__input report-block__input--narrow"
        type="number"
        min={0}
        value={block.panelgrid_index}
        onChange={(event) =>
          onChange?.({ ...block, panelgrid_index: Number(event.target.value) })
        }
        aria-label="PanelGrid index"
      />
      {block.angle === "free-form" ? (
        <>
          <label className="report-block__label">Custom prompt</label>
          <textarea
            className="report-block__textarea"
            rows={3}
            value={block.custom_prompt ?? ""}
            placeholder="What should the model focus on?"
            onChange={(event) =>
              onChange?.({ ...block, custom_prompt: event.target.value })
            }
            aria-label="Custom prompt"
          />
        </>
      ) : null}
      <div className="report-block__preview">
        <span className="report-block__hint">Latest summary</span>
        <p className="report-block__preview-text">
          {text || "No summary generated yet — click Refresh."}
        </p>
        {generatedAt ? (
          <small className="report-block__hint">
            Generated {new Date(generatedAt).toLocaleString()}
            {block.provider ? ` · ${block.provider}` : null}
          </small>
        ) : null}
      </div>
    </div>
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
