"use client";

import { formatNumber } from "../../../src/state.js";
import { compactValue } from "../../dashboard-models";
import { SettingRow } from "../settings/setting-row";
import type { RunSummary } from "../../dashboard-types";

function InfoRows({ rows }: { rows: string[][] }) {
  return (
    <div className="settings-list">
      {rows.map(([label, value]) => <SettingRow label={label} value={value} key={label} />)}
    </div>
  );
}

export function ModelContext({ run }: { run: RunSummary | null }) {
  if (!run) return <div className="empty">No run selected.</div>;
  const rows = [
    ["Run", run.name],
    ["Algorithm", compactValue(run.config.algo ?? run.config.model ?? "-")],
    ["Environment", compactValue(run.config.env ?? run.config.dataset ?? "-")],
    ["Seed", compactValue(run.config.seed ?? "-")],
    ["Learning rate", compactValue(run.config.learning_rate ?? run.config.lr ?? "-")],
    ["Checkpoints", formatNumber(run.artifact_counts.checkpoint, 0)],
  ];
  return <InfoRows rows={rows} />;
}
