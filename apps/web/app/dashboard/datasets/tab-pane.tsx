import { Database, Gauge } from "lucide-react";

import { MetricCard } from "../ui/metric-card";
import { DatasetTable } from "./dataset-table";
import { PageHead } from "../ui/page-head";
import { formatNumber } from "../../../src/state.js";
import type { DatasetRow } from "../../dashboard-types";

type Props = {
  datasetRows: DatasetRow[];
  metricKey: string;
  projectCount: number;
  runsInView: number;
};

export function DatasetsTabPane({ datasetRows, metricKey, projectCount, runsInView }: Props) {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Datasets" />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head"><h2><Database size={15} /> Config-derived Datasets <span>({datasetRows.length})</span></h2></div>
          <div className="panel-body">
            <DatasetTable rows={datasetRows} metricKey={metricKey} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Gauge size={15} /> Coverage</h2></div>
          <div className="panel-body insight-stack">
            <MetricCard label="Projects" value={formatNumber(projectCount, 0)} tone="neutral" />
            <MetricCard label="Runs in view" value={formatNumber(runsInView, 0)} tone="neutral" />
            <MetricCard label="Dataset keys" value={formatNumber(datasetRows.length, 0)} tone={datasetRows.length ? "good" : "neutral"} />
          </div>
        </section>
      </div>
    </>
  );
}
