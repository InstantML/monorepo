use super::*;

type ImportMetricBatch = (f64, DateTime<Utc>, Vec<String>, Vec<f64>);

pub async fn import_payload(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    source_type: &str,
    dry_run: bool,
    payload: Value,
) -> AppResult<Value> {
    let canonical = normalize_import(source_type, payload)?;
    let summary = summarize_canonical_import(&canonical);
    if dry_run {
        return Ok(json!({ "dry_run": true, "summary": summary }));
    }
    let mut tx = pool.begin().await?;
    let project = create_project_inner_tx(&mut tx, ctx.org_id, &canonical.project, None).await?;
    ensure_project_access(ctx, project.id)?;
    let mut run_ids = Vec::new();
    for run in canonical.runs {
        let created = insert_import_run_tx(
            &mut tx,
            ctx.org_id,
            project.id,
            &canonical.project,
            &canonical.source_type,
            &run,
        )
        .await?;
        insert_import_metrics(metric_store, ctx.org_id, created.id, &run.metrics).await?;
        update_imported_run_status_tx(&mut tx, ctx.org_id, created.id, &run).await?;
        for attribute in run.attributes {
            insert_attribute_input_tx(&mut tx, ctx.org_id, created.id, attribute).await?;
        }
        for artifact in run.artifacts {
            let artifact =
                insert_import_artifact_tx(&mut tx, ctx.org_id, created.id, artifact).await?;
            insert_artifact_attribute_tx(&mut tx, ctx.org_id, created.id, &artifact, None).await?;
        }
        run_ids.push(created.id);
    }
    let import = sqlx::query(
        r#"
        insert into imports (org_id, project_id, source_type, status, summary, run_ids, completed_at)
        values ($1, $2, $3, 'completed', $4, $5, now())
        returning id, org_id, project_id, source_type, status, summary, run_ids, created_at, completed_at
        "#,
    )
    .bind(ctx.org_id)
    .bind(project.id)
    .bind(&canonical.source_type)
    .bind(Json(summary.clone()))
    .bind(&run_ids)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({
        "dry_run": false,
        "import": import_row_value(&import)?,
        "summary": summary
    }))
}

async fn insert_import_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    project_id: Uuid,
    project_name: &str,
    source_type: &str,
    run: &CanonicalRun,
) -> AppResult<RunRow> {
    let run_name = validate_name(Some(&run.name), "run name")?;
    let project_name = validate_name(Some(project_name), "project name")?;
    let config = validate_json_object(Some(run.config.clone()), "run config")?;
    let tags = validate_tags(Some(run.tags.clone()))?;
    let metadata = canonical_run_metadata(source_type, run)?;
    let row = sqlx::query_as::<_, RunRow>(
        r#"
        insert into runs (org_id, project_id, name, config, tags, metadata)
        values ($1, $2, $3, $4, $5, $6)
        returning id, org_id, project_id, $7::text as project, name, status, config, tags, metadata,
                  created_at, started_at, finished_at
        "#,
    )
    .bind(org_id)
    .bind(project_id)
    .bind(run_name)
    .bind(Json(config.clone()))
    .bind(&tags)
    .bind(Json(metadata))
    .bind(project_name)
    .fetch_one(&mut **tx)
    .await?;
    for (key, value) in config.as_object().into_iter().flatten() {
        insert_attribute_tx(
            tx,
            org_id,
            row.id,
            &format!("config/{key}"),
            "config",
            None,
            None,
            value.clone(),
            json!({ "source": "run.config" }),
            None,
        )
        .await?;
    }
    for tag in &tags {
        insert_attribute_tx(
            tx,
            org_id,
            row.id,
            "sys/tags",
            "tag",
            None,
            None,
            json!(tag),
            json!({ "group": false }),
            None,
        )
        .await?;
    }
    Ok(row)
}

