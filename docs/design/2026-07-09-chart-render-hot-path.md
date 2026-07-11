# Design: Chart Render Hot-Path Optimization

Date: 2026-07-09

Status: Accepted after review and browser amendment

Owner: Codex

## Summary

The dashboard's bounded API and dense-canvas path already scaled to 2,000
selected runs, but the baseline client repeated expensive CPU and allocation
work before the chart was painted. `MetricChart` normalized every series twice
on the default, unzoomed render because it independently prepared the main plot
and range overview even though both inputs were identical. It also eagerly
built the hidden summary-table model twice, and hover hit-testing linearly
scanned every point on every animation frame.

This slice keeps the current UI, API, canvas/SVG split, and point limits. It
removes duplicate render work, computes summary data only when the user opens
the summary view, and uses the monotonic chart x-coordinate to bound hover work.
The change stays inside the web chart component and shared chart helpers.

## Goals

- Cut default unzoomed chart normalization from two full passes to one.
- Avoid summary-table scans and sorts while the chart view is active, and build
  the summary rows only once when the table is opened.
- Replace whole-series hover scans with binary-search-bounded candidate scans
  while preserving point and line-segment hit behavior.
- Record repeatable CPU and heap measurements at 100, 1,000, and 2,000 series.

## Non-Goals

- No API, storage, query, downsampling, chart-style, or selection-limit change.
- No new dependency, worker, WebGL renderer, or chart library.
- No virtualization work outside metric charts.
- No change to the current React state contract for tooltip visibility or
  cross-highlighting; this slice reduces the work performed by those renders.

## Users and Use Cases

Researchers compare 100-2,000 bounded run series in the Runs and Metrics
workspaces. They need initial chart paint, resize, zoom, and pointer interaction
to remain responsive without retaining duplicate normalized outputs as
selection size grows.

## Proposed Design

### Reuse the main normalization when the range is identical

`MetricChart` will compute `normalizedSeries` once. `rangeNormalizedSeries`
will alias it while no zoom window is active. When zoomed, the mini overview
will normalize only the five series it actually draws, while a separate
`chartDomain()` pass over the full unzoomed series preserves the correct x/y
domain. This avoids building normalized point objects and path strings for
1,995 invisible overview series. Both the full-domain scan and five-series
normalization are guarded by `showRange && zoomRange`, so charts without a
range overview pay neither cost.

`MiniRange` will receive the main chart's full-list-derived style indexes and
`useLineStyles` decision as explicit props. Its first five overview lines keep
the same color and dash identity they have today even though only their point
sequences are normalized for the overview.

### Lazily build one summary model

Add a shared `chartSummaryModel()` helper returning `{ rows, takeaway }`.
`chartSummaryRows()` and `chartSummaryTakeaway()` remain compatible and share
the model's row/takeaway builders without recomputing inside `MetricChart`.
`MetricChart` invokes the model only while `chartView === "summary"`; normal
chart renders and hover updates do not scan or sort summary rows.

### Bound hover work by x

`normalizeSeries()` will record whether each normalized point array is
monotonic by x while it already loops over the points. The hint is true only
when every `x` and `xValue` is finite and both sequences are numerically
nondecreasing, including equality. `NaN`, infinities, or a decreasing value
force the safe linear path. For explicitly monotonic arrays:

- `nearestPoint()` binary-searches the first/last points within
  `pointerX ± maxDistance` and checks only that window plus one neighboring
  segment on each side.
- Tooltip row lookup binary-searches the point nearest to the hovered x-value
  instead of reducing over every point in every series.

An unmarked or non-monotonic array keeps the existing linear fallback. This
preserves correctness for direct helper callers and malformed/custom series
without sorting or copying their points.

Compatibility includes exact legacy tie behavior:

- `nearestPoint()` keeps the first encountered series/candidate on equal
  distance because replacement remains strict (`distance < best.distance`).
- Point checks remain before their following segment checks.
- A segment with `t <= 0.5` reports its earlier endpoint; `t > 0.5` reports its
  later endpoint.
- Nearest-x tooltip lookup keeps the earlier array entry on a midpoint tie and
  the first entry in a duplicate-x group.

The indexed implementation must pass exact-result equivalence tests against a
frozen copy of the old linear algorithms before the hover phase is accepted.

### Benchmark harness

Add a deterministic Node benchmark that creates the same bounded shapes used by
the high-load UI design: 100×250, 1,000×80, and 2,000×60 points. It reports:

