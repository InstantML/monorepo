"use client";

import { Activity, BarChart3, BookOpen, Copy, Download, FileBarChart, LayoutPanelTop, Package, Search, Telescope } from "lucide-react";
import { useMemo, useState } from "react";

import { AgentSetupPanel } from "../api/agent-setup";
import { copyDocsMarkdown } from "../../docs/docs-agent-markdown-button";
import { PageHead } from "../ui/page-head";

type Props = {
  activeOrgId: string;
  canManageOrg: boolean;
  metricKey: string;
  newApiKey: string;
  primaryRunId: string | null;
  project: string;
  selectedRunIds: string[];
};

// Grouped view of the MCP surface in tools/mcp-server-tools.mjs; tool names are
// the `tracker.*` suffixes agents call. Keep in sync with docs/sdk/agent-run-analysis.md.
const capabilityGroups = [
  {
    icon: Search,
    title: "Discover runs",
    body: "Find runs by project, status, tags, notes, and saved workspace context.",
    tools: ["list_projects", "list_runs", "get_run"],
  },
  {
    icon: BarChart3,
    title: "Compare metrics",
    body: "Rank selected runs, inspect bounded series, and explain metric deltas.",
    tools: ["compare_matching_runs", "compare_runs", "list_metrics", "query_metrics", "get_metric_series_batch"],
  },
  {
    icon: Package,
    title: "Trace artifacts",
    body: "Inspect checkpoints, files, lineage, and safe artifact previews.",
    tools: ["list_run_artifacts", "resolve_artifact_version", "get_artifact_lineage", "get_run_lineage", "list_artifact_collections", "list_artifact_versions", "list_artifact_manifest"],
  },
  {
    icon: FileBarChart,
    title: "Author reports",
    body: "Draft persisted experiment readouts from selected runs and panels.",
    tools: ["create_report", "update_report", "share_report", "list_reports", "add_panel_to_report"],
  },
  {
    icon: Download,
    title: "Export evidence",
    body: "Pull bounded JSON or CSV run exports and portable report Markdown.",
    tools: ["export_runs", "export_report_markdown"],
  },
  {
    icon: LayoutPanelTop,
    title: "Read workspace views",
    body: "Resolve saved workspace views and org panels into bounded panel data.",
    tools: ["workspace_view_data", "list_org_panels"],
  },
];

const VISIBLE_TOOL_CHIPS = 3;
const AGENT_GUIDE_PATH = "/docs/sdk/agent-mcp";

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
  activeOrgId,
  canManageOrg,
  metricKey,
  newApiKey,
  primaryRunId,
  project,
  selectedRunIds,
}: Props) {
  const [copiedPrompt, setCopiedPrompt] = useState("");
  const [guideCopyState, setGuideCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const visibleNewApiKey = canManageOrg ? newApiKey : "";
  const projectLabel = project || "all projects";
  const selectionLabel = selectedRunIds.length ? `${selectedRunIds.length} selected runs` : "the current run page";
  const promptStarters = useMemo(() => [
    `Compare ${selectionLabel} in ${projectLabel} by ${metricKey} and summarize the strongest run with evidence.`,
    `Inspect artifacts and checkpoint lineage for ${primaryRunId ? `run ${primaryRunId}` : "the primary selected run"} and draft a reproducibility note.`,
    `Find failed or stalled runs in ${projectLabel}, group them by likely cause, and create a short report.`,
    `Create a report comparing ${selectionLabel} in ${projectLabel} by ${metricKey}, cite the evidence, and share it with a link.`,
  ], [metricKey, primaryRunId, projectLabel, selectionLabel]);

  async function handleCopy(prompt: string) {
    const copied = await copyText(prompt);
    setCopiedPrompt(copied ? prompt : "failed");
    window.setTimeout(() => setCopiedPrompt(""), 1800);
  }

  async function handleCopyGuide() {
    const copied = await copyDocsMarkdown(`${AGENT_GUIDE_PATH}.md`);
    setGuideCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setGuideCopyState("idle"), 1800);
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
            <AgentSetupPanel activeOrgId={activeOrgId} canManageOrg={canManageOrg} newApiKey={visibleNewApiKey} />
            <div className="agent-guide-row">
              <button className="secondary compact-button" type="button" onClick={() => void handleCopyGuide()}>
                <Copy size={13} /> {guideCopyState === "copied" ? "Copied guide" : guideCopyState === "failed" ? "Copy failed" : "Copy guide for your agent"}
              </button>
              <a className="secondary compact-button" href={AGENT_GUIDE_PATH} rel="noreferrer" target="_blank">
                <BookOpen size={13} /> Open agent docs
              </a>
            </div>
          </div>
        </section>

        <section className="panel agent-capabilities-panel">
          <div className="panel-head">
            <h2><Activity size={15} /> Agent Workspace</h2>
          </div>
          <div className="panel-body agent-workspace-stack">
            <div className="agent-capability-grid" aria-label="Agent capabilities">
              {capabilityGroups.map(({ icon: Icon, title, body, tools }) => {
                const expanded = Boolean(expandedTools[title]);
                const visibleTools = expanded ? tools : tools.slice(0, VISIBLE_TOOL_CHIPS);
                return (
                  <article className="agent-capability-card" key={title}>
                    <Icon size={16} />
                    <strong>{title}</strong>
                    <p>{body}</p>
                    <p className="agent-capability-tools">
                      {visibleTools.map((tool) => (
                        <code key={tool} title={`tracker.${tool}`}>{tool}</code>
                      ))}
                      {tools.length > VISIBLE_TOOL_CHIPS ? (
                        <button
                          aria-label={expanded ? `Collapse ${title} tools` : `Show ${tools.length - VISIBLE_TOOL_CHIPS} more ${title} tools`}
                          aria-expanded={expanded}
                          className="agent-capability-tools-toggle"
                          type="button"
                          onClick={() => setExpandedTools((prev) => ({ ...prev, [title]: !expanded }))}
                        >
                          {expanded ? "less" : `+${tools.length - VISIBLE_TOOL_CHIPS} more`}
                        </button>
                      ) : null}
                    </p>
                  </article>
                );
              })}
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
