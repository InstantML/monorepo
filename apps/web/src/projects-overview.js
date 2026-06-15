import { formatMetricValue } from "./charts.js";

// Per-project stat fetches are capped so an org with hundreds of projects
// doesn't fan out hundreds of requests on first paint. The overview component
// says how many projects were skipped instead of capping silently.
export const PROJECT_OVERVIEW_STATS_LIMIT = 16;

/**
 * Compact "2m ago" / "yesterday" label with an explicit clock for testability.
 * @param {string | null | undefined} iso
 * @param {number} [nowMs]
 */
export function relativeTimeLabel(iso, nowMs = Date.now()) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.round((nowMs - then) / 1000));
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
  return `${Math.round(diffMo / 12)}y ago`;
}

/**
 * Build one project card model from the per-project `/api/runs/summary`
 * (limit 1, newest first) and `/api/overview` payloads. Either payload may be
 * missing (failed fetch) — the card degrades to name-only rather than hiding
 * the project.
 * @param {string} name
 * @param {{ summary?: any, overview?: any, metricKey?: string }} [sources]
 */
export function projectOverviewCard(name, { summary, overview, metricKey = "" } = {}) {
  const latestRun = summary?.runs?.[0] ?? null;
  const overviewStats = overview?.overview ?? null;
  const runCount = Number.isFinite(Number(summary?.total))
    ? Number(summary.total)
    : Number.isFinite(Number(overviewStats?.total_runs))
      ? Number(overviewStats.total_runs)
      : null;
  const best = Number(overviewStats?.best_eval_return);
  return {
    name,
    runCount,
    activeRuns: Number.isFinite(Number(overviewStats?.active_runs)) ? Number(overviewStats.active_runs) : 0,
    failedRuns: Number.isFinite(Number(overviewStats?.failed_runs)) ? Number(overviewStats.failed_runs) : 0,
    bestMetric: Number.isFinite(best) ? best : null,
    bestMetricLabel: Number.isFinite(best) ? formatMetricValue(best) : "",
    metricKey,
    lastActivityAt: latestRun?.created_at ?? null,
    latestRunName: latestRun?.name ?? "",
    latestRunStatus: latestRun?.status ?? "",
    statsLoaded: Boolean(summary || overview),
  };
}

/**
 * Most recently active projects first; projects without stats sink to the
 * bottom alphabetically so the grid stays scannable.
 * @param {Array<ReturnType<typeof projectOverviewCard>>} cards
 */
export function sortProjectOverviewCards(cards) {
  return [...cards].sort((a, b) => {
    const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : Number.NaN;
    const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : Number.NaN;
    const aHas = Number.isFinite(aTime);
    const bHas = Number.isFinite(bTime);
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The overview replaces the cross-project runs workspace only on the true
 * "no scope at all" landing: no project, several projects to choose from, and
 * no narrower filter (a search or status deep link must keep showing results).
 * @param {{ project?: string, projects?: string[], query?: string, status?: string, browseAllRuns?: boolean }} state
 */
export function shouldShowProjectsOverview({ project = "", projects = [], query = "", status = "", browseAllRuns = false } = {}) {
  return !project && !query && !status && !browseAllRuns && projects.length > 1;
}
