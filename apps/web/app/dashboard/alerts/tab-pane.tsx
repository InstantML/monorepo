import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";

import { MetricCard } from "../ui/metric-card";
import { AlertList } from "./alert-list";
import { PageHead } from "../ui/page-head";
import { formatNumber, metricGoalLabel } from "../../../src/state.js";
import { shortMetricName } from "../../dashboard-models";
import type { AlertRow, Overview } from "../../dashboard-types";

type Props = {
  alertRows: AlertRow[];
  metricKey: string;
  overview: Overview;
  onRefresh: () => void;
};

export function AlertsTabPane({ alertRows, metricKey, overview, onRefresh }: Props) {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Alerts" emphasis="worth watching" lede={`${alertRows.length} active · run health`} />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head">
            <h2><AlertTriangle size={15} /> Alerts <span>({alertRows.length})</span></h2>
            <button className="icon-button framed" type="button" aria-label="Refresh alerts" onClick={onRefresh}><RefreshCw size={16} /></button>
          </div>
          <div className="panel-body">
            <AlertList rows={alertRows} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><ShieldCheck size={15} /> Run Health</h2></div>
          <div className="panel-body insight-stack">
            <MetricCard label="Failed runs" value={formatNumber(overview.failed_runs, 0)} tone={overview.failed_runs ? "bad" : "good"} />
            <MetricCard label="Active runs" value={formatNumber(overview.active_runs, 0)} tone={overview.active_runs ? "live" : "neutral"} />
            <MetricCard label="Metric points" value={formatNumber(overview.metric_points, 0)} tone="neutral" />
            <MetricCard label={`${metricGoalLabel(metricKey)} ${shortMetricName(metricKey)}`} value={formatNumber(overview.best_eval_return, 2)} tone="good" />
          </div>
        </section>
      </div>
    </>
  );
}
