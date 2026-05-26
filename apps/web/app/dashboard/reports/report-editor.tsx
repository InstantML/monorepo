"use client";

import { useCallback, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import {
  CalloutBlock,
  CodeBlock,
  defaultBlock,
  HeadingBlock,
  HorizontalRuleBlock,
  ImageBlock,
  LlmSummaryBlock,
  MarkdownBlock,
  PanelGridBlock,
  ParagraphBlock,
} from "./block-types";
import type {
  ReportBlock,
  ReportBlockKind,
  ReportRecord,
} from "./block-types";

type EditorReport = Pick<
  ReportRecord,
  "id" | "title" | "description" | "blocks" | "visibility"
>;

type Props = {
  report: EditorReport;
  saving?: boolean;
  refreshingBlockIndex?: number | null;
  onChange: (next: EditorReport) => void;
  onSave?: () => void;
  onRefreshBlock?: (blockIndex: number) => void;
};

const BLOCK_PALETTE: { kind: ReportBlockKind; label: string }[] = [
  { kind: "heading", label: "Heading" },
  { kind: "paragraph", label: "Paragraph" },
  { kind: "markdown", label: "Markdown" },
  { kind: "code", label: "Code" },
  { kind: "callout", label: "Callout" },
  { kind: "horizontal_rule", label: "Divider" },
  { kind: "image", label: "Image" },
  { kind: "panel_grid", label: "PanelGrid" },
  { kind: "llm_summary", label: "LLM summary" },
];

/**
 * Notion-style block editor. We keep the surface deliberately simple for
 * v1: one block per row, explicit move-up / move-down buttons, an insert
 * picker after each block. Drag-to-reorder is a v1.5 polish.
 */
export function ReportEditor({
  report,
  saving = false,
  refreshingBlockIndex,
  onChange,
  onSave,
  onRefreshBlock,
}: Props) {
  const [paletteOpenAt, setPaletteOpenAt] = useState<number | null>(null);
  const replaceBlock = useCallback(
    (index: number, next: ReportBlock) => {
      const blocks = report.blocks.map((block, current) =>
        current === index ? next : block,
      );
      onChange({ ...report, blocks });
    },
    [report, onChange],
  );
  const insertBlock = useCallback(
    (index: number, kind: ReportBlockKind) => {
      const next = [...report.blocks];
      next.splice(index, 0, defaultBlock(kind));
      onChange({ ...report, blocks: next });
      setPaletteOpenAt(null);
    },
    [report, onChange],
  );
  const removeBlock = useCallback(
    (index: number) => {
      const next = report.blocks.filter((_, current) => current !== index);
      onChange({ ...report, blocks: next });
    },
    [report, onChange],
  );
  const moveBlock = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= report.blocks.length) return;
      const next = [...report.blocks];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      onChange({ ...report, blocks: next });
    },
    [report, onChange],
  );
  return (
    <div className="report-editor">
      <header className="report-editor__head">
        <label className="report-block__label" htmlFor="report-title">
          Title
        </label>
        <input
          id="report-title"
          className="report-editor__title"
          value={report.title}
          placeholder="Untitled report"
          onChange={(event) => onChange({ ...report, title: event.target.value })}
        />
        <label className="report-block__label" htmlFor="report-description">
          Description (optional)
        </label>
        <input
          id="report-description"
          className="report-editor__description"
          value={report.description ?? ""}
          placeholder="One-line summary"
          onChange={(event) =>
            onChange({ ...report, description: event.target.value })
          }
        />
        <div className="report-editor__visibility">
          <label className="report-block__label">Visibility</label>
          <select
            className="report-block__select"
            value={report.visibility}
            onChange={(event) =>
              onChange({
                ...report,
                visibility: event.target.value as ReportRecord["visibility"],
              })
            }
          >
            <option value="private">Private — only you</option>
            <option value="org">Organization — your team</option>
            <option value="public">Public — anyone with the link</option>
          </select>
        </div>
        {onSave ? (
          <div className="report-editor__actions">
            <button
              type="button"
              className="report-editor__primary"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        ) : null}
      </header>

      <div className="report-editor__blocks">
        <InsertSlot
          openAt={paletteOpenAt}
          index={0}
          onOpen={(index) => setPaletteOpenAt(index)}
          onInsert={(kind) => insertBlock(0, kind)}
        />
        {report.blocks.map((block, index) => (
          <div className="report-editor__block-wrap" key={index}>
            <div className="report-editor__block-controls">
              <span className="report-editor__block-kind">{block.kind}</span>
              <button
                type="button"
                className="report-editor__control"
                aria-label="Move block up"
                disabled={index === 0}
                onClick={() => moveBlock(index, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="report-editor__control"
                aria-label="Move block down"
                disabled={index === report.blocks.length - 1}
                onClick={() => moveBlock(index, 1)}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className="report-editor__control report-editor__control--danger"
                aria-label="Delete block"
                onClick={() => removeBlock(index)}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <BlockEditor
              block={block}
              busy={refreshingBlockIndex === index}
              onChange={(next) => replaceBlock(index, next)}
              onRefresh={
                block.kind === "llm_summary" && onRefreshBlock
                  ? () => onRefreshBlock(index)
                  : undefined
              }
            />
            <InsertSlot
              openAt={paletteOpenAt}
              index={index + 1}
              onOpen={(slot) => setPaletteOpenAt(slot)}
              onInsert={(kind) => insertBlock(index + 1, kind)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function InsertSlot({
  openAt,
  index,
  onOpen,
  onInsert,
}: {
  openAt: number | null;
  index: number;
  onOpen: (slot: number | null) => void;
  onInsert: (kind: ReportBlockKind) => void;
}) {
  const open = openAt === index;
  return (
    <div className="report-editor__insert">
      {open ? (
        <div className="report-editor__palette">
          {BLOCK_PALETTE.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className="report-editor__palette-item"
              onClick={() => onInsert(entry.kind)}
            >
              {entry.label}
            </button>
          ))}
          <button
            type="button"
            className="report-editor__palette-item report-editor__palette-item--cancel"
            onClick={() => onOpen(null)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="report-editor__insert-btn"
          onClick={() => onOpen(index)}
          aria-label={`Insert block at position ${index}`}
        >
          + Insert block
        </button>
      )}
    </div>
  );
}

function BlockEditor({
  block,
  busy,
  onChange,
  onRefresh,
}: {
  block: ReportBlock;
  busy: boolean;
  onChange: (next: ReportBlock) => void;
  onRefresh?: () => void;
}) {
  switch (block.kind) {
    case "heading":
      return <HeadingBlock block={block} onChange={onChange} />;
    case "paragraph":
      return <ParagraphBlock block={block} onChange={onChange} />;
    case "markdown":
      return <MarkdownBlock block={block} onChange={onChange} />;
    case "code":
      return <CodeBlock block={block} onChange={onChange} />;
    case "callout":
      return <CalloutBlock block={block} onChange={onChange} />;
    case "horizontal_rule":
      return <HorizontalRuleBlock />;
    case "image":
      return <ImageBlock block={block} onChange={onChange} />;
    case "panel_grid":
      return <PanelGridBlock block={block} onChange={onChange} />;
    case "llm_summary":
      return (
        <LlmSummaryBlock
          block={block}
          busy={busy}
          onChange={onChange}
          onRefresh={onRefresh}
        />
      );
  }
}
