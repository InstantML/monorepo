//! Reports — Notion-style documents that combine prose, code, and live data.
//!
//! Reports are stored as JSON-payload operational records (kind = `"report"`).
//! The record body is a [`ReportRow`] whose `blocks` field is an ordered list
//! of block JSON objects (heading, paragraph, markdown, code, callout,
//! horizontal_rule, image, panel_grid, and legacy llm_summary). The store layer keeps
//! validation tight enough to round-trip blocks safely but stays agnostic to
//! their visual rendering — the frontend owns presentation.
//!
//! Auth model:
//! - Read: org member, or `visibility = "public"` (anyone), or the caller
//!   supplied the report's `share_token` (magic link).
//! - Write: org member with a non-demo session or a non-restricted API key.
//!
//! `llm_summary` remains accepted only for legacy stored reports. The public
//! UI, API, and MCP report-authoring surfaces no longer create or refresh
//! those blocks because the v1 provider path returned placeholders instead of
//! real synthesis.

use super::*;

mod lifecycle;
mod query;
mod validation;

pub use lifecycle::{create_report, delete_report, rotate_share_token, update_report};
pub use query::{
    export_report_markdown, get_report, get_report_by_share_token, list_org_panels, list_reports,
    report_summary,
};
pub use validation::{
    ensure_owner_can_write, validate_blocks, validate_visibility, MAX_REPORT_BLOCKS,
    MAX_REPORT_BLOCKS_PAYLOAD_BYTES,
};