async fn insert_import_metrics(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_id: Uuid,
    metrics: &[CanonicalMetric],
) -> AppResult<()> {
    let mut batches: Vec<ImportMetricBatch> = Vec::new();
    for metric in metrics {
        let key = validate_name(Some(&metric.key), "metric key")?;
        let step = validate_step(&json!(metric.step), "step")?;
        let value = validate_metric_value(metric.value)?;
        let timestamp = match metric.timestamp.as_deref() {
            Some(raw) => validate_timestamp(Some(raw))?,
            None => Utc::now(),
        };
        if let Some((_, _, keys, values)) =
            batches
                .iter_mut()
                .find(|(existing_step, existing_timestamp, existing_keys, _)| {
                    *existing_step == step
                        && *existing_timestamp == timestamp
                        && !existing_keys
                            .iter()
                            .any(|existing_key| existing_key == &key)
                })
        {
            keys.push(key);
            values.push(value);
        } else {
            batches.push((step, timestamp, vec![key], vec![value]));
        }
    }
    let mut rows: Vec<ChMetricPointRow> = Vec::new();
    for (step, timestamp, keys, values) in &batches {
        rows.extend(build_metric_point_rows_from_pairs(
            org_id, run_id, *step, *timestamp, keys, values,
        ));
    }
    metric_store.insert_points(&rows).await?;
    Ok(())
}

async fn insert_import_artifact_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    input: CreateArtifactRequest,
) -> AppResult<ArtifactRow> {
    let kind = validate_artifact_type(input.kind.as_deref().unwrap_or("file"))?;
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let uri = validate_name(input.uri.as_deref(), "artifact uri")?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let size_bytes = input
        .size_bytes
        .as_ref()
        .map(validate_size_bytes)
        .transpose()?;
    let sha256 = input
        .sha256
        .map(|value| validate_name(Some(&value), "sha256"))
        .transpose()?;
    let mime_type = input
        .mime_type
        .map(|value| validate_name(Some(&value), "mime_type"))
        .transpose()?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    insert_artifact_tx(
        tx,
        ArtifactInsert {
            org_id,
            run_id,
            kind: &kind,
            name: &name,
            uri: &uri,
            step,
            size_bytes,
            sha256,
            mime_type,
            storage_key: None,
            storage_path: None,
            metadata,
        },
    )
    .await
}

