# Web App TODO: W&B-Informed App Parity

Date: 2026-05-10

Scope: Training Observability web app parity work implied by the W&B docs gap review. This file covers frontend product surfaces: keyboard/workspace interaction, rich data panels, artifacts and lineage, public query/export UI, sweeps, automations, hosted admin flows, and report/workspace workflows. Backend/API work is listed only when the app feature cannot be completed without persisted state or data.

Primary sources reviewed:

- W&B docs index: https://docs.wandb.ai/llms.txt
- W&B keyboard shortcuts: https://docs.wandb.ai/models/app/keyboard-shortcuts
- W&B panels and line plots: https://docs.wandb.ai/models/app/features/panels and https://docs.wandb.ai/models/app/features/panels/line-plot
- W&B media panels: https://docs.wandb.ai/models/app/features/panels/media
- W&B Run Comparer: https://docs.wandb.ai/models/app/features/panels/run-comparer
- W&B tables: https://docs.wandb.ai/models/track/log/log-tables
- W&B artifacts, aliases, external references, TTL, and lineage: https://docs.wandb.ai/models/artifacts
- W&B Public API guide: https://docs.wandb.ai/models/track/public-api-guide
- W&B sweeps: https://docs.wandb.ai/models/sweeps/initialize-sweeps
- W&B registry and automations: https://docs.wandb.ai/models/registry and https://docs.wandb.ai/models/automations
- Local context: `TODO.md`, `apps/rust-server/TODO.md`, `packages/python-sdk/TODO.md`, `apps/web/README.md`, `docs/design/2026-05-10-runs-workspace-panels.md`, current `apps/web/app` implementation.

## Current Baseline

Implemented today:

- Keyboard-accessible custom selects with Arrow Up/Down, Enter, Space, Home, End, and Escape inside dropdowns.
- Global command registry for the MVP shortcut slice, with platform-aware Cmd/Ctrl labels.
- Keyboard shortcut help overlay available from the topbar help button and `?`.
- Quick search overlay available from `Cmd+K` / `Ctrl+K` for tabs, visible runs, metrics, projects, local saved views, selected-run artifacts, and safe app commands.
- Global `Escape` dismissal for quick search, shortcut help, fullscreen panels, edit/add-panel drawers, and the columns popover.
- Local Runs workspace undo/redo for layout mutations with bounded history and restrained status messaging.
- Runs selector collapse/restore via visible control and `Cmd+.` / `Ctrl+.`.
- `Cmd+J` / `Ctrl+J` focus handoff between the Runs selector and workspace canvas.
- Fullscreen panel previous/next buttons and Left/Right Arrow traversal.
- Tab navigation through native buttons, inputs, selects, and checkboxes.
- Focus traps and focus restoration for shortcut help, quick search, add-panel drawer, panel-edit drawer, and fullscreen panel inspection.
- Production UI polish from Computer Use QA: compact run rows, visible panel action affordances, actionable add-panel empty state, unclipped fullscreen charts, responsive Run Detail KPIs, horizontally contained Compare matrices, safer quick-search routing while typing, and tokenized run search such as `seed 13`.
- Route-backed dashboard tab routing for `Runs`, `Metrics`, `Run Detail`, `Compare`, `Alerts`, `Datasets`, `Artifacts`, `Models`, `Reports`, `Settings`, `Integrations`, and `API`, with legacy hash normalization for old links.
- Public landing, local dev Google-style sign-in/sign-up, onboarding, and copy-once SDK key creation before dashboard entry.
- Runs workspace with run selector, sections, add/edit/remove/duplicate/fullscreen line panels, local workspace layout storage, and add-panel drawer.
- Collapsible left app rail that expands on hover/focus and can be pinned.
- Reports tab that lists local saved views, but no report editor.
- Artifacts/checkpoints/rollouts UI, but no media panel viewer or image zoom/pan controls.
- Root/Rust/SDK TODOs now track W&B-informed API and SDK expansion; this file tracks the UI slices that become possible as those surfaces land.

Major differences from W&B app and SDK/API parity:

- Design-partner feedback from 2026-05-10 raised speed as the highest priority: a project with around 90,000 runs took seconds to load in W&B, so the web app must make large-run-count browsing, searching, filtering, sorting, and comparison feel immediate.
- Fullscreen panel state is not URL-addressable/restorable.
- The active/focused panel model is implicit; there is no persistent selected panel target for panel action shortcuts.
- No media-panel fullscreen controls.
- No report editor, report panel-grid selection, Markdown block insertion, or report deletion shortcuts.
- Tags and notes are now visible in the run rail/table and editable from Run Detail and Compare, but tag filters, notes-presence sorting, read-only hosted states, and large-project query-plan proof remain open.
- No first-class table, image, video, audio, histogram, plot, or 3D panels backed by typed logged-object schemas.
- No artifact version, alias, lineage, external-reference, TTL, or registry UI.
- No public query/export explorer for paginated history, unsampled history, file downloads, or post-hoc run updates.
- Compare now supports row and column layouts, run filtering, notes/tag editing, and metric-aware comparison. Remaining work is hosted persistence, larger-project query-plan proof, stronger row/column sorting, and richer artifact/media attachment.
- No sweep dashboard, agent status, best-run view, or sweep result comparison.
- No automation/webhook builder for metric thresholds or artifact events.
- No multi-org selector, usage summary, import workflow, managed Google provider, or rich auth/no-access states in the main UI. First-slice local onboarding and copy-once API-key creation are implemented.
- No UI for SDK lifecycle concepts such as resume/fork/offline mode, system metrics, console logs, code snapshots, or integration setup status.
- No LEET-like terminal exploration UI; this may remain out of web-app scope unless the product adds an in-app terminal/command palette bridge.

