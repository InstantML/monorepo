//! ClickHouse access for product traces.
//!
//! Product traces are tenant data linked to runs. They deliberately live in
//! append-only ClickHouse tables rather than the operational replay log because
//! RL and agent pipelines can emit many span events per run.

use chrono::{DateTime, Utc};
use clickhouse::Row;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    errors::AppResult,
    metric_store::{clickhouse_read_error, clickhouse_storage_error, MetricStore},
};

pub const MAX_TRACE_SEARCH_TERMS: usize = 8;

#[derive(Row, Serialize, Clone)]
pub struct TraceSpanEventRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,
    pub idempotency_key: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub event_id: Uuid,
    pub sequence: u64,
    pub event_kind: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub step: Option<f64>,
    pub rank: Option<u32>,
    pub thread_id: String,
    pub rollout_id: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros::option")]
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<f64>,
    pub input_preview: String,
    pub output_preview: String,
    pub error_type: String,
    pub error_preview: String,
    pub attributes_json: String,
    pub metrics_json: String,
    pub links_json: String,
    pub content_policy: String,
    pub redaction_state: String,
    pub truncated: u8,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

#[derive(Row, Serialize, Clone)]
pub struct TraceSpanIndexRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,
    pub idempotency_key: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub event_id: Uuid,
    pub name: String,
    pub kind: String,
    pub step: Option<f64>,
    pub rank: Option<u32>,
    pub thread_id: String,
    pub rollout_id: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub created_at: DateTime<Utc>,
}

#[derive(Row, Serialize, Clone)]
pub struct TraceSummaryRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub trace_id: String,
    pub idempotency_key: String,
    #[serde(with = "clickhouse::serde::uuid")]
    pub event_id: Uuid,
    pub root_span_id: String,
    pub root_name: String,
    pub status: String,
    pub kinds: Vec<String>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros::option")]
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<f64>,
    pub span_count: u32,
    pub running_span_count: u32,
    pub error_count: u32,
    pub model_call_count: u32,
    pub tool_call_count: u32,
    pub retrieval_count: u32,
    pub reward_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
    pub min_step: Option<f64>,
    pub max_step: Option<f64>,
    pub thread_id: String,
    pub rollout_id: String,
    pub summary_metrics_json: String,
    pub attributes_json: String,
    pub content_available: u8,
    pub truncated: u8,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Row, Serialize, Clone)]
pub struct TraceIngestBatchRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub org_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub idempotency_key: String,
    pub status: String,
    pub body_hash: String,
    pub response_json: String,
    pub trace_ids: Vec<String>,
    pub event_ids: Vec<String>,
    pub usage_event_count: u32,
    pub billing_period: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub accepted_at: DateTime<Utc>,
}

#[derive(Row, Deserialize)]
pub struct TraceIngestBatchReadRow {
    pub status: String,
    pub body_hash: String,
    pub response_json: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub accepted_at: DateTime<Utc>,
}

#[derive(Row, Deserialize, Clone)]
pub struct TraceSummaryReadRow {
    #[serde(with = "clickhouse::serde::uuid")]
    pub project_id: Uuid,
    #[serde(with = "clickhouse::serde::uuid")]
    pub run_id: Uuid,
    pub trace_id: String,
    pub root_span_id: String,
    pub root_name: String,
    pub status: String,
    pub kinds: Vec<String>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros::option")]
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<f64>,
    pub span_count: u32,
    pub running_span_count: u32,
    pub error_count: u32,
    pub model_call_count: u32,
    pub tool_call_count: u32,
    pub retrieval_count: u32,
    pub reward_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
    pub min_step: Option<f64>,
    pub max_step: Option<f64>,
    pub thread_id: String,
    pub rollout_id: String,
    pub summary_metrics_json: String,
    pub attributes_json: String,
    pub content_available: u8,
    pub truncated: u8,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Row, Deserialize, Clone)]
pub struct TraceSpanCanonicalRow {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub step: Option<f64>,
    pub rank: Option<u32>,
    pub thread_id: String,
    pub rollout_id: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros::option")]
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<f64>,
    pub input_preview: String,
    pub output_preview: String,
    pub error_type: String,
    pub error_preview: String,
    pub attributes_json: String,
    pub metrics_json: String,
    pub links_json: String,
    pub content_policy: String,
    pub redaction_state: String,
    pub truncated: u8,
}

