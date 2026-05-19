"use client";

import type { IntegrationRow } from "../../dashboard-types";

export function IntegrationCard({ item }: { item: IntegrationRow }) {
  const Icon = item.icon;
  return (
    <article className="integration-card">
      <div className="integration-top">
        <span className="browser-icon"><Icon size={15} /></span>
        <span className={`pill ${item.tone}`}>{item.status}</span>
      </div>
      <strong>{item.name}</strong>
      <small>{item.detail}</small>
    </article>
  );
}
