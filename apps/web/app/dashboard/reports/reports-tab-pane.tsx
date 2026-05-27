"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, FileText, Plus, Sparkles, Trash2 } from "lucide-react";

import { ApiClient } from "../../../src/api.js";
import {
  createReport,
  deleteReport,
  fetchReport,
  listReports,
  patchReport,
  refreshReportBlock,
  reportMarkdownUrl,
  rotateReportShareToken,
} from "../../../src/reports-api.js";
import { PageHead } from "../ui/page-head";
import { ReportEditor } from "./report-editor";
import { AutoSavePill } from "./auto-save-pill";
import type { AutoSaveStatus } from "./auto-save-pill";
import { createAutoSaveScheduler } from "./auto-save";
import type { ReportRecord, ReportSummary } from "./block-types";

type Mode =
  | { kind: "list" }
  | { kind: "open"; reportId: string; autoFocus?: boolean };

const AUTO_SAVE_DELAY_MS = 800;

interface SavePayload {
  title: string;
  description: string;
  visibility: ReportRecord["visibility"];
  blocks: ReportRecord["blocks"];
}

/**
 * Top-level Reports tab. Owns the list + editor flow plus the auto-save
 * scheduler. There is exactly one editing surface — the editor is always
 * interactive, no separate "preview" mode (matching the inline-editing
 * pattern of modern doc tools). The editor itself is a controlled
 * component that fires `onChange` for every edit; this pane debounces
 * those into one PATCH per 800 ms of quiet.
 */
