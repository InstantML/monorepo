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
  stepless_trace_count,   // traces with no step anywhere
  total_trace_count,
  truncated,              // true when distinct steps exceeded the cap
}
```

Bounds: `ORDER BY step ASC LIMIT 2001` (`MAX_TRACE_STEP_BUCKETS = 2000`,
truncation detected via limit+1; when truncated the lowest 2000 steps are
kept), optional `min_step`/`max_step` params reuse the existing validators.
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
  clear-filter chip appears. Markers are real `<button>`s with
  `aria-pressed`, focus-visible ring, and keyboard operability.
- **Degraded states**: no metric points → activity lane renders alone on the
  trace step domain with an explanatory caption; no stepped traces → metric
  chart renders alone plus a "N traces have no step" note; neither → existing
  empty state. Loading uses the shared skeleton primitives.

### Data flow

```
DetailTabPane (traces tab active)
 ├─ GET /api/runs/:id/traces/steps      → step buckets (new, 1 query)
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
