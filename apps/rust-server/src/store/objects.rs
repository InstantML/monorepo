use super::*;

pub async fn create_attributes(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateAttributesRequest,
) -> AppResult<Vec<Value>> {
    let items = normalize_attribute_inputs(input)?;
    let mut created = Vec::new();
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    for item in items {
        if matches!(item.kind.as_str(), "table" | "image" | "video" | "audio") {
            return Err(AppError::validation(
                "rich object types must use /api/runs/:run_id/objects",
            ));
        }
        let attribute = attribute_from_input(&mut data, ctx.org_id, run_id, item)?;
        store
            .persist_locked(
                "attribute",
                ctx.org_id,
                &attribute.id.to_string(),
                &attribute,
            )
            .await?;
        data.insert_attribute(attribute.clone());
        created.push(attribute_value(&attribute));
    }
    Ok(created)
}

pub async fn list_attributes(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<Value>> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let kind = query
        .get("type")
        .map(|value| validate_name(Some(value), "attribute type"))
        .transpose()?;
    let path_prefix = query
        .get("path_prefix")
        .map(|value| validate_name(Some(value), "path_prefix"))
        .transpose()?;
    let mut rows = data
        .attributes_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.attributes.get(&(ctx.org_id, *id)))
        .filter(|row| row.run_id == run_id)
        .filter(|row| {
            kind.as_ref()
                .map(|value| row.kind == *value)
                .unwrap_or(true)
        })
        .filter(|row| {
            path_prefix
                .as_ref()
                .map(|value| row.path.starts_with(value))
                .unwrap_or(true)
        })
        .map(attribute_value)
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        json_step(a)
            .total_cmp(&json_step(b))
            .then_with(|| json_i64(a, "id").cmp(&json_i64(b, "id")))
    });
    rows = rows.into_iter().skip(offset).take(limit).collect();
    Ok(rows)
}

pub async fn create_object(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateObjectRequest,
) -> AppResult<Value> {
    let key = validate_name(input.key.as_deref(), "object key")?;
    let requested_kind = validate_name(input.kind.as_deref(), "object kind")?;
    let kind = normalize_object_kind(&requested_kind)?;
    let is_table = kind == "table";
    let mut step = validate_optional_step(input.step.as_ref(), "step")?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    validate_json_size(&metadata, "metadata", MAX_OBJECT_METADATA_BYTES)?;
    let mut summary = validate_json_object(input.summary, "summary")?;
    validate_json_size(&summary, "summary", MAX_OBJECT_SUMMARY_BYTES)?;
    let mut value = input
        .value
        .unwrap_or_else(|| json!({ "kind": requested_kind, "metadata": metadata.clone() }));
    let rows = input.rows.unwrap_or_default();
    if is_table {
        validate_table_rows(&rows)?;
    } else if !rows.is_empty() {
        return Err(AppError::validation(format!(
            "rows are only accepted for table objects, not {requested_kind}"
        )));
    }
    if kind == "histogram_series" {
        validate_histogram_value(&value)?;
    }
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let mut artifact_id = input.artifact_id;
    if matches!(kind.as_str(), "image" | "video" | "audio") {
        let id = artifact_id
            .ok_or_else(|| AppError::validation("artifact_id is required for media objects"))?;
        let artifact = data
            .artifacts
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("artifact not found"))?;
        if artifact.org_id != ctx.org_id || artifact.run_id != run_id {
            return Err(AppError::validation("artifact must belong to the same run"));
        }
        step = step.or(artifact.step);
        value = json!({
            "kind": requested_kind,
            "uri": artifact.uri,
            "metadata": metadata
        });
        summary = media_summary(summary, &artifact);
        artifact_id = Some(artifact.id);
    } else if let Some(id) = artifact_id {
        let artifact = data
            .artifacts
            .get(&id)
            .ok_or_else(|| AppError::not_found("artifact not found"))?;
        if artifact.org_id != ctx.org_id || artifact.run_id != run_id {
            return Err(AppError::validation("artifact must belong to the same run"));
        }
        if kind == "histogram_series" {
            artifact_id = None;
        }
    }
    let attribute = AttributeRow {
        id: data.allocate_attribute_id(ctx.org_id),
        org_id: ctx.org_id,
        run_id,
        path: key,
        kind,
        step,
        logged_at: Some(Utc::now()),
        value,
        summary: if is_table {
            table_summary(summary, &rows)?
        } else {
            summary
        },
        artifact_id,
        created_at: Utc::now(),
    };
    let object = object_value(&data, &attribute);
    store
        .persist_locked(
            "attribute",
            ctx.org_id,
            &attribute.id.to_string(),
            &attribute,
        )
        .await?;
    data.insert_attribute(attribute.clone());
    if is_table && !rows.is_empty() {
        let rows_record = TableRowsRecord {
            attribute_id: attribute.id,
            rows: rows
                .into_iter()
                .enumerate()
                .map(|(index, row)| TableObjectRow {
                    row_index: index as i64,
                    row,
                    created_at: Utc::now(),
                })
                .collect(),
        };
        store
            .persist_locked(
                "table_rows",
                ctx.org_id,
                &attribute.id.to_string(),
                &rows_record,
            )
            .await?;
        data.table_rows
            .insert((ctx.org_id, rows_record.attribute_id), rows_record.rows);
    }
    Ok(object)
}

