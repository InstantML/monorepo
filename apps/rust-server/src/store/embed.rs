use super::*;
use crate::auth::{constant_time_eq, generate_embed_token, hash_embed_token, EMBED_TOKEN_PREFIX};
use serde_json::json;
use url::Url;

const EMBED_SCHEMA_VERSION: i32 = 1;
const DEFAULT_EMBED_TTL_SECONDS: i64 = 15 * 60;
const MAX_EMBED_TTL_SECONDS: i64 = 60 * 60;
const MAX_EMBED_RUN_IDS: usize = 100;
const MAX_EMBED_PANELS: usize = 8;
const DEFAULT_EMBED_POINT_LIMIT: i64 = 500;
const MAX_EMBED_POINT_LIMIT: i64 = 500;
const MAX_EMBED_CREATES_PER_SOURCE_PER_MINUTE: usize = 20;
const MAX_LIVE_EMBED_SESSIONS_PER_SOURCE: usize = 100;
const MAX_LIVE_EMBED_SESSIONS_PER_ORG: usize = 1_000;

#[derive(Clone, Debug)]
pub struct EmbedCreateConfig {
    pub app_base_url: String,
    pub hosted: bool,
    pub org_allowlist: Vec<Uuid>,
    pub token_hmac_secret: Option<String>,
}

pub async fn create_embed_session(
    store: &Store,
    ctx: &RequestContext,
    input: CreateEmbedSessionRequest,
    config: EmbedCreateConfig,
) -> AppResult<CreateEmbedSessionResponse> {
    let auth = ctx
        .auth
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("embed sessions require an API key"))?;
    if ctx.session.is_some() {
        return Err(AppError::unauthorized(
            "browser sessions cannot create embed sessions",
        ));
    }
    auth.require_scope("export:read")?;
    if !config.org_allowlist.is_empty() && !config.org_allowlist.contains(&ctx.org_id) {
        return Err(AppError::forbidden(
            "iframe embeds are not enabled for this organization",
        ));
    }

    let run_ids = validate_embed_run_ids(input.run_ids)?;
    let origin = validate_allowed_parent_origin(&input.allowed_parent_origin, config.hosted)?;
    let ttl_seconds = input
        .ttl_seconds
        .unwrap_or(DEFAULT_EMBED_TTL_SECONDS)
        .clamp(60, MAX_EMBED_TTL_SECONDS);
    let (options, warnings) = normalize_embed_options(input.options);
    let now = Utc::now();
    let expires_at = now + ChronoDuration::seconds(ttl_seconds);

    {
        let mut data = store.data.lock().await;
        ensure_embed_create_limits(&mut data, ctx.org_id, auth.api_key_id, now)?;
        for run_id in &run_ids {
            let run = embed_visible_run_for_auth(&data, ctx.org_id, auth.project_id, *run_id)?;
            if run.project_id != data.runs.get(run_id).expect("run exists").project_id {
                return Err(AppError::not_found("run not found"));
            }
        }
    }

    let token = generate_embed_token()?;
    let token_hash = hash_embed_token(&token, config.token_hmac_secret.as_deref());
    let row = EmbedSessionRow {
        schema_version: EMBED_SCHEMA_VERSION,
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        source_api_key_id: auth.api_key_id,
        source_service_account_id: auth.service_account_id,
        source_project_restriction_id: auth.project_id,
        source_scopes_snapshot: auth.scopes.clone(),
        token_hash,
        token_prefix: token.chars().take(EMBED_TOKEN_PREFIX.len()).collect(),
        run_ids,
        allowed_parent_origin: origin,
        options,
        created_at: now,
        expires_at,
        deleted_at: None,
    };
    store
        .persist_locked("embed_session", row.org_id, &row.id.to_string(), &row)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_embed_session(row.clone());
    Ok(CreateEmbedSessionResponse {
        embed_token: token.clone(),
        embed_session: PublicEmbedSession {
            id: row.id,
            expires_at: row.expires_at,
            allowed_parent_origin: row.allowed_parent_origin.clone(),
            run_count: row.run_ids.len(),
            iframe_src: format!(
                "{}/embed/runs/{}#token={}",
                config.app_base_url.trim_end_matches('/'),
                row.id,
                token
            ),
        },
        warnings,
    })
}

