"use client";

import { Bot, Copy, ExternalLink, PlugZap, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { buildAgentSetupSnippets, type AgentClientId } from "./agent-setup-snippets";

type Props = {
  canManageOrg: boolean;
  newApiKey: string;
  onCreateAgentKeyName: () => void;
};

async function copyText(value: string) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function AgentSetupPanel({ canManageOrg, newApiKey, onCreateAgentKeyName }: Props) {
  const snippets = useMemo(() => buildAgentSetupSnippets(canManageOrg ? newApiKey : ""), [canManageOrg, newApiKey]);
  const [activeClient, setActiveClient] = useState<AgentClientId>("claude-code");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const activeSnippet = snippets.find((snippet) => snippet.id === activeClient) ?? snippets[0]!;
  const hasCopyOnceKey = Boolean(canManageOrg && newApiKey);

  async function handleCopy() {
    const copied = await copyText(activeSnippet.body);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <section className="agent-setup-card" aria-label="Connect agent">
      <div className="agent-setup-card__head">
        <span className="agent-setup-card__icon"><Bot size={16} /></span>
        <div>
          <strong>Connect Agent</strong>
          <p>{hasCopyOnceKey ? "Use the new copy-once key in one of these setup snippets." : "Create an Agent MCP key, then copy a setup snippet."}</p>
        </div>
      </div>
      <div className="agent-setup-actions">
        {canManageOrg ? (
          <button className="secondary" type="button" onClick={onCreateAgentKeyName}>
            <PlugZap size={14} /> Use Agent MCP key name
          </button>
        ) : null}
        <a className="secondary" href="/docs/sdk/agent-mcp">
          <ExternalLink size={14} /> Docs
        </a>
      </div>
      <div className="agent-client-tabs" role="tablist" aria-label="Agent client setup">
        {snippets.map((snippet) => (
          <button
            aria-selected={activeClient === snippet.id}
            className={activeClient === snippet.id ? "active" : ""}
            key={snippet.id}
            onClick={() => setActiveClient(snippet.id)}
            role="tab"
            type="button"
          >
            {snippet.label}
          </button>
        ))}
      </div>
      <div className="agent-snippet-panel" role="tabpanel">
        <div className="agent-snippet-panel__bar">
          <span><TerminalSquare size={13} /> {activeSnippet.filename}</span>
          <button className="copy-button" type="button" onClick={() => void handleCopy()}>
            <Copy size={13} /> {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </button>
        </div>
        <pre>{activeSnippet.body}</pre>
      </div>
    </section>
  );
}
