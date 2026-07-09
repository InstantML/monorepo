use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Datelike;
#[cfg(test)]
use chrono::TimeZone;

use crate::trace_store::{
    self as ch_traces, TraceChildCountRow, TraceIngestBatchRow, TraceListCursor, TraceListQuery,
    TraceSpanCanonicalRow, TraceSpanEventRow, TraceSpanIndexReadRow, TraceSpanIndexRow,
    TraceSummaryReadRow, TraceSummaryRow, MAX_TRACE_SEARCH_TERMS,
};

const TRACE_SUMMARY_RECOMPUTE_LIMIT: i64 = 100_001;
const TRACE_SUMMARY_VISIBLE_SPAN_LIMIT: usize = 100_000;
const DEFAULT_TRACE_LOOKBACK_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
struct TraceListWindow {
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct ValidTraceEvent {
    input: TraceEventInput,
    trace_id: String,
    span_id: String,
    parent_span_id: String,
    event_kind: String,
    name: String,
    kind: String,
    status: String,
    thread_id: String,
    rollout_id: String,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    duration_ms: Option<f64>,
    input_preview: String,
    output_preview: String,
    error_type: String,
    error_preview: String,
    attributes_json: String,
    metrics_json: String,
    links_json: String,
    content_policy: String,
    redaction_state: String,
    truncated: bool,
}

pub async fn ingest_trace_events(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: CreateTraceEventsRequest,
    idempotency_key: String,
) -> AppResult<TraceIngestResponse> {
    let request_hash = hex::encode(hash_idempotency(run_id, &raw)?);
    store
        .reserve_idempotency_key(ctx.org_id, &idempotency_key)
        .await?;
    let result = async {
        let run = {
            let data = store.data.lock().await;
            fetch_run_in_data(&data, ctx, run_id)?
        };
        let metric_store = store.metric_store_for_org(ctx.org_id).await?;
        let existing_batch = ch_traces::trace_ingest_batch(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &idempotency_key,
        )
        .await?;
        if let Some(existing) = existing_batch.as_ref() {
            if existing.body_hash != request_hash {
                return Err(AppError::conflict(
                    "idempotency key was already used with a different request body",
                ));
            }
            if existing.status == "accepted" {
                return serde_json::from_str::<TraceIngestResponse>(&existing.response_json)
                    .map_err(|_| {
                        AppError::internal("stored trace idempotency response is invalid")
                    });
            }
        }
        ensure_billing_write_allowed(store, ctx.org_id, "log trace events").await?;

        let events = validate_trace_events(input.events)?;
        let unique_event_count = events
            .iter()
            .map(|event| event.input.event_id)
            .collect::<BTreeSet<_>>()
            .len() as i64;
        let capacity_lock = store.trace_ingest_capacity_lock(ctx.org_id).await;
        let _capacity_guard = capacity_lock.lock().await;
        enforce_plan_capacity(
            store,
            ctx.org_id,
            UsageDelta {
                trace_events: unique_event_count,
                ..UsageDelta::default()
            },
            "log trace events",
        )
        .await?;

        let now = Utc::now();
        let trace_ids = events
            .iter()
            .map(|event| event.trace_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let event_ids = events
            .iter()
            .map(|event| event.input.event_id.to_string())
            .collect::<Vec<_>>();
        if existing_batch.is_none() {
            let pending = TraceIngestBatchRow {
                org_id: ctx.org_id,
                project_id: run.project_id,
                run_id: run.id,
                idempotency_key: idempotency_key.clone(),
                status: "pending".to_string(),
                body_hash: request_hash.clone(),
                response_json: String::new(),
                trace_ids: trace_ids.clone(),
                event_ids: event_ids.clone(),
                usage_event_count: 0,
                billing_period: trace_billing_period(now),
                accepted_at: now,
            };
            ch_traces::insert_trace_ingest_batch(&metric_store, &pending).await?;
        }
        let event_rows = events
            .iter()
            .map(|event| trace_event_row(ctx.org_id, &run, event, &idempotency_key, now))
            .collect::<Vec<_>>();
        let index_rows = events
            .iter()
            .map(|event| trace_index_row(ctx.org_id, &run, event, &idempotency_key, now))
            .collect::<Vec<_>>();

        ch_traces::insert_trace_span_events(&metric_store, &event_rows).await?;
        ch_traces::insert_trace_span_index(&metric_store, &index_rows).await?;

        let summary_rows = recompute_trace_summaries(
            &metric_store,
            ctx.org_id,
            &run,
            &trace_ids,
            &idempotency_key,
            now,
        )
        .await?;
        ch_traces::insert_trace_summaries(&metric_store, &summary_rows).await?;

        let response = TraceIngestResponse {
            inserted: event_rows.len(),
            trace_ids: trace_ids.clone(),
            summary_updates: summary_rows.len(),
        };
        let batch = TraceIngestBatchRow {
            org_id: ctx.org_id,
            project_id: run.project_id,
            run_id: run.id,
            idempotency_key: idempotency_key.clone(),
            status: "accepted".to_string(),
            body_hash: request_hash.clone(),
            response_json: serde_json::to_string(&response)
                .map_err(|_| AppError::internal("trace response serialization failed"))?,
            trace_ids,
            event_ids,
            usage_event_count: unique_event_count as u32,
            billing_period: trace_billing_period(now),
            accepted_at: now,
        };
        ch_traces::insert_trace_ingest_batch(&metric_store, &batch).await?;
        Ok(response)
    }
    .await;
    store
        .release_idempotency_key(ctx.org_id, &idempotency_key)
        .await;
    result
}

pub async fn list_traces(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<TraceListResponse> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_TRACE_LIST_LIMIT,
        MAX_TRACE_LIST_LIMIT,
    )?;
    let (project_id, run_id) = trace_project_scope(store, ctx, query).await?;
    let status = optional_trace_status(query.get("status").map(String::as_str))?;
    let kind = optional_trace_kind(query.get("kind").map(String::as_str))?;
    let q = trace_search_query(query)?;
    let window = trace_list_window(query, run_id, Utc::now())?;
    if let (Some(from), Some(to)) = (&window.from, &window.to) {
        if to <= from {
            return Err(AppError::validation("to must be after from"));
        }
    }
    let min_step = query
        .get("min_step")
        .map(|value| validate_query_step(value, "min_step"))
        .transpose()?;
    let max_step = query
        .get("max_step")
        .map(|value| validate_query_step(value, "max_step"))
        .transpose()?;
    if matches!((min_step, max_step), (Some(min_step), Some(max_step)) if min_step > max_step) {
        return Err(AppError::validation(
            "min_step must be less than or equal to max_step",
        ));
    }
    let cursor = query
        .get("cursor")
        .map(|value| decode_trace_list_cursor(value))
        .transpose()?;

    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let rows = ch_traces::list_trace_summaries(
        &metric_store,
        ctx.org_id,
        &TraceListQuery {
            project_id,
            run_id,
            status,
            kind,
            q,
            from: window.from,
            to: window.to,
            min_step,
            max_step,
            cursor,
            limit: limit + 1,
        },
    )
    .await?;
    let has_more = rows.len() as i64 > limit;
    let visible_rows = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let next_cursor = if has_more {
        visible_rows.last().map(|row| {
            encode_trace_list_cursor(&TraceListCursor {
                started_at: row.started_at,
                trace_id: row.trace_id.clone(),
            })
        })
    } else {
        None
    }
    .transpose()?;

    let data = store.data.lock().await;
    let traces = visible_rows
        .into_iter()
        .map(|row| trace_summary_item(&data, row))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(TraceListResponse {
        traces,
        next_cursor,
        limit,
    })
}

pub async fn trace_detail(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    trace_id: String,
    query: &HashMap<String, String>,
) -> AppResult<TraceDetailResponse> {
    let span_limit = validate_limit(
        query.get("span_limit").map(String::as_str),
        DEFAULT_TRACE_SPAN_LIMIT,
        MAX_TRACE_SPAN_LIMIT,
    )?;
    validate_trace_id(&trace_id, "trace_id")?;
    let run = {
        let data = store.data.lock().await;
        fetch_run_in_data(&data, ctx, run_id)?
    };
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let (mut root_rows, total_span_count, root_count, orphan_count) = tokio::try_join!(
        ch_traces::root_span_ids(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &trace_id,
            span_limit + 1,
        ),
        ch_traces::total_span_count(&metric_store, ctx.org_id, run.project_id, run.id, &trace_id,),
        ch_traces::root_count(&metric_store, ctx.org_id, run.project_id, run.id, &trace_id),
        ch_traces::orphan_count(&metric_store, ctx.org_id, run.project_id, run.id, &trace_id),
    )?;
    if total_span_count == 0 {
        return Err(AppError::not_found("trace not found"));
    }

    let has_more_roots = root_rows.len() as i64 > span_limit;
    let spans = if root_rows.is_empty() {
        ch_traces::canonical_spans_for_summary(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &trace_id,
            None,
            span_limit,
        )
        .await?
    } else {
        root_rows.truncate(span_limit as usize);
        let span_ids = root_rows
            .iter()
            .map(|row| row.span_id.clone())
            .collect::<Vec<_>>();
        ch_traces::canonical_spans_by_id(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &trace_id,
            &span_ids,
        )
        .await?
    };
    let span_window_truncated = if root_count == 0 {
        total_span_count > span_limit as u64
    } else {
        root_count > span_limit as u64
    };
    let span_ids = spans
        .iter()
        .map(|span| span.span_id.clone())
        .collect::<Vec<_>>();
    let child_counts = child_count_map(
        ch_traces::child_counts(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &trace_id,
            &span_ids,
        )
        .await?,
    );
    let summary = summary_from_spans(
        &run,
        &trace_id,
        &spans,
        total_span_count,
        root_count,
        orphan_count,
    )?;
    let items = spans
        .into_iter()
        .map(|span| trace_span_item(span, &child_counts))
        .collect::<AppResult<Vec<_>>>()?;
    let partial_tree = total_span_count > items.len() as u64;
    let root_next_cursor = if has_more_roots {
        root_rows.last().map(encode_trace_child_cursor)
    } else {
        None
    }
    .transpose()?;
    Ok(TraceDetailResponse {
        trace: summary,
        spans: items,
        limits: crate::domain::TraceDetailLimits {
            span_limit,
            max_span_limit: MAX_TRACE_SPAN_LIMIT,
        },
        truncated: crate::domain::TraceDetailTruncation {
            spans: span_window_truncated,
            payloads: false,
            partial_tree,
        },
        root_next_cursor,
    })
}

pub async fn trace_children(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    trace_id: String,
    query: &HashMap<String, String>,
) -> AppResult<TraceChildrenResponse> {
    validate_trace_id(&trace_id, "trace_id")?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_TRACE_CHILD_LIMIT,
        MAX_TRACE_CHILD_LIMIT,
    )?;
    let parent_span_id = query
        .get("parent_span_id")
        .map(|value| {
            if value.is_empty() {
                Ok(String::new())
            } else {
                validate_span_id(value, "parent_span_id")
            }
        })
        .transpose()?
        .unwrap_or_default();
    let cursor = query
        .get("cursor")
        .map(|value| decode_trace_child_cursor(value))
        .transpose()?;
    let run = {
        let data = store.data.lock().await;
        fetch_run_in_data(&data, ctx, run_id)?
    };
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let (total_span_count, child_rows, child_count) = tokio::try_join!(
        ch_traces::total_span_count(&metric_store, ctx.org_id, run.project_id, run.id, &trace_id,),
        ch_traces::child_span_ids(
            &metric_store,
            ch_traces::TraceSpanWindowQuery {
                org_id: ctx.org_id,
                project_id: run.project_id,
                run_id: run.id,
                trace_id: &trace_id,
                parent_span_id: &parent_span_id,
                limit: limit + 1,
                cursor,
            },
        ),
        ch_traces::child_count_for_parent(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &trace_id,
            &parent_span_id,
        ),
    )?;
    if total_span_count == 0 {
        return Err(AppError::not_found("trace not found"));
    }
    let has_more = child_rows.len() as i64 > limit;
    let visible_rows = child_rows
        .into_iter()
        .take(limit as usize)
        .collect::<Vec<_>>();
    let span_ids = visible_rows
        .iter()
        .map(|row| row.span_id.clone())
        .collect::<Vec<_>>();
    let spans = ch_traces::canonical_spans_by_id(
        &metric_store,
        ctx.org_id,
        run.project_id,
        run.id,
        &trace_id,
        &span_ids,
    )
    .await?;
    let child_counts = child_count_map(
        ch_traces::child_counts(
            &metric_store,
            ctx.org_id,
            run.project_id,
            run.id,
            &trace_id,
            &span_ids,
        )
        .await?,
    );
    let items = spans
        .into_iter()
        .map(|span| trace_span_item(span, &child_counts))
        .collect::<AppResult<Vec<_>>>()?;
    let next_cursor = if has_more {
        visible_rows.last().map(encode_trace_child_cursor)
    } else {
        None
    }
    .transpose()?;
    let omitted = child_count.saturating_sub(items.len() as u64);
    Ok(TraceChildrenResponse {
        parent_span_id: none_if_empty(parent_span_id),
        returned: items.len(),
        spans: items,
        next_cursor,
        child_count,
        omitted,
    })
}

