"use client";

import { useState } from "react";
import { Activity, Box, Copy, Database, Download, FileText, Folder, GitBranch, GitFork, Server, Star, Tag, X } from "lucide-react";

import { buildCheckpointResumeCode, checkpointStep, defaultForkRunName } from "../../../src/checkpoints.js";
import { durationLabel, formatNumber, metricGoal, metricGoalLabel, statusTone } from "../../../src/state.js";
import { artifactHasStoredBytes, compactValue, formatBytes, formatRunTime, lastMetricStep, runNoteText, shortMetricName } from "../../dashboard-models";
import { MetricCard } from "../ui/metric-card";
import { RunMetadataEditor } from "../runs/run-metadata-editor";
import { useFocusTrap } from "../ui/use-focus-trap";
import { ArtifactMediaPreview } from "./artifact-panel";
import { RichObjectPanel } from "./rich-object-panel";
import type { Artifact, HoverPoint, LoggedObject, LoggedObjectRow, RunMetricRow, RunSummary, RunTimelineRow } from "../../dashboard-types";

type ForkCheckpointOptions = {
  inheritConfig: boolean;
  name: string;
  reason: string;
};

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRows({ rows }: { rows: string[][] }) {
  return (
    <div className="settings-list">
      {rows.map(([label, value]) => <SettingRow label={label} value={value} key={label} />)}
    </div>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <div className="chips">
      {values.map((value) => <span className="chip" title={value} key={value}>{value}</span>)}
    </div>
  );
}

function RunTimeline({ rows }: { rows: RunTimelineRow[] }) {
  return (
    <div className="run-timeline">
      {rows.map((row) => (
        <article className="run-timeline-row" key={row.id}>
          <span className={`timeline-dot ${row.tone}`} />
          <span>
            <strong>{row.label}</strong>
            <small>{row.detail}</small>
          </span>
          <b>{row.value}</b>
        </article>
      ))}
    </div>
  );
}

function RunMetricTable({ rows }: { rows: RunMetricRow[] }) {
  if (!rows.length) return <div className="empty compact-empty">No metric aggregates are available for this run.</div>;
  return (
    <div className="metric-summary-table">
      <div className="metric-summary-row metric-summary-head">
        <span>Metric</span>
        <span>Latest</span>
        <span>Goal</span>
        <span>Mean</span>
        <span>Step</span>
      </div>
      {rows.slice(0, 12).map((row) => (
        <div className="metric-summary-row" key={row.key}>
          <strong title={row.key}>{shortMetricName(row.key)}</strong>
          <span data-label="Latest">{formatNumber(row.latest, 3)}</span>
          <span data-label="Goal" title={metricGoalLabel(row.key)}>{formatNumber(metricGoal(row.key) === "minimize" ? row.min : row.max, 3)}</span>
          <span data-label="Mean">{formatNumber(row.mean, 3)}</span>
          <span data-label="Step">{formatNumber(row.bestStep, 0)}</span>
        </div>
      ))}
    </div>
  );
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Visible IDs/snippets remain selectable when clipboard permission is denied.
  }
}

