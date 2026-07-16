use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    domain::{
        CompareMatchingRunsRequest, CreateConsoleLogsRequest, CreateProjectRequest,
        CreateRunForkRequest, CreateRunRequest, LogMetricsRequest, LogRankMetricsRequest,
        StopAckRequest, StopRunRequest, StopRunsRequest, UpdateRunRequest,
    },
    errors::{AppError, AppResult},
    store,
};

use super::super::{observability, AppState};
use super::helpers::{
    context, header_text, header_value, parse_uuid, read_json, read_json_with_raw, require_scope,
    validate_session_mutation_origin,
};

fn require_sdk_control_actor(ctx: &crate::domain::RequestContext) -> AppResult<()> {
    if ctx.session.is_some() {
        return Err(AppError::forbidden(
            "SDK stop polling and acknowledgement require an SDK API key",
        ));
    }
    Ok(())
}

#[utoipa::path(
    post,
    path = "/projects",
    tag = "runs",
    request_body = crate::domain::CreateProjectRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created or fetched project", body = crate::http::openapi::ProjectEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let input = read_json::<CreateProjectRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let result = store::create_project(&state.store, &ctx, input).await;
    observability::project_mutation_outcome(
        ctx.org_id,
        "create_project",
        result.as_ref().ok().map(|project| project.id),
        result.as_ref().err(),
    );
    let project = result?;
    Ok(Json(json!({ "project": project })))
}

#[utoipa::path(
    get,
    path = "/projects",
    tag = "runs",
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Projects for the caller's organization", body = crate::http::openapi::ProjectsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_projects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(
        json!({ "projects": store::list_projects(&state.store, &ctx).await? }),
    ))
}

#[utoipa::path(
    post,
    path = "/runs",
    tag = "runs",
    request_body = crate::domain::CreateRunRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created or attached run. `created` is false for idempotent replay, `mode=auto` attach, or `mode=resume`.", body = crate::http::openapi::RunCreatedEnvelope),
        (status = 400, description = "Validation error, invalid_run_id, invalid_run_mode, or resume without id", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 402, description = "Plan or payment limit prevents creating another run", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "run_not_found (resume/auto/create for a missing or cross-org id)", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "run_id_conflict or resume_project_mismatch", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let input = read_json::<CreateRunRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let result = store::create_run(&state.store, &ctx, input).await;
    observability::run_mutation_outcome(
        ctx.org_id,
        "create_run",
        result.as_ref().ok().map(|created| created.run.project_id),
        result.as_ref().ok().map(|created| created.run.id),
        false,
        result.as_ref().err(),
    );
    let created = result?;
    Ok(Json(
        json!({ "run": created.run, "created": created.created }),
    ))
}

