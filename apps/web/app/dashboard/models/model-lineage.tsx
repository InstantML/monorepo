"use client";

import { safeArtifactUri } from "../../dashboard-models";
import type { ModelRow } from "../../dashboard-types";

export function ModelLineage({ rows }: { rows: ModelRow[] }) {
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
