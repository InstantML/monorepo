use super::*;

const DEFAULT_USAGE_DAYS: i64 = 14;
const MAX_USAGE_DAYS: i64 = 31;
const SYSTEM_USAGE_AGGREGATE_LIMIT: i64 = 50_000;
const SYSTEM_USAGE_RUN_LIMIT: usize = 5_000;
const MAX_SAMPLE_INTERVAL_SECONDS: f64 = 60.0;

#[derive(Default)]
struct RunUsage {
    run_id: Uuid,
    run_name: String,
    project: String,
    status: String,
    actor_label: String,
    actor_source: String,
    actor_confidence: String,
    gpu_model: String,
    observed_gpu_seconds: f64,
    utilized_gpu_seconds: f64,
    low_utilization_seconds: f64,
    energy_kwh: f64,
    power_sample_count: u64,
    gpu_sample_count: u64,
    cpu_sample_count: u64,
    memory_sample_count: u64,
    coverage_expected_seconds: f64,
    max_gpu_memory_percent: Option<f64>,
    avg_gpu_memory_percent_numerator: f64,
    avg_gpu_memory_percent_denominator: f64,
    avg_gpu_util_percent_numerator: f64,
    avg_gpu_util_percent_denominator: f64,
    avg_cpu_percent_numerator: f64,
    avg_cpu_percent_denominator: f64,
    buckets: [f64; 5],
    first_logged_at: Option<DateTime<Utc>>,
    last_logged_at: Option<DateTime<Utc>>,
    device_ids: BTreeSet<String>,
}

impl RunUsage {
    fn coverage_pct(&self) -> f64 {
        if self.coverage_expected_seconds <= 0.0 {
            if self.observed_gpu_seconds > 0.0 {
                100.0
            } else {
                0.0
            }
        } else {
            (self.observed_gpu_seconds / self.coverage_expected_seconds * 100.0).clamp(0.0, 100.0)
        }
    }

    fn avg_gpu_util_percent(&self) -> Option<f64> {
        weighted_average(
            self.avg_gpu_util_percent_numerator,
            self.avg_gpu_util_percent_denominator,
        )
    }

    fn avg_gpu_memory_percent(&self) -> Option<f64> {
        weighted_average(
            self.avg_gpu_memory_percent_numerator,
            self.avg_gpu_memory_percent_denominator,
        )
    }

    fn avg_cpu_percent(&self) -> Option<f64> {
        weighted_average(
            self.avg_cpu_percent_numerator,
            self.avg_cpu_percent_denominator,
        )
    }
}

#[derive(Default)]
struct UsageGroup {
    key: String,
    label: String,
    kind: String,
    actor_source: String,
    actor_confidence: String,
    run_count: usize,
    observed_gpu_seconds: f64,
    utilized_gpu_seconds: f64,
    low_utilization_seconds: f64,
    energy_kwh: f64,
    sample_count: u64,
    coverage_expected_seconds: f64,
    max_gpu_memory_percent: Option<f64>,
    util_numerator: f64,
    util_denominator: f64,
    memory_numerator: f64,
    memory_denominator: f64,
    buckets: [f64; 5],
}

