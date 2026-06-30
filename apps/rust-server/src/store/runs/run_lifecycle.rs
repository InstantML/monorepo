use std::{collections::HashSet, time::Duration as StdDuration};

use axum::http::StatusCode;

use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunLifecycleAction {
    Archive,
    Restore,
    Delete,
}

impl RunLifecycleAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Archive => "archive",
            Self::Restore => "restore",
            Self::Delete => "delete",
        }
    }

    fn target_state(self) -> &'static str {
        match self {
            Self::Archive => "archived",
            Self::Restore => "active",
            Self::Delete => "deleted",
        }
    }
}

#[derive(Debug)]
struct LifecycleChange {
    run: RunRow,
    status: &'static str,
}

#[derive(Debug)]
struct LifecycleCommand {
    raw: Value,
    action: RunLifecycleAction,
    reason: Option<String>,
    confirm: Option<String>,
    idempotency_key: Option<String>,
}

pub async fn archive_run(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: RunLifecycleRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    run_lifecycle_request(
        store,
        ctx,
        run_id,
        LifecycleCommand {
            raw,
            action: RunLifecycleAction::Archive,
            reason: input.reason,
            confirm: None,
            idempotency_key,
        },
    )
    .await
}

pub async fn restore_run(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: RunLifecycleRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    run_lifecycle_request(
        store,
        ctx,
        run_id,
        LifecycleCommand {
            raw,
            action: RunLifecycleAction::Restore,
            reason: input.reason,
            confirm: None,
            idempotency_key,
        },
    )
    .await
}

pub async fn delete_run(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: DeleteRunRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    run_lifecycle_request(
        store,
        ctx,
        run_id,
        LifecycleCommand {
            raw,
            action: RunLifecycleAction::Delete,
            reason: input.reason,
            confirm: input.confirm,
            idempotency_key,
        },
    )
    .await
}

async fn run_lifecycle_request(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    command: LifecycleCommand,
) -> AppResult<Value> {
    let LifecycleCommand {
        raw,
        action,
        reason,
        confirm,
        idempotency_key,
    } = command;
    if let Some(key) = idempotency_key {
        let request_hash = lifecycle_request_hash(run_id, action, &raw)?;
        if let Some(existing) =
            live_lifecycle_idempotency_response(store, ctx, &key, &request_hash).await?
        {
            return Ok(existing);
        }
        if let Err(error) = store.reserve_idempotency_key(ctx.org_id, &key).await {
            if let Some(existing) =
                wait_for_lifecycle_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            return Err(error);
        }
        let result = async {
            if let Some(existing) =
                live_lifecycle_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            let response = run_lifecycle_request_once(
                store,
                ctx,
                run_id,
                action,
                reason,
                confirm,
                Some(key.clone()),
            )
            .await?;
            persist_lifecycle_idempotency_response(
                store,
                ctx.org_id,
                key.clone(),
                request_hash,
                response.clone(),
            )
            .await?;
            Ok(response)
        }
        .await;
        store.release_idempotency_key(ctx.org_id, &key).await;
        return result;
    }
    run_lifecycle_request_once(store, ctx, run_id, action, reason, confirm, None).await
}

async fn run_lifecycle_request_once(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    action: RunLifecycleAction,
    reason: Option<String>,
    confirm: Option<String>,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    validate_lifecycle_confirmation(action, confirm.as_deref())?;
    let reason = validate_lifecycle_reason(reason.as_deref())?;
    let change =
        apply_lifecycle_change(store, ctx, run_id, action, reason, idempotency_key).await?;
    lifecycle_response_for_change(store, ctx, action, change).await
}

pub async fn batch_run_lifecycle(
    store: &Store,
    ctx: &RequestContext,
    raw: Value,
    input: BatchRunLifecycleRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    if let Some(key) = idempotency_key {
        let request_hash = hash_idempotency(Uuid::nil(), &raw)?;
        if let Some(existing) =
            live_lifecycle_idempotency_response(store, ctx, &key, &request_hash).await?
        {
            return Ok(existing);
        }
        if let Err(error) = store.reserve_idempotency_key(ctx.org_id, &key).await {
            if let Some(existing) =
                wait_for_lifecycle_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            return Err(error);
        }
        let result = async {
            if let Some(existing) =
                live_lifecycle_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            let response = batch_run_lifecycle_once(store, ctx, input, Some(key.clone())).await?;
            persist_lifecycle_idempotency_response(
                store,
                ctx.org_id,
                key.clone(),
                request_hash,
                response.clone(),
            )
            .await?;
            Ok(response)
        }
        .await;
        store.release_idempotency_key(ctx.org_id, &key).await;
        return result;
    }
    batch_run_lifecycle_once(store, ctx, input, None).await
}

