"use client";

import type { ReportRow } from "../../dashboard-types";

/**
 * List of locally-saved workspace views. (The Notion-style Reports feature
 * lives under `reports-tab-pane.tsx`; this surface is the legacy
 * saved-views index.)
 */
export function SavedViewsList({ rows }: { rows: ReportRow[] }) {
  if (!rows.length) return <div className="empty">No local saved views yet.</div>;
  return (
    <div className="event-list">
      {rows.map((row) => (
        <article className="event-row neutral" key={row.id}>
          <span className="event-marker" />
          <div>
            <strong>{row.name}</strong>
            <small>{row.scope}</small>
          </div>
          <span className="pill live">local</span>
        </article>
      ))}
    </div>
  );
}
