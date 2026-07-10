# Trace × Metric Correlation in the Run Workspace

Status: accepted · Slice of the tracing surface introduced in
`docs/design/2026-07-03-tracing-integration.md`.

## Problem

Metrics tell users *that* something changed (`reward/mean` dipped at step 400);
traces tell them *why* (the calculator tool timed out inside those rollouts).
Today the two live in separate surfaces: the run workspace Traces tab is a flat
recent-traces list with no step or time anchoring, and the metric charts have no
awareness of trace activity. Users correlate by eye, across tabs.

## Goal

Inside the run workspace (run detail) Traces tab, put run metrics and trace
activity on one shared step axis so a user can see "metric moved here, traces
erred here" in a single view, then click through from a step to the traces that
produced it.

## Non-goals

- No new chart library and no per-span waterfall in this slice (the full trace
  tree already lives in the Traces workspace).
- No wall-clock alignment of individual spans against metric points; step is
  the shared axis (time is shown as a secondary detail). Runs that log traces
  without steps degrade to the existing list plus a "stepless" note.
- No changes to SDK capture semantics.

## Architecture

### Backend: bounded per-step trace aggregates

New route `GET /api/runs/:run_id/traces/steps` (handler in
`http/handlers/traces.rs`, logic in `store/traces.rs`, SQL in
`trace_store.rs`), same auth scoping and accepted-idempotency-batch dedup as
`list_traces`. Trace-grain aggregation over `trace_summaries` (argMax-latest
per trace, the canonical pattern), grouped by the trace's step anchor
`min_step`:

```
TraceStepSummaryResponse {
  steps: [TraceStepBucket {
    step, trace_count, error_trace_count, running_trace_count,
    span_count, error_span_count,
    avg_duration_ms, max_duration_ms,
    input_tokens, output_tokens,
    first_started_at, last_started_at,
  }],
  stepless_trace_count,     // traces with no step anywhere
  total_trace_count,        // run-wide
  total_error_trace_count,  // run-wide: includes stepless + truncated-out
  truncated,                // true when the (range-filtered) result exceeded the cap
}
```

Bounds: `ORDER BY step ASC LIMIT 2001` (`MAX_TRACE_STEP_BUCKETS = 2000`,
truncation detected via limit+1; when truncated the lowest 2000 steps are
kept), optional `min_step`/`max_step` params use a trace-specific validator
that admits finite negatives (ingest accepts them).
Two parallel ClickHouse reads joined with `try_join!`: the bucket query
(step-filtered, `min_step IS NOT NULL`) and a run-wide counts query — the
totals must include stepless and out-of-window traces, so they cannot share
the bucket aggregation. `total_trace_count`/`stepless_trace_count` are always
run-wide; only `steps` honors `min_step`/`max_step`. No new tables, no schema
migration.

Why trace grain, not span grain: the product story is "rollouts at step N";
markers click through to the trace list, which is trace-grain, and
`trace_summaries` already carries canonical per-trace status/duration/token
rollups. Span-grain error counts ride along from the summary columns
(`span_count`, `error_count`).

Why not client-side aggregation of `GET /api/traces`: the list is
cursor-paged at 50 and capped for UI use; a long run with thousands of traces
would need dozens of round-trips and still be wrong under truncation. The
aggregate endpoint is one bounded query.

### Frontend: `TraceMetricTimeline` in the run workspace Traces tab

`apps/web/app/dashboard/detail/trace-timeline.tsx`, rendered above the
existing recent-traces list inside the Traces tab (`detail/tab-pane.tsx`).

- **Metric layer**: one metric line drawn with the existing `charts.js`
  primitives (`normalizeSeries`, `yMapper`, `axisTicks`) in a
  viewBox==px SVG — same geometry model as `MetricChart`, same palette
  (`chartColor`), same axis formatting. Metric key chosen via the shared
  `CustomSelect`, defaulting to `preferredMetricKey` over the run's user
  metrics; series fetched through the same `POST /api/metrics/series`
  request shape `DetailTabPane` already uses (reusing its `seriesMap` cache
  when the key matches a headline key).
- **Trace activity lane**: a fixed-height strip under the x-axis sharing the
  metric chart's x-domain. Each step bucket renders one marker: size encodes
  `trace_count` (sqrt scale, clamped), color encodes health (`--accent` ok,
  `--danger` any errors, `--muted` running-only). Buckets outside the metric
  series' step domain extend the shared domain so traces logged past the last
  metric point stay visible.
- **Interaction**: hovering a step shows a combined tooltip (metric value at
  nearest step + trace count / errors / avg duration / tokens). Clicking a
  bucket selects the step: the list below refetches `/api/traces` with
  `min_step`/`max_step` pinned to it (filters already exist server-side) and a
  clear-filter chip appears. Pointer selection resolves via frame-level nearest-bucket
  hit-testing; a pointer-transparent `<button>` layer with `aria-pressed`,
  a roving tabindex, and arrow-key navigation carries keyboard operability.