fn lifecycle_request_hash(
    run_id: Uuid,
    action: RunLifecycleAction,
    raw: &Value,
) -> AppResult<Vec<u8>> {
    hash_idempotency(run_id, &json!({ "action": action.as_str(), "body": raw }))
}

async fn batch_run_lifecycle_once(
    store: &Store,
    ctx: &RequestContext,
    input: BatchRunLifecycleRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    let action = parse_batch_lifecycle_action(&input.action)?;
    if input.run_ids.is_empty() {
        return Err(AppError::validation(
            "run_ids must include at least one run",
        ));
    }
    if input.run_ids.len() > MAX_BATCH_RUN_LIFECYCLE {
        return Err(AppError::validation(format!(
            "batch lifecycle supports at most {MAX_BATCH_RUN_LIFECYCLE} run_ids"
        )));
    }
    validate_lifecycle_confirmation(action, input.confirm.as_deref())?;
    let reason = validate_lifecycle_reason(input.reason.as_deref())?;
    let mut seen = HashSet::new();
    let run_ids = input
        .run_ids
        .into_iter()
        .filter(|run_id| seen.insert(*run_id))
        .collect::<Vec<_>>();
    let mut results = Vec::with_capacity(run_ids.len());
    for run_id in run_ids {
        match apply_lifecycle_change(
            store,
            ctx,
            run_id,
            action,
            reason.clone(),
            idempotency_key.clone(),
        )
        .await
        {
            Ok(change) => {
                let response = lifecycle_response_for_change(store, ctx, action, change).await?;
                let run = response.get("run").cloned().unwrap_or(Value::Null);
                let status = response
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("updated");
                results.push(json!({
                    "run_id": run_id,
                    "status": status,
                    "run": run,
                }));
            }
            Err(error) => results.push(json!({
                "run_id": run_id,
                "status": "error",
                "code": error.safe_code(),
                "error": error.message(),
            })),
        }
    }
    let updated = results
        .iter()
        .filter(|result| result.get("status").and_then(Value::as_str) == Some("updated"))
        .count();
    let failed = results
        .iter()
        .filter(|result| result.get("status").and_then(Value::as_str) == Some("error"))
        .count();
    Ok(json!({
        "action": action.as_str(),
        "results": results,
        "updated": updated,
        "failed": failed,
    }))
}

async fn lifecycle_response_for_change(
    store: &Store,
    ctx: &RequestContext,
    action: RunLifecycleAction,
    change: LifecycleChange,
) -> AppResult<Value> {
    let privacy = if can_read_private_run_control(ctx) {
        RunControlPrivacy::Private
    } else {
        RunControlPrivacy::Public
    };
    let run = run_summary_value(store, change.run, privacy).await?;
    Ok(json!({
        "action": action.as_str(),
        "run_id": run.get("id").cloned().unwrap_or(Value::Null),
        "status": change.status,
        "run": run,
    }))
}

async fn apply_lifecycle_change(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    action: RunLifecycleAction,
    reason: Option<String>,
    idempotency_key: Option<String>,
) -> AppResult<LifecycleChange> {
    let mut data = store.data.lock().await;
    let run = fetch_lifecycle_run_in_data(&data, ctx, run_id)?;
    let current = run_lifecycle_state(&data, &run);
    let target = action.target_state();
    if current == target {
        return Ok(LifecycleChange {
            run,
            status: "unchanged",
        });
    }
    if current == "deleted" && action != RunLifecycleAction::Delete {
        return Err(AppError::with_code(
            StatusCode::CONFLICT,
            "run_lifecycle_conflict",
            "deleted runs cannot be restored or archived",
        ));
    }
    let now = Utc::now();
    let record = RunLifecycleRow {
        kind: "run_lifecycle".to_string(),
        id: Uuid::new_v4(),
        org_id: run.org_id,
        run_id: run.id,
        state: target.to_string(),
        reason,
        actor_id: lifecycle_actor_id(ctx),
        actor_type: lifecycle_actor_type(ctx).to_string(),
        idempotency_key,
        created_at: now,
    };
    store
        .persist_locked("run_lifecycle", ctx.org_id, &record.id.to_string(), &record)
        .await?;
    data.insert_run_lifecycle(record);
    Ok(LifecycleChange {
        run,
        status: "updated",
    })
}

