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

CREATE TABLE IF NOT EXISTS trace_span_events (
    org_id           UUID,
    project_id       UUID,
    run_id           UUID,
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    idempotency_key  String,
    event_id         UUID,
    sequence         UInt64 CODEC(Delta, ZSTD(3)),
    event_kind       LowCardinality(String),
    name             String CODEC(ZSTD(3)),
    kind             LowCardinality(String),
    status           LowCardinality(String),
    step             Nullable(Float64) CODEC(ZSTD(3)),
    rank             Nullable(UInt32) CODEC(Delta, ZSTD(3)),
    thread_id        String CODEC(ZSTD(3)),
    rollout_id       String CODEC(ZSTD(3)),
    started_at       DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    ended_at         Nullable(DateTime64(6, 'UTC')) CODEC(Delta, ZSTD(3)),
    duration_ms      Nullable(Float64) CODEC(ZSTD(3)),
    input_preview    String CODEC(ZSTD(3)),
    output_preview   String CODEC(ZSTD(3)),
    error_type       LowCardinality(String),
    error_preview    String CODEC(ZSTD(3)),
    attributes_json  String CODEC(ZSTD(3)),
    metrics_json     String CODEC(ZSTD(3)),
    links_json       String CODEC(ZSTD(3)),
    content_policy   LowCardinality(String),
    redaction_state  LowCardinality(String),
    truncated        UInt8,
    created_at       DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, project_id, run_id, trace_id, span_id, idempotency_key, sequence, created_at, event_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS trace_span_index (
    org_id           UUID,
    project_id       UUID,
    run_id           UUID,
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    idempotency_key  String,
    event_id         UUID,
    name             String CODEC(ZSTD(3)),
    kind             LowCardinality(String),
    step             Nullable(Float64) CODEC(ZSTD(3)),
    rank             Nullable(UInt32) CODEC(Delta, ZSTD(3)),
    thread_id        String CODEC(ZSTD(3)),
    rollout_id       String CODEC(ZSTD(3)),
    started_at       DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at       DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, project_id, run_id, trace_id, parent_span_id, started_at, span_id, idempotency_key, event_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS trace_summaries (
    org_id               UUID,
    project_id           UUID,
    run_id               UUID,
    trace_id             String,
    idempotency_key      String,
    event_id             UUID,
    root_span_id         String,
    root_name            String CODEC(ZSTD(3)),
    status               LowCardinality(String),
    kinds                Array(String),
    started_at           DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    ended_at             Nullable(DateTime64(6, 'UTC')) CODEC(Delta, ZSTD(3)),
    duration_ms          Nullable(Float64) CODEC(ZSTD(3)),
    span_count           UInt32 CODEC(Delta, ZSTD(3)),
    running_span_count   UInt32 CODEC(Delta, ZSTD(3)),
    error_count          UInt32 CODEC(Delta, ZSTD(3)),
    model_call_count     UInt32 CODEC(Delta, ZSTD(3)),
    tool_call_count      UInt32 CODEC(Delta, ZSTD(3)),
    retrieval_count      UInt32 CODEC(Delta, ZSTD(3)),
    reward_count         UInt32 CODEC(Delta, ZSTD(3)),
    input_tokens         UInt64 CODEC(Delta, ZSTD(3)),
    output_tokens        UInt64 CODEC(Delta, ZSTD(3)),
    cost_usd             Nullable(Float64) CODEC(ZSTD(3)),
    min_step             Nullable(Float64) CODEC(ZSTD(3)),
    max_step             Nullable(Float64) CODEC(ZSTD(3)),
    thread_id            String CODEC(ZSTD(3)),
    rollout_id           String CODEC(ZSTD(3)),
    summary_metrics_json String CODEC(ZSTD(3)),
    attributes_json      String CODEC(ZSTD(3)),
    content_available    UInt8,
    truncated            UInt8,
    updated_at           DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, project_id, run_id, started_at, trace_id, idempotency_key, updated_at, event_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS trace_ingest_batches (
    org_id              UUID,
    project_id          UUID,
    run_id              UUID,
    idempotency_key     String,
    status              LowCardinality(String),
    body_hash           String,
    response_json       String CODEC(ZSTD(3)),
    trace_ids           Array(String),
    event_ids           Array(String),
    usage_event_count   UInt32 CODEC(Delta, ZSTD(3)),
    billing_period      String,
    accepted_at         DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY billing_period
ORDER BY (org_id, billing_period, run_id, idempotency_key, status, accepted_at)
SETTINGS index_granularity = 8192;