- **Degraded states**: no metric points → activity lane renders alone on the
  trace step domain with an explanatory caption; no stepped traces → the
  panel collapses to a "N traces have no step" note above the recent list
  (a chart with no lane earns no vertical space); neither → existing empty
  state. Metric-series fetch failures caption honestly ("Couldn't load
  <key>") instead of posing as an empty series. Loading uses the shared
  skeleton primitives.

### Data flow

```
DetailTabPane (traces tab active)
 ├─ GET /api/runs/:id/traces/steps      → step buckets (new, 2 parallel reads)
 ├─ POST /api/metrics/series {key,...}  → metric line (existing shape)
 └─ GET /api/traces?run_id&min_step&max_step&limit=20 → list (existing)
```

All three are lazy (tab-gated), aborted on tab exit, and independently
error-isolated: a failing steps query must not take down the list.

## Testing

- Rust: store-level tests for the aggregate (bucket math, truncation,
  stepless counting, idempotency dedup) following existing traces tests.
- `apps/web/tests/traces-tab.test.js`: source assertions for the new
  component wiring (lazy gating, endpoint path, filter round-trip), same
  style as the existing run-detail block.
- `ui-smoke.mjs` (`INSTANTML_UI_SMOKE_TRACES_ONLY=1` path): seed stepped
  traces, open the Traces tab, assert timeline renders with markers, click a
  step, assert the list filters and the deep link keeps working.
- Live validation on every slice: real SDK demo (30 steps, several rollouts
  per step, an error cluster + reward dip around one step band) against
  disposable ClickHouse + Rust + Next, driven in Chrome.

## Final review

2026-07-07: four specialized review agents (React correctness, Rust/contract,
design-system/a11y, holistic product bar) swept the full feature diff. All 18
confirmed findings were fixed and re-verified:

- Interaction: frame-level nearest-bucket hit-testing (dense steps), derived
  hover (no stale tooltips across live polls, rAF-coalesced, memoized lane
  layers), loaded-ref invalidation (no false empty states), manual refresh,
  first-N-of-M pinned disclosure.
- A11y/design: two-layer focus ring, metric value in marker labels, roving
  tabindex fallback, tooltip clamping, copy/pluralization, 5% light-theme
  band keeping the metric line ≥3:1.
- Backend: −0.0 step normalization, anchor semantics for step-filtered trace
  lists (pinned counts now match bucket counts exactly; stepless traces no
  longer leak in), negative-step query support matching ingest, u64-saturating
  token sums, run-wide `total_error_trace_count`, idempotency-dedup and
  status-update smoke coverage.

Gates on the final tree: 20 rust trace tests + clippy + fmt, codegen clean,
420 web tests + tsc, full traces UI smoke, and live verification against a
seeded 30-step/80-trace run plus a genuinely live run observed growing
across poll ticks in Chrome (both themes, keyboard, degraded states).

2026-07-08 (round 2): a second panel (React state, geometry/rendering,
Rust/contract, docs/test coherence) swept the fix-wave commits. 9 further
findings, all fixed: scoped metric-series errors (no misattribution across
run/metric switches), no "first 0 of N" on errored pinned lists, per-run
timeline remount (no resurrected hover), hover dot anchored to the polyline,
cadence-aware error-band contiguity with plot-bounds clamping, dead tooltip
click-guard removed, hover pop as an insertion animation (reduced-motion
honored), doc drift (schema block, validator wording, interaction/data-flow
lines, truncation-under-range wording, README pin wording), and five new
smoke assertions (pinned-count equality, keyboard pin path, refresh
round-trip, distinct-bounds bind-order canary on both endpoints). All gates
re-run green including the full traces UI smoke.

2026-07-08 (round 2, live UI/UX pass): a browser-driven design review
(verdict: ship-after-fixes) surfaced 6 polish items, all fixed and
live-verified: instant restore of the unfiltered list on pin clear (no
skeleton collapse/scroll shift, with min-height damping), labeled token and
duration stats ("avg trace … · N in / M out tok"), a crush-proof panel head
that sheds the step range below 720px, the metric line drawn in the run's
identity color (no collision with ok-marker green, consistent with
Overview/Metrics), Escape unpinning from the marker group, and a spinning
refresh icon while the fetch is in flight (reduced-motion safe).

2026-07-08 (rebase + review-fix integration): PR #344 squash-merged to main;
this branch rebased onto main. The round-3 review fixes for #344 (26 findings:
idempotency Drop guard, ingest rate-limit class, deduped window filters,
timestamp range checks, monotone pagination keys, SDK thread/generator/
batching/redaction/flush fixes, workspace deep links/keyboard/URL filters,
dialect unification) had never been committed, so they ride here as
24b33fbc, conflict-merged with this branch's anchor semantics and panel
structure. Full gate stack green post-integration.

