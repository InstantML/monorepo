"use client";

import { formatNumber } from "../../../src/state.js";

export function SeriesSummary({ summaries }: { summaries: Array<{ id: string; name: string; last: number | null }> }) {
  return (
    <div className="summary-list">
      <h3 className="subsection-title">Selected Series</h3>
      {summaries.map((item) => (
        <div className="summary-row" key={item.id}>
          <span>{item.name}</span>
          <strong>{formatNumber(item.last, 3)}</strong>
        </div>
      ))}
    </div>
  );
}
