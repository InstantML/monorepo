# Design: Dashboard Runs Polish

Date: 2026-06-09

Status: Accepted narrow UI slice

Owner: Codex

## Summary

This slice polishes the existing `/dashboard/runs` page using two Impeccable
critiques as the backlog. The dashboard already has the right primary shape:
run rail plus chart workspace. The current issue is accumulated control density:
global filters, saved views, workspace actions, run selection, panel controls,
and disabled states compete above the fold.

The smallest useful version preserves the existing API contracts and dashboard
state model while improving hierarchy, filter legibility, mobile ordering, and
run-rail scan quality.

## Goals

- Make active run constraints obvious through filter chips and one reset action.
- Move low-frequency Runs actions out of the first-read path.
- Improve run rail hierarchy and collapsed-rail context.
- Keep mobile focused on filtering, run selection, and inspection before export
  or column configuration.
- Clarify unavailable/disabled states without changing permissions or backend
  behavior.

## Non-Goals

- No backend, storage, SDK, or API contract changes.
- No new dashboard tab or new data dependency.
- No redesign of secondary dashboard pages.
- No share-link, MCP, or landing-page work.

## Users and Use Cases

The target user is a research engineer, ML lead, or platform engineer comparing
many training runs. The core workflow is:

1. Choose the relevant project/status/search constraints.
2. Select or inspect runs.
3. Read a metric panel.
4. Adjust workspace panels only after the run comparison context is clear.

## Proposed Design

Topbar:

- Keep project, status, query, and sort controls in the workbar.
- Add an active filter summary immediately after sort. It renders chips for
  non-default project, status, search query, and sort. Each chip can clear its
  own constraint. A compact reset clears all filters.
- Move saved-view name, save, view selection, and refresh into a "View actions"
  popover.
- Mirror search errors in the same persistent summary lane so invalid syntax is
  visible even when the search field compresses.

Runs command bar:

- Keep the primary metric selector visible.
- Move Columns, Export CSV, and Refresh into a compact "Runs actions" popover.
- Keep export unavailable copy inside the popover and in screen-reader text.

Run rail:

- Show per-run status as a compact state chip using existing `run.status`.
- Show a selected metric value when the selected metric exists in
  `latest_metrics`.
- Defer the cross-page "select all matching" banner until the user has started
  selecting runs.
- In collapsed rail mode, keep selected count and page range visible.

Mobile:

- Preserve touch target and input-size rules.
- Ensure command/action controls stack without putting export/columns ahead of
  the run rail.

## Component Impact

Frontend:

- `apps/web/app/dashboard/chrome/topbar.tsx`
- `apps/web/app/dashboard/runs/runs-commandbar.tsx`
- `apps/web/app/dashboard/runs/runs-workspace.tsx`
- `apps/web/app/dashboard/runs/tab-pane.tsx`
- Dashboard CSS split files.

Backend:

- None.

Python SDK:

- None.

Storage:

- None.

Docs:

- This design doc records the UI polish slice.
- `apps/web/README.md` remains accurate because commands and public contracts do
  not change.

## Data Model

No data model changes.

## API Contracts

No API contract changes.

## Performance Considerations

All changes use existing dashboard state. No new network requests, no new run
fan-out, and no additional metric-series reads. The selected metric value is
read from each loaded run summary's `latest_metrics` map.

## Simplicity Review

This avoids a new toolbar system, a new command palette flow, or route changes.
It only rearranges existing controls and adds small presentational components
inside the current dashboard seams.

## Failure Modes

- If a filter chip clear action is clicked, it should match the existing filter
  handler behavior and reset pagination where appropriate.
- If no selected metric exists for a run, the run rail omits the metric evidence
  chip rather than showing placeholder text.
- If export is unavailable, the action stays visible in the actions popover with
  explicit unlock copy.

## Testing Plan

- `npm run test:node`
- `npm run web:build`
- Browser smoke of `/dashboard/runs` at desktop and mobile widths against local
  demo data.

## Documentation Plan

No README command changes are required. This design doc is the implementation
reference.

## Alternatives Considered

- Full dashboard redesign: rejected because the existing shell is structurally
  strong and the problem is prioritization, not foundational layout.
- New shared action-menu component: deferred until a second surface needs the
  same exact pattern.
- Removing saved views from the Runs page: rejected because it is useful to
  power users; it should be disclosed later, not removed.

## Review Notes

Fresh reviewer 1:

- Finding: Keep the metric selector visible because it defines the chart
  context.
- Risk: Moving it into an actions menu would make the chart harder to read.
- Recommended edit: Only move low-frequency action controls.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: Do not add new backend reads for run-rail evidence.
- Risk: More requests would undercut the product's speed principle.
- Recommended edit: Use `latest_metrics` already loaded in summaries.
- Decision: Accepted.

## Coverage Exceptions

None.

## Decision

Accepted as a localized UI polish slice for the existing Runs dashboard.