pub async fn embed_frame_policy(
    store: &Store,
    session_id: Uuid,
) -> AppResult<EmbedFramePolicyResponse> {
    let row = embed_session_for_frame_policy(store, session_id).await?;
    let status = embed_session_status(store, &row).await;
    Ok(EmbedFramePolicyResponse {
        frame_policy: EmbedFramePolicy {
            session_id: row.id,
            status,
            allowed_parent_origin: row.allowed_parent_origin,
            expires_at: row.expires_at,
        },
    })
}

async fn embed_session_for_frame_policy(
    store: &Store,
    session_id: Uuid,
) -> AppResult<EmbedSessionRow> {
    if let Some(row) = {
        let data = store.data.lock().await;
        data.embed_sessions.get(&session_id).cloned()
    } {
        return Ok(row);
    }
    if let Some(row) = store
        .load_embed_session_from_control(session_id)
        .await
        .map_err(|_| AppError::service_unavailable("control plane unavailable"))?
    {
        let mut data = store.data.lock().await;
        data.insert_embed_session(row.clone());
        return Ok(row);
    }
    Err(AppError::not_found("embed session not found"))
}

pub async fn embed_current_session(
    store: &Store,
    session_id: Uuid,
    token: &str,
    token_hmac_secret: Option<&str>,
) -> AppResult<EmbedCurrentSessionResponse> {
    let (_auth, row) =
        authenticate_embed_token(store, session_id, token, token_hmac_secret).await?;
    Ok(EmbedCurrentSessionResponse {
        embed_session: EmbedCurrentSession {
            id: row.id,
            expires_at: row.expires_at,
            run_count: row.run_ids.len(),
            theme: row.options.theme.unwrap_or_else(|| "system".to_string()),
            has_custom_view: false,
        },
    })
}

pub async fn embed_runs_data(
    store: &Store,
    session_id: Uuid,
    token: &str,
    token_hmac_secret: Option<&str>,
    input: EmbedRunsDataRequest,
    instance_id: &str,
) -> AppResult<WorkspaceViewDataResponse> {
    let (embed_auth, row) =
        authenticate_embed_token(store, session_id, token, token_hmac_secret).await?;
    embed_runs_data_for_session(store, embed_auth, row, input, instance_id).await
}

pub async fn embed_runs_data_for_session(
    store: &Store,
    embed_auth: EmbedAuthContext,
    row: EmbedSessionRow,
    input: EmbedRunsDataRequest,
    instance_id: &str,
) -> AppResult<WorkspaceViewDataResponse> {
    reserve_api_request_usage(store, embed_auth.org_id, "general", instance_id).await?;
    let auth = AuthContext {
        org_id: embed_auth.org_id,
        api_key_id: embed_auth.source_api_key_id,
        service_account_id: embed_auth.source_service_account_id,
        project_id: embed_auth.source_project_restriction_id,
        scopes: embed_auth.scopes,
    };
    let ctx = RequestContext {
        org_id: embed_auth.org_id,
        auth: Some(auth),
        session: None,
    };
    let view = generated_embed_workspace_view(store, &ctx, &row).await?;
    let options = Some(WorkspaceViewDataOptions {
        metric_point_limit: Some(
            input
                .options
                .as_ref()
                .and_then(|options| options.metric_point_limit)
                .or(row.options.metric_point_limit)
                .unwrap_or(DEFAULT_EMBED_POINT_LIMIT)
                .clamp(1, MAX_EMBED_POINT_LIMIT),
        ),
        max_panels: Some(
            input
                .options
                .as_ref()
                .and_then(|options| options.max_panels)
                .or(row.options.max_panels)
                .unwrap_or(MAX_EMBED_PANELS)
                .clamp(1, MAX_EMBED_PANELS),
        ),
    });
    workspace_view_data(
        store,
        &ctx,
        WorkspaceViewDataRequest {
            view,
            run_ids: row.run_ids,
            options,
        },
    )
    .await
}