async fn update_imported_run_status_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    run: &CanonicalRun,
) -> AppResult<()> {
    let status = validate_status(&run.status)?;
    sqlx::query(
        r#"
        update runs
        set status = $3,
            started_at = coalesce($4, started_at),
            finished_at = case
              when $3 in ('finished', 'failed') then coalesce($5, finished_at, now())
              else null
            end
        where org_id = $1 and id = $2
        "#,
    )
    .bind(org_id)
    .bind(run_id)
    .bind(status)
    .bind(run.started_at)
    .bind(run.finished_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn canonical_run_metadata(source_type: &str, run: &CanonicalRun) -> AppResult<Value> {
    let mut metadata = validate_json_object(Some(run.metadata.clone()), "run metadata")?;
    let object = metadata
        .as_object_mut()
        .expect("validate_json_object guarantees an object");
    object.insert(
        "import".to_string(),
        json!({
            "source_type": source_type,
            "external_run_id": run.external_run_id,
        }),
    );
    Ok(metadata)
}

fn summarize_canonical_import(canonical: &CanonicalImport) -> Value {
    let mut summary = Map::from_iter([
        ("project".to_string(), json!(canonical.project)),
        ("runs".to_string(), json!(canonical.runs.len())),
        (
            "metrics".to_string(),
            json!(canonical
                .runs
                .iter()
                .map(|run| run.metrics.len())
                .sum::<usize>()),
        ),
        (
            "attributes".to_string(),
            json!(canonical
                .runs
                .iter()
                .map(|run| run.attributes.len())
                .sum::<usize>()),
        ),
        (
            "artifacts".to_string(),
            json!(canonical
                .runs
                .iter()
                .map(|run| run.artifacts.len())
                .sum::<usize>()),
        ),
    ]);
    if let Some(extra) = canonical.summary.as_object() {
        for (key, value) in extra {
            summary.insert(key.clone(), value.clone());
        }
    }
    Value::Object(summary)
}

pub async fn list_imports(pool: &PgPool, ctx: &RequestContext) -> AppResult<Value> {
    let restricted_project_id = ctx.auth.as_ref().and_then(|auth| auth.project_id);
    let rows = sqlx::query(
        r#"
        select id, org_id, project_id, source_type, status, summary, run_ids, created_at, completed_at
        from imports
        where org_id = $1
          and ($3::uuid is null or project_id = $3)
        order by created_at desc
        limit $2
        "#,
    )
    .bind(ctx.org_id)
    .bind(MAX_IMPORT_LIST)
    .bind(restricted_project_id)
    .fetch_all(pool)
    .await?;
    let imports = rows
        .iter()
        .map(import_row_value)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(json!({ "imports": imports }))
}

#[derive(Debug)]
struct CanonicalImport {
    source_type: String,
    project: String,
    runs: Vec<CanonicalRun>,
    summary: Value,
}

#[derive(Debug)]
struct CanonicalRun {
    name: String,
    status: String,
    config: Value,
    tags: Vec<String>,
    metadata: Value,
    metrics: Vec<CanonicalMetric>,
    attributes: Vec<AttributeInput>,
    artifacts: Vec<CreateArtifactRequest>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    external_run_id: Option<String>,
}

#[derive(Debug, Clone)]
struct CanonicalMetric {
    key: String,
    step: f64,
    value: f64,
    timestamp: Option<String>,
}

fn normalize_import(source_type: &str, payload: Value) -> AppResult<CanonicalImport> {
    match source_type {
        "neptune" => normalize_neptune(payload),
        "wandb" => normalize_wandb(payload),
        "mlflow" => normalize_mlflow(payload),
        _ => Err(AppError::not_found("route not found")),
    }
}

fn normalize_neptune(payload: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(
        payload.get("project").and_then(Value::as_str),
        "project name",
    )?;
    let runs = required_array(payload.get("runs"), "runs")?
        .iter()
        .enumerate()
        .map(|(index, run)| {
            let run = object_ref(run, "neptune run")?;
            let metadata = object_or_empty(run.get("metadata"), "neptune metadata")?;
            let neptune_id = optional_text(
                run.get("id")
                    .or_else(|| run.get("neptune_id"))
                    .or_else(|| metadata.get("neptune_id")),
                "external_run_id",
            )?;
            let name = validate_name(
                run.get("name")
                    .and_then(Value::as_str)
                    .or(neptune_id.as_deref())
                    .or(Some(&format!("imported-run-{}", index + 1))),
                "run name",
            )?;
            let metrics = optional_array(run.get("metrics"), "run metrics")?
                .iter()
                .map(|metric| metric_from_value(metric, 0.0, "run metric"))
                .collect::<AppResult<Vec<_>>>()?;
            let attributes = optional_array(run.get("attributes"), "run attributes")?
                .iter()
                .map(attribute_input_from_value)
                .collect::<AppResult<Vec<_>>>()?;
            let artifacts = optional_array(run.get("artifacts"), "run artifacts")?
                .iter()
                .map(artifact_request_from_value)
                .collect::<AppResult<Vec<_>>>()?;
            Ok(CanonicalRun {
                name,
                status: run
                    .get("status")
                    .and_then(Value::as_str)
                    .filter(|status| matches!(*status, "running" | "finished" | "failed"))
                    .unwrap_or("finished")
                    .to_string(),
                config: object_or_empty(run.get("config"), "run config")?,
                tags: optional_string_vec(run.get("tags"), "tags")?,
                metadata: json!({ "neptune": { "run_id": neptune_id, "metadata": metadata } }),
                metrics,
                attributes,
                artifacts,
                started_at: optional_timestamp(run.get("started_at"), "started_at")?,
                finished_at: optional_timestamp(run.get("finished_at"), "finished_at")?,
                external_run_id: neptune_id,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport {
        source_type: "neptune_exporter_json".to_string(),
        project,
        runs,
        summary: json!({}),
    })
}

fn normalize_wandb(payload: Value) -> AppResult<CanonicalImport> {
    let project = validate_name(
        payload.get("project").and_then(Value::as_str),
        "project name",
    )?;
    let runs = required_array(payload.get("runs"), "runs")?
        .iter()
        .enumerate()
        .map(|(index, run)| {
            let run = object_ref(run, "wandb run")?;
            let run_id = optional_text(run.get("id").or_else(|| run.get("run_id")), "external_run_id")?;
            let name = validate_name(
                run.get("name")
                    .and_then(Value::as_str)
                    .or(run_id.as_deref())
                    .or(Some(&format!("wandb-run-{}", index + 1))),
                "run name",
            )?;
            let mut metrics = Vec::new();
            for (row_index, item) in optional_array(run.get("history"), "wandb history")?
                .iter()
                .enumerate()
            {
                let item = object_ref(item, "wandb history rows")?;
                let step = item
                    .get("_step")
                    .map(|value| validate_step(value, "_step"))
                    .transpose()?
                    .unwrap_or(row_index as f64);
                let timestamp = external_timestamp(item.get("_timestamp"))?;
                for (key, value) in item {
                    if key.starts_with('_')
                        || value.is_null()
                        || value.as_str().map(str::trim) == Some("")
                        || value.is_boolean()
                    {
                        continue;
                    }
                    if let Some(value) = value.as_f64() {
                        if value.is_finite() {
                            metrics.push(CanonicalMetric {
                                key: validate_name(Some(key), "metric key")?,
                                step,
                                value,
                                timestamp: timestamp.clone(),
                            });
                        }
                    }
                }
            }
            let artifacts = optional_array(run.get("artifacts"), "wandb artifacts")?
                .iter()
                .map(|artifact| normalize_external_artifact("wandb", artifact))
                .collect::<AppResult<Vec<_>>>()?;
            let metadata = object_or_empty(run.get("metadata"), "wandb metadata")?;
            let summary = object_or_empty(run.get("summary"), "wandb summary")?;
            Ok(CanonicalRun {
                name,
                status: map_external_run_status(
                    run.get("state")
                        .or_else(|| run.get("status"))
                        .and_then(Value::as_str),
                ),
                config: object_or_empty(run.get("config"), "run config")?,
                tags: optional_string_vec(run.get("tags"), "tags")?,
                metadata: json!({
                    "wandb": {
                        "run_id": run_id,
                        "state": run.get("state").or_else(|| run.get("status")).cloned().unwrap_or(Value::Null),
                        "summary": summary,
                        "metadata": metadata
                    }
                }),
                metrics,
                attributes: Vec::new(),
                artifacts,
                started_at: optional_timestamp(run.get("started_at"), "started_at")?,
                finished_at: optional_timestamp(run.get("finished_at"), "finished_at")?,
                external_run_id: run_id,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(CanonicalImport {
        source_type: "wandb_json".to_string(),
        project,
        runs,
        summary: json!({}),
    })
}

fn normalize_mlflow(payload: Value) -> AppResult<CanonicalImport> {
    validate_import_schema_version(payload.get("schema_version"))?;
    let project = validate_name(
        payload.get("project").and_then(Value::as_str),
        "project name",
    )?;
    let mut warnings = Vec::new();
    let mut skipped_artifact_directories = 0_i64;
    let runs = required_array(payload.get("runs"), "runs")?
        .iter()
        .enumerate()
        .map(|(index, run)| {
            let run = object_ref(run, "mlflow run")?;
            let info = object_or_empty(run.get("info"), "mlflow info")?;
            let data = object_or_empty(run.get("data"), "mlflow data")?;
            let params = key_value_object(data.get("params"), "mlflow param", false)?;
            let tags = key_value_object(data.get("tags"), "mlflow tag", true)?;
            let run_id = optional_text(
                info.get("run_id")
                    .or_else(|| info.get("run_uuid"))
                    .or_else(|| run.get("run_id")),
                "external_run_id",
            )?;
            let run_uuid = optional_text(info.get("run_uuid").or_else(|| info.get("run_id")), "run_uuid")?;
            let experiment_id = optional_text(info.get("experiment_id"), "experiment_id")?;
            let status = map_mlflow_status(
                info.get("status")
                    .or_else(|| run.get("status"))
                    .and_then(Value::as_str),
            )?;
            let started_at = mlflow_timestamp(info.get("start_time"), "mlflow start_time")?;
            let finished_at = mlflow_timestamp(info.get("end_time"), "mlflow end_time")?;
            let latest_metrics =
                mlflow_metrics(data.get("metrics"), "mlflow latest metric")?;
            let history_metrics =
                mlflow_metrics(run.get("metric_history"), "mlflow history metric")?;
            let history_keys = history_metrics
                .iter()
                .map(|metric| metric.key.clone())
                .collect::<BTreeSet<_>>();
            let fallback_metrics = latest_metrics
                .iter()
                .filter(|metric| !history_keys.contains(&metric.key))
                .cloned()
                .collect::<Vec<_>>();
            if run.get("metric_history_complete").and_then(Value::as_bool) != Some(true) {
                warnings.push(format!(
                    "mlflow run {} metric history may be incomplete; latest metrics were used only for missing keys",
                    run_id.as_deref().unwrap_or(&format!("{}", index + 1))
                ));
            }
            let artifact_root = optional_text(
                run.get("artifact_root_uri")
                    .or_else(|| info.get("artifact_uri")),
                "artifact root uri",
            )?;
            let mut artifacts = Vec::new();
            for artifact in optional_array(run.get("artifacts"), "mlflow artifacts")? {
                if let Some(artifact) = normalize_mlflow_artifact(
                    artifact,
                    artifact_root.as_deref(),
                    &mut skipped_artifact_directories,
                )? {
                    artifacts.push(artifact);
                }
            }
            let name = validate_name(
                info.get("run_name")
                    .and_then(Value::as_str)
                    .or_else(|| tags.get("mlflow.runName").and_then(Value::as_str))
                    .or(run_id.as_deref())
                    .or(Some(&format!("mlflow-run-{}", index + 1))),
                "run name",
            )?;
            let metrics = history_metrics
                .into_iter()
                .chain(fallback_metrics.into_iter())
                .collect::<Vec<_>>();
            Ok(CanonicalRun {
                name,
                status,
                config: params.clone(),
                tags: Vec::new(),
                metadata: json!({
                    "mlflow": {
                        "run_id": run_id,
                        "run_uuid": run_uuid,
                        "experiment_id": experiment_id,
                        "status": info.get("status").or_else(|| run.get("status")).cloned().unwrap_or(Value::Null),
                        "start_time": started_at.map(|value| value.to_rfc3339()),
                        "end_time": finished_at.map(|value| value.to_rfc3339()),
                        "artifact_uri": info.get("artifact_uri").cloned().unwrap_or(Value::Null),
                        "params": params,
                        "tags": tags,
                        "latest_metrics": latest_metrics_by_key(&latest_metrics),
                        "metric_history_complete": run.get("metric_history_complete").and_then(Value::as_bool) == Some(true)
                    }
                }),
                metrics,
                attributes: Vec::new(),
                artifacts,
                started_at,
                finished_at,
                external_run_id: run_id,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let mut summary = Map::new();
    if !warnings.is_empty() {
        summary.insert("warnings".to_string(), json!(warnings));
    }
    if skipped_artifact_directories > 0 {
        summary.insert(
            "skipped".to_string(),
            json!({ "artifact_directories": skipped_artifact_directories }),
        );
    }
    Ok(CanonicalImport {
        source_type: "mlflow_json".to_string(),
        project,
        runs,
        summary: Value::Object(summary),
    })
}

fn metric_from_value(metric: &Value, default_step: f64, field: &str) -> AppResult<CanonicalMetric> {
    let metric = object_ref(metric, field)?;
    let step = metric
        .get("step")
        .map(|value| validate_step(value, "step"))
        .transpose()?
        .unwrap_or(default_step);
    let value = metric
        .get("value")
        .and_then(Value::as_f64)
        .ok_or_else(|| AppError::validation("metric values must be finite numbers"))?;
    Ok(CanonicalMetric {
        key: validate_name(metric.get("key").and_then(Value::as_str), "metric key")?,
        step,
        value: validate_metric_value(value)?,
        timestamp: optional_metric_timestamp(metric.get("timestamp"), "timestamp")?,
    })
}

fn required_array<'a>(value: Option<&'a Value>, field: &str) -> AppResult<&'a [Value]> {
    let values = optional_array(value, field)?;
    if values.is_empty() {
        return Err(AppError::validation(format!(
            "{field} must be a non-empty list"
        )));
    }
    Ok(values)
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

fn object_or_empty(value: Option<&Value>, field: &str) -> AppResult<Value> {
    validate_json_object(value.cloned(), field)
}

fn optional_string_vec(value: Option<&Value>, field: &str) -> AppResult<Vec<String>> {
    optional_array(value, field)?
        .iter()
        .map(|item| validate_name(item.as_str(), field))
        .collect()
}

fn optional_text(value: Option<&Value>, field: &str) -> AppResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => validate_optional_name(Some(text), field),
        Some(other) => validate_optional_name(Some(&other.to_string()), field),
    }
}

fn optional_timestamp(value: Option<&Value>, field: &str) -> AppResult<Option<DateTime<Utc>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(validate_timestamp(Some(text))?)),
        _ => Err(AppError::validation(format!(
            "{field} must be an ISO-compatible datetime"
        ))),
    }
}

fn optional_metric_timestamp(value: Option<&Value>, field: &str) -> AppResult<Option<String>> {
    optional_timestamp(value, field).map(|value| value.map(|timestamp| timestamp.to_rfc3339()))
}

fn external_timestamp(value: Option<&Value>) -> AppResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let seconds = number
                .as_f64()
                .ok_or_else(|| AppError::validation("timestamp must be finite"))?;
            if !seconds.is_finite() {
                return Err(AppError::validation("timestamp must be finite"));
            }
            seconds_to_rfc3339(seconds)
                .ok_or_else(|| {
                    AppError::validation("timestamp must be within supported datetime range")
                })
                .map(Some)
        }
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(validate_timestamp(Some(text))?.to_rfc3339())),
        _ => Err(AppError::validation(
            "timestamp must be finite or an ISO-compatible datetime",
        )),
    }
}

fn attribute_input_from_value(value: &Value) -> AppResult<AttributeInput> {
    let object = object_ref(value, "run attribute")?;
    let kind = validate_attribute_type(
        object
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::validation("type must be one of: config, file, file_series, float_series, histogram_series, string_series, tag"))?,
    )?;
    let path = validate_name(object.get("path").and_then(Value::as_str), "attribute path")?;
    let step = object.get("step").cloned();
    if let Some(step) = step.as_ref() {
        validate_optional_step(Some(step), "step")?;
    }
    let timestamp = optional_metric_timestamp(object.get("timestamp"), "timestamp")?;
    let value = object
        .get("value")
        .cloned()
        .ok_or_else(|| AppError::validation("attribute value is required"))?;
    let value = validate_attribute_value(&kind, value)?;
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

fn artifact_request_from_value(value: &Value) -> AppResult<CreateArtifactRequest> {
    let object = object_ref(value, "run artifact")?;
    let kind =
        validate_artifact_type(object.get("type").and_then(Value::as_str).unwrap_or("file"))?;
    let name = validate_name(object.get("name").and_then(Value::as_str), "artifact name")?;
    let uri = validate_name(object.get("uri").and_then(Value::as_str), "artifact uri")?;
    let step = object.get("step").cloned();
    if let Some(step) = step.as_ref() {
        validate_optional_step(Some(step), "step")?;
    }
    let size_bytes = object
        .get("size_bytes")
        .or_else(|| object.get("file_size"))
        .cloned();
    if let Some(size_bytes) = size_bytes.as_ref() {
        validate_size_bytes(size_bytes)?;
    }
    let sha256 = object
        .get("sha256")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "sha256"))
        .transpose()?;
    let mime_type = object
        .get("mime_type")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "mime_type"))
        .transpose()?;
    let metadata = object_or_empty(object.get("metadata"), "metadata")?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "path"))
        .transpose()?;
    Ok(CreateArtifactRequest {
        kind: Some(kind),
        name: Some(name),
        uri: Some(uri),
        step,
        size_bytes,
        sha256,
        mime_type,
        metadata: Some(metadata),
        path,
    })
}