#[utoipa::path(
    get,
    path = "/runs",
    tag = "runs",
    params(
        ("project" = Option<String>, Query, description = "Filter by project name"),
        ("status" = Option<String>, Query, description = "Filter by run status"),
        ("display_status" = Option<String>, Query, description = "Filter by derived display status: running, stopping, stopped, finished, or failed"),
        ("q" = Option<String>, Query, description = "Run search query. Bare text preserves legacy substring search; supports fields, boolean operators, and explicit re:/.../ regex."),
        ("sort_by" = Option<String>, Query, description = "Sort key: created, name, status, duration, metric-latest, or metric-best"),
        ("metric_key" = Option<String>, Query, description = "Metric key used by metric-latest and metric-best sorts"),
        ("limit" = Option<i64>, Query, description = "Page size (1..=1000)"),
        ("offset" = Option<i64>, Query, description = "Offset for pagination"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Page of runs", body = crate::http::openapi::RunSummariesEnvelope),
        (status = 400, description = "Invalid run search or query parameter", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_runs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(store::list_runs(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Run detail", body = crate::http::openapi::RunSummaryEnvelope),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        json!({ "run": store::get_run(&state.store, &ctx, run_id).await? }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/lineage",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Bounded direct lineage graph for the selected run", body = crate::http::openapi::RunLineageEnvelope),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_run_lineage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(store::run_lineage(&state.store, &ctx, run_id).await?))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/forks",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Source run UUID"),
        ("Idempotency-Key" = Option<String>, Header, description = "Stable client key used to deduplicate fork retries"),
    ),
    request_body = crate::domain::CreateRunForkRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created forked run", body = crate::http::openapi::RunForkEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 402, description = "Plan or payment limit prevents creating another run", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Source run or checkpoint not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Idempotency conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn fork_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "export:read", &state)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) =
        read_json_with_raw::<CreateRunForkRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let idempotency_key_present = idempotency_key.is_some();
    let result = store::fork_run(
        &state.store,
        &ctx,
        run_id,
        raw,
        input,
        idempotency_key,
        state.config.max_body_bytes,
    )
    .await;
    observability::run_mutation_outcome(
        ctx.org_id,
        "fork_run",
        result
            .as_ref()
            .ok()
            .and_then(|payload| uuid_from_value(payload, &["run", "project_id"])),
        result
            .as_ref()
            .ok()
            .and_then(|payload| uuid_from_value(payload, &["run", "id"])),
        idempotency_key_present,
        result.as_ref().err(),
    );
    Ok(Json(result?))
}

#[utoipa::path(
    patch,
    path = "/runs/{run_id}",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::UpdateRunRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Updated run", body = crate::http::openapi::RunEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn update_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<UpdateRunRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let result = store::update_run(&state.store, &ctx, run_id, input).await;
    observability::run_mutation_outcome(
        ctx.org_id,
        "update_run",
        result.as_ref().ok().map(|run| run.project_id),
        Some(run_id),
        false,
        result.as_ref().err(),
    );
    let run = result?;
    Ok(Json(json!({ "run": run })))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/stop",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("Idempotency-Key" = Option<String>, Header, description = "Stable client key used to deduplicate stop retries"),
    ),
    request_body = crate::domain::StopRunRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Recorded stop request", body = crate::http::openapi::RunStopEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing runs:control scope", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn stop_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "runs:control", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) =
        read_json_with_raw::<StopRunRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    Ok(Json(
        store::request_run_stop(&state.store, &ctx, run_id, raw, input, idempotency_key).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/runs/stop",
    tag = "runs",
    params(
        ("Idempotency-Key" = Option<String>, Header, description = "Stable client key used to deduplicate bulk stop retries"),
    ),
    request_body = crate::domain::StopRunsRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Recorded bulk stop requests", body = crate::http::openapi::RunStopBulkEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing runs:control scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn stop_runs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "runs:control", &state)?;
    let (input, raw) =
        read_json_with_raw::<StopRunsRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    Ok(Json(
        store::request_bulk_run_stop(&state.store, &ctx, raw, input, idempotency_key).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/stop-signal",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    security(("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Cooperative stop signal for SDK callers", body = crate::http::openapi::StopSignalEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing ingest scope", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn stop_signal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, true).await?;
    require_sdk_control_actor(&ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let mut response =
        Json(store::run_stop_signal(&state.store, &ctx, run_id).await?).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, header_value("private, no-store")?);
    response
        .headers_mut()
        .insert(header::PRAGMA, header_value("no-cache")?);
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/stop-ack",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::StopAckRequest,
    security(("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Acknowledged or completed stop request", body = crate::http::openapi::RunStopEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing ingest scope", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run or stop request not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Stop request id mismatch", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn stop_ack(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_sdk_control_actor(&ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<StopAckRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::acknowledge_run_stop(&state.store, &ctx, run_id, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/metrics",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::LogMetricsRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Inserted point count", body = crate::http::openapi::InsertedEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn log_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) =
        read_json_with_raw::<LogMetricsRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let metric_count = input
        .metrics
        .as_object()
        .map(|metrics| metrics.len())
        .unwrap_or(0);
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let idempotency_key_present = idempotency_key.is_some();
    let result = store::log_metrics(&state.store, &ctx, run_id, raw, input, idempotency_key).await;
    observability::metric_ingest(
        ctx.org_id,
        run_id,
        metric_count,
        result.as_ref().ok().copied(),
        idempotency_key_present,
        result.as_ref().err(),
    );
    let inserted = result?;
    Ok(Json(json!({ "inserted": inserted })))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/metrics/batch",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("Idempotency-Key" = Option<String>, Header, description = "Stable client key covering the whole batch"),
    ),
    request_body = crate::domain::LogMetricsBatchRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Inserted point count for the whole batch", body = crate::http::openapi::InsertedEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Idempotency conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn log_metrics_batch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) = read_json_with_raw::<crate::domain::LogMetricsBatchRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let metric_count = input
        .points
        .as_ref()
        .map(|points| {
            points
                .iter()
                .map(|point| point.metrics.as_object().map(|m| m.len()).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let idempotency_key_present = idempotency_key.is_some();
    let result =
        store::log_metrics_batch(&state.store, &ctx, run_id, raw, input, idempotency_key).await;
    observability::metric_ingest(
        ctx.org_id,
        run_id,
        metric_count,
        result.as_ref().ok().copied(),
        idempotency_key_present,
        result.as_ref().err(),
    );
    let inserted = result?;
    Ok(Json(json!({ "inserted": inserted })))
}

#[utoipa::path(
    post,
    path = "/runs/{run_id}/rank-metrics",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::LogRankMetricsRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Inserted rank metric point count", body = crate::http::openapi::InsertedEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn log_rank_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) =
        read_json_with_raw::<LogRankMetricsRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let metric_count = input
        .metrics
        .as_object()
        .map(|metrics| metrics.len())
        .unwrap_or(0);
    let rank = i64::from(input.rank);
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let idempotency_key_present = idempotency_key.is_some();
    let result =
        store::log_rank_metrics(&state.store, &ctx, run_id, raw, input, idempotency_key).await;
    observability::rank_metric_ingest(
        ctx.org_id,
        run_id,
        rank,
        metric_count,
        result.as_ref().ok().copied(),
        idempotency_key_present,
        result.as_ref().err(),
    );
    let inserted = result?;
    Ok(Json(json!({ "inserted": inserted })))
}

fn uuid_from_value(value: &Value, path: &[&str]) -> Option<Uuid> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
}

#[utoipa::path(
    get,
    path = "/runs/{run_id}/metrics",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("key" = Option<String>, Query, description = "Filter by metric key"),
        ("start_step" = Option<f64>, Query, description = "Inclusive start step"),
        ("end_step" = Option<f64>, Query, description = "Inclusive end step"),
        ("limit" = Option<i64>, Query, description = "Page size"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Bounded scalar metric points", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::get_metrics(&state.store, &ctx, run_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/rank-metrics/summary",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("key" = Option<String>, Query, description = "Rank metric key"),
        ("start_step" = Option<f64>, Query, description = "Inclusive start step"),
        ("end_step" = Option<f64>, Query, description = "Inclusive end step"),
        ("limit" = Option<i64>, Query, description = "Step limit"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Bounded rank metric summary", body = crate::domain::RankMetricsSummaryResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn rank_metrics_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let summary = store::rank_metrics_summary(&state.store, &ctx, run_id, &query).await?;
    Ok(Json(
        serde_json::to_value(summary).unwrap_or_else(|_| json!({})),
    ))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/logs",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::CreateConsoleLogsRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Number of inserted console log lines", body = crate::http::openapi::InsertedEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn log_console_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) = read_json_with_raw::<CreateConsoleLogsRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let stream = match input.stream.as_deref() {
        Some("stdout") | None => "stdout",
        Some("stderr") => "stderr",
        Some(_) => "invalid",
    };
    let line_count = input.lines.as_ref().map(|lines| lines.len()).unwrap_or(0);
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let idempotency_key_present = idempotency_key.is_some();
    let result =
        store::log_console_logs(&state.store, &ctx, run_id, raw, input, idempotency_key).await;
    observability::console_log_ingest(
        ctx.org_id,
        run_id,
        stream,
        line_count,
        result.as_ref().ok().copied(),
        idempotency_key_present,
        result.as_ref().err(),
    );
    let inserted = result?;
    Ok(Json(json!({ "inserted": inserted })))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/logs",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("stream" = Option<String>, Query, description = "stdout or stderr"),
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("cursor" = Option<String>, Query, description = "Pagination cursor"),
        ("q" = Option<String>, Query, description = "Substring filter"),
        ("tail" = Option<i64>, Query, description = "Return only the last N lines (1..=500) in ascending order; cannot be combined with cursor or q"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Console log page", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_console_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::list_console_logs(&state.store, &ctx, run_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/overview",
    tag = "runs",
    params(
        ("project" = Option<String>, Query, description = "Filter by project name"),
        ("status" = Option<String>, Query, description = "Filter by run status"),
        ("display_status" = Option<String>, Query, description = "Filter by derived display status: running, stopping, stopped, finished, or failed"),
        ("q" = Option<String>, Query, description = "Run search query. Bare text preserves legacy substring search; supports fields, boolean operators, and explicit re:/.../ regex."),
        ("metric_key" = Option<String>, Query, description = "Metric key for best-value column"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Dashboard overview payload", body = crate::http::openapi::JsonObjectResponse),
        (status = 400, description = "Invalid run search or query parameter", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(store::overview(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    get,
    path = "/api/runs/summary",
    tag = "runs",
    params(
        ("project" = Option<String>, Query, description = "Filter by project name"),
        ("status" = Option<String>, Query, description = "Filter by run status"),
        ("display_status" = Option<String>, Query, description = "Filter by derived display status: running, stopping, stopped, finished, or failed"),
        ("q" = Option<String>, Query, description = "Run search query. Bare text preserves legacy substring search; supports fields, boolean operators, and explicit re:/.../ regex."),
        ("sort_by" = Option<String>, Query, description = "Sort key"),
        ("metric_key" = Option<String>, Query, description = "Metric key for ranked column"),
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("offset" = Option<i64>, Query, description = "Offset for pagination"),
        ("cursor" = Option<String>, Query, description = "Pagination cursor"),
        ("projection" = Option<String>, Query, description = "Use selection for lightweight bulk-selection rows"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Run summary page with metric key catalog", body = crate::http::openapi::JsonObjectResponse),
        (status = 400, description = "Invalid run search or query parameter", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn runs_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(store::runs_summary(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    get,
    path = "/api/runs/side-by-side",
    tag = "runs",
    params(
        ("run_ids" = Option<String>, Query, description = "Comma-separated run UUIDs"),
        ("runs" = Option<String>, Query, description = "Alias for run_ids"),
        ("reference_run_id" = Option<String>, Query, description = "Pin a reference run"),
        ("diff_only" = Option<bool>, Query, description = "Only return rows that differ"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Side-by-side comparison rows", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn side_by_side(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    Ok(Json(store::side_by_side(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    post,
    path = "/api/runs/compare-query",
    tag = "runs",
    request_body = crate::domain::CompareMatchingRunsRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Filtered run comparison with selected candidate evidence", body = crate::http::openapi::JsonObjectResponse),
        (status = 400, description = "Invalid compare query", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Reference run not found in the visible query scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn compare_matching_runs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let input =
        read_json::<CompareMatchingRunsRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::compare_matching_runs(&state.store, &ctx, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/attributes",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
    ),
    request_body = crate::domain::CreateAttributesRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created attribute rows", body = crate::http::openapi::AttributesEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_attributes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<crate::domain::CreateAttributesRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    Ok(Json(
        json!({ "attributes": store::create_attributes(&state.store, &ctx, run_id, input).await? }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/attributes",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("type" = Option<String>, Query, description = "Filter by attribute kind"),
        ("path_prefix" = Option<String>, Query, description = "Filter by path prefix"),
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("offset" = Option<i64>, Query, description = "Offset for pagination"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Typed attribute rows for the run", body = crate::http::openapi::AttributesEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_attributes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        json!({ "attributes": store::list_attributes(&state.store, &ctx, run_id, &query).await? }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/runs/{run_id}/objects",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("Idempotency-Key" = Option<String>, Header, description = "Stable client key used to deduplicate object retries"),
    ),
    request_body = crate::domain::CreateObjectRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created rich object", body = crate::http::openapi::ObjectEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Idempotency conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_object(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) = read_json_with_raw::<crate::domain::CreateObjectRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    Ok(Json(json!({
        "object": store::create_object(&state.store, &ctx, run_id, raw, input, idempotency_key).await?
    })))
}

#[utoipa::path(
    get,
    path = "/api/runs/{run_id}/objects",
    tag = "runs",
    params(
        ("run_id" = String, Path, description = "Run UUID"),
        ("kind" = Option<String>, Query, description = "Filter by object kind"),
        ("key" = Option<String>, Query, description = "Filter by object key"),
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("offset" = Option<i64>, Query, description = "Offset for pagination"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Rich object page", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Run not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_objects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::list_objects(&state.store, &ctx, run_id, &query).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/objects/{object_id}/rows",
    tag = "runs",
    params(
        ("object_id" = i64, Path, description = "Object integer id"),
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("offset" = Option<i64>, Query, description = "Offset for pagination"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Table object rows", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Object not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_object_rows(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(object_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let object_id = object_id
        .parse::<i64>()
        .map_err(|_| crate::errors::AppError::not_found("object not found"))?;
    Ok(Json(
        store::list_object_rows(&state.store, &ctx, object_id, &query).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{RequestContext, SessionContext};

    #[test]
    fn sdk_stop_control_rejects_browser_session_context() {
        let ctx = RequestContext {
            org_id: Uuid::from_u128(1),
            auth: None,
            session: Some(SessionContext {
                session_id: Uuid::from_u128(2),
                user_id: Uuid::from_u128(3),
                role: "member".to_string(),
                demo_read_only: false,
                mcp_oauth: false,
            }),
        };

        let err = require_sdk_control_actor(&ctx).unwrap_err();
        assert_eq!(err.status(), axum::http::StatusCode::FORBIDDEN);
    }
}