- legacy-equivalent double normalization versus the single-pass render path;
- retained heap delta with `--expose-gc`;
- indexed `nearestPoint()` versus a local brute-force reference;
- lazy single summary-model cost.

The helper harness is a developer benchmark, not a CI timing gate. It retains
a frozen copy of the old normalization and hover implementations so it can
compare:

- legacy single normalization versus new single normalization;
- legacy duplicate normalization versus unzoomed reuse;
- legacy zoomed all-series normalization versus the amended all-series
  `chartDomain()` plus five-series overview normalization;
- brute-force versus indexed hit-testing;
- brute-force versus indexed tooltip-row lookup and ranking;
- the combined pointer pipeline across center, edge, gap, hit, and miss queries.

Fixtures cover sorted step data and time-mode data. Smoothed, log-scale, and
zoomed shapes get a smaller no-regression sample. The full matrix would make
routine local runs too slow, so the 100/1,000/2,000 primary cases remain sorted
step data.

### Require a real React/browser fixture

Add a test-only Next fixture outside the product route tree. It imports the real
`MetricChart`, renders deterministic 2,000×60 data with no API or ClickHouse,
and exposes browser performance marks for first committed paint and
pointer-to-tooltip latency. Playwright verifies dense canvas rendering, hover,
range zoom/reset, and chart/summary switching. It records timings without using
machine-sensitive timing assertions in the general unit suite; the dedicated
benchmark command enforces local acceptance budgets.

The browser fixture does not claim that mounting the 2,000-row summary table is
fast. Summary-table pagination or virtualization is a separate UI design; this
slice verifies the switch functionally and reports its observed cost.

## Component Impact

Backend:

- None.

Frontend:

- `apps/web/src/charts.js`: summary-model and indexed hover helpers.
- `apps/web/app/dashboard/metrics/metric-chart.tsx`: reuse normalization,
  lazy summary computation, and indexed tooltip lookup.
- Web tests cover correctness and component wiring.

Python SDK:

- None.

Storage:

- None.

Docs:

- Update the web README, benchmark README, and design index with the measured
  chart hot-path behavior and command.

## Data Model

No persisted data changes. Normalized in-memory series gain one boolean hint,
`xMonotonic`, computed during the existing normalization loop.

## API Contracts

No HTTP or public SDK changes. Existing `normalizeSeries()`, `nearestPoint()`,
and `chartSummaryTakeaway()` callers remain compatible. The new summary and
nearest-x helpers are additive frontend module exports.

## Performance Considerations

Expected client shape is bounded at 120,000 returned points for a 2,000-run
series request. An ad hoc Node 22 baseline on the current branch measured:

| Shape | Duplicate normalization | Retained Node heap delta | One hover hit-test | Eager summary pair |
| --- | ---: | ---: | ---: | ---: |
| 100 × 250 (25k points) | 24.9 ms | 14.9 MB | 1.26 ms | 3.67 ms |
| 1,000 × 80 (80k points) | 115.5 ms | 27.0 MB | 3.96 ms | 9.50 ms |
| 2,000 × 60 (120k points) | 168.1 ms | 37.2 MB | 6.06 ms | 15.53 ms |

The measurement used 12 samples with explicit GC on Node 22 on an Apple M1.
Fixtures were created before measurement; both duplicate outputs stayed live
through the second heap snapshot. Values are local-development medians, not
browser SLOs or total allocation-volume measurements. The committed harness
will record the exact Node/OS/hardware/commit, width/height, warmups, samples,
and fixture fields; clear live references between cases; and alternate paired
legacy/new case order to reduce GC and thermal bias.

Accepted helper targets on the same machine are:

- at least 35% less default normalization wall time and retained Node heap at
  2,000×60 (one pass replaces two, with fixed setup overhead remaining);
- new single normalization no more than 10% slower than the frozen legacy
  single pass for `showRange=false`-equivalent, step, time, smoothing, log, and
  zoom fixtures;
- at least 5× faster hit-testing and at least 3× faster combined
  hit-test-plus-tooltip-row construction at 2,000×60;
- zero summary-model work in the default chart view;
- no more than 10% helper-time regression at the 100-series shape;
- the zoomed 2,000×60 path compares legacy all-series normalization with the
  amended all-series `chartDomain()` plus five-series normalization and must
  remove the observed browser long task without regressing its domain/style
  semantics.

Dedicated production-browser fixture budgets on the benchmark machine are:

