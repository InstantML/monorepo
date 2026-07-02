/**
 * Compact "edited 2m ago" / "created yesterday" style. ISO string in,
 * humanized string out. Used by the reports list, the editor toolbar, and
 * the agent tab's activity line.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1m ago";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 45) return `${diffMin}m ago`;
  if (diffMin < 90) return "1h ago";
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffHr < 36) return "yesterday";
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr}y ago`;
}
