"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePathname } from "next/navigation";
import {
  ChevronLeft,
  FileText,
  Plus,
  Redo2,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";

import { ApiClient, isAbortError } from "../../../src/api.js";
import {
  createReport,
  deleteReport,
  fetchReport,
  listReports,
  patchReport,
  reportMarkdownUrl,
  rotateReportShareToken,
} from "../../../src/reports-api.js";
import { PageHead } from "../ui/page-head";
import { ReportEditor } from "./report-editor";
import { AutoSavePill } from "./auto-save-pill";
import type { AutoSaveStatus } from "./auto-save-pill";
import { createAutoSaveScheduler } from "./auto-save";
import type { ReportRecord, ReportSummary } from "./block-types";
import { useReportHistory, snapshotFromReport } from "./use-report-history";
import type { HistorySnapshot } from "./use-report-history";
import { classifySnapshotMode } from "./report-history-core.js";

type Mode =
  | { kind: "list" }
  | { kind: "open"; reportId: string; autoFocus?: boolean };

const AUTO_SAVE_DELAY_MS = 800;
const CREATE_REPORT_TIMEOUT_MS = 15_000;

interface SavePayload {
  clientSeq: number;
  title: string;
  description: string;
  visibility: ReportRecord["visibility"];
  blocks: ReportRecord["blocks"];
}

// Sentinel passed to `useReportHistory` on first mount; the `reset` effect
// replaces it with the real initial snapshot once a report is loaded.
const EMPTY_HISTORY_SNAPSHOT: HistorySnapshot = {
  title: "",
  description: "",
  visibility: "private",
  blocks: [],
};

/**
 * Top-level Reports tab. Owns the list + editor flow plus the auto-save
 * scheduler. There is exactly one editing surface — the editor is always
 * interactive, no separate "preview" mode (matching the inline-editing
 * pattern of modern doc tools). The editor itself is a controlled
 * component that fires `onChange` for every edit; this pane debounces
 * those into one PATCH per 800 ms of quiet.
 */
export function ReportsTabPane({ canEditReports = true }: { canEditReports?: boolean }) {
  const pathname = usePathname();
  const api = useMemo(() => new ApiClient(), []);
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [mode, setMode] = useState<Mode>(() => {
    const reportId = reportIdFromDashboardPath(pathname);
    return reportId ? { kind: "open", reportId } : { kind: "list" };
  });
  const [activeReport, setActiveReport] = useState<ReportRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState<AutoSaveStatus>({ state: "idle" });

  // Per-editor auto-save scheduler. Recreated each time we open a new
  // report so the cleanup of the previous one doesn't fire after we mount
  // its replacement.
  const schedulerRef = useRef<ReturnType<typeof createAutoSaveScheduler<SavePayload>> | null>(null);
  // Latest payload that the editor handed us. Used by the retry button.
  const lastPayloadRef = useRef<SavePayload | null>(null);

  // Undo/redo history. Stacks live across re-renders; `reset` clears them
  // on report-switch. The snapshot we initialize with is a placeholder —
  // it gets replaced immediately by the `reset` in the report-switch
  // effect below, before the user can interact with the editor.
  const history = useReportHistory(EMPTY_HISTORY_SNAPSHOT);
  // The `history` object's identity changes when canUndo/canRedo flip
  // (because the hook returns a useMemo'd handle that depends on those
  // flags). If we let `loadReport` depend on `history`, the very first
  // user edit recreates `loadReport`, which re-fires its useEffect and
  // reloads the report from the server — wiping the user's in-progress
  // typing. Pin the controller methods to a ref so the closures below
  // can call them without depending on the unstable handle.
  const historyRef = useRef(history);
  historyRef.current = history;
  // We need the *previous* snapshot to classify each edit (text-only vs
  // structural). The active report state is async, so keeping a ref of the
  // last-emitted snapshot is simpler than threading through useEffect.
  const lastSnapshotRef = useRef<HistorySnapshot | null>(null);
  const loadReportSeqRef = useRef(0);
  const editSeqRef = useRef(0);

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

  useEffect(() => {
    setModeFromPath(pathname, setMode);
  }, [pathname]);

  useEffect(() => {
    const syncFromHistory = () => setModeFromPath(window.location.pathname, setMode);
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  const openReport = useCallback(
    (reportId: string, options?: { autoFocus?: boolean; replace?: boolean }) => {
      setMode({ kind: "open", reportId, autoFocus: options?.autoFocus });
      pushDashboardPath(dashboardReportPath(reportId), options?.replace);
    },
    [],
  );

  const showReportList = useCallback(
    (options?: { replace?: boolean }) => {
      setMode({ kind: "list" });
      pushDashboardPath("/dashboard/reports", options?.replace);
    },
    [],
  );

  const loadReport = useCallback(
    async (reportId: string) => {
      const seq = loadReportSeqRef.current + 1;
      loadReportSeqRef.current = seq;
      setBusy(true);
      setError(null);
      setActiveReport((current) => (current?.id === reportId ? current : null));
      try {
        const report = await fetchReport(api, reportId);
        if (loadReportSeqRef.current !== seq) return;
        setActiveReport(report);
        setAutoSave({ state: "idle" });
        // History resets to the freshly-loaded report. Undo before any
        // user edit is a no-op (canUndo === false).
        const snapshot = snapshotFromReport(report);
        historyRef.current.reset(snapshot);
        lastSnapshotRef.current = snapshot;
      } catch (loadError) {
        if (loadReportSeqRef.current === seq) {
          setError(messageFromError(loadError));
        }
      } finally {
        if (loadReportSeqRef.current === seq) {
          setBusy(false);
        }
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
          const { clientSeq, ...serverPayload } = payload;
          const updated = await patchReport(api, reportId, serverPayload);
          if (updated) {
            // Critical: only update server-derived fields. NEVER overwrite
            // title / description / blocks / visibility from the response —
            // by the time the response lands (50–500 ms), the user has
            // typically typed more characters and the response represents a
            // stale snapshot. Spreading `...updated` would clobber those
            // newest keystrokes. Only `updated_at` / `share_token` /
            // metadata fields the server actually mutated need refreshing.
            setActiveReport((current) =>
              current
                ? {
                    ...current,
                    updated_at: updated.updated_at,
                    share_token: updated.share_token,
                  }
                : current,
            );
          }
          if (clientSeq === editSeqRef.current && !schedulerRef.current?.hasPending()) {
            setAutoSave({ state: "saved", at: Date.now() });
          }
          // Refresh the list silently so summaries reflect the new title.
          void listReports(api)
            .then(({ reports }) => setSummaries(reports))
            .catch(() => undefined);
        } catch (saveError) {
          if (payload.clientSeq === editSeqRef.current) {
            setAutoSave({
              state: "error",
              message: messageFromError(saveError),
            });
          }
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
    if (!canEditReports) {
      setError("Report editing is available to workspace writers.");
      return;
    }
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CREATE_REPORT_TIMEOUT_MS);
    try {
      const created = await createReport(
        api,
        {
          title: "Untitled report",
          visibility: "private",
        },
        {
          signal: controller.signal,
        },
      );
      if (created) {
        await loadList();
        openReport(created.id, { autoFocus: true });
      }
    } catch (createError) {
      setError(
        isAbortError(createError)
          ? "Creating the report timed out. Try again in a moment."
          : messageFromError(createError),
      );
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }, [api, canEditReports, loadList]);

  const handleEditorChange = useCallback(
    (
      next: Pick<ReportRecord, "id" | "title" | "description" | "blocks" | "visibility">,
    ) => {
      setActiveReport((current) => (current ? { ...current, ...next } : current));
      const nextSnapshot = snapshotFromReport(next);
      // Classify against the previous snapshot — text-only diffs coalesce
      // into one history entry per 500 ms typing burst; everything else
      // (structural changes, title/description/visibility) snapshots
      // immediately.
      const mode = classifySnapshotMode(lastSnapshotRef.current, nextSnapshot);
      historyRef.current.push(nextSnapshot, mode);
      lastSnapshotRef.current = nextSnapshot;
      const payload: SavePayload = {
        clientSeq: editSeqRef.current + 1,
        title: next.title,
        description: next.description ?? "",
        visibility: next.visibility,
        blocks: next.blocks,
      };
      editSeqRef.current = payload.clientSeq;
      lastPayloadRef.current = payload;
      setAutoSave({ state: "dirty" });
      schedulerRef.current?.schedule(payload);
    },
    [],
  );

  // Restore a snapshot produced by undo/redo. We explicitly do NOT re-push
  // the restored value into the history (push() is only for new edits).
  const applyRestoredSnapshot = useCallback(
    (snapshot: HistorySnapshot) => {
      setActiveReport((current) =>
        current
          ? {
              ...current,
              title: snapshot.title,
              description: snapshot.description,
              visibility: snapshot.visibility,
              blocks: snapshot.blocks,
            }
          : current,
      );
      lastSnapshotRef.current = snapshot;
      const payload: SavePayload = {
        clientSeq: editSeqRef.current + 1,
        title: snapshot.title,
        description: snapshot.description,
        visibility: snapshot.visibility,
        blocks: snapshot.blocks,
      };
      editSeqRef.current = payload.clientSeq;
      lastPayloadRef.current = payload;
      // Mirror exactly what an edit does: mark dirty + schedule a save.
      // This persists the undone state across reloads (matches Notion).
      setAutoSave({ state: "dirty" });
      schedulerRef.current?.schedule(payload);
    },
    [],
  );

  const handleUndo = useCallback(() => {
    if (!history.canUndo) return;
    const restored = history.undo();
    if (restored) applyRestoredSnapshot(restored);
  }, [history, applyRestoredSnapshot]);

  const handleRedo = useCallback(() => {
    if (!history.canRedo) return;
    const restored = history.redo();
    if (restored) applyRestoredSnapshot(restored);
  }, [history, applyRestoredSnapshot]);

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
        showReportList({ replace: true });
      } catch (deleteError) {
        setError(messageFromError(deleteError));
      } finally {
        setBusy(false);
      }
    },
    [api, loadList, showReportList],
  );

  const flushPendingEdits = useCallback(async () => {
    historyRef.current.flush();
    if (schedulerRef.current && schedulerRef.current.hasPending()) {
      await schedulerRef.current.flushNow();
    }
  }, []);

  const handleShare = useCallback(async () => {
    if (!activeReport) return;
    if (!canEditReports) return;
    setBusy(true);
    setError(null);
    try {
      await flushPendingEdits();
      const updated = await rotateReportShareToken(api, activeReport.id);
      if (updated) {
        setActiveReport((current) =>
          current
            ? {
                ...current,
                visibility: updated.visibility,
                updated_at: updated.updated_at,
                share_token: updated.share_token,
              }
            : updated,
        );
      }
    } catch (shareError) {
      setError(messageFromError(shareError));
    } finally {
      setBusy(false);
    }
  }, [activeReport, api, canEditReports, flushPendingEdits]);

  // Flush pending save before leaving the editor. Also flush any pending
  // history-coalesce snapshot so the last burst is preserved if the user
  // returns to this report.
  const flushAndLeave = useCallback(async (next: Mode) => {
    await flushPendingEdits();
    if (next.kind === "list") {
      showReportList();
    } else {
      openReport(next.reportId, { autoFocus: next.autoFocus });
    }
  }, [flushPendingEdits, openReport, showReportList]);

  const handleExportMarkdown = useCallback(async () => {
    if (!activeReport) return;
    await flushPendingEdits();
    window.open(reportMarkdownUrl(activeReport.id), "_blank", "noopener,noreferrer");
  }, [activeReport, flushPendingEdits]);

  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Reports"
        emphasis="for collaboration"
        lede="Block-based documents · live PanelGrids · shareable recaps"
      />
      {error ? <div className="report-error" role="alert">{error}</div> : null}
      {mode.kind === "list" ? (
        <ReportsListPane
          summaries={summaries}
          busy={busy}
          onOpen={(reportId) => openReport(reportId)}
          onCreate={() => void handleCreate()}
          canEditReports={canEditReports}
          onDelete={(reportId, title) => {
            if (!canEditReports) return;
            if (!window.confirm(`Delete "${title || "Untitled report"}"? This cannot be undone.`)) {
              return;
            }
            void handleDelete(reportId);
          }}
        />
      ) : null}
      {mode.kind === "open" && !activeReport ? (
        <section className="report-pane">
          <ReportToolbar onBack={() => void flushAndLeave({ kind: "list" })}>
            <div className="report-pane__toolbar-spacer" />
            <span className="report-pane__loading-status" aria-live="polite">
              Loading report...
            </span>
          </ReportToolbar>
          <ReportLoadingSkeleton />
        </section>
      ) : null}
      {mode.kind === "open" && activeReport ? (
        <section className="report-pane">
          {(() => {
            const shareTitle = !canEditReports
              ? "Read-only workspaces cannot create or rotate share links"
              : busy
                ? "Report action in progress"
                : activeReport.share_token
                  ? "Rotate share link"
                  : "Create share link";
            return (
          <ReportToolbar onBack={() => void flushAndLeave({ kind: "list" })}>
            <div className="report-pane__toolbar-spacer" />
            <AutoSavePill status={autoSave} onRetry={handleRetry} />
            <button
              type="button"
              className="report-pane__icon-button report-pane__history-button"
              onClick={handleUndo}
              disabled={!history.canUndo}
              aria-disabled={!history.canUndo}
              aria-label="Undo"
              title="Undo (⌘Z)"
            >
              <Undo2 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="report-pane__icon-button report-pane__history-button"
              onClick={handleRedo}
              disabled={!history.canRedo}
              aria-disabled={!history.canRedo}
              aria-label="Redo"
              title="Redo (⌘⇧Z)"
            >
              <Redo2 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="report-pane__icon-button"
              onClick={() => void handleShare()}
              disabled={!canEditReports || busy}
              aria-label={shareTitle}
              title={shareTitle}
            >
              {activeReport.share_token ? "Rotate share" : "Share"}
            </button>
            <button
              type="button"
              className="report-pane__icon-button"
              onClick={() => void handleExportMarkdown()}
              title="Export as Markdown"
            >
              Export
            </button>
          </ReportToolbar>
            );
          })()}
          {activeReport.share_token ? (
            <p className="report-pane__share">
              Public share URL ·{" "}
              <a
                href={shareUrlForToken(activeReport.share_token)}
                target="_blank"
                rel="noreferrer"
              >
                {shareUrlForToken(activeReport.share_token)}
              </a>
            </p>
          ) : null}
          <ReportEditor
            report={activeReport}
            autoFocusTitle={Boolean(mode.kind === "open" && mode.autoFocus)}
            onChange={handleEditorChange}
            readOnly={!canEditReports}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
        </section>
      ) : null}
    </>
  );
}

