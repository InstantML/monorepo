use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{errors::AppResult, store};

use super::super::AppState;
use super::helpers::{context, header_value, require_scope, write_context};

#[utoipa::path(
    get,
    path = "/api/export",
    tag = "runs",
    params(
        ("project" = Option<String>, Query, description = "Filter by project name"),
        ("status" = Option<String>, Query, description = "Filter by run status"),
        ("q" = Option<String>, Query, description = "Run search query. Bare text preserves legacy substring search; supports fields, boolean operators, and explicit re:/.../ regex."),
        ("sort_by" = Option<String>, Query, description = "Sort key"),
        ("metric_key" = Option<String>, Query, description = "Metric key for export columns"),
        ("run_ids" = Option<String>, Query, description = "Comma-separated exact run UUIDs for selected-run export. Capped for GET URL safety."),
        ("runs" = Option<String>, Query, description = "Alias for run_ids. Ignored when run_ids is present."),
        ("format" = Option<String>, Query, description = "Export format: json (default) or csv"),
    ),
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Versioned export payload", content(
            (crate::http::openapi::JsonObjectResponse = "application/json"),
            (String = "text/csv; charset=utf-8")
        )),
        (status = 400, description = "Invalid run search or query parameter", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Missing export scope", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Selected run is missing or not visible to the caller", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn export_data(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let format = query
        .get("format")
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("json");
    if !matches!(format, "json" | "csv") {
        return Err(crate::errors::AppError::validation(
            "format must be json or csv",
        ));
    }
    let result = store::export_data(&state.store, &ctx, &query).await;
    match result {
        Ok(payload) if format == "csv" => {
            let run_count = payload
                .get("runs")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let truncated = payload
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let csv = match store::export_payload_to_csv(&payload) {
                Ok(csv) => csv,
                Err(error) => {
                    crate::http::observability::export_outcome(
                        crate::http::observability::ExportOutcome {
                            org_id: ctx.org_id,
                            actor_kind: export_actor_kind(&ctx),
                            actor_fingerprint: export_actor_fingerprint(&ctx),
                            project_restricted: ctx
                                .auth
                                .as_ref()
                                .and_then(|auth| auth.project_id)
                                .is_some(),
                            format,
                            scope: export_scope(&query),
                            run_count,
                            truncated,
                            response_bytes: None,
                            error: Some(&error),
                        },
                    );
                    return Err(error);
                }
            };
            crate::http::observability::export_outcome(crate::http::observability::ExportOutcome {
                org_id: ctx.org_id,
                actor_kind: export_actor_kind(&ctx),
                actor_fingerprint: export_actor_fingerprint(&ctx),
                project_restricted: ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some(),
                format,
                scope: export_scope(&query),
                run_count,
                truncated,
                response_bytes: Some(csv.len()),
                error: None,
            });
            let mut response = csv.into_response();
            apply_export_download_headers(&mut response, "instantml-export.csv", truncated)?;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                header_value("text/csv; charset=utf-8")?,
            );
            Ok(response)
        }
        Ok(payload) => {
            let truncated = payload
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            crate::http::observability::export_outcome(crate::http::observability::ExportOutcome {
                org_id: ctx.org_id,
                actor_kind: export_actor_kind(&ctx),
                actor_fingerprint: export_actor_fingerprint(&ctx),
                project_restricted: ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some(),
                format,
                scope: export_scope(&query),
                run_count: payload
                    .get("runs")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0),
                truncated,
                response_bytes: None,
                error: None,
            });
            let mut response = Json(payload).into_response();
            apply_export_download_headers(&mut response, "instantml-export.json", truncated)?;
            Ok(response)
        }
        Err(error) => {
            crate::http::observability::export_outcome(crate::http::observability::ExportOutcome {
                org_id: ctx.org_id,
                actor_kind: export_actor_kind(&ctx),
                actor_fingerprint: export_actor_fingerprint(&ctx),
                project_restricted: ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some(),
                format,
                scope: export_scope(&query),
                run_count: 0,
                truncated: false,
                response_bytes: None,
                error: Some(&error),
            });
            Err(error)
        }
    }
}

fn apply_export_download_headers(
    response: &mut Response,
    filename: &str,
    truncated: bool,
) -> AppResult<()> {
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        header_value(&format!("attachment; filename=\"{filename}\""))?,
    );
    response_headers.insert(header::CACHE_CONTROL, header_value("private, no-store")?);
    response_headers.insert(header::PRAGMA, header_value("no-cache")?);
    response_headers.insert(
        HeaderName::from_static("x-content-type-options"),
        header_value("nosniff")?,
    );
    response_headers.insert(
        HeaderName::from_static("content-security-policy"),
        header_value("sandbox")?,
    );
    response_headers.insert(
        HeaderName::from_static("x-instantml-export-truncated"),
        HeaderValue::from_static(if truncated { "true" } else { "false" }),
    );
    Ok(())
}

fn export_scope(query: &HashMap<String, String>) -> &'static str {
    if query.get("run_ids").or_else(|| query.get("runs")).is_some() {
        "selected"
    } else {
        "filter"
    }
}

fn export_actor_kind(ctx: &crate::domain::RequestContext) -> &'static str {
    if ctx.auth.is_some() {
        "api_key"
    } else if ctx.session.is_some() {
        "browser_session"
    } else {
        "local"
    }
}

fn export_actor_fingerprint(ctx: &crate::domain::RequestContext) -> String {
    ctx.auth
        .as_ref()
        .map(|auth| stable_export_actor_fingerprint(&auth.api_key_id.to_string()))
        .or_else(|| {
            ctx.session
                .as_ref()
                .map(|session| stable_export_actor_fingerprint(&session.session_id.to_string()))
        })
        .unwrap_or_default()
}

fn stable_export_actor_fingerprint(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut text = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        let _ = write!(&mut text, "{byte:02x}");
    }
    text
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
    let ctx = write_context(&state, &headers).await?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    Ok(Json(store::reset_demo(&state.store, &ctx).await?))
}
