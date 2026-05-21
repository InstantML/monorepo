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

/// Maximum accepted `buckets` value for M4 downsampling.
pub(super) const MAX_M4_BUCKETS: u32 = 4096;

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

    let metric_store = store.metric_store_for_org(ctx.org_id).await?;

    // M4 is only applied when the caller asks for it AND the window covers the
    // full series (no start/end step). Zoomed queries fall through to the raw
    // path so partial-window fidelity isn't traded for a global aggregation.
    let m4_counts: HashMap<Uuid, u64> =
        if let (Some(b), None, None) = (buckets, start_step, end_step) {
            let threshold = (b as u64).saturating_mul(4);
            metric_store
                .count_points_for_runs_key(ctx.org_id, &run_ids, &key)
                .await?
                .into_iter()
                .filter(|row| row.count > threshold)
                .map(|row| (row.run_id, row.count))
                .collect()
        } else {
            HashMap::new()
        };

    let mut grouped: BTreeMap<Uuid, Vec<Value>> = BTreeMap::new();

    let raw_run_ids: Vec<Uuid> = run_ids
        .iter()
        .copied()
        .filter(|id| !m4_counts.contains_key(id))
        .collect();

    if !raw_run_ids.is_empty() {
        let rows = metric_store
            .query_points_for_runs(
                ctx.org_id,
                &raw_run_ids,
                &key,
                start_step,
                end_step,
                effective_limit,
            )
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

    if let Some(b) = buckets {
        for run_id in run_ids
            .iter()
            .copied()
            .filter(|id| m4_counts.contains_key(id))
        {
            let bucket_rows = metric_store
                .query_points_m4(ctx.org_id, run_id, &key, b)
                .await?;
            grouped.insert(run_id, m4_bucket_rows_to_points(&key, bucket_rows));
        }
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

/// Convert M4 bucket rows into a sorted, step-deduplicated point list.
///
/// For each bucket we emit up to four `{step, value}` pairs (first, last,
/// min, max). Within each bucket the four candidates are sorted by step and
/// then deduplicated on step — so if `first_step == min_step` we emit only
/// one point at that step rather than two. The output is globally ordered
/// because ClickHouse returns buckets in ascending bucket order and within
/// each bucket we sort before appending.
///
/// `created_at` is set to the Unix epoch for M4-aggregated points because
/// the aggregation discards per-point timestamps. Callers that care about
/// `created_at` must use the raw path.
pub(super) fn m4_bucket_rows_to_points(key: &str, bucket_rows: Vec<M4BucketRow>) -> Vec<Value> {
    let epoch_ts = DateTime::<Utc>::from_timestamp(0, 0).unwrap_or_default();
    let mut out = Vec::with_capacity(bucket_rows.len() * 4);
    for row in bucket_rows {
        let mut candidates: [(f64, f64); 4] = [
            (row.first_step, row.first_val),
            (row.last_step, row.last_val),
            (row.min_step, row.min_val),
            (row.max_step, row.max_val),
        ];
        candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
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

    #[test]
    fn m4_bucket_points_all_distinct_four_extremes() {
        let row = m4_row(0, (1.0, 0.5), (4.0, 0.8), (2.0, 0.1), (3.0, 0.9));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 4);
        let steps: Vec<f64> = pts.iter().map(|p| p["step"].as_f64().unwrap()).collect();
        assert_eq!(steps, vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn m4_bucket_points_deduplicates_coincident_extremes() {
        // first == min, last == max — should produce 2 points, not 4.
        let row = m4_row(0, (1.0, 0.1), (10.0, 0.9), (1.0, 0.1), (10.0, 0.9));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 2);
    }

    #[test]
    fn m4_bucket_points_single_point_when_all_coincide() {
        let row = m4_row(0, (5.0, 1.0), (5.0, 1.0), (5.0, 1.0), (5.0, 1.0));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        assert_eq!(pts.len(), 1);
        assert_eq!(pts[0]["step"].as_f64().unwrap(), 5.0);
        assert_eq!(pts[0]["value"].as_f64().unwrap(), 1.0);
    }

    #[test]
    fn m4_bucket_points_multiple_buckets_globally_sorted() {
        let rows = vec![
            m4_row(0, (0.0, 0.2), (9.0, 0.5), (3.0, 0.1), (7.0, 0.8)),
            m4_row(1, (10.0, 0.3), (19.0, 0.6), (12.0, 0.05), (17.0, 0.95)),
        ];
        let pts = m4_bucket_rows_to_points("loss", rows);
        assert_eq!(pts.len(), 8);
        let steps: Vec<f64> = pts.iter().map(|p| p["step"].as_f64().unwrap()).collect();
        assert_eq!(steps, vec![0.0, 3.0, 7.0, 9.0, 10.0, 12.0, 17.0, 19.0]);
    }

    #[test]
    fn m4_bucket_points_preserves_spike_value() {
        // A bucket containing a 73-step spike to 0.99 in an otherwise quiet
        // region — the spike must survive as the bucket's max.
        let row = m4_row(0, (10.0, 0.30), (89.0, 0.32), (45.0, 0.28), (73.0, 0.99));
        let pts = m4_bucket_rows_to_points("loss", vec![row]);
        let max_val = pts
            .iter()
            .map(|p| p["value"].as_f64().unwrap())
            .fold(f64::NEG_INFINITY, f64::max);
        assert!((max_val - 0.99).abs() < f64::EPSILON);
    }

    #[test]
    fn m4_bucket_points_empty_input() {
        let pts = m4_bucket_rows_to_points("loss", vec![]);
        assert!(pts.is_empty());
    }
}
