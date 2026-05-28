"use client";

import { Sparkles } from "lucide-react";

import type { LlmSummaryAngle, LlmSummaryBlockData } from "./types";

type Props = {
  block: LlmSummaryBlockData;
  readOnly?: boolean;
};

/**
 * Legacy renderer for reports that already contain an llm_summary block.
 * New reports cannot create or refresh these blocks while the provider path
 * only returns placeholders.
 */
export function LlmSummaryBlock({
  block,
  readOnly = false,
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
        <span>Legacy summary · {angleLabel(block.angle)}</span>
      </header>
      {text ? (
        <p className="report-render__llm-text">{text}</p>
      ) : (
        <p className="report-render__llm-empty">
          {readOnly
            ? "No summary was generated before this block type was retired."
            : "This legacy AI summary block is no longer generated. Delete it or replace it with prose."}
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