fn normalize_external_artifact(source: &str, value: &Value) -> AppResult<CreateArtifactRequest> {
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
    let mut metadata = object_or_empty(object.get("metadata"), "artifact metadata")?;
    if let Some(map) = metadata.as_object_mut() {
        if let Some(external_type) = external_type.as_ref() {
            map.insert("external_type".to_string(), json!(external_type));
        }
        map.insert("source".to_string(), json!(source));
    }
    let mut artifact = Map::new();
    artifact.insert("type".to_string(), json!(kind));
    artifact.insert("name".to_string(), json!(name));
    artifact.insert(
        "uri".to_string(),
        object
            .get("uri")
            .cloned()
            .unwrap_or_else(|| json!(format!("{source}://{name}"))),
    );
    if let Some(step) = object.get("step") {
        artifact.insert("step".to_string(), step.clone());
    }
    if let Some(size_bytes) = object.get("size_bytes").or_else(|| object.get("file_size")) {
        artifact.insert("size_bytes".to_string(), size_bytes.clone());
    }
    artifact.insert("metadata".to_string(), metadata);
    artifact_request_from_value(&Value::Object(artifact))
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

fn map_external_run_status(value: Option<&str>) -> String {
    match value.unwrap_or_default().to_ascii_lowercase().as_str() {
        "running" => "running",
        "failed" | "crashed" | "killed" => "failed",
        _ => "finished",
    }
    .to_string()
}

fn validate_import_schema_version(value: Option<&Value>) -> AppResult<()> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Number(number)) if number.as_i64() == Some(1) => Ok(()),
        _ => Err(AppError::validation("schema_version must be 1")),
    }
}

