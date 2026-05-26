"use client";

import {
  CalloutBlock,
  CodeBlock,
  HeadingBlock,
  HorizontalRuleBlock,
  ImageBlock,
  LlmSummaryBlock,
  MarkdownBlock,
  PanelGridBlock,
  ParagraphBlock,
} from "./block-types";
import type { ReportBlock, ReportRecord } from "./block-types";

type Props = {
  report: ReportRecord;
};

/**
 * Read-only rendering of a report. Used for in-dashboard view mode and for
 * the public `/r/:share_token` route — the same component, no editor chrome.
 */
export function ReportViewer({ report }: Props) {
  return (
    <article className="report-viewer">
      <header className="report-viewer__head">
        <h1 className="report-viewer__title">{report.title}</h1>
        {report.description ? (
          <p className="report-viewer__description">{report.description}</p>
        ) : null}
        <div className="report-viewer__meta">
          <span>Visibility · {report.visibility}</span>
          <span>Updated · {new Date(report.updated_at).toLocaleString()}</span>
        </div>
      </header>
      <div className="report-viewer__blocks">
        {report.blocks.map((block, index) => (
          <section className="report-viewer__block" key={index}>
            <RenderBlock block={block} />
          </section>
        ))}
      </div>
    </article>
  );
}

function RenderBlock({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case "heading":
      return <HeadingBlock block={block} readOnly />;
    case "paragraph":
      return <ParagraphBlock block={block} readOnly />;
    case "markdown":
      return <MarkdownBlock block={block} readOnly />;
    case "code":
      return <CodeBlock block={block} readOnly />;
    case "callout":
      return <CalloutBlock block={block} readOnly />;
    case "horizontal_rule":
      return <HorizontalRuleBlock readOnly />;
    case "image":
      return <ImageBlock block={block} readOnly />;
    case "panel_grid":
      return <PanelGridBlock block={block} readOnly />;
    case "llm_summary":
      return <LlmSummaryBlock block={block} readOnly />;
  }
}
