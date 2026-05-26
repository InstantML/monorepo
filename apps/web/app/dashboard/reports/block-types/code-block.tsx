"use client";

import type { CodeBlockData, CodeLanguage } from "./types";
import { SUPPORTED_CODE_LANGUAGES } from "./types";

type Props = {
  block: CodeBlockData;
  readOnly?: boolean;
  onChange?: (next: CodeBlockData) => void;
};

export function CodeBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return (
      <pre className={`report-render__code language-${block.language}`}>
        <code>{block.code}</code>
      </pre>
    );
  }
  return (
    <div className="report-block report-block--code">
      <div className="report-block__controls">
        <label className="report-block__label">Language</label>
        <select
          className="report-block__select"
          value={block.language}
          onChange={(event) =>
            onChange?.({ ...block, language: event.target.value as CodeLanguage })
          }
        >
          {SUPPORTED_CODE_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="report-block__textarea report-block__textarea--mono"
        rows={Math.min(20, Math.max(4, block.code.split("\n").length + 1))}
        value={block.code}
        placeholder="// code"
        onChange={(event) => onChange?.({ ...block, code: event.target.value })}
        aria-label="Code"
        spellCheck={false}
      />
    </div>
  );
}
