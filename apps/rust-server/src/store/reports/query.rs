//! Read-side handlers for reports — list, fetch by id, fetch by share token,
//! and markdown export.

use super::*;

use crate::domain::{ReportSummary, REPORT_VISIBILITY_PUBLIC};

const DEFAULT_REPORT_LIMIT: i64 = 50;
const MAX_REPORT_LIMIT: i64 = 200;
/// S6: share links stop resolving this many days after the token was minted.
/// Override with `INSTANTML_SHARE_TOKEN_TTL_DAYS` (`0` disables expiry).
const DEFAULT_SHARE_TOKEN_TTL_DAYS: i64 = 30;

fn share_token_ttl_days() -> i64 {
    static TTL: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *TTL.get_or_init(|| {
        std::env::var("INSTANTML_SHARE_TOKEN_TTL_DAYS")
            .ok()
            .and_then(|raw| raw.trim().parse::<i64>().ok())
            .filter(|days| *days >= 0)
            .unwrap_or(DEFAULT_SHARE_TOKEN_TTL_DAYS)
    })
}

/// Whether the row's share token is still within its TTL. Rows persisted
/// before issuance was recorded (`share_token_issued_at: None`) stay valid
/// until rotated — invalidating every pre-existing share link on deploy would
/// be a worse failure than a one-time grace window.
fn share_token_active(row: &ReportRow, now: chrono::DateTime<chrono::Utc>) -> bool {
    share_token_active_with_ttl(row, now, share_token_ttl_days())
}

fn share_token_active_with_ttl(
    row: &ReportRow,
    now: chrono::DateTime<chrono::Utc>,
    ttl_days: i64,
) -> bool {
    if row.share_token.is_none() {
        return false;
    }
    if ttl_days == 0 {
        return true;
    }
    match row.share_token_issued_at {
        None => true,
        Some(issued) => now.signed_duration_since(issued) <= chrono::Duration::days(ttl_days),
    }
}

pub async fn list_reports(
    store: &Store,
    ctx: &RequestContext,
    query: &HashMap<String, String>,
) -> AppResult<Value> {
    require_report_read(store, ctx)?;
    let limit = validate_limit(
        query.get("limit").map(String::as_str),
        DEFAULT_REPORT_LIMIT,
        MAX_REPORT_LIMIT,
    )? as usize;
    let offset = validate_offset(query.get("offset").map(String::as_str))? as usize;
    let project_filter = query
        .get("project")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && *value != "all");
    let data = store.data.lock().await;
    let mut rows: Vec<&ReportRow> = data
        .reports
        .values()
        .filter(|row| row.org_id == ctx.org_id)
        .filter(|row| row.deleted_at.is_none())
        .filter(|row| {
            project_filter.is_none_or(|filter| {
                row.project_id.map(|id| id.to_string()).as_deref() == Some(filter)
            })
        })
        .collect();
    rows.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.id.cmp(&right.id))
    });
    let total = rows.len();
    let summaries: Vec<ReportSummary> = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(report_summary)
        .collect();
    Ok(json!({
        "reports": summaries,
        "limit": limit,
        "offset": offset,
        "total": total,
    }))
}

pub async fn get_report(
    store: &Store,
    ctx: &RequestContext,
    report_id: Uuid,
    share_token: Option<&str>,
) -> AppResult<ReportRow> {
    let data = store.data.lock().await;
    let row = data
        .reports
        .get(&report_id)
        .filter(|row| row.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| AppError::not_found("report not found"))?;
    if row.visibility == REPORT_VISIBILITY_PUBLIC {
        return Ok(row);
    }
    if let Some(token) = share_token {
        if row
            .share_token
            .as_deref()
            .is_some_and(|stored| stored == token)
            && share_token_active(&row, chrono::Utc::now())
        {
            return Ok(row);
        }
    }
    drop(data);
    require_report_read(store, ctx)?;
    if row.org_id != ctx.org_id {
        return Err(AppError::not_found("report not found"));
    }
    Ok(row)
}