## Priority Definitions

- `P0`: Needed for credible daily workspace parity and keyboard accessibility.
- `P1`: Important parity for serious W&B replacement workflows.
- `P2`: Needed for richer W&B-like workflows after core Runs workspace is durable.
- `P3`: Nice-to-have parity, polish, or lower-frequency workflows.
- `P4`: Explicit non-goal for the current web app unless product direction changes.

## Audit Follow-Ups: Frontend Scale And Hidden-State Risks

Date: 2026-05-10.

These items came from the full frontend audit for issues like fixed minimum grids, CSS-hidden chart structure, silent caps, and demo-scale assumptions leaking into production workflows. The goal is to tighten the existing UI patterns rather than add a parallel component system.

### P0

- [ ] Stop rendering hidden range/zoom DOM in workspace panel cards.
  - Finding: workspace panel cards call `MetricChart` with range support, then hide `.chart-range-row` with CSS outside fullscreen.
  - Risk: mobile/assistive technology still sees hidden structure, and future chart layout work can accidentally inherit invisible range rows.
  - Build: pass an explicit `showRange` policy from `WorkspacePanelCard`, enable it only where the range brush is actually usable, and remove CSS-only masking.
  - Tests: rendered smoke asserts no hidden `.chart-range-row` exists in normal Runs panels and that fullscreen/metric charts still expose range zoom when expected.

- [ ] Make workspace sections handle more than 12 visible panels without silently hiding saved panels.
  - Finding: section rendering slices matching panels to the first 12.
  - Risk: saved panels can exist in local layout but be inaccessible unless search/order happens to reveal them.
  - Build: add section pagination, `Show more`, or bounded virtualization while preserving drag/drop and resize behavior.
  - Tests: create or seed a section with more than 12 panels and verify panels past 12 can be reached, edited, moved, and removed.

- [ ] Make the Add Panel drawer expose the full available metric key set.
  - Finding: the drawer only renders the first 18 available metric keys.
  - Risk: users with rich training logs cannot add many legitimate metrics even though docs say the drawer exposes the full key set.
  - Build: add metric search/filter and a bounded scroll/virtualized list instead of a fixed first-18 slice.
  - Tests: seed more than 18 available metrics and add a metric beyond the first page.

- [ ] Batch or concurrency-limit Runs workspace panel series fetching.
  - Finding: current loading fans out one request per visible metric per selected run.
  - Risk: selected-run workflows can create hundreds or thousands of requests when users select many runs or add many panels.
  - Build: prefer a Rust batch-series endpoint for `{ run_ids, metric_keys, limit }`; short-term fallback is a client request queue keyed only to rendered panels.
  - Tests: smoke/performance test proves selecting many runs and rendering many panels does not create unbounded parallel requests.

### P1

- [ ] Make Compare row mode responsive without a huge fixed-width grid.
  - Finding: row mode still builds fixed metric/evidence/config columns and produced a roughly 2,000 px contained table with only four compared runs.
  - Risk: the layout is technically contained but still clunky on mobile and mid-width screens.
  - Build: use responsive run cards or a user-controlled column picker for row mode; keep row-first comparison as the default.
  - Tests: desktop and mobile smoke verifies no awkward contained overflow for the default Compare row flow.

- [ ] Virtualize or explicitly cap Compare column matrix mode.
  - Finding: column mode creates one `minmax(180px, 1fr)` grid column per compared run.
  - Risk: the 50-run Compare cap can still become a very wide, hard-to-use matrix.
  - Build: virtualize run columns, page compared runs, or add a visible `show next runs` control.
  - Tests: 20+ and 50-run Compare fixtures remain responsive and keep reference/delta columns understandable.

- [ ] Make chart range previews and hover tooltips truthful for high selected-run counts.
  - Finding: the mini range overview plots only the first five series, and tooltip rows cap around five series.
  - Risk: range zoom and hover readouts can misrepresent what the main chart is plotting when many runs are selected.
  - Build: show active series plus a min/max envelope or aggregate summary for the rest; make overflow explicit in tooltip copy.
  - Tests: chart fixture with many series verifies range preview/tooltip communicate truncation or aggregation clearly.

- [ ] Add search/show-all behavior to the Run Detail metric summary table.
  - Finding: Run Detail metric rows are sliced to 12 and use a fixed 520 px row minimum.
  - Risk: important metrics are hidden and mobile/tablet users get a contained horizontal table rather than a readable detail view.
  - Build: add metric search/filter, `show all`, and a responsive stacked row layout.
  - Tests: run with more than 12 metrics can reveal every metric and remains readable on mobile.

- [ ] Make quick search server-backed or visibly scoped.
  - Finding: quick search builds from the first 80 loaded runs, first 80 metrics, first 30 artifacts, then filters to 24 visible results.
  - Risk: real projects make valid objects appear missing.
  - Build: use server-backed search for runs/metrics/artifacts or label the current scope clearly as local/loaded results.
  - Tests: search finds off-page runs and metrics in a paginated large-project fixture.

- [ ] Replace global dark-mode button styling with explicit button variants.
  - Finding: dark mode styles primary buttons by targeting `button:not(...)` with a long exclusion list.
  - Risk: new controls can accidentally inherit primary-blue styling until each selector is manually excluded.
  - Build: move primary styling to explicit classes such as `.primary-button`; make default button styling neutral.
  - Tests: visual smoke checks new generic buttons, sortable headers, row buttons, and icon buttons in dark mode.

