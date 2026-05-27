"use client";

import { MarkdownBlock } from "../markdown-block";
import type { MarkdownPanelData } from "../types";

/**
 * Inline markdown panel — used inside a PanelGrid cell for prose / commentary
 * sitting next to charts. Delegates rendering to the existing MarkdownBlock
 * so we stay consistent with top-level markdown blocks.
 */
export function MarkdownPanelRenderer({ panel }: { panel: MarkdownPanelData }) {
  return (
    <div className="panel-chart panel-chart--markdown">
      <MarkdownBlock block={{ kind: "markdown", text: panel.text }} readOnly />
    </div>
  );
}
