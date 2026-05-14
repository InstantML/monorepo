# Web App

This directory contains the Next/React frontend application for InstantML. It is responsible for browsing projects, comparing runs, charting metrics, viewing artifacts, and inspecting training-loop debugging panels.

Backend note: the UI targets the Rust/ClickHouse API in `apps/rust-server` by default. The deprecated Node API in `apps/server` remains available for compatibility checks. Keep UI data access on documented REST routes and bounded summary/series endpoints so both backends stay comparable during migration cleanup.

## Responsibilities

- Project dashboard.
- Public landing page plus local Google-style sign-in, sign-up, onboarding, and copy-once SDK API-key creation.
- Runs workspace with run selector, sections, line panels, and local workspace layout persistence.
- Run detail view.
- Run comparison view.
- Metric charts with catalog, selected-run leaderboard, hover details, summaries, grouping, smoothing, and pinned panels.
- Artifact browser.
- Rollout gallery.
- Checkpoint timeline.
- Import workflow UI when needed.

Current navigation and comparison controls:

- Route-backed navigation for `Runs`, `Metrics`, `Run Detail`, `Compare`, `Alerts`, `Datasets`, `Artifacts`, `Models`, `Reports`, `Settings`, `Integrations`, and `API` at `/dashboard/:tab`, with a compact logo-only topbar brand mark so filters and saved-view controls have more room.
- Unauthenticated visitors land on `/`, can sign in or sign up through the explicitly labeled local dev Google-style flow, reserve business seats, create a copy-once SDK API key, and then enter `/dashboard/runs`. The shared demo action signs in as `hello@instantml.ai` and reuses the `InstantML Demo` org/service. In hosted ClickHouse mode, that same local/dev flow writes users/orgs/sessions/API keys to the User Data control table while dashboard reads resolve the org's tenant data plane server-side.
- Collapsible left rail that stays narrow by default, expands on hover/focus, stays pinned during desktop page scroll, and can be pinned open.
- Light/dark mode toggle with a persisted local preference. Dark mode uses neutral dark surfaces with explicit accent states; primary button styling is opt-in via `.primary-button` instead of a broad global button selector.
- Refresh/loading experience: the root layout applies the saved theme before paint and the app shows a branded loading shell during the first dashboard API load instead of flashing an empty white page.
- Desktop `Runs` workspace with a top filter rectangle, left run selector, searchable panel canvas, collapsible sections, add-panel drawer, edit drawer, and fullscreen panel inspection.
- Metrics, Run Detail, and Compare now share the analysis-suite layout: compact header stats, responsive toolbars, chart-first metric inspection, a Run Detail metric picker/dossier, and row-first comparison evidence that visually matches the Runs workspace.
- Run Detail now contains a local Pluto-style Run Workspace with a sticky run header and Summary, Data, Logs, Files, System, and Graph sections. These are intentionally local run tabs, not new global dashboard tabs.
- Logs fetch `GET /api/runs/:id/logs` only when the local Logs section is opened, render stdout/stderr through a virtualized terminal with safe ANSI spans, and keep search bounded to the selected run/stream.
- Files is an evidence explorer over the selected run's existing artifact and rich-object endpoints. It previews checkpoints, uploaded files, media objects, table objects, and histograms without introducing a separate file storage layer.
- Compare workspace with selected-run caps, reference switching, Diff-only filtering, row-first and column matrix layouts, addable metric columns, clickable table-column sorting, evidence/run/config sorting, full metric/config/artifact labels, tags/notes/artifact context, a compact best-run/delta summary, and saved-view restore that prunes stale run IDs after data resets.
- Keyboard workflow MVP: `Cmd/Ctrl+K` quick search, `?` shortcut help, `Esc` top-overlay dismissal, `Cmd/Ctrl+Z` undo, `Cmd+Shift+Z` / `Ctrl+Y` redo, `Cmd/Ctrl+.` Runs selector collapse, `Cmd/Ctrl+J` Runs/canvas focus handoff, and Left/Right Arrow fullscreen panel traversal.
- Runs rail bulk-selection: the rail header has a tri-state master checkbox that selects or clears every run on the current page, shift-clicking a run extends the selection from the last interacted run, and a banner offers "Select all N matching filter" (capped at `MAX_SELECTED_RUNS = 500`) when more runs match the filter than fit on the visible page. Workspace and Metrics panels load all selected-run series through a single batched `POST /api/metrics/series` call (with `{ key, run_ids, limit }` JSON body) per panel/metric instead of fanning out N per-run requests, so the rail can drive 500-run selections without saturating browser connection limits or hitting the dev proxy's request-header byte ceiling.
- Production polish from Computer Use QA: modal/drawer focus traps, safer quick-search routing while typing, tokenized run search such as `seed 13`, visible panel action affordances, compact run rows, responsive Run Detail KPI wrapping, horizontally contained Compare matrices, and polished fullscreen panel charts with non-duplicated headers.
- W&B/Grafana-inspired workspace behavior: automatic mode creates a capped high-signal set of line panels from logged metric keys grouped by prefix; the metric catalog and single top-level add-panel drawer still expose the full key set. Manual mode starts blank so researchers can add only the panels they need. Runs workspace panels plot explicitly selected runs first, with selection capped at 500 runs (the chart-density and legend-readability ceiling rather than a network ceiling, since panel series are batched in one request per metric), then fall back to the filtered page/top-N preview when nothing is selected. Panel headers distinguish plotted series from selected runs, legends show every plotted series up to the compact legend cap, and selected runs that do not log a panel metric are called out with a `no data for metric` chip. Panels can be dragged between sections or into the unsectioned area and resized from their lower-right handle; local placement and size are saved in the workspace layout.
- First-slice panel support is intentionally line-plot only. Bar/scatter/parallel/media/query/text panels need the future field catalog and persisted layout API described in `docs/design/2026-05-10-runs-workspace-panels.md`.
- Agent-review hardening: run names inspect a primary run, checkboxes are reserved for compare selection, visible table-column preferences remain available through the `Columns` menu, and empty filters render a clear action in the run rail.
- Tags and notes are first-class run identification fields in the current UI: the Runs table has a default `Notes` column, the workspace selector shows compact tag chips plus a one-line note preview, and server-backed search matches tag/note text through the Rust `q` route. Run Detail and Compare share a small editor that saves `runs.tags` and `metadata.notes` through `PATCH /runs/:id`; Compare has its own edit-run picker so annotation does not change the reference run.
- Large-run browsing is server-backed: the Runs workspace uses Rust `next_cursor` values for Next/Previous pagination, falls back to offset pagination for the deprecated Node compatibility server, clears cursors when filters/sorts/page size change, and disables pagination while a page request is in flight. The benchmark target is now 100,000 run records with a 20,000-step long-run series; the earlier 90,000-run benchmark slice measured production first useful render at 387 ms locally on 2026-05-11.
- Sort runs by newest, selected metric latest/best, name, status, or duration.
- Group chart series by seed, first tag, or selected config keys.
- Switch chart x-axis between step and logged time.
- Smooth chart lines and show grouped averages.
- Use normalized `0..1` y-axes for unit-bounded metrics such as accuracy, F1, precision, recall, and AUC while keeping return/loss/reward metrics auto-scaled.
- Drag a chart range brush in metric and fullscreen panel charts to inspect an x-range; the main chart fits to the visible points inside the brush and recalculates the y-axis so returns/rewards/losses auto-fit the inspected segment.
- Inspect chart points with visible markers, axis labels, ticks, and hover readouts that show the run name and metric value in both metric charts and Runs workspace panel charts.
- Browse available metrics by namespace, coverage, point count, goal-aware best/lowest value, and selected-run presence.
- Inspect selected runs through a detail dossier with a per-run metric chart, timeline, reproducibility fields, metric aggregate table, source metadata, config, tags, and artifact preview/copy actions.
- Save local views and local Runs workspace layouts in `localStorage`.
- Compare selected runs in either a column-oriented matrix or row-oriented run scan mode. Compare includes diff-only mode, row search, row sorting, addable metric columns, clickable sorting for run/metric/annotation/artifact/config columns, run sorting by name/status/duration/tags/notes/config/artifact/metric values, reference highlighting, saved-view persistence, visible tags/notes, and a 50-run cap that matches the current Rust side-by-side endpoint.
- Copy selected-run artifact IDs and API route snippets directly from the `Artifacts` and `API` tabs. Run Detail and Compare render safe same-origin MP3/MP4 artifact previews when stored bytes are available, and unsupported or external-reference artifacts fall back to download/copy actions. Raw artifact URIs are redacted in the UI so future object-storage URLs do not leak signed query strings or bucket paths.
- Browse active-run rich logged objects in Run Detail and Artifacts. The first slice renders table previews, histogram bars, and media cards from `GET /api/runs/:id/objects` plus bounded `GET /api/objects/:id/rows` table reads. Hidden tabs do not fetch object manifests, and Compare keeps using existing artifact context to avoid extra selected-run fan-out.
- Address tabs through real routes such as `/dashboard/runs`, `/dashboard/alerts`, and `/dashboard/api`; legacy hashes such as `#runs` normalize to the matching dashboard route.
- Derived workspace tabs use current summaries, selected-run artifacts, local saved views, and documented API routes. They do not yet imply persistent alert, dataset, report, model registry, or integration credential storage.

