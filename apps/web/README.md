# Web App

This directory contains the Next/React frontend application for InstantML. It is responsible for browsing projects, comparing runs, charting metrics, viewing artifacts, and inspecting training-loop debugging panels.

Backend note: the UI targets the Rust/ClickHouse API in `apps/rust-server` by default. The deprecated Node API in `apps/server` remains available for compatibility checks. Keep UI data access on documented REST routes and bounded summary/series endpoints so both backends stay comparable during migration cleanup.

## Responsibilities

- Project dashboard.
- Public landing page (merged from the standalone `github.com/InstantML/landing` repo). The `/` route is an auth-aware Next.js server component: signed-in Clerk users are redirected to `/signin` (which in turn forwards to `/dashboard/runs` if an InstantML session is active), and visitors with no Clerk session are served the full polished landing page. The landing visual system — italic-serif headlines, emerald palette, grid+glow background, bento cards, animated hero spotlight — is preserved in `components/landing/`. See `docs/design/2026-05-17-landing-merge-into-web.md`.
- Public documentation at `/docs` and `/docs/:path*`. The route is rendered by
  the same Next app from the public docs source in `apps/docs`, keeping
  production docs same-origin until a separate docs domain is intentionally
  reintroduced. The public landing nav and authenticated dashboard chrome link
  directly to `/docs`. Markdown mirrors are available at `/docs/:path*.md`,
  with `/llms.txt` and `/llms-full.txt` for agent-readable ingestion. Every
  rendered docs page includes a copy action for its generated `.md` body and an
  adjacent raw `.md` link. The onboarding and empty-workspace first-run setup
  surfaces link to both
  `/docs/quickstart` and `/docs/quickstart.md` so users can follow the guide or
  paste the agent-readable version into an assistant.
- Clerk hosted sign-in/sign-up, local Google-style dev auth fallback, Free/Pro/Premium signup plan selection, hosted-vs-BYOC storage choice, Stripe Checkout redirect for paid signup, onboarding, organization invitation acceptance at `/invite#t=...`, and copy-once SDK API-key creation. For managed Clerk signups, the org-name input and account-type picker are hidden; the server auto-derives the workspace name and Free/Pro/Premium selection remains visible. Paid signups return a `billing_checkout.url` and redirect to Stripe before writes/API-key creation are unlocked; free hosted signups can still receive a ready-to-use `onboarding_api_key` rendered immediately without a separate button click. Premium BYOC signups go to onboarding without an SDK key until an owner/admin validates and saves a customer-owned self-hosted GCP ClickHouse connection. Sign-in, invite acceptance, and direct `/dashboard/*` entry all redirect unready storage sessions back to onboarding until `storage_state` is `storage_ready` or `storage_locked`. If a returning browser still has a Clerk session but InstantML cannot mint a scoped session from it, `app/auth-flow.tsx` retries with a non-cached Clerk token and then shows an explicit "refresh your sign-in" recovery path with a sign-out/restart action.
- RFC 8628 device-code confirmation page at `/auth/device`: requires a Clerk browser session for an owner/admin in a billing- and storage-ready workspace, pre-fills the `user_code` from a `?code=` query parameter, auto-formats the code as `XXXX-XXXX`, and POSTs to `POST /api/auth/device-code/confirm`. On success it shows a "you can close this tab" message; on error it shows an accessible `role="alert"` banner.
- Runs workspace with run selector, sections, line/bar/value-histogram/dot/scatter/distribution/logged-histogram timeline panels, control-plane saved views, and local workspace layout fallback.
- Run detail view.
- Run comparison view.
- Metric charts with catalog, selected-run leaderboard, hover details, summaries, grouping, smoothing, and pinned panels.
- Selected-run data export from the Runs command bar plus opt-in plotted-data
  CSV and chart-image downloads on Metrics and Runs workspace line charts.
- Artifact collections/detail/lineage workspace plus the legacy raw artifact browser, with bounded inline csv/json/text previews (first 16 KB streamed over the existing download route).
- Rollout gallery.
- Checkpoint timeline merged into Run Detail (lineage URI + eval return on each checkpoint row; `/dashboard/checkpoints` and `/dashboard/models` canonicalize to `/dashboard/detail`).
- Imports and integrations workspace for adoption: copy-ready W&B/Neptune/TensorBoard/MLflow CLI commands, Import v2 dry-run status, schema mapping, polling job visibility, warning previews, commit/cancel actions, dual-logging guidance, and framework adapter snippets.

Current navigation, workspace, and comparison controls:

- Route-backed navigation for `Runs`, `Metrics`, `Distributed`, `Traces`, `Run Detail`, `Compare`, `Insights`, `Alerts` (shown as `Run health`), `Datasets`, `Imports`, `Artifacts`, `Reports`, `Settings`, and `API` at `/dashboard/:tab`, with a compact logo-only topbar brand mark and plan usage badge near account controls so filters and saved-view controls have more room. The rail groups tabs as Analyze / Workspace / More / Admin. The former `Checkpoints` tab merged into Run Detail; `/dashboard/checkpoints` and `/dashboard/models` stay routable as aliases of `/dashboard/detail`.
- With no project selected, Runs lands on an explicit "All projects" overview: one card per project (run count, active/failed, best metric, latest activity) that scopes the project filter on click, plus a "Browse all runs" escape hatch into the cross-project workspace. Per-project stat fetches are capped at 16 projects and the cap is disclosed.
- Every metric line chart carries per-panel y-axis controls: a `Log` pill (log10 scale, positive values only — hidden point counts are disclosed, and an all-non-positive window keeps the controls mounted with an explanatory empty state) and a `Y auto/min–max` popover for manual y-ranges (one-sided entries fall back to the data bound; out-of-range data clips to the plot rect). The mini range overview and SVG export share the same scale.
- Cross-highlighting on the Runs workspace: hovering a run in the rail isolates its series in every line panel; hovering a chart series or legend chip lights the matching rail row and legend chip.
- Run health summary cards (failed/active/metric points/best metric) sit at the top of the Runs workspace, scoped to the active project/status/search filters.
- Imports at `/dashboard/imports` is CLI-first. It does not ask users to paste third-party credentials into the browser. The tab renders source-specific import/sync commands, a sample dry-run action against the Import v2 job API, source-to-InstantML schema mapping, privacy posture, polling recent import jobs, warning previews, dry-run commit/cancel controls, W&B dual-logging guidance, and polished HF/Lightning/Keras adapter snippets. Browser upload remains limited to canonical chunk demonstrations and should not become the primary path for large source exports.
- Copyable import commands are dry-run-first and shell-quote workspace, project,
  path, entity, and source-project values before rendering. TensorBoard
  watch/sync examples stay in the SDK docs; the dashboard copy action favors a
  one-shot dry-run command so users review the Import v2 summary before commit.