### P2

- [ ] Split the largest frontend files after the behavior fixes above land.
  - Finding: `app/page.tsx`, `app/dashboard-components.tsx`, and `app/globals.css` carry most workflow logic and styling.
  - Risk: unrelated UI patches keep colliding and global CSS regressions are hard to contain.
  - Build: extract workflow containers for Runs workspace, Metrics, Run Detail, Compare, chart primitives, and workspace state; keep shared data shaping in `src/`.
  - Tests: keep existing smoke coverage stable during each extraction.

- [ ] Extend smoke tests to catch hidden DOM, contained overflow, and silent caps.
  - Finding: current smoke catches document-level overflow but not contained table overflow, hidden chart range rows, drawer metric truncation, or section panel truncation.
  - Risk: production nits can pass CI while still being visible in the app.
  - Build: add assertions for hidden `.chart-range-row`, drawer metrics beyond index 18, section panels beyond index 12, Compare contained overflow, and Run Detail metric table accessibility.
  - Tests: the new assertions fail against the current known gaps before each behavior fix lands.

## P0: Large Run Count Speed, Search, And Run Identification

- [x] Make Runs first useful render credible for a 90,000-run project.
  - Design-partner feedback: W&B took seconds to load at around 90,000 runs; speed is the top differentiator.
  - Build: server-backed Rust cursor pagination, bounded visible rows, Node offset fallback, no full-project run fetch on initial page load, and guarded pagination controls are implemented.
  - Evidence: 2026-05-11 local production benchmark measured first useful render at 387 ms with a 90,000-run fixture.
  - Remaining: hosted-environment proof, high-cardinality metric catalog split, and Compare/workspace panel series scale gates.

- [x] Add first-slice server-backed search for runs.
  - Current app: quick search uses loaded client data.
  - Build: search by run name, notes, tags, and selected config text through Rust `search_text`; keep group, job type, source metadata, artifact names, metric key/value summary search as follow-up work.
  - Tests: UI smoke covers tokenized run search and note search; Rust tests cover tag/note search with org-scoped filters. Large-project query-plan tests remain open.

- [ ] Add durable run-table sorting controls.
  - Current app: server-side sorting by newest, name, status, duration, selected metric latest, and selected metric best is implemented for cursor-backed run pages.
  - Build: add tags, notes presence, artifact count/presence, changed/recently updated fields, URL query round-trip, and hosted saved-view persistence where available.
  - Tests: existing smoke covers cursor paging and filter cursor clearing; add sort URL/saved-view persistence and richer sort option coverage.

- [x] Make tags visible in the Runs list and workspace.
  - Build: compact tag chips in rows, overflow count in the workspace, table column visibility, and tag editing from Run Detail/Compare are implemented.
  - Remaining: row tooltip/full list, explicit tag filters, and pagination-aware tag filter tests.

- [x] Add first-slice notes visibility and editing.
  - Build: notes preview in run rows/workspace, server-backed notes search, and edit actions in Run Detail/Compare are implemented.
  - Remaining: notes filter/presence sort and read-only hosted-user controls.
  - Tests: UI smoke covers notes search and editing; add hosted read-only coverage after auth UI lands.

## P0: Keyboard Infrastructure

- [x] Add a global command registry.
  - W&B difference: W&B implements custom app-level shortcuts using platform-aware Cmd/Ctrl handling.
  - Current app: shortcuts are scattered and limited to custom selects.
  - Build: a small `useCommandRegistry` or equivalent that registers command id, label, shortcut, context, enabled state, and handler.
  - Keep platform labels as `Cmd` on macOS and `Ctrl` on Windows/Linux.
  - Do not fire global commands while a text input, textarea, select, or content-editable field owns the key unless the command is explicitly editor-scoped.
  - Tests: unit-test shortcut matching and browser-smoke at least one global command.

- [x] Add keyboard shortcut help UI.
  - W&B difference: users can learn shortcuts from docs; the app should expose them where they work.
  - Current app: no shortcut reference in UI.
  - Build: command palette/help modal reachable from a small help button and future `?` shortcut.
  - Include all active shortcuts, grouped by Workspace, Navigation, Panels, Media, Reports, and General.
  - Tests: modal opens, traps focus, closes with Escape, and shows platform-specific shortcut labels.

- [x] Implement global Escape behavior.
  - W&B shortcut: `Esc` closes fullscreen panels, drawers, quick search, editors, and overlays.
  - Current app: Escape closes custom select menus only; edit/add drawers and fullscreen panel require clicking close buttons.
  - Build: overlay stack with topmost-first dismissal for custom select, fullscreen panel, edit drawer, add-panel drawer, columns popover, quick search, report editor overlays.
  - Tests: Escape closes one overlay at a time without clearing page state.

- [x] Define focus management for overlays.
  - W&B difference: shortcut-heavy workflows assume reliable focus return.
  - Current app: shortcut help, quick search, add-panel drawer, panel-edit drawer, and fullscreen panel inspection use the shared focus-trap helper and restore focus when closed.
  - Build: focus trap for modal/fullscreen surfaces and restore focus to the triggering control on close.
  - Tests: Tab cycles within overlay, Shift+Tab cycles backward, close restores focus.

## P0: Workspace Management Shortcuts

