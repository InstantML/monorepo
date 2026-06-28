"use client";

import { useEffect, useState } from "react";

export type DocsTocItem = { id: string; text: string; level: number };

/**
 * Mintlify-style "On this page" rail. Server passes the page's heading list;
 * this component adds scroll-spy so the active section highlights as you read.
 * It renders the full list with or without JS, so it degrades to a plain
 * anchor list if the observer never runs.
 */
export function DocsToc({ items }: { items: DocsTocItem[] }) {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((element): element is HTMLElement => Boolean(element));
    if (!headings.length) return undefined;

    // Highlight the heading nearest the top of the viewport. The bottom margin
    // pulls the activation line up to ~30% of the viewport so a section lights
    // up as its heading reaches the upper third, matching Mintlify's feel.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveId(visible[0].target.id);
          return;
        }
        // Nothing intersecting (scrolled past a long section): keep the last
        // heading above the fold active instead of clearing the highlight.
        const above = headings
          .filter((heading) => heading.getBoundingClientRect().top < 120)
          .at(-1);
        if (above) setActiveId(above.id);
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: [0, 1] },
    );
    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [items]);

  if (items.length < 2) return null;

  return (
    <nav className="docs-route-toc" aria-label="On this page">
      <span className="docs-route-toc-title">On this page</span>
      <ul className="docs-route-toc-list">
        {items.map((item) => (
          <li className={`docs-route-toc-item level-${item.level}`} key={item.id}>
            <a className={item.id === activeId ? "is-active" : ""} href={`#${item.id}`}>
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