- Reports is a persisted document workspace backed by `/api/reports`: the dashboard tab lists org reports, opens each report at `/dashboard/reports/:report_id` in a Notion-style block editor so reloads and direct links preserve context, auto-saves the first and later edits, flushes pending edits before share/export actions, and supports public read-only share links at `/r/:share_token` (share tokens expire after `INSTANTML_SHARE_TOKEN_TTL_DAYS`, default 30 days; rotating mints a fresh token). Runset configuration uses a project multi-select picker and a run search-and-pin (with raw-text fallbacks), and the reports list supports one-click duplication ("<title> (copy)") plus a "Start from template" Experiment readout starter (`src/report-templates.js`). In hosted split mode the Next proxy sends report routes to the data API because reports live with tenant product data.
- Iframe run embeds render at `/embed/runs/:session_id` without the dashboard
  shell, Clerk provider, root storage scripts, saved-view mutation, or chart
  export actions. The embed page reads a one-time fragment bearer token,
  immediately removes the fragment from browser history, fetches only
  `/api/embed/*` routes with `credentials: "omit"`, and renders read-only
  interactive line, latest-value bar/dot/histogram, scatter, and distribution
  panels. `proxy.ts` owns the embed CSP/frame headers and asks the control API
  for the approved parent origin before HTML is framed. Logged histogram
  timelines, heatmaps, and chart export actions are still dashboard-only.
- The top-right account/workspace menu is the primary organization selector. Its trigger shows the current workspace next to the account avatar, the menu searches all active memberships, groups personal and business workspaces, shows role/plan/member metadata, launches create-workspace, and links to settings, billing, and sign out. The left brandbar workspace text is passive context only.
- Create-workspace keeps organization/workspace as the same backend entity. Free workspaces can invite teammates inline; paid workspaces defer invitations until after Stripe Checkout so unpaid orgs stay billing-blocked.
- The topbar account badge uses the signed-in user's managed-auth avatar when available, then falls back to initials derived from the display name or email handle.
- Unauthenticated visitors land on `/`, can sign in or sign up through Clerk in hosted mode, or through the explicitly labeled local dev Google-style flow in local mode. Signup chooses Free, Pro, or Premium, chooses either InstantML-provisioned storage or Premium BYOC ClickHouse, can reserve included teammate seats by email, creates a copy-once SDK API key, and then enters `/dashboard/runs`. BYOC onboarding displays copy-ready self-hosted GCP ClickHouse setup SQL, the configured InstantML data-plane egress CIDRs to allowlist in the customer GCP firewall/load balancer, and an endpoint/database/user/password validation form before SDK key creation is enabled. The shared demo action signs in as `hello@instantml.ai`, reuses the Premium-tier `InstantML Demo` org/service, skips SDK-key reveal, and is enforced read-only server-side so demo visitors browse sample data instead of pushing data. In hosted ClickHouse mode, auth writes users/orgs/sessions/API keys and tenant-route plan metadata to the User Data control table while dashboard reads resolve the org's tenant data plane server-side.
- Collapsible left rail that stays narrow by default, expands on hover/focus, stays pinned during desktop page scroll, and can be pinned open.
- Light/dark mode toggle (account menu and quick search) with a persisted local preference. Dark mode uses neutral dark surfaces with explicit accent states; primary button styling is opt-in via `.primary-button` instead of a broad global button selector.
- Refresh/loading experience: the root layout applies the saved theme before paint. Public marketing routes such as `/` and `/pricing` do not install a root loading boundary, so client-side navigation between static public pages stays immediate. Direct dashboard entry resolves a valid `instantml_session` cookie server-side and seeds the dashboard shell with that session, so signed-in users see the dashboard chrome on first paint while the Runs rail/workspace show skeleton rows and panels for data loads. If the server cannot prove a session, it redirects to `/signin` before rendering the dashboard. `/signin` also redirects valid InstantML sessions server-side before rendering the auth card; only stale-cookie / Clerk-only recovery falls back to the client auth exchange.
- Desktop `Runs` workspace with a top filter rectangle, left run selector, searchable panel canvas, collapsible sections, add-panel drawer, edit drawer, and fullscreen panel inspection.
- Cooperative stop requests are available from the Runs rail, selected-runs
  command bar, and Run Detail for owner/admin/member sessions. Every entry point
  opens the same confirmation dialog, sends `runs:control` stop requests to the
  Rust API, and renders derived `stopping`/`stopped` status from `run_control`
  without changing the legacy `run.status` contract.
