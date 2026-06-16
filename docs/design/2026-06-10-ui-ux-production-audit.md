# InstantML UI/UX Production Audit & W&B Parity Plan

Date: 2026-06-10
Author: UX engineering audit (Claude, driving the live app at localhost:3000 against the local Rust/ClickHouse backend, plus full frontend/backend code review)
Status: Draft for review

Method: seeded 8 projects / 37 runs through the public SDK (iris-classification, rl-cartpole, supervised-regression, checkpoints, q-learning-gridworld, contextual-bandit, rank-insights-research), then audited every dashboard tab, the landing page, sign-in, light/dark themes, keyboard flows, and console/network behavior in Chrome. Code review covered `apps/web` and `apps/rust-server`.

Companion mockups: `docs/design/mockups/` (runs workspace redesign, compare redesign, run detail redesign).

---

## 1. Executive summary

The product has a strong foundation: a real design-token system, a coherent dark theme, canvas charts that stay fast, an excellent Imports surface, and a genuinely differentiated Distributed (rank) dashboard. API latencies are consistently under 200 ms locally and the visual language is professional.

What keeps it from demo-ready is not visual polish — it is **five structural problems**: (1) an unreliable hover-expanding nav rail, (2) run selection that lives only in component memory so the core Compare loop cannot survive a reload or be shared, (3) cross-project "All projects" defaults that make first-load charts show "no data", (4) a recurring right-column overflow bug that truncates commit hashes and platform strings mid-character, and (5) silent data loss presentation when the SDK upload queue doesn't drain. Each one lands in the first five minutes of a demo.

Below: P0 blockers, then a page-by-page issue inventory (major and minor), a W&B parity matrix, security/performance findings, redesigns, and a sequenced roadmap.

---

## 2. P0 — blockers to demo (fix before anything else)

### P0-1. Left nav rail is unreliable
- The collapsed rail expands on hover; the **first click frequently acts as "expand" instead of navigating**, and clicks on revealed items often no-op (observed repeatedly across Runs/Compare/Distributed during the audit; roughly half of nav clicks failed).
- The expanded rail **overlays the run selector**, hiding "Select all" and the run list while open, and can get stuck expanded.
- Icon-only collapsed state has no tooltips; the only way to learn icons is to expand the whole rail.
- Fix: pinned-open labeled sidebar by default (collapse to icons as an explicit user choice), real `<a>` navigation on first click, no hover-expansion. See mockup `mockup-runs-workspace.html`.

### P0-2. Run selection is ephemeral; the Compare loop breaks
- Selection lives in `dashboard-shell.tsx` React state (`selectedRunIds`, line ~601). Any full page load, deep link, or refresh wipes it.
- Compare with a fresh URL shows "0 runs — Select runs to compare" with **no way to select runs from the page** and no link to the Runs tab: a dead-end empty state for the product's headline workflow.
- Distributed similarly depends on a "primary run" set elsewhere, with no on-page run picker.
- A compare view cannot be shared with a teammate (URL carries no selection), which contradicts "make differences between runs obvious" and undermines Reports/collaboration.
- Fix: encode selection in the URL (`?runs=a,b,c` with a cap) and persist last selection per project in the saved workspace state; add an inline run picker to Compare; add a persistent selection tray. See mockups.

### P0-3. Right-column metadata overflow (Run Detail, Checkpoints)
- Source/Reproducibility/Run Context panels overflow the viewport at 1440 px and 1568 px: `Commit ab39abca58e1136e166158c9437…` clipped at the screen edge, `Python 3.:`, `macOS-15.6.1-arm64-arm-6`, `RUN iris-fast-lr-seed-`, `LEARNING RATE 0.` — values cut mid-character with no wrap, no ellipsis, no copy affordance.
- Fix: constrain the column, wrap or middle-truncate values with full value on hover, and add copy buttons for commit/run-id/platform. See `mockup-run-detail.html`.

### P0-4. Cross-project defaults produce "no data" first impressions
- Default context is "All projects" and the workspace default metric (e.g. `eval/return_mean`) is applied to whatever 10 runs the page loads — runs from other projects that never logged it. Result: the first screen of Runs shows prominent "10 no data for metric" warning pills and empty panels; Metrics mixes a bandit experiment and a cartpole experiment on one axis; the leaderboard fills with "-" rows.
- Fix: make project the primary context (project-first IA). "All projects" becomes an explicit cross-project view with per-project default metrics. Auto-panels should derive from metrics actually present in the current run set, and sections with zero data should hide by default (`hideEmptySections: true`).