fn trace_event_row(
    org_id: Uuid,
    run: &RunRow,
    event: &ValidTraceEvent,
    idempotency_key: &str,
    now: DateTime<Utc>,
) -> TraceSpanEventRow {
    TraceSpanEventRow {
        org_id,
        project_id: run.project_id,
        run_id: run.id,
        trace_id: event.trace_id.clone(),
        span_id: event.span_id.clone(),
        parent_span_id: event.parent_span_id.clone(),
        idempotency_key: idempotency_key.to_string(),
        event_id: event.input.event_id,
        sequence: event.input.sequence,
        event_kind: event.event_kind.clone(),
        name: event.name.clone(),
        kind: event.kind.clone(),
        status: event.status.clone(),
        step: event.input.step,
        rank: event.input.rank,
        thread_id: event.thread_id.clone(),
        rollout_id: event.rollout_id.clone(),
        started_at: event.started_at,
        ended_at: event.ended_at,
        duration_ms: event.duration_ms,
        input_preview: event.input_preview.clone(),
        output_preview: event.output_preview.clone(),
        error_type: event.error_type.clone(),
        error_preview: event.error_preview.clone(),
        attributes_json: event.attributes_json.clone(),
        metrics_json: event.metrics_json.clone(),
        links_json: event.links_json.clone(),
        content_policy: event.content_policy.clone(),
        redaction_state: event.redaction_state.clone(),
        truncated: event.truncated as u8,
        created_at: now,
    }
}

