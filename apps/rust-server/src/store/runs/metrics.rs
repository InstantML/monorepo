use super::*;

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
    let run_count = run_ids.len();
    let effective_limit = effective_metric_series_limit(limit, run_count);
    let start_step = query_step(query, "start_step")?;
    let end_step = query_step(query, "end_step")?;
    let rows = store
        .metric_store_for_org(ctx.org_id)
        .await?
        .query_points_for_runs(
            ctx.org_id,
            &run_ids,
            &key,
            start_step,
            end_step,
            effective_limit,
        )
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
        })).collect::<Vec<_>>(),
        "requested_limit": limit,
        "effective_limit": effective_limit,
        "run_count": run_count,
        "total_point_cap": MAX_METRIC_SERIES_TOTAL_POINTS
    }))
}

pub(super) fn effective_metric_series_limit(requested_limit: i64, run_count: usize) -> i64 {
    if run_count == 0 {
        return requested_limit;
    }
    let max_per_run = (MAX_METRIC_SERIES_TOTAL_POINTS / run_count as i64).max(1);
    requested_limit.min(max_per_run)
}

pub(super) async fn metric_series_for_runs_key_chunked(
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

pub(super) async fn count_points_for_runs_chunked(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_metric_series_limit_respects_total_point_budget() {
        assert_eq!(effective_metric_series_limit(5_000, 1), 5_000);
        assert_eq!(effective_metric_series_limit(5_000, 1_000), 120);
        assert_eq!(effective_metric_series_limit(5_000, 2_000), 60);
        assert_eq!(effective_metric_series_limit(50, 2_000), 50);
    }
}
