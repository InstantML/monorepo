"use client";

import type { Tone } from "../../dashboard-types";

// One line in a settings key/value list: sans label on the left, value on the
// right. The value carries tabular figures so numeric values stay aligned
// without needing a monospace face. An optional tone tints the value (e.g.
// the plan name, or a quota nearing its limit).
export function SettingRow({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      {/* Full value on hover; the column ellipsizes long values. */}
      <strong className={tone} title={value}>{value}</strong>
    </div>
  );
}