#[derive(Row, Deserialize, Clone)]
pub struct TraceSpanIndexReadRow {
    pub span_id: String,
    pub parent_span_id: String,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub started_at: DateTime<Utc>,
}

#[derive(Row, Deserialize)]
pub struct TraceChildCountRow {
    pub parent_span_id: String,
    pub child_count: u64,
}

#[derive(Clone, Debug)]
pub struct TraceListQuery {
    pub project_id: Uuid,
    pub run_id: Option<Uuid>,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub q: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub min_step: Option<f64>,
    pub max_step: Option<f64>,
    pub cursor: Option<TraceListCursor>,
    pub limit: i64,
}

#[derive(Clone, Debug)]
pub struct TraceListCursor {
    pub started_at: DateTime<Utc>,
    pub trace_id: String,
}

#[derive(Row, Deserialize)]
pub struct TraceStepBucketReadRow {
    pub step: f64,
    pub trace_count: u64,
    pub error_trace_count: u64,
    pub running_trace_count: u64,
    pub span_count: u64,
    pub error_span_count: u64,
    pub avg_duration_ms: Option<f64>,
    pub max_duration_ms: Option<f64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub first_started_at: DateTime<Utc>,
    #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
    pub last_started_at: DateTime<Utc>,
}

#[derive(Row, Deserialize, Clone)]
pub struct TraceStepCountsReadRow {
    pub total_trace_count: u64,
    pub stepless_trace_count: u64,
}

#[derive(Clone, Debug)]
pub struct TraceStepSummaryQuery {
    pub project_id: Uuid,
    pub run_id: Uuid,
    pub min_step: Option<f64>,
    pub max_step: Option<f64>,
    pub limit: i64,
}

pub struct TraceSpanWindowQuery<'a> {
    pub org_id: Uuid,
    pub project_id: Uuid,
    pub run_id: Uuid,
    pub trace_id: &'a str,
    pub parent_span_id: &'a str,
    pub limit: i64,
    pub cursor: Option<(DateTime<Utc>, String)>,
}

pub async fn insert_trace_span_events(
    store: &MetricStore,
    rows: &[TraceSpanEventRow],
) -> AppResult<()> {
    insert_rows(store, "trace_span_events", rows).await
}

pub async fn insert_trace_span_index(
    store: &MetricStore,
    rows: &[TraceSpanIndexRow],
) -> AppResult<()> {
    insert_rows(store, "trace_span_index", rows).await
}

pub async fn insert_trace_summaries(
    store: &MetricStore,
    rows: &[TraceSummaryRow],
) -> AppResult<()> {
    insert_rows(store, "trace_summaries", rows).await
}

pub async fn insert_trace_ingest_batch(
    store: &MetricStore,
    row: &TraceIngestBatchRow,
) -> AppResult<()> {
    insert_rows(store, "trace_ingest_batches", std::slice::from_ref(row)).await
}

async fn insert_rows<T>(store: &MetricStore, table: &str, rows: &[T]) -> AppResult<()>
where
    T: Serialize + Row,
{
    if rows.is_empty() {
        return Ok(());
    }
    let mut inserter = store
        .client()
        .insert(table)
        .map_err(|err| clickhouse_storage_error("clickhouse trace insert init failed", err))?;
    for row in rows {
        inserter
            .write(row)
            .await
            .map_err(|err| clickhouse_storage_error("clickhouse trace insert write failed", err))?;
    }
    inserter
        .end()
        .await
        .map_err(|err| clickhouse_storage_error("clickhouse trace insert flush failed", err))?;
    Ok(())
}