- 2,000×60 first committed chart paint under 500 ms, measured from the fixture's
  pre-`createRoot().render()` mark to its post-commit `requestAnimationFrame`;
- pointer move to visible tooltip p95 under 100 ms over deterministic hit/miss
  positions;
- zoom/reset completes without a stale tooltip or a `PerformanceObserver`
  long-task entry over the browser-standard 50 ms threshold;
- the summary switch is functionally correct and its observed time is reported,
  not gated.

The first real-browser run after the original review measured 205.8 ms first
paint, 68.0 ms hover p95, and a 63 ms zoom/reset long task at 2,000×60. The
first two budgets passed. Inspection confirmed the zoom task came from the
second all-series normalization even though `MiniRange` slices to five series.
The amended range design above is required before the browser checkpoint can
pass; its result will be recorded separately from this pre-amendment evidence.

Time complexity changes from two O(points) normalization passes to one on the
default path, from O(total points) to O(series × log(points per series) + local
candidates) for normal hover hit-testing, and from two
O(total points + Σ(points-per-series log points-per-series) + series log series)
summary passes on every normalized-data change to one pass only when the
summary view is opened. The per-series summary sort remains in this slice for
compatibility; using the monotonic hint to remove it is deferred until separately
measured.

## Simplicity Review

The smallest useful fix reuses arrays already computed and adds two ordinary
binary searches. It does not add cache invalidation, mutable spatial indexes,
workers, or a new rendering abstraction. The linear fallback keeps helper
behavior safe when x ordering is unknown.

Implementation has two acceptance checkpoints. Array reuse plus lazy summary
modeling land first. Indexed hover lands only after exact linear-equivalence and
combined pointer-pipeline benchmarks pass. This keeps the riskier algorithmic
change removable without losing the low-risk render win.

Deferred: moving tooltip DOM updates fully outside React, lazily constructing
SVG path strings for dense-canvas charts, replacing the remaining flattened
extent arrays in normalization, and summary-table pagination/virtualization.
Those changes need
separate measurement after this slice removes the obvious duplicate work.

## Failure Modes

- Unsorted or non-finite custom points could return the wrong hover result if
  treated as sorted. Mitigation: both pixel x and source x-value must be finite
  and nondecreasing, and the helper uses the indexed path only when the hint is
  explicitly true.
- A long line segment can cross the pointer window with both endpoints outside
  it. Mitigation: candidate selection includes the point immediately before and
  after the x window, covering both boundary-crossing segments.
- Duplicate or tightly clustered x coordinates can create a large local
  candidate window. The result remains correct and degrades toward the old
  linear cost only for that series' local cluster.
- Lazy summary computation could briefly show stale rows after switching views.
  React memo dependencies include `chartView`, `normalizedSeries`, and
  `metricKey`, so the model is rebuilt from the committed input before render.
- Opening the 2,000-row summary mounts roughly 18,000 cells and may remain slow.
  The UI stays correct; pagination/virtualization is explicitly deferred and
  the browser benchmark reports the residual cost without claiming it is fixed.
- The zoom overview could use the wrong scale if its five visible series supply
  the domain. Mitigation: compute the unzoomed domain across every bounded
  series and pass that domain to `MiniRange`; use the five-series normalization
  only to supply the overview point sequences.
- The overview's first five lines could change color/dash identity if style
  assignment sees only five inputs. Mitigation: pass the main full-list style
  indexes and line-style decision into `MiniRange` instead of recomputing them
  from the sliced input.

## Testing Plan

- Unit tests compare indexed `nearestPoint()` and nearest-x tooltip lookup with
  frozen brute-force references over deterministic monotonic series. Cases
  include empty/one-point arrays, long boundary-crossing segments, dense
  clusters, duplicate x values, smoothed display y-values, cross-series and
  point/segment ties, `t === 0.5`, boundary equality, hits, and misses.
- Unit tests prove non-monotonic and mixed finite/`NaN`/infinite inputs take a
  correct linear fallback. Non-positive or non-finite `maxDistance` behavior is
  locked to the legacy result.
- Unit tests cover nearest-x tie behavior and a single-pass summary model.
- Component source tests lock the no-zoom normalization reuse and lazy summary
  wiring, matching the existing lightweight frontend test style.
- Component tests lock zoom overview normalization to the same five-series cap
  already used by `MiniRange`, with `chartDomain()` retaining the all-series
  unzoomed scale.
- Tests prove an x/y outlier after the first five series still changes the mini
  overview domain in step, time, log, and manual-range modes. A selection larger
  than the palette, including a preferred-slot collision, must keep the same
  first-five color/dash indexes as the main chart.
