use super::*;
use crate::auth::canonical_json;
use sha2::{Digest, Sha256};

/// Result of run creation/attach: the resolved run plus whether a genuinely new
/// run was created (`false` for idempotent replay, attach, or resume).
#[derive(Debug, Clone)]
pub struct CreatedRun {
    pub run: RunRow,
    pub created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CreateMode {
    Create,
    Resume,
    Auto,
}

fn parse_create_mode(raw: Option<&str>) -> AppResult<CreateMode> {
    match raw.map(str::trim) {
        None | Some("") | Some("create") => Ok(CreateMode::Create),
        Some("resume") => Ok(CreateMode::Resume),
        Some("auto") => Ok(CreateMode::Auto),
        Some(_) => Err(AppError::with_code(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_run_mode",
            "mode must be one of: create, resume, auto",
        )),
    }
}

fn invalid_run_id() -> AppError {
    AppError::with_code(
        axum::http::StatusCode::BAD_REQUEST,
        "invalid_run_id",
        "id must be a canonical RFC 4122 UUID",
    )
}

fn run_id_conflict() -> AppError {
    AppError::with_code(
        axum::http::StatusCode::CONFLICT,
        "run_id_conflict",
        "a different run already exists with this id",
    )
}

fn run_not_found() -> AppError {
    AppError::with_code(
        axum::http::StatusCode::NOT_FOUND,
        "run_not_found",
        "run not found",
    )
}

fn resume_project_mismatch() -> AppError {
    AppError::with_code(
        axum::http::StatusCode::CONFLICT,
        "resume_project_mismatch",
        "run belongs to a different project than requested",
    )
}

/// Accept any canonical RFC 4122 UUID (upper or lower case) and normalize to
/// the lowercased hyphenated form. Braced, URN, or hyphen-free forms are
/// rejected so the client id round-trips exactly.
fn parse_client_run_id(raw: &str) -> AppResult<Uuid> {
    let trimmed = raw.trim();
    let parsed = Uuid::try_parse(trimmed).map_err(|_| invalid_run_id())?;
    if parsed.is_nil() || parsed.hyphenated().to_string() != trimmed.to_ascii_lowercase() {
        return Err(invalid_run_id());
    }
    Ok(parsed)
}

struct NormalizedCreate {
    project_name: String,
    /// Present only when the caller explicitly named a project (used to detect
    /// resume project mismatches without treating the default as explicit).
    explicit_project: Option<String>,
    explicit_name: Option<String>,
    config: Value,
    tags: Vec<String>,
    metadata: Value,
}

fn normalize_create_request(input: CreateRunRequest) -> AppResult<NormalizedCreate> {
    // SDK callers that omit `project` (or send empty/whitespace) land in the
    // shared "default" project so ad-hoc and migrated runs have a predictable
    // home.
    let explicit_project = match input.project.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => Some(validate_name(Some(value), "project")?),
        _ => None,
    };
    let project_name = explicit_project
        .clone()
        .unwrap_or_else(|| DEFAULT_PROJECT_NAME.to_string());
    // The run name is auto-generated later once we know the project_id and its
    // current run count; only validate here when the caller passed one.
    let explicit_name = match input.name.as_deref().map(str::trim) {
        Some(value) if !value.is_empty() => Some(validate_name(Some(value), "run name")?),
        _ => None,
    };
    let config = validate_json_object(input.config, "config")?;
    let tags = validate_tags(input.tags)?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    Ok(NormalizedCreate {
        project_name,
        explicit_project,
        explicit_name,
        config,
        tags,
        metadata,
    })
}

/// Deterministic sha256 over the canonical JSON of the normalized create
/// request. Persisted on the run row so `mode="create"` replay is recognizable
/// beyond the idempotency-record TTL, following the shipped `fork_run` pattern.
fn create_request_fingerprint(
    run_id: Uuid,
    normalized: &NormalizedCreate,
) -> AppResult<(Vec<u8>, String)> {
    let payload = json!({
        "id": run_id.hyphenated().to_string(),
        "project": normalized.project_name,
        "name": normalized.explicit_name,
        "config": normalized.config,
        "tags": normalized.tags,
        "metadata": normalized.metadata,
    });
    let canonical = canonical_json(&payload)?;
    let bytes = Sha256::digest(canonical.as_bytes()).to_vec();
    let hex = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((bytes, hex))
}

