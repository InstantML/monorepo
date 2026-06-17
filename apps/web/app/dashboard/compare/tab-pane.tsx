import { Plus, X } from "lucide-react";

import { CustomSelect } from "../ui/select";
import { RunMetadataEditor } from "../runs/run-metadata-editor";
import { SideBySide } from "./side-by-side";
import { metricTitle, COMPARE_RUN_LIMIT } from "../../dashboard-models";
import { metricGoalLabel } from "../../../src/state.js";
import type { Artifact, CompareLayout, CompareRowSort, CompareRunSort, RunSummary } from "../../dashboard-types";

type Props = {
  addAllCompareTableMetrics: () => void;
  addCompareTableMetric: (metric: string) => void;
  availableRuns: RunSummary[];
  onAddCompareRun: (runId: string) => void;
  onOpenRunsTab: () => void;
  compareAddMetricOptions: string[];
  compareArtifactsByRun: Record<string, Artifact[]>;
  compareConfigKeys: string[];
  compareConfigSortKey: string;
  compareEditRun: RunSummary | null;
  compareLayout: CompareLayout;
  compareOverflowCount: number;
  compareRowSort: CompareRowSort;
  compareRunIds: string[];
  compareRunSort: CompareRunSort;
  compareRuns: RunSummary[];
  compareSearch: string;
  compareSortMetricKey: string;
  compareTableMetricKeys: string[];
  diffOnly: boolean;
  MAX_COMPARE_TABLE_METRICS: number;
  metricKey: string;
  metricOptionsForControls: string[];
  onChangeCompareSearch: (search: string) => void;
  onChangeMetricKeyAndSortKey: (value: string) => void;
  onCompareConfigSortKey: (key: string) => void;
  onCompareEditRunId: (id: string) => void;
  onCompareLayout: (layout: string) => void;
  onCompareRowSort: (sort: string) => void;
  onCompareRunSort: (sort: string) => void;
  onDiffOnly: (checked: boolean) => void;
  onOpenRunArtifacts: (runId: string) => void;
  onReferenceRunId: (id: string) => void;
  onResetCompareTableMetrics: () => void;
  onRunSortMetricKey: (key: string) => void;
  onRunSort: (sort: CompareRunSort) => void;
  onUpdateRunTagsAndNotes?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  referenceRun: RunSummary | null;
  removeCompareTableMetric: (metric: string) => void;
  selectedRunIds: string[];
  sideBySide: any;
};