fn key_value_object(
    value: Option<&Value>,
    field: &str,
    allow_duplicate_run_name: bool,
) -> AppResult<Value> {
    let mut values = Map::new();
    for candidate in optional_array(value, &format!("{field}s"))? {
        let entry = object_ref(candidate, field)?;
        let key = validate_name(
            entry.get("key").and_then(Value::as_str),
            &format!("{field} key"),
        )?;
        if values.contains_key(&key) && !(allow_duplicate_run_name && key == "mlflow.runName") {
            return Err(AppError::validation(format!("{field} keys must be unique")));
        }
        let value = validate_name(
            entry.get("value").and_then(Value::as_str),
            &format!("{field} value"),
        )?;
        values.insert(key, json!(value));
    }
    Ok(Value::Object(values))
}

fn mlflow_metrics(value: Option<&Value>, field: &str) -> AppResult<Vec<CanonicalMetric>> {
    optional_array(value, field)?
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let metric = object_ref(candidate, field)?;
            let key = validate_name(metric.get("key").and_then(Value::as_str), "metric key")?;
            let step = metric
                .get("step")
                .map(|value| validate_step(value, "step"))
                .transpose()?
                .unwrap_or(index as f64);
            let value = metric
                .get("value")
                .and_then(Value::as_f64)
                .ok_or_else(|| AppError::validation("metric values must be finite numbers"))?;
            Ok(CanonicalMetric {
                key,
                step,
                value: validate_metric_value(value)?,
                timestamp: mlflow_timestamp(metric.get("timestamp"), "mlflow metric timestamp")?
                    .map(|value| value.to_rfc3339()),
            })
        })
        .collect()
}

