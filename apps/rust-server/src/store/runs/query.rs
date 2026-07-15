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
        && !has_display_status_filter(query)
        && ctx.auth.as_ref().and_then(|auth| auth.project_id).is_none()
    {
        let (total_runs, active_runs, failed_runs, stopping_runs, stopped_runs) = {
            let data = store.data.lock().await;
            data.runs
                .values()
                .filter(|run| run.org_id == ctx.org_id && is_visible_run(&data, run))
                .fold(
                    (0_usize, 0_usize, 0_usize, 0_usize, 0_usize),
                    |(total, active, failed, stopping, stopped), run| {
                        let display = run_control_display_status(run, run_control_for(&data, run));
                        (
                            total + 1,
                            active + usize::from(run.status == "running"),
                            failed + usize::from(run.status == "failed"),
                            stopping + usize::from(display == "stopping"),
                            stopped + usize::from(display == "stopped"),
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
                "stopping_runs": stopping_runs,
                "stopped_runs": stopped_runs,
                "best_eval_return": best_eval_return,
                "metric_points": metric_points
            }
        }));
    }
    if let Some(project) = project_filter(query) {
        if !has_text_search(query)
            && !has_status_filter(query)
            && !has_display_status_filter(query)
            && ctx.auth.as_ref().and_then(|auth| auth.project_id).is_none()
        {
            let (total_runs, active_runs, failed_runs, stopping_runs, stopped_runs) = {
                let data = store.data.lock().await;
                data.runs
                    .values()
                    .filter(|run| {
                        run.org_id == ctx.org_id
                            && run.project == project
                            && is_visible_run(&data, run)
                    })
                    .fold(
                        (0_usize, 0_usize, 0_usize, 0_usize, 0_usize),
                        |(total, active, failed, stopping, stopped), run| {
                            let display =
                                run_control_display_status(run, run_control_for(&data, run));
                            (
                                total + 1,
                                active + usize::from(run.status == "running"),
                                failed + usize::from(run.status == "failed"),
                                stopping + usize::from(display == "stopping"),
                                stopped + usize::from(display == "stopped"),
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
                    "stopping_runs": stopping_runs,
                    "stopped_runs": stopped_runs,
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
    let (stopping_runs, stopped_runs) = {
        let data = store.data.lock().await;
        runs.iter()
            .fold((0_usize, 0_usize), |(stopping, stopped), run| {
                let display = run_control_display_status(run, run_control_for(&data, run));
                (
                    stopping + usize::from(display == "stopping"),
                    stopped + usize::from(display == "stopped"),
                )
            })
    };
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
            "stopping_runs": stopping_runs,
            "stopped_runs": stopped_runs,
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
    let search = compile_run_search(query.get("q").map(String::as_str))?;
    let indexed_page =
        if sort_by == "created" && search.is_empty() && search.is_simple_literal_and() {
            let data = store.data.lock().await;
            created_index_page(&data, ctx, query, &search, offset, limit)
        } else if matches!(sort_by.as_str(), "metric-latest" | "metric-best") {
            metric_sorted_index_page(store, ctx, query, &sort_by, metric_key, offset, limit).await?
        } else {
            None
        };
    let (total, page_runs) = if let Some(page) = indexed_page {
        page
    } else {
        // Non-indexed fallback: filter and sort over lightweight sort items
        // so only the requested page of full rows (config/metadata JSON
        // included) is cloned out of the store.
        let mut items = collect_filtered_run_sort_items(store, ctx, query, &search).await?;
        let total = items.len();
        let page_ids = if matches!(sort_by.as_str(), "metric-latest" | "metric-best")
            && items.len() > MAX_CLICKHOUSE_RUN_ID_CHUNK
        {
            metric_sorted_page_ids(store, ctx, &items, &sort_by, metric_key, offset, limit).await?
        } else {
            sort_run_items(store, ctx, query, &mut items).await?;
            items
                .iter()
                .skip(offset)
                .take(limit)
                .map(|item| item.id)
                .collect::<Vec<_>>()
        };
        let page_runs = {
            let data = store.data.lock().await;
            page_ids
                .iter()
                .filter_map(|run_id| data.runs.get(run_id).cloned())
                .collect::<Vec<_>>()
        };
        (total, page_runs)
    };
    let next_offset = offset + page_runs.len();
    let has_next = next_offset < total;
    if selection_projection {
        let controls = {
            let data = store.data.lock().await;
            page_runs
                .iter()
                .map(|run| (run.id, run_control_for(&data, run).cloned()))
                .collect::<HashMap<_, _>>()
        };
        return Ok(json!({
            "runs": page_runs
                .into_iter()
                .map(|run| {
                    let control = controls.get(&run.id).and_then(Option::as_ref);
                    selection_run_value(run, control)
                })
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
    let search = compile_run_search(query.get("q").map(String::as_str))?;
    collect_filtered_runs_with_search(store, ctx, query, &search).await
}

async fn collect_filtered_runs_with_search(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    search: &CompiledRunSearch,
) -> AppResult<Vec<RunRow>> {
    collect_filtered_runs_map(store, ctx, query, search, |_, run| run.clone()).await
}

/// Lightweight projection of a run holding only the fields the listing
/// fallback needs to sort and page, so full rows (config/metadata JSON
/// included) are cloned for the requested page only.
struct RunSortItem {
    id: Uuid,
    name: String,
    created_at: DateTime<Utc>,
    duration: Option<f64>,
    display_status: &'static str,
}

async fn collect_filtered_run_sort_items(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    search: &CompiledRunSearch,
) -> AppResult<Vec<RunSortItem>> {
    collect_filtered_runs_map(store, ctx, query, search, |data, run| RunSortItem {
        id: run.id,
        name: run.name.clone(),
        created_at: run.created_at,
        duration: duration_seconds(run),
        display_status: run_control_display_status(run, run_control_for(data, run)),
    })
    .await
}

async fn collect_filtered_runs_map<T>(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    search: &CompiledRunSearch,
    project_row: impl Fn(&StoreData, &RunRow) -> T,
) -> AppResult<Vec<T>> {
    let project = query
        .get("project")
        .filter(|value| !value.is_empty() && value.as_str() != "all");
    let status = query
        .get("status")
        .filter(|value| !value.is_empty() && value.as_str() != "all");
    let cache_key = (!search.is_empty()).then(|| run_filter_cache_key(ctx, query));
    if let Some(cache_key) = cache_key.as_ref() {
        let data = store.data.lock().await;
        if let Some(ids) = data.cached_run_filter_ids(cache_key) {
            return Ok(ids
                .into_iter()
                .filter_map(|run_id| data.runs.get(&run_id))
                .map(|run| project_row(&data, run))
                .collect());
        }
    }
    if search.is_empty() {
        let data = store.data.lock().await;
        return Ok(data
            .runs
            .values()
            .filter(|run| run.org_id == ctx.org_id && is_visible_run(&data, run))
            .filter(|run| {
                ctx.auth
                    .as_ref()
                    .and_then(|auth| auth.project_id)
                    .map(|id| id == run.project_id)
                    .unwrap_or(true)
            })
            .filter(|run| project.map(|name| run.project == *name).unwrap_or(true))
            .filter(|run| status.map(|value| run.status == *value).unwrap_or(true))
            .filter(|run| run_matches_display_status(&data, query, run))
            .map(|run| project_row(&data, run))
            .collect());
    }

    let matching_ids = {
        let data = store.data.lock().await;
        data.runs
            .values()
            .filter(|run| run.org_id == ctx.org_id && is_visible_run(&data, run))
            .filter(|run| {
                ctx.auth
                    .as_ref()
                    .and_then(|auth| auth.project_id)
                    .map(|id| id == run.project_id)
                    .unwrap_or(true)
            })
            .filter(|run| project.map(|name| run.project == *name).unwrap_or(true))
            .filter(|run| status.map(|value| run.status == *value).unwrap_or(true))
            .filter(|run| run_matches_display_status(&data, query, run))
            .filter(|run| run_matches_search(&data, run, search))
            .map(|run| run.id)
            .collect::<Vec<_>>()
    };
    let mut data = store.data.lock().await;
    if let Some(cache_key) = cache_key {
        data.insert_run_filter_cache(cache_key, matching_ids.clone());
    }
    let data = &*data;
    Ok(matching_ids
        .into_iter()
        .filter_map(|run_id| data.runs.get(&run_id))
        .map(|run| project_row(data, run))
        .collect())
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
        "status" => {
            let data = store.data.lock().await;
            runs.sort_by(|a, b| {
                run_control_display_status(a, run_control_for(&data, a))
                    .cmp(run_control_display_status(b, run_control_for(&data, b)))
                    .then_with(|| a.name.cmp(&b.name))
                    .then_with(|| b.created_at.cmp(&a.created_at))
            })
        }
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
    if has_text_search(query) || has_status_filter(query) || has_display_status_filter(query) {
        return Ok(None);
    }
    let search = CompiledRunSearch::empty();
    let total = {
        let data = store.data.lock().await;
        indexed_run_total(&data, ctx, query, &search)
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
            rows.into_iter()
                .filter_map(|row| data.runs.get(&row.run_id))
                .filter(|run| run_matches_indexed_query(&data, ctx, query, &search, run))
                .cloned()
                .collect::<Vec<_>>()
        };
        if page.len() >= target || fetch_limit == total {
            let mut seen = page.iter().map(|run| run.id).collect::<BTreeSet<_>>();
            if page.len() < target {
                let data = store.data.lock().await;
                append_created_index_runs(&data, ctx, query, &search, &mut seen, target, &mut page);
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

async fn sort_run_items(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    items: &mut [RunSortItem],
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
            let run_ids = items.iter().map(|item| item.id).collect::<Vec<_>>();
            let metric_store = store.metric_store_for_org(ctx.org_id).await?;
            let series =
                metric_series_for_runs_key_chunked(&metric_store, ctx.org_id, &run_ids, metric_key)
                    .await?
                    .into_iter()
                    .map(|row| (row.run_id, row))
                    .collect::<HashMap<_, _>>();
            sort_by_metric_series(
                items,
                |item| item.id,
                |item| item.created_at,
                &sort_by,
                metric_key,
                &series,
            );
        }
        "duration" => items.sort_by(|a, b| {
            numeric_desc(a.duration, b.duration).then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "name" => items.sort_by(|a, b| {
            a.name
                .cmp(&b.name)
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "status" => items.sort_by(|a, b| {
            a.display_status
                .cmp(b.display_status)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| b.created_at.cmp(&a.created_at))
        }),
        "created" => items.sort_by_key(|item| std::cmp::Reverse(item.created_at)),
        _ => items.sort_by_key(|item| std::cmp::Reverse(item.created_at)),
    }
    Ok(())
}

async fn metric_sorted_page_ids(
    store: &Store,
    ctx: &RequestContext,
    items: &[RunSortItem],
    sort_by: &str,
    metric_key: &str,
    offset: usize,
    limit: usize,
) -> AppResult<Vec<Uuid>> {
    let item_by_id = items
        .iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let mode = metric_sort_mode(sort_by, metric_key);
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let target = offset.saturating_add(limit);
    let mut fetch_limit = target.max(1_000).min(items.len()).max(limit);
    let ordered = loop {
        let rows = metric_store
            .query_top_series_for_org_key(ctx.org_id, metric_key, mode, fetch_limit as i64)
            .await?;
        let page = rows
            .into_iter()
            .filter(|row| item_by_id.contains_key(&row.run_id))
            .map(|row| row.run_id)
            .collect::<Vec<_>>();
        if page.len() >= target || fetch_limit == items.len() {
            break page;
        }
        fetch_limit = (fetch_limit * 2).min(items.len());
    };
    let mut seen = ordered.iter().copied().collect::<BTreeSet<_>>();
    let mut page = ordered;
    if page.len() < target {
        let mut without_metric = items
            .iter()
            .filter(|item| !seen.contains(&item.id))
            .map(|item| (item.created_at, item.id))
            .collect::<Vec<_>>();
        without_metric.sort_by_key(|(created_at, _)| std::cmp::Reverse(*created_at));
        for (_, run_id) in without_metric {
            seen.insert(run_id);
            page.push(run_id);
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
    search: &CompiledRunSearch,
    offset: usize,
    limit: usize,
) -> Option<(usize, Vec<RunRow>)> {
    let total = indexed_run_total(data, ctx, query, search);
    let mut seen = BTreeSet::new();
    let mut page = Vec::with_capacity(limit);
    append_created_index_runs(
        data,
        ctx,
        query,
        search,
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
    search: &CompiledRunSearch,
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
            if run_matches_indexed_query(data, ctx, query, search, run) {
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
        if run_matches_indexed_query(data, ctx, query, search, run) {
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
    search: &CompiledRunSearch,
) -> usize {
    if search.is_empty() && !has_status_filter(query) && !has_display_status_filter(query) {
        if let Some(project_id) = ctx.auth.as_ref().and_then(|auth| auth.project_id) {
            let Some(project) = data.projects.get(&project_id) else {
                return 0;
            };
            if project_filter(query)
                .map(|project_filter| project_filter != project.name)
                .unwrap_or(false)
            {
                return 0;
            }
            return data
                .run_count_by_org_project
                .get(&(ctx.org_id, project.name.clone()))
                .copied()
                .unwrap_or(0);
        }
        if let Some(project) = project_filter(query) {
            return data
                .run_count_by_org_project
                .get(&(ctx.org_id, project.to_string()))
                .copied()
                .unwrap_or(0);
        }
        return data.run_count_by_org.get(&ctx.org_id).copied().unwrap_or(0);
    }
    if let Some(project) = project_filter(query) {
        data.runs_by_org_project_created
            .iter()
            .filter(|((org_id, project_name, _, run_id), _)| {
                *org_id == ctx.org_id
                    && project_name == project
                    && data
                        .runs
                        .get(run_id)
                        .map(|run| run_matches_indexed_query(data, ctx, query, search, run))
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
                        .map(|run| run_matches_indexed_query(data, ctx, query, search, run))
                        .unwrap_or(false)
            })
            .count()
    }
}

fn run_filter_cache_key(
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> RunFilterCacheKey {
    RunFilterCacheKey {
        org_id: ctx.org_id,
        auth_project_id: ctx.auth.as_ref().and_then(|auth| auth.project_id),
        project: query.get("project").cloned().unwrap_or_default(),
        status: query.get("status").cloned().unwrap_or_default(),
        display_status: query.get("display_status").cloned().unwrap_or_default(),
        q: query.get("q").cloned().unwrap_or_default(),
    }
}

fn run_matches_indexed_query(
    data: &StoreData,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
    search: &CompiledRunSearch,
    run: &RunRow,
) -> bool {
    if run.org_id != ctx.org_id {
        return false;
    }
    if !is_visible_run(data, run) {
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
    if !run_matches_display_status(data, query, run) {
        return false;
    }
    if !run_matches_search(data, run, search) {
        return false;
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
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
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
        let search = compile_run_search(query.get("q").map(String::as_str)).unwrap();
        let (total, page) = created_index_page(&data, &ctx, &query, &search, 0, 25).unwrap();

        assert_eq!(total, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, failed.id);
    }

    #[test]
    fn incomplete_import_runs_are_hidden_from_indexes() {
        let ctx = RequestContext {
            org_id: Uuid::from_u128(1),
            auth: None,
            session: None,
        };
        let mut data = StoreData::default();
        let mut hidden = run(1, "half-imported", 1);
        hidden.metadata = json!({
            "import": {
                "source_type": "wandb",
                "external_project_id": "team/project",
                "external_run_id": "run-1",
                "complete": false
            }
        });
        let visible = run(2, "complete", 2);
        data.insert_run(hidden);
        data.insert_run(visible);

        let query = HashMap::new();
        let search = CompiledRunSearch::empty();
        let (total, page) = created_index_page(&data, &ctx, &query, &search, 0, 25).unwrap();

        assert_eq!(total, 1);
        assert_eq!(page[0].name, "complete");
    }

    #[test]
    fn browser_session_created_index_includes_all_same_workspace_projects() {
        let org_id = Uuid::from_u128(1);
        let other_org_id = Uuid::from_u128(2);
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: Some(SessionContext {
                session_id: Uuid::from_u128(20),
                user_id: Uuid::from_u128(21),
                role: "viewer".to_string(),
                demo_read_only: false,
                mcp_oauth: false,
            }),
        };
        let mut data = StoreData::default();
        let mut alpha = run(1, "alpha-run", 1);
        alpha.project_id = Uuid::from_u128(10);
        alpha.project = "alpha".to_string();
        let mut beta = run(2, "beta-run", 2);
        beta.project_id = Uuid::from_u128(11);
        beta.project = "beta".to_string();
        let mut other_org = run(3, "other-org-run", 3);
        other_org.org_id = other_org_id;
        other_org.project_id = Uuid::from_u128(12);
        other_org.project = "other-org".to_string();
        data.insert_run(alpha.clone());
        data.insert_run(beta.clone());
        data.insert_run(other_org);

        let query = HashMap::new();
        let search = CompiledRunSearch::empty();
        let (total, page) = created_index_page(&data, &ctx, &query, &search, 0, 25).unwrap();

        assert_eq!(total, 2);
        assert_eq!(
            page.iter().map(|run| run.id).collect::<Vec<_>>(),
            vec![beta.id, alpha.id]
        );
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
