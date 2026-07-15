use super::*;

pub async fn side_by_side(
    store: &Store,
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
    build_side_by_side(
        store,
        ctx,
        run_ids,
        reference_run_id,
        diff_only,
        None,
        false,
    )
    .await
}

pub async fn compare_matching_runs(
    store: &Store,
    ctx: &RequestContext,
    input: CompareMatchingRunsRequest,
) -> AppResult<Value> {
    let limit = input.limit.unwrap_or(20);
    if limit == 0 {
        return Err(AppError::validation("limit must be at least 1"));
    }
    if limit > MAX_SIDE_BY_SIDE_RUNS {
        return Err(AppError::validation(format!(
            "limit cannot exceed {MAX_SIDE_BY_SIDE_RUNS}"
        )));
    }

    let sort_by = validate_run_sort(input.sort_by.as_deref().unwrap_or("created"))?;
    let metric_key = input
        .metric_key
        .as_deref()
        .map(|value| validate_name(Some(value), "metric_key"))
        .transpose()?
        .or_else(|| {
            matches!(sort_by.as_str(), "metric-latest" | "metric-best")
                .then(|| "eval/return_mean".to_string())
        });
    let include_rows = input.include_rows.unwrap_or(true);
    let diff_only = input.diff_only.unwrap_or(false);

    let mut query = HashMap::new();
    if let Some(project) = input.project.as_ref().filter(|value| !value.is_empty()) {
        query.insert("project".to_string(), project.clone());
    }
    if let Some(q) = input.q.as_ref().filter(|value| !value.trim().is_empty()) {
        query.insert("q".to_string(), q.clone());
    }
    if let Some(status) = input.status.as_ref().filter(|value| !value.is_empty()) {
        query.insert("status".to_string(), status.clone());
    }
    if let Some(display_status) = input
        .display_status
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        query.insert("display_status".to_string(), display_status.clone());
    }
    query.insert("sort_by".to_string(), sort_by.clone());
    if let Some(metric_key) = metric_key.as_ref() {
        query.insert("metric_key".to_string(), metric_key.clone());
    }

    let ranked = filtered_runs(store, ctx, &query).await?;
    let total_matching_runs = ranked.len();
    let mut selected = ranked.iter().take(limit).cloned().collect::<Vec<_>>();
    let mut selection_reasons = selected
        .iter()
        .map(|run| (run.id, "selected".to_string()))
        .collect::<HashMap<_, _>>();

    if let Some(reference_run_id) = input.reference_run_id {
        if !selected.iter().any(|run| run.id == reference_run_id) {
            let reference = ranked
                .iter()
                .find(|run| run.id == reference_run_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("run not found"))?;
            if selected.len() >= MAX_SIDE_BY_SIDE_RUNS {
                if let Some(removed) = selected.pop() {
                    selection_reasons.remove(&removed.id);
                }
            }
            selection_reasons.insert(reference.id, "reference".to_string());
            selected.push(reference);
        }
    }

    let selected_run_ids = selected.iter().map(|run| run.id).collect::<Vec<_>>();
    let effective_reference_run_id = input
        .reference_run_id
        .or_else(|| selected_run_ids.first().copied());
    let metric_series = if let Some(metric_key) = metric_key.as_ref() {
        let metric_store = store.metric_store_for_org(ctx.org_id).await?;
        metric_series_for_runs_key(&metric_store, ctx.org_id, &selected_run_ids, metric_key)
            .await?
            .into_iter()
            .map(|row| (row.run_id, row))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    let display_statuses = if sort_by == "status" {
        let data = store.data.lock().await;
        selected
            .iter()
            .map(|run| {
                (
                    run.id,
                    run_control_display_status(run, run_control_for(&data, run)).to_string(),
                )
            })
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    let candidates = selected
        .iter()
        .enumerate()
        .map(|(index, run)| {
            candidate_evidence(
                index + 1,
                run,
                &sort_by,
                metric_key.as_deref(),
                metric_key.as_ref().and_then(|_| metric_series.get(&run.id)),
                display_statuses.get(&run.id).map(String::as_str),
                selection_reasons
                    .get(&run.id)
                    .map(String::as_str)
                    .unwrap_or("selected"),
            )
        })
        .collect::<Vec<_>>();
    let summary_metric_keys = metric_key
        .as_ref()
        .map(|key| vec![key.clone()])
        .unwrap_or_default();
    let runs =
        summarize_runs_for_metric_keys(store, selected.clone(), &summary_metric_keys).await?;
    let rows_payload = if include_rows {
        let row_metric_keys = metric_key
            .as_ref()
            .map(|key| vec![key.clone()])
            .unwrap_or_default();
        Some(
            build_side_by_side(
                store,
                ctx,
                selected_run_ids.clone(),
                effective_reference_run_id,
                diff_only,
                Some(row_metric_keys),
                true,
            )
            .await?,
        )
    } else {
        None
    };

    let rows = rows_payload
        .as_ref()
        .and_then(|payload| payload.get("rows").cloned())
        .unwrap_or_else(|| json!([]));
    let rows_truncated = rows_payload
        .as_ref()
        .and_then(|payload| payload.get("truncated").and_then(Value::as_bool))
        .unwrap_or(false);

    Ok(json!({
        "query": {
            "project": input.project,
            "q": input.q,
            "status": input.status,
            "display_status": input.display_status,
            "sort_by": sort_by,
            "metric_key": metric_key
        },
        "total_matching_runs": total_matching_runs,
        "selected_run_ids": selected_run_ids,
        "candidates": candidates,
        "runs": runs,
        "rows": rows,
        "reference_run_id": effective_reference_run_id,
        "limits": {
            "runs": MAX_SIDE_BY_SIDE_RUNS,
            "rows": MAX_SIDE_BY_SIDE_ROWS
        },
        "truncated": {
            "runs": total_matching_runs > limit,
            "rows": rows_truncated
        }
    }))
}

async fn build_side_by_side(
    store: &Store,
    ctx: &RequestContext,
    run_ids: Vec<Uuid>,
    reference_run_id: Option<Uuid>,
    diff_only: bool,
    metric_keys: Option<Vec<String>>,
    prioritize_differences: bool,
) -> AppResult<Value> {
    let (runs, attributes) = {
        let data = store.data.lock().await;
        let mut runs = Vec::new();
        let mut attributes = Vec::new();
        for run_id in &run_ids {
            let run = fetch_run_in_data(&data, ctx, *run_id)?;
            ensure_run_access_in_data(ctx, &run)?;
            attributes.extend(
                data.attributes_by_run
                    .get(run_id)
                    .into_iter()
                    .flatten()
                    .filter_map(|id| data.attributes.get(&(ctx.org_id, *id)).cloned())
                    .filter(|attribute| attribute.run_id == *run_id),
            );
            runs.push(run);
        }
        (runs, attributes)
    };
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let series = match metric_keys.as_ref() {
        Some(keys) if keys.is_empty() => Vec::new(),
        Some(keys) => {
            metric_series_for_runs_keys(&metric_store, ctx.org_id, &run_ids, keys).await?
        }
        None => {
            metric_series_for_runs_limited(
                &metric_store,
                ctx.org_id,
                &run_ids,
                MAX_SIDE_BY_SIDE_ROWS as i64 + 1,
            )
            .await?
        }
    };
    // Group series/attribute rows by run once — the per-run .filter() scans
    // made this O(runs x rows) (up to 50 x 5000 iterations per request).
    let mut series_by_run: HashMap<Uuid, Vec<&MetricSeriesRow>> = HashMap::new();
    for item in &series {
        series_by_run.entry(item.run_id).or_default().push(item);
    }
    let mut attributes_by_run: HashMap<Uuid, Vec<&AttributeRow>> = HashMap::new();
    for item in &attributes {
        attributes_by_run.entry(item.run_id).or_default().push(item);
    }
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
        for item in series_by_run.get(&run.id).into_iter().flatten() {
            values.insert(format!("metric/{}/latest", item.key), json!(item.latest));
            values.insert(format!("metric/{}/max", item.key), json!(item.max));
            values.insert(format!("metric/{}/mean", item.key), json!(item.mean));
        }
        for attribute in attributes_by_run.get(&run.id).into_iter().flatten() {
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
    let mut row_entries = paths
        .into_iter()
        .filter_map(|path| {
            let mut values = Map::new();
            for run in &runs {
                values.insert(
                    run.id.to_string(),
                    values_by_run[&run.id].get(&path).cloned().unwrap_or(Value::Null),
                );
            }
            // Value equality is canonical here (serde_json without
            // preserve_order keeps object keys sorted), so comparing against
            // the first cell replaces a JSON re-serialization of every cell.
            let mut cells = values.values();
            let first = cells.next();
            let different = match first {
                Some(first) => cells.any(|value| value != first),
                None => false,
            };
            if diff_only && !different {
                return None;
            }
            let reference = reference_run_id
                .and_then(|id| values.get(&id.to_string()).cloned())
                .unwrap_or(Value::Null);
            Some((
                path.clone(),
                different,
                json!({ "path": path, "values": values, "reference_run_id": reference_run_id, "reference": reference, "different": different }),
            ))
        })
        .collect::<Vec<_>>();
    if prioritize_differences {
        row_entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    }
    let truncated = row_entries.len() > MAX_SIDE_BY_SIDE_ROWS;
    let rows = row_entries
        .into_iter()
        .take(MAX_SIDE_BY_SIDE_ROWS)
        .map(|(_, _, row)| row)
        .collect::<Vec<_>>();
    Ok(
        json!({ "runs": runs, "reference_run_id": reference_run_id, "rows": rows, "truncated": truncated }),
    )
}

fn candidate_evidence(
    rank: usize,
    run: &RunRow,
    sort_by: &str,
    metric_key: Option<&str>,
    metric: Option<&MetricSeriesRow>,
    display_status: Option<&str>,
    selection_reason: &str,
) -> Value {
    let sort_mode = match sort_by {
        "metric-latest" => "latest",
        "metric-best" if metric_key.map(is_minimize_metric).unwrap_or(false) => "min",
        "metric-best" => "max",
        other => other,
    };
    let sort_value = match sort_by {
        "metric-latest" => metric
            .and_then(|row| row.latest)
            .map(Value::from)
            .unwrap_or(Value::Null),
        "metric-best" if metric_key.map(is_minimize_metric).unwrap_or(false) => metric
            .and_then(|row| row.min)
            .map(Value::from)
            .unwrap_or(Value::Null),
        "metric-best" => metric
            .and_then(|row| row.max)
            .map(Value::from)
            .unwrap_or(Value::Null),
        "duration" => duration_seconds_for_candidate(run)
            .map(Value::from)
            .unwrap_or(Value::Null),
        "name" => json!(run.name),
        "status" => json!(display_status.unwrap_or(run.status.as_str())),
        _ => json!(run.created_at),
    };
    json!({
        "rank": rank,
        "run_id": run.id,
        "sort_value": sort_value,
        "sort_mode": sort_mode,
        "metric_key": metric_key,
        "metric_count": metric.map(|row| row.count),
        "latest_step": metric.and_then(|row| row.latest_step),
        "best_step": metric.and_then(|row| row.best_step),
        "missing_metric": metric_key.is_some() && metric.is_none(),
        "selection_reason": selection_reason
    })
}

fn duration_seconds_for_candidate(run: &RunRow) -> Option<f64> {
    run.finished_at
        .map(|finished| (finished - run.started_at).num_milliseconds() as f64 / 1_000.0)
}

pub async fn export_data(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    if let Some(auth) = &ctx.auth {
        auth.require_scope("export:read")?;
    }
    let (selected, total_runs) = export_runs(store, ctx, query).await?;
    let run_ids = selected.iter().map(|run| run.id).collect::<Vec<_>>();
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
    let (metrics, metrics_truncated) =
        metric_point_values_for_runs(&metric_store, ctx.org_id, &run_ids).await?;
    let (metric_series, metric_series_truncated) = metric_series_values_for_runs_limited(
        &metric_store,
        ctx.org_id,
        &run_ids,
        Some(MAX_EXPORT_METRIC_SERIES),
    )
    .await?;
    let data = store.data.lock().await;
    let run_id_set = run_ids.iter().copied().collect::<BTreeSet<_>>();
    let projects = {
        let mut map = BTreeMap::new();
        for run in &selected {
            if let Some(project) = data.projects.get(&run.project_id) {
                map.insert(project.id, project.clone());
            }
        }
        map.into_values().collect::<Vec<_>>()
    };
    let organization = data
        .organizations
        .get(&ctx.org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let (attribute_rows, attributes_truncated) = collect_limited(
        run_ids
            .iter()
            .flat_map(|run_id| data.attributes_by_run.get(run_id).into_iter().flatten())
            .filter_map(|id| data.attributes.get(&(ctx.org_id, *id)))
            .filter(|attribute| run_id_set.contains(&attribute.run_id)),
        MAX_EXPORT_ATTRIBUTES,
    );
    let artifact_public_uris =
        export_artifact_public_uris_for_attributes(&data, ctx.org_id, &run_id_set, &attribute_rows);
    let attributes = attribute_rows
        .iter()
        .map(|attribute| export_attribute_value(attribute, &artifact_public_uris))
        .collect::<Vec<_>>();
    let (artifacts, artifacts_truncated) = collect_limited(
        run_ids
            .iter()
            .flat_map(|run_id| data.artifacts_by_run.get(run_id).into_iter().flatten())
            .filter_map(|id| data.artifacts.get(id))
            .map(|artifact| artifact.public_row()),
        MAX_EXPORT_ARTIFACTS,
    );
    let (table_object_rows, table_object_rows_truncated) =
        export_table_object_rows(&data, ctx.org_id, &run_ids);
    let mut imports = export_import_rows(&data, ctx.org_id, &run_id_set);
    let imports_truncated = imports.len() > MAX_IMPORT_LIST as usize;
    imports.truncate(MAX_IMPORT_LIST as usize);
    let exported_at = Utc::now();
    Ok(json!({
        "version": 1,
        "exported_at": exported_at,
        "generated_at": exported_at,
        "organizations": [organization],
        "projects": projects,
        "runs": selected,
        "metric_series": metric_series,
        "metrics": metrics,
        "attributes": attributes,
        "artifacts": artifacts,
        "table_object_rows": table_object_rows,
        "imports": imports,
        "limits": {
            "runs": MAX_EXPORT_RUNS,
            "selected_run_ids": MAX_EXPORT_SELECTED_RUN_IDS,
            "metrics": MAX_EXPORT_METRICS,
            "metric_series": MAX_EXPORT_METRIC_SERIES,
            "attributes": MAX_EXPORT_ATTRIBUTES,
            "artifacts": MAX_EXPORT_ARTIFACTS,
            "table_object_rows": MAX_EXPORT_TABLE_OBJECT_ROWS,
            "imports": MAX_IMPORT_LIST,
            "csv_bytes": MAX_EXPORT_CSV_BYTES
        },
        "truncated": total_runs > run_ids.len()
            || metrics_truncated
            || metric_series_truncated
            || attributes_truncated
            || artifacts_truncated
            || table_object_rows_truncated
            || imports_truncated
    }))
}

async fn export_runs(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<(Vec<RunRow>, usize)> {
    if query.get("run_ids").or_else(|| query.get("runs")).is_some() {
        let run_ids = parse_export_run_ids(query)?;
        let data = store.data.lock().await;
        let mut runs = Vec::with_capacity(run_ids.len());
        for run_id in run_ids {
            runs.push(export_selected_run_in_data(&data, ctx, run_id)?);
        }
        return Ok((runs, 0));
    }
    let runs = filtered_runs(store, ctx, query).await?;
    let total_runs = runs.len();
    Ok((runs.into_iter().take(MAX_EXPORT_RUNS).collect(), total_runs))
}

fn parse_export_run_ids(query: &HashMap<String, String>) -> AppResult<Vec<Uuid>> {
    let ids = parse_run_ids(query.get("run_ids").or_else(|| query.get("runs")))?;
    let mut seen = BTreeSet::new();
    let mut deduped = Vec::new();
    for id in ids {
        if seen.insert(id) {
            deduped.push(id);
        }
    }
    if deduped.len() > MAX_EXPORT_SELECTED_RUN_IDS {
        return Err(AppError::validation(format!(
            "run_ids must include at most {MAX_EXPORT_SELECTED_RUN_IDS} runs for synchronous export"
        )));
    }
    Ok(deduped)
}

fn export_selected_run_in_data(
    data: &StoreData,
    ctx: &RequestContext,
    run_id: Uuid,
) -> AppResult<RunRow> {
    let Some(run) = data.runs.get(&run_id).cloned() else {
        return Err(AppError::not_found("run not found"));
    };
    if !is_visible_run(data, &run)
        || run.org_id != ctx.org_id
        || ctx
            .auth
            .as_ref()
            .and_then(|auth| auth.project_id)
            .map(|id| id != run.project_id)
            .unwrap_or(false)
    {
        return Err(AppError::not_found("run not found"));
    }
    Ok(run)
}

fn export_artifact_public_uris_for_attributes(
    data: &StoreData,
    org_id: Uuid,
    run_id_set: &BTreeSet<Uuid>,
    attributes: &[&AttributeRow],
) -> HashMap<String, String> {
    attributes
        .iter()
        .filter_map(|attribute| attribute.artifact_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|artifact_id| data.artifacts.get(&artifact_id))
        .filter(|artifact| artifact.org_id == org_id && run_id_set.contains(&artifact.run_id))
        .filter(|artifact| matches!(artifact.storage_backend.as_str(), "local" | "r2"))
        .map(|artifact| (artifact.uri.clone(), artifact.public_uri()))
        .collect()
}

fn export_attribute_value(
    row: &AttributeRow,
    public_uri_by_private_uri: &HashMap<String, String>,
) -> Value {
    let mut value = attribute_value(row);
    sanitize_export_private_uris(&mut value, public_uri_by_private_uri);
    value
}

fn sanitize_export_private_uris(
    value: &mut Value,
    public_uri_by_private_uri: &HashMap<String, String>,
) {
    match value {
        Value::String(raw) => {
            if let Some(public_uri) = public_uri_by_private_uri.get(raw) {
                *raw = public_uri.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_export_private_uris(item, public_uri_by_private_uri);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                sanitize_export_private_uris(item, public_uri_by_private_uri);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn export_import_rows(
    data: &StoreData,
    org_id: Uuid,
    run_id_set: &BTreeSet<Uuid>,
) -> Vec<ImportRow> {
    let mut imports = data
        .imports
        .values()
        .filter(|row| row.org_id == org_id)
        .filter(|row| row.run_ids.iter().any(|id| run_id_set.contains(id)))
        .map(|row| {
            let mut row = row.clone();
            row.run_ids.retain(|id| run_id_set.contains(id));
            row
        })
        .collect::<Vec<_>>();
    imports.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    imports
}

fn export_table_object_rows(
    data: &StoreData,
    org_id: Uuid,
    run_ids: &[Uuid],
) -> (Vec<Value>, bool) {
    let mut rows = Vec::new();
    for run_id in run_ids {
        let Some(attribute_ids) = data.attributes_by_run.get(run_id) else {
            continue;
        };
        for attribute_id in attribute_ids {
            let Some(attribute) = data.attributes.get(&(org_id, *attribute_id)) else {
                continue;
            };
            if attribute.run_id != *run_id {
                continue;
            }
            let Some(table_rows) = data.table_rows.get(&(org_id, attribute.id)) else {
                continue;
            };
            for row in table_rows {
                if rows.len() == MAX_EXPORT_TABLE_OBJECT_ROWS {
                    return (rows, true);
                }
                rows.push(json!({
                    "org_id": org_id,
                    "run_id": attribute.run_id,
                    "attribute_id": attribute.id,
                    "row_index": row.row_index,
                    "row": row.row.clone(),
                    "created_at": row.created_at
                }));
            }
        }
    }
    (rows, false)
}

fn collect_limited<I, T>(iter: I, limit: usize) -> (Vec<T>, bool)
where
    I: IntoIterator<Item = T>,
{
    let mut values = Vec::new();
    for item in iter {
        if values.len() == limit {
            return (values, true);
        }
        values.push(item);
    }
    (values, false)
}

pub fn export_payload_to_csv(payload: &Value) -> AppResult<String> {
    let mut writer = CsvWriter::new(MAX_EXPORT_CSV_BYTES);
    writer.push_record(CSV_HEADER.iter().copied())?;
    let run_lookup = export_run_lookup(payload);
    for record_type in [
        "organizations",
        "projects",
        "runs",
        "metric_series",
        "metrics",
        "attributes",
        "artifacts",
        "table_object_rows",
        "imports",
    ] {
        let Some(rows) = payload.get(record_type).and_then(Value::as_array) else {
            continue;
        };
        let singular = singular_record_type(record_type);
        for row in rows {
            writer.push_record(csv_row(singular, row, &run_lookup)?)?;
        }
    }
    Ok(writer.finish())
}

const CSV_HEADER: [&str; 16] = [
    "record_type",
    "org_id",
    "project_id",
    "run_id",
    "run_name",
    "run_status",
    "artifact_id",
    "attribute_id",
    "key",
    "path",
    "step",
    "value",
    "logged_at",
    "created_at",
    "row_index",
    "json",
];

struct CsvWriter {
    body: String,
    max_bytes: usize,
}

impl CsvWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            body: String::new(),
            max_bytes,
        }
    }

    fn push_record<I, S>(&mut self, cells: I) -> AppResult<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut first = true;
        for cell in cells {
            if !first {
                self.body.push(',');
            }
            first = false;
            self.body.push_str(&csv_cell(cell.as_ref()));
        }
        self.body.push('\n');
        if self.body.len() > self.max_bytes {
            return Err(AppError::validation(format!(
                "CSV export exceeds the synchronous {} byte cap; narrow the selection or use async export when available",
                self.max_bytes
            )));
        }
        Ok(())
    }

    fn finish(self) -> String {
        self.body
    }
}

fn singular_record_type(record_type: &str) -> &'static str {
    match record_type {
        "organizations" => "organization",
        "projects" => "project",
        "runs" => "run",
        "metric_series" => "metric_series",
        "metrics" => "metric",
        "attributes" => "attribute",
        "artifacts" => "artifact",
        "table_object_rows" => "table_object_row",
        "imports" => "import",
        _ => "record",
    }
}

fn export_run_lookup(payload: &Value) -> HashMap<String, (String, String)> {
    payload
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let id = value_string(row.get("id"))?;
            let name = value_string(row.get("name")).unwrap_or_default();
            let status = value_string(row.get("status")).unwrap_or_default();
            Some((id, (name, status)))
        })
        .collect()
}

fn csv_row(
    record_type: &str,
    row: &Value,
    run_lookup: &HashMap<String, (String, String)>,
) -> AppResult<Vec<String>> {
    let run_id = value_string(row.get("run_id"))
        .or_else(|| {
            (record_type == "run")
                .then(|| value_string(row.get("id")))
                .flatten()
        })
        .unwrap_or_default();
    let (run_name, run_status) = if record_type == "run" {
        (
            value_string(row.get("name")).unwrap_or_default(),
            value_string(row.get("status")).unwrap_or_default(),
        )
    } else {
        run_lookup.get(&run_id).cloned().unwrap_or_default()
    };
    let org_id = value_string(row.get("org_id"))
        .or_else(|| {
            (record_type == "organization")
                .then(|| value_string(row.get("id")))
                .flatten()
        })
        .unwrap_or_default();
    let project_id = value_string(row.get("project_id"))
        .or_else(|| {
            (record_type == "project")
                .then(|| value_string(row.get("id")))
                .flatten()
        })
        .unwrap_or_default();
    let value = row
        .get("value")
        .or_else(|| row.get("latest"))
        .map(csv_value_string)
        .unwrap_or_default();
    let json = serde_json::to_string(row)
        .map_err(|_| AppError::internal("export CSV row serialization failed"))?;
    Ok(vec![
        record_type.to_string(),
        org_id,
        project_id,
        run_id,
        run_name,
        run_status,
        (record_type == "artifact")
            .then(|| value_string(row.get("id")))
            .flatten()
            .unwrap_or_default(),
        value_string(row.get("attribute_id"))
            .or_else(|| {
                (record_type == "attribute")
                    .then(|| value_string(row.get("id")))
                    .flatten()
            })
            .unwrap_or_default(),
        value_string(row.get("key")).unwrap_or_default(),
        value_string(row.get("path")).unwrap_or_default(),
        value_string(row.get("step")).unwrap_or_default(),
        value,
        value_string(row.get("logged_at")).unwrap_or_default(),
        value_string(row.get("created_at")).unwrap_or_default(),
        value_string(row.get("row_index")).unwrap_or_default(),
        json,
    ])
}

fn value_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(raw) => Some(raw.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        other => serde_json::to_string(other).ok(),
    }
}

