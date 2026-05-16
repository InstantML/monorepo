use super::*;

pub(super) fn validate_scopes<'a>(
    scopes: impl IntoIterator<Item = &'a str>,
) -> AppResult<Vec<String>> {
    let values = scopes.into_iter().map(str::to_string).collect::<Vec<_>>();
    for scope in &values {
        if !ALLOWED_SCOPES.contains(&scope.as_str()) {
            return Err(AppError::validation(format!(
                "unsupported API key scope: {scope}"
            )));
        }
    }
    Ok(values)
}

pub(super) fn resolve_key_project(
    data: &StoreData,
    org_id: Uuid,
    project_id: Option<Uuid>,
    project_name: Option<&str>,
) -> AppResult<Option<Uuid>> {
    if let Some(id) = project_id {
        let project = data
            .projects
            .get(&id)
            .ok_or_else(|| AppError::not_found("project not found"))?;
        if project.org_id != org_id {
            return Err(AppError::not_found("project not found"));
        }
        if let Some(name) = project_name {
            let name = validate_name(Some(name), "project")?;
            if project.name != name {
                return Err(AppError::validation(
                    "project_id and project must refer to the same project",
                ));
            }
        }
        return Ok(Some(id));
    }
    if let Some(name) = project_name {
        let name = validate_name(Some(name), "project")?;
        return data
            .projects_by_org_name
            .get(&(org_id, name))
            .copied()
            .map(Some)
            .ok_or_else(|| AppError::not_found("project not found"));
    }
    Ok(None)
}

pub(super) fn validate_metrics(value: Value) -> AppResult<BTreeMap<String, f64>> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::validation("metrics must be an object"))?;
    if object.len() > MAX_METRICS_PER_BATCH {
        return Err(AppError::validation(format!(
            "metrics must include at most {MAX_METRICS_PER_BATCH} keys"
        )));
    }
    let mut metrics = BTreeMap::new();
    for (key, value) in object {
        let key = validate_name(Some(key), "metric key")?;
        let value = value
            .as_f64()
            .ok_or_else(|| AppError::validation("metric values must be finite numbers"))?;
        metrics.insert(key, validate_metric_value(value)?);
    }
    if metrics.is_empty() {
        return Err(AppError::validation(
            "metrics must include at least one key",
        ));
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

pub(super) fn normalize_attribute_inputs(
    input: CreateAttributesRequest,
) -> AppResult<Vec<AttributeInput>> {
    if let Some(attributes) = input.attributes {
        return Ok(attributes);
    }
    Ok(vec![AttributeInput {
        path: input
            .path
            .ok_or_else(|| AppError::validation("path is required"))?,
        kind: input
            .kind
            .ok_or_else(|| AppError::validation("type is required"))?,
        step: input.step,
        timestamp: input.timestamp,
        value: input
            .value
            .ok_or_else(|| AppError::validation("value is required"))?,
        summary: input.summary,
        artifact_id: None,
    }])
}

pub(super) fn attribute_from_input(
    data: &mut StoreData,
    org_id: Uuid,
    run_id: Uuid,
    input: AttributeInput,
) -> AppResult<AttributeRow> {
    let kind = validate_attribute_type(&input.kind)?;
    if let Some(artifact_id) = input.artifact_id {
        let artifact = data.artifacts.get(&artifact_id).ok_or_else(|| {
            AppError::validation("artifact_id must reference an artifact on the same run")
        })?;
        if artifact.org_id != org_id || artifact.run_id != run_id {
            return Err(AppError::validation(
                "artifact_id must reference an artifact on the same run",
            ));
        }
    }
    let row = AttributeRow {
        id: data.allocate_attribute_id(org_id),
        org_id,
        run_id,
        path: validate_name(Some(&input.path), "attribute path")?,
        kind,
        step: validate_optional_step(input.step.as_ref(), "step")?,
        logged_at: Some(validate_timestamp(input.timestamp.as_deref())?),
        value: input.value,
        summary: validate_json_object(input.summary, "summary")?,
        artifact_id: input.artifact_id,
        created_at: Utc::now(),
    };
    Ok(row)
}

pub(super) fn validate_attribute_type(kind: &str) -> AppResult<String> {
    let value = validate_name(Some(kind), "type")?;
    if matches!(
        value.as_str(),
        "config"
            | "float_series"
            | "string_series"
            | "file"
            | "file_series"
            | "histogram_series"
            | "tag"
    ) {
        Ok(value)
    } else {
        Err(AppError::validation("unsupported attribute type"))
    }
}

pub(super) fn normalize_object_kind(kind: &str) -> AppResult<String> {
    let kind = validate_name(Some(kind), "kind")?;
    match kind.as_str() {
        "histogram" => Ok("histogram_series".to_string()),
        "table" | "image" | "video" | "audio" => Ok(kind),
        _ => Err(AppError::validation("unsupported object kind")),
    }
}

pub(super) fn validate_json_size(value: &Value, field: &str, max: usize) -> AppResult<()> {
    let size = serde_json::to_vec(value)
        .map_err(|_| AppError::validation(format!("{field} must be valid JSON")))?
        .len();
    if size > max {
        Err(AppError::validation(format!("{field} is too large")))
    } else {
        Ok(())
    }
}

pub(super) fn validate_table_rows(rows: &[Value]) -> AppResult<()> {
    if rows.len() > MAX_TABLE_ROWS_PER_CREATE {
        return Err(AppError::validation(
            "table rows exceed the per-object limit",
        ));
    }
    for row in rows {
        if !row.is_object() {
            return Err(AppError::validation("table rows must be objects"));
        }
        if row.as_object().map(|object| object.len()).unwrap_or(0) > MAX_TABLE_COLUMNS {
            return Err(AppError::validation("table row has too many columns"));
        }
        validate_json_size(row, "table row", MAX_TABLE_ROW_BYTES)?;
    }
    Ok(())
}

pub(super) fn validate_histogram_value(value: &Value) -> AppResult<()> {
    let bins = value
        .get("bins")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("histogram value must include bins"))?;
    if bins.len() > MAX_HISTOGRAM_BINS {
        return Err(AppError::validation("histogram has too many bins"));
    }
    Ok(())
}

