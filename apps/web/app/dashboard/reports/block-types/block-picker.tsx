"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  FileText,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  LayoutGrid,
  Minus,
  Type,
} from "lucide-react";

import type { BlockPickerEntry } from "../slash-command";
import { BLOCK_PICKER_CATALOG, filterBlockPicker } from "../slash-command";

type Props = {
  /** Initial filter text. Defaults to empty. */
  initialQuery?: string;
  /** Notify the parent that the query changed (used by the slash menu so the editor can keep `/foo` in sync). */
  onQueryChange?: (next: string) => void;
  /** User picked an entry. */
  onPick: (id: string) => void;
  /** User pressed Escape or clicked outside. */
  onDismiss: () => void;
  /**
   * Anchor mode. `floating` positions the picker absolutely above its
   * mounting container at top:0 (caller positions the container); `inline`
   * renders as a regular flow element used inside the hover-line gap.
   */
  variant?: "floating" | "inline";
  /** Disable the internal input — relevant when the slash menu lives in the editor's text input. */
  showSearchInput?: boolean;
  /** Show full label and hint (default), or compact list. */
  compact?: boolean;
};

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  "heading-1": Heading1,
  "heading-2": Heading2,
  "heading-3": Heading3,
  paragraph: Type,
  markdown: Hash,
  code: Code2,
  callout: FileText,
  horizontal_rule: Minus,
  image: ImageIcon,
  panel_grid: LayoutGrid,
};

/**
 * block-based block-type picker. Shared component for two surfaces:
 *
 *   - Hover-line `+` button between blocks → `variant="inline"` mounts a
 *     small popover anchored to the gap.
 *   - Slash-command menu → `variant="floating"` mounts near the caret with
 *     the editor's textarea retaining focus; the picker reflects the
 *     filter text via `initialQuery` and listens for global Up/Down/Enter
 *     so the user never leaves the textarea.
 *
 * Keyboard contract:
 *   - ArrowUp / ArrowDown: move highlight (wraps)
 *   - Enter: pick highlighted entry
 *   - Escape: dismiss (Cmd+. on macOS also dismisses)
 *
 * When `showSearchInput` is true the picker owns the search input and
 * doesn't read the keyboard from `window`; when false the parent feeds
 * `initialQuery` and routes the keys via its own input.
 */
export function BlockPicker({
  initialQuery = "",
  onQueryChange,
  onPick,
  onDismiss,
  variant = "inline",
  showSearchInput = true,
  compact = false,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<HTMLButtonElement[]>([]);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const filtered = useMemo(
    () => filterBlockPicker(query, BLOCK_PICKER_CATALOG),
    [query],
  );

  // Clamp the highlight whenever the filtered list changes.
  useEffect(() => {
    if (filtered.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((current) => Math.min(current, filtered.length - 1));
  }, [filtered.length]);

  // Keep the active item visible inside the scrollable list.
  useEffect(() => {
    const node = itemsRef.current[activeIndex];
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, filtered.length]);

  // Dismiss on outside click (inline variant only; floating is dismissed by parent).
  useEffect(() => {
    if (variant !== "inline") return undefined;
    const handler = (event: MouseEvent) => {
      if (!ref.current) return;
      if (event.target instanceof Node && ref.current.contains(event.target)) return;
      onDismiss();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [variant, onDismiss]);

  // Keyboard handling for the inline picker. The floating variant defers to the
  // parent textarea's keydown handler (which calls `handleExternalKey`).
  useEffect(() => {
    if (variant !== "inline") return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      // Don't intercept when the user is typing in the picker's own search box.
      if (event.target instanceof HTMLInputElement && ref.current?.contains(event.target)) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((current) =>
            filtered.length === 0 ? 0 : (current + 1) % filtered.length,
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((current) =>
            filtered.length === 0
              ? 0
              : (current - 1 + filtered.length) % filtered.length,
          );
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const entry = filtered[activeIndex];
          if (entry) onPick(entry.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [variant, filtered, activeIndex, onPick, onDismiss]);

  const updateQuery = (next: string) => {
    setQuery(next);
    onQueryChange?.(next);
  };

  return (
    <div
      ref={ref}
      className={`block-picker block-picker--${variant}${compact ? " block-picker--compact" : ""}`}
      role="listbox"
      aria-label="Insert block"
    >
      {showSearchInput ? (
        <input
          autoFocus={variant === "inline"}
          className="block-picker__search"
          placeholder="Search blocks…"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          aria-label="Filter block types"
        />
      ) : null}
      <div className="block-picker__list">
        {filtered.length === 0 ? (
          <div className="block-picker__empty">No blocks match “{query}”</div>
        ) : (
          filtered.map((entry, index) => {
            const Icon = ICONS[entry.id];
            const active = index === activeIndex;
            return (
              <button
                key={entry.id}
                ref={(node) => {
                  if (node) itemsRef.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={active}
                className={`block-picker__row${active ? " block-picker__row--active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onPick(entry.id)}
              >
                <span className="block-picker__icon" aria-hidden="true">
                  {Icon ? <Icon size={16} /> : null}
                </span>
                <span className="block-picker__copy">
                  <span className="block-picker__label">{entry.label}</span>
                  {entry.hint ? (
                    <span className="block-picker__hint">{entry.hint}</span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Exposed for the editor's textarea-driven slash menu — lets the host
 * intercept Up/Down/Enter without juggling refs.
 */
export interface BlockPickerKeyHandler {
  /** Returns true when the key was handled and the host should preventDefault. */
  (event: { key: string }): boolean;
}

/**
 * Lightweight controller used by callers who want to drive the picker
 * imperatively. The slash-command menu uses this to forward keys from the
 * editor's textarea.
 */
export interface BlockPickerController {
  query: string;
  setQuery: (next: string) => void;
  filtered: BlockPickerEntry[];
  activeIndex: number;
  setActiveIndex: (next: number) => void;
  pick: (id: string) => void;
  cancel: () => void;
}

export type { BlockPickerEntry };
