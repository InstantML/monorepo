use super::*;

use std::cmp::Ordering;

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

const DEFAULT_OBJECT_EXPLORER_LIMIT: usize = 50;
const MAX_OBJECT_EXPLORER_LIMIT: usize = 100;
const OBJECT_EXPLORER_TEXT_PREVIEW_BYTES: usize = 2_000;
const OBJECT_EXPLORER_KEY_MAX_BYTES: usize = 128;

#[derive(Debug, Clone)]
struct ObjectExplorerCandidate {
    row: AttributeRow,
    run: RunRow,
}

#[derive(Debug, Serialize, Deserialize)]
struct ObjectExplorerCursor {
    v: i32,
    step: Option<f64>,
    created_at: DateTime<Utc>,
    id: i64,
}

pub async fn create_attributes(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateAttributesRequest,
) -> AppResult<Vec<Value>> {
    ensure_billing_write_allowed(store, ctx.org_id, "create attributes").await?;
    let items = normalize_attribute_inputs(input)?;
    let mut created = Vec::new();
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    for item in items {
        if matches!(item.kind.as_str(), "table" | "image" | "video" | "audio") {
            return Err(AppError::validation(
                "rich object types must use /api/runs/:run_id/objects",
            ));
        }
        let attribute = attribute_from_input(&mut data, ctx.org_id, run_id, item)?;
        store
            .persist_locked(
                "attribute",
                ctx.org_id,
                &attribute.id.to_string(),
                &attribute,
            )
            .await?;
        data.insert_attribute(attribute.clone());
        created.push(attribute_value(&attribute));
    }
    Ok(created)
}

pub async fn list_attributes(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<Value>> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_METRIC_LIMIT,
        MAX_METRIC_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let kind = query
        .get("type")
        .map(|value| validate_name(Some(value), "attribute type"))
        .transpose()?;
    let path_prefix = query
        .get("path_prefix")
        .map(|value| validate_name(Some(value), "path_prefix"))
        .transpose()?;
    let mut rows = data
        .attributes_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.attributes.get(&(ctx.org_id, *id)))
        .filter(|row| row.run_id == run_id)
        .filter(|row| {
            kind.as_ref()
                .map(|value| row.kind == *value)
                .unwrap_or(true)
        })
        .filter(|row| {
            path_prefix
                .as_ref()
                .map(|value| row.path.starts_with(value))
                .unwrap_or(true)
        })
        .map(attribute_value)
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        json_step(a)
            .total_cmp(&json_step(b))
            .then_with(|| json_i64(a, "id").cmp(&json_i64(b, "id")))
    });
    rows = rows.into_iter().skip(offset).take(limit).collect();
    Ok(rows)
}

pub async fn create_object(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: CreateObjectRequest,
    idempotency_key: Option<String>,
) -> AppResult<Value> {
    let request_hash = hash_idempotency(run_id, &raw)?;
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
                        // Re-check run access before returning the cached body.
                        ensure_run_visible_in_data(&data, ctx, run_id)?;
                        return Ok(existing.response_json.clone());
                    }
                    return Err(AppError::conflict(
                        "idempotency key was already used with a different request body",
                    ));
                }
            }
            let object = create_object_inner(store, ctx, run_id, input).await?;
            let record = IdempotencyRecord {
                org_id: ctx.org_id,
                key: key.clone(),
                request_hash,
                response_json: object.clone(),
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
            Ok(object)
        }
        .await;
        store.release_idempotency_key(ctx.org_id, &key).await;
        return result;
    }
    create_object_inner(store, ctx, run_id, input).await
}

