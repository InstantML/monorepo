use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};

use crate::{
    domain::{
        ClickHouseConnectionCreateRequest, ClickHouseConnectionRotateCredentialsRequest,
        ClickHouseConnectionValidateRequest, CreateApiKeyRequest,
        CreateCurrentUserOrganizationRequest, CreateOrganizationRequest, CreateUserRequest,
        ReserveSeatRequest,
    },
    errors::AppResult,
    store,
};

use super::super::AppState;
use super::helpers::{
    admin_actor, parse_uuid, read_json, reject_demo_session_mutation, require_admin_or_bootstrap,
    require_bootstrap, session_context, validate_mutation_origin,
};

/// List the orgs the calling session-authenticated user belongs to.
///
/// Returns membership-decorated org summaries (role, member count, slug)
/// for the org-switcher dropdown. Distinct from `/api/orgs` which is a
/// bootstrap-only admin route.
#[utoipa::path(
    get,
    path = "/api/orgs/memberships",
    tag = "orgs",
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Membership summaries decorated with role, member count, slug", body = crate::http::openapi::OrgMembershipsEnvelope),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_org_memberships(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let session = session_context(&state, &headers).await?;
    let memberships =
        store::list_user_org_memberships(&state.store, session.user.id, session.organization.id)
            .await?;
    Ok(Json(json!({ "memberships": memberships })))
}