function ReportToolbar({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="report-pane__toolbar">
      <button
        type="button"
        className="report-pane__icon-button"
        onClick={onBack}
        title="Back to all reports"
        aria-label="Back to all reports"
      >
        <ChevronLeft size={15} aria-hidden="true" />
        <span className="report-pane__toolbar-label">All reports</span>
      </button>
      {children}
    </div>
  );
}

function ReportsListPane({
  summaries,
  busy,
  canEditReports,
  onOpen,
  onCreate,
  onDelete,
}: {
  summaries: ReportSummary[];
  busy: boolean;
  canEditReports: boolean;
  onOpen: (reportId: string) => void;
  onCreate: () => void;
  onDelete: (reportId: string, title: string) => void;
}) {
  return (
    <>
      <section className="report-home">
        <div className="report-home__header">
          <div>
            <h2>
              <FileText size={16} /> Reports
              <span>{summaries.length}</span>
            </h2>
            <p>Experiment writeups, live panels, and shareable readouts.</p>
          </div>
          {summaries.length > 0 ? (
            <div className="report-home__actions">
              <button
                type="button"
                className="report-pane__icon-button"
                onClick={() => onCreate()}
                disabled={busy || !canEditReports}
                title={canEditReports ? "New report" : "Report editing requires workspace write access"}
              >
                <Plus size={14} aria-hidden="true" /> New report
              </button>
            </div>
          ) : null}
        </div>
        <div className="report-home__body">
          {busy && summaries.length === 0 ? (
            <div className="report-list__loading" aria-live="polite">
              Loading reports...
            </div>
          ) : summaries.length === 0 ? (
            <div className="report-list__empty">
              <FileText size={22} aria-hidden="true" />
              <strong>No reports yet</strong>
              <span>{canEditReports ? "Create the first writeup for this workspace." : "This workspace is read-only. Shared reports will appear here."}</span>
              {canEditReports ? (
                <button
                  type="button"
                  className="report-pane__icon-button"
                  onClick={() => onCreate()}
                  disabled={busy}
                  title="Create report"
                >
                  <Plus size={14} aria-hidden="true" /> Create report
                </button>
              ) : null}
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
                      onClick={() => onDelete(summary.id, summary.title)}
                      aria-label={`Delete report ${summary.title}`}
                      disabled={busy || !canEditReports}
                      title={canEditReports ? "Delete report" : "Report editing requires workspace write access"}
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

function setModeFromPath(
  pathname: string | null,
  setMode: Dispatch<SetStateAction<Mode>>,
) {
  const reportId = reportIdFromDashboardPath(pathname);
  setMode((current) => {
    if (!reportId) return current.kind === "list" ? current : { kind: "list" };
    if (current.kind === "open" && current.reportId === reportId) return current;
    return { kind: "open", reportId };
  });
}

function reportIdFromDashboardPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const parts = pathname.split("/").filter(Boolean);
  const reportsIndex = parts.indexOf("reports");
  const rawReportId = reportsIndex >= 0 ? parts[reportsIndex + 1] : null;
  if (!rawReportId) return null;
  try {
    return decodeURIComponent(rawReportId);
  } catch {
    return rawReportId;
  }
}

function dashboardReportPath(reportId: string): string {
  return `/dashboard/reports/${encodeURIComponent(reportId)}`;
}

function pushDashboardPath(path: string, replace = false) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  if (replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
}

function shareUrlForToken(token: string): string {
  const path = `/r/${token}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

function ReportLoadingSkeleton() {
  return (
    <div className="report-editor report-editor--loading" aria-label="Loading report">
      <div className="report-skeleton report-skeleton--title" />
      <div className="report-skeleton report-skeleton--description" />
      <div className="report-skeleton report-skeleton--meta" />
      <div className="report-skeleton report-skeleton--line" />
      <div className="report-skeleton report-skeleton--line report-skeleton--wide" />
      <div className="report-skeleton report-skeleton--line report-skeleton--short" />
      <div className="report-skeleton report-skeleton--panel" />
    </div>
  );
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
