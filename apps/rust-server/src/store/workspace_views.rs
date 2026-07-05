use super::*;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

const DASHBOARD_PREFERENCE_SCHEMA_VERSION: i32 = 1;
const WORKSPACE_VIEW_SCHEMA_VERSION: i32 = 1;
const WORKSPACE_VIEW_EXPORT_KIND: &str = "instantml.workspace_view";
const MAX_WORKSPACE_VIEW_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_WORKSPACE_VIEW_DATA_VIEW_BYTES: usize = 256 * 1024;
const MAX_LIVE_WORKSPACE_VIEWS_PER_USER: usize = 200;
const MAX_LIVE_WORKSPACE_VIEWS_PER_ORG: usize = 1_000;
const MAX_WORKSPACE_VIEW_TOMBSTONES_PER_USER: usize = 50;
const DEFAULT_WORKSPACE_VIEW_LIMIT: i64 = 50;
const MAX_WORKSPACE_VIEW_LIMIT: i64 = 100;
const DEFAULT_WORKSPACE_VIEW_DATA_PANEL_LIMIT: usize = 20;
const MAX_WORKSPACE_VIEW_DATA_PANEL_LIMIT: usize = 50;
const MAX_WORKSPACE_VIEW_DATA_RUN_IDS: usize = 100;
const DEFAULT_WORKSPACE_VIEW_DATA_POINTS_PER_SERIES: i64 = 500;
const MAX_WORKSPACE_VIEW_DATA_POINTS_PER_SERIES: i64 = 500;
const MAX_WORKSPACE_VIEW_DATA_TOTAL_POINTS: usize = 50_000;
const MAX_WORKSPACE_VIEW_DATA_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

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
    persist_new_workspace_view_with_capacity(store, &row).await?;
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

pub async fn export_workspace_view(
    store: &Store,
    ctx: &RequestContext,
    view_id: Uuid,
) -> AppResult<WorkspaceViewExportEnvelope> {
    let user_id = require_dashboard_read(store, ctx)?;
    let data = store.data.lock().await;
    let row = workspace_view_for_user(&data, ctx.org_id, user_id, view_id)?;
    workspace_view_export_envelope(&row)
}

pub async fn import_workspace_view(
    store: &Store,
    ctx: &RequestContext,
    input: ImportWorkspaceViewRequest,
) -> AppResult<WorkspaceViewImportResponse> {
    let user_id = require_dashboard_write(store, ctx)?;
    let action = validate_workspace_view_import_action(input.conflict_strategy.as_deref())?;
    validate_workspace_view_export_envelope(&input.exported_view)?;
    let name = input
        .name
        .as_deref()
        .map(|value| validate_name(Some(value), "view name"))
        .transpose()?
        .unwrap_or_else(|| input.exported_view.view.name.clone());
    let name = validate_name(Some(&name), "view name")?;
    let project = match input.project {
        Some(value) => validate_optional_nonempty(Some(value), "project")?,
        None => input
            .exported_view
            .view
            .project
            .clone()
            .map(|value| validate_optional_nonempty(Some(value), "project"))
            .transpose()?
            .flatten(),
    };
    let (payload, warnings) =
        sanitize_workspace_view_import_payload(input.exported_view.view.payload.clone())?;
    let payload = validate_workspace_view_payload(Some(payload))?;
    let payload_bytes = json_size_bytes(&payload)?;
    let replace_target = validate_workspace_view_import_replace_target(
        &action,
        input.existing_view_id,
        input.expected_updated_at,
    )?;

    if input.dry_run {
        if let Some((view_id, expected_updated_at)) = replace_target.as_ref() {
            let data = store.data.lock().await;
            let existing = workspace_view_for_user(&data, ctx.org_id, user_id, *view_id)?;
            ensure_workspace_view_expected_updated_at(&existing, expected_updated_at.to_owned())?;
        }
        return Ok(WorkspaceViewImportResponse {
            dry_run: true,
            action,
            name,
            project,
            payload_bytes,
            warnings,
            workspace_view: None,
        });
    }

    ensure_billing_write_allowed(store, ctx.org_id, "import workspace views").await?;
    let now = Utc::now();
    let row = match replace_target {
        Some((view_id, expected_updated_at)) => {
            let existing = {
                let data = store.data.lock().await;
                let existing = workspace_view_for_user(&data, ctx.org_id, user_id, view_id)?;
                ensure_workspace_view_expected_updated_at(&existing, expected_updated_at)?;
                existing
            };
            let row = WorkspaceViewRow {
                name,
                project,
                payload,
                updated_at: now,
                ..existing
            };
            persist_workspace_view_current(store, ctx.org_id, &row, expected_updated_at).await?;
            let mut data = store.data.lock().await;
            data.insert_workspace_view(row.clone());
            row
        }
        None => {
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
            persist_new_workspace_view_with_capacity(store, &row).await?;
            let mut data = store.data.lock().await;
            data.insert_workspace_view(row.clone());
            row
        }
    };
    Ok(WorkspaceViewImportResponse {
        dry_run: false,
        action,
        name: row.name.clone(),
        project: row.project.clone(),
        payload_bytes,
        warnings,
        workspace_view: Some(row),
    })
}

