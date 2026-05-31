use std::collections::{HashMap, HashSet};

use super::*;
use regex::Regex;
use sha2::{Digest, Sha256};

const IMPORT_V2_SCHEMA_VERSION: i32 = 2;
const IMPORT_STATE_CREATED: &str = "created";
const IMPORT_STATE_UPLOADING: &str = "uploading";
const IMPORT_STATE_DRY_RUN_READY: &str = "dry_run_ready";
const IMPORT_STATE_COMMITTING: &str = "committing";
const IMPORT_STATE_COMMITTED: &str = "committed";
const IMPORT_STATE_FAILED: &str = "failed";
const IMPORT_STATE_CANCELLED: &str = "cancelled";
const IMPORT_DEDUPE_SKIP_EXISTING: &str = "skip_existing";
const MAX_IMPORT_RUNS_PER_CHUNK: usize = 1_000;
const MAX_IMPORT_METRICS_PER_CHUNK: usize = 50_000;
const MAX_IMPORT_ATTRIBUTES_PER_CHUNK: usize = 25_000;
const MAX_IMPORT_ARTIFACTS_PER_CHUNK: usize = 10_000;
const MAX_IMPORT_WARNINGS_PER_JOB: usize = 200;
const MAX_IMPORT_STRING_BYTES: usize = 8 * 1024;
const MAX_IMPORT_CHUNKS_PER_JOB: usize = 500;
const MAX_IMPORT_RUNS_PER_JOB: u64 = 50_000;
const MAX_IMPORT_METRICS_PER_JOB: u64 = 1_000_000;
const MAX_IMPORT_ATTRIBUTES_PER_JOB: u64 = 250_000;
const MAX_IMPORT_ARTIFACTS_PER_JOB: u64 = 100_000;

