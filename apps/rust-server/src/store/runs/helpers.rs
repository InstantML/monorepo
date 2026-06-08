use super::*;

pub(super) const MAX_CLICKHOUSE_RUN_ID_CHUNK: usize = 4_000;

pub(super) fn project_filter(query: &HashMap<String, String>) -> Option<&str> {
    query
        .get("project")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && *value != "all")
}

pub(super) fn has_text_search(query: &HashMap<String, String>) -> bool {
    query
        .get("q")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub(super) fn has_status_filter(query: &HashMap<String, String>) -> bool {
    query
        .get("status")
        .map(String::as_str)
        .map(|value| !value.is_empty() && value != "all")
        .unwrap_or(false)
}

pub(super) fn has_display_status_filter(query: &HashMap<String, String>) -> bool {
    query
        .get("display_status")
        .map(String::as_str)
        .map(|value| !value.is_empty() && value != "all")
        .unwrap_or(false)
}

pub(super) fn metric_keys_from_run_values(run_values: &[Value], limit: usize) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for value in run_values {
        let Some(items) = value.get("metric_keys").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(key) = item.as_str() {
                keys.insert(key.to_string());
                if keys.len() >= limit {
                    return keys.into_iter().collect();
                }
            }
        }
    }
    keys.into_iter().collect()
}

pub(super) fn validate_run_sort(sort_by: &str) -> AppResult<String> {
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

pub(super) fn sort_runs_by_metric(
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

pub(super) fn is_minimize_metric(key: &str) -> bool {
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

pub(super) fn metric_sort_mode(sort_by: &str, metric_key: &str) -> SeriesSortMode {
    if sort_by == "metric-latest" {
        SeriesSortMode::Latest
    } else if is_minimize_metric(metric_key) {
        SeriesSortMode::BestMin
    } else {
        SeriesSortMode::BestMax
    }
}

pub fn numeric_desc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    let left = left.unwrap_or(f64::NEG_INFINITY);
    let right = right.unwrap_or(f64::NEG_INFINITY);
    right.total_cmp(&left)
}

pub(super) fn numeric_asc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    let left = left.unwrap_or(f64::INFINITY);
    let right = right.unwrap_or(f64::INFINITY);
    left.total_cmp(&right)
}

pub(super) fn duration_seconds(run: &RunRow) -> Option<f64> {
    run.finished_at
        .map(|finished| (finished - run.started_at).num_milliseconds() as f64 / 1_000.0)
}
