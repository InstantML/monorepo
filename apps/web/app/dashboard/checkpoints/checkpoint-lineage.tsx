"use client";

import { safeArtifactUri } from "../../dashboard-models";
import type { CheckpointRow } from "../../dashboard-types";

export function CheckpointLineage({ rows }: { rows: CheckpointRow[] }) {
  if (!rows.length) return <div className="empty">No checkpoints logged for the selected run.</div>;
  return (
    <div className="timeline-list">
      {rows.map((row) => (
        <article className="timeline-row" key={row.id}>
          <span className="timeline-dot" />
          <div>
            <strong>{row.name}</strong>
            <small>{safeArtifactUri(row.uri)}</small>
          </div>
          <span>{row.step}</span>
          <span>{row.evalReturn}</span>
        </article>
      ))}
    </div>
  );
}