fn trace_index_row(
    org_id: Uuid,
    run: &RunRow,
    event: &ValidTraceEvent,
    idempotency_key: &str,
    now: DateTime<Utc>,
) -> TraceSpanIndexRow {
    TraceSpanIndexRow {
        org_id,
        project_id: run.project_id,
        run_id: run.id,
        trace_id: event.trace_id.clone(),
        span_id: event.span_id.clone(),
        parent_span_id: event.parent_span_id.clone(),
        idempotency_key: idempotency_key.to_string(),
        event_id: event.input.event_id,
        name: event.name.clone(),
        kind: event.kind.clone(),
        step: event.input.step,
        rank: event.input.rank,
        thread_id: event.thread_id.clone(),
        rollout_id: event.rollout_id.clone(),
        started_at: event.started_at,
        created_at: now,
    }
}

async fn recompute_trace_summaries(
    metric_store: &MetricStore,
    org_id: Uuid,
    run: &RunRow,
    trace_ids: &[String],
    idempotency_key: &str,
    now: DateTime<Utc>,
) -> AppResult<Vec<TraceSummaryRow>> {
    let all_spans = ch_traces::canonical_spans_for_summary_batch(
        metric_store,
        org_id,
        run.project_id,
        run.id,
        trace_ids,
        Some(idempotency_key),
        TRACE_SUMMARY_RECOMPUTE_LIMIT,
    )
    .await?;
    let mut spans_by_trace: BTreeMap<String, Vec<TraceSpanCanonicalRow>> = BTreeMap::new();
    for span in all_spans {
        spans_by_trace
            .entry(span.trace_id.clone())
            .or_default()
            .push(span);
    }
    let mut rows = Vec::with_capacity(trace_ids.len());
    for trace_id in trace_ids {
        let mut spans = spans_by_trace.remove(trace_id).unwrap_or_default();
        if spans.is_empty() {
            continue;
        }
        let summary_scan_truncated = spans.len() >= TRACE_SUMMARY_RECOMPUTE_LIMIT as usize;
        if summary_scan_truncated {
            spans.truncate(TRACE_SUMMARY_VISIBLE_SPAN_LIMIT);
        }
        rows.push(summary_row_from_spans(
            org_id,
            run,
            trace_id,
            idempotency_key,
            &spans,
            summary_scan_truncated,
            now,
        )?);
    }
    Ok(rows)
}

fn summary_row_from_spans(
    org_id: Uuid,
    run: &RunRow,
    trace_id: &str,
    idempotency_key: &str,
    spans: &[TraceSpanCanonicalRow],
    summary_scan_truncated: bool,
    now: DateTime<Utc>,
) -> AppResult<TraceSummaryRow> {
    let aggregate = aggregate_trace_spans(spans)?;
    let attributes = json!({
        "root_count": aggregate.root_count,
        "orphan_span_count": aggregate.orphan_span_count
    });
    Ok(TraceSummaryRow {
        org_id,
        project_id: run.project_id,
        run_id: run.id,
        trace_id: trace_id.to_string(),
        idempotency_key: idempotency_key.to_string(),
        event_id: Uuid::new_v4(),
        root_span_id: aggregate.root.span_id.clone(),
        root_name: aggregate.root.name.clone(),
        status: aggregate.status.to_string(),
        kinds: aggregate.kinds,
        started_at: aggregate.started_at,
        ended_at: aggregate.ended_at,
        duration_ms: aggregate.duration_ms,
        span_count: spans.len().min(u32::MAX as usize) as u32,
        running_span_count: saturating_u32(aggregate.running_span_count),
        error_count: saturating_u32(aggregate.error_count),
        model_call_count: saturating_u32(aggregate.model_call_count),
        tool_call_count: saturating_u32(aggregate.tool_call_count),
        retrieval_count: saturating_u32(aggregate.retrieval_count),
        reward_count: saturating_u32(aggregate.reward_count),
        input_tokens: aggregate.input_tokens,
        output_tokens: aggregate.output_tokens,
        cost_usd: aggregate.cost_usd,
        min_step: aggregate.min_step,
        max_step: aggregate.max_step,
        thread_id: aggregate.root.thread_id.clone(),
        rollout_id: aggregate.root.rollout_id.clone(),
        summary_metrics_json: serde_json::to_string(&aggregate.summary_metrics)
            .map_err(|_| AppError::internal("trace summary metrics serialization failed"))?,
        attributes_json: serde_json::to_string(&attributes)
            .map_err(|_| AppError::internal("trace summary attributes serialization failed"))?,
        content_available: aggregate.content_available as u8,
        truncated: (summary_scan_truncated || aggregate.payloads_truncated) as u8,
        updated_at: now,
    })
}

struct TraceSpanAggregate<'a> {
    root: &'a TraceSpanCanonicalRow,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    duration_ms: Option<f64>,
    kinds: Vec<String>,
    status: &'static str,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: Option<f64>,
    min_step: Option<f64>,
    max_step: Option<f64>,
    summary_metrics: Value,
    running_span_count: u64,
    error_count: u64,
    model_call_count: u64,
    tool_call_count: u64,
    retrieval_count: u64,
    reward_count: u64,
    root_count: u64,
    orphan_span_count: u64,
    content_available: bool,
    payloads_truncated: bool,
}

