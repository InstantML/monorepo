use super::*;

pub async fn create_attributes(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateAttributesRequest,
) -> AppResult<Vec<AttributeRow>> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let attributes = normalize_attributes(input)?;
    if attributes.is_empty() {
        return Err(AppError::validation("attributes must not be empty"));
    }
    let mut tx = pool.begin().await?;
    let mut rows = Vec::with_capacity(attributes.len());
    for attribute in attributes {
        rows.push(insert_attribute_input_tx(&mut tx, ctx.org_id, run_id, attribute).await?);
    }
    tx.commit().await?;
    Ok(rows)
}

pub async fn list_attributes(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<AttributeRow>> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let kind = query
        .get("type")
        .map(|value| validate_name(Some(value), "attribute type"))
        .transpose()?;
    let path_prefix = query
        .get("path_prefix")
        .map(|value| validate_name(Some(value), "path_prefix"))
        .transpose()?;
    sqlx::query_as::<_, AttributeRow>(
        r#"
        select id, org_id, run_id, path, type as kind, step, logged_at, value, summary, artifact_id, created_at
        from attributes
        where org_id = $1 and run_id = $2
          and ($3::text is null or type = $3)
          and ($4::text is null or path like ($4 || '%'))
        order by coalesce(step, -1) asc, id asc
        limit $5
        "#,
    )
    .bind(ctx.org_id)
    .bind(run_id)
    .bind(kind)
    .bind(path_prefix)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn create_object(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateObjectRequest,
) -> AppResult<Value> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let key = validate_name(input.key.as_deref(), "object key")?;
    let kind = validate_object_kind(input.kind.as_deref())?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    validate_json_size(&metadata, "metadata", MAX_OBJECT_METADATA_BYTES)?;
    let summary = validate_json_object(input.summary, "summary")?;
    validate_json_size(&summary, "summary", MAX_OBJECT_SUMMARY_BYTES)?;
    let mut tx = pool.begin().await?;
    let object = match kind.as_str() {
        "table" => {
            let rows = validate_table_rows(input.rows.unwrap_or_default())?;
            let summary = normalize_table_summary(summary, &rows)?;
            if let Some(artifact_id) = input.artifact_id {
                fetch_artifact_for_run_tx(&mut tx, ctx.org_id, run_id, artifact_id).await?;
            }
            let attribute = insert_attribute_tx(
                &mut tx,
                ctx.org_id,
                run_id,
                &key,
                "table",
                step,
                Some(Utc::now()),
                json!({ "kind": "table", "metadata": metadata }),
                summary,
                input.artifact_id,
            )
            .await?;
            insert_table_object_rows_tx(&mut tx, ctx.org_id, attribute.id, &rows).await?;
            attribute
        }
        "histogram" => {
            reject_rows(input.rows.as_ref(), "histogram")?;
            let value = validate_histogram_object(input.value)?;
            let value = merge_object_metadata(value, metadata)?;
            insert_attribute_tx(
                &mut tx,
                ctx.org_id,
                run_id,
                &key,
                "histogram_series",
                step,
                Some(Utc::now()),
                value,
                summary,
                None,
            )
            .await?
        }
        "image" | "video" | "audio" => {
            reject_rows(input.rows.as_ref(), &kind)?;
            let artifact_id = input
                .artifact_id
                .ok_or_else(|| AppError::validation("artifact_id is required for media objects"))?;
            let artifact =
                fetch_artifact_for_run_tx(&mut tx, ctx.org_id, run_id, artifact_id).await?;
            insert_attribute_tx(
                &mut tx,
                ctx.org_id,
                run_id,
                &key,
                &kind,
                step.or(artifact.step),
                Some(Utc::now()),
                json!({
                    "kind": kind,
                    "uri": artifact.uri,
                    "metadata": metadata
                }),
                merge_media_summary(summary, &artifact),
                Some(artifact.id),
            )
            .await?
        }
        _ => unreachable!("validate_object_kind restricts values"),
    };
    let value = logged_object_value_from_attribute_tx(&mut tx, ctx.org_id, &object).await?;
    tx.commit().await?;
    Ok(value)
}

