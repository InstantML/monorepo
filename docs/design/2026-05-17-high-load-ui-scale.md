# High-Load Dashboard Scale

Date: 2026-05-17

## Status

Approved for narrow implementation after review updates.

## Context

The dashboard is moving from tens or hundreds of runs to hosted Rust/ClickHouse datasets where users need to search, select, and visualize 1,000-2,000 runs without the UI freezing. The current frontend and Rust API still have several safety caps from the first working slice:

- Browser selection is capped at `MAX_SELECTED_RUNS = 500`.
- Rust run listing and batched metric-series validation cap requests at 500 runs.
- Metric chart rendering uses SVG polylines for every series, which becomes expensive around 1,000 lines.
- Compare's detailed side-by-side endpoint is intentionally capped at 50 runs and should remain bounded.

The goal of this slice is to make the common high-load workflow smooth with the hosted Rust live server:

1. Search 1,000-2,000 runs.
2. Select all matching runs up to a documented browser cap.
3. Render compare/workspace metric charts for roughly 1,000 selected runs in a reasonable fashion.
4. Keep detailed Compare diffing honest and bounded.

## Goals

- Raise run search/selection and metric-series API limits to 2,000 runs.
- Keep chart queries bounded by fetching metric series in patches and reducing points per run as selected-run count rises.
- Render dense metric charts with canvas while keeping SVG axes, labels, and lightweight interaction overlays.
- Avoid per-run request fan-out for large selections.
- Preserve the 50-run detailed side-by-side comparison cap until there is a separate virtualized Compare table design.
- Add tests for the new caps, point-budget behavior, chunking, and dense chart decisions.
- Verify the flow against the hosted Rust server and ClickHouse data using load scripts plus Computer Use.

## Non-Goals

- Do not redesign Compare into a full spreadsheet or parallel-coordinates product.
- Do not remove or rewrite the existing side-by-side endpoint.
- Do not fetch full metric history for 1,000+ selected runs.
- Do not introduce a charting dependency in this slice.
- Do not make 2,000-line hover tooltips scan every point on every mousemove.

## Proposed Changes

### API Limits

Update the Rust API validation constants:

- `MAX_RUN_LIMIT`: 500 -> 1,000.
- `MAX_METRIC_SERIES_RUN_IDS`: 500 -> 2,000.
- `MAX_METRIC_SERIES_TOTAL_POINTS`: new server-enforced cap of 120,000 returned metric points per batched metric-series request.

The default run list limit stays 100. Clients must opt into larger pages explicitly. `GET /api/runs/summary` remains a paginated endpoint with `limit` and `offset`; no single run-list page can exceed 1,000 records. The 2,000-run browser selection flow must fetch two 1,000-row pages instead of asking the API for one 2,000-row response.

Bulk selection must use a lightweight `projection=selection` summary mode. That projection returns only run identity and display/filter metadata needed for selection and chart labels, plus empty/default metric/artifact summary fields for frontend compatibility. It does not query ClickHouse metric aggregate rows for every selected run. Normal summary responses remain unchanged for visible table pages.

Metric point limits remain bounded by `MAX_METRIC_LIMIT`, and the batched series endpoint also clamps the effective per-run limit so `run_ids.len() * effective_limit <= MAX_METRIC_SERIES_TOTAL_POINTS`. For example, 2,000 run ids can return at most 60 points per run even if a client requests 5,000. The response should include additive metadata such as `requested_limit`, `effective_limit`, `run_count`, and `total_point_cap` so clients and benchmarks can confirm when clamping happened.

The side-by-side export/compare cap remains 50 runs because that endpoint returns a wide, detailed payload and is not the right shape for 1,000-run visualization.

### Frontend Selection

Update `MAX_SELECTED_RUNS` to 2,000. The Runs rail "select all matching filter" action will page through `GET /api/runs/summary?projection=selection` with `limit=1000` and increasing `offset` until it has selected either all matching runs or 2,000 ids. Saved-view restore will retain up to 2,000 selected run ids.

