"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type DocsCodeBlockProps = {
  code: string;
  language: string;
};

export function DocsCodeBlock({ code, language }: DocsCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return clearCopiedTimer;
  }, []);

  function clearCopiedTimer() {
    const timeout = timeoutRef.current;
    if (timeout) clearTimeout(timeout);
    timeoutRef.current = null;
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    clearCopiedTimer();
    setCopied(true);
    timeoutRef.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="docs-route-code">
      <div className="docs-route-code-toolbar">
        <span className="docs-route-code-label">{language}</span>
        <button aria-label="Copy code snippet" className="docs-route-code-copy" onClick={copyCode} type="button">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
