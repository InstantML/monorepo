use super::*;

pub async fn create_run(
    pool: &PgPool,
    ctx: &RequestContext,
    input: CreateRunRequest,
) -> AppResult<RunRow> {
    let project_name = validate_name(input.project.as_deref(), "project name")?;
    let project = if let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        let project = fetch_project_by_id(pool, ctx.org_id, project_id).await?;
        if project.name != project_name {
            return Err(AppError::forbidden(
                "api key is restricted to a different project",
            ));
        }
        project
    } else {
        create_project_inner(
            pool,
            ctx.org_id,
            CreateProjectRequest {
                name: Some(project_name.clone()),
                description: None,
            },
        )
        .await?
    };
    let run_name = validate_name(
        input
            .name
            .as_deref()
            .or(Some(&format!("{project_name}-run"))),
        "run name",
    )?;
    let config = validate_json_object(input.config, "config")?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    let tags = validate_tags(input.tags)?;
    let mut tx = pool.begin().await?;
    let run = sqlx::query_as::<_, RunRow>(
        r#"
        insert into runs (org_id, project_id, name, config, tags, metadata)
        values ($1, $2, $3, $4, $5, $6)
        returning id, org_id, project_id, $7::text as project, name, status, config, tags, metadata, created_at, started_at, finished_at
        "#,
    )
    .bind(ctx.org_id)
    .bind(project.id)
    .bind(run_name)
    .bind(Json(config.clone()))
    .bind(&tags)
    .bind(Json(metadata))
    .bind(project_name)
    .fetch_one(&mut *tx)
    .await?;
    for (key, value) in config.as_object().into_iter().flatten() {
        insert_attribute_tx(
            &mut tx,
            ctx.org_id,
            run.id,
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
            &mut tx,
            ctx.org_id,
            run.id,
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
    tx.commit().await?;
    Ok(run)
}

pub async fn list_runs(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_RUN_LIMIT,
    )?;
    let offset = validate_offset(query.get("offset").map(String::as_str))?;
    let page = query_run_page(pool, metric_store, ctx, query, limit, offset).await?;
    Ok(json!({
        "runs": page.runs,
        "limit": limit,
        "offset": offset,
        "next_cursor": page.next_cursor,
        "page_info": {
            "pagination": page.pagination,
            "has_next_page": page.next_cursor.is_some()
        }
    }))
}

pub async fn get_run(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<Value> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    run_summary_value(pool, metric_store, run).await
}

pub async fn update_run(
    pool: &PgPool,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UpdateRunRequest,
) -> AppResult<RunRow> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let status = input.status.as_deref().map(validate_status).transpose()?;
    let tags = input
        .tags
        .map(|tags| validate_tags(Some(tags)))
        .transpose()?;
    let notes = input
        .notes
        .map(|note| validate_note_patch(&note))
        .transpose()?;
    if status.is_none() && tags.is_none() && notes.is_none() {
        return Err(AppError::validation(
            "at least one of status, tags, or notes is required",
        ));
    }
    let mut metadata = run.metadata.clone();
    if let Some(note) = notes.as_ref() {
        let object = metadata
            .as_object_mut()
            .ok_or_else(|| AppError::validation("metadata must be an object"))?;
        if note.is_empty() {
            object.remove("notes");
        } else {
            object.insert("notes".to_string(), Value::String(note.clone()));
        }
    }
    sqlx::query_as::<_, RunRow>(
        r#"
        update runs
        set status = coalesce($3, runs.status),
            tags = coalesce($4, runs.tags),
            metadata = $5,
            finished_at = case
                when $3::text is null then runs.finished_at
                when $3 in ('finished', 'failed') then now()
                else null
            end
        from projects p
        where runs.project_id = p.id and runs.id = $1 and runs.org_id = $2
        returning runs.id, runs.org_id, runs.project_id, p.name as project, runs.name, runs.status, runs.config, runs.tags,
                  runs.metadata, runs.created_at, runs.started_at, runs.finished_at
        "#,
    )
    .bind(run_id)
    .bind(ctx.org_id)
    .bind(status)
    .bind(tags)
    .bind(Json(metadata))
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}
pub async fn runs_summary(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_RUN_LIMIT,
    )?;
    let offset = validate_offset(query.get("offset").map(String::as_str))?;
    let total = count_runs(pool, ctx, query).await?;
    let page = query_run_page(pool, metric_store, ctx, query, limit, offset).await?;
    let run_ids = page.runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let series = metric_series_for_runs(metric_store, ctx.org_id, &run_ids).await?;
    let artifact_counts = artifact_counts_for_runs(pool, ctx.org_id, &run_ids).await?;
    let metric_keys = metric_keys_for_filtered_runs(pool, metric_store, ctx, query).await?;
    let values = page
        .runs
        .into_iter()
        .map(|run| summarize_run(run, &series, &artifact_counts))
        .collect::<Vec<_>>();
    Ok(json!({
        "runs": values,
        "limit": limit,
        "offset": offset,
        "total": total,
        "metric_keys": metric_keys,
        "next_cursor": page.next_cursor,
        "page_info": {
            "pagination": page.pagination,
            "has_next_page": page.next_cursor.is_some()
        }
    }))
}

