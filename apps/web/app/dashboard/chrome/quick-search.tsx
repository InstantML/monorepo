"use client";

import { Search, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useFocusTrap } from "../ui/use-focus-trap";

type QuickSearchItem = {
  description: string;
  group: string;
  id: string;
  label: string;
  onSelect: () => void;
};

export function QuickSearchModal({
  activeIndex,
  items,
  onActiveIndex,
  onClose,
  onQuery,
  onSelect,
  query,
  returnFocusSelector,
}: {
  activeIndex: number;
  items: QuickSearchItem[];
  onActiveIndex: (index: number) => void;
  onClose: () => void;
  onQuery: (value: string) => void;
  onSelect: (item: QuickSearchItem) => void;
  query: string;
  returnFocusSelector?: string;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, "#quick-search-input", returnFocusSelector);
  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    const maxIndex = Math.max(0, items.length - 1);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onActiveIndex(Math.min(maxIndex, activeIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onActiveIndex(Math.max(0, activeIndex - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      onActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onActiveIndex(Math.max(0, items.length - 1));
    } else if (event.key === "Enter" && items[activeIndex]) {
      event.preventDefault();
      onSelect(items[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="workspace-modal command-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Quick search"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="command-card quick-search-card">
        <div className="quick-search-input">
          <Search size={18} />
          <input
            aria-label="Quick search"
            autoFocus
            id="quick-search-input"
            onChange={(event) => {
              onActiveIndex(0);
              onQuery(event.target.value);
            }}
            onKeyDown={handleKey}
            placeholder="Search tabs, runs, metrics, projects, views"
            type="search"
            value={query}
          />
          <button className="icon-button" type="button" aria-label="Close quick search" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="quick-search-results" role="listbox" aria-label="Quick search results">
          {items.length ? items.map((item, index) => (
            <button
              aria-selected={index === activeIndex}
              className={`quick-search-row ${index === activeIndex ? "active" : ""}`}
              key={item.id}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onActiveIndex(index)}
              role="option"
              type="button"
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <em>{item.group}</em>
            </button>
          )) : (
            <div className="empty compact-empty">No matches yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
