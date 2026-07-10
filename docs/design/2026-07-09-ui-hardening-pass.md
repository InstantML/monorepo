# UI Hardening Pass — 2026-07-09

Status: in progress. Senior-frontend hardening sweep of the dashboard: no new
features, only making what exists solid, consistent, and fast. Follows the
2026-06-10 production audit (whose P0s have landed) and the tracing rounds.

## Surface map

**Screens** (all lazy-loaded panes inside `dashboard-shell.tsx`, routed by
`/dashboard/<tab>`): Runs (panels view + sortable table/compare view), Metrics,
Distributed (rank reducers), Traces (summaries + tree + inspector), Datasets,
Artifacts (versioned collections + raw run artifacts), Insights (GPU/System ·
Run Analysis), Run Health (alerts), Reports (list + block editor), Agent (MCP
setup), Settings, and the Run workspace (`detail/`: Overview · Metrics ·
Traces · Artifacts · Logs · Config · Lineage). Chrome: nav rail, topbar
(project scope, search, workspace menu), quick-search palette, shortcut help,
ticker. Outside the dashboard: landing, signin/signup, onboarding, invite,
billing return, pricing, docs, embed, share (`/r/<token>`).

**Shared primitives**: `ui/select` (CustomSelect), `ui/skeleton`, `ui/toasts`,
`ui/metric-card`, `ui/analysis-card`, `ui/use-focus-trap`,
`ui/use-details-dismiss`, `components/segmented-toggle`,
`components/debounced-text-input`, `src/charts.js` (canvas + SVG primitives),
`detail/trace-timeline`.

**State matrix probed per surface**: loading (skeletons), empty, error
(API down / 4xx / 5xx), success, disabled, overflow/long-text, live-poll
(running runs), keyboard-only, dark/light, 375 / 768 / 1280 viewports.

## Baseline (before)

- Production build: 84 static pages; client JS healthy — largest chunk 288 KB,
  2.6 MB total chunks (uncompressed), tabs lazy-loaded (PR #355).
- CSS: single `globals.css` @import chain (~33.7k lines, ~230 KB raw across
  19 files) ships to every route including landing/docs/reports styles on the
  dashboard. Known Phase-3 debt with a documented plan
  (`docs/design/2026-05-18-globals-css-audit.md`); import order is
  load-bearing — deliberately not churned in this pass.
- Token discipline: 145 raw `font-size: <n>px` declarations outside
  `tokens.css` (top offenders: reports.css 31, landing-system.css 24,
  overhaul/dark-overrides/compare 12 each); raw border-radius values
  concentrated in overhaul/landing-system/docs/charts; `!important` mostly in
  docs.css (28) and landing-system.css (17).

## Findings

(grouped by dimension; ✅ = fixed in this pass, ▶ = deferred with rationale)

### 1. Bugs & broken states

- ✅ **Mid-session API failure masqueraded as empty data on Metrics.** With the
  API killed after load, switching to Metrics rendered a normal-looking page
  claiming "No runs have logged <metric> yet" — the shell's runs/series fetch
  error only surfaced inside the Runs workspace. The Metrics pane now renders
  the shell's error tone as a danger status strip (`.status-strip.error`),
  verified by killing/restarting the local API live. Full page loads while the
  API is down already redirect to the sign-in recovery card ("Couldn't reach
  InstantML · Retry connection") — verified, no crash.
- ✅ **Runs-table STEP column showed billions-scale values.** The
  `latestStep` aggregate fallback included the SDK's time-keyed
  `system/instantml/*` upload telemetry (best_step = unix seconds). Now
  filtered via the existing `isInternalInstantMlMetric`. ▶ Residual: for runs
  without the selected metric the fallback shows best_step, not latest step —
  needs a summary-level last-user-step field (server change).
- ✅ **Race probes clean**: rapid metric-key switching lands on the last key
  (no stale series); deep-link → run switch → popstate all correct after the
  primaryRunId fix (PR #357). HTML-injection probes render inert everywhere
  (config values, tags, log lines, trace attributes).

### 2. UI consistency

- ✅ **Unbroken long text escaped its containers in six places** (probed with
  a 180-char run name, 800-char config token, 64-char tag, 500-char log line):
  run-detail header (legacy `.run-workspace-name` `flex: 0 0 auto` defeated
  the pd-name ellipsis and overflowed into Compare), config codewell (5500px
  sideways scroll → `overflow-wrap: anywhere`), runs-table RUN column
  (auto-layout column grew to ~1100px pushing metrics off-screen → 52ch/38vw
  cap + title), legend chips in wide grid tracks (1445px chip → 52ch cap),
  table tag chips (22ch cap). Log tail and trace rows already contained
  long content correctly.
- ▶ **Token discipline drift** (measured): 145 raw `font-size` px outside
  tokens.css (reports 31, landing-system 24), raw radii concentrated in
  overhaul/landing/docs, `!important` mostly in docs.css (28). Mechanical
  sweep deferred — churn risk outweighs user-visible gain; top offenders are
  marketing/docs surfaces outside the product shell.

### 3. Performance

- Production build healthy: 84 pages, largest client chunk 288 KB, tabs
  lazy-loaded. Long-task probe during chart-hover sweeps and tab switches
  peaks at ~113 ms in dev mode (dev-build hydration dominates); no
  unmemoized hot paths surfaced — chart hover rows, marker layers, and
  summary rows are already memoized from prior rounds.
- ▶ **All-routes CSS bundle** (~230 KB raw across 19 files) ships to every
  route including dashboard-irrelevant landing/docs/reports styles. Known
  Phase-3 debt with documented plan (2026-05-18 audit); import order is
  load-bearing, deliberately not churned here.

### 4. Accessibility & robustness

- ✅ **Accessible names: clean.** Live-DOM audit found zero buttons/links
  lacking an accessible name (aria-hidden-aware textContent + aria-label
  check across the runs page).
- ✅ **Keyboard: clean.** Quick-search opens with focus in its input, Escape
  closes and returns focus to the trigger; tab focus is visible
  (outline + shadow) on chrome controls.
- ✅ **Panel heads clipped nothing but spilled under panel bodies on phones.**
  overhaul.css pinned `.panel-head` at exactly 48px; artifact panels' wrapped
  action rows overlapped the body by a measured 230px at 390px wide. Fixed
  with min-height; desktop renders pixel-identical (verified).
- ✅ **Mobile legend chips clamp to 3 lines** — wrapping (L6) preserved for
  metric names, pathological run names no longer push charts off-screen.
- ✅ **Responsive sweep: no horizontal overflow** on any of 10 dashboard
  pages at 390px and 768px (Playwright probe measuring document scrollWidth
  and uncontained wide elements, hostile-data run included).

## Fix log

- `parity-detail.css` — pd-name ellipsis vs legacy flex rule; codewell
  overflow-wrap (commit "Harden the run header and config well…")
- `parity-runs.css` / `charts.css` / `runs-table.tsx` — table name cap +
  title, tag caps, legend cap, telemetry-step filter (commit "Cap runaway
  text in the runs table and chart legends")
- `metrics/tab-pane.tsx` / `dashboard-shell.tsx` / `instrument.css` — error
  strip on Metrics (commit "Surface shared-fetch failures on the Metrics
  pane")
- `overhaul.css` / `mobile.css` — panel-head min-height; mobile legend clamp
  (commit "Let panel heads grow when their controls wrap…")

Gates on the final tree: 424 web tests + tsc clean, traces UI smoke, live
verification in Chrome and Playwright at 390/768/1440 across the hostile-data
run, API-down/recovery cycles, and keyboard/race/long-task probes.