/// Public lookup by share token — used by the unauthenticated `/r/:token`
/// frontend route. Org membership and login are not required.
pub async fn get_report_by_share_token(store: &Store, share_token: &str) -> AppResult<ReportRow> {
    let now = chrono::Utc::now();
    let data = store.data.lock().await;
    data.reports
        .values()
        .find(|row| {
            row.deleted_at.is_none()
                && row
                    .share_token
                    .as_deref()
                    .is_some_and(|stored| stored == share_token)
                && share_token_active(row, now)
        })
        .cloned()
        .ok_or_else(|| AppError::not_found("report not found"))
}

/// Returns every panel defined inside every PanelGrid block across the
/// caller's org, flattened. The dashboard's "Add panel" picker exposes this
/// list under the "From other reports" tab so a user (or agent) can clone an
/// existing panel spec into the current report.
pub async fn list_org_panels(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    require_report_read(store, ctx)?;
    let data = store.data.lock().await;
    let entries = panels_inventory(&data, ctx.org_id);
    Ok(json!({ "panels": entries }))
}

/// Pure flattening helper used by [`list_org_panels`]. Extracted so it can be
/// tested without standing up a `Store` instance — the surrounding handler is
/// a thin auth + lock wrapper.
pub(crate) fn panels_inventory(data: &StoreData, org_id: Uuid) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    for row in data.reports.values() {
        if row.org_id != org_id || row.deleted_at.is_some() {
            continue;
        }
        let Some(blocks) = row.blocks.as_array() else {
            continue;
        };
        for block in blocks {
            let Some(block_obj) = block.as_object() else {
                continue;
            };
            if block_obj.get("kind").and_then(Value::as_str) != Some("panel_grid") {
                continue;
            }
            let Some(panels) = block_obj.get("panels").and_then(Value::as_array) else {
                continue;
            };
            for (panel_index, panel_spec) in panels.iter().enumerate() {
                entries.push(json!({
                    "report_id": row.id,
                    "report_title": row.title,
                    "panel_index": panel_index,
                    "panel_spec": panel_spec.clone(),
                }));
            }
        }
    }
    entries
}

pub fn report_summary(row: &ReportRow) -> ReportSummary {
    let block_count = row.blocks.as_array().map(|array| array.len()).unwrap_or(0);
    ReportSummary {
        id: row.id,
        title: row.title.clone(),
        description: row.description.clone(),
        project_id: row.project_id,
        visibility: row.visibility.clone(),
        // Advertise only tokens that still resolve — an expired link reading
        // as "shared" would send users to a 404.
        has_share_token: share_token_active(row, chrono::Utc::now()),
        author_user_id: row.author_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        block_count,
    }
}

/// Render the report as plaintext Markdown. PanelGrids and LLMSummary blocks
/// degrade to readable summaries (their interactive surface obviously can't
/// be exported as static markdown). This is the v1 export path; PDF / LaTeX
/// are deferred to v2.
pub async fn export_report_markdown(
    store: &Store,
    ctx: &RequestContext,
    report_id: Uuid,
    share_token: Option<&str>,
) -> AppResult<String> {
    let row = get_report(store, ctx, report_id, share_token).await?;
    Ok(render_markdown(&row))
}

pub(super) fn render_markdown(row: &ReportRow) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", row.title));
    if let Some(description) = &row.description {
        if !description.trim().is_empty() {
            out.push_str(description);
            out.push_str("\n\n");
        }
    }
    let Some(blocks) = row.blocks.as_array() else {
        return out;
    };
    for block in blocks {
        render_block_into(block, &mut out);
        out.push('\n');
    }
    out
}