pub async fn system_usage_insights(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let family = query
        .get("family")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "gpu".to_string());
    if !matches!(family.as_str(), "gpu" | "system") {
        return Err(AppError::validation("family must be gpu or system"));
    }
    let group_by = query
        .get("group_by")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "actor".to_string());
    if !matches!(group_by.as_str(), "actor" | "project" | "gpu_model" | "run") {
        return Err(AppError::validation(
            "group_by must be actor, project, gpu_model, or run",
        ));
    }
    let (period_start, period_end, range_label) = usage_period(query)?;
    let project_filter = query
        .get("project")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let actor_filter = query
        .get("actor")
        .or_else(|| query.get("actor_user_id"))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let gpu_model_filter = query
        .get("gpu_model")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let min_coverage_pct = parse_optional_f64(query, "min_coverage_pct", 0.0, 0.0, 100.0)?;
    let row_limit = parse_optional_usize(query, "limit", 100, 1, 500)?;

    let mut runs = visible_runs_for_usage(store, ctx, period_start, period_end).await?;
    runs.retain(|run| {
        if let Some(project) = &project_filter {
            if run.project != *project && run.project_id.to_string() != *project {
                return false;
            }
        }
        let (actor_label, actor_source, _) = run_actor(run);
        if let Some(actor) = &actor_filter {
            if actor_label.to_ascii_lowercase() != *actor
                && actor_source.to_ascii_lowercase() != *actor
            {
                return false;
            }
        }
        if let Some(gpu_model_filter_value) = &gpu_model_filter {
            if gpu_model(run).to_ascii_lowercase() != *gpu_model_filter_value {
                return false;
            }
        }
        true
    });
    runs.sort_by_key(|run| std::cmp::Reverse(run.started_at));
    if runs.len() > SYSTEM_USAGE_RUN_LIMIT {
        return Err(AppError::validation(format!(
            "usage insights are limited to {SYSTEM_USAGE_RUN_LIMIT} runs; narrow the time or project filter"
        )));
    }
    let run_ids = runs.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let aggregate_rows = metric_store
        .query_system_usage_aggregates(
            ctx.org_id,
            &run_ids,
            period_start,
            period_end,
            SYSTEM_USAGE_AGGREGATE_LIMIT,
        )
        .await?;
    let aggregate_truncated = aggregate_rows.len() >= SYSTEM_USAGE_AGGREGATE_LIMIT as usize;
    let mut usages = usage_by_run(&runs, aggregate_rows, period_start, period_end);
    usages.retain(|usage| usage.coverage_pct() >= min_coverage_pct);

    let summary = usage_summary(&usages);
    let groups = grouped_usage_rows(&usages, &group_by, row_limit);
    let top_runs = top_usage_runs(&usages, row_limit.min(50));
    let retained_run_ids = usages
        .iter()
        .map(|usage| usage.run_id)
        .collect::<BTreeSet<_>>();
    let scoped_runs = runs
        .iter()
        .filter(|run| retained_run_ids.contains(&run.id))
        .cloned()
        .collect::<Vec<_>>();
    let coverage = coverage_summary(&scoped_runs, &usages, aggregate_truncated);
    let attention = attention_cards(&scoped_runs, &usages, &coverage);
    let available_filters = available_filters(&usages);

    Ok(json!({
        "family": family,
        "generated_at": Utc::now(),
        "is_invoice_grade": false,
        "period": {
            "start": period_start,
            "end": period_end,
            "range": range_label,
            "timezone": "UTC"
        },
        "filters": {
            "group_by": group_by,
            "project": project_filter,
            "actor": actor_filter,
            "gpu_model": gpu_model_filter,
            "min_coverage_pct": min_coverage_pct,
            "limit": row_limit
        },
        "summary": summary,
        "coverage": coverage,
        "groups": groups,
        "top_runs": top_runs,
        "attention": attention,
        "available_filters": available_filters,
        "notes": [
            "Usage is estimated from logged system metrics and run metadata.",
            "Observed GPU hours are not billable tracked hours or invoice data."
        ]
    }))
}

