"use client";

import { Check, Clipboard, Download, FileArchive, GitBranch, RefreshCw, ShieldCheck, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { components } from "../../../src/types/api.generated";

type ImportJob = components["schemas"]["ImportJobRow"];
type ImportsEnvelope = components["schemas"]["ImportsEnvelope"];
type ImportJobEnvelope = components["schemas"]["ImportJobEnvelope"];

type ApiLike = {
  get<T extends object = Record<string, unknown>>(path: string, options?: Record<string, unknown>): Promise<T>;
  post<T extends object = Record<string, unknown>>(path: string, body?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
};

type Props = {
  api: ApiLike;
  project: string;
};

// The dry-run workflow stepper. Choosing a source and generating the bundle
// happen up front (a source is always selected here), so the live actionable
// stage is the dry run; commit follows once a job is ready below.
const IMPORT_STEPS = ["Choose source", "Generate bundle", "Dry run", "Commit import"];
const IMPORT_ACTIVE_STEP = 2;

const sources = [
  { id: "wandb", label: "Weights & Biases", status: "CLI ready", icon: GitBranch, capabilities: ["Runs", "Metrics", "Artifacts", "Config", "Tags"] },
  { id: "neptune", label: "Neptune Exporter", status: "CLI ready", icon: FileArchive, capabilities: ["Runs", "Metrics", "Params", "Tags"] },
  { id: "tensorboard", label: "TensorBoard", status: "CLI ready", icon: UploadCloud, capabilities: ["Scalar events"] },
  { id: "mlflow", label: "MLflow legacy", status: "Available", icon: Download, capabilities: ["Runs", "Metrics", "Artifacts"] },
];

export function ImportsTabPane({ api, project }: Props) {
  const [mode, setMode] = useState<"import" | "dual" | "adapters">("import");
  const [source, setSource] = useState("wandb");
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState("");
  const [actionJobId, setActionJobId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const activeSource = sources.find((item) => item.id === source) ?? sources[0];
  const cliCommand = useMemo(() => {
    const target = shellQuote(project || "my-project");
    if (source === "wandb") return `instantml import wandb --project ${target} --entity my-team --source-project old-project --dry-run`;
    if (source === "neptune") return `instantml import neptune --project ${target} --input ./neptune-export/data --files-path ./neptune-export/files --source-project ${shellQuote("workspace/project")} --dry-run`;
    if (source === "tensorboard") return `instantml sync tensorboard ./runs --project ${target} --dry-run`;
    return `instantml import mlflow --project ${target} --input mlflow-export.json --source-project ${shellQuote("mlflow-export")} --dry-run`;
  }, [project, source]);

  async function loadJobs(showLoading = false) {
    if (showLoading) setJobsLoading(true);
    try {
      const payload = await api.get<ImportsEnvelope>("/api/imports");
      setJobs(Array.isArray(payload?.imports) ? payload.imports : []);
      setJobsError("");
    } catch {
      setJobsError("Import jobs are unavailable right now.");
    } finally {
      setJobsLoaded(true);
      setJobsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const payload = await api.get<ImportsEnvelope>("/api/imports");
        if (!cancelled) {
          setJobs(Array.isArray(payload?.imports) ? payload.imports : []);
          setJobsError("");
        }
      } catch {
        if (!cancelled) setJobsError("Import jobs are unavailable right now.");
      } finally {
        if (!cancelled) {
          setJobsLoaded(true);
          setJobsLoading(false);
        }
      }
    }
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api]);

  async function copyCommand() {
    const copied = await copyText(cliCommand);
    setMessage(copied ? "Command copied." : "Copy failed. Select and copy the command manually.");
  }

  async function runJobAction(job: ImportJob, action: "commit" | "cancel") {
    const summary = summarizeJob(job);
    const retrying = action === "commit" && job.status === "failed";
    const ok = window.confirm(
      action === "commit"
        ? `${retrying ? "Retry" : "Commit"} import #${job.id}? This will write ${summary.runs} runs and ${summary.metrics} metric points.`
        : `Cancel import #${job.id}? This cannot be undone.`,
    );
    if (!ok) return;
    setActionJobId(job.id);
    setMessage("");
    try {
      await api.post<ImportJobEnvelope>(`/api/imports/jobs/${job.id}/${action}`);
      setMessage(action === "commit" ? "Import commit started." : "Import job cancelled.");
      await loadJobs(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Failed to ${action} import job.`);
    } finally {
      setActionJobId(null);
    }
  }

  return (
    <div className="imports-tab">
      <header className="imports-head">
        <div>
          <h1>Imports & Integrations</h1>
          <p>Move existing experiment history into InstantML without handing third-party tokens to the server.</p>
        </div>
        <button className="secondary compact-button imports-refresh-button" type="button" onClick={() => void loadJobs(true)} aria-label="Refresh import jobs">
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      <div className="imports-modes" role="group" aria-label="Import workflow mode">
        <button className={mode === "import" ? "active" : ""} aria-pressed={mode === "import"} onClick={() => setMode("import")} type="button">Import</button>
        <button className={mode === "dual" ? "active" : ""} aria-pressed={mode === "dual"} onClick={() => setMode("dual")} type="button">Live dual logging</button>
        <button className={mode === "adapters" ? "active" : ""} aria-pressed={mode === "adapters"} onClick={() => setMode("adapters")} type="button">Framework adapters</button>
      </div>

      {mode === "import" ? (
        <div className="imports-grid">
          <aside className="imports-sources" aria-label="Import sources">
            {sources.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={source === item.id ? "source active" : "source"} type="button" onClick={() => setSource(item.id)}>
                  <Icon size={22} />
                  <span>
                    <strong>{item.label}</strong>
                    <em>{item.status}</em>
                  </span>
                  <small>{item.capabilities.join(" · ")}</small>
                </button>
              );
            })}
          </aside>

          <section className="imports-workflow" aria-label="Import dry-run workflow">
            <ol className="imports-steps" aria-label="Import workflow">
              {IMPORT_STEPS.map((label, index) => {
                const state = index < IMPORT_ACTIVE_STEP ? "is-done" : index === IMPORT_ACTIVE_STEP ? "is-current" : "";
                return (
                  <li className={`imports-step ${state}`.trim()} key={label} aria-current={state === "is-current" ? "step" : undefined}>
                    <span className="imports-step-marker" aria-hidden="true">
                      {index < IMPORT_ACTIVE_STEP ? <Check size={13} /> : index + 1}
                    </span>
                    <span className="imports-step-label">{label}</span>
                    {state ? <span className="visually-hidden">{state === "is-done" ? " (completed)" : " (current step)"}</span> : null}
                  </li>
                );
              })}
            </ol>
            <div className="imports-panel">
              <div className="imports-panel-head">
                <div>
                  <h2>{activeSource.label}</h2>
                  <p>Run this locally to create a dry-run job with real source chunks.</p>
                </div>
                <button className="primary-button" type="button" onClick={copyCommand}>
                  <Clipboard size={15} /> Copy command
                </button>
              </div>
              <div className="imports-command">
                <code>{cliCommand}</code>
                <button className="icon-button" type="button" onClick={copyCommand} aria-label="Copy import command">
                  <Clipboard size={15} />
                </button>
              </div>
              <div className="imports-security">
                <ShieldCheck size={16} />
                <span>Tokens stay local. Dry-run happens before commit. Unsupported fields become warnings.</span>
              </div>
              {message ? <p className="imports-message" role="status">{message}</p> : null}
            </div>
          </section>

          <aside className="imports-mapping" aria-label="Schema mapping">
            <h2>Schema mapping</h2>
            <dl>
              <div><dt>run_id</dt><dd>metadata.import.external_run_id</dd></div>
              <div><dt>config</dt><dd>run config</dd></div>
              <div><dt>history / scalars</dt><dd>metric_points</dd></div>
              <div><dt>artifacts / files</dt><dd>artifact references</dd></div>
              <div><dt>tags / notes</dt><dd>run metadata</dd></div>
            </dl>
          </aside>
        </div>
      ) : mode === "dual" ? (
        <SnippetPanel
          title="Dual-log to W&B and InstantML"
          command={'run = im.init(project="demo", shadow_wandb=True)\nrun.log({"train/loss": 0.12}, step=1)\nrun.finish()'}
        />
      ) : (
        <SnippetPanel
          title="Framework adapters"
          command={'from instantml import InstantMLLogger, InstantMLCallback, InstantMLKerasCallback\n# Lightning: Trainer(logger=InstantMLLogger(project="demo"))\n# HF: Trainer(callbacks=[InstantMLCallback(project="demo")])\n# Keras: model.fit(..., callbacks=[InstantMLKerasCallback(project="demo")])'}
        />
      )}

      <section className="imports-jobs" aria-label="Recent import jobs">
        <h2>Recent import jobs</h2>
        {jobsError ? <p className="imports-message imports-message--error" role="alert">{jobsError}</p> : null}
        {!jobsLoading && jobsLoaded && jobs.length === 0 && !jobsError ? (
          <div className="imports-jobs-empty">
            <FileArchive size={22} aria-hidden="true" />
            <p>No import jobs yet</p>
            <span>Run a dry-run command above to create your first import job — it will appear here.</span>
          </div>
        ) : (
        <div className="imports-table-scroll">
          <table>
            <thead>
              <tr><th>Source</th><th>Project</th><th>Runs</th><th>Points</th><th>Warnings</th><th>Status</th><th>Started</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {jobsLoading && !jobsLoaded ? (
                <tr><td colSpan={8}>Loading import jobs...</td></tr>
              ) : jobs.length ? jobs.map((job) => {
                const canCommit = job.status === "dry_run_ready" || (job.status === "failed" && job.progress?.resumable === true);
                const commitLabel = job.status === "failed" ? "Retry" : "Commit";
                const canCancel = !["committed", "completed", "cancelled", "committing"].includes(job.status);
                const commitDisabledReason = actionJobId === job.id
                  ? "Import action is in progress."
                  : canCommit
                    ? `${commitLabel} import #${job.id}`
                    : `Import #${job.id} is ${job.status}; only dry-run-ready or resumable failed jobs can be committed.`;
                const cancelDisabledReason = actionJobId === job.id
                  ? "Import action is in progress."
                  : canCancel
                    ? `Cancel import #${job.id}`
                    : `Import #${job.id} is ${job.status} and can no longer be cancelled.`;
                const summary = summarizeJob(job);
                return (
                  <tr key={job.id}>
                    <td>{job.source_type}</td>
                    <td>{job.target_project ?? project}</td>
                    <td>{String(summary.runs)}</td>
                    <td>{String(summary.metrics)}</td>
                    <td>{String(job.warnings?.length ?? job.summary?.warnings ?? 0)}</td>
                    <td><span className={`imports-status imports-status--${job.status}`}>{job.status}</span></td>
                    <td>{job.created_at ? new Date(job.created_at).toLocaleString() : "-"}</td>
	                    <td>
	                      <div className="imports-actions">
	                        <button type="button" onClick={() => runJobAction(job, "commit")} disabled={actionJobId === job.id || !canCommit} title={commitDisabledReason}>
	                          {commitLabel}
	                        </button>
	                        <button type="button" onClick={() => runJobAction(job, "cancel")} disabled={actionJobId === job.id || !canCancel} title={cancelDisabledReason}>
	                          Cancel
	                        </button>
	                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={8}>No import jobs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}
        {jobs.some((job) => job.warnings?.length) ? (
          <div className="imports-warnings" aria-label="Import warnings">
            {jobs.flatMap((job) => (job.warnings ?? []).slice(0, 3).map((warning) => (
              <p key={`${job.id}-${String(warning.code ?? warning.message ?? "warning")}`}>
                <strong>{job.source_type} #{job.id}</strong>: {String(warning.message ?? warning.code ?? "Warning")}
              </p>
            )))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SnippetPanel({ title, command }: { title: string; command: string }) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  async function copy() {
    if (await copyText(command)) {
      setCopyState("copied");
    } else {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState(null), 1600);
  }
  return (
    <section className="imports-panel imports-snippet">
      <div className="imports-panel-head">
        <div>
          <h2>{title}</h2>
          <p>Keep the training-loop hot path async and process-zero by default.</p>
        </div>
        <button className="icon-button" type="button" onClick={copy} aria-label="Copy snippet">
          <Clipboard size={15} />
        </button>
      </div>
      <pre><code>{command}</code></pre>
      {copyState ? <p className="imports-message" role={copyState === "failed" ? "alert" : "status"} aria-live="polite">{copyState === "copied" ? "Snippet copied." : "Copy failed. Select and copy the snippet manually."}</p> : null}
    </section>
  );
}

function summarizeJob(job: ImportJob) {
  return {
    runs: Number(job.summary?.runs ?? 0),
    metrics: Number(job.summary?.metrics ?? 0),
  };
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
