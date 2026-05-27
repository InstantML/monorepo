"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import type { MarkdownBlockData } from "./types";

type Props = {
  block: MarkdownBlockData;
  readOnly?: boolean;
  onChange?: (next: MarkdownBlockData) => void;
};

/**
 * Markdown-aware textarea. We deliberately do NOT pull in a markdown parser
 * for v1 — the renderer just preserves whitespace as <pre>. A real syntax-
 * highlighting editor + parser lands in v1.5 once we know which renderer
 * we're standardizing on.
 *
 * One-mode polish: the editor textarea uses the same monospace surface as
 * the renderer's <pre>, so there's no visual jump on focus.
 */
export function MarkdownBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return (
      <pre className="report-render__markdown" aria-label="Markdown block">
        {block.text}
      </pre>
    );
  }
  return <MarkdownEditor block={block} onChange={onChange} />;
}

function MarkdownEditor({
  block,
  onChange,
}: {
  block: MarkdownBlockData;
  onChange?: (next: MarkdownBlockData) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const autoSize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => {
    autoSize();
  }, [block.text, autoSize]);
  return (
    <textarea
      ref={ref}
      className="report-block__textarea report-block__textarea--markdown"
      rows={1}
      value={block.text}
      placeholder="# Heading…  (markdown)"
      onChange={(event) => onChange?.({ ...block, text: event.target.value })}
      onInput={autoSize}
      aria-label="Markdown content"
      spellCheck={false}
    />
  );
}