pub async fn list_objects(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_LIMIT,
        MAX_OBJECT_LIMIT,
    )?;
    let offset = validate_offset(query.get("offset").map(String::as_str))?;
    let kind = query
        .get("kind")
        .map(|value| validate_object_kind(Some(value)))
        .transpose()?;
    let db_kind = kind
        .as_deref()
        .map(object_kind_to_attribute_type)
        .map(|value| value.to_string());
    let key = query
        .get("key")
        .map(|value| validate_name(Some(value), "object key"))
        .transpose()?;
    let rows = sqlx::query(
        r#"
        select a.id, a.org_id, a.run_id, a.path as key,
               case when a.type = 'histogram_series' then 'histogram' else a.type end as kind,
               a.step, a.value, a.summary, a.artifact_id, a.created_at,
               artifacts.name as artifact_name,
               artifacts.uri as artifact_uri,
               artifacts.mime_type as artifact_mime_type,
               artifacts.size_bytes as artifact_size_bytes
        from attributes a
        left join artifacts on artifacts.org_id = a.org_id and artifacts.id = a.artifact_id
        where a.org_id = $1 and a.run_id = $2
          and a.type in ('table', 'image', 'video', 'audio', 'histogram_series')
          and ($3::text is null or a.type = $3)
          and ($4::text is null or a.path = $4)
        order by coalesce(a.step, -1) desc, a.created_at desc, a.id desc
        limit $5 offset $6
        "#,
    )
    .bind(ctx.org_id)
    .bind(run_id)
    .bind(db_kind)
    .bind(key)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    let objects = rows
        .iter()
        .map(logged_object_row_value)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(json!({ "objects": objects, "limit": limit, "offset": offset }))
}

pub async fn list_object_rows(
    pool: &PgPool,
    ctx: &RequestContext,
    object_id: i64,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_ROW_LIMIT,
        MAX_OBJECT_ROW_LIMIT,
    )?;
    let offset = validate_offset(query.get("offset").map(String::as_str))?;
    let object = sqlx::query_as::<_, AttributeRow>(
        r#"
        select id, org_id, run_id, path, type as kind, step, logged_at, value, summary, artifact_id, created_at
        from attributes
        where org_id = $1 and id = $2
        "#,
    )
    .bind(ctx.org_id)
    .bind(object_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("object not found"))?;
    let run = fetch_run(pool, object.run_id).await?;
    ensure_run_access(ctx, &run)?;
    if object.kind != "table" {
        return Err(AppError::validation(
            "object rows are only available for table objects",
        ));
    }
    let rows = sqlx::query(
        r#"
        select row_index, row, created_at
        from table_object_rows
        where org_id = $1 and attribute_id = $2
        order by row_index asc
        limit $3 offset $4
        "#,
    )
    .bind(ctx.org_id)
    .bind(object_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    let rows = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "row_index": row.try_get::<i64, _>("row_index")?,
                "row": row.try_get::<Value, _>("row")?,
                "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?
            }))
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(json!({ "object_id": object_id, "rows": rows, "limit": limit, "offset": offset }))
}
fn normalize_attributes(input: CreateAttributesRequest) -> AppResult<Vec<AttributeInput>> {
    if let Some(attributes) = input.attributes {
        return Ok(attributes);
    }
    Ok(vec![AttributeInput {
        path: input.path.ok_or_else(|| AppError::validation("attribute path must be a non-empty string"))?,
        kind: input.kind.ok_or_else(|| AppError::validation("type must be one of: config, file, file_series, float_series, histogram_series, string_series, tag"))?,
        step: input.step,
        timestamp: input.timestamp,
        value: input.value.ok_or_else(|| AppError::validation("attribute value is required"))?,
        summary: input.summary,
        artifact_id: None,
    }])
}