fn latest_metrics_by_key(metrics: &[CanonicalMetric]) -> Value {
    let mut values = Map::new();
    for metric in metrics {
        values.insert(
            metric.key.clone(),
            json!({ "value": metric.value, "step": metric.step, "timestamp": metric.timestamp }),
        );
    }
    Value::Object(values)
}

fn normalize_mlflow_artifact(
    value: &Value,
    artifact_root: Option<&str>,
    skipped_artifact_directories: &mut i64,
) -> AppResult<Option<CreateArtifactRequest>> {
    let artifact = object_ref(value, "mlflow artifact")?;
    if artifact.get("is_dir").and_then(Value::as_bool) == Some(true) {
        *skipped_artifact_directories += 1;
        return Ok(None);
    }
    let artifact_path = validate_relative_artifact_path(
        artifact
            .get("path")
            .or_else(|| artifact.get("name"))
            .and_then(Value::as_str),
        "mlflow artifact path",
    )?;
    let uri = artifact
        .get("uri")
        .and_then(Value::as_str)
        .map(|value| validate_name(Some(value), "artifact uri"))
        .transpose()?
        .unwrap_or_else(|| join_artifact_uri(artifact_root, &artifact_path));
    let mut metadata = object_or_empty(artifact.get("metadata"), "mlflow artifact metadata")?;
    if let Some(map) = metadata.as_object_mut() {
        map.insert("path".to_string(), json!(artifact_path));
        map.insert("root_uri".to_string(), json!(artifact_root));
        map.insert("is_dir".to_string(), json!(false));
    }
    let mut normalized = Map::new();
    normalized.insert(
        "name".to_string(),
        json!(artifact_path
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&artifact_path)),
    );
    normalized.insert(
        "type".to_string(),
        artifact.get("type").cloned().unwrap_or(Value::Null),
    );
    normalized.insert("uri".to_string(), json!(uri));
    if let Some(step) = artifact.get("step") {
        normalized.insert("step".to_string(), step.clone());
    }
    if let Some(size) = artifact
        .get("file_size")
        .or_else(|| artifact.get("size_bytes"))
    {
        normalized.insert("size_bytes".to_string(), size.clone());
    }
    normalized.insert("metadata".to_string(), metadata);
    normalize_external_artifact("mlflow", &Value::Object(normalized)).map(Some)
}

