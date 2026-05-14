# Design: Next React UI Migration

Date: 2026-05-07

Status: Accepted

Owner: Codex

## Summary

The current static UI is useful but cramped and hard to scan. The next UI pass should migrate the frontend to Next/React, use the uploaded dashboard codebase as visual direction, and improve legibility with a tabbed operational layout.

After the first migration, the product direction shifted toward a more polished light console inspired by the generated concept mockup: compact top navigation, left section rail, first-viewport run table, metric chart, and right-side inspector. The UI should feel like a serious training workbench, not a marketing page or decorative dashboard.

The May 8 polish pass tightened the Runs page against that mockup: the topbar is a single compact row, the left rail uses cleaner active states, a slim command row sits above the cards, the workbench uses mock-aligned proportions with a medium-width two-column breakpoint, table rows are fixed-height and single-line, the chart uses a multi-run hover popup with a vertical guide, and the bottom range strip renders a mini overview chart.

A later May 8 agent-review hardening pass removed or implemented dead controls, split row inspection from chart selection, added a real table column menu, made empty filters recoverable from inside the table, replaced the raw side-by-side chip wall with a comparison matrix, added copy actions for artifact/API rows, and cleared stale hover readouts when no chart point is active.

The follow-up code-quality pass kept the same UI contract but split the React surface into clearer files: `page.tsx` now owns state, API orchestration, and tab composition; `dashboard-components.tsx` owns reusable view components; `dashboard-config.tsx` owns stable navigation and integration config; `dashboard-models.ts` owns derived rows and format helpers; `dashboard-types.ts` owns shared TypeScript contracts. Styling remains centralized in `globals.css`.

The May 2026 Metrics/Run Detail polish keeps the same REST contracts but makes the secondary workspaces more researcher-useful: Metrics now includes a metric catalog, selected-run leaderboard, hover readout, series summary, grouping, smoothing, x-axis switching, and pinned panels; Run Detail now presents a run dossier with a per-run metric chart, timeline, reproducibility highlights, source metadata, metric aggregate table, config, tags, artifact preview/copy actions, and failed-run triage.

Supersession note: this migration originally targeted the then-current Node API. The React UI still runs as a separate Next app in `apps/web`, but the default backend is now the Rust/ClickHouse service in `apps/rust-server`, selected through `RLOBS_API_BASE` at build/start time and the Next server-side API proxy. The deprecated Node API remains a compatibility target; UI work should preserve documented REST route shapes unless a later design intentionally changes them.

## Goals

- Migrate `apps/web` to Next/React.
- Add tabs for `Runs`, `Metrics`, `Run Detail`, and `Compare`.
- Modernize visual design with a light operational console theme, denser but clearer spacing, and better typography.
- Add chart axes, labels, grid lines, visible point markers, and hover details for the nearest run/timestamp.
- Keep `Runs` as the primary workbench: run table, selected metric chart, and run inspector visible together on desktop.
- Match the accepted light-console mock closely enough that spacing, table density, chart proportions, hover popup behavior, bottom range strip, and inspector formatting feel production-ready.
- Keep visible controls honest: if a control is present, it should change UI state, navigate somewhere useful, or be removed until implemented.
- Keep tests practical: pure helper tests with Node and a Playwright smoke test against the Next UI.

## Non-Goals

- Preserve the old static self-host path in this pass.
- Add a full component library or Tailwind/shadcn stack.
- Change backend API contracts.
- Add server-side rendering data dependencies.

## Proposed Design

- `apps/web/app`: Next app router entrypoint.
- `apps/web/src/api.js`: fetch helper shared by React and tests.
- `apps/web/src/chart-model.js`: pure chart normalization, ticks, hover hit-testing, smoothing, and grouped averages.
- `apps/web/src/view-model.js`: pure run sorting, formatting, metric keys, groups, and selection helpers.
- `apps/web/app/page.tsx`: client-side dashboard state, API orchestration, and tab composition.
- `apps/web/app/dashboard-components.tsx`: reusable dashboard view components.
- `apps/web/app/dashboard-config.tsx`: stable nav and integration config.
- `apps/web/app/dashboard-models.ts`: local derived rows and formatting helpers for tab surfaces.
- `apps/web/app/dashboard-types.ts`: shared frontend TypeScript contracts.
- `apps/web/app/globals.css`: standalone CSS using a light, compact training-console aesthetic as inspiration.

Tabs:

- `Runs`: filters, run table, selected metric chart, and primary run inspector in one desktop workbench.
- `Metrics`: metric catalog, chart controls, chart, selected-run leaderboard, hover readout, series summary, and pinned metric panels.
- `Run Detail`: selected run dossier, per-run chart, timeline, reproducibility highlights, timestamp hover details, metric aggregate table, checkpoints, rollouts, artifacts.
- `Compare`: side-by-side comparison and diff-only toggle.

React decision:

- Use React/Next now because the user explicitly requested migration.
- Avoid Tailwind/shadcn for this slice to keep dependencies and build setup smaller.

## API Contracts

No backend changes.

The UI calls:

- `GET /projects`
- `GET /api/overview`
- `GET /api/runs/summary`
- `GET /runs/:id/metrics`
- `GET /api/runs/:id/artifacts`
- `GET /api/runs/side-by-side`
- `POST /api/demo/reset`

## Testing Plan

- Node helper tests for formatting, sorting, chart normalization, ticks, hover hit-testing, smoothing, grouping, and API errors.
- Playwright smoke test starts a Node API server, starts Next, loads demo data, exercises tabs and chart hover, and verifies no page errors.
- Playwright smoke also covers inspect-vs-select behavior, column visibility, filter empty states, compare matrix rendering, artifact/API copy affordances, and the absence of stale hover details.
- `next build` for type/build verification.

## Review Notes

Fresh reviewer 1:

- Finding: User explicitly changed direction to Next/React and said to ignore self-hosting for now.
- Risk: A full component-library migration would add avoidable setup weight.
- Recommended edit: Use Next/React but keep CSS and helpers simple.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: The immediate UX need is legibility and chart inspection, not backend changes.
- Risk: Reworking APIs or storage would expand scope.
- Recommended edit: Keep backend API stable and focus the UI around tabs, chart axes, hover, and run detail.
- Decision: Accepted.

## Decision

Proceed with a focused Next/React migration in `apps/web`.
