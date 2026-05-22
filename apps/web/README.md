# Web App

This directory contains the Next/React frontend application for InstantML. It is responsible for browsing projects, comparing runs, charting metrics, viewing artifacts, and inspecting training-loop debugging panels.

Backend note: the UI targets the Rust/ClickHouse API in `apps/rust-server` by default. The deprecated Node API in `apps/server` remains available for compatibility checks. Keep UI data access on documented REST routes and bounded summary/series endpoints so both backends stay comparable during migration cleanup.

## Responsibilities

- Project dashboard.
- Public landing page (merged from the standalone `github.com/InstantML/landing` repo). The `/` route is an auth-aware Next.js server component: signed-in Clerk users are redirected to `/signin` (which in turn forwards to `/dashboard/runs` if an InstantML session is active), and visitors with no Clerk session are served the full polished landing page. The landing visual system — italic-serif headlines, emerald palette, grid+glow background, bento cards, animated hero spotlight — is preserved in `components/landing/`. See `docs/design/2026-05-17-landing-merge-into-web.md`.
- Clerk hosted sign-in/sign-up, local Google-style dev auth fallback, Free/Pro/Premium signup plan selection, Stripe Checkout redirect for paid signup, onboarding, organization invitation acceptance at `/invite#t=...`, and copy-once SDK API-key creation. For managed Clerk signups, the org-name input and account-type picker are hidden; the server auto-derives the workspace name and Free/Pro/Premium selection remains visible. Paid signups return a `billing_checkout.url` and redirect to Stripe before writes/API-key creation are unlocked; free signups can still receive a ready-to-use `onboarding_api_key` rendered immediately without a separate button click. If a returning browser still has a Clerk session but InstantML cannot mint a scoped session from it, `app/auth-flow.tsx` retries with a non-cached Clerk token and then shows an explicit "refresh your sign-in" recovery path with a sign-out/restart action.
- RFC 8628 device-code confirmation page at `/auth/device`: requires a Clerk browser session, pre-fills the `user_code` from a `?code=` query parameter, auto-formats the code as `XXXX-XXXX`, and POSTs to `POST /api/auth/device-code/confirm`. On success it shows a "you can close this tab" message; on error it shows an accessible `role="alert"` banner.
- Runs workspace with run selector, sections, line/bar/histogram/dot panels, control-plane saved views, and local workspace layout fallback.
- Run detail view.
- Run comparison view.
- Metric charts with catalog, selected-run leaderboard, hover details, summaries, grouping, smoothing, and pinned panels.
- Artifact browser.
- Rollout gallery.
- Checkpoint timeline.
- Import workflow UI when needed.

Current navigation and comparison controls:

