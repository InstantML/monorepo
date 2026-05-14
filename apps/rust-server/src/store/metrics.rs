use super::*;

pub async fn log_metrics(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    run_id: Uuid,
    body: Value,
    input: LogMetricsRequest,
    idempotency_key: Option<String>,
) -> AppResult<i64> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let step = validate_step(&input.step, "step")?;
    let timestamp = validate_timestamp(input.timestamp.as_deref())?;
    if let Some(value) = input.preview_completion.as_ref() {
        let completion = validate_step(value, "preview_completion")?;
        if completion > 1.0 {
            return Err(AppError::validation(
                "preview_completion must be between 0 and 1",
            ));
        }
    }
    let metrics = validate_metrics(input.metrics)?;
    let request_hash = idempotency_key
        .as_ref()
        .map(|_| hash_idempotency(run_id, &body));
    let mut tx = pool.begin().await?;
    if let Some(key) = idempotency_key.as_deref() {
        let key = validate_name(Some(key), "idempotency key")?;
        lock_idempotency_key(&mut tx, ctx.org_id, &key).await?;
        if let Some(existing) = find_idempotency_tx(&mut tx, ctx.org_id, &key).await? {
            if Some(existing.request_hash) != request_hash {
                return Err(AppError::conflict(
                    "idempotency key was already used with a different payload",
                ));
            }
            let inserted = existing
                .response_json
                .get("inserted")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            tx.commit().await?;
            return Ok(inserted);
        }
    }
    // Build ClickHouse rows and insert while the advisory idempotency lock is
    // still held by `tx`. The CH write is not part of the Postgres transaction;
    // if it fails we return early and tx rolls back, releasing the lock so a
    // retry can re-attempt cleanly. If the CH write succeeds but the
    // subsequent idempotency-record insert fails, a retry can produce a
    // duplicate insert — acceptable trade-off pre-PMF given AggregatingMergeTree
    // aggregates remain consistent under at-least-once semantics.
    let ch_rows = build_metric_point_rows(ctx.org_id, run_id, step, timestamp, &metrics);
    metric_store.insert_points(&ch_rows).await?;
    let response = json!({ "inserted": metrics.len() as i64 });
    if let (Some(key), Some(hash)) = (idempotency_key, request_hash) {
        sqlx::query(
            r#"
            insert into idempotency_keys (org_id, key, request_hash, response_json)
            values ($1, $2, $3, $4)
            "#,
        )
        .bind(ctx.org_id)
        .bind(validate_name(Some(&key), "idempotency key")?)
        .bind(hash)
        .bind(Json(response))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(metrics.len() as i64)
}

fn build_metric_point_rows(
    org_id: Uuid,
    run_id: Uuid,
    step: f64,
    logged_at: DateTime<Utc>,
    metrics: &BTreeMap<String, f64>,
) -> Vec<ChMetricPointRow> {
    metrics
        .iter()
        .map(|(key, value)| ChMetricPointRow {
            org_id,
            run_id,
            key: key.clone(),
            step,
            value: *value,
            logged_at,
            created_at: logged_at,
        })
        .collect()
}

pub(super) fn build_metric_point_rows_from_pairs(
    org_id: Uuid,
    run_id: Uuid,
    step: f64,
    logged_at: DateTime<Utc>,
    keys: &[String],
    values: &[f64],
) -> Vec<ChMetricPointRow> {
    keys.iter()
        .zip(values.iter())
        .map(|(key, value)| ChMetricPointRow {
            org_id,
            run_id,
            key: key.clone(),
            step,
            value: *value,
            logged_at,
            created_at: logged_at,
        })
        .collect()
}

