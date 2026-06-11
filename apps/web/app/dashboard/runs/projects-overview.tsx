"use client";

import { ArrowRight, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiClient, isAbortError, queryString } from "../../../src/api.js";
import {
  PROJECT_OVERVIEW_STATS_LIMIT,
  projectOverviewCard,
  relativeTimeLabel,
  sortProjectOverviewCards,
} from "../../../src/projects-overview.js";
import { statusTone } from "../../../src/state.js";

type ProjectCard = ReturnType<typeof projectOverviewCard>;

/**
 * Explicit "All projects" overview (audit 3.1): one card per project with run
 * count, last activity, and best metric, replacing the mixed cross-project
 * workspace as the no-scope landing. Stats load per project and degrade to
 * name-only cards when a fetch fails.
 */
export function ProjectsOverview({
  metricKey,
  onBrowseAllRuns,
  onSelectProject,
  projects,
  totalRuns,
}: {
  metricKey: string;
  onBrowseAllRuns: () => void;
  onSelectProject: (project: string) => void;
  projects: string[];
  totalRuns: number;
}) {
  const api = useMemo(() => new ApiClient(), []);
  const [cards, setCards] = useState<ProjectCard[]>(() => projects.map((name) => projectOverviewCard(name)));
  const [statsLoading, setStatsLoading] = useState(true);
  const statsProjects = useMemo(() => projects.slice(0, PROJECT_OVERVIEW_STATS_LIMIT), [projects]);
  const skippedStats = projects.length - statsProjects.length;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setStatsLoading(true);
    setCards(projects.map((name) => projectOverviewCard(name)));
    Promise.all(statsProjects.map(async (name) => {
      const requestOptions = { signal: controller.signal };
      const [summary, overview] = await Promise.all([
        api.get(`/api/runs/summary${queryString({ project: name, limit: 1, sort_by: "created", metric_key: metricKey })}`, requestOptions)
          .catch((error: unknown) => { if (isAbortError(error)) throw error; return null; }),
        api.get(`/api/overview${queryString({ project: name, metric_key: metricKey })}`, requestOptions)
          .catch((error: unknown) => { if (isAbortError(error)) throw error; return null; }),
      ]);
      return projectOverviewCard(name, { summary, overview, metricKey });
    })).then((loaded) => {
      if (cancelled) return;
      const byName = new Map(loaded.map((card) => [card.name, card]));
      setCards(projects.map((name) => byName.get(name) ?? projectOverviewCard(name)));
      setStatsLoading(false);
    }).catch((error: unknown) => {
      if (cancelled || isAbortError(error)) return;
      setStatsLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, metricKey, projects, statsProjects]);

  const sortedCards = useMemo(() => sortProjectOverviewCards(cards), [cards]);

  return (
    <section className="projects-overview" aria-label="Projects overview">
      <div className="projects-overview-head">
        <div>
          <h2>Pick a project</h2>
          <p className="projects-overview-lede">
            {projects.length} projects · {totalRuns.toLocaleString()} runs. Charts and leaderboards make the most sense inside one project.
          </p>
        </div>
        <button className="secondary" onClick={onBrowseAllRuns} type="button">
          Browse all runs <ArrowRight size={14} />
        </button>
      </div>
      <div className="projects-overview-grid">
        {sortedCards.map((card) => (
          <button
            className="project-card"
            key={card.name}
            onClick={() => onSelectProject(card.name)}
            title={`Open the ${card.name} project`}
            type="button"
          >
            <span className="project-card-name"><FolderOpen aria-hidden size={15} /> {card.name}</span>
            <span className="project-card-stats">
              {card.runCount !== null ? (
                <>
                  <span className="project-card-stat"><b>{card.runCount.toLocaleString()}</b> runs</span>
                  {card.activeRuns ? <span className="project-card-stat is-active"><b>{card.activeRuns}</b> running</span> : null}
                  {card.failedRuns ? <span className="project-card-stat is-failed"><b>{card.failedRuns}</b> failed</span> : null}
                </>
              ) : (
                <span className="project-card-stat muted">{statsLoading ? "Loading stats..." : "Stats unavailable"}</span>
              )}
            </span>
            {card.bestMetric !== null ? (
              <span className="project-card-best" title={`Best ${card.metricKey} across the project`}>
                Best {card.metricKey}: <b>{card.bestMetricLabel}</b>
              </span>
            ) : null}
            <span className="project-card-activity">
              {card.lastActivityAt ? (
                <>
                  {card.latestRunStatus ? <span className={`pill ${statusTone(card.latestRunStatus)}`}>{card.latestRunStatus}</span> : null}
                  <span className="muted">
                    {card.latestRunName ? `${card.latestRunName} · ` : ""}{relativeTimeLabel(card.lastActivityAt)}
                  </span>
                </>
              ) : (
                <span className="muted">{card.statsLoaded ? "No runs yet" : ""}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {skippedStats > 0 ? (
        <p className="projects-overview-note" role="note">
          Stats loaded for the first {PROJECT_OVERVIEW_STATS_LIMIT} projects; {skippedStats} more listed without stats.
        </p>
      ) : null}
    </section>
  );
}