async fn visible_runs_for_usage(
    store: &Store,
    ctx: &RequestContext,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> AppResult<Vec<RunRow>> {
    let data = store.data.lock().await;
    Ok(data
        .runs
        .values()
        .filter(|run| {
            run.org_id == ctx.org_id
                && is_visible_run(&data, run)
                && ensure_run_access_in_data(ctx, run).is_ok()
                && run_overlaps_period(run, period_start, period_end)
        })
        .cloned()
        .collect())
}

fn usage_by_run(
    runs: &[RunRow],
    aggregate_rows: Vec<SystemUsageAggregateRow>,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> Vec<RunUsage> {
    let run_map = runs
        .iter()
        .map(|run| (run.id, run))
        .collect::<HashMap<_, _>>();
    let mut usages = runs
        .iter()
        .map(|run| {
            let (actor_label, actor_source, actor_confidence) = run_actor(run);
            (
                run.id,
                RunUsage {
                    run_id: run.id,
                    run_name: run.name.clone(),
                    project: run.project.clone(),
                    status: run.status.clone(),
                    actor_label,
                    actor_source,
                    actor_confidence,
                    gpu_model: gpu_model(run),
                    coverage_expected_seconds: run_period_seconds(run, period_start, period_end),
                    ..RunUsage::default()
                },
            )
        })
        .collect::<HashMap<_, _>>();

    for row in aggregate_rows {
        let Some(run) = run_map.get(&row.run_id).copied() else {
            continue;
        };
        let Some(usage) = usages.get_mut(&row.run_id) else {
            continue;
        };
        let sample_seconds = aggregate_sample_seconds(&row);
        if let Some((device_id, metric_name)) = parse_gpu_metric_key(&row.key) {
            usage.device_ids.insert(device_id);
            usage.gpu_sample_count += row.sample_count;
            merge_logged_bounds(usage, row.first_logged_at, row.last_logged_at);
            match metric_name.as_str() {
                "utilization_percent" => {
                    usage.observed_gpu_seconds += sample_seconds;
                    usage.utilized_gpu_seconds +=
                        sample_seconds * (row.avg_value.clamp(0.0, 100.0) / 100.0);
                    let low_count = row.bucket_0_10 + row.bucket_10_30;
                    if row.sample_count > 0 {
                        usage.low_utilization_seconds +=
                            sample_seconds * (low_count as f64 / row.sample_count as f64);
                        usage.buckets[0] +=
                            sample_seconds * (row.bucket_0_10 as f64 / row.sample_count as f64);
                        usage.buckets[1] +=
                            sample_seconds * (row.bucket_10_30 as f64 / row.sample_count as f64);
                        usage.buckets[2] +=
                            sample_seconds * (row.bucket_30_60 as f64 / row.sample_count as f64);
                        usage.buckets[3] +=
                            sample_seconds * (row.bucket_60_85 as f64 / row.sample_count as f64);
                        usage.buckets[4] +=
                            sample_seconds * (row.bucket_85_100 as f64 / row.sample_count as f64);
                    }
                    usage.avg_gpu_util_percent_numerator += row.avg_value * sample_seconds;
                    usage.avg_gpu_util_percent_denominator += sample_seconds;
                }
                "memory_percent" => {
                    usage.max_gpu_memory_percent =
                        max_option(usage.max_gpu_memory_percent, row.max_value);
                    usage.avg_gpu_memory_percent_numerator +=
                        row.avg_value * sample_seconds.max(row.sample_count as f64);
                    usage.avg_gpu_memory_percent_denominator +=
                        sample_seconds.max(row.sample_count as f64);
                }
                "power_watts" => {
                    usage.power_sample_count += row.sample_count;
                    usage.energy_kwh += row.avg_value.max(0.0) * sample_seconds / 3_600_000.0;
                }
                _ => {}
            }
        } else if row.key == "system/cpu_percent" {
            usage.cpu_sample_count += row.sample_count;
            usage.avg_cpu_percent_numerator += row.avg_value * row.sample_count as f64;
            usage.avg_cpu_percent_denominator += row.sample_count as f64;
        } else if matches!(
            row.key.as_str(),
            "system/memory_percent" | "system/memory_used_bytes" | "system/process_rss_bytes"
        ) {
            usage.memory_sample_count += row.sample_count;
        }
        let overlap_seconds = run_period_seconds(run, period_start, period_end);
        let devices = usage.device_ids.len().max(1) as f64;
        usage.coverage_expected_seconds = overlap_seconds * devices;
    }

    let mut rows = usages.into_values().collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.observed_gpu_seconds
            .partial_cmp(&a.observed_gpu_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

fn usage_summary(usages: &[RunUsage]) -> Value {
    let observed_gpu_seconds = usages
        .iter()
        .map(|usage| usage.observed_gpu_seconds)
        .sum::<f64>();
    let utilized_gpu_seconds = usages
        .iter()
        .map(|usage| usage.utilized_gpu_seconds)
        .sum::<f64>();
    let low_utilization_seconds = usages
        .iter()
        .map(|usage| usage.low_utilization_seconds)
        .sum::<f64>();
    let expected_seconds = usages
        .iter()
        .map(|usage| usage.coverage_expected_seconds)
        .sum::<f64>();
    let sample_count = usages
        .iter()
        .map(|usage| usage.gpu_sample_count)
        .sum::<u64>();
    let energy_kwh = usages.iter().map(|usage| usage.energy_kwh).sum::<f64>();
    let max_gpu_memory_percent = usages
        .iter()
        .filter_map(|usage| usage.max_gpu_memory_percent)
        .fold(None, max_option);
    json!({
        "observed_gpu_hours": hours(observed_gpu_seconds),
        "utilized_gpu_hours": hours(utilized_gpu_seconds),
        "low_utilization_gpu_hours": hours(low_utilization_seconds),
        "avg_gpu_utilization_percent": percent(utilized_gpu_seconds, observed_gpu_seconds),
        "max_gpu_memory_percent": max_gpu_memory_percent,
        "energy_kwh": energy_kwh,
        "sample_count": sample_count,
        "run_count": usages.iter().filter(|usage| usage.observed_gpu_seconds > 0.0).count(),
        "coverage_pct": percent(observed_gpu_seconds, expected_seconds),
        "utilization_buckets": bucket_json(bucket_totals(usages)),
    })
}

fn grouped_usage_rows(usages: &[RunUsage], group_by: &str, limit: usize) -> Vec<Value> {
    let mut groups = BTreeMap::<String, UsageGroup>::new();
    for usage in usages {
        let (key, label, kind, source, confidence) = match group_by {
            "project" => (
                usage.project.clone(),
                usage.project.clone(),
                "project".to_string(),
                String::new(),
                String::new(),
            ),
            "gpu_model" => (
                usage.gpu_model.clone(),
                usage.gpu_model.clone(),
                "gpu_model".to_string(),
                String::new(),
                String::new(),
            ),
            "run" => (
                usage.run_id.to_string(),
                usage.run_name.clone(),
                "run".to_string(),
                usage.actor_source.clone(),
                usage.actor_confidence.clone(),
            ),
            _ => (
                usage.actor_label.clone(),
                usage.actor_label.clone(),
                "attribution".to_string(),
                usage.actor_source.clone(),
                usage.actor_confidence.clone(),
            ),
        };
        let group = groups.entry(key.clone()).or_insert_with(|| UsageGroup {
            key,
            label,
            kind,
            actor_source: source,
            actor_confidence: confidence,
            ..UsageGroup::default()
        });
        group.run_count += 1;
        group.observed_gpu_seconds += usage.observed_gpu_seconds;
        group.utilized_gpu_seconds += usage.utilized_gpu_seconds;
        group.low_utilization_seconds += usage.low_utilization_seconds;
        group.energy_kwh += usage.energy_kwh;
        group.sample_count += usage.gpu_sample_count;
        group.coverage_expected_seconds += usage.coverage_expected_seconds;
        group.max_gpu_memory_percent =
            option_max(group.max_gpu_memory_percent, usage.max_gpu_memory_percent);
        group.util_numerator += usage.avg_gpu_util_percent_numerator;
        group.util_denominator += usage.avg_gpu_util_percent_denominator;
        group.memory_numerator += usage.avg_gpu_memory_percent_numerator;
        group.memory_denominator += usage.avg_gpu_memory_percent_denominator;
        for index in 0..5 {
            group.buckets[index] += usage.buckets[index];
        }
    }
    let mut rows = groups.into_values().collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.observed_gpu_seconds
            .partial_cmp(&a.observed_gpu_seconds)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.into_iter()
        .take(limit)
        .map(|group| {
            json!({
                "key": group.key,
                "label": group.label,
                "kind": group.kind,
                "actor_source": empty_to_null(group.actor_source),
                "actor_confidence": empty_to_null(group.actor_confidence),
                "run_count": group.run_count,
                "observed_gpu_hours": hours(group.observed_gpu_seconds),
                "utilized_gpu_hours": hours(group.utilized_gpu_seconds),
                "low_utilization_gpu_hours": hours(group.low_utilization_seconds),
                "avg_gpu_utilization_percent": weighted_average(group.util_numerator, group.util_denominator),
                "avg_gpu_memory_percent": weighted_average(group.memory_numerator, group.memory_denominator),
                "max_gpu_memory_percent": group.max_gpu_memory_percent,
                "energy_kwh": group.energy_kwh,
                "sample_count": group.sample_count,
                "coverage_pct": percent(group.observed_gpu_seconds, group.coverage_expected_seconds),
                "utilization_buckets": bucket_json(group.buckets),
            })
        })
        .collect()
}

fn top_usage_runs(usages: &[RunUsage], limit: usize) -> Vec<Value> {
    usages
        .iter()
        .filter(|usage| usage.observed_gpu_seconds > 0.0)
        .take(limit)
        .map(|usage| {
            json!({
                "run_id": usage.run_id,
                "run_name": usage.run_name,
                "project": usage.project,
                "status": usage.status,
                "actor_label": usage.actor_label,
                "actor_source": usage.actor_source,
                "actor_confidence": usage.actor_confidence,
                "gpu_model": usage.gpu_model,
                "observed_gpu_hours": hours(usage.observed_gpu_seconds),
                "utilized_gpu_hours": hours(usage.utilized_gpu_seconds),
                "low_utilization_gpu_hours": hours(usage.low_utilization_seconds),
                "avg_gpu_utilization_percent": usage.avg_gpu_util_percent(),
                "avg_gpu_memory_percent": usage.avg_gpu_memory_percent(),
                "max_gpu_memory_percent": usage.max_gpu_memory_percent,
                "avg_cpu_percent": usage.avg_cpu_percent(),
                "energy_kwh": usage.energy_kwh,
                "sample_count": usage.gpu_sample_count,
                "coverage_pct": usage.coverage_pct(),
                "utilization_buckets": bucket_json(usage.buckets),
                "first_logged_at": usage.first_logged_at,
                "last_logged_at": usage.last_logged_at,
            })
        })
        .collect()
}

fn coverage_summary(runs: &[RunRow], usages: &[RunUsage], truncated: bool) -> Value {
    let runs_with_gpu = usages
        .iter()
        .filter(|usage| usage.observed_gpu_seconds > 0.0)
        .count();
    let observed = usages
        .iter()
        .map(|usage| usage.observed_gpu_seconds)
        .sum::<f64>();
    let expected = usages
        .iter()
        .map(|usage| usage.coverage_expected_seconds)
        .sum::<f64>();
    json!({
        "runs_in_scope": runs.len(),
        "runs_with_gpu_metrics": runs_with_gpu,
        "runs_missing_gpu_metrics": runs.len().saturating_sub(runs_with_gpu),
        "sample_count": usages.iter().map(|usage| usage.gpu_sample_count).sum::<u64>(),
        "coverage_pct": percent(observed, expected),
        "aggregate_truncated": truncated,
        "low_confidence_attribution_rows": usages.iter().filter(|usage| usage.actor_confidence == "low").count(),
    })
}

fn attention_cards(runs: &[RunRow], usages: &[RunUsage], coverage: &Value) -> Vec<Value> {
    let missing = coverage
        .get("runs_missing_gpu_metrics")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let low_util_hours = usages
        .iter()
        .map(|usage| usage.low_utilization_seconds)
        .sum::<f64>();
    let failed_gpu_hours = usages
        .iter()
        .filter(|usage| usage.status == "failed")
        .map(|usage| usage.observed_gpu_seconds)
        .sum::<f64>();
    let high_memory_low_util = usages
        .iter()
        .filter(|usage| {
            usage.avg_gpu_util_percent().unwrap_or(100.0) < 30.0
                && usage.max_gpu_memory_percent.unwrap_or(0.0) >= 85.0
        })
        .count();
    let cpu_bound = usages
        .iter()
        .filter(|usage| {
            usage.avg_gpu_util_percent().unwrap_or(100.0) < 30.0
                && usage.avg_cpu_percent().unwrap_or(0.0) >= 70.0
        })
        .count();
    let mut cards = Vec::new();
    if missing > 0 {
        cards.push(json!({
            "id": "missing_gpu_telemetry",
            "severity": if missing as usize == runs.len() { "warn" } else { "info" },
            "title": "Runs missing GPU telemetry",
            "message": format!("{missing} runs in scope did not report GPU metrics."),
            "metric": "runs",
            "value": missing as f64
        }));
    }
    if low_util_hours > 0.0 {
        cards.push(json!({
            "id": "low_utilization",
            "severity": "warn",
            "title": "Low-utilization GPU time",
            "message": "GPU utilization was below 30% for part of the observed window.",
            "metric": "gpu_hours",
            "value": hours(low_util_hours)
        }));
    }
    if failed_gpu_hours > 0.0 {
        cards.push(json!({
            "id": "failed_gpu_hours",
            "severity": "warn",
            "title": "Failed-run GPU time",
            "message": "Some observed GPU time belongs to failed runs.",
            "metric": "gpu_hours",
            "value": hours(failed_gpu_hours)
        }));
    }
    if high_memory_low_util > 0 {
        cards.push(json!({
            "id": "memory_bound",
            "severity": "info",
            "title": "High memory with low utilization",
            "message": "These runs may be memory-bound or waiting on work despite reserving GPU memory.",
            "metric": "runs",
            "value": high_memory_low_util as f64
        }));
    }
    if cpu_bound > 0 {
        cards.push(json!({
            "id": "cpu_bound",
            "severity": "info",
            "title": "CPU/data-loading pressure",
            "message": "Low GPU utilization overlaps high CPU usage in this window.",
            "metric": "runs",
            "value": cpu_bound as f64
        }));
    }
    cards
}

fn available_filters(usages: &[RunUsage]) -> Value {
    json!({
        "projects": filter_options(usages.iter().map(|usage| usage.project.clone())),
        "actors": filter_options(usages.iter().map(|usage| usage.actor_label.clone())),
        "gpu_models": filter_options(usages.iter().map(|usage| usage.gpu_model.clone())),
    })
}

fn usage_period(
    query: &HashMap<String, String>,
) -> AppResult<(DateTime<Utc>, DateTime<Utc>, String)> {
    let now = Utc::now();
    let end = match query.get("end").map(String::as_str) {
        Some(raw) if !raw.trim().is_empty() => parse_rfc3339(raw, "end")?,
        _ => now,
    };
    let range = query
        .get("range")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{DEFAULT_USAGE_DAYS}d"));
    if range_days(&range).is_none() {
        return Err(AppError::validation("range must be 7d, 14d, or 30d"));
    }
    let start = match query.get("start").map(String::as_str) {
        Some(raw) if !raw.trim().is_empty() => parse_rfc3339(raw, "start")?,
        _ => end - ChronoDuration::days(range_days(&range).unwrap_or(DEFAULT_USAGE_DAYS)),
    };
    if start >= end {
        return Err(AppError::validation("start must be before end"));
    }
    let max_window = ChronoDuration::days(MAX_USAGE_DAYS);
    let bounded_start = if end - start > max_window {
        end - max_window
    } else {
        start
    };
    Ok((bounded_start, end, range))
}

fn parse_rfc3339(raw: &str, field: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw.trim())
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::validation(format!("{field} must be an RFC3339 timestamp")))
}

fn range_days(range: &str) -> Option<i64> {
    match range {
        "7d" => Some(7),
        "14d" => Some(14),
        "30d" => Some(30),
        _ => None,
    }
}

fn parse_optional_f64(
    query: &HashMap<String, String>,
    key: &str,
    default: f64,
    min: f64,
    max: f64,
) -> AppResult<f64> {
    let Some(raw) = query
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(default);
    };
    let value = raw
        .parse::<f64>()
        .map_err(|_| AppError::validation(format!("{key} must be a number")))?;
    if !value.is_finite() || value < min || value > max {
        return Err(AppError::validation(format!(
            "{key} must be between {min} and {max}"
        )));
    }
    Ok(value)
}

fn parse_optional_usize(
    query: &HashMap<String, String>,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> AppResult<usize> {
    let Some(raw) = query
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(default);
    };
    let value = raw
        .parse::<usize>()
        .map_err(|_| AppError::validation(format!("{key} must be an integer")))?;
    if value < min || value > max {
        return Err(AppError::validation(format!(
            "{key} must be between {min} and {max}"
        )));
    }
    Ok(value)
}

fn parse_gpu_metric_key(key: &str) -> Option<(String, String)> {
    let parts = key.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["system", "gpu", device, metric] => Some(((*device).to_string(), (*metric).to_string())),
        ["system", "gpu_util"] | ["system", "gpu_utilization"] => {
            Some(("0".to_string(), "utilization_percent".to_string()))
        }
        ["gpu", device, metric] => Some(((*device).to_string(), (*metric).to_string())),
        _ => None,
    }
}

