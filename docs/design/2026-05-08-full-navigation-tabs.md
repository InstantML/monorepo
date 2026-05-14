# Design: Full Navigation Tabs

Date: 2026-05-08

Status: Accepted

Owner: Codex

## Summary

The current Next/React app has the primary `Runs` workbench and three supporting tabs. The product mockup, however, shows a fuller left rail for the complete observability workspace: `Runs`, `Metrics`, `Run Detail`, `Compare`, `Alerts`, `Datasets`, `Artifacts`, `Models`, `Reports`, `Settings`, `Integrations`, and `API`.

This change implements every visible navigation entry from the mock in the same light console style. It does not add backend endpoints or storage. The smallest useful version is a set of honest, useful frontend surfaces derived from data the app already loads: run summaries, metric keys, selected-run metric series, selected-run artifacts, side-by-side rows, local saved views, and local API health.

## Goals

- Add the full mock navigation rail with the same grouped visual style.
- Give every tab a real product surface, not a placeholder marketing panel.
- Reuse current data and bounded queries only.
- Keep the `Runs` workbench unchanged as the primary first screen.
- Extend browser smoke coverage so every tab is reachable and renders meaningful content.

## Non-Goals

- Add new backend APIs.
- Add authentication, RBAC, team settings, or persistent report objects.
- Add a model registry, dataset registry, alert rule engine, or integration marketplace.
- Add a component library or routing restructure.
- Implement object upload/download UI beyond browsing selected-run artifacts already returned by the API.

## Users and Use Cases

Primary users are ML engineers comparing active training runs. They need the left rail to reveal the shape of the future product while staying useful today:

- Inspect failures and active-run risk in `Alerts`.
- Understand environment/config coverage in `Datasets`.
- Browse selected-run files, checkpoints, and rollouts in `Artifacts`.
- Inspect checkpoint lineage in `Models`.
- See local saved views and summary snapshots in `Reports`.
- Review workspace UI/API preferences in `Settings`.
- Discover supported local integrations in `Integrations`.
- Copy or inspect API endpoints in `API`.

## Proposed Design

Navigation:

- Keep a left rail matching the mock's grouped structure.
- Primary group: `Runs`, `Metrics`, `Run Detail`, `Compare`.
- Workspace group: `Alerts`, `Datasets`, `Artifacts`, `Models`, `Reports`.
- Admin group: `Settings`, `Integrations`, `API`.
- Keep only controls that do something now. Inert chrome such as a disabled `Collapse` affordance should wait until the behavior exists.
- Mirror active tabs into URL hashes such as `#runs` and `#api` so the workspace can be refreshed or directly inspected without adding route complexity.

Tab content:

- `Runs`: unchanged first-screen workbench.
- `Metrics`: existing chart workflow plus series summary.
- `Run Detail`: existing detail and artifact panels.
- `Compare`: existing side-by-side diff workflow.
- `Alerts`: derived cards from failed runs, running runs, missing checkpoint counts, and empty success state.
- `Datasets`: config-derived environment/dataset coverage table. If no dataset-like key exists, show an honest empty state.
- `Artifacts`: selected-run artifact browser with files, checkpoints, rollouts, counts, size, step, and URI.
- `Models`: selected-run checkpoint lineage derived from checkpoint artifacts and run config.
- `Reports`: local saved views plus a compact run-summary snapshot.
- `Settings`: local UI/API settings and current workspace state. Controls may update existing local UI state only.
- `Integrations`: implementation-backed integration cards for Python SDK, Node API, local demo data, and Neptune-shaped import.
- `API`: documented local endpoints currently used by the UI, with concise request examples.

## Component Impact

Backend:

- No backend changes.

Frontend:

- Expand the tab registry and keep reusable workspace panel/table/card components in `apps/web/app/dashboard-components.tsx`.
- Keep `apps/web/app/page.tsx` focused on state, API orchestration, and tab composition.
- Keep stable navigation and integration config in `apps/web/app/dashboard-config.tsx`, with view-model helpers in `apps/web/app/dashboard-models.ts`.
- Extend CSS in `apps/web/app/globals.css` for grouped navigation, tab dashboards, status cards, and compact data lists.
- Keep bounded data use: the app still fetches run summaries with `limit=100` and selected-run metric series with `limit=1000`.

Python SDK:

- No SDK changes.

Storage:

- No storage changes.

Docs:

- Update `apps/web/README.md`.
- Add this design doc.

## Data Model

No new data model.

The frontend derives display models from:

- `RunSummary`
- `Artifact`
- selected metric series
- side-by-side comparison payload
- `localStorage` saved views

## API Contracts

No new API contracts.

The UI continues to call:

- `GET /projects`
- `GET /api/overview`
- `GET /api/runs/summary`
- `GET /runs/:id/metrics`
- `GET /api/runs/:id/artifacts`
- `GET /api/runs/side-by-side`
- `POST /api/demo/reset`

## Performance Considerations

