use super::*;
use sha2::{Digest, Sha256};

const LINEAGE_CHILDREN_LIMIT: usize = 100;

#[derive(Debug)]
struct PreparedFork {
    run: RunRow,
    response_context: Value,
}

pub async fn fork_run(
    store: &Store,
    ctx: &RequestContext,
    source_run_id: Uuid,
    raw: Value,
    input: CreateRunForkRequest,
    idempotency_key: Option<String>,
    max_body_bytes: usize,
) -> AppResult<Value> {
    let request_hash = hash_idempotency(source_run_id, &raw)?;
    if let Some(key) = idempotency_key {
        let child_id = deterministic_fork_child_id(ctx.org_id, &key, &request_hash);
        store.reserve_idempotency_key(ctx.org_id, &key).await?;
        let result = async {
            {
                let data = store.data.lock().await;
                if let Some(existing) = data
                    .idempotency
                    .get(&(ctx.org_id, key.clone()))
                    .filter(|record| record.expires_at > Utc::now())
                {
                    if existing.request_hash == request_hash {
                        validate_cached_fork_response_access(&data, ctx, source_run_id, child_id)?;
                        return Ok(existing.response_json.clone());
                    }
                    return Err(AppError::conflict(
                        "idempotency key was already used with a different request body",
                    ));
                }
            }
            fork_run_once(
                store,
                ctx,
                source_run_id,
                input,
                Some((key.clone(), request_hash, child_id)),
                max_body_bytes,
            )
            .await
        }
        .await;
        store.release_idempotency_key(ctx.org_id, &key).await;
        return result;
    }
    fork_run_once(store, ctx, source_run_id, input, None, max_body_bytes).await
}

async fn fork_run_once(
    store: &Store,
    ctx: &RequestContext,
    source_run_id: Uuid,
    input: CreateRunForkRequest,
    idempotency: Option<(String, Vec<u8>, Uuid)>,
    max_body_bytes: usize,
) -> AppResult<Value> {
    let (prepared, existing_child) = {
        let data = store.data.lock().await;
        let child_id = idempotency
            .as_ref()
            .map(|(_, _, child_id)| *child_id)
            .unwrap_or_else(Uuid::new_v4);
        let prepared = prepare_fork(&data, ctx, source_run_id, input, child_id, max_body_bytes)?;
        let existing_child = data.runs.get(&prepared.run.id).cloned();
        (prepared, existing_child)
    };
    let response_run = existing_child
        .clone()
        .unwrap_or_else(|| prepared.run.clone());
    let response = fork_response(response_run, prepared.response_context.clone())?;
    if existing_child.is_none() {
        ensure_billing_write_allowed(store, ctx.org_id, "fork a run").await?;
        enforce_plan_capacity(
            store,
            ctx.org_id,
            UsageDelta {
                runs: 1,
                storage_bytes: RUN_METADATA_BYTES,
                ..UsageDelta::default()
            },
            "fork a run",
        )
        .await?;
        let mut data = store.data.lock().await;
        // The source run and checkpoint may have changed after validation. Check
        // visibility again before persisting the child record.
        fetch_run_in_data(&data, ctx, source_run_id)?;
        if let Some(artifact_id) = prepared.run.forked_from_artifact_id {
            let artifact = data
                .artifacts
                .get(&artifact_id)
                .ok_or_else(|| AppError::not_found("checkpoint artifact not found"))?;
            ensure_checkpoint_matches_source(artifact, source_run_id)?;
        }
        store
            .persist_locked(
                "run",
                ctx.org_id,
                &prepared.run.id.to_string(),
                &prepared.run,
            )
            .await?;
        data.insert_run(prepared.run.clone());
    }
    if let Some((key, request_hash, _)) = idempotency {
        let record = IdempotencyRecord {
            org_id: ctx.org_id,
            key: key.clone(),
            request_hash,
            response_json: response.clone(),
            expires_at: Utc::now() + ChronoDuration::days(7),
        };
        store
            .persist_locked("idempotency", ctx.org_id, &key, &record)
            .await?;
        store
            .data
            .lock()
            .await
            .idempotency
            .insert((ctx.org_id, key), record);
    }
    Ok(response)
}