- Metrics, Run Detail, and Compare now share the analysis-suite layout: compact header stats, responsive toolbars, chart-first metric inspection, a Run Detail metric picker/dossier, and row-first comparison evidence that visually matches the Runs workspace.
- Distributed is a rank-aware per-run dashboard backed by `GET /api/runs/:id/rank-metrics/summary`; it renders reduce mean/weighted mean/min/max/range/stddev/p50/p95, rank coverage, heatmap cells, and outlier rows only when the tab is active.
- Traces is a project/run-scoped debugging workspace backed by `GET /api/traces`, `GET /api/runs/:run_id/traces/:trace_id`, and `GET /api/runs/:run_id/traces/:trace_id/spans`. It only fetches while the tab is active, supports run/status/kind/search filters, paginated trace summaries, deep links via `run_id`, `trace_id`, and `span_id`, stale-response guards, and lazy child-span expansion for large trees. Project-scoped trace lists use the API's recent default window; run-scoped lists are complete unless a date window is supplied, so deep links to older imported runs stay visible.
- Insights now has two views. `GPU & System` is API-backed and summarizes observed GPU telemetry by employee attribution label, project, GPU model, and run with coverage/confidence indicators; it is for optimization and triage, not tracked-hour billing. `Run Analysis` remains the local exploratory dashboard over loaded/selected run summaries, with grouped reducer comparisons, evaluation cards, hyperparameter scatter, k-means clusters, and parallel-coordinate traces. The hyperparameter scatter and parallel-coordinate explorers each offer a per-axis linear/log scale (learning-rate-like axes default to log), a `Chart`⇄`Table` toggle that exposes an accessible summary table (caption + scoped headers, ranked by the Y field / per-axis run matrix), keyboard-focusable charts with an `aria-live` readout, and honest truncation disclosure (parallel coordinates draws up to `PARALLEL_MAX_DRAWN = 200` runs and discloses "N of M" rather than silently capping).
- Run Detail now contains a local Pluto-style Run Workspace with a sticky run header and Summary, Data, Traces, Logs, Files, System, and Graph sections. These are intentionally local run tabs, not new global dashboard tabs. The Traces section fetches `GET /api/traces?run_id=...&limit=20` only when opened and links each trace to the full Traces workspace with exact `run_id`, `trace_id`, and `span_id` parameters; the run-scoped query intentionally omits `from`/`to` so older traces for the selected run are not hidden by project browsing defaults. The Summary checkpoint list can create a same-project linked fork from a checkpoint after an explicit confirmation that InstantML creates only a run record and does not start training. The Graph section fetches the selected run's bounded parent/child lineage only while the local Graph section is open.
- Logs fetch `GET /api/runs/:id/logs` only when the local Logs section is opened, render stdout/stderr through a virtualized terminal with safe ANSI spans, and keep search bounded to the selected run/stream.
- Files is an evidence explorer over the selected run's existing artifact and rich-object endpoints. It previews checkpoints, uploaded files, media objects, table objects, and histograms without introducing a separate file storage layer. Run Detail summary also surfaces checkpoint artifacts directly, with download, `Resume Code`, and linked `Fork` actions. Forked runs inherit source config by default, remain in the source project, and are selected immediately after creation so users can inspect lineage before attaching a training script.
- Compare workspace with selected-run caps, reference switching, Diff-only filtering, row-first and column matrix layouts, addable metric columns, clickable table-column sorting, evidence/run/config sorting, full metric/config/artifact labels, tags/notes/artifact context, a compact best-run/delta summary, and saved-view restore that prunes stale run IDs after data resets.
- Compare row mode uses readable metric-table headers with namespace/objective sublabels; non-zero artifact counts jump to the selected-run Artifacts tab instead of acting as inert numbers.
- Keyboard workflow MVP: `Cmd/Ctrl+K` quick search, `?` shortcut help, `Esc` top-overlay dismissal, `Cmd/Ctrl+Z` undo, `Cmd+Shift+Z` / `Ctrl+Y` redo, `Cmd/Ctrl+.` Runs selector collapse, `Cmd/Ctrl+J` Runs/canvas focus handoff, number keys `1-9` for rail-order tab jumps, and Left/Right Arrow fullscreen panel traversal.
- Run selection is mirrored into a capped `?runs=` URL parameter (explicit selections only), so compare/chart context survives reloads and can be shared; a bottom selection tray offers Compare / Export CSV / Clear whenever a selection exists.
- The Runs tab offers a Panels ⇄ Table view toggle (persisted per browser); the table view is a flat sortable run list with a table-local column chooser for status/tags/notes/started/duration/metric columns.
- Charts render at their measured CSS-pixel size (the SVG viewBox matches the frame), so axis text and strokes never stretch with panel width; smoothing keeps the raw series visible as a faded ghost line under the EMA curve.
- Runs rail bulk-selection: the rail header has a tri-state master checkbox that selects or clears every run on the current page, shift-clicking a run extends the selection from the last interacted run, and a banner offers "Select all N matching filter" (capped at `MAX_SELECTED_RUNS = 2000`) when more runs match the filter than fit on the visible page, including after filters clear the current selection to zero. Bulk selection pages through the Rust `projection=selection` response so it does not fetch full ClickHouse metric aggregates for every selected run, and both summary/search loads and bulk-selection pages retry short transient proxy/backend failures before showing a global API issue. The dashboard auto-selects the first `DEFAULT_SELECTED_RUNS = 100` most recent runs once on initial load; explicit empty selections and large cross-page selections are preserved across search/filter refreshes. Workspace and Metrics line panels load selected-run series through bounded adaptive `POST /api/metrics/series` chunks with adaptive per-series point limits, retry transient proxy/backend failures, and patch the chart as chunks return, so the rail can drive 2,000-run selections without N per-run requests.
- Selected-run CSV export downloads raw selected-run data through
  `/api/export?format=csv&run_ids=...`; the action announces why export is
  unavailable when nothing is selected or the 100-run synchronous export cap is
  exceeded. Chart export buttons download the already plotted/zoomed sample,
  not unsampled full history, and are disabled above 120 series or 20,000
  plotted points.
