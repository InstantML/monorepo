"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import type { CalloutBlockData, CalloutVariant } from "./types";
import { SUPPORTED_CALLOUT_VARIANTS } from "./types";

type Props = {
  block: CalloutBlockData;
  readOnly?: boolean;
  onChange?: (next: CalloutBlockData) => void;
};

/**
 * One-mode callout. The container always renders with the
 * `report-render__callout` styling — colored left border, soft tint,
 * variant label pill in the corner. On focus the body becomes an editable
 * textarea, same font, same color; on hover the variant pill becomes a
 * native select.
 */
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
    <CalloutEditor
      block={block}
      onChange={onChange}
      variantLabel={variantLabel}
    />
  );
}

function CalloutEditor({
  block,
  onChange,
  variantLabel,
}: {
  block: CalloutBlockData;
  onChange?: (next: CalloutBlockData) => void;
  variantLabel: string;
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
    <div
      className={`report-render__callout report-render__callout--${block.variant} report-block--callout-edit`}
    >
      <span className="report-block__callout-variant-pill" aria-hidden="true">
        <select
          className="report-block__select report-block__select--inline"
          value={block.variant}
          onChange={(event) =>
            onChange?.({ ...block, variant: event.target.value as CalloutVariant })
          }
          aria-label="Callout variant"
          title={variantLabel}
        >
          {SUPPORTED_CALLOUT_VARIANTS.map((variant) => (
            <option key={variant} value={variant}>
              {variant}
            </option>
          ))}
        </select>
      </span>
      <textarea
        ref={ref}
        className="report-block__textarea report-block__textarea--callout"
        rows={1}
        value={block.text}
        placeholder="Callout text"
        onChange={(event) => onChange?.({ ...block, text: event.target.value })}
        onInput={autoSize}
        aria-label="Callout text"
      />
    </div>
  );
}
