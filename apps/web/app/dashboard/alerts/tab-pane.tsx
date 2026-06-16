"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PageHead } from "../ui/page-head";
import { ApiClient, queryString } from "../../../src/api.js";
import { formatMetricValue } from "../../../src/charts.js";
import { formatNumber, metricGoalLabel } from "../../../src/state.js";
import { buildDatasetRows, metricTitle, shortMetricName } from "../../dashboard-models";
import type { AlertRow, DatasetRow, Overview, RunSummary } from "../../dashboard-types";

type Props = {
  alertRows: AlertRow[];
  metricKey: string;
  overview: Overview;
  onRefresh: () => void;
};

type Sev = "crit" | "warn" | "info";
type SevFilter = "all" | Sev;

// Rule kinds come from buildAlertRows ids (`<run>:<kind>` / `grouped:<kind>`).
const RULE_LABELS: Record<string, string> = {
  failed: "run-failed",
  running: "still-running",
  checkpoint: "no-checkpoint",
  metric: "missing-metric",
};

// INFO is informational (blue), never live-green — green stays reserved for
// live/best markers per the design language.
const SEV_PILL: Record<Sev, string> = { crit: "bad", warn: "warn", info: "info" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function alertKind(row: AlertRow) {
  return row.id.split(":")[1] ?? "";
}

export function alertSeverity(row: AlertRow): Sev {
  if (row.severity === "critical") return "crit";
  if (row.severity === "warning") return "warn";
  return "info";
}

export function alertRuleLabel(row: AlertRow) {
  return RULE_LABELS[alertKind(row)] ?? row.label;
}

// Titles are "<run name> failed" / "<run name> is still running" / etc; strip
// the known suffix so run names containing spaces survive intact. Grouped
// findings cover several runs, so the run cell stays empty for them.
export function alertRunName(row: AlertRow) {
  if (row.id.startsWith("grouped:")) return "—";
  const name = row.title.replace(/ failed$| is still running$| has no checkpoints$| is missing .*$/, "");
  return name && name !== row.title ? name : "—";
}

// buildAlertRows only embeds a formatted "Mon DD, HH:MM" stamp (failed /
// running findings); recover it for a relative "fired" label, else em-dash.
export function alertFiredLabel(row: AlertRow, now: number) {
  const match = row.detail.match(/([A-Z][a-z]{2}) (\d{2}), (\d{2}):(\d{2})$/);
  if (!match) return "—";
  const monthIndex = MONTHS.indexOf(match[1]);
  if (monthIndex < 0) return "—";
  const reference = new Date(now);
  let fired = new Date(reference.getFullYear(), monthIndex, Number(match[2]), Number(match[3]), Number(match[4]));
  // The stamp carries no year; a "future" stamp belongs to the previous year.
  if (fired.getTime() - now > 26 * 3600_000) {
    fired = new Date(reference.getFullYear() - 1, monthIndex, Number(match[2]), Number(match[3]), Number(match[4]));
  }
  const diffMs = now - fired.getTime();
  if (diffMs < 0) return "—";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Grouped rows fold N runs into one line ("12 runs have no checkpoints");
// weight the rule by that count so "most common rule" reflects reality.
function ruleWeight(row: AlertRow) {
  if (!row.id.startsWith("grouped:")) return 1;
  const match = row.title.match(/^(\d+) runs/);
  return match ? Number(match[1]) : 1;
}

export function AlertsTabPane({ alertRows, metricKey, overview, onRefresh }: Props) {
  const [sevFilter, setSevFilter] = useState<SevFilter>("all");
  const [datasetRows, setDatasetRows] = useState<DatasetRow[] | null>(null);
  const [datasetsVersion, setDatasetsVersion] = useState(0);
  const now = Date.now();

  // Datasets reuse the run directory the dashboard already exposes — same
  // client API, same project filter as the page URL, no new endpoints.
  useEffect(() => {
    const controller = new AbortController();
    const api = new ApiClient();
    const project = new URLSearchParams(window.location.search).get("project") ?? "";
    let cancelled = false;
    (async () => {
      try {
        const payload = (await api.get(
          `/api/runs/summary${queryString({ project, limit: 100 })}`,
          { signal: controller.signal },
        )) as { runs?: RunSummary[] };
        if (!cancelled) setDatasetRows(buildDatasetRows(payload.runs ?? [], metricKey));
      } catch {
        // Transient API failures keep the last good rows; only an initial
        // failure falls through to the explicit empty state.
        if (!cancelled) setDatasetRows((current) => current ?? []);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [metricKey, datasetsVersion]);

  const critCount = alertRows.filter((row) => alertSeverity(row) === "crit").length;
  const warnCount = alertRows.filter((row) => alertSeverity(row) === "warn").length;

  const { ruleKindCount, topRule } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of alertRows) {
      const kind = alertKind(row);
      if (!kind) continue;
      counts.set(kind, (counts.get(kind) ?? 0) + ruleWeight(row));
    }
    let top = "";
    let best = 0;
    for (const [kind, count] of counts) {
      if (count > best) {
        top = kind;
        best = count;
      }
    }
    return { ruleKindCount: counts.size, topRule: top ? RULE_LABELS[top] ?? top : "" };
  }, [alertRows]);

  const filteredRows = sevFilter === "all" ? alertRows : alertRows.filter((row) => alertSeverity(row) === sevFilter);

  const healthPill = critCount ? "bad" : warnCount ? "warn" : "live";
  const healthLabel = critCount ? "firing" : warnCount ? "degraded" : "nominal";

  const refresh = () => {
    onRefresh();
    setDatasetsVersion((version) => version + 1);
  };

  return (
    <>
      <PageHead eyebrow="Workspace" title="Run health" />

      <div className="hp-grid">
        <section className="hp-panel hp-col-3">
          <div className="hp-panel-head"><span className="hp-mlabel">Open alerts</span></div>
          <div className="hp-panel-body hp-stat">
            <span className="hp-stat-value">
              <span className={critCount ? "hp-crit" : ""}>{critCount}</span><small> crit</small> · <span className={warnCount ? "hp-warnc" : ""}>{warnCount}</span><small> warn</small>
            </span>
            <span className="hp-stat-delta">{formatNumber(alertRows.length, 0)} findings in view</span>
          </div>
        </section>
        <section className="hp-panel hp-col-3">
          <div className="hp-panel-head"><span className="hp-mlabel">Monitors</span></div>
          <div className="hp-panel-body hp-stat">
            <span className="hp-stat-value">{ruleKindCount}<small> rule kinds</small></span>
            <span className="hp-stat-delta">{topRule ? `most common: ${topRule}` : "no rules firing"}</span>
          </div>
        </section>
        <section className="hp-panel hp-col-3">
          <div className="hp-panel-head"><span className="hp-mlabel">Active runs</span></div>
          <div className="hp-panel-body hp-stat">
            <span className={`hp-stat-value${overview.active_runs ? " hp-live" : ""}`}>{formatNumber(overview.active_runs, 0)}</span>
            <span className="hp-stat-delta">of {formatNumber(overview.total_runs, 0)} runs in view</span>
          </div>
        </section>
        <section className="hp-panel hp-col-3">
          <div className="hp-panel-head"><span className="hp-mlabel">Failed runs</span></div>
          <div className="hp-panel-body hp-stat">
            <span className={`hp-stat-value${overview.failed_runs ? " hp-crit" : ""}`}>{formatNumber(overview.failed_runs, 0)}</span>
            <span className={`hp-stat-delta${overview.failed_runs ? " down" : ""}`}>
              {overview.failed_runs ? `${critCount} critical alerts open` : "none in view"}
            </span>
          </div>
        </section>
      </div>

      <div className="hp-grid">
        <section className="hp-panel hp-col-7">
          <div className="hp-panel-head">
            <span className="hp-mlabel">Alerts</span>
            <div className="hp-seg" role="group" aria-label="Severity filter">
              <button type="button" className={sevFilter === "all" ? "is-active" : ""} onClick={() => setSevFilter("all")}>All</button>
              <button type="button" className={sevFilter === "crit" ? "is-active" : ""} onClick={() => setSevFilter("crit")}>Crit</button>
              <button type="button" className={sevFilter === "warn" ? "is-active" : ""} onClick={() => setSevFilter("warn")}>Warn</button>
            </div>
            <button className="icon-button framed" type="button" aria-label="Refresh alerts" onClick={refresh}><RefreshCw size={14} /></button>
          </div>
          <div className="hp-panel-body hp-flush">
            {filteredRows.length ? (
              <table className="hp-dtable">
                <thead>
                  <tr>
                    <th>Sev</th>
                    <th>Alert</th>
                    <th>Run</th>
                    <th>Rule</th>
                    <th className="hp-right">Fired</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => {
                    const sev = alertSeverity(row);
                    return (
                      <tr key={row.id}>
                        <td><span className={`pill ${SEV_PILL[sev]}`}>{sev}</span></td>
                        <td className="hp-td-alert" title={row.detail}>{row.title}</td>
                        <td className="hp-td-dim">{alertRunName(row)}</td>
                        <td><span className="hp-tag">{alertRuleLabel(row)}</span></td>
                        <td className="hp-td-num hp-td-dim">{alertFiredLabel(row, now)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                {sevFilter === "all" ? "No alerts from the current run filters." : `No ${sevFilter === "crit" ? "critical" : "warning"} alerts in view.`}
              </div>
            )}
          </div>
        </section>

        {/* No grad-norm style monitors exist in the alert builder, so this
            stays the run-health detail panel (mockup chrome, no fake chart). */}
        <section className="hp-panel hp-col-5">
          <div className="hp-panel-head">
            <span className="hp-mlabel">Run health — {shortMetricName(metricKey)}</span>
            <span className={`pill ${healthPill}`}>{healthLabel}</span>
          </div>
          <div className="hp-panel-body">
            <dl className="hp-kv">
              <div>
                <dt>Metric points</dt>
                <dd>{formatNumber(overview.metric_points, 0)}</dd>
              </div>
              <div>
                <dt>{metricGoalLabel(metricKey)} {metricTitle(metricKey)}</dt>
                <dd>{formatMetricValue(overview.best_eval_return)}</dd>
              </div>
              <div>
                <dt>Total runs</dt>
                <dd>{formatNumber(overview.total_runs, 0)}</dd>
              </div>
              <div>
                <dt>Open findings</dt>
                <dd>{formatNumber(alertRows.length, 0)}</dd>
              </div>
            </dl>
            <p className="hp-note">No anomaly series attached to the open alerts.</p>
          </div>
        </section>
      </div>

      <div className="hp-grid">
        <section className="hp-panel hp-col-12">
          <div className="hp-panel-head">
            <span className="hp-mlabel">Datasets</span>
            <span className="hp-unit">{datasetRows === null ? "loading" : `${datasetRows.length} tracked`}</span>
          </div>
          <div className="hp-panel-body hp-flush">
            {datasetRows?.length ? (
              <table className="hp-dtable">
                <thead>
                  <tr>
                    <th>Dataset</th>
                    <th className="hp-right">Runs</th>
                    <th>Seeds</th>
                    <th className="hp-right">Best {shortMetricName(metricKey)}</th>
                  </tr>
                </thead>
                <tbody>
                  {datasetRows.map((row) => (
                    <tr key={row.name}>
                      <td className="hp-td-name">{row.name}</td>
                      <td className="hp-td-num">{formatNumber(row.runs, 0)}</td>
                      <td className="hp-td-dim">{row.seeds.join(", ") || "—"}</td>
                      <td className="hp-td-num">{formatNumber(row.best, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                {datasetRows === null ? "Loading dataset metadata..." : "No dataset or environment metadata found in the current run configs."}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