pub async fn list_imports(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let data = store.data.lock().await;
    let restricted_project_id = ctx.auth.as_ref().and_then(|auth| auth.project_id);
    let mut rows = data
        .imports
        .values()
        .filter(|row| row.org_id == ctx.org_id)
        .filter(|row| {
            restricted_project_id
                .map(|project_id| row.project_id == Some(project_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    rows.truncate(MAX_IMPORT_LIST as usize);
    Ok(json!({ "imports": rows }))
}

pub async fn create_import_job(
    store: &Store,
    ctx: &RequestContext,
    raw: Value,
) -> AppResult<Value> {
    let source_type = validate_name(
        raw.get("source_type").and_then(Value::as_str),
        "source_type",
    )?;
    let source_project = validate_optional_import_text(
        raw.get("source_project").and_then(Value::as_str),
        "source_project",
    )?;
    let target_project = validate_name(
        raw.get("target_project")
            .or_else(|| raw.get("project"))
            .and_then(Value::as_str),
        "target_project",
    )?;
    let schema_version = raw
        .get("schema_version")
        .and_then(Value::as_i64)
        .unwrap_or(IMPORT_V2_SCHEMA_VERSION as i64);
    if schema_version != IMPORT_V2_SCHEMA_VERSION as i64 {
        return Err(AppError::validation("import schema_version must be 2"));
    }
    ensure_import_project_access(store, ctx, &target_project).await?;
    let mut data = store.data.lock().await;
    let project_id = ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .or_else(|| {
            data.projects_by_org_name
                .get(&(ctx.org_id, target_project.clone()))
                .copied()
        });
    let now = Utc::now();
    let row = ImportRow {
        id: data.allocate_import_id(ctx.org_id),
        org_id: ctx.org_id,
        project_id,
        source_type,
        source_project,
        target_project: Some(target_project),
        schema_version: IMPORT_V2_SCHEMA_VERSION,
        status: IMPORT_STATE_CREATED.to_string(),
        dedupe_policy: IMPORT_DEDUPE_SKIP_EXISTING.to_string(),
        summary: import_empty_summary(),
        warnings: Vec::new(),
        error_summary: None,
        progress: json!({ "state": IMPORT_STATE_CREATED }),
        run_ids: Vec::new(),
        chunk_ids: Vec::new(),
        accepted_chunk_count: 0,
        committed_batch_count: 0,
        created_by_user_id: ctx.session.as_ref().map(|session| session.user_id),
        updated_at: Some(now),
        created_at: now,
        completed_at: None,
    };
    store
        .persist_locked("import", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    data.imports.insert((ctx.org_id, row.id), row.clone());
    Ok(json!({ "job": row }))
}

pub async fn get_import_job(
    store: &Store,
    ctx: &RequestContext,
    import_id: i64,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let job = import_job_for_ctx(&data, ctx, import_id)?.clone();
    Ok(json!({ "job": job }))
}

pub async fn append_import_chunk(
    store: &Store,
    ctx: &RequestContext,
    import_id: i64,
    raw: Value,
) -> AppResult<Value> {
    let mut chunk_payload = redact_value(raw);
    let chunk_id = validate_name(
        chunk_payload.get("chunk_id").and_then(Value::as_str),
        "chunk_id",
    )?;
    validate_import_string_limits(&chunk_payload)?;
    let sequence = chunk_payload
        .get("sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::validation("sequence is required"))?;
    if sequence < 0 {
        return Err(AppError::validation("sequence must be non-negative"));
    }
    let final_chunk = chunk_payload
        .get("final")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let schema_version = chunk_payload
        .get("schema_version")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::validation("schema_version is required"))?;
    if schema_version != IMPORT_V2_SCHEMA_VERSION as i64 {
        return Err(AppError::validation("schema_version must be 2"));
    }
    if chunk_payload
        .get("job_id")
        .and_then(Value::as_i64)
        .filter(|job_id| *job_id == import_id)
        .is_none()
    {
        return Err(AppError::validation("chunk job_id does not match path"));
    }
    let computed_hash = import_content_hash(&chunk_payload)?;
    let provided_hash = chunk_payload
        .get("content_hash")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    if let Some(provided_hash) = provided_hash.as_ref() {
        if provided_hash != &computed_hash {
            return Err(AppError::validation(
                "content_hash does not match chunk payload",
            ));
        }
    }
    if let Some(map) = chunk_payload.as_object_mut() {
        map.insert("content_hash".to_string(), json!(computed_hash.clone()));
    }
    validate_import_chunk_shape(&chunk_payload)?;
    let chunk_summary = summarize_import_chunk(&chunk_payload)?;
    let mut data = store.data.lock().await;
    let job_snapshot = import_job_for_ctx(&data, ctx, import_id)?.clone();
    let target_project = chunk_payload
        .get("target_project")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("target_project is required"))?;
    if job_snapshot.target_project.as_deref() != Some(target_project) {
        return Err(AppError::validation(
            "chunk target_project does not match job",
        ));
    }
    if chunk_payload
        .get("source_type")
        .and_then(Value::as_str)
        .filter(|source| *source == job_snapshot.source_type)
        .is_none()
    {
        return Err(AppError::validation("chunk source_type does not match job"));
    }
    if job_snapshot.source_project.as_deref()
        != chunk_payload.get("source_project").and_then(Value::as_str)
    {
        return Err(AppError::validation(
            "chunk source_project does not match job",
        ));
    }
    let chunk_key = (ctx.org_id, import_id, chunk_id.clone());
    if let Some(existing) = data.import_chunks.get(&chunk_key) {
        if existing.content_hash == computed_hash {
            let existing = existing.clone();
            let job_clone =
                rebuild_import_job_from_chunks_locked(&mut data, ctx, import_id, Utc::now())?;
            store
                .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
                .await?;
            data.imports
                .insert((ctx.org_id, job_clone.id), job_clone.clone());
            return Ok(json!({ "job": job_clone, "chunk": existing, "duplicate": true }));
        }
        return Err(AppError::conflict(
            "import chunk already exists with different content",
        ));
    }
    if sequence as usize != job_snapshot.chunk_ids.len() {
        return Err(AppError::conflict(
            "import chunk sequence must be contiguous",
        ));
    }
    if !matches!(
        job_snapshot.status.as_str(),
        IMPORT_STATE_CREATED | IMPORT_STATE_UPLOADING
    ) {
        return Err(AppError::conflict("import job is not accepting chunks"));
    }
    if job_snapshot.chunk_ids.len() >= MAX_IMPORT_CHUNKS_PER_JOB {
        return Err(AppError::validation("import job has too many chunks"));
    }
    let projected_summary =
        projected_import_summary_locked(&data, ctx.org_id, import_id, &chunk_summary);
    validate_import_job_caps(&projected_summary)?;
    let now = Utc::now();
    let chunk = ImportChunkRow {
        org_id: ctx.org_id,
        import_id,
        chunk_id: chunk_id.clone(),
        sequence,
        content_hash: computed_hash,
        final_chunk,
        payload: chunk_payload,
        summary: chunk_summary,
        created_at: now,
    };
    if final_chunk {
        let mut chunks = job_chunks_locked(&data, ctx.org_id, import_id);
        chunks.push(chunk.clone());
        canonical_import_from_chunk_rows(&job_snapshot, chunks)?;
    }
    store
        .persist_locked("import_chunk", ctx.org_id, &chunk.chunk_id, &chunk)
        .await?;
    data.import_chunks.insert(chunk_key, chunk.clone());
    let mut job_clone = rebuild_import_job_from_chunks_locked(&mut data, ctx, import_id, now)?;
    job_clone.summary = projected_summary;
    store
        .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
        .await?;
    data.imports
        .insert((ctx.org_id, job_clone.id), job_clone.clone());
    Ok(json!({ "job": job_clone, "chunk": chunk, "duplicate": false }))
}

pub async fn cancel_import_job(
    store: &Store,
    ctx: &RequestContext,
    import_id: i64,
) -> AppResult<Value> {
    let mut data = store.data.lock().await;
    let job = import_job_for_ctx_mut(&mut data, ctx, import_id)?;
    if matches!(
        job.status.as_str(),
        IMPORT_STATE_COMMITTED | IMPORT_STATE_CANCELLED
    ) {
        return Err(AppError::conflict("import job is already terminal"));
    }
    if job.status == IMPORT_STATE_COMMITTING {
        return Err(AppError::conflict(
            "committing import jobs cannot be cancelled",
        ));
    }
    job.status = IMPORT_STATE_CANCELLED.to_string();
    job.progress = json!({ "state": IMPORT_STATE_CANCELLED });
    job.updated_at = Some(Utc::now());
    job.completed_at = Some(Utc::now());
    let job_clone = job.clone();
    store
        .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
        .await?;
    data.imports
        .insert((ctx.org_id, job_clone.id), job_clone.clone());
    Ok(json!({ "job": job_clone }))
}

pub async fn commit_import_job(
    store: &Store,
    ctx: &RequestContext,
    import_id: i64,
) -> AppResult<Value> {
    let active_key = (ctx.org_id, import_id);
    let canonical = {
        let mut data = store.data.lock().await;
        let job_snapshot = import_job_for_ctx(&data, ctx, import_id)?.clone();
        if job_snapshot.status == IMPORT_STATE_COMMITTED {
            let summary = job_snapshot.summary.clone();
            return Ok(json!({ "job": job_snapshot, "summary": summary }));
        }
        if data.active_import_commits.contains(&active_key) {
            let summary = job_snapshot.summary.clone();
            return Ok(json!({ "job": job_snapshot, "summary": summary }));
        }
        if data
            .active_import_commits
            .iter()
            .any(|(org_id, _)| *org_id == ctx.org_id)
        {
            return Err(AppError::conflict(
                "another import commit is already running for this organization",
            ));
        }
        let has_partial_writes = has_partial_import_writes_locked(&data, ctx.org_id, import_id);
        if job_snapshot.status == IMPORT_STATE_COMMITTING && has_partial_writes {
            let job = import_job_for_ctx_mut(&mut data, ctx, import_id)?;
            job.status = IMPORT_STATE_FAILED.to_string();
            job.error_summary = Some(json!({
                "code": "import_commit_uncertain",
                "message": "import commit was interrupted after partial writes; create a new import job",
            }));
            job.progress = json!({ "state": IMPORT_STATE_FAILED, "resumable": false, "partial_write_started": true });
            job.updated_at = Some(Utc::now());
            let job_clone = job.clone();
            store
                .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
                .await?;
            return Err(AppError::conflict(
                "import commit was interrupted after partial writes; create a new import job",
            ));
        }
        if !matches!(
            job_snapshot.status.as_str(),
            IMPORT_STATE_DRY_RUN_READY | IMPORT_STATE_FAILED | IMPORT_STATE_COMMITTING
        ) {
            return Err(AppError::conflict("import job is not ready to commit"));
        }
        if job_snapshot.status == IMPORT_STATE_FAILED && has_partial_writes {
            return Err(AppError::conflict(
                "failed import has partial writes; create a new import job",
            ));
        }
        let canonical = match canonical_import_from_chunks_locked(&data, ctx, &job_snapshot) {
            Ok(canonical) => canonical,
            Err(err) => {
                let job = import_job_for_ctx_mut(&mut data, ctx, import_id)?;
                job.status = IMPORT_STATE_FAILED.to_string();
                job.error_summary = Some(json!({
                    "code": err.safe_code(),
                    "message": err.message(),
                }));
                job.progress = json!({ "state": IMPORT_STATE_FAILED, "resumable": false });
                job.updated_at = Some(Utc::now());
                let job_clone = job.clone();
                store
                    .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
                    .await?;
                return Err(err);
            }
        };
        data.active_import_commits.insert(active_key);
        let job = import_job_for_ctx_mut(&mut data, ctx, import_id)?;
        job.status = IMPORT_STATE_COMMITTING.to_string();
        job.progress = json!({ "state": IMPORT_STATE_COMMITTING });
        job.updated_at = Some(Utc::now());
        canonical
    };

    let result = commit_canonical_import(store, ctx, import_id, canonical).await;
    {
        let mut data = store.data.lock().await;
        data.active_import_commits.remove(&active_key);
    }
    if result.is_err() {
        let mut data = store.data.lock().await;
        let resumable = !has_partial_import_writes_locked(&data, ctx.org_id, import_id);
        if let Some(job) = data.imports.get_mut(&(ctx.org_id, import_id)) {
            job.status = IMPORT_STATE_FAILED.to_string();
            job.error_summary = result.as_ref().err().map(|err| {
                json!({
                    "code": err.safe_code(),
                    "message": err.message(),
                })
            });
            job.progress = json!({ "state": IMPORT_STATE_FAILED, "resumable": resumable });
            job.updated_at = Some(Utc::now());
            let job_clone = job.clone();
            store
                .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
                .await?;
        }
    }
    result
}

pub async fn import_payload(
    store: &Store,
    ctx: &RequestContext,
    source: &str,
    dry_run: bool,
    raw: Value,
) -> AppResult<Value> {
    let canonical = normalize_import(source, redact_value(raw))?;
    let summary = json!({
        "runs": canonical.runs.len(),
        "metrics": canonical.runs.iter().map(|run| run.metrics.len()).sum::<usize>(),
        "attributes": canonical.runs.iter().map(|run| run.attributes.len()).sum::<usize>(),
        "artifacts": canonical.runs.iter().map(|run| run.artifacts.len()).sum::<usize>(),
    });
    if dry_run {
        ensure_import_project_access(store, ctx, &canonical.project).await?;
        return Ok(json!({ "dry_run": true, "summary": summary }));
    }
    ensure_import_project_access(store, ctx, &canonical.project).await?;
    ensure_billing_write_allowed(store, ctx.org_id, "import runs").await?;
    let project_exists = {
        let data = store.data.lock().await;
        ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some()
            || data
                .projects_by_org_name
                .contains_key(&(ctx.org_id, canonical.project.clone()))
    };
    enforce_plan_capacity(
        store,
        ctx.org_id,
        import_usage_delta(&canonical, project_exists),
        "import runs",
    )
    .await?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let mut data = store.data.lock().await;
    let project = match ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        Some(project_id) => {
            let project = data
                .projects
                .get(&project_id)
                .cloned()
                .filter(|project| project.org_id == ctx.org_id)
                .ok_or_else(|| AppError::forbidden("project-scoped API key project not found"))?;
            if project.name != canonical.project {
                return Err(AppError::forbidden(
                    "project-scoped API keys cannot import into another project",
                ));
            }
            project
        }
        None => ensure_project_locked(store, &mut data, ctx.org_id, &canonical.project).await?,
    };
    let mut run_ids = Vec::new();
    for item in canonical.runs {
        let started_at = item.started_at.unwrap_or_else(Utc::now);
        let finished_at = if item.status == "running" {
            None
        } else {
            Some(item.finished_at.unwrap_or_else(Utc::now))
        };
        let run = RunRow {
            id: Uuid::new_v4(),
            org_id: ctx.org_id,
            project_id: project.id,
            project: project.name.clone(),
            name: item.name,
            status: item.status,
            config: item.config,
            tags: item.tags,
            metadata: item.metadata,
            created_at: Utc::now(),
            started_at,
            finished_at,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        };
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        data.insert_run(run.clone());
        let points = item
            .metrics
            .into_iter()
            .map(|metric| ChMetricPointRow {
                org_id: ctx.org_id,
                run_id: run.id,
                key: metric.key,
                step: metric.step,
                value: metric.value,
                logged_at: metric.logged_at,
                created_at: Utc::now(),
            })
            .collect::<Vec<_>>();
        metric_store.insert_points(&points).await?;
        for attribute in item.attributes {
            let attribute = attribute_from_input(&mut data, ctx.org_id, run.id, attribute)?;
            store
                .persist_locked(
                    "attribute",
                    ctx.org_id,
                    &attribute.id.to_string(),
                    &attribute,
                )
                .await?;
            data.insert_attribute(attribute);
        }
        for artifact in item.artifacts {
            let artifact = ArtifactRow {
                id: Uuid::new_v4(),
                org_id: ctx.org_id,
                run_id: run.id,
                kind: artifact.kind,
                name: artifact.name.clone(),
                uri: artifact.uri,
                step: artifact.step,
                size_bytes: artifact.size_bytes,
                sha256: None,
                mime_type: artifact.mime_type.or_else(|| {
                    mime_guess::from_path(&artifact.name)
                        .first_raw()
                        .map(str::to_string)
                }),
                storage_backend: "external".to_string(),
                storage_key: None,
                storage_path: None,
                metadata: artifact.metadata,
                created_at: Utc::now(),
            };
            store
                .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
                .await?;
            data.insert_artifact(artifact);
        }
        run_ids.push(run.id);
    }
    let import = ImportRow {
        id: data.allocate_import_id(ctx.org_id),
        org_id: ctx.org_id,
        project_id: Some(project.id),
        source_type: format!("{source}_json"),
        source_project: None,
        target_project: Some(project.name.clone()),
        schema_version: 1,
        status: "completed".to_string(),
        dedupe_policy: "legacy".to_string(),
        summary: summary.clone(),
        warnings: Vec::new(),
        error_summary: None,
        progress: json!({ "state": "completed" }),
        run_ids: run_ids.clone(),
        chunk_ids: Vec::new(),
        accepted_chunk_count: 0,
        committed_batch_count: 0,
        created_by_user_id: ctx.session.as_ref().map(|session| session.user_id),
        updated_at: Some(Utc::now()),
        created_at: Utc::now(),
        completed_at: Some(Utc::now()),
    };
    store
        .persist_locked("import", ctx.org_id, &import.id.to_string(), &import)
        .await?;
    data.imports.insert((ctx.org_id, import.id), import.clone());
    Ok(json!({ "dry_run": false, "summary": summary, "import": import }))
}

async fn commit_canonical_import(
    store: &Store,
    ctx: &RequestContext,
    import_id: i64,
    canonical: CanonicalImport,
) -> AppResult<Value> {
    let CanonicalImport {
        project: canonical_project,
        runs: canonical_runs,
    } = canonical;
    ensure_import_project_access(store, ctx, &canonical_project).await?;
    ensure_billing_write_allowed(store, ctx.org_id, "import runs").await?;
    let project_snapshot = {
        let data = store.data.lock().await;
        match ctx.auth.as_ref().and_then(|auth| auth.project_id) {
            Some(project_id) => {
                let project = data
                    .projects
                    .get(&project_id)
                    .cloned()
                    .filter(|project| project.org_id == ctx.org_id)
                    .ok_or_else(|| {
                        AppError::forbidden("project-scoped API key project not found")
                    })?;
                if project.name != canonical_project {
                    return Err(AppError::forbidden(
                        "project-scoped API keys cannot import into another project",
                    ));
                }
                Some(project)
            }
            None => data
                .projects_by_org_name
                .get(&(ctx.org_id, canonical_project.clone()))
                .and_then(|project_id| data.projects.get(project_id).cloned()),
        }
    };
    let existing_complete_identity_runs = {
        let data = store.data.lock().await;
        project_snapshot
            .as_ref()
            .map(|project| {
                data.runs
                    .values()
                    .filter(|run| run.org_id == ctx.org_id && run.project_id == project.id)
                    .filter_map(|run| {
                        import_complete_external_identity(&run.metadata)
                            .map(|identity| (identity, run.id))
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default()
    };
    let mut runs_to_commit = Vec::new();
    let mut existing_runs_to_update = Vec::new();
    let mut skipped_runs = 0usize;
    let mut seen_identities = HashSet::new();
    for item in canonical_runs {
        let external_identity = import_external_identity(&item.metadata);
        if let Some(identity) = external_identity.as_ref() {
            if !seen_identities.insert(identity.clone()) {
                skipped_runs += 1;
                continue;
            }
            if let Some(run_id) = existing_complete_identity_runs.get(identity) {
                if import_source_type(&item.metadata).as_deref() == Some("tensorboard")
                    && item.attributes.is_empty()
                    && item.artifacts.is_empty()
                {
                    existing_runs_to_update.push((*run_id, item));
                } else {
                    skipped_runs += 1;
                }
                continue;
            }
        }
        runs_to_commit.push(item);
    }
    let append_metric_points = existing_runs_to_update
        .iter()
        .map(|(_, run)| run.metrics.len() as i64)
        .sum::<i64>();
    let mut usage_delta = import_usage_delta_for_runs(&runs_to_commit, project_snapshot.is_some());
    usage_delta.metric_points += append_metric_points;
    enforce_plan_capacity(store, ctx.org_id, usage_delta, "import runs").await?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let project = match project_snapshot {
        Some(project) => project,
        None => {
            let mut data = store.data.lock().await;
            ensure_project_locked(store, &mut data, ctx.org_id, &canonical_project).await?
        }
    };
    let total_attributes = runs_to_commit
        .iter()
        .map(|run| run.attributes.len())
        .sum::<usize>();
    let total_artifacts = runs_to_commit
        .iter()
        .map(|run| run.artifacts.len())
        .sum::<usize>();
    let mut run_ids = Vec::new();
    let mut updated_run_ids = Vec::new();
    let mut committed_metrics = 0usize;
    let mut partial_marked = false;
    for (run_id, item) in existing_runs_to_update {
        if !partial_marked {
            mark_import_partial_write_started(store, ctx, import_id).await?;
            partial_marked = true;
        }
        let points = item
            .metrics
            .into_iter()
            .map(|metric| ChMetricPointRow {
                org_id: ctx.org_id,
                run_id,
                key: metric.key,
                step: metric.step,
                value: metric.value,
                logged_at: metric.logged_at,
                created_at: Utc::now(),
            })
            .collect::<Vec<_>>();
        for batch in points.chunks(50_000) {
            metric_store.insert_points(batch).await?;
        }
        committed_metrics += points.len();
        updated_run_ids.push(run_id);
    }
    for item in runs_to_commit {
        if !partial_marked {
            mark_import_partial_write_started(store, ctx, import_id).await?;
            partial_marked = true;
        }
        let started_at = item.started_at.unwrap_or_else(Utc::now);
        let finished_at = if item.status == "running" {
            None
        } else {
            Some(item.finished_at.unwrap_or_else(Utc::now))
        };
        let mut metadata = item.metadata;
        set_import_complete(&mut metadata, false);
        let mut run = RunRow {
            id: Uuid::new_v4(),
            org_id: ctx.org_id,
            project_id: project.id,
            project: project.name.clone(),
            name: item.name,
            status: item.status,
            config: item.config,
            tags: item.tags,
            metadata,
            created_at: Utc::now(),
            started_at,
            finished_at,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        };
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        let points = item
            .metrics
            .into_iter()
            .map(|metric| ChMetricPointRow {
                org_id: ctx.org_id,
                run_id: run.id,
                key: metric.key,
                step: metric.step,
                value: metric.value,
                logged_at: metric.logged_at,
                created_at: Utc::now(),
            })
            .collect::<Vec<_>>();
        for batch in points.chunks(50_000) {
            metric_store.insert_points(batch).await?;
        }
        committed_metrics += points.len();
        let mut attributes = Vec::new();
        for attribute in item.attributes {
            let attribute = {
                let mut data = store.data.lock().await;
                attribute_from_input(&mut data, ctx.org_id, run.id, attribute)?
            };
            store
                .persist_locked(
                    "attribute",
                    ctx.org_id,
                    &attribute.id.to_string(),
                    &attribute,
                )
                .await?;
            attributes.push(attribute);
        }
        let mut artifacts = Vec::new();
        for artifact in item.artifacts {
            let artifact = ArtifactRow {
                id: Uuid::new_v4(),
                org_id: ctx.org_id,
                run_id: run.id,
                kind: artifact.kind,
                name: artifact.name.clone(),
                uri: artifact.uri,
                step: artifact.step,
                size_bytes: artifact.size_bytes,
                sha256: None,
                mime_type: artifact.mime_type.or_else(|| {
                    mime_guess::from_path(&artifact.name)
                        .first_raw()
                        .map(str::to_string)
                }),
                storage_backend: "external".to_string(),
                storage_key: None,
                storage_path: None,
                metadata: artifact.metadata,
                created_at: Utc::now(),
            };
            store
                .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
                .await?;
            artifacts.push(artifact);
        }
        set_import_complete(&mut run.metadata, true);
        store
            .persist_locked("run", ctx.org_id, &run.id.to_string(), &run)
            .await?;
        {
            let mut data = store.data.lock().await;
            data.insert_run(run.clone());
            for attribute in attributes {
                data.insert_attribute(attribute);
            }
            for artifact in artifacts {
                data.insert_artifact(artifact);
            }
        }
        run_ids.push(run.id);
    }
    let summary = json!({
        "runs": run_ids.len(),
        "updated_runs": updated_run_ids.len(),
        "skipped_runs": skipped_runs,
        "metrics": committed_metrics,
        "attributes": total_attributes,
        "artifacts": total_artifacts,
    });
    let job_clone = {
        let mut data = store.data.lock().await;
        let job = data
            .imports
            .get_mut(&(ctx.org_id, import_id))
            .ok_or_else(|| AppError::not_found("import job not found"))?;
        job.project_id = Some(project.id);
        job.status = IMPORT_STATE_COMMITTED.to_string();
        job.summary = summary.clone();
        job.run_ids = run_ids.clone();
        job.progress = json!({
            "state": IMPORT_STATE_COMMITTED,
            "committed_runs": run_ids.len(),
            "updated_runs": updated_run_ids.len(),
            "skipped_runs": skipped_runs,
        });
        job.committed_batch_count = job.accepted_chunk_count;
        job.updated_at = Some(Utc::now());
        job.completed_at = Some(Utc::now());
        job.clone()
    };
    store
        .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
        .await?;
    Ok(json!({ "job": job_clone, "summary": summary }))
}

fn import_usage_delta(canonical: &CanonicalImport, project_exists: bool) -> UsageDelta {
    import_usage_delta_for_runs(&canonical.runs, project_exists)
}

fn import_usage_delta_for_runs(runs: &[CanonicalRun], project_exists: bool) -> UsageDelta {
    let run_count = runs.len() as i64;
    let metric_points = runs.iter().map(|run| run.metrics.len() as i64).sum::<i64>();
    let artifacts = runs
        .iter()
        .map(|run| run.artifacts.len() as i64)
        .sum::<i64>();
    UsageDelta {
        projects: if project_exists { 0 } else { 1 },
        runs: run_count,
        metric_points,
        storage_bytes: artifacts * ARTIFACT_METADATA_BYTES
            + run_count * RUN_METADATA_BYTES
            + if project_exists {
                0
            } else {
                PROJECT_METADATA_BYTES
            },
    }
}

#[derive(Default)]
struct CanonicalImport {
    project: String,
    runs: Vec<CanonicalRun>,
}

struct CanonicalRun {
    name: String,
    status: String,
    config: Value,
    tags: Vec<String>,
    metadata: Value,
    metrics: Vec<CanonicalMetric>,
    attributes: Vec<AttributeInput>,
    artifacts: Vec<CanonicalArtifact>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
struct CanonicalMetric {
    key: String,
    step: f64,
    value: f64,
    logged_at: DateTime<Utc>,
}

struct CanonicalArtifact {
    kind: String,
    name: String,
    uri: String,
    step: Option<f64>,
    size_bytes: Option<i64>,
    mime_type: Option<String>,
    metadata: Value,
}

fn import_empty_summary() -> Value {
    json!({
        "runs": 0,
        "metrics": 0,
        "attributes": 0,
        "artifacts": 0,
        "warnings": 0,
        "skipped_runs": 0
    })
}

fn import_job_for_ctx<'a>(
    data: &'a StoreData,
    ctx: &RequestContext,
    import_id: i64,
) -> AppResult<&'a ImportRow> {
    let job = data
        .imports
        .get(&(ctx.org_id, import_id))
        .ok_or_else(|| AppError::not_found("import job not found"))?;
    if let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        if job.project_id != Some(project_id) {
            return Err(AppError::forbidden(
                "project-scoped API key cannot access this import",
            ));
        }
    }
    Ok(job)
}

fn import_job_for_ctx_mut<'a>(
    data: &'a mut StoreData,
    ctx: &RequestContext,
    import_id: i64,
) -> AppResult<&'a mut ImportRow> {
    let job = data
        .imports
        .get_mut(&(ctx.org_id, import_id))
        .ok_or_else(|| AppError::not_found("import job not found"))?;
    if let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        if job.project_id != Some(project_id) {
            return Err(AppError::forbidden(
                "project-scoped API key cannot access this import",
            ));
        }
    }
    Ok(job)
}

fn job_chunks_locked(data: &StoreData, org_id: Uuid, import_id: i64) -> Vec<ImportChunkRow> {
    let mut chunks = data
        .import_chunks
        .values()
        .filter(|chunk| chunk.org_id == org_id && chunk.import_id == import_id)
        .cloned()
        .collect::<Vec<_>>();
    chunks.sort_by_key(|chunk| (chunk.sequence, chunk.chunk_id.clone()));
    chunks
}

fn summarize_import_job_locked(data: &StoreData, org_id: Uuid, import_id: i64) -> Value {
    let chunks = job_chunks_locked(data, org_id, import_id);
    let mut runs = 0u64;
    let mut metrics = 0u64;
    let mut attributes = 0u64;
    let mut artifacts = 0u64;
    let mut warnings = 0u64;
    for chunk in chunks {
        runs += chunk
            .summary
            .get("runs")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        metrics += chunk
            .summary
            .get("metrics")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        attributes += chunk
            .summary
            .get("attributes")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        artifacts += chunk
            .summary
            .get("artifacts")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        warnings += chunk
            .summary
            .get("warnings")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    }
    json!({
        "runs": runs,
        "metrics": metrics,
        "attributes": attributes,
        "artifacts": artifacts,
        "warnings": warnings,
        "skipped_runs": 0
    })
}

fn projected_import_summary_locked(
    data: &StoreData,
    org_id: Uuid,
    import_id: i64,
    next_summary: &Value,
) -> Value {
    let current = summarize_import_job_locked(data, org_id, import_id);
    json!({
        "runs": summary_count(&current, "runs") + summary_count(next_summary, "runs"),
        "metrics": summary_count(&current, "metrics") + summary_count(next_summary, "metrics"),
        "attributes": summary_count(&current, "attributes") + summary_count(next_summary, "attributes"),
        "artifacts": summary_count(&current, "artifacts") + summary_count(next_summary, "artifacts"),
        "warnings": summary_count(&current, "warnings") + summary_count(next_summary, "warnings"),
        "skipped_runs": 0
    })
}

fn summary_count(summary: &Value, key: &str) -> u64 {
    summary.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn validate_import_job_caps(summary: &Value) -> AppResult<()> {
    if summary_count(summary, "runs") > MAX_IMPORT_RUNS_PER_JOB {
        return Err(AppError::validation("import job has too many runs"));
    }
    if summary_count(summary, "metrics") > MAX_IMPORT_METRICS_PER_JOB {
        return Err(AppError::validation(
            "import job has too many metric points",
        ));
    }
    if summary_count(summary, "attributes") > MAX_IMPORT_ATTRIBUTES_PER_JOB {
        return Err(AppError::validation("import job has too many attributes"));
    }
    if summary_count(summary, "artifacts") > MAX_IMPORT_ARTIFACTS_PER_JOB {
        return Err(AppError::validation("import job has too many artifacts"));
    }
    Ok(())
}

fn job_warnings_locked(data: &StoreData, org_id: Uuid, import_id: i64) -> Vec<Value> {
    let mut warnings = Vec::new();
    for chunk in job_chunks_locked(data, org_id, import_id) {
        for warning in chunk
            .payload
            .get("warnings")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            if warnings.len() >= MAX_IMPORT_WARNINGS_PER_JOB {
                return warnings;
            }
            warnings.push(redact_value(warning.clone()));
        }
    }
    warnings
}

fn rebuild_import_job_from_chunks_locked(
    data: &mut StoreData,
    ctx: &RequestContext,
    import_id: i64,
    now: DateTime<Utc>,
) -> AppResult<ImportRow> {
    let chunks = job_chunks_locked(data, ctx.org_id, import_id);
    let summary = summarize_import_job_locked(data, ctx.org_id, import_id);
    let warnings = job_warnings_locked(data, ctx.org_id, import_id);
    let has_final = chunks.iter().any(|chunk| chunk.final_chunk);
    if has_final {
        let job_snapshot = import_job_for_ctx(data, ctx, import_id)?.clone();
        canonical_import_from_chunk_rows(&job_snapshot, chunks.clone())?;
    }
    let chunk_ids = chunks
        .into_iter()
        .map(|chunk| chunk.chunk_id)
        .collect::<Vec<_>>();
    let status = if has_final {
        IMPORT_STATE_DRY_RUN_READY
    } else if chunk_ids.is_empty() {
        IMPORT_STATE_CREATED
    } else {
        IMPORT_STATE_UPLOADING
    };
    let job = import_job_for_ctx_mut(data, ctx, import_id)?;
    if matches!(
        job.status.as_str(),
        IMPORT_STATE_CREATED | IMPORT_STATE_UPLOADING | IMPORT_STATE_DRY_RUN_READY
    ) {
        job.status = status.to_string();
        job.chunk_ids = chunk_ids;
        job.accepted_chunk_count = job.chunk_ids.len() as i64;
        job.summary = summary;
        job.warnings = warnings;
        job.progress = json!({
            "state": job.status,
            "chunks": job.accepted_chunk_count,
            "final_chunk_received": has_final
        });
        job.updated_at = Some(now);
    }
    Ok(job.clone())
}

fn summarize_import_chunk(chunk: &Value) -> AppResult<Value> {
    Ok(json!({
        "runs": optional_array(chunk.get("runs"), "runs")?.len(),
        "metrics": optional_array(chunk.get("metric_points"), "metric_points")?.len(),
        "attributes": optional_array(chunk.get("attributes"), "attributes")?.len(),
        "artifacts": optional_array(chunk.get("artifact_refs"), "artifact_refs")?.len(),
        "warnings": optional_array(chunk.get("warnings"), "warnings")?.len(),
    }))
}

fn validate_import_chunk_shape(chunk: &Value) -> AppResult<()> {
    let runs = optional_array(chunk.get("runs"), "runs")?;
    let metrics = optional_array(chunk.get("metric_points"), "metric_points")?;
    let attributes = optional_array(chunk.get("attributes"), "attributes")?;
    let artifacts = optional_array(chunk.get("artifact_refs"), "artifact_refs")?;
    let warnings = optional_array(chunk.get("warnings"), "warnings")?;
    if runs.len() > MAX_IMPORT_RUNS_PER_CHUNK {
        return Err(AppError::validation("too many runs in import chunk"));
    }
    if metrics.len() > MAX_IMPORT_METRICS_PER_CHUNK {
        return Err(AppError::validation(
            "too many metric points in import chunk",
        ));
    }
    if attributes.len() > MAX_IMPORT_ATTRIBUTES_PER_CHUNK {
        return Err(AppError::validation("too many attributes in import chunk"));
    }
    if artifacts.len() > MAX_IMPORT_ARTIFACTS_PER_CHUNK {
        return Err(AppError::validation(
            "too many artifact references in import chunk",
        ));
    }
    if warnings.len() > MAX_IMPORT_WARNINGS_PER_JOB {
        return Err(AppError::validation("too many warnings in import chunk"));
    }
    Ok(())
}

fn canonical_import_from_chunks_locked(
    data: &StoreData,
    ctx: &RequestContext,
    job: &ImportRow,
) -> AppResult<CanonicalImport> {
    canonical_import_from_chunk_rows(job, job_chunks_locked(data, ctx.org_id, job.id))
}

fn canonical_import_from_chunk_rows(
    job: &ImportRow,
    chunks: Vec<ImportChunkRow>,
) -> AppResult<CanonicalImport> {
    let project = job
        .target_project
        .clone()
        .ok_or_else(|| AppError::validation("import job target_project is missing"))?;
    let source_project = job
        .source_project
        .clone()
        .unwrap_or_else(|| job.source_type.clone());
    let mut runs_by_source = BTreeMap::<String, CanonicalRun>::new();
    for chunk in chunks {
        for run in optional_array(chunk.payload.get("runs"), "runs")? {
            let source_run_id = canonical_source_run_id(run)?;
            let name = validate_name(
                run.get("name")
                    .and_then(Value::as_str)
                    .or(Some(source_run_id.as_str())),
                "run name",
            )?;
            let config = redact_value(run.get("config").cloned().unwrap_or_else(|| json!({})));
            let mut metadata = validate_json_object(run.get("metadata").cloned(), "run metadata")?;
            insert_import_metadata(
                &mut metadata,
                job.id,
                &job.source_type,
                &source_project,
                &source_run_id,
            );
            runs_by_source
                .entry(source_run_id.clone())
                .or_insert(CanonicalRun {
                    name,
                    status: map_external_run_status(run.get("status").and_then(Value::as_str)),
                    config,
                    tags: import_tags(run.get("tags"), &job.source_type)?,
                    metadata,
                    metrics: Vec::new(),
                    attributes: Vec::new(),
                    artifacts: Vec::new(),
                    started_at: parse_timestamp_value(run.get("started_at"), "started_at")?,
                    finished_at: parse_timestamp_value(run.get("finished_at"), "finished_at")?,
                });
        }
        for metric in optional_array(chunk.payload.get("metric_points"), "metric_points")? {
            let source_run_id = canonical_source_run_id(metric)?;
            let run = runs_by_source
                .get_mut(&source_run_id)
                .ok_or_else(|| AppError::validation("metric source_run_id has no run entry"))?;
            run.metrics.push(metric_from_key_step_value(metric)?);
        }
        for attribute in optional_array(chunk.payload.get("attributes"), "attributes")? {
            let source_run_id = canonical_source_run_id(attribute)?;
            let run = runs_by_source
                .get_mut(&source_run_id)
                .ok_or_else(|| AppError::validation("attribute source_run_id has no run entry"))?;
            run.attributes.push(attribute_input_from_value(attribute)?);
        }
        for artifact in optional_array(chunk.payload.get("artifact_refs"), "artifact_refs")? {
            let source_run_id = canonical_source_run_id(artifact)?;
            let run = runs_by_source
                .get_mut(&source_run_id)
                .ok_or_else(|| AppError::validation("artifact source_run_id has no run entry"))?;
            run.artifacts
                .push(canonical_artifact_from_value(&job.source_type, artifact)?);
        }
    }
    Ok(CanonicalImport {
        project,
        runs: runs_by_source.into_values().collect(),
    })
}

fn canonical_source_run_id(value: &Value) -> AppResult<String> {
    validate_name(
        value
            .get("source_run_id")
            .or_else(|| value.get("external_run_id"))
            .or_else(|| value.get("run_id"))
            .and_then(Value::as_str),
        "source_run_id",
    )
}

fn import_tags(value: Option<&Value>, source_type: &str) -> AppResult<Vec<String>> {
    let mut tags = optional_string_vec(value, "tags")?;
    if !tags.iter().any(|tag| tag == "imported") {
        tags.push("imported".to_string());
    }
    if !tags.iter().any(|tag| tag == source_type) {
        tags.push(source_type.to_string());
    }
    Ok(tags)
}

fn insert_import_metadata(
    metadata: &mut Value,
    job_id: i64,
    source_type: &str,
    source_project: &str,
    external_run_id: &str,
) {
    if !metadata.is_object() {
        *metadata = json!({});
    }
    if let Some(map) = metadata.as_object_mut() {
        map.insert("source".to_string(), json!(source_type));
        map.insert(
            "import".to_string(),
            json!({
                "job_id": job_id,
                "source_type": source_type,
                "source_project": source_project,
                "external_project_id": source_project,
                "external_run_id": external_run_id
            }),
        );
    }
}

fn import_external_identity(metadata: &Value) -> Option<(String, String, String)> {
    let import = metadata.get("import")?;
    let source_type = import.get("source_type")?.as_str()?.to_string();
    let external_project_id = import
        .get("external_project_id")
        .or_else(|| import.get("source_project"))?
        .as_str()?
        .to_string();
    let external_run_id = import.get("external_run_id")?.as_str()?.to_string();
    Some((source_type, external_project_id, external_run_id))
}

fn import_source_type(metadata: &Value) -> Option<String> {
    metadata
        .get("import")
        .and_then(|import| import.get("source_type"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn import_complete_external_identity(metadata: &Value) -> Option<(String, String, String)> {
    if metadata
        .get("import")
        .and_then(|import| import.get("complete"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return None;
    }
    import_external_identity(metadata)
}

fn set_import_complete(metadata: &mut Value, complete: bool) {
    if let Some(import) = metadata.get_mut("import").and_then(Value::as_object_mut) {
        import.insert("complete".to_string(), json!(complete));
    }
}

fn has_partial_import_writes_locked(data: &StoreData, org_id: Uuid, import_id: i64) -> bool {
    if data
        .imports
        .get(&(org_id, import_id))
        .map(|job| import_partial_write_started(&job.progress))
        .unwrap_or(false)
    {
        return true;
    }
    data.runs.values().any(|run| {
        run.org_id == org_id
            && run
                .metadata
                .get("import")
                .and_then(|value| value.get("job_id"))
                .and_then(Value::as_i64)
                == Some(import_id)
    })
}

async fn mark_import_partial_write_started(
    store: &Store,
    ctx: &RequestContext,
    import_id: i64,
) -> AppResult<()> {
    let job_clone = {
        let data = store.data.lock().await;
        let mut job = import_job_for_ctx(&data, ctx, import_id)?.clone();
        if import_partial_write_started(&job.progress) {
            return Ok(());
        }
        job.progress = import_progress_with_partial_write(&job.progress, &job.status);
        job.updated_at = Some(Utc::now());
        job
    };
    store
        .persist_locked("import", ctx.org_id, &job_clone.id.to_string(), &job_clone)
        .await?;
    let mut data = store.data.lock().await;
    data.imports
        .insert((ctx.org_id, job_clone.id), job_clone.clone());
    Ok(())
}

fn import_progress_with_partial_write(progress: &Value, state: &str) -> Value {
    let mut map = progress.as_object().cloned().unwrap_or_else(Map::new);
    map.insert("state".to_string(), json!(state));
    map.insert("partial_write_started".to_string(), json!(true));
    Value::Object(map)
}

fn import_partial_write_started(progress: &Value) -> bool {
    progress
        .get("partial_write_started")
        .and_then(Value::as_bool)
        == Some(true)
}

fn validate_optional_import_text(value: Option<&str>, field: &str) -> AppResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) if text.trim().is_empty() => Ok(None),
        Some(text) => {
            if text.len() > MAX_IMPORT_STRING_BYTES {
                return Err(AppError::validation(format!("{field} is too long")));
            }
            Ok(Some(text.to_string()))
        }
    }
}

fn validate_import_string_limits(value: &Value) -> AppResult<()> {
    match value {
        Value::String(text) => {
            if text.len() > MAX_IMPORT_STRING_BYTES {
                Err(AppError::validation("import text value is too large"))
            } else {
                Ok(())
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_import_string_limits(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, item) in map {
                if key.len() > MAX_IMPORT_STRING_BYTES {
                    return Err(AppError::validation("import object key is too large"));
                }
                validate_import_string_limits(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_value).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let redacted = if secretish_key(&key) {
                        Value::String("[REDACTED]".to_string())
                    } else {
                        redact_value(value)
                    };
                    (key, redacted)
                })
                .collect(),
        ),
        other => other,
    }
}

fn secretish_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let normalized = lower
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "token"
            | "auth_token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "api_token"
            | "api_key"
            | "apikey"
            | "secret"
            | "secret_key"
            | "client_secret"
            | "password"
            | "passwd"
            | "access_key"
            | "private_key"
    ) || normalized.ends_with("_token")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("_private_key")
}

fn redact_text(text: &str) -> String {
    let mut output = text.to_string();
    let patterns = [
        r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}",
        r"(?i)(api[_-]?key|token|secret|password)=([^&\s]+)",
        r"AKIA[0-9A-Z]{16}",
        r"instantml_[A-Za-z0-9_=-]{8,}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    ];
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            output = regex.replace_all(&output, "[REDACTED]").to_string();
        }
    }
    if let Ok(regex) = Regex::new(
        r"([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|AWSAccessKeyId|X-Goog-Credential|X-Goog-Signature|X-Goog-SignedHeaders|X-Goog-Algorithm|X-Goog-Expires|sig|signature|token|access_token|se|sp|spr|sv|sr|skoid|sktid|skt|ske|sks|skv)=)[^&\s]+",
    ) {
        output = regex.replace_all(&output, "$1[REDACTED]").to_string();
    }
    output
}

