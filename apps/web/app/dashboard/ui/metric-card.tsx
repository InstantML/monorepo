"use client";

import type { Tone } from "../../dashboard-types";

export function MetricCard({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
