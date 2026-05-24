use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};

use crate::{
    errors::{AppError, AppResult},
    store::{self, AdminOverviewOptions, ADMIN_OVERVIEW_DEFAULT_LIMIT, ADMIN_OVERVIEW_MAX_LIMIT},
};

use super::super::AppState;
use super::helpers::require_strict_bootstrap;

#[utoipa::path(
    get,
    path = "/api/admin/overview",
    tag = "admin",
    params(
        ("q" = Option<String>, Query, description = "Case-insensitive search over users, orgs, API keys, and risk text"),
        ("limit" = Option<usize>, Query, description = "Maximum rows per list; default 100, max 200"),
    ),
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Read-only operator overview", body = crate::domain::AdminOverviewResponse),
        (status = 400, description = "Invalid query parameter", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn admin_overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<crate::domain::AdminOverviewResponse>> {
    require_strict_bootstrap(&state, &headers)?;
    let limit = match query.get("limit") {
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| AppError::validation("limit must be a positive integer"))?
            .clamp(1, ADMIN_OVERVIEW_MAX_LIMIT),
        None => ADMIN_OVERVIEW_DEFAULT_LIMIT,
    };
    Ok(Json(
        store::admin_overview(
            &state.store,
            AdminOverviewOptions {
                q: query.get("q").cloned(),
                limit,
                data_counts_available: state.config.service_plane.includes_data(),
            },
        )
        .await?,
    ))
}