fn validate_object_kind(value: Option<&str>) -> AppResult<String> {
    let kind = validate_name(value, "object kind")?.to_ascii_lowercase();
    if matches!(
        kind.as_str(),
        "table" | "image" | "video" | "audio" | "histogram"
    ) {
        Ok(kind)
    } else {
        Err(AppError::validation(
            "kind must be one of: audio, histogram, image, table, video",
        ))
    }
}

fn object_kind_to_attribute_type(kind: &str) -> &'static str {
    match kind {
        "histogram" => "histogram_series",
        "table" => "table",
        "image" => "image",
        "video" => "video",
        "audio" => "audio",
        _ => unreachable!("validate_object_kind restricts values"),
    }
}

fn reject_rows(rows: Option<&Vec<Value>>, kind: &str) -> AppResult<()> {
    if rows.is_some_and(|items| !items.is_empty()) {
        return Err(AppError::validation(format!(
            "rows are only accepted for table objects, not {kind}"
        )));
    }
    Ok(())
}

fn validate_json_size(value: &Value, field: &str, max_bytes: usize) -> AppResult<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| AppError::validation(format!("{field} must be JSON serializable")))?;
    if bytes.len() > max_bytes {
        return Err(AppError::validation(format!(
            "{field} must be at most {max_bytes} bytes"
        )));
    }
    Ok(())
}

fn validate_table_rows(rows: Vec<Value>) -> AppResult<Vec<Value>> {
    if rows.len() > MAX_TABLE_ROWS_PER_CREATE {
        return Err(AppError::validation(format!(
            "rows must contain at most {MAX_TABLE_ROWS_PER_CREATE} items"
        )));
    }
    for row in &rows {
        if !row.is_object() {
            return Err(AppError::validation("table rows must be JSON objects"));
        }
        validate_json_size(row, "table row", MAX_TABLE_ROW_BYTES)?;
    }
    Ok(rows)
}

fn normalize_table_summary(mut summary: Value, rows: &[Value]) -> AppResult<Value> {
    let object = summary
        .as_object_mut()
        .ok_or_else(|| AppError::validation("summary must be an object"))?;
    let columns = match object.get("columns") {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| AppError::validation("table columns must be strings"))
            })
            .collect::<AppResult<Vec<_>>>()?,
        Some(_) => return Err(AppError::validation("table columns must be an array")),
        None => {
            let mut keys = BTreeSet::new();
            for row in rows {
                if let Some(row) = row.as_object() {
                    keys.extend(row.keys().cloned());
                }
            }
            keys.into_iter().collect::<Vec<_>>()
        }
    };
    if columns.len() > MAX_TABLE_COLUMNS {
        return Err(AppError::validation(format!(
            "table columns must contain at most {MAX_TABLE_COLUMNS} items"
        )));
    }
    if columns.iter().any(|column| column.trim().is_empty()) {
        return Err(AppError::validation(
            "table columns must be non-empty strings",
        ));
    }
    object.insert("columns".to_string(), json!(columns));
    object.insert("row_count".to_string(), json!(rows.len()));
    validate_json_size(&summary, "summary", MAX_OBJECT_SUMMARY_BYTES)?;
    Ok(summary)
}

fn validate_histogram_object(value: Option<Value>) -> AppResult<Value> {
    let mut value = validate_json_object(value, "histogram value")?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| AppError::validation("histogram value must be an object"))?;
    let bins = finite_number_array(object.get("bins"), "bins")?;
    let counts = finite_number_array(object.get("counts"), "counts")?;
    if bins.is_empty() || counts.is_empty() {
        return Err(AppError::validation(
            "histogram bins and counts must not be empty",
        ));
    }
    if bins.len() > MAX_HISTOGRAM_BINS || counts.len() > MAX_HISTOGRAM_BINS {
        return Err(AppError::validation(format!(
            "histogram bins and counts must contain at most {MAX_HISTOGRAM_BINS} items"
        )));
    }
    if !(bins.len() == counts.len() || bins.len() == counts.len() + 1) {
        return Err(AppError::validation(
            "histogram bins length must match counts length or counts length plus one",
        ));
    }
    if counts.iter().any(|value| *value < 0.0) {
        return Err(AppError::validation(
            "histogram counts must be nonnegative numbers",
        ));
    }
    object.insert("bins".to_string(), json!(bins));
    object.insert("counts".to_string(), json!(counts));
    validate_json_size(&value, "histogram value", MAX_OBJECT_SUMMARY_BYTES)?;
    Ok(value)
}

