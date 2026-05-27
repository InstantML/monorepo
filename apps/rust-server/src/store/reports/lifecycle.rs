//! Report mutations — create, update, delete, share-token rotation, and
//! refresh of an `llm_summary` block in place. All mutations are persisted as
//! `report` operational records and reapplied to the in-memory index.

use super::*;

use super::llm::{
    generate_summary, report_llm_provider_label, LlmMetricAggregate, LlmRunMetricSummary,
    LlmSummaryRequest,
};
use super::validation::{ensure_owner_can_write, validate_blocks, validate_visibility};

const REPORT_SCHEMA_VERSION: i32 = 1;
const SHARE_TOKEN_PREFIX: &str = "instantml_share_";

pub async fn create_report(
    store: &Store,
    ctx: &RequestContext,
    input: CreateReportRequest,
) -> AppResult<ReportRow> {
    let user_id = require_report_write(store, ctx)?;
    let title = validate_name(input.title.as_deref(), "title")?;
    let description = validate_optional_name(input.description.as_deref(), "description")?;
    let visibility = validate_visibility(input.visibility.as_deref())?;
    let blocks = validate_blocks(input.blocks)?;
    let now = Utc::now();
    let row = ReportRow {
        schema_version: REPORT_SCHEMA_VERSION,
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        project_id: input.project_id,
        title,
        description,
        blocks,
        created_at: now,
        updated_at: now,
        author_user_id: user_id,
        share_token: None,
        visibility,
        deleted_at: None,
    };
    let mut data = store.data.lock().await;
    store
        .persist_locked("report", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    data.insert_report(row.clone());
    Ok(row)
}

pub async fn update_report(
    store: &Store,
    ctx: &RequestContext,
    report_id: Uuid,
    input: UpdateReportRequest,
) -> AppResult<ReportRow> {
    require_report_write(store, ctx)?;
    let mut data = store.data.lock().await;
    let existing = fetch_live_report(&data, ctx.org_id, report_id)?;
    if input.title.is_none()
        && input.description.is_none()
        && input.visibility.is_none()
        && input.blocks.is_none()
    {
        return Err(AppError::validation(
            "at least one of title, description, visibility, or blocks is required",
        ));
    }
    let title = match input.title {
        Some(value) => validate_name(Some(value.as_str()), "title")?,
        None => existing.title.clone(),
    };
    let description = match input.description {
        Some(value) if value.trim().is_empty() => None,
        Some(value) => validate_optional_name(Some(value.as_str()), "description")?,
        None => existing.description.clone(),
    };
    let visibility = match input.visibility {
        Some(value) => validate_visibility(Some(value.as_str()))?,
        None => existing.visibility.clone(),
    };
    let blocks = match input.blocks {
        Some(value) => validate_blocks(Some(value))?,
        None => existing.blocks.clone(),
    };
    let row = ReportRow {
        title,
        description,
        visibility,
        blocks,
        updated_at: Utc::now(),
        ..existing
    };
    store
        .persist_locked("report", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    data.insert_report(row.clone());
    Ok(row)
}

pub async fn delete_report(
    store: &Store,
    ctx: &RequestContext,
    report_id: Uuid,
) -> AppResult<ReportRow> {
    require_report_write(store, ctx)?;
    let mut data = store.data.lock().await;
    let existing = fetch_live_report(&data, ctx.org_id, report_id)?;
    let row = ReportRow {
        deleted_at: Some(Utc::now()),
        updated_at: Utc::now(),
        ..existing
    };
    store
        .persist_locked("report", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    data.insert_report(row.clone());
    Ok(row)
}

pub async fn rotate_share_token(
    store: &Store,
    ctx: &RequestContext,
    report_id: Uuid,
) -> AppResult<ReportRow> {
    require_report_write(store, ctx)?;
    let mut data = store.data.lock().await;
    let existing = fetch_live_report(&data, ctx.org_id, report_id)?;
    // `generate_api_key` returns an opaque, high-entropy random token —
    // reusing the helper saves us standing up a parallel CSPRNG path.
    let raw = crate::auth::generate_api_key();
    let token = format!(
        "{SHARE_TOKEN_PREFIX}{}",
        raw.trim_start_matches("instantml_")
    );
    let row = ReportRow {
        share_token: Some(token),
        updated_at: Utc::now(),
        ..existing
    };
    store
        .persist_locked("report", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    data.insert_report(row.clone());
    Ok(row)
}

/// Re-run the LLM summary for the block at `block_index`. The block must be
/// an `llm_summary` block; it carries `panelgrid_index` which we use to look
/// up the surrounding PanelGrid's runsets. We pull summary aggregates for the
/// matched runs via `query_series_for_runs`, then hand the structured payload
/// to the configured LLM provider.
pub async fn refresh_report_block(
    store: &Store,
    ctx: &RequestContext,
    report_id: Uuid,
    block_index: usize,
) -> AppResult<ReportRow> {
    require_report_write(store, ctx)?;
    let (existing, llm_request) = {
        let data = store.data.lock().await;
        let existing = fetch_live_report(&data, ctx.org_id, report_id)?;
        let llm_request = build_llm_request_locked(&data, ctx.org_id, &existing, block_index)?;
        (existing, llm_request)
    };
    let series_rows = if llm_request.run_ids.is_empty() {
        Vec::new()
    } else {
        let metric_store = store.metric_store();
        metric_store
            .query_series_for_runs(ctx.org_id, &llm_request.run_ids, None)
            .await
            .unwrap_or_default()
    };
    let mut by_run: std::collections::HashMap<Uuid, Vec<LlmMetricAggregate>> =
        std::collections::HashMap::new();
    for row in series_rows {
        let aggregate = LlmMetricAggregate {
            key: row.key,
            count: row.count as i64,
            min: finite(row.min),
            max: finite(row.max),
            mean: if row.count > 0 {
                finite(row.sum / row.count as f64)
            } else {
                None
            },
            latest: finite(row.latest),
        };
        by_run.entry(row.run_id).or_default().push(aggregate);
    }
    let runs = llm_request
        .runs
        .into_iter()
        .map(|run| LlmRunMetricSummary {
            metrics: by_run.remove(&run.run_uuid).unwrap_or_default(),
            run_id: run.run_uuid.to_string(),
            run_name: run.run_name,
            project: run.project,
        })
        .collect::<Vec<_>>();
    let summary_request = LlmSummaryRequest {
        angle: llm_request.angle,
        custom_prompt: llm_request.custom_prompt,
        report_title: existing.title.clone(),
        runs,
    };
    let (text, provider) = generate_summary(&summary_request)?;
    let now = Utc::now();
    let mut blocks = existing.blocks.as_array().cloned().unwrap_or_default();
    let block = blocks.get_mut(block_index).ok_or_else(|| {
        AppError::not_found(format!("report block at index {block_index} not found"))
    })?;
    let block_obj = block
        .as_object_mut()
        .ok_or_else(|| AppError::internal("stored llm_summary block is not a JSON object"))?;
    block_obj.insert("generated_text".to_string(), Value::String(text));
    block_obj.insert("generated_at".to_string(), Value::String(now.to_rfc3339()));
    block_obj.insert(
        "provider".to_string(),
        Value::String(report_llm_provider_label(provider).to_string()),
    );
    let new_blocks = validate_blocks(Some(Value::Array(blocks)))?;
    let row = ReportRow {
        blocks: new_blocks,
        updated_at: now,
        ..existing
    };
    let mut data = store.data.lock().await;
    store
        .persist_locked("report", ctx.org_id, &row.id.to_string(), &row)
        .await?;
    data.insert_report(row.clone());
    Ok(row)
}

#[derive(Debug)]
struct LlmBlockRequest {
    angle: String,
    custom_prompt: Option<String>,
    runs: Vec<LlmRunRef>,
    run_ids: Vec<Uuid>,
}

#[derive(Debug)]
struct LlmRunRef {
    run_uuid: Uuid,
    run_name: String,
    project: String,
}

fn build_llm_request_locked(
    data: &StoreData,
    org_id: Uuid,
    report: &ReportRow,
    block_index: usize,
) -> AppResult<LlmBlockRequest> {
    let blocks = report
        .blocks
        .as_array()
        .ok_or_else(|| AppError::internal("stored report `blocks` is not a JSON array"))?;
    let block = blocks.get(block_index).ok_or_else(|| {
        AppError::not_found(format!("report block at index {block_index} not found"))
    })?;
    let block_obj = block
        .as_object()
        .ok_or_else(|| AppError::validation("target block must be a JSON object"))?;
    if block_obj.get("kind").and_then(Value::as_str) != Some("llm_summary") {
        return Err(AppError::validation(
            "target block must be an `llm_summary` block",
        ));
    }
    let angle = block_obj
        .get("angle")
        .and_then(Value::as_str)
        .unwrap_or("what-worked")
        .to_string();
    let custom_prompt = block_obj
        .get("custom_prompt")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let panelgrid_index = block_obj
        .get("panelgrid_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::validation("llm_summary block missing `panelgrid_index`"))?;
    let panel_block = blocks.get(panelgrid_index as usize).ok_or_else(|| {
        AppError::validation(format!(
            "llm_summary `panelgrid_index` {panelgrid_index} does not reference a block in this report"
        ))
    })?;
    let panel_obj = panel_block
        .as_object()
        .ok_or_else(|| AppError::internal("referenced panel_grid block is not a JSON object"))?;
    if panel_obj.get("kind").and_then(Value::as_str) != Some("panel_grid") {
        return Err(AppError::validation(
            "llm_summary `panelgrid_index` must reference a panel_grid block",
        ));
    }
    let runsets = panel_obj
        .get("runsets")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::internal("panel_grid block missing `runsets`"))?;
    let mut projects: Vec<String> = Vec::new();
    let mut limit_total: usize = 0;
    for runset in runsets {
        let runset_obj = runset
            .as_object()
            .ok_or_else(|| AppError::internal("runset entry must be a JSON object"))?;
        let runset_limit = runset_obj
            .get("limit")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or(50) as usize;
        limit_total = limit_total.saturating_add(runset_limit);
        if let Some(project_list) = runset_obj.get("projects").and_then(Value::as_array) {
            for project in project_list {
                if let Some(name) = project.as_str() {
                    projects.push(name.to_string());
                }
            }
        }
    }
    // Look up runs for the named projects. The LLM call is summary-only —
    // we don't want to drown the prompt in raw points — so we cap total at
    // the cumulative runset limit (default 50/each).
    let mut runs = Vec::new();
    let mut run_ids = Vec::new();
    let cap = limit_total.clamp(50, 200);
    for project in &projects {
        for run in data
            .runs
            .values()
            .filter(|run| run.org_id == org_id && run.project.as_str() == project.as_str())
        {
            if runs.len() >= cap {
                break;
            }
            run_ids.push(run.id);
            runs.push(LlmRunRef {
                run_uuid: run.id,
                run_name: run.name.clone(),
                project: run.project.clone(),
            });
        }
        if runs.len() >= cap {
            break;
        }
    }
    Ok(LlmBlockRequest {
        angle,
        custom_prompt,
        runs,
        run_ids,
    })
}

fn fetch_live_report(data: &StoreData, org_id: Uuid, report_id: Uuid) -> AppResult<ReportRow> {
    data.reports
        .get(&report_id)
        .filter(|row| row.org_id == org_id)
        .filter(|row| row.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| AppError::not_found("report not found"))
}

fn finite(value: f64) -> Option<f64> {
    if value.is_finite() {
        Some(value)
    } else {
        None
    }
}

fn require_report_write(store: &Store, ctx: &RequestContext) -> AppResult<Option<Uuid>> {
    // Bearer-API-key callers (the SDK) can author reports too; in v1 we
    // accept either browser session or API key as long as the org matches.
    if let Some(auth) = &ctx.auth {
        if auth.org_id != ctx.org_id {
            return Err(AppError::forbidden("api key belongs to a different org"));
        }
        return Ok(None);
    }
    if store.hosted_clickhouse_enabled() && ctx.session.is_none() {
        return Err(AppError::unauthorized("browser session required"));
    }
    if let Some(session) = &ctx.session {
        ensure_owner_can_write(session.demo_read_only, Some(&session.role))?;
        return Ok(Some(session.user_id));
    }
    // Local single-binary mode — no session, no auth: allow as the local
    // user (mirrors how workspace_views works for local dev).
    Ok(None)
}

#[allow(dead_code)]
pub(super) fn report_envelope(row: &ReportRow) -> Value {
    json!({ "report": row })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        REPORT_VISIBILITY_ORG, REPORT_VISIBILITY_PRIVATE, REPORT_VISIBILITY_PUBLIC,
    };
    use serde_json::json;

    fn sample_row() -> ReportRow {
        ReportRow {
            schema_version: REPORT_SCHEMA_VERSION,
            id: Uuid::from_u128(1),
            org_id: Uuid::from_u128(2),
            project_id: None,
            title: "T".to_string(),
            description: None,
            blocks: json!([
                { "kind": "paragraph", "text": "hi" },
                { "kind": "panel_grid", "runsets": [{ "name": "x", "projects": ["p"] }], "panels": [{ "type": "line", "metric_key": "loss", "runset_index": 0 }] },
                { "kind": "llm_summary", "panelgrid_index": 1, "angle": "what-worked" }
            ]),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            author_user_id: None,
            share_token: None,
            visibility: REPORT_VISIBILITY_PRIVATE.to_string(),
            deleted_at: None,
        }
    }

    #[test]
    fn ensure_owner_can_write_blocks_demo_sessions() {
        assert!(ensure_owner_can_write(true, Some("owner")).is_err());
        assert!(ensure_owner_can_write(false, Some("viewer")).is_err());
        assert!(ensure_owner_can_write(false, Some("member")).is_ok());
        assert!(ensure_owner_can_write(false, None).is_ok());
    }

    #[test]
    fn build_llm_request_locked_resolves_runsets() {
        let mut data = StoreData::default();
        let org_id = Uuid::from_u128(2);
        let run = RunRow {
            id: Uuid::from_u128(10),
            org_id,
            project_id: Uuid::from_u128(20),
            project: "p".to_string(),
            name: "exp-1".to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: vec![],
            metadata: json!({}),
            created_at: chrono::Utc::now(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        };
        data.insert_run(run.clone());
        let report = sample_row();
        let request = build_llm_request_locked(&data, org_id, &report, 2).unwrap();
        assert_eq!(request.angle, "what-worked");
        assert_eq!(request.runs.len(), 1);
        assert_eq!(request.runs[0].run_uuid, run.id);
    }

    #[test]
    fn build_llm_request_locked_rejects_non_llm_block() {
        let data = StoreData::default();
        let report = sample_row();
        let err = build_llm_request_locked(&data, report.org_id, &report, 0).unwrap_err();
        assert!(err.message().contains("`llm_summary`"));
    }

    #[test]
    fn build_llm_request_locked_rejects_bad_panelgrid_index() {
        let data = StoreData::default();
        let mut report = sample_row();
        report.blocks =
            json!([{ "kind": "llm_summary", "panelgrid_index": 99, "angle": "what-worked" }]);
        let err = build_llm_request_locked(&data, report.org_id, &report, 0).unwrap_err();
        assert!(err.message().contains("panelgrid_index"));
    }

    #[test]
    fn visibility_constants_are_distinct() {
        assert_ne!(REPORT_VISIBILITY_PRIVATE, REPORT_VISIBILITY_ORG);
        assert_ne!(REPORT_VISIBILITY_ORG, REPORT_VISIBILITY_PUBLIC);
    }
}
