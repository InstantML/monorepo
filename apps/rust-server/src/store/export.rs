use super::*;

pub async fn export_data(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    if ctx.auth.is_some() {
        ctx.auth
            .as_ref()
            .expect("checked")
            .require_scope("export:read")?;
    }
    let project = query.get("project").cloned();
    let project_id = query
        .get("project_id")
        .map(|raw| {
            Uuid::parse_str(raw)
                .map_err(|_| AppError::validation("project_id must be a valid UUID"))
        })
        .transpose()?;
    let restricted_project_id = ctx.auth.as_ref().and_then(|auth| auth.project_id);
    let projects = if let Some(project) = project {
        sqlx::query_as::<_, ProjectRow>(
            r#"
            select id, org_id, name, description, created_at
            from projects
            where org_id = $1 and name = $2
              and ($3::uuid is null or id = $3)
              and ($4::uuid is null or id = $4)
            order by name
            "#,
        )
        .bind(ctx.org_id)
        .bind(project)
        .bind(project_id)
        .bind(restricted_project_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, ProjectRow>(
            r#"
            select id, org_id, name, description, created_at
            from projects
            where org_id = $1
              and ($2::uuid is null or id = $2)
              and ($3::uuid is null or id = $3)
            order by name
            "#,
        )
        .bind(ctx.org_id)
        .bind(project_id)
        .bind(restricted_project_id)
        .fetch_all(pool)
        .await?
    };
    let project_ids = projects
        .iter()
        .map(|project| project.id)
        .collect::<Vec<_>>();
    let runs = if project_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, RunRow>(
            r#"
            select r.id, r.org_id, r.project_id, p.name as project, r.name, r.status, r.config, r.tags, r.metadata,
                   r.created_at, r.started_at, r.finished_at
            from runs r join projects p on p.org_id = r.org_id and p.id = r.project_id
            where r.org_id = $1 and r.project_id = any($2)
            order by r.created_at desc, r.id desc
            limit $3
            "#,
        )
        .bind(ctx.org_id)
        .bind(&project_ids)
        .bind(MAX_EXPORT_RUNS)
        .fetch_all(pool)
        .await?
    };
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metrics = if run_ids.is_empty() {
        Vec::new()
    } else {
        metric_point_values_for_runs(metric_store, ctx.org_id, &run_ids, MAX_EXPORT_METRICS).await?
    };
    let attributes = if run_ids.is_empty() {
        Vec::new()
    } else {
        attribute_values_for_runs(pool, ctx.org_id, &run_ids, MAX_EXPORT_ATTRIBUTES).await?
    };
    let artifacts = if run_ids.is_empty() {
        Vec::new()
    } else {
        artifact_values_for_runs(pool, ctx.org_id, &run_ids, MAX_EXPORT_ARTIFACTS).await?
    };
    let table_object_rows = if run_ids.is_empty() {
        Vec::new()
    } else {
        table_object_row_values_for_runs(pool, ctx.org_id, &run_ids, MAX_EXPORT_TABLE_OBJECT_ROWS)
            .await?
    };
    let imports = if run_ids.is_empty() {
        Vec::new()
    } else {
        import_values_for_runs(pool, ctx.org_id, &run_ids, MAX_IMPORT_LIST).await?
    };
    let organization = sqlx::query_as::<_, OrganizationRow>(
        "select id, slug::text as slug, name, plan_tier, account_type, seat_limit, created_by_user_id, created_at from organizations where id = $1",
    )
    .bind(ctx.org_id)
    .fetch_one(pool)
    .await?;
    Ok(json!({
        "version": 1,
        "exported_at": Utc::now(),
        "organizations": [organization],
        "projects": projects,
        "runs": runs,
        "metric_series": metric_series_values_for_runs(metric_store, ctx.org_id, &run_ids).await?,
        "metrics": metrics,
        "attributes": attributes,
        "artifacts": artifacts,
        "table_object_rows": table_object_rows,
        "imports": imports,
        "limits": {
            "runs": MAX_EXPORT_RUNS,
            "metrics": MAX_EXPORT_METRICS,
            "attributes": MAX_EXPORT_ATTRIBUTES,
            "artifacts": MAX_EXPORT_ARTIFACTS,
            "table_object_rows": MAX_EXPORT_TABLE_OBJECT_ROWS,
            "imports": MAX_IMPORT_LIST
        }
    }))
}