async fn create_object_inner(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateObjectRequest,
) -> AppResult<Value> {
    ensure_billing_write_allowed(store, ctx.org_id, "create objects").await?;
    let key = validate_name(input.key.as_deref(), "object key")?;
    let requested_kind = validate_name(input.kind.as_deref(), "object kind")?;
    let kind = normalize_object_kind(&requested_kind)?;
    let is_table = kind == "table";
    let mut step = validate_optional_step(input.step.as_ref(), "step")?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    validate_json_size(&metadata, "metadata", MAX_OBJECT_METADATA_BYTES)?;
    let mut summary = validate_json_object(input.summary, "summary")?;
    validate_json_size(&summary, "summary", MAX_OBJECT_SUMMARY_BYTES)?;
    let mut value = input
        .value
        .unwrap_or_else(|| json!({ "kind": requested_kind, "metadata": metadata.clone() }));
    validate_json_size(&value, "object value", MAX_OBJECT_VALUE_BYTES)?;
    let rows = input.rows.unwrap_or_default();
    if is_table {
        validate_table_rows(&rows)?;
    } else if !rows.is_empty() {
        return Err(AppError::validation(format!(
            "rows are only accepted for table objects, not {requested_kind}"
        )));
    }
    if kind == "histogram_series" {
        validate_histogram_value(&value)?;
    } else if kind == "classification_eval" {
        validate_classification_eval_value(&value)?;
    }
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let mut artifact_id = input.artifact_id;
    if matches!(kind.as_str(), "image" | "video" | "audio") {
        let id = artifact_id
            .ok_or_else(|| AppError::validation("artifact_id is required for media objects"))?;
        let artifact = data
            .artifacts
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::not_found("artifact not found"))?;
        if artifact.org_id != ctx.org_id || artifact.run_id != run_id {
            return Err(AppError::validation("artifact must belong to the same run"));
        }
        step = step.or(artifact.step);
        value = json!({
            "kind": requested_kind,
            "uri": artifact.uri,
            "metadata": metadata
        });
        summary = media_summary(summary, &artifact);
        artifact_id = Some(artifact.id);
    } else if let Some(id) = artifact_id {
        let artifact = data
            .artifacts
            .get(&id)
            .ok_or_else(|| AppError::not_found("artifact not found"))?;
        if artifact.org_id != ctx.org_id || artifact.run_id != run_id {
            return Err(AppError::validation("artifact must belong to the same run"));
        }
        if kind == "histogram_series" {
            artifact_id = None;
        }
    }
    let attribute = AttributeRow {
        id: data.allocate_attribute_id(ctx.org_id),
        org_id: ctx.org_id,
        run_id,
        path: key,
        kind,
        step,
        logged_at: Some(Utc::now()),
        value,
        summary: if is_table {
            table_summary(summary, &rows)?
        } else {
            summary
        },
        artifact_id,
        created_at: Utc::now(),
    };
    let object = object_value(&data, &attribute);
    store
        .persist_locked(
            "attribute",
            ctx.org_id,
            &attribute.id.to_string(),
            &attribute,
        )
        .await?;
    data.insert_attribute(attribute.clone());
    if is_table && !rows.is_empty() {
        let rows_record = TableRowsRecord {
            attribute_id: attribute.id,
            rows: rows
                .into_iter()
                .enumerate()
                .map(|(index, row)| TableObjectRow {
                    row_index: index as i64,
                    row,
                    created_at: Utc::now(),
                })
                .collect(),
        };
        store
            .persist_locked(
                "table_rows",
                ctx.org_id,
                &attribute.id.to_string(),
                &rows_record,
            )
            .await?;
        data.table_rows
            .insert((ctx.org_id, rows_record.attribute_id), rows_record.rows);
    }
    Ok(object)
}

pub async fn list_objects(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_LIMIT,
        MAX_OBJECT_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let kind = query
        .get("kind")
        .map(|value| normalize_object_kind(value))
        .transpose()?;
    let key = query
        .get("key")
        .map(|value| validate_name(Some(value), "object key"))
        .transpose()?;
    let mut rows = data
        .attributes_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.attributes.get(&(ctx.org_id, *id)))
        .filter(|row| row.run_id == run_id)
        .filter(|row| {
            matches!(
                row.kind.as_str(),
                "table" | "image" | "video" | "audio" | "histogram_series" | "classification_eval"
            )
        })
        .filter(|row| {
            kind.as_ref()
                .map(|value| row.kind == *value)
                .unwrap_or(true)
        })
        .filter(|row| key.as_ref().map(|value| row.path == *value).unwrap_or(true))
        .map(|row| object_value(&data, row))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        super::runs::numeric_desc(Some(json_step(a)), Some(json_step(b)))
            .then_with(|| json_time(b).cmp(&json_time(a)))
            .then_with(|| json_i64(b, "id").cmp(&json_i64(a, "id")))
    });
    rows = rows.into_iter().skip(offset).take(limit).collect();
    Ok(json!({ "objects": rows, "limit": limit, "offset": offset }))
}