- [x] Implement `Cmd+Z` / `Ctrl+Z` undo for workspace changes.
  - W&B shortcut: undo UI changes such as workspace or panel modifications.
  - Current app: workspace edits immediately mutate local state and localStorage with no history.
  - Build: bounded undo stack for workspace operations: add/remove/duplicate/edit panel, add section, collapse/expand section, mode changes, reset layout, panel settings changes.
  - Preserve selection, project, filters, and current tab separately from layout undo unless intentionally part of a command.
  - Tests: undo add panel, undo remove panel, undo title/settings edit, and undo reset layout.

- [x] Implement `Cmd+Shift+Z` / `Ctrl+Y` redo.
  - W&B shortcut: redo a previously undone workspace change.
  - Current app: no redo stack.
  - Build: redo stack invalidates when a new non-redo workspace mutation occurs.
  - Tests: undo/redo sequence and stack invalidation after a new edit.

- [x] Add unsaved/autosaved workspace history messaging.
  - W&B difference: undo/redo is understandable because the workspace has a visible state model.
  - Current app: local workspace persistence is silent except topbar status.
  - Build: small status text such as `Autosaved`, `Undo available`, or `Redo available`; keep it restrained and non-noisy.
  - Tests: status updates after workspace mutations.

## P0: Navigation Shortcuts

- [x] Implement `Cmd+K` / `Ctrl+K` quick search.
  - W&B shortcut: open quick search across projects, runs, and resources.
  - Current app: topbar has project/status/view controls and a run filter, but no global search dialog.
  - Build: command palette-style search over projects, visible runs, saved local views, tabs, metric keys, artifacts for selected runs, and API snippets.
  - Selecting an item should route/focus the relevant app surface.
  - Rust follow-up: hosted search should later query project/run/artifact/workspace summaries server-side.
  - Tests: open with shortcut, search run name, jump to run detail, search metric key, jump to Metrics/Runs panel context.

- [x] Implement `Cmd+.` / `Ctrl+.` to minimize or restore the Runs selector sidebar.
  - W&B shortcut: minimize/restore the Runs selector sidebar to reclaim screen space.
  - Current app: app rail can be pinned/unpinned; Runs selector rail is always present in the Runs workspace on desktop.
  - Build: separate `runsRailCollapsed` state from app nav pinning. Collapse to icon/count strip or hide with a reveal affordance.
  - Persist per user/browser initially, then per workspace view after workspace persistence exists.
  - Tests: shortcut toggles rail, layout expands/collapses without horizontal overflow, focus remains sensible.

- [x] Implement `Cmd+J` / `Ctrl+J` project-sidebar navigation.
  - W&B shortcut: switch between Workspaces and Runs tabs in the project sidebar.
  - Current app: a single `Runs` tab contains both run selector and workspace panels; no explicit Workspaces vs Runs project-sidebar tabs.
  - Build option A: map to toggling focus between Runs selector and workspace canvas.
  - Build option B: add explicit mini-tabs in the Runs page for `Workspace` and `Runs table/selector` when the old run-table returns.
  - Recommendation: choose option A first for a smaller slice.
  - Tests: shortcut alternates focus regions and announces the active region to screen readers.

- [x] Make top-level app tabs route-addressable and shortcut-addressable.
  - W&B difference: W&B has app-level navigation affordances beyond basic Tab order.
  - Current app: tabs are clickable links under `/dashboard/:tab`, legacy hashes normalize, and command-palette actions can open each app tab.
  - Build: command palette actions for each app tab and optional numeric shortcuts after the command registry lands.
  - Tests: smoke covers route-tab navigation and helper tests cover path/hash normalization.

## P0: Panel Fullscreen Navigation

- [x] Implement Left/Right Arrow to move through panels while fullscreen.
  - W&B shortcut: Left Arrow / Right Arrow steps through panels in a section in fullscreen mode.
  - Current app: fullscreen panel exists, but arrow keys do nothing.
  - Build: order panels by their current visible order in the active section; arrow keys move to previous/next panel and wrap only if product explicitly decides to wrap.
  - Tests: fullscreen first panel, Right Arrow shows next panel, Left Arrow returns, Escape closes.

- [ ] Make fullscreen panel state URL-addressable or restorable.
  - W&B difference: fullscreen navigation behaves like a stable view mode.
  - Current app: fullscreen state is local React state and disappears on reload.
  - Build: add optional hash/query fragment such as `#runs?panel=<id>&fullscreen=1` only after route strategy is designed.
  - Tests: reload can restore fullscreen panel if route-state slice is accepted.

- [x] Add visible fullscreen navigation controls.
  - W&B shortcut parity requires keyboard support, but mouse/touch users also need discoverable next/previous controls.
  - Current app: only close button exists.
  - Build: compact previous/next icon buttons with disabled states and tooltips showing shortcuts.
  - Tests: buttons match arrow-key behavior.

- [ ] Add selected/focused panel model.
  - W&B difference: panel keyboard actions require an active panel.
  - Current app: panel actions are hover/focus-within buttons; no persistent selected panel.
  - Build: clicking/focusing a card sets active panel; active styling should be subtle and not fight chart readability.
  - Tests: active panel survives keyboard traversal and panel action shortcuts target only active panel.

## P1: Media Panel Shortcuts