The UI should keep Compare's detailed note clear: only the first 50 selected runs are sent to the side-by-side endpoint; the larger selection remains available for workspace/metric charts and run summaries.

The dashboard may auto-select the first `DEFAULT_SELECTED_RUNS = 100` most recent runs once during the first successful load so the initial page is useful at hosted scale. The initial Runs page size is also 100, so the default selection comes from the same first summary page rather than an extra per-run fetch. After that, user intent owns the selection state: clearing selection, filtering/searching, selecting 1,000-2,000 matching runs, or restoring a saved view must not be overwritten by the default fallback during summary/detail refreshes. The "select all matching" banner must remain visible for overflowed result sets even when the current selection is empty, because high-load search often starts from zero selected runs.

Run-summary/search requests and bulk-selection page requests retry transient `429`/`5xx`/timeout failures with short bounded backoff before surfacing an error. This keeps the topbar from flashing a global "API issue" when a single Cloud Run or local Next proxy request fails during otherwise healthy high-load filtering.

### Metric Series Fetching

Keep the existing batched `POST /api/metrics/series` path and tune it for larger selections:

- Use adaptive request patch sizes: 100 ids for small selections, 250 ids at 250+ selected runs, 500 ids at 500+ selected runs, and 2,000 ids at 1,500+ selected runs. The top-end 2,000-id patch matches the backend cap and avoids doubling Cloud Run proxy overhead for the heaviest UI case.
- Keep bounded concurrency for multi-metric panel refreshes.
- Adapt per-run point limits by selected-run count:
  - `< 50`: 1,000 points/run.
  - `50-99`: 500 points/run.
  - `100-249`: 250 points/run.
  - `250-399`: 160 points/run.
  - `400-799`: 120 points/run.
  - `800-1,499`: 80 points/run.
  - `1,500+`: 60 points/run.

This keeps a 1,000-run metric around 80,000 points and a 2,000-run metric around 120,000 points before response overhead, which is heavy but bounded enough for ClickHouse and canvas rendering.

The frontend uses adaptive request patches, so small selections still stream in quickly while 1,000-2,000 selected runs avoid issuing dozens of tiny Cloud Run requests per metric. Metric-series calls retry transient `429`/`5xx`/timeout failures with short backoff before surfacing an error, because the localhost Next proxy can otherwise show a stale global API warning during large chart loads even when the Cloud Run service is healthy. The 120,000-point backend cap exists as defense in depth for direct callers, large UI patches, and benchmarks that intentionally exercise a single large request.

Run-summary responses derive top-level `metric_keys` from the same summarized page rows they return. They should not issue a separate ClickHouse key-catalog read for the page because high-load search, filtering, and selection already need the run summary aggregates.

### Dense Chart Rendering

Add a shared dense-chart heuristic:

- Dense mode starts when a chart has more than 120 plotted series or more than 8,000 plotted points.

In dense mode:

- Draw series paths to a single canvas layer.
- Keep SVG axes, gridlines, labels, hover guide, and range controls.
- Avoid rendering per-series SVG polylines or per-point circles.
- Disable or simplify point hover scans for dense charts so mouse movement stays responsive.
- Keep the existing SVG path for sparse charts where direct point hover is useful.

### Compare Behavior

This slice keeps Compare's detailed diff payload bounded at 50 runs. It does not claim that the detailed matrix compares all selected runs. Larger selected sets remain useful for:

- Search/filter result selection.
- Summary counts.
- Metric/workspace charts.
- Quick chart-driven comparisons.

If users need a 1,000-run detailed Compare table, that should get a separate design for virtualization, server-side aggregation, and column pinning.

## Performance Expectations

- Selecting 1,000 matching runs should not create one request per run.
- Selecting 2,000 matching runs should keep the browser responsive enough to continue searching, scrolling, and changing tabs.
- A 1,000-run chart should render in dense canvas mode without thousands of SVG line nodes.
- A 2,000-run chart may lower per-run point density but should not lock up the page.
- Hosted API benchmarking should show successful 1,000-run and 2,000-run batched metric-series requests after deployment.