fn import_content_hash(payload: &Value) -> AppResult<String> {
    let mut value = payload.clone();
    if let Some(map) = value.as_object_mut() {
        map.remove("content_hash");
    }
    let value = canonical_json_value(value);
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| AppError::validation("import chunk payload is not valid JSON"))?;
    Ok(hex_bytes(Sha256::digest(bytes)))
}

fn canonical_json_value(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonical_json_value).collect()),
        Value::Object(map) => {
            let mut entries = map.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonical_json_value(value)))
                    .collect(),
            )
        }
        other => other,
    }
}

fn hex_bytes(bytes: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = bytes.as_ref();
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn normalize_import(source: &str, raw: Value) -> AppResult<CanonicalImport> {
    match source {
        "neptune" => normalize_neptune(raw),
        "wandb" => normalize_wandb(raw),
        "mlflow" => normalize_mlflow(raw),
        _ => Err(AppError::validation("unsupported import source")),
    }
}

fn normalize_neptune(raw: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(raw.get("project").and_then(Value::as_str), "project")?;
    let runs = raw
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("runs must be an array"))?
        .iter()
        .map(|run| {
            let source_metadata =
                validate_json_object(run.get("metadata").cloned(), "neptune metadata")?;
            let external_run_id = optional_text(
                run.get("id")
                    .or_else(|| run.get("neptune_id"))
                    .or_else(|| source_metadata.get("neptune_id")),
                "external_run_id",
            )?;
            let name = validate_name(
                run.get("name")
                    .and_then(Value::as_str)
                    .or(external_run_id.as_deref()),
                "run name",
            )?;
            let external_run_id = external_run_id.unwrap_or_else(|| name.clone());
            let metrics = run
                .get("metrics")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .map(metric_from_key_step_value)
                .collect::<AppResult<Vec<_>>>()?;
            let attributes = optional_array(run.get("attributes"), "run attributes")?
                .iter()
                .map(attribute_input_from_value)
                .collect::<AppResult<Vec<_>>>()?;
            let artifacts = optional_array(run.get("artifacts"), "run artifacts")?
                .iter()
                .map(|artifact| canonical_artifact_from_value("neptune", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let tags = optional_string_vec(run.get("tags"), "tags")?;
            Ok(CanonicalRun {
                name,
                status: run
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "running" | "finished" | "failed"))
                    .unwrap_or("finished")
                    .to_string(),
                config: run.get("config").cloned().unwrap_or_else(|| json!({})),
                tags: if tags.is_empty() {
                    vec!["imported".to_string(), "neptune".to_string()]
                } else {
                    tags
                },
                metadata: json!({
                    "source": "neptune",
                    "import": {
                        "source_type": "neptune",
                        "source_project": project,
                        "external_project_id": project,
                        "external_run_id": external_run_id,
                        "complete": true,
                        "legacy": true
                    },
                    "neptune": { "run_id": external_run_id, "metadata": source_metadata }
                }),
                metrics,
                attributes,
                artifacts,
                started_at: parse_timestamp_value(run.get("started_at"), "started_at")?,
                finished_at: parse_timestamp_value(run.get("finished_at"), "finished_at")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport { project, runs })
}

fn normalize_wandb(raw: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(raw.get("project").and_then(Value::as_str), "project")?;
    let runs = raw
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("runs must be an array"))?
        .iter()
        .enumerate()
        .map(|(run_index, run)| {
            let run_id =
                optional_text(run.get("id").or_else(|| run.get("run_id")), "external_run_id")?;
            let name = validate_name(
                run.get("name")
                    .or_else(|| run.get("id"))
                    .and_then(Value::as_str),
                "run name",
            )?;
            let mut metrics = Vec::new();
            for (row_index, point) in run
                .get("history")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                let step = point
                    .get("_step")
                    .map(|value| validate_step(value, "_step"))
                    .transpose()?
                    .unwrap_or(row_index as f64);
                let timestamp = point
                    .get("_timestamp")
                    .map(|value| parse_timestamp_value(Some(value), "_timestamp"))
                    .transpose()?
                    .flatten()
                    .unwrap_or_else(Utc::now);
                for (key, value) in point.as_object().into_iter().flatten() {
                    if key.starts_with('_') {
                        continue;
                    }
                    if let Some(value) = value.as_f64() {
                        metrics.push(CanonicalMetric {
                            key: key.clone(),
                            step,
                            value,
                            logged_at: timestamp,
                        });
                    }
                }
            }
            let artifacts = optional_array(run.get("artifacts"), "wandb artifacts")?
                .iter()
                .map(|artifact| canonical_artifact_from_value("wandb", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let source_metadata =
                validate_json_object(run.get("metadata").cloned(), "wandb metadata")?;
            let summary = validate_json_object(run.get("summary").cloned(), "wandb summary")?;
            let external_run_id = run_id.clone().unwrap_or_else(|| name.clone());
            Ok(CanonicalRun {
                name: if name.is_empty() {
                    format!("wandb-run-{}", run_index + 1)
                } else {
                    name
                },
                status: map_external_run_status(
                    run.get("state")
                        .or_else(|| run.get("status"))
                        .and_then(Value::as_str),
                ),
                config: run.get("config").cloned().unwrap_or_else(|| json!({})),
                tags: optional_string_vec(run.get("tags"), "tags")?,
                metadata: json!({
                    "source": "wandb",
                    "import": {
                        "source_type": "wandb",
                        "source_project": project,
                        "external_project_id": project,
                        "external_run_id": external_run_id,
                        "complete": true,
                        "legacy": true
                    },
                    "wandb": {
                        "run_id": external_run_id,
                        "state": run.get("state").or_else(|| run.get("status")).cloned().unwrap_or(Value::Null),
                        "summary": summary,
                        "metadata": source_metadata
                    }
                }),
                metrics,
                attributes: Vec::new(),
                artifacts,
                started_at: parse_timestamp_value(run.get("started_at"), "started_at")?,
                finished_at: parse_timestamp_value(run.get("finished_at"), "finished_at")?,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport { project, runs })
}

fn normalize_mlflow(raw: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(
        raw.get("project")
            .and_then(Value::as_str)
            .or(Some("mlflow-import")),
        "project",
    )?;
    let runs = raw
        .get("runs")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("runs must be an array"))?
        .iter()
        .map(|run| {
            let info = run.get("info").unwrap_or(&Value::Null);
            let data = run.get("data").unwrap_or(&Value::Null);
            let params = key_value_object(data.get("params"), "mlflow param")?;
            let tags = key_value_object(data.get("tags"), "mlflow tag")?;
            let name = validate_name(
                info.get("run_name")
                    .or_else(|| tags.get("mlflow.runName"))
                    .or_else(|| info.get("run_id"))
                    .and_then(Value::as_str)
                    .or(Some("mlflow-run")),
                "run name",
            )?;
            let external_run_id =
                optional_text(info.get("run_id").or_else(|| info.get("run_uuid")), "external_run_id")?
                    .unwrap_or_else(|| name.clone());
            let status = match info
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("FINISHED")
            {
                "FAILED" | "KILLED" => "failed",
                "RUNNING" => "running",
                _ => "finished",
            }
            .to_string();
            let latest_metrics = data
                .get("metrics")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .map(metric_from_key_step_value)
                .collect::<AppResult<Vec<_>>>()?;
            let history_metrics = run
                .get("metric_history")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .map(metric_from_key_step_value)
                .collect::<AppResult<Vec<_>>>()?;
            let history_keys = history_metrics
                .iter()
                .map(|metric| metric.key.clone())
                .collect::<BTreeSet<_>>();
            let metrics = if history_metrics.is_empty() {
                latest_metrics.clone()
            } else {
                history_metrics
                    .into_iter()
                    .chain(
                        latest_metrics
                            .iter()
                            .filter(|metric| !history_keys.contains(&metric.key))
                            .cloned(),
                    )
                    .collect()
            };
            let artifacts = optional_array(run.get("artifacts"), "mlflow artifacts")?
                .iter()
                .filter(|artifact| artifact.get("is_dir").and_then(Value::as_bool) != Some(true))
                .map(|artifact| canonical_artifact_from_value("mlflow", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let started_at = parse_timestamp_value(info.get("start_time"), "mlflow start_time")?;
            let finished_at = parse_timestamp_value(info.get("end_time"), "mlflow end_time")?;
            Ok(CanonicalRun {
                name,
                status,
                config: params.clone(),
                tags: vec!["imported".to_string(), "mlflow".to_string()],
                metadata: json!({
                    "source": "mlflow",
                    "import": {
                        "source_type": "mlflow",
                        "source_project": project,
                        "external_project_id": project,
                        "external_run_id": external_run_id,
                        "complete": true,
                        "legacy": true
                    },
                    "mlflow": {
                        "run_id": external_run_id,
                        "run_uuid": info.get("run_uuid").or_else(|| info.get("run_id")).cloned().unwrap_or(Value::Null),
                        "experiment_id": info.get("experiment_id").cloned().unwrap_or(Value::Null),
                        "status": info.get("status").or_else(|| run.get("status")).cloned().unwrap_or(Value::Null),
                        "start_time": started_at.map(|value| value.to_rfc3339()),
                        "end_time": finished_at.map(|value| value.to_rfc3339()),
                        "artifact_uri": info.get("artifact_uri").cloned().unwrap_or(Value::Null),
                        "params": params,
                        "tags": tags,
                        "metric_history_complete": run.get("metric_history_complete").and_then(Value::as_bool) == Some(true)
                    }
                }),
                metrics,
                attributes: Vec::new(),
                artifacts,
                started_at,
                finished_at,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport { project, runs })
}

fn metric_from_key_step_value(value: &Value) -> AppResult<CanonicalMetric> {
    let key = validate_name(value.get("key").and_then(Value::as_str), "metric key")?;
    let step = value.get("step").and_then(Value::as_f64).unwrap_or(0.0);
    let metric_value = value
        .get("value")
        .and_then(Value::as_f64)
        .ok_or_else(|| AppError::validation("metric value must be a number"))?;
    let logged_at =
        parse_timestamp_value(value.get("timestamp"), "metric timestamp")?.unwrap_or_else(Utc::now);
    Ok(CanonicalMetric {
        key,
        step: validate_metric_value(step)?,
        value: validate_metric_value(metric_value)?,
        logged_at,
    })
}

fn parse_timestamp_value(value: Option<&Value>, field: &str) -> AppResult<Option<DateTime<Utc>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(validate_timestamp(Some(text))?)),
        Some(Value::Number(number)) => {
            let raw = number
                .as_f64()
                .ok_or_else(|| AppError::validation(format!("{field} must be finite")))?;
            if !raw.is_finite() {
                return Err(AppError::validation(format!("{field} must be finite")));
            }
            let millis = if raw.abs() >= 10_000_000_000.0 {
                raw.round() as i64
            } else {
                (raw * 1_000.0).round() as i64
            };
            Ok(Some(datetime_from_millis(millis)?))
        }
        _ => Err(AppError::validation(format!(
            "{field} must be epoch time or an ISO-compatible datetime"
        ))),
    }
}

fn datetime_from_millis(millis: i64) -> AppResult<DateTime<Utc>> {
    let secs = millis.div_euclid(1_000);
    let nanos = (millis.rem_euclid(1_000) as u32) * 1_000_000;
    DateTime::<Utc>::from_timestamp(secs, nanos)
        .ok_or_else(|| AppError::validation("timestamp must be within supported datetime range"))
}

fn optional_array<'a>(value: Option<&'a Value>, field: &str) -> AppResult<&'a [Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        _ => Err(AppError::validation(format!("{field} must be a list"))),
    }
}

fn object_ref<'a>(value: &'a Value, field: &str) -> AppResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| AppError::validation(format!("{field} must be an object")))
}

fn optional_text(value: Option<&Value>, field: &str) -> AppResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => validate_optional_name(Some(text), field),
        Some(other) => validate_optional_name(Some(&other.to_string()), field),
    }
}

