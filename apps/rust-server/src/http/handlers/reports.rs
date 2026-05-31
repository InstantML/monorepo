//! HTTP handlers for the reports surface. Each handler is annotated with a
//! `#[utoipa::path]` so the OpenAPI codegen picks up the route shape; the
//! aggregator in `crate::http::openapi::ApiDoc` lists the handlers below.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::{
    domain::{CreateReportRequest, UpdateReportRequest},
    errors::AppResult,
    store,
};

use super::super::AppState;
use super::helpers::{
    context, header_value, parse_uuid, read_json, validate_session_mutation_origin,
};

/// Optional magic-link share token query parameter — used by anonymous
/// readers visiting `/r/:token` in the dashboard.
fn share_token(query: &HashMap<String, String>) -> Option<&str> {
    query
        .get("share")
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

#[utoipa::path(
    post,
    path = "/api/reports",
    tag = "reports",
    request_body = crate::domain::CreateReportRequest,
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Created report", body = crate::http::openapi::ReportEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient report write permission", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let input = read_json::<CreateReportRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let row = store::create_report(&state.store, &ctx, input).await?;
    Ok(Json(json!({ "report": row })))
}

#[utoipa::path(
    get,
    path = "/api/reports",
    tag = "reports",
    params(
        ("limit" = Option<i64>, Query, description = "Page size"),
        ("offset" = Option<i64>, Query, description = "Pagination offset"),
        ("project" = Option<String>, Query, description = "Filter to a single project_id"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Report summaries for the caller's org", body = crate::http::openapi::ReportSummariesEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_reports(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(store::list_reports(&state.store, &ctx, &query).await?))
}

#[utoipa::path(
    get,
    path = "/api/reports/{report_id}",
    tag = "reports",
    params(
        ("report_id" = String, Path, description = "Report UUID"),
        ("share" = Option<String>, Query, description = "Magic-link share token (allows anonymous read)"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = []), ()),
    responses(
        (status = 200, description = "Report", body = crate::http::openapi::ReportEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Report not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    let report_id = parse_uuid(&report_id, "report not found")?;
    let row = store::get_report(&state.store, &ctx, report_id, share_token(&query)).await?;
    Ok(Json(json!({ "report": row })))
}

#[utoipa::path(
    patch,
    path = "/api/reports/{report_id}",
    tag = "reports",
    params(("report_id" = String, Path, description = "Report UUID")),
    request_body = crate::domain::UpdateReportRequest,
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Updated report", body = crate::http::openapi::ReportEnvelope),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient report write permission", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Report not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn update_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let report_id = parse_uuid(&report_id, "report not found")?;
    let input = read_json::<UpdateReportRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let row = store::update_report(&state.store, &ctx, report_id, input).await?;
    Ok(Json(json!({ "report": row })))
}

#[utoipa::path(
    delete,
    path = "/api/reports/{report_id}",
    tag = "reports",
    params(("report_id" = String, Path, description = "Report UUID")),
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Soft-deleted report", body = crate::http::openapi::ReportEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient report write permission", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Report not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn delete_report(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let report_id = parse_uuid(&report_id, "report not found")?;
    let row = store::delete_report(&state.store, &ctx, report_id).await?;
    Ok(Json(json!({ "report": row })))
}

#[utoipa::path(
    post,
    path = "/api/reports/{report_id}/share",
    tag = "reports",
    params(("report_id" = String, Path, description = "Report UUID")),
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Report with rotated share token", body = crate::http::openapi::ReportEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient report write permission", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Report not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn rotate_report_share_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    let report_id = parse_uuid(&report_id, "report not found")?;
    let row = store::rotate_share_token(&state.store, &ctx, report_id).await?;
    Ok(Json(json!({ "report": row })))
}

#[utoipa::path(
    get,
    path = "/api/reports/share/{share_token}",
    tag = "reports",
    params(("share_token" = String, Path, description = "Magic-link share token")),
    security(()),
    responses(
        (status = 200, description = "Shared report fetched by share token", body = crate::http::openapi::ReportEnvelope),
        (status = 404, description = "Report not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn get_report_by_share_token(
    State(state): State<Arc<AppState>>,
    Path(share_token_value): Path<String>,
) -> AppResult<Json<Value>> {
    let row = store::get_report_by_share_token(&state.store, &share_token_value).await?;
    Ok(Json(json!({ "report": row })))
}

#[utoipa::path(
    get,
    path = "/api/reports/panels",
    tag = "reports",
    security(("browserSession" = []), ("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Org-wide panel inventory flattened across every report", body = crate::http::openapi::PanelInventoryEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_org_panels(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(store::list_org_panels(&state.store, &ctx).await?))
}

#[utoipa::path(
    get,
    path = "/api/reports/{report_id}/markdown",
    tag = "reports",
    params(
        ("report_id" = String, Path, description = "Report UUID"),
        ("share" = Option<String>, Query, description = "Magic-link share token (allows anonymous read)"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = []), ()),
    responses(
        (status = 200, description = "Markdown rendering of the report", body = String, content_type = "text/markdown; charset=utf-8"),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Report not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn export_report_markdown(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(report_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, false).await?;
    let report_id = parse_uuid(&report_id, "report not found")?;
    let markdown =
        store::export_report_markdown(&state.store, &ctx, report_id, share_token(&query)).await?;
    let mut response = markdown.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header_value("text/markdown; charset=utf-8")?,
    );
    Ok(response)
}
