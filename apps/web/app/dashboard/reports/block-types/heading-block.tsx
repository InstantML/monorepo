"use client";

import type { HeadingBlockData, HeadingLevel } from "./types";
import { SUPPORTED_HEADING_LEVELS } from "./types";

type Props = {
  block: HeadingBlockData;
  readOnly?: boolean;
  onChange?: (next: HeadingBlockData) => void;
};

export function HeadingBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return renderHeading(block);
  }
  return (
    <div className="report-block report-block--heading">
      <div className="report-block__controls">
        <label className="report-block__label">Heading level</label>
        <select
          className="report-block__select"
          value={block.level}
          onChange={(event) => {
            const level = Number(event.target.value) as HeadingLevel;
            onChange?.({ ...block, level });
          }}
        >
          {SUPPORTED_HEADING_LEVELS.map((level) => (
            <option key={level} value={level}>
              H{level}
            </option>
          ))}
        </select>
      </div>
      <input
        className="report-block__input report-block__input--heading"
        value={block.text}
        placeholder="Section heading"
        onChange={(event) => onChange?.({ ...block, text: event.target.value })}
        aria-label="Heading text"
      />
    </div>
  );
}

function renderHeading(block: HeadingBlockData) {
  if (block.level === 1) {
    return <h1 className="report-render__h1">{block.text}</h1>;
  }
  if (block.level === 2) {
    return <h2 className="report-render__h2">{block.text}</h2>;
  }
  return <h3 className="report-render__h3">{block.text}</h3>;
}