pub async fn delete_workspace_view(
    store: &Store,
    ctx: &RequestContext,
    view_id: Uuid,
    expected_updated_at: DateTime<Utc>,
) -> AppResult<WorkspaceViewDeleteResponse> {
    let user_id = require_dashboard_write(store, ctx)?;
    let deleted_at = Utc::now();
    let existing = {
        let data = store.data.lock().await;
        let existing = workspace_view_for_user(&data, ctx.org_id, user_id, view_id)?;
        ensure_workspace_view_expected_updated_at(&existing, expected_updated_at)?;
        existing
    };
    let row = WorkspaceViewRow {
        updated_at: deleted_at,
        deleted_at: Some(deleted_at),
        ..existing
    };
    persist_workspace_view_current(store, ctx.org_id, &row, expected_updated_at).await?;
    if let Some(control_db) = &store.control_db {
        control_db
            .prune_workspace_view_tombstones(
                ctx.org_id,
                user_id,
                MAX_WORKSPACE_VIEW_TOMBSTONES_PER_USER as i64,
            )
            .await?;
    }
    let mut data = store.data.lock().await;
    data.insert_workspace_view(row);
    prune_workspace_view_tombstones_in_data(
        &mut data,
        ctx.org_id,
        user_id,
        MAX_WORKSPACE_VIEW_TOMBSTONES_PER_USER,
    );
    Ok(WorkspaceViewDeleteResponse {
        deleted: true,
        view_id,
        deleted_at,
    })
}

pub async fn workspace_view_data(
    store: &Store,
    ctx: &RequestContext,
    input: WorkspaceViewDataRequest,
) -> AppResult<WorkspaceViewDataResponse> {
    if let Some(auth) = &ctx.auth {
        auth.require_scope("export:read")?;
    }
    validate_json_size(&input.view, "view", MAX_WORKSPACE_VIEW_DATA_VIEW_BYTES)?;
    let run_ids = dedupe_workspace_view_data_run_ids(input.run_ids)?;
    let requested_metric_point_limit = input
        .options
        .as_ref()
        .and_then(|options| options.metric_point_limit)
        .unwrap_or(DEFAULT_WORKSPACE_VIEW_DATA_POINTS_PER_SERIES)
        .clamp(1, MAX_WORKSPACE_VIEW_DATA_POINTS_PER_SERIES);
    let max_panels = input
        .options
        .as_ref()
        .and_then(|options| options.max_panels)
        .unwrap_or(DEFAULT_WORKSPACE_VIEW_DATA_PANEL_LIMIT)
        .clamp(1, MAX_WORKSPACE_VIEW_DATA_PANEL_LIMIT);
    let (payload, mut warnings) = workspace_view_data_payload(&input.view)?;
    let (panels, panel_warnings) = workspace_view_data_panels(&payload, max_panels)?;
    warnings.extend(panel_warnings);
    let mut metric_keys = panels
        .iter()
        .map(|panel| panel.metric_key.clone())
        .collect::<BTreeSet<_>>();
    let mut line_metric_keys = panels
        .iter()
        .filter(|panel| panel.panel_type == "line")
        .map(|panel| panel.metric_key.clone())
        .collect::<BTreeSet<_>>();
    if metric_keys.is_empty() {
        if let Some(metric_key) = payload
            .get("metricKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let metric_key = validate_name(Some(metric_key), "metricKey")?;
            metric_keys.insert(metric_key.clone());
            line_metric_keys.insert(metric_key);
        }
    }
    let metric_key_vec = metric_keys.iter().cloned().collect::<Vec<_>>();
    let line_metric_key_vec = line_metric_keys.iter().cloned().collect::<Vec<_>>();
    let runs = {
        let data = store.data.lock().await;
        run_ids
            .iter()
            .map(|run_id| workspace_view_data_run_for_ctx(&data, ctx, *run_id))
            .collect::<AppResult<Vec<_>>>()?
    };
    let summaries = summarize_runs_for_metric_keys(store, runs, &metric_key_vec).await?;
    let metric_point_limit = workspace_view_data_effective_point_limit(
        requested_metric_point_limit,
        run_ids.len(),
        line_metric_key_vec.len(),
        &mut warnings,
    );

    let metric_series = workspace_view_metric_series_for_keys(
        store,
        ctx.org_id,
        &run_ids,
        &line_metric_key_vec,
        metric_point_limit,
    )
    .await?;
    let total_points = metric_series
        .iter()
        .map(|item| metric_series_point_count(&item.series))
        .sum::<usize>();
    if total_points > MAX_WORKSPACE_VIEW_DATA_TOTAL_POINTS {
        return Err(AppError::validation(format!(
            "workspace view data would exceed {MAX_WORKSPACE_VIEW_DATA_TOTAL_POINTS} metric points"
        )));
    }

    let panel_values = panels
        .iter()
        .map(|panel| {
            let metric_summary = metric_summary_values(&summaries, &panel.metric_key);
            let mut panel_warnings = Vec::new();
            let series_key = if panel.panel_type == "line" {
                Some(panel.metric_key.clone())
            } else {
                if !workspace_view_summary_panel_type(&panel.panel_type) {
                    let warning = format!(
                        "panel {} uses unsupported type {}; returned run summaries only",
                        panel.id, panel.panel_type
                    );
                    warnings.push(warning.clone());
                    panel_warnings.push(warning);
                }
                None
            };
            WorkspaceViewDataPanelResult {
                id: panel.id.clone(),
                title: panel.title.clone(),
                panel_type: panel.panel_type.clone(),
                section_id: panel.section_id.clone(),
                section_name: panel.section_name.clone(),
                metric_key: panel.metric_key.clone(),
                data_kind: if panel.panel_type == "line" {
                    "metric_series".to_string()
                } else {
                    "metric_summary".to_string()
                },
                series_key,
                x_field: panel.x_field.clone(),
                y_field: panel.y_field.clone(),
                value_field: panel.value_field.clone(),
                group_field: panel.group_field.clone(),
                replicate_field: panel.replicate_field.clone(),
                summary_values: metric_summary,
                warnings: panel_warnings,
            }
        })
        .collect::<Vec<_>>();

    let response = WorkspaceViewDataResponse {
        view_data: WorkspaceViewData {
            schema_version: 1,
            generated_at: Utc::now(),
            run_ids,
            runs: summaries,
            metric_keys: metric_key_vec,
            metric_series,
            panels: panel_values,
            warnings,
            limits: WorkspaceViewDataLimits {
                run_ids: MAX_WORKSPACE_VIEW_DATA_RUN_IDS,
                panels: max_panels,
                points_per_series: metric_point_limit,
                max_points_per_series: MAX_WORKSPACE_VIEW_DATA_POINTS_PER_SERIES,
                total_points,
                max_total_points: MAX_WORKSPACE_VIEW_DATA_TOTAL_POINTS,
                max_response_bytes: MAX_WORKSPACE_VIEW_DATA_RESPONSE_BYTES,
            },
        },
    };
    let response_bytes = serialized_size_bytes(&response)?;
    if response_bytes > MAX_WORKSPACE_VIEW_DATA_RESPONSE_BYTES {
        return Err(AppError::validation(format!(
            "workspace view data response exceeds {MAX_WORKSPACE_VIEW_DATA_RESPONSE_BYTES} bytes"
        )));
    }
    Ok(response)
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
    ensure_no_dangerous_workspace_view_keys(&payload, "$")?;
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

fn workspace_view_data_run_for_ctx(
    data: &StoreData,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<RunRow> {
    let run = data
        .runs
        .get(&run_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("run not found"))?;
    if !is_visible_run(data, &run) || run.org_id != ctx.org_id {
        return Err(AppError::not_found("run not found"));
    }
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .map(|project_id| project_id != run.project_id)
        .unwrap_or(false)
    {
        return Err(AppError::not_found("run not found"));
    }
    Ok(run)
}

fn ensure_workspace_view_create_capacity(
    data: &StoreData,
    org_id: Uuid,
    user_id: Option<Uuid>,
) -> AppResult<()> {
    let live_for_org = data
        .workspace_views
        .values()
        .filter(|view| view.org_id == org_id)
        .filter(|view| view.deleted_at.is_none())
        .count();
    if live_for_org >= MAX_LIVE_WORKSPACE_VIEWS_PER_ORG {
        return Err(AppError::validation(format!(
            "workspace cannot have more than {MAX_LIVE_WORKSPACE_VIEWS_PER_ORG} saved views"
        )));
    }
    let live_for_user = data
        .workspace_views
        .values()
        .filter(|view| view.org_id == org_id)
        .filter(|view| view.owner_user_id == user_id)
        .filter(|view| view.deleted_at.is_none())
        .count();
    if live_for_user >= MAX_LIVE_WORKSPACE_VIEWS_PER_USER {
        return Err(AppError::validation(format!(
            "user cannot have more than {MAX_LIVE_WORKSPACE_VIEWS_PER_USER} saved views"
        )));
    }
    Ok(())
}

async fn persist_new_workspace_view_with_capacity(
    store: &Store,
    row: &WorkspaceViewRow,
) -> AppResult<()> {
    if let Some(control_db) = &store.control_db {
        return control_db
            .insert_workspace_view_with_capacity(
                row,
                MAX_LIVE_WORKSPACE_VIEWS_PER_USER as i64,
                MAX_LIVE_WORKSPACE_VIEWS_PER_ORG as i64,
            )
            .await;
    }
    {
        let data = store.data.lock().await;
        ensure_workspace_view_create_capacity(&data, row.org_id, row.owner_user_id)?;
    }
    store
        .persist_locked("workspace_view", row.org_id, &row.id.to_string(), row)
        .await
}

fn prune_workspace_view_tombstones_in_data(
    data: &mut StoreData,
    org_id: Uuid,
    user_id: Option<Uuid>,
    keep: usize,
) {
    let mut tombstones = data
        .workspace_views
        .values()
        .filter(|view| view.org_id == org_id)
        .filter(|view| view.owner_user_id == user_id)
        .filter(|view| view.deleted_at.is_some())
        .map(|view| {
            (
                view.deleted_at.unwrap_or(view.updated_at),
                view.updated_at,
                view.id,
            )
        })
        .collect::<Vec<_>>();
    tombstones.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.2.cmp(&left.2))
    });
    for (_, _, id) in tombstones.into_iter().skip(keep) {
        data.workspace_views.remove(&id);
    }
}

