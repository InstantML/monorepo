# Design: M4 Chart Aggregation

Date: 2026-05-18

Status: Accepted

Owner: Agent (feat/m4-chart-aggregation)

## Summary

The current batched-series chart endpoint (`POST /api/metrics/series`) fetches
raw metric points with a naive `LIMIT ? BY run_id` prefix cut. For long runs
(Arjun's 200k-point series is the canonical example), the prefix cut silently
returns only the first N steps rather than a shape-representative sample of the
full series. The rendered chart is therefore wrong: loss spikes near epoch 180k
are invisible even though the data exists.

M4 (Jugel et al., 2014) fixes this by dividing the step axis into W
equal-width buckets and keeping exactly four points per bucket: the
smallest-step point (first), the largest-step point (last), the
smallest-value point (min), and the largest-value point (max). The resulting
4W-point polyline is pixel-for-pixel identical to the full N-point polyline
for any chart W pixels wide. The algorithm is provably lossless for rendering.

This design adds optional M4 downsampling to the existing
`POST /api/metrics/series` endpoint via a new `buckets` body field. No new
endpoint is needed; the existing response shape is preserved. When `buckets` is
absent the behavior is unchanged.

## Goals

- Fix the rendering bug where prefix-cut series miss value extremes and spikes.
- Keep chart loads sub-100 ms p95 on a 200k-point series with a local
  ClickHouse.
- Preserve the existing request/response contract so no frontend change is
  required beyond passing `buckets`.
- Keep org_id scoping and all auth/permission rules unmodified.

## Non-Goals

- Zoom-to-window queries (sending step bounds in addition to buckets). That is
  a follow-up; the current design covers the full-series case.
- M4 across multiple runs in compare view as a single ClickHouse query. The
  per-run loop already parallelises across runs implicitly via `IN ?` binding.
- Client-side downsampling fallback.
- Changing the materialized view or adding new ClickHouse tables.

## Users and Use Cases

Researcher viewing the loss curve for a 200k-step run in the single-run chart
panel. Currently they see only steps 0..1000 (the prefix limit). With M4 and
`buckets=1000` they see a shape-preserving sample of all 200k steps including
the loss spike at step 180k.

## Proposed Design

### API contract

`POST /api/metrics/series` accepts one new optional body field:

```
buckets?: integer   1..4096, default absent (no M4)
```

- If `buckets` is absent or 0: existing behaviour (raw prefix-limited points).
- If `buckets > 0` and the total point count for the first requested run on the
  key exceeds `4 * buckets`: run the M4 ClickHouse query.
- Otherwise: fall through to raw points (series is already small).

The response shape is unchanged:

```json
{
  "series": [
    { "run_id": "...", "metrics": [{"key": "...", "step": 0.0, "value": 0.0, "created_at": "..."}, ...] }
  ]
}
```

Points in each per-run `metrics` array are sorted by `step` ascending (same as
today). When M4 is applied, up to 4 points per bucket are emitted, deduped by
step within each bucket, then concatenated in bucket order.

### ClickHouse query shape

```sql
WITH
  bounds AS (
    SELECT min(step) AS lo, max(step) AS hi
    FROM metric_points
    WHERE org_id = {org} AND run_id = {run} AND key = {key}
  )
SELECT
  toUInt32(
    if(bounds.hi = bounds.lo,
       0,
       floor((step - bounds.lo) * {W} / (bounds.hi - bounds.lo + 1)))
  ) AS bucket,
  argMin(step, step)   AS first_step,  argMin(value, step)  AS first_val,
  argMax(step, step)   AS last_step,   argMax(value, step)  AS last_val,
  argMin(step, value)  AS min_step,    min(value)           AS min_val,
  argMax(step, value)  AS max_step,    max(value)           AS max_val
FROM metric_points, bounds
WHERE org_id = {org} AND run_id = {run} AND key = {key}
GROUP BY bucket
ORDER BY bucket
```

Note: `floor(...)` cast to `UInt32` keeps the bucket index non-negative and
avoids floating-point modulo surprises. The `+1` in the divisor prevents the
`step = hi` boundary from overflowing into bucket W.

Rust emits the four (step, value) pairs for each bucket, sorts them by step
within the bucket, dedupes step-exact duplicates, and appends to the output
vector. The final array is already ordered because buckets come out of
ClickHouse sorted.

### Count check

Before the M4 query the handler reads the per-run count from the
`metric_series` aggregate table (zero extra I/O against `metric_points`):

```sql
SELECT toUInt64(countMerge(count)) AS n
FROM metric_series
WHERE org_id = ? AND run_id = ? AND key = ?
GROUP BY run_id, key
```

If `n <= 4 * buckets` the handler falls through to the existing raw-point path.
This avoids the overhead of the M4 CTE for small series.

### Multi-run handling

`metrics_series_batched` already iterates over `run_ids`. Each run is checked
independently: a run with 100 points uses raw mode even in the same request as
a 200k-point run that uses M4. This keeps the query per run simple and avoids
a cross-run GROUP BY that would complicate the CTE.

## Component Impact

Backend:
- `src/metric_store.rs`: add `query_points_m4` and `count_points_for_run_key`.
- `src/store/runs.rs`: update `metrics_series_batched` to read the new `buckets`
  field, check counts, and fan out to `query_points_m4` or existing
  `query_points_for_runs`.
- `src/http/handlers.rs`: add `buckets` to `MetricsSeriesRequest`.

Frontend:
- `apps/web/app/dashboard/dashboard-shell.tsx`: pass
  `buckets: METRIC_SERIES_BATCH_LIMIT` (1000) in the fetch payload. No visual
  change expected.

Python SDK:
- No change needed; the SDK does not consume the chart endpoint.

Storage:
- No schema changes. M4 reads only `metric_points` and `metric_series`.

Docs:
- `apps/rust-server/README.md`: document the new `buckets` parameter.
- `docs/architecture/current-api.md`: update the series endpoint description.

## Data Model

No new tables or columns. The `metric_points` sort key
`(org_id, run_id, key, step)` is exactly the order M4 needs for efficient
scans per bucket.

## API Contracts

### POST /api/metrics/series

Request body (existing fields unchanged):
```json
{
  "key": "train/loss",
  "run_ids": ["uuid1", "uuid2"],
  "limit": 1000,
  "start_step": 0.0,
  "end_step": null,
  "buckets": 1000
}
```

New field: `buckets` — optional `u32`, 1..4096. When absent: existing
prefix-limit behaviour (unchanged). When present and the series is large:
M4 downsampled response.

Response shape unchanged.

## Performance Considerations

- Expected rows for 200k-point series with `buckets=1000`: ClickHouse scans
  all 200k rows once and returns 1000 aggregate groups, each with 8 numbers.
  Wire transfer is O(1000) not O(200k).
- ClickHouse sort key `(org_id, run_id, key, step)` means the M4 scan is a
  single contiguous range read. The GROUP BY on `bucket` is a hash agg over
  1000 buckets — trivially cheap.
- Count check hits `metric_series` (AggregatingMergeTree), a single key lookup,
  typically sub-millisecond.
- Expected p95 locally: < 100 ms for 200k points at buckets=1000. Raw prefix
  path at 1000 points: < 10 ms (unchanged).
- Memory: 200k Float64 rows ≈ 1.6 MB in-core; the aggregate is 1000 × 8 ×
  8 bytes = 64 KB.

## Simplicity Review

The simplest version: extend the existing endpoint, add one optional body
field, add one ClickHouse query method, add the Rust struct for the M4 result
row, and emit the deduped four-point array. No new routes, no new tables, no
new abstractions. The count-check short-circuit avoids complexity for the
common small-series case.

Deferred: zoom-to-window (client sends step range with buckets), streaming
response for very large bucket counts, M4 across multiple runs in one query.

## Failure Modes

- ClickHouse unavailable: returns `warehouse_unavailable` 503 (same as today).
- Series with 0 points: count check returns 0, falls through to raw path which
  returns an empty metrics array.
- Series with 1 point: count check returns 1, falls through to raw path which
  returns the single point.
- Series with fewer points than `4 * buckets`: falls through to raw path.
- All values equal in a bucket: `min_step` and `max_step` collapse to the same
  step as `first_step` or `last_step`; deduplication drops the duplicates,
  leaving at most 2 distinct step values per bucket. Correct.
- `step = hi` boundary: `floor(.../ (hi - lo + 1))` maps the last point to
  bucket W-1, not bucket W. Correct.
- `hi = lo` (all steps identical): the `if` guard sets every bucket to 0.
  All points collapse to bucket 0 and dedup to first/last/min/max. Correct.

## Testing Plan

Unit tests (no ClickHouse needed, pure Rust logic):
1. `m4_bucket_points_deduplicates_coincident_extremes`: construct a
   `BucketRow` where first_step == min_step; assert the output has 3 points
   not 4.
2. `m4_bucket_points_all_distinct`: all four extremes are different; assert
   output has 4 points sorted by step.
3. `m4_bucket_points_single_point`: first==last==min==max; assert 1 output
   point.
4. `metrics_series_m4_uses_raw_path_for_small_series`: call with
   `count <= 4 * buckets`; assert the returned metrics array matches the raw
   points, not an M4 result.
5. `metrics_series_m4_threshold_boundary`: count == `4 * buckets`; raw path.
   count == `4 * buckets + 1`; M4 path.

Integration tests (require ClickHouse, run in CI via `test:contract`):
6. Seed a 200k-point run with a known spike at step 180k (value 99.0, all
   others near 0). Query with `buckets=1000`. Assert step 180k is present in
   the response.
7. Seed a 5-point run. Query with `buckets=1000`. Assert response has exactly
   5 points (raw path).
8. Query with no `buckets` field. Assert behaviour identical to today
   (prefix-limited, no regression).

Frontend test (Node/Playwright):
9. Assert `fetchBatchedMetricSeries` passes `buckets: 1000` in the POST body
   when the chart is rendered.

## Documentation Plan

- Update `apps/rust-server/README.md` HTTP Surface section.
- Update `docs/architecture/current-api.md` series endpoint entry.
- Update benchmark tooling section for the new M4 benchmark.

## Alternatives Considered

**New endpoint `/api/metrics/series/m4`**: would break zero existing callers but
adds a route to maintain. The single-endpoint approach with an optional param
preserves backward compatibility and is simpler.

**LTTB downsampling in Rust**: requires fetching all raw points to Rust before
downsampling. M4 pushes the aggregation to ClickHouse where the data lives.

**Client-side downsampling**: hides the bug from the API contract. API should
return representative data.

## Review Notes

Fresh reviewer 1 (edge-case focus):

- Finding: `hi = lo` (all steps equal, e.g. a series where the user always
  logs step 0) causes `(step - lo) * W / (hi - lo + 1)` = `0 * W / 1` = 0
  for every row. All points land in bucket 0; dedup leaves first/last/min/max
  ≤ 4 points. The output is correct but the caller gets 1 bucket, not W.
- Risk: Low. Series with all-identical steps are a degenerate input.
- Recommended edit: Document in the design doc and in the code comment.
  No code change needed.
- Decision: Accepted.

Fresh reviewer 2 (performance focus):

- Finding: The count check before the M4 query adds a round-trip to
  `metric_series` per run. For a request with 10 runs that all have small
  series, that is 10 extra sub-ms queries before the existing path runs.
- Risk: Negligible for normal use; each count hit is a single AggregatingMergeTree key lookup.
- Recommended edit: Batch the count check into a single `IN ?` query for all
  run_ids at once, returning (run_id, count) pairs. This removes the per-run
  round-trip overhead.
- Decision: Accepted — implemented as a batched pre-check before the per-run
  loop. Single query for all run counts, then per-run M4 or raw path based on
  the result.

## Coverage Exceptions

Integration tests against live ClickHouse (tests 6–8) need a running
ClickHouse. They are tagged `#[cfg(feature = "integration")]` and run only
in `test:contract` / CI.

- Uncovered area: live ClickHouse M4 query path in `cargo test` offline.
- Reason: no embedded ClickHouse in the unit test harness.
- Risk: Low. The SQL is exercised by CI integration tests; the Rust
  assembly/dedup logic is exercised by offline unit tests.
- Follow-up: Consider adding a testcontainers ClickHouse fixture to enable
  integration tests in `cargo test`.
- Owner/date: Agent, 2026-05-18.

## Decision

Accepted. Implement the M4 extension to `POST /api/metrics/series` as
described. The count-check batching from reviewer 2 is included in the
implementation.