pub async fn list_objects_explorer(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let limit = validate_object_explorer_limit(query.get("limit").map(String::as_str))?;
    let kind = query
        .get("kind")
        .map(|value| normalize_explorer_kind_filter(value))
        .transpose()?;
    let key = validate_object_explorer_key(query.get("key").map(String::as_str))?;
    let run_id = query
        .get("run_id")
        .filter(|value| !value.trim().is_empty())
        .map(|value| parse_explorer_uuid(value, "run_id"))
        .transpose()?;
    let project_id = query
        .get("project_id")
        .filter(|value| !value.trim().is_empty())
        .map(|value| parse_explorer_uuid(value, "project_id"))
        .transpose()?;
    let from_step =
        validate_object_explorer_step(query.get("from_step").map(String::as_str), "from_step")?;
    let to_step =
        validate_object_explorer_step(query.get("to_step").map(String::as_str), "to_step")?;
    if let (Some(from), Some(to)) = (from_step, to_step) {
        if from > to {
            return Err(object_explorer_invalid(
                "from_step must be less than or equal to to_step",
            ));
        }
    }
    let cursor = query
        .get("cursor")
        .filter(|value| !value.trim().is_empty())
        .map(|value| decode_object_explorer_cursor(value))
        .transpose()?;

    let run_query = run_filter_query(query);
    let mut runs = filtered_runs(store, ctx, &run_query).await?;
    if let Some(project_id) = project_id {
        runs.retain(|run| run.project_id == project_id);
    }
    if let Some(run_id) = run_id {
        runs.retain(|run| run.id == run_id);
    }
    let run_by_id = runs
        .into_iter()
        .map(|run| (run.id, run))
        .collect::<HashMap<_, _>>();

    let data = store.data.lock().await;
    let explorer_page = object_explorer_page_from_index(
        &data,
        ctx,
        &run_by_id,
        &kind,
        &key,
        from_step,
        to_step,
        cursor.as_ref(),
        limit,
    );
    let page = explorer_page.candidates;
    let has_next = explorer_page.has_next;
    let next_cursor = if has_next {
        page.last()
            .map(encode_object_explorer_cursor)
            .transpose()?
            .map(Value::String)
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let objects = page
        .iter()
        .map(|candidate| object_explorer_value(&data, candidate))
        .collect::<Vec<_>>();
    Ok(json!({
        "objects": objects,
        "next_cursor": next_cursor,
        "limit": limit,
        "page_info": {
            "pagination": "cursor",
            "has_next_page": has_next
        }
    }))
}

struct ObjectExplorerPage {
    candidates: Vec<ObjectExplorerCandidate>,
    has_next: bool,
    #[allow(dead_code)]
    inspected_index_entries: usize,
}

#[allow(clippy::too_many_arguments)]
fn object_explorer_page_from_index(
    data: &StoreData,
    ctx: &RequestContext,
    run_by_id: &HashMap<Uuid, RunRow>,
    kind: &Option<String>,
    key: &Option<String>,
    from_step: Option<f64>,
    to_step: Option<f64>,
    cursor: Option<&ObjectExplorerCursor>,
    limit: usize,
) -> ObjectExplorerPage {
    let mut page = Vec::with_capacity(limit.saturating_add(1));
    let mut inspected_index_entries = 0;
    for index_key in data
        .object_attributes_by_org
        .get(&ctx.org_id)
        .into_iter()
        .flat_map(|keys| keys.iter())
    {
        inspected_index_entries += 1;
        let Some(row) = data.attributes.get(&(ctx.org_id, index_key.attribute_id)) else {
            continue;
        };
        let Some(run) = run_by_id.get(&row.run_id) else {
            continue;
        };
        let Some(row_kind) = explorer_kind_for_row(&row.kind) else {
            continue;
        };
        if kind
            .as_ref()
            .map(|value| row_kind != value)
            .unwrap_or(false)
        {
            continue;
        }
        if key
            .as_ref()
            .map(|value| !row.path.contains(value))
            .unwrap_or(false)
        {
            continue;
        }
        if !step_in_range(row.step, from_step, to_step) {
            continue;
        }
        let candidate = ObjectExplorerCandidate {
            row: row.clone(),
            run: run.clone(),
        };
        if cursor
            .as_ref()
            .map(|cursor| compare_candidate_to_cursor(&candidate, cursor) != Ordering::Greater)
            .unwrap_or(false)
        {
            continue;
        }
        page.push(candidate);
        if page.len() > limit {
            break;
        }
    }
    let has_next = page.len() > limit;
    if has_next {
        page.truncate(limit);
    }
    ObjectExplorerPage {
        candidates: page,
        has_next,
        inspected_index_entries,
    }
}

pub async fn list_object_rows(
    store: &Store,
    ctx: &RequestContext,
    object_id: i64,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    let data = store.data.lock().await;
    let object = data
        .attributes
        .get(&(ctx.org_id, object_id))
        .ok_or_else(|| AppError::not_found("object not found"))?;
    let run = fetch_run_in_data(&data, ctx, object.run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    if object.kind != "table" {
        return Err(AppError::validation(
            "object rows are only available for table objects",
        ));
    }
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_OBJECT_ROW_LIMIT,
        MAX_OBJECT_ROW_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let rows = data
        .table_rows
        .get(&(ctx.org_id, object_id))
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|row| {
            json!({
                "row_index": row.row_index,
                "row": row.row,
                "created_at": row.created_at
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "object_id": object_id, "rows": rows, "limit": limit, "offset": offset }))
}

fn run_filter_query(query: &HashMap<String, String>) -> HashMap<String, String> {
    ["project", "q"]
        .into_iter()
        .filter_map(|key| {
            query
                .get(key)
                .filter(|value| !value.trim().is_empty())
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect()
}

fn validate_object_explorer_limit(raw: Option<&str>) -> AppResult<usize> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(DEFAULT_OBJECT_EXPLORER_LIMIT);
    };
    let value = raw
        .trim()
        .parse::<usize>()
        .map_err(|_| object_explorer_invalid("limit must be a positive integer"))?;
    if value == 0 || value > MAX_OBJECT_EXPLORER_LIMIT {
        return Err(object_explorer_invalid(format!(
            "limit must be between 1 and {MAX_OBJECT_EXPLORER_LIMIT}"
        )));
    }
    Ok(value)
}

fn validate_object_explorer_key(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > OBJECT_EXPLORER_KEY_MAX_BYTES || value.chars().any(char::is_control) {
        return Err(object_explorer_invalid("key filter is invalid"));
    }
    Ok(Some(value.to_string()))
}

fn validate_object_explorer_step(raw: Option<&str>, field: &'static str) -> AppResult<Option<f64>> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = value
        .parse::<f64>()
        .map_err(|_| object_explorer_invalid(format!("{field} must be a finite number")))?;
    if !parsed.is_finite() {
        return Err(object_explorer_invalid(format!(
            "{field} must be a finite number"
        )));
    }
    Ok(Some(parsed))
}

fn parse_explorer_uuid(raw: &str, field: &'static str) -> AppResult<Uuid> {
    Uuid::parse_str(raw.trim())
        .map_err(|_| object_explorer_invalid(format!("{field} must be a UUID")))
}

fn normalize_explorer_kind_filter(raw: &str) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(object_explorer_invalid("kind must not be empty"));
    }
    if value == "text" {
        return Ok("text".to_string());
    }
    let normalized = normalize_object_kind(value)
        .map_err(|_| object_explorer_invalid("unsupported object kind"))?;
    Ok(if normalized == "histogram_series" {
        "histogram".to_string()
    } else {
        normalized
    })
}

