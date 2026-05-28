"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

type DocsNavigation = Array<{
  tab: string;
  groups: Array<{
    group: string;
    pages: Array<{ path: string; title: string }>;
  }>;
}>;

type IndexEntry = {
  path: string;
  title: string;
  tab: string;
  group: string;
  haystack: string;
};

function buildIndex(navigation: DocsNavigation): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const tab of navigation) {
    for (const group of tab.groups) {
      for (const page of group.pages) {
        entries.push({
          path: page.path,
          title: page.title,
          tab: tab.tab,
          group: group.group,
          haystack: `${page.title} ${tab.tab} ${group.group}`.toLowerCase(),
        });
      }
    }
  }
  return entries;
}

// Score a match: prefer prefix matches on the title, then substring matches
// on the title, then matches anywhere in the haystack (group / tab name).
// Lower score = better match.
function scoreMatch(query: string, entry: IndexEntry): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  const title = entry.title.toLowerCase();
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (title.includes(q)) return 2;
  if (entry.haystack.includes(q)) return 3;
  return null;
}

function pageUrl(pagePath: string) {
  if (pagePath === "index") return "/docs";
  return `/docs/${pagePath}`;
}

const MAX_RESULTS = 8;

export function DocsSearch({ navigation }: { navigation: DocsNavigation }) {
  const index = useMemo(() => buildIndex(navigation), [navigation]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return [] as Array<IndexEntry & { score: number }>;
    const scored: Array<IndexEntry & { score: number }> = [];
    for (const entry of index) {
      const score = scoreMatch(query, entry);
      if (score !== null) scored.push({ ...entry, score });
    }
    scored.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
    return scored.slice(0, MAX_RESULTS);
  }, [query, index]);

  // `/` anywhere on the page focuses the search input (unless the user is
  // already typing in another input/textarea).
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: globalThis.PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Reset active row when results change.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[activeIndex];
      if (target) {
        window.location.href = pageUrl(target.path);
      }
    }
  }

  const showResults = open && query.trim().length > 0;
  const activeResultId = showResults && results[activeIndex] ? `docs-search-result-${activeIndex}` : undefined;

  return (
    <div className="docs-route-search" role="search" ref={rootRef}>
      <Search aria-hidden size={14} />
      <input
        ref={inputRef}
        type="search"
        placeholder="Search the docs"
        aria-label="Search the docs"
        aria-activedescendant={activeResultId}
        aria-autocomplete="list"
        aria-controls="docs-search-results"
        aria-expanded={showResults}
        aria-haspopup="listbox"
        autoComplete="off"
        role="combobox"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {!query ? <kbd className="docs-route-search-kbd">/</kbd> : null}
      {showResults ? (
        <div
          className="docs-route-search-results"
          id="docs-search-results"
          role="listbox"
          aria-label="Search results"
        >
          {results.length === 0 ? (
            <div className="docs-route-search-empty">No matches.</div>
          ) : (
            results.map((result, index) => (
              <Link
                className={
                  index === activeIndex
                    ? "docs-route-search-result is-active"
                    : "docs-route-search-result"
                }
                href={pageUrl(result.path)}
                id={`docs-search-result-${index}`}
                key={result.path}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => setOpen(false)}
              >
                <span className="docs-route-search-result-title">{result.title}</span>
                <span className="docs-route-search-result-meta">
                  {result.tab} · {result.group}
                </span>
              </Link>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