fn render_block_into(block: &Value, out: &mut String) {
    let Some(object) = block.as_object() else {
        return;
    };
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "heading" => {
            let level = object.get("level").and_then(Value::as_i64).unwrap_or(1);
            let prefix = "#".repeat(level.clamp(1, 6) as usize);
            let text = object.get("text").and_then(Value::as_str).unwrap_or("");
            out.push_str(&format!("{prefix} {text}\n"));
        }
        "paragraph" | "markdown" => {
            let text = object.get("text").and_then(Value::as_str).unwrap_or("");
            out.push_str(text);
            out.push('\n');
        }
        "code" => {
            let language = object.get("language").and_then(Value::as_str).unwrap_or("");
            let code = object.get("code").and_then(Value::as_str).unwrap_or("");
            out.push_str(&format!("```{language}\n{code}\n```\n"));
        }
        "callout" => {
            let variant = object
                .get("variant")
                .and_then(Value::as_str)
                .unwrap_or("info");
            let text = object.get("text").and_then(Value::as_str).unwrap_or("");
            out.push_str(&format!("> [{variant}] {text}\n"));
        }
        "horizontal_rule" => out.push_str("---\n"),
        "image" => {
            let url = object.get("url").and_then(Value::as_str).unwrap_or("");
            let caption = object.get("caption").and_then(Value::as_str).unwrap_or("");
            out.push_str(&format!("![{caption}]({url})\n"));
        }
        "panel_grid" => {
            out.push_str("> _Panel grid — interactive in the dashboard._\n");
            if let Some(runsets) = object.get("runsets").and_then(Value::as_array) {
                for runset in runsets {
                    let name = runset
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("runset");
                    let projects = runset
                        .get("projects")
                        .and_then(Value::as_array)
                        .map(|array| {
                            array
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    out.push_str(&format!("> - **{name}**: {projects}\n"));
                }
            }
        }
        "llm_summary" => {
            let angle = object
                .get("angle")
                .and_then(Value::as_str)
                .unwrap_or("what-worked");
            let text = object
                .get("generated_text")
                .and_then(Value::as_str)
                .unwrap_or("_LLM summary has not been generated yet._");
            out.push_str(&format!("**LLM summary ({angle}):**\n\n{text}\n"));
        }
        _ => {}
    }
}

fn require_report_read(store: &Store, ctx: &RequestContext) -> AppResult<()> {
    // Org-scoped read: a valid session OR a valid API key for this org.
    if ctx.auth.is_some() {
        return Ok(());
    }
    if ctx.session.is_some() {
        return Ok(());
    }
    if store.hosted_clickhouse_enabled() {
        return Err(AppError::unauthorized("authentication required"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::REPORT_VISIBILITY_PRIVATE;

    fn row(id: u128, blocks: Value) -> ReportRow {
        ReportRow {
            schema_version: 1,
            id: Uuid::from_u128(id),
            org_id: Uuid::from_u128(99),
            project_id: None,
            title: format!("Report {id}"),
            description: Some("d".to_string()),
            blocks,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            author_user_id: None,
            share_token: None,
            share_token_issued_at: None,
            visibility: REPORT_VISIBILITY_PRIVATE.to_string(),
            deleted_at: None,
        }
    }

    #[test]
    fn render_markdown_handles_each_block_kind() {
        let report = row(
            1,
            json!([
                { "kind": "heading", "level": 2, "text": "H" },
                { "kind": "paragraph", "text": "para" },
                { "kind": "code", "language": "python", "code": "x = 1" },
                { "kind": "callout", "variant": "warn", "text": "careful" },
                { "kind": "horizontal_rule" },
                { "kind": "image", "url": "https://example.com/x.png", "caption": "cap" },
                { "kind": "panel_grid", "runsets": [{ "name": "r", "projects": ["p"] }], "panels": [] },
                { "kind": "llm_summary", "panelgrid_index": 6, "angle": "outliers", "generated_text": "OK" }
            ]),
        );
        let md = render_markdown(&report);
        assert!(md.contains("# Report 1"));
        assert!(md.contains("## H"));
        assert!(md.contains("```python"));
        assert!(md.contains("> [warn]"));
        assert!(md.contains("![cap]"));
        assert!(md.contains("**LLM summary (outliers)"));
    }

    #[test]
    fn report_summary_counts_blocks() {
        let row = row(
            2,
            json!([{"kind": "horizontal_rule"}, {"kind": "horizontal_rule"}]),
        );
        let summary = report_summary(&row);
        assert_eq!(summary.block_count, 2);
        assert!(!summary.has_share_token);
    }

    #[test]
    fn report_summary_marks_share_token_presence() {
        let mut row = row(3, json!([]));
        row.share_token = Some("instantml_share_xxx".to_string());
        let summary = report_summary(&row);
        assert!(summary.has_share_token);
    }

    #[test]
    fn share_tokens_expire_after_the_configured_ttl() {
        let now = chrono::Utc::now();
        let mut report = row(4, json!([]));

        // No token at all: never active.
        assert!(!share_token_active_with_ttl(&report, now, 30));

        report.share_token = Some("instantml_share_xxx".to_string());

        // Legacy token (no issuance recorded) stays valid until rotated.
        report.share_token_issued_at = None;
        assert!(share_token_active_with_ttl(&report, now, 30));

        // Fresh token: active. Past the TTL: expired.
        report.share_token_issued_at = Some(now - chrono::Duration::days(5));
        assert!(share_token_active_with_ttl(&report, now, 30));
        report.share_token_issued_at = Some(now - chrono::Duration::days(31));
        assert!(!share_token_active_with_ttl(&report, now, 30));

        // TTL 0 is the explicit "never expire" opt-out.
        assert!(share_token_active_with_ttl(&report, now, 0));
    }

    #[test]
    fn panels_inventory_flattens_panel_grids_across_reports() {
        let mut data = StoreData::default();
        let org_id = Uuid::from_u128(99);
        let mut report_a = row(
            10,
            json!([
                { "kind": "paragraph", "text": "intro" },
                {
                    "kind": "panel_grid",
                    "runsets": [{ "name": "rs", "projects": ["proj-a"] }],
                    "panels": [
                        { "type": "line", "metric_key": "loss", "runset_index": 0 },
                        { "type": "scalar", "metric_key": "loss", "runset_index": 0, "agg": "latest" }
                    ]
                }
            ]),
        );
        report_a.org_id = org_id;
        let mut report_b = row(
            11,
            json!([{
                "kind": "panel_grid",
                "runsets": [{ "name": "rs", "projects": ["proj-b"] }],
                "panels": [
                    { "type": "bar", "metric_key": "eval/return_mean", "runset_index": 0 }
                ]
            }]),
        );
        report_b.org_id = org_id;
        data.insert_report(report_a);
        data.insert_report(report_b);

        // A report from a different org must not leak.
        let mut foreign = row(
            12,
            json!([{
                "kind": "panel_grid",
                "runsets": [{ "name": "x", "projects": ["p"] }],
                "panels": [{ "type": "line", "metric_key": "foreign", "runset_index": 0 }]
            }]),
        );
        foreign.org_id = Uuid::from_u128(123);
        data.insert_report(foreign);

        let entries = panels_inventory(&data, org_id);
        assert_eq!(entries.len(), 3);
        let metric_keys: Vec<String> = entries
            .iter()
            .map(|entry| {
                entry["panel_spec"]["metric_key"]
                    .as_str()
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert!(metric_keys.contains(&"loss".to_string()));
        assert!(metric_keys.contains(&"eval/return_mean".to_string()));
        assert!(!metric_keys.contains(&"foreign".to_string()));
        // Each entry carries the report id, title, and panel index.
        for entry in &entries {
            assert!(entry["report_id"].as_str().is_some());
            assert!(entry["report_title"].as_str().is_some());
            assert!(entry["panel_index"].as_i64().is_some());
        }
    }

    #[test]
    fn panels_inventory_skips_deleted_reports() {
        let mut data = StoreData::default();
        let org_id = Uuid::from_u128(99);
        let mut report = row(
            20,
            json!([{
                "kind": "panel_grid",
                "runsets": [{ "name": "rs", "projects": ["p"] }],
                "panels": [{ "type": "line", "metric_key": "loss", "runset_index": 0 }]
            }]),
        );
        report.org_id = org_id;
        report.deleted_at = Some(chrono::Utc::now());
        data.insert_report(report);
        let entries = panels_inventory(&data, org_id);
        assert!(entries.is_empty());
    }
}