export function CompareTabPane({
  addAllCompareTableMetrics,
  addCompareTableMetric,
  availableRuns,
  onAddCompareRun,
  onOpenRunsTab,
  compareAddMetricOptions,
  compareArtifactsByRun,
  compareConfigKeys,
  compareConfigSortKey,
  compareEditRun,
  compareLayout,
  compareOverflowCount,
  compareRowSort,
  compareRunIds,
  compareRunSort,
  compareRuns,
  compareSearch,
  compareSortMetricKey,
  compareTableMetricKeys,
  diffOnly,
  MAX_COMPARE_TABLE_METRICS,
  metricKey,
  metricOptionsForControls,
  onChangeCompareSearch,
  onChangeMetricKeyAndSortKey,
  onCompareConfigSortKey,
  onCompareEditRunId,
  onCompareLayout,
  onCompareRowSort,
  onCompareRunSort,
  onDiffOnly,
  onOpenRunArtifacts,
  onReferenceRunId,
  onResetCompareTableMetrics,
  onRunSortMetricKey,
  onRunSort,
  onUpdateRunTagsAndNotes,
  referenceRun,
  removeCompareTableMetric,
  selectedRunIds,
  sideBySide,
}: Props) {
  const selectedIdSet = new Set(selectedRunIds);
  const addRunOptions = availableRuns.filter((run) => !selectedIdSet.has(run.id));
  const addRunSelect = (
    <CustomSelect
      disabled={!addRunOptions.length}
      id="compare-add-run"
      label="Add runs"
      onChange={(value) => { if (value) onAddCompareRun(value); }}
      options={addRunOptions.length
        ? [{ value: "", label: "Add run to comparison", disabled: true }, ...addRunOptions.map((run) => ({ value: run.id, label: run.name }))]
        : [{ value: "", label: "All loaded runs selected", disabled: true }]}
      value=""
    />
  );
  return (
    <div className="analysis-page compare-analysis">
      <section className="panel analysis-card compare-shell">
        <header className="analysis-header compare-analysis-header">
          <div className="analysis-title-block">
            <h2>{compareRunIds.length}{compareOverflowCount ? `/${selectedRunIds.length}` : ""} runs side by side</h2>
            <p>{metricTitle(metricKey)} · {metricGoalLabel(metricKey)} objective · sort any column</p>
          </div>
          <div className="analysis-stat-strip">
            <div className="analysis-stat"><span>Reference</span><strong title={referenceRun?.name}>{referenceRun?.name ?? "-"}</strong></div>
            <div className="analysis-stat"><span>Cap</span><strong>{COMPARE_RUN_LIMIT}</strong></div>
            <div className="analysis-stat"><span>Mode</span><strong>{compareLayout === "columns" ? "Columns" : "Rows"}</strong></div>
          </div>
          {compareOverflowCount ? <span className="compare-limit-note">First {COMPARE_RUN_LIMIT} selected runs are compared; {compareOverflowCount} remain selected outside Compare.</span> : null}
        </header>
        <div className="analysis-toolbar compare-toolbar">
          <label className="control compare-search-control">
            Search
            <input aria-label="Compare search" id="compare-search" placeholder="runs, evidence, tags, notes, artifacts" value={compareSearch} onChange={(event) => onChangeCompareSearch(event.target.value)} />
          </label>
          {addRunSelect}
          <CustomSelect
            id="reference-run"
            label="Reference"
            onChange={onReferenceRunId}
            options={compareRuns.length ? compareRuns.map((run) => ({ value: run.id, label: run.name })) : [{ value: "", label: "No selected runs", disabled: true }]}
            value={referenceRun?.id ?? ""}
          />
          <CustomSelect
            id="compare-metric"
            label="Metric"
            onChange={onChangeMetricKeyAndSortKey}
            options={metricOptionsForControls.length ? metricOptionsForControls.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
            value={metricOptionsForControls.length ? metricKey : ""}
          />
          <CustomSelect
            disabled={!compareAddMetricOptions.length || compareTableMetricKeys.length >= MAX_COMPARE_TABLE_METRICS}
            id="compare-add-metric"
            label="Add metric"
            onChange={addCompareTableMetric}
            options={compareAddMetricOptions.length && compareTableMetricKeys.length < MAX_COMPARE_TABLE_METRICS
              ? [{ value: "", label: "Add metric", disabled: true }, ...compareAddMetricOptions.map((metric) => ({ value: metric, label: metric }))]
              : [{ value: "", label: "All metrics added", disabled: true }]}
            value=""
          />
          <CustomSelect
            id="compare-layout"
            label="Layout"
            onChange={onCompareLayout}
            options={[
              { value: "rows", label: "Runs as rows" },
              { value: "columns", label: "Runs as columns" },
            ]}
            value={compareLayout === "columns" ? "columns" : "rows"}
          />
          {compareLayout === "columns" ? (
            <CustomSelect
              id="compare-row-sort"
              label="Evidence"
              onChange={onCompareRowSort}
              options={[
                { value: "signal", label: "Signal" },
                { value: "changed", label: "Changed first" },
                { value: "missing", label: "Missing first" },
                { value: "category", label: "Category" },
                { value: "name", label: "Name" },
                { value: "spread", label: "Numeric spread" },
              ]}
              value={compareRowSort}
            />
          ) : null}
          <CustomSelect
            disabled={!compareConfigKeys.length}
            id="compare-config-key"
            label="Config"
            onChange={onCompareConfigSortKey}
            options={compareConfigKeys.length ? compareConfigKeys.map((key) => ({ value: key, label: key })) : [{ value: "", label: "No config keys", disabled: true }]}
            value={compareConfigKeys.length ? compareConfigSortKey : ""}
          />
          <label className="control checkbox-control">
            Diff only
            <input aria-label="Show differences only" id="diff-only" type="checkbox" checked={diffOnly} onChange={(event) => onDiffOnly(event.target.checked)} />
          </label>
        </div>
        <div className="compare-metric-strip" aria-label="Compare table metric columns">
          <span>Metric columns</span>
          {compareTableMetricKeys.map((metric) => (
            <div className={`compare-metric-pill ${metric === metricKey ? "active" : ""}`} key={metric}>
              <span className="compare-metric-label" title={metric}>{metricTitle(metric)}</span>
              {metric !== metricKey ? (
                <button aria-label={`Remove ${metric} column`} className="compare-metric-remove" onClick={() => removeCompareTableMetric(metric)} title="Remove metric column" type="button">
                  <X size={12} />
                </button>
              ) : null}
            </div>
          ))}
          <div className="compare-metric-strip-actions">
            <button
              className="compare-metric-action"
              disabled={!compareAddMetricOptions.length || compareTableMetricKeys.length >= MAX_COMPARE_TABLE_METRICS}
              onClick={addAllCompareTableMetrics}
              title={`Add up to ${MAX_COMPARE_TABLE_METRICS} metric columns`}
              type="button"
            >
              <Plus size={12} /> Add all
            </button>
            <button
              className="compare-metric-action"
              disabled={compareTableMetricKeys.length <= 1}
              onClick={onResetCompareTableMetrics}
              title="Reset to the primary metric column"
              type="button"
            >
              Reset
            </button>
          </div>
        </div>
        {!compareRuns.length ? (
          selectedRunIds.length ? (
            <div className="empty compare-empty-state">
              <p>Loading the {selectedRunIds.length} selected runs…</p>
            </div>
          ) : (
            <div className="empty compare-empty-state">
              <p>No runs selected yet. Add runs with the picker above, or select them from the Runs workspace. Selections are saved to the link, so a compare view can be shared or reopened later.</p>
              <button className="secondary compact-button" onClick={onOpenRunsTab} type="button">Select runs in the Runs tab</button>
            </div>
          )
        ) : (
          <SideBySide
            artifactsByRun={compareArtifactsByRun}
            configSortKey={compareConfigSortKey}
            diffOnly={diffOnly}
            layout={compareLayout}
            metricKey={metricKey}
            onOpenRunArtifacts={onOpenRunArtifacts}
            onReferenceRunId={onReferenceRunId}
            onRunSort={onRunSort}
            onRunSortMetricKey={onRunSortMetricKey}
            payload={sideBySide}
            referenceRunId={referenceRun?.id ?? ""}
            rowSort={compareRowSort}
            runSort={compareRunSort}
            runSortMetricKey={compareSortMetricKey}
            search={compareSearch}
            tableMetrics={compareTableMetricKeys}
          />
        )}
        {compareRuns.length ? (
          <details className="compare-annotation-details">
            <summary>
              <span>Annotate compared run</span>
              <strong title={compareEditRun?.name}>{compareEditRun?.name ?? "-"}</strong>
            </summary>
            <div className="compare-metadata-editor">
              <CustomSelect
                id="compare-edit-run"
                label="Annotate"
                onChange={onCompareEditRunId}
                options={compareRuns.map((run) => ({ value: run.id, label: run.name }))}
                value={compareEditRun?.id ?? ""}
              />
              <RunMetadataEditor compact onSave={onUpdateRunTagsAndNotes} run={compareEditRun} title="Tags and notes" />
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
