use super::*;

pub async fn side_by_side(
    pool: &PgPool,
    metric_store: &MetricStore,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let run_ids = parse_run_ids(query.get("run_ids").or_else(|| query.get("runs")))?;
    if run_ids.len() > MAX_SIDE_BY_SIDE_RUNS {
        return Err(AppError::validation(format!(
            "run_ids must include at most {MAX_SIDE_BY_SIDE_RUNS} runs"
        )));
    }
    let reference_run_id = query
        .get("reference_run_id")
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .or_else(|| run_ids.first().copied());
    let diff_only = query
        .get("diff_only")
        .map(|value| value == "true")
        .unwrap_or(false);
    let mut runs = Vec::new();
    for run_id in &run_ids {
        let run = fetch_run(pool, *run_id).await?;
        ensure_run_access(ctx, &run)?;
        runs.push(run);
    }
    let mut series = metric_series_for_runs_limited(
        metric_store,
        ctx.org_id,
        &run_ids,
        MAX_SIDE_BY_SIDE_ROWS as i64 + 1,
    )
    .await?;
    let series_truncated = series.len() > MAX_SIDE_BY_SIDE_ROWS;
    series.truncate(MAX_SIDE_BY_SIDE_ROWS);
    let mut attributes =
        side_by_side_attributes(pool, ctx.org_id, &run_ids, MAX_SIDE_BY_SIDE_ROWS as i64 + 1)
            .await?;
    let attributes_truncated = attributes.len() > MAX_SIDE_BY_SIDE_ROWS;
    attributes.truncate(MAX_SIDE_BY_SIDE_ROWS);
    let mut values_by_run: HashMap<Uuid, BTreeMap<String, Value>> = HashMap::new();
    for run in &runs {
        let mut values = BTreeMap::new();
        if let Some(config) = run.config.as_object() {
            for (key, value) in config {
                values.insert(format!("config/{key}"), value.clone());
            }
        }
        if let Some(metadata) = run.metadata.as_object() {
            for (key, value) in metadata {
                values.insert(format!("metadata/{key}"), value.clone());
            }
        }
        for tag in &run.tags {
            values.insert(format!("tag/{tag}"), json!(true));
        }
        for item in series.iter().filter(|item| item.run_id == run.id) {
            values.insert(format!("metric/{}/latest", item.key), json!(item.latest));
            values.insert(format!("metric/{}/max", item.key), json!(item.max));
            values.insert(format!("metric/{}/mean", item.key), json!(item.mean));
        }
        for attribute in attributes.iter().filter(|item| item.run_id == run.id) {
            values.insert(
                format!("attribute/{}", attribute.path),
                attribute.value.clone(),
            );
        }
        values_by_run.insert(run.id, values);
    }
    let mut paths = BTreeSet::new();
    for values in values_by_run.values() {
        paths.extend(values.keys().cloned());
    }
    let path_count = paths.len();
    let truncated = attributes_truncated || series_truncated || path_count > MAX_SIDE_BY_SIDE_ROWS;
    let rows = paths
        .into_iter()
        .take(MAX_SIDE_BY_SIDE_ROWS)
        .filter_map(|path| {
            let mut values = Map::new();
            for run in &runs {
                values.insert(
                    run.id.to_string(),
                    values_by_run[&run.id]
                        .get(&path)
                        .cloned()
                        .unwrap_or(Value::Null),
                );
            }
            let different = values
                .values()
                .map(|value| serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()))
                .collect::<BTreeSet<_>>()
                .len()
                > 1;
            if diff_only && !different {
                return None;
            }
            let reference = reference_run_id
                .and_then(|id| values.get(&id.to_string()).cloned())
                .unwrap_or(Value::Null);
            Some(json!({
                "path": path,
                "values": values,
                "reference_run_id": reference_run_id,
                "reference": reference,
                "different": different
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "runs": runs,
        "reference_run_id": reference_run_id,
        "rows": rows,
        "truncated": truncated
    }))
}
fn parse_run_ids(raw: Option<&String>) -> AppResult<Vec<Uuid>> {
    let raw = raw.ok_or_else(|| AppError::validation("run_ids must include at least one run"))?;
    let ids = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value).map_err(|_| AppError::validation("run id must be a valid UUID"))
        })
        .collect::<AppResult<Vec<_>>>()?;
    if ids.is_empty() {
        Err(AppError::validation(
            "run_ids must include at least one run",
        ))
    } else {
        Ok(ids)
    }
}
