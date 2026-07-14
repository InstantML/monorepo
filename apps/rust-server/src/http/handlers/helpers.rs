use std::net::{IpAddr, SocketAddr};

use axum::{
    body::Bytes,
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::{
    domain::{AuthContext, AuthSessionPayload, RequestContext, SessionContext},
    errors::{AppError, AppResult},
    store,
};

use super::super::{AppState, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SECS};

const MCP_OAUTH_ORG_HEADER: &str = "x-instantml-oauth-org-id";

pub fn require_bootstrap(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if !state.config.auth_mode.requires_api_key() {
        return Ok(());
    }
    require_strict_bootstrap(state, headers)
}

pub fn require_strict_bootstrap(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if state.config.bootstrap_token.is_empty() {
        return Err(AppError::unauthorized("bootstrap token is not configured"));
    }
    match header_text(headers, "x-instantml-bootstrap-token") {
        Some(token) if token == state.config.bootstrap_token => Ok(()),
        _ => Err(AppError::unauthorized("invalid bootstrap token")),
    }
}

pub async fn require_admin_or_bootstrap(
    state: &AppState,
    headers: &HeaderMap,
    org_id: Uuid,
) -> AppResult<()> {
    if require_strict_bootstrap(state, headers).is_ok() {
        return Ok(());
    }
    if header_text(headers, "authorization").is_some() {
        let ctx = context(state, headers, true).await?;
        if ctx.org_id != org_id {
            return Err(AppError::forbidden(
                "organization belongs to a different API key",
            ));
        }
        require_scope(&ctx, "api_keys:write", state)?;
        return store::require_unrestricted_org_access(&ctx);
    }
    if state.config.auth_mode.requires_api_key() && session_cookie(headers).is_none() {
        require_strict_bootstrap(state, headers)?;
        return Ok(());
    }
    let session = session_context(state, headers).await?;
    if session.organization.id != org_id {
        return Err(AppError::forbidden(
            "session belongs to a different organization",
        ));
    }
    store::require_org_admin(&state.store, session.user.id, org_id)
        .await
        .map(|_| ())
}

pub async fn admin_actor(
    state: &AppState,
    headers: &HeaderMap,
    org_id: Uuid,
) -> AppResult<Option<Uuid>> {
    if require_strict_bootstrap(state, headers).is_ok() {
        return Ok(None);
    }
    if header_text(headers, "authorization").is_some() {
        let ctx = context(state, headers, true).await?;
        if ctx.org_id != org_id {
            return Err(AppError::forbidden(
                "organization belongs to a different API key",
            ));
        }
        require_scope(&ctx, "api_keys:write", state)?;
        store::require_unrestricted_org_access(&ctx)?;
        return Ok(None);
    }
    if state.config.auth_mode.requires_api_key() && session_cookie(headers).is_none() {
        require_strict_bootstrap(state, headers)?;
        return Ok(None);
    }
    validate_mutation_origin(state, headers)?;
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

pub async fn reject_demo_session_mutation(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    let session = session_context(state, headers).await?;
    if store::is_shared_demo_org(&session.organization) {
        return Err(AppError::forbidden(
            "demo workspace browser sessions are read-only",
        ));
    }
    Ok(())
}

pub async fn context(
    state: &AppState,
    headers: &HeaderMap,
    tenant_route: bool,
) -> AppResult<RequestContext> {
    // Tier 2: valid data-plane requests no longer refresh control state on
    // every request. A background task (spawned in `serve()` for the data
    // plane) keeps the in-memory projection fresh out-of-band. On auth miss
    // only, we force one control refresh and retry so newly created sessions
    // and API keys become usable immediately after control-plane writes.
    let ctx = match header_text(headers, "authorization") {
        Some(header) => {
            let token = header
                .strip_prefix("Bearer ")
                .or_else(|| header.strip_prefix("bearer "))
                .ok_or_else(|| AppError::unauthorized("authorization must use bearer token"))?;
            // Third bearer tier (flag-gated): a Clerk OAuth access token from
            // the hosted MCP browser sign-in. Off by default, so the API-key
            // path below is byte-identical when disabled. An InstantML API key
            // always starts with `instantml_`, so a token without that prefix
            // is the OAuth case. Permissions mirror the user's own org role
            // (the reviewed follow-up to the read-only v1), so the grant never
            // exceeds what the user could do in the dashboard.
            // See docs/design/2026-06-30-mcp-oauth.md.
            if mcp_oauth_enabled() && !token.starts_with("instantml_") {
                let requested_org_id = mcp_oauth_requested_org_id(headers)?;
                let grant = authenticate_mcp_oauth(state, token, requested_org_id).await?;
                RequestContext {
                    org_id: grant.org_id,
                    auth: None,
                    session: Some(SessionContext {
                        session_id: Uuid::nil(),
                        user_id: grant.user_id,
                        role: grant.role,
                        demo_read_only: grant.demo_read_only,
                        mcp_oauth: true,
                    }),
                }
            } else {
                let auth = authenticate_api_key_with_auth_miss_refresh(state, token).await?;
                RequestContext {
                    org_id: auth.org_id,
                    auth: Some(auth),
                    session: None,
                }
            }
        }
        None => {
            let Some(token) = session_cookie(headers) else {
                if state.config.auth_mode.requires_api_key() && tenant_route {
                    return Err(AppError::unauthorized("missing bearer token"));
                }
                return Ok(RequestContext::local());
            };
            let payload = authenticate_session_with_auth_miss_refresh(state, token).await?;
            RequestContext {
                org_id: payload.organization.id,
                auth: None,
                session: Some(SessionContext {
                    session_id: payload.session.id,
                    user_id: payload.user.id,
                    role: payload.membership.role,
                    demo_read_only: store::is_shared_demo_org(&payload.organization),
                    mcp_oauth: false,
                }),
            }
        }
    };
    if tenant_route {
        state.store.ensure_tenant_loaded(ctx.org_id).await?;
    }
    Ok(ctx)
}

async fn authenticate_api_key_with_auth_miss_refresh(
    state: &AppState,
    token: &str,
) -> AppResult<AuthContext> {
    match store::authenticate_api_key(&state.store, token).await {
        Ok(auth) => Ok(auth),
        Err(error) if state.config.service_plane.runs_background_control_refresh() => {
            if let Err(refresh_error) = state.store.refresh_control_records_for_auth_miss().await {
                tracing::warn!(
                    workflow = "control_refresh",
                    operation = "auth_miss_refresh",
                    outcome = "failure",
                    auth_kind = "api_key",
                    status = refresh_error.status().as_u16(),
                    code = refresh_error.safe_code(),
                    error_kind = refresh_error.safe_code(),
                    retryable = refresh_error.retryable(),
                    safe_summary = refresh_error.safe_summary(),
                    "control-record refresh after API-key auth miss failed"
                );
                return Err(error);
            }
            store::authenticate_api_key(&state.store, token).await
        }
        Err(error) => Err(error),
    }
}

async fn authenticate_session_with_auth_miss_refresh(
    state: &AppState,
    token: &str,
) -> AppResult<AuthSessionPayload> {
    match store::authenticate_session(&state.store, token).await {
        Ok(payload) => Ok(payload),
        Err(error) if state.config.service_plane.runs_background_control_refresh() => {
            if let Err(refresh_error) = state.store.refresh_control_records_for_auth_miss().await {
                tracing::warn!(
                    workflow = "control_refresh",
                    operation = "auth_miss_refresh",
                    outcome = "failure",
                    auth_kind = "session",
                    status = refresh_error.status().as_u16(),
                    code = refresh_error.safe_code(),
                    error_kind = refresh_error.safe_code(),
                    retryable = refresh_error.retryable(),
                    safe_summary = refresh_error.safe_summary(),
                    "control-record refresh after session auth miss failed"
                );
                return Err(error);
            }
            store::authenticate_session(&state.store, token).await
        }
        Err(error) => Err(error),
    }
}

/// Enable the MCP OAuth token bridge (hosted browser sign-in). Off by default,
/// so `context()` is unchanged in production. Read from the environment directly
/// for now; move to `Config` (config.rs `env_bool_optional`) when the bridge
/// graduates from review-gated to default.
fn mcp_oauth_enabled() -> bool {
    match std::env::var("INSTANTML_MCP_OAUTH_ENABLED") {
        Ok(value) => {
            let value = value.trim();
            value == "1" || value.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

fn mcp_oauth_requested_org_id(headers: &HeaderMap) -> AppResult<Option<Uuid>> {
    let Some(raw) = header_text(headers, MCP_OAUTH_ORG_HEADER) else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    Uuid::parse_str(raw).map(Some).map_err(|_| {
        AppError::validation(format!(
            "{MCP_OAUTH_ORG_HEADER} must be a valid organization UUID"
        ))
    })
}

/// Authenticate a Clerk OAuth access token (hosted MCP browser sign-in) and
/// resolve it to an org-scoped grant that mirrors the user's own role
/// (docs/design/2026-06-30-mcp-oauth.md).
///
/// 1. Verify the token via the Clerk Backend API using the configured Clerk
///    secret key.
/// 2. Map the Clerk user (`provider = "clerk"`, `provider_subject = subject`) to
///    the internal user and resolve the org/role from active memberships
///    (named org when present; otherwise single membership only).
///
/// Clerk cannot issue custom scopes, so `principal.scopes` is intentionally
/// unused: authorization is the mirrored role enforced server-side by
/// `require_session_scope` and the store-level role checks.
async fn authenticate_mcp_oauth(
    state: &AppState,
    token: &str,
    requested_org_id: Option<Uuid>,
) -> AppResult<store::OAuthIdentityGrant> {
    let secret_key = state
        .config
        .clerk_secret_key
        .as_deref()
        .ok_or_else(|| AppError::unauthorized("OAuth is not configured"))?;
    let principal = crate::managed_auth::verify_clerk_oauth_token(
        secret_key,
        &state.config.clerk_api_base,
        token,
    )
    .await?;
    store::authenticate_oauth_identity_for_org(
        &state.store,
        "clerk",
        &principal.subject,
        requested_org_id,
    )
    .await
}

pub fn require_scope(ctx: &RequestContext, scope: &str, state: &AppState) -> AppResult<()> {
    if let Some(auth) = &ctx.auth {
        return auth.require_scope(scope);
    }
    if let Some(session) = &ctx.session {
        return require_session_scope(session, scope);
    }
    if state.config.auth_mode.requires_api_key() {
        return Err(AppError::unauthorized("missing bearer token"));
    }
    Ok(())
}

pub fn require_session_scope(session: &SessionContext, scope: &str) -> AppResult<()> {
    if session.demo_read_only {
        return if scope == "export:read" {
            Ok(())
        } else {
            Err(AppError::forbidden(
                "demo workspace browser sessions are read-only",
            ))
        };
    }
    let role = session.role.as_str();
    let allowed = match scope {
        "sdk:ingest" | "artifacts:write" | "runs:control" => {
            matches!(role, "owner" | "admin" | "member")
        }
        "artifacts:manage" | "imports:write" | "usage:read" | "api_keys:write" => {
            matches!(role, "owner" | "admin")
        }
        "export:read" => matches!(role, "owner" | "admin" | "member" | "viewer"),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(AppError::forbidden(format!(
            "session role requires permission {scope}"
        )))
    }
}

pub fn request_rate_key(headers: &HeaderMap, peer: SocketAddr) -> String {
    let peer_key = format!("ip:{}", peer.ip());
    forwarded_rate_ip(headers)
        .map(|client_ip| format!("{peer_key};client:{client_ip}"))
        .unwrap_or(peer_key)
}

fn forwarded_rate_ip(headers: &HeaderMap) -> Option<IpAddr> {
    for name in ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] {
        if let Some(raw) = header_text(headers, name) {
            let candidate = raw.split(',').next()?.trim();
            if let Ok(ip) = candidate.parse::<IpAddr>() {
                return Some(ip);
            }
        }
    }
    None
}

pub async fn session_context(
    state: &AppState,
    headers: &HeaderMap,
) -> AppResult<crate::domain::AuthSessionPayload> {
    let token = session_cookie(headers).ok_or_else(|| AppError::unauthorized("missing session"))?;
    store::authenticate_session(&state.store, token).await
}

pub fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    cookie_value(headers, SESSION_COOKIE)
}

pub fn cookie_value<'a>(headers: &'a HeaderMap, cookie_name: &str) -> Option<&'a str> {
    let raw = header_text(headers, "cookie")?;
    raw.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == cookie_name && !value.is_empty()).then_some(value)
    })
}

