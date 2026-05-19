"use client";

import { Copy } from "lucide-react";

import type { ApiRow } from "../../dashboard-types";

function copyText(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

export function ApiTable({ rows }: { rows: ApiRow[] }) {
  return (
    <div className="api-list">
      {rows.map((row) => (
        <article className="api-row" key={`${row.method}-${row.path}`}>
          <span>{row.method}</span>
          <code>{row.path}</code>
          <small>{row.description}</small>
          <button className="copy-button" type="button" onClick={() => copyText(`${row.method} ${row.path}`)}><Copy size={13} /> Copy</button>
        </article>
      ))}
    </div>
  );
}
