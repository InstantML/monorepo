"use client";

import { ArrowRight, Check, Copy, Terminal } from "lucide-react";
import { useEffect, useState } from "react";

// First-run SDK snippet for the empty-workspace state. Shows the pip line,
// a copy-pasteable Python training loop, a "Copy" button, an "Or import
// from W&B / MLflow / Neptune" link to the Integrations tab, and a "Copy
// with your key" action that substitutes the user's onboarding key from
// sessionStorage when available.
//
// Triggered from `runs/tab-pane.tsx` when the workspace has zero runs and
// zero projects — i.e., a cold-start user just landed in the dashboard.
// Surfaces the UI-audit P1 gap: "fresh user signs up, lands in the
// dashboard, has no idea how to log their first run" (docs/design/
// 2026-05-19-ui-audit.md § "Can a fresh user sign up and produce a chart
// in 5 minutes?").

const ONBOARDING_KEY_STORAGE = "instantml_onboarding_key";
const API_KEY_PLACEHOLDER = "<YOUR_API_KEY>";
const PIP_LINE = "pip install instantml";

function buildSnippet(apiKey: string): string {
  return [
    "import instantml as im",
    "import random",
    "",
    "run = im.init(",
    "    project=\"my-first-project\",",
    "    config={\"lr\": 3e-4, \"model\": \"transformer-7b\"},",
    `    api_key="${apiKey}",`,
    ")",
    "",
    "for step in range(100):",
    "    run.log({\"train/loss\": 2.0 * (0.95 ** step) + random.gauss(0, 0.05)}, step=step)",
    "",
    "run.finish()",
  ].join("\n");
}

function readStashedKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(ONBOARDING_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type CopiedKind = "snippet" | "snippet-with-key" | "pip" | null;

export function EmptyWorkspaceSnippet({ orgName }: { orgName: string }) {
  const [stashedKey, setStashedKey] = useState("");
  const [copied, setCopied] = useState<CopiedKind>(null);

  useEffect(() => {
    setStashedKey(readStashedKey());
  }, []);

  useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(handle);
  }, [copied]);

  const placeholderSnippet = buildSnippet(API_KEY_PLACEHOLDER);
  const hasKey = Boolean(stashedKey);

  async function onCopySnippet() {
    if (await writeClipboard(placeholderSnippet)) setCopied("snippet");
  }
  async function onCopySnippetWithKey() {
    if (!hasKey) return;
    if (await writeClipboard(buildSnippet(stashedKey))) setCopied("snippet-with-key");
  }
  async function onCopyPip() {
    if (await writeClipboard(PIP_LINE)) setCopied("pip");
  }

  return (
    <section className="empty-workspace-snippet" aria-label="First run setup">
      <header className="empty-workspace-snippet__head">
        <strong>{orgName ? `${orgName} is empty.` : "This workspace is empty."}</strong>
        <span>Log your first run with the InstantML SDK — three calls, no daemon.</span>
      </header>

      <div className="empty-workspace-snippet__pip">
        <span className="empty-workspace-snippet__step">1. Install</span>
        <code>{PIP_LINE}</code>
        <button className="copy-button" onClick={onCopyPip} type="button">
          {copied === "pip" ? <Check size={13} /> : <Copy size={13} />}
          {copied === "pip" ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="iml-term empty-workspace-snippet__term">
        <div className="iml-term-bar">
          <span className="tl"><Terminal size={11} aria-hidden="true" /> 2. Paste into train.py</span>
          <span className="sp" />
          <button className="iml-copy" onClick={onCopySnippet} type="button">
            {copied === "snippet" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "snippet" ? "Copied" : "Copy"}
          </button>
          <button
            className="iml-copy empty-workspace-snippet__copy-key"
            disabled={!hasKey}
            onClick={onCopySnippetWithKey}
            title={hasKey ? "Copy snippet with your onboarding API key already substituted" : "Available right after you create your first SDK key"}
            type="button"
          >
            {copied === "snippet-with-key" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "snippet-with-key" ? "Copied with key" : "Copy with your key"}
          </button>
        </div>
        <pre className="iml-term-body empty-workspace-snippet__code"><code>{placeholderSnippet}</code></pre>
      </div>

      <footer className="empty-workspace-snippet__foot">
        <span>
          Replace <code>{API_KEY_PLACEHOLDER}</code> with the key from{" "}
          <a className="empty-workspace-snippet__link" href="/dashboard/api">API tab</a>
          {hasKey ? " — or use “Copy with your key” above" : ""}.
        </span>
        <a className="empty-workspace-snippet__import" href="/dashboard/integrations">
          Or import from W&amp;B / MLflow / Neptune <ArrowRight size={12} aria-hidden="true" />
        </a>
      </footer>
    </section>
  );
}
