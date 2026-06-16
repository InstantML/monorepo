use super::*;

pub async fn create_run(
    store: &Store,
    ctx: &RequestContext,
    input: CreateRunRequest,
) -> AppResult<RunRow> {
    // SDK callers that omit `project` (or send empty/whitespace) land in the
    // shared "default" project so ad-hoc and migrated runs have a
    // predictable home.
    let project_name = match input.project.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => validate_name(Some(value), "project")?,
        _ => DEFAULT_PROJECT_NAME.to_string(),
    };
    // The run name is auto-generated below once we know the project_id and
    // its current run count; only validate here when the caller passed one.
    let explicit_name = match input.name.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => Some(validate_name(Some(value), "run name")?),
        _ => None,
    };
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
    // Default name: <adjective>-<noun>-<sequence>, where sequence is this
    // run's 1-indexed position in the project. Counts `data.runs` under the
    // lock so the sequence is consistent with what we're about to insert.
    let name = match explicit_name {
        Some(provided) => provided,
        None => {
            let seq = data
                .runs
                .values()
                .filter(|run| run.org_id == ctx.org_id && run.project_id == project_id)
                .count() as u64
                + 1;
            generate_run_name(seq)?
        }
    };
    let run = RunRow {
        id: Uuid::new_v4(),
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
        parent_run_id: None,
        forked_from_step: None,
        forked_from_artifact_id: None,
    };
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    data.insert_run(run.clone());
    Ok(run)
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
    let mut terminal_stop_control = None;
    if input.status.is_none() && input.tags.is_none() && input.notes.is_none() {
        return Err(AppError::validation(
            "at least one of status, tags, or notes is required",
        ));
    }
    if let Some(status) = input.status {
        run.status = validate_status(&status)?;
        if matches!(run.status.as_str(), "finished" | "failed") && run.finished_at.is_none() {
            run.finished_at = Some(Utc::now());
        }
        if matches!(run.status.as_str(), "finished" | "failed") {
            if let Some(existing) = data.run_controls.get(&run.id) {
                if matches!(existing.stop_state.as_str(), "requested" | "acknowledged") {
                    let mut control = existing.clone();
                    control.stop_state = "terminal_without_completion".to_string();
                    control.updated_at = run.finished_at.unwrap_or_else(Utc::now);
                    terminal_stop_control = Some(control);
                }
            }
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
    if let Some(control) = terminal_stop_control.as_ref() {
        store
            .persist_locked("run_control", ctx.org_id, &run.id.to_string(), &control)
            .await?;
    }
    data.insert_run(run.clone());
    if let Some(control) = terminal_stop_control {
        data.insert_run_control(control);
    }
    Ok(run)
}

pub async fn get_run(store: &Store, ctx: &RequestContext, run_id: Uuid) -> AppResult<Value> {
    let run = {
        let data = store.data.lock().await;
        fetch_run_in_data(&data, ctx, run_id)?
    };
    let privacy = if can_read_private_run_control(ctx) {
        RunControlPrivacy::Private
    } else {
        RunControlPrivacy::Public
    };
    run_summary_value(store, run, privacy).await
}
