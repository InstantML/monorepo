"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";

import {
  CalloutBlock,
  CodeBlock,
  defaultBlock,
  HorizontalRuleBlock,
  ImageBlock,
  LlmSummaryBlock,
  MarkdownBlock,
  PanelGridBlock,
  ParagraphBlock,
  HeadingBlock,
} from "./block-types";
import type {
  HeadingBlockData,
  PanelGridBlockData,
  ParagraphBlockData,
  MarkdownBlockData,
  ReportBlock,
  ReportBlockKind,
  ReportRecord,
} from "./block-types";
import { BlockPicker } from "./block-types/block-picker";
import {
  detectSlashTrigger,
  filterBlockPicker,
  BLOCK_PICKER_CATALOG,
  resolvePickerKind,
} from "./slash-command";

type EditorReport = Pick<
  ReportRecord,
  "id" | "title" | "description" | "blocks" | "visibility"
>;

type Props = {
  report: EditorReport;
  refreshingBlockIndex?: number | null;
  /** When true the title input auto-focuses on mount (new-report flow). */
  autoFocusTitle?: boolean;
  /**
   * Read-only surface (used by the public `/r/<token>` share view). When set
   * all inputs are inert, no slash menu, no drag handles, no controls, no
   * auto-save scheduling. The DOM still matches the editor — same single
   * renderer per block — so visual fidelity stays the same.
   */
  readOnly?: boolean;
  onChange?: (next: EditorReport) => void;
  onRefreshBlock?: (blockIndex: number) => void;
  /**
   * Cmd-Z handlers. Wired by the parent (which owns the history stack);
   * the editor only listens for the keystroke. When `readOnly` is set the
   * handlers are ignored (no undo on the public share view).
   */
  onUndo?: () => void;
  onRedo?: () => void;
};

interface SlashMenuState {
  blockIndex: number;
  query: string;
  caretAnchor: { top: number; left: number } | null;
  triggerOffset: number;
}

/**
 * Walk the block list and return every PanelGrid except the host index.
 * Each candidate is labeled with the nearest preceding heading's text, so
 * the "From this report" tab is human-readable.
 */
function collectSiblingPanelGrids(
  blocks: ReportBlock[],
  hostIndex: number,
): { blockIndex: number; label: string; block: PanelGridBlockData }[] {
  const candidates: { blockIndex: number; label: string; block: PanelGridBlockData }[] = [];
  let lastHeading: string | null = null;
  let gridCount = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind === "heading") {
      lastHeading = (block as HeadingBlockData).text || lastHeading;
    } else if (block.kind === "panel_grid") {
      gridCount += 1;
      if (i !== hostIndex) {
        const grid = block as PanelGridBlockData;
        const label = lastHeading
          ? `${lastHeading} (PanelGrid #${gridCount})`
          : `PanelGrid #${gridCount}`;
        candidates.push({ blockIndex: i, label, block: grid });
      }
    }
  }
  return candidates;
}

/**
 * One-mode (inline-editing) block editor. Every block renders with the
 * exact typography of its published form; focusing reveals a cursor, hover
 * reveals controls (drag handle + delete + per-block knobs). There is no
 * separate "preview" mode — the same surface is the editor and the viewer.
 *
 * Five interaction behaviors:
 *
 *   - Hover-line `+` between every adjacent pair of blocks opens the same
 *     BlockPicker the slash command uses.
 *   - `/` inside a paragraph / markdown / heading text input opens a
 *     floating picker anchored to the caret.
 *   - Drag handle (`⋮⋮`) on the left edge supports HTML5 drag-and-drop.
 *   - Cmd/Ctrl+Shift+↑/↓ moves the focused block.
 *   - Empty editor renders a single centered `+` affordance.
 *
 * Auto-save lives in the parent (reports-tab-pane) — the editor is a
 * controlled component; every `onChange` triggers a debounce there.
 *
 * In `readOnly` mode all of the above is suppressed; the same DOM and
 * styling render but inputs are inert (this is what powers `/r/<token>`).
 */