pub(super) fn table_summary(mut summary: Value, rows: &[Value]) -> AppResult<Value> {
    let object = summary
        .as_object_mut()
        .ok_or_else(|| AppError::validation("summary must be an object"))?;
    object.entry("row_count").or_insert(json!(rows.len()));
    if !object.contains_key("columns") {
        let columns = rows
            .first()
            .and_then(Value::as_object)
            .map(|row| {
                row.keys()
                    .take(MAX_TABLE_COLUMNS)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        object.insert("columns".to_string(), json!(columns));
    }
    Ok(summary)
}

pub(super) fn media_summary(mut summary: Value, artifact: &ArtifactRow) -> Value {
    if let Some(object) = summary.as_object_mut() {
        object.insert("artifact_name".to_string(), json!(artifact.name));
        object.insert("artifact_uri".to_string(), json!(artifact.uri));
        object.insert("mime_type".to_string(), json!(artifact.mime_type));
        object.insert("size_bytes".to_string(), json!(artifact.size_bytes));
    }
    summary
}

pub(super) fn validate_artifact_type(kind: &str) -> AppResult<String> {
    let value = validate_name(Some(kind), "artifact type")?;
    if matches!(value.as_str(), "checkpoint" | "rollout" | "file") {
        Ok(value)
    } else {
        Err(AppError::validation(
            "artifact type must be one of: checkpoint, file, rollout",
        ))
    }
}

pub(super) fn validate_size_bytes(value: &Value) -> AppResult<i64> {
    let size = value
        .as_i64()
        .ok_or_else(|| AppError::validation("size_bytes must be a nonnegative integer"))?;
    if size < 0 {
        Err(AppError::validation(
            "size_bytes must be a nonnegative integer",
        ))
    } else {
        Ok(size)
    }
}

pub(super) fn attribute_value(row: &AttributeRow) -> Value {
    json!({
        "id": row.id,
        "org_id": row.org_id,
        "run_id": row.run_id,
        "path": row.path,
        "type": row.kind,
        "step": row.step,
        "logged_at": row.logged_at,
        "value": row.value,
        "summary": row.summary,
        "artifact_id": row.artifact_id,
        "created_at": row.created_at
    })
}

pub(super) fn object_value(data: &StoreData, row: &AttributeRow) -> Value {
    let kind = if row.kind == "histogram_series" {
        "histogram"
    } else {
        row.kind.as_str()
    };
    let metadata = row
        .value
        .get("metadata")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let artifact = row
        .artifact_id
        .and_then(|id| data.artifacts.get(&id))
        .map(|artifact| {
            json!({
                "id": artifact.id,
                "name": artifact.name,
                "uri": artifact.uri,
                "mime_type": artifact.mime_type,
                "size_bytes": artifact.size_bytes
            })
        });
    json!({
        "id": row.id,
        "org_id": row.org_id,
        "run_id": row.run_id,
        "key": row.path,
        "kind": kind,
        "step": row.step,
        "value": row.value,
        "metadata": metadata,
        "summary": row.summary,
        "artifact_id": row.artifact_id,
        "artifact": artifact,
        "created_at": row.created_at
    })
}

pub(super) fn json_time(value: &Value) -> String {
    value
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub(super) fn json_step(value: &Value) -> f64 {
    value.get("step").and_then(Value::as_f64).unwrap_or(-1.0)
}

pub(super) fn json_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub(super) fn query_step(query: &HashMap<String, String>, key: &str) -> AppResult<Option<f64>> {
    query
        .get(key)
        .map(|raw| validate_query_step(raw, key))
        .transpose()
}

pub(super) fn validate_query_step(raw: &str, field: &str) -> AppResult<f64> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| AppError::validation(format!("{field} must be a nonnegative number")))?;
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(AppError::validation(format!(
            "{field} must be a nonnegative number"
        )))
    }
}

