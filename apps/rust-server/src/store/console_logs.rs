use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

use super::*;

const CONSOLE_LOG_STREAMS: &[&str] = &["stdout", "stderr"];
const MAX_CONSOLE_CURSOR_BYTES: usize = 256;
const MAX_CONSOLE_LOG_SEARCH_SCAN: i64 = 5_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ConsoleLogCursor {
    line_number: u64,
    ingest_id: Uuid,
}

pub async fn log_console_logs(
    store: &Store,
    ctx: &RequestContext,
    run_id: Uuid,
    raw: Value,
    input: CreateConsoleLogsRequest,
    idempotency_key: Option<String>,
) -> AppResult<usize> {
    let stream = validate_console_stream(input.stream.as_deref())?;
    let now = Utc::now();
    let rows = validate_console_log_inputs(ctx.org_id, run_id, &stream, input.lines, now)?;
    let request_hash = hash_idempotency(run_id, &raw)?;
    let metric_store = store.metric_store_for_org(ctx.org_id).await?;
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
            metric_store.insert_console_logs(&rows).await?;
            let run = note_run_event(store, ctx, run_id).await?;
            store.publish_live_event(
                ctx.org_id,
                run.project_id,
                run_id,
                "run_console_batch",
                json!({
                    "run_id": run_id,
                    "stream": stream,
                    "line_count": rows.len()
                }),
            );
            let record = IdempotencyRecord {
                org_id: ctx.org_id,
                key: key.clone(),
                request_hash,
                response_json: json!({ "inserted": rows.len() }),
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
            Ok(rows.len())
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
    metric_store.insert_console_logs(&rows).await?;
    let run = note_run_event(store, ctx, run_id).await?;
    store.publish_live_event(
        ctx.org_id,
        run.project_id,
        run_id,
        "run_console_batch",
        json!({
            "run_id": run_id,
            "stream": stream,
            "line_count": rows.len()
        }),
    );
    Ok(rows.len())
}

pub async fn list_console_logs(
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
    let stream = validate_console_stream(query.get("stream").map(String::as_str))?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_CONSOLE_LOG_LIMIT,
        MAX_CONSOLE_LOG_LIMIT,
    )?;
    let cursor = query
        .get("cursor")
        .filter(|value| !value.is_empty())
        .map(|raw| decode_console_cursor(raw))
        .transpose()?;
    let search = query
        .get("q")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_console_search)
        .transpose()?;
    let window_limit = if search.is_some() {
        (limit * 20).clamp(limit + 1, MAX_CONSOLE_LOG_SEARCH_SCAN) + 1
    } else {
        limit + 1
    };
    let mut rows = store
        .metric_store_for_org(ctx.org_id)
        .await?
        .query_console_log_window(
            ctx.org_id,
            run_id,
            &stream,
            cursor.map(|item| (item.line_number, item.ingest_id)),
            window_limit,
        )
        .await?;
    let raw_has_more = rows.len() as i64 > window_limit - 1;
    if raw_has_more {
        rows.truncate((window_limit - 1) as usize);
    }
    let (selected, next_cursor, truncated) =
        select_console_log_rows(rows, search.as_deref(), limit, raw_has_more);
    Ok(json!({
        "lines": selected.iter().map(console_log_line_value).collect::<Vec<_>>(),
        "next_cursor": next_cursor.map(|cursor| encode_console_cursor(&cursor)).transpose()?,
        "limit": limit,
        "truncated": truncated
    }))
}

fn validate_console_log_inputs(
    org_id: Uuid,
    run_id: Uuid,
    stream: &str,
    lines: Option<Vec<ConsoleLogInput>>,
    now: DateTime<Utc>,
) -> AppResult<Vec<ConsoleLogInsertRow>> {
    let lines = lines.ok_or_else(|| AppError::validation("lines are required"))?;
    if lines.is_empty() {
        return Err(AppError::validation(
            "lines must include at least one log line",
        ));
    }
    if lines.len() > MAX_CONSOLE_LOG_LINES_PER_BATCH {
        return Err(AppError::validation(format!(
            "lines must include at most {MAX_CONSOLE_LOG_LINES_PER_BATCH} items"
        )));
    }
    lines
        .into_iter()
        .map(|line| {
            let line_number = line
                .line_number
                .ok_or_else(|| AppError::validation("line_number is required"))?;
            let message = line
                .message
                .ok_or_else(|| AppError::validation("message is required"))?;
            if message.len() > MAX_CONSOLE_LOG_MESSAGE_BYTES {
                return Err(AppError::validation("message is too large"));
            }
            Ok(ConsoleLogInsertRow {
                org_id,
                run_id,
                stream: stream.to_string(),
                ingest_id: Uuid::new_v4(),
                line_number,
                message,
                logged_at: line
                    .timestamp
                    .as_deref()
                    .map(|raw| validate_timestamp(Some(raw)))
                    .transpose()?
                    .unwrap_or(now),
                created_at: now,
            })
        })
        .collect()
}