pub async fn authenticate_embed_token(
    store: &Store,
    session_id: Uuid,
    token: &str,
    token_hmac_secret: Option<&str>,
) -> AppResult<(EmbedAuthContext, EmbedSessionRow)> {
    if !valid_embed_token_shape(token) {
        return Err(AppError::unauthorized("invalid embed token"));
    }
    if store.refresh_control_records_for_auth_miss().await.is_err() {
        return Err(AppError::service_unavailable("control plane unavailable"));
    }
    let token_hash = hash_embed_token(token, token_hmac_secret);
    let data = store.data.lock().await;
    let row = data
        .embed_sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::unauthorized("invalid embed token"))?;
    if row.deleted_at.is_some() || row.expires_at <= Utc::now() {
        return Err(AppError::unauthorized("embed token expired"));
    }
    if !constant_time_eq(&row.token_hash, &token_hash) {
        return Err(AppError::unauthorized("invalid embed token"));
    }
    let key = data
        .api_keys
        .get(&row.source_api_key_id)
        .ok_or_else(|| AppError::forbidden("source API key is inactive"))?;
    if key.row.revoked_at.is_some()
        || key
            .row
            .expires_at
            .map(|expires| expires <= Utc::now())
            .unwrap_or(false)
    {
        return Err(AppError::forbidden("source API key is inactive"));
    }
    if key.row.service_account_id != row.source_service_account_id
        || key.row.project_id != row.source_project_restriction_id
    {
        return Err(AppError::forbidden("source API key changed"));
    }
    let account = data
        .service_accounts
        .get(&row.source_service_account_id)
        .ok_or_else(|| AppError::forbidden("source service account is inactive"))?;
    if account.disabled_at.is_some() {
        return Err(AppError::forbidden("source service account is inactive"));
    }
    let scopes = effective_scopes_for_embed(&data, key);
    if !scopes.iter().any(|scope| scope == "export:read") {
        return Err(AppError::forbidden("source API key requires export:read"));
    }
    if scopes != row.source_scopes_snapshot {
        return Err(AppError::forbidden("source API key scopes changed"));
    }
    Ok((
        EmbedAuthContext {
            org_id: row.org_id,
            session_id: row.id,
            source_api_key_id: row.source_api_key_id,
            source_service_account_id: row.source_service_account_id,
            source_project_restriction_id: row.source_project_restriction_id,
            scopes,
        },
        row,
    ))
}

fn validate_embed_run_ids(run_ids: Vec<Uuid>) -> AppResult<Vec<Uuid>> {
    if run_ids.is_empty() {
        return Err(AppError::validation(
            "run_ids must include at least one run",
        ));
    }
    if run_ids.len() > MAX_EMBED_RUN_IDS {
        return Err(AppError::validation(format!(
            "run_ids cannot include more than {MAX_EMBED_RUN_IDS} runs"
        )));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(run_ids.len());
    for run_id in run_ids {
        if seen.insert(run_id) {
            out.push(run_id);
        }
    }
    Ok(out)
}

fn validate_allowed_parent_origin(raw: &str, hosted: bool) -> AppResult<String> {
    if raw.contains('*') {
        return Err(AppError::validation(
            "allowed_parent_origin cannot contain wildcards",
        ));
    }
    let url = Url::parse(raw.trim())
        .map_err(|_| AppError::validation("allowed_parent_origin must be a valid origin"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(AppError::validation(
            "allowed_parent_origin must be a bare origin with no path, query, or credentials",
        ));
    }
    let Some(host) = url.host_str() else {
        return Err(AppError::validation(
            "allowed_parent_origin must include a host",
        ));
    };
    let scheme = url.scheme();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if hosted {
        if scheme != "https" {
            return Err(AppError::validation("hosted embed origins must use https"));
        }
        if instantml_owned_host(host) {
            return Err(AppError::validation(
                "hosted embed parent origin cannot be an InstantML origin",
            ));
        }
    } else if scheme != "https" && !(scheme == "http" && loopback) {
        return Err(AppError::validation(
            "local embed origins must use https or loopback http",
        ));
    }
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("{scheme}://{host}{port}"))
}

fn instantml_owned_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "instantml.ai"
        || lower.ends_with(".instantml.ai")
        || lower == "instantml.com"
        || lower.ends_with(".instantml.com")
}