pub(super) fn datetime_from_micros(micros: i64) -> DateTime<Utc> {
    let secs = micros.div_euclid(1_000_000);
    let nanos = (micros.rem_euclid(1_000_000) as u32) * 1_000;
    DateTime::<Utc>::from_timestamp(secs, nanos).unwrap_or_else(epoch)
}

pub(super) fn run_search_text(run: &RunRow) -> String {
    format!(
        "{} {} {} {}",
        run.name,
        run.tags.join(" "),
        run.config,
        run.metadata
    )
    .to_ascii_lowercase()
}

pub(super) fn parse_run_ids(raw: Option<&String>) -> AppResult<Vec<Uuid>> {
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

pub(super) fn slugify(value: &str) -> String {
    let mut slug = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "workspace".to_string()
    } else {
        slug.chars().take(63).collect()
    }
}

#[cfg(test)]
pub(super) fn unique_slug(data: &StoreData, base: &str) -> String {
    if !data.orgs_by_slug.contains_key(base) {
        return base.to_string();
    }
    for index in 2..10_000 {
        let candidate = format!("{base}-{index}");
        if !data.orgs_by_slug.contains_key(&candidate) {
            return candidate;
        }
    }
    format!("{}-{}", base, Uuid::new_v4().simple())
}

pub(super) fn epoch() -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(0, 0).unwrap_or_else(Utc::now)
}

