"use client";

import type { AlertRow } from "../../dashboard-types";

export function AlertList({ rows }: { rows: AlertRow[] }) {
  if (!rows.length) return <div className="empty">No alerts from the current run filters.</div>;
  return (
    <div className="event-list">
      {rows.map((row) => (
        <article className={`event-row ${row.severity}`} key={row.id}>
          <span className="event-marker" />
          <div>
            <strong>{row.title}</strong>
            <small>{row.detail}</small>
          </div>
          <span className={`pill ${row.tone}`}>{row.label}</span>
        </article>
      ))}
    </div>
  );
}
