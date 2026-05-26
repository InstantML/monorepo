"use client";

import type { MarkdownBlockData } from "./types";

type Props = {
  block: MarkdownBlockData;
  readOnly?: boolean;
  onChange?: (next: MarkdownBlockData) => void;
};

/**
 * Markdown-aware textarea. We deliberately do NOT pull in a markdown parser
 * for v1 — the renderer just preserves line breaks and bold/italic syntax
 * literally. A real syntax-highlighting editor + parser lands in v1.5 once
 * we know which renderer we're standardizing on.
 */
export function MarkdownBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return (
      <pre className="report-render__markdown" aria-label="Markdown block">
        {block.text}
      </pre>
    );
  }
  return (
    <div className="report-block report-block--markdown">
      <div className="report-block__hint">Markdown</div>
      <textarea
        className="report-block__textarea report-block__textarea--mono"
        rows={Math.min(20, Math.max(4, block.text.split("\n").length + 1))}
        value={block.text}
        placeholder="# Heading\n\nWrite markdown..."
        onChange={(event) => onChange?.({ ...block, text: event.target.value })}
        aria-label="Markdown content"
      />
    </div>
  );
}