fn csv_value_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(raw) => raw.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn csv_cell(raw: &str) -> String {
    let protected = protect_csv_formula(raw);
    let needs_quotes = protected
        .chars()
        .any(|ch| matches!(ch, ',' | '"' | '\n' | '\r'));
    if !needs_quotes {
        return protected;
    }
    format!("\"{}\"", protected.replace('"', "\"\""))
}

fn protect_csv_formula(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    if raw.starts_with(['\t', '\r', '\n']) {
        return format!("'{raw}");
    }
    let first_non_padding = raw.chars().find(|ch| !csv_formula_padding(*ch));
    if first_non_padding.is_some_and(|ch| matches!(ch, '=' | '+' | '-' | '@')) {
        format!("'{raw}")
    } else {
        raw.to_string()
    }
}

fn csv_formula_padding(ch: char) -> bool {
    ch.is_whitespace() || ch.is_control() || ch == '\u{feff}'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_cell_escapes_quotes_and_commas() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_cell("a\nb"), "\"a\nb\"");
    }

    #[test]
    fn csv_cell_neutralizes_formula_like_values() {
        assert_eq!(csv_cell("=cmd"), "'=cmd");
        assert_eq!(csv_cell("  +SUM(A1:A2)"), "'  +SUM(A1:A2)");
        assert_eq!(csv_cell("-1"), "'-1");
        assert_eq!(csv_cell("@name"), "'@name");
        assert_eq!(csv_cell("\t=cmd"), "'\t=cmd");
        assert_eq!(csv_cell("\tplain"), "'\tplain");
        assert_eq!(csv_cell("\rplain"), "\"'\rplain\"");
        assert_eq!(csv_cell("\nplain"), "\"'\nplain\"");
        assert_eq!(csv_cell("\u{000b}=cmd"), "'\u{000b}=cmd");
        assert_eq!(csv_cell("\u{feff}=cmd"), "'\u{feff}=cmd");
    }

    #[test]
    fn export_attribute_value_redacts_private_artifact_uris() {
        let org_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let artifact_id = Uuid::new_v4();
        let private_uri = "instantml://artifacts/bucket/runs/run-1/media.png";
        let public_uri = format!("instantml://artifacts/{artifact_id}");
        let external_uri = "https://example.com/public.png";
        let attribute = AttributeRow {
            id: 1,
            org_id,
            run_id,
            path: "media/image".to_string(),
            kind: "image".to_string(),
            step: Some(1.0),
            logged_at: Some(Utc::now()),
            value: json!({
                "kind": "image",
                "uri": private_uri,
                "metadata": {
                    "copy": private_uri,
                    "external": external_uri
                }
            }),
            summary: json!({ "preview_uri": private_uri }),
            artifact_id: Some(artifact_id),
            created_at: Utc::now(),
        };
        let exported = export_attribute_value(
            &attribute,
            &HashMap::from([(private_uri.to_string(), public_uri.clone())]),
        );
        let exported_text = serde_json::to_string(&exported).unwrap();
        assert!(!exported_text.contains(private_uri));
        assert!(exported_text.contains(&public_uri));
        assert!(exported_text.contains(external_uri));

        let csv = export_payload_to_csv(&json!({
            "organizations": [],
            "projects": [],
            "runs": [],
            "metric_series": [],
            "metrics": [],
            "attributes": [exported],
            "artifacts": [],
            "table_object_rows": [],
            "imports": []
        }))
        .unwrap();
        assert!(!csv.contains(private_uri));
        assert!(csv.contains(&public_uri));
    }

    #[test]
    fn selected_export_hides_incomplete_import_runs() {
        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let ctx = RequestContext {
            org_id,
            auth: None,
            session: None,
        };
        let mut data = StoreData::default();
        let mut hidden = test_run(org_id, project_id, "half-imported");
        hidden.metadata = json!({
            "import": {
                "source_type": "wandb",
                "external_project_id": "team/project",
                "external_run_id": "run-1",
                "complete": false
            }
        });
        let hidden_id = hidden.id;
        let visible = test_run(org_id, project_id, "complete");
        let visible_id = visible.id;
        data.insert_run(hidden);
        data.insert_run(visible);

        assert!(export_selected_run_in_data(&data, &ctx, hidden_id).is_err());
        assert_eq!(
            export_selected_run_in_data(&data, &ctx, visible_id)
                .unwrap()
                .id,
            visible_id
        );
    }

    #[test]
    fn export_payload_to_csv_includes_expected_record_rows() {
        let payload = json!({
            "organizations": [{"id": "org", "name": "Org"}],
            "projects": [{"id": "project", "org_id": "org", "name": "Demo"}],
            "runs": [{"id": "run-1", "org_id": "org", "project_id": "project", "name": "run, one", "status": "finished"}],
            "metrics": [{"org_id": "org", "run_id": "run-1", "key": "loss", "step": 1, "value": 0.5, "created_at": "2026-05-31T00:00:00Z"}],
            "metric_series": [],
            "attributes": [],
            "artifacts": [],
            "table_object_rows": [],
            "imports": []
        });
        let csv = export_payload_to_csv(&payload).unwrap();
        assert!(csv.starts_with("record_type,org_id,project_id,run_id"));
        assert!(csv.contains("organization,"));
        assert!(csv.contains("\"run, one\""));
        assert!(csv.contains("metric,org,,run-1"));
    }

    #[test]
    fn export_import_rows_keeps_only_exported_run_ids() {
        let org_id = Uuid::new_v4();
        let selected_run_id = Uuid::new_v4();
        let hidden_run_id = Uuid::new_v4();
        let other_org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        data.imports.insert(
            (org_id, 1),
            ImportRow {
                id: 1,
                org_id,
                project_id: None,
                source_type: "wandb_json".to_string(),
                source_project: None,
                target_project: None,
                schema_version: 1,
                status: "completed".to_string(),
                dedupe_policy: "legacy".to_string(),
                summary: json!({ "runs": 2 }),
                warnings: Vec::new(),
                error_summary: None,
                progress: json!({ "state": "completed" }),
                run_ids: vec![selected_run_id, hidden_run_id],
                chunk_ids: Vec::new(),
                accepted_chunk_count: 0,
                committed_batch_count: 0,
                created_by_user_id: None,
                updated_at: Some(Utc::now()),
                created_at: Utc::now(),
                completed_at: Some(Utc::now()),
            },
        );
        data.imports.insert(
            (other_org_id, 2),
            ImportRow {
                id: 2,
                org_id: other_org_id,
                project_id: None,
                source_type: "wandb_json".to_string(),
                source_project: None,
                target_project: None,
                schema_version: 1,
                status: "completed".to_string(),
                dedupe_policy: "legacy".to_string(),
                summary: json!({ "runs": 1 }),
                warnings: Vec::new(),
                error_summary: None,
                progress: json!({ "state": "completed" }),
                run_ids: vec![selected_run_id],
                chunk_ids: Vec::new(),
                accepted_chunk_count: 0,
                committed_batch_count: 0,
                created_by_user_id: None,
                updated_at: Some(Utc::now()),
                created_at: Utc::now(),
                completed_at: Some(Utc::now()),
            },
        );
        let selected = BTreeSet::from([selected_run_id]);

        let imports = export_import_rows(&data, org_id, &selected);

        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].run_ids, vec![selected_run_id]);
    }

    fn test_run(org_id: Uuid, project_id: Uuid, name: &str) -> RunRow {
        let now = Utc::now();
        RunRow {
            id: Uuid::new_v4(),
            org_id,
            project_id,
            project: "project".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: Vec::new(),
            metadata: json!({}),
            created_at: now,
            started_at: now,
            finished_at: Some(now),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        }
    }
}
