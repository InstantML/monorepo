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
                    .filter_map(|id| data.attributes.get(id).cloned()),
            );
            runs.push(run);
        }
        (runs, attributes)
    };
    let series = metric_series_for_runs_limited(
        store.metric_store(),
        ctx.org_id,
        &run_ids,
        MAX_SIDE_BY_SIDE_ROWS as i64 + 1,
    )
    .await?;
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
    let rows = paths
        .into_iter()
        .take(MAX_SIDE_BY_SIDE_ROWS)
        .filter_map(|path| {
            let mut values = Map::new();
            for run in &runs {
                values.insert(
                    run.id.to_string(),
                    values_by_run[&run.id].get(&path).cloned().unwrap_or(Value::Null),
                );
            }
            let different = values
                .values()
                .map(|value| serde_json::to_string(value).unwrap_or_default())
                .collect::<BTreeSet<_>>()
                .len()
                > 1;
            if diff_only && !different {
                return None;
            }
            let reference = reference_run_id
                .and_then(|id| values.get(&id.to_string()).cloned())
                .unwrap_or(Value::Null);
            Some(json!({ "path": path, "values": values, "reference_run_id": reference_run_id, "reference": reference, "different": different }))
        })
        .collect::<Vec<_>>();
    Ok(
        json!({ "runs": runs, "reference_run_id": reference_run_id, "rows": rows, "truncated": false }),
    )
}

pub async fn export_data(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    if let Some(auth) = &ctx.auth {
        auth.require_scope("export:read")?;
    }
    let runs = filtered_runs(store, ctx, query).await?;
    let total_runs = runs.len();
    let selected = runs.into_iter().take(MAX_EXPORT_RUNS).collect::<Vec<_>>();
    let run_ids = selected.iter().map(|run| run.id).collect::<Vec<_>>();
    let metrics = metric_point_values_for_runs(store.metric_store(), ctx.org_id, &run_ids).await?;
    let metric_series =
        metric_series_values_for_runs(store.metric_store(), ctx.org_id, &run_ids).await?;
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
    let mut attributes = run_ids
        .iter()
        .flat_map(|run_id| data.attributes_by_run.get(run_id).into_iter().flatten())
        .filter_map(|id| data.attributes.get(id))
        .map(attribute_value)
        .collect::<Vec<_>>();
    let attributes_truncated = attributes.len() > MAX_EXPORT_ATTRIBUTES;
    attributes.truncate(MAX_EXPORT_ATTRIBUTES);
    let mut artifacts = run_ids
        .iter()
        .flat_map(|run_id| data.artifacts_by_run.get(run_id).into_iter().flatten())
        .filter_map(|id| data.artifacts.get(id))
        .cloned()
        .collect::<Vec<_>>();
    let artifacts_truncated = artifacts.len() > MAX_EXPORT_ARTIFACTS;
    artifacts.truncate(MAX_EXPORT_ARTIFACTS);
    let mut table_object_rows = data
        .attributes
        .values()
        .filter(|attribute| run_id_set.contains(&attribute.run_id))
        .flat_map(|attribute| {
            data.table_rows
                .get(&attribute.id)
                .into_iter()
                .flatten()
                .map(move |row| {
                    json!({
                        "org_id": ctx.org_id,
                        "run_id": attribute.run_id,
                        "attribute_id": attribute.id,
                        "row_index": row.row_index,
                        "row": row.row.clone(),
                        "created_at": row.created_at
                    })
                })
        })
        .collect::<Vec<_>>();
    let table_object_rows_truncated = table_object_rows.len() > MAX_EXPORT_TABLE_OBJECT_ROWS;
    table_object_rows.truncate(MAX_EXPORT_TABLE_OBJECT_ROWS);
    let mut imports = data
        .imports
        .values()
        .filter(|row| row.org_id == ctx.org_id)
        .filter(|row| row.run_ids.iter().any(|id| run_id_set.contains(id)))
        .cloned()
        .collect::<Vec<_>>();
    imports.sort_by_key(|row| std::cmp::Reverse(row.created_at));
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
            "metrics": MAX_EXPORT_METRICS,
            "attributes": MAX_EXPORT_ATTRIBUTES,
            "artifacts": MAX_EXPORT_ARTIFACTS,
            "table_object_rows": MAX_EXPORT_TABLE_OBJECT_ROWS,
            "imports": MAX_IMPORT_LIST
        },
        "truncated": total_runs > run_ids.len()
            || metrics.len() as i64 >= MAX_EXPORT_METRICS
            || attributes_truncated
            || artifacts_truncated
            || table_object_rows_truncated
    }))
}