fn validate_console_stream(raw: Option<&str>) -> AppResult<String> {
    let stream = raw.unwrap_or("stdout").trim();
    if CONSOLE_LOG_STREAMS.contains(&stream) {
        Ok(stream.to_string())
    } else {
        Err(AppError::validation("stream must be stdout or stderr"))
    }
}

fn validate_console_search(raw: &str) -> AppResult<String> {
    if raw.len() > MAX_TEXT_BYTES {
        return Err(AppError::validation("q is too large"));
    }
    Ok(raw.to_ascii_lowercase())
}

fn select_console_log_rows(
    rows: Vec<ConsoleLogReadRow>,
    search: Option<&str>,
    limit: i64,
    raw_has_more: bool,
) -> (Vec<ConsoleLogReadRow>, Option<ConsoleLogCursor>, bool) {
    let mut selected = Vec::new();
    let mut last_scanned = None;
    for row in rows {
        last_scanned = Some(ConsoleLogCursor {
            line_number: row.line_number,
            ingest_id: row.ingest_id,
        });
        let matches = search
            .map(|needle| row.message.to_ascii_lowercase().contains(needle))
            .unwrap_or(true);
        if matches && selected.len() < limit as usize {
            selected.push(row);
        }
    }
    let next_cursor = if selected.len() >= limit as usize {
        selected.last().map(|row| ConsoleLogCursor {
            line_number: row.line_number,
            ingest_id: row.ingest_id,
        })
    } else if raw_has_more {
        last_scanned
    } else {
        None
    };
    let truncated = search.is_some() && raw_has_more && selected.len() < limit as usize;
    (selected, next_cursor, truncated)
}

fn console_log_line_value(row: &ConsoleLogReadRow) -> Value {
    json!({
        "run_id": row.run_id,
        "stream": row.stream,
        "line_number": row.line_number,
        "message": row.message,
        "timestamp": row.logged_at,
        "created_at": row.created_at
    })
}

fn encode_console_cursor(cursor: &ConsoleLogCursor) -> AppResult<String> {
    let raw = serde_json::to_vec(cursor)
        .map_err(|_| AppError::internal("cursor serialization failed"))?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn decode_console_cursor(raw: &str) -> AppResult<ConsoleLogCursor> {
    if raw.len() > MAX_CONSOLE_CURSOR_BYTES {
        return Err(AppError::validation("cursor is too large"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::validation("cursor is invalid"))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::validation("cursor is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_row(line_number: u64, message: &str) -> ConsoleLogReadRow {
        ConsoleLogReadRow {
            run_id: Uuid::from_u128(2),
            stream: "stdout".to_string(),
            ingest_id: Uuid::from_u128(line_number as u128 + 10),
            line_number,
            message: message.to_string(),
            logged_at: epoch(),
            created_at: epoch(),
        }
    }

    #[test]
    fn validate_console_stream_accepts_only_stdout_or_stderr() {
        assert_eq!(validate_console_stream(None).unwrap(), "stdout");
        assert_eq!(validate_console_stream(Some("stderr")).unwrap(), "stderr");
        assert!(validate_console_stream(Some("debug")).is_err());
    }

    #[test]
    fn console_cursor_round_trips_as_opaque_string() {
        let cursor = ConsoleLogCursor {
            line_number: 42,
            ingest_id: Uuid::from_u128(9),
        };
        let encoded = encode_console_cursor(&cursor).unwrap();
        assert_eq!(decode_console_cursor(&encoded).unwrap(), cursor);
        assert!(decode_console_cursor("not-base64").is_err());
        assert!(decode_console_cursor(&"a".repeat(MAX_CONSOLE_CURSOR_BYTES + 1)).is_err());
    }

    #[test]
    fn select_console_log_rows_filters_and_uses_scan_cursor_when_truncated() {
        let rows = vec![
            read_row(1, "hello"),
            read_row(2, "loss=0.2"),
            read_row(3, "still scanning"),
        ];
        let (selected, cursor, truncated) = select_console_log_rows(rows, Some("loss"), 10, true);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].line_number, 2);
        assert_eq!(cursor.unwrap().line_number, 3);
        assert!(truncated);
    }

    #[test]
    fn validate_console_log_inputs_requires_line_numbers_and_limits_message_size() {
        let now = epoch();
        let rows = validate_console_log_inputs(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            "stdout",
            Some(vec![ConsoleLogInput {
                line_number: Some(7),
                message: Some("ok".to_string()),
                timestamp: None,
            }]),
            now,
        )
        .unwrap();
        assert_eq!(rows[0].line_number, 7);
        assert_eq!(rows[0].logged_at, now);
        assert!(validate_console_log_inputs(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            "stdout",
            Some(vec![ConsoleLogInput {
                line_number: None,
                message: Some("ok".to_string()),
                timestamp: None,
            }]),
            now,
        )
        .is_err());
    }
}