fn optional_string_vec(value: Option<&Value>, field: &str) -> AppResult<Vec<String>> {
    optional_array(value, field)?
        .iter()
        .map(|item| validate_name(item.as_str(), field))
        .collect()
}

fn key_value_object(value: Option<&Value>, field: &str) -> AppResult<Value> {
    let mut values = Map::new();
    for candidate in optional_array(value, &format!("{field}s"))? {
        let entry = object_ref(candidate, field)?;
        let key = validate_name(
            entry.get("key").and_then(Value::as_str),
            &format!("{field} key"),
        )?;
        if values.contains_key(&key) {
            continue;
        }
        let value = entry.get("value").cloned().unwrap_or(Value::Null);
        values.insert(key, value);
    }
    Ok(Value::Object(values))
}

fn map_external_run_status(value: Option<&str>) -> String {
    match value.unwrap_or_default().to_ascii_lowercase().as_str() {
        "running" => "running",
        "failed" | "crashed" | "killed" => "failed",
        _ => "finished",
    }
    .to_string()
}

fn attribute_input_from_value(value: &Value) -> AppResult<AttributeInput> {
    let object = object_ref(value, "run attribute")?;
    let kind = validate_attribute_type(
        object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("attribute type is required"))?,
    )?;
    let path = validate_name(object.get("path").and_then(Value::as_str), "attribute path")?;
    let step = object.get("step").cloned();
    if let Some(step) = step.as_ref() {
        validate_optional_step(Some(step), "step")?;
    }
    let timestamp = object
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|raw| validate_timestamp(Some(raw)).map(|timestamp| timestamp.to_rfc3339()))
        .transpose()?;
    let value = object
        .get("value")
        .cloned()
        .ok_or_else(|| AppError::validation("attribute value is required"))?;
    let summary = object.get("summary").cloned();
    validate_json_object(summary.clone(), "attribute summary")?;
    Ok(AttributeInput {
        path,
        kind,
        step,
        timestamp,
        value,
        summary,
        artifact_id: None,
    })
}