- Route-backed navigation for `Runs`, `Metrics`, `Run Detail`, `Compare`, `Alerts`, `Datasets`, `Artifacts`, `Models`, `Reports`, `Settings`, `Integrations`, and `API` at `/dashboard/:tab`, with a compact logo-only topbar brand mark and plan usage badge near account controls so filters and saved-view controls have more room.
- Unauthenticated visitors land on `/`, can sign in or sign up through Clerk in hosted mode, or through the explicitly labeled local dev Google-style flow in local mode. Signup chooses Free, Pro, or Premium, can reserve included teammate seats by email, creates a copy-once SDK API key, and then enters `/dashboard/runs`. The shared demo action signs in as `hello@instantml.ai`, reuses the Premium-tier `InstantML Demo` org/service, skips SDK-key reveal, and is enforced read-only server-side so demo visitors browse sample data instead of pushing data. In hosted ClickHouse mode, auth writes users/orgs/sessions/API keys and tenant-route plan metadata to the User Data control table while dashboard reads resolve the org's tenant data plane server-side.
- Collapsible left rail that stays narrow by default, expands on hover/focus, stays pinned during desktop page scroll, and can be pinned open.
- Light/dark mode toggle with a persisted local preference. Dark mode uses neutral dark surfaces with explicit accent states; primary button styling is opt-in via `.primary-button` instead of a broad global button selector.
- Refresh/loading experience: the root layout applies the saved theme before paint and the app shows a branded loading shell during the first dashboard API load instead of flashing an empty white page.
- Desktop `Runs` workspace with a top filter rectangle, left run selector, searchable panel canvas, collapsible sections, add-panel drawer, edit drawer, and fullscreen panel inspection.
- Metrics, Run Detail, and Compare now share the analysis-suite layout: compact header stats, responsive toolbars, chart-first metric inspection, a Run Detail metric picker/dossier, and row-first comparison evidence that visually matches the Runs workspace.
- Run Detail now contains a local Pluto-style Run Workspace with a sticky run header and Summary, Data, Logs, Files, System, and Graph sections. These are intentionally local run tabs, not new global dashboard tabs.
- Logs fetch `GET /api/runs/:id/logs` only when the local Logs section is opened, render stdout/stderr through a virtualized terminal with safe ANSI spans, and keep search bounded to the selected run/stream.
- Files is an evidence explorer over the selected run's existing artifact and rich-object endpoints. It previews checkpoints, uploaded files, media objects, table objects, and histograms without introducing a separate file storage layer. Run Detail summary also surfaces checkpoint artifacts directly, with download and `Resume Code` copy actions that start resumed SDK runs in project `checkpoints`.
- Compare workspace with selected-run caps, reference switching, Diff-only filtering, row-first and column matrix layouts, addable metric columns, clickable table-column sorting, evidence/run/config sorting, full metric/config/artifact labels, tags/notes/artifact context, a compact best-run/delta summary, and saved-view restore that prunes stale run IDs after data resets.
- Compare row mode uses readable metric-table headers with namespace/objective sublabels; non-zero artifact counts jump to the selected-run Artifacts tab instead of acting as inert numbers.
- Keyboard workflow MVP: `Cmd/Ctrl+K` quick search, `?` shortcut help, `Esc` top-overlay dismissal, `Cmd/Ctrl+Z` undo, `Cmd+Shift+Z` / `Ctrl+Y` redo, `Cmd/Ctrl+.` Runs selector collapse, `Cmd/Ctrl+J` Runs/canvas focus handoff, and Left/Right Arrow fullscreen panel traversal.
- Runs rail bulk-selection: the rail header has a tri-state master checkbox that selects or clears every run on the current page, shift-clicking a run extends the selection from the last interacted run, and a banner offers "Select all N matching filter" (capped at `MAX_SELECTED_RUNS = 2000`) when more runs match the filter than fit on the visible page, including after filters clear the current selection to zero. Bulk selection pages through the Rust `projection=selection` response so it does not fetch full ClickHouse metric aggregates for every selected run, and both summary/search loads and bulk-selection pages retry short transient proxy/backend failures before showing a global API issue. The dashboard auto-selects the first `DEFAULT_SELECTED_RUNS = 100` most recent runs once on initial load; explicit empty selections and large cross-page selections are preserved across search/filter refreshes. Workspace and Metrics line panels load selected-run series through bounded adaptive `POST /api/metrics/series` chunks with adaptive per-series point limits, retry transient proxy/backend failures, and patch the chart as chunks return, so the rail can drive 2,000-run selections without N per-run requests.
- Production polish from Computer Use QA: modal/drawer focus traps, safer quick-search routing while typing, tokenized run search such as `seed 13`, visible panel action affordances, compact run rows, responsive Run Detail KPI wrapping, horizontally contained Compare matrices, and polished fullscreen panel charts with non-duplicated headers.
- The topbar sliders button now has an honest state on both desktop and mobile: it collapses/expands the run-filter workbar on desktop and opens the mobile filter drawer on phones.
- W&B/Grafana-inspired workspace behavior: automatic mode creates a capped high-signal set of line panels from logged metric keys grouped by prefix; the metric catalog and single top-level add-panel drawer expose the full key set plus chart type choices. Manual mode starts blank so researchers can add only the panels they need. Runs workspace line panels plot explicitly selected runs first, with selection capped at 2,000 runs, then fall back to the filtered page/top-N preview when nothing is selected. Dense line charts render series paths on canvas while preserving SVG axes, gridlines, labels, and range controls. Bar, histogram, and dot panels summarize latest metric values from run summaries so researchers can inspect distributions without fetching full histories. Panel headers distinguish plotted series from selected runs, legends show every plotted series up to the compact legend cap, and selected runs that do not log a line-panel metric are called out with a `no data for metric` chip. Panels can be dragged between sections or into the unsectioned area and resized from their lower-right handle; placement and size are saved in the workspace layout.
- True x/y scatter, parallel coordinates, media, query, and text panels still need the future field catalog described in `docs/design/2026-05-10-runs-workspace-panels.md`.
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
- Save dashboard project preference and named workspace views through the Rust control-plane API, with validated `localStorage` fallback when the API is unavailable during local development.
- Compare selected runs in either a column-oriented matrix or row-oriented run scan mode. Compare includes diff-only mode, row search, row sorting, addable metric columns, clickable sorting for run/metric/annotation/artifact/config columns, run sorting by name/status/duration/tags/notes/config/artifact/metric values, reference highlighting, saved-view persistence, visible tags/notes, and a 50-run cap that matches the current Rust side-by-side endpoint.
- Copy selected-run artifact IDs and API route snippets directly from the `Artifacts` and `API` tabs. Run Detail and Compare render safe same-origin image/MP3/MP4 artifact previews when stored bytes are available, including R2-backed hosted artifacts served through `/api/artifacts/:id/download`; unsupported or external-reference artifacts fall back to copy-only/unavailable actions. Raw artifact URIs are redacted in the UI so object-storage URLs, signed query strings, and bucket paths do not leak.
- Browse active-run rich logged objects in Run Detail and Artifacts. The first slice renders table previews, histogram bars, and media cards from `GET /api/runs/:id/objects` plus bounded `GET /api/objects/:id/rows` table reads. Hidden tabs do not fetch object manifests, and Compare keeps using existing artifact context to avoid extra selected-run fan-out.
- Address tabs through real routes such as `/dashboard/runs`, `/dashboard/alerts`, and `/dashboard/api`; legacy hashes such as `#runs` normalize to the matching dashboard route.
- Derived workspace tabs use current summaries, selected-run artifacts, local saved views, and documented API routes. They do not yet imply persistent alert, dataset, report, model registry, or integration credential storage.
- Settings now includes plan and usage visibility, Stripe billing controls, token-backed invite/list controls, pending invitation resend/revoke actions, and seat accounting that includes active members plus unexpired pending invitations. Metric-point usage is shown for the current UTC calendar month with its reset date; storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource counts that do not reset monthly. Storage combines exact InstantML-owned local/R2 artifact bytes with exact ClickHouse table bytes for dedicated tenant databases and falls back to metadata estimates only when exact per-org warehouse bytes are unavailable, such as shared-cell orgs. External/imported artifact sizes stay metadata-only and do not consume retained-storage quota. The topbar mirrors the highest usage percentage in a compact badge near account controls. The API tab now lists keys, creates copy-once keys, revokes keys, and still shows request snippets for SDK/API users.

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
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:build
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:start
```

Then open `http://127.0.0.1:3000`, sign up with Clerk when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are configured, or use the labeled local dev Google-style flow in local mode. Choose a Free/Pro/Premium plan, optionally invite included seats, create the copy-once SDK key, and enter the dashboard.

