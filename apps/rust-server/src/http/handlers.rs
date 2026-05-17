use super::*;

pub(super) async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

pub(super) async fn readyz(State(state): State<Arc<AppState>>) -> AppResult<Json<Value>> {
    if state.config.service_plane.includes_data() && !store::ready(&state.store).await {
        return Err(AppError::service_unavailable(
            "clickhouse operational store is not ready",
        ));
    }
    if !state.config.service_plane.includes_data() && !store::control_ready(&state.store).await {
        return Err(AppError::service_unavailable(
            "clickhouse control store is not ready",
        ));
    }
    Ok(Json(json!({ "status": "ok" })))
}

pub(super) async fn metrics() -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        "instantml_rust_build_info{service=\"rust-server\"} 1\n",
    )
        .into_response()
}

pub(super) async fn openapi_json(State(state): State<Arc<AppState>>) -> Json<Value> {
    let mut paths = serde_json::Map::new();
    openapi_insert(
        &mut paths,
        "/health",
        &[(
            "get",
            openapi_operation("Liveness check", None, &[], &[("200", "healthy")], true),
        )],
    );
    openapi_insert(
        &mut paths,
        "/healthz",
        &[(
            "get",
            openapi_operation(
                "Liveness check alias",
                None,
                &[],
                &[("200", "healthy")],
                true,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/readyz",
        &[(
            "get",
            openapi_operation(
                "Readiness check for operational and metric stores",
                None,
                &[],
                &[("200", "ready"), ("503", "not ready")],
                true,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/metrics",
        &[(
            "get",
            openapi_operation(
                "Prometheus text metrics",
                None,
                &[],
                &[("200", "Prometheus text exposition")],
                true,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/openapi.json",
        &[(
            "get",
            openapi_operation(
                "Compact route index",
                None,
                &[],
                &[("200", "OpenAPI route index")],
                true,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/auth/config",
        &[(
            "get",
            openapi_operation(
                "Frontend auth provider availability",
                None,
                &[],
                &[("200", "dev and Clerk auth booleans")],
                true,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/auth/dev/google",
        &[(
            "post",
            openapi_operation(
                "Create local development Google-style browser session",
                Some(("x-instantml-auth", "local-dev-origin")),
                &[],
                &[("200", "session payload and session cookie")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/auth/clerk",
        &[(
            "post",
            openapi_operation(
                "Exchange Clerk session token for InstantML browser session",
                Some(("x-instantml-auth", "allowed-origin")),
                &[],
                &[("200", "session payload and session cookie")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/auth/session",
        &[(
            "get",
            openapi_operation(
                "Read current browser session",
                None,
                &[],
                &[(
                    "200",
                    "authenticated session payload or authenticated=false",
                )],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/auth/logout",
        &[(
            "post",
            openapi_operation(
                "Revoke current browser session and clear cookie",
                Some(("x-instantml-auth", "allowed-origin")),
                &[],
                &[("200", "authenticated=false")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/users",
        &[
            (
                "post",
                openapi_operation(
                    "Bootstrap a user",
                    Some(("x-instantml-auth", "bootstrap-token")),
                    &[],
                    &[("200", "user row")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List bootstrap users",
                    Some(("x-instantml-auth", "bootstrap-token")),
                    &[],
                    &[("200", "user rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/orgs",
        &[
            (
                "post",
                openapi_operation(
                    "Bootstrap an organization",
                    Some(("x-instantml-auth", "bootstrap-token")),
                    &[],
                    &[("200", "organization row")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List organizations",
                    Some(("x-instantml-auth", "bootstrap-token")),
                    &[],
                    &[("200", "organization rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/orgs/name-availability",
        &[(
            "get",
            openapi_operation(
                "Check organization slug availability",
                None,
                &["name"],
                &[("200", "availability payload")],
                true,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/orgs/{org_id}/api-keys",
        &[
            (
                "post",
                openapi_operation(
                    "Create a copy-once SDK API key",
                    Some((
                        "x-instantml-auth",
                        "owner/admin session, api_keys:write API key, or bootstrap token",
                    )),
                    &[],
                    &[("200", "plaintext api_key once plus public key row")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List API keys for an organization",
                    Some((
                        "x-instantml-auth",
                        "owner/admin session, api_keys:write API key, or bootstrap token",
                    )),
                    &[],
                    &[("200", "public API key rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/orgs/{org_id}/seats",
        &[
            (
                "get",
                openapi_operation(
                    "List organization seats",
                    Some(("x-instantml-auth", "owner/admin session or bootstrap token")),
                    &[],
                    &[("200", "seat rows")],
                    false,
                ),
            ),
            (
                "post",
                openapi_operation(
                    "Reserve an invited organization seat",
                    Some(("x-instantml-auth", "owner/admin session or bootstrap token")),
                    &[],
                    &[("200", "seat row")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/orgs/{org_id}/api-keys/{api_key_id}/revoke",
        &[(
            "post",
            openapi_operation(
                "Revoke an API key",
                Some((
                    "x-instantml-auth",
                    "owner/admin session, api_keys:write API key, or bootstrap token",
                )),
                &[],
                &[("200", "revoked public API key row")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/orgs/{org_id}/service-accounts/{service_account_id}/disable",
        &[(
            "post",
            openapi_operation(
                "Disable a service account",
                Some((
                    "x-instantml-auth",
                    "owner/admin session, api_keys:write API key, or bootstrap token",
                )),
                &[],
                &[("200", "disabled service account row")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/projects",
        &[
            (
                "post",
                openapi_operation(
                    "Create or fetch a project by name",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "project row")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List projects visible to the current tenant context",
                    None,
                    &[],
                    &[("200", "project rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/runs",
        &[
            (
                "post",
                openapi_operation(
                    "Create a run and implicitly create the project when allowed",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "run row")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List runs with bounded filters and offset pagination",
                    None,
                    &[
                        "project",
                        "status",
                        "q",
                        "sort_by",
                        "metric_key",
                        "limit",
                        "offset",
                    ],
                    &[("200", "run summaries")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/runs/{run_id}",
        &[
            (
                "get",
                openapi_operation(
                    "Fetch one summarized run",
                    None,
                    &[],
                    &[("200", "run summary")],
                    false,
                ),
            ),
            (
                "patch",
                openapi_operation(
                    "Update run status, tags, or notes",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "updated run row")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/runs/{run_id}/metrics",
        &[
            (
                "post",
                openapi_operation(
                    "Log scalar metrics for one run",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "inserted metric count")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "Read bounded scalar metric points for one run",
                    None,
                    &["key", "start_step", "end_step", "limit"],
                    &[("200", "metric point rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/metrics/series",
        &[(
            "post",
            openapi_operation(
                "Read bounded metric series for multiple runs",
                None,
                &[],
                &[("200", "series grouped by run_id")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/{run_id}/logs",
        &[
            (
                "post",
                openapi_operation(
                    "Append stdout or stderr console lines",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "inserted log count")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "Read bounded stdout or stderr console lines",
                    None,
                    &["stream", "limit", "cursor", "q"],
                    &[("200", "console log page")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/overview",
        &[(
            "get",
            openapi_operation(
                "Dashboard overview counts and selected metric best value",
                None,
                &["project", "status", "q", "metric_key"],
                &[("200", "overview payload")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/summary",
        &[(
            "get",
            openapi_operation(
                "Dashboard run summaries with cursor pagination and metric key catalog",
                None,
                &[
                    "project",
                    "status",
                    "q",
                    "sort_by",
                    "metric_key",
                    "limit",
                    "offset",
                    "cursor",
                ],
                &[("200", "summary page")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/side-by-side",
        &[(
            "get",
            openapi_operation(
                "Compare runs by config, metadata, tags, attributes, and metric aggregates",
                None,
                &["run_ids", "runs", "reference_run_id", "diff_only"],
                &[("200", "comparison rows")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/{run_id}/attributes",
        &[
            (
                "post",
                openapi_operation(
                    "Create typed non-rich attributes",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "created attributes")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List typed attributes for a run",
                    None,
                    &["type", "path_prefix", "limit", "offset"],
                    &[("200", "attribute rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/{run_id}/objects",
        &[
            (
                "post",
                openapi_operation(
                    "Create rich table, media, or histogram objects",
                    Some(("x-instantml-scope", "sdk:ingest")),
                    &[],
                    &[("200", "created object")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List rich objects for a run",
                    None,
                    &["kind", "key", "limit", "offset"],
                    &[("200", "object page")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/objects/{object_id}/rows",
        &[(
            "get",
            openapi_operation(
                "Read bounded rows for a table object",
                None,
                &["limit", "offset"],
                &[("200", "table object rows")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/{run_id}/artifacts",
        &[
            (
                "post",
                openapi_operation(
                    "Create artifact metadata",
                    Some(("x-instantml-scope", "artifacts:write")),
                    &[],
                    &[("200", "artifact row")],
                    false,
                ),
            ),
            (
                "get",
                openapi_operation(
                    "List artifacts for a run",
                    None,
                    &["limit"],
                    &[("200", "artifact rows")],
                    false,
                ),
            ),
        ],
    );
    openapi_insert(
        &mut paths,
        "/api/runs/{run_id}/artifacts/upload",
        &[(
            "post",
            openapi_operation(
                "Upload local artifact bytes and create artifact metadata",
                Some(("x-instantml-scope", "artifacts:write")),
                &[],
                &[
                    ("200", "artifact row"),
                    (
                        "403",
                        "disabled in hosted mode until object storage is configured",
                    ),
                ],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/artifacts/{artifact_id}/download",
        &[(
            "get",
            openapi_operation(
                "Download locally stored artifact bytes",
                None,
                &[],
                &[("200", "artifact byte stream")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/export",
        &[(
            "get",
            openapi_operation(
                "Bounded JSON export of filtered tenant data",
                Some(("x-instantml-scope", "export:read for API keys")),
                &["project", "status", "q", "sort_by", "metric_key"],
                &[("200", "versioned export payload")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/usage",
        &[(
            "get",
            openapi_operation(
                "Computed org usage summary",
                Some((
                    "x-instantml-scope",
                    "usage:read and unrestricted org access",
                )),
                &[],
                &[("200", "usage payload")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/usage/export",
        &[(
            "get",
            openapi_operation(
                "Versioned usage export",
                Some((
                    "x-instantml-scope",
                    "usage:read and unrestricted org access",
                )),
                &[],
                &[("200", "usage export payload")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/imports",
        &[(
            "get",
            openapi_operation(
                "List recent imports",
                None,
                &[],
                &[("200", "import rows")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/imports/neptune",
        &[(
            "post",
            openapi_operation(
                "Import normalized Neptune JSON",
                Some(("x-instantml-scope", "imports:write")),
                &["dry_run"],
                &[("200", "dry-run or completed import summary")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/imports/wandb",
        &[(
            "post",
            openapi_operation(
                "Import normalized W&B JSON",
                Some(("x-instantml-scope", "imports:write")),
                &["dry_run"],
                &[("200", "dry-run or completed import summary")],
                false,
            ),
        )],
    );
    openapi_insert(
        &mut paths,
        "/api/imports/mlflow",
        &[(
            "post",
            openapi_operation(
                "Import normalized MLflow JSON",
                Some(("x-instantml-scope", "imports:write")),
                &["dry_run"],
                &[("200", "dry-run or completed import summary")],
                false,
            ),
        )],
    );

    let service_plane = state.config.service_plane;
    paths.retain(|path, _| openapi_path_available_for_plane(path, service_plane));

    Json(json!({
        "openapi": "3.1.0",
        "info": {
            "title": "InstantML Rust API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Current Rust/ClickHouse API route index. See docs/architecture/current-api.md for inputs, query parameters, response envelopes, auth scopes, and examples."
        },
        "x-instantml-service-plane": service_plane.as_str(),
        "security": [
            { "bearerApiKey": [] },
            { "browserSession": [] }
        ],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearerApiKey": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "InstantML SDK API key sent as Authorization: Bearer instantml_..."
                },
                "browserSession": {
                    "type": "apiKey",
                    "in": "cookie",
                    "name": "instantml_session",
                    "description": "HttpOnly browser session cookie issued by /api/auth/dev/google or /api/auth/clerk"
                },
                "bootstrapToken": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "X-InstantML-Bootstrap-Token",
                    "description": "Operator-only bootstrap token for initial users, orgs, and admin key paths"
                }
            }
        }
    }))
}

fn openapi_path_available_for_plane(
    path: &str,
    service_plane: crate::config::ServicePlaneRole,
) -> bool {
    if matches!(
        path,
        "/health" | "/healthz" | "/readyz" | "/metrics" | "/openapi.json" | "/api/auth/config"
    ) {
        return true;
    }
    if path.starts_with("/api/auth/")
        || path == "/api/users"
        || path == "/api/orgs"
        || path == "/api/orgs/name-availability"
        || path.starts_with("/api/orgs/{org_id}/")
    {
        return service_plane.includes_control();
    }
    service_plane.includes_data()
}

fn openapi_insert(
    paths: &mut serde_json::Map<String, Value>,
    path: &str,
    operations: &[(&str, Value)],
) {
    let mut path_item = serde_json::Map::new();
    for (method, operation) in operations {
        path_item.insert((*method).to_string(), operation.clone());
    }
    paths.insert(path.to_string(), Value::Object(path_item));
}

fn openapi_operation(
    summary: &str,
    extension: Option<(&str, &str)>,
    query_parameters: &[&str],
    response_specs: &[(&str, &str)],
    public: bool,
) -> Value {
    let mut operation = serde_json::Map::new();
    operation.insert("summary".to_string(), json!(summary));
    if public {
        operation.insert("security".to_string(), json!([]));
    }
    if let Some((key, value)) = extension {
        operation.insert(key.to_string(), json!(value));
    }
    if !query_parameters.is_empty() {
        let parameters = query_parameters
            .iter()
            .map(|name| json!({ "name": name, "in": "query" }))
            .collect::<Vec<_>>();
        operation.insert("x-query-parameters".to_string(), json!(parameters));
    }
    let mut responses = serde_json::Map::new();
    for (status, description) in response_specs {
        responses.insert((*status).to_string(), json!({ "description": description }));
    }
    operation.insert("responses".to_string(), Value::Object(responses));
    Value::Object(operation)
}

pub(super) async fn auth_config(State(state): State<Arc<AppState>>) -> Json<Value> {
    let exposes_auth_routes = state.config.service_plane.includes_control();
    Json(json!({
        "dev_auth_enabled": exposes_auth_routes && state.config.dev_auth_enabled,
        "managed_clerk_enabled": exposes_auth_routes && state.config.managed_clerk_enabled,
        "service_plane": state.config.service_plane.as_str()
    }))
}

pub(super) async fn auth_dev_google(
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
    let created = store::create_dev_google_session(&state.store, input).await?;
    json_with_session_cookie(&state, &headers, created.payload, &created.token)
}

pub(super) async fn auth_clerk(
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
    validate_clerk_signup_allowed(&state.config, &principal.email, &input)?;
    let created = store::create_clerk_session(&state.store, principal, input).await?;
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

pub(super) async fn auth_session(
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

pub(super) async fn auth_logout(
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

pub(super) async fn create_user(
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

pub(super) async fn list_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    require_bootstrap(&state, &headers)?;
    Ok(Json(
        json!({ "users": store::list_users(&state.store).await? }),
    ))
}

pub(super) async fn create_org(
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

pub(super) async fn list_orgs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    require_bootstrap(&state, &headers)?;
    Ok(Json(
        json!({ "organizations": store::list_organizations(&state.store).await? }),
    ))
}

pub(super) async fn org_name_availability(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        store::organization_name_availability(&state.store, query.get("name").map(String::as_str))
            .await?,
    ))
}

pub(super) async fn create_api_key(
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

pub(super) async fn list_api_keys(
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

pub(super) async fn revoke_api_key(
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

pub(super) async fn disable_service_account(
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

pub(super) async fn reserve_seat(
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

pub(super) async fn list_seats(
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

pub(super) async fn create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let input = read_json::<CreateProjectRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "project": store::create_project(&state.store, &ctx, input).await? }),
    ))
}

pub(super) async fn list_projects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(
        json!({ "projects": store::list_projects(&state.store, &ctx).await? }),
    ))
}

pub(super) async fn create_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let input = read_json::<CreateRunRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "run": store::create_run(&state.store, &ctx, input).await? }),
    ))
}

pub(super) async fn list_runs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::list_runs(&state.store, &ctx, &query).await?))
}

pub(super) async fn get_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        json!({ "run": store::get_run(&state.store, &ctx, run_id).await? }),
    ))
}

pub(super) async fn update_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<UpdateRunRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "run": store::update_run(&state.store, &ctx, run_id, input).await? }),
    ))
}

pub(super) async fn log_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) =
        read_json_with_raw::<LogMetricsRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let inserted =
        store::log_metrics(&state.store, &ctx, run_id, raw, input, idempotency_key).await?;
    Ok(Json(json!({ "inserted": inserted })))
}

pub(super) async fn get_metrics(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::get_metrics(&state.store, &ctx, run_id, &query).await?,
    ))
}

pub(super) async fn log_console_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let (input, raw) = read_json_with_raw::<CreateConsoleLogsRequest>(
        &headers,
        bytes,
        state.config.max_body_bytes,
    )?;
    let idempotency_key = header_text(&headers, "idempotency-key").map(str::to_string);
    let inserted =
        store::log_console_logs(&state.store, &ctx, run_id, raw, input, idempotency_key).await?;
    Ok(Json(json!({ "inserted": inserted })))
}

pub(super) async fn list_console_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::list_console_logs(&state.store, &ctx, run_id, &query).await?,
    ))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct MetricsSeriesRequest {
    key: String,
    run_ids: Vec<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    start_step: Option<f64>,
    #[serde(default)]
    end_step: Option<f64>,
}

pub(super) async fn metrics_series(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MetricsSeriesRequest>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let mut query = HashMap::new();
    query.insert("key".to_string(), body.key);
    query.insert("run_ids".to_string(), body.run_ids.join(","));
    if let Some(limit) = body.limit {
        query.insert("limit".to_string(), limit.to_string());
    }
    if let Some(start) = body.start_step {
        query.insert("start_step".to_string(), start.to_string());
    }
    if let Some(end) = body.end_step {
        query.insert("end_step".to_string(), end.to_string());
    }
    Ok(Json(
        store::metrics_series_batched(&state.store, &ctx, &query).await?,
    ))
}

pub(super) async fn overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::overview(&state.store, &ctx, &query).await?))
}

pub(super) async fn runs_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::runs_summary(&state.store, &ctx, &query).await?))
}

pub(super) async fn side_by_side(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::side_by_side(&state.store, &ctx, &query).await?))
}

pub(super) async fn create_attributes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<CreateAttributesRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "attributes": store::create_attributes(&state.store, &ctx, run_id, input).await? }),
    ))
}

pub(super) async fn list_attributes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        json!({ "attributes": store::list_attributes(&state.store, &ctx, run_id, &query).await? }),
    ))
}

pub(super) async fn create_object(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "sdk:ingest", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<CreateObjectRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(json!({
        "object": store::create_object(&state.store, &ctx, run_id, input).await?
    })))
}

pub(super) async fn list_objects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        store::list_objects(&state.store, &ctx, run_id, &query).await?,
    ))
}

pub(super) async fn list_object_rows(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(object_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let object_id = object_id
        .parse::<i64>()
        .map_err(|_| AppError::not_found("object not found"))?;
    Ok(Json(
        store::list_object_rows(&state.store, &ctx, object_id, &query).await?,
    ))
}

pub(super) async fn create_artifact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input = read_json::<CreateArtifactRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        json!({ "artifact": store::create_artifact(&state.store, &ctx, run_id, input).await? }),
    ))
}

pub(super) async fn upload_artifact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "artifacts:write", &state)?;
    if !state.config.artifact_uploads_enabled {
        return Err(AppError::forbidden(
            "artifact byte uploads are disabled until hosted object storage is configured",
        ));
    }
    let run_id = parse_uuid(&run_id, "run not found")?;
    let input =
        read_json::<UploadArtifactRequest>(&headers, bytes, state.config.max_upload_body_bytes)?;
    Ok(Json(
        json!({ "artifact": store::upload_artifact(&state.store, &state.config, &ctx, run_id, input).await? }),
    ))
}

pub(super) async fn list_artifacts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    let run_id = parse_uuid(&run_id, "run not found")?;
    Ok(Json(
        json!({ "artifacts": store::list_artifacts(&state.store, &ctx, run_id, &query).await? }),
    ))
}

pub(super) async fn download_artifact(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(artifact_id): Path<String>,
) -> AppResult<Response> {
    let ctx = context(&state, &headers, true).await?;
    let artifact_id = parse_uuid(&artifact_id, "artifact not found")?;
    let artifact = store::get_artifact_for_context(&state.store, &ctx, artifact_id).await?;
    let artifact_store = LocalArtifactStore::new(&state.config.artifact_root);
    let file = artifact_store.open(&artifact).await?;
    let content_type = artifact
        .mime_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, header_value(&content_type)?);
    if let Some(size_bytes) = artifact.size_bytes {
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            header_value(&size_bytes.to_string())?,
        );
    }
    Ok(response)
}

pub(super) async fn export_data(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::export_data(&state.store, &ctx, &query).await?))
}

pub(super) async fn usage_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "usage:read", &state)?;
    Ok(Json(store::usage_summary(&state.store, &ctx).await?))
}

pub(super) async fn usage_export(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "usage:read", &state)?;
    Ok(Json(store::usage_export(&state.store, &ctx).await?))
}

pub(super) async fn list_imports(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    Ok(Json(store::list_imports(&state.store, &ctx).await?))
}

pub(super) async fn import_neptune(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    import_with_source(state, headers, query, bytes, "neptune").await
}

pub(super) async fn import_wandb(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    import_with_source(state, headers, query, bytes, "wandb").await
}

pub(super) async fn import_mlflow(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    import_with_source(state, headers, query, bytes, "mlflow").await
}

async fn import_with_source(
    state: Arc<AppState>,
    headers: HeaderMap,
    query: HashMap<String, String>,
    bytes: Bytes,
    source: &str,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    validate_session_mutation_origin(&state, &headers, &ctx)?;
    require_scope(&ctx, "imports:write", &state)?;
    let raw = read_json_value(&headers, bytes, state.config.max_body_bytes)?;
    let dry_run = query
        .get("dry_run")
        .map(|value| value == "true")
        .unwrap_or(false);
    Ok(Json(
        store::import_payload(&state.store, &ctx, source, dry_run, raw).await?,
    ))
}

pub(super) async fn not_found() -> AppError {
    AppError::not_found("route not found")
}

fn require_bootstrap(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if !state.config.auth_mode.requires_api_key() {
        return Ok(());
    }
    require_strict_bootstrap(state, headers)
}

fn require_strict_bootstrap(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if state.config.bootstrap_token.is_empty() {
        return Err(AppError::unauthorized("bootstrap token is not configured"));
    }
    match header_text(headers, "x-instantml-bootstrap-token") {
        Some(token) if token == state.config.bootstrap_token => Ok(()),
        _ => Err(AppError::unauthorized("invalid bootstrap token")),
    }
}

async fn require_admin_or_bootstrap(
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

async fn admin_actor(
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

async fn reject_demo_session_mutation(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    let session = session_context(state, headers).await?;
    if store::is_shared_demo_org(&session.organization) {
        return Err(AppError::forbidden(
            "demo workspace browser sessions are read-only",
        ));
    }
    Ok(())
}

async fn context(
    state: &AppState,
    headers: &HeaderMap,
    tenant_route: bool,
) -> AppResult<RequestContext> {
    refresh_control_before_auth(state).await?;
    let ctx = match header_text(headers, "authorization") {
        Some(header) => {
            let token = header
                .strip_prefix("Bearer ")
                .or_else(|| header.strip_prefix("bearer "))
                .ok_or_else(|| AppError::unauthorized("authorization must use bearer token"))?;
            let auth = store::authenticate_api_key(&state.store, token).await?;
            RequestContext {
                org_id: auth.org_id,
                auth: Some(auth),
                session: None,
            }
        }
        None => {
            let Some(token) = session_cookie(headers) else {
                if state.config.auth_mode.requires_api_key() && tenant_route {
                    return Err(AppError::unauthorized("missing bearer token"));
                }
                return Ok(RequestContext::local());
            };
            let payload = store::authenticate_session(&state.store, token).await?;
            RequestContext {
                org_id: payload.organization.id,
                auth: None,
                session: Some(SessionContext {
                    session_id: payload.session.id,
                    user_id: payload.user.id,
                    role: payload.membership.role,
                    demo_read_only: store::is_shared_demo_org(&payload.organization),
                }),
            }
        }
    };
    if tenant_route {
        state.store.ensure_tenant_loaded(ctx.org_id).await?;
    }
    Ok(ctx)
}

fn require_scope(ctx: &RequestContext, scope: &str, state: &AppState) -> AppResult<()> {
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

fn require_session_scope(session: &SessionContext, scope: &str) -> AppResult<()> {
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
        "sdk:ingest" | "artifacts:write" => matches!(role, "owner" | "admin" | "member"),
        "imports:write" | "usage:read" | "api_keys:write" => matches!(role, "owner" | "admin"),
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

async fn session_context(
    state: &AppState,
    headers: &HeaderMap,
) -> AppResult<crate::domain::AuthSessionPayload> {
    refresh_control_before_auth(state).await?;
    let token = session_cookie(headers).ok_or_else(|| AppError::unauthorized("missing session"))?;
    store::authenticate_session(&state.store, token).await
}

async fn refresh_control_before_auth(state: &AppState) -> AppResult<()> {
    if state.config.service_plane.refreshes_control_before_auth() {
        state.store.refresh_control_records().await?;
    }
    Ok(())
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    cookie_value(headers, SESSION_COOKIE)
}

fn cookie_value<'a>(headers: &'a HeaderMap, cookie_name: &str) -> Option<&'a str> {
    let raw = header_text(headers, "cookie")?;
    raw.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == cookie_name && !value.is_empty()).then_some(value)
    })
}

fn json_with_session_cookie<T: serde::Serialize>(
    state: &AppState,
    headers: &HeaderMap,
    payload: T,
    token: &str,
) -> AppResult<Response> {
    let mut response = Json(payload).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        header_value(&session_cookie_header(
            token,
            is_secure_request(state, headers),
        ))?,
    );
    Ok(response)
}

fn session_cookie_header(token: &str, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        60 * 60 * 24 * 30
    ) + secure
}

fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

fn is_secure_request(state: &AppState, headers: &HeaderMap) -> bool {
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

fn validate_mutation_origin(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    validate_mutation_origin_inner(state, headers, state.config.auth_mode.requires_api_key())
}

fn validate_mutation_origin_required(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    validate_mutation_origin_inner(state, headers, true)
}

fn validate_session_mutation_origin(
    state: &AppState,
    headers: &HeaderMap,
    ctx: &RequestContext,
) -> AppResult<()> {
    if ctx.session.is_some() {
        validate_mutation_origin(state, headers)?;
    }
    Ok(())
}

fn validate_mutation_origin_inner(
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

fn request_origin(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let host = header_text(headers, "host")?;
    let scheme = if is_secure_request(state, headers) {
        "https"
    } else {
        "http"
    };
    Some(format!("{scheme}://{host}"))
}

fn read_json<T: DeserializeOwned>(
    headers: &HeaderMap,
    bytes: Bytes,
    max_bytes: usize,
) -> AppResult<T> {
    validate_json_body(headers, &bytes, max_bytes)?;
    serde_json::from_slice::<T>(&bytes)
        .map_err(|_| AppError::validation("request body must be valid JSON"))
}

fn read_json_value(headers: &HeaderMap, bytes: Bytes, max_bytes: usize) -> AppResult<Value> {
    validate_json_body(headers, &bytes, max_bytes)?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::validation("request body must be valid JSON"))?;
    if !raw.is_object() {
        return Err(AppError::validation("request body must be a JSON object"));
    }
    Ok(raw)
}

fn read_json_with_raw<T: DeserializeOwned>(
    headers: &HeaderMap,
    bytes: Bytes,
    max_bytes: usize,
) -> AppResult<(T, Value)> {
    let raw = read_json_value(headers, bytes, max_bytes)?;
    let typed = serde_json::from_value::<T>(raw.clone())
        .map_err(|_| AppError::validation("request body must be valid JSON"))?;
    Ok((typed, raw))
}

fn validate_json_body(headers: &HeaderMap, bytes: &Bytes, max_bytes: usize) -> AppResult<()> {
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

fn validate_clerk_signup_allowed(
    config: &AppConfig,
    email: &str,
    input: &ClerkAuthRequest,
) -> AppResult<()> {
    if !is_clerk_signup_request(input) {
        return Ok(());
    }
    if config.signup_allowed_emails.is_empty() && config.signup_allowed_domains.is_empty() {
        return Ok(());
    }
    let normalized = email.trim().to_ascii_lowercase();
    if config
        .signup_allowed_emails
        .iter()
        .any(|allowed| allowed == &normalized)
    {
        return Ok(());
    }
    let domain = normalized.split_once('@').map(|(_, domain)| domain);
    if let Some(domain) = domain {
        if config
            .signup_allowed_domains
            .iter()
            .any(|allowed| allowed == domain)
        {
            return Ok(());
        }
    }
    Err(AppError::forbidden(
        "hosted signup is restricted to invited accounts",
    ))
}

fn is_clerk_signup_request(input: &ClerkAuthRequest) -> bool {
    input.mode.as_deref() == Some("signup")
        || input
            .org_name
            .as_deref()
            .is_some_and(|name| !name.trim().is_empty())
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn parse_uuid(raw: &str, missing_message: &str) -> AppResult<Uuid> {
    Uuid::parse_str(raw).map_err(|_| AppError::not_found(missing_message))
}

fn header_value(value: &str) -> AppResult<HeaderValue> {
    HeaderValue::from_str(value).map_err(|_| AppError::internal("invalid header value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(role: &str, demo_read_only: bool) -> SessionContext {
        SessionContext {
            session_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            role: role.to_string(),
            demo_read_only,
        }
    }

    #[test]
    fn demo_browser_sessions_are_read_only() {
        let demo = session("owner", true);
        assert!(require_session_scope(&demo, "export:read").is_ok());
        for scope in [
            "sdk:ingest",
            "artifacts:write",
            "imports:write",
            "usage:read",
            "api_keys:write",
        ] {
            assert!(require_session_scope(&demo, scope).is_err());
        }
    }

    #[test]
    fn non_demo_session_roles_keep_expected_write_permissions() {
        assert!(require_session_scope(&session("member", false), "sdk:ingest").is_ok());
        assert!(require_session_scope(&session("member", false), "api_keys:write").is_err());
        assert!(require_session_scope(&session("owner", false), "api_keys:write").is_ok());
    }

    #[test]
    fn openapi_paths_follow_service_plane_roles() {
        use crate::config::ServicePlaneRole;

        assert!(openapi_path_available_for_plane(
            "/api/auth/config",
            ServicePlaneRole::Control
        ));
        assert!(openapi_path_available_for_plane(
            "/api/auth/config",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/api/orgs/{org_id}/api-keys",
            ServicePlaneRole::Control
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/orgs/{org_id}/api-keys",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/runs",
            ServicePlaneRole::Data
        ));
        assert!(!openapi_path_available_for_plane(
            "/runs",
            ServicePlaneRole::Control
        ));
    }

    #[test]
    fn clerk_signup_allowlist_only_applies_to_signup() {
        let mut config = test_config();
        config.signup_allowed_emails = vec!["founder@example.com".to_string()];
        config.signup_allowed_domains = vec!["instantml.ai".to_string()];
        let signup = ClerkAuthRequest {
            token: None,
            mode: Some("signup".to_string()),
            account_type: None,
            org_name: Some("Acme".to_string()),
            plan_tier: None,
            seat_emails: None,
            accept_invite_org_id: None,
        };
        assert!(validate_clerk_signup_allowed(&config, "founder@example.com", &signup).is_ok());
        assert!(validate_clerk_signup_allowed(&config, "teammate@instantml.ai", &signup).is_ok());
        assert!(validate_clerk_signup_allowed(&config, "stranger@example.org", &signup).is_err());

        let signin = ClerkAuthRequest {
            token: None,
            mode: Some("signin".to_string()),
            account_type: None,
            org_name: None,
            plan_tier: None,
            seat_emails: None,
            accept_invite_org_id: None,
        };
        assert!(validate_clerk_signup_allowed(&config, "stranger@example.org", &signin).is_ok());
    }

    fn test_config() -> AppConfig {
        AppConfig {
            clickhouse_url: "http://default:@127.0.0.1:8123/instantml".to_string(),
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            service_plane: crate::config::ServicePlaneRole::Combined,
            max_body_bytes: 1_000_000,
            max_upload_body_bytes: 50_000_000,
            artifact_root: ".instantml/rust-artifacts".into(),
            bootstrap_token: String::new(),
            auth_mode: crate::config::AuthMode::Local,
            dev_auth_enabled: true,
            managed_clerk_enabled: false,
            clerk_secret_key: None,
            clerk_api_base: "https://api.clerk.com".to_string(),
            clerk_jwt_issuer: None,
            clerk_session_max_token_age: std::time::Duration::from_secs(600),
            signup_allowed_emails: Vec::new(),
            signup_allowed_domains: Vec::new(),
            artifact_uploads_enabled: true,
            allowed_frontend_origins: Vec::new(),
            request_timeout: std::time::Duration::from_secs(30),
            log_format: crate::config::LogFormat::Pretty,
            hosted_clickhouse: None,
        }
    }
}