fn object_explorer_invalid(message: impl Into<String>) -> AppError {
    AppError::with_code(StatusCode::BAD_REQUEST, "object_explorer_invalid", message)
}

fn explorer_kind_for_row(kind: &str) -> Option<&'static str> {
    match kind {
        "table" => Some("table"),
        "image" => Some("image"),
        "video" => Some("video"),
        "audio" => Some("audio"),
        "histogram_series" => Some("histogram"),
        "classification_eval" => Some("classification_eval"),
        "string_series" => Some("text"),
        _ => None,
    }
}

fn step_in_range(step: Option<f64>, from_step: Option<f64>, to_step: Option<f64>) -> bool {
    if from_step.is_none() && to_step.is_none() {
        return true;
    }
    let Some(step) = step else {
        return false;
    };
    from_step.map(|from| step >= from).unwrap_or(true)
        && to_step.map(|to| step <= to).unwrap_or(true)
}

#[cfg(test)]
fn compare_object_explorer_candidates(
    left: &ObjectExplorerCandidate,
    right: &ObjectExplorerCandidate,
) -> Ordering {
    compare_object_explorer_sort_tuple(
        left.row.step,
        left.row.created_at,
        left.row.id,
        right.row.step,
        right.row.created_at,
        right.row.id,
    )
}

fn compare_candidate_to_cursor(
    candidate: &ObjectExplorerCandidate,
    cursor: &ObjectExplorerCursor,
) -> Ordering {
    compare_object_explorer_sort_tuple(
        candidate.row.step,
        candidate.row.created_at,
        candidate.row.id,
        cursor.step,
        cursor.created_at,
        cursor.id,
    )
}

