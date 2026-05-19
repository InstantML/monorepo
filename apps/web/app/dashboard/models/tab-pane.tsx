import { Box, Layers3 } from "lucide-react";

import { ModelContext } from "./model-context";
import { ModelLineage } from "./model-lineage";
import { PageHead } from "../ui/page-head";
import { formatNumber } from "../../../src/state.js";
import type { ModelRow, RunSummary } from "../../dashboard-types";

type Props = {
  modelRows: ModelRow[];
  primaryRun: RunSummary | null;
};

export function ModelsTabPane({ modelRows, primaryRun }: Props) {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Checkpoints" emphasis="and lineage" lede={`${modelRows.length} tracked · ${primaryRun?.name ?? "no run"}`} />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head"><h2><Box size={15} /> Checkpoint Lineage <span>({formatNumber(modelRows.length, 0)})</span></h2></div>
          <div className="panel-body">
            <ModelLineage rows={modelRows} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Layers3 size={15} /> Model Context</h2></div>
          <div className="panel-body"><ModelContext run={primaryRun} /></div>
        </section>
      </div>
    </>
  );
}
