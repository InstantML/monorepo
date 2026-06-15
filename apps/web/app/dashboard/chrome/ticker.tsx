// This file once hosted the telemetry "ticker" strip (the LIVE/PTS/clock bar),
// which was removed. Only the compact-count formatter survives — it's still used
// for the nav run-count badge.

// Compact count for dense mono chrome (1.8k, 1.24M) — matches the mock's
// formatting without inventing rates.
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const format = (scaled: number, suffix: string) => {
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${parseFloat(scaled.toFixed(digits))}${suffix}`;
  };
  if (value >= 1e9) return format(value / 1e9, "B");
  if (value >= 1e6) return format(value / 1e6, "M");
  if (value >= 1e3) return format(value / 1e3, "k");
  return String(Math.round(value));
}
