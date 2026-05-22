use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::{
    domain::{
        ClerkAuthRequest, DevGoogleAuthRequest, DeviceCodeConfirmRequest, DeviceCodePollRequest,
        DeviceCodeStartRequest, SwitchOrganizationRequest,
    },
    errors::{AppError, AppResult},
    store,
};

use super::super::AppState;
use super::helpers::{
    clear_session_cookie, header_value, json_with_session_cookie, read_json, request_rate_key,
    session_context, session_cookie, validate_clerk_signup_allowed, validate_mutation_origin,
    validate_mutation_origin_required,
};

#[utoipa::path(
    post,
    path = "/api/auth/dev/google",
    tag = "auth",
    request_body = crate::domain::DevGoogleAuthRequest,
    security(),
    responses(
        (status = 200, description = "Session payload; HttpOnly session cookie is set on the response", body = crate::domain::AuthSessionPayload),
        (status = 401, description = "Dev auth is not enabled", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Origin not allowed", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn auth_dev_google(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Response> {
    if !state.config.dev_auth_enabled {
        return Err(AppError::unauthorized(
            "local development auth is not enabled",
        ));
    }
    validate_mutation_origin(&state, &headers)?;
    let input = read_json::<DevGoogleAuthRequest>(&headers, bytes, state.config.max_body_bytes)?;
    if let Some(invite_token) = input.accept_invite_token.as_deref() {
        store::record_invitation_token_attempt(
            &state.store,
            invite_token,
            store::InvitationTokenAttemptScope::Accept,
            Some(&request_rate_key(&headers)),
        )
        .await?;
    }
    let created =
        store::create_dev_google_session(&state.store, input, Some(&state.config.billing)).await?;
    json_with_session_cookie(&state, &headers, created.payload, &created.token)
}

#[utoipa::path(
    post,
    path = "/api/auth/clerk",
    tag = "auth",
    request_body = crate::domain::ClerkAuthRequest,
    security(),
    responses(
        (status = 200, description = "Session payload (with optional onboarding API key); HttpOnly session cookie is set", body = crate::http::openapi::AuthSessionWithOnboardingKey),
        (status = 401, description = "Clerk auth not configured or token invalid", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Origin not allowed or signup restricted", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn auth_clerk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Response> {
    if !state.config.managed_clerk_enabled {
        return Err(AppError::unauthorized(
            "managed Clerk auth is not configured",
        ));
    }
    validate_mutation_origin_required(&state, &headers)?;
    let input = read_json::<ClerkAuthRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let token = input
        .token
        .clone()
        .ok_or_else(|| AppError::validation("token is required"))?;
    let secret_key = state
        .config
        .clerk_secret_key
        .as_deref()
        .ok_or_else(|| AppError::unauthorized("managed Clerk auth is not configured"))?;
    let principal = crate::managed_auth::verify_clerk_session_token(
        secret_key,
        &state.config.clerk_api_base,
        state.config.clerk_jwt_issuer.as_deref(),
        &token,
        state.config.clerk_session_max_token_age,
    )
    .await?;
    if let Some(invite_token) = input.accept_invite_token.as_deref() {
        store::record_invitation_token_attempt(
            &state.store,
            invite_token,
            store::InvitationTokenAttemptScope::Accept,
            Some(&request_rate_key(&headers)),
        )
        .await?;
    }
    validate_clerk_signup_allowed(&state.config, &principal.email, &input)?;
    let created =
        store::create_clerk_session(&state.store, principal, input, Some(&state.config.billing))
            .await?;
    let mut response_body = serde_json::to_value(&created.payload)
        .map_err(|_| AppError::internal("failed to serialize auth payload"))?;
    if let Some(onboarding_key) = &created.onboarding_api_key {
        if let Some(obj) = response_body.as_object_mut() {
            obj.insert(
                "onboarding_api_key".to_string(),
                serde_json::to_value(onboarding_key)
                    .map_err(|_| AppError::internal("failed to serialize onboarding key"))?,
            );
        }
    }
    json_with_session_cookie(&state, &headers, response_body, &created.token)
}

#[utoipa::path(
    get,
    path = "/api/auth/session",
    tag = "auth",
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Authenticated session payload", body = crate::domain::AuthSessionPayload),
        (status = 200, description = "Unauthenticated session", body = crate::http::openapi::AuthSessionUnauthenticated),
    ),
)]
pub async fn auth_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let Some(token) = session_cookie(&headers) else {
        return Ok(Json(json!({ "authenticated": false })).into_response());
    };
    match store::authenticate_session(&state.store, token).await {
        Ok(payload) => Ok(Json(payload).into_response()),
        Err(_) => {
            let mut response = Json(json!({ "authenticated": false })).into_response();
            response
                .headers_mut()
                .append(header::SET_COOKIE, header_value(&clear_session_cookie())?);
            Ok(response)
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "auth",
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Session revoked and cookie cleared", body = crate::http::openapi::AuthSessionUnauthenticated),
    ),
)]
pub async fn auth_logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Response> {
    validate_mutation_origin(&state, &headers)?;
    if let Some(token) = session_cookie(&headers) {
        store::revoke_session(&state.store, token).await?;
    }
    let mut response = Json(json!({ "authenticated": false })).into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, header_value(&clear_session_cookie())?);
    Ok(response)
}