For paid signup and Settings billing controls, configure the Rust API with
`STRIPE_SECRET_KEY` and optionally `STRIPE_WEBHOOK_SECRET` plus
`STRIPE_*_PRICE_ID` values. The frontend uses same-origin `/api/billing/*`
rewrites and redirects to the Stripe-hosted Checkout/Portal URLs returned by the
API; no Stripe secret or card data is exposed to the browser.

Returning hosted users can land on `/signin` with Clerk still showing an account while the InstantML session cookie has expired or the cached Clerk token is too old for the Rust exchange. The page first retries `POST /api/auth/clerk` with `getToken({ skipCache: true })`. If that still returns unauthorized, use the visible recovery actions: try a fresh token once more, then sign out and restart sign-in to refresh the browser's Clerk state.

Fast development server:

```bash
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Run against the hosted Cloud Run Rust API:

```bash
npm run web:dev
```

When no explicit API base is set, the frontend rewrites default to the
production router `https://api.instantml.ai`. Staging and preview frontend
builds should set `INSTANTML_WEB_API_ENV=staging` to route all same-origin API
rewrites through `https://staging.api.instantml.ai`; leave it unset, or set it
to `prod`, for pushed production builds. This variable intentionally overrides
repo-local deploy helper API-base values so staging builds do not accidentally
inherit a prod `.env` target.

