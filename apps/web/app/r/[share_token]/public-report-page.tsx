"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiClient } from "../../../src/api.js";
import { ReportEditor } from "../../dashboard/reports/report-editor";
import type { ReportRecord } from "../../dashboard/reports/block-types";
import { reportFromPayload } from "../../../src/reports-api.js";

type Props = {
  shareToken: string;
};

/**
 * Public, unauthenticated read-only view of a report. Fetches via the
 * magic-link share token; no session or org membership is required.
 *
 * Renders the same `<ReportEditor>` as the in-dashboard surface, in
 * `readOnly` mode — the editor and viewer share one renderer so visuals
 * stay in lockstep without a second component drifting.
 */
export function PublicReportPage({ shareToken }: Props) {
  const api = useMemo(() => new ApiClient(), []);
  const [report, setReport] = useState<ReportRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // Public lookup endpoint resolves the report by its magic-link
        // share token alone (no session, no UUID required).
        const payload = await api.get(
          `/api/reports/share/${encodeURIComponent(shareToken)}`,
        );
        const next = reportFromPayload(payload);
        if (!cancelled) {
          if (next) setReport(next);
          else setError("Report not found.");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load report.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, shareToken]);

  if (loading) {
    return (
      <main className="public-report">
        <p>Loading report…</p>
      </main>
    );
  }
  if (error || !report) {
    return (
      <main className="public-report">
        <h1>Report not found</h1>
        <p>{error ?? "The share link is invalid or has been rotated."}</p>
      </main>
    );
  }
  return (
    <main className="public-report">
      <p className="public-report__context">Read-only public report</p>
      <ReportEditor report={report} readOnly />
    </main>
  );
}