fn aggregate_trace_spans(spans: &[TraceSpanCanonicalRow]) -> AppResult<TraceSpanAggregate<'_>> {
    let root = spans
        .iter()
        .filter(|span| span.parent_span_id.is_empty())
        .min_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| a.span_id.cmp(&b.span_id))
        })
        .or_else(|| spans.first())
        .ok_or_else(|| AppError::not_found("trace not found"))?;
    let started_at = spans
        .iter()
        .map(|span| span.started_at)
        .min()
        .unwrap_or(root.started_at);
    let ended_at = spans.iter().filter_map(|span| span.ended_at).max();
    let duration_ms =
        ended_at.map(|ended| (ended - started_at).num_microseconds().unwrap_or(0) as f64 / 1000.0);
    let mut kinds = spans
        .iter()
        .map(|span| span.kind.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    kinds.sort();
    let (input_tokens, output_tokens, cost_usd, summary_metrics) = summary_metrics(spans)?;
    let steps = spans
        .iter()
        .filter_map(|span| span.step)
        .collect::<Vec<_>>();
    let span_ids = spans
        .iter()
        .map(|span| span.span_id.as_str())
        .collect::<BTreeSet<_>>();
    Ok(TraceSpanAggregate {
        root,
        started_at,
        ended_at,
        duration_ms,
        kinds,
        status: summary_status(spans),
        input_tokens,
        output_tokens,
        cost_usd,
        min_step: steps.iter().copied().reduce(f64::min),
        max_step: steps.iter().copied().reduce(f64::max),
        summary_metrics,
        running_span_count: spans.iter().filter(|span| span.status == "running").count() as u64,
        error_count: spans.iter().filter(|span| span.status == "error").count() as u64,
        model_call_count: spans.iter().filter(|span| span.kind == "model").count() as u64,
        tool_call_count: spans.iter().filter(|span| span.kind == "tool").count() as u64,
        retrieval_count: spans.iter().filter(|span| span.kind == "retrieval").count() as u64,
        reward_count: spans.iter().filter(|span| span.kind == "reward").count() as u64,
        root_count: spans
            .iter()
            .filter(|span| span.parent_span_id.is_empty())
            .count() as u64,
        orphan_span_count: spans
            .iter()
            .filter(|span| !span.parent_span_id.is_empty())
            .filter(|span| !span_ids.contains(span.parent_span_id.as_str()))
            .count() as u64,
        content_available: spans
            .iter()
            .any(|span| !span.input_preview.is_empty() || !span.output_preview.is_empty()),
        payloads_truncated: spans.iter().any(|span| span.truncated != 0),
    })
}

fn saturating_u32(value: u64) -> u32 {
    value.min(u32::MAX as u64) as u32
}

fn summary_status(spans: &[TraceSpanCanonicalRow]) -> &'static str {
    if spans.iter().any(|span| span.status == "error") {
        "error"
    } else if spans.iter().any(|span| span.status == "running") {
        "running"
    } else if spans.iter().any(|span| span.status == "cancelled") {
        "cancelled"
    } else if spans.iter().all(|span| span.status == "interrupted") {
        "interrupted"
    } else {
        "ok"
    }
}

fn summary_metrics(spans: &[TraceSpanCanonicalRow]) -> AppResult<(u64, u64, Option<f64>, Value)> {
    let mut input_tokens = 0_u64;
    let mut output_tokens = 0_u64;
    let mut cost_usd = 0.0_f64;
    let mut has_cost = false;
    let mut summary = Map::new();
    for span in spans {
        let metrics = json_from_str(&span.metrics_json)?;
        if let Some(object) = metrics.as_object() {
            for (key, value) in object {
                if let Some(number) = value.as_f64() {
                    if key == "gen_ai.usage.input_tokens" {
                        input_tokens = input_tokens.saturating_add(number.max(0.0) as u64);
                    } else if key == "gen_ai.usage.output_tokens" {
                        output_tokens = output_tokens.saturating_add(number.max(0.0) as u64);
                    } else if key == "gen_ai.usage.cost_usd" || key == "cost_usd" {
                        cost_usd += number.max(0.0);
                        has_cost = true;
                    } else if key.starts_with("reward.") {
                        summary.insert(key.clone(), value.clone());
                    }
                }
            }
        }
    }
    Ok((
        input_tokens,
        output_tokens,
        has_cost.then_some(cost_usd),
        Value::Object(summary),
    ))
}

fn validate_trace_events(events: Vec<TraceEventInput>) -> AppResult<Vec<ValidTraceEvent>> {
    if events.is_empty() {
        return Err(AppError::validation(
            "events must include at least one trace event",
        ));
    }
    if events.len() > MAX_TRACE_EVENTS_PER_BATCH {
        return Err(AppError::validation(format!(
            "events cannot include more than {MAX_TRACE_EVENTS_PER_BATCH} trace events"
        )));
    }
    let mut seen = BTreeSet::new();
    let mut seen_span_sequences = BTreeSet::new();
    let mut span_parent_ids: HashMap<(String, String), String> = HashMap::new();
    let mut out = Vec::with_capacity(events.len());
    for (index, input) in events.into_iter().enumerate() {
        if !seen.insert(input.event_id) {
            return Err(AppError::validation(format!(
                "events[{index}].event_id is duplicated in this request"
            )));
        }
        let trace_id = validate_trace_id(&input.trace_id, "trace_id")?;
        let span_id = validate_span_id(&input.span_id, "span_id")?;
        if !seen_span_sequences.insert((trace_id.clone(), span_id.clone(), input.sequence)) {
            return Err(AppError::validation(format!(
                "events[{index}].sequence is duplicated for this span"
            )));
        }
        let mut parent_span_id = input
            .parent_span_id
            .as_deref()
            .map(|value| validate_span_id(value, "parent_span_id"))
            .transpose()?
            .unwrap_or_default();
        if parent_span_id == span_id {
            return Err(AppError::validation(
                "parent_span_id cannot be the same as span_id",
            ));
        }
        let span_key = (trace_id.clone(), span_id.clone());
        if let Some(previous_parent_span_id) = span_parent_ids.get(&span_key).cloned() {
            if previous_parent_span_id != parent_span_id {
                if parent_span_id.is_empty() && !previous_parent_span_id.is_empty() {
                    parent_span_id = previous_parent_span_id;
                } else {
                    return Err(AppError::validation(format!(
                        "events[{index}].parent_span_id changes an existing span parent"
                    )));
                }
            }
        } else {
            span_parent_ids.insert(span_key, parent_span_id.clone());
        }
        let event_kind = validate_trace_event_kind(&input.event_kind)?;
        let kind = validate_trace_kind(&input.kind)?;
        let status = validate_trace_status(&input.status)?;
        let name = validate_short_string(&input.name, "name", MAX_TRACE_NAME_BYTES)?;
        let thread_id = optional_short_string(input.thread_id.as_deref(), "thread_id")?;
        let rollout_id = optional_short_string(input.rollout_id.as_deref(), "rollout_id")?;
        let started_at = parse_rfc3339(&input.started_at, "started_at")?;
        let ended_at = input
            .ended_at
            .as_deref()
            .map(|value| parse_rfc3339(value, "ended_at"))
            .transpose()?;
        let duration_ms = validate_optional_nonnegative_finite(input.duration_ms, "duration_ms")?;
        if let Some(ended_at) = ended_at {
            if ended_at < started_at - ChronoDuration::seconds(1) {
                return Err(AppError::validation(
                    "ended_at cannot be before started_at beyond clock skew tolerance",
                ));
            }
        }
        let duration_ms = duration_ms.or_else(|| {
            ended_at.map(|ended_at| {
                (ended_at - started_at)
                    .num_microseconds()
                    .unwrap_or(0)
                    .max(0) as f64
                    / 1000.0
            })
        });
        let step = validate_optional_finite(input.step, "step")?;
        let input_preview = validate_preview(input.input_preview.as_deref(), "input_preview")?;
        let output_preview = validate_preview(input.output_preview.as_deref(), "output_preview")?;
        let error_type = optional_short_string(input.error_type.as_deref(), "error_type")?;
        let error_preview = validate_preview(input.error_preview.as_deref(), "error_preview")?;
        let attributes_json = validate_json_object_payload(
            input.attributes.as_ref(),
            "attributes",
            MAX_TRACE_ATTRIBUTES_BYTES,
        )?;
        let metrics_json = validate_json_object_payload(
            input.metrics.as_ref(),
            "metrics",
            MAX_TRACE_METRICS_BYTES,
        )?;
        let links_json = validate_json_object_or_array_payload(
            input.links.as_ref(),
            "links",
            MAX_TRACE_LINKS_BYTES,
        )?;
        let content_policy = validate_trace_policy(
            input.content_policy.as_deref().unwrap_or("off"),
            "content_policy",
            &["off", "preview"],
        )?;
        let redaction_state = validate_trace_policy(
            input.redaction_state.as_deref().unwrap_or("not_captured"),
            "redaction_state",
            &["not_captured", "redacted", "truncated", "captured"],
        )?;
        if content_policy == "off"
            && (!input_preview.is_empty()
                || !output_preview.is_empty()
                || !error_preview.is_empty()
                || redaction_state == "captured")
        {
            return Err(AppError::validation(
                "content previews require content_policy=preview",
            ));
        }
        let truncated = input.truncated.unwrap_or(false);
        out.push(ValidTraceEvent {
            input: TraceEventInput {
                step,
                duration_ms,
                ..input
            },
            trace_id,
            span_id,
            parent_span_id,
            event_kind,
            name,
            kind,
            status,
            thread_id,
            rollout_id,
            started_at,
            ended_at,
            duration_ms,
            input_preview,
            output_preview,
            error_type,
            error_preview,
            attributes_json,
            metrics_json,
            links_json,
            content_policy,
            redaction_state,
            truncated,
        });
    }
    reject_batch_parent_cycle(&out)?;
    Ok(out)
}

