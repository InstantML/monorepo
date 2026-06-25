use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use uuid::Uuid;

use crate::{
    domain::AdminPlanChangeRequest,
    errors::{AppError, AppResult},
    store::{self, AdminOverviewOptions, ADMIN_OVERVIEW_DEFAULT_LIMIT, ADMIN_OVERVIEW_MAX_LIMIT},
};

use super::super::AppState;
use super::helpers::{read_json, require_strict_bootstrap};

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

#[utoipa::path(
    get,
    path = "/api/admin/data-cells",
    tag = "admin",
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Operator data-cell registry summary", body = crate::domain::AdminDataCellsResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn admin_data_cells(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<crate::domain::AdminDataCellsResponse>> {
    require_strict_bootstrap(&state, &headers)?;
    Ok(Json(store::admin_data_cells(&state.store).await?))
}

#[utoipa::path(
    post,
    path = "/api/admin/data-cells/{cell_id}/backup",
    tag = "admin",
    params(
        ("cell_id" = String, Path, description = "Data-cell identifier to record backup evidence for"),
        ("environment" = Option<String>, Query, description = "Cell environment; defaults to this service's configured environment"),
    ),
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Backup evidence recorded; returns the refreshed data-cell registry", body = crate::domain::AdminDataCellsResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Data cell not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn admin_record_data_cell_backup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(cell_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<crate::domain::AdminDataCellsResponse>> {
    require_strict_bootstrap(&state, &headers)?;
    Ok(Json(
        store::record_data_cell_backup(&state.store, query.get("environment").cloned(), &cell_id)
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/admin/orgs/{org_id}/plan",
    tag = "admin",
    params(("org_id" = Uuid, Path, description = "Organization to re-plan")),
    request_body = crate::domain::AdminPlanChangeRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Refreshed organization summary", body = crate::domain::AdminOrganizationSummary),
        (status = 400, description = "Invalid plan tier", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Organization not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn admin_change_plan(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<Uuid>,
    bytes: Bytes,
) -> AppResult<Json<crate::domain::AdminOrganizationSummary>> {
    require_strict_bootstrap(&state, &headers)?;
    let request =
        read_json::<AdminPlanChangeRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let summary = store::admin_change_org_plan(
        &state.store,
        org_id,
        Some(request.plan_tier.as_str()),
        state.config.service_plane.includes_data(),
    )
    .await?;
    Ok(Json(summary))
}
