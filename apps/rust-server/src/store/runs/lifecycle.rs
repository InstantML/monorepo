use super::*;

pub async fn create_run(
    store: &Store,
    ctx: &RequestContext,
    input: CreateRunRequest,
) -> AppResult<CreateRunResult> {
    let requested_id = input.id;
    let resume = validate_resume_mode(input.resume.as_deref())?;
    let project_name = validate_name(input.project.as_deref(), "project")?;
    let name = validate_name(input.name.as_deref().or(Some("run")), "run name")?;
    let config = validate_json_object(input.config, "config")?;
    let tags = validate_tags(input.tags)?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let project_exists = {
        let data = store.data.lock().await;
        match data
            .projects_by_org_name
            .get(&(ctx.org_id, project_name.clone()))
            .copied()
        {
            Some(project_id) => {
                if let Some(auth) = &ctx.auth {
                    if auth.project_id.is_some_and(|id| id != project_id) {
                        return Err(AppError::forbidden("run belongs to a different project"));
                    }
                }
                true
            }
            None => {
                if let Some(auth) = &ctx.auth {
                    if auth.project_id.is_some() {
                        return Err(AppError::forbidden(
                            "project-scoped API key cannot create a different project",
                        ));
                    }
                }
                false
            }
        }
    };
    if let Some(run_id) = requested_id {
        let existing = {
            let data = store.data.lock().await;
            data.runs.get(&run_id).cloned()
        };
        if let Some(run) = existing {
            ensure_run_access_in_data(ctx, &run)?;
            if run.project != project_name {
                return Err(AppError::with_code(
                    axum::http::StatusCode::CONFLICT,
                    "run_resume_conflict",
                    "run id belongs to a different project",
                ));
            }
            if resume == "never" {
                return Err(AppError::with_code(
                    axum::http::StatusCode::CONFLICT,
                    "run_resume_conflict",
                    "run id already exists",
                ));
            }
            let (resume_from_step, latest_steps_by_key) =
                resume_state_for_run(store, ctx.org_id, run.id).await?;
            return Ok(CreateRunResult {
                run,
                created: false,
                resumed: true,
                resume_from_step,
                latest_steps_by_key,
            });
        }
        if resume == "must" {
            return Err(AppError::with_code(
                axum::http::StatusCode::NOT_FOUND,
                "run_resume_missing",
                "run id does not exist",
            ));
        }
    }
    ensure_billing_write_allowed(store, ctx.org_id, "create a run").await?;
    enforce_plan_capacity(
        store,
        ctx.org_id,
        UsageDelta {
            projects: if project_exists { 0 } else { 1 },
            runs: 1,
            storage_bytes: RUN_METADATA_BYTES
                + if project_exists {
                    0
                } else {
                    PROJECT_METADATA_BYTES
                },
            ..UsageDelta::default()
        },
        "create a run",
    )
    .await?;
    let mut data = store.data.lock().await;
    let project_id = match data
        .projects_by_org_name
        .get(&(ctx.org_id, project_name.clone()))
        .copied()
    {
        Some(id) => id,
        None => {
            if let Some(auth) = &ctx.auth {
                if auth.project_id.is_some() {
                    return Err(AppError::forbidden(
                        "project-scoped API key cannot create a different project",
                    ));
                }
            }
            let project = ProjectRow {
                id: Uuid::new_v4(),
                org_id: ctx.org_id,
                name: project_name.clone(),
                description: None,
                created_at: Utc::now(),
            };
            store
                .persist_locked("project", ctx.org_id, &project.id.to_string(), &project)
                .await?;
            let id = project.id;
            data.insert_project(project);
            id
        }
    };
    if let Some(auth) = &ctx.auth {
        if auth.project_id.is_some_and(|id| id != project_id) {
            return Err(AppError::forbidden("run belongs to a different project"));
        }
    }
    let run = RunRow {
        id: requested_id.unwrap_or_else(Uuid::new_v4),
        org_id: ctx.org_id,
        project_id,
        project: project_name,
        name,
        status: "running".to_string(),
        config,
        tags,
        metadata,
        created_at: Utc::now(),
        started_at: Utc::now(),
        finished_at: None,
        last_heartbeat_at: None,
        last_event_at: None,
    };
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    data.insert_run(run.clone());
    Ok(CreateRunResult {
        run,
        created: true,
        resumed: false,
        resume_from_step: 0.0,
        latest_steps_by_key: BTreeMap::new(),
    })
}

pub async fn update_run(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UpdateRunRequest,
) -> AppResult<RunRow> {
    ensure_billing_write_allowed(store, ctx.org_id, "update a run").await?;
    let mut data = store.data.lock().await;
    let mut run = fetch_run_in_data(&data, ctx, run_id)?;
    if input.status.is_none() && input.tags.is_none() && input.notes.is_none() {
        return Err(AppError::validation(
            "at least one of status, tags, or notes is required",
        ));
    }
    if let Some(status) = input.status {
        run.status = validate_status(&status)?;
        if matches!(run.status.as_str(), "finished" | "failed" | "crashed")
            && run.finished_at.is_none()
        {
            run.finished_at = Some(Utc::now());
        }
    }
    if let Some(tags) = input.tags {
        run.tags = validate_tags(Some(tags))?;
    }
    if let Some(notes) = input.notes {
        let metadata = run
            .metadata
            .as_object_mut()
            .ok_or_else(|| AppError::validation("metadata must be an object"))?;
        if notes.trim().is_empty() {
            metadata.remove("notes");
        } else {
            metadata.insert(
                "notes".to_string(),
                json!(validate_name(Some(&notes), "notes")?),
            );
        }
    }
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    data.insert_run(run.clone());
    store.publish_live_event(
        ctx.org_id,
        run.project_id,
        run.id,
        "run_status",
        json!({
            "run_id": run.id,
            "status": run.status,
            "last_heartbeat_at": run.last_heartbeat_at
        }),
    );
    Ok(run)
}

