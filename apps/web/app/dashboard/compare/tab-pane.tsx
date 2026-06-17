import { Download, GitCompare, Plus, X } from "lucide-react";

import { CustomSelect } from "../ui/select";
import { SideBySide } from "./side-by-side";
import { metricTitle, COMPARE_RUN_LIMIT } from "../../dashboard-models";
import { metricGoalLabel } from "../../../src/state.js";
import type { Artifact, RunSummary } from "../../dashboard-types";

type Props = {
  addAllCompareTableMetrics: () => void;
  addCompareTableMetric: (metric: string) => void;
  compareAddMetricOptions: string[];
  compareArtifactsByRun: Record<string, Artifact[]>;
  compareOverflowCount: number;
  compareRuns: RunSummary[];
  compareTableMetricKeys: string[];
  diffOnly: boolean;
  exportSelectedBusy: boolean;
  MAX_COMPARE_TABLE_METRICS: number;
  metricKey: string;
  metricOptionsForControls: string[];
  onChangeMetricKeyAndSortKey: (value: string) => void;
  onClearSelection: () => void;
  onDiffOnly: (checked: boolean) => void;
  onExportSelectedRuns: () => void;
  onOpenRunArtifacts: (runId: string) => void;
  onReferenceRunId: (id: string) => void;
  onResetCompareTableMetrics: () => void;
  referenceRun: RunSummary | null;
  removeCompareTableMetric: (metric: string) => void;
  selectedRunExportDisabled: boolean;
  selectedRunExportTitle: string;
  sideBySide: any;
};

// Embedded comparison panel that lives at the top of the Runs → Table view.
// Selecting runs in the table below drives this directly, so there is no
// separate Compare page or selection toast: pick a set, see it compared.
export function CompareView({
  addAllCompareTableMetrics,
  addCompareTableMetric,
  compareAddMetricOptions,
  compareArtifactsByRun,
  compareOverflowCount,
  compareRuns,
  compareTableMetricKeys,
  diffOnly,
  exportSelectedBusy,
  MAX_COMPARE_TABLE_METRICS,
  metricKey,
  metricOptionsForControls,
  onChangeMetricKeyAndSortKey,
  onClearSelection,
  onDiffOnly,
  onExportSelectedRuns,
  onOpenRunArtifacts,
  onReferenceRunId,
  onResetCompareTableMetrics,
  referenceRun,
  removeCompareTableMetric,
  selectedRunExportDisabled,
  selectedRunExportTitle,
  sideBySide,
}: Props) {
  // Comparison needs at least two runs. With zero or one selected, show a quiet
  // prompt instead of an empty table so the table below stays the focus.
  if (compareRuns.length < 2) {
    return (
      <div className="compare-embed-prompt">
        <GitCompare size={15} aria-hidden />
        <span>
          {compareRuns.length === 1
            ? "Select one more run below to compare it side by side."
            : "Select runs with the checkboxes below to compare them side by side."}
        </span>
      </div>
    );
  }

  const canAddMetric = Boolean(compareAddMetricOptions.length) && compareTableMetricKeys.length < MAX_COMPARE_TABLE_METRICS;

  return (
    <section className="compare-embed" aria-label="Compare selected runs">
      <header className="compare-embed-head">
        <div className="compare-embed-title">
          <h3>Comparing {compareRuns.length} runs</h3>
          <p>
            {metricTitle(metricKey)} · {metricGoalLabel(metricKey)} objective
            {compareOverflowCount ? ` · ${compareOverflowCount} more selected beyond the first ${COMPARE_RUN_LIMIT}` : ""}
          </p>
        </div>
        <div className="compare-embed-actions">
          <CustomSelect
            id="reference-run"
            label="Reference"
            onChange={onReferenceRunId}
            options={compareRuns.map((run) => ({ value: run.id, label: run.name }))}
            value={referenceRun?.id ?? ""}
          />
          <button
            aria-disabled={selectedRunExportDisabled || undefined}
            className="secondary compact-button"
            disabled={selectedRunExportDisabled || exportSelectedBusy}
            onClick={onExportSelectedRuns}
            title={selectedRunExportTitle}
            type="button"
          >
            <Download size={14} /> {exportSelectedBusy ? "Exporting" : "Export CSV"}
          </button>
          <button className="ghost compact-button" onClick={onClearSelection} type="button">
            <X size={14} /> Clear
          </button>
        </div>
      </header>
      <div className="compare-embed-controls">
        <CustomSelect
          id="compare-metric"
          label="Metric"
          onChange={onChangeMetricKeyAndSortKey}
          options={metricOptionsForControls.length ? metricOptionsForControls.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
          value={metricOptionsForControls.length ? metricKey : ""}
        />
        <div className="compare-metric-chips" aria-label="Comparison metric columns">
          {compareTableMetricKeys.map((metric) => (
            <span className={`compare-metric-pill ${metric === metricKey ? "active" : ""}`} key={metric}>
              <span className="compare-metric-label" title={metric}>{metricTitle(metric)}</span>
              {metric !== metricKey ? (
                <button aria-label={`Remove ${metric} column`} className="compare-metric-remove" onClick={() => removeCompareTableMetric(metric)} title="Remove metric column" type="button">
                  <X size={12} />
                </button>
              ) : null}
            </span>
          ))}
          <CustomSelect
            disabled={!canAddMetric}
            id="compare-add-metric"
            label="Add metric"
            labelClassName="visually-hidden"
            onChange={addCompareTableMetric}
            options={canAddMetric
              ? [{ value: "", label: "Add metric column", disabled: true }, ...compareAddMetricOptions.map((metric) => ({ value: metric, label: metric }))]
              : [{ value: "", label: "All metrics added", disabled: true }]}
            value=""
          />
          <button
            className="compare-metric-action"
            disabled={!canAddMetric}
            onClick={addAllCompareTableMetrics}
            title={`Add up to ${MAX_COMPARE_TABLE_METRICS} metric columns`}
            type="button"
          >
            <Plus size={12} /> Add all
          </button>
          {compareTableMetricKeys.length > 1 ? (
            <button className="compare-metric-action" onClick={onResetCompareTableMetrics} title="Reset to the primary metric column" type="button">Reset</button>
          ) : null}
        </div>
        <label className="control checkbox-control compare-embed-diff">
          Diff config only
          <input aria-label="Show differing config only" id="diff-only" type="checkbox" checked={diffOnly} onChange={(event) => onDiffOnly(event.target.checked)} />
        </label>
      </div>
      <SideBySide
        artifactsByRun={compareArtifactsByRun}
        diffOnly={diffOnly}
        layout="rows"
        metricKey={metricKey}
        onOpenRunArtifacts={onOpenRunArtifacts}
        onReferenceRunId={onReferenceRunId}
        payload={sideBySide}
        referenceRunId={referenceRun?.id ?? ""}
        tableMetrics={compareTableMetricKeys}
      />
    </section>
  );
}
