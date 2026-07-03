use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::json;

use crate::{
    domain::CreateTraceEventsRequest,
    errors::{AppError, AppResult},
    store,
};

use super::super::{observability, AppState};
use super::helpers::{
    context, header_text, parse_uuid, read_json_with_raw, require_scope,
    validate_session_mutation_origin,
};

const MAX_TRACE_IDEMPOTENCY_KEY_BYTES: usize = 200;

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/traces/events",
    tag = "traces",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("Idempotency-Key" = String, Header, description = "Stable client key used to deduplicate trace ingest retries"),
    ),
    request_body = crate::domain::CreateTraceEventsRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Accepted trace span events", body = crate::domain::TraceIngestResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 402, description = "Plan or payment limit prevents writing trace events", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Idempotency conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn log_trace_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<crate::domain::TraceIngestResponse>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let idempotency_key = trace_idempotency_key(&headers)?;
    let (input, raw) = read_json_with_raw::<CreateTraceEventsRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let result =
        store::ingest_trace_events(&state.store, &ctx, run_id, raw, input, idempotency_key).await;
    observability::run_mutation_outcome(
        ctx.org_id,
        "log_trace_events",
        None,
        Some(run_id),
        true,
        result.as_ref().err(),
    );
    Ok(Json(result?))
}

#[utoipa::path(
    get,
    path = "/api/traces",
    tag = "traces",
    params(
        ("project_id" = Option<String>, Query, description = "Project UUID. Required unless run_id or project is present."),
        ("project" = Option<String>, Query, description = "Project name fallback for local/dashboard callers"),
        ("run_id" = Option<String>, Query, description = "Exact run UUID"),
        ("status" = Option<String>, Query, description = "Trace status"),
        ("kind" = Option<String>, Query, description = "Trace span kind"),
        ("q" = Option<String>, Query, description = "Search root name, trace id prefix, rollout id, or thread id"),
        ("from" = Option<String>, Query, description = "RFC3339 lower bound over started_at"),
        ("to" = Option<String>, Query, description = "RFC3339 upper bound over started_at"),
        ("min_step" = Option<f64>, Query, description = "Minimum trace step overlap"),
        ("max_step" = Option<f64>, Query, description = "Maximum trace step overlap"),
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("cursor" = Option<String>, Query, description = "Opaque pagination cursor"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Trace summaries", body = crate::domain::TraceListResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Project or run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_traces(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<crate::domain::TraceListResponse>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(store::list_traces(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/traces/{trace_id}",
    tag = "traces",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("trace_id" = String, Path, description = "32-character trace id"),
        ("span_limit" = Option<i64>, Query, description = "Maximum spans returned in the initial tree window"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Trace tree window", body = crate::domain::TraceDetailResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run or trace not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_trace_detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((run_id, trace_id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<crate::domain::TraceDetailResponse>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::trace_detail(&state.store, &ctx, run_id, trace_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/traces/{trace_id}/spans",
    tag = "traces",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("trace_id" = String, Path, description = "32-character trace id"),
        ("parent_span_id" = Option<String>, Query, description = "Parent span id. Omit or pass an empty string to load roots."),
        ("limit" = Option<i64>, Query, description = "Maximum child spans returned"),
        ("cursor" = Option<String>, Query, description = "Opaque child pagination cursor"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Child span window", body = crate::domain::TraceChildrenResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run or trace not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_trace_children(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((run_id, trace_id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<crate::domain::TraceChildrenResponse>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::trace_children(&state.store, &ctx, run_id, trace_id, &query).await?,
    ))
}

#[allow(dead_code)]
fn _json_object_for_openapi_smoke() -> serde_json::Value {
    json!({})
}

fn trace_idempotency_key(headers: &HeaderMap) -> AppResult<String> {
    let key = header_text(headers, "idempotency-key")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("Idempotency-Key header is required"))?;
    if key.len() > MAX_TRACE_IDEMPOTENCY_KEY_BYTES {
        return Err(AppError::validation(format!(
            "Idempotency-Key cannot exceed {MAX_TRACE_IDEMPOTENCY_KEY_BYTES} bytes"
        )));
    }
    if key.chars().any(char::is_control) {
        return Err(AppError::validation(
            "Idempotency-Key cannot contain control characters",
        ));
    }
    Ok(key.to_string())
}
