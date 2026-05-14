use super::*;

pub async fn create_artifact(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
) -> AppResult<ArtifactRow> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let kind = validate_artifact_type(input.kind.as_deref().unwrap_or("file"))?;
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let uri = validate_name(input.uri.as_deref(), "artifact uri")?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let size_bytes = input
        .size_bytes
        .as_ref()
        .map(validate_size_bytes)
        .transpose()?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let mime_type = input
        .mime_type
        .or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_string));
    let mut tx = pool.begin().await?;
    let artifact = insert_artifact_tx(
        &mut tx,
        ArtifactInsert {
            org_id: ctx.org_id,
            run_id,
            kind: &kind,
            name: &name,
            uri: &uri,
            step,
            size_bytes,
            sha256: input.sha256,
            mime_type,
            storage_key: None,
            storage_path: None,
            metadata,
        },
    )
    .await?;
    insert_artifact_attribute_tx(&mut tx, ctx.org_id, run_id, &artifact, input.path).await?;
    tx.commit().await?;
    Ok(artifact)
}

pub async fn upload_artifact(
    pool: &PgPool,
    config: &AppConfig,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UploadArtifactRequest,
) -> AppResult<ArtifactRow> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let kind = validate_artifact_type(input.kind.as_deref().unwrap_or("file"))?;
    let name = validate_name(input.name.as_deref(), "artifact name")?;
    let content = input
        .content_base64
        .ok_or_else(|| AppError::validation("content_base64 must be a non-empty string"))?;
    if content.trim().is_empty() {
        return Err(AppError::validation(
            "content_base64 must be a non-empty string",
        ));
    }
    let artifact_id = Uuid::new_v4();
    let mime_type = input
        .mime_type
        .or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_string))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let artifact_store = LocalArtifactStore::new(&config.artifact_root);
    let staged = artifact_store
        .stage_base64(ctx.org_id, run_id, artifact_id, &name, &content)
        .await?;
    if let Err(error) = artifact_store.finalize(&staged).await {
        artifact_store.cleanup(&staged.tmp_path).await;
        artifact_store.cleanup(&staged.final_path).await;
        return Err(error);
    }
    let artifact = match insert_uploaded_artifact(
        pool,
        ctx.org_id,
        run_id,
        artifact_id,
        &kind,
        &name,
        step,
        staged.size_bytes,
        &staged.sha256,
        &mime_type,
        &staged.storage_key,
        &staged.final_path,
        &staged.uri,
        metadata,
        input.path,
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

pub async fn list_artifacts(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<ArtifactRow>> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        MAX_ARTIFACT_LIST,
        MAX_ARTIFACT_LIST,
    )?;
    sqlx::query_as::<_, ArtifactRow>(
        r#"
        select id, org_id, run_id, type as kind, name, uri, step, size_bytes, sha256, mime_type,
               storage_backend, storage_key, storage_path, metadata, created_at
        from artifacts
        where org_id = $1 and run_id = $2
        order by coalesce(step, -1) asc, created_at asc
        limit $3
        "#,
    )
    .bind(ctx.org_id)
    .bind(run_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

pub async fn get_artifact(pool: &PgPool, artifact_id: Uuid) -> AppResult<ArtifactRow> {
    sqlx::query_as::<_, ArtifactRow>(
        r#"
        select id, org_id, run_id, type as kind, name, uri, step, size_bytes, sha256, mime_type,
               storage_backend, storage_key, storage_path, metadata, created_at
        from artifacts
        where id = $1
        "#,
    )
    .bind(artifact_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("artifact not found"))
}

pub async fn get_artifact_for_context(
    pool: &PgPool,
    ctx: &RequestContext,
    artifact_id: Uuid,
) -> AppResult<ArtifactRow> {
    let artifact = get_artifact(pool, artifact_id).await?;
    let run = fetch_run(pool, artifact.run_id).await?;
    ensure_run_access(ctx, &run)?;
    Ok(artifact)
}
pub(super) fn validate_artifact_type(kind: &str) -> AppResult<String> {
    let kind = validate_name(Some(kind), "type")?;
    if matches!(kind.as_str(), "checkpoint" | "rollout" | "file") {
        Ok(kind)
    } else {
        Err(AppError::validation(
            "type must be one of: checkpoint, file, rollout",
        ))
    }
}
pub(super) fn validate_size_bytes(value: &Value) -> AppResult<i64> {
    let number = value
        .as_i64()
        .ok_or_else(|| AppError::validation("size_bytes must be a nonnegative integer"))?;
    if number < 0 {
        return Err(AppError::validation(
            "size_bytes must be a nonnegative integer",
        ));
    }
    Ok(number)
}

pub(super) async fn fetch_artifact_for_run_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    artifact_id: Uuid,
) -> AppResult<ArtifactRow> {
    sqlx::query_as::<_, ArtifactRow>(
        r#"
        select id, org_id, run_id, type as kind, name, uri, step, size_bytes, sha256, mime_type,
               storage_backend, storage_key, storage_path, metadata, created_at
        from artifacts
        where org_id = $1 and run_id = $2 and id = $3
        "#,
    )
    .bind(org_id)
    .bind(run_id)
    .bind(artifact_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::validation("artifact_id must reference an artifact on the same run"))
}

pub(super) struct ArtifactInsert<'a> {
    pub(super) org_id: Uuid,
    pub(super) run_id: Uuid,
    pub(super) kind: &'a str,
    pub(super) name: &'a str,
    pub(super) uri: &'a str,
    pub(super) step: Option<f64>,
    pub(super) size_bytes: Option<i64>,
    pub(super) sha256: Option<String>,
    pub(super) mime_type: Option<String>,
    pub(super) storage_key: Option<String>,
    pub(super) storage_path: Option<String>,
    pub(super) metadata: Value,
}