- Run search uses one server-backed `q` language across `/runs`, summaries, overview, selection projection, and export: bare text preserves legacy implicit-AND matching, while `tag:baseline`, `status:finished`, `name:"long context"`, `-tag:debug`, `(tag:baseline OR tag:candidate)`, and `re:/seed-(13|14)/` add precise filters. The topbar search help icon documents the syntax in place; invalid search syntax shows an inline error while preserving the last valid run page, and "Select all matching" stays disabled until the committed query is valid.
- Production polish from Computer Use QA: modal/drawer focus traps, safer quick-search routing while typing, server-backed run search, visible panel action affordances, compact run rows, responsive Run Detail KPI wrapping, horizontally contained Compare matrices, and polished fullscreen panel charts with non-duplicated headers.
- The topbar sliders button now has an honest state on both desktop and mobile: it collapses/expands the run-filter workbar on desktop and opens the mobile filter drawer on phones.
- W&B/Grafana-inspired workspace behavior: the Runs workspace auto-generates a capped high-signal starting board of line panels from logged metric keys grouped by prefix; any add/remove/edit/move/resize action preserves the user's curated layout, and `Rebuild layout` regenerates the starting board when needed. The metric catalog and single top-level add-panel drawer expose the full key set plus chart type choices. Runs workspace line panels plot explicitly selected runs first, with selection capped at 2,000 runs, then fall back to the filtered page/top-N preview when nothing is selected. Dense line charts render series paths on canvas while preserving SVG axes, gridlines, labels, and range controls. Bar, value histogram, dot, scatter, and seed/group distribution panels summarize already loaded run summaries so researchers can inspect distributions, ablation stability, and numeric tradeoffs without fetching full histories. Scatter and distribution fields come from metric aggregates, numeric/categorical config or metadata leaves, run status, first tag, duration, and created time; their scope is selected runs when a selection is active, otherwise visible loaded runs capped by the panel limit. Logged histogram timeline panels fetch at most 100 histogram rich objects for one primary run and one explicit key, rendering compatible-bin heatmaps or selected-frame fallbacks when bins changed. Panel headers distinguish plotted series from selected runs, legends show every plotted series up to the compact legend cap, and selected runs that do not log a line-panel metric are called out with a `no data for metric` chip. Panels can be dragged between sections or into the unsectioned area and resized from their lower-right handle; placement and size are saved in the workspace layout.
- Parallel-coordinate analysis remains in Insights as an exploratory HPO/sweep
  view over loaded summaries. Media, query, and text workspace panels still
  need future contracts.
- Agent-review hardening: run names inspect a primary run, checkboxes are reserved for compare selection, visible table-column preferences remain available through the `Columns` menu, and empty filters render a clear action in the run rail.
- Tags and notes are first-class run identification fields in the current UI: the Runs table has a default `Notes` column, the workspace selector shows compact tag chips plus a one-line note preview, and server-backed search matches exact tags with `tag:`/`tags:` and note text with `notes:` through the Rust `q` route. Run Detail and Compare share a small editor that saves `runs.tags` and `metadata.notes` through `PATCH /runs/:id`; Compare has its own edit-run picker so annotation does not change the reference run.
- Large-run browsing is server-backed: the Runs workspace uses Rust `next_cursor` values for Next/Previous pagination, falls back to offset pagination for the deprecated Node compatibility server, clears cursors when filters/sorts/page size change, and disables pagination while a page request is in flight. The benchmark target is now 100,000 run records with a 20,000-step long-run series; the earlier 90,000-run benchmark slice measured production first useful render at 387 ms locally on 2026-05-11, and the current hosted GCP showcase stayed sub-second on 50,000 runs / 522M metric points on 2026-05-23.
- Durable async SDK logging surfaces as a compact upload-health chip in the
  Runs rail when runs emit `system/instantml/*` heartbeat metrics. The
  dashboard silently polls the current summary page every 5 seconds while
  visible, and normal metric selectors hide those internal SDK health keys.
