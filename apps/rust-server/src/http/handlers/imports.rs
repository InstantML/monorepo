use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::Value;

use crate::{errors::AppResult, store};

use super::super::{observability, AppState};
use super::helpers::{context, read_json_value, require_scope, validate_session_mutation_origin};

#[utoipa::path(
    get,
    path = "/api/imports",
    tag = "runs",
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Recent imports for the caller's tenant", body = crate::http::openapi::ImportsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing export:read or imports:write scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_imports(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_import_read_scope(&ctx, &state)?;
    Ok(Json(store::list_imports(&state.store, &ctx).await?))
}

#[utoipa::path(
    post,
    path = "/api/imports/jobs",
    tag = "runs",
    request_body(content = crate::http::openapi::ImportJobCreateRequest, description = "Import v2 job create request"),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Created import job", body = crate::http::openapi::ImportJobEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_import_job(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = import_mutation_context(&state, &headers).await?;
    let raw = read_json_value(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::create_import_job(&state.store, &ctx, raw).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/imports/jobs/{import_id}",
    tag = "runs",
    params(("import_id" = i64, Path, description = "Import job id")),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Import job status", body = crate::http::openapi::ImportJobEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing export:read or imports:write scope", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Import job not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_import_job(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(import_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_import_read_scope(&ctx, &state)?;
    Ok(Json(
        store::get_import_job(&state.store, &ctx, import_id).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/imports/jobs/{import_id}/chunks",
    tag = "runs",
    params(("import_id" = i64, Path, description = "Import job id")),
    request_body(content = crate::http::openapi::CanonicalImportChunk, description = "Canonical import chunk v2"),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Accepted import chunk", body = crate::http::openapi::ImportChunkAppendResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Chunk conflict or illegal state transition", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn append_import_chunk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(import_id): Path<i64>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = import_mutation_context(&state, &headers).await?;
    let raw = read_json_value(&headers, bytes, state.config.max_upload_body_bytes)?;
    Ok(Json(
        store::append_import_chunk(&state.store, &ctx, import_id, raw).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/imports/jobs/{import_id}/commit",
    tag = "runs",
    params(("import_id" = i64, Path, description = "Import job id")),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Committed import job", body = crate::http::openapi::ImportJobEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Import job is not ready", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn commit_import_job(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(import_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let ctx = import_mutation_context(&state, &headers).await?;
    Ok(Json(
        store::commit_import_job(&state.store, &ctx, import_id).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/imports/jobs/{import_id}/cancel",
    tag = "runs",
    params(("import_id" = i64, Path, description = "Import job id")),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Cancelled import job", body = crate::http::openapi::ImportJobEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Import job cannot be cancelled", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn cancel_import_job(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(import_id): Path<i64>,
) -> AppResult<Json<Value>> {
    let ctx = import_mutation_context(&state, &headers).await?;
    Ok(Json(
        store::cancel_import_job(&state.store, &ctx, import_id).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/imports/neptune",
    tag = "runs",
    params(
        ("dry_run" = Option<bool>, Query, description = "Run validation only without persisting"),
    ),
    request_body(content = crate::http::openapi::JsonObjectResponse, description = "Normalized Neptune JSON payload"),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Dry-run or completed import summary", body = crate::http::openapi::JsonObjectResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn import_neptune(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    import_with_source(state, headers, query, bytes, "neptune").await
}

#[utoipa::path(
    post,
    path = "/api/imports/wandb",
    tag = "runs",
    params(
        ("dry_run" = Option<bool>, Query, description = "Run validation only without persisting"),
    ),
    request_body(content = crate::http::openapi::JsonObjectResponse, description = "Normalized W&B JSON payload"),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Dry-run or completed import summary", body = crate::http::openapi::JsonObjectResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn import_wandb(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    import_with_source(state, headers, query, bytes, "wandb").await
}

#[utoipa::path(
    post,
    path = "/api/imports/mlflow",
    tag = "runs",
    params(
        ("dry_run" = Option<bool>, Query, description = "Run validation only without persisting"),
    ),
    request_body(content = crate::http::openapi::JsonObjectResponse, description = "Normalized MLflow JSON payload"),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Dry-run or completed import summary", body = crate::http::openapi::JsonObjectResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing imports:write scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn import_mlflow(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    import_with_source(state, headers, query, bytes, "mlflow").await
}

async fn import_with_source(
    state: Arc<AppState>,
    headers: HeaderMap,
    query: HashMap<String, String>,
    bytes: Bytes,
    source: &str,
) -> AppResult<Json<Value>> {
    let ctx = import_mutation_context(&state, &headers).await?;
    let raw = read_json_value(&headers, bytes, state.config.max_body_bytes)?;
    let dry_run = query
        .get("dry_run")
        .map(|value| value == "true")
        .unwrap_or(false);
    let result = store::import_payload(&state.store, &ctx, source, dry_run, raw).await;
    let (project_id, run_count, metric_count, artifact_count) = result
        .as_ref()
        .ok()
        .map(import_counts)
        .unwrap_or((None, 0, 0, 0));
    observability::import_outcome(observability::ImportOutcome {
        org_id: ctx.org_id,
        source,
        dry_run,
        project_id,
        run_count,
        metric_count,
        artifact_count,
        error: result.as_ref().err(),
    });
    Ok(Json(result?))
}

async fn import_mutation_context(
    state: &Arc<AppState>,
    headers: &HeaderMap,
) -> AppResult<crate::domain::RequestContext> {
    let ctx = context(state, headers, true).await?;
    validate_session_mutation_origin(state, headers, &ctx)?;
    require_scope(&ctx, "imports:write", state)?;
    Ok(ctx)
}

fn require_import_read_scope(
    ctx: &crate::domain::RequestContext,
    state: &AppState,
) -> AppResult<()> {
    if let Some(auth) = &ctx.auth {
        if auth
            .scopes
            .iter()
            .any(|scope| matches!(scope.as_str(), "export:read" | "imports:write"))
        {
            return Ok(());
        }
        return auth.require_scope("export:read");
    }
    require_scope(ctx, "export:read", state)
}

fn import_counts(value: &Value) -> (Option<uuid::Uuid>, usize, usize, usize) {
    let summary = value.get("summary").unwrap_or(value);
    let run_count = summary.get("runs").and_then(Value::as_u64).unwrap_or(0) as usize;
    let metric_count = summary.get("metrics").and_then(Value::as_u64).unwrap_or(0) as usize;
    let artifact_count = summary
        .get("artifacts")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let project_id = value
        .get("import")
        .and_then(|import| import.get("project_id"))
        .and_then(Value::as_str)
        .and_then(|raw| uuid::Uuid::parse_str(raw).ok());
    (project_id, run_count, metric_count, artifact_count)
}
