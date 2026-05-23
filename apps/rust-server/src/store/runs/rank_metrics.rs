use super::*;

pub async fn log_rank_metrics(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: LogRankMetricsRequest,
    idempotency_key: Option<String>,
) -> AppResult<usize> {
    let metrics = validate_metrics(input.metrics)?;
    let step = validate_step(&input.step, "step")?;
    let timestamp = validate_timestamp(input.timestamp.as_deref())?;
    let rank = validate_rank(input.rank, input.world_size)?;
    let local_rank = validate_local_rank(input.local_rank.unwrap_or(rank), input.world_size)?;
    let weight = validate_rank_weight(input.weight)?;
    let request_hash = hash_idempotency(run_id, &raw)?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let now = Utc::now();
    let points = metrics
        .iter()
        .map(|(key, value)| ChRankMetricPointRow {
            org_id: ctx.org_id,
            run_id,
            key: key.clone(),
            step,
            rank,
            local_rank,
            world_size: input.world_size,
            value: *value,
            weight,
            logged_at: timestamp,
            created_at: now,
            event_id: Uuid::new_v4(),
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
            ensure_billing_write_allowed(store, ctx.org_id, "log rank metrics").await?;
            enforce_plan_capacity(
                store,
                ctx.org_id,
                UsageDelta {
                    metric_points: points.len() as i64,
                    ..UsageDelta::default()
                },
                "log rank metrics",
            )
            .await?;
            metric_store.insert_rank_points(&points).await?;
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
    ensure_billing_write_allowed(store, ctx.org_id, "log rank metrics").await?;
    enforce_plan_capacity(
        store,
        ctx.org_id,
        UsageDelta {
            metric_points: points.len() as i64,
            ..UsageDelta::default()
        },
        "log rank metrics",
    )
    .await?;
    metric_store.insert_rank_points(&points).await?;
    Ok(points.len())
}

pub async fn rank_metrics_summary(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<RankMetricsSummaryResponse> {
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
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let requested_key = query
        .get("key")
        .filter(|value| !value.trim().is_empty())
        .map(|raw| validate_name(Some(raw.as_str()), "key"))
        .transpose()?;
    let keys = match requested_key.as_ref() {
        Some(key) => vec![key.clone()],
        None => {
            metric_store
                .query_rank_metric_keys(ctx.org_id, run_id, 200)
                .await?
        }
    };
    let selected_key = match query.get("key").filter(|value| !value.trim().is_empty()) {
        Some(_) => requested_key,
        None => keys.first().cloned(),
    };
    let Some(key) = selected_key else {
        return Ok(empty_rank_summary(keys, None, limit));
    };
    let observed_world_size = metric_store
        .query_rank_metric_max_world_size(ctx.org_id, run_id, &key, start_step, end_step)
        .await?;
    let effective_limit = effective_rank_step_limit(limit, observed_world_size);
    let row_limit = (effective_limit as usize)
        .saturating_mul(observed_world_size.clamp(1, MAX_RANK_WORLD_SIZE) as usize)
        .min(MAX_RANK_CANONICAL_ROWS);
    let rows = metric_store
        .query_rank_points_canonical(
            ctx.org_id,
            run_id,
            &key,
            RankMetricStepWindow {
                start_step,
                end_step,
                step_limit: effective_limit,
                row_limit: row_limit as i64,
            },
        )
        .await?;
    Ok(build_rank_summary(
        keys,
        Some(key),
        rows,
        effective_limit,
        effective_limit < limit,
    ))
}

fn validate_rank(rank: u32, world_size: u32) -> AppResult<u32> {
    validate_world_size(world_size)?;
    if rank >= world_size {
        return Err(AppError::validation("rank must be less than world_size"));
    }
    Ok(rank)
}

fn validate_local_rank(local_rank: u32, world_size: u32) -> AppResult<u32> {
    validate_world_size(world_size)?;
    if local_rank >= world_size {
        return Err(AppError::validation(
            "local_rank must be less than world_size",
        ));
    }
    Ok(local_rank)
}

fn validate_world_size(world_size: u32) -> AppResult<u32> {
    if world_size == 0 {
        return Err(AppError::validation("world_size must be at least 1"));
    }
    if world_size > MAX_RANK_WORLD_SIZE {
        return Err(AppError::validation(format!(
            "world_size cannot exceed {MAX_RANK_WORLD_SIZE}"
        )));
    }
    Ok(world_size)
}

fn validate_rank_weight(weight: Option<f64>) -> AppResult<f64> {
    let weight = weight.unwrap_or(1.0);
    if !weight.is_finite() || weight <= 0.0 {
        return Err(AppError::validation("weight must be finite and positive"));
    }
    Ok(weight)
}

fn empty_rank_summary(
    keys: Vec<String>,
    key: Option<String>,
    step_limit: i64,
) -> RankMetricsSummaryResponse {
    RankMetricsSummaryResponse {
        keys,
        key,
        reducers: Vec::new(),
        heatmap: Vec::new(),
        outliers: Vec::new(),
        coverage: Vec::new(),
        limits: RankMetricLimits {
            step_limit,
            max_world_size: MAX_RANK_WORLD_SIZE,
            max_canonical_rows: MAX_RANK_CANONICAL_ROWS,
            max_heatmap_cells: MAX_RANK_HEATMAP_CELLS,
            outlier_limit: MAX_RANK_OUTLIERS,
        },
        truncated: RankMetricTruncation {
            steps: false,
            heatmap: false,
            outliers: false,
        },
    }
}

fn build_rank_summary(
    keys: Vec<String>,
    key: Option<String>,
    rows: Vec<RankMetricCanonicalRow>,
    step_limit: i64,
    steps_truncated: bool,
) -> RankMetricsSummaryResponse {
    let mut groups: Vec<(f64, Vec<RankMetricCanonicalRow>)> = Vec::new();
    for row in rows {
        if let Some((step, current)) = groups.last_mut() {
            if *step == row.step {
                current.push(row);
                continue;
            }
        }
        groups.push((row.step, vec![row]));
    }

    let mut reducers = Vec::with_capacity(groups.len());
    let mut coverage = Vec::with_capacity(groups.len());
    let mut heatmap_groups: Vec<Vec<RankHeatmapPoint>> = Vec::with_capacity(groups.len());
    let mut outlier_candidates = Vec::new();
    let mut max_group_len = 1_usize;

    for (step, group) in &groups {
        max_group_len = max_group_len.max(group.len());
        let reducer = reducer_for_group(*step, group);
        let present = group.iter().map(|row| row.rank).collect::<BTreeSet<_>>();
        let expected = reducer.expected_world_size;
        let missing_rank_count = (expected as usize).saturating_sub(present.len());
        let missing_ranks = if expected <= 128 {
            (0..expected)
                .filter(|rank| !present.contains(rank))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        coverage.push(RankCoveragePoint {
            step: *step,
            rank_count: group.len(),
            expected_world_size: expected,
            missing_rank_count,
            missing_ranks,
            world_size_mismatch: reducer.world_size_mismatch,
        });
        let mut heatmap_points = Vec::with_capacity(group.len());
        for row in group {
            let delta = row.value - reducer.mean;
            heatmap_points.push(RankHeatmapPoint {
                step: *step,
                rank: row.rank,
                value: row.value,
                delta_from_mean: delta,
            });
            let z_score = if reducer.stddev > 0.0 {
                delta / reducer.stddev
            } else {
                0.0
            };
            outlier_candidates.push(RankOutlierPoint {
                rank: row.rank,
                step: *step,
                value: row.value,
                delta_from_mean: delta,
                z_score,
            });
        }
        heatmap_groups.push(heatmap_points);
        reducers.push(reducer);
    }

    let total_heatmap_cells = heatmap_groups.iter().map(Vec::len).sum::<usize>();
    let heatmap_truncated = total_heatmap_cells > MAX_RANK_HEATMAP_CELLS;
    let heatmap = if heatmap_truncated {
        sample_heatmap_groups(heatmap_groups, max_group_len)
    } else {
        heatmap_groups.into_iter().flatten().collect()
    };

    outlier_candidates.sort_by(|a, b| {
        b.z_score
            .abs()
            .total_cmp(&a.z_score.abs())
            .then_with(|| b.delta_from_mean.abs().total_cmp(&a.delta_from_mean.abs()))
    });
    let outliers_truncated = outlier_candidates.len() > MAX_RANK_OUTLIERS;
    outlier_candidates.truncate(MAX_RANK_OUTLIERS);

    RankMetricsSummaryResponse {
        keys,
        key,
        reducers,
        heatmap,
        outliers: outlier_candidates,
        coverage,
        limits: RankMetricLimits {
            step_limit,
            max_world_size: MAX_RANK_WORLD_SIZE,
            max_canonical_rows: MAX_RANK_CANONICAL_ROWS,
            max_heatmap_cells: MAX_RANK_HEATMAP_CELLS,
            outlier_limit: MAX_RANK_OUTLIERS,
        },
        truncated: RankMetricTruncation {
            steps: steps_truncated,
            heatmap: heatmap_truncated,
            outliers: outliers_truncated,
        },
    }
}

fn effective_rank_step_limit(requested_limit: i64, observed_world_size: u32) -> i64 {
    let world_size = observed_world_size.clamp(1, MAX_RANK_WORLD_SIZE) as usize;
    let max_steps = (MAX_RANK_CANONICAL_ROWS / world_size).max(1) as i64;
    requested_limit.min(max_steps)
}

fn reducer_for_group(step: f64, group: &[RankMetricCanonicalRow]) -> RankReducerPoint {
    let rank_count = group.len();
    let expected_world_size = group.iter().map(|row| row.world_size).max().unwrap_or(0);
    let world_size_mismatch = group
        .iter()
        .any(|row| row.world_size != expected_world_size);
    let sum = group.iter().map(|row| row.value).sum::<f64>();
    let mean = if rank_count > 0 {
        sum / rank_count as f64
    } else {
        0.0
    };
    let weight_sum = group.iter().map(|row| row.weight).sum::<f64>();
    let weighted_mean = if weight_sum > 0.0 {
        group.iter().map(|row| row.value * row.weight).sum::<f64>() / weight_sum
    } else {
        mean
    };
    let min = group
        .iter()
        .map(|row| row.value)
        .fold(f64::INFINITY, f64::min);
    let max = group
        .iter()
        .map(|row| row.value)
        .fold(f64::NEG_INFINITY, f64::max);
    let variance = if rank_count > 0 {
        group
            .iter()
            .map(|row| {
                let diff = row.value - mean;
                diff * diff
            })
            .sum::<f64>()
            / rank_count as f64
    } else {
        0.0
    };
    let mut values = group.iter().map(|row| row.value).collect::<Vec<_>>();
    values.sort_by(f64::total_cmp);
    RankReducerPoint {
        step,
        rank_count,
        expected_world_size,
        world_size_mismatch,
        mean,
        weighted_mean,
        min: if min.is_finite() { min } else { 0.0 },
        max: if max.is_finite() { max } else { 0.0 },
        stddev: variance.max(0.0).sqrt(),
        p05: percentile(&values, 0.05),
        p50: percentile(&values, 0.50),
        p95: percentile(&values, 0.95),
    }
}

fn percentile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f64 * p).round() as usize;
    values[index.min(values.len() - 1)]
}

fn sample_heatmap_groups(
    groups: Vec<Vec<RankHeatmapPoint>>,
    max_group_len: usize,
) -> Vec<RankHeatmapPoint> {
    let max_steps = (MAX_RANK_HEATMAP_CELLS / max_group_len.max(1)).max(1);
    if groups.len() <= max_steps {
        return groups
            .into_iter()
            .flatten()
            .take(MAX_RANK_HEATMAP_CELLS)
            .collect();
    }
    let last = groups.len().saturating_sub(1);
    let mut out = Vec::new();
    for sample_index in 0..max_steps {
        let index = if max_steps == 1 {
            0
        } else {
            ((sample_index as f64 / (max_steps - 1) as f64) * last as f64).round() as usize
        };
        out.extend(groups[index].iter().cloned());
        if out.len() >= MAX_RANK_HEATMAP_CELLS {
            out.truncate(MAX_RANK_HEATMAP_CELLS);
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        step: f64,
        rank: u32,
        world_size: u32,
        value: f64,
        weight: f64,
    ) -> RankMetricCanonicalRow {
        RankMetricCanonicalRow {
            step,
            rank,
            local_rank: rank,
            world_size,
            value,
            weight,
        }
    }

    #[test]
    fn rank_reducer_uses_weighted_mean_and_coverage() {
        let summary = build_rank_summary(
            vec!["train/loss".to_string()],
            Some("train/loss".to_string()),
            vec![row(1.0, 0, 4, 1.0, 1.0), row(1.0, 2, 4, 3.0, 3.0)],
            1000,
            false,
        );
        assert_eq!(summary.reducers[0].rank_count, 2);
        assert_eq!(summary.reducers[0].mean, 2.0);
        assert_eq!(summary.reducers[0].weighted_mean, 2.5);
        assert_eq!(summary.coverage[0].missing_ranks, vec![1, 3]);
    }

    #[test]
    fn rank_reducer_reports_world_size_mismatch() {
        let summary = build_rank_summary(
            vec!["train/loss".to_string()],
            Some("train/loss".to_string()),
            vec![row(1.0, 0, 2, 1.0, 1.0), row(1.0, 1, 4, 2.0, 1.0)],
            1000,
            false,
        );
        assert!(summary.reducers[0].world_size_mismatch);
        assert_eq!(summary.reducers[0].expected_world_size, 4);
    }

    #[test]
    fn rank_validation_rejects_bad_values() {
        assert!(validate_rank(2, 2).is_err());
        assert!(validate_rank(0, 0).is_err());
        assert!(validate_local_rank(3, 3).is_err());
        assert!(validate_rank_weight(Some(0.0)).is_err());
    }

    #[test]
    fn effective_rank_step_limit_caps_canonical_rows() {
        assert_eq!(effective_rank_step_limit(5_000, 8), 5_000);
        assert_eq!(
            effective_rank_step_limit(5_000, MAX_RANK_WORLD_SIZE),
            (MAX_RANK_CANONICAL_ROWS / MAX_RANK_WORLD_SIZE as usize) as i64
        );
        assert_eq!(effective_rank_step_limit(5_000, 0), 5_000);
    }
}