pub async fn list_objects(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_LIMIT,
        MAX_OBJECT_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let kind = query
        .get("kind")
        .map(|value| normalize_object_kind(value))
        .transpose()?;
    let key = query
        .get("key")
        .map(|value| validate_name(Some(value), "object key"))
        .transpose()?;
    let mut rows = data
        .attributes_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.attributes.get(&(ctx.org_id, *id)))
        .filter(|row| row.run_id == run_id)
        .filter(|row| {
            matches!(
                row.kind.as_str(),
                "table" | "image" | "video" | "audio" | "histogram_series"
            )
        })
        .filter(|row| {
            kind.as_ref()
                .map(|value| row.kind == *value)
                .unwrap_or(true)
        })
        .filter(|row| key.as_ref().map(|value| row.path == *value).unwrap_or(true))
        .map(|row| object_value(&data, row))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        super::runs::numeric_desc(Some(json_step(a)), Some(json_step(b)))
            .then_with(|| json_time(b).cmp(&json_time(a)))
            .then_with(|| json_i64(b, "id").cmp(&json_i64(a, "id")))
    });
    rows = rows.into_iter().skip(offset).take(limit).collect();
    Ok(json!({ "objects": rows, "limit": limit, "offset": offset }))
}

pub async fn list_object_rows(
    store: &Store,
    ctx: &RequestContext,
    object_id: i64,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let object = data
        .attributes
        .get(&(ctx.org_id, object_id))
        .ok_or_else(|| AppError::not_found("object not found"))?;
    let run = fetch_run_in_data(&data, ctx, object.run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    if object.kind != "table" {
        return Err(AppError::validation(
            "object rows are only available for table objects",
        ));
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_ROW_LIMIT,
        MAX_OBJECT_ROW_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let rows = data
        .table_rows
        .get(&(ctx.org_id, object_id))
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|row| {
            json!({
                "row_index": row.row_index,
                "row": row.row,
                "created_at": row.created_at
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "object_id": object_id, "rows": rows, "limit": limit, "offset": offset }))
}

pub async fn create_artifact(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
) -> AppResult<ArtifactRow> {
    let artifact = artifact_from_input(store, ctx, run_id, input, None).await?;
    Ok(artifact)
}

pub async fn upload_artifact(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UploadArtifactRequest,
) -> AppResult<ArtifactRow> {
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let artifact_id = Uuid::new_v4();
    let content = input
        .content_base64
        .as_deref()
        .ok_or_else(|| AppError::validation("content_base64 is required"))?;
    if content.trim().is_empty() {
        return Err(AppError::validation("content_base64 is required"));
    }
    let artifact_store = LocalArtifactStore::new(&config.artifact_root);
    let staged = artifact_store
        .stage_base64(ctx.org_id, run_id, artifact_id, &name, content)
        .await?;
    if let Err(error) = artifact_store.finalize(&staged).await {
        artifact_store.cleanup(&staged.tmp_path).await;
        artifact_store.cleanup(&staged.final_path).await;
        return Err(error);
    }
    let request = CreateArtifactRequest {
        kind: input.kind,
        name: Some(name),
        uri: Some(staged.uri.clone()),
        step: input.step,
        size_bytes: Some(json!(staged.size_bytes)),
        sha256: Some(staged.sha256.clone()),
        mime_type: input.mime_type,
        metadata: input.metadata,
        path: input.path,
    };
    let storage_key = staged.storage_key.clone();
    let artifact = match artifact_from_input(
        store,
        ctx,
        run_id,
        request,
        Some((artifact_id, storage_key)),
    )
    .await
    {
        Ok(artifact) => artifact,
        Err(error) => {
            artifact_store.cleanup(&staged.final_path).await;
            return Err(error);
        }
    };
    Ok(artifact)
}

async fn artifact_from_input(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
    stored: Option<(Uuid, String)>,
) -> AppResult<ArtifactRow> {
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let kind = validate_artifact_type(input.kind.as_deref().unwrap_or("file"))?;
    let uri = validate_name(
        input
            .uri
            .as_deref()
            .or(input.path.as_deref())
            .or(Some(&name)),
        "artifact uri",
    )?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let size_bytes = input
        .size_bytes
        .as_ref()
        .map(validate_size_bytes)
        .transpose()?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let (id, storage_key) = stored.unwrap_or_else(|| (Uuid::new_v4(), String::new()));
    let artifact = ArtifactRow {
        id,
        org_id: ctx.org_id,
        run_id,
        kind,
        name: name.clone(),
        uri,
        step,
        size_bytes,
        sha256: input.sha256,
        mime_type: input
            .mime_type
            .or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_string)),
        storage_backend: if storage_key.is_empty() {
            "external".to_string()
        } else {
            "local".to_string()
        },
        storage_key: (!storage_key.is_empty()).then_some(storage_key),
        storage_path: None,
        metadata,
        created_at: Utc::now(),
    };
    store
        .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
        .await?;
    data.insert_artifact(artifact.clone());
    Ok(artifact)
}

pub async fn list_artifacts(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<ArtifactRow>> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_ARTIFACT_LIST,
    )? as usize;
    let mut rows = data
        .artifacts_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifacts.get(id).cloned())
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    rows.truncate(limit);
    Ok(rows)
}

pub async fn get_artifact_for_context(
    store: &Store,
    ctx: &RequestContext,
    artifact_id: Uuid,
) -> AppResult<ArtifactRow> {
    let data = store.data.lock().await;
    let artifact = data
        .artifacts
        .get(&artifact_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact not found"))?;
    let run = fetch_run_in_data(&data, ctx, artifact.run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    Ok(artifact)
}