pub async fn trace_ingest_batch(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    idempotency_key: &str,
) -> AppResult<Option<TraceIngestBatchReadRow>> {
    store
        .client()
        .query(
            "SELECT status, body_hash, response_json, accepted_at \
             FROM trace_ingest_batches \
             WHERE org_id = ? AND project_id = ? AND run_id = ? AND idempotency_key = ? \
             ORDER BY if(status = 'accepted', 1, 0) DESC, accepted_at DESC \
             LIMIT 1",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(idempotency_key)
        .fetch_optional::<TraceIngestBatchReadRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn trace_event_usage_for_period(
    store: &MetricStore,
    org_id: Uuid,
    billing_period: &str,
) -> AppResult<u64> {
    store
        .client()
        .query(
            "SELECT toUInt64(coalesce(sum(usage_event_count), 0)) \
             FROM ( \
               SELECT argMax(usage_event_count, accepted_at) AS usage_event_count \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND billing_period = ? AND status = 'accepted' \
               GROUP BY run_id, idempotency_key \
             )",
        )
        .bind(org_id)
        .bind(billing_period)
        .fetch_one::<u64>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn list_trace_summaries(
    store: &MetricStore,
    org_id: Uuid,
    query: &TraceListQuery,
) -> AppResult<Vec<TraceSummaryReadRow>> {
    let mut sql = String::from(
        "SELECT \
           project_id, run_id, trace_id, \
           root_span_id, root_name, status, kinds, summary_started_at AS started_at, ended_at, duration_ms, \
           span_count, running_span_count, error_count, model_call_count, tool_call_count, \
           retrieval_count, reward_count, input_tokens, output_tokens, cost_usd, min_step, \
           max_step, thread_id, rollout_id, summary_metrics_json, attributes_json, \
           content_available, truncated, summary_updated_at AS updated_at \
         FROM ( \
           SELECT \
             project_id, run_id, trace_id, \
             argMax(root_span_id, tuple(updated_at, event_id)) AS root_span_id, \
             argMax(root_name, tuple(updated_at, event_id)) AS root_name, \
             argMax(status, tuple(updated_at, event_id)) AS status, \
             argMax(kinds, tuple(updated_at, event_id)) AS kinds, \
             argMax(started_at, tuple(updated_at, event_id)) AS summary_started_at, \
             argMax(ended_at, tuple(updated_at, event_id)) AS ended_at, \
             argMax(duration_ms, tuple(updated_at, event_id)) AS duration_ms, \
             argMax(span_count, tuple(updated_at, event_id)) AS span_count, \
             argMax(running_span_count, tuple(updated_at, event_id)) AS running_span_count, \
             argMax(error_count, tuple(updated_at, event_id)) AS error_count, \
             argMax(model_call_count, tuple(updated_at, event_id)) AS model_call_count, \
             argMax(tool_call_count, tuple(updated_at, event_id)) AS tool_call_count, \
             argMax(retrieval_count, tuple(updated_at, event_id)) AS retrieval_count, \
             argMax(reward_count, tuple(updated_at, event_id)) AS reward_count, \
             argMax(input_tokens, tuple(updated_at, event_id)) AS input_tokens, \
             argMax(output_tokens, tuple(updated_at, event_id)) AS output_tokens, \
             argMax(cost_usd, tuple(updated_at, event_id)) AS cost_usd, \
             argMax(min_step, tuple(updated_at, event_id)) AS min_step, \
             argMax(max_step, tuple(updated_at, event_id)) AS max_step, \
             argMax(thread_id, tuple(updated_at, event_id)) AS thread_id, \
             argMax(rollout_id, tuple(updated_at, event_id)) AS rollout_id, \
             argMax(summary_metrics_json, tuple(updated_at, event_id)) AS summary_metrics_json, \
             argMax(attributes_json, tuple(updated_at, event_id)) AS attributes_json, \
             argMax(content_available, tuple(updated_at, event_id)) AS content_available, \
             argMax(truncated, tuple(updated_at, event_id)) AS truncated, \
             max(updated_at) AS summary_updated_at \
           FROM trace_summaries \
           WHERE org_id = ? \
             AND project_id = ? \
             AND (run_id, idempotency_key) IN ( \
               SELECT run_id, idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND status = 'accepted' \
               GROUP BY run_id, idempotency_key \
             )",
    );
    if query.from.is_some() {
        sql.push_str(" AND started_at >= parseDateTime64BestEffort(?, 6, 'UTC')");
    }
    if query.to.is_some() {
        sql.push_str(" AND started_at < parseDateTime64BestEffort(?, 6, 'UTC')");
    }
    if query.run_id.is_some() {
        sql.push_str(" AND run_id = ?");
    }
    sql.push_str(
        " GROUP BY project_id, run_id, trace_id \
         ) WHERE 1",
    );
    if query.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    if query.kind.is_some() {
        sql.push_str(" AND has(kinds, ?)");
    }
    let search_terms = query
        .q
        .as_deref()
        .map(trace_search_terms)
        .unwrap_or_default();
    for _ in &search_terms {
        sql.push_str(
            " AND (positionCaseInsensitive(root_name, ?) > 0 \
               OR startsWith(trace_id, ?) \
               OR positionCaseInsensitive(rollout_id, ?) > 0 \
               OR positionCaseInsensitive(thread_id, ?) > 0)",
        );
    }
    if query.min_step.is_some() {
        sql.push_str(" AND (max_step IS NULL OR max_step >= ?)");
    }
    if query.max_step.is_some() {
        sql.push_str(" AND (min_step IS NULL OR min_step <= ?)");
    }
    if query.cursor.is_some() {
        sql.push_str(
            " AND (summary_started_at < parseDateTime64BestEffort(?, 6, 'UTC') \
               OR (summary_started_at = parseDateTime64BestEffort(?, 6, 'UTC') AND trace_id < ?))",
        );
    }
    sql.push_str(" ORDER BY summary_started_at DESC, trace_id DESC LIMIT ?");

    let mut q = store
        .client()
        .query(&sql)
        .bind(org_id)
        .bind(query.project_id)
        .bind(org_id)
        .bind(query.project_id);
    if let Some(from) = query.from {
        q = q.bind(from.to_rfc3339());
    }
    if let Some(to) = query.to {
        q = q.bind(to.to_rfc3339());
    }
    if let Some(run_id) = query.run_id {
        q = q.bind(run_id);
    }
    if let Some(status) = &query.status {
        q = q.bind(status);
    }
    if let Some(kind) = &query.kind {
        q = q.bind(kind);
    }
    for term in &search_terms {
        q = q.bind(term).bind(term).bind(term).bind(term);
    }
    if let Some(min_step) = query.min_step {
        q = q.bind(min_step);
    }
    if let Some(max_step) = query.max_step {
        q = q.bind(max_step);
    }
    if let Some(cursor) = &query.cursor {
        let cursor_at = cursor.started_at.to_rfc3339();
        q = q
            .bind(cursor_at.clone())
            .bind(cursor_at)
            .bind(&cursor.trace_id);
    }
    q.bind(query.limit)
        .fetch_all::<TraceSummaryReadRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn trace_step_summaries(
    store: &MetricStore,
    org_id: Uuid,
    query: TraceStepSummaryQuery,
) -> AppResult<Vec<TraceStepBucketReadRow>> {
    let mut sql = String::from(
        "SELECT \
           assumeNotNull(min_step) AS step, \
           toUInt64(count()) AS trace_count, \
           toUInt64(countIf(status = 'error')) AS error_trace_count, \
           toUInt64(countIf(status = 'running')) AS running_trace_count, \
           toUInt64(sum(span_count)) AS span_count, \
           toUInt64(sum(error_count)) AS error_span_count, \
           avgOrNull(duration_ms) AS avg_duration_ms, \
           maxOrNull(duration_ms) AS max_duration_ms, \
           toUInt64(sum(input_tokens)) AS input_tokens, \
           toUInt64(sum(output_tokens)) AS output_tokens, \
           min(started_at) AS first_started_at, \
           max(started_at) AS last_started_at \
         FROM ( \
           SELECT \
             argMax(status, tuple(updated_at, event_id)) AS status, \
             argMax(span_count, tuple(updated_at, event_id)) AS span_count, \
             argMax(error_count, tuple(updated_at, event_id)) AS error_count, \
             argMax(duration_ms, tuple(updated_at, event_id)) AS duration_ms, \
             argMax(input_tokens, tuple(updated_at, event_id)) AS input_tokens, \
             argMax(output_tokens, tuple(updated_at, event_id)) AS output_tokens, \
             argMax(min_step, tuple(updated_at, event_id)) AS min_step, \
             argMax(started_at, tuple(updated_at, event_id)) AS started_at \
           FROM trace_summaries \
           WHERE org_id = ? \
             AND project_id = ? \
             AND run_id = ? \
             AND (run_id, idempotency_key) IN ( \
               SELECT run_id, idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND status = 'accepted' \
               GROUP BY run_id, idempotency_key \
             ) \
           GROUP BY project_id, run_id, trace_id \
         ) WHERE min_step IS NOT NULL",
    );
    if query.min_step.is_some() {
        sql.push_str(" AND min_step >= ?");
    }
    if query.max_step.is_some() {
        sql.push_str(" AND min_step <= ?");
    }
    sql.push_str(" GROUP BY step ORDER BY step ASC LIMIT ?");

    let mut q = store
        .client()
        .query(&sql)
        .bind(org_id)
        .bind(query.project_id)
        .bind(query.run_id)
        .bind(org_id)
        .bind(query.project_id);
    if let Some(min_step) = query.min_step {
        q = q.bind(min_step);
    }
    if let Some(max_step) = query.max_step {
        q = q.bind(max_step);
    }
    q.bind(query.limit)
        .fetch_all::<TraceStepBucketReadRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn trace_step_counts(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
) -> AppResult<TraceStepCountsReadRow> {
    store
        .client()
        .query(
            "SELECT \
               toUInt64(count()) AS total_trace_count, \
               toUInt64(countIf(min_step IS NULL)) AS stepless_trace_count \
             FROM ( \
               SELECT argMax(min_step, tuple(updated_at, event_id)) AS min_step \
               FROM trace_summaries \
               WHERE org_id = ? \
                 AND project_id = ? \
                 AND run_id = ? \
                 AND (run_id, idempotency_key) IN ( \
                   SELECT run_id, idempotency_key \
                   FROM trace_ingest_batches \
                   WHERE org_id = ? AND project_id = ? AND status = 'accepted' \
                   GROUP BY run_id, idempotency_key \
                 ) \
               GROUP BY project_id, run_id, trace_id \
             )",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(org_id)
        .bind(project_id)
        .fetch_one::<TraceStepCountsReadRow>()
        .await
        .map_err(clickhouse_read_error)
}

fn trace_search_terms(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

pub async fn root_span_ids(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
    limit: i64,
) -> AppResult<Vec<TraceSpanIndexReadRow>> {
    child_span_ids(
        store,
        TraceSpanWindowQuery {
            org_id,
            project_id,
            run_id,
            trace_id,
            parent_span_id: "",
            limit,
            cursor: None,
        },
    )
    .await
}

pub async fn child_span_ids(
    store: &MetricStore,
    query: TraceSpanWindowQuery<'_>,
) -> AppResult<Vec<TraceSpanIndexReadRow>> {
    let mut sql = String::from(
        "SELECT span_id, span_parent_id AS parent_span_id, first_started_at AS started_at \
         FROM ( \
           SELECT span_id, any(parent_span_id) AS span_parent_id, min(started_at) AS first_started_at \
           FROM trace_span_index \
           WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? AND parent_span_id = ? \
             AND idempotency_key IN ( \
               SELECT idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
               GROUP BY idempotency_key \
             ) \
           GROUP BY span_id \
         ) WHERE 1",
    );
    if query.cursor.is_some() {
        sql.push_str(
            " AND (first_started_at > parseDateTime64BestEffort(?, 6, 'UTC') \
               OR (first_started_at = parseDateTime64BestEffort(?, 6, 'UTC') AND span_id > ?))",
        );
    }
    sql.push_str(" ORDER BY first_started_at ASC, span_id ASC LIMIT ?");

    let mut q = store
        .client()
        .query(&sql)
        .bind(query.org_id)
        .bind(query.project_id)
        .bind(query.run_id)
        .bind(query.trace_id)
        .bind(query.parent_span_id)
        .bind(query.org_id)
        .bind(query.project_id)
        .bind(query.run_id);
    if let Some((started_at, span_id)) = query.cursor {
        let cursor_at = started_at.to_rfc3339();
        q = q.bind(cursor_at.clone()).bind(cursor_at).bind(span_id);
    }
    q.bind(query.limit)
        .fetch_all::<TraceSpanIndexReadRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn child_counts(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
    parent_span_ids: &[String],
) -> AppResult<Vec<TraceChildCountRow>> {
    if parent_span_ids.is_empty() {
        return Ok(Vec::new());
    }
    store
        .client()
        .query(
            "SELECT parent_span_id, countDistinct(span_id) AS child_count \
             FROM trace_span_index \
             WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
               AND parent_span_id IN ? \
               AND idempotency_key IN ( \
                 SELECT idempotency_key \
                 FROM trace_ingest_batches \
                 WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
                 GROUP BY idempotency_key \
               ) \
             GROUP BY parent_span_id",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(parent_span_ids.to_vec())
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .fetch_all::<TraceChildCountRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn child_count_for_parent(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
    parent_span_id: &str,
) -> AppResult<u64> {
    store
        .client()
        .query(
            "SELECT countDistinct(span_id) \
             FROM trace_span_index \
             WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
               AND parent_span_id = ? \
               AND idempotency_key IN ( \
                 SELECT idempotency_key \
                 FROM trace_ingest_batches \
                 WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
                 GROUP BY idempotency_key \
               )",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(parent_span_id)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .fetch_one::<u64>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn canonical_spans_by_id(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
    span_ids: &[String],
) -> AppResult<Vec<TraceSpanCanonicalRow>> {
    if span_ids.is_empty() {
        return Ok(Vec::new());
    }
    store
        .client()
        .query(CANONICAL_SPANS_BY_ID_SQL)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(span_ids.to_vec())
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .fetch_all::<TraceSpanCanonicalRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn canonical_spans_for_summary(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
    include_idempotency_key: Option<&str>,
    limit: i64,
) -> AppResult<Vec<TraceSpanCanonicalRow>> {
    let mut sql = CANONICAL_SPANS_FOR_TRACE_SQL.to_string();
    if include_idempotency_key.is_some() {
        sql = sql.replace(
            "/* accepted_filter */",
            "AND (idempotency_key = ? OR idempotency_key IN ( \
               SELECT idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
               GROUP BY idempotency_key \
             ))",
        );
    } else {
        sql = sql.replace(
            "/* accepted_filter */",
            "AND idempotency_key IN ( \
               SELECT idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
               GROUP BY idempotency_key \
             )",
        );
    }
    let mut q = store
        .client()
        .query(&sql)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id);
    if let Some(idempotency_key) = include_idempotency_key {
        q = q.bind(idempotency_key);
    }
    q.bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(limit)
        .fetch_all::<TraceSpanCanonicalRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn canonical_spans_for_summary_batch(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_ids: &[String],
    include_idempotency_key: Option<&str>,
    per_trace_limit: i64,
) -> AppResult<Vec<TraceSpanCanonicalRow>> {
    if trace_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut sql = CANONICAL_SPANS_FOR_TRACES_SQL.to_string();
    if include_idempotency_key.is_some() {
        sql = sql.replace(
            "/* accepted_filter */",
            "AND (idempotency_key = ? OR idempotency_key IN ( \
               SELECT idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
               GROUP BY idempotency_key \
             ))",
        );
    } else {
        sql = sql.replace(
            "/* accepted_filter */",
            "AND idempotency_key IN ( \
               SELECT idempotency_key \
               FROM trace_ingest_batches \
               WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
               GROUP BY idempotency_key \
             )",
        );
    }
    let mut q = store
        .client()
        .query(&sql)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_ids.to_vec());
    if let Some(idempotency_key) = include_idempotency_key {
        q = q.bind(idempotency_key);
    }
    q.bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(per_trace_limit)
        .fetch_all::<TraceSpanCanonicalRow>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn total_span_count(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
) -> AppResult<u64> {
    store
        .client()
        .query(
            "SELECT countDistinct(span_id) \
             FROM trace_span_index \
             WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
               AND idempotency_key IN ( \
                 SELECT idempotency_key \
                 FROM trace_ingest_batches \
                 WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
                 GROUP BY idempotency_key \
               )",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .fetch_one::<u64>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn root_count(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
) -> AppResult<u64> {
    store
        .client()
        .query(
            "SELECT countDistinct(span_id) \
             FROM trace_span_index \
             WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
               AND parent_span_id = '' \
               AND idempotency_key IN ( \
                 SELECT idempotency_key \
                 FROM trace_ingest_batches \
                 WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
                 GROUP BY idempotency_key \
               )",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .fetch_one::<u64>()
        .await
        .map_err(clickhouse_read_error)
}

pub async fn orphan_count(
    store: &MetricStore,
    org_id: Uuid,
    project_id: Uuid,
    run_id: Uuid,
    trace_id: &str,
) -> AppResult<u64> {
    store
        .client()
        .query(
            "SELECT count() \
             FROM ( \
               SELECT span_id, any(parent_span_id) AS canonical_parent_span_id \
               FROM trace_span_index \
               WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
                 AND idempotency_key IN ( \
                   SELECT idempotency_key \
                   FROM trace_ingest_batches \
                   WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
                   GROUP BY idempotency_key \
                 ) \
               GROUP BY span_id \
             ) \
             WHERE canonical_parent_span_id != '' \
               AND canonical_parent_span_id NOT IN ( \
                 SELECT span_id \
                 FROM trace_span_index \
                 WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
                   AND idempotency_key IN ( \
                     SELECT idempotency_key \
                     FROM trace_ingest_batches \
                     WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
                     GROUP BY idempotency_key \
                   ) \
                 GROUP BY span_id \
               )",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .bind(trace_id)
        .bind(org_id)
        .bind(project_id)
        .bind(run_id)
        .fetch_one::<u64>()
        .await
        .map_err(clickhouse_read_error)
}

const CANONICAL_SPANS_BY_ID_SQL: &str = "SELECT \
    trace_id, span_id, \
    argMax(parent_span_id, tuple(sequence, created_at, event_id)) AS parent_span_id, \
    argMax(name, tuple(sequence, created_at, event_id)) AS name, \
    argMax(kind, tuple(sequence, created_at, event_id)) AS kind, \
    argMax(status, tuple(sequence, created_at, event_id)) AS status, \
    argMax(step, tuple(sequence, created_at, event_id)) AS step, \
    argMax(rank, tuple(sequence, created_at, event_id)) AS rank, \
    argMax(thread_id, tuple(sequence, created_at, event_id)) AS thread_id, \
    argMax(rollout_id, tuple(sequence, created_at, event_id)) AS rollout_id, \
    min(started_at) AS started_at, \
    argMax(ended_at, tuple(sequence, created_at, event_id)) AS ended_at, \
    argMax(duration_ms, tuple(sequence, created_at, event_id)) AS duration_ms, \
    argMax(input_preview, tuple(sequence, created_at, event_id)) AS input_preview, \
    argMax(output_preview, tuple(sequence, created_at, event_id)) AS output_preview, \
    argMax(error_type, tuple(sequence, created_at, event_id)) AS error_type, \
    argMax(error_preview, tuple(sequence, created_at, event_id)) AS error_preview, \
    argMax(attributes_json, tuple(sequence, created_at, event_id)) AS attributes_json, \
    argMax(metrics_json, tuple(sequence, created_at, event_id)) AS metrics_json, \
    argMax(links_json, tuple(sequence, created_at, event_id)) AS links_json, \
    argMax(content_policy, tuple(sequence, created_at, event_id)) AS content_policy, \
    argMax(redaction_state, tuple(sequence, created_at, event_id)) AS redaction_state, \
    argMax(truncated, tuple(sequence, created_at, event_id)) AS truncated \
  FROM trace_span_events \
  WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? AND span_id IN ? \
    AND idempotency_key IN ( \
      SELECT idempotency_key \
      FROM trace_ingest_batches \
      WHERE org_id = ? AND project_id = ? AND run_id = ? AND status = 'accepted' \
      GROUP BY idempotency_key \
    ) \
  GROUP BY trace_id, span_id \
  ORDER BY started_at ASC, span_id ASC";

const CANONICAL_SPANS_FOR_TRACE_SQL: &str = "SELECT \
    trace_id, span_id, \
    argMax(parent_span_id, tuple(sequence, created_at, event_id)) AS parent_span_id, \
    argMax(name, tuple(sequence, created_at, event_id)) AS name, \
    argMax(kind, tuple(sequence, created_at, event_id)) AS kind, \
    argMax(status, tuple(sequence, created_at, event_id)) AS status, \
    argMax(step, tuple(sequence, created_at, event_id)) AS step, \
    argMax(rank, tuple(sequence, created_at, event_id)) AS rank, \
    argMax(thread_id, tuple(sequence, created_at, event_id)) AS thread_id, \
    argMax(rollout_id, tuple(sequence, created_at, event_id)) AS rollout_id, \
    min(started_at) AS started_at, \
    argMax(ended_at, tuple(sequence, created_at, event_id)) AS ended_at, \
    argMax(duration_ms, tuple(sequence, created_at, event_id)) AS duration_ms, \
    argMax(input_preview, tuple(sequence, created_at, event_id)) AS input_preview, \
    argMax(output_preview, tuple(sequence, created_at, event_id)) AS output_preview, \
    argMax(error_type, tuple(sequence, created_at, event_id)) AS error_type, \
    argMax(error_preview, tuple(sequence, created_at, event_id)) AS error_preview, \
    argMax(attributes_json, tuple(sequence, created_at, event_id)) AS attributes_json, \
    argMax(metrics_json, tuple(sequence, created_at, event_id)) AS metrics_json, \
    argMax(links_json, tuple(sequence, created_at, event_id)) AS links_json, \
    argMax(content_policy, tuple(sequence, created_at, event_id)) AS content_policy, \
    argMax(redaction_state, tuple(sequence, created_at, event_id)) AS redaction_state, \
    argMax(truncated, tuple(sequence, created_at, event_id)) AS truncated \
  FROM trace_span_events \
  WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id = ? \
  /* accepted_filter */ \
  GROUP BY trace_id, span_id \
  ORDER BY started_at ASC, span_id ASC \
  LIMIT ?";

const CANONICAL_SPANS_FOR_TRACES_SQL: &str = "SELECT \
    trace_id, span_id, \
    argMax(parent_span_id, tuple(sequence, created_at, event_id)) AS parent_span_id, \
    argMax(name, tuple(sequence, created_at, event_id)) AS name, \
    argMax(kind, tuple(sequence, created_at, event_id)) AS kind, \
    argMax(status, tuple(sequence, created_at, event_id)) AS status, \
    argMax(step, tuple(sequence, created_at, event_id)) AS step, \
    argMax(rank, tuple(sequence, created_at, event_id)) AS rank, \
    argMax(thread_id, tuple(sequence, created_at, event_id)) AS thread_id, \
    argMax(rollout_id, tuple(sequence, created_at, event_id)) AS rollout_id, \
    min(started_at) AS started_at, \
    argMax(ended_at, tuple(sequence, created_at, event_id)) AS ended_at, \
    argMax(duration_ms, tuple(sequence, created_at, event_id)) AS duration_ms, \
    argMax(input_preview, tuple(sequence, created_at, event_id)) AS input_preview, \
    argMax(output_preview, tuple(sequence, created_at, event_id)) AS output_preview, \
    argMax(error_type, tuple(sequence, created_at, event_id)) AS error_type, \
    argMax(error_preview, tuple(sequence, created_at, event_id)) AS error_preview, \
    argMax(attributes_json, tuple(sequence, created_at, event_id)) AS attributes_json, \
    argMax(metrics_json, tuple(sequence, created_at, event_id)) AS metrics_json, \
    argMax(links_json, tuple(sequence, created_at, event_id)) AS links_json, \
    argMax(content_policy, tuple(sequence, created_at, event_id)) AS content_policy, \
    argMax(redaction_state, tuple(sequence, created_at, event_id)) AS redaction_state, \
    argMax(truncated, tuple(sequence, created_at, event_id)) AS truncated \
  FROM trace_span_events \
  WHERE org_id = ? AND project_id = ? AND run_id = ? AND trace_id IN ? \
  /* accepted_filter */ \
  GROUP BY trace_id, span_id \
  ORDER BY trace_id ASC, started_at ASC, span_id ASC \
  LIMIT ? BY trace_id";

#[cfg(test)]
mod tests {
    use super::trace_search_terms;

    #[test]
    fn trace_search_terms_split_whitespace() {
        let terms = trace_search_terms("  rollout step2   reward extra one two three four five  ");

        assert_eq!(
            terms,
            vec!["rollout", "step2", "reward", "extra", "one", "two", "three", "four", "five"]
        );
    }
}