pub fn json_with_session_cookie<T: serde::Serialize>(
    state: &AppState,
    headers: &HeaderMap,
    payload: T,
    token: &str,
) -> AppResult<Response> {
    let mut response = Json(payload).into_response();
    response.headers_mut().append(
        axum::http::header::SET_COOKIE,
        header_value(&session_cookie_header(
            token,
            is_secure_request(state, headers),
        ))?,
    );
    Ok(response)
}

pub fn session_cookie_header(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_COOKIE_MAX_AGE_SECS}"
    ) + secure
}

pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

pub fn is_secure_request(state: &AppState, headers: &HeaderMap) -> bool {
    if let Some(proto) = header_text(headers, "x-forwarded-proto") {
        return proto.eq_ignore_ascii_case("https");
    }
    // Without an explicit forwarded-proto, fall back to topology heuristics.
    // The bind address may be 0.0.0.0 inside a container even when the client
    // reached us via http://localhost:PORT — using the request's Host header
    // catches that case so we don't set `Secure` on cookies the browser will
    // then refuse to send back.
    let host_is_loopback = header_text(headers, "host")
        .map(|host| {
            let bare = host.split(':').next().unwrap_or(host);
            matches!(bare, "localhost" | "127.0.0.1" | "::1" | "[::1]")
        })
        .unwrap_or(false);
    if host_is_loopback {
        return false;
    }
    !state.config.bind_addr.ip().is_loopback()
}