After `npm run deploy:cloud-run` succeeds, the deploy helper writes hosted API
settings into `apps/web/.env.local`. Single-service deploys write
`INSTANTML_API_BASE`; split control/data deploys write
`INSTANTML_CONTROL_API_BASE` and `INSTANTML_DATA_API_BASE`. If the managed HTTPS
public router is created, the helper writes `INSTANTML_API_BASE`,
`INSTANTML_CONTROL_API_BASE`, and `INSTANTML_DATA_API_BASE` to the same router
URL. Next loads that file automatically, so local frontend development no longer
needs a local Rust server.
If you point at a different hosted API manually, set `INSTANTML_API_BASE` for a
combined service or set both split bases for control/data before running
`web:dev`, `web:build`, or `web:start`. Non-loopback API origins must also be
listed in `INSTANTML_API_ALLOWED_ORIGINS`.

Invite links use `/invite#t=<token>` so the token is not sent to the server as a
URL path or query string. The invite page reads the fragment once, removes it
from browser history, keeps only a short timestamped session-storage fallback
for Clerk redirect handoffs, previews the invitation through
`/api/invitations/preview`, and then exchanges a fresh verified Clerk session
or local dev identity with `accept_invite_token` before opening
`/dashboard/runs`. In managed Clerk mode, the page does not accept invitations
through an existing InstantML session cookie; it re-checks Clerk, preserves the
short invite handoff token, and clears the InstantML session when the browser
is signed in as the wrong account. Settings hides invitation and billing
mutation controls from non-admin sessions, shows pending invitation delivery
status plus resend/revoke controls for admins, and exposes ephemeral copy/open
links for log-provider invites immediately after create/resend for deterministic
local and staging checks.

When the hosted API returns `code: "warehouse_unavailable"` with HTTP `503`, the
dashboard treats the API as reachable and shows a "Starting data warehouse"
loading state while retrying. This is the expected user-facing state when an
org's tenant ClickHouse warehouse is waking after idle; User Data/control
failures should remain separate operational alerts.

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

`apps/web/tests/landing-page.test.js` covers: all 8 ported component exports, `"use client"` directives, ThemeToggle localStorage key alignment, `app/page.tsx` server-component wiring (no `"use client"`, imports `auth` and `redirect`, redirects signed-in users, renders `LandingPage` for signed-out), polyline helper correctness, timestamp helper correctness, TtlRing circumference math, CSS selector presence, and logo.svg + design doc existence. `apps/web/tests/auth-flow-recovery.test.js` locks the stale hosted-Clerk recovery contract: 401 retry with `skipCache`, visible user instructions, and responsive recovery actions. These tests run via `node --test` without a browser.

The default browser smoke starts disposable ClickHouse and the Rust API, builds the Next app, starts `next start`, verifies the public landing page does not fetch dashboard summaries, signs up through the local dev Google-style flow with a Pro plan, creates a copy-once SDK API key, seeds demo data through the signed-in session, verifies Settings usage/seats and the topbar usage badge, verifies API-key create/revoke UI, verifies the initial dashboard load, asserts hidden rich-object/log fetches stay gated, and captures a screenshot. Set `INSTANTML_UI_SMOKE_FULL_WORKSPACE=1` to run the longer workspace regression that exercises route-backed tabs, run inspection, Runs workspace add/edit/collapse/fullscreen panel flows, drag-and-resize layout persistence, focus traps, tokenized search, tag/note editing, selected-run plotting, chart hover/zoom, rich-object previews, Compare layouts/sorting/reference switching, artifact/API affordances, and responsive viewports. `npm run test:ui`, `npm run test:ui:direct`, and direct no-env invocation of `node apps/web/tests/ui-smoke.mjs` all use the Rust/ClickHouse harness.

The hosted ClickHouse smoke is API/SDK-facing rather than browser-facing: it signs up, creates an SDK key, verifies User Data control rows, writes direct and Python SDK runs into the routed tenant database, restarts the API, and verifies the dashboard summary endpoint can still read the ingested runs.

