//! Reports — Notion-style documents that combine prose, code, and live data.
//!
//! Reports are stored as JSON-payload operational records (kind = `"report"`).
//! The record body is a [`ReportRow`] whose `blocks` field is an ordered list
//! of block JSON objects (heading, paragraph, markdown, code, callout,
//! horizontal_rule, image, panel_grid, llm_summary). The store layer keeps
//! validation tight enough to round-trip blocks safely but stays agnostic to
//! their visual rendering — the frontend owns presentation.
//!
//! Auth model:
//! - Read: org member, or `visibility = "public"` (anyone), or the caller
//!   supplied the report's `share_token` (magic link).
//! - Write: org member with a non-demo session or a non-restricted API key.
//!
//! `LLMSummaryBlock` is the differentiator: when a caller hits
//! `POST /api/reports/:id/blocks/:index/refresh` against an `llm_summary`
//! block, the store reads the referenced PanelGrid's runsets, fetches metric
//! summary aggregates via `query_series_for_runs`, and asks the configured
//! LLM provider to write a paragraph. The provider call is gated on
//! `ANTHROPIC_API_KEY`; without a key, a deterministic stub paragraph is
//! returned so the wiring stays exercised in tests and local dev.

use super::*;

mod lifecycle;
mod llm;
mod query;
mod validation;

pub use lifecycle::{
    create_report, delete_report, refresh_report_block, rotate_share_token, update_report,
};
pub use llm::{report_llm_provider_label, ReportLlmProvider};
pub use query::{
    export_report_markdown, get_report, get_report_by_share_token, list_org_panels, list_reports,
    report_summary,
};
pub use validation::{
    ensure_owner_can_write, validate_blocks, validate_visibility, MAX_REPORT_BLOCKS,
    MAX_REPORT_BLOCKS_PAYLOAD_BYTES,
};
