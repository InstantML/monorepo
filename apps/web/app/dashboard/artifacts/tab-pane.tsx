import { Archive, Package } from "lucide-react";

import { ArtifactBrowser } from "./artifact-browser";
import { MetricCard } from "../ui/metric-card";
import { RichObjectPanel } from "../detail/rich-object-panel";
import { PageHead } from "../ui/page-head";
import { formatNumber } from "../../../src/state.js";
import type { Artifact, LoggedObject, LoggedObjectRow, RunSummary } from "../../dashboard-types";

type ArtifactTotals = { file: number; checkpoint: number; rollout: number };

type Props = {
  artifactTotals: ArtifactTotals;
  loggedObjects: LoggedObject[];
  objectRowsById: Record<number, LoggedObjectRow[]>;
  primaryRun: RunSummary | null;
  visibleArtifacts: Artifact[];
};

export function ArtifactsTabPane({ artifactTotals, loggedObjects, objectRowsById, primaryRun, visibleArtifacts }: Props) {
  return (
    <>
      <PageHead eyebrow="Workspace" title="Artifacts" emphasis="and lineage" lede={`${visibleArtifacts.length} for ${primaryRun?.name ?? "inspected run"}`} />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head"><h2><Package size={15} /> Selected-run Artifacts <span>({visibleArtifacts.length})</span></h2></div>
          <div className="panel-body">
            <RichObjectPanel objects={loggedObjects} rowsByObjectId={objectRowsById} title="Logged Objects" />
            <ArtifactBrowser artifacts={visibleArtifacts} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Archive size={15} /> Artifact Totals</h2></div>
          <div className="panel-body insight-stack">
            <MetricCard label="Files" value={formatNumber(artifactTotals.file, 0)} tone="neutral" />
            <MetricCard label="Checkpoints" value={formatNumber(artifactTotals.checkpoint, 0)} tone="good" />
            <MetricCard label="Rollouts" value={formatNumber(artifactTotals.rollout, 0)} tone="live" />
            <MetricCard label="Inspected run" value={primaryRun?.name ?? "-"} tone="neutral" />
          </div>
        </section>
      </div>
    </>
  );
}
