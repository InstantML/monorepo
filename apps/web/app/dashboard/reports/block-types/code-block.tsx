"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import type { CodeBlockData, CodeLanguage } from "./types";
import { SUPPORTED_CODE_LANGUAGES } from "./types";

type Props = {
  block: CodeBlockData;
  readOnly?: boolean;
  onChange?: (next: CodeBlockData) => void;
};

/**
 * One-mode code block. The editor uses the same `<pre>`-styled surface as
 * the renderer — same monospace font, same line-height, same background —
 * so focusing the block just shows a cursor. The language pill lives in
 * the corner; it only becomes interactive (a `<select>`) on hover/focus.
 */
export function CodeBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return (
      <pre className={`report-render__code language-${block.language}`}>
        <code>{block.code}</code>
      </pre>
    );
  }
  return <CodeEditor block={block} onChange={onChange} />;
}

function CodeEditor({
  block,
  onChange,
}: {
  block: CodeBlockData;
  onChange?: (next: CodeBlockData) => void;
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
  }, [block.code, autoSize]);
  return (
    <div className="report-block report-block--code report-block--inline">
      <div className="report-block__inline-pill report-block__inline-pill--code">
        <select
          className="report-block__select report-block__select--inline report-block__select--mono"
          value={block.language}
          onChange={(event) =>
            onChange?.({ ...block, language: event.target.value as CodeLanguage })
          }
          aria-label="Code language"
        >
          {SUPPORTED_CODE_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
      </div>
      <textarea
        ref={ref}
        className="report-block__textarea report-block__textarea--code"
        rows={1}
        value={block.code}
        placeholder="// code"
        onChange={(event) => onChange?.({ ...block, code: event.target.value })}
        onInput={autoSize}
        aria-label="Code"
        spellCheck={false}
      />
    </div>
  );
}