/// Re-point the caller's session at a different org they belong to.
///
/// Used by the dashboard org-switcher. The session token is unchanged — only
/// the bound `org_id` on the session row is updated, so subsequent requests
/// from the same cookie scope to the newly selected org.
#[utoipa::path(
    post,
    path = "/api/auth/switch-organization",
    tag = "auth",
    request_body = crate::domain::SwitchOrganizationRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Refreshed session payload bound to the target org", body = crate::domain::AuthSessionPayload),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "No active membership in target organization", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Organization not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn auth_switch_organization(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Response> {
    validate_mutation_origin(&state, &headers)?;
    let token = session_cookie(&headers)
        .ok_or_else(|| AppError::unauthorized("missing session"))?
        .to_string();
    let input =
        read_json::<SwitchOrganizationRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let target_org_id = input
        .org_id
        .ok_or_else(|| AppError::validation("org_id is required"))?;
    let payload = store::switch_session_organization(&state.store, &token, target_org_id).await?;
    Ok(Json(payload).into_response())
}

// --- Device-code (RFC 8628) handlers ---

#[utoipa::path(
    post,
    path = "/api/auth/device-code/start",
    tag = "auth",
    request_body = crate::domain::DeviceCodeStartRequest,
    security(),
    responses(
        (status = 200, description = "Device-code grant initiated", body = crate::http::openapi::DeviceCodeStartResponse),
    ),
)]
pub async fn device_code_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let input = read_json::<DeviceCodeStartRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let client_info = input
        .client_info
        .map(|info| json!({ "name": info.name, "version": info.version }));
    let frontend_base_url = state
        .config
        .frontend_base_url
        .as_deref()
        .or_else(|| {
            state
                .config
                .allowed_frontend_origins
                .first()
                .map(String::as_str)
        })
        .unwrap_or("http://localhost:3000");
    let result = store::device_code_start(&state.store, frontend_base_url, client_info).await?;
    Ok(Json(result))
}

#[utoipa::path(
    post,
    path = "/api/auth/device-code/poll",
    tag = "auth",
    request_body = crate::domain::DeviceCodePollRequest,
    security(),
    responses(
        (status = 200, description = "status: pending | authorized | denied | expired", body = crate::http::openapi::DeviceCodePollResponse),
        (status = 429, description = "slow_down: polling too fast", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn device_code_poll(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let input = read_json::<DeviceCodePollRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let raw_device_code = input
        .device_code
        .ok_or_else(|| AppError::validation("device_code is required"))?;
    let result = store::device_code_poll(&state.store, &raw_device_code).await?;
    Ok(Json(result))
}

#[utoipa::path(
    post,
    path = "/api/auth/device-code/confirm",
    tag = "auth",
    request_body = crate::domain::DeviceCodeConfirmRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Grant confirmed", body = crate::http::openapi::DeviceCodeConfirmResponse),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "user_code not found or expired", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn device_code_confirm(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let input =
        read_json::<DeviceCodeConfirmRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let raw_user_code = input
        .user_code
        .ok_or_else(|| AppError::validation("user_code is required"))?;
    // Requires a valid browser session.
    let session_payload = session_context(&state, &headers).await?;
    let result = store::device_code_confirm(
        &state.store,
        session_payload.user.id,
        session_payload.organization.id,
        &raw_user_code,
    )
    .await?;
    Ok(Json(result))
}

// --- End device-code handlers ---
