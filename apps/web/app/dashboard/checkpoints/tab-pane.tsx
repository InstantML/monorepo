import { Box, Layers3 } from "lucide-react";

import { CheckpointContext } from "./checkpoint-context";
import { CheckpointLineage } from "./checkpoint-lineage";
import { PageHead } from "../ui/page-head";
import { formatNumber } from "../../../src/state.js";
import type { CheckpointRow, RunSummary } from "../../dashboard-types";

type Props = {
  checkpointRows: CheckpointRow[];
  primaryRun: RunSummary | null;
};

export function CheckpointsTabPane({ checkpointRows, primaryRun }: Props) {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Checkpoints" />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head"><h2><Box size={15} /> Checkpoint Lineage <span>({formatNumber(checkpointRows.length, 0)})</span></h2></div>
          <div className="panel-body">
            <CheckpointLineage rows={checkpointRows} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Layers3 size={15} /> Run Context</h2></div>
          <div className="panel-body"><CheckpointContext run={primaryRun} /></div>
        </section>
      </div>
    </>
  );
}
