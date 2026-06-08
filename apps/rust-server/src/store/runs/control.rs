use std::collections::HashSet;

use axum::http::StatusCode;

use super::*;

pub async fn request_run_stop(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: StopRunRequest,
) -> AppResult<Value> {
    ensure_billing_write_allowed(store, ctx.org_id, "request a run stop").await?;
    let reason = validate_stop_reason(input.reason.as_deref())?;
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
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
        "run_control": run_control_summary(&plan.run, Some(&plan.control)),
    }))
}

pub async fn request_bulk_run_stop(
    store: &Store,
    ctx: &RequestContext,
    input: StopRunsRequest,
) -> AppResult<Value> {
    ensure_billing_write_allowed(store, ctx.org_id, "request run stops").await?;
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
                let plan = prepare_stop_locked(&data, ctx, &run, reason.clone());
                if plan.persist {
                    controls_to_persist.push(plan.control.clone());
                }
                results.push(json!({
                    "run_id": plan.run.id,
                    "ok": true,
                    "run_control": run_control_summary(&plan.run, Some(&plan.control)),
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

pub async fn run_stop_signal(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    let control = run_control_for(&data, &run);
    let active = control
        .map(|item| matches!(item.stop_state.as_str(), "requested" | "acknowledged"))
        .unwrap_or(false);
    Ok(json!({
        "run_id": run.id,
        "run_status": run.status,
        "terminal": matches!(run.status.as_str(), "finished" | "failed"),
        "stop_requested": active,
        "poll_after_seconds": 10,
        "stop_request": control.filter(|_| active).map(|item| json!({
            "stop_request_id": item.stop_request_id,
            "requested_at": item.requested_at.clone(),
            "acknowledged_at": item.acknowledged_at.clone(),
        })),
    }))
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
        "run_control": run_control_summary(&run, Some(&control)),
    }))
}

struct StopRequestPlan {
    run: RunRow,
    control: RunControlRow,
    persist: bool,
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
        };
    }
    if let Some(existing) = data.run_controls.get(&run.id) {
        if matches!(existing.stop_state.as_str(), "requested" | "acknowledged") {
            return StopRequestPlan {
                run: run.clone(),
                control: existing.clone(),
                persist: false,
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
