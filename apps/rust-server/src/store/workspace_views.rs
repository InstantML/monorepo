use super::*;

const DASHBOARD_PREFERENCE_SCHEMA_VERSION: i32 = 1;
const WORKSPACE_VIEW_SCHEMA_VERSION: i32 = 1;
const MAX_WORKSPACE_VIEW_PAYLOAD_BYTES: usize = 64 * 1024;
const DEFAULT_WORKSPACE_VIEW_LIMIT: i64 = 50;
const MAX_WORKSPACE_VIEW_LIMIT: i64 = 100;

pub async fn get_dashboard_preferences(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let user_id = require_dashboard_read(store, ctx)?;
    let data = store.data.lock().await;
    let preference = data
        .dashboard_preferences
        .get(&(ctx.org_id, user_id))
        .cloned();
    Ok(json!({
        "preferences": {
            "selected_project": preference.as_ref().and_then(|row| row.selected_project.clone()),
            "updated_at": preference.map(|row| row.updated_at)
        }
    }))
}

pub async fn update_dashboard_preferences(
    store: &Store,
    ctx: &RequestContext,
    input: UpdateDashboardPreferencesRequest,
) -> AppResult<Value> {
    let user_id = require_dashboard_write(store, ctx)?;
    ensure_billing_write_allowed(store, ctx.org_id, "save dashboard preferences").await?;
    let selected_project = validate_optional_nonempty(input.selected_project, "selected_project")?;
    let row = DashboardPreferenceRow {
        schema_version: DASHBOARD_PREFERENCE_SCHEMA_VERSION,
        org_id: ctx.org_id,
        user_id,
        selected_project,
        updated_at: Utc::now(),
    };
    let entity_id = dashboard_preference_entity_id(user_id);
    store
        .persist_locked("dashboard_preference", ctx.org_id, &entity_id, &row)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_dashboard_preference(row.clone());
    Ok(json!({
        "preferences": {
            "selected_project": row.selected_project,
            "updated_at": row.updated_at
        }
    }))
}

pub async fn list_workspace_views(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let user_id = require_dashboard_read(store, ctx)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_WORKSPACE_VIEW_LIMIT,
        MAX_WORKSPACE_VIEW_LIMIT,
    )? as usize;
    let start = query
        .get("cursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let data = store.data.lock().await;
    let mut views = data
        .workspace_views
        .values()
        .filter(|view| view.org_id == ctx.org_id)
        .filter(|view| view.owner_user_id == user_id)
        .filter(|view| view.deleted_at.is_none())
        .cloned()
        .collect::<Vec<_>>();
    views.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
    let summaries = views
        .iter()
        .skip(start)
        .take(limit)
        .map(workspace_view_summary)
        .collect::<Vec<_>>();
    let next_index = start.saturating_add(summaries.len());
    let next_cursor = if next_index < views.len() {
        Some(next_index.to_string())
    } else {
        None
    };
    Ok(json!({ "workspace_views": summaries, "next_cursor": next_cursor }))
}