The smoke also covers the keyboard-workflow MVP: shortcut help, quick search to run detail, compact rail-label search for long run names, Runs selector collapse/restore, Runs/canvas focus handoff, `Esc` drawer dismissal, workspace undo/redo, and fullscreen panel arrow traversal.

The Runs workspace keeps its summary/filter block pinned below the top bar on desktop, with both the selector rail and panel toolbar pinned underneath it while panel sections scroll. The run rail uses compact selected-run rows and a fixed footer so pagination controls remain visible.

Pagination coverage includes Rust cursor requests, cursor clearing after filter changes, Previous-page behavior, and deprecated Node offset fallback.

Set `INSTANTML_UI_SMOKE_API_BASE` to point the same smoke at an already running Rust-compatible backend. The full landing/auth/onboarding smoke depends on Rust session endpoints; deprecated Node UI checks should be treated as compatibility-only and kept behind explicit legacy investigation.

## Current Files

- `app/layout.tsx` — includes logo-intro animation boot script
- `app/loading.tsx`
- `app/loading-screen.tsx`
- `app/page.tsx` — auth-aware server component; unauthenticated renders `LandingPage`, Clerk-authenticated redirects to `/signin`
- `app/auth-flow.tsx`
- `app/invite/page.tsx`
- `app/signin/page.tsx`
- `app/signup/page.tsx`
- `app/onboarding/page.tsx`
- `app/auth/device/page.tsx`
- `app/dashboard/[[...tab]]/page.tsx`
- `app/dashboard/components/run-workspace.tsx`
- `app/dashboard/dashboard-shell.tsx`
- `app/dashboard-components.tsx`
- `app/dashboard-config.tsx`
- `app/dashboard-models.ts`
- `app/dashboard-types.ts`
- `app/globals.css` — thin `@import` chain; all rules live in `app/styles/`. See below.
- `app/styles/tokens.css` — brand primitives + light/dark design tokens (`:root`)
- `app/styles/base.css` — global reset, typography, button defaults
- `app/styles/landing.css` — marketing page + auth card surfaces (`.landing-*`, `.auth-*`)
- `app/styles/dashboard.css` — shell, topbar, brand-mark, tabs, nav rail
- `app/styles/dashboard-runs.css` — runs workspace rail, rows, filter strip
- `app/styles/panels.css` — workspace panels, canvas, sections, modals
- `app/styles/charts.css` — metric charts, axes, series, range, tooltip
- `app/styles/run-detail.css` — run detail, KPIs, inspector, evidence, timeline
- `app/styles/compare.css` — compare view, leaderboard, evidence cells
- `app/styles/dark-overrides.css` — dark-theme overrides (Phase 3 target: dissolve into each file)
- `app/styles/overhaul.css` — visual overhaul layers 2026-05-15 (Phase 3 target: merge into canonical files)
- `app/styles/mobile.css` — mobile redesign ≤720px
- `app/styles/landing-system.css` — landing visual system + `@keyframes` animations
- `app/icon.svg`
- `components/landing/LogoMark.tsx` — InstantML mark SVG (server component)
- `components/landing/NavLogo.tsx` — logo + wordmark with intro animation (server component)
- `components/landing/ThemeToggle.tsx` — CSS-only icon-swap toggle, writes `instantml:next:theme` (client)
- `components/landing/HeroSpotlight.tsx` — Lissajous-drift radial spotlights + scroll parallax (client)
- `components/landing/MaskingDemo.tsx` — decorative animated loss-chart SVG (client)
- `components/landing/AuditFeed.tsx` — decorative SDK-event marquee terminal (client)
- `components/landing/TtlRing.tsx` — p95-latency dial with animated sweep (client)
- `components/landing/LandingPage.tsx` — full landing page layout (client, composes all above)
- `public/logo.svg` — standalone SVG logo for favicon/meta use
- `proxy.ts`
- `src/api.js`
- `src/charts.js`
- `src/evidence.js`
- `src/routes.js`
- `src/shortcuts.js`
- `src/state.js`
- `src/terminal.js`
- `src/workspace.js` — `deriveClerkSlug` and `slugify` helpers (mirrors server-side slug logic for UI preview)
- `next.config.mjs`

## Relevant Design Docs

