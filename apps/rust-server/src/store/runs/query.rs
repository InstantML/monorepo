use super::*;

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
    let selection_projection = query
        .get("projection")
        .map(|value| value == "selection")
        .unwrap_or(false);
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
    let next_offset = offset + page_runs.len();
    let has_next = next_offset < total;
    if selection_projection {
        return Ok(json!({
            "runs": page_runs
                .into_iter()
                .map(selection_run_value)
                .collect::<AppResult<Vec<_>>>()?,
            "metric_keys": [],
            "total": total,
            "projection": "selection",
            "next_cursor": if has_next { json!(format!("offset:{next_offset}")) } else { Value::Null },
            "page_info": { "pagination": "cursor", "has_next_page": has_next }
        }));
    }
    let run_values = summarize_runs(store, page_runs).await?;
    let metric_keys = metric_keys_from_run_values(&run_values, 250);
    Ok(json!({
        "runs": run_values,
        "metric_keys": metric_keys,
        "total": total,
        "next_cursor": if has_next { json!(format!("offset:{next_offset}")) } else { Value::Null },
        "page_info": { "pagination": "cursor", "has_next_page": has_next }
    }))
}

pub async fn filtered_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Vec<RunRow>> {
    let mut runs = collect_filtered_runs(store, ctx, query).await?;
    sort_runs(store, ctx, query, &mut runs).await?;
    Ok(runs)
}

pub(super) async fn collect_filtered_runs(
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

pub(super) async fn sort_runs(
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

pub(super) fn created_index_page(
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

pub(super) fn append_created_index_runs(
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
}
