# Design: Hyperparameter Explorers — production hardening (log scale, accessibility, honest scale)

Date: 2026-06-30

Status: Accepted (revised after fresh review)

Owner: Claude (agent)

## Summary

The competitive gap analysis flagged "Params (parallel-coordinates) + Scatter
explorers" as missing vs. Aim. **Fresh review proved that premise wrong**: the
explorers already ship under **Insights → Run Analysis**
(`apps/web/app/dashboard/insights/tab-pane.tsx`), powered by the pure logic in
`apps/web/src/research-insights.js`:

- a **Hyperparameter scatter** card (X/Y axis selectors, auto-defaults,
  click-to-open-run, hover readout),
- a **Parallel coordinates** card (add/remove axes, best-run highlight,
  constant-axis handling),
- plus k-means clustering and grouped reducers.

Three independent reviewers (simplicity, performance, frontend/a11y) all reached
the same verdict: **do not build a second set of explorers** — that would
duplicate shipped, tested code (also present as report/workspace panel blocks in
`src/dashboard-panels.js`) and split the UX. The real gap is that the *existing*
explorers fall short of Aim parity and the repo's own production bar on three
concrete, verifiable axes (confirmed live against the 1,000-run demo seed):

1. **No log-scale axes.** The scatter explicitly renders "linear axes" only.
   Learning rate and loss — the canonical hyperparameter/metric pair — are
   log-natural; on a linear axis a 1e-5…1e-2 sweep collapses onto the origin.
2. **Accessibility below the repo standard.** The accepted
   `2026-06-12-accessible-chart-summary-tables.md` pattern (Chart/Summary-table
   toggle, real `<table>` with scoped headers) is implemented for line charts
   (`metric-chart.tsx`) but **not** for the explorers. Live DOM check:
   parallel-coordinates is `role="img"` + one `aria-label`, `tabIndex=null`
   (not keyboard-focusable), and there is **no** summary table on either
   explorer (`anyTableInExplorers: 0`). A screen-reader user learns the axis
   names and nothing else.
3. **Silent truncation.** Parallel coordinates renders `rows.slice(0, 80)` and
   labels it "80 runs" with no "of N"; scatter caps at `slice(0, 500)`. Users
   cannot tell coverage is partial.

This change closes those three gaps by **extending the existing explorers**, not
replacing them. It reuses `research-insights.js` and adds new logic only in that
pure, unit-tested layer.

## Goals