pub fn validate_mutation_origin(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    validate_mutation_origin_inner(state, headers, state.config.auth_mode.requires_api_key())
}

pub fn validate_mutation_origin_required(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    validate_mutation_origin_inner(state, headers, true)
}

pub fn validate_session_mutation_origin(
    state: &AppState,
    headers: &HeaderMap,
    ctx: &RequestContext,
) -> AppResult<()> {
    if session_requires_mutation_origin(ctx) {
        validate_mutation_origin(state, headers)?;
    }
    Ok(())
}

/// The origin gate is CSRF protection for cookie-authenticated browser
/// sessions. An MCP OAuth context authenticates with an explicit bearer token
/// that browsers never attach ambiently, and the MCP bridge sends no Origin
/// header, so those requests skip the gate.
fn session_requires_mutation_origin(ctx: &RequestContext) -> bool {
    ctx.session
        .as_ref()
        .is_some_and(|session| !session.mcp_oauth)
}

pub fn validate_mutation_origin_inner(
    state: &AppState,
    headers: &HeaderMap,
    require_origin: bool,
) -> AppResult<()> {
    let Some(origin) = header_text(headers, "origin") else {
        return if require_origin {
            Err(AppError::forbidden("origin is required for this request"))
        } else {
            Ok(())
        };
    };
    let origin = origin.trim_end_matches('/');
    if state
        .config
        .allowed_frontend_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        return Ok(());
    }
    if request_origin(state, headers).as_deref() == Some(origin) {
        return Ok(());
    }
    if let Ok(url) = Url::parse(origin) {
        if url
            .host_str()
            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"))
        {
            return Ok(());
        }
    }
    Err(AppError::forbidden(
        "origin is not allowed for this request",
    ))
}