async fn workspace_view_metric_series_for_keys(
    store: &Store,
    org_id: Uuid,
    run_ids: &[Uuid],
    keys: &[String],
    metric_point_limit: i64,
) -> AppResult<Vec<WorkspaceViewMetricSeries>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let metric_store = store.metric_store_for_org(org_id).await?;
    let rows = metric_store
        .query_points_for_runs_keys(org_id, run_ids, keys, metric_point_limit)
        .await?;
    let mut grouped: BTreeMap<String, BTreeMap<Uuid, Vec<Value>>> = BTreeMap::new();
    for row in rows {
        let key = row.key;
        grouped
            .entry(key.clone())
            .or_default()
            .entry(row.run_id)
            .or_default()
            .push(json!({
                "key": key,
                "step": row.step,
                "value": row.value,
                "created_at": row.created_at
            }));
    }
    Ok(keys
        .iter()
        .map(|key| {
            let mut per_run = grouped.remove(key).unwrap_or_default();
            let series = run_ids
                .iter()
                .map(|run_id| {
                    json!({
                        "run_id": run_id,
                        "metrics": per_run.remove(run_id).unwrap_or_default()
                    })
                })
                .collect::<Vec<_>>();
            WorkspaceViewMetricSeries {
                metric_key: key.clone(),
                series,
            }
        })
        .collect())
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

fn workspace_view_export_envelope(
    row: &WorkspaceViewRow,
) -> AppResult<WorkspaceViewExportEnvelope> {
    let (payload, _) = sanitize_workspace_view_import_payload(row.payload.clone())?;
    let payload = validate_workspace_view_payload(Some(payload))?;
    let payload_sha256 = json_sha256(&payload)?;
    Ok(WorkspaceViewExportEnvelope {
        kind: WORKSPACE_VIEW_EXPORT_KIND.to_string(),
        schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
        exported_at: Utc::now(),
        source: WorkspaceViewExportSource {
            product: "instantml".to_string(),
            format: "workspace_view".to_string(),
        },
        view: WorkspaceViewExportedView {
            name: row.name.clone(),
            project: row.project.clone(),
            payload,
        },
        integrity: WorkspaceViewExportIntegrity { payload_sha256 },
    })
}

