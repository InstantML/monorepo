"use client";

import { Copy, Download, GitFork, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isAbortError, queryString } from "../../../src/api.js";
import { buildCheckpointResumeCode, checkpointStep } from "../../../src/checkpoints.js";
import { displayStatusForRun, formatNumber, uploadHealthForRun } from "../../../src/state.js";
import { artifactHasStoredBytes, buildAlertRows, compactValue, formatBytes, lastMetricStep } from "../../dashboard-models";
import { MetricChart } from "../metrics/metric-chart";
import { RunMetadataEditor } from "../runs/run-metadata-editor";
import { SkeletonChartLines } from "../ui/skeleton";
import { useFocusTrap } from "../ui/use-focus-trap";
import type { Artifact, MetricSeries, RunSummary, RunTimelineRow } from "../../dashboard-types";

type ApiLike = {
  get(path: string, options?: { signal?: AbortSignal }): Promise<any>;
  post(path: string, body?: any, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<any>;
};

export type ForkCheckpointOptions = {
  inheritConfig: boolean;
  name: string;
  reason: string;
};

export type OverviewChartSpec = {
  key: string;
  modifier: string;
  unit?: string;
  fullWidth?: boolean;
  series: MetricSeries[];
};

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Visible snippets stay selectable when clipboard permission is denied.
  }
}

/* ------------------------------------------------------------------ */
/* Chart grid                                                          */
/* ------------------------------------------------------------------ */

