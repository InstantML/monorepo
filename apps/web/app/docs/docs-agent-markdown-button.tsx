"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type DocsAgentMarkdownButtonProps = {
  href: string;
};

export function DocsAgentMarkdownButton({ href }: DocsAgentMarkdownButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function copyMarkdown() {
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) return;
      await navigator.clipboard.writeText(await response.text());
    } catch {
      return;
    }
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCopied(true);
    timeoutRef.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button className="docs-route-agent-copy" onClick={copyMarkdown} type="button">
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied .md" : "Copy .md for agent"}
    </button>
  );
}
