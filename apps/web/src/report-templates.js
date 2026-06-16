/**
 * Pure helpers for the Reports list actions (audit RP3): the
 * "Start from template" starter document and "Duplicate report" payload.
 * Plain JS with no React/DOM dependencies so `node --test` can exercise the
 * shapes directly; the reports tab pane consumes these and POSTs them
 * through `createReport` in reports-api.js.
 */

/**
 * Deep-copy helper. `structuredClone` exists in every runtime we target
 * (Node 18+, evergreen browsers); JSON round-trip is the safety net for
 * anything older. Report blocks are JSON-serializable by contract, so the
 * fallback is lossless.
 */
function deepCopy(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * "Experiment readout" starter document. Returns a fresh object on every
 * call so callers can mutate the result without bleeding into later
 * creations. Block shapes mirror block-types/types.ts (and the Rust
 * validation in apps/rust-server/src/store/reports/).
 */
export function experimentReadoutTemplate() {
  return {
    title: "Experiment readout",
    description: "What we ran, what we learned, and what happens next.",
    visibility: "private",
    blocks: [
      { kind: "heading", level: 2, text: "Summary" },
      {
        kind: "paragraph",
        text: "One-paragraph recap: what was tested and the headline result.",
      },
      { kind: "heading", level: 2, text: "Results" },
      {
        kind: "panel_grid",
        runsets: [{ name: "runset-1", projects: [], pinned_run_ids: [] }],
        panels: [],
      },
      { kind: "heading", level: 2, text: "Next steps" },
      {
        kind: "paragraph",
        text: "Follow-up experiments, open questions, and owners.",
      },
    ],
  };
}

/** "<title> (copy)" naming for duplicated reports, with an untitled fallback. */
export function duplicateReportTitle(title) {
  const base =
    typeof title === "string" && title.trim() ? title.trim() : "Untitled report";
  return `${base} (copy)`;
}

/**
 * CreateReportRequest body for duplicating a report. Copies title (with the
 * "(copy)" suffix), description, and blocks. Duplicates always start
 * private — share tokens and public visibility are deliberately not
 * carried over so a copy never leaks through the original's share link
 * audience by surprise.
 */
export function duplicateReportPayload(report) {
  return {
    title: duplicateReportTitle(report?.title),
    description:
      typeof report?.description === "string" ? report.description : "",
    visibility: "private",
    blocks: Array.isArray(report?.blocks) ? deepCopy(report.blocks) : [],
  };
}
