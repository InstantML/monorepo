//! Report mutations — create, update, delete, and share-token rotation. All
//! mutations are persisted as `report` operational records and reapplied to
//! the in-memory index.

use super::*;

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

fn fetch_live_report(data: &StoreData, org_id: Uuid, report_id: Uuid) -> AppResult<ReportRow> {
    data.reports
        .get(&report_id)
        .filter(|row| row.org_id == org_id)
        .filter(|row| row.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| AppError::not_found("report not found"))
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

    #[test]
    fn ensure_owner_can_write_blocks_demo_sessions() {
        assert!(ensure_owner_can_write(true, Some("owner")).is_err());
        assert!(ensure_owner_can_write(false, Some("viewer")).is_err());
        assert!(ensure_owner_can_write(false, Some("member")).is_ok());
        assert!(ensure_owner_can_write(false, None).is_ok());
    }

    #[test]
    fn visibility_constants_are_distinct() {
        assert_ne!(REPORT_VISIBILITY_PRIVATE, REPORT_VISIBILITY_ORG);
        assert_ne!(REPORT_VISIBILITY_ORG, REPORT_VISIBILITY_PUBLIC);
    }
}