pub(super) fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: Uuid, org_id: Uuid, name: &str) -> ProjectRow {
        ProjectRow {
            id,
            org_id,
            name: name.to_string(),
            description: None,
            created_at: epoch(),
        }
    }

    fn run(id: Uuid, org_id: Uuid, project_id: Uuid, name: &str) -> RunRow {
        RunRow {
            id,
            org_id,
            project_id,
            project: "demo".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({"lr": 0.1}),
            tags: vec!["baseline".to_string()],
            metadata: json!({"notes": "useful"}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: Some(epoch() + ChronoDuration::seconds(5)),
        }
    }

    #[test]
    fn slugify_and_unique_slug_keep_workspace_names_stable() {
        assert_eq!(slugify("  My Fancy Workspace! "), "my-fancy-workspace");
        assert_eq!(slugify("!!!"), "workspace");

        let mut data = StoreData::default();
        let org = OrganizationRow {
            id: Uuid::from_u128(10),
            slug: "team".to_string(),
            name: "Team".to_string(),
            plan_tier: "free".to_string(),
            account_type: "customer".to_string(),
            seat_limit: 1,
            created_by_user_id: None,
            created_at: epoch(),
        };
        data.insert_org(org);

        assert_eq!(unique_slug(&data, "new-team"), "new-team");
        assert_eq!(unique_slug(&data, "team"), "team-2");
    }

    #[test]
    fn parse_run_ids_trims_values_and_rejects_empty_or_invalid_lists() {
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let raw = format!(" {first},,{second} ");

        assert_eq!(parse_run_ids(Some(&raw)).unwrap(), vec![first, second]);
        assert!(parse_run_ids(None).is_err());
        assert!(parse_run_ids(Some(&"not-a-uuid".to_string())).is_err());
        assert!(parse_run_ids(Some(&",".to_string())).is_err());
    }

    #[test]
    fn validate_metrics_requires_non_empty_finite_numeric_map() {
        let metrics = validate_metrics(json!({"loss": 1.25, "acc": 0.9})).unwrap();
        assert_eq!(metrics.get("loss"), Some(&1.25));
        assert!(validate_metrics(json!({})).is_err());
        assert!(validate_metrics(json!({"loss": "bad"})).is_err());
        assert!(validate_metric_value(f64::NAN).is_err());
    }

    #[test]
    fn apply_project_delete_removes_project_runs_attributes_artifacts_and_rows() {
        let org_id = Uuid::from_u128(1);
        let project_id = Uuid::from_u128(2);
        let run_id = Uuid::from_u128(3);
        let artifact_id = Uuid::from_u128(4);
        let mut data = StoreData::default();
        data.insert_project(project(project_id, org_id, "demo"));
        data.insert_run(run(run_id, org_id, project_id, "demo-run"));
        data.insert_attribute(AttributeRow {
            id: 7,
            org_id,
            run_id,
            path: "samples".to_string(),
            kind: "table".to_string(),
            step: Some(1.0),
            logged_at: Some(epoch()),
            value: json!({}),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch(),
        });
        data.table_rows.insert(
            (org_id, 7),
            vec![TableObjectRow {
                row_index: 0,
                row: json!({"prompt": "hi"}),
                created_at: epoch(),
            }],
        );
        data.insert_artifact(ArtifactRow {
            id: artifact_id,
            org_id,
            run_id,
            kind: "file".to_string(),
            name: "metrics.json".to_string(),
            uri: "demo://metrics.json".to_string(),
            step: None,
            size_bytes: Some(20),
            sha256: None,
            mime_type: None,
            storage_backend: "external".to_string(),
            storage_key: None,
            storage_path: None,
            metadata: json!({}),
            created_at: epoch(),
        });

        data.apply_project_delete(ProjectDeleteRecord {
            org_id,
            project_name: "demo".to_string(),
        });

        assert!(!data.projects.contains_key(&project_id));
        assert!(!data.runs.contains_key(&run_id));
        assert!(!data.attributes.contains_key(&(org_id, 7)));
        assert!(!data.table_rows.contains_key(&(org_id, 7)));
        assert!(!data.artifacts.contains_key(&artifact_id));
    }

    #[test]
    fn resolve_key_project_rejects_cross_org_or_mismatched_project_names() {
        let org_id = Uuid::from_u128(1);
        let other_org_id = Uuid::from_u128(2);
        let project_id = Uuid::from_u128(3);
        let other_project_id = Uuid::from_u128(4);
        let mut data = StoreData::default();
        data.insert_project(project(project_id, org_id, "alpha"));
        data.insert_project(project(other_project_id, other_org_id, "alpha"));

        assert_eq!(
            resolve_key_project(&data, org_id, Some(project_id), Some("alpha")).unwrap(),
            Some(project_id)
        );
        assert!(resolve_key_project(&data, org_id, Some(project_id), Some("beta")).is_err());
        assert!(resolve_key_project(&data, org_id, Some(other_project_id), None).is_err());
        assert_eq!(
            resolve_key_project(&data, org_id, None, Some("alpha")).unwrap(),
            Some(project_id)
        );
    }

    #[test]
    fn attribute_from_input_requires_same_run_artifact() {
        let org_id = Uuid::from_u128(1);
        let run_id = Uuid::from_u128(2);
        let other_run_id = Uuid::from_u128(3);
        let artifact_id = Uuid::from_u128(4);
        let mut data = StoreData::default();
        data.insert_artifact(ArtifactRow {
            id: artifact_id,
            org_id,
            run_id: other_run_id,
            kind: "file".to_string(),
            name: "out.json".to_string(),
            uri: "demo://out.json".to_string(),
            step: None,
            size_bytes: None,
            sha256: None,
            mime_type: None,
            storage_backend: "external".to_string(),
            storage_key: None,
            storage_path: None,
            metadata: json!({}),
            created_at: epoch(),
        });

        let input = AttributeInput {
            path: "report".to_string(),
            kind: "file".to_string(),
            step: None,
            timestamp: None,
            value: json!("demo://out.json"),
            summary: None,
            artifact_id: Some(artifact_id),
        };

        assert!(attribute_from_input(&mut data, org_id, run_id, input).is_err());
    }

    #[test]
    fn table_and_histogram_validation_cover_object_limits_and_summaries() {
        let rows = vec![json!({"a": 1, "b": 2})];
        assert!(validate_table_rows(&rows).is_ok());
        assert_eq!(
            table_summary(json!({}), &rows).unwrap(),
            json!({"row_count": 1, "columns": ["a", "b"]})
        );
        assert!(validate_table_rows(&[json!(["not", "object"])]).is_err());
        assert!(validate_histogram_value(&json!({"bins": [0, 1], "counts": [3]})).is_ok());
        assert!(validate_histogram_value(&json!({"counts": [3]})).is_err());
    }

    #[test]
    fn series_row_from_aggregate_computes_mean_variance_and_best_values() {
        let row = series_row_from_aggregate(SeriesReadRow {
            run_id: Uuid::from_u128(1),
            key: "reward".to_string(),
            count: 2,
            min: 1.0,
            max: 3.0,
            sum: 4.0,
            sum_sq: 10.0,
            latest: 3.0,
            latest_step: 2.0,
            best_step: 2.0,
        });

        assert_eq!(row.count, 2);
        assert_eq!(row.mean, Some(2.0));
        assert_eq!(row.variance, Some(1.0));
        assert_eq!(row.best, Some(3.0));
        assert_eq!(row.best_step, Some(2.0));
    }

    #[test]
    fn run_access_checks_org_and_project_scope() {
        let org_id = Uuid::from_u128(1);
        let project_id = Uuid::from_u128(2);
        let run = run(Uuid::from_u128(3), org_id, project_id, "scoped");
        let unrestricted = RequestContext {
            org_id,
            auth: None,
            session: None,
        };
        let restricted = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(4),
                service_account_id: Uuid::from_u128(5),
                project_id: Some(project_id),
                scopes: vec![],
            }),
            session: None,
        };
        let wrong_project = RequestContext {
            org_id,
            auth: Some(AuthContext {
                org_id,
                api_key_id: Uuid::from_u128(6),
                service_account_id: Uuid::from_u128(7),
                project_id: Some(Uuid::from_u128(8)),
                scopes: vec![],
            }),
            session: None,
        };

        assert!(ensure_run_access_in_data(&unrestricted, &run).is_ok());
        assert!(ensure_run_access_in_data(&restricted, &run).is_ok());
        assert!(ensure_run_access_in_data(&wrong_project, &run).is_err());
        assert!(ensure_unrestricted_org_key(&restricted).is_err());
    }
}