- Add per-axis **linear/log** scaling to the scatter explorer, auto-defaulting
  learning-rate-like axes to log (reusing the repo's existing LR heuristic).
- Bring both explorers to the accepted accessible-chart standard: a
  **Chart / Table** toggle exposing an accessible summary `<table>`, a
  keyboard-focusable parallel-coordinates chart, and a live readout.
- Make truncation **honest**: disclose "showing N of M" everywhere and raise the
  parallel-coordinates draw cap to a safe, disclosed bound.
- Ship as a localized, reuse-first change with full unit coverage of new pure
  logic and a browser E2E pass against the seed.

## Non-Goals

- No new explorer tab, no new chart components, no new backend endpoint, no SDK
  change. (All three reviewers flagged these as duplication.)
- No full-project-population scope change. The explorers analyze the loaded/
  selected run universe today; widening to the entire filtered population needs
  backend paging and is a **documented follow-up**, not this slice.
- No color-by-metric gradient or axis brushing in this slice (follow-ups). The
  sequential color ramp the frontend reviewer noted as absent is out of scope.
- No change to clustering or grouped-reducer cards.

## Users and Use Cases

An engineer tuning learning rate opens Insights → Run Analysis, sets the scatter
X axis to `learning_rate` and flips it to **log** — the sweep spreads across the
axis and the relationship to `eval/loss` becomes legible. A screen-reader user
opens the **Table** view of the parallel-coordinates explorer and reads, per
run, each axis value plus which run is best for the active metric. A user with
2,000 loaded runs sees "showing 200 of 2,000 — narrow the run set for full
coverage" instead of a silent 80.

## Proposed Design

All changes live in `apps/web/app/dashboard/insights/tab-pane.tsx` (the cards)
and `apps/web/src/research-insights.js` (new pure helpers). New pure logic is
unit-tested in `apps/web/tests`.

### 1. Log-scale scatter

- Add a per-axis scale control (linear/log) to the scatter card's
  `AxisPairControls`, defaulting via a small reused heuristic
  (`isLearningRateLikeField`, already in `src/dashboard-panels.js`) so LR-like
  axes start on log.
- Extend the scatter geometry to map values under a chosen scale. Add a pure
  `scatterGeometry(points, { xScale, yScale })` in `research-insights.js` that
  generalizes the current local `pointGeometry`: for a log axis it maps
  `log10(value)` and drops non-positive values (counted and disclosed, mirroring
  `charts.js` log handling). Linear remains the default and the exact current
  behavior.
- Axis tick labels show real values (not log10) using existing `formatNumber`/
  `formatAxisTick`. The note reports the active scale ("log x · linear y") and
  any non-positive points hidden by a log axis.

### 2. Accessibility — Chart/Table toggle + keyboard

- Add a reusable `ExplorerChartFrame` wrapper (or extend each card) providing a
  Chart/Summary-table SegmentedToggle, matching `metric-chart.tsx`'s pattern
  (`aria-pressed`, `role="status"` live announcement of the active view).
- New pure builders in `research-insights.js`:
  - `scatterSummaryRows(points, fields)` → per-run `{ name, x, y }` plus a
    header describing the two fields; sorted by Y (goal-aware where a metric).
  - `parallelSummaryRows(rows, fields, { bestRunId })` → per-run row with one
    column per axis (raw values) and a "best" marker; plus a per-axis
    `parallelAxisSummary` (min/max/constant) for an axis-stats caption.
- Render these as real `<table>`s (caption, `<th scope="col">`/`scope="row">`),
  reusing the `.chart-summary-table` styles.
- Make the parallel-coordinates `<svg>` keyboard-focusable (`tabIndex={0}`) with
  an `aria-live` readout naming the focused/best run, mirroring the scatter
  card's existing focus readout. Both charts keep `role="img"` with a descriptive
  label.

### 3. Honest truncation

- Replace the inline `rows.slice(0, 80)` for parallel coordinates with a named
  constant (`PARALLEL_MAX_DRAWN = 200`) and disclose "showing N of M" in the note
  and chart `aria-label` when `M > N`. Raising 80→200 stays well under the dense
  thresholds for SVG (the chart is one polyline per run; 200 polylines × ≤5 axes
  is light) and is disclosed.
- Scatter already discloses "shown of"; align its wording and surface the same
  "of M" in the `aria-label`.

## Component Impact

Backend / SDK / Storage: none.

Frontend:

- `apps/web/src/research-insights.js`: new pure exports `scatterGeometry`,
  `scatterSummaryRows`, `parallelSummaryRows`, `parallelAxisSummary`,
  `logSafeValues` (small helpers). Existing exports unchanged.
- `apps/web/app/dashboard/insights/tab-pane.tsx`: scatter scale control + log
  rendering; Chart/Table toggle + tables on both explorers; parallel keyboard
  focus + readout; truncation disclosure + raised cap.
- `apps/web/app/styles/research.css` (or the nearest existing explorer
  stylesheet): minor styles for the scale control and table within the cards
  (reusing existing `.chart-summary-table`, `.analysis-note` tokens).

Docs:

- `apps/web/README.md` (Insights explorer capabilities), `USER_DOCS.md`
  (log scale + accessible tables note).

## Data Model

No data model changes. New wire types: none (all client-side over the existing
`/api/runs/summary` payload the shell already loads).

## API Contracts

No API changes. Continues to consume `RunSummary` (`config`,
`latest_metrics`, `metric_aggregates`) already loaded by the dashboard shell and
passed to `InsightsTabPane` as `sortedRuns` + `selectedRunIds`.

## Performance Considerations

- Pure client-side transforms over the already-loaded run universe (≤ the shell's
  loaded page). No new network calls.
- `scatterGeometry`/summary builders are O(points). Parallel draw cap 200
  polylines × ≤5 axes is far under `DENSE_CHART_SERIES_THRESHOLD` (120 *line
  series*, i.e. many points each); these are short straight polylines, so SVG is
  fine and no canvas path is needed. Tables render ≤ the same row caps.
- Log mapping guards non-positive values (no `log(≤0)`); degenerate/constant
  axes keep the existing centered-band handling.

## Simplicity Review

This is the smallest change that closes the three verified gaps, and it is
reuse-first: no new components, endpoints, or chart engines; new code is confined
to pure functions in `research-insights.js` plus wiring in the existing card
file. It directly implements the reviewers' unanimous recommendation (harden,
don't duplicate). Deferred by intent: full-population scope (needs backend
paging), color-by-metric ramp, and axis brushing.