fn canonical_artifact_from_value(source: &str, value: &Value) -> AppResult<CanonicalArtifact> {
    let object = object_ref(value, &format!("{source} artifact"))?;
    let name = object
        .get("name")
        .or_else(|| object.get("path"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("artifact name must be a non-empty string"))?;
    let external_type = object
        .get("type")
        .map(|value| optional_text(Some(value), "artifact type"))
        .transpose()?
        .flatten();
    let kind = map_external_artifact_type(external_type.as_deref(), name);
    let uri = object
        .get("uri")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "artifact uri"))
        .transpose()?
        .unwrap_or_else(|| format!("{source}://{name}"));
    let step = object
        .get("step")
        .map(|value| validate_optional_step(Some(value), "step"))
        .transpose()?
        .flatten();
    let size_bytes = object
        .get("size_bytes")
        .or_else(|| object.get("file_size"))
        .map(validate_size_bytes)
        .transpose()?;
    let mime_type = object
        .get("mime_type")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "mime_type"))
        .transpose()?;
    let mut metadata = validate_json_object(object.get("metadata").cloned(), "artifact metadata")?;
    if let Some(map) = metadata.as_object_mut() {
        if let Some(external_type) = external_type {
            map.insert("external_type".to_string(), json!(external_type));
        }
        map.insert("source".to_string(), json!(source));
    }
    Ok(CanonicalArtifact {
        kind: kind.to_string(),
        name: validate_name(Some(name), "artifact name")?,
        uri,
        step,
        size_bytes,
        mime_type,
        metadata,
    })
}