- Sort runs by newest, selected metric latest/best, name, status, or duration.
- Group chart series by seed, first tag, or selected config keys.
- Switch chart x-axis between step and logged time.
- Smooth chart lines and show grouped averages.
- Use normalized `0..1` y-axes for unit-bounded metrics such as accuracy, F1, precision, recall, and AUC while keeping return/loss/reward metrics auto-scaled.
- Drag a chart range brush in metric and fullscreen panel charts to inspect an x-range; the main chart fits to the visible points inside the brush and recalculates the y-axis so returns/rewards/losses auto-fit the inspected segment.
- Inspect chart points with visible markers, axis labels, ticks, and hover readouts that show the run name and metric value in both metric charts and Runs workspace panel charts.
- Browse available metrics by namespace, coverage, point count, goal-aware best/lowest value, and selected-run presence.
- Inspect selected runs through a detail dossier with a per-run metric chart, timeline, reproducibility fields, metric aggregate table, source metadata, config, tags, and artifact preview/copy actions.
- Save dashboard project preference and named workspace views through the Rust control-plane API, with validated `localStorage` fallback when the API is unavailable during local development. Shared saved views can be exported as portable JSON, imported only after a current dry-run preview of the same <=128 KiB JSON payload, and soft-deleted with an `updated_at` conflict check; embedded selected/current run IDs are stripped so the agent-facing `/api/workspace-view-data` route accepts a portable view plus explicit run IDs and returns bounded data for the panels it can reproduce. Project preference loading gates the initial runs query so the first dashboard read does not fetch all projects and then immediately refetch the preferred project. Local saved views and workspace layouts are scoped by active org, user email, and project; old org-only and project-only local keys are copied into the scoped key on first authenticated load so existing browser layouts remain visible.
- Compare selected runs in either a column-oriented matrix or row-oriented run scan mode. Compare includes diff-only mode, row search, row sorting, addable metric columns, clickable sorting for run/metric/annotation/artifact/config columns, run sorting by name/status/duration/tags/notes/config/artifact/metric values, reference highlighting, saved-view persistence, visible tags/notes, and a 50-run cap that matches the current Rust side-by-side endpoint.
- Browse versioned artifact collections in the `Artifacts` tab with collection search/type filters, version summaries, manifest downloads, bounded lineage, and owner/admin management controls for `best`, retention, and soft delete. Legacy raw run artifacts remain visible in a separate panel for existing media, rich-object, checkpoint, and importer workflows; imported external artifact references are also mirrored into run-level metadata-only versioned bundles so migrated W&B/Neptune/MLflow runs appear in catalog lineage without byte migration. Run Detail and Compare render only safe same-origin media previews from an explicit PNG/JPEG/WebP/GIF, MP3/WAV/AAC/M4A, and MP4/WebM/MOV allowlist when stored bytes are available, including R2-backed hosted artifacts served through `/api/artifacts/:id/download`; SVG/HTML and unsupported or external-reference artifacts fall back to copy-only/unavailable actions. Raw artifact URIs are redacted in the UI so object-storage URLs, signed query strings, and bucket paths do not leak.
- Browse active-run rich logged objects in Run Detail and Artifacts. The first slice renders table previews, histogram bars, and media cards from `GET /api/runs/:id/objects` plus bounded `GET /api/objects/:id/rows` table reads. Hidden tabs do not fetch object manifests, and Compare keeps using existing artifact context to avoid extra selected-run fan-out.
- Address tabs through real routes such as `/dashboard/runs`, `/dashboard/alerts`, and `/dashboard/agent`; legacy hashes such as `#runs` normalize to the matching dashboard route, and old `/dashboard/api` links canonicalize to `/dashboard/agent`.
- Derived workspace tabs use current summaries, selected-run artifacts, local saved views, and documented API routes. They do not yet imply persistent alert or dataset registry storage; Reports is the exception and uses the persisted `/api/reports` surface. The Agent tab is the agent-first setup and workflow surface: it connects Claude Code, Codex, Cursor, VS Code, and local bridge clients to the hosted MCP server, defaults to browser sign-in, and shows capability and prompt-starter affordances; OAuth snippets are scoped to the currently selected workspace with an `org_id` URL parameter.
- Settings now includes plan and usage visibility, plan API rate policies, Stripe billing controls, token-backed invite/list controls, pending invitation resend/revoke actions, API key management/reference, and seat accounting that includes active members plus unexpired pending invitations. Metric-point and API-request usage are shown for the current UTC calendar month with the reset date; storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource counts that do not reset monthly. Free/non-billable API request overage is blocked, while paid Pro/Premium request overage is Stripe-metered. Hosted storage combines exact InstantML-owned local/R2 artifact bytes with exact ClickHouse table bytes for dedicated tenant databases and falls back to metadata estimates only when exact per-org warehouse bytes are unavailable, such as shared-cell orgs. BYOC storage guardrails count only InstantML-owned artifact bytes and never include customer-owned ClickHouse database bytes. External/imported artifact sizes stay metadata-only and do not consume retained-storage quota. The topbar mirrors the highest metric, storage, or API-request usage percentage in a compact badge near account controls. Workspace settings -> API lists request snippets for every session, but API-key listing/create/revoke controls are owner/admin-only and stay disabled or hidden for read-only members.

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
- Trace workspace tests for route registration, source-level API contracts,
  stylesheet wiring, and the targeted authenticated Rust/ClickHouse trace smoke.
- Search tests for bare text, tags, boolean operators, regex success, inline
  validation errors, and stale/invalid select-all guards.
- Integration tests for API-backed views where practical.
- Accessibility checks for core workflows.

## Run

Install dependencies from the repo root first:

```bash
npm ci
npx playwright install chromium
```

Default frontend development runs the Next app on localhost and points its
server-side rewrite proxy at the hosted staging API:

```bash
INSTANTML_WEB_API_ENV=staging npm run web:dev
```

Then open `http://127.0.0.1:3000`. Hosted sign-in requires
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the same Clerk application as the
staging backend. Keep both values in `apps/web/.env.local` if you prefer not to
pass the env var every time:

```text
INSTANTML_WEB_API_ENV=staging
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<staging Clerk publishable key>
```

`INSTANTML_WEB_API_ENV=staging` routes all same-origin API rewrites through
`https://staging.api.instantml.ai` and intentionally overrides repo-local API
base values unless `INSTANTML_WEB_EXPLICIT_API_BASES=1` is set. Do not set
`INSTANTML_API_BASE` for this default staging-router workflow. Restart
`next dev` after changing rewrite env.

Iframe embed local QA uses the same local Rust/ClickHouse API plus a temporary
parent website. Start the API with embeds enabled:

```bash
INSTANTML_EMBED_ENABLED=1 \
INSTANTML_EMBED_FRAME_ENABLED=1 \
INSTANTML_EMBED_TOKEN_HMAC_SECRET=local-embed-secret \
npm run dev:api
```

Start the web app against that local API:

```bash
INSTANTML_WEB_EXPLICIT_API_BASES=1 \
INSTANTML_API_BASE=http://127.0.0.1:8000 \
INSTANTML_CONTROL_API_BASE=http://127.0.0.1:8000 \
INSTANTML_DATA_API_BASE=http://127.0.0.1:8000 \
INSTANTML_API_ALLOWED_ORIGINS=http://127.0.0.1:8000 \
npm run web:dev
```

