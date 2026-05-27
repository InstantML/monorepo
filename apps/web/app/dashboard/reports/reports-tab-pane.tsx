"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Plus, Sparkles, Trash2 } from "lucide-react";

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
import { ReportViewer } from "./report-viewer";
import type {
  ReportBlock,
  ReportRecord,
  ReportSummary,
} from "./block-types";

type Mode =
  | { kind: "list" }
  | { kind: "edit"; reportId: string }
  | { kind: "view"; reportId: string };

const DEFAULT_BLOCKS: ReportBlock[] = [];

/**
 * Top-level Reports tab. Handles the list/editor/viewer flow internally so
 * the dashboard-shell wiring stays a thin pass-through.
 */
export function ReportsTabPane() {
  const api = useMemo(() => new ApiClient(), []);
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [activeReport, setActiveReport] = useState<ReportRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingBlockIndex, setRefreshingBlockIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      } catch (loadError) {
        setError(messageFromError(loadError));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (mode.kind === "list") {
      setActiveReport(null);
      return;
    }
    void loadReport(mode.reportId);
  }, [mode, loadReport]);

  const handleCreate = useCallback(
    async () => {
      setBusy(true);
      setError(null);
      try {
        const created = await createReport(api, {
          title: "Untitled report",
          visibility: "private",
        });
        if (created) {
          await loadList();
          setMode({ kind: "edit", reportId: created.id });
        }
      } catch (createError) {
        setError(messageFromError(createError));
      } finally {
        setBusy(false);
      }
    },
    [api, loadList],
  );

  const handleEditorChange = useCallback(
    (next: Pick<ReportRecord, "id" | "title" | "description" | "blocks" | "visibility">) => {
      setActiveReport((current) =>
        current ? { ...current, ...next } : current,
      );
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!activeReport) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await patchReport(api, activeReport.id, {
        title: activeReport.title,
        description: activeReport.description ?? "",
        visibility: activeReport.visibility,
        blocks: activeReport.blocks,
      });
      if (updated) setActiveReport(updated);
      await loadList();
    } catch (saveError) {
      setError(messageFromError(saveError));
    } finally {
      setBusy(false);
    }
  }, [activeReport, api, loadList]);

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

  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Reports"
        emphasis="for collaboration"
        lede="Notion-style documents · live PanelGrids · LLM summaries"
      />
      {error ? <div className="report-error" role="alert">{error}</div> : null}
      {mode.kind === "list" ? (
        <ReportsListPane
          summaries={summaries}
          busy={busy}
          onOpenView={(reportId) => setMode({ kind: "view", reportId })}
          onOpenEdit={(reportId) => setMode({ kind: "edit", reportId })}
          onCreate={() => void handleCreate()}
          onDelete={(reportId) => void handleDelete(reportId)}
        />
      ) : null}
      {mode.kind === "edit" && activeReport ? (
        <section className="report-pane">
          <div className="report-pane__head">
            <button
              type="button"
              className="report-pane__back"
              onClick={() => setMode({ kind: "list" })}
            >
              ← All reports
            </button>
            <div className="report-pane__head-actions">
              <button
                type="button"
                className="report-pane__action"
                onClick={() => setMode({ kind: "view", reportId: activeReport.id })}
              >
                Preview
              </button>
              <button
                type="button"
                className="report-pane__action"
                onClick={() => void handleShare()}
              >
                {activeReport.share_token ? "Rotate share link" : "Create share link"}
              </button>
              <a
                className="report-pane__action"
                href={reportMarkdownUrl(activeReport.id)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Export Markdown
              </a>
            </div>
          </div>
          {activeReport.share_token ? (
            <p className="report-pane__share">
              Public share URL ·{" "}
              <code>/r/{activeReport.share_token}</code>
            </p>
          ) : null}
          <ReportEditor
            report={activeReport}
            saving={busy}
            refreshingBlockIndex={refreshingBlockIndex}
            onChange={handleEditorChange}
            onSave={() => void handleSave()}
            onRefreshBlock={(index) => void handleRefreshBlock(index)}
          />
        </section>
      ) : null}
      {mode.kind === "view" && activeReport ? (
        <section className="report-pane">
          <div className="report-pane__head">
            <button
              type="button"
              className="report-pane__back"
              onClick={() => setMode({ kind: "list" })}
            >
              ← All reports
            </button>
            <button
              type="button"
              className="report-pane__action"
              onClick={() => setMode({ kind: "edit", reportId: activeReport.id })}
            >
              Edit
            </button>
          </div>
          <ReportViewer report={activeReport} />
        </section>
      ) : null}
    </>
  );
}

function ReportsListPane({
  summaries,
  busy,
  onOpenView,
  onOpenEdit,
  onCreate,
  onDelete,
}: {
  summaries: ReportSummary[];
  busy: boolean;
  onOpenView: (reportId: string) => void;
  onOpenEdit: (reportId: string) => void;
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
              className="report-pane__action"
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
                    onClick={() => onOpenView(summary.id)}
                  >
                    <strong>{summary.title}</strong>
                    {summary.description ? (
                      <small>{summary.description}</small>
                    ) : null}
                    <small className="report-list__meta">
                      {summary.block_count} blocks · {summary.visibility}
                      {summary.has_share_token ? (
                        <span className="report-list__pill">
                          <Sparkles size={11} aria-hidden="true" /> shared
                        </span>
                      ) : null}
                    </small>
                  </button>
                  <div className="report-list__actions">
                    <button
                      type="button"
                      className="report-pane__action"
                      onClick={() => onOpenEdit(summary.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="report-pane__action report-pane__action--danger"
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