fn validate_relative_artifact_path(value: Option<&str>, field: &str) -> AppResult<String> {
    let text = validate_name(value, field)?.replace('\\', "/");
    if text.starts_with('/')
        || (text.len() > 2 && text.as_bytes()[1] == b':' && text.as_bytes()[2] == b'/')
    {
        return Err(AppError::validation(format!(
            "{field} must be a relative path"
        )));
    }
    if text.split('/').any(|part| part == "..") {
        return Err(AppError::validation(format!(
            "{field} must not contain traversal"
        )));
    }
    Ok(text)
}

fn join_artifact_uri(root: Option<&str>, artifact_path: &str) -> String {
    match root {
        Some(root) if !root.trim().is_empty() => {
            format!("{}/{}", root.trim_end_matches('/'), artifact_path)
        }
        _ => format!("mlflow://{artifact_path}"),
    }
}

fn map_mlflow_status(value: Option<&str>) -> AppResult<String> {
    match value.unwrap_or("FINISHED").to_ascii_uppercase().as_str() {
        "RUNNING" | "SCHEDULED" => Ok("running".to_string()),
        "FINISHED" => Ok("finished".to_string()),
        "FAILED" | "KILLED" => Ok("failed".to_string()),
        _ => Err(AppError::validation(
            "mlflow status must be one of: RUNNING, SCHEDULED, FINISHED, FAILED, KILLED",
        )),
    }
}