Create an embed session from a backend or script with an `export:read` API key
and `allowed_parent_origin` equal to the parent site's exact origin, then render
the returned `iframe_src`:

```html
<iframe
  src="http://127.0.0.1:3000/embed/runs/<session_id>#token=instantml_embed_..."
  sandbox="allow-scripts allow-same-origin"
  referrerpolicy="no-referrer"
  width="100%"
  height="640"
></iframe>
```

Treat the full `iframe_src` as a bearer secret and avoid screenshots that show
the fragment token. The committed public docs screenshot for iframe embeds is a
browser-verified parent page with the token hidden from the address bar and no
live token text visible. Verify expanded panel support by checking that the
iframe shows at least one non-line chart and that no export/download buttons are
present.

When backend work needs disposable local API and ClickHouse state, start the
primary Rust/ClickHouse API from the repo root:

```bash
npm run dev:api
```

Start the Next app in another terminal against that local API:

```bash
INSTANTML_WEB_EXPLICIT_API_BASES=1 \
INSTANTML_API_BASE=http://127.0.0.1:8000 \
INSTANTML_CONTROL_API_BASE=http://127.0.0.1:8000 \
INSTANTML_DATA_API_BASE=http://127.0.0.1:8000 \
INSTANTML_API_ALLOWED_ORIGINS=http://127.0.0.1:8000 \
npm run web:build

INSTANTML_WEB_EXPLICIT_API_BASES=1 \
INSTANTML_API_BASE=http://127.0.0.1:8000 \
INSTANTML_CONTROL_API_BASE=http://127.0.0.1:8000 \
INSTANTML_DATA_API_BASE=http://127.0.0.1:8000 \
INSTANTML_API_ALLOWED_ORIGINS=http://127.0.0.1:8000 \
npm run web:start
```

Then open `http://127.0.0.1:3000`, sign up with the labeled local dev Google-style flow, create the copy-once SDK key, and enter the dashboard. With explicit loopback API bases, a loopback web host, and no Clerk runtime env, `proxy.ts` bypasses Clerk middleware so `/signup` and `/signin` can use dev auth; when Clerk env is present or any explicit API base is non-local, the managed Clerk middleware still runs. Choose a Free/Pro/Premium plan, choose hosted storage or Premium BYOC ClickHouse, and optionally invite included seats. BYOC signups must first validate the customer-owned GCP ClickHouse endpoint from onboarding; any unready storage state keeps the browser on onboarding and the API key/dashboard paths stay blocked until the Rust data-plane route is ready.

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

Use explicit split bases only when you intentionally want the local Next proxy
to bypass the staging router and call direct Cloud Run services:

```bash
INSTANTML_WEB_EXPLICIT_API_BASES=1 \
INSTANTML_CONTROL_API_BASE=https://instantml-staging-control-<hash>-uc.a.run.app \
INSTANTML_DATA_API_BASE=https://instantml-staging-data-us-central1-a-<hash>-uc.a.run.app \
INSTANTML_API_ALLOWED_ORIGINS=https://instantml-staging-control-<hash>-uc.a.run.app,https://instantml-staging-data-us-central1-a-<hash>-uc.a.run.app \
npm run web:dev
```

Staging and preview frontend builds should set `INSTANTML_WEB_API_ENV=staging`.
Production builds should leave it unset, or set it to `prod`, so same-origin
rewrites target `https://api.instantml.ai`.

The `/docs` route is served by the web app in development, staging, and
production. It reads the public MDX/OpenAPI source from `apps/docs`, so run
`npm run docs:sync-openapi` after Rust OpenAPI changes and
`npm run docs:validate` before shipping docs updates. `npm run docs:dev` is
still useful for validating the Mintlify source view, but it is not required
for the Next `/docs` route. The app also rewrites `/docs/:path*.md` to a
Markdown response generated from the same source so agents can read pages such
as `/docs/quickstart.md` without HTML. Public docs pages are included in
`/sitemap.xml` from `apps/docs/docs.json` navigation and each rendered docs URL
sets a self-referencing canonical, so route metadata should be updated alongside
docs routing changes.

Staging and production frontend builds must use a
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the same Clerk application as the
backend `CLERK_SECRET_KEY`. The backend publishes its expected
`clerk_jwt_issuer` from `/api/auth/config`; the sign-in and invite pages compare
that issuer with the frontend key and show a configuration error when the build
points at the wrong Clerk instance.

The staging web container is built from `apps/web/Dockerfile`. Build it with
`INSTANTML_WEB_API_ENV=staging` and the staging
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, then deploy it as the
`instantml-staging-web` Cloud Run service. Use the resulting stable Cloud Run
origin for `INSTANTML_FRONTEND_BASE_URL` and include that origin in
`INSTANTML_ALLOWED_FRONTEND_ORIGINS` for both staging control and data services
before enabling Resend-backed invitations.
For Cloud Run web smoke tests, prefer direct split backend targets over a
web-service -> public-load-balancer loop: set
`INSTANTML_WEB_EXPLICIT_API_BASES=1`,
`INSTANTML_CONTROL_API_BASE=<staging-control-url>`, and
`INSTANTML_DATA_API_BASE=<staging-data-url>` at image build time, with both
origins in `INSTANTML_API_ALLOWED_ORIGINS`. This keeps browser calls
same-origin while the Next proxy talks directly to the intended staging
services.

