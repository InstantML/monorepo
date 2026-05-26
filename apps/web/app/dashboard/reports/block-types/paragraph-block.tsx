"use client";

import type { ParagraphBlockData } from "./types";

type Props = {
  block: ParagraphBlockData;
  readOnly?: boolean;
  onChange?: (next: ParagraphBlockData) => void;
};

export function ParagraphBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return <p className="report-render__paragraph">{block.text}</p>;
  }
  return (
    <textarea
      className="report-block__textarea"
      rows={Math.min(8, Math.max(2, block.text.split("\n").length + 1))}
      value={block.text}
      placeholder="Type a paragraph..."
      onChange={(event) => onChange?.({ ...block, text: event.target.value })}
      aria-label="Paragraph text"
    />
  );
}