fn validate_workspace_view_export_envelope(
    envelope: &WorkspaceViewExportEnvelope,
) -> AppResult<()> {
    if envelope.kind != WORKSPACE_VIEW_EXPORT_KIND {
        return Err(AppError::validation("exported_view.kind is not supported"));
    }
    if envelope.schema_version != WORKSPACE_VIEW_SCHEMA_VERSION {
        return Err(AppError::validation(
            "exported_view.schema_version is not supported",
        ));
    }
    validate_workspace_view_payload(Some(envelope.view.payload.clone()))?;
    let expected = json_sha256(&envelope.view.payload)?;
    if envelope.integrity.payload_sha256 != expected {
        return Err(AppError::validation(
            "exported_view.integrity.payload_sha256 does not match payload",
        ));
    }
    Ok(())
}

fn validate_workspace_view_import_action(raw: Option<&str>) -> AppResult<String> {
    let action = raw.unwrap_or("create").trim();
    if matches!(action, "create" | "replace") {
        Ok(action.to_string())
    } else {
        Err(AppError::validation(
            "conflict_strategy must be create or replace",
        ))
    }
}

fn validate_workspace_view_import_replace_target(
    action: &str,
    existing_view_id: Option<Uuid>,
    expected_updated_at: Option<DateTime<Utc>>,
) -> AppResult<Option<(Uuid, DateTime<Utc>)>> {
    if action != "replace" {
        return Ok(None);
    }
    let view_id = existing_view_id
        .ok_or_else(|| AppError::validation("existing_view_id is required for replace"))?;
    let expected_updated_at = expected_updated_at
        .ok_or_else(|| AppError::validation("expected_updated_at is required for replace"))?;
    Ok(Some((view_id, expected_updated_at)))
}

fn ensure_workspace_view_expected_updated_at(
    existing: &WorkspaceViewRow,
    expected_updated_at: DateTime<Utc>,
) -> AppResult<()> {
    if existing.updated_at == expected_updated_at {
        Ok(())
    } else {
        Err(AppError::conflict(
            "workspace view was updated by another request",
        ))
    }
}

async fn persist_workspace_view_current(
    store: &Store,
    org_id: Uuid,
    row: &WorkspaceViewRow,
    expected_updated_at: DateTime<Utc>,
) -> AppResult<()> {
    if let Some(control_db) = &store.control_db {
        if control_db
            .update_workspace_view_if_current(row, expected_updated_at)
            .await?
        {
            return Ok(());
        }
        return Err(AppError::conflict(
            "workspace view was updated by another request",
        ));
    }
    store
        .persist_locked("workspace_view", org_id, &row.id.to_string(), row)
        .await
}

fn json_sha256(value: &Value) -> AppResult<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| AppError::internal("workspace view payload serialization failed"))?;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut out, "{byte:02x}")
            .map_err(|_| AppError::internal("workspace view digest formatting failed"))?;
    }
    Ok(out)
}

fn json_size_bytes(value: &Value) -> AppResult<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| AppError::internal("workspace view payload serialization failed"))
}

fn serialized_size_bytes<T: Serialize>(value: &T) -> AppResult<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| AppError::internal("workspace view payload serialization failed"))
}

fn sanitize_workspace_view_import_payload(payload: Value) -> AppResult<(Value, Vec<String>)> {
    let mut warnings = Vec::new();
    let sanitized =
        sanitize_workspace_view_json(payload, "$", &mut warnings)?.unwrap_or_else(|| json!({}));
    Ok((sanitized, warnings))
}

fn ensure_no_dangerous_workspace_view_keys(value: &Value, path: &str) -> AppResult<()> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if is_dangerous_json_key(key) {
                    return Err(AppError::validation(format!(
                        "payload contains unsupported key {path}.{key}"
                    )));
                }
                ensure_no_dangerous_workspace_view_keys(child, &format!("{path}.{key}"))?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                ensure_no_dangerous_workspace_view_keys(child, &format!("{path}[{index}]"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn sanitize_workspace_view_json(
    value: Value,
    path: &str,
    warnings: &mut Vec<String>,
) -> AppResult<Option<Value>> {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                if is_dangerous_json_key(&key) {
                    return Err(AppError::validation(format!(
                        "payload contains unsupported key {key}"
                    )));
                }
                if is_sensitive_json_key(&key) {
                    warnings.push(format!("dropped sensitive field {path}.{key}"));
                    continue;
                }
                if let Some(value) =
                    sanitize_workspace_view_json(child, &format!("{path}.{key}"), warnings)?
                {
                    out.insert(key, value);
                }
            }
            Ok(Some(Value::Object(out)))
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (index, child) in items.into_iter().enumerate() {
                if let Some(value) =
                    sanitize_workspace_view_json(child, &format!("{path}[{index}]"), warnings)?
                {
                    out.push(value);
                }
            }
            Ok(Some(Value::Array(out)))
        }
        Value::String(value) if is_sensitive_json_string(&value) => {
            warnings.push(format!("dropped sensitive string at {path}"));
            Ok(None)
        }
        other => Ok(Some(other)),
    }
}

fn is_dangerous_json_key(key: &str) -> bool {
    matches!(key, "__proto__" | "prototype" | "constructor")
}

fn is_sensitive_json_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("apikey")
        || normalized.contains("authorization")
        || normalized.contains("credential")
        || normalized.contains("cookie")
        || matches!(
            normalized.as_str(),
            "orgid"
                | "organizationid"
                | "owneruserid"
                | "userid"
                | "sessionid"
                | "tenantid"
                | "runid"
                | "runids"
                | "primaryrunid"
                | "referencerunid"
                | "selectedrunid"
                | "selectedrunids"
                | "localstoragekey"
                | "storagekey"
                | "bucket"
                | "objectpath"
                | "artifacturi"
                | "artifacturl"
                | "signedurl"
                | "presignedurl"
                | "url"
                | "uri"
        )
        || normalized.contains("tenantroute")
        || normalized.contains("localstorage")
        || normalized.contains("signedurl")
        || normalized.contains("presigned")
        || normalized.contains("bucketname")
        || normalized.contains("objectkey")
        || normalized.contains("objectpath")
        || normalized.contains("artifacturi")
}

