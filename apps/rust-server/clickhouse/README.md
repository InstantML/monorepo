# ClickHouse schema

Schema files for the ClickHouse metric store. The Rust server applies these on
startup via `metric_store::migrate`. Files are applied in lexical order and must
be idempotent (`CREATE TABLE IF NOT EXISTS`, etc) since ClickHouse has no native
schema version tracking built in.

## Layout

- `0001_initial.sql` — `operational_records` (low-volume replay log),
  `metric_points` (raw scalar time series), `rank_metric_points` (raw
  per-rank scalar metrics for distributed reducer/coverage views),
  `console_log_lines` (bounded stdout/stderr reads by run/stream/cursor),
  `run_liveness` (heartbeat and last-event timestamps for live runs),
  `metric_series` (aggregated summary via `AggregatingMergeTree`), and
  `metric_series_mv` (the materialized view that populates `metric_series`
  from `metric_points` on insert).

`METRIC_SCHEMA_VERSION = 3` in `src/metric_store.rs` exists so existing BYOC
tenant routes created before `rank_metric_points` or `run_liveness` are
migrated on first load.

## Read patterns

Summary queries `*Merge` over `metric_series`:

```sql
SELECT
    org_id, run_id, key,
    countMerge(count)            AS count,
    sumMerge(sum)                AS sum,
    sumMerge(sum_sq)             AS sum_sq,
    minMerge(min)                AS min,
    maxMerge(max)                AS max,
    argMaxMerge(latest)          AS latest,
    maxMerge(latest_step)        AS latest_step,
    argMaxMerge(best_step)       AS best_step,
    argMaxMerge(latest_logged_at) AS latest_logged_at
FROM metric_series
WHERE org_id = {org:UUID} AND run_id IN {runs:Array(UUID)}
GROUP BY org_id, run_id, key;
```

`mean = sum / count` and `variance = sum_sq/count - (sum/count)^2` are computed
on read. `best = max` (matches the prior summary behavior, which always tracked
max regardless of metric direction).

Console log reads query one `(org_id, run_id, stream)` at a time from
`console_log_lines`, ordered by `(line_number, ingest_id)`. Clients provide
line numbers; the API returns opaque cursors so the UI can page stdout/stderr
without loading entire logs.

Run liveness reads query the newest `run_liveness` row per `(org_id, run_id)`.
Rows are append-only heartbeat/event snapshots with a 30-day TTL; authoritative
run status still lives in the `run` operational record.

Rank summary reads query one `(org_id, run_id, key)` at a time from
`rank_metric_points`. Duplicate `(step, rank)` rows are canonicalized at read
time with `argMax(..., tuple(created_at, event_id))`, then reducers, coverage,
heatmap cells, and outliers are derived inside the Rust store layer.
