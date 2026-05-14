# ClickHouse schema

Schema files for the ClickHouse metric store. The Rust server applies these on
startup via `metric_store::migrate`. Files are applied in lexical order and must
be idempotent (`CREATE TABLE IF NOT EXISTS`, etc) since ClickHouse has no native
schema version tracking built in.

## Layout

- `0001_initial.sql` — `metric_points` (raw time series), `metric_series`
  (aggregated summary via `AggregatingMergeTree`), and `metric_series_mv` (the
  materialized view that populates `metric_series` from `metric_points` on
  insert).

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
