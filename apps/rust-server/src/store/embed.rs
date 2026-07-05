use super::*;
use crate::auth::{constant_time_eq, generate_embed_token, hash_embed_token, EMBED_TOKEN_PREFIX};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
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
const EMBED_FIELD_CATALOG_MAX_RUNS: usize = 25;
const EMBED_FIELD_CATALOG_MAX_DEPTH: usize = 4;
const EMBED_FIELD_CATALOG_MAX_LEAVES_PER_RUN: usize = 64;
const EMBED_FIELD_CATALOG_MAX_NODES_PER_RUN: usize = 256;
const EMBED_FIELD_CATALOG_MAX_KEYS_PER_RUN: usize = 256;

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
    let metric_point_limit = effective_embed_i64_option(
        input
            .options
            .as_ref()
            .and_then(|options| options.metric_point_limit),
        row.options.metric_point_limit,
        DEFAULT_EMBED_POINT_LIMIT,
        MAX_EMBED_POINT_LIMIT,
    );
    let max_panels = effective_embed_usize_option(
        input
            .options
            .as_ref()
            .and_then(|options| options.max_panels),
        row.options.max_panels,
        MAX_EMBED_PANELS,
        MAX_EMBED_PANELS,
    );
    let view = generated_embed_workspace_view(store, &ctx, &row, max_panels).await?;
    let options = Some(WorkspaceViewDataOptions {
        metric_point_limit: Some(metric_point_limit),
        max_panels: Some(max_panels),
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

fn effective_embed_i64_option(
    requested: Option<i64>,
    session: Option<i64>,
    default: i64,
    cap: i64,
) -> i64 {
    [requested, session]
        .into_iter()
        .flatten()
        .map(|value| value.clamp(1, cap))
        .min()
        .unwrap_or(default.clamp(1, cap))
}

fn effective_embed_usize_option(
    requested: Option<usize>,
    session: Option<usize>,
    default: usize,
    cap: usize,
) -> usize {
    [requested, session]
        .into_iter()
        .flatten()
        .map(|value| value.clamp(1, cap))
        .min()
        .unwrap_or(default.clamp(1, cap))
}

async fn generated_embed_workspace_view(
    store: &Store,
    _ctx: &RequestContext,
    row: &EmbedSessionRow,
    max_panels: usize,
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
    let metric_keys = keys.into_iter().map(|(key, _)| key).collect::<Vec<_>>();
    let panels = generated_embed_panels_for_metric_keys(&metric_keys, &runs, max_panels);
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

fn generated_embed_panels_for_metric_keys(
    metric_keys: &[String],
    runs: &[RunRow],
    max_panels: usize,
) -> Vec<Value> {
    let mut panels = Vec::new();
    let Some(primary_key) = metric_keys.first() else {
        return panels;
    };
    let max_panels = max_panels.clamp(1, MAX_EMBED_PANELS);
    push_generated_embed_panel(&mut panels, "line", primary_key, runs, max_panels);
    if let Some(second_key) = metric_keys.get(1) {
        push_generated_embed_panel(&mut panels, "line", second_key, runs, max_panels);
    }
    for panel_type in ["histogram", "bar", "dot", "scatter", "distribution"] {
        push_generated_embed_panel(&mut panels, panel_type, primary_key, runs, max_panels);
    }
    for metric_key in metric_keys.iter().skip(2) {
        push_generated_embed_panel(&mut panels, "line", metric_key, runs, max_panels);
    }
    panels
}

fn push_generated_embed_panel(
    panels: &mut Vec<Value>,
    panel_type: &str,
    metric_key: &str,
    runs: &[RunRow],
    max_panels: usize,
) {
    if panels.len() >= max_panels {
        return;
    }
    let index = panels.len();
    let mut panel = json!({
        "id": format!("embed-{panel_type}-{index}"),
        "type": panel_type,
        "title": generated_embed_panel_title(panel_type, metric_key),
        "metricKey": metric_key
    });
    if let Some(object) = panel.as_object_mut() {
        match panel_type {
            "scatter" => {
                object.insert(
                    "xField".to_string(),
                    Value::String(preferred_embed_scatter_x_field(runs)),
                );
                object.insert(
                    "yField".to_string(),
                    Value::String(metric_field_id(metric_key, "best")),
                );
            }
            "distribution" => {
                object.insert(
                    "valueField".to_string(),
                    Value::String(metric_field_id(metric_key, "best")),
                );
                let (group_field, replicate_field) = preferred_embed_distribution_fields(runs);
                if let Some(group_field) = group_field {
                    object.insert("groupField".to_string(), Value::String(group_field));
                }
                if let Some(replicate_field) = replicate_field {
                    object.insert("replicateField".to_string(), Value::String(replicate_field));
                }
            }
            _ => {}
        }
    }
    panels.push(panel);
}

fn generated_embed_panel_title(panel_type: &str, metric_key: &str) -> String {
    match panel_type {
        "line" => metric_key.to_string(),
        "histogram" => format!("{metric_key} histogram"),
        "bar" => format!("{metric_key} latest bars"),
        "dot" => format!("{metric_key} latest dots"),
        "scatter" => format!("{metric_key} tradeoff"),
        "distribution" => format!("{metric_key} distribution"),
        _ => metric_key.to_string(),
    }
}

fn metric_field_id(metric_key: &str, aggregation: &str) -> String {
    format!(
        "metric:{}:{}",
        encode_uri_component(metric_key),
        if matches!(aggregation, "latest" | "min" | "max" | "mean" | "best") {
            aggregation
        } else {
            "latest"
        }
    )
}

fn run_field_id(field: &str) -> String {
    if field == "created_at_unix" {
        "run:created_at_unix".to_string()
    } else {
        "run:duration_seconds".to_string()
    }
}

fn run_categorical_field_id(field: &str) -> String {
    if field == "first_tag" {
        "run:first_tag".to_string()
    } else {
        "run:status".to_string()
    }
}

fn object_field_id(source: &str, path: &[String]) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let pointer = format!(
        "/{}",
        path.iter()
            .map(|segment| segment.replace('~', "~0").replace('/', "~1"))
            .collect::<Vec<_>>()
            .join("/")
    );
    Some(format!(
        "{}:{}",
        if source == "metadata" {
            "metadata"
        } else {
            "config"
        },
        encode_uri_component(&pointer)
    ))
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if matches!(
            byte,
            b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'!'
                | b'~'
                | b'*'
                | b'\''
                | b'('
                | b')'
        ) {
            encoded.push(*byte as char);
        } else {
            let _ = write!(&mut encoded, "%{:02X}", *byte);
        }
    }
    encoded
}

#[derive(Clone, Debug)]
struct EmbedNumericField {
    id: String,
    label: String,
    source_rank: usize,
    available_count: usize,
}

#[derive(Clone, Debug)]
struct EmbedCategoricalField {
    id: String,
    label: String,
    source_rank: usize,
    available_count: usize,
    groups: BTreeSet<String>,
}

#[derive(Default)]
struct EmbedFieldTraversalBudget {
    keys: usize,
    leaves: usize,
    nodes: usize,
}

impl EmbedFieldTraversalBudget {
    fn exhausted(&self) -> bool {
        self.leaves >= EMBED_FIELD_CATALOG_MAX_LEAVES_PER_RUN
            || self.nodes >= EMBED_FIELD_CATALOG_MAX_NODES_PER_RUN
            || self.keys >= EMBED_FIELD_CATALOG_MAX_KEYS_PER_RUN
    }

    fn enter_node(&mut self) -> bool {
        if self.nodes >= EMBED_FIELD_CATALOG_MAX_NODES_PER_RUN {
            return false;
        }
        self.nodes += 1;
        true
    }

    fn visit_key(&mut self) -> bool {
        if self.keys >= EMBED_FIELD_CATALOG_MAX_KEYS_PER_RUN {
            return false;
        }
        self.keys += 1;
        true
    }

    fn visit_leaf(&mut self) -> bool {
        if self.leaves >= EMBED_FIELD_CATALOG_MAX_LEAVES_PER_RUN {
            return false;
        }
        self.leaves += 1;
        true
    }
}

fn preferred_embed_scatter_x_field(runs: &[RunRow]) -> String {
    let mut fields = embed_numeric_fields(runs);
    fields.sort_by(|left, right| {
        scatter_field_rank(left)
            .cmp(&scatter_field_rank(right))
            .then_with(|| left.source_rank.cmp(&right.source_rank))
            .then_with(|| right.available_count.cmp(&left.available_count))
            .then_with(|| left.label.cmp(&right.label))
    });
    fields
        .first()
        .map(|field| field.id.clone())
        .unwrap_or_else(|| run_field_id("duration_seconds"))
}

fn preferred_embed_distribution_fields(runs: &[RunRow]) -> (Option<String>, Option<String>) {
    let fields = embed_categorical_fields(runs);
    let group_field = fields
        .iter()
        .filter(|field| {
            let groups = field.groups.len();
            (2..=12).contains(&groups) && !is_seed_like_field(&field.label)
        })
        .min_by(|left, right| {
            distribution_group_rank(left)
                .cmp(&distribution_group_rank(right))
                .then_with(|| left.source_rank.cmp(&right.source_rank))
                .then_with(|| right.available_count.cmp(&left.available_count))
                .then_with(|| left.label.cmp(&right.label))
        })
        .map(|field| field.id.clone());
    let replicate_field = fields
        .iter()
        .filter(|field| is_seed_like_field(&field.label))
        .max_by(|left, right| {
            left.available_count
                .cmp(&right.available_count)
                .then_with(|| right.source_rank.cmp(&left.source_rank))
                .then_with(|| right.label.cmp(&left.label))
        })
        .map(|field| field.id.clone());
    (group_field, replicate_field)
}

fn embed_numeric_fields(runs: &[RunRow]) -> Vec<EmbedNumericField> {
    let mut counts = BTreeMap::<String, EmbedNumericField>::new();
    for run in runs.iter().take(EMBED_FIELD_CATALOG_MAX_RUNS) {
        let mut budget = EmbedFieldTraversalBudget::default();
        collect_numeric_object_fields(
            &run.config,
            "config",
            0,
            &mut Vec::new(),
            &mut counts,
            &mut budget,
        );
        collect_numeric_object_fields(
            &run.metadata,
            "metadata",
            0,
            &mut Vec::new(),
            &mut counts,
            &mut budget,
        );
    }
    counts.into_values().collect()
}

fn embed_categorical_fields(runs: &[RunRow]) -> Vec<EmbedCategoricalField> {
    let mut counts = BTreeMap::<String, EmbedCategoricalField>::new();
    for run in runs.iter().take(EMBED_FIELD_CATALOG_MAX_RUNS) {
        let mut budget = EmbedFieldTraversalBudget::default();
        mark_categorical_field(
            &mut counts,
            run_categorical_field_id("status"),
            "Status".to_string(),
            2,
            &run.status,
        );
        if let Some(first_tag) = run.tags.first() {
            mark_categorical_field(
                &mut counts,
                run_categorical_field_id("first_tag"),
                "First tag".to_string(),
                1,
                first_tag,
            );
        }
        collect_categorical_object_fields(
            &run.config,
            "config",
            0,
            &mut Vec::new(),
            &mut counts,
            &mut budget,
        );
        collect_categorical_object_fields(
            &run.metadata,
            "metadata",
            0,
            &mut Vec::new(),
            &mut counts,
            &mut budget,
        );
    }
    counts.into_values().collect()
}

fn collect_numeric_object_fields(
    value: &Value,
    source: &str,
    depth: usize,
    path: &mut Vec<String>,
    counts: &mut BTreeMap<String, EmbedNumericField>,
    budget: &mut EmbedFieldTraversalBudget,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    if depth >= EMBED_FIELD_CATALOG_MAX_DEPTH || budget.exhausted() || !budget.enter_node() {
        return;
    }
    for (key, child) in object {
        if budget.exhausted() || !budget.visit_key() {
            break;
        }
        path.push(key.clone());
        if embed_finite_number(child).is_some() {
            if !budget.visit_leaf() {
                path.pop();
                break;
            }
            if let Some(id) = object_field_id(source, path) {
                let label = format!("{source}.{}", path.join("."));
                let entry = counts.entry(id.clone()).or_insert(EmbedNumericField {
                    id,
                    label,
                    source_rank: if source == "config" { 0 } else { 3 },
                    available_count: 0,
                });
                entry.available_count += 1;
            }
        } else if child.is_object() {
            collect_numeric_object_fields(child, source, depth + 1, path, counts, budget);
        }
        path.pop();
    }
}

fn collect_categorical_object_fields(
    value: &Value,
    source: &str,
    depth: usize,
    path: &mut Vec<String>,
    counts: &mut BTreeMap<String, EmbedCategoricalField>,
    budget: &mut EmbedFieldTraversalBudget,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    if depth >= EMBED_FIELD_CATALOG_MAX_DEPTH || budget.exhausted() || !budget.enter_node() {
        return;
    }
    for (key, child) in object {
        if budget.exhausted() || !budget.visit_key() {
            break;
        }
        path.push(key.clone());
        if let Some(value) = embed_categorical_value(child) {
            if !budget.visit_leaf() {
                path.pop();
                break;
            }
            if let Some(id) = object_field_id(source, path) {
                let label = format!("{source}.{}", path.join("."));
                mark_categorical_field(
                    counts,
                    id,
                    label,
                    if source == "config" { 0 } else { 3 },
                    &value,
                );
            }
        } else if child.is_object() {
            collect_categorical_object_fields(child, source, depth + 1, path, counts, budget);
        }
        path.pop();
    }
}

fn mark_categorical_field(
    counts: &mut BTreeMap<String, EmbedCategoricalField>,
    id: String,
    label: String,
    source_rank: usize,
    value: &str,
) {
    let value = value.trim();
    if value.is_empty() || value.len() > 120 {
        return;
    }
    let entry = counts.entry(id.clone()).or_insert(EmbedCategoricalField {
        id,
        label,
        source_rank,
        available_count: 0,
        groups: BTreeSet::new(),
    });
    entry.available_count += 1;
    entry.groups.insert(value.to_string());
}

fn embed_finite_number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if text.len() <= 64 => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    number.is_finite().then_some(number)
}