- [ ] Build first-class media panels.
  - W&B shortcut surface includes image fullscreen zoom, pan, reset, zoom-to-fit, and step slider controls.
  - Current app: artifacts/rollouts/checkpoints are listed; no media panel type renders image/video/table artifacts in the Runs workspace.
  - Build: media panel type backed by artifact metadata and signed/local artifact download URLs.
  - Support image grids, single-image fullscreen, and artifact step metadata.
  - Tests: image artifact renders, missing artifact shows safe empty state, object-storage URLs are not leaked.

- [ ] Implement `Cmd + +` / `Ctrl + +` image zoom in.
  - Current app: no image fullscreen media viewer.
  - Build: media viewer zoom state with bounds and transform origin.
  - Tests: shortcut increases zoom and does not affect browser zoom while media viewer is focused.

- [ ] Implement `Cmd + -` / `Ctrl + -` image zoom out.
  - Current app: no media zoom.
  - Build: same media viewer zoom model.
  - Tests: zoom lower bound and label/readout update.

- [ ] Implement `Cmd+0` / `Ctrl+0` reset to 100% zoom.
  - Current app: no media zoom.
  - Build: reset transform and pan offsets.
  - Tests: reset after zoom/pan.

- [ ] Implement `Shift+L` zoom to fit.
  - Current app: no media zoom-to-fit.
  - Build: compute fit scale from viewport and image natural dimensions.
  - Tests: tall/wide images fit within fullscreen viewport.

- [ ] Implement click-drag pan when zoomed in.
  - Current app: no pan behavior.
  - Build: pointer events for mouse and touch, keyboard-accessible pan alternatives if practical.
  - Tests: drag changes pan offset only when zoomed.

- [ ] Implement media step slider.
  - W&B shortcut: `Cmd+Left/Right` or `Ctrl+Left/Right` moves the step slider in fullscreen media panels.
  - Current app: no media panel step slider.
  - Build: derive available artifact/media steps for a run and allow slider/shortcut traversal.
  - Tests: shortcut changes step and rendered image/metadata.

## P1: Report Shortcuts And Editor

- [ ] Build an actual report editor.
  - W&B shortcut surface includes report grid deletion, Markdown insertion, editor Escape, and Tab navigation.
  - Current app: Reports tab lists local saved views only.
  - Build: report documents with title, sections, panel grid blocks, Markdown blocks, and selected workspace panel imports.
  - Rust follow-up: report persistence tables/API after org/user auth and workspace-view persistence.
  - Tests: create local draft, add panel block, edit title, add markdown block.

- [ ] Add report panel-grid selection.
  - W&B shortcut: Delete/Backspace removes the selected panel grid from a report.
  - Current app: no report grid.
  - Build: selectable report blocks with clear focus/selection ring.
  - Tests: select block with mouse and keyboard.

- [ ] Implement Delete/Backspace to remove selected report panel grid.
  - Current app: no report editor deletion shortcut.
  - Build: confirm only if deletion would remove persisted/shared report content; local draft deletion can support undo instead.
  - Tests: Delete removes selected draft grid and can be undone once undo exists for reports.

- [ ] Implement `/mark` then Enter to insert Markdown block.
  - W&B shortcut: Enter inserts Markdown block after typing `/mark`.
  - Current app: no slash command editor.
  - Build: simple slash-command input within report editor; start with `/mark`.
  - Tests: type `/mark`, press Enter, Markdown block appears and focus moves into it.

- [ ] Implement Escape to exit report editor.
  - Current app: no editor mode.
  - Build: Escape exits text block/editor mode before closing parent report editor, following overlay stack order.
  - Tests: Escape from Markdown field exits editing; second Escape closes editor/drawer if applicable.

- [ ] Ensure Tab navigation inside reports is intentional.
  - W&B shortcut: Tab navigates interactive report elements.
  - Current app: native Tab exists but no report structure.
  - Build: logical tab order for report toolbar, blocks, block actions, editor fields.
  - Tests: keyboard-only creation and block deletion smoke.

## P1: Workspace And Panel Parity Beyond The Shortcut Page

- [ ] Persist workspace views in Rust/Postgres.
  - W&B difference: workspace state is a product object; local-only views are not enough for team parity.
  - Current app: saved views and Runs workspace layouts are localStorage-only.
  - Build: implement the `workspace_views` API from `docs/design/2026-05-10-runs-workspace-panels.md` after human user/org context lands.
  - Tests: create/update/delete/default workspace views scoped by org/user/project.

- [ ] Add workspace/section/panel settings surfaces.
  - W&B difference: workspace, section, and panel settings are configurable, and shortcuts undo/redo those changes.
  - Current app: panel edit drawer exposes only title, metric, x-axis, group, smoothing, group average, and max runs; section/workspace settings are mostly implicit.
  - Build: settings drawer for workspace defaults and section overrides.
  - Tests: setting precedence workspace < section < panel.

- [ ] Add section rename/delete/reorder.
  - W&B difference: sections can be managed as first-class workspace objects.
  - Current app: add/collapse sections only; no rename/delete/reorder.
  - Build: inline rename or section settings drawer, delete with undo, reorder after persisted layout.
  - Tests: rename persists, delete undo works, keyboard focus remains in workspace.

- [ ] Add panel move/reorder and resize.
  - W&B difference: panel grids are spatial and editable.
  - Current app: duplicate/remove/edit/fullscreen, but no move, drag/drop, or resize.
  - Build: keyboard-accessible move actions first; drag/drop later.
  - Tests: move panel between sections and within section.

- [ ] Add panel share/copy-link action.
  - W&B difference: panels can be shared/copied.
  - Current app: no panel links.
  - Build: panel IDs in route state, copy local deep link, later hosted share permissions.
  - Tests: copied link restores tab/section/panel focus.

