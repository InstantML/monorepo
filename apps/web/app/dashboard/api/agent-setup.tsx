"use client";

import { Copy, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { buildAgentSetupSnippets, type AgentAuthMode, type AgentClientId } from "./agent-setup-snippets";
import { ClientLogo } from "./client-logos";

type Props = {
  canManageOrg: boolean;
  newApiKey: string;
};

const AUTH_MODES: { id: AgentAuthMode; label: string; preview?: boolean }[] = [
  { id: "oauth", label: "Browser sign-in", preview: true },
  { id: "api-key", label: "API key" },
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

export function AgentSetupPanel({ canManageOrg, newApiKey }: Props) {
  const [authMode, setAuthMode] = useState<AgentAuthMode>("oauth");
  const [activeClient, setActiveClient] = useState<AgentClientId>("claude-code");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const apiKey = canManageOrg ? newApiKey : "";
  const snippets = useMemo(() => buildAgentSetupSnippets(apiKey, authMode), [apiKey, authMode]);
  const activeSnippet = snippets.find((snippet) => snippet.id === activeClient) ?? snippets[0]!;
  const hasCopyOnceKey = Boolean(apiKey);

  async function handleCopy() {
    const copied = await copyText(activeSnippet.body);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  const note =
    authMode === "oauth"
      ? "Your agent opens a browser to sign in to InstantML on first connect — no key to copy, rotate, or commit."
      : hasCopyOnceKey
        ? "Using the copy-once key above. It is shown once, so store it in a secrets manager."
        : canManageOrg
          ? "Create an Agent MCP key in Workspace settings -> API and this snippet fills in the key for you."
          : "Use browser sign-in, or ask a workspace admin for an API key.";

  return (
    <section className="agent-setup-card" aria-label="Connect agent">
      <header className="agent-setup-card__head">
        <strong>Connect an agent</strong>
        <p>Point your coding agent at the InstantML MCP server to inspect, compare, and report on runs.</p>
      </header>

      <div className="agent-auth-toggle" role="radiogroup" aria-label="Authentication method">
        {AUTH_MODES.map((mode) => (
          <button
            aria-checked={authMode === mode.id}
            className={authMode === mode.id ? "active" : ""}
            key={mode.id}
            onClick={() => setAuthMode(mode.id)}
            role="radio"
            type="button"
          >
            {mode.label}
            {mode.preview ? <span className="agent-auth-toggle__tag">Preview</span> : null}
          </button>
        ))}
      </div>

      <div className="agent-client-grid" role="tablist" aria-label="Agent client">
        {snippets.map((snippet) => (
          <button
            aria-selected={activeClient === snippet.id}
            className={`agent-client-tile ${activeClient === snippet.id ? "active" : ""}`}
            key={snippet.id}
            onClick={() => setActiveClient(snippet.id)}
            role="tab"
            type="button"
          >
            <ClientLogo client={snippet.id} size={22} />
            <span>{snippet.label}</span>
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

      <p className="agent-setup-card__note">{note}</p>
    </section>
  );
}
