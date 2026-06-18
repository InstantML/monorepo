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
    path = "/api/insights/system-usage",
    tag = "runs",
    params(
        ("family" = Option<String>, Query, description = "Usage family. `gpu` is the default; `system` keeps the response shape extensible."),
        ("range" = Option<String>, Query, description = "Preset UTC window: 7d, 14d, or 30d. Ignored when start/end are supplied."),
        ("start" = Option<String>, Query, description = "RFC3339 inclusive period start. Windows are capped to 31 days."),
        ("end" = Option<String>, Query, description = "RFC3339 exclusive period end."),
        ("group_by" = Option<String>, Query, description = "Breakdown dimension: actor, project, gpu_model, or run."),
        ("project" = Option<String>, Query, description = "Project name filter."),
        ("actor" = Option<String>, Query, description = "Actor label filter."),
        ("gpu_model" = Option<String>, Query, description = "GPU model label filter."),
        ("min_coverage_pct" = Option<f64>, Query, description = "Minimum telemetry coverage percentage."),
        ("limit" = Option<i64>, Query, description = "Maximum grouped rows to return, capped at 500."),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Observed GPU and system usage insights", body = crate::http::openapi::SystemUsageInsightsEnvelope),
        (status = 400, description = "Invalid query parameter", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing usage:read scope, admin session role, or org-scoped key access", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn system_usage_insights(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "usage:read", &state)?;
    store::require_unrestricted_org_access(&ctx)?;
    Ok(Json(
        store::system_usage_insights(&state.store, &ctx, &query).await?,
    ))
}
