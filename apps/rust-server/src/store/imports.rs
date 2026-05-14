use super::*;

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

pub async fn import_payload(
    store: &Store,
    ctx: &RequestContext,
    source: &str,
    dry_run: bool,
    raw: Value,
) -> AppResult<Value> {
    let canonical = normalize_import(source, raw)?;
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
        status: "completed".to_string(),
        summary: summary.clone(),
        run_ids: run_ids.clone(),
        created_at: Utc::now(),
        completed_at: Some(Utc::now()),
    };
    store
        .persist_locked("import", ctx.org_id, &import.id.to_string(), &import)
        .await?;
    data.imports.insert((ctx.org_id, import.id), import.clone());
    Ok(json!({ "dry_run": false, "summary": summary, "import": import }))
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
                    "wandb": {
                        "run_id": run_id,
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
                    "mlflow": {
                        "run_id": info.get("run_id").or_else(|| info.get("run_uuid")).cloned().unwrap_or(Value::Null),
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
}