fn compare_object_explorer_sort_tuple(
    left_step: Option<f64>,
    left_created_at: DateTime<Utc>,
    left_id: i64,
    right_step: Option<f64>,
    right_created_at: DateTime<Utc>,
    right_id: i64,
) -> Ordering {
    match (left_step, right_step) {
        (Some(left), Some(right)) => right.total_cmp(&left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
    .then_with(|| right_created_at.cmp(&left_created_at))
    .then_with(|| right_id.cmp(&left_id))
}

fn encode_object_explorer_cursor(candidate: &ObjectExplorerCandidate) -> AppResult<String> {
    let cursor = ObjectExplorerCursor {
        v: 1,
        step: candidate.row.step,
        created_at: candidate.row.created_at,
        id: candidate.row.id,
    };
    let raw = serde_json::to_vec(&cursor)
        .map_err(|_| AppError::internal("object explorer cursor encoding failed"))?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn decode_object_explorer_cursor(raw: &str) -> AppResult<ObjectExplorerCursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.trim().as_bytes())
        .map_err(|_| object_explorer_invalid("cursor is invalid"))?;
    let cursor = serde_json::from_slice::<ObjectExplorerCursor>(&bytes)
        .map_err(|_| object_explorer_invalid("cursor is invalid"))?;
    if cursor.v != 1 {
        return Err(object_explorer_invalid("cursor is invalid"));
    }
    Ok(cursor)
}

fn object_explorer_value(data: &StoreData, candidate: &ObjectExplorerCandidate) -> Value {
    let row = &candidate.row;
    let kind = explorer_kind_for_row(&row.kind).unwrap_or("unknown");
    let metadata = row
        .value
        .get("metadata")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let artifact = row
        .artifact_id
        .and_then(|id| data.artifacts.get(&id))
        .filter(|artifact| artifact.org_id == row.org_id && artifact.run_id == row.run_id)
        .map(|artifact| {
            json!({
                "id": artifact.id,
                "name": artifact.name,
                "uri": artifact.public_uri(),
                "mime_type": artifact.mime_type,
                "size_bytes": artifact.size_bytes,
                "storage_backend": artifact.storage_backend
            })
        });
    let preview = object_explorer_preview(kind, &row.value);
    json!({
        "object_id": format!("attr:{}", row.id),
        "id": row.id,
        "run_id": row.run_id,
        "run_name": candidate.run.name,
        "project": candidate.run.project,
        "kind": kind,
        "key": row.path,
        "step": row.step,
        "created_at": row.created_at,
        "logged_at": row.logged_at,
        "summary": row.summary,
        "metadata": metadata,
        "preview": preview,
        "artifact_id": row.artifact_id,
        "artifact": artifact
    })
}

fn object_explorer_preview(kind: &str, value: &Value) -> Value {
    let mut preview = Map::new();
    if kind == "text" {
        let raw = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default());
        let (text, truncated) = truncate_utf8(&raw, OBJECT_EXPLORER_TEXT_PREVIEW_BYTES);
        preview.insert("text".to_string(), Value::String(text));
        preview.insert("truncated".to_string(), Value::Bool(truncated));
    } else {
        preview.insert("text".to_string(), Value::Null);
        preview.insert("truncated".to_string(), Value::Bool(false));
    }
    if kind == "histogram" {
        if let Some(histogram) = histogram_preview(value) {
            preview.insert("histogram".to_string(), histogram);
        }
    }
    if kind == "classification_eval" {
        if let Some(evaluation) = classification_eval_preview(value) {
            preview.insert("evaluation".to_string(), evaluation);
        }
    }
    Value::Object(preview)
}

fn histogram_preview(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let bins = object.get("bins").and_then(Value::as_array)?;
    let counts = object.get("counts").and_then(Value::as_array)?;
    let truncated = bins.len() > 65 || counts.len() > 64;
    Some(json!({
        "bins": bins.iter().take(65).cloned().collect::<Vec<_>>(),
        "counts": counts.iter().take(64).cloned().collect::<Vec<_>>(),
        "truncated": truncated
    }))
}

fn classification_eval_preview(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    Some(json!({
        "accuracy": object.get("accuracy").cloned().unwrap_or(Value::Null),
        "macro_f1": object.get("macro_f1").cloned().unwrap_or(Value::Null),
        "sample_count": object.get("sample_count").cloned().unwrap_or(Value::Null),
        "class_names": string_array_preview(object.get("class_names"), 2),
        "confusion_matrix": matrix_preview(object.get("confusion_matrix"), 2, 2),
        "per_class": record_array_preview(object.get("per_class"), 2),
        "predictions": record_array_preview(object.get("predictions"), 5),
        "pr_curve": record_array_preview(object.get("pr_curve"), 200),
        "roc_curve": record_array_preview(object.get("roc_curve"), 200),
    }))
}

fn string_array_preview(value: Option<&Value>, limit: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.as_str().is_some())
        .take(limit)
        .cloned()
        .collect()
}

fn record_array_preview(value: Option<&Value>, limit: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.is_object())
        .take(limit)
        .cloned()
        .collect()
}

