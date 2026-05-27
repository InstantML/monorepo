"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import type { ParagraphBlockData } from "./types";

type Props = {
  block: ParagraphBlockData;
  readOnly?: boolean;
  onChange?: (next: ParagraphBlockData) => void;
};

/**
 * One-mode paragraph block. The textarea is transparent and styled to match
 * the published paragraph; on focus a soft background + faint accent ring
 * appears. Height auto-grows to fit content so there's no visual jump
 * between "displaying" and "editing".
 */
export function ParagraphBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return <p className="report-render__paragraph">{block.text}</p>;
  }
  return <ParagraphEditor block={block} onChange={onChange} />;
}

function ParagraphEditor({
  block,
  onChange,
}: {
  block: ParagraphBlockData;
  onChange?: (next: ParagraphBlockData) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const autoSize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  // Resize whenever the controlled value changes (incl. initial mount).
  useLayoutEffect(() => {
    autoSize();
  }, [block.text, autoSize]);
  return (
    <textarea
      ref={ref}
      className="report-block__textarea report-block__textarea--paragraph"
      rows={1}
      value={block.text}
      placeholder="Type / for commands, or write a paragraph…"
      onChange={(event) => {
        onChange?.({ ...block, text: event.target.value });
      }}
      onInput={autoSize}
      aria-label="Paragraph text"
    />
  );
}