### P0-5. `?project=` deep links silently ignored
- Navigating to `/dashboard/distributed?project=rank-insights-research` while a different project filter is persisted keeps the old project (breadcrumb and data stay on iris-classification). URL state loses to localStorage state — deep links lie.
- Fix: URL always wins; persisted state is only a fallback when the URL is silent.

### P0-6. Default-text-instead-of-placeholder bugs
- Report title: typing produced "Untitled report**Iris sweep readout**". API key name: "Dashboard SDK key**ui-audit-seed-key**". Both fields pre-fill real text rather than using a placeholder, so user input appends.
- Fix: use placeholders, or select-all on focus.

### P0-7. Silent data-loss presentation ("upload stale")
- The rank-insights seeding lost rank metrics for 8 of 12 runs because `finish()` timed out while the async queue drained; the SDK printed a stdout warning, but the dashboard shows those runs as cleanly **Finished** with only a cryptic "upload stale" badge. Distributed then says "No rank metrics logged for this run yet", which is false — they were logged and lost/stranded.
- This is the worst kind of trust failure for an observability tool: the UI asserts completeness it doesn't have.
- Fix (UI): a first-class run data-state — `complete / uploading / incomplete (n rows pending)` — with plain-language copy and a "what to do" link (run `instantml-uploader` recovery). Fix (SDK): louder finish-timeout behavior and a server-side "expected vs received" heartbeat where feasible.

### P0-8. Billing "Change to Pro/Premium" jumps straight to Stripe checkout
- One click on a settings button immediately redirects the whole tab to Stripe with no in-app summary/confirm step (price, seats, proration) and no obvious way back.
- Fix: in-app plan-change sheet with summary and explicit "Continue to Stripe" action; open checkout in a way that preserves the app tab.

---

## 3. Information architecture & navigation redesign

Current: 14 flat tabs (Runs, Metrics, Distributed, Compare, Alerts, Insights, Datasets, Imports, Artifacts, Checkpoints, Reports, Settings, API, plus Pin/Docs/Shortcuts) behind a hover rail, with project as a *filter* rather than a *place*. Three competing project indicators exist (brandbar text, breadcrumb, filter dropdown).