fn finite_number_array(value: Option<&Value>, field: &str) -> AppResult<Vec<f64>> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation(format!("histogram {field} must be an array")))?;
    values
        .iter()
        .map(|value| {
            let number = value.as_f64().ok_or_else(|| {
                AppError::validation(format!("histogram {field} must contain finite numbers"))
            })?;
            if !number.is_finite() {
                return Err(AppError::validation(format!(
                    "histogram {field} must contain finite numbers"
                )));
            }
            Ok(number)
        })
        .collect()
}

fn merge_object_metadata(mut value: Value, metadata: Value) -> AppResult<Value> {
    if !metadata.as_object().is_some_and(|object| object.is_empty()) {
        value
            .as_object_mut()
            .ok_or_else(|| AppError::validation("object value must be an object"))?
            .insert("metadata".to_string(), metadata);
    }
    Ok(value)
}

pub(super) fn merge_media_summary(mut summary: Value, artifact: &ArtifactRow) -> Value {
    let object = summary
        .as_object_mut()
        .expect("validate_json_object guarantees an object");
    object.insert("artifact_name".to_string(), json!(artifact.name));
    object.insert("artifact_uri".to_string(), json!(artifact.uri));
    object.insert("mime_type".to_string(), json!(artifact.mime_type));
    object.insert("size_bytes".to_string(), json!(artifact.size_bytes));
    summary
}