fn fetch_lifecycle_run_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<RunRow> {
    let run = data
        .runs
        .get(&run_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("run not found"))?;
    if !is_retained_run(data, &run) {
        return Err(AppError::not_found("run not found"));
    }
    ensure_run_access_in_data(ctx, &run)?;
    Ok(run)
}

fn parse_batch_lifecycle_action(action: &str) -> AppResult<RunLifecycleAction> {
    match action.trim() {
        "archive" => Ok(RunLifecycleAction::Archive),
        "restore" => Ok(RunLifecycleAction::Restore),
        "delete" => Ok(RunLifecycleAction::Delete),
        _ => Err(AppError::with_code(
            StatusCode::BAD_REQUEST,
            "run_lifecycle_invalid",
            "action must be archive, restore, or delete",
        )),
    }
}

fn validate_lifecycle_confirmation(
    action: RunLifecycleAction,
    confirm: Option<&str>,
) -> AppResult<()> {
    if action != RunLifecycleAction::Delete {
        return Ok(());
    }
    match confirm.map(str::trim) {
        Some("delete") => Ok(()),
        _ => Err(AppError::with_code(
            StatusCode::BAD_REQUEST,
            "run_lifecycle_invalid",
            "delete requires confirm=delete",
        )),
    }
}

fn validate_lifecycle_reason(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    validate_optional_name(Some(value), "lifecycle reason")
}

fn lifecycle_actor_type(ctx: &RequestContext) -> &'static str {
    if ctx.session.is_some() {
        "session"
    } else if ctx.auth.is_some() {
        "api_key"
    } else {
        "local"
    }
}

fn lifecycle_actor_id(ctx: &RequestContext) -> Option<String> {
    if let Some(session) = &ctx.session {
        Some(session.user_id.to_string())
    } else {
        ctx.auth.as_ref().map(|auth| auth.api_key_id.to_string())
    }
}

async fn live_lifecycle_idempotency_response(
    store: &Store,
    ctx: &RequestContext,
    key: &str,
    request_hash: &[u8],
) -> AppResult<Option<Value>> {
    let data = store.data.lock().await;
    let Some(existing) = data
        .idempotency
        .get(&(ctx.org_id, key.to_string()))
        .filter(|record| record.expires_at > Utc::now())
    else {
        return Ok(None);
    };
    if existing.request_hash.as_slice() != request_hash {
        return Err(AppError::conflict(
            "idempotency key was already used with a different request body",
        ));
    }
    validate_cached_lifecycle_response_access(&data, ctx, &existing.response_json)?;
    Ok(Some(existing.response_json.clone()))
}

async fn wait_for_lifecycle_idempotency_response(
    store: &Store,
    ctx: &RequestContext,
    key: &str,
    request_hash: &[u8],
) -> AppResult<Option<Value>> {
    for _ in 0..20 {
        tokio::time::sleep(StdDuration::from_millis(25)).await;
        if let Some(existing) =
            live_lifecycle_idempotency_response(store, ctx, key, request_hash).await?
        {
            return Ok(Some(existing));
        }
    }
    Ok(None)
}

fn validate_cached_lifecycle_response_access(
    data: &StoreData,
    ctx: &RequestContext,
    response: &Value,
) -> AppResult<()> {
    if let Some(results) = response.get("results").and_then(Value::as_array) {
        for result in results {
            if matches!(
                result.get("status").and_then(Value::as_str),
                Some("updated" | "unchanged")
            ) {
                let run_id = cached_lifecycle_run_id(result)?;
                fetch_lifecycle_run_in_data(data, ctx, run_id)?;
            }
        }
        return Ok(());
    }
    let run_id = cached_lifecycle_run_id(response)?;
    fetch_lifecycle_run_in_data(data, ctx, run_id)?;
    Ok(())
}

fn cached_lifecycle_run_id(value: &Value) -> AppResult<Uuid> {
    let run_id = value
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("cached lifecycle response missing run_id"))?;
    Uuid::parse_str(run_id)
        .map_err(|_| AppError::internal("cached lifecycle response has invalid run_id"))
}