## P1: Hosted Workflow UI From The Global TODO

- [ ] Add an organization selector and hosted auth state shell.
  - Global alignment: root P5 needs organization selection plus empty/no-access/error states.
  - Current app: first-time users see `/`, local dev auth creates a single signed-in org, and dashboard entry checks the session; multi-org switching and hosted provider states are not selectable yet.
  - Build: compact org selector, local-mode indicator, no-access empty state, expired/revoked-key messaging, and safe retry affordances.
  - Tests: local mode still works, auth error renders without stack traces, selected org scopes visible state.

- [x] Add first-slice API-key creation and copy-once UI.
  - Global alignment: Rust P2 provides API-key routes; SDK P0/P6 need clear auth onboarding.
  - Implemented: onboarding creates a scoped SDK key through the session-authenticated Rust route, displays plaintext once, and avoids localStorage persistence.
  - Remaining: API tab management flow with scope choices, optional project restriction, expiry, prefix list, revocation, and dismissed-plaintext behavior.
  - Tests: smoke covers onboarding key creation; add scope/revocation UI tests when management lands.

- [ ] Add usage summary UI.
  - Global alignment: root P5/P7 tracks warning-only usage before billing truth.
  - Current app: no admin usage view.
  - Build: seats, projects, runs, metric points, metric series, artifacts, artifact bytes, active API keys, plan thresholds, and warning copy.
  - Tests: unknown artifact bytes are visible, warning states render, no invoice-truth language appears.

- [ ] Add import dry-run and import summary UI.
  - Global alignment: Rust supports Neptune, transformed W&B, and transformed MLflow imports; adoption validation depends on this path.
  - Current app: import workflow is not first-class.
  - Build: upload/paste JSON, choose source, dry-run validation summary, warnings, skipped records, real import confirmation, import history list.
  - Tests: dry-run and real import results share rendering, failed validation is recoverable, imported runs become searchable.

## P1: Compare Page Ergonomics

- [x] Add row-oriented Compare layout.
  - Design-partner feedback: Compare should support rows instead of only columns.
  - Current app: comparison matrix is column-oriented around selected runs.
  - Build: toggle between `runs as columns` and `runs as rows`; choose the default that scans best for many runs after UX testing.
  - Tests: both orientations preserve selected runs, diff-only mode, copied values, and responsive behavior.

- [x] Add row sorting to Compare.
  - Build: sort fields/rows by name, category, changed-only priority, missing values, metric latest/best value, config key, artifact presence, tag match, and notes presence.
  - Tests: sort is stable, diff-only and search interact predictably, and row sort state is URL/saved-view restorable.

- [x] Add column sorting to Compare.
  - Build: sort compared runs by newest, name, status, duration, selected metric latest/best, tag match, notes presence, artifact count/presence, and selected config values.
  - Tests: column sort does not drop selected runs and remains server-backed or bounded for large selections.

- [x] Surface tags and notes inside Compare.
  - Build: tags and notes should be high in the comparison scan order, searchable within compare, and editable when post-hoc mutation routes exist.
  - Tests: long notes and many tags stay readable without exploding row height.

- [x] Attach playable artifacts to Compare rows.
  - Design-partner feedback: compare should properly attach artifacts such as MP3 and MP4 files and let users run/play them.
  - Current app: artifacts are mostly listed or copied, not played in compare.
  - Build: artifact row group with inline audio/video player for safe MP3/MP4 files, download-only fallback, artifact presence sort, and media fullscreen handoff.
  - Tests: media playback controls render without autoplay, unsupported/external files fall back safely, raw signed URLs are not displayed.

## P2: Quick Search Scope Expansion

- [ ] Search all projects and runs server-side.
  - Current app quick-search target should start with loaded data, but parity requires larger org/project search.
  - Build: `GET /api/search` or bounded type-specific routes for projects, runs, metrics, artifacts, reports, and workspace views.
  - Tests: pagination/bounds, auth scoping, fuzzy query behavior.

- [ ] Include commands in quick search.
  - W&B difference: quick search is an efficient navigation tool; modern parity should include command execution.
  - Current app: no quick search.
  - Build: commands such as `Reset demo`, `Toggle theme`, `Open API tab`, `Add panel`, `Save view`.
  - Tests: command results execute without text-search side effects.

- [ ] Add recent/frequent resources.
  - Current app: no recents.
  - Build: local recents first, hosted per-user recents later.
  - Tests: selecting resource moves it up in local recent list.

## P2: Panel Types Needed For Shortcut-Adjacent Parity

- [ ] Add table panel type.
  - Current app: table-like data exists in artifacts and compare views, but not workspace panels.
  - W&B gap alignment: W&B tables are queryable structured rows, not just downloadable files.
  - Build: typed columns, paginated rows, selected-run overlays, image/media cell placeholders, empty/error states, and export affordance.
  - Tests: large tables page without layout shift, mixed cell types do not overflow, keyboard selection works.

- [ ] Add bar chart panel type.
  - Current app: line panels only.
  - Shortcut relevance: fullscreen panel traversal should work across mixed panel types.

- [ ] Add scatter plot panel type.
  - Current app: line panels only.
  - Shortcut relevance: panel traversal and settings undo/redo should be panel-type agnostic.

- [ ] Add parallel coordinates panel type.
  - Current app: side-by-side compare exists, but no parallel coordinates workspace panel.
  - Shortcut relevance: active panel/focus model should not assume line charts.