pub(super) async fn insert_attribute_input_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    input: AttributeInput,
) -> AppResult<AttributeRow> {
    let path = validate_name(Some(&input.path), "attribute path")?;
    let kind = validate_attribute_type(&input.kind)?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let logged_at = Some(validate_timestamp(input.timestamp.as_deref())?);
    let summary = validate_json_object(input.summary, "attribute summary")?;
    let value = validate_attribute_value(&kind, input.value)?;
    if let Some(artifact_id) = input.artifact_id {
        fetch_artifact_for_run_tx(tx, org_id, run_id, artifact_id).await?;
    }
    insert_attribute_tx(
        tx,
        org_id,
        run_id,
        &path,
        &kind,
        step,
        logged_at,
        value,
        summary,
        input.artifact_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn insert_attribute_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    path: &str,
    kind: &str,
    step: Option<f64>,
    logged_at: Option<DateTime<Utc>>,
    value: Value,
    summary: Value,
    artifact_id: Option<Uuid>,
) -> AppResult<AttributeRow> {
    sqlx::query_as::<_, AttributeRow>(
        r#"
        insert into attributes (org_id, run_id, path, type, step, logged_at, value, summary, artifact_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning id, org_id, run_id, path, type as kind, step, logged_at, value, summary, artifact_id, created_at
        "#,
    )
    .bind(org_id)
    .bind(run_id)
    .bind(path)
    .bind(kind)
    .bind(step)
    .bind(logged_at)
    .bind(Json(value))
    .bind(Json(summary))
    .bind(artifact_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

pub(super) fn validate_attribute_type(kind: &str) -> AppResult<String> {
    let kind = validate_name(Some(kind), "attribute type")?;
    if matches!(
        kind.as_str(),
        "config"
            | "float_series"
            | "string_series"
            | "file"
            | "file_series"
            | "histogram_series"
            | "tag"
    ) {
        Ok(kind)
    } else {
        Err(AppError::validation(
            "type must be one of: config, file, file_series, float_series, histogram_series, string_series, tag; use /api/runs/:run_id/objects for table, image, video, or audio",
        ))
    }
}
pub(super) fn validate_attribute_value(kind: &str, value: Value) -> AppResult<Value> {
    if kind == "float_series" {
        let number = value
            .as_f64()
            .ok_or_else(|| AppError::validation("float_series value must be finite numbers"))?;
        if !number.is_finite() {
            return Err(AppError::validation(
                "float_series value must be finite numbers",
            ));
        }
        return Ok(json!(number));
    }
    if kind == "tag" && !value.is_string() {
        return Err(AppError::validation("tag value must be a string"));
    }
    Ok(value)
}
pub(super) async fn insert_table_object_rows_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    attribute_id: i64,
    rows: &[Value],
) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let records = rows
        .iter()
        .enumerate()
        .map(|(index, row)| json!({ "row_index": index as i64, "row": row }))
        .collect::<Vec<_>>();
    sqlx::query(
        r#"
        insert into table_object_rows (org_id, attribute_id, row_index, row)
        select $1, $2, record.row_index, record.row
        from jsonb_to_recordset($3::jsonb) as record(row_index bigint, row jsonb)
        "#,
    )
    .bind(org_id)
    .bind(attribute_id)
    .bind(Json(Value::Array(records)))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn logged_object_value_from_attribute_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    attribute: &AttributeRow,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        select a.id, a.org_id, a.run_id, a.path as key,
               case when a.type = 'histogram_series' then 'histogram' else a.type end as kind,
               a.step, a.value, a.summary, a.artifact_id, a.created_at,
               artifacts.name as artifact_name,
               artifacts.uri as artifact_uri,
               artifacts.mime_type as artifact_mime_type,
               artifacts.size_bytes as artifact_size_bytes
        from attributes a
        left join artifacts on artifacts.org_id = a.org_id and artifacts.id = a.artifact_id
        where a.org_id = $1 and a.id = $2
        "#,
    )
    .bind(org_id)
    .bind(attribute.id)
    .fetch_one(&mut **tx)
    .await?;
    logged_object_row_value(&row)
}

fn logged_object_row_value(row: &PgRow) -> AppResult<Value> {
    let value = row.try_get::<Value, _>("value")?;
    let metadata = value
        .get("metadata")
        .filter(|metadata| metadata.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let artifact_id = row.try_get::<Option<Uuid>, _>("artifact_id")?;
    let artifact = match artifact_id {
        Some(id) => Some(json!({
            "id": id,
            "name": row.try_get::<Option<String>, _>("artifact_name")?,
            "uri": row.try_get::<Option<String>, _>("artifact_uri")?,
            "mime_type": row.try_get::<Option<String>, _>("artifact_mime_type")?,
            "size_bytes": row.try_get::<Option<i64>, _>("artifact_size_bytes")?
        })),
        None => None,
    };
    Ok(json!({
        "id": row.try_get::<i64, _>("id")?,
        "org_id": row.try_get::<Uuid, _>("org_id")?,
        "run_id": row.try_get::<Uuid, _>("run_id")?,
        "key": row.try_get::<String, _>("key")?,
        "kind": row.try_get::<String, _>("kind")?,
        "step": row.try_get::<Option<f64>, _>("step")?,
        "value": value,
        "metadata": metadata,
        "summary": row.try_get::<Value, _>("summary")?,
        "artifact_id": artifact_id,
        "artifact": artifact,
        "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?
    }))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn attribute_row_value(row: &PgRow) -> AppResult<Value> {
    Ok(json!({
        "id": row.try_get::<i64, _>("id")?,
        "org_id": row.try_get::<Uuid, _>("org_id")?,
        "run_id": row.try_get::<Uuid, _>("run_id")?,
        "path": row.try_get::<String, _>("path")?,
        "type": row.try_get::<String, _>("type")?,
        "step": row.try_get::<Option<f64>, _>("step")?,
        "logged_at": row.try_get::<Option<DateTime<Utc>>, _>("logged_at")?,
        "value": row.try_get::<Value, _>("value")?,
        "summary": row.try_get::<Value, _>("summary")?,
        "artifact_id": row.try_get::<Option<Uuid>, _>("artifact_id")?,
        "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?
    }))
}