Proposed (see mockups):
1. **Project-first hierarchy.** A project switcher at the top of the sidebar; tabs operate within the project. "All projects" remains as an explicit overview page (project cards with run counts, last activity, best metric) rather than the default context for analysis surfaces.
2. **Pinned, labeled sidebar** grouped exactly as today (Analyze / Workspace / Admin) but always showing labels; collapse-to-icons is a persisted user toggle, expansion never happens on hover. Tooltips on icons when collapsed.
3. **Demote rarely-daily tabs.** Alerts, Datasets, Imports, API move under a "More" group or into Settings (API keys) until they have daily value; Run Detail leaves the top level (it's already route-backed from run clicks).
4. **One project control.** Breadcrumb shows org / project / tab and is clickable; the filter-bar project dropdown disappears.
5. **Selection tray.** A persistent bottom tray shows "N runs selected — Compare · Export · Tag · Clear" from any analysis tab, carrying selection (and the URL) across Runs/Metrics/Compare/Distributed.
6. Keyboard: number keys 1–9 for tab jumps; keep Cmd+K (it's the best navigation in the app today — it saved this audit).

---

## 4. Page-by-page findings (exhaustive)

### 4.1 Landing page
- L1 (major): Hero and sections are reveal-gated; first paint is a black page with only the navbar for 1–2 s (longer on slow connections); mid-scroll captures show fully blank sections before fade-in. Content must be visible by default; animation should enhance, not gate.
- L2: Stat-card labels/values ("LARGE RUN HISTORY", "236 ms p95") render in low-contrast gray on near-black during/after reveal; verify ≥4.5:1.
- L3: Hero claims are good and specific (keep). Bento/spotlight system is distinctive (keep).

### 4.2 Auth/entry
- A1: `/signin` with an existing session bounces through to the dashboard with a branded shell — good. (Clerk-session-without-InstantML-session recovery path exists in code; untested.)
- A2: No visible "Demo" entry from the local landing nav (the shared-demo action exists per README; surface it on the landing page for the demo story).

### 4.3 Runs workspace
- R1 (major): Run selector rows waste their ~270 px: project name repeated on every row even when project-filtered; `lr …` config truncated; tag chips truncate to "accur…", "uplo…". No metric/config columns, no sortable table view in the selector (the runs *table* exists only as Compare's row mode). W&B's project page is fundamentally a sortable, filterable runs table — this is the single largest parity gap in daily feel. Mockup replaces the selector with a proper runs table (name, status, duration, key metric columns, config columns, tags) with column chooser.
- R2 (major): Default panels with zero data and "N no data for metric" pills (see P0-4).
- R3: Two selection affordances (header checkbox + "Select all 6 on this page" link) with different styles; the link looks like a hyperlink, the checkbox like a control. Unify.
- R4: "upload stale" badge: jargon, same visual weight as status badges (see P0-7).
- R5: Run color swatch (square) and selection circle sit adjacent with no legend — dual encoding is opaque. The square is the chart color; make it doubly clear (tooltip "chart color") or merge affordances.
- R6: Legends under each panel list runs in two columns, consuming half the panel height for 10+ runs; rely on the table's color column + hover tooltip instead, with an optional expandable legend.
- R7: Run-cap messaging is inconsistent: panels say "10 current page", Metrics says "+28 more plotted", settings say maxRuns 10. One concept, three labels.
- R8: Pagination strip ("Rows 100 · 1 / 1") is cramped, bottom-left, and easy to miss; move into the table header region.
- R9: Search placeholder "runs, tags, notes, config" is good; results behavior untested for empty-match state.
- R10: Add panels / edit drawer / fullscreen exist (good); drag handles visible. Reset layout is a nice touch.
- R11: 5 s metadata polling continues regardless of tab visibility (code: `setInterval(poll, 5_000)` in dashboard-shell); pause when `document.hidden`.

### 4.4 Run Detail
- D1 (P0-3): Source/Reproducibility overflow & truncation; no copy buttons for commit/run id.
- D2: LATEST/BEST header cards show "-" when the workspace default metric isn't logged for this run; they should default to the run's own primary metric (best objective) instead.
- D3: Metric Summary includes `system/` and `upload_lag_seconds` rows: `MEAN 1,781,077,552` (a unix timestamp averaged) — meaningless and alarming. Exclude system/internal metrics from the user table; render upload health as a status, not a series.
- D4: GOAL column duplicates LATEST for most rows; meaning (objective target? best?) is undefined anywhere. Define or drop.
- D5: Timeline right column dates clipped ("Jun 10," with the time cut).
- D6: Reproducibility card renders five empty labeled rows when nothing is logged; collapse to a single teaching empty state with the SDK snippet.
- D7: Data tab on a specific run still asks "Select one or more runs…" and inherits the global default metric — it should default to this run + its first logged metric.
- D8: System tab is a counters table only; no GPU/CPU/memory/network charts (parity gap; W&B captures these automatically). Raw `upload_health_unix_seconds` rows shown with comma formatting.
- D9: Logs/Files/Graph: solid structure, good empty states; Files preview of csv/json exists via evidence panels but no inline preview for the most common case (small csv) on the artifacts list itself.
- D10: Clicking a run name in the selector navigates here (expected), but there's no way back to the workspace preserving context except browser back; add an explicit "Back to runs" breadcrumb action.

### 4.5 Metrics
- M1: Strong when project-scoped (catalog, leaderboard, pin, smoothing, grouping).
- M2: Single-point series (test/accuracy logged once) render as near-invisible dots; render visible markers when a series has < 3 points.
- M3: Leaderboard includes runs without the metric as "-" rows; filter them out.
- M4: "Metric filter" placeholder `train/.*` implies regex with no hint or validation feedback.
- M5: Header stat block "AVAILABLE 39 / PINNED 0 / SERIES 36" is insider vocabulary; label in user terms ("39 metrics · 36 series plotted").
- M6: Smoothing slider has no value readout ("Smooth 0" updates, but units/method — EMA? window? — unstated).

### 4.6 Compare
- C1 (P0-2): No on-page run selection; selection doesn't survive reloads; not shareable.
- C2: Table clips at the right edge (last config column renders "U…"); the horizontal scrollbar sits mid-page and the clipped header row gives no affordance that more columns exist. Add edge fade + sticky first column + visible scroll.
- C3: Delta coloring is direction-naive for added metric columns (lower loss shows red). The "Best objective" concept already encodes direction for the primary metric; respect a per-metric direction (or neutral color when unknown).
- C4: Artifact strips list `test-predictions.csv` twice per run with no version/alias label; "+1 more" target unclear. Group by name with version chips.
- C5: Reference run switching, diff-only, row/matrix modes, sortable columns: all good bones. The "First 50 selected runs are compared" overflow note is honest (good).
- C6: Search inside Compare only filters already-compared runs; with C1 fixed it should also add runs.

### 4.7 Insights
- I1: Group table header shows raw group values ("17", "7") without the grouping key (seed); say "Grouped by seed".
- I2: Evaluation metric cards render 4 of 7 as "not logged" placeholders; hide unlogged cards behind a "+3 not logged" disclosure.
- I3: Parallel coordinates: degenerate axes show the same number top and bottom (EPOCHS 160/160); collapse or annotate constant axes ("constant: 160"). Otherwise a genuinely good panel (best-run highlight works).
- I4: No interaction from points/lines to runs (click → run detail / select).
- I5: "Using 6 current loaded page" header copy is broken English; "Analyzing the 6 loaded runs".

### 4.8 Distributed
- DS1: The strongest analysis surface in the product (reducers, coverage, per-rank snapshot with straggler highlighting, heatmap, outliers, z-scores). Keep and showcase in demos — with seeded rank data.
- DS2: No on-page run picker (P0-2 family): the "selected run" is set on another tab.
- DS3: Heatmap and coverage rely on red/green alone; add a colorblind-safe diverging palette option and/or pattern, and a numeric tooltip per cell.
- DS4: Truncated control labels: "Mean, weighted, m…" / "Show central tenden…" at default width.
- DS5: Z-score coloring implies good/bad by sign (−green/+red); deviation direction isn't inherently bad — use magnitude-based neutral emphasis.
- DS6: Empty state teaches the exact SDK call (excellent pattern — replicate it everywhere).

### 4.9 Alerts
- AL1 (major): Not really alerts — a derived-warnings list. 12 identical "has no checkpoints" warnings for seed runs = noise that trains users to ignore the tab. No rules, no channels (email/Slack/webhook), no mute/acknowledge, no per-run threshold alerts (W&B `run.alert()` + automations). Either build alert rules (define condition → notify channel) or rename this surface "Run health" and dedupe ("8 runs have no checkpoints" as one row).
- AL2: Run Health side cards (failed/active/metric points/best accuracy) are useful; promote them to the Runs workspace header instead.

### 4.10 Datasets
- DT1: Config-derived only; honest empty state. But Coverage card mixes scopes: "PROJECTS 8" (org-wide) beside "RUNS IN VIEW 12" (project) under a project filter. Scope every number to the current context.

### 4.11 Imports & integrations
- IM1: Best-in-class page (stepper, source cards, schema mapping table, "tokens stay local" trust note, dry-run-first). Keep.
- IM2: Copy command embeds `--entity my-team` placeholder that will be copied verbatim; pre-fill from the workspace or visually mark placeholders.

### 4.12 Artifacts
- AR1 (major): Layout is panel soup — six dashboard cards (Collections / Versions / Manifest / Lineage / Raw / Totals) of which four show empty states for typical runs. The mental model (collection → version → files) is buried. Replace with a two-pane browser: left = collections + versions tree, right = files with preview; raw run uploads fold in as "unversioned".
- AR2: "Metadata only" reference artifacts (`file://…` URIs) aren't visually distinguished from uploaded ones; users will click Download expecting bytes.
- AR3: URIs middle-truncated with no copy-URI affordance (only Copy ID).
- AR4: No file preview (csv/json/image) in the artifact list; evidence preview exists only in Run Detail → Files.
- AR5: Duplicate filenames listed without version/alias disambiguation (same as C4).
- AR6: "Selected page totals — FILES 24" is an accounting card users don't need front-and-center.

### 4.13 Checkpoints
- CK1: Run Context panel overflow (P0-3).
- CK2: Timeline is a single-row list; with one tracked checkpoint the page feels empty. Merge Checkpoints into Run Detail (Summary already lists checkpoint artifacts with Resume/Fork — good) and into Artifacts; a top-level tab isn't earning its slot.

### 4.14 Reports
- RP1 (P0-6): Title default-text bug.
- RP2: Panel-grid runset configuration is raw text fields: "PROJECTS (comma-separated…)", "PINNED RUN IDS (UUID or project/name)". Needs project picker + run search (the components exist elsewhere).
- RP3: Auto-save pill, visibility selector, share/export: good. Missing: comments/mentions (W&B reports are collaborative documents), report duplication, and a template ("Experiment readout" with prefilled sections).
- RP4: Block picker is discoverable ("Type / …" hint) — good.

### 4.15 Settings
- ST1: One page mixes plan usage, billing, seats, members, workspace defaults, and a debug "state echo" (PROJECT FILTER / SELECTED RUNS: 0 / API ROUTE MODE: Same-origin proxy). The state echo is internal debugging — move behind a dev flag.
- ST2: No profile section (display name/avatar), no notification preferences, no theme control, no danger zone (delete workspace), no project management anywhere (rename/delete project, default privacy).
- ST3: Member list shows the owner row; invite flow only exists at signup (per README). Add invite here — it's where everyone will look.
- ST4 (P0-8): plan-change → Stripe with no confirm.
- ST5: Plan usage bars are good; "resets Jul 1" chip in topbar is good.

### 4.16 API tab
- AP1: Key list + copy-once reveal + revoke (X) work; the revoke affordance is a bare "×" with no confirm dialog observed — destructive action needs a confirm + "last used" metadata per key.
- AP2 (P0-6): name input default-text bug.
- AP3: API surface cards with copyable example routes: nice docs touch; consider linking each to `/docs` route reference.

### 4.17 Chrome/topbar
- T1: Theme toggle absent in the dashboard (exists only on landing); theme is persisted but unreachable. Put it in the account menu.
- T2: The slider icon next to search toggles the filter bar with no tooltip/label and no state explanation; it reads as "settings".
- T3: Plan badge ("Premium · 0% used · resets Jul 1") is informative; clicking it should go to Settings → usage (currently unverified).
- T4: Account/workspace menu is well done (search, role/plan/member metadata, create workspace).
- T5: Quick search (Cmd+K) is excellent; add it to the visible UI as a search box affordance for mouse users (exists as "Search ⌘K" — good), and show grouped results (Tabs / Runs / Projects) with type labels on the left.

### 4.18 Visual design system
- V1: Tokens, spacing, and component vocabulary are consistent; dark theme is genuinely good; light theme renders cleanly.
- V2: Italic-serif flourishes ("Runs *in flight*", "Alerts *worth watching*", "0 runs *side by side*", "API *keys*") appear on every page header — the flourish is brand voice once, formula when it's everywhere, and "0 runs side by side" reads odd. Keep it on at most the workspace landing header; use plain headers elsewhere. (PRODUCT.md itself warns against display typography in dense UI.)
- V3: All-caps micro-eyebrows (WORKSPACE / ADMIN / METRICS) on every page: same formula concern; they add a scanning anchor though — acceptable if V2 is addressed.
- V4: Status vocabulary: "Finished" outlined-green chip everywhere is heavy for the most common state; consider quiet text + colored dot, reserving chips for Failed/Running.
- V5: Tag chips truncate aggressively with no tooltip; add title/tooltip and a popover for full tag lists.
- V6: Monospace is used well for data; check 11px faint text against AA (the `--faint` token is documented as AA-safe — verify on tinted surfaces).

---

## 5. W&B parity matrix (feature-level)

| Capability | W&B | InstantML today | Verdict |
|---|---|---|---|
| Runs table (sortable metric/config columns, filters, grouping) | Core | Selector list only; table exists only inside Compare | **Gap — highest priority** |
| Metric charts (smoothing, grouping, x-axis modes) | Core | Yes (good) | Parity (minus polish) |
| Run compare (diff configs/metrics) | Core | Yes, row+matrix modes | Parity once selection is fixed |
| Saved views / workspaces | Workspaces | Control-plane saved views + local fallback | Parity-ish |
| Reports | Collaborative docs + comments | Block editor + share links, no comments | Partial |
| Artifacts (versioning, lineage, preview) | Core | Versions/aliases/lineage exist; browser UX weak, no preview | Partial |
| Model registry (stages, promotion) | Yes | No | Gap (acceptable post-demo) |
| Sweeps / HPO | Yes | No (Insights offers local scatter/parallel/k-means) | Gap (Insights is a partial answer) |
| System metrics (GPU/CPU/mem auto-capture) | Yes | No (SDK queue counters only) | **Gap — table stakes for ML infra demos** |
| Alerts (`run.alert()`, automations, Slack/email) | Yes | Derived warnings list only | **Gap** |
| Media logging (images/audio/video/3D) | Yes | Tables, histograms, files; rollout gallery | Partial |
| Logs streaming | Yes | Yes (virtualized, ANSI-safe) | Parity |
| Distributed/rank-aware views | Weak | Strong (reducers, heatmaps, stragglers) | **Differentiator — lead with it** |
| Forking/resume from checkpoint | Limited | First-class (fork + resume code) | **Differentiator** |
| Imports from W&B/MLflow/Neptune/TB | Limited | First-class, CLI-first, dry-run | **Differentiator** |
| Public project sharing / anonymous mode | Yes | Report share links only | Gap (fine for now) |
| Mobile/responsive | Mediocre | mobile.css exists; untested | Unknown |

Strategy note: don't chase Sweeps or Registry for the demo. Lead with speed + Distributed + fork/resume + imports; close the runs-table, system-metrics, and alerts gaps, which are what a W&B user misses in the first ten minutes.

---

## 6. Security & performance review

### Security — positives (verified in code)
- ClickHouse queries use parameter binding throughout `metric_store.rs` (no string-built SQL found).
- API keys, sessions, invitation tokens stored as SHA-256 hashes with hash-keyed lookup maps; report share tokens reuse the CSPRNG key generator.
- Session cookie: HttpOnly, SameSite=Lax, conditional Secure (with a localhost carve-out), bounded Max-Age.
- CSRF: `validate_mutation_origin` enforces an allow-listed Origin on mutations in hosted mode; session-scoped variant for browser flows.
- Rate limiting: unauthenticated per-client and per-org per-class limits with structured 429s.
- CSV exports neutralize formula injection (`=`, `+`, `-`, `@`, tab/CR/LF, including padded variants) and quote correctly.
- Log terminal renders ANSI via classed spans (`ansiTokens`), no `innerHTML`; only controlled `dangerouslySetInnerHTML` in `layout.tsx` (theme bootstrap + static JSON-LD).
- Artifact store sanitizes names and canonicalizes paths against the root (path traversal defense).
- Imports are CLI-first specifically so third-party tokens never reach the server (good architectural stance).

### Security — issues
- S1 (high, DX): `examples/rank-insights/train.py` has no `--server` flag and defaults to `https://api.instantml.ai` — following the README sends the user's `INSTANTML_API_KEY` to production from a local workflow (this audit reproduced it). Make examples consistent; better, make the SDK warn when an `instantml_…` key is sent to a non-default host or vice versa.
- S2 (medium): JSON-LD injection helper uses plain `JSON.stringify`; content is static today, but adopt a `</script>`-escaping serializer to keep it safe under future dynamic data.
- S3 (medium): API key revoke is a single unconfirmed "×" click (destructive, irreversible for SDKs in the field).
- S4 (low): local auth mode falls back to an unauthenticated `RequestContext::local()`; fine bound to 127.0.0.1 — add a startup warning if `INSTANTML_AUTH_MODE=local` with a non-loopback bind.
- S5 (low): no Content-Security-Policy observed on the web app; with Clerk + same-origin proxy a strict CSP is attainable and cheap insurance.
- S6 (low): report share tokens have rotation but no expiry and no last-accessed visibility for owners.

### Performance — positives
- Local API p95s: 10–200 ms for everything observed (summaries, series, usage); charts are canvas-based; logs are virtualized; series fetches are bounded (1,000 points per run cap, documented in Settings).

### Performance — risks
- PF1 (high, backend): the entire control-plane dataset (orgs, runs, artifacts, sessions, API keys…) is in-memory `BTreeMap`s behind **one global `tokio::sync::Mutex`** (`store.data.lock().await` on nearly every request, including auth lookups). At the stated 50k-run target this is a contention and memory ceiling; write-gating iterates all org artifacts per run-create (`usage_counts_for_org`). Plan a sharded/RwLock store or push hot lookups (auth) into lock-free maps.
- PF2 (medium, frontend): `dashboard-shell.tsx` is 4,175 lines with 57 `useEffect`s and owns every tab; all analysis state re-renders through one component. Split per-tab state ownership; this is also what makes selection persistence hard today.
- PF3 (low): duplicate fetch pairs observed on load (`/api/workspace-views`, `/api/metrics/series` each fired twice — likely StrictMode double-mount in dev, but verify in prod build).
- PF4 (low): 5 s polling runs while the tab is hidden; gate on `document.visibilityState` and use backoff when idle.
- PF5 (low): seeding revealed `finish()` upload-queue starvation under modest bursts (8 ranks × 60 steps × 7 metrics) — the async uploader needs either a longer drain budget, progress reporting, or server acks surfaced to the UI (ties to P0-7).

---

## 7. Redesigned flows (mockups in `docs/design/mockups/`)

1. **Runs workspace** (`mockup-runs-workspace.html`) — pinned labeled sidebar with project switcher; runs as a real table (status dot, name, duration, key metrics, config columns, tags, chart-color swatch); selection checkboxes feeding a bottom selection tray ("3 selected — Compare · Export · Tag"); panels docked right with auto-sections from present metrics only; honest run data-state badges (uploading/incomplete).
2. **Compare** (`mockup-compare.html`) — inline "Add runs" picker (search + recent + select-all-from-filter), URL-encoded selection, sticky first column, direction-aware deltas with per-metric goal direction, artifact version chips.
3. **Run Detail** (`mockup-run-detail.html`) — fixed two-column layout with wrapped, copyable metadata (commit, platform, python); LATEST/BEST driven by the run's own objective; system metrics as charts with the upload-health status as a banner state, not a metric row; reproducibility as a teaching empty state.

---

## 8. Roadmap to demo-ready

**Week 1 — stop the bleeding (P0s)**
1. Replace hover rail with pinned labeled sidebar (P0-1).
2. URL-encoded run selection + Compare inline picker + selection tray (P0-2).
3. Fix metadata overflow + copy buttons (P0-3); fix `?project=` precedence (P0-5); placeholder bugs (P0-6).
4. Project-first defaults; hide empty sections; per-project default metric (P0-4).
5. Run data-state badges for incomplete uploads (P0-7 UI half).
6. In-app plan-change confirm step (P0-8). API-key revoke confirm (S3).

**Week 2 — the table and the trust**
7. Runs table with sortable metric/config columns + column chooser (R1) — biggest single parity win.
8. Direction-aware deltas in Compare (C3); clip/scroll fixes (C2).
9. Run Detail cleanup: D2–D7 (system metrics out of summary tables, GOAL defined or dropped, Data tab defaults to current run).
10. Examples/SDK base-URL footgun (S1) + finish() drain budget (PF5).

**Week 3 — parity closers & polish**
11. System metrics capture (SDK psutil/NVML) + System tab charts (D8).
12. Alerts → either real rules (one channel: email) or rename to Run Health with dedupe (AL1).
13. Artifacts browser restructure (AR1) with preview for csv/json/png (AR4).
14. Reports: runset pickers (RP2), report template, comments if time allows.
15. Theme toggle in account menu (T1); landing reveal de-gating (L1); a11y pass on heatmap palette (DS3) and faint text (V6).
16. Settings: split into Workspace / Members (with invite) / Billing / Profile; remove debug echo (ST1–ST3).

**Defer (post-demo, on evidence)**: Sweeps, model registry stages, public projects, mobile-first work, report comments if cut from week 3.

---

## 9. Things that are genuinely good (keep, and demo these)

- Distributed rank dashboards (coverage, stragglers, heatmap) — no W&B equivalent.
- Imports & integrations page — CLI-first with a real trust posture.
- Checkpoint fork/resume with confirmation copy that tells the truth ("creates only a run record, does not start training").
- Cmd+K quick search; undo/redo for workspace changes; saved views with stale-run pruning.
- Canvas charts with bounded reads; skeletons; <200 ms API behavior — "make speed visible" is real.
- Token system, dark theme, and overall component consistency; the Stripe/Clerk integration plumbing.