- Expected tab switch reads are in-memory React state reads.
- No tab should fetch full metric history.
- Artifact and side-by-side calls remain scoped to selected runs.
- Derived lists should cap displayed rows where appropriate.
- The left rail must remain responsive at desktop and collapse to horizontal scrolling under the existing mobile breakpoint.

## Simplicity Review

This is the simplest useful version because it only adds frontend surfaces over data already loaded by the app. It avoids premature registries, alert rules, report persistence, integration state machines, and model/dataset storage.

Deferred complexity:

- Persistent alert rules.
- Dataset and model registry entities.
- Report creation/editing.
- Integration credentials.
- Dedicated API explorer with live request editor.

## Failure Modes

- If there are no runs, every new tab should render an empty state rather than throwing.
- If a selected run has no artifacts, `Artifacts` and `Models` should show honest empty states.
- If saved views are empty, `Reports` should show no saved local views.
- If the API base is misconfigured, existing error messaging should remain visible through `status-message`.

## Testing Plan

- Run `npm run web:build`.
- Run `npm run test:node`.
- Extend and run `npm run test:ui` so Playwright clicks every tab and checks for meaningful tab-specific content.
- Use Computer Use in Arc to inspect the rendered navigation and at least several non-run tabs.
- Use `view_image` on the accepted concept and latest rendered screenshot before final handoff.

## Documentation Plan

- Update `apps/web/README.md` with the full navigation list and the honest data-source limits for newly added tabs.

## Alternatives Considered

- Add backend registries for alerts, datasets, reports, models, and integrations now.
  Rejected because it would expand scope beyond the user's immediate UI request and violate the simple first slice.

- Keep disabled placeholder tabs.
  Rejected because the user asked to create the tabs, and inert placeholders would make the UI feel unfinished.

- Split the app into nested routes.
  Rejected for this slice because the current tab state is already working and easier to test without routing churn.

## Review Notes

Fresh reviewer 1:

- Finding: The design correctly keeps the new tabs frontend-only and data-derived.
- Risk: Adding many tabs can make `page.tsx` harder to understand.
- Recommended edit: Use small reusable view components and shared list/table primitives instead of bespoke markup for every tab.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: The new registry-like tabs could imply product features that do not exist yet.
- Risk: Users may mistake derived views for persistent registries or managed integrations.
- Recommended edit: Use precise labels such as local saved views, config-derived datasets, selected-run artifacts, and implementation-backed integrations.
- Decision: Accepted.

## Coverage Exceptions

None.

## Decision

Accepted for a frontend-only implementation that adds the full visible navigation and useful derived tab surfaces without backend/storage changes.

## Follow-up: Agent UI Review Hardening

The first full-tab implementation was reviewed by fresh senior-engineer agents. Their strongest simplicity finding was that inert controls made the otherwise polished console feel unreliable. The accepted follow-up kept the frontend-only boundary and made these narrow changes:

- Remove topbar/rail/chart controls that had no implemented behavior.
- Make run-name clicks inspect the primary run while row checkboxes remain chart/compare selection.
- Add a real `Columns` menu for table visibility.
- Add an in-table empty state with a clear-filters action.
- Replace the raw compare rows with a compact matrix that emphasizes config, source, metric, and changed values.
- Add copy actions for artifact URIs and API route snippets.
- Update smoke coverage so these interactions remain intentional.

## Follow-up: Daily Workflow Hardening

The P2 daily-workflow pass kept the same frontend/API boundary and turned the most visible comparison controls into durable working behavior:

- Runs now request bounded pages from `/api/runs/summary` and expose page size, previous, next, and truthful row ranges.
- Run summaries are sorted by the server before pagination, so `Best metric`, `Latest metric`, `Name`, `Status`, and `Duration` remain global within the filtered result set.
- Page changes preserve the comparison selection; filter/search/status changes intentionally reset it to the new result set.
- Metric key lists are scoped to the full filtered result set rather than the current page.
- The columns popover keeps existing base-column toggles and adds pinned metric columns filtered by metric-name regex.
- Column metric search is independent from the primary chart metric regex filter.
- Saved views are named and persist filters, metric controls, selected/reference runs, pinned metrics, table columns, and page size in local storage.
- The compare tab accepts a reference run, labels the reference column, highlights changed cells, and shows relative deltas for numeric values.
- The metrics tab accepts a regex metric filter and can render pinned multi-metric chart panels beside the primary chart.
- Dashboard, metric, artifact, pinned-panel, and side-by-side fetches are split into cancellation-safe effects or request-generation guarded loaders so chart controls do not refetch unrelated panels or let stale responses overwrite current state.
- Pinned chart hover labels use the hovered panel's metric key, not the primary chart's metric key.
- Grouped averages preserve averaged timestamps for the time x-axis.
- UI smoke coverage now exercises pagination, regex filtering, pinned columns, named saved views, reference comparison, multi-metric panels, all navigation tabs, and a 1280px viewport.

Screenshot artifact: `docs/design/assets/2026-05-09-ui-daily-workflow-smoke.png`.