Acceptance budgets for this slice:

- Hosted run-summary pages: 1,000-row pages return p95 under 2.5s during the benchmark, with summaries only and no full metric history.
- Hosted selection projection: two 1,000-row `projection=selection` pages should return enough run labels for 2,000 selected ids without fetching ClickHouse metric aggregates for every run.
- Hosted chunked metric series: the UI-shaped adaptive chunks return p95 under 2.5s per chunk for 60-120 points/run.
- Hosted single large metric series: a direct 2,000-run request succeeds with `effective_limit <= 60`, `total_point_cap = 120000`, and p95 under 8s for benchmark samples.
- Hosted benchmark defaults: `npm run benchmark:cloud-run` should exercise the current dashboard shape by default: 100 selected runs on fresh load, 1,000 selected `seed-13` search results, and a 2,000-run max selection. This keeps the benchmark representative without requiring a caller to remember override flags.
- Browser selection: selecting 2,000 matching runs completes without a framework error overlay and keeps input/search controls usable afterward.
- Browser chart render: a 1,000-run line chart enters dense canvas mode, exposes axes, and renders with fewer than 50 SVG `.series` nodes.
- Browser responsiveness: after chart data lands, tab switches and search input updates should respond within roughly one second in Computer Use checks.
- Rust memory/ClickHouse safety: no Cloud Run 503/timeout for the benchmarked 1,000/2,000-run cases; any observed 5xx blocks completion.

## Failure Modes

- Large result sets may still be slow if the selected metric is absent from many runs; the UI should keep partial patch rendering and missing-series counts visible.
- Canvas charts trade off inspectable SVG nodes and per-point hover in exchange for responsiveness.
- The backend may need ClickHouse tuning if 2,000-run batched metric queries are slow on real hosted data; this design intentionally keeps requests bounded first.
- Compare users may expect all 2,000 selected runs in the detailed matrix. The existing cap note must remain visible.

## Testing Plan

- Unit tests:
  - Selection helpers enforce 2,000-run cap.
  - `adaptiveMetricSeriesLimit` returns the new high-load point budgets.
  - Run-id chunking defaults to 100 ids, then scales to 250, 500, and 2,000 ids for larger selections.
  - Dense chart heuristic switches at the intended series/point thresholds.
  - Rust batched metric-series limit clamps to the server-side total point cap.
- Build/tests:
  - `npm run test:node` from `apps/web`.
  - `npm run web:build` from the repo root.
  - Relevant Rust tests or at minimum `cargo test` for `apps/rust-server`.
- Hosted verification:
  - Seed or confirm hosted scale data.
  - Run hosted Cloud Run benchmark cases for 1,000 and 2,000 selected runs.
  - Start local Next app pointed at hosted Rust/control/data API.
  - Use Computer Use to log in if needed, search/select 1,000-2,000 runs, open charts/Compare, and inspect responsiveness.
  - Spawn zero-context frontend QA agents to independently exercise high-load search/selection/chart flows with Computer Use and report findings.

## Rollout

1. Land frontend/API cap and rendering changes.
2. Deploy Rust backend because API validation limits changed.
3. Verify hosted benchmark at 1,000 and 2,000 run selections.
4. Verify browser behavior against the hosted Rust live server.

## Review Notes

- Reviewer A: rejected the first draft until backend response bounds and measurable hosted acceptance budgets were added.
- Update: added `MAX_METRIC_SERIES_TOTAL_POINTS`, changed run selection to use paginated 1,000-row summary pages rather than one 2,000-row page, and added concrete hosted/API/browser pass-fail budgets.
- Reviewer A re-review: approved the narrow slice after the server point cap and paginated selection updates.
- Reviewer B re-review: approved the narrow slice after the same updates; suggested recording response byte size later as a non-blocking follow-up.