fn normalize_embed_options(
    input: Option<EmbedSessionOptions>,
) -> (EmbedSessionOptions, Vec<String>) {
    let mut warnings = Vec::new();
    let input = input.unwrap_or(EmbedSessionOptions {
        theme: None,
        metric_point_limit: None,
        max_panels: None,
    });
    let theme = match input.theme.as_deref().unwrap_or("system") {
        "light" | "dark" | "system" => input.theme.or_else(|| Some("system".to_string())),
        _ => {
            warnings.push("theme defaulted to system".to_string());
            Some("system".to_string())
        }
    };
    let max_panels = input.max_panels.map(|value| {
        if value > MAX_EMBED_PANELS {
            warnings.push(format!("max_panels clamped to {MAX_EMBED_PANELS}"));
        }
        value.clamp(1, MAX_EMBED_PANELS)
    });
    let metric_point_limit = input.metric_point_limit.map(|value| {
        if value > MAX_EMBED_POINT_LIMIT {
            warnings.push(format!(
                "metric_point_limit clamped to {MAX_EMBED_POINT_LIMIT}"
            ));
        }
        value.clamp(1, MAX_EMBED_POINT_LIMIT)
    });
    (
        EmbedSessionOptions {
            theme,
            metric_point_limit,
            max_panels,
        },
        warnings,
    )
}

fn ensure_embed_create_limits(
    data: &mut StoreData,
    org_id: Uuid,
    source_api_key_id: Uuid,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let minute_ago = now - ChronoDuration::minutes(1);
    let attempts = data
        .embed_create_attempts
        .entry(source_api_key_id)
        .or_default();
    attempts.retain(|created_at| *created_at > minute_ago);
    if attempts.len() >= MAX_EMBED_CREATES_PER_SOURCE_PER_MINUTE {
        return Err(AppError::with_code(
            http::StatusCode::TOO_MANY_REQUESTS,
            "embed_create_rate_limited",
            "embed session create rate limit exceeded",
        ));
    }
    let live_source = data
        .embed_sessions
        .values()
        .filter(|row| row.source_api_key_id == source_api_key_id)
        .filter(|row| row.deleted_at.is_none() && row.expires_at > now)
        .count();
    if live_source >= MAX_LIVE_EMBED_SESSIONS_PER_SOURCE {
        return Err(AppError::validation(
            "source API key has too many live embed sessions",
        ));
    }
    let live_org = data
        .embed_sessions
        .values()
        .filter(|row| row.org_id == org_id)
        .filter(|row| row.deleted_at.is_none() && row.expires_at > now)
        .count();
    if live_org >= MAX_LIVE_EMBED_SESSIONS_PER_ORG {
        return Err(AppError::validation(
            "organization has too many live embed sessions",
        ));
    }
    attempts.push(now);
    Ok(())
}

fn embed_visible_run_for_auth(
    data: &StoreData,
    org_id: Uuid,
    project_id: Option<Uuid>,
    run_id: Uuid,
) -> AppResult<RunRow> {
    let run = data
        .runs
        .get(&run_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("run not found"))?;
    if run.org_id != org_id || !is_visible_run(data, &run) {
        return Err(AppError::not_found("run not found"));
    }
    if project_id
        .map(|project_id| project_id != run.project_id)
        .unwrap_or(false)
    {
        return Err(AppError::not_found("run not found"));
    }
    Ok(run)
}

async fn embed_session_status(store: &Store, row: &EmbedSessionRow) -> String {
    if row.deleted_at.is_some() || row.expires_at <= Utc::now() {
        return "expired".to_string();
    }
    let data = store.data.lock().await;
    let Some(key) = data.api_keys.get(&row.source_api_key_id) else {
        return "source_inactive".to_string();
    };
    if key.row.revoked_at.is_some()
        || key
            .row
            .expires_at
            .map(|expires| expires <= Utc::now())
            .unwrap_or(false)
    {
        return "source_inactive".to_string();
    }
    let Some(account) = data.service_accounts.get(&row.source_service_account_id) else {
        return "source_inactive".to_string();
    };
    if account.disabled_at.is_some() {
        return "source_inactive".to_string();
    }
    "active".to_string()
}

