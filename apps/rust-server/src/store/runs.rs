use super::*;

pub async fn create_project(
    store: &Store,
    ctx: &RequestContext,
    input: CreateProjectRequest,
) -> AppResult<ProjectRow> {
    if let Some(auth) = &ctx.auth {
        if auth.project_id.is_some() {
            return Err(AppError::forbidden(
                "project-scoped API keys cannot create projects",
            ));
        }
    }
    let name = validate_name(input.name.as_deref(), "project name")?;
    let description = validate_optional_name(input.description.as_deref(), "project description")?;
    {
        let data = store.data.lock().await;
        if let Some(project_id) = data
            .projects_by_org_name
            .get(&(ctx.org_id, name.clone()))
            .copied()
        {
            return data
                .projects
                .get(&project_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("project not found"));
        }
    }
    enforce_plan_capacity(
        store,
        ctx.org_id,
        UsageDelta {
            projects: 1,
            storage_bytes: PROJECT_METADATA_BYTES,
            ..UsageDelta::default()
        },
        "create a project",
    )
    .await?;
    let mut data = store.data.lock().await;
    if let Some(project_id) = data
        .projects_by_org_name
        .get(&(ctx.org_id, name.clone()))
        .copied()
    {
        return data
            .projects
            .get(&project_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    let project = ProjectRow {
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        name,
        description,
        created_at: Utc::now(),
    };
    store
        .persist_locked("project", ctx.org_id, &project.id.to_string(), &project)
        .await?;
    data.insert_project(project.clone());
    Ok(project)
}

pub async fn list_projects(store: &Store, ctx: &RequestContext) -> AppResult<Vec<ProjectRow>> {
    let data = store.data.lock().await;
    let mut projects = data
        .projects
        .values()
        .filter(|project| project.org_id == ctx.org_id)
        .filter(|project| {
            ctx.auth
                .as_ref()
                .and_then(|auth| auth.project_id)
                .map(|id| id == project.id)
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(projects)
}

pub async fn create_run(
    store: &Store,
    ctx: &RequestContext,
    input: CreateRunRequest,
) -> AppResult<RunRow> {
    let project_name = validate_name(input.project.as_deref(), "project")?;
    let name = validate_name(input.name.as_deref().or(Some("run")), "run name")?;
    let config = validate_json_object(input.config, "config")?;
    let tags = validate_tags(input.tags)?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
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
    let mut data = store.data.lock().await;
    let mut run = fetch_run_in_data(&data, ctx, run_id)?;
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
    data.insert_run(run.clone());
    Ok(run)
}

pub async fn get_run(store: &Store, ctx: &RequestContext, run_id: Uuid) -> AppResult<Value> {
    let run = {
        let data = store.data.lock().await;
        fetch_run_in_data(&data, ctx, run_id)?
    };
    run_summary_value(store, run).await
}

pub async fn list_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_RUN_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let runs = filtered_runs(store, ctx, query).await?;
    let values = summarize_runs(store, runs.into_iter().skip(offset).take(limit).collect()).await?;
    Ok(json!({ "runs": values }))
}

pub async fn overview(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    if project_filter(query).is_none()
        && !has_text_search(query)
        && !has_status_filter(query)
        && ctx.auth.as_ref().and_then(|auth| auth.project_id).is_none()
    {
        let (total_runs, active_runs, failed_runs) = {
            let data = store.data.lock().await;
            data.runs
                .values()
                .filter(|run| run.org_id == ctx.org_id)
                .fold(
                    (0_usize, 0_usize, 0_usize),
                    |(total, active, failed), run| {
                        (
                            total + 1,
                            active + usize::from(run.status == "running"),
                            failed + usize::from(run.status == "failed"),
                        )
                    },
                )
        };
        let metric_store = store.metric_store_for_org(ctx.org_id).await?;
        let best_eval_return = metric_store
            .query_top_series_for_org_key(ctx.org_id, metric_key, SeriesSortMode::BestMax, 1)
            .await?
            .into_iter()
            .next()
            .map(|row| row.max);
        let metric_points = metric_store.count_points_for_org(ctx.org_id).await?;
        return Ok(json!({
            "overview": {
                "total_runs": total_runs,
                "active_runs": active_runs,
                "failed_runs": failed_runs,
                "best_eval_return": best_eval_return,
                "metric_points": metric_points
            }
        }));
    }
    if let Some(project) = project_filter(query) {
        if !has_text_search(query)
            && !has_status_filter(query)
            && ctx.auth.as_ref().and_then(|auth| auth.project_id).is_none()
        {
            let (total_runs, active_runs, failed_runs) = {
                let data = store.data.lock().await;
                data.runs
                    .values()
                    .filter(|run| run.org_id == ctx.org_id && run.project == project)
                    .fold(
                        (0_usize, 0_usize, 0_usize),
                        |(total, active, failed), run| {
                            (
                                total + 1,
                                active + usize::from(run.status == "running"),
                                failed + usize::from(run.status == "failed"),
                            )
                        },
                    )
            };
            let metric_store = store.metric_store_for_org(ctx.org_id).await?;
            let sort_mode = if is_minimize_metric(metric_key) {
                SeriesSortMode::BestMin
            } else {
                SeriesSortMode::BestMax
            };
            let best_eval_return = metric_store
                .query_top_series_for_project_key(ctx.org_id, project, metric_key, sort_mode, 1)
                .await?
                .into_iter()
                .next()
                .map(|row| {
                    if is_minimize_metric(metric_key) {
                        row.min
                    } else {
                        row.max
                    }
                });
            let metric_points = metric_store
                .count_points_for_project(ctx.org_id, project)
                .await?;
            return Ok(json!({
                "overview": {
                    "total_runs": total_runs,
                    "active_runs": active_runs,
                    "failed_runs": failed_runs,
                    "best_eval_return": best_eval_return,
                    "metric_points": metric_points
                }
            }));
        }
    }
    let runs = filtered_runs(store, ctx, query).await?;
    let total_runs = runs.len();
    let active_runs = runs.iter().filter(|run| run.status == "running").count();
    let failed_runs = runs.iter().filter(|run| run.status == "failed").count();
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let series =
        metric_series_for_runs_key_chunked(&metric_store, ctx.org_id, &run_ids, metric_key).await?;
    let best_eval_return = series
        .iter()
        .filter_map(|row| row.best)
        .max_by(|a, b| a.total_cmp(b));
    let metric_points = count_points_for_runs_chunked(&metric_store, ctx.org_id, &run_ids).await?;
    Ok(json!({
        "overview": {
            "total_runs": total_runs,
            "active_runs": active_runs,
            "failed_runs": failed_runs,
            "best_eval_return": best_eval_return,
            "metric_points": metric_points
        }
    }))
}

pub async fn runs_summary(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_RUN_LIMIT,
    )? as usize;
    let offset = if let Some(cursor) = query.get("cursor") {
        cursor
            .strip_prefix("offset:")
            .and_then(|raw| raw.parse::<usize>().ok())
            .unwrap_or(0)
    } else {
        validate_offset(query.get("offset").map(String::as_str))? as usize
    };
    let sort_by = validate_run_sort(
        query
            .get("sort_by")
            .map(String::as_str)
            .unwrap_or("created"),
    )?;
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    let indexed_page = if sort_by == "created" {
        let data = store.data.lock().await;
        created_index_page(&data, ctx, query, offset, limit)
    } else if matches!(sort_by.as_str(), "metric-latest" | "metric-best") {
        metric_sorted_index_page(store, ctx, query, &sort_by, metric_key, offset, limit).await?
    } else {
        None
    };
    let (total, page_runs) = if let Some(page) = indexed_page {
        page
    } else {
        let mut all_runs = collect_filtered_runs(store, ctx, query).await?;
        let total = all_runs.len();
        let page_runs = if matches!(sort_by.as_str(), "metric-latest" | "metric-best")
            && all_runs.len() > MAX_CLICKHOUSE_RUN_ID_CHUNK
        {
            metric_sorted_page(store, ctx, &all_runs, &sort_by, metric_key, offset, limit).await?
        } else {
            sort_runs(store, ctx, query, &mut all_runs).await?;
            all_runs
                .iter()
                .skip(offset)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        };
        (total, page_runs)
    };
    let run_ids = page_runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let metric_keys = metric_store
        .query_keys_for_runs(ctx.org_id, &run_ids, 250_i64)
        .await?;
    let next_offset = offset + page_runs.len();
    let has_next = next_offset < total;
    Ok(json!({
        "runs": summarize_runs(store, page_runs).await?,
        "metric_keys": metric_keys,
        "total": total,
        "next_cursor": if has_next { json!(format!("offset:{next_offset}")) } else { Value::Null },
        "page_info": { "pagination": "cursor", "has_next_page": has_next }
    }))
}

pub(super) async fn filtered_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Vec<RunRow>> {
    let mut runs = collect_filtered_runs(store, ctx, query).await?;
    sort_runs(store, ctx, query, &mut runs).await?;
    Ok(runs)
}

async fn collect_filtered_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Vec<RunRow>> {
    let project = query
        .get("project")
        .filter(|value| !value.is_empty() && value.as_str() != "all");
    let status = query
        .get("status")
        .filter(|value| !value.is_empty() && value.as_str() != "all");
    let tokens = query
        .get("q")
        .map(|q| {
            q.split_whitespace()
                .map(|part| part.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let runs = {
        let data = store.data.lock().await;
        data.runs
            .values()
            .filter(|run| run.org_id == ctx.org_id)
            .filter(|run| {
                ctx.auth
                    .as_ref()
                    .and_then(|auth| auth.project_id)
                    .map(|id| id == run.project_id)
                    .unwrap_or(true)
            })
            .filter(|run| project.map(|name| run.project == *name).unwrap_or(true))
            .filter(|run| status.map(|value| run.status == *value).unwrap_or(true))
            .filter(|run| {
                if tokens.is_empty() {
                    return true;
                }
                data.run_search_texts
                    .get(&run.id)
                    .map(|haystack| tokens.iter().all(|token| haystack.contains(token)))
                    .unwrap_or_else(|| {
                        let haystack = run_search_text(run);
                        tokens.iter().all(|token| haystack.contains(token))
                    })
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    Ok(runs)
}

async fn sort_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    runs: &mut [RunRow],
) -> AppResult<()> {
    let sort_by = validate_run_sort(
        query
            .get("sort_by")
            .map(String::as_str)
            .unwrap_or("created"),
    )?;
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    match sort_by.as_str() {
        "metric-latest" | "metric-best" => {
            let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
            let metric_store = store.metric_store_for_org(ctx.org_id).await?;
            let series =
                metric_series_for_runs_key_chunked(&metric_store, ctx.org_id, &run_ids, metric_key)
                    .await?
                    .into_iter()
                    .map(|row| (row.run_id, row))
                    .collect::<HashMap<_, _>>();
            sort_runs_by_metric(runs, &sort_by, metric_key, &series);
        }
        "duration" => runs.sort_by(|a, b| {
            numeric_desc(duration_seconds(a), duration_seconds(b))
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "name" => runs.sort_by(|a, b| {
            a.name
                .cmp(&b.name)
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "status" => runs.sort_by(|a, b| {
            a.status
                .cmp(&b.status)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "created" => runs.sort_by_key(|run| std::cmp::Reverse(run.created_at)),
        _ => runs.sort_by_key(|run| std::cmp::Reverse(run.created_at)),
    }
    Ok(())
}

async fn metric_sorted_index_page(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    sort_by: &str,
    metric_key: &str,
    offset: usize,
    limit: usize,
) -> AppResult<Option<(usize, Vec<RunRow>)>> {
    if has_text_search(query) || has_status_filter(query) {
        return Ok(None);
    }
    let total = {
        let data = store.data.lock().await;
        let tokens = text_search_tokens(query);
        indexed_run_total(&data, ctx, query, &tokens)
    };
    if total <= MAX_CLICKHOUSE_RUN_ID_CHUNK {
        return Ok(None);
    }
    let mode = metric_sort_mode(sort_by, metric_key);
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let target = offset.saturating_add(limit);
    let mut fetch_limit = target.max(1_000).min(total).max(limit);
    let page = loop {
        let rows = metric_store
            .query_top_series_for_org_key(ctx.org_id, metric_key, mode, fetch_limit as i64)
            .await?;
        let mut page = {
            let data = store.data.lock().await;
            let tokens = text_search_tokens(query);
            rows.into_iter()
                .filter_map(|row| data.runs.get(&row.run_id))
                .filter(|run| run_matches_indexed_query(&data, ctx, query, run, &tokens))
                .cloned()
                .collect::<Vec<_>>()
        };
        if page.len() >= target || fetch_limit == total {
            let mut seen = page.iter().map(|run| run.id).collect::<BTreeSet<_>>();
            if page.len() < target {
                let data = store.data.lock().await;
                let tokens = text_search_tokens(query);
                append_created_index_runs(&data, ctx, query, &tokens, &mut seen, target, &mut page);
            }
            break page;
        }
        fetch_limit = (fetch_limit * 2).min(total);
    };
    Ok(Some((
        total,
        page.into_iter().skip(offset).take(limit).collect(),
    )))
}

async fn metric_sorted_page(
    store: &Store,
    ctx: &RequestContext,
    runs: &[RunRow],
    sort_by: &str,
    metric_key: &str,
    offset: usize,
    limit: usize,
) -> AppResult<Vec<RunRow>> {
    let run_by_id = runs
        .iter()
        .map(|run| (run.id, run.clone()))
        .collect::<HashMap<_, _>>();
    let mode = metric_sort_mode(sort_by, metric_key);
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let target = offset.saturating_add(limit);
    let mut fetch_limit = target.max(1_000).min(runs.len()).max(limit);
    let ordered = loop {
        let rows = metric_store
            .query_top_series_for_org_key(ctx.org_id, metric_key, mode, fetch_limit as i64)
            .await?;
        let page = rows
            .into_iter()
            .filter_map(|row| run_by_id.get(&row.run_id).cloned())
            .collect::<Vec<_>>();
        if page.len() >= target || fetch_limit == runs.len() {
            break page;
        }
        fetch_limit = (fetch_limit * 2).min(runs.len());
    };
    let mut seen = ordered.iter().map(|run| run.id).collect::<BTreeSet<_>>();
    let mut page = ordered;
    if page.len() < target {
        let mut without_metric = runs
            .iter()
            .filter(|run| !seen.contains(&run.id))
            .cloned()
            .collect::<Vec<_>>();
        without_metric.sort_by_key(|run| std::cmp::Reverse(run.created_at));
        for run in without_metric {
            seen.insert(run.id);
            page.push(run);
            if page.len() >= target {
                break;
            }
        }
    }
    Ok(page.into_iter().skip(offset).take(limit).collect())
}

fn metric_sort_mode(sort_by: &str, metric_key: &str) -> SeriesSortMode {
    if sort_by == "metric-latest" {
        SeriesSortMode::Latest
    } else if is_minimize_metric(metric_key) {
        SeriesSortMode::BestMin
    } else {
        SeriesSortMode::BestMax
    }
}

fn created_index_page(
    data: &StoreData,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    offset: usize,
    limit: usize,
) -> Option<(usize, Vec<RunRow>)> {
    let tokens = text_search_tokens(query);
    let total = indexed_run_total(data, ctx, query, &tokens);
    let mut seen = BTreeSet::new();
    let mut page = Vec::with_capacity(limit);
    append_created_index_runs(
        data,
        ctx,
        query,
        &tokens,
        &mut seen,
        offset.saturating_add(limit),
        &mut page,
    );
    Some((total, page.into_iter().skip(offset).take(limit).collect()))
}

fn append_created_index_runs(
    data: &StoreData,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    tokens: &[String],
    seen: &mut BTreeSet<Uuid>,
    target: usize,
    page: &mut Vec<RunRow>,
) {
    if let Some(project) = project_filter(query) {
        for ((org_id, project_name, _, run_id), _) in data.runs_by_org_project_created.iter().rev()
        {
            if *org_id != ctx.org_id || project_name != project || seen.contains(run_id) {
                continue;
            }
            let Some(run) = data.runs.get(run_id) else {
                continue;
            };
            if run_matches_indexed_query(data, ctx, query, run, tokens) {
                seen.insert(*run_id);
                page.push(run.clone());
                if page.len() >= target {
                    return;
                }
            }
        }
        return;
    }
    for ((org_id, _, run_id), _) in data.runs_by_org_created.iter().rev() {
        if *org_id != ctx.org_id || seen.contains(run_id) {
            continue;
        }
        let Some(run) = data.runs.get(run_id) else {
            continue;
        };
        if run_matches_indexed_query(data, ctx, query, run, tokens) {
            seen.insert(*run_id);
            page.push(run.clone());
            if page.len() >= target {
                return;
            }
        }
    }
}

fn indexed_run_total(
    data: &StoreData,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    tokens: &[String],
) -> usize {
    if let Some(project) = project_filter(query) {
        data.runs_by_org_project_created
            .iter()
            .filter(|((org_id, project_name, _, run_id), _)| {
                *org_id == ctx.org_id
                    && project_name == project
                    && data
                        .runs
                        .get(run_id)
                        .map(|run| run_matches_indexed_query(data, ctx, query, run, tokens))
                        .unwrap_or(false)
            })
            .count()
    } else {
        data.runs_by_org_created
            .iter()
            .filter(|((org_id, _, run_id), _)| {
                *org_id == ctx.org_id
                    && data
                        .runs
                        .get(run_id)
                        .map(|run| run_matches_indexed_query(data, ctx, query, run, tokens))
                        .unwrap_or(false)
            })
            .count()
    }
}

fn run_matches_indexed_query(
    data: &StoreData,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    run: &RunRow,
    tokens: &[String],
) -> bool {
    if run.org_id != ctx.org_id {
        return false;
    }
    if ctx
        .auth
        .as_ref()
        .and_then(|auth| auth.project_id)
        .map(|project_id| project_id != run.project_id)
        .unwrap_or(false)
    {
        return false;
    }
    if query
        .get("status")
        .filter(|value| !value.is_empty() && value.as_str() != "all")
        .map(|status| run.status != *status)
        .unwrap_or(false)
    {
        return false;
    }
    if !tokens.is_empty() {
        let matches = data
            .run_search_texts
            .get(&run.id)
            .map(|haystack| tokens.iter().all(|token| haystack.contains(token)))
            .unwrap_or_else(|| {
                let haystack = run_search_text(run);
                tokens.iter().all(|token| haystack.contains(token))
            });
        if !matches {
            return false;
        }
    }
    project_filter(query)
        .map(|project| run.project == project)
        .unwrap_or(true)
}

fn text_search_tokens(query: &HashMap<String, String>) -> Vec<String> {
    query
        .get("q")
        .map(|q| {
            q.split_whitespace()
                .map(|part| part.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

fn project_filter(query: &HashMap<String, String>) -> Option<&str> {
    query
        .get("project")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && *value != "all")
}

fn has_text_search(query: &HashMap<String, String>) -> bool {
    query
        .get("q")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn has_status_filter(query: &HashMap<String, String>) -> bool {
    query
        .get("status")
        .map(String::as_str)
        .map(|value| !value.is_empty() && value != "all")
        .unwrap_or(false)
}

fn validate_run_sort(sort_by: &str) -> AppResult<String> {
    let sort_by = validate_name(Some(sort_by), "sort_by")?;
    if matches!(
        sort_by.as_str(),
        "created" | "duration" | "metric-best" | "metric-latest" | "name" | "status"
    ) {
        Ok(sort_by)
    } else {
        Err(AppError::validation(
            "sort_by must be one of: created, duration, metric-best, metric-latest, name, status",
        ))
    }
}

fn sort_runs_by_metric(
    runs: &mut [RunRow],
    sort_by: &str,
    metric_key: &str,
    series: &HashMap<Uuid, MetricSeriesRow>,
) {
    runs.sort_by(|a, b| {
        let left = metric_sort_value(series.get(&a.id), sort_by, metric_key);
        let right = metric_sort_value(series.get(&b.id), sort_by, metric_key);
        let order = if sort_by == "metric-best" && is_minimize_metric(metric_key) {
            numeric_asc(left, right)
        } else {
            numeric_desc(left, right)
        };
        order.then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn metric_sort_value(
    series: Option<&MetricSeriesRow>,
    sort_by: &str,
    metric_key: &str,
) -> Option<f64> {
    let series = series?;
    if sort_by == "metric-latest" {
        return series.latest;
    }
    if is_minimize_metric(metric_key) {
        series.min
    } else {
        series.max
    }
}

fn is_minimize_metric(key: &str) -> bool {
    key.split(['/', '_']).any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "loss"
                | "error"
                | "err"
                | "perplexity"
                | "ppl"
                | "wer"
                | "cer"
                | "mae"
                | "mse"
                | "rmse"
                | "nll"
                | "kl"
                | "regret"
        )
    })
}

const MAX_CLICKHOUSE_RUN_ID_CHUNK: usize = 4_000;

async fn metric_series_for_runs_key_chunked(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    key: &str,
) -> AppResult<Vec<MetricSeriesRow>> {
    if run_ids.len() > MAX_CLICKHOUSE_RUN_ID_CHUNK {
        let selected = run_ids.iter().copied().collect::<BTreeSet<_>>();
        let rows = metric_store
            .query_series_for_org_key(org_id, key)
            .await?
            .into_iter()
            .filter(|row| selected.contains(&row.run_id))
            .map(series_row_from_aggregate)
            .collect();
        return Ok(rows);
    }
    let mut tasks = Vec::new();
    for chunk in run_ids.chunks(MAX_CLICKHOUSE_RUN_ID_CHUNK) {
        let metric_store = metric_store.clone();
        let run_ids = chunk.to_vec();
        let key = key.to_string();
        tasks.push(tokio::spawn(async move {
            metric_series_for_runs_key(&metric_store, org_id, &run_ids, &key).await
        }));
    }
    let mut rows = Vec::new();
    for task in tasks {
        rows.extend(
            task.await
                .map_err(|err| AppError::internal(format!("metric sort task failed: {err}")))??,
        );
    }
    Ok(rows)
}

async fn count_points_for_runs_chunked(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<i64> {
    let mut tasks = Vec::new();
    for chunk in run_ids.chunks(MAX_CLICKHOUSE_RUN_ID_CHUNK) {
        let metric_store = metric_store.clone();
        let run_ids = chunk.to_vec();
        tasks.push(tokio::spawn(async move {
            metric_store.count_points_for_runs(org_id, &run_ids).await
        }));
    }
    let mut total = 0_i64;
    for task in tasks {
        total += task
            .await
            .map_err(|err| AppError::internal(format!("metric count task failed: {err}")))??;
    }
    Ok(total)
}

pub(super) fn numeric_desc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    let left = left.unwrap_or(f64::NEG_INFINITY);
    let right = right.unwrap_or(f64::NEG_INFINITY);
    right.total_cmp(&left)
}

fn numeric_asc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    let left = left.unwrap_or(f64::INFINITY);
    let right = right.unwrap_or(f64::INFINITY);
    left.total_cmp(&right)
}

fn duration_seconds(run: &RunRow) -> Option<f64> {
    run.finished_at
        .map(|finished| (finished - run.started_at).num_milliseconds() as f64 / 1_000.0)
}

pub async fn log_metrics(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: LogMetricsRequest,
    idempotency_key: Option<String>,
) -> AppResult<usize> {
    let metrics = validate_metrics(input.metrics)?;
    let step = validate_step(&input.step, "step")?;
    let timestamp = validate_timestamp(input.timestamp.as_deref())?;
    let request_hash = hash_idempotency(run_id, &raw)?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let points = metrics
        .iter()
        .map(|(key, value)| ChMetricPointRow {
            org_id: ctx.org_id,
            run_id,
            key: key.clone(),
            step,
            value: *value,
            logged_at: timestamp,
            created_at: Utc::now(),
        })
        .collect::<Vec<_>>();
    if let Some(key) = idempotency_key {
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
                        return existing
                            .response_json
                            .get("inserted")
                            .and_then(Value::as_u64)
                            .map(|value| value as usize)
                            .ok_or_else(|| {
                                AppError::internal("stored idempotency response is invalid")
                            });
                    }
                    return Err(AppError::conflict(
                        "idempotency key was already used with a different request body",
                    ));
                }
                let run = fetch_run_in_data(&data, ctx, run_id)?;
                ensure_run_access_in_data(ctx, &run)?;
            }
            enforce_plan_capacity(
                store,
                ctx.org_id,
                UsageDelta {
                    metric_points: points.len() as i64,
                    ..UsageDelta::default()
                },
                "log metrics",
            )
            .await?;
            metric_store.insert_points(&points).await?;
            let record = IdempotencyRecord {
                org_id: ctx.org_id,
                key: key.clone(),
                request_hash,
                response_json: json!({ "inserted": points.len() }),
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
                .insert((ctx.org_id, key.clone()), record);
            Ok(points.len())
        }
        .await;
        store.release_idempotency_key(ctx.org_id, &key).await;
        return result;
    }
    {
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        ensure_run_access_in_data(ctx, &run)?;
    }
    enforce_plan_capacity(
        store,
        ctx.org_id,
        UsageDelta {
            metric_points: points.len() as i64,
            ..UsageDelta::default()
        },
        "log metrics",
    )
    .await?;
    metric_store.insert_points(&points).await?;
    Ok(points.len())
}

pub async fn get_metrics(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    {
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        ensure_run_access_in_data(ctx, &run)?;
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let start_step = query
        .get("start_step")
        .map(|raw| validate_query_step(raw, "start_step"))
        .transpose()?;
    let end_step = query
        .get("end_step")
        .map(|raw| validate_query_step(raw, "end_step"))
        .transpose()?;
    let rows = store
        .metric_store_for_org(ctx.org_id)
        .await?
        .query_points(
            ctx.org_id,
            run_id,
            query.get("key").map(String::as_str),
            start_step,
            end_step,
            limit,
        )
        .await?;
    Ok(json!({ "metrics": rows.into_iter().map(metric_point_value).collect::<Vec<_>>() }))
}

/// Maximum accepted `buckets` value for M4 downsampling.
const MAX_M4_BUCKETS: u32 = 4096;

pub async fn metrics_series_batched(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let key = validate_name(query.get("key").map(String::as_str), "key")?;
    let run_ids = parse_run_ids(query.get("run_ids"))?;
    if run_ids.len() > MAX_METRIC_SERIES_RUN_IDS {
        return Err(AppError::validation(format!(
            "run_ids cannot include more than {MAX_METRIC_SERIES_RUN_IDS} runs"
        )));
    }
    {
        let data = store.data.lock().await;
        for run_id in &run_ids {
            let run = fetch_run_in_data(&data, ctx, *run_id)?;
            ensure_run_access_in_data(ctx, &run)?;
        }
    }

    // Parse and validate the optional M4 bucket count.
    let buckets: Option<u32> = query
        .get("buckets")
        .map(|raw| {
            raw.parse::<u32>()
                .map_err(|_| AppError::validation("buckets must be a positive integer"))
                .and_then(|b| {
                    if b == 0 {
                        Err(AppError::validation("buckets must be at least 1"))
                    } else if b > MAX_M4_BUCKETS {
                        Err(AppError::validation(format!(
                            "buckets cannot exceed {MAX_M4_BUCKETS}"
                        )))
                    } else {
                        Ok(b)
                    }
                })
        })
        .transpose()?;

    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let start_step = query_step(query, "start_step")?;
    let end_step = query_step(query, "end_step")?;

    let metric_store = store.metric_store_for_org(ctx.org_id).await?;

    // When M4 is requested, fetch counts for all runs in one query to decide
    // per-run whether to use M4 or the raw prefix path.
    let m4_counts: HashMap<Uuid, u64> = if let Some(b) = buckets {
        let threshold = (b as u64).saturating_mul(4);
        let count_rows = metric_store
            .count_points_for_runs_key(ctx.org_id, &run_ids, &key)
            .await?;
        count_rows
            .into_iter()
            .filter(|row| row.count > threshold)
            .map(|row| (row.run_id, row.count))
            .collect()
    } else {
        HashMap::new()
    };

    // Build the response. Runs that exceed the M4 threshold are downsampled;
    // the rest use the existing raw prefix-limited path.
    let mut grouped: BTreeMap<Uuid, Vec<Value>> = BTreeMap::new();

    // Collect run IDs that need the raw path.
    let raw_run_ids: Vec<Uuid> = run_ids
        .iter()
        .copied()
        .filter(|id| !m4_counts.contains_key(id))
        .collect();

    if !raw_run_ids.is_empty() {
        let rows = metric_store
            .query_points_for_runs(ctx.org_id, &raw_run_ids, &key, start_step, end_step, limit)
            .await?;
        for row in rows {
            grouped.entry(row.run_id).or_default().push(json!({
                "key": row.key,
                "step": row.step,
                "value": row.value,
                "created_at": row.created_at
            }));
        }
    }

    // M4 path: one query per qualifying run.
    if let Some(b) = buckets {
        for run_id in run_ids
            .iter()
            .copied()
            .filter(|id| m4_counts.contains_key(id))
        {
            let bucket_rows = metric_store
                .query_points_m4(ctx.org_id, run_id, &key, b)
                .await?;
            let points = m4_bucket_rows_to_points(&key, bucket_rows);
            grouped.insert(run_id, points);
        }
    }

    Ok(json!({
        "series": run_ids.into_iter().map(|run_id| json!({
            "run_id": run_id,
            "metrics": grouped.remove(&run_id).unwrap_or_default()
        })).collect::<Vec<_>>()
    }))
}

/// Convert M4 bucket rows into a sorted, step-deduplicated point list.
///
/// For each bucket we emit up to four `{step, value}` pairs (first, last,
/// min, max). Within each bucket the four candidates are sorted by step and
/// then deduplicated on step — so if `first_step == min_step` we emit only
/// one point at that step rather than two. The output is already globally
/// ordered because ClickHouse returns buckets in ascending bucket order and
/// within each bucket we sort before appending.
///
/// The `created_at` field is set to the Unix epoch for M4-aggregated points
/// because the aggregation discards per-point timestamps. Callers that care
/// about `created_at` must use the raw path.
pub(super) fn m4_bucket_rows_to_points(
    key: &str,
    bucket_rows: Vec<crate::metric_store::M4BucketRow>,
) -> Vec<Value> {
    use chrono::DateTime;
    let epoch_ts = DateTime::from_timestamp(0, 0).unwrap_or_default();
    let mut out = Vec::with_capacity(bucket_rows.len() * 4);
    for row in bucket_rows {
        // Collect up to 4 (step, value) candidates for this bucket.
        let mut candidates: [(f64, f64); 4] = [
            (row.first_step, row.first_val),
            (row.last_step, row.last_val),
            (row.min_step, row.min_val),
            (row.max_step, row.max_val),
        ];
        // Sort by step ascending.
        candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        // Emit each unique step once; when two candidates share a step take
        // the one that appears first after sorting (deterministic).
        let mut prev_step = f64::NEG_INFINITY;
        for (step, value) in candidates {
            if step != prev_step {
                out.push(json!({
                    "key": key,
                    "step": step,
                    "value": value,
                    "created_at": epoch_ts
                }));
                prev_step = step;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metric_store::M4BucketRow;

    fn run(id: u128, name: &str, created_offset: i64) -> RunRow {
        let created_at = epoch() + ChronoDuration::seconds(created_offset);
        RunRow {
            id: Uuid::from_u128(id),
            org_id: Uuid::from_u128(1),
            project_id: Uuid::from_u128(2),
            project: "project".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: vec![],
            metadata: json!({}),
            created_at,
            started_at: created_at,
            finished_at: Some(created_at + ChronoDuration::seconds(30)),
        }
    }

    #[test]
    fn validate_run_sort_allows_documented_values_only() {
        for value in [
            "created",
            "duration",
            "metric-best",
            "metric-latest",
            "name",
            "status",
        ] {
            assert_eq!(validate_run_sort(value).unwrap(), value);
        }
        assert!(validate_run_sort("other").is_err());
    }

    #[test]
    fn created_index_page_applies_status_text_and_project_filters() {
        let ctx = RequestContext {
            org_id: Uuid::from_u128(1),
            auth: None,
            session: None,
        };
        let mut data = StoreData::default();
        let mut failed = run(1, "failed-llm", 1);
        failed.status = "failed".to_string();
        failed.tags = vec!["llm".to_string()];
        failed.metadata = json!({ "notes": "reward stability cohort" });
        let mut finished = run(2, "finished-llm", 2);
        finished.tags = vec!["llm".to_string()];
        finished.metadata = json!({ "notes": "reward stability cohort" });
        let mut other_project = run(3, "failed-other-project", 3);
        other_project.project = "other".to_string();
        other_project.status = "failed".to_string();
        other_project.metadata = json!({ "notes": "reward stability cohort" });
        data.insert_run(failed.clone());
        data.insert_run(finished);
        data.insert_run(other_project);

        let query = HashMap::from([
            ("project".to_string(), "project".to_string()),
            ("status".to_string(), "failed".to_string()),
            ("q".to_string(), "reward stability".to_string()),
        ]);
        let (total, page) = created_index_page(&data, &ctx, &query, 0, 25).unwrap();

        assert_eq!(total, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, failed.id);
    }

    #[test]
    fn metric_sort_prefers_high_reward_and_low_loss_then_newer_runs() {
        let newer = run(3, "newer", 3);
        let older = run(1, "older", 1);
        let middle = run(2, "middle", 2);
        let mut runs = vec![older.clone(), newer.clone(), middle.clone()];
        let reward_series = HashMap::from([
            (
                older.id,
                MetricSeriesRow {
                    run_id: older.id,
                    key: "eval/reward".to_string(),
                    count: 1,
                    min: Some(10.0),
                    max: Some(10.0),
                    mean: Some(10.0),
                    variance: Some(0.0),
                    latest: Some(10.0),
                    latest_step: Some(1.0),
                    best: Some(10.0),
                    best_step: Some(1.0),
                },
            ),
            (
                newer.id,
                MetricSeriesRow {
                    run_id: newer.id,
                    key: "eval/reward".to_string(),
                    count: 1,
                    min: Some(20.0),
                    max: Some(20.0),
                    mean: Some(20.0),
                    variance: Some(0.0),
                    latest: Some(20.0),
                    latest_step: Some(1.0),
                    best: Some(20.0),
                    best_step: Some(1.0),
                },
            ),
        ]);

        sort_runs_by_metric(&mut runs, "metric-best", "eval/reward", &reward_series);
        assert_eq!(runs[0].id, newer.id);
        assert_eq!(runs[1].id, older.id);
        assert_eq!(runs[2].id, middle.id);

        let mut loss_runs = vec![older.clone(), newer.clone()];
        let loss_series = HashMap::from([
            (
                older.id,
                MetricSeriesRow {
                    key: "train/loss".to_string(),
                    min: Some(0.5),
                    max: Some(1.0),
                    latest: Some(0.8),
                    ..reward_series[&older.id].clone()
                },
            ),
            (
                newer.id,
                MetricSeriesRow {
                    key: "train/loss".to_string(),
                    min: Some(0.2),
                    max: Some(1.2),
                    latest: Some(0.9),
                    ..reward_series[&newer.id].clone()
                },
            ),
        ]);

        sort_runs_by_metric(&mut loss_runs, "metric-best", "train/loss", &loss_series);
        assert_eq!(loss_runs[0].id, newer.id);
    }

    #[test]
    fn duration_seconds_is_none_until_finished() {
        let finished = run(1, "finished", 0);
        let mut running = run(2, "running", 0);
        running.finished_at = None;

        assert_eq!(duration_seconds(&finished), Some(30.0));
        assert_eq!(duration_seconds(&running), None);
    }

    // -----------------------------------------------------------------------
    // M4 bucket-to-points conversion unit tests
    // -----------------------------------------------------------------------

    fn m4_row(
        bucket: u32,
        first: (f64, f64),
        last: (f64, f64),
        min: (f64, f64),
        max: (f64, f64),
    ) -> M4BucketRow {
        M4BucketRow {
            bucket,
            first_step: first.0,
            first_val: first.1,
            last_step: last.0,
            last_val: last.1,
            min_step: min.0,
            min_val: min.1,
            max_step: max.0,
            max_val: max.1,
        }
    }

    fn steps(points: &[Value]) -> Vec<f64> {
        points.iter().map(|p| p["step"].as_f64().unwrap()).collect()
    }

    fn values_at(points: &[Value], step: f64) -> Vec<f64> {
        points
            .iter()
            .filter(|p| p["step"].as_f64().unwrap() == step)
            .map(|p| p["value"].as_f64().unwrap())
            .collect()
    }

    #[test]
    fn m4_bucket_points_all_distinct_four_extremes() {
        // All four extremes are at different steps: expect 4 sorted points.
        let row = m4_row(0, (1.0, 0.5), (4.0, 0.8), (2.0, 0.1), (3.0, 0.9));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 4);
        assert_eq!(steps(&pts), vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn m4_bucket_points_deduplicates_coincident_extremes() {
        // first_step == min_step: should emit 3 points, not 4.
        let row = m4_row(
            0,
            (1.0, 0.1), // first (also min-value step)
            (4.0, 0.8),
            (1.0, 0.1), // min — same step as first
            (3.0, 0.9),
        );
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 3);
        assert_eq!(steps(&pts), vec![1.0, 3.0, 4.0]);
    }

    #[test]
    fn m4_bucket_points_single_point_when_all_coincide() {
        // All four extremes are the same step+value (degenerate single-point bucket).
        let row = m4_row(0, (5.0, 1.0), (5.0, 1.0), (5.0, 1.0), (5.0, 1.0));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 1);
        assert_eq!(pts[0]["step"].as_f64().unwrap(), 5.0);
        assert_eq!(pts[0]["value"].as_f64().unwrap(), 1.0);
    }

    #[test]
    fn m4_bucket_points_two_extremes_deduped_to_two() {
        // first==min at step 1, last==max at step 10: expect 2 points.
        let row = m4_row(0, (1.0, 0.1), (10.0, 0.9), (1.0, 0.1), (10.0, 0.9));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 2);
        assert_eq!(steps(&pts), vec![1.0, 10.0]);
    }

    #[test]
    fn m4_bucket_points_multiple_buckets_produce_sorted_output() {
        // Two buckets; output should be globally sorted by step.
        let rows = vec![
            m4_row(0, (0.0, 0.2), (9.0, 0.5), (3.0, 0.1), (7.0, 0.8)),
            m4_row(1, (10.0, 0.3), (19.0, 0.6), (12.0, 0.05), (17.0, 0.95)),
        ];
        let pts = m4_bucket_rows_to_points("loss", rows);
        // Bucket 0: steps 0,3,7,9 | Bucket 1: steps 10,12,17,19 => 8 total
        assert_eq!(pts.len(), 8);
        let s = steps(&pts);
        let mut sorted = s.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(s, sorted, "output must be sorted by step");
    }

    #[test]
    fn m4_bucket_points_preserves_spike_value() {
        // A spike in the middle of the series: max_val row should carry it.
        let row = m4_row(
            5,
            (50.0, 0.02),  // first
            (59.0, 0.03),  // last
            (53.0, 0.001), // min value
            (55.0, 99.0),  // max value — the spike
        );
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        let spike_vals = values_at(&pts, 55.0);
        assert_eq!(spike_vals, vec![99.0], "spike value must survive M4");
    }

    #[test]
    fn m4_bucket_points_empty_input_returns_empty() {
        let pts = m4_bucket_rows_to_points("loss", vec![]);
        assert!(pts.is_empty());
    }

    #[test]
    fn m4_bucket_points_all_equal_values_two_distinct_steps() {
        // All values identical but steps differ: first/last remain, min==first, max==last.
        let row = m4_row(
            0,
            (0.0, 0.5),  // first
            (10.0, 0.5), // last
            (0.0, 0.5),  // min == first
            (10.0, 0.5), // max == last
        );
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 2);
        assert_eq!(steps(&pts), vec![0.0, 10.0]);
        // Both values are 0.5.
        for pt in &pts {
            assert_eq!(pt["value"].as_f64().unwrap(), 0.5);
        }
    }
}