## Progress log

- 2026-07-05: design accepted; branch `codex/trace-metric-correlation` cut
  from the tracing integration branch.
- 2026-07-07: backend slice landed — `GET /api/runs/:run_id/traces/steps`
  (DTOs, argMax-dedup SQL, handler, openapi + generated TS, README/API docs,
  3 store tests). Validated live against a seeded 30-step / 80-trace demo run
  (error cluster steps 18–22 reproduced exactly in bucket aggregates; filters,
  min>max validation, 404 semantics, and route ordering confirmed via curl).
  Review pass: clean except doc drift (round-trip count, run-wide totals),
  fixed.
- 2026-07-07: frontend slice landed — `TraceMetricTimeline` in the run
  workspace Traces tab (metric line + trace activity lane on one step axis,
  full-height danger wash over contiguous error steps, tonal markers,
  panel-head totals, combined tooltip, step-click → filtered recent-traces
  list with clear chip). Design pass done in-browser against the live demo:
  both themes, keyboard/aria (30 focusable markers, aria-pressed round-trip),
  metric switching with on-demand series fetch, list skeletons. 420 web tests
  + typecheck green.
- 2026-07-07 (paused, review findings open): post-commit review of 6dbfebb6
  surfaced 3 confirmed issues to fix before the final pass —
  (1) trace-timeline.tsx:354 overlapping hit-buttons mis-select steps once
  bucket spacing drops under 22px (dense runs; drive click from SVG-level
  nearest-bucket hit-test instead, matching handleMove);
  (2) trace-timeline.tsx:360 hover/tooltip sticks when the pointer exits the
  frame over a marker button (buttons lack onMouseLeave; move handlers to the
  frame container);
  (3) tab-pane.tsx:488/637/705 one-frame stale-run flash: traceSeriesCache is
  keyed by metric key only and traceSteps isn't cleared in the run-reset
  effect (key cache by run, clear traceSteps on run change).
  Non-blocking notes: series cache never refetches for running runs
  (non-headline keys go stale); new tests are source-regex snapshots, not
  behavior. Remaining plan: fix the 3 findings → re-verify live in Chrome →
  extend ui-smoke traces path for the timeline → final multi-angle review
  pass + full E2E walkthrough → (optional) push branch + PR.
- 2026-07-07: smoke + docs coverage added — the `INSTANTML_UI_SMOKE_TRACES_ONLY`
  path now seeds stepped/error/stepless traces plus aligned metric points and
  asserts the timeline (lazy `/traces/steps` fetch, markers, error band,
  run-wide panel-head totals, step-click filter chip + list pinning, clear),
  and the run-detail/traces/tracing docs plus the web README document the
  correlation timeline.
- 2026-07-09 (production rollout + live verification): main (both tracing PRs)
  deployed to the hosted API via `deploy-cloud-run.yml`; trace routes verified
  live. A real SDK run (`examples/agent-rl-tracing`, new) seeded traces with an
  error cluster, metrics, rank metrics, console logs, checkpoints, and a file
  artifact on instantml.ai; every surface verified in the dashboard. Hosted
  testing surfaced and fixed: invalid `eval` trace kind (use `evaluator`),
  artifact byte uploads disabled on hosted (the example falls back to
  metadata-only artifacts — rendered as "REFERENCE ONLY" in the UI), `?runs=`
  deep links opening the newest run instead of the linked run (primaryRunId
  now seeds from the URL), a project-wide "No artifacts yet" claim on a
  run-scoped panel, and duplicate same-named project options. The web
  frontend still needs a Vercel redeploy from post-#354 main for the timeline
  to appear on instantml.ai (production deploys are blocked on Vercel
  authorization for the merge author); the timeline was verified on the
  current build locally against the same seeded data shape.
- 2026-07-09 (artifacts + logging deep verification): a 19-check scripted pass
  against the live stack covered artifact byte upload/download round-trips
  (sha256-equal), versioned artifact collections (manifest, lineage, alias
  handling — `latest`/`vN` are server-reserved and auto-managed), rollout
  metadata artifacts, and console logging (volume, stream isolation,
  multi-line, unicode/HTML-safe rendering, limit/tail pagination, ordering).
  UI verified: Artifacts workspace collection/version/manifest/lineage panels,
  run-detail download vs metadata-only affordances, and the Logs filter. On
  the hosted API the same log/list contracts hold and metadata-only artifact
  downloads 404 cleanly ("artifact bytes not found"). No product defects; the
  only failures were correct server validations (reserved aliases, Free-plan
  project cap).
