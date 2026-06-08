use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::{
    domain::{
        ImportWorkspaceViewRequest, SaveWorkspaceViewRequest, UpdateDashboardPreferencesRequest,
        WorkspaceViewDataRequest,
    },
    errors::{AppError, AppResult},
    store,
};

use super::super::AppState;
use super::helpers::{
    context, header_value, parse_uuid, read_json, require_scope, validate_session_mutation_origin,
};

const MAX_WORKSPACE_VIEW_IMPORT_BODY_BYTES: usize = 128 * 1024;
const MAX_WORKSPACE_VIEW_DATA_BODY_BYTES: usize = 256 * 1024;

#[utoipa::path(
    get,
    path = "/api/dashboard/preferences",
    tag = "dashboard",
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Dashboard preferences for the caller's tenant", body = crate::http::openapi::DashboardPreferencesEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_dashboard_preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(
        store::get_dashboard_preferences(&state.store, &ctx).await?,
    ))
}

#[utoipa::path(
    put,
    path = "/api/dashboard/preferences",
    tag = "dashboard",
    request_body = crate::domain::UpdateDashboardPreferencesRequest,
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Updated dashboard preferences", body = crate::http::openapi::DashboardPreferencesEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn update_dashboard_preferences(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let input = read_json::<UpdateDashboardPreferencesRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    Ok(Json(
        store::update_dashboard_preferences(&state.store, &ctx, input).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/workspace-views",
    tag = "dashboard",
    params(
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("cursor" = Option<String>, Query, description = "Pagination cursor"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Saved workspace view summaries", body = crate::http::openapi::WorkspaceViewSummariesEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_workspace_views(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(
        store::list_workspace_views(&state.store, &ctx, &query).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/workspace-views",
    tag = "dashboard",
    request_body = crate::domain::SaveWorkspaceViewRequest,
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Created workspace view", body = crate::http::openapi::WorkspaceViewEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_workspace_view(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let input =
        read_json::<SaveWorkspaceViewRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::create_workspace_view(&state.store, &ctx, input).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/workspace-views/{view_id}",
    tag = "dashboard",
    params(
        ("view_id" = String, Path, description = "Workspace view UUID"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Workspace view", body = crate::http::openapi::WorkspaceViewEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Workspace view not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_workspace_view(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(view_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    let view_id = parse_uuid(&view_id, "workspace view not found")?;
    Ok(Json(
        store::get_workspace_view(&state.store, &ctx, view_id).await?,
    ))
}

#[utoipa::path(
    put,
    path = "/api/workspace-views/{view_id}",
    tag = "dashboard",
    params(
        ("view_id" = String, Path, description = "Workspace view UUID"),
    ),
    request_body = crate::domain::SaveWorkspaceViewRequest,
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Updated workspace view", body = crate::http::openapi::WorkspaceViewEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Workspace view not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn update_workspace_view(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(view_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let view_id = parse_uuid(&view_id, "workspace view not found")?;
    let input =
        read_json::<SaveWorkspaceViewRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::update_workspace_view(&state.store, &ctx, view_id, input).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/workspace-views/{view_id}/export",
    tag = "dashboard",
    params(
        ("view_id" = String, Path, description = "Workspace view UUID"),
    ),
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Portable workspace view JSON", body = crate::domain::WorkspaceViewExportEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Workspace view not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn export_workspace_view(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(view_id): Path<String>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, false).await?;
    let view_id = parse_uuid(&view_id, "workspace view not found")?;
    let envelope = store::export_workspace_view(&state.store, &ctx, view_id).await?;
    let filename = workspace_view_export_filename(&envelope.view.name);
    let mut response = Json(envelope).into_response();
    apply_workspace_view_export_headers(&mut response, &filename)?;
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/api/workspace-views/import",
    tag = "dashboard",
    request_body = crate::domain::ImportWorkspaceViewRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Dry-run preview or imported workspace view", body = crate::domain::WorkspaceViewImportResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Workspace view update conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn import_workspace_view(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<crate::domain::WorkspaceViewImportResponse>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let input = read_json::<ImportWorkspaceViewRequest>(
        &headers,
        bytes,
        state
            .config
            .max_body_bytes
            .min(MAX_WORKSPACE_VIEW_IMPORT_BODY_BYTES),
    )?;
    Ok(Json(
        store::import_workspace_view(&state.store, &ctx, input).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/api/workspace-views/{view_id}",
    tag = "dashboard",
    params(
        ("view_id" = String, Path, description = "Workspace view UUID"),
        ("expected_updated_at" = String, Query, description = "Last observed updated_at timestamp for optimistic delete"),
    ),
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Deleted workspace view marker", body = crate::domain::WorkspaceViewDeleteResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Workspace view not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Workspace view update conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn delete_workspace_view(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(view_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<crate::domain::WorkspaceViewDeleteResponse>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let view_id = parse_uuid(&view_id, "workspace view not found")?;
    let expected_updated_at = parse_expected_updated_at(&query)?;
    Ok(Json(
        store::delete_workspace_view(&state.store, &ctx, view_id, expected_updated_at).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/workspace-view-data",
    tag = "dashboard",
    request_body = crate::domain::WorkspaceViewDataRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Bounded data projection for a portable workspace view and explicit runs", body = crate::domain::WorkspaceViewDataResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing export scope or project access", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Selected run is missing or not visible to the caller", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn workspace_view_data(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<crate::domain::WorkspaceViewDataResponse>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let input = read_json::<WorkspaceViewDataRequest>(
        &headers,
        bytes,
        state
            .config
            .max_body_bytes
            .min(MAX_WORKSPACE_VIEW_DATA_BODY_BYTES),
    )?;
    Ok(Json(
        store::workspace_view_data(&state.store, &ctx, input).await?,
    ))
}

fn parse_expected_updated_at(query: &HashMap<String, String>) -> AppResult<DateTime<Utc>> {
    let raw = query
        .get("expected_updated_at")
        .ok_or_else(|| AppError::validation("expected_updated_at is required"))?;
    DateTime::parse_from_rfc3339(raw)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::validation("expected_updated_at must be an RFC 3339 timestamp"))
}

fn workspace_view_export_filename(name: &str) -> String {
    let safe = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(80)
        .collect::<String>();
    let base = if safe.is_empty() {
        "workspace-view".to_string()
    } else {
        safe
    };
    format!("{base}.instantml-view.json")
}

fn apply_workspace_view_export_headers(response: &mut Response, filename: &str) -> AppResult<()> {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_DISPOSITION,
        header_value(&format!("attachment; filename=\"{filename}\""))?,
    );
    headers.insert(header::CACHE_CONTROL, header_value("private, no-store")?);
    headers.insert(header::PRAGMA, header_value("no-cache")?);
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        header_value("nosniff")?,
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        header_value("sandbox")?,
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    Ok(())
}