fn deterministic_fork_child_id(org_id: Uuid, key: &str, request_hash: &[u8]) -> Uuid {
    let mut hasher = Sha256::new();
    hasher.update(b"instantml:run-fork:v1");
    hasher.update(org_id.as_bytes());
    hasher.update(key.as_bytes());
    hasher.update(request_hash);
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn validate_cached_fork_response_access(
    data: &StoreData,
    ctx: &RequestContext,
    source_run_id: Uuid,
    child_id: Uuid,
) -> AppResult<()> {
    fetch_run_in_data(data, ctx, source_run_id)?;
    let child = data
        .runs
        .get(&child_id)
        .ok_or_else(|| AppError::not_found("forked run not found"))?;
    ensure_run_access_in_data(ctx, child)
}

fn fork_response(run: RunRow, response_context: Value) -> AppResult<Value> {
    Ok(json!({
        "run": selection_run_value(run)?,
        "fork": response_context
    }))
}

fn prepare_fork(
    data: &StoreData,
    ctx: &RequestContext,
    source_run_id: Uuid,
    input: CreateRunForkRequest,
    child_id: Uuid,
    max_body_bytes: usize,
) -> AppResult<PreparedFork> {
    let source = fetch_run_in_data(data, ctx, source_run_id)?;
    let requested_step = input
        .step
        .map(|step| validate_step(&json!(step), "step"))
        .transpose()?;
    let checkpoint = input
        .checkpoint_artifact_id
        .map(|artifact_id| checkpoint_artifact(data, &source, artifact_id))
        .transpose()?;
    let checkpoint_step = checkpoint.as_ref().and_then(checkpoint_step);
    if let (Some(requested), Some(actual)) = (requested_step, checkpoint_step) {
        if (requested - actual).abs() > f64::EPSILON {
            return Err(AppError::validation(
                "step must match the checkpoint artifact step",
            ));
        }
    }
    let forked_from_step = requested_step.or(checkpoint_step);
    let inherit_config = input.inherit_config.unwrap_or(true);
    let mut config = if inherit_config {
        source.config.clone()
    } else {
        json!({})
    };
    let config_overrides = validate_json_object(input.config_overrides, "config_overrides")?;
    merge_json_object(&mut config, config_overrides, "config")?;
    let mut metadata = validate_json_object(input.metadata, "metadata")?;
    reject_reserved_metadata(&metadata)?;
    if let Some(notes) = input.notes {
        metadata
            .as_object_mut()
            .expect("validated metadata is an object")
            .insert(
                "notes".to_string(),
                json!(validate_name(Some(&notes), "notes")?),
            );
    }
    let now = Utc::now();
    let lineage = lineage_snapshot(
        &source,
        checkpoint.as_ref(),
        forked_from_step,
        inherit_config,
        now,
    );
    metadata
        .as_object_mut()
        .expect("validated metadata is an object")
        .insert("lineage".to_string(), lineage.clone());
    let default_name = default_fork_name(&source, forked_from_step);
    let name = validate_name(
        input.name.as_deref().or(Some(default_name.as_str())),
        "run name",
    )?;
    let tags = fork_tags(&source.tags, input.tags)?;
    let run = RunRow {
        id: child_id,
        org_id: ctx.org_id,
        project_id: source.project_id,
        project: source.project.clone(),
        name,
        status: "running".to_string(),
        config,
        tags,
        metadata,
        created_at: now,
        started_at: now,
        finished_at: None,
        parent_run_id: Some(source.id),
        forked_from_step,
        forked_from_artifact_id: checkpoint.as_ref().map(|artifact| artifact.id),
    };
    validate_final_fork_size(&run, max_body_bytes)?;
    Ok(PreparedFork {
        run,
        response_context: json!({
            "parent_run_id": source.id,
            "forked_from_step": forked_from_step,
            "forked_from_artifact_id": checkpoint.as_ref().map(|artifact| artifact.id),
            "message": "InstantML created a linked run record. It did not start training."
        }),
    })
}

fn checkpoint_artifact(
    data: &StoreData,
    source: &RunRow,
    artifact_id: Uuid,
) -> AppResult<ArtifactRow> {
    let artifact = data
        .artifacts
        .get(&artifact_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("checkpoint artifact not found"))?;
    ensure_checkpoint_matches_source(&artifact, source.id)?;
    if artifact.org_id != source.org_id {
        return Err(AppError::not_found("checkpoint artifact not found"));
    }
    Ok(artifact)
}

fn ensure_checkpoint_matches_source(artifact: &ArtifactRow, source_run_id: Uuid) -> AppResult<()> {
    if artifact.run_id != source_run_id {
        return Err(AppError::not_found("checkpoint artifact not found"));
    }
    if artifact.kind != "checkpoint" {
        return Err(AppError::validation(
            "checkpoint_artifact_id must reference a checkpoint artifact",
        ));
    }
    Ok(())
}

fn checkpoint_step(artifact: &ArtifactRow) -> Option<f64> {
    artifact.step.or_else(|| {
        artifact
            .metadata
            .get("checkpoint")
            .and_then(Value::as_object)
            .and_then(|checkpoint| checkpoint.get("step"))
            .and_then(Value::as_f64)
            .filter(|step| step.is_finite() && *step >= 0.0)
    })
}

fn merge_json_object(target: &mut Value, overrides: Value, field: &str) -> AppResult<()> {
    let target = target
        .as_object_mut()
        .ok_or_else(|| AppError::validation(format!("{field} must be an object")))?;
    let overrides = overrides
        .as_object()
        .ok_or_else(|| AppError::validation(format!("{field} overrides must be an object")))?;
    for (key, value) in overrides {
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn reject_reserved_metadata(metadata: &Value) -> AppResult<()> {
    let object = metadata
        .as_object()
        .ok_or_else(|| AppError::validation("metadata must be an object"))?;
    for key in [
        "lineage",
        "parent_run_id",
        "forked_from_step",
        "forked_from_artifact_id",
    ] {
        if object.contains_key(key) {
            return Err(AppError::validation(format!(
                "metadata.{key} is reserved for run lineage"
            )));
        }
    }
    Ok(())
}

fn lineage_snapshot(
    source: &RunRow,
    checkpoint: Option<&ArtifactRow>,
    forked_from_step: Option<f64>,
    inherit_config: bool,
    created_at: DateTime<Utc>,
) -> Value {
    json!({
        "kind": "fork",
        "source_run_id": source.id,
        "source_project": source.project.clone(),
        "source_run_name": source.name.clone(),
        "source_step": forked_from_step,
        "checkpoint_artifact_id": checkpoint.map(|artifact| artifact.id),
        "checkpoint_name": checkpoint.map(|artifact| artifact.name.clone()),
        "checkpoint_step": checkpoint.and_then(checkpoint_step),
        "inherit_config": inherit_config,
        "created_at": created_at
    })
}

fn default_fork_name(source: &RunRow, step: Option<f64>) -> String {
    match step {
        Some(step) => format!("fork-of-{}-step-{}", source.name, compact_step(step)),
        None => format!("fork-of-{}", source.name),
    }
}

fn compact_step(step: f64) -> String {
    if step.fract() == 0.0 {
        format!("{}", step as i64)
    } else {
        format!("{step}")
    }
}

fn fork_tags(source_tags: &[String], requested: Option<Vec<String>>) -> AppResult<Vec<String>> {
    let mut tags = source_tags.to_vec();
    if let Some(requested) = requested {
        tags.extend(requested);
    }
    tags.push("forked".to_string());
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    for tag in validate_tags(Some(tags))? {
        if seen.insert(tag.clone()) {
            output.push(tag);
        }
    }
    Ok(output)
}

fn validate_final_fork_size(run: &RunRow, max_body_bytes: usize) -> AppResult<()> {
    let payload = json!({
        "config": &run.config,
        "metadata": &run.metadata,
    });
    let size = serde_json::to_vec(&payload)
        .map_err(|_| AppError::validation("fork payload must be valid JSON"))?
        .len();
    if size > max_body_bytes {
        Err(AppError::validation(
            "fork config and metadata exceed the request body limit",
        ))
    } else {
        Ok(())
    }
}

pub async fn run_lineage(store: &Store, ctx: &RequestContext, run_id: Uuid) -> AppResult<Value> {
    let (run, parent, children, children_total, checkpoint) = {
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        let parent = run
            .parent_run_id
            .and_then(|parent_id| data.runs.get(&parent_id).cloned())
            .filter(|candidate| ensure_run_access_in_data(ctx, candidate).is_ok());
        let mut children = Vec::new();
        let mut children_total = 0_usize;
        for ((org_id, parent_id, _, child_id), _) in data.runs_by_parent_created.iter().rev() {
            if *org_id != ctx.org_id || *parent_id != run.id {
                continue;
            }
            let Some(child) = data.runs.get(child_id).cloned() else {
                continue;
            };
            if ensure_run_access_in_data(ctx, &child).is_err() {
                continue;
            }
            children_total += 1;
            if children.len() < LINEAGE_CHILDREN_LIMIT {
                children.push(child);
            }
        }
        let checkpoint = run
            .forked_from_artifact_id
            .and_then(|artifact_id| data.artifacts.get(&artifact_id).cloned())
            .filter(|artifact| {
                artifact.org_id == ctx.org_id
                    && artifact.kind == "checkpoint"
                    && run.parent_run_id == Some(artifact.run_id)
            });
        (run, parent, children, children_total, checkpoint)
    };
    let mut summary_inputs = Vec::with_capacity(1 + parent.is_some() as usize + children.len());
    summary_inputs.push(run.clone());
    if let Some(parent) = &parent {
        summary_inputs.push(parent.clone());
    }
    summary_inputs.extend(children.iter().cloned());
    let mut summaries = summarize_runs(store, summary_inputs).await?.into_iter();
    let run_summary = summaries
        .next()
        .ok_or_else(|| AppError::internal("lineage run summary missing"))?;
    let parent_summary = if parent.is_some() {
        Some(
            summaries
                .next()
                .ok_or_else(|| AppError::internal("lineage parent summary missing"))?,
        )
    } else {
        None
    };
    let child_summaries = summaries.collect::<Vec<_>>();
    Ok(json!({
        "run": run_summary,
        "parent": parent_summary,
        "children": child_summaries,
        "checkpoint_artifact": checkpoint.map(|artifact| artifact.public_row()),
        "children_total": children_total,
        "has_more_children": children_total > LINEAGE_CHILDREN_LIMIT,
        "limit": LINEAGE_CHILDREN_LIMIT
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_run(id: u128, project_id: u128, name: &str) -> RunRow {
        RunRow {
            id: Uuid::from_u128(id),
            org_id: Uuid::from_u128(1),
            project_id: Uuid::from_u128(project_id),
            project: "project".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({"lr": 0.01, "seed": 1}),
            tags: vec!["baseline".to_string()],
            metadata: json!({}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: Some(epoch()),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        }
    }

    #[test]
    fn prepare_fork_derives_step_and_merges_config() {
        let ctx = RequestContext::local();
        let source = test_run(10, 20, "source");
        let checkpoint = ArtifactRow {
            id: Uuid::from_u128(30),
            org_id: source.org_id,
            run_id: source.id,
            kind: "checkpoint".to_string(),
            name: "ckpt-120".to_string(),
            uri: "file:///tmp/ckpt".to_string(),
            step: Some(120.0),
            size_bytes: None,
            sha256: None,
            mime_type: None,
            storage_backend: "external".to_string(),
            storage_key: None,
            storage_path: None,
            metadata: json!({}),
            created_at: epoch(),
        };
        let mut data = StoreData::default();
        data.insert_run(source.clone());
        data.insert_artifact(checkpoint.clone());

        let fork = prepare_fork(
            &data,
            &ctx,
            source.id,
            CreateRunForkRequest {
                name: None,
                step: None,
                checkpoint_artifact_id: Some(checkpoint.id),
                inherit_config: Some(true),
                config_overrides: Some(json!({"lr": 0.02})),
                tags: Some(vec!["retry".to_string()]),
                notes: Some("Retry from checkpoint".to_string()),
                metadata: Some(json!({"reason": "nan"})),
            },
            Uuid::from_u128(40),
            1024 * 1024,
        )
        .unwrap();

        assert_eq!(fork.run.parent_run_id, Some(source.id));
        assert_eq!(fork.run.forked_from_step, Some(120.0));
        assert_eq!(fork.run.forked_from_artifact_id, Some(checkpoint.id));
        assert_eq!(fork.run.config["lr"], json!(0.02));
        assert_eq!(fork.run.config["seed"], json!(1));
        assert!(fork.run.tags.contains(&"baseline".to_string()));
        assert!(fork.run.tags.contains(&"retry".to_string()));
        assert!(fork.run.tags.contains(&"forked".to_string()));
        assert_eq!(
            fork.run.metadata["lineage"]["source_run_id"],
            json!(source.id)
        );
        assert_eq!(fork.run.metadata["notes"], json!("Retry from checkpoint"));
    }

    #[test]
    fn prepare_fork_rejects_checkpoint_step_mismatch() {
        let ctx = RequestContext::local();
        let source = test_run(10, 20, "source");
        let checkpoint = ArtifactRow {
            id: Uuid::from_u128(30),
            org_id: source.org_id,
            run_id: source.id,
            kind: "checkpoint".to_string(),
            name: "ckpt-120".to_string(),
            uri: "file:///tmp/ckpt".to_string(),
            step: Some(120.0),
            size_bytes: None,
            sha256: None,
            mime_type: None,
            storage_backend: "external".to_string(),
            storage_key: None,
            storage_path: None,
            metadata: json!({}),
            created_at: epoch(),
        };
        let mut data = StoreData::default();
        data.insert_run(source.clone());
        data.insert_artifact(checkpoint.clone());

        let error = prepare_fork(
            &data,
            &ctx,
            source.id,
            CreateRunForkRequest {
                name: None,
                step: Some(121.0),
                checkpoint_artifact_id: Some(checkpoint.id),
                inherit_config: None,
                config_overrides: None,
                tags: None,
                notes: None,
                metadata: None,
            },
            Uuid::from_u128(40),
            1024 * 1024,
        )
        .unwrap_err();

        assert_eq!(
            error.message(),
            "step must match the checkpoint artifact step"
        );
    }

    #[test]
    fn cached_fork_response_rechecks_project_scope() {
        let org_id = Uuid::from_u128(1);
        let project_id = Uuid::from_u128(20);
        let source = test_run(10, project_id.as_u128(), "source");
        let mut child = test_run(40, project_id.as_u128(), "child");
        child.parent_run_id = Some(source.id);
        let mut data = StoreData::default();
        data.insert_run(source.clone());
        data.insert_run(child.clone());
        let scoped_ctx = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(50),
                service_account_id: Uuid::from_u128(60),
                project_id: Some(project_id),
                scopes: vec![],
            }),
            session: None,
        };
        let wrong_project_ctx = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(51),
                service_account_id: Uuid::from_u128(61),
                project_id: Some(Uuid::from_u128(99)),
                scopes: vec![],
            }),
            session: None,
        };

        assert!(
            validate_cached_fork_response_access(&data, &scoped_ctx, source.id, child.id).is_ok()
        );
        assert!(validate_cached_fork_response_access(
            &data,
            &wrong_project_ctx,
            source.id,
            child.id
        )
        .is_err());
    }
}