pub(super) async fn insert_artifact_tx(
    tx: &mut Transaction<'_, Postgres>,
    input: ArtifactInsert<'_>,
) -> AppResult<ArtifactRow> {
    sqlx::query_as::<_, ArtifactRow>(
        r#"
        insert into artifacts
          (org_id, run_id, type, name, uri, step, size_bytes, sha256, mime_type, storage_backend, storage_key, storage_path, metadata)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'local', $10, $11, $12)
        returning id, org_id, run_id, type as kind, name, uri, step, size_bytes, sha256, mime_type,
                  storage_backend, storage_key, storage_path, metadata, created_at
        "#,
    )
    .bind(input.org_id)
    .bind(input.run_id)
    .bind(input.kind)
    .bind(input.name)
    .bind(input.uri)
    .bind(input.step)
    .bind(input.size_bytes)
    .bind(input.sha256)
    .bind(input.mime_type)
    .bind(input.storage_key)
    .bind(input.storage_path)
    .bind(Json(input.metadata))
    .fetch_one(&mut **tx)
    .await
    .map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
async fn insert_uploaded_artifact(
    pool: &PgPool,
    org_id: Uuid,
    run_id: Uuid,
    artifact_id: Uuid,
    kind: &str,
    name: &str,
    step: Option<f64>,
    size_bytes: i64,
    sha256: &str,
    mime_type: &str,
    storage_key: &str,
    storage_path: &std::path::Path,
    uri: &str,
    metadata: Value,
    attribute_path: Option<String>,
) -> AppResult<ArtifactRow> {
    let mut tx = pool.begin().await?;
    let artifact = sqlx::query_as::<_, ArtifactRow>(
        r#"
        insert into artifacts
          (id, org_id, run_id, type, name, uri, step, size_bytes, sha256, mime_type, storage_backend, storage_key, storage_path, metadata)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'local', $11, $12, $13)
        returning id, org_id, run_id, type as kind, name, uri, step, size_bytes, sha256, mime_type,
                  storage_backend, storage_key, storage_path, metadata, created_at
        "#,
    )
    .bind(artifact_id)
    .bind(org_id)
    .bind(run_id)
    .bind(kind)
    .bind(name)
    .bind(uri)
    .bind(step)
    .bind(size_bytes)
    .bind(sha256)
    .bind(mime_type)
    .bind(storage_key)
    .bind(storage_path.to_string_lossy().to_string())
    .bind(Json(metadata))
    .fetch_one(&mut *tx)
    .await?;
    insert_artifact_attribute_tx(&mut tx, org_id, run_id, &artifact, attribute_path).await?;
    tx.commit().await?;
    Ok(artifact)
}

pub(super) async fn insert_artifact_attribute_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    artifact: &ArtifactRow,
    path: Option<String>,
) -> AppResult<()> {
    let attribute_path = validate_name(
        Some(&path.unwrap_or_else(|| format!("artifacts/{}", artifact.name))),
        "attribute path",
    )?;
    let attribute_type = if artifact.step.is_some() {
        "file_series"
    } else {
        "file"
    };
    insert_attribute_tx(
        tx,
        org_id,
        run_id,
        &attribute_path,
        attribute_type,
        artifact.step,
        None,
        json!(artifact.uri),
        json!({
            "artifact_type": artifact.kind,
            "size_bytes": artifact.size_bytes,
            "sha256": artifact.sha256,
            "mime_type": artifact.mime_type
        }),
        Some(artifact.id),
    )
    .await?;
    Ok(())
}
pub(super) fn artifact_row_value(row: &PgRow) -> AppResult<Value> {
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "org_id": row.try_get::<Uuid, _>("org_id")?,
        "run_id": row.try_get::<Uuid, _>("run_id")?,
        "type": row.try_get::<String, _>("type")?,
        "name": row.try_get::<String, _>("name")?,
        "uri": row.try_get::<String, _>("uri")?,
        "step": row.try_get::<Option<f64>, _>("step")?,
        "size_bytes": row.try_get::<Option<i64>, _>("size_bytes")?,
        "sha256": row.try_get::<Option<String>, _>("sha256")?,
        "mime_type": row.try_get::<Option<String>, _>("mime_type")?,
        "storage_backend": row.try_get::<String, _>("storage_backend")?,
        "storage_key": row.try_get::<Option<String>, _>("storage_key")?,
        "storage_path": row.try_get::<Option<String>, _>("storage_path")?,
        "metadata": row.try_get::<Value, _>("metadata")?,
        "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?
    }))
}
