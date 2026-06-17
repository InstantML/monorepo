import { Database } from "lucide-react";

import { DatasetTable } from "./dataset-table";
import { PageHead } from "../ui/page-head";
import type { DatasetRow } from "../../dashboard-types";

type Props = {
  datasetRows: DatasetRow[];
  metricKey: string;
};

export function DatasetsTabPane({ datasetRows, metricKey }: Props) {
  return (
    <>
      <PageHead title="Datasets" />
      <div className="tab-grid">
        <section className="panel">
          <div className="panel-head"><h2><Database size={15} /> Config-derived Datasets <span>({datasetRows.length})</span></h2></div>
          <div className="panel-body">
            <DatasetTable rows={datasetRows} metricKey={metricKey} />
          </div>
        </section>
      </div>
    </>
  );
}