fn reject_batch_parent_cycle(events: &[ValidTraceEvent]) -> AppResult<()> {
    let parents = events
        .iter()
        .map(|event| (event.span_id.as_str(), event.parent_span_id.as_str()))
        .collect::<HashMap<_, _>>();
    for span_id in parents.keys() {
        let mut seen = BTreeSet::new();
        let mut current = *span_id;
        while let Some(parent) = parents
            .get(current)
            .copied()
            .filter(|value| !value.is_empty())
        {
            if !seen.insert(current) || parent == *span_id {
                return Err(AppError::validation("trace batch contains a parent cycle"));
            }
            current = parent;
        }
    }
    Ok(())
}

async fn trace_project_scope(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<(Uuid, Option<Uuid>)> {
    if let Some(raw_run_id) = query.get("run_id").filter(|value| !value.is_empty()) {
        let run_id = Uuid::parse_str(raw_run_id)
            .map_err(|_| AppError::validation("run_id must be a UUID"))?;
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        return Ok((run.project_id, Some(run.id)));
    }
    let data = store.data.lock().await;
    let project_id =
        if let Some(raw_project_id) = query.get("project_id").filter(|value| !value.is_empty()) {
            Uuid::parse_str(raw_project_id)
                .map_err(|_| AppError::validation("project_id must be a UUID"))?
        } else if let Some(project_name) = query.get("project").filter(|value| !value.is_empty()) {
            *data
                .projects_by_org_name
                .get(&(ctx.org_id, project_name.to_string()))
                .ok_or_else(|| AppError::not_found("project not found"))?
        } else if let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) {
            project_id
        } else {
            return Err(AppError::validation(
                "project_id or run_id is required for trace list",
            ));
        };
    let project = data
        .projects
        .get(&project_id)
        .filter(|project| project.org_id == ctx.org_id)
        .ok_or_else(|| AppError::not_found("project not found"))?;
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .is_some_and(|auth_project_id| auth_project_id != project.id)
    {
        return Err(AppError::forbidden(
            "project belongs to a different API key",
        ));
    }
    Ok((project.id, None))
}

fn trace_summary_item(data: &StoreData, row: TraceSummaryReadRow) -> AppResult<TraceSummaryItem> {
    let run = data
        .runs
        .get(&row.run_id)
        .ok_or_else(|| AppError::not_found("run not found"))?;
    let project_name = data
        .projects
        .get(&row.project_id)
        .map(|project| project.name.clone())
        .unwrap_or_else(|| run.project.clone());
    Ok(TraceSummaryItem {
        trace_id: row.trace_id,
        run_id: row.run_id,
        project_id: row.project_id,
        project: project_name,
        run_name: run.name.clone(),
        root_span_id: row.root_span_id,
        root_name: row.root_name,
        status: row.status,
        kinds: row.kinds,
        started_at: row.started_at,
        ended_at: row.ended_at,
        duration_ms: row.duration_ms,
        span_count: row.span_count,
        running_span_count: row.running_span_count,
        error_count: row.error_count,
        model_call_count: row.model_call_count,
        tool_call_count: row.tool_call_count,
        retrieval_count: row.retrieval_count,
        reward_count: row.reward_count,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cost_usd: row.cost_usd,
        min_step: row.min_step,
        max_step: row.max_step,
        thread_id: none_if_empty(row.thread_id),
        rollout_id: none_if_empty(row.rollout_id),
        summary_metrics: json_from_str(&row.summary_metrics_json)?,
        attributes: json_from_str(&row.attributes_json)?,
        content_available: row.content_available != 0,
        truncated: row.truncated != 0,
        updated_at: row.updated_at,
    })
}

fn trace_span_item(
    span: TraceSpanCanonicalRow,
    child_counts: &HashMap<String, u64>,
) -> AppResult<TraceSpanItem> {
    let child_count = child_counts.get(&span.span_id).copied().unwrap_or(0);
    Ok(TraceSpanItem {
        trace_id: span.trace_id,
        span_id: span.span_id.clone(),
        parent_span_id: none_if_empty(span.parent_span_id),
        name: span.name,
        kind: span.kind,
        status: span.status,
        started_at: span.started_at,
        ended_at: span.ended_at,
        duration_ms: span.duration_ms,
        step: span.step,
        rank: span.rank,
        thread_id: none_if_empty(span.thread_id),
        rollout_id: none_if_empty(span.rollout_id),
        attributes: json_from_str(&span.attributes_json)?,
        metrics: json_from_str(&span.metrics_json)?,
        links: json_from_str(&span.links_json)?,
        input_preview: span.input_preview,
        output_preview: span.output_preview,
        error_type: none_if_empty(span.error_type),
        error_preview: span.error_preview,
        content_policy: span.content_policy,
        redaction_state: span.redaction_state,
        truncated: span.truncated != 0,
        child_count,
        returned_child_count: 0,
        omitted_child_count: child_count,
    })
}