function CheckpointList({
  artifacts,
  onForkCheckpoint,
  run,
}: {
  artifacts: Artifact[];
  onForkCheckpoint?: (artifact: Artifact, options: ForkCheckpointOptions) => Promise<void>;
  run: RunSummary;
}) {
  const [forkArtifact, setForkArtifact] = useState<Artifact | null>(null);
  const [forkName, setForkName] = useState("");
  const [forkReason, setForkReason] = useState("");
  const [inheritConfig, setInheritConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useFocusTrap<HTMLDivElement>(Boolean(forkArtifact), closeForkDialog, "#fork-run-name");
  const checkpoints = artifacts
    .filter((artifact) => artifact.type === "checkpoint")
    .sort((left, right) => (right.step ?? -1) - (left.step ?? -1));
  if (!checkpoints.length) return null;

  function openForkDialog(artifact: Artifact) {
    setForkArtifact(artifact);
    setForkName(defaultForkRunName(artifact, run));
    setForkReason("");
    setInheritConfig(true);
    setError("");
  }

  function closeForkDialog() {
    if (busy) return;
    setForkArtifact(null);
    setError("");
  }

  async function submitFork() {
    if (!forkArtifact || !onForkCheckpoint || busy) return;
    setBusy(true);
    setError("");
    try {
      await onForkCheckpoint(forkArtifact, {
        inheritConfig,
        name: forkName,
        reason: forkReason,
      });
      setForkArtifact(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create fork.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="detail-section checkpoint-section">
      <h3><Box size={15} /> Checkpoints ({checkpoints.length})</h3>
      <div className="checkpoint-list">
        {checkpoints.map((artifact) => {
          const canDownload = artifactHasStoredBytes(artifact);
          return (
            <article className="checkpoint-row" key={artifact.id}>
              <div className="checkpoint-main">
                <strong title={artifact.name}>{artifact.name}</strong>
                <small>{artifact.step === null ? "no step" : `step ${artifact.step}`} · {formatBytes(artifact.size_bytes)}</small>
              </div>
              <div className="checkpoint-actions">
                {canDownload ? (
                  <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
                ) : (
                  <button className="copy-button artifact-download unavailable" disabled title="Download unavailable for metadata-only checkpoints" type="button">
                    <Download size={13} /> Unavailable
                  </button>
                )}
                <button
                  className="copy-button"
                  onClick={() => void copyText(buildCheckpointResumeCode(artifact, run))}
                  type="button"
                >
                  <Copy size={13} /> Resume Code
                </button>
                {onForkCheckpoint ? (
                  <button
                    aria-label={`Fork ${artifact.name}`}
                    className="copy-button"
                    disabled={busy}
                    onClick={() => openForkDialog(artifact)}
                    type="button"
                  >
                    <GitFork size={13} /> Fork
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {forkArtifact ? (
        <div className="workspace-modal checkpoint-fork-modal" role="dialog" aria-modal="true" aria-label="Fork checkpoint">
          <div className="workspace-modal-card checkpoint-fork-card" ref={dialogRef} tabIndex={-1}>
            <div className="drawer-head">
              <div>
                <span className="analysis-eyebrow eyebrow--accent">Fork checkpoint</span>
                <h2>{forkArtifact.name}</h2>
              </div>
              <button aria-label="Close fork dialog" className="icon-button framed" disabled={busy} onClick={closeForkDialog} type="button">
                <X size={16} />
              </button>
            </div>
            <div className="checkpoint-fork-body">
              <p className="checkpoint-fork-notice">InstantML creates a linked run record only. It does not start training.</p>
              <div className="checkpoint-fork-grid">
                <div><span>Source run</span><strong title={run.name}>{run.name}</strong></div>
                <div><span>Checkpoint step</span><strong>{checkpointStep(forkArtifact) ?? "unknown"}</strong></div>
                <div><span>Checkpoint id</span><strong title={forkArtifact.id}>{forkArtifact.id}</strong></div>
              </div>
              <label className="checkpoint-fork-field">
                <span>Run name</span>
                <input aria-label="Fork run name" id="fork-run-name" value={forkName} onChange={(event) => setForkName(event.target.value)} />
              </label>
              <label className="checkpoint-fork-field">
                <span>Reason</span>
                <textarea aria-label="Fork reason" rows={3} value={forkReason} onChange={(event) => setForkReason(event.target.value)} placeholder="Retry reason" />
              </label>
              <label className="checkpoint-fork-toggle">
                <input aria-label="Inherit source config" type="checkbox" checked={inheritConfig} onChange={(event) => setInheritConfig(event.target.checked)} />
                <span>Inherit source config</span>
              </label>
              {error ? <div className="checkpoint-fork-error" role="alert">{error}</div> : null}
            </div>
            <div className="checkpoint-fork-actions">
              <button className="secondary" disabled={busy} onClick={closeForkDialog} type="button">Cancel</button>
              <button className="primary" disabled={busy || !forkName.trim()} onClick={submitFork} type="button">
                <GitFork size={14} /> {busy ? "Creating..." : "Create Fork"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function artifactCountForRun(run: RunSummary, loadedCount: number) {
  const counted = Object.values(run.artifact_counts ?? {}).reduce((total, value) => (
    total + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  ), 0);
  return counted || loadedCount;
}

export function RunDetail({
  activeMetricKey,
  artifacts = [],
  elementId,
  hover,
  loggedObjects = [],
  metricRows,
  objectRowsById = {},
  onForkCheckpoint,
  onRunMetadataSave,
  run,
  selectedCount,
  selectedRuns,
  timelineRows,
  workspaceSummary = false,
}: {
  activeMetricKey: string;
  artifacts?: Artifact[];
  elementId: string;
  hover: HoverPoint;
  loggedObjects?: LoggedObject[];
  metricRows: RunMetricRow[];
  objectRowsById?: Record<number, LoggedObjectRow[]>;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  onForkCheckpoint?: (artifact: Artifact, options: ForkCheckpointOptions) => Promise<void>;
  run: RunSummary | null;
  selectedCount: number;
  selectedRuns?: RunSummary[];
  timelineRows: RunTimelineRow[];
  workspaceSummary?: boolean;
  }) {
  if (!run) return <div className="empty">No run selected.</div>;
  const chartRuns = selectedRuns?.length ? selectedRuns : [run];
  const commit = metadataScalar(run.metadata, "git_commit")
    ?? metadataScalar(run.metadata, "commit")
    ?? nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "commit"]);
  const gitAvailable = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "available"]);
  const gitDirty = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "dirty"]);
  const gitDirtyUnknown = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "git", "dirty_unknown"]);
  const entrypoint = nestedMetadataScalar(run.metadata, ["_rlobs", "source", "entrypoint"]);
  const dirtyLabel = gitDirty === true ? "yes" : gitDirty === false ? "no" : gitDirtyUnknown === true ? "unknown" : "-";
  const gitLabel = gitAvailable === false ? "unavailable" : gitAvailable === true || commit ? "available" : "-";
  const sourceRows = [
    ["Start time", formatRunTime(run.started_at ?? run.created_at)],
    ["End time", run.finished_at ? formatRunTime(run.finished_at) : "-"],
    ["Duration", durationLabel(run)],
    ["Entry point", compactValue(entrypoint ?? "-")],
    ["Git", compactValue(gitLabel)],
    ["Host", compactValue(run.metadata.hostname ?? run.metadata.host ?? "-")],
    ["PID", compactValue(run.metadata.pid ?? "-")],
    ["Commit", compactValue(commit ?? "-")],
    ["Dirty", compactValue(dirtyLabel)],
    ["Python", compactValue(metadataScalar(run.metadata, "python") ?? "-")],
    ["Platform", compactValue(metadataScalar(run.metadata, "platform") ?? "-")],
  ];
  const artifactRows = artifacts.slice(0, 4);
  const artifactCount = artifactCountForRun(run, artifacts.length);
  const activeMetric = run.metric_aggregates?.[activeMetricKey];
  const activeBest = metricGoal(activeMetricKey) === "minimize" ? activeMetric?.min : activeMetric?.max;
  const configRows = [
    ["Algorithm", compactValue(run.config.algo ?? run.config.model ?? run.config.policy ?? "-")],
    ["Dataset/env", compactValue(run.config.dataset ?? run.config.dataset_name ?? run.config.env ?? "-")],
    ["Seed", compactValue(run.config.seed ?? "-")],
    ["Learning rate", compactValue(run.config.learning_rate ?? run.config.lr ?? "-")],
    ["Batch size", compactValue(run.config.batch_size ?? run.config.batch ?? "-")],
    ["Epochs/steps", compactValue(run.config.epochs ?? run.config.steps ?? run.config.total_steps ?? "-")],
  ];
  return (
    <div className={`detail-stack ${workspaceSummary ? "workspace-summary" : ""}`} id={elementId}>
      {!workspaceSummary ? (
        <header className="run-detail-hero">
          <div className="run-detail-title">
            <span className="analysis-eyebrow eyebrow--accent">Selected run</span>
            <h2 title={run.name}>{run.name}</h2>
            <p>{run.project} · {durationLabel(run)} · {selectedCount ? `${selectedCount} runs selected for charts` : "not in comparison set"}</p>
          </div>
          <div className="run-detail-badges">
            <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
            {run.tags?.slice(0, 3).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
            {(run.tags?.length ?? 0) > 3 ? <span className="chip">+{(run.tags?.length ?? 0) - 3}</span> : null}
          </div>
        </header>
      ) : null}
      <RunMetadataEditor compact onSave={onRunMetadataSave} run={run} title="Run tags and notes" />
      {!workspaceSummary ? (
        <section className="detail-section chart-selection-section">
          <h3><Activity size={15} /> Chart selection</h3>
          <div className="chart-selection-list">
            {chartRuns.slice(0, 8).map((selectedRun) => (
              <span className={selectedRun.id === run.id ? "active" : ""} key={selectedRun.id} title={selectedRun.name}>
                {selectedRun.name}
              </span>
            ))}
            {chartRuns.length > 8 ? <em>+{chartRuns.length - 8} more</em> : null}
          </div>
        </section>
      ) : selectedCount ? (
        <div className="workspace-summary-selection">
          <Activity size={14} />
          <span>{selectedCount} runs selected for chart context</span>
          <strong>{shortMetricName(activeMetricKey)}</strong>
        </div>
      ) : null}
      <div className="run-kpi-grid">
        <MetricCard label={`Latest ${shortMetricName(activeMetricKey)}`} value={formatNumber(activeMetric?.latest, 3)} tone="neutral" />
        <MetricCard label={`${metricGoalLabel(activeMetricKey)} ${shortMetricName(activeMetricKey)}`} value={formatNumber(activeBest, 3)} tone="good" />
        <MetricCard label="Metric keys" value={formatNumber(metricRows.length, 0)} tone="live" />
        <MetricCard label="Artifacts" value={formatNumber(artifactCount, 0)} tone={artifactCount ? "good" : "neutral"} />
      </div>
      {hover ? <div className="detail-row highlight"><span>Hovered point</span><strong>{hover.runName} / step {hover.point.step} / {formatNumber(hover.point.value, 4)}</strong></div> : null}
      {run.status === "failed" ? (
        <section className="failure-card">
          <strong>Failed run triage</strong>
          <div><span>Last metric step</span><b>{lastMetricStep(run)}</b></div>
          <div><span>Likely reason</span><b>{compactValue(run.metadata.error ?? run.metadata.exit_reason ?? "No failure reason logged")}</b></div>
          <div><span>Checkpoint coverage</span><b>{formatNumber(run.artifact_counts?.checkpoint ?? 0, 0)} checkpoints</b></div>
        </section>
      ) : null}
      <CheckpointList artifacts={artifacts} onForkCheckpoint={onForkCheckpoint} run={run} />
      <div className="detail-body-grid">
        <div className="detail-main-column">
          <section className="detail-section">
            <h3><Database size={15} /> Metric Summary</h3>
            <RunMetricTable rows={metricRows} />
          </section>
          {!workspaceSummary ? (
            <>
              <section className="detail-section">
                <h3><Folder size={15} /> Recent Artifacts ({artifacts.length})</h3>
                {artifactRows.length ? artifactRows.map((artifact) => (
                  <div className="artifact-mini" key={artifact.id}>
                    <span>{artifact.name}</span>
                    <small>{artifact.step === null ? "no step" : `step ${artifact.step}`}</small>
                    <small>{formatBytes(artifact.size_bytes)}</small>
                    <ArtifactMediaPreview artifact={artifact} compact fallback />
                  </div>
                )) : <small>No artifacts logged.</small>}
              </section>
              <RichObjectPanel objects={loggedObjects} rowsByObjectId={objectRowsById} title="Rich Objects" />
            </>
          ) : null}
          <details className="detail-section raw-detail">
            <summary><Database size={15} /> Raw configuration</summary>
            <pre>{JSON.stringify(run.config, null, 2)}</pre>
          </details>
          <details className="detail-section raw-detail">
            <summary><GitBranch size={15} /> Latest metrics</summary>
            <pre>{JSON.stringify(run.latest_metrics, null, 2)}</pre>
          </details>
        </div>
        <aside className="detail-side-rail">
          <section className="detail-section">
            <h3><Activity size={15} /> Timeline</h3>
            <RunTimeline rows={timelineRows} />
          </section>
          <section className="detail-section">
            <h3><Server size={15} /> Source</h3>
            {sourceRows.map(([label, value]) => <div className="detail-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </section>
          <section className="detail-section">
            <h3><Star size={15} /> Reproducibility</h3>
            <InfoRows rows={configRows} />
          </section>
          <section className="detail-section">
            <h3><Tag size={15} /> Tags</h3>
            <Chips values={run.tags} />
          </section>
        </aside>
      </div>
    </div>
  );
}

function metadataScalar(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function nestedMetadataScalar(metadata: Record<string, unknown>, path: string[]) {
  let current: unknown = metadata;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? current : null;
}