- Run `npm run test:node`, `npm run web:build`, and the new chart benchmark.
- Run the required test-only React/Playwright high-load fixture with no backend
  dependency and record the production-browser timings.
- Run the focused chart visual harness and normal web build.

## Documentation Plan

- Add this design to `docs/design/README.md`.
- Document the chart benchmark command and result in `benchmarks/README.md` and
  a dated results file.
- Update `apps/web/README.md` chart performance notes.

## Alternatives Considered

Build a quadtree or R-tree for hover:

- Rejected for this slice. Chart x values are already ordered, so binary search
  gives the needed bound with no persistent index or invalidation rules.

Move all chart work to a Web Worker:

- Rejected. Serialization and ownership complexity are unjustified while the
  current path performs obvious duplicate synchronous work.

Disable hover for dense charts:

- Rejected. Dense-chart hover is an accepted user workflow and current tests
  explicitly preserve it.

Memoize the second normalization separately:

- Rejected. When unzoomed it is the same value, so aliasing the first result is
  simpler and uses less memory.

## Review Notes

Fresh correctness reviewer:

- Finding: Non-finite x-values could incorrectly retain the monotonic hint;
  exact tie compatibility and full pointer-pipeline/browser coverage were not
  specified. Summary complexity was understated.
- Risk: Indexed hover could miss valid points or subtly change which run/point
  wins, while helper-only timings could overstate the user-visible improvement.
- Recommended edit: Require finite/nondecreasing coordinates, frozen-reference
  equivalence including ties and malformed inputs, combined hover benchmarks,
  required browser coverage, and accurate complexity.
- Decision: Approved after revision; no remaining blockers.

Fresh performance reviewer:

- Finding: Relative helper targets did not prove browser responsiveness; heap
  terminology/method was inconsistent; the benchmark omitted single-pass and
  zoom no-regression cases; summary-table DOM cost remained unbounded.
- Risk: A favorable double-versus-single result could mask regressions in other
  chart callers and imply broader browser/summary performance than measured.
- Recommended edit: Add frozen legacy comparisons, precise retained-heap
  method, absolute browser fixture budgets, zoom reporting, exact monotonic
  contract, and an explicit residual summary-table risk.
- Decision: Approved after revision; no remaining blockers.

Post-review browser amendment:

- Finding: The required 2,000×60 browser fixture passed paint and hover budgets
  but recorded a 63 ms zoom/reset long task.
- Risk: The accepted implementation would still miss its explicit zoom budget.
- Recommended edit: Preserve the all-series unzoomed domain with
  `chartDomain()`, but normalize only the five overview series `MiniRange`
  renders.
- Follow-up finding: Slicing the input before `MiniRange` computes styles can
  change first-five colors/dashes; the full-domain scan must also stay gated on
  `showRange && zoomRange`, and benchmark text must describe the amended path.
- Recommended follow-up edit: Pass full-list style metadata separately, add the
  range/zoom guard, and cover later-series domain outliers plus palette
  collisions.
- Decision: Approved after final revision by both reviewers.

## Coverage Exceptions

None planned. Timing assertions remain outside CI because shared-runner timing
is noisy; correctness and wiring stay in deterministic tests.

## Implementation Benchmark Results

The committed local result is
`benchmarks/2026-07-10-chart-render-hot-path-results.md`. On an Apple M1 at the
2,000×60 bounded chart shape:

- default unzoomed normalization improved from 119.65 ms to 60.40 ms (1.98×),
  while retained normalized output fell from 67.90 MB to 33.95 MB;
- exact legacy-compatible hit testing improved 6.66× and the combined
  hit-test-plus-tooltip pipeline improved 4.52×;
- lazy summary modeling reduced opened-summary helper work from 13.79 ms to
  7.12 ms and removed it entirely from the normal chart view;
- zoom overview preparation improved from 63.38 ms to 8.99 ms (7.05×).

The backend-independent real Chromium fixture measured 208.6 ms first
committed paint, 71.54 ms pointer-to-tooltip p95, one dense canvas, zero SVG
series nodes, zero zoom/reset long tasks over 50 ms, all 2,000 summary rows,
and no console/page errors.

## Decision

Implemented after two fresh review passes, re-review, and final approval of the
browser-measured zoom amendment. The shipped slice includes both original
checkpoints plus the all-series-domain/five-series-overview zoom fix with
full-list style metadata preserved.
