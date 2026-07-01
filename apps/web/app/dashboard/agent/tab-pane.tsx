"use client";

import { Activity, BarChart3, Copy, FileBarChart, Package, Search, Telescope } from "lucide-react";
import { useMemo, useState } from "react";

import { AgentSetupPanel } from "../api/agent-setup";
import { PageHead } from "../ui/page-head";

type Props = {
  canManageOrg: boolean;
  metricKey: string;
  newApiKey: string;
  primaryRunId: string | null;
  project: string;
  selectedRunIds: string[];
};

const capabilityGroups = [
  { icon: Search, title: "Discover runs", body: "Find runs by project, status, tags, notes, and saved workspace context." },
  { icon: BarChart3, title: "Compare metrics", body: "Rank selected runs, inspect bounded series, and explain metric deltas." },
  { icon: Package, title: "Trace artifacts", body: "Inspect checkpoints, files, lineage, and safe artifact previews." },
  { icon: FileBarChart, title: "Author reports", body: "Draft persisted experiment readouts from selected runs and panels." },
];

async function copyText(value: string) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function AgentTabPane({
  canManageOrg,
  metricKey,
  newApiKey,
  primaryRunId,
  project,
  selectedRunIds,
}: Props) {
  const [copiedPrompt, setCopiedPrompt] = useState("");
  const visibleNewApiKey = canManageOrg ? newApiKey : "";
  const projectLabel = project || "all projects";
  const selectionLabel = selectedRunIds.length ? `${selectedRunIds.length} selected runs` : "the current run page";
  const promptStarters = useMemo(() => [
    `Compare ${selectionLabel} in ${projectLabel} by ${metricKey} and summarize the strongest run with evidence.`,
    `Inspect artifacts and checkpoint lineage for ${primaryRunId ? `run ${primaryRunId}` : "the primary selected run"} and draft a reproducibility note.`,
    `Find failed or stalled runs in ${projectLabel}, group them by likely cause, and create a short report.`,
  ], [metricKey, primaryRunId, projectLabel, selectionLabel]);

  async function handleCopy(prompt: string) {
    const copied = await copyText(prompt);
    setCopiedPrompt(copied ? prompt : "failed");
    window.setTimeout(() => setCopiedPrompt(""), 1800);
  }

  return (
    <>
      <PageHead title="Agent" />
      <div className="tab-grid two-col agent-tab-grid">
        <section className="panel agent-connect-panel">
          <div className="panel-head">
            <h2><Telescope size={15} /> Connect</h2>
          </div>
          <div className="panel-body admin-stack">
            <AgentSetupPanel canManageOrg={canManageOrg} newApiKey={visibleNewApiKey} />
          </div>
        </section>

        <section className="panel agent-capabilities-panel">
          <div className="panel-head">
            <h2><Activity size={15} /> Agent Workspace</h2>
          </div>
          <div className="panel-body agent-workspace-stack">
            <div className="agent-capability-grid" aria-label="Agent capabilities">
              {capabilityGroups.map(({ icon: Icon, title, body }) => (
                <article className="agent-capability-card" key={title}>
                  <Icon size={16} />
                  <strong>{title}</strong>
                  <p>{body}</p>
                </article>
              ))}
            </div>

            <section className="agent-prompt-section" aria-label="Prompt starters">
              <div className="panel-subhead">
                <strong>Prompt starters</strong>
              </div>
              <div className="agent-prompt-list">
                {promptStarters.map((prompt) => (
                  <article className="api-row agent-prompt-row" key={prompt}>
                    <code>{prompt}</code>
                    <button className="copy-button" type="button" onClick={() => void handleCopy(prompt)}>
                      <Copy size={13} /> {copiedPrompt === prompt ? "Copied" : copiedPrompt === "failed" ? "Copy failed" : "Copy"}
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </section>
      </div>
    </>
  );
}