fn effective_scopes_for_embed(data: &StoreData, record: &ApiKeyRecord) -> Vec<String> {
    if data
        .organizations
        .get(&record.row.org_id)
        .is_some_and(is_shared_demo_org)
    {
        return vec!["export:read".to_string()];
    }
    record.row.scopes.clone()
}

fn valid_embed_token_shape(token: &str) -> bool {
    token.starts_with(EMBED_TOKEN_PREFIX)
        && token.len() == EMBED_TOKEN_PREFIX.len() + 43
        && token[EMBED_TOKEN_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

async fn generated_embed_workspace_view(
    store: &Store,
    _ctx: &RequestContext,
    row: &EmbedSessionRow,
) -> AppResult<Value> {
    let runs = {
        let data = store.data.lock().await;
        row.run_ids
            .iter()
            .map(|run_id| {
                embed_visible_run_for_auth(
                    &data,
                    row.org_id,
                    row.source_project_restriction_id,
                    *run_id,
                )
            })
            .collect::<AppResult<Vec<_>>>()?
    };
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_store = store.metric_store_for_org(row.org_id).await?;
    let series = metric_series_for_runs_limited(&metric_store, row.org_id, &run_ids, 256).await?;
    let mut ranked = BTreeMap::<String, i64>::new();
    for item in series {
        if item.key.starts_with("system/instantml/") {
            continue;
        }
        *ranked.entry(item.key).or_insert(0) += item.count.max(0);
    }
    let mut keys = ranked.into_iter().collect::<Vec<_>>();
    keys.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let max_panels = row.options.max_panels.unwrap_or(MAX_EMBED_PANELS);
    let panels = keys
        .into_iter()
        .take(max_panels)
        .enumerate()
        .map(|(index, (key, _))| {
            json!({
                "id": format!("embed-line-{index}"),
                "type": "line",
                "title": key,
                "metricKey": key
            })
        })
        .collect::<Vec<_>>();
    let project = runs.first().map(|run| run.project.clone());
    Ok(json!({
        "workspaceView": {
            "id": format!("embed-{}", row.id),
            "name": "Embedded runs",
            "project": project,
            "settings": { "maxRuns": row.run_ids.len().min(MAX_EMBED_RUN_IDS) },
            "sections": [{
                "id": "embed-section",
                "name": "Metrics",
                "settings": { "maxRuns": row.run_ids.len().min(MAX_EMBED_RUN_IDS) },
                "panels": panels
            }]
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_embed_test",
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_db: None,
            hosted_clickhouse: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "test".to_string(),
                allow_private_endpoints: true,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
            cell_routing: crate::config::CellRoutingConfig {
                environment: "test".to_string(),
                placement_data_cell_id: None,
                heartbeat_data_cell_id: None,
            },
            data_cell_writer_runtime: DataCellWriterLeaseRuntime::for_tests(),
            data_cell_writer_lease: Arc::new(Mutex::new(DataCellWriterLeaseState::default())),
            data_cell_writer_refresh_lock: Arc::new(Mutex::new(())),
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            customer_tenant_endpoints: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            shared_cell_metric_store: None,
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    fn test_org(id: Uuid) -> OrganizationRow {
        OrganizationRow {
            id,
            slug: "embed-test".to_string(),
            name: "Embed Test".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 3,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    #[tokio::test]
    async fn authenticate_embed_token_checks_hash_and_source_scopes() {
        let org_id = Uuid::new_v4();
        let api_key_id = Uuid::new_v4();
        let service_account_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let token = generate_embed_token().unwrap();
        let hmac_secret = "embed-hmac-test";
        let mut data = StoreData::default();
        data.insert_org(test_org(org_id));
        data.service_accounts.insert(
            service_account_id,
            ServiceAccountRow {
                id: service_account_id,
                org_id,
                name: "embed service".to_string(),
                created_by_user_id: None,
                created_at: Utc::now(),
                disabled_at: None,
            },
        );
        data.insert_api_key(ApiKeyRecord {
            row: PublicApiKeyRow {
                id: api_key_id,
                org_id,
                service_account_id,
                name: "embed key".to_string(),
                key_prefix: "instantml_test".to_string(),
                scopes: vec!["export:read".to_string()],
                project_id: None,
                created_at: Utc::now(),
                expires_at: None,
                last_used_at: None,
                revoked_at: None,
            },
            key_hash: hash_secret("source-key"),
        });
        data.insert_embed_session(EmbedSessionRow {
            schema_version: EMBED_SCHEMA_VERSION,
            id: session_id,
            org_id,
            source_api_key_id: api_key_id,
            source_service_account_id: service_account_id,
            source_project_restriction_id: None,
            source_scopes_snapshot: vec!["export:read".to_string()],
            token_hash: hash_embed_token(&token, Some(hmac_secret)),
            token_prefix: token.chars().take(EMBED_TOKEN_PREFIX.len()).collect(),
            run_ids: vec![Uuid::new_v4()],
            allowed_parent_origin: "https://portal.example.com".to_string(),
            options: EmbedSessionOptions {
                theme: Some("system".to_string()),
                metric_point_limit: Some(200),
                max_panels: Some(2),
            },
            created_at: Utc::now(),
            expires_at: Utc::now() + ChronoDuration::minutes(5),
            deleted_at: None,
        });
        let store = store_with_data(data);

        let (auth, row) = authenticate_embed_token(&store, session_id, &token, Some(hmac_secret))
            .await
            .unwrap();
        assert_eq!(auth.org_id, org_id);
        assert_eq!(auth.source_api_key_id, api_key_id);
        assert_eq!(row.id, session_id);

        let wrong = authenticate_embed_token(
            &store,
            session_id,
            "instantml_embed_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some(hmac_secret),
        )
        .await
        .unwrap_err();
        assert_eq!(wrong.status(), axum::http::StatusCode::UNAUTHORIZED);

        {
            let mut data = store.data.lock().await;
            data.api_keys
                .get_mut(&api_key_id)
                .unwrap()
                .row
                .scopes
                .clear();
        }
        let inactive = authenticate_embed_token(&store, session_id, &token, Some(hmac_secret))
            .await
            .unwrap_err();
        assert_eq!(inactive.status(), axum::http::StatusCode::FORBIDDEN);
        assert!(inactive.message().contains("export:read"));
    }

    #[test]
    fn parent_origin_validation_rejects_hosted_unsafe_inputs() {
        assert_eq!(
            validate_allowed_parent_origin("https://portal.example.com", true).unwrap(),
            "https://portal.example.com"
        );
        assert!(validate_allowed_parent_origin("http://portal.example.com", true).is_err());
        assert!(validate_allowed_parent_origin("https://portal.example.com/path", true).is_err());
        assert!(validate_allowed_parent_origin("https://*.example.com", true).is_err());
        assert!(validate_allowed_parent_origin("https://app.instantml.ai", true).is_err());
        assert_eq!(
            validate_allowed_parent_origin("http://127.0.0.1:3999", false).unwrap(),
            "http://127.0.0.1:3999"
        );
    }

    #[test]
    fn embed_options_are_clamped_and_warned() {
        let (options, warnings) = normalize_embed_options(Some(EmbedSessionOptions {
            theme: Some("neon".to_string()),
            metric_point_limit: Some(5_000),
            max_panels: Some(30),
        }));
        assert_eq!(options.theme.as_deref(), Some("system"));
        assert_eq!(options.metric_point_limit, Some(MAX_EMBED_POINT_LIMIT));
        assert_eq!(options.max_panels, Some(MAX_EMBED_PANELS));
        assert_eq!(warnings.len(), 3);
    }

    #[test]
    fn embed_token_shape_is_strict() {
        let token = generate_embed_token().unwrap();
        assert!(valid_embed_token_shape(&token));
        assert!(!valid_embed_token_shape("instantml_embed_short"));
        assert!(!valid_embed_token_shape(&format!("{token}!")));
    }
}