fn mlflow_timestamp(value: Option<&Value>, field: &str) -> AppResult<Option<DateTime<Utc>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let millis = number
                .as_i64()
                .ok_or_else(|| AppError::validation(format!("{field} must be finite")))?;
            millis_to_rfc3339(millis)
                .ok_or_else(|| {
                    AppError::validation(format!("{field} must be within supported datetime range"))
                })
                .and_then(|text| optional_timestamp(Some(&Value::String(text)), field))
        }
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(validate_timestamp(Some(text))?)),
        _ => Err(AppError::validation(format!(
            "{field} must be epoch milliseconds or an ISO-compatible datetime"
        ))),
    }
}

fn seconds_to_rfc3339(seconds: f64) -> Option<String> {
    let secs = seconds.trunc() as i64;
    let nanos = ((seconds.fract()) * 1_000_000_000.0).round() as u32;
    Utc.timestamp_opt(secs, nanos)
        .single()
        .map(|value| value.to_rfc3339())
}

fn millis_to_rfc3339(millis: i64) -> Option<String> {
    let secs = millis.div_euclid(1000);
    let nanos = (millis.rem_euclid(1000) as u32) * 1_000_000;
    Utc.timestamp_opt(secs, nanos)
        .single()
        .map(|value| value.to_rfc3339())
}

pub(super) fn import_row_value(row: &PgRow) -> AppResult<Value> {
    Ok(json!({
        "id": row.try_get::<i64, _>("id")?,
        "org_id": row.try_get::<Uuid, _>("org_id")?,
        "project_id": row.try_get::<Option<Uuid>, _>("project_id")?,
        "source_type": row.try_get::<String, _>("source_type")?,
        "status": row.try_get::<String, _>("status")?,
        "summary": row.try_get::<Value, _>("summary")?,
        "run_ids": row.try_get::<Vec<Uuid>, _>("run_ids")?,
        "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?,
        "completed_at": row.try_get::<Option<DateTime<Utc>>, _>("completed_at")?
    }))
}