fn matrix_preview(value: Option<&Value>, row_limit: usize, column_limit: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .take(row_limit)
        .map(|row| Value::Array(row.iter().take(column_limit).cloned().collect()))
        .collect()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

pub async fn create_artifact(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
) -> AppResult<ArtifactRow> {
    ensure_billing_write_allowed(store, ctx.org_id, "create an artifact").await?;
    let artifact = artifact_from_input(store, ctx, run_id, input, None, true).await?;
    Ok(artifact)
}

#[allow(clippy::too_many_arguments)]
pub async fn upload_artifact(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: UploadArtifactRequest,
    idempotency_key: Option<String>,
) -> AppResult<ArtifactRow> {
    let request_hash = hash_idempotency(run_id, &raw)?;
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
                        // Re-check run access before returning the cached body.
                        ensure_run_visible_in_data(&data, ctx, run_id)?;
                        return serde_json::from_value::<ArtifactRow>(
                            existing.response_json.clone(),
                        )
                        .map_err(|_| AppError::internal("stored idempotency response is invalid"));
                    }
                    return Err(AppError::conflict(
                        "idempotency key was already used with a different request body",
                    ));
                }
            }
            let artifact = upload_artifact_inner(store, config, ctx, run_id, input).await?;
            let record = IdempotencyRecord {
                org_id: ctx.org_id,
                key: key.clone(),
                request_hash,
                response_json: serde_json::to_value(&artifact)
                    .map_err(|_| AppError::internal("artifact response serialization failed"))?,
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
            Ok(artifact)
        }
        .await;
        store.release_idempotency_key(ctx.org_id, &key).await;
        return result;
    }
    upload_artifact_inner(store, config, ctx, run_id, input).await
}

async fn upload_artifact_inner(
    store: &Store,
    config: &AppConfig,
    ctx: &RequestContext,
    run_id: Uuid,
    input: UploadArtifactRequest,
) -> AppResult<ArtifactRow> {
    ensure_billing_write_allowed(store, ctx.org_id, "upload an artifact").await?;
    let name = validate_name(Some(input.name.as_str()), "artifact name")?;
    let artifact_id = Uuid::new_v4();
    let content = input.content_base64.as_str();
    if content.trim().is_empty() {
        return Err(AppError::validation("content_base64 is required"));
    }
    let prepared = prepare_base64_artifact(content)?;
    {
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        ensure_run_access_in_data(ctx, &run)?;
    }
    enforce_plan_capacity(
        store,
        ctx.org_id,
        UsageDelta {
            storage_bytes: prepared.size_bytes + ARTIFACT_METADATA_BYTES,
            ..UsageDelta::default()
        },
        "upload an artifact",
    )
    .await?;
    let size_bytes = prepared.size_bytes;
    let sha256 = prepared.sha256.clone();
    let artifact_store = ArtifactByteStore::for_upload(config)?;
    let stored = artifact_store
        .store_prepared(
            ctx.org_id,
            run_id,
            artifact_id,
            &name,
            input.mime_type.as_deref(),
            prepared,
        )
        .await?;
    let request = CreateArtifactRequest {
        kind: input.kind,
        name,
        uri: Some(stored.uri.clone()),
        step: input.step,
        size_bytes: Some(json!(size_bytes)),
        sha256: Some(sha256),
        mime_type: input.mime_type,
        metadata: input.metadata,
        path: input.path,
    };
    let artifact =
        match artifact_from_input(store, ctx, run_id, request, Some(stored.clone()), false).await {
            Ok(artifact) => artifact,
            Err(error) => {
                artifact_store.cleanup(&stored).await;
                return Err(error);
            }
        };
    Ok(artifact)
}

async fn artifact_from_input(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    input: CreateArtifactRequest,
    stored: Option<StoredArtifact>,
    enforce_capacity: bool,
) -> AppResult<ArtifactRow> {
    let name = validate_name(Some(input.name.as_str()), "artifact name")?;
    let kind = validate_artifact_type(input.kind.as_deref().unwrap_or("file"))?;
    let uri = validate_name(
        input
            .uri
            .as_deref()
            .or(input.path.as_deref())
            .or(Some(&name)),
        "artifact uri",
    )?;
    let step = validate_optional_step(input.step.as_ref(), "step")?;
    let size_bytes = input
        .size_bytes
        .as_ref()
        .map(validate_size_bytes)
        .transpose()?;
    let metadata = validate_json_object(input.metadata, "metadata")?;
    {
        let data = store.data.lock().await;
        let run = fetch_run_in_data(&data, ctx, run_id)?;
        ensure_run_access_in_data(ctx, &run)?;
    }
    if enforce_capacity {
        let stored_bytes = if stored.is_some() {
            size_bytes.unwrap_or(0)
        } else {
            0
        };
        enforce_plan_capacity(
            store,
            ctx.org_id,
            UsageDelta {
                storage_bytes: stored_bytes + ARTIFACT_METADATA_BYTES,
                ..UsageDelta::default()
            },
            "create an artifact",
        )
        .await?;
    }
    let mut data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let stored = stored.as_ref();
    let artifact = ArtifactRow {
        id: stored.map(|stored| stored.id).unwrap_or_else(Uuid::new_v4),
        org_id: ctx.org_id,
        run_id,
        kind,
        name: name.clone(),
        uri,
        step,
        size_bytes,
        sha256: input.sha256,
        mime_type: input
            .mime_type
            .or_else(|| mime_guess::from_path(&name).first_raw().map(str::to_string)),
        storage_backend: stored
            .map(|stored| stored.storage_backend.clone())
            .unwrap_or_else(|| "external".to_string()),
        storage_key: stored.map(|stored| stored.storage_key.clone()),
        storage_path: stored.and_then(|stored| stored.storage_path.clone()),
        metadata,
        created_at: Utc::now(),
    };
    store
        .persist_locked("artifact", ctx.org_id, &artifact.id.to_string(), &artifact)
        .await?;
    data.insert_artifact(artifact.clone());
    Ok(artifact)
}

