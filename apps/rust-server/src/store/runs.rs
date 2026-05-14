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
    let runs = filtered_runs(store, ctx, query).await?;
    let total_runs = runs.len();
    let active_runs = runs.iter().filter(|run| run.status == "running").count();
    let failed_runs = runs.iter().filter(|run| run.status == "failed").count();
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_key = query
        .get("metric_key")
        .map(String::as_str)
        .unwrap_or("eval/return_mean");
    let series =
        metric_series_for_runs_key(store.metric_store(), ctx.org_id, &run_ids, metric_key).await?;
    let best_eval_return = series
        .iter()
        .filter_map(|row| row.best)
        .max_by(|a, b| a.total_cmp(b));
    let metric_points = store
        .metric_store()
        .count_points_for_runs(ctx.org_id, &run_ids)
        .await
        .unwrap_or(0);
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
    let all_runs = filtered_runs(store, ctx, query).await?;
    let total = all_runs.len();
    let page_runs = all_runs
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let run_ids = all_runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_keys = store
        .metric_store()
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
    let mut runs = {
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
                let haystack = run_search_text(run);
                tokens.iter().all(|token| haystack.contains(token))
            })
            .cloned()
            .collect::<Vec<_>>()
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
    match sort_by.as_str() {
        "metric-latest" | "metric-best" => {
            let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
            let series =
                metric_series_for_runs_key(store.metric_store(), ctx.org_id, &run_ids, metric_key)
                    .await?
                    .into_iter()
                    .map(|row| (row.run_id, row))
                    .collect::<HashMap<_, _>>();
            sort_runs_by_metric(&mut runs, &sort_by, metric_key, &series);
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
        _ => unreachable!("validate_run_sort restricts values"),
    }
    Ok(runs)
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
    let request_hash = hash_idempotency(run_id, &raw);
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
    let mut data = store.data.lock().await;
    if let Some(key) = &idempotency_key {
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
                    .ok_or_else(|| AppError::internal("stored idempotency response is invalid"));
            }
            return Err(AppError::conflict(
                "idempotency key was already used with a different request body",
            ));
        }
    }
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    store.metric_store().insert_points(&points).await?;
    if let Some(key) = idempotency_key {
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
        data.idempotency.insert((ctx.org_id, key), record);
    }
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
        .metric_store()
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
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let start_step = query_step(query, "start_step")?;
    let end_step = query_step(query, "end_step")?;
    let rows = store
        .metric_store()
        .query_points_for_runs(ctx.org_id, &run_ids, &key, start_step, end_step, limit)
        .await?;
    let mut grouped: BTreeMap<Uuid, Vec<Value>> = BTreeMap::new();
    for row in rows {
        grouped.entry(row.run_id).or_default().push(json!({
            "key": row.key,
            "step": row.step,
            "value": row.value,
            "created_at": row.created_at
        }));
    }
    Ok(json!({
        "series": run_ids.into_iter().map(|run_id| json!({
            "run_id": run_id,
            "metrics": grouped.remove(&run_id).unwrap_or_default()
        })).collect::<Vec<_>>()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