pub fn request_origin(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let host = header_text(headers, "host")?;
    let scheme = if is_secure_request(state, headers) {
        "https"
    } else {
        "http"
    };
    Some(format!("{scheme}://{host}"))
}

pub fn read_json<T: DeserializeOwned>(
    headers: &HeaderMap,
    bytes: Bytes,
    max_bytes: usize,
) -> AppResult<T> {
    validate_json_body(headers, &bytes, max_bytes)?;
    serde_json::from_slice::<T>(&bytes)
        .map_err(|_| AppError::validation("request body must be valid JSON"))
}

pub fn read_json_value(headers: &HeaderMap, bytes: Bytes, max_bytes: usize) -> AppResult<Value> {
    validate_json_body(headers, &bytes, max_bytes)?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::validation("request body must be valid JSON"))?;
    if !raw.is_object() {
        return Err(AppError::validation("request body must be a JSON object"));
    }
    Ok(raw)
}

pub fn read_json_with_raw<T: DeserializeOwned>(
    headers: &HeaderMap,
    bytes: Bytes,
    max_bytes: usize,
) -> AppResult<(T, Value)> {
    let raw = read_json_value(headers, bytes, max_bytes)?;
    let typed = serde_json::from_value::<T>(raw.clone())
        .map_err(|_| AppError::validation("request body must be valid JSON"))?;
    Ok((typed, raw))
}

