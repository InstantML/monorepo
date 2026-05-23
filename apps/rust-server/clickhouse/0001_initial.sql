-- ClickHouse schema for Training Observability storage.
--
-- `operational_records` is the low-volume control/data-plane record log used
-- to rebuild the Rust API's local single-process index. `metric_points` and
-- `metric_series` are the analytical layer for high-volume scalar metrics.
-- This file is idempotent (CREATE TABLE IF NOT EXISTS) so it can be applied repeatedly.

CREATE TABLE IF NOT EXISTS operational_records (
    kind       LowCardinality(String),
    org_id     UUID,
    entity_id  String,
    payload    String CODEC(ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (kind, org_id, entity_id, created_at)
SETTINGS index_granularity = 8192;

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

CREATE TABLE IF NOT EXISTS rank_metric_points (
    org_id     UUID,
    run_id     UUID,
    key        LowCardinality(String),
    step       Float64 CODEC(Delta, ZSTD(3)),
    rank       UInt32,
    local_rank UInt32,
    world_size UInt32,
    value      Float64 CODEC(ZSTD(3)),
    weight     Float64 CODEC(ZSTD(3)),
    logged_at  DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3)),
    event_id   UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, key, step, rank, created_at, event_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS console_log_lines (
    org_id      UUID,
    run_id      UUID,
    stream      LowCardinality(String),
    ingest_id   UUID,
    line_number UInt64 CODEC(Delta, ZSTD(3)),
    message     String CODEC(ZSTD(3)),
    logged_at   DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at  DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, stream, line_number, ingest_id)
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