async fn persist_lifecycle_idempotency_response(
    store: &Store,
    org_id: Uuid,
    key: String,
    request_hash: Vec<u8>,
    response: Value,
) -> AppResult<()> {
    let record = IdempotencyRecord {
        org_id,
        key: key.clone(),
        request_hash,
        response_json: response,
        expires_at: Utc::now() + ChronoDuration::days(7),
    };
    store
        .persist_locked("idempotency", org_id, &key, &record)
        .await?;
    store
        .data
        .lock()
        .await
        .idempotency
        .insert((org_id, key), record);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    fn test_store() -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_lifecycle_test",
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
            data: Arc::new(Mutex::new(StoreData::default())),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    fn run(run_id: Uuid) -> RunRow {
        RunRow {
            id: run_id,
            org_id: LOCAL_ORG_ID,
            project_id: Uuid::from_u128(200),
            project: "project".to_string(),
            name: "train".to_string(),
            status: "running".to_string(),
            config: json!({}),
            tags: vec![],
            metadata: json!({}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: None,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        }
    }

    #[test]
    fn lifecycle_idempotency_hash_includes_action() {
        let run_id = Uuid::from_u128(42);
        let body = json!({ "reason": "same body" });
        let archive = lifecycle_request_hash(run_id, RunLifecycleAction::Archive, &body).unwrap();
        let restore = lifecycle_request_hash(run_id, RunLifecycleAction::Restore, &body).unwrap();

        assert_ne!(
            archive, restore,
            "archive and restore must not replay each other's idempotency responses"
        );
    }

    #[tokio::test]
    async fn lifecycle_projection_filters_archive_restore_and_delete() {
        let store = test_store();
        let ctx = RequestContext::local();
        let run_id = Uuid::from_u128(42);
        {
            let mut data = store.data.lock().await;
            data.insert_run(run(run_id));
        }

        let archived = apply_lifecycle_change(
            &store,
            &ctx,
            run_id,
            RunLifecycleAction::Archive,
            Some("bad seed".to_string()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(archived.status, "updated");
        {
            let data = store.data.lock().await;
            let run = data.runs.get(&run_id).unwrap();
            assert_eq!(run_lifecycle_state(&data, run), "archived");
            assert!(!run_matches_lifecycle_filter(&data, &HashMap::new(), run));
            assert!(run_matches_lifecycle_filter(
                &data,
                &HashMap::from([("lifecycle".to_string(), "archived".to_string())]),
                run
            ));
            assert!(fetch_run_in_data(&data, &ctx, run_id).is_ok());
        }

        let unchanged = apply_lifecycle_change(
            &store,
            &ctx,
            run_id,
            RunLifecycleAction::Archive,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(unchanged.status, "unchanged");

        apply_lifecycle_change(
            &store,
            &ctx,
            run_id,
            RunLifecycleAction::Restore,
            None,
            None,
        )
        .await
        .unwrap();
        {
            let data = store.data.lock().await;
            let run = data.runs.get(&run_id).unwrap();
            assert_eq!(run_lifecycle_state(&data, run), "active");
            assert!(run_matches_lifecycle_filter(&data, &HashMap::new(), run));
        }

        apply_lifecycle_change(&store, &ctx, run_id, RunLifecycleAction::Delete, None, None)
            .await
            .unwrap();
        {
            let data = store.data.lock().await;
            let run = data.runs.get(&run_id).unwrap();
            assert_eq!(run_lifecycle_state(&data, run), "deleted");
            assert!(!run_matches_lifecycle_filter(
                &data,
                &HashMap::from([("lifecycle".to_string(), "all".to_string())]),
                run
            ));
            assert!(fetch_run_in_data(&data, &ctx, run_id).is_err());
        }

        let deleted_again =
            apply_lifecycle_change(&store, &ctx, run_id, RunLifecycleAction::Delete, None, None)
                .await
                .unwrap();
        assert_eq!(deleted_again.status, "unchanged");

        let restore_deleted = apply_lifecycle_change(
            &store,
            &ctx,
            run_id,
            RunLifecycleAction::Restore,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(restore_deleted.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn delete_requires_confirmation() {
        assert!(validate_lifecycle_confirmation(RunLifecycleAction::Archive, None).is_ok());
        assert!(
            validate_lifecycle_confirmation(RunLifecycleAction::Delete, Some("delete")).is_ok()
        );
        let err = validate_lifecycle_confirmation(RunLifecycleAction::Delete, Some("archive"))
            .unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }
}
