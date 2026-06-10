use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, Json};

use crate::{domain::RouteDiscoveryResponse, errors::AppResult};

use super::super::AppState;
use super::helpers::context;

#[utoipa::path(
    get,
    path = "/api/routing/current",
    tag = "routing",
    security(("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Current data-cell route for the caller's organization", body = crate::domain::RouteDiscoveryResponse),
        (status = 401, description = "API key required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "API key lacks a data-plane scope", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Route discovery unavailable", body = crate::http::openapi::ErrorResponse),
        (status = 503, description = "Assigned data cell is not write-ready", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn current_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<RouteDiscoveryResponse>> {
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(state.store.current_route_discovery(&ctx).await?))
}