- `docs/design/2026-05-17-landing-merge-into-web.md` — landing port, auth-aware `/` route, CSS scoping, migration plan, coverage exceptions
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
- `docs/design/2026-05-16-device-code-cli-login.md`
- `docs/design/2026-05-16-gcp-cloud-run-rust-api.md`
- `docs/design/2026-05-16-pricing-signup-org-admin.md`
- `docs/design/2026-05-16-auto-personal-workspace.md`
- `docs/design/2026-05-17-dashboard-reliability-control-views.md`
- `docs/product/pricing-and-margins.md`
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
- Keep chart DOM bounded: sparse line charts use SVG paths and capped markers; dense charts switch to a canvas path layer so 1,000+ plotted runs do not create thousands of SVG series nodes.
- Keep frontend API failures client-safe. Do not display raw backend stack traces, SQL paths, object-storage paths, or auth details in the topbar.
- Keep same-origin API proxy configuration server-only in production; `INSTANTML_API_BASE` is validated by `next.config.mjs`, and production non-loopback origins must be listed in `INSTANTML_API_ALLOWED_ORIGINS`.
- Keep saved views validated before applying them. Control-plane saved views are the source of truth when authenticated; local saved views are a fallback and must stay namespaced by org/project/user-derived keys.
- Keep shared data-shaping helpers in `src/` so Node tests can cover important UI logic without requiring a browser.
- Keep global keyboard matching in `src/shortcuts.js` and keep browser smoke coverage around any command that changes routing, layout, or overlay state.
- Keep reusable React surfaces in `app/dashboard-components.tsx`, stable navigation/integration config in `app/dashboard-config.tsx`, and view-model helpers in `app/dashboard-models.ts`.
- Keep styling in `app/styles/`; `app/globals.css` is the thin entry-point `@import` chain only. Components should emit semantic class names rather than introduce CSS modules or inline visual systems. Add new rules to the most specific split file for the feature area. Prefer adjusting shared tokens in `tokens.css` before creating one-off component styles. See `docs/design/2026-05-18-globals-css-audit.md` for the split rationale and Phase 3 dedup plan.
- Keep run-table sorting server-side when pagination is active; client sorting should not reorder only the current page.
- Keep selected run details cached separately from the current page so comparisons survive page changes.
- Prune stale saved-view run IDs against the API before rendering Compare; a saved local view must never claim selected runs that no longer exist.
- Keep Runs workspace panel queries bounded by selected runs up to `MAX_SELECTED_RUNS` or filtered page/top N plus metric point limits; do not fetch full metric histories for the panel grid.
- Keep hidden tab data fetches gated by active tab. Runs should not load Metrics, Run Detail, Compare, or artifact-only data during initial dashboard entry unless that tab is active.
- Keep workspace layouts schema-versioned and sanitized before applying. The Rust/ClickHouse workspace-views API owns authenticated persistence; local storage is only a compatibility and offline-development fallback.
- The first hosted auth/onboarding and token-backed organization invitation slices exist. Follow-ups are richer provider webhook delivery state, broader organization switching polish, and expanded auth/no-access recovery copy.

## API type codegen

The Rust handlers in `apps/rust-server/src/http/handlers.rs` carry
`#[utoipa::path(...)]` macros. `apps/web/src/types/api.generated.ts` is
emitted from that spec — do not edit it by hand.

```bash
# regenerate the spec + TS bindings after any Rust handler change
npm run codegen:api

# CI guard — fails if the committed generated files are out of date
npm run verify:api-types
```

Frontend code consuming a generated type should import it as:

```ts
import type { components } from "../../src/types/api.generated";

type RunRow = components["schemas"]["RunRow"];
type SeatRow = components["schemas"]["SeatRow"];
```

See `docs/design/2026-05-19-utoipa-migration.md` for the rollout plan and
which hand-rolled types in this app are next on the list to migrate.

Known simplification follow-ups from review:

- Continue shrinking `app/page.tsx` when a workflow becomes complex enough to justify a dedicated container component.
- Add URL/query persistence for high-value daily-workflow state after the named saved-view format settles.
- Keep `npm run test:ui` covering pagination, Runs workspace sections/panels, add/edit/fullscreen panel flows, regex metric filtering, named saved views, reference-run comparison, multi-metric panels, and the 1280px viewport.