- [ ] Add text/Markdown workspace panel type.
  - Current app: no text panel in Runs workspace.
  - Shortcut relevance: report `/mark` and workspace text editing need editor-scoped shortcut rules.

## P2: Rich Logged Object And Media UI

- [x] Add first-slice typed object catalog surfaces for the selected run.
  - W&B gap alignment: logged media keys should become browsable workspace resources, not only artifact rows.
  - Build: Run Detail and Artifacts load `GET /api/runs/:id/objects` only for the active selected run, render table previews, histogram bars, and media cards, and fetch bounded table rows through `GET /api/objects/:id/rows`.
  - Remaining: workspace object panels, object catalog search, plots, point-cloud metadata, and batch Compare object context after a no-fan-out design.
  - Tests: UI smoke asserts initial dashboard load makes no object requests, selected-run table/histogram/image previews render, demo media fallback text appears when bytes are unavailable, table previews stay bounded, and Compare does not add object fan-out.

- [x] Add first-slice histogram preview support.
  - Current app: scalar lines and metric aggregate tables exist, but histogram-series attributes have no dedicated visualization.
  - Build: selected-run rich-object cards render compact bounded histogram bars.
  - Remaining: workspace histogram panels and heatmaps backed by bounded per-run/key data.

- [ ] Add image comparison panel.
  - Current app: no image grid or step-aware viewer.
  - Build: compare images across selected runs at the same step/key, with captions, masks/boxes when available, and fullscreen handoff.
  - Tests: missing images do not collapse layout, signed/local URLs are never copied or displayed raw.

- [x] Add selected-run video/audio object preview cards.
  - Current app: rollout artifacts are listed but not played inline.
  - Build: rich-object media cards reuse the safe same-origin media helper; unsupported/external/demo URIs fall back safely.
  - Remaining: workspace media panels, fullscreen handoff for video, image zoom, and step sliders.

## P2: Artifacts, Lineage, Registry, And Models UI

- [ ] Add artifact versions and aliases UI.
  - W&B gap alignment: users expect `latest`, `vN`, and custom aliases to be visible and navigable.
  - Current app: artifact metadata is flat per run.
  - Build: version timeline, alias badges, tags, digest/manifest summary, and download-by-version/alias actions after Rust artifact versions exist.
  - Tests: alias changes update without confusing old versions, protected/raw storage data is not exposed.

- [ ] Add artifact lineage graph.
  - W&B gap alignment: W&B shows input/output run-artifact DAGs for reproducibility.
  - Current app: artifacts are attached to runs only.
  - Build: compact lineage view for selected artifact or run, with upstream/downstream runs and artifacts.
  - Tests: cyclic or malformed data is rejected server-side and rendered defensively if encountered.

- [ ] Add external-reference artifact states.
  - W&B gap alignment: reference artifacts may point to S3/GCS/Azure/HTTP/NFS without uploaded bytes.
  - Current app: raw URIs are redacted and no reference-specific state exists.
  - Build: show reference type, checksum/size metadata, availability status, and safe copy/download actions.
  - Tests: signed URLs and bucket paths remain hidden unless explicitly safe.

- [ ] Add model registry first slice only after artifact versions are stable.
  - W&B gap alignment: registry is a curated org-level artifact lifecycle surface.
  - Current app: `Models` is derived from checkpoint artifacts only.
  - Build: collections, promoted versions, aliases, tags, lineage, and audit summary if customer validation confirms demand.
  - Tests: role-based edit/delete affordances match auth state.

## P2: Public Query, Export, And Run History UI

- [ ] Add public query explorer after Rust exposes stable query routes.
  - W&B gap alignment: W&B Public API supports filtering runs, reading history, files, sweeps, and exports.
  - Current app: API tab shows snippets but no interactive explorer.
  - Build: filter builder, route preview, response preview, copy Python SDK snippet, and bounded result table.
  - Tests: filters are URL-restorable and cannot request unbounded histories by default.

- [ ] Add paginated history/export UI.
  - Current app: charts use bounded series, but users cannot request paginated or unsampled history exports.
  - Build: per-run/per-project export drawer for JSON/CSV with row limits, sampling mode, and async/streaming status when backend supports it.
  - Tests: export limits are visible, long exports do not block the app shell.

- [ ] Add post-hoc run metadata/config/summary editor.
  - W&B gap alignment: W&B Public API can update metadata/config/summary after logging.
  - Current app: run detail is read-only except local view state.
  - Build: audited edit flows for notes, tags, display name, safe metadata/config fields, and summary overrides after Rust supports mutation routes.
  - Tests: validation errors preserve edits, read-only users cannot see save affordances.

## P2: Sweeps, Automations, And Integrations UI

- [ ] Add minimal sweeps dashboard after Rust sweep routes exist.
  - W&B gap alignment: sweeps include config, agents, run assignments, results, and best-run lookup.
  - Current app: no sweeps surface.
  - Build: sweep list, config summary, run table filtered to sweep, best-run card, agent status, and cancel/pause controls if supported.
  - Tests: empty, running, failed, completed, and no-agent states.

- [ ] Add metric-threshold automation builder after backend design lands.
  - W&B gap alignment: automations can trigger Slack/webhook actions from metric or artifact events.
  - Current app: Alerts tab is derived/local and no durable automation exists.
  - Build: create threshold rule, signed webhook action, delivery history, disabled/error state, and clear plan gating if pricing requires it.
  - Tests: webhook secrets are never displayed, failed deliveries are visible.