After `npm run deploy:cloud-run` succeeds, the deploy helper may write hosted
API settings into `apps/web/.env.local`. Single-service deploys write
`INSTANTML_API_BASE`; split control/data deploys write
`INSTANTML_CONTROL_API_BASE` and `INSTANTML_DATA_API_BASE`. If the managed HTTPS
public router is created, the helper writes `INSTANTML_API_BASE`,
`INSTANTML_CONTROL_API_BASE`, and `INSTANTML_DATA_API_BASE` to the same router
URL. The default local development command still sets
`INSTANTML_WEB_API_ENV=staging`, which overrides those local API-base values and
keeps localhost testing on `https://staging.api.instantml.ai`.
If you intentionally point at a different hosted API manually, set
`INSTANTML_WEB_EXPLICIT_API_BASES=1`, then set `INSTANTML_API_BASE` for a
combined service or both split bases for control/data before running
`web:dev`, `web:build`, or `web:start`. Non-loopback API origins must also be
listed in `INSTANTML_API_ALLOWED_ORIGINS` unless they are first-party
`api.instantml.ai` or `staging.api.instantml.ai` router origins.

Invite links use `/invite#t=<token>` so the token is not sent to the server as a
URL path or query string. The invite page reads the fragment once, removes it
from browser history, and writes the short timestamped session-storage fallback
only for explicit Clerk handoffs such as sign-in, sign-up, or account restart;
otherwise it clears the token on `pagehide`. It previews the invitation through
`/api/invitations/preview`, and then exchanges a fresh verified Clerk session
or local dev identity with `accept_invite_token` before opening
`/dashboard/runs`. In managed Clerk mode, the page does not accept invitations
through an existing InstantML session cookie; it re-checks Clerk, preserves the
short invite handoff token, and clears the InstantML session when the browser
is signed in as the wrong account. Settings hides invitation and billing
mutation controls from non-admin sessions, shows pending invitation delivery
status plus resend/revoke controls for admins, and exposes ephemeral copy/open
links for log-provider invites immediately after create/resend for deterministic
local and staging checks. Copied invite links remain same-origin but include the
absolute origin so they can be pasted into chat or email.

When the hosted API returns `code: "warehouse_unavailable"` with HTTP `503`, the
dashboard treats the API as reachable and shows a "Starting data warehouse"
status while retrying in the rendered dashboard shell. Initial Runs content
stays in its skeleton state during this retry instead of blocking the whole
page. This is the expected user-facing state when an org's tenant ClickHouse
warehouse is waking after idle; User Data/control failures should remain
separate operational alerts.

The Playwright smoke uses the production-style build/start path.

Next generates `next-env.d.ts` during `next dev`, `next build`, and `next typegen`. The file is ignored because Next 16 rewrites its route-type import between development and production builds.

## API Observability

Product API calls should go through `src/api.js`'s `ApiClient` so browser,
Rust, Cloud Run, and Cloudflare logs share a safe correlation value. The client
adds a sanitized `x-request-id` when a caller does not provide one, reads the
sanitized response header when available, and includes `Request <id>` only in
client-safe `ApiError` messages. Request IDs that look like emails, bearer
values, InstantML/Stripe/GitHub-style secrets, or other token-like credentials
are discarded and replaced before logging or display.

Frontend console logging is user-facing, so the payload is intentionally small:
event name, request/trace ID, method, redacted route-template path, status,
duration, code, and retryability. Failed requests log with `console.warn` for
4xx and `console.error` for 5xx/network failures. Successful request logging is
opt-in with `NEXT_PUBLIC_INSTANTML_API_LOGS=1` or
`localStorage.setItem("instantml:api-logs", "1")`. Do not log request bodies,
response bodies, query strings, auth headers, cookies, emails, metric keys or
values, artifact names, object-storage URLs, or user content from frontend API
helpers.

Artifact byte previews and downloads are same-origin browser navigations or
media loads to `/api/artifacts/:id/download`, so they cannot always attach the
frontend-generated header. The Rust origin still generates and logs a safe
request ID for those byte requests; use the surrounding artifact metadata
`ApiClient` call, artifact ID, time window, and Cloud Run download workflow log
to correlate a user report.

## Test

From the repo root:

```bash
npm run test:node
node --test apps/web/tests/traces-tab.test.js
npm run web:build
npx react-doctor@latest
npm run test:ui
npm run test:ui:traces
npm run test:ui:direct
npm run test:rust:ui
npm run test:hosted-clickhouse
```

React Doctor is configured at the repo root. It keeps existing broad
frontend-advisory categories visible in the CLI but out of the score gate, and
it skips generic dead-code analysis because Next routes, generated files, tests,
and scripts are reached through framework/tool entrypoints in this monorepo.

`apps/web/tests/landing-page.test.js` covers: all 8 ported component exports, `"use client"` directives, ThemeToggle localStorage key alignment, `app/page.tsx` server-component wiring (no `"use client"`, imports `auth` and `redirect`, redirects signed-in users, renders `LandingPage` for signed-out), polyline helper correctness, timestamp helper correctness, TtlRing circumference math, CSS selector presence, and logo.svg + design doc existence. `apps/web/tests/auth-flow-recovery.test.js` locks the stale hosted-Clerk recovery contract: 401 retry with `skipCache`, visible user instructions, and responsive recovery actions. These tests run via `node --test` without a browser.