enum RunLookup {
    Missing,
    /// Exists but not visible/accessible to the caller. Treated as 404 so a
    /// client id never leaks the existence of another org/project's run, and
    /// the existing run is never mutated.
    Hidden,
    Visible(Box<RunRow>),
}

fn lookup_run_for_client(data: &StoreData, ctx: &RequestContext, run_id: Uuid) -> RunLookup {
    match data.runs.get(&run_id) {
        None => RunLookup::Missing,
        Some(run) => {
            if is_visible_run(data, run) && ensure_run_access_in_data(ctx, run).is_ok() {
                RunLookup::Visible(Box::new(run.clone()))
            } else {
                RunLookup::Hidden
            }
        }
    }
}

pub async fn create_run(
    store: &Store,
    ctx: &RequestContext,
    input: CreateRunRequest,
) -> AppResult<CreatedRun> {
    let mode = parse_create_mode(input.mode.as_deref())?;
    let client_id = match input.id.as_deref() {
        Some(raw) => Some(parse_client_run_id(raw)?),
        None => None,
    };
    match client_id {
        None => {
            if mode == CreateMode::Resume {
                return Err(AppError::validation("mode=resume requires an id"));
            }
            // Legacy server-generated identity path: behavior is unchanged.
            let normalized = normalize_create_request(input)?;
            let run = create_run_server_generated(store, ctx, normalized).await?;
            Ok(CreatedRun { run, created: true })
        }
        Some(run_id) => create_run_with_client_id(store, ctx, input, run_id, mode).await,
    }
}

