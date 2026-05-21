use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::Value;

use crate::{errors::AppResult, store};

use super::super::AppState;
use super::helpers::{context, require_scope};

#[utoipa::path(
    get,
    path = "/api/export",
    tag = "runs",
    params(
        ("project" = Option<String>, Query, description = "Filter by project name"),
        ("status" = Option<String>, Query, description = "Filter by run status"),
        ("q" = Option<String>, Query, description = "Substring search"),
        ("sort_by" = Option<String>, Query, description = "Sort key"),
        ("metric_key" = Option<String>, Query, description = "Metric key for export columns"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Versioned export payload", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing export scope", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn export_data(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::export_data(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    get,
    path = "/api/usage",
    tag = "runs",
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Computed org usage summary", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing usage:read scope or restricted org access", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn usage_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "usage:read", &state)?;
    Ok(Json(store::usage_summary(&state.store, &ctx).await?))
}

#[utoipa::path(
    get,
    path = "/api/usage/export",
    tag = "runs",
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Versioned usage export payload", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing usage:read scope or restricted org access", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn usage_export(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "usage:read", &state)?;
    Ok(Json(store::usage_export(&state.store, &ctx).await?))
}

#[utoipa::path(
    post,
    path = "/api/demo/reset",
    tag = "runs",
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Reset deterministic demo project", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing ingest scope", body = crate::http::openapi::ErrorResponse),
        (status = 402, description = "Plan limit exceeded", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn reset_demo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    Ok(Json(store::reset_demo(&state.store, &ctx).await?))
}