pub async fn get_run(store: &Store, ctx: &RequestContext, run_id: Uuid) -> AppResult<Value> {
    let run = {
        let data = store.data.lock().await;
        fetch_run_in_data(&data, ctx, run_id)?
    };
    run_summary_value(store, run).await
}

pub async fn record_run_heartbeat(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: RunHeartbeatRequest,
) -> AppResult<RunRow> {
    let process_id = input.process_id.unwrap_or_else(Uuid::new_v4);
    let timestamp = validate_timestamp(input.timestamp.as_deref())?;
    let state = validate_name(
        input.state.as_deref().or(Some("running")),
        "heartbeat state",
    )?;
    if state != "running" {
        return Err(AppError::validation("heartbeat state must be running"));
    }
    let mut data = store.data.lock().await;
    let mut run = fetch_run_in_data(&data, ctx, run_id)?;
    if matches!(run.status.as_str(), "finished" | "failed" | "crashed") {
        return Err(AppError::conflict("terminal run cannot accept heartbeat"));
    }
    run.last_heartbeat_at = Some(timestamp);
    run.last_event_at = Some(timestamp);
    let liveness = RunLivenessRow {
        org_id: ctx.org_id,
        run_id,
        process_id,
        last_heartbeat_at: timestamp,
        last_event_at: timestamp,
        state: "running".to_string(),
        created_at: Utc::now(),
    };
    data.run_liveness.insert(run_id, liveness.clone());
    data.insert_run(run.clone());
    drop(data);
    store
        .metric_store_for_org(ctx.org_id)
        .await?
        .insert_run_liveness(&liveness)
        .await?;
    store.publish_live_event(
        ctx.org_id,
        run.project_id,
        run.id,
        "run_status",
        json!({
            "run_id": run.id,
            "status": run.status,
            "last_heartbeat_at": timestamp,
            "last_event_at": timestamp
        }),
    );
    Ok(run)
}

pub async fn note_run_event(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<RunRow> {
    let mut liveness_to_persist = None;
    let mut data = store.data.lock().await;
    let mut run = fetch_run_in_data(&data, ctx, run_id)?;
    let now = Utc::now();
    run.last_event_at = Some(now);
    if let Some(liveness) = data.run_liveness.get_mut(&run_id) {
        liveness.last_event_at = now;
        liveness.created_at = now;
        liveness_to_persist = Some(liveness.clone());
    }
    data.insert_run(run.clone());
    drop(data);
    if let Some(liveness) = liveness_to_persist {
        store
            .metric_store_for_org(ctx.org_id)
            .await?
            .insert_run_liveness(&liveness)
            .await?;
    }
    Ok(run)
}

pub async fn mark_stale_runs_crashed(store: &Store, timeout: StdDuration) -> AppResult<usize> {
    let cutoff = Utc::now()
        - ChronoDuration::from_std(timeout)
            .map_err(|_| AppError::internal("invalid liveness timeout"))?;
    let stale_runs = {
        let data = store.data.lock().await;
        data.runs
            .values()
            .filter(|run| run.status == "running")
            .filter_map(|run| {
                let heartbeat_at = data.run_liveness.get(&run.id)?.last_heartbeat_at;
                (heartbeat_at < cutoff).then_some(run.id)
            })
            .collect::<Vec<_>>()
    };
    let mut crashed = 0;
    for run_id in stale_runs {
        if mark_run_crashed_without_billing_gate(store, run_id).await? {
            crashed += 1;
        }
    }
    Ok(crashed)
}

async fn mark_run_crashed_without_billing_gate(store: &Store, run_id: Uuid) -> AppResult<bool> {
    let mut data = store.data.lock().await;
    let Some(mut run) = data.runs.get(&run_id).cloned() else {
        return Ok(false);
    };
    if run.status != "running" {
        return Ok(false);
    }
    run.status = "crashed".to_string();
    if run.finished_at.is_none() {
        run.finished_at = Some(Utc::now());
    }
    store
        .persist_locked("run", run.org_id, &run.id.to_string(), &run)
        .await?;
    data.insert_run(run.clone());
    store.publish_live_event(
        run.org_id,
        run.project_id,
        run.id,
        "run_status",
        json!({
            "run_id": run.id,
            "status": run.status,
            "last_heartbeat_at": run.last_heartbeat_at,
            "last_event_at": run.last_event_at
        }),
    );
    Ok(true)
}

fn validate_resume_mode(raw: Option<&str>) -> AppResult<&str> {
    let value = raw.unwrap_or("never");
    if matches!(value, "never" | "allow" | "must") {
        Ok(value)
    } else {
        Err(AppError::validation(
            "resume must be one of: allow, must, never",
        ))
    }
}

async fn resume_state_for_run(
    store: &Store,
    org_id: Uuid,
    run_id: Uuid,
) -> AppResult<(f64, BTreeMap<String, f64>)> {
    let metric_store = store.metric_store_for_org(org_id).await?;
    let resume_from_step = metric_store.resume_step_for_run(org_id, run_id).await?;
    let latest_steps_by_key = metric_store
        .latest_steps_by_key(org_id, run_id)
        .await?
        .into_iter()
        .collect();
    Ok((resume_from_step, latest_steps_by_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_resume_mode_accepts_v1_modes_only() {
        assert_eq!(validate_resume_mode(None).unwrap(), "never");
        assert_eq!(validate_resume_mode(Some("allow")).unwrap(), "allow");
        assert_eq!(validate_resume_mode(Some("must")).unwrap(), "must");
        assert!(validate_resume_mode(Some("auto")).is_err());
    }
}
