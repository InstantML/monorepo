"use client";

import type { CodePanelData } from "../types";

/**
 * Inline code panel — same visual as the top-level CodeBlock but contained
 * inside a PanelGrid cell. Read-only render path; editing happens via the
 * PanelEditor toolbar that owns the panel spec.
 */
export function CodePanelRenderer({ panel }: { panel: CodePanelData }) {
  return (
    <pre className={`panel-chart panel-chart--code language-${panel.language}`}>
      <code>{panel.code}</code>
    </pre>
  );
}