pub async fn list_artifacts(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    query: &HashMap<String, String>,
) -> AppResult<Vec<ArtifactRow>> {
    let data = store.data.lock().await;
    let run = fetch_run_in_data(&data, ctx, run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_RUN_LIMIT,
        MAX_ARTIFACT_LIST,
    )? as usize;
    let mut rows = data
        .artifacts_by_run
        .get(&run_id)
        .into_iter()
        .flatten()
        .filter_map(|id| data.artifacts.get(id).cloned())
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| std::cmp::Reverse(row.created_at));
    rows.truncate(limit);
    Ok(rows)
}

pub async fn get_artifact_for_context(
    store: &Store,
    ctx: &RequestContext,
    artifact_id: Uuid,
) -> AppResult<ArtifactRow> {
    let data = store.data.lock().await;
    let artifact = data
        .artifacts
        .get(&artifact_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("artifact not found"))?;
    let run = fetch_run_in_data(&data, ctx, artifact.run_id)?;
    ensure_run_access_in_data(ctx, &run)?;
    Ok(artifact)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: u128, name: &str) -> RunRow {
        RunRow {
            id: Uuid::from_u128(id),
            org_id: Uuid::from_u128(1),
            project_id: Uuid::from_u128(2),
            project: "cartpole".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: vec![],
            metadata: json!({}),
            created_at: epoch(),
            started_at: epoch(),
            finished_at: Some(epoch()),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        }
    }

    fn attribute(
        id: i64,
        run_id: Uuid,
        kind: &str,
        step: Option<f64>,
        created_offset: i64,
    ) -> AttributeRow {
        AttributeRow {
            id,
            org_id: Uuid::from_u128(1),
            run_id,
            path: format!("eval/{kind}/{id}"),
            kind: kind.to_string(),
            step,
            logged_at: Some(epoch() + ChronoDuration::seconds(created_offset)),
            value: json!({"metadata": {"caption": id}, "bins": [0, 1], "counts": [id]}),
            summary: json!({}),
            artifact_id: None,
            created_at: epoch() + ChronoDuration::seconds(created_offset),
        }
    }

    #[test]
    fn object_explorer_cursor_uses_stable_sort_tuple() {
        let run = run(10, "seed-10");
        let mut rows = [
            ObjectExplorerCandidate {
                row: attribute(1, run.id, "image", Some(1.0), 1),
                run: run.clone(),
            },
            ObjectExplorerCandidate {
                row: attribute(2, run.id, "image", Some(3.0), 2),
                run: run.clone(),
            },
            ObjectExplorerCandidate {
                row: attribute(3, run.id, "image", None, 3),
                run: run.clone(),
            },
        ];
        rows.sort_by(compare_object_explorer_candidates);
        assert_eq!(
            rows.iter()
                .map(|candidate| candidate.row.id)
                .collect::<Vec<_>>(),
            vec![2, 1, 3]
        );

        let cursor =
            decode_object_explorer_cursor(&encode_object_explorer_cursor(&rows[0]).unwrap())
                .unwrap();
        let after = rows
            .iter()
            .filter(|candidate| {
                compare_candidate_to_cursor(candidate, &cursor) == Ordering::Greater
            })
            .map(|candidate| candidate.row.id)
            .collect::<Vec<_>>();
        assert_eq!(after, vec![1, 3]);
    }

    #[test]
    fn object_explorer_page_stops_after_limit_lookahead_for_broad_reads() {
        let ctx = RequestContext {
            org_id: Uuid::from_u128(1),
            auth: None,
            session: None,
        };
        let run = run(10, "seed-10");
        let mut data = StoreData::default();
        for id in 1..=150 {
            data.insert_attribute(attribute(id, run.id, "image", Some(id as f64), id));
        }
        let run_by_id = HashMap::from([(run.id, run)]);
        let page = object_explorer_page_from_index(
            &data, &ctx, &run_by_id, &None, &None, None, None, None, 20,
        );

        assert!(page.has_next);
        assert_eq!(page.inspected_index_entries, 21);
        assert_eq!(
            page.candidates
                .iter()
                .map(|candidate| candidate.row.id)
                .collect::<Vec<_>>(),
            (131..=150).rev().collect::<Vec<_>>()
        );
    }

    #[test]
    fn object_explorer_text_preview_is_bounded_on_utf8_boundary() {
        let long = format!(
            "{}{}",
            "a".repeat(OBJECT_EXPLORER_TEXT_PREVIEW_BYTES - 1),
            "é"
        );
        let preview = object_explorer_preview("text", &json!(long));
        assert_eq!(
            preview["text"].as_str().unwrap().len(),
            OBJECT_EXPLORER_TEXT_PREVIEW_BYTES - 1
        );
        assert_eq!(preview["truncated"], json!(true));
    }

    #[test]
    fn object_explorer_filter_validation_is_bounded() {
        assert_eq!(validate_object_explorer_limit(None).unwrap(), 50);
        assert!(validate_object_explorer_limit(Some("0")).is_err());
        assert!(validate_object_explorer_limit(Some("101")).is_err());
        assert_eq!(normalize_explorer_kind_filter("text").unwrap(), "text");
        assert_eq!(
            normalize_explorer_kind_filter("histogram").unwrap(),
            "histogram"
        );
        assert!(normalize_explorer_kind_filter("dataset").is_err());
        assert_eq!(
            validate_object_explorer_key(Some("eval/frame"))
                .unwrap()
                .as_deref(),
            Some("eval/frame")
        );
        assert!(validate_object_explorer_key(Some("bad\nkey")).is_err());
        assert!(validate_object_explorer_step(Some("NaN"), "from_step").is_err());
    }

    #[test]
    fn object_explorer_classification_preview_is_bounded() {
        let preview = object_explorer_preview(
            "classification_eval",
            &json!({
                "accuracy": 0.91,
                "macro_f1": 0.88,
                "sample_count": 512,
                "class_names": ["negative", "positive", "extra"],
                "confusion_matrix": [[210, 12, 1], [19, 271, 2], [1, 2, 3]],
                "per_class": [
                    {"class_name": "negative", "precision": 0.92},
                    {"class_name": "positive", "precision": 0.89},
                    {"class_name": "extra", "precision": 0.5}
                ],
                "predictions": (0..12).map(|index| json!({"id": index, "score": 0.9})).collect::<Vec<_>>(),
                "pr_curve": (0..250).map(|index| json!({"recall": index as f64 / 250.0, "precision": 0.9})).collect::<Vec<_>>(),
                "roc_curve": (0..250).map(|index| json!({"fpr": index as f64 / 250.0, "tpr": 0.9})).collect::<Vec<_>>()
            }),
        );
        let evaluation = &preview["evaluation"];
        assert_eq!(evaluation["accuracy"], json!(0.91));
        assert_eq!(evaluation["class_names"].as_array().unwrap().len(), 2);
        assert_eq!(evaluation["confusion_matrix"].as_array().unwrap().len(), 2);
        assert_eq!(
            evaluation["confusion_matrix"][0].as_array().unwrap().len(),
            2
        );
        assert_eq!(evaluation["per_class"].as_array().unwrap().len(), 2);
        assert_eq!(evaluation["predictions"].as_array().unwrap().len(), 5);
        assert_eq!(evaluation["pr_curve"].as_array().unwrap().len(), 200);
        assert_eq!(evaluation["roc_curve"].as_array().unwrap().len(), 200);
    }

    #[test]
    fn object_explorer_value_redacts_artifact_storage_details() {
        let run = run(10, "seed-10");
        let artifact_id = Uuid::from_u128(20);
        let mut data = StoreData::default();
        data.insert_artifact(ArtifactRow {
            id: artifact_id,
            org_id: Uuid::from_u128(1),
            run_id: run.id,
            kind: "file".to_string(),
            name: "frame.png".to_string(),
            uri: "instantml://artifacts/private-bucket/org/run/frame.png".to_string(),
            step: Some(3.0),
            size_bytes: Some(1024),
            sha256: Some("abc".to_string()),
            mime_type: Some("image/png".to_string()),
            storage_backend: "local".to_string(),
            storage_key: Some("private/key".to_string()),
            storage_path: Some("/tmp/private/frame.png".to_string()),
            metadata: json!({}),
            created_at: epoch(),
        });
        let mut row = attribute(1, run.id, "image", Some(3.0), 1);
        row.artifact_id = Some(artifact_id);
        let value = object_explorer_value(&data, &ObjectExplorerCandidate { row, run });

        assert_eq!(value["object_id"], json!("attr:1"));
        assert_eq!(value["artifact"]["mime_type"], json!("image/png"));
        assert_eq!(
            value["artifact"]["uri"],
            json!(format!("instantml://artifacts/{artifact_id}"))
        );
        assert!(value["artifact"].get("storage_key").is_none());
        assert!(value["artifact"].get("storage_path").is_none());
        assert!(!serde_json::to_string(&value)
            .unwrap()
            .contains("private-bucket"));
    }
}
