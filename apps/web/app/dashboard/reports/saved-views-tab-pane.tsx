import { Activity, FileBarChart } from "lucide-react";

import { MetricCard } from "../ui/metric-card";
import { SavedViewsList } from "./saved-views-list";
import { PageHead } from "../ui/page-head";
import { formatNumber, metricGoalLabel } from "../../../src/state.js";
import { shortMetricName } from "../../dashboard-models";
import type { Overview, ReportRow } from "../../dashboard-types";

type Props = {
  metricKey: string;
  overview: Overview;
  reportRows: ReportRow[];
  selectedRunCount: number;
  totalRuns: number;
};

/**
 * Saved-views surface — kept under the legacy "reports" file path while the
 * new Reports feature ships under its own tab. The Reports nav entry now
 * points at `reports-tab-pane.tsx`; this component renders the Saved Views
 * tab content.
 */
export function SavedViewsTabPane({ metricKey, overview, reportRows, selectedRunCount, totalRuns }: Props) {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Saved views" lede={`${reportRows.length} local · ${shortMetricName(metricKey)}`} />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head"><h2><FileBarChart size={15} /> Local Saved Views <span>({reportRows.length})</span></h2></div>
          <div className="panel-body">
            <SavedViewsList rows={reportRows} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Activity size={15} /> Snapshot</h2></div>
          <div className="panel-body insight-stack">
            <MetricCard label="Runs" value={formatNumber(totalRuns, 0)} tone="neutral" />
            <MetricCard label="Selected" value={formatNumber(selectedRunCount, 0)} tone="live" />
            <MetricCard label="Metric" value={shortMetricName(metricKey)} tone="neutral" />
            <MetricCard label={`${metricGoalLabel(metricKey)} return`} value={formatNumber(overview.best_eval_return, 2)} tone="good" />
          </div>
        </section>
      </div>
    </>
  );
}