fn map_external_artifact_type(external_type: Option<&str>, name: &str) -> &'static str {
    let text = format!("{} {}", external_type.unwrap_or_default(), name).to_ascii_lowercase();
    if text.contains("checkpoint")
        || text.contains("model")
        || text.ends_with(".pt")
        || text.ends_with(".pth")
        || text.ends_with(".ckpt")
        || text.ends_with(".safetensors")
        || text.ends_with(".onnx")
    {
        "checkpoint"
    } else if text.contains("rollout")
        || text.contains("video")
        || text.ends_with(".mp4")
        || text.ends_with(".mov")
        || text.ends_with(".webm")
    {
        "rollout"
    } else {
        "file"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_neptune_preserves_metadata_attributes_artifacts_and_default_tags() {
        let import = normalize_import(
            "neptune",
            json!({
                "project": "research",
                "runs": [{
                    "id": "NPT-1",
                    "metadata": {"owner": "ml"},
                    "metrics": [{"key": "eval/return", "step": 2.0, "value": 42.0, "timestamp": "2026-05-14T00:00:00Z"}],
                    "attributes": [{"path": "config/lr", "type": "config", "value": 0.1}],
                    "artifacts": [{"name": "model.pt", "size_bytes": 128}],
                    "started_at": "2026-05-14T00:00:00Z",
                    "finished_at": "2026-05-14T00:01:00Z"
                }]
            }),
        )
        .unwrap();

        assert_eq!(import.project, "research");
        assert_eq!(import.runs.len(), 1);
        let run = &import.runs[0];
        assert_eq!(run.name, "NPT-1");
        assert_eq!(run.tags, vec!["imported", "neptune"]);
        assert_eq!(run.metrics[0].key, "eval/return");
        assert_eq!(run.attributes[0].path, "config/lr");
        assert_eq!(run.artifacts[0].kind, "checkpoint");
        assert_eq!(run.metadata["source"], "neptune");
        assert_eq!(run.metadata["import"]["source_type"], "neptune");
        assert_eq!(run.metadata["import"]["external_project_id"], "research");
        assert_eq!(run.metadata["import"]["external_run_id"], "NPT-1");
        assert_eq!(run.metadata["import"]["complete"], true);
        assert!(run.started_at.is_some());
        assert!(run.finished_at.is_some());
    }

    #[test]
    fn normalize_wandb_expands_history_points_and_artifacts() {
        let import = normalize_import(
            "wandb",
            json!({
                "project": "trainer",
                "runs": [{
                    "id": "abc123",
                    "name": "wandb-run",
                    "state": "crashed",
                    "config": {"batch_size": 32},
                    "tags": ["sweep"],
                    "summary": {"best": 9},
                    "metadata": {"host": "worker-1"},
                    "history": [
                        {"_step": 0, "_timestamp": 1778716800, "loss": 3.0, "acc": 0.1},
                        {"_step": 1, "_timestamp": 1778716801, "loss": 2.0}
                    ],
                    "artifacts": [{"name": "rollout.mp4", "type": "video", "file_size": 2048}]
                }]
            }),
        )
        .unwrap();

        let run = &import.runs[0];
        assert_eq!(run.status, "failed");
        assert_eq!(run.config["batch_size"], 32);
        assert_eq!(run.metrics.len(), 3);
        assert_eq!(run.metrics[0].step, 0.0);
        assert_eq!(run.artifacts[0].kind, "rollout");
        assert_eq!(run.artifacts[0].size_bytes, Some(2048));
        assert_eq!(run.metadata["wandb"]["summary"]["best"], 9);
        assert_eq!(run.metadata["import"]["source_type"], "wandb");
        assert_eq!(run.metadata["import"]["external_project_id"], "trainer");
        assert_eq!(run.metadata["import"]["external_run_id"], "abc123");
        assert_eq!(run.metadata["import"]["complete"], true);
    }

    #[test]
    fn normalize_mlflow_merges_history_with_latest_metrics_and_metadata() {
        let import = normalize_import(
            "mlflow",
            json!({
                "project": "mlflow-project",
                "runs": [{
                    "info": {
                        "run_id": "run-1",
                        "run_name": "candidate",
                        "status": "FINISHED",
                        "start_time": 1778716800000i64,
                        "end_time": 1778716860000i64,
                        "artifact_uri": "s3://bucket/run-1"
                    },
                    "data": {
                        "params": [{"key": "lr", "value": "0.1"}],
                        "tags": [{"key": "team", "value": "infra"}],
                        "metrics": [
                            {"key": "loss", "step": 10.0, "value": 0.5},
                            {"key": "accuracy", "step": 10.0, "value": 0.8}
                        ]
                    },
                    "metric_history": [
                        {"key": "loss", "step": 0.0, "value": 1.0},
                        {"key": "loss", "step": 1.0, "value": 0.9}
                    ],
                    "metric_history_complete": true,
                    "artifacts": [
                        {"path": "model.onnx"},
                        {"path": "plots", "is_dir": true}
                    ]
                }]
            }),
        )
        .unwrap();

        let run = &import.runs[0];
        assert_eq!(run.name, "candidate");
        assert_eq!(run.config["lr"], "0.1");
        assert_eq!(run.metrics.len(), 3);
        assert!(run.metrics.iter().any(|metric| metric.key == "accuracy"));
        assert_eq!(run.artifacts.len(), 1);
        assert_eq!(run.artifacts[0].kind, "checkpoint");
        assert_eq!(run.metadata["mlflow"]["tags"]["team"], "infra");
        assert_eq!(run.metadata["mlflow"]["metric_history_complete"], true);
        assert_eq!(run.metadata["import"]["source_type"], "mlflow");
        assert_eq!(
            run.metadata["import"]["external_project_id"],
            "mlflow-project"
        );
        assert_eq!(run.metadata["import"]["external_run_id"], "run-1");
        assert_eq!(run.metadata["import"]["complete"], true);
    }

    #[test]
    fn import_normalization_rejects_bad_sources_and_bad_shapes() {
        assert!(normalize_import("unknown", json!({})).is_err());
        assert!(normalize_import("wandb", json!({"project": "x", "runs": "bad"})).is_err());
        assert!(metric_from_key_step_value(&json!({"key": "loss", "value": "bad"})).is_err());
        assert_eq!(map_external_run_status(Some("RUNNING")), "running");
        assert_eq!(
            map_external_artifact_type(None, "weights.safetensors"),
            "checkpoint"
        );
    }

    #[test]
    fn import_v2_hash_ignores_hash_field_and_redacts_secrets() {
        let payload = json!({
            "schema_version": 2,
            "source_type": "wandb",
            "source_project": "entity/project",
            "target_project": "adoption",
            "job_id": 7,
            "chunk_id": "chunk-0",
            "sequence": 0,
            "runs": [{
                "source_run_id": "run-1",
                "name": "candidate",
                "config": {
                    "api_key": "wandb_please_do_not_keep",
                    "notes": "Authorization: bearer abcdefghijklmnopqrstuvwxyz"
                }
            }],
            "metric_points": [],
            "attributes": [],
            "artifact_refs": [],
            "warnings": [{"message": "signed https://bucket/object?X-Amz-Signature=abcdef&X-Amz-Credential=creds&X-Goog-Signature=goog&sig=azure"}],
            "final": true,
            "content_hash": "client-supplied"
        });
        let redacted = redact_value(payload);

        assert_eq!(redacted["runs"][0]["config"]["api_key"], "[REDACTED]");
        assert_eq!(
            redacted["runs"][0]["config"]["notes"],
            "Authorization: [REDACTED]"
        );
        assert_eq!(
            redacted["warnings"][0]["message"],
            "signed https://bucket/object?X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&sig=[REDACTED]"
        );

        let hash = import_content_hash(&redacted).unwrap();
        let mut same_payload = redacted.clone();
        same_payload["content_hash"] = json!("different-client-hash");
        assert_eq!(hash, import_content_hash(&same_payload).unwrap());
    }

    #[test]
    fn import_redaction_preserves_normal_ml_token_fields() {
        assert!(!secretish_key("max_tokens"));
        assert!(!secretish_key("tokenizer"));
        assert!(!secretish_key("tokens_per_second"));
        assert!(secretish_key("hf_token"));
        assert!(secretish_key("client_secret"));
    }

    #[test]
    fn import_v2_chunk_validation_enforces_bounded_batches() {
        let too_many_runs = (0..=MAX_IMPORT_RUNS_PER_CHUNK)
            .map(|index| json!({ "source_run_id": format!("run-{index}") }))
            .collect::<Vec<_>>();
        assert!(validate_import_chunk_shape(&json!({
            "runs": too_many_runs,
            "metric_points": [],
            "attributes": [],
            "artifact_refs": [],
            "warnings": []
        }))
        .is_err());

        assert!(validate_import_chunk_shape(&json!({
            "runs": [{"source_run_id": "run-1"}],
            "metric_points": [{"source_run_id": "run-1", "key": "loss", "step": 0.0, "value": 1.0}],
            "attributes": [],
            "artifact_refs": [],
            "warnings": []
        }))
        .is_ok());
    }

    #[test]
    fn import_v2_canonical_chunks_merge_runs_metrics_attributes_and_artifacts() {
        let org_id = Uuid::new_v4();
        let import_id = 9;
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: None,
        };
        let mut data = StoreData::default();
        data.imports.insert(
            (org_id, import_id),
            test_import_row(
                org_id,
                import_id,
                "wandb",
                Some("team/research"),
                "adoption",
            ),
        );
        data.import_chunks.insert(
            (org_id, import_id, "chunk-1".to_string()),
            test_chunk_row(
                org_id,
                import_id,
                "chunk-1",
                1,
                json!({
                    "schema_version": 2,
                    "source_type": "wandb",
                    "target_project": "adoption",
                    "job_id": import_id,
                    "chunk_id": "chunk-1",
                    "sequence": 1,
                    "runs": [],
                    "metric_points": [{
                        "source_run_id": "run-1",
                        "key": "eval/loss",
                        "step": 2.0,
                        "value": 0.25,
                        "timestamp": "2026-05-30T00:00:00Z"
                    }],
                    "attributes": [{"source_run_id": "run-1", "path": "config/lr", "type": "config", "value": 0.1}],
                    "artifact_refs": [{"source_run_id": "run-1", "name": "model.safetensors", "uri": "wandb://run-1/model.safetensors"}],
                    "warnings": [],
                    "final": true
                }),
            ),
        );
        data.import_chunks.insert(
            (org_id, import_id, "chunk-0".to_string()),
            test_chunk_row(
                org_id,
                import_id,
                "chunk-0",
                0,
                json!({
                    "schema_version": 2,
                    "source_type": "wandb",
                    "target_project": "adoption",
                    "job_id": import_id,
                    "chunk_id": "chunk-0",
                    "sequence": 0,
                    "runs": [{
                        "source_run_id": "run-1",
                        "name": "candidate",
                        "status": "running",
                        "config": {"token": "please-redact"},
                        "tags": ["baseline"],
                        "metadata": {"owner": "research"}
                    }],
                    "metric_points": [],
                    "attributes": [],
                    "artifact_refs": [],
                    "warnings": []
                }),
            ),
        );

        let import = canonical_import_from_chunks_locked(
            &data,
            &ctx,
            data.imports.get(&(org_id, import_id)).unwrap(),
        )
        .unwrap();

        assert_eq!(import.project, "adoption");
        assert_eq!(import.runs.len(), 1);
        let run = &import.runs[0];
        assert_eq!(run.name, "candidate");
        assert_eq!(run.status, "running");
        assert_eq!(run.config["token"], "[REDACTED]");
        assert_eq!(run.tags, vec!["baseline", "imported", "wandb"]);
        assert_eq!(run.metrics[0].key, "eval/loss");
        assert_eq!(run.attributes[0].path, "config/lr");
        assert_eq!(run.artifacts[0].kind, "checkpoint");
        assert_eq!(
            run.metadata["import"]["external_project_id"],
            "team/research"
        );
        assert_eq!(run.metadata["import"]["external_run_id"], "run-1");
    }

    #[test]
    fn import_v2_canonical_chunks_reject_orphan_metrics() {
        let org_id = Uuid::new_v4();
        let import_id = 10;
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: None,
        };
        let mut data = StoreData::default();
        let mut job = test_import_row(org_id, import_id, "tensorboard", None, "adoption");
        job.status = IMPORT_STATE_UPLOADING.to_string();
        job.progress = json!({ "state": IMPORT_STATE_UPLOADING });
        data.imports.insert((org_id, import_id), job);
        data.import_chunks.insert(
            (org_id, import_id, "chunk-0".to_string()),
            test_chunk_row(
                org_id,
                import_id,
                "chunk-0",
                0,
                json!({
                    "schema_version": 2,
                    "source_type": "tensorboard",
                    "target_project": "adoption",
                    "job_id": import_id,
                    "chunk_id": "chunk-0",
                    "sequence": 0,
                    "runs": [],
                    "metric_points": [{"source_run_id": "missing", "key": "loss", "step": 0.0, "value": 1.0}],
                    "attributes": [],
                    "artifact_refs": [],
                    "warnings": [],
                    "final": true
                }),
            ),
        );

        assert!(canonical_import_from_chunks_locked(
            &data,
            &ctx,
            data.imports.get(&(org_id, import_id)).unwrap()
        )
        .is_err());
        assert!(
            rebuild_import_job_from_chunks_locked(&mut data, &ctx, import_id, Utc::now()).is_err()
        );
        assert_ne!(
            data.imports.get(&(org_id, import_id)).unwrap().status,
            IMPORT_STATE_DRY_RUN_READY
        );
    }

    #[test]
    fn import_partial_write_progress_blocks_resumable_retry() {
        let org_id = Uuid::new_v4();
        let import_id = 11;
        let mut data = StoreData::default();
        let mut row = test_import_row(org_id, import_id, "wandb", Some("team/project"), "adoption");
        row.status = IMPORT_STATE_FAILED.to_string();
        row.progress = import_progress_with_partial_write(&row.progress, &row.status);
        data.imports.insert((org_id, import_id), row);

        assert!(has_partial_import_writes_locked(&data, org_id, import_id));
    }

    fn test_import_row(
        org_id: Uuid,
        id: i64,
        source_type: &str,
        source_project: Option<&str>,
        target_project: &str,
    ) -> ImportRow {
        ImportRow {
            id,
            org_id,
            project_id: None,
            source_type: source_type.to_string(),
            source_project: source_project.map(str::to_string),
            target_project: Some(target_project.to_string()),
            schema_version: IMPORT_V2_SCHEMA_VERSION,
            status: IMPORT_STATE_DRY_RUN_READY.to_string(),
            dedupe_policy: IMPORT_DEDUPE_SKIP_EXISTING.to_string(),
            summary: import_empty_summary(),
            warnings: Vec::new(),
            error_summary: None,
            progress: json!({ "state": IMPORT_STATE_DRY_RUN_READY }),
            run_ids: Vec::new(),
            chunk_ids: Vec::new(),
            accepted_chunk_count: 0,
            committed_batch_count: 0,
            created_by_user_id: None,
            updated_at: Some(Utc::now()),
            created_at: Utc::now(),
            completed_at: None,
        }
    }

    fn test_chunk_row(
        org_id: Uuid,
        import_id: i64,
        chunk_id: &str,
        sequence: i64,
        payload: Value,
    ) -> ImportChunkRow {
        ImportChunkRow {
            org_id,
            import_id,
            chunk_id: chunk_id.to_string(),
            sequence,
            content_hash: import_content_hash(&payload).unwrap(),
            final_chunk: payload
                .get("final")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            summary: summarize_import_chunk(&payload).unwrap(),
            payload,
            created_at: Utc::now(),
        }
    }
}
