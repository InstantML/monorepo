-- ClickHouse schema for metric storage.
--
-- Replaces the Postgres metric_points + metric_series tables.
-- Postgres remains primary for OLTP metadata (orgs, users, runs, attributes, artifacts, etc).
-- This file is idempotent (CREATE TABLE IF NOT EXISTS) so it can be applied repeatedly.

CREATE TABLE IF NOT EXISTS metric_points (
    org_id     UUID,
    run_id     UUID,
    key        LowCardinality(String),
    step       Float64 CODEC(Delta, ZSTD(3)),
    value      Float64 CODEC(ZSTD(3)),
    logged_at  DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, key, step)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS metric_series (
    org_id           UUID,
    run_id           UUID,
    key              LowCardinality(String),
    count            AggregateFunction(count, Float64),
    sum              AggregateFunction(sum, Float64),
    sum_sq           AggregateFunction(sum, Float64),
    min              AggregateFunction(min, Float64),
    max              AggregateFunction(max, Float64),
    latest           AggregateFunction(argMax, Float64, Float64),
    latest_step      AggregateFunction(max, Float64),
    best_step        AggregateFunction(argMax, Float64, Float64),
    latest_logged_at AggregateFunction(argMax, DateTime64(6, 'UTC'), Float64)
)
ENGINE = AggregatingMergeTree
ORDER BY (org_id, run_id, key);

CREATE MATERIALIZED VIEW IF NOT EXISTS metric_series_mv TO metric_series AS
SELECT
    org_id,
    run_id,
    key,
    countState(value)                AS count,
    sumState(value)                  AS sum,
    sumState(value * value)          AS sum_sq,
    minState(value)                  AS min,
    maxState(value)                  AS max,
    argMaxState(value, step)         AS latest,
    maxState(step)                   AS latest_step,
    argMaxState(step, value)         AS best_step,
    argMaxState(logged_at, step)     AS latest_logged_at
FROM metric_points
GROUP BY org_id, run_id, key;
