# Chart Render Hot-Path Benchmark Results

Date: 2026-07-10

## Context

- Branch: `codex/performance-scalability`
- Base commit: `5fc2b877653405b2ba9f0467a3411247e6ca0ae7`
- Working tree dirty at measurement time: `true` (the benchmarked optimization)
- Node: `v21.7.1`
- Browser: Chromium `147.0.7727.15`
- Platform: macOS arm64 `24.6.0`, Apple M1
- Chart frame: 900 × 360 CSS pixels, 28 px padding
- Helper samples: 9 measured, 2 warmups, paired/alternating legacy and optimized order

These are local CPU, retained-heap, and browser-interaction measurements, not
hosted API or customer-device SLOs.

## Commands

```bash
npm run benchmark:charts
npm run benchmark:charts:browser
```

## Helper Results

The legacy default-render case normalizes the same unzoomed series twice. The
optimized case reuses one normalized result. Retained heap is measured after GC
while the returned normalized outputs remain live.

| Shape | Legacy duplicate normalize | Optimized reused normalize | Speedup | Legacy retained heap | Optimized retained heap |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 × 250 (25k points) | 22.55 ms | 11.24 ms | 2.01× | 14.11 MB | 7.05 MB |
| 1,000 × 80 (80k points) | 80.46 ms | 44.17 ms | 1.82× | 45.23 MB | 22.62 MB |
| 2,000 × 60 (120k points) | 119.65 ms | 60.40 ms | 1.98× | 67.90 MB | 33.95 MB |

Pointer measurements run 20 deterministic hit/miss positions per sample and
include exact legacy-compatible line-segment hit testing. The combined case
also builds and ranks tooltip rows.

| Shape | Hit-test speedup | Combined hover legacy | Combined hover optimized | Combined speedup |
| --- | ---: | ---: | ---: | ---: |
| 100 × 250 | 16.88× | 24.26 ms | 1.79 ms | 13.55× |
| 1,000 × 80 | 8.47× | 86.23 ms | 12.81 ms | 6.73× |
| 2,000 × 60 | 6.66× | 126.71 ms | 28.02 ms | 4.52× |

At 2,000×60, replacing the eager duplicate summary calculation with one lazy
summary model reduced helper time from 13.79 ms to 7.12 ms when the summary is
actually opened. The normal chart view now performs no summary-model work.

The added monotonicity bookkeeping did not materially regress one-pass
normalization: the 2,000×60 ratio was `1.010`, while time, smoothing, log, and
zoomed-main variants stayed between `0.926×` and `1.015×` of the frozen legacy
reference. The amended zoom overview—full all-series domain plus normalization
of the five rendered preview series—fell from 63.38 ms to 8.99 ms, a 7.05×
speedup.

## Real React/Browser Result

The browser harness bundles the real `MetricChart`, renders 2,000 runs × 60
points without an API/backend, and exercises dense canvas paint, hover, range
zoom/reset, and the summary-table switch.

| Measurement | Result | Budget |
| --- | ---: | ---: |
| First committed paint | 208.6 ms | < 500 ms |
| Pointer-to-tooltip p95 | 71.54 ms | < 100 ms |
| Dense canvas layers | 1 | 1 |
| SVG series nodes | 0 | < 50 |
| Zoom/reset long tasks > 50 ms | 0 | 0 |
| 2,000-row summary switch | 236.16 ms | reported, not gated |
| Console/page errors | 0 | 0 |

Before the five-series overview amendment, the same fixture recorded a 63 ms
zoom/reset long task. The final path preserves the all-series domain and
full-list color/dash assignments while removing that long task.

## Interpretation

- Default chart work now scales with one normalization output instead of two,
  halving the dominant retained normalized-series memory.
- Hover candidate work is bounded by binary search over monotonic x-values,
  with exact linear fallback for malformed or unsorted inputs.
- Hidden summary tables no longer consume render CPU during normal chart use.
- Zoom retains the correct global overview domain but prepares point sequences
  only for the five lines the mini overview renders.

All design gates in `docs/design/2026-07-09-chart-render-hot-path.md` passed.

## Same-Day Follow-Up Pass

A second optimization pass on the same machine (flatten-free domain extents,
two-phase tooltip rows that defer Intl formatting to the sliced top rows,
zoom-gesture-invariant overview/domain memos, identity-keyed style indexes,
and lean monotonic-aware summary points) moved the 2,000 × 60 helper numbers
to:

- single normalization 0.98× of the frozen legacy pass (the monotonic
  bookkeeping is now paid for by the removed flatten);
- combined hover 5.20× over legacy (was 4.52×);
- lazy summary model 2.66 ms (was 7.12 ms);
- zoom overview preparation 1.03 ms (was 8.99 ms), 48× over legacy.

The browser fixture measured 192.1 ms first committed paint (was 208.6 ms),
68.9 ms pointer-to-tooltip p95, 197.2 ms summary switch (was 236.2 ms), zero
zoom/reset long tasks, and zero console errors. The re-zoom domain/overview
reuse is not visible in this fixture (it times a single zoom gesture); its
effect is on subsequent zoom selections, which no longer re-scan the full
series for an identical domain.

## 2026-07-11 Second Follow-Up Pass

A third pass (lazy polyline strings, fixed-shape normalized points, and a
fused count/x/y domain-stats pass) moved the 2,000 × 60 helper numbers to:

- single normalization 0.10× of the frozen legacy pass for dense charts —
  the canvas renderer strokes numeric points, so the polyline strings the
  legacy path built eagerly are now never constructed on that path (sparse
  SVG charts and exports build them lazily on first read, so their cost moves
  to first paint of those charts rather than disappearing);
- retained normalized output 20.78 MB (was 33.95 MB after reuse) for the same
  reason — dense-chart outputs never hold path strings;
- combined hover 5.28×; hit-test 7.78×; lazy summary model 2.56 ms;
- zoom overview preparation 0.65 ms.

The browser fixture measured 115.9 ms first committed paint (208.6 ms at the
original submission), 65.0 ms pointer-to-tooltip p95, 186.8 ms summary switch,
zero zoom/reset long tasks, and zero console errors.