## Design Requirement

Before implementation, create or update design docs for:

- Frontend framework selection
- Routing structure
- Data-fetching conventions
- Runs workspace and panel behavior
- Charting and comparison behavior
- Artifact and media viewing
- Error/loading/empty states

## Testing Expectations

Frontend code should target 100% first-party code coverage.

Expected tests:

- Component tests for loading, empty, error, and populated states.
- Interaction tests for filters, run selection, and chart controls.
- Integration tests for API-backed views where practical.
- Accessibility checks for core workflows.

## Run

Install dependencies from the repo root first:

```bash
npm ci
npx playwright install chromium
```

Start the primary Rust/ClickHouse API from the repo root:

```bash
npm run dev:api
```

Start the Next app in another terminal:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:build
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:start
```

Then open `http://127.0.0.1:3000`, sign up with the labeled local dev Google-style flow, create the copy-once SDK key, and enter the dashboard.

Fast development server:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

The Playwright smoke uses the production-style build/start path.

Next generates `next-env.d.ts` during `next dev`, `next build`, and `next typegen`. The file is ignored because Next 16 rewrites its route-type import between development and production builds.

## Test

From the repo root:

```bash
npm run test:node
npm run web:build
npm run test:ui
npm run test:ui:direct
npm run test:rust:ui
npm run test:hosted-clickhouse
```