pub async fn get_metrics(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let run = fetch_run(pool, run_id).await?;
    ensure_run_access(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let key = query
        .get("key")
        .map(|value| validate_name(Some(value), "metric key"))
        .transpose()?;
    let start = query
        .get("start_step")
        .map(|value| validate_query_step(value, "start_step"))
        .transpose()?;
    let end = query
        .get("end_step")
        .map(|value| validate_query_step(value, "end_step"))
        .transpose()?;
    if let (Some(start), Some(end)) = (start, end) {
        if start > end {
            return Err(AppError::validation(
                "start_step must be less than or equal to end_step",
            ));
        }
    }
    let read_rows = metric_store
        .query_points(ctx.org_id, run_id, key.as_deref(), start, end, limit)
        .await?;
    let rows: Vec<MetricPointRow> = read_rows
        .into_iter()
        .map(|row| MetricPointRow {
            key: row.key,
            step: row.step,
            value: row.value,
            created_at: row.created_at,
        })
        .collect();
    Ok(json!({ "metrics": rows, "limit": limit }))
}

pub async fn metrics_series_batched(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let key = validate_name(query.get("key").map(String::as_str), "metric key")?;
    let run_ids_raw = query
        .get("run_ids")
        .map(String::as_str)
        .ok_or_else(|| AppError::validation("run_ids must not be empty"))?;
    let mut requested: Vec<Uuid> = Vec::new();
    let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    for part in run_ids_raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let id = Uuid::parse_str(trimmed)
            .map_err(|_| AppError::validation(format!("invalid run id: {trimmed}")))?;
        if seen.insert(id) {
            requested.push(id);
        }
    }
    if requested.is_empty() {
        return Err(AppError::validation("run_ids must not be empty"));
    }
    if requested.len() > MAX_METRIC_SERIES_RUN_IDS {
        return Err(AppError::validation(format!(
            "run_ids must contain at most {MAX_METRIC_SERIES_RUN_IDS} ids"
        )));
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )?;
    let start = query
        .get("start_step")
        .map(|value| validate_query_step(value, "start_step"))
        .transpose()?;
    let end = query
        .get("end_step")
        .map(|value| validate_query_step(value, "end_step"))
        .transpose()?;
    if let (Some(start), Some(end)) = (start, end) {
        if start > end {
            return Err(AppError::validation(
                "start_step must be less than or equal to end_step",
            ));
        }
    }
    let allowed: Vec<Uuid> =
        sqlx::query_scalar("select id from runs where org_id = $1 and id = any($2::uuid[])")
            .bind(ctx.org_id)
            .bind(&requested)
            .fetch_all(pool)
            .await?;
    let allowed_set: std::collections::HashSet<Uuid> = allowed.into_iter().collect();
    let allowed_requested: Vec<Uuid> = requested
        .iter()
        .copied()
        .filter(|id| allowed_set.contains(id))
        .collect();
    let read_rows = metric_store
        .query_points_for_runs(ctx.org_id, &allowed_requested, &key, start, end, limit)
        .await?;
    let mut by_run: HashMap<Uuid, Vec<MetricPointRow>> = HashMap::new();
    for row in read_rows {
        by_run.entry(row.run_id).or_default().push(MetricPointRow {
            key: row.key,
            step: row.step,
            value: row.value,
            created_at: row.created_at,
        });
    }
    let series: Vec<Value> = requested
        .iter()
        .filter(|id| allowed_set.contains(id))
        .map(|id| {
            json!({
                "run_id": id,
                "metrics": by_run.remove(id).unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({
        "key": key,
        "limit": limit,
        "series": series,
    }))
}
fn validate_metrics(value: Value) -> AppResult<BTreeMap<String, f64>> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::validation("metrics must be a non-empty object"))?;
    if object.is_empty() {
        return Err(AppError::validation("metrics must be a non-empty object"));
    }
    if object.len() > MAX_METRICS_PER_BATCH {
        return Err(AppError::validation(format!(
            "metrics must include at most {MAX_METRICS_PER_BATCH} values"
        )));
    }
    let mut metrics = BTreeMap::new();
    for (key, raw) in object {
        let key = validate_name(Some(key), "metric key")?;
        let value = raw
            .as_f64()
            .ok_or_else(|| AppError::validation("metric values must be finite numbers"))?;
        if !value.is_finite() {
            return Err(AppError::validation("metric values must be finite numbers"));
        }
        metrics.insert(key, value);
    }
    Ok(metrics)
}

pub(super) fn validate_metric_value(value: f64) -> AppResult<f64> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(AppError::validation("metric values must be finite numbers"))
    }
}

async fn lock_idempotency_key(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    key: &str,
) -> AppResult<()> {
    sqlx::query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))")
        .bind(org_id.to_string())
        .bind(key)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(Debug)]
struct ExistingIdempotency {
    request_hash: Vec<u8>,
    response_json: Value,
}

async fn find_idempotency_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    key: &str,
) -> AppResult<Option<ExistingIdempotency>> {
    let row = sqlx::query(
        "select request_hash, response_json from idempotency_keys where org_id = $1 and key = $2",
    )
    .bind(org_id)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| {
        Ok(ExistingIdempotency {
            request_hash: row.try_get("request_hash")?,
            response_json: row.try_get("response_json")?,
        })
    })
    .transpose()
}

fn validate_query_step(raw: &str, field: &str) -> AppResult<f64> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| AppError::validation(format!("{field} must be a finite number")))?;
    if !value.is_finite() || value < 0.0 {
        return Err(AppError::validation(format!(
            "{field} must be a nonnegative number"
        )));
    }
    Ok(value)
}
