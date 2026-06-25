use std::{sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::{
    domain::{CreateEmbedSessionRequest, EmbedRunsDataRequest},
    errors::{AppError, AppResult},
    store::{self, EmbedCreateConfig},
};

use super::super::AppState;
use super::helpers::{context, header_text, parse_uuid, read_json};

const MAX_EMBED_CREATE_BODY_BYTES: usize = 64 * 1024;
const MAX_EMBED_DATA_BODY_BYTES: usize = 64 * 1024;

#[utoipa::path(
    post,
    path = "/api/embed/sessions",
    tag = "embeds",
    request_body = crate::domain::CreateEmbedSessionRequest,
    security(("bearerApiKey" = [])),
    responses(
        (status = 200, description = "Created iframe embed session", body = crate::domain::CreateEmbedSessionResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "API key required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Embeds disabled or key lacks export access", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_embed_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Response> {
    let result: AppResult<Response> = async {
        require_embed_api_enabled(&state)?;
        refresh_embed_control_projection(&state).await?;
        let ctx = context(&state, &headers, true).await?;
        let input = read_json::<CreateEmbedSessionRequest>(
            &headers,
            bytes,
            MAX_EMBED_CREATE_BODY_BYTES.min(state.config.max_body_bytes),
        )?;
        let response = store::create_embed_session(
            &state.store,
            &ctx,
            input,
            EmbedCreateConfig {
                app_base_url: embed_app_base_url(&state),
                hosted: state.config.hosted_clickhouse.is_some(),
                org_allowlist: state.config.embed.org_allowlist.clone(),
                token_hmac_secret: state.config.embed.token_hmac_secret.clone(),
            },
        )
        .await?;
        Ok(Json(response).into_response())
    }
    .await;
    Ok(embed_api_response(result, true))
}

#[utoipa::path(
    get,
    path = "/api/embed/sessions/{session_id}/frame-policy",
    tag = "embeds",
    params(("session_id" = String, Path, description = "Embed session UUID")),
    responses(
        (status = 200, description = "Frame policy metadata", body = crate::domain::EmbedFramePolicyResponse),
        (status = 404, description = "Embed session not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn embed_frame_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> AppResult<Response> {
    let result: AppResult<Response> = async {
        let session_id = parse_uuid(&session_id, "embed session not found")?;
        if let Some(retry_after) = state
            .rate_limiter
            .check_embed_frame_policy(embed_client_rate_key(&headers))
            .await
        {
            return Ok(rate_limited_response(retry_after));
        }
        if !state.config.embed.frame_enabled {
            return Err(AppError::forbidden("iframe embeds are disabled"));
        }
        let response = store::embed_frame_policy(&state.store, session_id).await?;
        Ok(Json(response).into_response())
    }
    .await;
    Ok(embed_api_response(result, false))
}

#[utoipa::path(
    get,
    path = "/api/embed/sessions/{session_id}/current",
    tag = "embeds",
    params(("session_id" = String, Path, description = "Embed session UUID")),
    security(("bearerEmbedToken" = [])),
    responses(
        (status = 200, description = "Current embed session metadata", body = crate::domain::EmbedCurrentSessionResponse),
        (status = 401, description = "Embed token required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Embeds disabled or source key inactive", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn embed_current_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> AppResult<Response> {
    let result: AppResult<Response> = async {
        require_embed_api_enabled(&state)?;
        let session_id = parse_uuid(&session_id, "embed session not found")?;
        if let Some(retry_after) = state
            .rate_limiter
            .check_embed_token_pre_auth(embed_client_rate_key(&headers))
            .await
        {
            return Ok(rate_limited_response(retry_after));
        }
        let token = embed_bearer_token(&headers)?;
        let response = store::embed_current_session(
            &state.store,
            session_id,
            token,
            state.config.embed.token_hmac_secret.as_deref(),
        )
        .await?;
        if let Some(retry_after) = state
            .rate_limiter
            .check_embed_current_session(session_id)
            .await
        {
            return Ok(rate_limited_response(retry_after));
        }
        Ok(Json(response).into_response())
    }
    .await;
    Ok(embed_api_response(result, true))
}

#[utoipa::path(
    post,
    path = "/api/embed/sessions/{session_id}/runs/data",
    tag = "embeds",
    params(("session_id" = String, Path, description = "Embed session UUID")),
    request_body = crate::domain::EmbedRunsDataRequest,
    security(("bearerEmbedToken" = [])),
    responses(
        (status = 200, description = "Bounded run chart data", body = crate::domain::WorkspaceViewDataResponse),
        (status = 401, description = "Embed token required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Embeds disabled or source key inactive", body = crate::http::openapi::ErrorResponse),
        (status = 429, description = "Per-session rate limited", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn embed_runs_data(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Response> {
    let result: AppResult<Response> = async {
        require_embed_api_enabled(&state)?;
        let session_id = parse_uuid(&session_id, "embed session not found")?;
        if let Some(retry_after) = state
            .rate_limiter
            .check_embed_token_pre_auth(embed_client_rate_key(&headers))
            .await
        {
            return Ok(rate_limited_response(retry_after));
        }
        let token = embed_bearer_token(&headers)?;
        let (embed_auth, row) = store::authenticate_embed_token(
            &state.store,
            session_id,
            token,
            state.config.embed.token_hmac_secret.as_deref(),
        )
        .await?;
        if let Some(retry_after) = state.rate_limiter.check_embed_data_session(row.id).await {
            return Ok(rate_limited_response(retry_after));
        }
        let input = read_json::<EmbedRunsDataRequest>(
            &headers,
            bytes,
            MAX_EMBED_DATA_BODY_BYTES.min(state.config.max_body_bytes),
        )?;
        let response = store::embed_runs_data_for_session(
            &state.store,
            embed_auth,
            row,
            input,
            state.rate_limiter.public_instance_id(),
        )
        .await?;
        Ok(Json(response).into_response())
    }
    .await;
    Ok(embed_api_response(result, true))
}

fn require_embed_api_enabled(state: &AppState) -> AppResult<()> {
    if state.config.embed.enabled {
        Ok(())
    } else {
        Err(AppError::forbidden("iframe embeds are disabled"))
    }
}

async fn refresh_embed_control_projection(state: &AppState) -> AppResult<()> {
    state
        .store
        .refresh_control_records_for_auth_miss()
        .await
        .map_err(|_| AppError::service_unavailable("control plane unavailable"))
}

fn embed_bearer_token(headers: &HeaderMap) -> AppResult<&str> {
    let header = header_text(headers, "authorization")
        .ok_or_else(|| AppError::unauthorized("missing embed token"))?;
    header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .ok_or_else(|| AppError::unauthorized("authorization must use bearer token"))
}

fn embed_app_base_url(state: &AppState) -> String {
    state
        .config
        .frontend_base_url
        .clone()
        .or_else(|| state.config.allowed_frontend_origins.first().cloned())
        .unwrap_or_else(|| "http://localhost:3000".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn embed_client_rate_key(headers: &HeaderMap) -> String {
    for name in ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] {
        if let Some(value) = header_text(headers, name) {
            if let Some(candidate) = value.split(',').next().map(str::trim) {
                if !candidate.is_empty() {
                    return candidate.to_string();
                }
            }
        }
    }
    "unknown".to_string()
}

fn embed_api_response(result: AppResult<Response>, vary_authorization: bool) -> Response {
    let mut response = match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    apply_embed_api_headers(response.headers_mut(), vary_authorization);
    response
}

fn apply_embed_api_headers(headers: &mut HeaderMap, vary_authorization: bool) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if vary_authorization {
        headers.insert(header::VARY, HeaderValue::from_static("Authorization"));
    }
}

fn rate_limited_response(retry_after: Duration) -> Response {
    let retry_after = retry_after.as_secs().max(1);
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": "rate limit exceeded for embed session",
            "code": "rate_limit_exceeded"
        })),
    )
        .into_response();
    response.headers_mut().insert(
        header::RETRY_AFTER,
        HeaderValue::from_str(&retry_after.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("1")),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_bearer_token_requires_authorization_header() {
        let headers = HeaderMap::new();
        assert!(embed_bearer_token(&headers).is_err());
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer instantml_embed_test"),
        );
        assert_eq!(
            embed_bearer_token(&headers).unwrap(),
            "instantml_embed_test"
        );
    }

    #[test]
    fn embed_client_rate_key_prefers_forwarded_client() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.7, 10.0.0.1"),
        );
        assert_eq!(embed_client_rate_key(&headers), "203.0.113.7");
    }

    #[test]
    fn embed_error_and_rate_limit_responses_are_private_no_store() {
        let response = embed_api_response(Err(AppError::unauthorized("missing embed token")), true);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(response.headers()[header::PRAGMA], "no-cache");
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()[header::VARY], "Authorization");

        let response = embed_api_response(Ok(rate_limited_response(Duration::from_secs(2))), true);
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(response.headers()[header::RETRY_AFTER], "2");
        assert_eq!(response.headers()[header::VARY], "Authorization");
    }
}