The browser smoke starts disposable ClickHouse and the Rust API by default, builds the Next app, starts `next start`, verifies the public landing page does not fetch dashboard summaries, signs up through the local dev Google-style flow, creates a copy-once SDK API key, seeds demo data through the signed-in session, exercises route-backed tabs with Playwright, verifies run-row click selection plus inspection behavior, exercises Runs workspace add/edit/collapse/fullscreen panel flows, checks drag-and-resize layout persistence, checks focus traps, validates tokenized run search and note search, edits tags/notes from Run Detail and Compare, asserts selected-run-only workspace plotting beyond each panel's automatic preview cap, checks that workspace charts grow and shrink with selected runs, asserts visible panel action affordances, hovers workspace chart points for run/value tooltips, verifies fullscreen chart range zoom, verifies rich-object fetches are gated to Run Detail/Artifacts, table previews are bounded, histogram/image/fallback media previews render, Compare does not add object fan-out, toggles columns, checks empty filters, hovers chart points, validates Compare column/row layouts, addable Compare metric columns, Compare row/run/config sorting, reference switching, non-anonymous metric labels, Compare artifact context, saved-view restoration, artifact/API affordances, and captures a screenshot. `npm run test:ui`, `npm run test:ui:direct`, and direct no-env invocation of `node apps/web/tests/ui-smoke.mjs` all use the Rust/ClickHouse harness.

The hosted ClickHouse smoke is API/SDK-facing rather than browser-facing: it signs up, creates an SDK key, verifies User Data control rows, writes direct and Python SDK runs into the routed tenant database, restarts the API, and verifies the dashboard summary endpoint can still read the ingested runs.

The smoke also covers the keyboard-workflow MVP: shortcut help, quick search to run detail, compact rail-label search for long run names, Runs selector collapse/restore, Runs/canvas focus handoff, `Esc` drawer dismissal, workspace undo/redo, and fullscreen panel arrow traversal.

The Runs workspace keeps its summary/filter block pinned below the top bar on desktop, with both the selector rail and panel toolbar pinned underneath it while panel sections scroll. The run rail uses compact selected-run rows and a fixed footer so pagination controls remain visible.

Pagination coverage includes Rust cursor requests, cursor clearing after filter changes, Previous-page behavior, and deprecated Node offset fallback.

Set `RLOBS_UI_SMOKE_API_BASE` to point the same smoke at an already running Rust-compatible backend. The full landing/auth/onboarding smoke depends on Rust session endpoints; deprecated Node UI checks should be treated as compatibility-only and kept behind explicit legacy investigation.

## Current Files

- `app/layout.tsx`
- `app/loading.tsx`
- `app/loading-screen.tsx`
- `app/page.tsx`
- `app/auth-flow.tsx`
- `app/signin/page.tsx`
- `app/signup/page.tsx`
- `app/onboarding/page.tsx`
- `app/dashboard/[[...tab]]/page.tsx`
- `app/dashboard/components/run-workspace.tsx`
- `app/dashboard/dashboard-shell.tsx`
- `app/dashboard-components.tsx`
- `app/dashboard-config.tsx`
- `app/dashboard-models.ts`
- `app/dashboard-types.ts`
- `app/globals.css`
- `app/icon.svg`
- `src/api.js`
- `src/charts.js`
- `src/evidence.js`
- `src/routes.js`
- `src/shortcuts.js`
- `src/state.js`
- `src/terminal.js`
- `next.config.mjs`