export function ReportEditor({
  report,
  refreshingBlockIndex,
  autoFocusTitle = false,
  readOnly = false,
  onChange,
  onRefreshBlock,
  onUndo,
  onRedo,
}: Props) {
  const [gapPickerAt, setGapPickerAt] = useState<number | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!readOnly && autoFocusTitle && titleRef.current) titleRef.current.focus();
  }, [autoFocusTitle, readOnly]);

  // Global Cmd-Z / Cmd-Shift-Z (and Cmd-Y) handler. Our React-controlled
  // inputs don't participate in the browser's native undo stack, so we
  // can safely preempt it. Suppressed in `readOnly` mode (public share
  // view) and when the slash menu is open (so Arrow keys + Enter still
  // pick a block).
  useEffect(() => {
    if (readOnly) return;
    if (!onUndo && !onRedo) return;
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      const isUndoCombo = key === "z" && !event.shiftKey;
      const isRedoCombo = (key === "z" && event.shiftKey) || key === "y";
      if (!isUndoCombo && !isRedoCombo) return;
      // If the slash menu is open we let its handler win — Enter / arrows
      // shouldn't trigger undo even though they share a modifier key.
      if (slashMenu) return;
      event.preventDefault();
      if (isUndoCombo) {
        onUndo?.();
      } else {
        onRedo?.();
      }
    };
    // Capture-phase so we run BEFORE the focused textarea/input fires its
    // native undo, which would otherwise consume Cmd-Z and leave our React
    // history untouched. We preventDefault to suppress the native behavior
    // entirely; our undo stack is the only one that knows about cross-block
    // structural changes anyway.
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [readOnly, onUndo, onRedo, slashMenu]);

  // Auto-size the description textarea so it grows with content (no resize
  // grip, no visible scrollbar — matches the at-rest paragraph rhythm).
  const autoSizeDescription = useCallback(() => {
    const el = descriptionRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => {
    autoSizeDescription();
  }, [report.description, autoSizeDescription]);

  // ── Controlled-update helpers (no-ops in readOnly) ──────────────────────
  const emit = useCallback(
    (next: EditorReport) => {
      if (readOnly) return;
      onChange?.(next);
    },
    [onChange, readOnly],
  );

  const replaceBlock = useCallback(
    (index: number, next: ReportBlock) => {
      const blocks = report.blocks.map((block, current) =>
        current === index ? next : block,
      );
      emit({ ...report, blocks });
    },
    [report, emit],
  );

  const insertBlockAt = useCallback(
    (index: number, block: ReportBlock) => {
      const next = [...report.blocks];
      next.splice(index, 0, block);
      emit({ ...report, blocks: next });
    },
    [report, emit],
  );

  const insertKindAt = useCallback(
    (index: number, kind: ReportBlockKind, headingLevel?: 1 | 2 | 3) => {
      const block = defaultBlock(kind);
      if (kind === "heading" && headingLevel) {
        (block as HeadingBlockData).level = headingLevel;
        (block as HeadingBlockData).text = "";
      }
      insertBlockAt(index, block);
    },
    [insertBlockAt],
  );

  const removeBlock = useCallback(
    (index: number) => {
      const next = report.blocks.filter((_, current) => current !== index);
      emit({ ...report, blocks: next });
    },
    [report, emit],
  );

  const moveBlock = useCallback(
    (from: number, to: number) => {
      if (from === to || to < 0 || to >= report.blocks.length) return;
      const next = [...report.blocks];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      emit({ ...report, blocks: next });
    },
    [report, emit],
  );

  const handlePickerSelect = useCallback(
    (id: string, index: number) => {
      const resolved = resolvePickerKind(id);
      if (!resolved) return;
      insertKindAt(index, resolved.kind, resolved.headingLevel);
      setGapPickerAt(null);
    },
    [insertKindAt],
  );

  // ── Slash-command handler ─────────────────────────────────────────────────
  // Called by paragraph/markdown/heading inputs after every keystroke. Looks
  // for a `/` on the active line and opens / updates the floating picker.
  const handleTextChange = useCallback(
    (
      blockIndex: number,
      element: HTMLInputElement | HTMLTextAreaElement,
      committedText: string,
    ) => {
      if (readOnly) return;
      const caret = element.selectionStart ?? committedText.length;
      const trigger = detectSlashTrigger(committedText, caret);
      if (!trigger.active) {
        setSlashMenu(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      setSlashMenu({
        blockIndex,
        query: trigger.query,
        triggerOffset: trigger.triggerOffset,
        caretAnchor: { top: rect.top + rect.height + 6, left: rect.left + 8 },
      });
    },
    [readOnly],
  );

  // When the slash menu picks an entry: strip the `/query` text from the
  // source input and swap the block kind in place. This is the "convert
  // current block" UX users expect — typing `/h1` on an empty
  // paragraph turns it into a Heading 1.
  const commitSlashPick = useCallback(
    (id: string) => {
      if (!slashMenu) return;
      const resolved = resolvePickerKind(id);
      if (!resolved) return;
      const current = report.blocks[slashMenu.blockIndex];
      if (!current) return;
      const isTextBlock =
        current.kind === "paragraph" ||
        current.kind === "markdown" ||
        current.kind === "heading";
      const stripFrom = (text: string) =>
        text.slice(0, slashMenu.triggerOffset) +
        text.slice(slashMenu.triggerOffset + 1 + slashMenu.query.length);
      let stripped: ReportBlock = current;
      if (isTextBlock) {
        const text =
          current.kind === "paragraph"
            ? (current as ParagraphBlockData).text
            : current.kind === "markdown"
              ? (current as MarkdownBlockData).text
              : (current as HeadingBlockData).text;
        stripped = {
          ...current,
          text: stripFrom(text),
        } as ReportBlock;
      }
      const isEmpty =
        isTextBlock &&
        (stripped.kind === "paragraph" ||
          stripped.kind === "markdown" ||
          stripped.kind === "heading") &&
        (
          (stripped as ParagraphBlockData | MarkdownBlockData | HeadingBlockData).text
        ).trim().length === 0;
      const newBlock = (() => {
        const b = defaultBlock(resolved.kind);
        if (resolved.kind === "heading" && resolved.headingLevel) {
          (b as HeadingBlockData).level = resolved.headingLevel;
          (b as HeadingBlockData).text = "";
        }
        return b;
      })();
      if (isEmpty) {
        const next = report.blocks.map((block, current2) =>
          current2 === slashMenu.blockIndex ? newBlock : block,
        );
        emit({ ...report, blocks: next });
      } else {
        const next = [...report.blocks];
        next.splice(slashMenu.blockIndex, 1, stripped);
        next.splice(slashMenu.blockIndex + 1, 0, newBlock);
        emit({ ...report, blocks: next });
      }
      setSlashMenu(null);
    },
    [slashMenu, report, emit],
  );

  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashMenu?.query]);

  const handleSlashKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!slashMenu) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenu(null);
        return true;
      }
      const entries = filterBlockPicker(slashMenu.query, BLOCK_PICKER_CATALOG);
      if (entries.length === 0) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % entries.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex(
          (current) => (current - 1 + entries.length) % entries.length,
        );
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const pick = entries[slashActiveIndex];
        if (pick) commitSlashPick(pick.id);
        return true;
      }
      return false;
    },
    [slashMenu, slashActiveIndex, commitSlashPick],
  );

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const onDragStart = useCallback((index: number) => {
    setDragSourceIndex(index);
  }, []);
  const onDragEnd = useCallback(() => {
    setDragSourceIndex(null);
    setDropIndex(null);
  }, []);
  const onDropAtGap = useCallback(
    (gapIndex: number) => {
      if (dragSourceIndex === null) return;
      let target = gapIndex;
      if (dragSourceIndex < gapIndex) target = gapIndex - 1;
      if (target === dragSourceIndex) {
        setDragSourceIndex(null);
        setDropIndex(null);
        return;
      }
      moveBlock(dragSourceIndex, target);
      setDragSourceIndex(null);
      setDropIndex(null);
    },
    [dragSourceIndex, moveBlock],
  );

  // Keyboard reorder: Cmd/Ctrl+Shift+Arrow. Esc blurs the focused element.
  const onBlockKeyDown = useCallback(
    (index: number, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || !event.shiftKey) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveBlock(index, index - 1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveBlock(index, index + 1);
      }
    },
    [moveBlock],
  );

  const rootClass = `report-editor${readOnly ? " report-editor--readonly" : ""}`;

  return (
    <div className={rootClass}>
      <header className="report-editor__head">
        <input
          ref={titleRef}
          id="report-title"
          className="report-editor__title"
          value={report.title}
          placeholder="Untitled report"
          readOnly={readOnly}
          onChange={(event) => emit({ ...report, title: event.target.value })}
          aria-label="Report title"
        />
        <textarea
          ref={descriptionRef}
          id="report-description"
          className="report-editor__description"
          value={report.description ?? ""}
          placeholder="One-line summary"
          rows={1}
          readOnly={readOnly}
          onChange={(event) => emit({ ...report, description: event.target.value })}
          onInput={autoSizeDescription}
          aria-label="Report description"
        />
        {!readOnly ? (
          <div className="report-editor__visibility">
            <label className="report-block__label" htmlFor="report-visibility">
              Visibility
            </label>
            <select
              id="report-visibility"
              className="report-block__select"
              value={report.visibility}
              onChange={(event) =>
                emit({
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
        ) : null}
      </header>

      <div className="report-editor__blocks">
        {report.blocks.length === 0 && !readOnly ? (
          <EmptyEditorPrompt onPick={(id) => handlePickerSelect(id, 0)} />
        ) : null}
        {!readOnly ? (
          <HoverGap
            index={0}
            open={gapPickerAt === 0}
            dropActive={dragSourceIndex !== null && dropIndex === 0}
            onOpen={() => setGapPickerAt(0)}
            onDismiss={() => setGapPickerAt(null)}
            onPick={(id) => handlePickerSelect(id, 0)}
            onDragOver={() => setDropIndex(0)}
            onDragLeave={() =>
              setDropIndex((current) => (current === 0 ? null : current))
            }
            onDrop={() => onDropAtGap(0)}
            dragActive={dragSourceIndex !== null}
          />
        ) : null}
        {report.blocks.map((block, index) => {
          const isDragging = dragSourceIndex === index;
          const siblingsForGrid =
            block.kind === "panel_grid"
              ? collectSiblingPanelGrids(report.blocks, index)
              : undefined;
          return (
            <div key={index}>
              <BlockRow
                block={block}
                index={index}
                refreshing={refreshingBlockIndex === index}
                dragging={isDragging}
                readOnly={readOnly}
                onChange={(next) => replaceBlock(index, next)}
                onRemove={() => removeBlock(index)}
                onRefresh={
                  block.kind === "llm_summary" && onRefreshBlock
                    ? () => onRefreshBlock(index)
                    : undefined
                }
                onDragStart={() => onDragStart(index)}
                onDragEnd={onDragEnd}
                onKeyDown={(event) => onBlockKeyDown(index, event)}
                onTextChange={(element, text) =>
                  handleTextChange(index, element, text)
                }
                onSlashKeyDown={handleSlashKeyDown}
                slashOpen={slashMenu?.blockIndex === index}
                siblingPanelGrids={siblingsForGrid}
              />
              {!readOnly ? (
                <HoverGap
                  index={index + 1}
                  open={gapPickerAt === index + 1}
                  dropActive={
                    dragSourceIndex !== null && dropIndex === index + 1
                  }
                  onOpen={() => setGapPickerAt(index + 1)}
                  onDismiss={() => setGapPickerAt(null)}
                  onPick={(id) => handlePickerSelect(id, index + 1)}
                  onDragOver={() => setDropIndex(index + 1)}
                  onDragLeave={() =>
                    setDropIndex((current) =>
                      current === index + 1 ? null : current,
                    )
                  }
                  onDrop={() => onDropAtGap(index + 1)}
                  dragActive={dragSourceIndex !== null}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {!readOnly && slashMenu && slashMenu.caretAnchor ? (
        <div
          className="block-picker-floating"
          style={
            {
              top: slashMenu.caretAnchor.top,
              left: slashMenu.caretAnchor.left,
            } as CSSProperties
          }
          role="dialog"
          aria-label="Slash command palette"
        >
          <SlashMenuList
            query={slashMenu.query}
            activeIndex={slashActiveIndex}
            onHover={setSlashActiveIndex}
            onPick={(id) => commitSlashPick(id)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Internal components ─────────────────────────────────────────────────────

function EmptyEditorPrompt({ onPick }: { onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="report-editor__empty">
      {open ? (
        <BlockPicker
          variant="inline"
          onPick={(id) => {
            setOpen(false);
            onPick(id);
          }}
          onDismiss={() => setOpen(false)}
        />
      ) : (
        <button
          type="button"
          className="report-editor__empty-button"
          onClick={() => setOpen(true)}
          aria-label="Add your first block"
        >
          <Plus size={16} aria-hidden="true" />
          <span>
            Type <kbd>/</kbd> or click + to add your first block
          </span>
        </button>
      )}
    </div>
  );
}

function HoverGap({
  index,
  open,
  dropActive,
  dragActive,
  onOpen,
  onDismiss,
  onPick,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  index: number;
  open: boolean;
  dropActive: boolean;
  dragActive: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onPick: (id: string) => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}) {
  return (
    <div
      className={`report-block-handle-zone${dropActive ? " report-block-handle-zone--drop" : ""}${dragActive ? " report-block-handle-zone--drag" : ""}`}
      onDragOver={(event) => {
        if (!dragActive) return;
        event.preventDefault();
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        if (!dragActive) return;
        event.preventDefault();
        onDrop();
      }}
    >
      {open ? (
        <div className="block-picker-anchor">
          <BlockPicker
            variant="inline"
            onPick={(id) => onPick(id)}
            onDismiss={onDismiss}
          />
        </div>
      ) : (
        <button
          type="button"
          className="report-block-handle-zone__add"
          onClick={onOpen}
          aria-label={`Insert block at position ${index}`}
          title="Click to add block (or type /)"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      )}
      <span className="report-block-drop-indicator" aria-hidden="true" />
    </div>
  );
}

function BlockRow({
  block,
  index,
  refreshing,
  dragging,
  readOnly,
  onChange,
  onRemove,
  onRefresh,
  onDragStart,
  onDragEnd,
  onKeyDown,
  onTextChange,
  onSlashKeyDown,
  slashOpen,
  siblingPanelGrids,
}: {
  block: ReportBlock;
  index: number;
  refreshing: boolean;
  dragging: boolean;
  readOnly: boolean;
  onChange: (next: ReportBlock) => void;
  onRemove: () => void;
  onRefresh?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onTextChange: (
    element: HTMLInputElement | HTMLTextAreaElement,
    text: string,
  ) => void;
  onSlashKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => boolean;
  slashOpen: boolean;
  siblingPanelGrids?: {
    blockIndex: number;
    label: string;
    block: import("./block-types/types").PanelGridBlockData;
  }[];
}) {
  const wrapClass = `report-editor__block-wrap${dragging ? " report-editor__block-wrap--dragging" : ""}${readOnly ? " report-editor__block-wrap--readonly" : ""}`;
  return (
    <div className={wrapClass} tabIndex={-1} onKeyDown={onKeyDown}>
      {!readOnly ? (
        <>
          <div
            className="report-block-handle"
            draggable
            onDragStart={(event) => {
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", `block:${index}`);
              }
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            title="Drag to reorder (or Cmd/Ctrl+Shift+↑/↓)"
            aria-label={`Drag block ${index + 1}`}
          >
            <GripVertical size={14} aria-hidden="true" />
          </div>
          <div className="report-editor__block-controls">
            <span className="report-editor__block-kind">
              {block.kind.replace("_", " ")}
            </span>
            <button
              type="button"
              className="report-editor__control report-editor__control--danger"
              aria-label="Delete block"
              onClick={onRemove}
              title="Delete block"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </>
      ) : null}
      <BlockBody
        block={block}
        busy={refreshing}
        slashOpen={slashOpen}
        readOnly={readOnly}
        onChange={onChange}
        onTextChange={onTextChange}
        onSlashKeyDown={onSlashKeyDown}
        onRefresh={onRefresh}
        siblingPanelGrids={siblingPanelGrids}
      />
    </div>
  );
}

function BlockBody({
  block,
  busy,
  slashOpen,
  readOnly,
  onChange,
  onTextChange,
  onSlashKeyDown,
  onRefresh,
  siblingPanelGrids,
}: {
  block: ReportBlock;
  busy: boolean;
  slashOpen: boolean;
  readOnly: boolean;
  onChange: (next: ReportBlock) => void;
  onTextChange: (
    element: HTMLInputElement | HTMLTextAreaElement,
    text: string,
  ) => void;
  onSlashKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => boolean;
  onRefresh?: () => void;
  siblingPanelGrids?: {
    blockIndex: number;
    label: string;
    block: import("./block-types/types").PanelGridBlockData;
  }[];
}) {
  // Read-only path: pass straight through to the block components' readOnly
  // rendering. They already render the published view.
  if (readOnly) {
    switch (block.kind) {
      case "heading":
        return <HeadingBlock block={block as HeadingBlockData} readOnly />;
      case "paragraph":
        return <ParagraphBlock block={block as ParagraphBlockData} readOnly />;
      case "markdown":
        return <MarkdownBlock block={block as MarkdownBlockData} readOnly />;
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
  // Editable path. Text blocks (paragraph / markdown / heading) get the
  // slash-command-aware wrapper so users can type `/h2` to convert. Other
  // blocks render their normal editor.
  switch (block.kind) {
    case "heading":
      return (
        <HeadingTextWrap
          block={block as HeadingBlockData}
          onChange={onChange}
          onTextChange={onTextChange}
          onSlashKeyDown={onSlashKeyDown}
          slashOpen={slashOpen}
        />
      );
    case "paragraph":
      return (
        <ParagraphTextWrap
          block={block as ParagraphBlockData}
          onChange={onChange}
          onTextChange={onTextChange}
          onSlashKeyDown={onSlashKeyDown}
          slashOpen={slashOpen}
        />
      );
    case "markdown":
      return (
        <MarkdownBlock
          block={block as MarkdownBlockData}
          onChange={(next) => onChange(next)}
        />
      );
    case "code":
      return <CodeBlock block={block} onChange={onChange} />;
    case "callout":
      return <CalloutBlock block={block} onChange={onChange} />;
    case "horizontal_rule":
      return <HorizontalRuleBlock />;
    case "image":
      return <ImageBlock block={block} onChange={onChange} />;
    case "panel_grid":
      return (
        <PanelGridBlock
          block={block}
          onChange={onChange}
          siblingPanelGrids={siblingPanelGrids}
        />
      );
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

// Slash-aware wrappers — these duplicate the rendering of HeadingBlock /
// ParagraphBlock in editable mode, but with an `onKeyDown` and `onInput`
// hook that lets the editor watch the caret for `/`.

function ParagraphTextWrap({
  block,
  onChange,
  onTextChange,
  onSlashKeyDown,
  slashOpen,
}: {
  block: ParagraphBlockData;
  onChange: (next: ReportBlock) => void;
  onTextChange: (
    element: HTMLInputElement | HTMLTextAreaElement,
    text: string,
  ) => void;
  onSlashKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => boolean;
  slashOpen: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const autoSize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => {
    autoSize();
  }, [block.text, autoSize]);
  return (
    <textarea
      ref={ref}
      className="report-block__textarea report-block__textarea--paragraph"
      rows={1}
      value={block.text}
      placeholder="Type / for commands, or write a paragraph…"
      onChange={(event) => {
        const next = { ...block, text: event.target.value };
        onChange(next);
        onTextChange(event.currentTarget, event.target.value);
      }}
      onInput={autoSize}
      onKeyDown={(event) => {
        if (slashOpen) {
          if (onSlashKeyDown(event)) return;
        }
      }}
      aria-label="Paragraph text"
    />
  );
}

function HeadingTextWrap({
  block,
  onChange,
  onTextChange,
  onSlashKeyDown,
  slashOpen,
}: {
  block: HeadingBlockData;
  onChange: (next: ReportBlock) => void;
  onTextChange: (
    element: HTMLInputElement | HTMLTextAreaElement,
    text: string,
  ) => void;
  onSlashKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => boolean;
  slashOpen: boolean;
}) {
  const headingClass =
    block.level === 1
      ? "report-block__heading-input report-block__heading-input--h1"
      : block.level === 2
        ? "report-block__heading-input report-block__heading-input--h2"
        : "report-block__heading-input report-block__heading-input--h3";
  return (
    <div className="report-block report-block--heading report-block--inline">
      <div className="report-block__heading-controls">
        <select
          className="report-block__select report-block__select--inline"
          value={block.level}
          onChange={(event) =>
            onChange({ ...block, level: Number(event.target.value) as 1 | 2 | 3 })
          }
          aria-label="Heading level"
        >
          <option value={1}>H1</option>
          <option value={2}>H2</option>
          <option value={3}>H3</option>
        </select>
      </div>
      <input
        className={headingClass}
        value={block.text}
        placeholder={`Heading ${block.level}`}
        onChange={(event) => {
          const next = { ...block, text: event.target.value };
          onChange(next);
          onTextChange(event.currentTarget, event.target.value);
        }}
        onKeyDown={(event) => {
          if (slashOpen) {
            if (onSlashKeyDown(event)) return;
          }
        }}
        aria-label="Heading text"
      />
    </div>
  );
}

function SlashMenuList({
  query,
  activeIndex,
  onHover,
  onPick,
}: {
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (id: string) => void;
}) {
  const entries = useMemo(
    () => filterBlockPicker(query, BLOCK_PICKER_CATALOG),
    [query],
  );
  if (entries.length === 0) {
    return <div className="block-picker__empty">No blocks match “{query}”</div>;
  }
  return (
    <div className="block-picker__list" role="listbox">
      {entries.map((entry, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={entry.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`block-picker__row${active ? " block-picker__row--active" : ""}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(entry.id);
            }}
          >
            <span className="block-picker__copy">
              <span className="block-picker__label">{entry.label}</span>
              {entry.hint ? (
                <span className="block-picker__hint">{entry.hint}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export { BLOCK_PICKER_CATALOG };
