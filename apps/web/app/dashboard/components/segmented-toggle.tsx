"use client";

import type { ComponentType, CSSProperties, ReactNode } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Optional leading icon (e.g. a lucide-react icon component). */
  icon?: ComponentType<{ size?: number }>;
  /** Optional native tooltip / hover hint for the option. */
  title?: string;
};

/**
 * A segmented toggle with a single highlight that slides between options
 * instead of the active background snapping on. The thumb is a `::before`
 * pseudo-element sized to `1 / count` of the track and translated by the
 * active index — both fed in as the `--seg-count` / `--seg-active` custom
 * properties below, so the same CSS handles any number of segments.
 *
 * Pass a `className` for surface-specific layout (width, alignment); the
 * shared look lives on `.iml-segmented` in segmented.css.
 */
export function SegmentedToggle<T extends string>({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
}) {
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      aria-label={ariaLabel}
      className={className ? `iml-segmented ${className}` : "iml-segmented"}
      role="group"
      style={{ "--seg-count": options.length, "--seg-active": activeIndex } as CSSProperties}
    >
      {options.map(({ value: optionValue, label, icon: Icon, title }) => (
        <button
          aria-pressed={value === optionValue}
          className="iml-segmented__option"
          key={optionValue}
          onClick={() => onChange(optionValue)}
          title={title}
          type="button"
        >
          {Icon ? <Icon size={14} /> : null}
          {label}
        </button>
      ))}
    </div>
  );
}