fn aggregate_sample_seconds(row: &SystemUsageAggregateRow) -> f64 {
    if row.sample_count < 2 {
        return 0.0;
    }
    let span = (row.last_logged_at - row.first_logged_at)
        .num_milliseconds()
        .max(0) as f64
        / 1000.0;
    if span <= 0.0 {
        return 0.0;
    }
    let interval = (span / (row.sample_count.saturating_sub(1) as f64))
        .clamp(0.0, MAX_SAMPLE_INTERVAL_SECONDS);
    interval * row.sample_count as f64
}

fn run_actor(run: &RunRow) -> (String, String, String) {
    for key in [
        "owner",
        "owner_email",
        "user",
        "user_email",
        "created_by",
        "created_by_email",
    ] {
        if let Some(value) = run.metadata.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return (
                    safe_actor_label(trimmed),
                    format!("metadata.{key}"),
                    "medium".to_string(),
                );
            }
        }
    }
    (
        "Unknown".to_string(),
        "unknown".to_string(),
        "low".to_string(),
    )
}

fn safe_actor_label(value: &str) -> String {
    let trimmed = value.trim();
    if let Some((local, domain)) = trimmed.split_once('@') {
        let visible = local.chars().next().unwrap_or('*');
        return format!("{visible}***@{domain}");
    }
    trimmed.to_string()
}