#[utoipa::path(
    post,
    path = "/api/users",
    tag = "orgs",
    request_body = crate::domain::CreateUserRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Created user row", body = crate::http::openapi::UserEnvelope),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    require_bootstrap(&state, &headers)?;
    let input = read_json::<CreateUserRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "user": store::create_user(&state.store, input).await? }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/users",
    tag = "orgs",
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Bootstrap-visible user rows", body = crate::http::openapi::UsersEnvelope),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    require_bootstrap(&state, &headers)?;
    Ok(Json(
        json!({ "users": store::list_users(&state.store).await? }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/orgs",
    tag = "orgs",
    request_body = crate::domain::CreateOrganizationRequest,
    security(("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Bootstrapped organization row", body = crate::http::openapi::OrganizationEnvelope),
        (status = 401, description = "Bootstrap token required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_org(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    require_bootstrap(&state, &headers)?;
    let input =
        read_json::<CreateOrganizationRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "organization": store::create_organization(&state.store, input).await? }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/orgs/current-user",
    tag = "orgs",
    request_body = crate::domain::CreateCurrentUserOrganizationRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Created organization for the current browser user", body = crate::domain::CurrentUserOrganizationCreateResponse),
        (status = 400, description = "Validation error", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Organization or personal workspace already exists", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_current_user_org(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<axum::response::Response> {
    validate_mutation_origin(&state, &headers)?;
    reject_demo_session_mutation(&state, &headers).await?;
    let session = session_context(&state, &headers).await?;
    let input = read_json::<CreateCurrentUserOrganizationRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let created = store::create_current_user_organization(
        &state.store,
        session.user.id,
        session.organization.id,
        input,
        &state.config.billing,
        &state.config.email,
    )
    .await?;
    if let Some(token) = created.token.as_deref() {
        super::helpers::json_with_session_cookie(&state, &headers, created.response, token)
    } else {
        Ok(Json(created.response).into_response())
    }
}

#[utoipa::path(
    get,
    path = "/api/orgs",
    tag = "orgs",
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "List of organizations visible to the caller", body = crate::http::openapi::OrganizationsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_orgs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    require_bootstrap(&state, &headers)?;
    Ok(Json(
        json!({ "organizations": store::list_organizations(&state.store).await? }),
    ))
}

#[utoipa::path(
    get,
    path = "/api/orgs/name-availability",
    tag = "orgs",
    params(
        ("name" = Option<String>, Query, description = "Proposed organization name / slug"),
    ),
    security(),
    responses(
        (status = 200, description = "Availability payload", body = crate::http::openapi::OrganizationNameAvailability),
    ),
)]
pub async fn org_name_availability(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        store::organization_name_availability(&state.store, query.get("name").map(String::as_str))
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/storage/clickhouse-connections/current",
    tag = "storage",
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Current ClickHouse connection setup status", body = crate::http::openapi::ClickHouseConnectionStatusEnvelope),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn customer_clickhouse_connection_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let session = session_context(&state, &headers).await?;
    store::require_org_admin(&state.store, session.user.id, session.organization.id).await?;
    Ok(Json(json!({
        "connection": state.store.customer_clickhouse_status(
            session.organization.id,
            &state.config.byoc_clickhouse,
        ).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/storage/clickhouse-connections/validate",
    tag = "storage",
    request_body = crate::domain::ClickHouseConnectionValidateRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Customer ClickHouse validation result", body = crate::http::openapi::ClickHouseConnectionValidationEnvelope),
        (status = 400, description = "Invalid connection settings", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
        (status = 503, description = "ClickHouse endpoint unavailable", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn validate_customer_clickhouse_connection(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    reject_demo_session_mutation(&state, &headers).await?;
    let session = session_context(&state, &headers).await?;
    store::require_org_admin(&state.store, session.user.id, session.organization.id).await?;
    store::ensure_billing_write_allowed(
        &state.store,
        session.organization.id,
        "configure customer ClickHouse",
    )
    .await?;
    let mut input = read_json::<ClickHouseConnectionValidateRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    if let Some(org_id) = input.org_id {
        if org_id != session.organization.id {
            return Err(crate::errors::AppError::forbidden(
                "session belongs to a different organization",
            ));
        }
    } else {
        input.org_id = Some(session.organization.id);
    }
    Ok(Json(json!({
        "validation": state.store.validate_customer_clickhouse(
            input,
            &state.config.byoc_clickhouse,
        ).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/storage/clickhouse-connections",
    tag = "storage",
    request_body = crate::domain::ClickHouseConnectionCreateRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Saved customer ClickHouse connection status", body = crate::http::openapi::ClickHouseConnectionStatusEnvelope),
        (status = 400, description = "Invalid connection settings", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
        (status = 409, description = "Storage route is already locked", body = crate::http::openapi::ErrorResponse),
        (status = 503, description = "ClickHouse endpoint unavailable", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_customer_clickhouse_connection(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    reject_demo_session_mutation(&state, &headers).await?;
    let session = session_context(&state, &headers).await?;
    store::require_org_admin(&state.store, session.user.id, session.organization.id).await?;
    store::ensure_billing_write_allowed(
        &state.store,
        session.organization.id,
        "configure customer ClickHouse",
    )
    .await?;
    let mut input = read_json::<ClickHouseConnectionCreateRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    if let Some(org_id) = input.org_id {
        if org_id != session.organization.id {
            return Err(crate::errors::AppError::forbidden(
                "session belongs to a different organization",
            ));
        }
    } else {
        input.org_id = Some(session.organization.id);
    }
    Ok(Json(json!({
        "connection": state.store.create_customer_clickhouse_route(
            input,
            &state.config.byoc_clickhouse,
        ).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/storage/clickhouse-connections/rotate-credentials",
    tag = "storage",
    request_body = crate::domain::ClickHouseConnectionRotateCredentialsRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Rotated customer ClickHouse credentials", body = crate::http::openapi::ClickHouseConnectionStatusEnvelope),
        (status = 400, description = "Invalid connection settings", body = crate::http::openapi::ErrorResponse),
        (status = 401, description = "Missing session", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Customer ClickHouse route missing", body = crate::http::openapi::ErrorResponse),
        (status = 503, description = "ClickHouse endpoint or secret store unavailable", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn rotate_customer_clickhouse_credentials(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    reject_demo_session_mutation(&state, &headers).await?;
    let session = session_context(&state, &headers).await?;
    store::require_org_admin(&state.store, session.user.id, session.organization.id).await?;
    store::ensure_billing_write_allowed(
        &state.store,
        session.organization.id,
        "configure customer ClickHouse",
    )
    .await?;
    let mut input = read_json::<ClickHouseConnectionRotateCredentialsRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    if let Some(org_id) = input.org_id {
        if org_id != session.organization.id {
            return Err(crate::errors::AppError::forbidden(
                "session belongs to a different organization",
            ));
        }
    } else {
        input.org_id = Some(session.organization.id);
    }
    Ok(Json(json!({
        "connection": state.store.rotate_customer_clickhouse_credentials(
            input,
            &state.config.byoc_clickhouse,
        ).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/api-keys",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
    ),
    request_body = crate::domain::CreateApiKeyRequest,
    security(("browserSession" = []), ("bearerApiKey" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Created API key plus copy-once plaintext", body = crate::http::openapi::ApiKeyCreatedEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn create_api_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    let input = read_json::<CreateApiKeyRequest>(&headers, bytes, state.config.max_body_bytes)?;
    match admin_actor(&state, &headers, org_id).await? {
        Some(user_id) => Ok(Json(
            store::create_api_key_for_user(&state.store, user_id, org_id, input).await?,
        )),
        None => Ok(Json(
            store::create_api_key(&state.store, org_id, input).await?,
        )),
    }
}

#[utoipa::path(
    get,
    path = "/api/orgs/{org_id}/api-keys",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
    ),
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "API keys for the organization", body = crate::http::openapi::ApiKeysEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_api_keys(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    require_admin_or_bootstrap(&state, &headers, org_id).await?;
    Ok(Json(
        json!({ "api_keys": store::list_api_keys(&state.store, org_id).await? }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/api-keys/{api_key_id}/revoke",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
        ("api_key_id" = String, Path, description = "API key UUID"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Revoked API key row", body = crate::http::openapi::ApiKeyEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "API key not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn revoke_api_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((org_id, api_key_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    if session_cookie(&headers).is_some() {
        validate_mutation_origin(&state, &headers)?;
        reject_demo_session_mutation(&state, &headers).await?;
    }
    require_admin_or_bootstrap(&state, &headers, org_id).await?;
    let api_key_id = parse_uuid(&api_key_id, "api key not found")?;
    Ok(Json(
        json!({ "key": store::revoke_api_key(&state.store, org_id, api_key_id).await? }),
    ))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/service-accounts/{service_account_id}/disable",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
        ("service_account_id" = String, Path, description = "Service account UUID"),
    ),
    security(("browserSession" = []), ("bearerApiKey" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Disabled service account row", body = crate::http::openapi::ServiceAccountEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
        (status = 404, description = "Service account not found", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn disable_service_account(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((org_id, service_account_id)): Path<(String, String)>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    if session_cookie(&headers).is_some() {
        validate_mutation_origin(&state, &headers)?;
        reject_demo_session_mutation(&state, &headers).await?;
    }
    require_admin_or_bootstrap(&state, &headers, org_id).await?;
    let service_account_id = parse_uuid(&service_account_id, "service account not found")?;
    Ok(Json(json!({
        "service_account": store::disable_service_account(&state.store, org_id, service_account_id).await?
    })))
}

#[utoipa::path(
    post,
    path = "/api/orgs/{org_id}/seats",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
    ),
    request_body = crate::domain::ReserveSeatRequest,
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Reserved (invited) seat row", body = crate::http::openapi::SeatEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn reserve_seat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    let input = read_json::<ReserveSeatRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let actor = admin_actor(&state, &headers, org_id).await?;
    Ok(Json(json!({
        "seat": store::reserve_seat(&state.store, actor, org_id, input).await?
    })))
}

#[utoipa::path(
    get,
    path = "/api/orgs/{org_id}/seats",
    tag = "orgs",
    params(
        ("org_id" = String, Path, description = "Organization UUID"),
    ),
    security(("browserSession" = []), ("bootstrapToken" = [])),
    responses(
        (status = 200, description = "Seats for the organization", body = crate::http::openapi::SeatsEnvelope),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
        (status = 403, description = "Insufficient role", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn list_seats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
) -> AppResult<Json<Value>> {
    let org_id = parse_uuid(&org_id, "organization not found")?;
    require_admin_or_bootstrap(&state, &headers, org_id).await?;
    Ok(Json(json!({
        "seats": store::list_seats(&state.store, org_id).await?
    })))
}

// Re-export session_cookie for use by revoke_api_key / disable_service_account.
use super::helpers::session_cookie;
