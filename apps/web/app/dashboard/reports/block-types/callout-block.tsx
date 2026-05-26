"use client";

import type { CalloutBlockData, CalloutVariant } from "./types";
import { SUPPORTED_CALLOUT_VARIANTS } from "./types";

type Props = {
  block: CalloutBlockData;
  readOnly?: boolean;
  onChange?: (next: CalloutBlockData) => void;
};

export function CalloutBlock({ block, readOnly = false, onChange }: Props) {
  const variantLabel = block.variant.charAt(0).toUpperCase() + block.variant.slice(1);
  if (readOnly) {
    return (
      <div className={`report-render__callout report-render__callout--${block.variant}`}>
        <strong className="report-render__callout-label">{variantLabel}</strong>
        <span className="report-render__callout-text">{block.text}</span>
      </div>
    );
  }
  return (
    <div className="report-block report-block--callout">
      <div className="report-block__controls">
        <label className="report-block__label">Variant</label>
        <select
          className="report-block__select"
          value={block.variant}
          onChange={(event) =>
            onChange?.({ ...block, variant: event.target.value as CalloutVariant })
          }
        >
          {SUPPORTED_CALLOUT_VARIANTS.map((variant) => (
            <option key={variant} value={variant}>
              {variant}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="report-block__textarea"
        rows={2}
        value={block.text}
        placeholder="Callout text"
        onChange={(event) => onChange?.({ ...block, text: event.target.value })}
        aria-label="Callout text"
      />
    </div>
  );
}
