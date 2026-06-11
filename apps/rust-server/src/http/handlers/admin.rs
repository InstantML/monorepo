use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    domain::{CreateOrgMigrationRequest, OrgMigrationTransitionRequest},
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
    get,
    path = "/api/admin/org-migrations",
    tag = "admin",
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Operator org migration records", body = crate::domain::AdminOrgMigrationsResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn admin_org_migrations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<crate::domain::AdminOrgMigrationsResponse>> {
    require_strict_bootstrap(&state, &headers)?;
    Ok(Json(store::admin_org_migrations(&state.store).await?))
}

#[utoipa::path(
    post,
    path = "/api/admin/org-migrations",
    tag = "admin",
    request_body = crate::domain::CreateOrgMigrationRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Planned org migration", body = crate::http::openapi::OrgMigrationEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Active migration or route conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_admin_org_migration(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    require_strict_bootstrap(&state, &headers)?;
    let input =
        read_json::<CreateOrgMigrationRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let migration = store::create_admin_org_migration(&state.store, input).await?;
    Ok(Json(json!({ "migration": migration })))
}

#[utoipa::path(
    post,
    path = "/api/admin/org-migrations/{migration_id}/write-block",
    tag = "admin",
    params(("migration_id" = String, Path, description = "Migration UUID")),
    request_body = crate::domain::OrgMigrationTransitionRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Write-blocked org migration", body = crate::http::openapi::OrgMigrationEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Migration not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Route or transition conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn write_block_admin_org_migration(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(migration_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    require_strict_bootstrap(&state, &headers)?;
    let migration_id = parse_migration_id(&migration_id)?;
    let input =
        read_json::<OrgMigrationTransitionRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let migration =
        store::write_block_admin_org_migration(&state.store, migration_id, input).await?;
    Ok(Json(json!({ "migration": migration })))
}

#[utoipa::path(
    post,
    path = "/api/admin/org-migrations/{migration_id}/restore",
    tag = "admin",
    params(("migration_id" = String, Path, description = "Migration UUID")),
    request_body = crate::domain::OrgMigrationTransitionRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Restored source route for org migration", body = crate::http::openapi::OrgMigrationEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Migration not found", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Route or transition conflict", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn restore_admin_org_migration(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(migration_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    require_strict_bootstrap(&state, &headers)?;
    let migration_id = parse_migration_id(&migration_id)?;
    let input =
        read_json::<OrgMigrationTransitionRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let migration = store::restore_admin_org_migration(&state.store, migration_id, input).await?;
    Ok(Json(json!({ "migration": migration })))
}

#[utoipa::path(
    post,
    path = "/api/admin/org-migrations/{migration_id}/fail",
    tag = "admin",
    params(("migration_id" = String, Path, description = "Migration UUID")),
    request_body = crate::domain::OrgMigrationTransitionRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Failed org migration record", body = crate::http::openapi::OrgMigrationEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Migration not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn fail_admin_org_migration(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(migration_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    require_strict_bootstrap(&state, &headers)?;
    let migration_id = parse_migration_id(&migration_id)?;
    let input =
        read_json::<OrgMigrationTransitionRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let migration = store::fail_admin_org_migration(&state.store, migration_id, input).await?;
    Ok(Json(json!({ "migration": migration })))
}

fn parse_migration_id(raw: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found("org migration not found"))
}
