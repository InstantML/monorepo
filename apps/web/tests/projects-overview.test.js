import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROJECT_OVERVIEW_STATS_LIMIT,
  projectOverviewCard,
  relativeTimeLabel,
  shouldShowProjectsOverview,
  sortProjectOverviewCards,
} from "../src/projects-overview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(path.join(here, "..", relative), "utf8");

test("projectOverviewCard merges summary and overview payloads", () => {
  const card = projectOverviewCard("bandits", {
    metricKey: "eval/return_mean",
    summary: { total: 12, runs: [{ name: "ucb-seed3", status: "running", created_at: "2026-06-10T12:00:00Z" }] },
    overview: { overview: { total_runs: 12, active_runs: 2, failed_runs: 1, best_eval_return: 0.91234 } },
  });
  assert.equal(card.name, "bandits");
  assert.equal(card.runCount, 12);
  assert.equal(card.activeRuns, 2);
  assert.equal(card.failedRuns, 1);
  assert.equal(card.bestMetric, 0.91234);
  assert.equal(card.bestMetricLabel, "0.91234");
  assert.equal(card.latestRunName, "ucb-seed3");
  assert.equal(card.latestRunStatus, "running");
  assert.equal(card.lastActivityAt, "2026-06-10T12:00:00Z");
  assert.equal(card.statsLoaded, true);
});

test("projectOverviewCard degrades when fetches fail", () => {
  const bare = projectOverviewCard("orphan");
  assert.equal(bare.runCount, null);
  assert.equal(bare.bestMetric, null);
  assert.equal(bare.lastActivityAt, null);
  assert.equal(bare.statsLoaded, false);
  // Overview-only (summary failed): count falls back to overview totals.
  const overviewOnly = projectOverviewCard("partial", { overview: { overview: { total_runs: 4, active_runs: 0, failed_runs: 0 } } });
  assert.equal(overviewOnly.runCount, 4);
  assert.equal(overviewOnly.statsLoaded, true);
  assert.equal(overviewOnly.bestMetric, null, "non-numeric best metric stays null");
});

test("sortProjectOverviewCards orders by activity then name, stats-missing last", () => {
  const cards = [
    projectOverviewCard("zeta"),
    projectOverviewCard("old", { summary: { total: 1, runs: [{ created_at: "2026-06-01T00:00:00Z" }] } }),
    projectOverviewCard("new", { summary: { total: 1, runs: [{ created_at: "2026-06-10T00:00:00Z" }] } }),
    projectOverviewCard("alpha"),
  ];
  assert.deepEqual(sortProjectOverviewCards(cards).map((card) => card.name), ["new", "old", "alpha", "zeta"]);
});

test("relativeTimeLabel humanizes with an explicit clock", () => {
  const now = Date.parse("2026-06-11T12:00:00Z");
  assert.equal(relativeTimeLabel("2026-06-11T11:59:50Z", now), "just now");
  assert.equal(relativeTimeLabel("2026-06-11T11:30:00Z", now), "30m ago");
  assert.equal(relativeTimeLabel("2026-06-11T06:00:00Z", now), "6h ago");
  assert.equal(relativeTimeLabel("2026-06-10T10:00:00Z", now), "yesterday");
  assert.equal(relativeTimeLabel("2026-06-01T12:00:00Z", now), "10d ago");
  assert.equal(relativeTimeLabel(null, now), "");
  assert.equal(relativeTimeLabel("not-a-date", now), "");
});

test("shouldShowProjectsOverview only fires on the unscoped multi-project landing", () => {
  const base = { project: "", projects: ["a", "b"], query: "", status: "", browseAllRuns: false };
  assert.equal(shouldShowProjectsOverview(base), true);
  assert.equal(shouldShowProjectsOverview({ ...base, project: "a" }), false);
  assert.equal(shouldShowProjectsOverview({ ...base, query: "loss" }), false, "search deep links keep showing results");
  assert.equal(shouldShowProjectsOverview({ ...base, status: "running" }), false);
  assert.equal(shouldShowProjectsOverview({ ...base, browseAllRuns: true }), false);
  assert.equal(shouldShowProjectsOverview({ ...base, projects: ["solo"] }), false, "single-project orgs go straight to the workspace");
  assert.equal(shouldShowProjectsOverview({ ...base, projects: [] }), false);
});

test("stats fan-out is capped and the cap is disclosed", () => {
  assert.ok(PROJECT_OVERVIEW_STATS_LIMIT >= 8 && PROJECT_OVERVIEW_STATS_LIMIT <= 64);
  const component = readSource("app/dashboard/runs/projects-overview.tsx");
  assert.match(component, /PROJECT_OVERVIEW_STATS_LIMIT/);
  assert.match(component, /more listed without stats/);
});

test("Runs tab routes the unscoped landing to the overview and keeps the opt-out", () => {
  const tabPane = readSource("app/dashboard/runs/tab-pane.tsx");
  assert.match(tabPane, /shouldShowProjectsOverview\(\{ browseAllRuns, project, projects, query, status \}\)/);
  assert.match(tabPane, /onBrowseAllRuns=\{\(\) => setBrowseAllRuns\(true\)\}/);
  assert.match(tabPane, /setBrowseAllRuns\(false\);\s*onSelectProject\(name\);/);
  // The shell wires project selection to the canonical changeProject (URL +
  // preference persistence) rather than a second state path.
  const shell = readSource("app/dashboard/dashboard-shell.tsx");
  assert.match(shell, /onSelectProject=\{changeProject\}/);
});