pub async fn overview(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let filters = run_filters(pool, ctx, query).await?;
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    let mut builder = QueryBuilder::<Postgres>::new("select id, status from runs r");
    push_run_filters(&mut builder, &filters);
    let run_rows = builder.build().fetch_all(pool).await?;
    let mut total_runs: i64 = 0;
    let mut active_runs: i64 = 0;
    let mut failed_runs: i64 = 0;
    let mut filtered_ids: Vec<Uuid> = Vec::with_capacity(run_rows.len());
    for row in run_rows {
        total_runs += 1;
        let status: String = row.try_get("status")?;
        match status.as_str() {
            "running" => active_runs += 1,
            "failed" => failed_runs += 1,
            _ => {}
        }
        filtered_ids.push(row.try_get("id")?);
    }
    let (metric_points, best_eval_return) = if filtered_ids.is_empty() {
        (0_i64, None)
    } else {
        let total_points: u64 = metric_store
            .client()
            .query(
                "SELECT toUInt64(countMerge(count)) \
                 FROM metric_series \
                 WHERE org_id = ? AND run_id IN ?",
            )
            .bind(ctx.org_id)
            .bind(&filtered_ids)
            .fetch_one::<u64>()
            .await
            .map_err(|err| {
                AppError::internal(format!("clickhouse overview points query failed: {err}"))
            })?;
        let best: Option<f64> = metric_store
            .client()
            .query(
                "SELECT maxMerge(max) \
                 FROM metric_series \
                 WHERE org_id = ? AND run_id IN ? AND key = ?",
            )
            .bind(ctx.org_id)
            .bind(&filtered_ids)
            .bind(metric_key)
            .fetch_optional::<f64>()
            .await
            .map_err(|err| {
                AppError::internal(format!("clickhouse overview best query failed: {err}"))
            })?;
        (total_points as i64, best)
    };
    Ok(json!({
        "overview": {
            "total_runs": total_runs,
            "active_runs": active_runs,
            "failed_runs": failed_runs,
            "metric_points": metric_points,
            "best_eval_return": best_eval_return
        }
    }))
}
fn ensure_same_org(ctx: &RequestContext, org_id: Uuid) -> AppResult<()> {
    if ctx.org_id == org_id {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "run belongs to a different organization",
        ))
    }
}

pub(super) fn ensure_project_access(ctx: &RequestContext, project_id: Uuid) -> AppResult<()> {
    match ctx.auth.as_ref().and_then(|auth| auth.project_id) {
        Some(allowed_project_id) if allowed_project_id != project_id => Err(AppError::forbidden(
            "api key is restricted to a different project",
        )),
        _ => Ok(()),
    }
}

pub(super) fn ensure_run_access(ctx: &RequestContext, run: &RunRow) -> AppResult<()> {
    ensure_same_org(ctx, run.org_id)?;
    ensure_project_access(ctx, run.project_id)
}

pub(super) fn ensure_unrestricted_org_key(ctx: &RequestContext) -> AppResult<()> {
    if ctx.auth.as_ref().and_then(|auth| auth.project_id).is_some() {
        Err(AppError::forbidden("api key is restricted to a project"))
    } else {
        Ok(())
    }
}