export function ReportsTabPane() {
  const api = useMemo(() => new ApiClient(), []);
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [activeReport, setActiveReport] = useState<ReportRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingBlockIndex, setRefreshingBlockIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState<AutoSaveStatus>({ state: "idle" });

  // Per-editor auto-save scheduler. Recreated each time we open a new
  // report so the cleanup of the previous one doesn't fire after we mount
  // its replacement.
  const schedulerRef = useRef<ReturnType<typeof createAutoSaveScheduler<SavePayload>> | null>(null);
  // Latest payload that the editor handed us. Used by the retry button.
  const lastPayloadRef = useRef<SavePayload | null>(null);
  // First-render guard — we don't auto-save on the initial mount.
  const hasUserEditedRef = useRef(false);

  const loadList = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { reports } = await listReports(api);
      setSummaries(reports);
    } catch (loadError) {
      setError(messageFromError(loadError));
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadReport = useCallback(
    async (reportId: string) => {
      setBusy(true);
      setError(null);
      try {
        const report = await fetchReport(api, reportId);
        setActiveReport(report);
        setAutoSave({ state: "idle" });
        hasUserEditedRef.current = false;
      } catch (loadError) {
        setError(messageFromError(loadError));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  // Build (or rebuild) the scheduler whenever we open a new report id.
  useEffect(() => {
    if (mode.kind !== "open") {
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
      return;
    }
    const reportId = mode.reportId;
    const scheduler = createAutoSaveScheduler<SavePayload>({
      delayMs: AUTO_SAVE_DELAY_MS,
      flush: async (payload) => {
        setAutoSave({ state: "saving" });
        try {
          const updated = await patchReport(api, reportId, payload);
          if (updated) {
            setActiveReport((current) => (current ? { ...current, ...updated } : current));
          }
          setAutoSave({ state: "saved", at: Date.now() });
          // Refresh the list silently so summaries reflect the new title.
          void listReports(api)
            .then(({ reports }) => setSummaries(reports))
            .catch(() => undefined);
        } catch (saveError) {
          setAutoSave({
            state: "error",
            message: messageFromError(saveError),
          });
        }
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [mode, api]);

  useEffect(() => {
    if (mode.kind === "list") {
      setActiveReport(null);
      return;
    }
    void loadReport(mode.reportId);
  }, [mode, loadReport]);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createReport(api, {
        title: "Untitled report",
        visibility: "private",
      });
      if (created) {
        await loadList();
        setMode({ kind: "open", reportId: created.id, autoFocus: true });
      }
    } catch (createError) {
      setError(messageFromError(createError));
    } finally {
      setBusy(false);
    }
  }, [api, loadList]);

  const handleEditorChange = useCallback(
    (
      next: Pick<ReportRecord, "id" | "title" | "description" | "blocks" | "visibility">,
    ) => {
      setActiveReport((current) => (current ? { ...current, ...next } : current));
      // First setState from `loadReport` would push the initial value in too
      // — guard against scheduling a save for that no-op edit.
      if (!hasUserEditedRef.current) {
        hasUserEditedRef.current = true;
        return;
      }
      const payload: SavePayload = {
        title: next.title,
        description: next.description ?? "",
        visibility: next.visibility,
        blocks: next.blocks,
      };
      lastPayloadRef.current = payload;
      setAutoSave({ state: "dirty" });
      schedulerRef.current?.schedule(payload);
    },
    [],
  );

  const handleRetry = useCallback(() => {
    const payload = lastPayloadRef.current;
    if (!payload) return;
    schedulerRef.current?.schedule(payload);
    void schedulerRef.current?.flushNow();
  }, []);

  const handleDelete = useCallback(
    async (reportId: string) => {
      setBusy(true);
      setError(null);
      try {
        await deleteReport(api, reportId);
        await loadList();
        setMode({ kind: "list" });
      } catch (deleteError) {
        setError(messageFromError(deleteError));
      } finally {
        setBusy(false);
      }
    },
    [api, loadList],
  );

  const handleRefreshBlock = useCallback(
    async (blockIndex: number) => {
      if (!activeReport) return;
      setRefreshingBlockIndex(blockIndex);
      setError(null);
      try {
        const refreshed = await refreshReportBlock(api, activeReport.id, blockIndex);
        if (refreshed) setActiveReport(refreshed);
      } catch (refreshError) {
        setError(messageFromError(refreshError));
      } finally {
        setRefreshingBlockIndex(null);
      }
    },
    [activeReport, api],
  );

  const handleShare = useCallback(async () => {
    if (!activeReport) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rotateReportShareToken(api, activeReport.id);
      if (updated) setActiveReport(updated);
    } catch (shareError) {
      setError(messageFromError(shareError));
    } finally {
      setBusy(false);
    }
  }, [activeReport, api]);

  // Flush pending save before leaving the editor.
  const flushAndLeave = useCallback(async (next: Mode) => {
    if (schedulerRef.current && schedulerRef.current.hasPending()) {
      await schedulerRef.current.flushNow();
    }
    setMode(next);
  }, []);

  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Reports"
        emphasis="for collaboration"
        lede="Block-based documents · live PanelGrids · LLM summaries"
      />
      {error ? <div className="report-error" role="alert">{error}</div> : null}
      {mode.kind === "list" ? (
        <ReportsListPane
          summaries={summaries}
          busy={busy}
          onOpen={(reportId) => setMode({ kind: "open", reportId })}
          onCreate={() => void handleCreate()}
          onDelete={(reportId) => void handleDelete(reportId)}
        />
      ) : null}
      {mode.kind === "open" && activeReport ? (
        <section className="report-pane">
          <div className="report-pane__toolbar">
            <button
              type="button"
              className="report-pane__icon-button"
              onClick={() => void flushAndLeave({ kind: "list" })}
              title="Back to all reports"
              aria-label="Back to all reports"
            >
              <ChevronLeft size={15} aria-hidden="true" />
              <span className="report-pane__toolbar-label">All reports</span>
            </button>
            <div className="report-pane__toolbar-spacer" />
            <AutoSavePill status={autoSave} onRetry={handleRetry} />
            <button
              type="button"
              className="report-pane__icon-button"
              onClick={() => void handleShare()}
              title={activeReport.share_token ? "Rotate share link" : "Create share link"}
            >
              {activeReport.share_token ? "Rotate share" : "Share"}
            </button>
            <a
              className="report-pane__icon-button"
              href={reportMarkdownUrl(activeReport.id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Export as Markdown"
            >
              Export
            </a>
          </div>
          {activeReport.share_token ? (
            <p className="report-pane__share">
              Public share URL · <code>/r/{activeReport.share_token}</code>
            </p>
          ) : null}
          <ReportEditor
            report={activeReport}
            refreshingBlockIndex={refreshingBlockIndex}
            autoFocusTitle={Boolean(mode.kind === "open" && mode.autoFocus)}
            onChange={handleEditorChange}
            onRefreshBlock={(index) => void handleRefreshBlock(index)}
          />
        </section>
      ) : null}
    </>
  );
}

function ReportsListPane({
  summaries,
  busy,
  onOpen,
  onCreate,
  onDelete,
}: {
  summaries: ReportSummary[];
  busy: boolean;
  onOpen: (reportId: string) => void;
  onCreate: () => void;
  onDelete: (reportId: string) => void;
}) {
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>
            <FileText size={15} /> Your reports{" "}
            <span>({summaries.length})</span>
          </h2>
          <div className="panel-head-actions">
            <button
              type="button"
              className="report-pane__icon-button"
              onClick={() => onCreate()}
              disabled={busy}
            >
              <Plus size={14} aria-hidden="true" /> New report
            </button>
          </div>
        </div>
        <div className="panel-body">
          {summaries.length === 0 ? (
            <div className="empty">
              No reports yet. Create one to start documenting an experiment line.
            </div>
          ) : (
            <ul className="report-list">
              {summaries.map((summary) => (
                <li className="report-list__row" key={summary.id}>
                  <button
                    type="button"
                    className="report-list__title-button"
                    onClick={() => onOpen(summary.id)}
                  >
                    <span className="report-list__title-text">
                      {summary.title || "Untitled report"}
                    </span>
                    {summary.description ? (
                      <span className="report-list__description">{summary.description}</span>
                    ) : null}
                    <span className="report-list__meta">
                      <span>{summary.block_count} blocks</span>
                      <span aria-hidden="true">·</span>
                      <span>{summary.visibility}</span>
                      {summary.has_share_token ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="report-list__pill">
                            <Sparkles size={11} aria-hidden="true" /> shared
                          </span>
                        </>
                      ) : null}
                    </span>
                  </button>
                  <div className="report-list__timestamps" aria-label="Report timestamps">
                    <span className="report-list__timestamp" title={absoluteTime(summary.updated_at)}>
                      Edited {relativeTime(summary.updated_at)}
                    </span>
                    <span className="report-list__timestamp report-list__timestamp--muted" title={absoluteTime(summary.created_at)}>
                      Created {relativeTime(summary.created_at)}
                    </span>
                  </div>
                  <div className="report-list__actions">
                    <button
                      type="button"
                      className="report-pane__icon-button report-pane__icon-button--danger"
                      onClick={() => onDelete(summary.id)}
                      aria-label={`Delete report ${summary.title}`}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong loading reports.";
}

/**
 * Compact "edited 2m ago" / "created yesterday" style. ISO string in,
 * humanized string out. Used by the reports list and the editor toolbar.
 */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1m ago";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 45) return `${diffMin}m ago`;
  if (diffMin < 90) return "1h ago";
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffHr < 36) return "yesterday";
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr}y ago`;
}

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
