use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::Value;

use crate::{
    domain::{SaveWorkspaceViewRequest, UpdateDashboardPreferencesRequest},
    errors::AppResult,
    store,
};

use super::super::AppState;
use super::helpers::{context, parse_uuid, read_json, validate_session_mutation_origin};

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