pub async fn create_workspace_view(
    store: &Store,
    ctx: &RequestContext,
    input: SaveWorkspaceViewRequest,
) -> AppResult<Value> {
    let user_id = require_dashboard_write(store, ctx)?;
    ensure_billing_write_allowed(store, ctx.org_id, "create workspace views").await?;
    let name = validate_name(input.name.as_deref(), "view name")?;
    let project = validate_optional_nonempty(input.project, "project")?;
    let payload = validate_workspace_view_payload(input.payload)?;
    let now = Utc::now();
    let row = WorkspaceViewRow {
        schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        owner_user_id: user_id,
        name,
        project,
        payload,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    };
    store
        .persist_locked("workspace_view", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_workspace_view(row.clone());
    Ok(json!({ "workspace_view": row }))
}

pub async fn get_workspace_view(
    store: &Store,
    ctx: &RequestContext,
    view_id: Uuid,
) -> AppResult<Value> {
    let user_id = require_dashboard_read(store, ctx)?;
    let data = store.data.lock().await;
    let row = workspace_view_for_user(&data, ctx.org_id, user_id, view_id)?;
    Ok(json!({ "workspace_view": row }))
}

pub async fn update_workspace_view(
    store: &Store,
    ctx: &RequestContext,
    view_id: Uuid,
    input: SaveWorkspaceViewRequest,
) -> AppResult<Value> {
    let user_id = require_dashboard_write(store, ctx)?;
    ensure_billing_write_allowed(store, ctx.org_id, "update workspace views").await?;
    let existing = {
        let data = store.data.lock().await;
        workspace_view_for_user(&data, ctx.org_id, user_id, view_id)?
    };
    let name = input
        .name
        .as_deref()
        .map(|value| validate_name(Some(value), "view name"))
        .transpose()?
        .unwrap_or_else(|| existing.name.clone());
    let project = match input.project {
        Some(value) => validate_optional_nonempty(Some(value), "project")?,
        None => existing.project.clone(),
    };
    let payload = match input.payload {
        Some(value) => validate_workspace_view_payload(Some(value))?,
        None => existing.payload.clone(),
    };
    let row = WorkspaceViewRow {
        name,
        project,
        payload,
        updated_at: Utc::now(),
        ..existing
    };
    store
        .persist_locked("workspace_view", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_workspace_view(row.clone());
    Ok(json!({ "workspace_view": row }))
}

fn require_dashboard_read(store: &Store, ctx: &RequestContext) -> AppResult<Option<Uuid>> {
    if ctx.auth.is_some() {
        return Err(AppError::forbidden(
            "dashboard views require a browser session",
        ));
    }
    if store.hosted_clickhouse_enabled() && ctx.session.is_none() {
        return Err(AppError::unauthorized("browser session required"));
    }
    Ok(ctx.session.as_ref().map(|session| session.user_id))
}

fn require_dashboard_write(store: &Store, ctx: &RequestContext) -> AppResult<Option<Uuid>> {
    let user_id = require_dashboard_read(store, ctx)?;
    if let Some(session) = &ctx.session {
        if session.demo_read_only {
            return Err(AppError::forbidden(
                "demo workspace browser sessions are read-only",
            ));
        }
        if !matches!(session.role.as_str(), "owner" | "admin" | "member") {
            return Err(AppError::forbidden(
                "session role cannot write dashboard views",
            ));
        }
    }
    Ok(user_id)
}

fn dashboard_preference_entity_id(user_id: Option<Uuid>) -> String {
    format!(
        "dashboard_preference:{}",
        user_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "local".to_string())
    )
}

fn validate_optional_nonempty(value: Option<String>, field: &str) -> AppResult<Option<String>> {
    match value {
        Some(raw) if raw.trim().is_empty() => Ok(None),
        Some(raw) => validate_name(Some(&raw), field).map(Some),
        None => Ok(None),
    }
}

fn validate_workspace_view_payload(value: Option<Value>) -> AppResult<Value> {
    let payload = validate_json_object(value, "payload")?;
    validate_json_size(&payload, "payload", MAX_WORKSPACE_VIEW_PAYLOAD_BYTES)?;
    Ok(payload)
}

fn workspace_view_for_user(
    data: &StoreData,
    org_id: Uuid,
    user_id: Option<Uuid>,
    view_id: Uuid,
) -> AppResult<WorkspaceViewRow> {
    data.workspace_views
        .get(&view_id)
        .filter(|view| view.org_id == org_id)
        .filter(|view| view.owner_user_id == user_id)
        .filter(|view| view.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| AppError::not_found("workspace view not found"))
}

fn workspace_view_summary(view: &WorkspaceViewRow) -> WorkspaceViewSummary {
    WorkspaceViewSummary {
        id: view.id,
        name: view.name.clone(),
        project: view.project.clone(),
        created_at: view.created_at,
        updated_at: view.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SessionContext;

    fn store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_workspace_views_test",
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
                default_data_cell_id: None,
                current_data_cell_id: None,
                register_current_data_cell: false,
                current_data_cell_public_api_base: None,
                public_api_base_allowed_suffix: None,
                writer_lease: None,
            },
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
            current_writer_lease: Arc::new(Mutex::new(None)),
            current_writer_lease_deadline: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn workspace_view_payload_must_be_small_object() {
        assert!(validate_workspace_view_payload(Some(json!({ "ok": true }))).is_ok());
        assert!(validate_workspace_view_payload(Some(json!(["nope"]))).is_err());
        assert!(validate_workspace_view_payload(Some(json!({
            "large": "x".repeat(MAX_WORKSPACE_VIEW_PAYLOAD_BYTES)
        })))
        .is_err());
    }

    #[test]
    fn dashboard_preference_entity_id_is_stable() {
        let id = Uuid::from_u128(42);
        assert_eq!(
            dashboard_preference_entity_id(Some(id)),
            format!("dashboard_preference:{id}")
        );
        assert_eq!(
            dashboard_preference_entity_id(None),
            "dashboard_preference:local"
        );
    }

    #[test]
    fn workspace_view_lookup_is_scoped_to_org_owner_and_live_rows() {
        let now = Utc::now();
        let org_id = Uuid::from_u128(1);
        let other_org_id = Uuid::from_u128(2);
        let owner_user_id = Some(Uuid::from_u128(3));
        let other_user_id = Some(Uuid::from_u128(4));
        let view_id = Uuid::from_u128(5);
        let deleted_view_id = Uuid::from_u128(6);
        let mut data = StoreData::default();

        data.insert_workspace_view(WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: view_id,
            org_id,
            owner_user_id,
            name: "daily".to_string(),
            project: Some("demo".to_string()),
            payload: json!({ "tab": "runs" }),
            created_at: now,
            updated_at: now,
            deleted_at: None,
        });
        data.insert_workspace_view(WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: deleted_view_id,
            org_id,
            owner_user_id,
            name: "deleted".to_string(),
            project: None,
            payload: json!({ "tab": "runs" }),
            created_at: now,
            updated_at: now,
            deleted_at: Some(now),
        });

        assert_eq!(
            workspace_view_for_user(&data, org_id, owner_user_id, view_id)
                .unwrap()
                .name,
            "daily"
        );
        assert!(workspace_view_for_user(&data, other_org_id, owner_user_id, view_id).is_err());
        assert!(workspace_view_for_user(&data, org_id, other_user_id, view_id).is_err());
        assert!(workspace_view_for_user(&data, org_id, owner_user_id, deleted_view_id).is_err());
    }

    #[tokio::test]
    async fn workspace_view_writes_respect_billing_block() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "owner@example.com".to_string(),
            display_name: Some("Owner".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "paid-lab".to_string(),
            name: "Paid Lab".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "business".to_string(),
            seat_limit: PLAN_PRO.included_seats,
            created_by_user_id: Some(user.id),
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let mut data = StoreData::default();
        data.insert_user(user.clone());
        data.insert_org(org.clone());
        data.insert_membership(membership_row(org.id, user.id, "owner", "active"));
        let store = store_with_data(data);
        let ctx = RequestContext {
            org_id: org.id,
            auth: None,
            session: Some(SessionContext {
                session_id: Uuid::new_v4(),
                user_id: user.id,
                role: "owner".to_string(),
                demo_read_only: false,
            }),
        };

        let preference_error = update_dashboard_preferences(
            &store,
            &ctx,
            UpdateDashboardPreferencesRequest {
                selected_project: Some("demo".to_string()),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            preference_error.status(),
            axum::http::StatusCode::PAYMENT_REQUIRED
        );

        let view_error = create_workspace_view(
            &store,
            &ctx,
            SaveWorkspaceViewRequest {
                name: Some("Daily".to_string()),
                project: None,
                payload: Some(json!({ "tab": "runs" })),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            view_error.status(),
            axum::http::StatusCode::PAYMENT_REQUIRED
        );
    }
}