pub(super) async fn fetch_run(pool: &PgPool, run_id: Uuid) -> AppResult<RunRow> {
    sqlx::query_as::<_, RunRow>(
        r#"
        select r.id, r.org_id, r.project_id, p.name as project, r.name, r.status, r.config, r.tags, r.metadata,
               r.created_at, r.started_at, r.finished_at
        from runs r join projects p on p.org_id = r.org_id and p.id = r.project_id
        where r.id = $1
        "#,
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?
        .ok_or_else(|| AppError::not_found("run not found"))
}

#[derive(Debug, FromRow)]
struct RunQueryRow {
    id: Uuid,
    org_id: Uuid,
    project_id: Uuid,
    project: String,
    name: String,
    sort_name: String,
    status: String,
    config: Value,
    tags: Vec<String>,
    metadata: Value,
    created_at: DateTime<Utc>,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    sort_metric: Option<f64>,
    sort_duration: Option<f64>,
}

impl From<RunQueryRow> for RunRow {
    fn from(row: RunQueryRow) -> Self {
        Self {
            id: row.id,
            org_id: row.org_id,
            project_id: row.project_id,
            project: row.project,
            name: row.name,
            status: row.status,
            config: row.config,
            tags: row.tags,
            metadata: row.metadata,
            created_at: row.created_at,
            started_at: row.started_at,
            finished_at: row.finished_at,
        }
    }
}

struct RunPage {
    runs: Vec<RunRow>,
    next_cursor: Option<String>,
    pagination: &'static str,
}

#[derive(Debug, Deserialize, Serialize)]
struct RunPageCursor {
    v: u8,
    sort_by: String,
    metric_key: String,
    filter_hash: String,
    values: RunCursorValues,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RunCursorValues {
    Created {
        created_at: DateTime<Utc>,
        id: Uuid,
    },
    Name {
        name: String,
        id: Uuid,
    },
    Status {
        status: String,
        name: String,
        id: Uuid,
    },
    Duration {
        duration: Option<f64>,
        created_at: DateTime<Utc>,
        id: Uuid,
    },
    Metric {
        value: Option<f64>,
        created_at: DateTime<Utc>,
        id: Uuid,
    },
}

struct RunRowsQuery<'a> {
    pool: &'a PgPool,
    metric_store: &'a MetricStore,
    org_id: Uuid,
    filters: &'a RunFilters,
    sort_by: &'a str,
    metric_key: &'a str,
    cursor: Option<&'a RunCursorValues>,
    limit: i64,
    offset: i64,
}

async fn query_run_page(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    limit: i64,
    offset: i64,
) -> AppResult<RunPage> {
    let filters = run_filters(pool, ctx, query).await?;
    let sort_by = validate_run_sort(query.get("sort_by").or_else(|| query.get("sortBy")))?;
    let metric_key = query
        .get("metric_key")
        .map(|value| validate_name(Some(value), "metric key"))
        .transpose()?
        .unwrap_or_else(|| "eval/return_mean".to_string());
    let filter_hash = run_filter_hash(&filters, &sort_by, &metric_key, limit);
    let cursor = decode_run_cursor(query.get("cursor"), &sort_by, &metric_key, &filter_hash)?;
    let page_limit = limit + 1;
    let mut rows = query_run_rows(RunRowsQuery {
        pool,
        metric_store,
        org_id: ctx.org_id,
        filters: &filters,
        sort_by: &sort_by,
        metric_key: &metric_key,
        cursor: cursor.as_ref().map(|item| &item.values),
        limit: page_limit,
        offset: if cursor.is_some() { 0 } else { offset },
    })
    .await?;
    let has_next = rows.len() > limit as usize;
    if has_next {
        rows.pop();
    }
    let next_cursor = if has_next {
        rows.last()
            .map(|row| {
                encode_run_cursor(
                    &sort_by,
                    &metric_key,
                    &filter_hash,
                    cursor_values_for(row, &sort_by),
                )
            })
            .transpose()?
    } else {
        None
    };
    Ok(RunPage {
        runs: rows.into_iter().map(Into::into).collect(),
        next_cursor,
        pagination: if cursor.is_some() { "cursor" } else { "offset" },
    })
}

async fn query_run_rows(params: RunRowsQuery<'_>) -> AppResult<Vec<RunQueryRow>> {
    let metric_sort = matches!(params.sort_by, "metric-latest" | "metric-best");
    let metric_expr = if params.sort_by == "metric-latest" {
        "ms.latest"
    } else {
        "ms.max"
    };
    if metric_sort {
        return query_metric_sorted_run_rows(params).await;
    }
    let RunRowsQuery {
        pool,
        filters,
        sort_by,
        cursor,
        limit,
        offset,
        ..
    } = params;
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        select r.id, r.org_id, r.project_id, p.name as project, r.name, lower(r.name) as sort_name,
               r.status, r.config, r.tags, r.metadata,
               r.created_at, r.started_at, r.finished_at,
        "#,
    );
    builder.push("null::double precision");
    builder.push(
        r#" as sort_metric,
               extract(epoch from (r.finished_at - r.started_at))::double precision as sort_duration
        from runs r
        join projects p on p.org_id = r.org_id and p.id = r.project_id
        "#,
    );
    push_run_filters(&mut builder, filters);
    if let Some(cursor) = cursor {
        push_cursor_predicate(&mut builder, sort_by, metric_expr, cursor)?;
    }
    push_run_order(&mut builder, sort_by, metric_expr);
    builder.push(" limit ").push_bind(limit);
    if offset > 0 {
        builder.push(" offset ").push_bind(offset);
    }
    builder
        .build_query_as::<RunQueryRow>()
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// Sort runs by a metric value (`metric-latest` -> latest; `metric-best` -> max).
///
/// Cross-database join: filter run_ids in Postgres, fetch series aggregates
/// from ClickHouse for those ids, merge in memory, paginate, then hydrate the
/// page-sized subset of full run rows from Postgres.
/// Sort runs by a metric value (`metric-latest` -> latest; `metric-best` -> max).
///
/// Cross-database join: filter run_ids in Postgres, fetch series aggregates
/// from ClickHouse for those ids, merge in memory, then hydrate the page-sized
/// subset of full run rows from Postgres.
///
/// Cursor-based pagination is intentionally rejected here pending follow-up:
/// the cross-DB ordering semantics need to be reproduced precisely against the
/// previous SQL-only path before cursors can be relied on. Callers fall back
/// to offset pagination, which the UI already supports.
async fn query_metric_sorted_run_rows(params: RunRowsQuery<'_>) -> AppResult<Vec<RunQueryRow>> {
    let RunRowsQuery {
        pool,
        metric_store,
        org_id,
        filters,
        sort_by,
        metric_key,
        cursor,
        limit,
        offset,
    } = params;
    if cursor.is_some() {
        return Err(AppError::validation(
            "cursor pagination is not supported for metric-sort during the ClickHouse migration; use offset pagination",
        ));
    }
    let mut id_builder = QueryBuilder::<Postgres>::new("select r.id, r.created_at from runs r");
    push_run_filters(&mut id_builder, filters);
    let candidates: Vec<(Uuid, DateTime<Utc>)> = id_builder
        .build_query_as::<(Uuid, DateTime<Utc>)>()
        .fetch_all(pool)
        .await?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let candidate_ids: Vec<Uuid> = candidates.iter().map(|(id, _)| *id).collect();
    let series_rows = metric_store
        .query_series_for_runs(org_id, &candidate_ids, None)
        .await?;
    let mut metric_by_run: HashMap<Uuid, f64> = HashMap::new();
    for row in series_rows {
        if row.key != metric_key {
            continue;
        }
        let value = match sort_by {
            "metric-latest" => row.latest,
            _ => row.max,
        };
        metric_by_run.insert(row.run_id, value);
    }
    let mut ordered: Vec<(Option<f64>, DateTime<Utc>, Uuid)> = candidates
        .into_iter()
        .map(|(id, created_at)| (metric_by_run.get(&id).copied(), created_at, id))
        .collect();
    ordered.sort_by(|a, b| {
        // Metric value desc with NULLS LAST, then created_at desc, then id desc.
        match (a.0, b.0) {
            (Some(x), Some(y)) => match y.partial_cmp(&x) {
                Some(std::cmp::Ordering::Equal) | None => b.1.cmp(&a.1).then_with(|| b.2.cmp(&a.2)),
                Some(other) => other,
            },
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.1.cmp(&a.1).then_with(|| b.2.cmp(&a.2)),
        }
    });
    let page: Vec<(Option<f64>, DateTime<Utc>, Uuid)> = ordered
        .into_iter()
        .skip(offset.max(0) as usize)
        .take(limit.max(0) as usize)
        .collect();
    if page.is_empty() {
        return Ok(Vec::new());
    }
    let page_ids: Vec<Uuid> = page.iter().map(|slot| slot.2).collect();
    let raw_rows = sqlx::query_as::<_, RunQueryRow>(
        r#"
        select r.id, r.org_id, r.project_id, p.name as project, r.name, lower(r.name) as sort_name,
               r.status, r.config, r.tags, r.metadata,
               r.created_at, r.started_at, r.finished_at,
               null::double precision as sort_metric,
               extract(epoch from (r.finished_at - r.started_at))::double precision as sort_duration
        from runs r
        join projects p on p.org_id = r.org_id and p.id = r.project_id
        where r.id = any($1)
        "#,
    )
    .bind(&page_ids)
    .fetch_all(pool)
    .await?;
    let mut by_id: HashMap<Uuid, RunQueryRow> =
        raw_rows.into_iter().map(|row| (row.id, row)).collect();
    let mut output = Vec::with_capacity(page.len());
    for (metric_value, _, id) in page {
        if let Some(mut row) = by_id.remove(&id) {
            row.sort_metric = metric_value;
            output.push(row);
        }
    }
    Ok(output)
}

async fn count_runs(
    pool: &PgPool,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<i64> {
    let filters = run_filters(pool, ctx, query).await?;
    let mut builder = QueryBuilder::<Postgres>::new("select count(*) from runs r");
    push_run_filters(&mut builder, &filters);
    builder
        .build_query_scalar::<i64>()
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

struct RunFilters {
    project_id: Option<Uuid>,
    project_missing: bool,
    status: Option<String>,
    q: Vec<String>,
    restricted_project_id: Option<Uuid>,
    org_id: Uuid,
}

async fn run_filters(
    pool: &PgPool,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<RunFilters> {
    let q = query
        .get("q")
        .map(|value| {
            value
                .split_whitespace()
                .map(|part| part.trim().to_ascii_lowercase())
                .filter(|part| !part.is_empty())
                .take(MAX_SEARCH_TOKENS)
                .map(|part| format!("%{}%", escape_like_token(&part)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let requested_project_id = query
        .get("project_id")
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| {
            Uuid::parse_str(raw)
                .map_err(|_| AppError::validation("project_id must be a valid UUID"))
        })
        .transpose()?;
    let named_project_id =
        if let Some(project) = query.get("project").filter(|raw| !raw.trim().is_empty()) {
            sqlx::query_scalar::<_, Uuid>("select id from projects where org_id = $1 and name = $2")
                .bind(ctx.org_id)
                .bind(project)
                .fetch_optional(pool)
                .await?
        } else {
            None
        };
    let mut project_missing = query
        .get("project")
        .filter(|raw| !raw.trim().is_empty())
        .is_some()
        && named_project_id.is_none();
    if let (Some(requested), Some(named)) = (requested_project_id, named_project_id) {
        if requested != named {
            project_missing = true;
        }
    }
    let mut project_id = requested_project_id.or(named_project_id);
    let restricted_project_id = ctx.auth.as_ref().and_then(|auth| auth.project_id);
    if let Some(restricted) = restricted_project_id {
        if let Some(requested) = project_id {
            if requested != restricted {
                project_missing = true;
            }
        }
        project_id = Some(restricted);
    }
    let status = query
        .get("status")
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| validate_status(raw))
        .transpose()?;
    Ok(RunFilters {
        project_id,
        project_missing,
        status,
        q,
        restricted_project_id,
        org_id: ctx.org_id,
    })
}

fn push_run_filters(builder: &mut QueryBuilder<'_, Postgres>, filters: &RunFilters) {
    builder.push(" where r.org_id = ").push_bind(filters.org_id);
    if filters.project_missing {
        builder.push(" and false");
        return;
    }
    if let Some(project_id) = filters.project_id {
        builder.push(" and r.project_id = ").push_bind(project_id);
    }
    if let Some(status) = filters.status.as_ref() {
        builder.push(" and r.status = ").push_bind(status.clone());
    }
    for token in &filters.q {
        builder
            .push(" and r.search_text like ")
            .push_bind(token.clone())
            .push(" escape '\\'");
    }
}

fn push_run_order(builder: &mut QueryBuilder<'_, Postgres>, sort_by: &str, metric_expr: &str) {
    match sort_by {
        "name" => builder.push(" order by lower(r.name) asc, r.id asc"),
        "status" => builder.push(" order by r.status asc, lower(r.name) asc, r.id asc"),
        "duration" => builder.push(" order by extract(epoch from (r.finished_at - r.started_at)) desc nulls last, r.created_at desc, r.id desc"),
        "metric-latest" | "metric-best" => {
            builder
                .push(" order by ")
                .push(metric_expr)
                .push(" desc nulls last, r.created_at desc, r.id desc")
        }
        _ => builder.push(" order by r.created_at desc, r.id desc"),
    };
}

fn push_cursor_predicate(
    builder: &mut QueryBuilder<'_, Postgres>,
    sort_by: &str,
    metric_expr: &str,
    cursor: &RunCursorValues,
) -> AppResult<()> {
    match (sort_by, cursor) {
        ("created", RunCursorValues::Created { created_at, id }) => {
            builder.push(" and (r.created_at < ");
            builder.push_bind(*created_at);
            builder.push(" or (r.created_at = ");
            builder.push_bind(*created_at);
            builder.push(" and r.id < ");
            builder.push_bind(*id);
            builder.push("))");
        }
        ("name", RunCursorValues::Name { name, id }) => {
            builder.push(" and (lower(r.name) > ");
            builder.push_bind(name.clone());
            builder.push(" or (lower(r.name) = ");
            builder.push_bind(name.clone());
            builder.push(" and r.id > ");
            builder.push_bind(*id);
            builder.push("))");
        }
        ("status", RunCursorValues::Status { status, name, id }) => {
            builder.push(" and (r.status > ");
            builder.push_bind(status.clone());
            builder.push(" or (r.status = ");
            builder.push_bind(status.clone());
            builder.push(" and (lower(r.name) > ");
            builder.push_bind(name.clone());
            builder.push(" or (lower(r.name) = ");
            builder.push_bind(name.clone());
            builder.push(" and r.id > ");
            builder.push_bind(*id);
            builder.push("))))");
        }
        (
            "duration",
            RunCursorValues::Duration {
                duration,
                created_at,
                id,
            },
        ) => {
            push_desc_nulls_last_cursor(
                builder,
                "extract(epoch from (r.finished_at - r.started_at))",
                *duration,
                *created_at,
                *id,
            );
        }
        (
            "metric-latest" | "metric-best",
            RunCursorValues::Metric {
                value,
                created_at,
                id,
            },
        ) => {
            push_desc_nulls_last_cursor(builder, metric_expr, *value, *created_at, *id);
        }
        _ => {
            return Err(AppError::validation(
                "cursor sort values do not match sort_by",
            ));
        }
    }
    Ok(())
}

fn push_desc_nulls_last_cursor(
    builder: &mut QueryBuilder<'_, Postgres>,
    expression: &str,
    value: Option<f64>,
    created_at: DateTime<Utc>,
    id: Uuid,
) {
    builder.push(" and (");
    if let Some(value) = value {
        builder
            .push("(")
            .push(expression)
            .push(" is not null and (")
            .push(expression)
            .push(" < ")
            .push_bind(value)
            .push(" or (")
            .push(expression)
            .push(" = ")
            .push_bind(value)
            .push(" and ");
        push_created_desc_tie(builder, created_at, id);
        builder.push("))) or ");
        builder.push(expression).push(" is null");
    } else {
        builder.push(expression).push(" is null and ");
        push_created_desc_tie(builder, created_at, id);
    }
    builder.push(")");
}

fn push_created_desc_tie(
    builder: &mut QueryBuilder<'_, Postgres>,
    created_at: DateTime<Utc>,
    id: Uuid,
) {
    builder.push("(r.created_at < ");
    builder.push_bind(created_at);
    builder.push(" or (r.created_at = ");
    builder.push_bind(created_at);
    builder.push(" and r.id < ");
    builder.push_bind(id);
    builder.push("))");
}

fn cursor_values_for(row: &RunQueryRow, sort_by: &str) -> RunCursorValues {
    match sort_by {
        "name" => RunCursorValues::Name {
            name: row.sort_name.clone(),
            id: row.id,
        },
        "status" => RunCursorValues::Status {
            status: row.status.clone(),
            name: row.sort_name.clone(),
            id: row.id,
        },
        "duration" => RunCursorValues::Duration {
            duration: row.sort_duration,
            created_at: row.created_at,
            id: row.id,
        },
        "metric-latest" | "metric-best" => RunCursorValues::Metric {
            value: row.sort_metric,
            created_at: row.created_at,
            id: row.id,
        },
        _ => RunCursorValues::Created {
            created_at: row.created_at,
            id: row.id,
        },
    }
}

fn decode_run_cursor(
    raw: Option<&String>,
    sort_by: &str,
    metric_key: &str,
    filter_hash: &str,
) -> AppResult<Option<RunPageCursor>> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    if raw.len() > MAX_RUN_CURSOR_BYTES {
        return Err(AppError::validation("cursor is too large"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.as_bytes())
        .map_err(|_| AppError::validation("cursor is invalid"))?;
    let cursor: RunPageCursor =
        serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor is invalid"))?;
    if cursor.v != RUN_CURSOR_VERSION {
        return Err(AppError::validation("cursor version is unsupported"));
    }
    if cursor.sort_by != sort_by
        || cursor.metric_key != metric_key
        || cursor.filter_hash != filter_hash
    {
        return Err(AppError::validation("cursor does not match current query"));
    }
    Ok(Some(cursor))
}

fn encode_run_cursor(
    sort_by: &str,
    metric_key: &str,
    filter_hash: &str,
    values: RunCursorValues,
) -> AppResult<String> {
    let cursor = RunPageCursor {
        v: RUN_CURSOR_VERSION,
        sort_by: sort_by.to_string(),
        metric_key: metric_key.to_string(),
        filter_hash: filter_hash.to_string(),
        values,
    };
    let bytes =
        serde_json::to_vec(&cursor).map_err(|_| AppError::internal("cursor encode failed"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn run_filter_hash(filters: &RunFilters, sort_by: &str, metric_key: &str, limit: i64) -> String {
    let payload = json!({
        "v": RUN_CURSOR_VERSION,
        "org_id": filters.org_id,
        "project_id": filters.project_id,
        "project_missing": filters.project_missing,
        "status": filters.status,
        "q": filters.q,
        "restricted_project_id": filters.restricted_project_id,
        "sort_by": sort_by,
        "metric_key": metric_key,
        "limit": limit,
    });
    let digest = Sha256::digest(payload.to_string().as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn validate_note_patch(note: &str) -> AppResult<String> {
    let trimmed = note.trim().to_string();
    if trimmed.len() > MAX_TEXT_BYTES {
        return Err(AppError::validation(format!(
            "notes must be at most {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok(trimmed)
}

fn escape_like_token(token: &str) -> String {
    token
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn validate_run_sort(value: Option<&String>) -> AppResult<String> {
    let sort_by = value
        .map(String::as_str)
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or("created");
    if matches!(
        sort_by,
        "created" | "metric-latest" | "metric-best" | "name" | "status" | "duration"
    ) {
        Ok(sort_by.to_string())
    } else {
        Err(AppError::validation(
            "sort_by must be one of: created, duration, metric-best, metric-latest, name, status",
        ))
    }
}

async fn metric_keys_for_filtered_runs(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<BTreeSet<String>> {
    let filters = run_filters(pool, ctx, query).await?;
    let mut builder = QueryBuilder::<Postgres>::new("select r.id from runs r");
    push_run_filters(&mut builder, &filters);
    let run_ids: Vec<Uuid> = builder.build_query_scalar::<Uuid>().fetch_all(pool).await?;
    if run_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    let keys: Vec<String> = metric_store
        .client()
        .query(
            "SELECT DISTINCT key FROM metric_series \
             WHERE org_id = ? AND run_id IN ? \
             ORDER BY key",
        )
        .bind(ctx.org_id)
        .bind(&run_ids)
        .fetch_all::<String>()
        .await
        .map_err(|err| AppError::internal(format!("clickhouse metric-keys query failed: {err}")))?;
    Ok(keys.into_iter().collect())
}

async fn run_summary_value(
    pool: &PgPool,
    metric_store: &MetricStore,
    run: RunRow,
) -> AppResult<Value> {
    let run_ids = vec![run.id];
    let series = metric_series_for_runs(metric_store, run.org_id, &run_ids).await?;
    let counts = artifact_counts_for_runs(pool, run.org_id, &run_ids).await?;
    Ok(summarize_run(run, &series, &counts))
}

fn summarize_run(
    run: RunRow,
    series: &[MetricSeriesRow],
    artifact_counts: &HashMap<Uuid, BTreeMap<String, i64>>,
) -> Value {
    let mut latest = Map::new();
    let mut aggregates = Map::new();
    let mut keys = Vec::new();
    for item in series.iter().filter(|item| item.run_id == run.id) {
        latest.insert(item.key.clone(), json!(item.latest));
        aggregates.insert(
            item.key.clone(),
            json!({
                "latest": item.latest,
                "min": item.min,
                "max": item.max,
                "mean": item.mean,
                "variance": item.variance,
                "count": item.count,
                "best_step": item.best_step
            }),
        );
        keys.push(item.key.clone());
    }
    keys.sort();
    let counts = artifact_counts.get(&run.id).cloned().unwrap_or_else(|| {
        BTreeMap::from([
            ("checkpoint".to_string(), 0),
            ("rollout".to_string(), 0),
            ("file".to_string(), 0),
        ])
    });
    let mut value = serde_json::to_value(run).expect("run serializes");
    if let Value::Object(map) = &mut value {
        map.insert("latest_metrics".to_string(), Value::Object(latest));
        map.insert("metric_aggregates".to_string(), Value::Object(aggregates));
        map.insert("metric_keys".to_string(), json!(keys));
        map.insert("artifact_counts".to_string(), json!(counts));
    }
    value
}

async fn metric_series_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs(org_id, run_ids, None)
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

pub(super) async fn metric_series_for_runs_limited(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs(org_id, run_ids, Some(limit))
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

pub(super) fn series_row_from_aggregate(
    aggregate: crate::metric_store::SeriesReadRow,
) -> MetricSeriesRow {
    let count = aggregate.count as i64;
    let mean = if count > 0 {
        Some(aggregate.sum / count as f64)
    } else {
        None
    };
    let variance = mean.map(|m| {
        let raw = aggregate.sum_sq / count as f64 - m * m;
        if raw < 0.0 {
            0.0
        } else {
            raw
        }
    });
    let some_if_any = |value: f64| if count > 0 { Some(value) } else { None };
    MetricSeriesRow {
        run_id: aggregate.run_id,
        key: aggregate.key,
        count,
        min: some_if_any(aggregate.min),
        max: some_if_any(aggregate.max),
        mean,
        variance,
        latest: some_if_any(aggregate.latest),
        latest_step: some_if_any(aggregate.latest_step),
        // `best` mirrors the prior Postgres behavior which always tracked max
        // regardless of metric direction. `best_step` is the step at which
        // that max occurred.
        best: some_if_any(aggregate.max),
        best_step: some_if_any(aggregate.best_step),
    }
}

async fn artifact_counts_for_runs(
    pool: &PgPool,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<HashMap<Uuid, BTreeMap<String, i64>>> {
    let mut counts = HashMap::new();
    for run_id in run_ids {
        counts.insert(
            *run_id,
            BTreeMap::from([
                ("checkpoint".to_string(), 0),
                ("rollout".to_string(), 0),
                ("file".to_string(), 0),
            ]),
        );
    }
    if run_ids.is_empty() {
        return Ok(counts);
    }
    let rows = sqlx::query(
        "select run_id, type, count(*) as count from artifacts where org_id = $1 and run_id = any($2) group by run_id, type",
    )
    .bind(org_id)
    .bind(run_ids)
    .fetch_all(pool)
    .await?;
    for row in rows {
        let run_id: Uuid = row.try_get("run_id")?;
        let kind: String = row.try_get("type")?;
        let count: i64 = row.try_get("count")?;
        counts.entry(run_id).or_default().insert(kind, count);
    }
    Ok(counts)
}

pub(super) async fn side_by_side_attributes(
    pool: &PgPool,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: i64,
) -> AppResult<Vec<AttributeRow>> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_as::<_, AttributeRow>(
        r#"
        select id, org_id, run_id, path, type as kind, step, logged_at, value, summary, artifact_id, created_at
        from attributes
        where org_id = $1 and run_id = any($2)
        order by path, run_id, coalesce(step, -1), id
        limit $3
        "#,
    )
    .bind(org_id)
    .bind(run_ids)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}