fn summary_from_spans(
    run: &RunRow,
    trace_id: &str,
    spans: &[TraceSpanCanonicalRow],
    total_span_count: u64,
    root_count: u64,
    orphan_count: u64,
) -> AppResult<crate::domain::TraceDetailSummary> {
    let aggregate = aggregate_trace_spans(spans)?;
    let attributes = json!({
        "root_count": root_count,
        "orphan_span_count": orphan_count,
        "returned_span_count": spans.len()
    });
    Ok(crate::domain::TraceDetailSummary {
        trace_id: trace_id.to_string(),
        run_id: run.id,
        project_id: run.project_id,
        project: run.project.clone(),
        run_name: run.name.clone(),
        root_span_id: aggregate.root.span_id.clone(),
        root_name: aggregate.root.name.clone(),
        status: aggregate.status.to_string(),
        started_at: aggregate.started_at,
        ended_at: aggregate.ended_at,
        duration_ms: aggregate.duration_ms,
        span_count: total_span_count,
        running_span_count: aggregate.running_span_count,
        error_count: aggregate.error_count,
        content_available: aggregate.content_available,
        payloads_truncated: aggregate.payloads_truncated,
        summary_metrics: aggregate.summary_metrics,
        attributes,
        summary: json!({
            "run_name": run.name,
            "project": run.project,
            "returned_span_count": spans.len()
        }),
        total_span_count,
        root_count,
        orphan_count,
    })
}

fn child_count_map(rows: Vec<TraceChildCountRow>) -> HashMap<String, u64> {
    rows.into_iter()
        .map(|row| (row.parent_span_id, row.child_count))
        .collect()
}

fn validate_trace_id(value: &str, field: &str) -> AppResult<String> {
    validate_hex_id(value, field, 32)
}

fn validate_span_id(value: &str, field: &str) -> AppResult<String> {
    validate_hex_id(value, field, 16)
}

fn validate_hex_id(value: &str, field: &str, len: usize) -> AppResult<String> {
    if value.len() != len || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(AppError::validation(format!(
            "{field} must be {len} lowercase hex characters"
        )));
    }
    let value = value.to_ascii_lowercase();
    if value.chars().all(|ch| ch == '0') {
        return Err(AppError::validation(format!("{field} cannot be all zeros")));
    }
    Ok(value)
}

fn validate_trace_event_kind(value: &str) -> AppResult<String> {
    validate_trace_policy(
        value,
        "event_kind",
        &["started", "updated", "finished", "exception", "interrupted"],
    )
}

fn validate_trace_kind(value: &str) -> AppResult<String> {
    validate_trace_policy(
        value,
        "kind",
        &[
            "rollout",
            "env_step",
            "model",
            "tool",
            "retrieval",
            "reward",
            "evaluator",
            "dataset",
            "preprocessing",
            "postprocessing",
            "checkpoint",
            "artifact",
            "system",
            "custom",
        ],
    )
}

fn optional_trace_kind(value: Option<&str>) -> AppResult<Option<String>> {
    value
        .filter(|value| !value.is_empty() && *value != "all")
        .map(validate_trace_kind)
        .transpose()
}

fn validate_trace_status(value: &str) -> AppResult<String> {
    validate_trace_policy(
        value,
        "status",
        &["running", "ok", "error", "cancelled", "interrupted"],
    )
}

fn optional_trace_status(value: Option<&str>) -> AppResult<Option<String>> {
    value
        .filter(|value| !value.is_empty() && *value != "all")
        .map(validate_trace_status)
        .transpose()
}

fn validate_trace_policy(value: &str, field: &str, allowed: &[&str]) -> AppResult<String> {
    let value = validate_short_string(value, field, MAX_TRACE_FIELD_BYTES)?.to_ascii_lowercase();
    if allowed.iter().any(|candidate| *candidate == value) {
        Ok(value)
    } else {
        Err(AppError::validation(format!(
            "{field} must be one of: {}",
            allowed.join(", ")
        )))
    }
}

fn validate_short_string(value: &str, field: &str, max_bytes: usize) -> AppResult<String> {
    if value.trim().is_empty() {
        return Err(AppError::validation(format!("{field} is required")));
    }
    if value.len() > max_bytes {
        return Err(AppError::validation(format!(
            "{field} cannot exceed {max_bytes} bytes"
        )));
    }
    Ok(value.to_string())
}

fn optional_short_string(value: Option<&str>, field: &str) -> AppResult<String> {
    match value {
        Some(value) if !value.is_empty() => {
            validate_short_string(value, field, MAX_TRACE_FIELD_BYTES)
        }
        _ => Ok(String::new()),
    }
}

fn validate_preview(value: Option<&str>, field: &str) -> AppResult<String> {
    match value {
        Some(value) if value.len() > MAX_TRACE_PREVIEW_BYTES => Err(AppError::validation(format!(
            "{field} cannot exceed {MAX_TRACE_PREVIEW_BYTES} bytes"
        ))),
        Some(value) => Ok(value.to_string()),
        None => Ok(String::new()),
    }
}

fn validate_json_object_payload(
    value: Option<&Value>,
    field: &str,
    max_bytes: usize,
) -> AppResult<String> {
    let value = value.cloned().unwrap_or_else(|| json!({}));
    if !matches!(value, Value::Object(_)) {
        return Err(AppError::validation(format!(
            "{field} must be a JSON object"
        )));
    }
    validate_serialized_json_payload(value, field, max_bytes)
}

fn validate_json_object_or_array_payload(
    value: Option<&Value>,
    field: &str,
    max_bytes: usize,
) -> AppResult<String> {
    let value = value.cloned().unwrap_or_else(|| json!({}));
    if !matches!(value, Value::Object(_) | Value::Array(_)) {
        return Err(AppError::validation(format!(
            "{field} must be a JSON object or array"
        )));
    }
    validate_serialized_json_payload(value, field, max_bytes)
}

fn validate_serialized_json_payload(
    value: Value,
    field: &str,
    max_bytes: usize,
) -> AppResult<String> {
    let serialized = serde_json::to_string(&value)
        .map_err(|_| AppError::validation(format!("{field} must be valid JSON")))?;
    if serialized.len() > max_bytes {
        return Err(AppError::validation(format!(
            "{field} cannot exceed {max_bytes} serialized bytes"
        )));
    }
    Ok(serialized)
}

