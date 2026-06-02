"use client";

import { Copy } from "lucide-react";
import { useState } from "react";

import type { ApiRow } from "../../dashboard-types";

async function copyText(value: string) {
  if (!value) return false;
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    // Clipboard permission can be denied in local/dev browser contexts. The
    // route text stays visible so users can select it manually.
    return false;
  }
}

export function ApiTable({ rows }: { rows: ApiRow[] }) {
  const [copyState, setCopyState] = useState<Record<string, "copied" | "failed">>({});
  async function handleCopy(row: ApiRow) {
    const key = `${row.method}-${row.path}`;
    const copied = await copyText(`${row.method} ${row.path}`);
    setCopyState((current) => ({ ...current, [key]: copied ? "copied" : "failed" }));
    window.setTimeout(() => {
      setCopyState((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 1800);
  }

  return (
    <div className="api-list">
      {rows.map((row) => {
        const key = `${row.method}-${row.path}`;
        const state = copyState[key];
        return (
          <article className="api-row" key={key}>
            <span>{row.method}</span>
            <code>{row.path}</code>
            <small>{row.description}</small>
            <button className="copy-button" type="button" onClick={() => void handleCopy(row)}>
              <Copy size={13} /> {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
            </button>
            {state ? (
              <span className="visually-hidden" role={state === "failed" ? "alert" : "status"} aria-live="polite">
                {state === "copied" ? `${row.method} ${row.path} copied.` : `Copy failed for ${row.method} ${row.path}. Select the route text manually.`}
              </span>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
