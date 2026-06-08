use super::*;

pub(super) async fn summarize_runs(store: &Store, runs: Vec<RunRow>) -> AppResult<Vec<Value>> {
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let series = if let Some(first) = runs.first() {
        let metric_store = store.metric_store_for_org(first.org_id).await?;
        metric_series_for_runs(&metric_store, first.org_id, &run_ids).await?
    } else {
        Vec::new()
    };
    let counts = {
        let data = store.data.lock().await;
        artifact_counts_for_runs(&data, &run_ids)
    };
    let controls = {
        let data = store.data.lock().await;
        runs.iter()
            .map(|run| (run.id, run_control_for(&data, run).cloned()))
            .collect::<HashMap<_, _>>()
    };
    runs.into_iter()
        .map(|run| {
            let control = controls.get(&run.id).and_then(Option::as_ref);
            summarize_run(run, control, &series, &counts)
        })
        .collect::<AppResult<Vec<_>>>()
}

pub(super) async fn run_summary_value(store: &Store, run: RunRow) -> AppResult<Value> {
    let run_ids = vec![run.id];
    let metric_store = store.metric_store_for_org(run.org_id).await?;
    let series = metric_series_for_runs(&metric_store, run.org_id, &run_ids).await?;
    let counts = {
        let data = store.data.lock().await;
        artifact_counts_for_runs(&data, &run_ids)
    };
    let control = {
        let data = store.data.lock().await;
        run_control_for(&data, &run).cloned()
    };
    summarize_run(run, control.as_ref(), &series, &counts)
}

pub(super) fn selection_run_value(
    run: RunRow,
    control: Option<&RunControlRow>,
) -> AppResult<Value> {
    let mut value = serde_json::to_value(&run)
        .map_err(|_| AppError::internal("run selection serialization failed"))?;
    if let Value::Object(map) = &mut value {
        map.insert("latest_metrics".to_string(), Value::Object(Map::new()));
        map.insert("metric_aggregates".to_string(), Value::Object(Map::new()));
        map.insert("metric_keys".to_string(), json!([]));
        map.insert(
            "artifact_counts".to_string(),
            json!({
                "checkpoint": 0,
                "rollout": 0,
                "file": 0
            }),
        );
        map.insert(
            "run_control".to_string(),
            run_control_summary(&run, control),
        );
    }
    Ok(value)
}

pub(super) fn summarize_run(
    run: RunRow,
    control: Option<&RunControlRow>,
    series: &[MetricSeriesRow],
    artifact_counts: &HashMap<Uuid, BTreeMap<String, i64>>,
) -> AppResult<Value> {
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
    let mut value = serde_json::to_value(&run)
        .map_err(|_| AppError::internal("run summary serialization failed"))?;
    if let Value::Object(map) = &mut value {
        map.insert(
            "run_control".to_string(),
            run_control_summary(&run, control),
        );
        map.insert("latest_metrics".to_string(), Value::Object(latest));
        map.insert("metric_aggregates".to_string(), Value::Object(aggregates));
        map.insert("metric_keys".to_string(), json!(keys));
        map.insert("artifact_counts".to_string(), json!(counts));
    }
    Ok(value)
}

pub(super) fn artifact_counts_for_runs(
    data: &StoreData,
    run_ids: &[Uuid],
) -> HashMap<Uuid, BTreeMap<String, i64>> {
    let selected = run_ids.iter().copied().collect::<BTreeSet<_>>();
    let mut counts = HashMap::new();
    for id in run_ids {
        counts.insert(
            *id,
            BTreeMap::from([
                ("checkpoint".to_string(), 0),
                ("rollout".to_string(), 0),
                ("file".to_string(), 0),
            ]),
        );
    }
    for artifact in data
        .artifacts
        .values()
        .filter(|artifact| selected.contains(&artifact.run_id))
    {
        let entry = counts.entry(artifact.run_id).or_insert_with(BTreeMap::new);
        *entry.entry(artifact.kind.clone()).or_insert(0) += 1;
    }
    counts
}

pub(super) async fn metric_series_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs(org_id, run_ids, None)
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

pub(super) async fn metric_series_for_runs_key(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    key: &str,
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs_key(org_id, run_ids, key)
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

#[derive(clickhouse::Row, Deserialize)]
struct ExportMetricPointRow {
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

pub(super) async fn metric_point_values_for_runs(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> AppResult<(Vec<Value>, bool)> {
    if run_ids.is_empty() {
        return Ok((Vec::new(), false));
    }
    let rows = metric_store
        .client()
        .query(
            "SELECT org_id, run_id, key, step, value, logged_at, created_at \
             FROM metric_points \
             WHERE org_id = ? AND run_id IN ? \
             ORDER BY run_id, key, step, created_at \
             LIMIT ?",
        )
        .bind(org_id)
        .bind(run_ids)
        .bind(MAX_EXPORT_METRICS + 1)
        .fetch_all::<ExportMetricPointRow>()
        .await
        .map_err(|err| AppError::internal(format!("clickhouse export metrics failed: {err}")))?;
    let truncated = rows.len() as i64 > MAX_EXPORT_METRICS;
    Ok((
        rows.into_iter()
            .take(MAX_EXPORT_METRICS as usize)
            .map(|row| {
                json!({
                    "org_id": row.org_id,
                    "run_id": row.run_id,
                    "key": row.key,
                    "step": row.step,
                    "value": row.value,
                    "logged_at": row.logged_at,
                    "created_at": row.created_at
                })
            })
            .collect(),
        truncated,
    ))
}

pub(super) async fn metric_series_values_for_runs_limited(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: Option<usize>,
) -> AppResult<(Vec<Value>, bool)> {
    let fetch_limit = limit.map(|value| value.saturating_add(1) as i64);
    let rows =
        metric_series_for_runs_limited_or_all(metric_store, org_id, run_ids, fetch_limit).await?;
    let truncated = limit.map(|value| rows.len() > value).unwrap_or(false);
    let selected = rows.into_iter().take(limit.unwrap_or(usize::MAX));
    Ok((
        selected
            .map(|row| {
                json!({
                    "org_id": org_id,
                    "run_id": row.run_id,
                    "key": row.key,
                    "count": row.count,
                    "min": row.min,
                    "max": row.max,
                    "mean": row.mean,
                    "variance": row.variance,
                    "latest": row.latest,
                    "latest_step": row.latest_step,
                    "best": row.best,
                    "best_step": row.best_step
                })
            })
            .collect(),
        truncated,
    ))
}

async fn metric_series_for_runs_limited_or_all(
    metric_store: &MetricStore,
    org_id: Uuid,
    run_ids: &[Uuid],
    limit: Option<i64>,
) -> AppResult<Vec<MetricSeriesRow>> {
    let rows = metric_store
        .query_series_for_runs(org_id, run_ids, limit)
        .await?;
    Ok(rows.into_iter().map(series_row_from_aggregate).collect())
}

pub(super) fn series_row_from_aggregate(aggregate: SeriesReadRow) -> MetricSeriesRow {
    let count = aggregate.count as i64;
    let mean = (count > 0).then_some(aggregate.sum / count as f64);
    let variance = mean.map(|m| (aggregate.sum_sq / count as f64 - m * m).max(0.0));
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
        best: some_if_any(aggregate.max),
        best_step: some_if_any(aggregate.best_step),
    }
}

pub(super) fn metric_point_value(row: crate::metric_store::PointReadRow) -> Value {
    json!({ "key": row.key, "step": row.step, "value": row.value, "created_at": row.created_at })
}