fn is_sensitive_json_string(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("s3://")
        || lower.starts_with("gs://")
        || lower.starts_with("bearer ")
        || lower.contains("x-amz-signature")
        || lower.contains("x-amz-credential")
        || lower.contains("signature=")
        || lower.contains("token=")
        || lower.contains("api_key=")
        || lower.contains("apikey=")
        || lower.contains("password=")
        || lower.contains("secret=")
        || lower.contains("credential=")
        || lower.contains("session=")
        || lower.contains("localstorage")
        || trimmed.starts_with("sk_")
        || trimmed.starts_with("pk_")
        || trimmed.starts_with("AKIA")
        || trimmed.contains("-----BEGIN ")
}

fn dedupe_workspace_view_data_run_ids(run_ids: Vec<Uuid>) -> AppResult<Vec<Uuid>> {
    if run_ids.is_empty() {
        return Err(AppError::validation(
            "run_ids must include at least one run",
        ));
    }
    if run_ids.len() > MAX_WORKSPACE_VIEW_DATA_RUN_IDS {
        return Err(AppError::validation(format!(
            "run_ids cannot include more than {MAX_WORKSPACE_VIEW_DATA_RUN_IDS} runs"
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

fn workspace_view_data_effective_point_limit(
    requested_limit: i64,
    run_count: usize,
    metric_key_count: usize,
    warnings: &mut Vec<String>,
) -> i64 {
    let series_slots = run_count.saturating_mul(metric_key_count);
    if series_slots == 0 {
        return requested_limit;
    }
    let cap_per_series = (MAX_WORKSPACE_VIEW_DATA_TOTAL_POINTS / series_slots)
        .max(1)
        .try_into()
        .unwrap_or(1);
    let effective = requested_limit.min(cap_per_series);
    if effective < requested_limit {
        warnings.push(format!(
            "metric_point_limit reduced to {effective} to keep the response under {MAX_WORKSPACE_VIEW_DATA_TOTAL_POINTS} total metric points"
        ));
    }
    effective
}

fn metric_series_point_count(series: &[Value]) -> usize {
    series
        .iter()
        .filter_map(|run_series| run_series.get("metrics").and_then(Value::as_array))
        .map(Vec::len)
        .sum()
}

fn workspace_view_summary_panel_type(panel_type: &str) -> bool {
    matches!(
        panel_type,
        "bar" | "dot" | "value" | "histogram" | "value_histogram" | "scatter" | "distribution"
    )
}

#[derive(Clone, Debug)]
struct WorkspaceViewDataPanel {
    id: String,
    title: String,
    panel_type: String,
    section_id: String,
    section_name: String,
    metric_key: String,
    x_field: Option<String>,
    y_field: Option<String>,
    value_field: Option<String>,
    group_field: Option<String>,
    replicate_field: Option<String>,
}

fn workspace_view_data_payload(view: &Value) -> AppResult<(Value, Vec<String>)> {
    let payload = if view
        .get("kind")
        .and_then(Value::as_str)
        .map(|kind| kind == WORKSPACE_VIEW_EXPORT_KIND)
        .unwrap_or(false)
    {
        let envelope = serde_json::from_value::<WorkspaceViewExportEnvelope>(view.clone())
            .map_err(|_| AppError::validation("view export envelope is invalid"))?;
        validate_workspace_view_export_envelope(&envelope)?;
        envelope.view.payload
    } else if let Some(payload) = view.get("payload").filter(|payload| payload.is_object()) {
        payload.clone()
    } else {
        validate_json_object(Some(view.clone()), "view")?
    };
    let (payload, warnings) = sanitize_workspace_view_import_payload(payload)?;
    let payload = validate_workspace_view_payload(Some(payload))?;
    Ok((payload, warnings))
}

fn workspace_view_data_panels(
    payload: &Value,
    max_panels: usize,
) -> AppResult<(Vec<WorkspaceViewDataPanel>, Vec<String>)> {
    let workspace = payload
        .get("workspaceView")
        .filter(|value| value.is_object())
        .unwrap_or(payload);
    let Some(sections) = workspace.get("sections").and_then(Value::as_array) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let mut panels = Vec::new();
    let mut warnings = Vec::new();
    'sections: for section in sections {
        let section_id = section
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("section")
            .chars()
            .take(80)
            .collect::<String>();
        let section_name = section
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Charts")
            .chars()
            .take(80)
            .collect::<String>();
        let Some(section_panels) = section.get("panels").and_then(Value::as_array) else {
            continue;
        };
        for panel in section_panels {
            if panels.len() >= max_panels {
                warnings.push(format!("panel list capped at {max_panels} panels"));
                break 'sections;
            }
            let Some(metric_key) = panel
                .get("metricKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let panel_type = panel
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("line")
                .to_string();
            let title = panel
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(metric_key)
                .chars()
                .take(100)
                .collect::<String>();
            let id = panel
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(metric_key)
                .chars()
                .take(100)
                .collect::<String>();
            panels.push(WorkspaceViewDataPanel {
                id,
                title,
                panel_type,
                section_id: section_id.clone(),
                section_name: section_name.clone(),
                metric_key: validate_name(Some(metric_key), "metricKey")?,
                x_field: workspace_view_panel_field(panel, "xField"),
                y_field: workspace_view_panel_field(panel, "yField"),
                value_field: workspace_view_panel_field(panel, "valueField"),
                group_field: workspace_view_panel_field(panel, "groupField"),
                replicate_field: workspace_view_panel_field(panel, "replicateField"),
            });
        }
    }
    Ok((panels, warnings))
}

fn workspace_view_panel_field(panel: &Value, key: &str) -> Option<String> {
    panel
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(512).collect::<String>())
}

fn metric_summary_values(summaries: &[Value], metric_key: &str) -> Vec<Value> {
    summaries
        .iter()
        .map(|run| {
            let run_id = run.get("id").cloned().unwrap_or(Value::Null);
            let aggregate = run
                .get("metric_aggregates")
                .and_then(|aggregates| aggregates.get(metric_key))
                .cloned()
                .unwrap_or(Value::Null);
            let latest = run
                .get("latest_metrics")
                .and_then(|latest| latest.get(metric_key))
                .cloned()
                .unwrap_or(Value::Null);
            json!({
                "run_id": run_id,
                "latest": latest,
                "aggregate": aggregate
            })
        })
        .collect()
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
            trace_ingest_capacity_locks: Arc::new(Mutex::new(HashMap::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            write_gate_usage: Arc::new(Mutex::new(HashMap::new())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    fn test_run(id: Uuid, org_id: Uuid, project_id: Uuid, name: &str) -> RunRow {
        RunRow {
            id,
            org_id,
            project_id,
            project: "default".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: Vec::new(),
            metadata: json!({}),
            created_at: Utc::now(),
            started_at: Utc::now(),
            finished_at: Some(Utc::now()),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
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
    fn workspace_view_export_envelope_hashes_payload() {
        let row = WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: Uuid::from_u128(10),
            org_id: Uuid::from_u128(1),
            owner_user_id: None,
            name: "Daily".to_string(),
            project: Some("demo".to_string()),
            payload: json!({ "metricKey": "eval/reward" }),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            deleted_at: None,
        };
        let envelope = workspace_view_export_envelope(&row).unwrap();
        assert_eq!(envelope.kind, WORKSPACE_VIEW_EXPORT_KIND);
        assert_eq!(envelope.schema_version, WORKSPACE_VIEW_SCHEMA_VERSION);
        assert_eq!(envelope.view.name, "Daily");
        assert!(validate_workspace_view_export_envelope(&envelope).is_ok());

        let mut tampered = envelope.clone();
        tampered.view.payload = json!({ "metricKey": "train/loss" });
        assert!(validate_workspace_view_export_envelope(&tampered).is_err());
    }

    #[test]
    fn workspace_view_export_envelope_drops_sensitive_payload_fields() {
        let row = WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: Uuid::from_u128(101),
            org_id: Uuid::from_u128(1),
            owner_user_id: None,
            name: "Daily".to_string(),
            project: Some("demo".to_string()),
            payload: json!({
                "metricKey": "eval/reward",
                "workspaceView": {
                    "settings": { "apiToken": "secret", "maxRuns": 10 }
                }
            }),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            deleted_at: None,
        };
        let envelope = workspace_view_export_envelope(&row).unwrap();
        assert!(envelope
            .view
            .payload
            .pointer("/workspaceView/settings/apiToken")
            .is_none());
        assert_eq!(
            envelope
                .view
                .payload
                .pointer("/workspaceView/settings/maxRuns")
                .and_then(Value::as_i64),
            Some(10)
        );
        assert_eq!(
            envelope.integrity.payload_sha256,
            json_sha256(&envelope.view.payload).unwrap()
        );
    }

    #[test]
    fn workspace_view_import_sanitizer_drops_sensitive_keys_and_rejects_proto_keys() {
        let (sanitized, warnings) = sanitize_workspace_view_import_payload(json!({
            "workspaceView": {
                "org_id": Uuid::new_v4().to_string(),
                "primaryRunId": Uuid::new_v4().to_string(),
                "referenceRunId": Uuid::new_v4().to_string(),
                "selectedRunIds": [Uuid::new_v4().to_string()],
                "settings": {
                    "apiToken": "secret",
                    "maxRuns": 10,
                    "signedUrl": "https://storage.example.invalid/object?X-Amz-Signature=abc",
                    "artifactUri": "s3://bucket/checkpoint.pt",
                    "objectPath": "runs/secret/checkpoint.pt"
                },
                "sections": [{ "panels": [{
                    "id": "panel-a",
                    "metricKey": "eval/reward",
                    "title": "https://example.invalid/share"
                }] }]
            }
        }))
        .unwrap();
        assert!(warnings.iter().any(|warning| warning.contains("apiToken")));
        assert!(warnings.iter().any(|warning| warning.contains("org_id")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("selectedRunIds")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("primaryRunId")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("referenceRunId")));
        assert!(warnings.iter().any(|warning| warning.contains("signedUrl")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("artifactUri")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("sensitive string")));
        assert!(sanitized
            .pointer("/workspaceView/settings/apiToken")
            .is_none());
        assert!(sanitized.pointer("/workspaceView/org_id").is_none());
        assert!(sanitized.pointer("/workspaceView/primaryRunId").is_none());
        assert!(sanitized.pointer("/workspaceView/referenceRunId").is_none());
        assert!(sanitized.pointer("/workspaceView/selectedRunIds").is_none());
        assert!(sanitized
            .pointer("/workspaceView/settings/signedUrl")
            .is_none());
        assert!(sanitized
            .pointer("/workspaceView/settings/artifactUri")
            .is_none());
        assert!(sanitized
            .pointer("/workspaceView/settings/objectPath")
            .is_none());
        assert!(sanitized
            .pointer("/workspaceView/sections/0/panels/0/title")
            .is_none());
        assert_eq!(
            sanitized
                .pointer("/workspaceView/settings/maxRuns")
                .and_then(Value::as_i64),
            Some(10)
        );

        assert!(sanitize_workspace_view_import_payload(json!({
            "__proto__": { "polluted": true }
        }))
        .is_err());
    }

    #[test]
    fn workspace_view_data_panel_extraction_returns_supported_panel_specs() {
        let payload = json!({
            "workspaceView": {
                "sections": [{
                    "id": "section-a",
                    "name": "Eval",
                    "panels": [
                        { "id": "panel-line", "title": "Reward", "type": "line", "metricKey": "eval/reward" },
                        { "id": "panel-bar", "title": "Loss", "type": "bar", "metricKey": "train/loss" },
                        { "id": "panel-hist", "title": "Loss hist", "type": "histogram", "metricKey": "train/loss" },
                        { "id": "panel-legacy-hist", "title": "Loss legacy hist", "type": "value_histogram", "metricKey": "train/loss" },
                        {
                            "id": "panel-scatter",
                            "title": "Reward tradeoff",
                            "type": "scatter",
                            "metricKey": "eval/reward",
                            "xField": "run:duration_seconds",
                            "yField": "metric:eval%2Freward:best"
                        },
                        {
                            "id": "panel-dist",
                            "title": "Reward distribution",
                            "type": "distribution",
                            "metricKey": "eval/reward",
                            "valueField": "metric:eval%2Freward:best",
                            "groupField": "run:status",
                            "replicateField": "config:%2Fseed"
                        }
                    ]
                }]
            }
        });
        let (panels, warnings) = workspace_view_data_panels(&payload, 10).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(panels.len(), 6);
        assert_eq!(panels[0].section_name, "Eval");
        assert_eq!(panels[0].metric_key, "eval/reward");
        assert_eq!(panels[1].panel_type, "bar");
        assert!(workspace_view_summary_panel_type("histogram"));
        assert!(workspace_view_summary_panel_type("value_histogram"));
        assert!(workspace_view_summary_panel_type("scatter"));
        assert_eq!(panels[2].panel_type, "histogram");
        assert_eq!(panels[4].x_field.as_deref(), Some("run:duration_seconds"));
        assert_eq!(
            panels[4].y_field.as_deref(),
            Some("metric:eval%2Freward:best")
        );
        assert_eq!(
            panels[5].value_field.as_deref(),
            Some("metric:eval%2Freward:best")
        );
        assert_eq!(panels[5].group_field.as_deref(), Some("run:status"));
        assert_eq!(panels[5].replicate_field.as_deref(), Some("config:%2Fseed"));
    }

    #[test]
    fn workspace_view_data_rejects_empty_runs_and_caps_total_points() {
        assert!(dedupe_workspace_view_data_run_ids(Vec::new()).is_err());
        let mut warnings = Vec::new();
        let effective = workspace_view_data_effective_point_limit(500, 100, 50, &mut warnings);
        assert_eq!(effective, 10);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("under 50000 total metric points")));
    }

    #[test]
    fn workspace_view_data_payload_validates_and_sanitizes_export_envelope() {
        let payload = json!({
            "metricKey": "eval/reward",
            "workspaceView": {
                "settings": { "sessionToken": "drop-me", "maxRuns": 5 }
            }
        });
        let payload_sha256 = json_sha256(&payload).unwrap();
        let envelope = json!({
            "kind": WORKSPACE_VIEW_EXPORT_KIND,
            "schema_version": WORKSPACE_VIEW_SCHEMA_VERSION,
            "exported_at": Utc::now(),
            "source": { "product": "instantml", "format": "workspace_view" },
            "view": { "name": "Daily", "project": "demo", "payload": payload },
            "integrity": { "payload_sha256": payload_sha256 }
        });
        let (sanitized, warnings) = workspace_view_data_payload(&envelope).unwrap();
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("sessionToken")));
        assert!(sanitized
            .pointer("/workspaceView/settings/sessionToken")
            .is_none());
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

    #[test]
    fn workspace_view_create_capacity_caps_live_user_and_org_rows() {
        let now = Utc::now();
        let org_id = Uuid::from_u128(20);
        let owner_user_id = Some(Uuid::from_u128(21));
        let mut data = StoreData::default();
        for index in 0..MAX_LIVE_WORKSPACE_VIEWS_PER_USER {
            data.insert_workspace_view(WorkspaceViewRow {
                schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
                id: Uuid::from_u128(1_000 + index as u128),
                org_id,
                owner_user_id,
                name: format!("view-{index}"),
                project: None,
                payload: json!({ "metricKey": "eval/reward" }),
                created_at: now,
                updated_at: now,
                deleted_at: None,
            });
        }
        assert!(ensure_workspace_view_create_capacity(&data, org_id, owner_user_id).is_err());
        let first_id = Uuid::from_u128(1_000);
        let first = data.workspace_views.get_mut(&first_id).unwrap();
        first.deleted_at = Some(now);
        assert!(ensure_workspace_view_create_capacity(&data, org_id, owner_user_id).is_ok());

        let mut org_data = StoreData::default();
        for index in 0..MAX_LIVE_WORKSPACE_VIEWS_PER_ORG {
            org_data.insert_workspace_view(WorkspaceViewRow {
                schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
                id: Uuid::from_u128(10_000 + index as u128),
                org_id,
                owner_user_id: Some(Uuid::from_u128(30_000 + index as u128)),
                name: format!("org-view-{index}"),
                project: None,
                payload: json!({ "metricKey": "eval/reward" }),
                created_at: now,
                updated_at: now,
                deleted_at: None,
            });
        }
        assert!(ensure_workspace_view_create_capacity(
            &org_data,
            org_id,
            Some(Uuid::from_u128(99_999))
        )
        .is_err());
    }

    #[test]
    fn workspace_view_data_run_lookup_hides_inaccessible_runs() {
        let org_id = Uuid::from_u128(30);
        let project_id = Uuid::from_u128(31);
        let other_project_id = Uuid::from_u128(32);
        let other_org_id = Uuid::from_u128(33);
        let visible_run_id = Uuid::from_u128(34);
        let other_project_run_id = Uuid::from_u128(35);
        let other_org_run_id = Uuid::from_u128(36);
        let mut data = StoreData::default();
        data.insert_run(test_run(visible_run_id, org_id, project_id, "visible"));
        data.insert_run(test_run(
            other_project_run_id,
            org_id,
            other_project_id,
            "other-project",
        ));
        data.insert_run(test_run(
            other_org_run_id,
            other_org_id,
            project_id,
            "other-org",
        ));
        let ctx = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(40),
                service_account_id: Uuid::from_u128(41),
                project_id: Some(project_id),
                scopes: vec!["export:read".to_string()],
            }),
            session: None,
        };

        assert!(workspace_view_data_run_for_ctx(&data, &ctx, visible_run_id).is_ok());
        for run_id in [other_project_run_id, other_org_run_id, Uuid::from_u128(37)] {
            let error = workspace_view_data_run_for_ctx(&data, &ctx, run_id).unwrap_err();
            assert_eq!(error.status(), axum::http::StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn import_workspace_view_creates_sanitized_live_row() {
        let store = store_with_data(StoreData::default());
        let ctx = RequestContext::local();
        let source_row = WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: Uuid::from_u128(11),
            org_id: ctx.org_id,
            owner_user_id: None,
            name: "Imported".to_string(),
            project: Some("demo".to_string()),
            payload: json!({
                "metricKey": "eval/reward",
                "workspaceView": {
                    "settings": { "sessionToken": "drop-me", "maxRuns": 5 },
                    "sections": [{ "panels": [{ "metricKey": "eval/reward" }] }]
                }
            }),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            deleted_at: None,
        };
        let envelope = WorkspaceViewExportEnvelope {
            kind: WORKSPACE_VIEW_EXPORT_KIND.to_string(),
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            exported_at: Utc::now(),
            source: WorkspaceViewExportSource {
                product: "instantml".to_string(),
                format: "workspace_view".to_string(),
            },
            view: WorkspaceViewExportedView {
                name: source_row.name.clone(),
                project: source_row.project.clone(),
                payload: source_row.payload.clone(),
            },
            integrity: WorkspaceViewExportIntegrity {
                payload_sha256: json_sha256(&source_row.payload).unwrap(),
            },
        };

        let response = import_workspace_view(
            &store,
            &ctx,
            ImportWorkspaceViewRequest {
                exported_view: envelope,
                dry_run: false,
                conflict_strategy: Some("create".to_string()),
                existing_view_id: None,
                expected_updated_at: None,
                name: None,
                project: None,
            },
        )
        .await
        .unwrap();

        let imported = response.workspace_view.unwrap();
        assert_eq!(imported.name, "Imported");
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.contains("sessionToken")));
        assert!(imported
            .payload
            .pointer("/workspaceView/settings/sessionToken")
            .is_none());
        let data = store.data.lock().await;
        assert!(data.workspace_views.contains_key(&imported.id));
    }

    #[tokio::test]
    async fn import_workspace_view_dry_run_replace_validates_target() {
        let now = Utc::now();
        let view_id = Uuid::from_u128(102);
        let mut data = StoreData::default();
        data.insert_workspace_view(WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: view_id,
            org_id: LOCAL_ORG_ID,
            owner_user_id: None,
            name: "Replace me".to_string(),
            project: None,
            payload: json!({ "metricKey": "eval/reward" }),
            created_at: now,
            updated_at: now,
            deleted_at: None,
        });
        let store = store_with_data(data);
        let ctx = RequestContext::local();
        let payload = json!({ "metricKey": "train/loss" });
        let envelope = WorkspaceViewExportEnvelope {
            kind: WORKSPACE_VIEW_EXPORT_KIND.to_string(),
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            exported_at: Utc::now(),
            source: WorkspaceViewExportSource {
                product: "instantml".to_string(),
                format: "workspace_view".to_string(),
            },
            view: WorkspaceViewExportedView {
                name: "Replacement".to_string(),
                project: None,
                payload: payload.clone(),
            },
            integrity: WorkspaceViewExportIntegrity {
                payload_sha256: json_sha256(&payload).unwrap(),
            },
        };

        let missing_target = import_workspace_view(
            &store,
            &ctx,
            ImportWorkspaceViewRequest {
                exported_view: envelope.clone(),
                dry_run: true,
                conflict_strategy: Some("replace".to_string()),
                existing_view_id: None,
                expected_updated_at: Some(now),
                name: None,
                project: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing_target.status(), axum::http::StatusCode::BAD_REQUEST);

        let stale = import_workspace_view(
            &store,
            &ctx,
            ImportWorkspaceViewRequest {
                exported_view: envelope,
                dry_run: true,
                conflict_strategy: Some("replace".to_string()),
                existing_view_id: Some(view_id),
                expected_updated_at: Some(now + ChronoDuration::seconds(1)),
                name: None,
                project: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(stale.status(), axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn delete_workspace_view_requires_matching_updated_at() {
        let now = Utc::now();
        let view_id = Uuid::from_u128(12);
        let mut data = StoreData::default();
        data.insert_workspace_view(WorkspaceViewRow {
            schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
            id: view_id,
            org_id: LOCAL_ORG_ID,
            owner_user_id: None,
            name: "Delete me".to_string(),
            project: None,
            payload: json!({ "metricKey": "eval/reward" }),
            created_at: now,
            updated_at: now,
            deleted_at: None,
        });
        let store = store_with_data(data);
        let ctx = RequestContext::local();

        let conflict =
            delete_workspace_view(&store, &ctx, view_id, now + ChronoDuration::seconds(1))
                .await
                .unwrap_err();
        assert_eq!(conflict.status(), axum::http::StatusCode::CONFLICT);

        let deleted = delete_workspace_view(&store, &ctx, view_id, now)
            .await
            .unwrap();
        assert!(deleted.deleted);
        let data = store.data.lock().await;
        assert!(data
            .workspace_views
            .get(&view_id)
            .and_then(|view| view.deleted_at)
            .is_some());
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