fn gpu_model(run: &RunRow) -> String {
    for key in [
        "gpu_model",
        "gpu_name",
        "device_name",
        "accelerator",
        "instance_type",
    ] {
        if let Some(value) = run.metadata.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "Unknown GPU".to_string()
}

fn run_overlaps_period(
    run: &RunRow,
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> bool {
    let run_end = run.finished_at.unwrap_or(period_end);
    run.started_at < period_end && run_end > period_start
}

fn run_period_seconds(run: &RunRow, period_start: DateTime<Utc>, period_end: DateTime<Utc>) -> f64 {
    let start = run.started_at.max(period_start);
    let end = run.finished_at.unwrap_or(period_end).min(period_end);
    (end - start).num_milliseconds().max(0) as f64 / 1000.0
}

fn merge_logged_bounds(usage: &mut RunUsage, first: DateTime<Utc>, last: DateTime<Utc>) {
    usage.first_logged_at = Some(
        usage
            .first_logged_at
            .map_or(first, |current| current.min(first)),
    );
    usage.last_logged_at = Some(
        usage
            .last_logged_at
            .map_or(last, |current| current.max(last)),
    );
}

fn bucket_totals(usages: &[RunUsage]) -> [f64; 5] {
    let mut totals = [0.0; 5];
    for usage in usages {
        for (index, value) in usage.buckets.iter().enumerate() {
            totals[index] += value;
        }
    }
    totals
}

fn bucket_json(buckets: [f64; 5]) -> Vec<Value> {
    ["0-10", "10-30", "30-60", "60-85", "85-100"]
        .iter()
        .enumerate()
        .map(|(index, label)| json!({ "bucket": label, "gpu_hours": hours(buckets[index]) }))
        .collect()
}

fn filter_options(values: impl Iterator<Item = String>) -> Vec<Value> {
    values
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .take(100)
        .map(|value| json!({ "label": value, "value": value }))
        .collect()
}

fn weighted_average(numerator: f64, denominator: f64) -> Option<f64> {
    if denominator > 0.0 && numerator.is_finite() {
        Some(numerator / denominator)
    } else {
        None
    }
}

fn percent(numerator: f64, denominator: f64) -> Option<f64> {
    if denominator > 0.0 {
        Some((numerator / denominator * 100.0).clamp(0.0, 100.0))
    } else {
        None
    }
}

fn hours(seconds: f64) -> f64 {
    seconds.max(0.0) / 3600.0
}

fn max_option(current: Option<f64>, next: f64) -> Option<f64> {
    Some(current.map_or(next, |value| value.max(next)))
}

fn option_max(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn empty_to_null(value: String) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_metric_key_parser_supports_current_and_legacy_keys() {
        assert_eq!(
            parse_gpu_metric_key("system/gpu/0/utilization_percent"),
            Some(("0".to_string(), "utilization_percent".to_string()))
        );
        assert_eq!(
            parse_gpu_metric_key("gpu/1/memory_percent"),
            Some(("1".to_string(), "memory_percent".to_string()))
        );
        assert_eq!(
            parse_gpu_metric_key("system/gpu_util"),
            Some(("0".to_string(), "utilization_percent".to_string()))
        );
        assert_eq!(parse_gpu_metric_key("system/cpu_percent"), None);
    }

    #[test]
    fn usage_period_bounds_custom_windows_to_one_month() {
        let mut query = HashMap::new();
        query.insert("start".to_string(), "2026-01-01T00:00:00Z".to_string());
        query.insert("end".to_string(), "2026-03-01T00:00:00Z".to_string());
        let (start, end, _) = usage_period(&query).expect("period");
        assert_eq!(end.to_rfc3339(), "2026-03-01T00:00:00+00:00");
        assert_eq!((end - start).num_days(), MAX_USAGE_DAYS);
    }

    #[test]
    fn usage_query_validation_rejects_unknown_ranges_and_bad_numbers() {
        let mut query = HashMap::new();
        query.insert("range".to_string(), "90d".to_string());
        assert!(usage_period(&query).is_err());

        query.clear();
        query.insert("min_coverage_pct".to_string(), "all".to_string());
        assert!(parse_optional_f64(&query, "min_coverage_pct", 0.0, 0.0, 100.0).is_err());

        query.clear();
        query.insert("limit".to_string(), "1000".to_string());
        assert!(parse_optional_usize(&query, "limit", 100, 1, 500).is_err());
    }

    #[test]
    fn actor_fallback_is_low_confidence_when_metadata_is_missing() {
        let run = RunRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            project: "default".to_string(),
            name: "run".to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: Vec::new(),
            metadata: json!({}),
            created_at: Utc::now(),
            started_at: Utc::now(),
            finished_at: None,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        };
        assert_eq!(
            run_actor(&run),
            (
                "Unknown".to_string(),
                "unknown".to_string(),
                "low".to_string()
            )
        );
    }

    #[test]
    fn actor_labels_mask_email_like_metadata() {
        let run = RunRow {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            project: "default".to_string(),
            name: "run".to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: Vec::new(),
            metadata: json!({"owner_email": "alice@example.com"}),
            created_at: Utc::now(),
            started_at: Utc::now(),
            finished_at: None,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        };

        assert_eq!(
            run_actor(&run),
            (
                "a***@example.com".to_string(),
                "metadata.owner_email".to_string(),
                "medium".to_string()
            )
        );
    }
}