async fn create_run_with_client_id(
    store: &Store,
    ctx: &RequestContext,
    input: CreateRunRequest,
    run_id: Uuid,
    mode: CreateMode,
) -> AppResult<CreatedRun> {
    let normalized = normalize_create_request(input)?;
    let (request_hash_bytes, request_hash_hex) = create_request_fingerprint(run_id, &normalized)?;
    // The in-flight idempotency guard serializes concurrent requests for the
    // same client run id within this process; the data-plane writer lease is
    // the cross-instance serializer.
    let idem_key = format!("run-create:{run_id}");
    store.reserve_idempotency_key(ctx.org_id, &idem_key).await?;
    let result = create_run_with_client_id_guarded(
        store,
        ctx,
        run_id,
        mode,
        &normalized,
        &request_hash_bytes,
        &request_hash_hex,
        &idem_key,
    )
    .await;
    store.release_idempotency_key(ctx.org_id, &idem_key).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn create_run_with_client_id_guarded(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    mode: CreateMode,
    normalized: &NormalizedCreate,
    request_hash_bytes: &[u8],
    request_hash_hex: &str,
    idem_key: &str,
) -> AppResult<CreatedRun> {
    // Fast in-window replay: a persisted run-create idempotency record short
    // circuits create/auto without re-running the matrix. Beyond the record's
    // TTL the run row's `create_request_hash` remains the source of truth.
    {
        let data = store.data.lock().await;
        if let Some(record) = data
            .idempotency
            .get(&(ctx.org_id, idem_key.to_string()))
            .filter(|record| record.expires_at > Utc::now())
        {
            if record.request_hash == request_hash_bytes {
                if mode != CreateMode::Resume {
                    if let Some(run) = data.runs.get(&run_id) {
                        if is_visible_run(&data, run) && ensure_run_access_in_data(ctx, run).is_ok()
                        {
                            return Ok(CreatedRun {
                                run: run.clone(),
                                created: false,
                            });
                        }
                    }
                }
            } else if mode == CreateMode::Create {
                // Only reveal the conflict when the caller can see the
                // existing run; hidden/missing runs fall through to the slow
                // path, which maps them to 404 without leaking existence.
                if let Some(run) = data.runs.get(&run_id) {
                    if is_visible_run(&data, run) && ensure_run_access_in_data(ctx, run).is_ok() {
                        return Err(run_id_conflict());
                    }
                }
            }
        }
    }

    let lookup = {
        let data = store.data.lock().await;
        lookup_run_for_client(&data, ctx, run_id)
    };

    match lookup {
        RunLookup::Hidden => Err(run_not_found()),
        RunLookup::Visible(run) => match mode {
            CreateMode::Create => {
                if run.create_request_hash.as_deref() == Some(request_hash_hex) {
                    // Idempotent replay: no mutation, no capacity check.
                    Ok(CreatedRun {
                        run: *run,
                        created: false,
                    })
                } else {
                    Err(run_id_conflict())
                }
            }
            // Attach-or-create, never reopen: a terminal run stays terminal.
            CreateMode::Auto => Ok(CreatedRun {
                run: *run,
                created: false,
            }),
            CreateMode::Resume => resume_existing_run(store, ctx, run_id, normalized).await,
        },
        RunLookup::Missing => match mode {
            CreateMode::Resume => Err(run_not_found()),
            CreateMode::Create | CreateMode::Auto => {
                create_new_with_id(
                    store,
                    ctx,
                    run_id,
                    normalized,
                    request_hash_bytes,
                    request_hash_hex,
                    idem_key,
                )
                .await
            }
        },
    }
}

async fn create_new_with_id(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    normalized: &NormalizedCreate,
    request_hash_bytes: &[u8],
    request_hash_hex: &str,
    idem_key: &str,
) -> AppResult<CreatedRun> {
    // Phase A: validate project scope/existence under a brief lock.
    let project_exists = {
        let data = store.data.lock().await;
        match data
            .projects_by_org_name
            .get(&(ctx.org_id, normalized.project_name.clone()))
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
    // Capacity/billing gates run only on genuine new creation.
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
    // Phase B: resolve or create the project without holding the StoreData
    // lock across the project persist. Rare auto-creation is serialized by a
    // per-org creation lock so concurrent creates cannot mint duplicate
    // (org, name) projects.
    let existing_project_id = {
        let data = store.data.lock().await;
        data.projects_by_org_name
            .get(&(ctx.org_id, normalized.project_name.clone()))
            .copied()
    };
    let project_id = match existing_project_id {
        Some(id) => id,
        None => {
            if let Some(auth) = &ctx.auth {
                if auth.project_id.is_some() {
                    return Err(AppError::forbidden(
                        "project-scoped API key cannot create a different project",
                    ));
                }
            }
            let create_lock = store.project_create_lock(ctx.org_id).await;
            let _create_guard = create_lock.lock().await;
            let rechecked = {
                let data = store.data.lock().await;
                data.projects_by_org_name
                    .get(&(ctx.org_id, normalized.project_name.clone()))
                    .copied()
            };
            match rechecked {
                Some(id) => id,
                None => {
                    let project = ProjectRow {
                        id: Uuid::new_v4(),
                        org_id: ctx.org_id,
                        name: normalized.project_name.clone(),
                        description: None,
                        created_at: Utc::now(),
                    };
                    store
                        .persist_locked("project", ctx.org_id, &project.id.to_string(), &project)
                        .await?;
                    let id = project.id;
                    store.data.lock().await.insert_project(project);
                    id
                }
            }
        }
    };
    // Phase C: build the run under the lock, releasing it before persisting
    // (the in-flight guard fences concurrent same-id creates while the lock
    // is released).
    let run = {
        let data = store.data.lock().await;
        if let Some(auth) = &ctx.auth {
            if auth.project_id.is_some_and(|id| id != project_id) {
                return Err(AppError::forbidden("run belongs to a different project"));
            }
        }
        let name = match normalized.explicit_name.clone() {
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
        let now = Utc::now();
        RunRow {
            id: run_id,
            org_id: ctx.org_id,
            project_id,
            project: normalized.project_name.clone(),
            name,
            status: "running".to_string(),
            config: normalized.config.clone(),
            tags: normalized.tags.clone(),
            metadata: normalized.metadata.clone(),
            created_at: now,
            started_at: now,
            finished_at: None,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
            resume_count: 0,
            resumed_at: None,
            create_request_hash: Some(request_hash_hex.to_string()),
            lifecycle: Vec::new(),
        }
    };
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    let record = IdempotencyRecord {
        org_id: ctx.org_id,
        key: idem_key.to_string(),
        request_hash: request_hash_bytes.to_vec(),
        response_json: serde_json::to_value(&run)
            .map_err(|_| AppError::internal("run-create response serialization failed"))?,
        expires_at: Utc::now() + ChronoDuration::days(7),
    };
    store
        .persist_locked("idempotency", ctx.org_id, idem_key, &record)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_run(run.clone());
    data.idempotency
        .insert((ctx.org_id, idem_key.to_string()), record);
    Ok(CreatedRun { run, created: true })
}

/// Explicit reopen. Running runs are a plain attach; terminal runs are reopened
/// with the enumerated side effects (status/finished_at/resume bookkeeping,
/// bounded lifecycle history, and a run_control stop-state reset).
async fn resume_existing_run(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    normalized: &NormalizedCreate,
) -> AppResult<CreatedRun> {
    // Billing/plan capacity checks are intentionally skipped on resume: no new
    // run is created, matching the replay/attach paths and `fork_run`.
    let (run, reset_control) = {
        let data = store.data.lock().await;
        let run = match lookup_run_for_client(&data, ctx, run_id) {
            RunLookup::Visible(run) => *run,
            RunLookup::Missing | RunLookup::Hidden => return Err(run_not_found()),
        };
        if let Some(requested) = &normalized.explicit_project {
            if requested != &run.project {
                return Err(resume_project_mismatch());
            }
        }
        if run.status == "running" {
            // Plain attach: no lifecycle mutation.
            return Ok(CreatedRun {
                run,
                created: false,
            });
        }
        let now = Utc::now();
        let previous_status = run.status.clone();
        let mut run = run;
        run.status = "running".to_string();
        run.finished_at = None;
        run.resume_count = run.resume_count.saturating_add(1);
        run.resumed_at = Some(now);
        run.lifecycle.push(LifecycleTransition {
            status_from: previous_status,
            status_to: "running".to_string(),
            at: now,
            kind: "resume".to_string(),
        });
        if run.lifecycle.len() > RUN_LIFECYCLE_HISTORY_LIMIT {
            let excess = run.lifecycle.len() - RUN_LIFECYCLE_HISTORY_LIMIT;
            run.lifecycle.drain(0..excess);
        }
        // Reset any active stop state so a stale stop request cannot immediately
        // re-terminate the reopened run.
        let reset_control = data.run_controls.get(&run.id).and_then(|existing| {
            if existing.stop_state == "none" {
                None
            } else {
                Some(RunControlRow {
                    org_id: run.org_id,
                    run_id: run.id,
                    stop_request_id: None,
                    stop_state: "none".to_string(),
                    reason: None,
                    completion_message: None,
                    actor: Some("resume".to_string()),
                    requested_at: None,
                    acknowledged_at: None,
                    completed_at: None,
                    updated_at: now,
                })
            }
        });
        (run, reset_control)
    };
    store
        .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
        .await?;
    if let Some(control) = &reset_control {
        store
            .persist_locked("run_control", ctx.org_id, &run.id.to_string(), control)
            .await?;
    }
    let mut data = store.data.lock().await;
    data.insert_run(run.clone());
    if let Some(control) = reset_control {
        data.insert_run_control(control);
    }
    Ok(CreatedRun {
        run,
        created: false,
    })
}

async fn create_run_server_generated(
    store: &Store,
    ctx: &RequestContext,
    normalized: NormalizedCreate,
) -> AppResult<RunRow> {
    let NormalizedCreate {
        project_name,
        explicit_name,
        config,
        tags,
        metadata,
        ..
    } = normalized;
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
        resume_count: 0,
        resumed_at: None,
        create_request_hash: None,
        lifecycle: Vec::new(),
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