## Failure Modes

- **Log axis with non-positive values**: those points/lines are dropped from the
  log axis, counted, and disclosed in the note; the axis still renders.
- **All-constant axis**: existing constant-axis centering retained; the table
  caption marks it constant.
- **No numeric fields / <2 fields**: existing empty states retained.
- **Truncation**: disclosed count in note + `aria-label`.
- **Table with many rows**: capped to the same disclosed bound as the chart so
  the table never balloons past what's drawn.

## Testing Plan

- **Web unit** (`apps/web/tests`, node:test): `scatterGeometry` (linear vs log
  mapping, non-positive drop count, degenerate axis), `scatterSummaryRows` /
  `parallelSummaryRows` (ordering, best marker, per-axis stats, truncation
  flag), `logSafeValues`. Target 100% of the new pure helpers.
- **Browser E2E** (Playwright against the dev API + 1,000-run seed): scatter log
  toggle changes the axis + note; Chart/Table toggle reveals an accessible
  `<table>` on both explorers; parallel `<svg>` is focusable and exposes a live
  readout; truncation note shows "N of M". Before/after screenshots.
- **Commands**: `npm run test:node` (targeted), `npm run web:build`, browser QA.

Coverage: 100% of new pure helpers. UI wiring covered by E2E + existing card
render paths.

## Documentation Plan

- `apps/web/README.md`: note log scale + accessible tables on the Insights
  explorers.
- `USER_DOCS.md`: short "Explore hyperparameters (log scale, accessible tables)".
- This design doc records the corrected scope and the review.

## Alternatives Considered

- **Build a new Explore tab + endpoint + chart components** (the original draft):
  rejected by all three reviewers as duplication of shipped explorers
  (`research-insights.js`, `dashboard-panels.js`, `ScatterPanelChart`,
  `parallel-coordinates-renderer.tsx`) and a split UX.
- **Promote explorers to a top-level tab**: deferred — discoverability is real
  but structurally riskier and orthogonal to the quality gaps; revisit after the
  explorers are production-grade.
- **Color-by-metric ramp**: high Aim-parity value but net-new color infra; kept
  as a focused follow-up to keep this slice low-risk and reviewable.

## Review Notes

Fresh reviewer 1 (simplicity/scope):

- Finding: A new `/api/explore/runs` endpoint + `explore-model.ts` + new chart
  files duplicate `dashboard-panels.js` (`parallelCoordinatesForRuns`,
  `scatterPointsForRuns`, `buildRunFieldCatalog`) and shipped renderers; the
  honest first slice reuses existing code over `/api/runs/summary`.
- Risk: Two flatten/typing/axis implementations drift; over-build.
- Decision: **Accepted.** Scope rewritten to reuse existing explorers; no new
  endpoint or chart engine.