function ChartPanel({ loading, spec }: { loading: boolean; spec: OverviewChartSpec }) {
  const chartHeight = spec.fullWidth ? 120 : 150;
  const awaitingSeries = loading && !spec.series.some((item) => item.points?.length);
  return (
    <div className={`pd-panel pd-chartpanel ${spec.modifier}`}>
      <div className="pd-panel-head">
        <span className="pd-mlabel" title={spec.key}>{spec.key}</span>
        {spec.unit ? <span className="pd-unit">{spec.unit}</span> : null}
      </div>
      <div className="pd-panel-chart">
        {awaitingSeries ? (
          <div className="chart-area workspace-chart-loading" role="status" aria-label={`Loading ${spec.key} series`}>
            <SkeletonChartLines legend={false} minHeight={chartHeight} />
          </div>
        ) : (
          <MetricChart
            emptyMessage="No points logged yet."
            height={chartHeight}
            metricKey={spec.key}
            padding={34}
            series={spec.series}
            showRange={false}
            showYAxisControls={false}
            xMode="step"
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Log tail                                                            */
/* ------------------------------------------------------------------ */

type TailLine = {
  created_at: string;
  line_number: number;
  message: string;
  stream: string;
  timestamp: string;
};

// Newer servers accept `tail=<N>` (1..=500) on the console-log GET and return
// exactly the last N lines ascending — one request per stream per poll. Older
// servers ignore the param and only page forward (line_number ASC), so the
// tail falls back to following the cursor a bounded number of pages and
// keeping the last lines seen (very long logs then show the freshest page
// reached). The fallback engages when a response returns more lines than the
// requested tail — i.e. the server served a full first page instead.
const TAIL_PAGE_LIMIT = 6;
const TAIL_PAGE_SIZE = 250;
const TAIL_LINES = 5;
const TAIL_POLL_MS = 15_000;

function tailTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function tailLevel(message: string): { level: string; tone: string } | null {
  const match = message.match(/^\s*\[?\b(INFO|WARN|WARNING|ERROR|ERR|FATAL|DEBUG|TRACE)\b\]?:?\s*/i);
  if (!match) return null;
  // Show the level exactly as the log emitted it; only the tone lookup normalizes.
  const level = match[1];
  const normalized = level.toUpperCase();
  const tone = normalized.startsWith("ERR") || normalized === "FATAL" ? "er" : normalized.startsWith("WARN") ? "wr" : "ok";
  return { level, tone };
}

export function LogTailPanel({
  api,
  onOpenLogs,
  run,
  running,
}: {
  api: ApiLike;
  onOpenLogs: () => void;
  run: RunSummary;
  running: boolean;
}) {
  const [lines, setLines] = useState<TailLine[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [tick, setTick] = useState(0);
  // Sticky per-panel feature detection: once a server demonstrably ignores
  // `tail=` we stop paying the probe request and walk the cursor directly.
  const tailUnsupportedRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    // Ticks are gated on tab visibility (B6): no background polling, and a
    // return to the tab refreshes the tail once immediately.
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      setTick((current) => current + 1);
    };
    const timer = window.setInterval(poll, TAIL_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [running]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function walkTail(stream: "stdout" | "stderr", seed: TailLine[], seedCursor: string) {
      // Legacy forward-only pagination: follow the cursor a bounded number of
      // pages and keep the last lines seen.
      let collected = seed.slice(-TAIL_LINES);
      let cursor = seedCursor;
      if (seed.length && !cursor) return collected;
      for (let page = 0; page < TAIL_PAGE_LIMIT; page += 1) {
        const query = cursor
          ? queryString({ stream, limit: TAIL_PAGE_SIZE, cursor })
          : queryString({ stream, limit: TAIL_PAGE_SIZE });
        const payload = await api.get(`/api/runs/${run.id}/logs${query}`, { signal: controller.signal });
        const chunk: TailLine[] = Array.isArray(payload?.lines) ? payload.lines : [];
        collected = [...collected, ...chunk].slice(-TAIL_LINES);
        cursor = payload?.next_cursor ?? "";
        if (!cursor) break;
      }
      return collected;
    }
    async function tailOf(stream: "stdout" | "stderr") {
      if (!tailUnsupportedRef.current) {
        // Preferred path: a single tail=N request per stream.
        const payload = await api.get(
          `/api/runs/${run.id}/logs${queryString({ stream, tail: TAIL_LINES })}`,
          { signal: controller.signal },
        );
        const chunk: TailLine[] = Array.isArray(payload?.lines) ? payload.lines : [];
        if (chunk.length <= TAIL_LINES) {
          // Either the server honored tail=N, or the whole log fits in the
          // response — both are the correct tail.
          return chunk.slice(-TAIL_LINES);
        }
        // The server ignored `tail` and returned a full first page: remember
        // that and finish via the pagination walk, reusing this page as the
        // first hop.
        tailUnsupportedRef.current = true;
        return walkTail(stream, chunk, payload?.next_cursor ?? "");
      }
      return walkTail(stream, [], "");
    }
    (async () => {
      try {
        let tail = await tailOf("stdout");
        if (!tail.length) tail = await tailOf("stderr");
        if (!cancelled) {
          setLines(tail);
          setPhase("ready");
        }
      } catch (caught) {
        if (!cancelled && !isAbortError(caught)) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, run.id, tick]);

  return (
    <div className="pd-panel pd-logtail">
      <div className="pd-panel-head">
        <span className="pd-mlabel">Log tail</span>
        {running ? <span className="pd-chip pd-chip--live pd-chip--sm"><span className="pd-pulse pd-pulse--sm" />following</span> : null}
        <button className="pd-btn pd-btn--ghost pd-btn--sm" onClick={onOpenLogs} type="button">Open logs</button>
      </div>
      <div className="pd-loglines">
        {lines.map((line) => {
          const lvl = tailLevel(line.message);
          const message = lvl ? line.message.replace(/^\s*\[?\b(INFO|WARN|WARNING|ERROR|ERR|FATAL|DEBUG|TRACE)\b\]?:?\s*/i, "") : line.message;
          return (
            <div className="pd-logline" key={`${line.stream}-${line.line_number}-${line.created_at}`}>
              <span className="t">{tailTimestamp(line.timestamp)}</span>
              {lvl ? <span className={lvl.tone}>{lvl.level}</span> : null}
              <span className="msg">{message}</span>
            </div>
          );
        })}
        {phase === "loading" && !lines.length ? <div className="pd-logline pd-logline--empty">Loading log tail...</div> : null}
        {phase === "error" && !lines.length ? <div className="pd-logline pd-logline--empty">Unable to load logs.</div> : null}
        {phase === "ready" && !lines.length ? <div className="pd-logline pd-logline--empty">No console logs yet.</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Config panel                                                        */
/* ------------------------------------------------------------------ */

function configValueClass(value: unknown) {
  if (typeof value === "number") return "n";
  if (typeof value === "string") return "s";
  return "v";
}

export function ConfigPanel({ parent, run }: { parent: RunSummary | null; run: RunSummary }) {
  const [diffOnly, setDiffOnly] = useState(false);
  const entries = Object.entries(run.config ?? {});
  const parentConfig = parent?.config ?? null;
  const rows = entries.map(([key, value]) => {
    const parentValue = parentConfig ? parentConfig[key] : undefined;
    const changed = Boolean(parentConfig) && JSON.stringify(parentValue) !== JSON.stringify(value);
    return { changed, key, parentValue, value };
  });
  const visible = diffOnly ? rows.filter((row) => row.changed) : rows;
  const parentShort = parent ? parent.name.split("-").pop() ?? parent.name : "";
  return (
    <div className="pd-panel">
      <div className="pd-panel-head">
        <span className="pd-mlabel">Config</span>
        {parent ? (
          <button
            aria-pressed={diffOnly}
            className={`pd-btn pd-btn--ghost pd-btn--sm ${diffOnly ? "is-on" : ""}`}
            onClick={() => setDiffOnly((current) => !current)}
            type="button"
          >
            Diff vs {parentShort}
          </button>
        ) : null}
      </div>
      {entries.length ? (
        <div className="pd-codewell">
          {visible.map((row) => (
            <div className="pd-cfg-row" key={row.key}>
              <span className="k">{row.key}:</span>
              <span className={configValueClass(row.value)} title={compactValue(row.value)}>{compactValue(row.value)}</span>
              {row.changed ? (
                <span className="c"># was {row.parentValue === undefined ? "unset" : compactValue(row.parentValue)}</span>
              ) : null}
            </div>
          ))}
          {diffOnly && !visible.length ? <div className="pd-cfg-row"><span className="c"># no differences vs {parent?.name}</span></div> : null}
        </div>
      ) : (
        <div className="pd-side-empty">
          <p>Nothing logged yet. Record algorithm, dataset, and seed with:</p>
          <code>run = instantml.init(config=&#123;"algo": "...", "dataset": "...", "seed": 17&#125;)</code>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Checkpoints panel                                                   */
/* ------------------------------------------------------------------ */

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function artifactGlyph(artifact: Artifact) {
  if (artifact.type === "checkpoint") return "ckpt";
  if (artifact.type === "rollout") return "roll";
  return artifact.type.slice(0, 4) || "file";
}

export function bestCheckpointId(artifacts: Artifact[]) {
  let best: Artifact | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const artifact of artifacts) {
    if (artifact.type !== "checkpoint") continue;
    const value = Number(artifact.metadata?.eval_return);
    if (Number.isFinite(value) && value > bestValue) {
      bestValue = value;
      best = artifact;
    }
  }
  return best?.id ?? "";
}

export function newestCheckpoint(artifacts: Artifact[]) {
  const checkpoints = artifacts
    .filter((artifact) => artifact.type === "checkpoint")
    .sort((left, right) => (right.step ?? -1) - (left.step ?? -1));
  return checkpoints[0] ?? null;
}

const CHECKPOINT_PANEL_ROWS = 5;

export function CheckpointsPanel({
  artifacts,
  onRequestFork,
  run,
  totalCount,
}: {
  artifacts: Artifact[];
  onRequestFork?: (artifact: Artifact) => void;
  run: RunSummary;
  totalCount: number;
}) {
  const checkpoints = artifacts
    .filter((artifact) => artifact.type === "checkpoint")
    .sort((left, right) => (right.step ?? -1) - (left.step ?? -1));
  const others = artifacts.filter((artifact) => artifact.type !== "checkpoint");
  const rows = [...checkpoints, ...others].slice(0, CHECKPOINT_PANEL_ROWS);
  const bestId = bestCheckpointId(artifacts);
  return (
    <div className="pd-panel">
      <div className="pd-panel-head">
        <span className="pd-mlabel">Checkpoints</span>
        <span className="pd-unit">{formatNumber(totalCount, 0)} total</span>
      </div>
      <div className="pd-panel-flush">
        {rows.length ? rows.map((artifact) => (
          <div className="pd-art-row" key={artifact.id}>
            <span className="pd-art-glyph">{artifactGlyph(artifact)}</span>
            <span className="pd-art-name" title={artifact.name}>{artifact.name}</span>
            {artifact.id === bestId ? <span className="pd-chip pd-chip--live pd-chip--sm">best</span> : null}
            <span className="pd-art-size num">{formatBytes(artifact.size_bytes)}</span>
            <span className="pd-art-actions">
              {artifactHasStoredBytes(artifact) ? (
                <a aria-label={`Download ${artifact.name}`} className="pd-iconbtn" href={artifactDownloadUrl(artifact)} title="Download">
                  <Download size={12} />
                </a>
              ) : null}
              {artifact.type === "checkpoint" ? (
                <button
                  aria-label={`Copy resume code for ${artifact.name}`}
                  className="pd-iconbtn"
                  onClick={() => void copyText(buildCheckpointResumeCode(artifact, run))}
                  title="Copy resume code"
                  type="button"
                >
                  <Copy size={12} />
                </button>
              ) : null}
              {artifact.type === "checkpoint" && onRequestFork ? (
                <button
                  aria-label={`Fork ${artifact.name}`}
                  className="pd-iconbtn"
                  onClick={() => onRequestFork(artifact)}
                  title="Fork from checkpoint"
                  type="button"
                >
                  <GitFork size={12} />
                </button>
              ) : null}
            </span>
          </div>
        )) : <div className="pd-side-empty"><p>No artifacts logged for this run.</p></div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fork dialog (existing checkpoint-fork flow, relocated)              */
/* ------------------------------------------------------------------ */

export function ForkCheckpointDialog({
  artifact,
  defaultName,
  onClose,
  onForkCheckpoint,
  run,
}: {
  artifact: Artifact;
  defaultName: string;
  onClose: () => void;
  onForkCheckpoint: (artifact: Artifact, options: ForkCheckpointOptions) => Promise<void>;
  run: RunSummary;
}) {
  const [forkName, setForkName] = useState(defaultName);
  const [forkReason, setForkReason] = useState("");
  const [inheritConfig, setInheritConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useFocusTrap<HTMLDivElement>(true, close, "#fork-run-name");

  function close() {
    if (!busy) onClose();
  }

  async function submitFork() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onForkCheckpoint(artifact, { inheritConfig, name: forkName, reason: forkReason });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create fork.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-modal checkpoint-fork-modal" role="dialog" aria-modal="true" aria-label="Fork checkpoint">
      <div className="workspace-modal-card checkpoint-fork-card" ref={dialogRef} tabIndex={-1}>
        <div className="drawer-head">
          <div>
            <span className="analysis-eyebrow eyebrow--accent">Fork checkpoint</span>
            <h2>{artifact.name}</h2>
          </div>
          <button aria-label="Close fork dialog" className="icon-button framed" disabled={busy} onClick={close} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="checkpoint-fork-body">
          <p className="checkpoint-fork-notice">InstantML creates a linked run record only. It does not start training.</p>
          <div className="checkpoint-fork-grid">
            <div><span>Source run</span><strong title={run.name}>{run.name}</strong></div>
            <div><span>Checkpoint step</span><strong>{checkpointStep(artifact) ?? "unknown"}</strong></div>
            <div><span>Checkpoint id</span><strong title={artifact.id}>{artifact.id}</strong></div>
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
          <button className="secondary" disabled={busy} onClick={close} type="button">Cancel</button>
          <button className="primary" disabled={busy || !forkName.trim()} onClick={() => void submitFork()} type="button">
            <GitFork size={14} /> {busy ? "Creating..." : "Create Fork"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts + timeline rails                                             */
/* ------------------------------------------------------------------ */

function dotTone(tone: string) {
  if (tone === "bad") return "pd-dot--crit";
  if (tone === "warn") return "pd-dot--warn";
  if (tone === "live" || tone === "good") return "pd-dot--ok";
  return "pd-dot--neutral";
}

export function RunAlertsPanel({ metricKey, run }: { metricKey: string; run: RunSummary }) {
  const rows = buildAlertRows([run], metricKey);
  return (
    <div className="pd-panel">
      <div className="pd-panel-head"><span className="pd-mlabel">Alerts on this run</span></div>
      <div className="pd-panel-flush">
        {rows.length ? rows.map((row) => (
          <div className="pd-feed-row" key={row.id}>
            <span className={`pd-dot ${dotTone(row.tone)}`} />
            <div className="pd-feed-body">
              <div className="pd-feed-title">{row.title}</div>
              <div className="pd-feed-meta"><span className="pd-tag">{row.label}</span> {row.detail}</div>
            </div>
          </div>
        )) : <div className="pd-side-empty"><p>No alerts for this run.</p></div>}
      </div>
    </div>
  );
}

export function RunTimelinePanel({ rows }: { rows: RunTimelineRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="pd-panel">
      <div className="pd-panel-head"><span className="pd-mlabel">Timeline</span></div>
      <div className="pd-panel-flush">
        {rows.map((row) => (
          <div className="pd-feed-row" key={row.id}>
            <span className={`pd-dot ${dotTone(row.tone)}`} />
            <div className="pd-feed-body">
              <div className="pd-feed-title">{row.label}</div>
              <div className="pd-feed-meta">{row.detail}</div>
            </div>
            <span className="pd-feed-time num">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview tab                                                        */
/* ------------------------------------------------------------------ */

export function OverviewTab({
  alertMetricKey,
  api,
  artifactCount,
  artifacts,
  charts,
  loadingSeries,
  onOpenLogs,
  onRequestFork,
  onRunMetadataSave,
  parent,
  run,
  running,
  timelineRows,
}: {
  alertMetricKey: string;
  api: ApiLike;
  artifactCount: number;
  artifacts: Artifact[];
  charts: OverviewChartSpec[];
  loadingSeries: boolean;
  onOpenLogs: () => void;
  onRequestFork?: (artifact: Artifact) => void;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  parent: RunSummary | null;
  run: RunSummary;
  running: boolean;
  timelineRows: RunTimelineRow[];
}) {
  const uploadHealth = uploadHealthForRun(run);
  const displayStatus = displayStatusForRun(run);
  const gridCharts = charts.filter((spec) => !spec.fullWidth);
  const wideCharts = charts.filter((spec) => spec.fullWidth);
  return (
    <div className="pd-grid">
      <div className="pd-col-main">
        {uploadHealth.state === "incomplete" || uploadHealth.state === "errors" || uploadHealth.state === "stale" ? (
          <div className={`run-data-banner ${uploadHealth.tone}`} role="status">
            <strong>{uploadHealth.state === "stale" ? "Upload stalled." : "Metrics may be incomplete."}</strong>
            <span>{uploadHealth.detail}</span>
          </div>
        ) : null}
        {displayStatus === "failed" ? (
          <section className="failure-card">
            <strong>Failed run triage</strong>
            <div><span>Last metric step</span><b>{lastMetricStep(run)}</b></div>
            <div><span>Likely reason</span><b>{compactValue(run.metadata.error ?? run.metadata.exit_reason ?? "No failure reason logged")}</b></div>
            <div><span>Checkpoint coverage</span><b>{formatNumber(run.artifact_counts?.checkpoint ?? 0, 0)} checkpoints</b></div>
          </section>
        ) : null}
        {gridCharts.length ? (
          <div className="pd-chartgrid">
            {gridCharts.map((spec) => <ChartPanel key={spec.key} loading={loadingSeries} spec={spec} />)}
          </div>
        ) : (
          <div className="pd-panel"><div className="pd-side-empty"><p>No metrics logged for this run yet.</p></div></div>
        )}
        {wideCharts.map((spec) => <ChartPanel key={spec.key} loading={loadingSeries} spec={spec} />)}
        <LogTailPanel api={api} onOpenLogs={onOpenLogs} run={run} running={running} />
      </div>
      <aside className="pd-col-side">
        <ConfigPanel parent={parent} run={run} />
        <CheckpointsPanel artifacts={artifacts} onRequestFork={onRequestFork} run={run} totalCount={artifactCount} />
        <RunAlertsPanel metricKey={alertMetricKey} run={run} />
        <RunTimelinePanel rows={timelineRows} />
        <div className="pd-panel pd-panel--editor">
          <RunMetadataEditor compact onSave={onRunMetadataSave} run={run} title="Run tags and notes" />
        </div>
      </aside>
    </div>
  );
}