The default browser smoke starts disposable ClickHouse and the Rust API, builds the Next app, starts `next start`, verifies the public landing page does not fetch dashboard summaries, signs up through the local dev Google-style flow with a Pro plan, creates a copy-once SDK API key, seeds demo data through the signed-in session, verifies Settings usage/seats and the topbar usage badge, verifies API-key create/revoke UI, verifies the initial dashboard load, asserts hidden rich-object/log fetches stay gated, and captures a screenshot. `npm run test:ui:traces` runs the same production-style Rust/ClickHouse/Next harness in a shorter trace-focused mode: it seeds a native trace batch, verifies `GET /api/traces?run_id=...`, opens Run Detail's lazy local Traces section, and follows the exact `run_id`/`trace_id`/`span_id` deep-link into the full Traces workspace. Set `INSTANTML_UI_SMOKE_FULL_WORKSPACE=1` to run the longer workspace regression that exercises route-backed tabs, run inspection, Runs workspace add/edit/collapse/fullscreen panel flows, drag-and-resize layout persistence, focus traps, tokenized search, tag/note editing, selected-run plotting, chart hover/zoom, rich-object previews, Compare layouts/sorting/reference switching, artifact/API affordances, and responsive viewports. `npm run test:ui`, `npm run test:ui:direct`, and direct no-env invocation of `node apps/web/tests/ui-smoke.mjs` all use the Rust/ClickHouse harness.

The hosted ClickHouse smoke is API/SDK-facing rather than browser-facing: it signs up, creates an SDK key, verifies User Data control rows, writes direct and Python SDK runs into the routed tenant database, restarts the API, and verifies the dashboard summary endpoint can still read the ingested runs.

The smoke also covers the keyboard-workflow MVP: shortcut help, quick search to run detail, compact rail-label search for long run names, Runs selector collapse/restore, Runs/canvas focus handoff, `Esc` drawer dismissal, workspace undo/redo, and fullscreen panel arrow traversal.

The Runs workspace keeps its filter/command block pinned below the top bar on desktop, with run totals folded into the status filter labels instead of a separate stat strip. The selector rail and panel toolbar pin underneath it while panel sections scroll. The run rail uses compact selected-run rows and a fixed footer so pagination controls remain visible.

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
- `app/dashboard/imports/tab-pane.tsx` — Imports and integrations tab body.
- `app/styles/tokens.css` — brand primitives + light/dark design tokens (`:root`)
- `app/styles/base.css` — global reset, typography, button defaults
- `app/styles/landing.css` — marketing page + auth card surfaces (`.landing-*`, `.auth-*`)
- `app/styles/dashboard.css` — shell, topbar, brand-mark, tabs, nav rail
- `app/styles/dashboard-runs.css` — runs workspace rail, rows, filter strip
- `app/styles/panels.css` — workspace panels, canvas, sections, modals
- `app/styles/charts.css` — metric charts, axes, series, range, tooltip
- `app/styles/research.css` — Distributed and Insights dashboard surfaces
- `app/styles/traces.css` — Traces dashboard list, tree, inspector, and filters
- `app/styles/imports.css` — imports workspace styling
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

- `docs/design/2026-05-26-organization-workspace-selector.md` — organization-as-workspace model, account/workspace menu, user-facing create-org route, role labels/capabilities
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
- `docs/design/2026-05-23-rank-aware-research-dashboards.md`
- `docs/design/2026-05-14-pluto-style-frontend-workspace.md`
- `docs/design/2026-05-14-instantml-rescheme-and-chart-polish.md`
- `docs/design/2026-05-16-device-code-cli-login.md`
- `docs/design/2026-05-16-gcp-cloud-run-rust-api.md`
- `docs/design/2026-05-16-pricing-signup-org-admin.md`
- `docs/design/2026-05-16-auto-personal-workspace.md`
- `docs/design/2026-05-17-dashboard-reliability-control-views.md`
- `docs/design/2026-05-30-adoption-imports-integrations.md`
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
- Keep the production CSP free of `unsafe-eval`. Local development may allow it for framework tooling, but `next.config.mjs` must not emit it when `NODE_ENV=production`.
- Keep redirect URLs validated in frontend code before calling `window.location.assign` or `window.open`: invitation links must stay same-origin `/invite#t=...`, and Stripe redirects must be `https://checkout.stripe.com` or `https://billing.stripe.com`.
- Keep saved views validated before applying them. Control-plane saved views are the source of truth when authenticated; local saved views are a fallback and must stay namespaced by org/project/user-derived keys. Export/import/delete controls should stay scoped to shared control-plane views unless a future design adds a browser-side canonical envelope for local-only views.
- Keep shared data-shaping helpers in `src/` so Node tests can cover important UI logic without requiring a browser.
- Keep global keyboard matching in `src/shortcuts.js` and keep browser smoke coverage around any command that changes routing, layout, or overlay state.
- Keep reusable React surfaces in `app/dashboard-components.tsx`, stable navigation config in `app/dashboard-config.tsx`, and view-model helpers in `app/dashboard-models.ts`.
- Keep styling in `app/styles/`; `app/globals.css` is the thin entry-point `@import` chain only. Components should emit semantic class names rather than introduce CSS modules or inline visual systems. Add new rules to the most specific split file for the feature area. Prefer adjusting shared tokens in `tokens.css` before creating one-off component styles. See `docs/design/2026-05-18-globals-css-audit.md` for the split rationale and Phase 3 dedup plan.
- Keep run-table sorting server-side when pagination is active; client sorting should not reorder only the current page.
- Keep selected run details cached separately from the current page so comparisons survive page changes.
- Prune stale saved-view run IDs against the API before rendering Compare; a saved local view must never claim selected runs that no longer exist.
- Keep Runs workspace panel queries bounded by selected runs up to `MAX_SELECTED_RUNS` or filtered page/top N plus metric point limits; do not fetch full metric histories for the panel grid.
- Keep hidden tab data fetches gated by active tab. Runs should not load Metrics, Run Detail, Compare, or artifact-only data during initial dashboard entry unless that tab is active.
- Keep selected-run hydration abortable and bounded. Off-page selected runs may be fetched so Compare survives pagination, but stale `/runs/:id` requests must be cancelled and fanout-capped.
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