## Relevant Design Docs

- `docs/design/2026-05-07-next-react-ui-migration.md`
- `docs/design/2026-05-08-full-navigation-tabs.md`
- `docs/design/2026-05-10-runs-workspace-panels.md`
- `docs/design/2026-05-10-compare-page-flow.md`
- `docs/design/2026-05-10-run-tags-notes-editing.md`
- `docs/design/2026-05-10-web-keyboard-shortcuts-mvp.md`
- `docs/design/2026-05-11-analysis-tabs-redesign.md`
- `docs/design/2026-05-11-large-run-query-performance.md`
- `docs/design/2026-05-11-landing-auth-onboarding.md`
- `docs/design/2026-05-14-hosted-clickhouse-routing.md`
- `docs/design/2026-05-14-pluto-style-frontend-workspace.md`
- `docs/design/2026-05-14-instantml-rescheme-and-chart-polish.md`
- `apps/web/TODO.md` tracks W&B keyboard-shortcut and app-interaction parity gaps by priority.

## Notes for Future Agents

- Prioritize clear comparison workflows over decorative UI.
- Keep screens focused and information-dense.
- Keep the visual language sleek and precise: low-radius controls, flat buttons, restrained shadows, and status chips that read as compact metadata rather than bubbly decoration.
- Do not make marketing pages before the usable app exists.
- Use InstantML for user-facing product language.
- Avoid UI state that cannot be reproduced from URL, query state, or API state when practical.
- Keep charts responsive with bounded data queries.
- Render only the active tab body so hidden chart/detail/comparison surfaces do not rerender on every hover or filter update.
- Keep chart DOM bounded: line paths are always rendered, but per-point SVG markers are capped for point-heavy series.
- Keep frontend API failures client-safe. Do not display raw backend stack traces, SQL paths, object-storage paths, or auth details in the topbar.
- Keep same-origin API proxy configuration server-only in production; `RLOBS_API_BASE` is validated by `next.config.mjs`, and production non-loopback origins must be listed in `RLOBS_API_ALLOWED_ORIGINS`.
- Keep saved local views validated before applying them. Hosted auth/org work should namespace saved-view keys by authenticated org/user before exposing real multi-org switching.
- Keep shared data-shaping helpers in `src/` so Node tests can cover important UI logic without requiring a browser.
- Keep global keyboard matching in `src/shortcuts.js` and keep browser smoke coverage around any command that changes routing, layout, or overlay state.
- Keep reusable React surfaces in `app/dashboard-components.tsx`, stable navigation/integration config in `app/dashboard-config.tsx`, and view-model helpers in `app/dashboard-models.ts`.
- Keep styling centralized in `app/globals.css`; components should emit semantic class names rather than introduce CSS modules or inline visual systems. Prefer adjusting shared tokens before creating one-off component styles.
- Keep run-table sorting server-side when pagination is active; client sorting should not reorder only the current page.
- Keep selected run details cached separately from the current page so comparisons survive page changes.
- Prune stale saved-view run IDs against the API before rendering Compare; a saved local view must never claim selected runs that no longer exist.
- Keep Runs workspace panel queries bounded by selected runs up to `MAX_SELECTED_RUNS` or filtered page/top N plus metric point limits; do not fetch full metric histories for the panel grid.
- Keep hidden tab data fetches gated by active tab. Runs should not load Metrics, Run Detail, Compare, or artifact-only data during initial dashboard entry unless that tab is active.
- Keep workspace local-storage layouts schema-versioned and sanitized before applying. Hosted persistence belongs in the future Rust/ClickHouse workspace-views API after human user/org membership context lands.
- The first hosted auth/onboarding slice exists, but full organization switching, hosted provider credentials, invitation email delivery, and richer auth/no-access states are still follow-ups.

Known simplification follow-ups from review:

- Continue shrinking `app/page.tsx` when a workflow becomes complex enough to justify a dedicated container component.
- Add URL/query persistence for high-value daily-workflow state after the named saved-view format settles.
- Keep `npm run test:ui` covering pagination, Runs workspace sections/panels, add/edit/fullscreen panel flows, regex metric filtering, named saved views, reference-run comparison, multi-metric panels, and the 1280px viewport.
