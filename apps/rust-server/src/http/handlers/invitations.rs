use std::{collections::HashMap, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Response,
    Json,
};
use serde_json::{json, Value};

use crate::{
    domain::{validate_limit, validate_offset, CreateInvitationRequest, InvitationTokenRequest},
    errors::{AppError, AppResult},
    store,
};

use super::super::AppState;
use super::helpers::{
    header_text, json_with_session_cookie, parse_uuid, read_json, request_rate_key,
    require_strict_bootstrap, session_context, validate_mutation_origin,
};

#[utoipa::path(
    get,
    path = "/api/orgs/{org_id}/invitations",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
        ("limit" = Option<i64>, Query, description = "Maximum rows to return; defaults to 100"),
        ("offset" = Option<i64>, Query, description = "Rows to skip"),
    ),
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Organization invitations", body = crate::http::openapi::InvitationsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Admin role required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_invitations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    invitation_admin_actor(&state, &headers, org_id, false).await?;
    let limit = validate_limit(query.get("limit").map(String::as_str), 100, 200)? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    Ok(Json(json!({
        "invitations": store::list_org_invitations(&state.store, org_id, limit, offset).await?,
        "limit": limit,
        "offset": offset
    })))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/invitations",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
    ),
    request_body = crate::domain::CreateInvitationRequest,
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Created organization invitation", body = crate::http::openapi::InvitationEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Admin role required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_invitation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    let input = read_json::<CreateInvitationRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let actor = invitation_admin_actor(&state, &headers, org_id, true).await?;
    let outcome =
        store::create_org_invitation(&state.store, actor, org_id, input, &state.config.email)
            .await?;
    Ok(Json(invitation_outcome_json(outcome)))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/invitations/{invitation_id}/resend",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
        ("invitation_id" = String, Path, description = "Invitation UUID"),
    ),
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Resent organization invitation", body = crate::http::openapi::InvitationEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Admin role required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn resend_invitation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((org_id, invitation_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    let invitation_id = parse_uuid(&invitation_id, "invitation not found")?;
    let actor = invitation_admin_actor(&state, &headers, org_id, true).await?;
    let outcome = store::resend_org_invitation(
        &state.store,
        actor,
        org_id,
        invitation_id,
        &state.config.email,
    )
    .await?;
    Ok(Json(invitation_outcome_json(outcome)))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/invitations/{invitation_id}/revoke",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
        ("invitation_id" = String, Path, description = "Invitation UUID"),
    ),
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Revoked organization invitation", body = crate::http::openapi::InvitationEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Admin role required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn revoke_invitation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((org_id, invitation_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    let invitation_id = parse_uuid(&invitation_id, "invitation not found")?;
    let actor = invitation_admin_actor(&state, &headers, org_id, true).await?;
    Ok(Json(json!({
        "invitation": store::revoke_org_invitation(&state.store, actor, org_id, invitation_id).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/invitations/preview",
    tag = "invitations",
    request_body = crate::domain::InvitationTokenRequest,
    security(),
    responses(
        (status = 200, description = "Safe invitation preview", body = crate::http::openapi::InvitationPreviewEnvelope),
        (status = 404, description = "Invitation not found", body = crate::http::openapi::ErrorResponse),
        (status = 429, description = "Invitation preview rate limited", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn preview_invitation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let input = read_json::<InvitationTokenRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let token = input
        .token
        .clone()
        .ok_or_else(|| AppError::validation("token is required"))?;
    store::record_invitation_token_attempt(
        &state.store,
        &token,
        store::InvitationTokenAttemptScope::Preview,
        Some(&request_rate_key(&headers)),
    )
    .await?;
    Ok(Json(json!({
        "invitation": store::preview_invitation(&state.store, input).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/invitations/accept",
    tag = "invitations",
    request_body = crate::domain::InvitationTokenRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Session payload for accepted organization", body = crate::domain::AuthSessionPayload),
        (status = 401, description = "Browser session required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Invite email mismatch or fresh Clerk exchange required", body = crate::http::openapi::ErrorResponse),
        (status = 410, description = "Invitation expired or revoked", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn accept_invitation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Response> {
    validate_mutation_origin(&state, &headers)?;
    if state.config.managed_clerk_enabled {
        return Err(AppError::with_code(
            axum::http::StatusCode::FORBIDDEN,
            "clerk_exchange_required",
            "a fresh Clerk session exchange is required to accept this invitation",
        ));
    }
    let session = session_context(&state, &headers).await?;
    let input = read_json::<InvitationTokenRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let token = input
        .token
        .ok_or_else(|| crate::errors::AppError::validation("token is required"))?;
    store::record_invitation_token_attempt(
        &state.store,
        &token,
        store::InvitationTokenAttemptScope::Accept,
        Some(&request_rate_key(&headers)),
    )
    .await?;
    let created = store::accept_invitation_for_user(&state.store, &token, session.user.id).await?;
    json_with_session_cookie(&state, &headers, created.payload, &created.token)
}

fn invitation_outcome_json(outcome: store::InvitationSendOutcome) -> Value {
    json!({
        "invitation": outcome.invitation,
        "preview_link": outcome.preview_link,
        "delivery_error": outcome.delivery_error,
    })
}

async fn invitation_admin_actor(
    state: &AppState,
    headers: &HeaderMap,
    org_id: uuid::Uuid,
    require_origin: bool,
) -> AppResult<Option<uuid::Uuid>> {
    if require_strict_bootstrap(state, headers).is_ok() {
        return Ok(None);
    }
    if header_text(headers, "authorization").is_some() {
        return Err(AppError::forbidden(
            "organization invitations require an owner/admin browser session",
        ));
    }
    if require_origin {
        validate_mutation_origin(state, headers)?;
    }
    let session = session_context(state, headers).await?;
    if session.organization.id != org_id {
        return Err(AppError::forbidden(
            "session belongs to a different organization",
        ));
    }
    if store::is_shared_demo_org(&session.organization) {
        return Err(AppError::forbidden(
            "demo workspace browser sessions are read-only",
        ));
    }
    store::require_org_admin(&state.store, session.user.id, org_id).await?;
    Ok(Some(session.user.id))
}