Fresh reviewer 2 (performance/correctness):

- Finding: Frontend explorer logic already exists and is unit-tested; the new
  2,000-run cap doubles `MAX_RUN_LIMIT` (1000); 2,000 SVG polylines contradict
  the repo's dense-chart canvas precedent; param-typing edge cases (NaN/inf,
  numeric-looking strings, `best` for minimize metrics, log≤0) underspecified.
- Risk: Duplication; inconsistent caps; SVG perf; correctness on edge values.
- Decision: **Accepted.** No new endpoint/cap; parallel draw cap set to 200
  (well under dense thresholds, disclosed); log mapping guards ≤0; reuse the
  existing goal-aware `best` logic; no 2,000-run SVG render.

Fresh reviewer 3 (frontend/a11y):

- Finding: The feature already exists under Insights (scatter, parallel,
  clusters); `charts.js` cannot supply parallel/scatter/categorical/gradient
  primitives (the existing cards use `research-insights.js` + a local
  `pointGeometry`, not `charts.js`); the accessible summary-table pattern is not
  yet applied to the field-matrix shape; parallel coords has no keyboard/table;
  tab registration has four touch points and the shell passes `sortedRuns`/
  `selectedRunIds`, not `query`.
- Risk: Duplicate UX; unbuildable reuse claims; empty SR story; broken deep-link
  if a tab were added.
- Decision: **Accepted.** No new tab (so no routing touch points); extend the
  existing cards; build a **new** field-matrix summary table (not a call to the
  line-series `chartSummaryRows`); add keyboard + live readout to parallel
  coords; reuse `research-insights.js` (not `charts.js`) for geometry.

## Coverage Exceptions

None expected; new logic is pure and fully unit-testable.

## Decision

**Accepted** for implementation as a localized, reuse-first hardening of the
existing Insights hyperparameter explorers: log-scale scatter, accessible
Chart/Table + keyboard for both explorers, and honest truncation. Full-population
scope, color-by-metric, and brushing are documented follow-ups.

## Implementation Status (2026-06-30)

Shipped on branch `feat/hyperparameter-explorers`:

- **Log-scale scatter** — per-axis linear/log toggle in `ScatterCard`;
  learning-rate-like axes auto-default to log via `looksLogarithmicField`.
  New pure `scatterGeometry(points, {xScale,yScale})` in `research-insights.js`
  maps log10 and drops/counts non-positive values.
- **Accessibility** — `Chart`⇄`Table` `SegmentedToggle` on both explorers,
  rendering accessible `<table>`s (caption + `scope` headers) from new pure
  `scatterSummaryRows` / `parallelSummaryRows`. The parallel `<svg>` is now
  `tabIndex={0}` with an `aria-live` focus readout. The Table view is gated on
  its own `summaryRows` so an all-non-positive log axis never hides the
  accessible fallback.
- **Honest truncation** — `PARALLEL_MAX_DRAWN = 200`, disclosed as "N of M".
- **Legibility** — all axis tick labels (scatter + parallel) use
  `formatAxisTick`, and hover/readout/table cells use `formatMetricValue`, so a
  learning-rate axis renders `1e-4` / `3e-4`, never `0`.

Verification: `tsc --noEmit` clean (caught + fixed 2 type bugs and 1 review
finding); 20 unit tests in `apps/web/tests/insights-tab.test.js` (405 total web
unit tests green); Playwright E2E against the 1,000-run demo seed confirms the
log toggle, both Chart/Table toggles, the parallel keyboard readout, and
scientific learning-rate axis ticks. A fresh pre-commit code review (FIX-FIRST)
surfaced the tick-label "0" regression and the table-gate bug; both were fixed
and locked with regression tests before commit.

Follow-ups (out of scope, intentionally deferred): full filtered-population
scope (needs a bounded backend projection / paging beyond the loaded page),
color-by-metric sequential ramp, and axis brushing-to-refilter.