- [ ] Add artifact-event automation UI later.
  - Build: trigger when a version is created or an alias/tag changes, with webhook/Slack destination once integrations exist.
  - Tests: registry/artifact permissions control available actions.

- [ ] Add integrations status and setup guides.
  - W&B gap alignment: framework integrations are a major adoption path.
  - Current app: Integrations tab is mostly implementation-backed cards and snippets.
  - Build: status cards and copyable setup snippets for Python SDK, PyTorch Lightning, Hugging Face, Keras, TensorBoard, Gym/RL, W&B dual logging, and MLflow import as those SDK features land.
  - Tests: snippets reflect current package/API names and Rust default backend.

## P2: Accessibility And Keyboard Polish

- [ ] Define complete tab order for the Runs workspace.
  - Current app: native Tab works, but the order is long and not optimized for daily keyboard use.
  - Build: landmarks, skip links, and focus-region shortcuts for top filters, run rail, panel canvas, drawer.
  - Tests: keyboard-only smoke through filter, select run, add panel, edit panel, fullscreen panel.

- [ ] Add visible shortcut hints in tooltips.
  - Current app: buttons have labels/aria labels, but few shortcut hints.
  - Build: tooltips for shortcut-enabled buttons once command registry exists.
  - Tests: tooltip text contains platform shortcut.

- [ ] Add screen-reader live announcements for shortcut actions.
  - Current app: topbar status has `aria-live`, but command outcomes are not centralized.
  - Build: command-result announcer for undo/redo, panel traversal, rail collapsed/restored, quick search selection.
  - Tests: live region text updates after command.

- [ ] Add keyboard shortcut conflict tests.
  - Current app: no global shortcuts.
  - Build: verify browser/system-reserved combos are avoided or intentionally handled.
  - Tests: typing in search/input does not trigger navigation or workspace mutations.

## P3: LEET / Terminal UI Parity Decision

- [ ] Decide whether LEET parity is in scope.
  - W&B page mentions W&B LEET, a terminal UI launched with `wandb beta leet`.
  - Current product has no terminal experiment explorer.
  - Recommendation: keep out of web-app P0-P2. Consider later as a Python SDK or CLI project, not `apps/web`.

- [ ] If in scope later, add an app bridge rather than terminal emulation.
  - Build idea: app command palette can show `Open in CLI` snippets or copy commands for local exploration.
  - Do not build a browser terminal unless there is a clear user need and security model.

## P3: Documentation And Discoverability

- [ ] Add a keyboard shortcuts page or modal content file.
  - Current app docs mention controls but not shortcuts.
  - Build: source shortcut docs from the command registry to avoid drift.
  - Tests: registry and docs snapshots stay in sync.

- [ ] Add onboarding hints for first-use keyboard workflows.
  - Current app has no onboarding.
  - Build: subtle one-time hints for `Cmd+K`, `Esc`, fullscreen arrows, and undo/redo.
  - Tests: hint can be dismissed and does not return.

- [ ] Document unsupported W&B shortcuts.
  - Current docs do not explicitly say what is unsupported.
  - Build: keep this TODO updated as parity changes.

## P4: Explicit Non-Goals For Now

- [ ] Do not implement LEET inside the web app unless the product strategy changes.
- [ ] Do not override browser zoom globally outside media fullscreen contexts.
- [ ] Do not add destructive report deletion without undo or confirmation semantics.
- [ ] Do not add heavyweight keyboard libraries until the simple command registry proves insufficient.
- [ ] Do not ship registry, sweeps, automations, or rich media editors as inert chrome before the relevant Rust/SDK contracts exist.
- [ ] Do not add any UI that requires full metric history scans for normal page load.

## Suggested Implementation Order

1. Command registry, platform shortcut labels, help modal.
2. Overlay stack and global Escape.
3. Workspace undo/redo for local layout mutations.
4. Runs rail collapse shortcut.
5. Quick search across loaded projects/runs/metrics/tabs.
6. Fullscreen panel left/right navigation.
7. Focus management and keyboard-only Runs workspace smoke test.
8. Report editor design doc and first local report editor slice.
9. Media panel design doc and first image fullscreen viewer slice.
10. Rust/Postgres persistence for workspace views and reports after user/org identity is ready.
11. Hosted workflow UI: org selector, API keys, usage summary, import dry-run.
12. Typed table/media panels once Rust and SDK rich-object contracts land.
13. Artifact versions, aliases, downloads, and lineage UI once Rust artifact lineage lands.
14. Public query/export explorer once server routes and Python `Api` client are stable.
15. Sweeps, automations, registry, and integration status only after backend contracts and customer validation.

## Verification Checklist For Each Shortcut Feature

- [ ] Works with Cmd on macOS and Ctrl on Windows/Linux where applicable.
- [ ] Does not fire from text inputs unless editor-scoped.
- [ ] Has visible discoverability in shortcut help.
- [ ] Has an accessible label or live-region outcome.
- [ ] Is covered by unit tests for command matching.
- [ ] Is covered by a Playwright UI smoke for at least one representative flow.
- [ ] Uses bounded API requests and never fetches full metric history by default.
- [ ] Does not display raw signed URLs, bucket paths, stack traces, SQL details, or secret values.
- [ ] Keeps search, filter, and row/column sorting server-backed or bounded for large projects.
- [ ] Does not create horizontal overflow at desktop, 1280px, or mobile widths.
- [ ] Updates `apps/web/README.md` and this TODO when support changes.
