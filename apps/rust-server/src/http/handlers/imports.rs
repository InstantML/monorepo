use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Query, State},
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
        (status = 200, description = "Recent imports for the caller's tenant", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_imports(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::list_imports(&state.store, &ctx).await?))
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
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "imports:write", &state)?;
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
