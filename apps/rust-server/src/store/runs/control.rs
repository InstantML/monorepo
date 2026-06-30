use std::{collections::HashSet, time::Duration as StdDuration};

use axum::http::StatusCode;

use super::*;

pub async fn request_run_stop(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: StopRunRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    if let Some(key) = idempotency_key {
        let request_hash = hash_idempotency(run_id, &raw)?;
        if let Some(existing) =
            live_stop_idempotency_response(store, ctx, &key, &request_hash).await?
        {
            return Ok(existing);
        }
        if let Err(error) = store.reserve_idempotency_key(ctx.org_id, &key).await {
            if let Some(existing) =
                wait_for_stop_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            return Err(error);
        }
        let result = async {
            if let Some(existing) =
                live_stop_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            let response = request_run_stop_once(store, ctx, run_id, input).await?;
            persist_stop_idempotency_response(
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
    request_run_stop_once(store, ctx, run_id, input).await
}

async fn request_run_stop_once(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: StopRunRequest,
) -> AppResult<Value> {
    let reason = validate_stop_reason(input.reason.as_deref())?;
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    if run_lifecycle_state(&data, &run) != "active" {
        return Err(AppError::with_code(
            StatusCode::CONFLICT,
            "run_lifecycle_conflict",
            "run lifecycle state does not allow stop control",
        ));
    }
    let plan = prepare_stop_locked(&data, ctx, &run, reason);
    if plan.persist {
        store
            .persist_locked(
                "run_control",
                ctx.org_id,
                &run.id.to_string(),
                &plan.control,
            )
            .await?;
        data.insert_run_control(plan.control.clone());
    }
    Ok(json!({
        "run_id": plan.run.id,
        "ok": true,
        "already_requested": plan.already_requested,
        "already_terminal": plan.already_terminal,
        "run_control": run_control_summary(&plan.run, Some(&plan.control), RunControlPrivacy::Private),
    }))
}

pub async fn request_bulk_run_stop(
    store: &Store,
    ctx: &RequestContext,
    raw: Value,
    input: StopRunsRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    if let Some(key) = idempotency_key {
        let request_hash = hash_idempotency(Uuid::nil(), &raw)?;
        if let Some(existing) =
            live_stop_idempotency_response(store, ctx, &key, &request_hash).await?
        {
            return Ok(existing);
        }
        if let Err(error) = store.reserve_idempotency_key(ctx.org_id, &key).await {
            if let Some(existing) =
                wait_for_stop_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            return Err(error);
        }
        let result = async {
            if let Some(existing) =
                live_stop_idempotency_response(store, ctx, &key, &request_hash).await?
            {
                return Ok(existing);
            }
            let response = request_bulk_run_stop_once(store, ctx, input).await?;
            persist_stop_idempotency_response(
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
    request_bulk_run_stop_once(store, ctx, input).await
}

async fn request_bulk_run_stop_once(
    store: &Store,
    ctx: &RequestContext,
    input: StopRunsRequest,
) -> AppResult<Value> {
    if input.run_ids.is_empty() {
        return Err(AppError::validation(
            "run_ids must include at least one run",
        ));
    }
    if input.run_ids.len() > MAX_BULK_STOP_RUNS {
        return Err(AppError::validation(format!(
            "bulk stop supports at most {MAX_BULK_STOP_RUNS} run_ids"
        )));
    }
    let reason = validate_stop_reason(input.reason.as_deref())?;
    let mut data = store.data.lock().await;
    let mut seen = HashSet::new();
    let run_ids: Vec<Uuid> = input
        .run_ids
        .into_iter()
        .filter(|run_id| seen.insert(*run_id))
        .collect();
    let mut results = Vec::with_capacity(run_ids.len());
    let mut controls_to_persist = Vec::new();
    for run_id in run_ids {
        match fetch_run_in_data(&data, ctx, run_id) {
            Ok(run) => {
                if run_lifecycle_state(&data, &run) != "active" {
                    results.push(json!({
                        "run_id": run_id,
                        "ok": false,
                        "error": "run_lifecycle_conflict",
                    }));
                    continue;
                }
                let plan = prepare_stop_locked(&data, ctx, &run, reason.clone());
                if plan.persist {
                    controls_to_persist.push(plan.control.clone());
                }
                results.push(json!({
                    "run_id": plan.run.id,
                    "ok": true,
                    "already_requested": plan.already_requested,
                    "already_terminal": plan.already_terminal,
                    "run_control": run_control_summary(&plan.run, Some(&plan.control), RunControlPrivacy::Private),
                }));
            }
            Err(error) => results.push(json!({
                "run_id": run_id,
                "ok": false,
                "error": if matches!(error.status(), StatusCode::NOT_FOUND | StatusCode::FORBIDDEN) {
                    "not_found_or_unauthorized"
                } else {
                    error.message()
                },
            })),
        }
    }
    store
        .persist_run_controls_locked(ctx.org_id, &controls_to_persist)
        .await?;
    for control in controls_to_persist {
        data.insert_run_control(control);
    }
    Ok(json!({
        "results": results,
        "limit": MAX_BULK_STOP_RUNS,
    }))
}

async fn live_idempotency_response(
    store: &Store,
    org_id: Uuid,
    key: &str,
    request_hash: &[u8],
) -> AppResult<Option<Value>> {
    let data = store.data.lock().await;
    let Some(existing) = data
        .idempotency
        .get(&(org_id, key.to_string()))
        .filter(|record| record.expires_at > Utc::now())
    else {
        return Ok(None);
    };
    if existing.request_hash.as_slice() == request_hash {
        return Ok(Some(existing.response_json.clone()));
    }
    Err(AppError::conflict(
        "idempotency key was already used with a different request body",
    ))
}

async fn live_stop_idempotency_response(
    store: &Store,
    ctx: &RequestContext,
    key: &str,
    request_hash: &[u8],
) -> AppResult<Option<Value>> {
    let Some(existing) = live_idempotency_response(store, ctx.org_id, key, request_hash).await?
    else {
        return Ok(None);
    };
    validate_cached_stop_response_access(store, ctx, &existing).await?;
    Ok(Some(existing))
}

async fn wait_for_stop_idempotency_response(
    store: &Store,
    ctx: &RequestContext,
    key: &str,
    request_hash: &[u8],
) -> AppResult<Option<Value>> {
    for _ in 0..20 {
        tokio::time::sleep(StdDuration::from_millis(25)).await;
        if let Some(existing) =
            live_stop_idempotency_response(store, ctx, key, request_hash).await?
        {
            return Ok(Some(existing));
        }
    }
    Ok(None)
}

async fn validate_cached_stop_response_access(
    store: &Store,
    ctx: &RequestContext,
    response: &Value,
) -> AppResult<()> {
    let data = store.data.lock().await;
    if let Some(results) = response.get("results").and_then(Value::as_array) {
        for result in results {
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                fetch_run_in_data(&data, ctx, cached_stop_run_id(result)?)?;
            }
        }
        return Ok(());
    }
    fetch_run_in_data(&data, ctx, cached_stop_run_id(response)?)?;
    Ok(())
}

fn cached_stop_run_id(value: &Value) -> AppResult<Uuid> {
    let run_id = value
        .get("run_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("cached stop response missing run_id"))?;
    Uuid::parse_str(run_id)
        .map_err(|_| AppError::internal("cached stop response has invalid run_id"))
}

async fn persist_stop_idempotency_response(
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

pub async fn run_stop_signal(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    let control = run_control_for(&data, &run);
    let active = run.status == "running"
        && control
            .map(|item| matches!(item.stop_state.as_str(), "requested" | "acknowledged"))
            .unwrap_or(false);
    let poll_after_seconds = stop_poll_after_seconds(&data, ctx.org_id);
    Ok(json!({
        "run_id": run.id,
        "run_status": run.status,
        "terminal": matches!(run.status.as_str(), "finished" | "failed"),
        "stop_requested": active,
        "poll_after_seconds": poll_after_seconds,
        "stop_request": control.filter(|_| active).map(|item| json!({
            "stop_request_id": item.stop_request_id,
            "requested_at": item.requested_at.clone(),
            "acknowledged_at": item.acknowledged_at.clone(),
        })),
    }))
}

fn stop_poll_after_seconds(data: &StoreData, org_id: Uuid) -> i64 {
    match data
        .organizations
        .get(&org_id)
        .map(|org| org.plan_tier.as_str())
    {
        Some("premium") => 10,
        Some("pro") => 15,
        _ => 30,
    }
}

pub async fn acknowledge_run_stop(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: StopAckRequest,
) -> AppResult<Value> {
    let message = validate_stop_reason(input.message.as_deref())?;
    let mut data = store.data.lock().await;
    let mut run = fetch_run_in_data(&data, ctx, run_id)?;
    let mut control = data
        .run_controls
        .get(&run_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("stop request not found"))?;
    if control.stop_request_id != Some(input.stop_request_id) {
        return Err(AppError::conflict(
            "stop request id does not match active request",
        ));
    }
    let now = Utc::now();
    let mut control_changed = false;
    let mut run_changed = false;
    match input.state.as_str() {
        "acknowledged" => {
            if control.stop_state != "completed" && control.acknowledged_at.is_none() {
                control.acknowledged_at = Some(now);
                control_changed = true;
            }
            if control.stop_state == "requested" {
                control.stop_state = "acknowledged".to_string();
                control_changed = true;
            }
        }
        "completed" => {
            if control.acknowledged_at.is_none() {
                control.acknowledged_at = Some(now);
                control_changed = true;
            }
            if control.completed_at.is_none() {
                control.completed_at = Some(now);
                control_changed = true;
            }
            if control.completion_message.is_none() && message.is_some() {
                control.completion_message = message;
                control_changed = true;
            }
            if control.stop_state != "completed" {
                control.stop_state = "completed".to_string();
                control_changed = true;
            }
            if run.status == "running" {
                run.status = "failed".to_string();
                if run.finished_at.is_none() {
                    run.finished_at = control.completed_at;
                }
                run_changed = true;
            }
        }
        _ => {
            return Err(AppError::validation(
                "state must be acknowledged or completed",
            ));
        }
    }
    if run_changed {
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        data.insert_run(run.clone());
    }
    if control_changed {
        control.updated_at = now;
        store
            .persist_locked("run_control", ctx.org_id, &run.id.to_string(), &control)
            .await?;
        data.insert_run_control(control.clone());
    }
    Ok(json!({
        "run_id": run.id,
        "run_control": run_control_summary(&run, Some(&control), RunControlPrivacy::Private),
    }))
}

struct StopRequestPlan {
    run: RunRow,
    control: RunControlRow,
    persist: bool,
    already_requested: bool,
    already_terminal: bool,
}

fn prepare_stop_locked(
    data: &StoreData,
    ctx: &RequestContext,
    run: &RunRow,
    reason: Option<String>,
) -> StopRequestPlan {
    if run.status != "running" {
        return StopRequestPlan {
            run: run.clone(),
            control: data
                .run_controls
                .get(&run.id)
                .cloned()
                .unwrap_or_else(|| inactive_control(run)),
            persist: false,
            already_requested: false,
            already_terminal: true,
        };
    }
    if let Some(existing) = data.run_controls.get(&run.id) {
        if matches!(existing.stop_state.as_str(), "requested" | "acknowledged") {
            return StopRequestPlan {
                run: run.clone(),
                control: existing.clone(),
                persist: false,
                already_requested: true,
                already_terminal: false,
            };
        }
    }
    let now = Utc::now();
    let control = RunControlRow {
        org_id: run.org_id,
        run_id: run.id,
        stop_request_id: Some(Uuid::new_v4()),
        stop_state: "requested".to_string(),
        reason,
        completion_message: None,
        actor: Some(stop_actor(ctx)),
        requested_at: Some(now),
        acknowledged_at: None,
        completed_at: None,
        updated_at: now,
    };
    StopRequestPlan {
        run: run.clone(),
        control,
        persist: true,
        already_requested: false,
        already_terminal: false,
    }
}

fn inactive_control(run: &RunRow) -> RunControlRow {
    RunControlRow {
        org_id: run.org_id,
        run_id: run.id,
        stop_request_id: None,
        stop_state: "none".to_string(),
        reason: None,
        completion_message: None,
        actor: None,
        requested_at: None,
        acknowledged_at: None,
        completed_at: None,
        updated_at: run.created_at,
    }
}

fn stop_actor(ctx: &RequestContext) -> String {
    if let Some(session) = &ctx.session {
        return format!("user:{}", session.user_id);
    }
    if let Some(auth) = &ctx.auth {
        return format!("api_key:{}", auth.api_key_id);
    }
    "local".to_string()
}

fn validate_stop_reason(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    validate_optional_name(Some(value), "stop reason")
}