pub fn validate_json_body(headers: &HeaderMap, bytes: &Bytes, max_bytes: usize) -> AppResult<()> {
    if bytes.len() > max_bytes {
        return Err(AppError::payload_too_large("request body is too large"));
    }
    if let Some(length) = header_text(headers, "content-length") {
        let length = length
            .parse::<usize>()
            .map_err(|_| AppError::validation("invalid content-length"))?;
        if length > max_bytes {
            return Err(AppError::payload_too_large("request body is too large"));
        }
    }
    let content_type = header_text(headers, "content-type").unwrap_or_default();
    if !content_type.contains("application/json") {
        return Err(AppError::validation(
            "content-type must be application/json",
        ));
    }
    Ok(())
}

pub fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

pub fn parse_uuid(raw: &str, missing_message: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found(missing_message))
}

pub fn header_value(value: &str) -> AppResult<HeaderValue> {
    HeaderValue::from_str(value).map_err(|_| AppError::internal("invalid header value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_oauth_requested_org_id_parses_optional_header() {
        let org_id = Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap();
        let mut headers = HeaderMap::new();
        assert_eq!(mcp_oauth_requested_org_id(&headers).unwrap(), None);

        headers.insert(MCP_OAUTH_ORG_HEADER, HeaderValue::from_static(""));
        assert_eq!(mcp_oauth_requested_org_id(&headers).unwrap(), None);

        headers.insert(
            MCP_OAUTH_ORG_HEADER,
            HeaderValue::from_static("11111111-2222-4333-8444-555555555555"),
        );
        assert_eq!(mcp_oauth_requested_org_id(&headers).unwrap(), Some(org_id));

        headers.insert(MCP_OAUTH_ORG_HEADER, HeaderValue::from_static("not-an-org"));
        assert!(mcp_oauth_requested_org_id(&headers).is_err());
    }

    #[test]
    fn mutation_origin_gate_applies_to_cookie_sessions_not_mcp_oauth() {
        let session = |mcp_oauth: bool| {
            Some(SessionContext {
                session_id: Uuid::nil(),
                user_id: Uuid::nil(),
                role: "member".to_string(),
                demo_read_only: false,
                mcp_oauth,
            })
        };
        let ctx = |session| RequestContext {
            org_id: Uuid::nil(),
            auth: None,
            session,
        };
        // Cookie-authenticated browser sessions stay behind the CSRF origin
        // gate; bearer-authenticated MCP OAuth contexts (no ambient
        // credentials, no Origin header from the bridge) are exempt.
        assert!(session_requires_mutation_origin(&ctx(session(false))));
        assert!(!session_requires_mutation_origin(&ctx(session(true))));
        assert!(!session_requires_mutation_origin(&ctx(None)));
    }
}