fn embed_categorical_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty() && text.len() <= 120).then(|| text.to_string())
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn scatter_field_rank(field: &EmbedNumericField) -> usize {
    let text = field.label.to_lowercase();
    if text.contains("learning_rate") || text.ends_with(".lr") || text.contains(".lr.") {
        0
    } else if text.contains("batch_size") || text.contains("batch.size") {
        1
    } else if is_seed_like_field(&text) {
        2
    } else {
        3
    }
}

fn distribution_group_rank(field: &EmbedCategoricalField) -> usize {
    let text = field.label.to_lowercase();
    if [
        "variant", "group", "dataset", "model", "policy", "algo", "method",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        0
    } else if field.id == run_categorical_field_id("first_tag") {
        1
    } else if field.id == run_categorical_field_id("status") {
        2
    } else {
        3
    }
}

fn is_seed_like_field(text: &str) -> bool {
    text.to_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|part| part == "seed")
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
            write_gate_usage: Arc::new(Mutex::new(HashMap::new())),
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

    fn test_run(name: &str, status: &str, config: Value, tags: Vec<&str>) -> RunRow {
        let started_at = Utc::now();
        RunRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            project: "embed-test".to_string(),
            name: name.to_string(),
            status: status.to_string(),
            config,
            tags: tags.into_iter().map(str::to_string).collect(),
            metadata: json!({}),
            created_at: started_at,
            started_at,
            finished_at: Some(started_at + ChronoDuration::seconds(42)),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
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
    fn embed_data_options_apply_session_caps() {
        assert_eq!(
            effective_embed_i64_option(
                None,
                Some(200),
                DEFAULT_EMBED_POINT_LIMIT,
                MAX_EMBED_POINT_LIMIT
            ),
            200
        );
        assert_eq!(
            effective_embed_i64_option(
                Some(500),
                Some(200),
                DEFAULT_EMBED_POINT_LIMIT,
                MAX_EMBED_POINT_LIMIT
            ),
            200
        );
        assert_eq!(
            effective_embed_i64_option(
                Some(100),
                Some(200),
                DEFAULT_EMBED_POINT_LIMIT,
                MAX_EMBED_POINT_LIMIT
            ),
            100
        );
        assert_eq!(
            effective_embed_i64_option(
                None,
                None,
                DEFAULT_EMBED_POINT_LIMIT,
                MAX_EMBED_POINT_LIMIT
            ),
            DEFAULT_EMBED_POINT_LIMIT
        );
        assert_eq!(
            effective_embed_usize_option(Some(8), Some(3), MAX_EMBED_PANELS, MAX_EMBED_PANELS),
            3
        );
        assert_eq!(
            effective_embed_usize_option(Some(2), None, MAX_EMBED_PANELS, MAX_EMBED_PANELS),
            2
        );
        assert_eq!(
            effective_embed_usize_option(None, None, MAX_EMBED_PANELS, MAX_EMBED_PANELS),
            MAX_EMBED_PANELS
        );
    }

    #[test]
    fn generated_embed_panels_include_summary_specs_and_encoded_fields() {
        let runs = vec![
            test_run(
                "run-a",
                "completed",
                json!({ "learning_rate": 0.001, "variant": "baseline", "seed": 1 }),
                vec!["baseline"],
            ),
            test_run(
                "run-b",
                "failed",
                json!({ "learning_rate": 0.002, "variant": "trial", "seed": 2 }),
                vec!["trial"],
            ),
        ];
        let metric_keys = vec![
            "eval/return mean".to_string(),
            "train:loss".to_string(),
            "rollout/reward".to_string(),
        ];
        let panels = generated_embed_panels_for_metric_keys(&metric_keys, &runs, MAX_EMBED_PANELS);
        let panel_types = panels
            .iter()
            .filter_map(|panel| panel.get("type").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            panel_types,
            vec![
                "line",
                "line",
                "histogram",
                "bar",
                "dot",
                "scatter",
                "distribution",
                "line"
            ]
        );
        let scatter = panels
            .iter()
            .find(|panel| panel.get("type").and_then(Value::as_str) == Some("scatter"))
            .unwrap();
        assert_eq!(
            scatter.get("xField").and_then(Value::as_str),
            Some("config:%2Flearning_rate")
        );
        assert_eq!(
            scatter.get("yField").and_then(Value::as_str),
            Some("metric:eval%2Freturn%20mean:best")
        );
        let distribution = panels
            .iter()
            .find(|panel| panel.get("type").and_then(Value::as_str) == Some("distribution"))
            .unwrap();
        assert_eq!(
            distribution.get("valueField").and_then(Value::as_str),
            Some("metric:eval%2Freturn%20mean:best")
        );
        assert_eq!(
            distribution.get("groupField").and_then(Value::as_str),
            Some("config:%2Fvariant")
        );
        assert_eq!(
            distribution.get("replicateField").and_then(Value::as_str),
            Some("config:%2Fseed")
        );
    }

    #[test]
    fn embed_token_shape_is_strict() {
        let token = generate_embed_token().unwrap();
        assert!(valid_embed_token_shape(&token));
        assert!(!valid_embed_token_shape("instantml_embed_short"));
        assert!(!valid_embed_token_shape(&format!("{token}!")));
    }
}