fn validate_optional_finite(value: Option<f64>, field: &str) -> AppResult<Option<f64>> {
    match value {
        Some(value) if !value.is_finite() => {
            Err(AppError::validation(format!("{field} must be finite")))
        }
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

fn validate_optional_nonnegative_finite(value: Option<f64>, field: &str) -> AppResult<Option<f64>> {
    match validate_optional_finite(value, field)? {
        Some(value) if value < 0.0 => Err(AppError::validation(format!(
            "{field} must be a nonnegative number"
        ))),
        value => Ok(value),
    }
}

fn parse_rfc3339(value: &str, field: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| AppError::validation(format!("{field} must be RFC3339 timestamp")))
}

fn json_from_str(value: &str) -> AppResult<Value> {
    serde_json::from_str(value).map_err(|_| AppError::internal("stored trace JSON is invalid"))
}

fn none_if_empty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn encode_trace_list_cursor(cursor: &TraceListCursor) -> AppResult<String> {
    let payload = json!({
        "started_at": cursor.started_at.to_rfc3339(),
        "trace_id": cursor.trace_id
    });
    let bytes = serde_json::to_vec(&payload)
        .map_err(|_| AppError::internal("trace cursor serialization failed"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_trace_list_cursor(value: &str) -> AppResult<TraceListCursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::validation("cursor is invalid"))?;
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor is invalid"))?;
    let started_at = payload
        .get("started_at")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("cursor is invalid"))
        .and_then(|value| parse_rfc3339(value, "cursor.started_at"))?;
    let trace_id = payload
        .get("trace_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("cursor is invalid"))
        .and_then(|value| validate_trace_id(value, "cursor.trace_id"))?;
    Ok(TraceListCursor {
        started_at,
        trace_id,
    })
}

fn encode_trace_child_cursor(row: &TraceSpanIndexReadRow) -> AppResult<String> {
    let payload = json!({
        "started_at": row.started_at.to_rfc3339(),
        "span_id": row.span_id
    });
    let bytes = serde_json::to_vec(&payload)
        .map_err(|_| AppError::internal("trace child cursor serialization failed"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_trace_child_cursor(value: &str) -> AppResult<(DateTime<Utc>, String)> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::validation("cursor is invalid"))?;
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor is invalid"))?;
    let started_at = payload
        .get("started_at")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("cursor is invalid"))
        .and_then(|value| parse_rfc3339(value, "cursor.started_at"))?;
    let span_id = payload
        .get("span_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("cursor is invalid"))
        .and_then(|value| validate_span_id(value, "cursor.span_id"))?;
    Ok((started_at, span_id))
}

#[cfg(test)]
fn datetime_from_millis(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
}

fn trace_billing_period(now: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", now.year(), now.month())
}

fn trace_list_window(
    query: &HashMap<String, String>,
    run_id: Option<Uuid>,
    now: DateTime<Utc>,
) -> AppResult<TraceListWindow> {
    let from = query
        .get("from")
        .map(|value| parse_rfc3339(value, "from"))
        .transpose()?;
    let to = query
        .get("to")
        .map(|value| parse_rfc3339(value, "to"))
        .transpose()?;
    if run_id.is_some() {
        return Ok(TraceListWindow { from, to });
    }
    Ok(TraceListWindow {
        from: Some(from.unwrap_or_else(|| now - ChronoDuration::days(DEFAULT_TRACE_LOOKBACK_DAYS))),
        to: Some(to.unwrap_or(now)),
    })
}

fn trace_search_query(query: &HashMap<String, String>) -> AppResult<Option<String>> {
    let q = match query.get("q") {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => Some(validate_short_string(value, "q", MAX_TRACE_FIELD_BYTES)?),
        None => None,
    };
    if q.as_deref()
        .is_some_and(|value| value.split_whitespace().count() > MAX_TRACE_SEARCH_TERMS)
    {
        return Err(AppError::validation(format!(
            "q cannot include more than {MAX_TRACE_SEARCH_TERMS} search terms"
        )));
    }
    Ok(q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn trace_id() -> String {
        "7bba9f33312b3dbb8b2c2c62bb7abe2d".to_string()
    }

    fn fixed_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 3, 12, 0, 0).unwrap()
    }

    fn canonical_span(
        span_id: &str,
        parent_span_id: &str,
        name: &str,
        kind: &str,
        status: &str,
        started_at: DateTime<Utc>,
        metrics_json: &str,
    ) -> TraceSpanCanonicalRow {
        TraceSpanCanonicalRow {
            trace_id: trace_id(),
            span_id: span_id.to_string(),
            parent_span_id: parent_span_id.to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
            status: status.to_string(),
            step: Some(7.0),
            rank: None,
            thread_id: "thread-a".to_string(),
            rollout_id: "rollout-a".to_string(),
            started_at,
            ended_at: Some(started_at + ChronoDuration::milliseconds(125)),
            duration_ms: Some(125.0),
            input_preview: String::new(),
            output_preview: String::new(),
            error_type: String::new(),
            error_preview: String::new(),
            attributes_json: "{}".to_string(),
            metrics_json: metrics_json.to_string(),
            links_json: "[]".to_string(),
            content_policy: "off".to_string(),
            redaction_state: "not_captured".to_string(),
            truncated: 0,
        }
    }

    #[test]
    fn trace_list_window_defaults_project_scope_to_recent_range() {
        let query = HashMap::new();
        let window = trace_list_window(&query, None, fixed_now()).unwrap();

        assert_eq!(
            window.from.unwrap().timestamp(),
            (fixed_now() - ChronoDuration::days(DEFAULT_TRACE_LOOKBACK_DAYS)).timestamp()
        );
        assert_eq!(window.to.unwrap().timestamp(), fixed_now().timestamp());
    }

    #[test]
    fn trace_list_window_leaves_run_scope_unbounded_without_explicit_dates() {
        let query = HashMap::new();
        let window = trace_list_window(&query, Some(Uuid::new_v4()), fixed_now()).unwrap();

        assert!(window.from.is_none());
        assert!(window.to.is_none());
    }

    #[test]
    fn trace_list_window_honors_explicit_run_scope_dates() {
        let mut query = HashMap::new();
        query.insert("from".to_string(), "2026-06-01T00:00:00Z".to_string());
        query.insert("to".to_string(), "2026-06-02T00:00:00Z".to_string());

        let window = trace_list_window(&query, Some(Uuid::new_v4()), fixed_now()).unwrap();

        assert_eq!(
            window.from.unwrap().to_rfc3339(),
            "2026-06-01T00:00:00+00:00"
        );
        assert_eq!(window.to.unwrap().to_rfc3339(), "2026-06-02T00:00:00+00:00");
    }

    #[test]
    fn trace_search_query_rejects_too_many_terms() {
        let mut query = HashMap::new();
        query.insert(
            "q".to_string(),
            "one two three four five six seven eight nine".to_string(),
        );

        assert!(trace_search_query(&query)
            .unwrap_err()
            .message()
            .contains("more than 8 search terms"));

        query.insert("q".to_string(), "   ".to_string());
        assert!(trace_search_query(&query).unwrap().is_none());
    }

    #[test]
    fn trace_event_validation_rejects_bad_ids_and_cycles() {
        let started_at = "2026-07-03T12:00:00Z".to_string();
        let parent = TraceEventInput {
            trace_id: trace_id(),
            span_id: "086e83747d0e381e".to_string(),
            parent_span_id: Some("1111111111111111".to_string()),
            event_id: Uuid::new_v4(),
            sequence: 1,
            event_kind: "started".to_string(),
            name: "root".to_string(),
            kind: "rollout".to_string(),
            status: "running".to_string(),
            step: Some(1.0),
            rank: None,
            thread_id: None,
            rollout_id: None,
            started_at: started_at.clone(),
            ended_at: None,
            duration_ms: None,
            input_preview: None,
            output_preview: None,
            error_type: None,
            error_preview: None,
            attributes: Some(json!({})),
            metrics: Some(json!({})),
            links: Some(json!([])),
            content_policy: Some("off".to_string()),
            redaction_state: Some("not_captured".to_string()),
            truncated: Some(false),
        };
        let mut child = parent.clone();
        child.span_id = "1111111111111111".to_string();
        child.parent_span_id = Some("086e83747d0e381e".to_string());
        child.event_id = Uuid::new_v4();

        assert!(validate_trace_events(vec![parent, child]).is_err());
    }

    #[test]
    fn trace_event_validation_rejects_parent_changes_within_batch() {
        let started_at = "2026-07-03T12:00:00Z".to_string();
        let first = TraceEventInput {
            trace_id: trace_id(),
            span_id: "086e83747d0e381e".to_string(),
            parent_span_id: Some("1111111111111111".to_string()),
            event_id: Uuid::new_v4(),
            sequence: 1,
            event_kind: "started".to_string(),
            name: "child".to_string(),
            kind: "model".to_string(),
            status: "running".to_string(),
            step: Some(1.0),
            rank: None,
            thread_id: None,
            rollout_id: None,
            started_at,
            ended_at: None,
            duration_ms: None,
            input_preview: None,
            output_preview: None,
            error_type: None,
            error_preview: None,
            attributes: Some(json!({})),
            metrics: Some(json!({})),
            links: Some(json!([])),
            content_policy: Some("off".to_string()),
            redaction_state: Some("not_captured".to_string()),
            truncated: Some(false),
        };
        let mut changed_parent = first.clone();
        changed_parent.event_id = Uuid::new_v4();
        changed_parent.sequence = 2;
        changed_parent.parent_span_id = Some("2222222222222222".to_string());

        assert!(validate_trace_events(vec![first.clone(), changed_parent]).is_err());

        let mut omitted_parent_finish = first.clone();
        omitted_parent_finish.event_id = Uuid::new_v4();
        omitted_parent_finish.sequence = 2;
        omitted_parent_finish.event_kind = "finished".to_string();
        omitted_parent_finish.status = "ok".to_string();
        omitted_parent_finish.parent_span_id = None;
        let normalized = validate_trace_events(vec![first, omitted_parent_finish]).unwrap();
        assert_eq!(normalized[1].parent_span_id, "1111111111111111");
    }

    #[test]
    fn trace_event_validation_enforces_preview_policy_and_derives_duration() {
        let event = TraceEventInput {
            trace_id: trace_id(),
            span_id: "086e83747d0e381e".to_string(),
            parent_span_id: None,
            event_id: Uuid::new_v4(),
            sequence: 1,
            event_kind: "finished".to_string(),
            name: "rollout".to_string(),
            kind: "rollout".to_string(),
            status: "ok".to_string(),
            step: Some(1.0),
            rank: None,
            thread_id: None,
            rollout_id: None,
            started_at: "2026-07-03T12:00:00Z".to_string(),
            ended_at: Some("2026-07-03T12:00:01.250Z".to_string()),
            duration_ms: None,
            input_preview: Some("secret".to_string()),
            output_preview: None,
            error_type: None,
            error_preview: None,
            attributes: Some(json!({})),
            metrics: Some(json!({})),
            links: Some(json!([])),
            content_policy: Some("off".to_string()),
            redaction_state: Some("not_captured".to_string()),
            truncated: Some(false),
        };
        assert!(validate_trace_events(vec![event.clone()]).is_err());

        let accepted = TraceEventInput {
            input_preview: None,
            content_policy: Some("preview".to_string()),
            redaction_state: Some("truncated".to_string()),
            ..event.clone()
        };
        let validated = validate_trace_events(vec![accepted]).unwrap();
        assert_eq!(validated[0].duration_ms, Some(1250.0));

        let invalid_attributes = TraceEventInput {
            attributes: Some(json!(["not", "an", "object"])),
            input_preview: None,
            content_policy: Some("preview".to_string()),
            redaction_state: Some("truncated".to_string()),
            ..event
        };
        assert!(validate_trace_events(vec![invalid_attributes]).is_err());
    }

    #[test]
    fn trace_cursor_round_trips() {
        let cursor = TraceListCursor {
            started_at: datetime_from_millis(1_780_000_000_000),
            trace_id: trace_id(),
        };
        let encoded = encode_trace_list_cursor(&cursor).unwrap();
        let decoded = decode_trace_list_cursor(&encoded).unwrap();
        assert_eq!(decoded.trace_id, cursor.trace_id);
        assert_eq!(
            decoded.started_at.timestamp_millis(),
            cursor.started_at.timestamp_millis()
        );
    }

    #[test]
    fn trace_child_cursor_round_trips() {
        let row = TraceSpanIndexReadRow {
            span_id: "086e83747d0e381e".to_string(),
            parent_span_id: String::new(),
            started_at: datetime_from_millis(1_780_000_000_000),
        };
        let encoded = encode_trace_child_cursor(&row).unwrap();
        let (started_at, span_id) = decode_trace_child_cursor(&encoded).unwrap();
        assert_eq!(span_id, row.span_id);
        assert_eq!(
            started_at.timestamp_millis(),
            row.started_at.timestamp_millis()
        );
    }

    #[test]
    fn aggregate_trace_spans_pins_summary_semantics() {
        let root = canonical_span(
            "2222222222222222",
            "",
            "rollout",
            "rollout",
            "running",
            fixed_now(),
            r#"{"gen_ai.usage.input_tokens":4}"#,
        );
        let earlier_root = canonical_span(
            "1111111111111111",
            "",
            "first-root",
            "tool",
            "ok",
            fixed_now() - ChronoDuration::seconds(2),
            r#"{"gen_ai.usage.output_tokens":2,"gen_ai.usage.cost_usd":0.25}"#,
        );
        let mut child = canonical_span(
            "3333333333333333",
            "2222222222222222",
            "reward.score",
            "reward",
            "error",
            fixed_now() + ChronoDuration::seconds(1),
            r#"{"reward.total":0.92,"cost_usd":0.5}"#,
        );
        child.input_preview = "{\"token\":\"[REDACTED]\"}".to_string();
        child.truncated = 1;
        let orphan = canonical_span(
            "4444444444444444",
            "5555555555555555",
            "orphan",
            "retrieval",
            "ok",
            fixed_now() + ChronoDuration::seconds(2),
            "{}",
        );

        let spans = [root, earlier_root, child, orphan];
        let aggregate = aggregate_trace_spans(&spans).expect("aggregate");

        assert_eq!(aggregate.root.span_id, "1111111111111111");
        assert_eq!(aggregate.status, "error");
        assert_eq!(aggregate.root_count, 2);
        assert_eq!(aggregate.orphan_span_count, 1);
        assert_eq!(aggregate.input_tokens, 4);
        assert_eq!(aggregate.output_tokens, 2);
        assert_eq!(aggregate.cost_usd, Some(0.75));
        assert_eq!(aggregate.reward_count, 1);
        assert_eq!(aggregate.retrieval_count, 1);
        assert!(aggregate.content_available);
        assert!(aggregate.payloads_truncated);
        assert_eq!(aggregate.summary_metrics["reward.total"], json!(0.92));
    }
}