async fn metric_point_values_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<Value>> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(clickhouse::Row, serde::Deserialize)]
    struct ExportRow {
        #[serde(with = "clickhouse::serde::uuid")]
        org_id: Uuid,
        #[serde(with = "clickhouse::serde::uuid")]
        run_id: Uuid,
        key: String,
        step: f64,
        value: f64,
        #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
        logged_at: DateTime<Utc>,
        #[serde(with = "clickhouse::serde::chrono::datetime64::micros")]
        created_at: DateTime<Utc>,
    }
    let rows = metric_store
        .client()
        .query(
            "SELECT org_id, run_id, key, step, value, logged_at, created_at \
             FROM metric_points \
             WHERE org_id = ? AND run_id IN ? \
             ORDER BY run_id, step, created_at \
             LIMIT ?",
        )
        .bind(org_id)
        .bind(run_ids)
        .bind(limit)
        .fetch_all::<ExportRow>()
        .await
        .map_err(|err| AppError::internal(format!("clickhouse export metrics failed: {err}")))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "org_id": row.org_id,
                "run_id": row.run_id,
                "key": row.key,
                "step": row.step,
                "value": row.value,
                "logged_at": row.logged_at,
                "created_at": row.created_at,
            })
        })
        .collect())
}

async fn metric_series_values_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<Vec<Value>> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }
    let aggregates = metric_store
        .query_series_for_runs(org_id, run_ids, None)
        .await?;
    Ok(aggregates
        .into_iter()
        .map(|row| {
            let series = series_row_from_aggregate(row);
            json!({
                "org_id": org_id,
                "run_id": series.run_id,
                "key": series.key,
                "count": series.count,
                "min": series.min,
                "max": series.max,
                "mean": series.mean,
                "variance": series.variance,
                "latest": series.latest,
                "latest_step": series.latest_step,
                "best": series.best,
                "best_step": series.best_step,
            })
        })
        .collect())
}

async fn attribute_values_for_runs(
    pool: &PgPool,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        r#"
        select id, org_id, run_id, path, type, step, logged_at, value, summary, artifact_id, created_at
        from attributes
        where org_id = $1 and run_id = any($2)
        order by run_id, path, coalesce(step, -1), id
        limit $3
        "#,
    )
    .bind(org_id)
    .bind(run_ids)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(attribute_row_value).collect()
}

async fn artifact_values_for_runs(
    pool: &PgPool,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        r#"
        select id, org_id, run_id, type, name, uri, step, size_bytes, sha256, mime_type,
               storage_backend, storage_key, storage_path, metadata, created_at
        from artifacts
        where org_id = $1 and run_id = any($2)
        order by run_id, coalesce(step, -1), created_at, id
        limit $3
        "#,
    )
    .bind(org_id)
    .bind(run_ids)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(artifact_row_value).collect()
}

async fn table_object_row_values_for_runs(
    pool: &PgPool,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        r#"
        select rows.id, rows.org_id, rows.attribute_id, attributes.run_id, rows.row_index, rows.row, rows.created_at
        from table_object_rows rows
        join attributes on attributes.org_id = rows.org_id and attributes.id = rows.attribute_id
        where rows.org_id = $1 and attributes.run_id = any($2)
        order by attributes.run_id, rows.attribute_id, rows.row_index
        limit $3
        "#,
    )
    .bind(org_id)
    .bind(run_ids)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": row.try_get::<i64, _>("id")?,
                "org_id": row.try_get::<Uuid, _>("org_id")?,
                "run_id": row.try_get::<Uuid, _>("run_id")?,
                "attribute_id": row.try_get::<i64, _>("attribute_id")?,
                "row_index": row.try_get::<i64, _>("row_index")?,
                "row": row.try_get::<Value, _>("row")?,
                "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?
            }))
        })
        .collect()
}

async fn import_values_for_runs(
    pool: &PgPool,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        r#"
        select id, org_id, project_id, source_type, status, summary, run_ids, created_at, completed_at
        from imports
        where org_id = $1 and run_ids && $2
        order by created_at desc
        limit $3
        "#,
    )
    .bind(org_id)
    .bind(run_ids)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.iter().map(imports::import_row_value).collect()
}
