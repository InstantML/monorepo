"use client";

import type { HeadingBlockData, HeadingLevel } from "./types";
import { SUPPORTED_HEADING_LEVELS } from "./types";

type Props = {
  block: HeadingBlockData;
  readOnly?: boolean;
  onChange?: (next: HeadingBlockData) => void;
};

/**
 * One-mode heading block. At rest the input is borderless and renders with
 * the exact same typography as the published heading. On focus a faint
 * accent ring + soft background appears; the level selector is exposed in a
 * small pill above the heading on hover/focus. When `readOnly` we render a
 * static H1/H2/H3 element (used by the public share view).
 */
export function HeadingBlock({ block, readOnly = false, onChange }: Props) {
  if (readOnly) {
    return renderHeading(block);
  }
  const headingClass =
    block.level === 1
      ? "report-block__heading-input report-block__heading-input--h1"
      : block.level === 2
        ? "report-block__heading-input report-block__heading-input--h2"
        : "report-block__heading-input report-block__heading-input--h3";
  return (
    <div className="report-block report-block--heading report-block--inline">
      <div className="report-block__heading-controls">
        <select
          className="report-block__select report-block__select--inline"
          value={block.level}
          onChange={(event) => {
            const level = Number(event.target.value) as HeadingLevel;
            onChange?.({ ...block, level });
          }}
          aria-label="Heading level"
        >
          {SUPPORTED_HEADING_LEVELS.map((level) => (
            <option key={level} value={level}>
              H{level}
            </option>
          ))}
        </select>
      </div>
      <input
        className={headingClass}
        value={block.text}
        placeholder={`Heading ${block.level}`}
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
