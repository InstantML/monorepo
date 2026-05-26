//! Validation for report blocks and visibility values. Block payloads are
//! authored by the dashboard editor (and eventually the SDK / MCP tool), so
//! we keep the schema permissive — JSON objects with a known `kind`
//! discriminator and a small set of per-kind required fields — while bounding
//! total payload size and recursion.

use super::*;

use serde_json::Map;

use crate::domain::{REPORT_VISIBILITY_ORG, REPORT_VISIBILITY_PRIVATE, REPORT_VISIBILITY_PUBLIC};

/// Hard cap on a report's serialized block array. 256 KiB is plenty for the
/// Notion-style documents we expect (markdown + a handful of panels + a few
/// LLM summary paragraphs) and keeps the operational-record payload small
/// enough to round-trip cheaply through ClickHouse.
pub const MAX_REPORT_BLOCKS_PAYLOAD_BYTES: usize = 256 * 1024;
/// Hard cap on the number of blocks per report. Mirrors editor UX limits;
/// well-designed reports rarely exceed a few dozen blocks.
pub const MAX_REPORT_BLOCKS: usize = 256;

/// Per-block size cap. A single markdown block of 32 KiB is already an
/// unusually large prose section; anything bigger should be split.
const MAX_SINGLE_BLOCK_BYTES: usize = 32 * 1024;

const SUPPORTED_BLOCK_KINDS: &[&str] = &[
    "heading",
    "paragraph",
    "markdown",
    "code",
    "callout",
    "horizontal_rule",
    "image",
    "panel_grid",
    "llm_summary",
];

const SUPPORTED_CALLOUT_VARIANTS: &[&str] = &["info", "warn", "success"];
const SUPPORTED_CODE_LANGUAGES: &[&str] = &[
    "python",
    "javascript",
    "typescript",
    "json",
    "yaml",
    "markdown",
    "rust",
    "bash",
    "sql",
    "plain",
];
const SUPPORTED_LLM_ANGLES: &[&str] = &[
    "what-worked",
    "outliers",
    "config-diffs",
    "next-steps",
    "free-form",
];

pub fn validate_visibility(value: Option<&str>) -> AppResult<String> {
    let raw = value.unwrap_or(REPORT_VISIBILITY_PRIVATE).trim();
    match raw {
        REPORT_VISIBILITY_PRIVATE | REPORT_VISIBILITY_ORG | REPORT_VISIBILITY_PUBLIC => {
            Ok(raw.to_string())
        }
        _ => Err(AppError::validation(
            "visibility must be one of: private, org, public",
        )),
    }
}

/// Validate the entire `blocks` value: must be an array, bounded length, each
/// element must be an object with a known `kind` plus the per-kind required
/// fields. Returns the canonicalized JSON value (defaulting to an empty array
/// when omitted) so callers can persist it directly.
pub fn validate_blocks(value: Option<Value>) -> AppResult<Value> {
    let raw = value.unwrap_or_else(|| Value::Array(Vec::new()));
    let array = raw
        .as_array()
        .ok_or_else(|| AppError::validation("blocks must be a JSON array"))?;
    if array.len() > MAX_REPORT_BLOCKS {
        return Err(AppError::validation(format!(
            "blocks must contain at most {MAX_REPORT_BLOCKS} entries"
        )));
    }
    for (index, block) in array.iter().enumerate() {
        validate_single_block(index, block)?;
    }
    let canonical = Value::Array(array.clone());
    validate_json_size(&canonical, "blocks", MAX_REPORT_BLOCKS_PAYLOAD_BYTES)?;
    Ok(canonical)
}

fn validate_single_block(index: usize, block: &Value) -> AppResult<()> {
    let object = block.as_object().ok_or_else(|| {
        AppError::validation(format!("block at index {index} must be a JSON object"))
    })?;
    let kind = object.get("kind").and_then(Value::as_str).ok_or_else(|| {
        AppError::validation(format!(
            "block at index {index} is missing a `kind` discriminator"
        ))
    })?;
    if !SUPPORTED_BLOCK_KINDS.contains(&kind) {
        return Err(AppError::validation(format!(
            "block at index {index} has unsupported kind `{kind}`"
        )));
    }
    validate_json_size(block, "block", MAX_SINGLE_BLOCK_BYTES)?;
    match kind {
        "heading" => validate_heading(index, object),
        "paragraph" => validate_text_field(index, object, "text", false),
        "markdown" => validate_text_field(index, object, "text", false),
        "code" => validate_code(index, object),
        "callout" => validate_callout(index, object),
        "horizontal_rule" => Ok(()),
        "image" => validate_image(index, object),
        "panel_grid" => validate_panel_grid(index, object),
        "llm_summary" => validate_llm_summary(index, object),
        _ => unreachable!("kind set is enumerated above"),
    }
}

fn validate_heading(index: usize, object: &Map<String, Value>) -> AppResult<()> {
    let level = object.get("level").and_then(Value::as_i64).ok_or_else(|| {
        AppError::validation(format!(
            "heading block at index {index} requires `level` (1, 2, or 3)"
        ))
    })?;
    if !(1..=3).contains(&level) {
        return Err(AppError::validation(format!(
            "heading block at index {index} `level` must be 1, 2, or 3"
        )));
    }
    validate_text_field(index, object, "text", false)
}

fn validate_text_field(
    index: usize,
    object: &Map<String, Value>,
    field: &str,
    allow_empty: bool,
) -> AppResult<()> {
    match object.get(field).and_then(Value::as_str) {
        Some(text) if allow_empty || !text.trim().is_empty() => Ok(()),
        Some(_) => Err(AppError::validation(format!(
            "block at index {index} `{field}` must be a non-empty string"
        ))),
        None => Err(AppError::validation(format!(
            "block at index {index} requires `{field}` text"
        ))),
    }
}

fn validate_code(index: usize, object: &Map<String, Value>) -> AppResult<()> {
    let language = object
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("plain");
    if !SUPPORTED_CODE_LANGUAGES.contains(&language) {
        return Err(AppError::validation(format!(
            "code block at index {index} has unsupported language `{language}`"
        )));
    }
    // Allow an empty code body — the editor lets you drop an empty block as
    // a placeholder.
    if !object.get("code").map(Value::is_string).unwrap_or(false) {
        return Err(AppError::validation(format!(
            "code block at index {index} requires `code` text"
        )));
    }
    Ok(())
}

fn validate_callout(index: usize, object: &Map<String, Value>) -> AppResult<()> {
    let variant = object
        .get("variant")
        .and_then(Value::as_str)
        .unwrap_or("info");
    if !SUPPORTED_CALLOUT_VARIANTS.contains(&variant) {
        return Err(AppError::validation(format!(
            "callout block at index {index} has unsupported variant `{variant}`"
        )));
    }
    validate_text_field(index, object, "text", false)
}

fn validate_image(index: usize, object: &Map<String, Value>) -> AppResult<()> {
    let url = object.get("url").and_then(Value::as_str).ok_or_else(|| {
        AppError::validation(format!("image block at index {index} requires `url`"))
    })?;
    if url.trim().is_empty() {
        return Err(AppError::validation(format!(
            "image block at index {index} `url` must not be empty"
        )));
    }
    Ok(())
}

fn validate_panel_grid(index: usize, object: &Map<String, Value>) -> AppResult<()> {
    let runsets = object
        .get("runsets")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::validation(format!(
                "panel_grid block at index {index} requires `runsets` array"
            ))
        })?;
    for (runset_index, runset) in runsets.iter().enumerate() {
        let runset_obj = runset.as_object().ok_or_else(|| {
            AppError::validation(format!(
                "panel_grid block {index}: runset {runset_index} must be an object"
            ))
        })?;
        let name = runset_obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            return Err(AppError::validation(format!(
                "panel_grid block {index}: runset {runset_index} requires `name`"
            )));
        }
        // `projects` is a list — the cross-project requirement.
        let projects = runset_obj
            .get("projects")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AppError::validation(format!(
                    "panel_grid block {index}: runset {runset_index} requires `projects` array"
                ))
            })?;
        for project in projects {
            if !project.is_string() {
                return Err(AppError::validation(format!(
                    "panel_grid block {index}: runset {runset_index} `projects` entries must be strings"
                )));
            }
        }
    }
    let panels = object
        .get("panels")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::validation(format!(
                "panel_grid block at index {index} requires `panels` array"
            ))
        })?;
    for (panel_index, panel) in panels.iter().enumerate() {
        let panel_obj = panel.as_object().ok_or_else(|| {
            AppError::validation(format!(
                "panel_grid block {index}: panel {panel_index} must be an object"
            ))
        })?;
        let panel_type = panel_obj.get("type").and_then(Value::as_str).unwrap_or("");
        if panel_type != "line" {
            return Err(AppError::validation(format!(
                "panel_grid block {index}: panel {panel_index} type `{panel_type}` is not supported in v1 (only `line`)"
            )));
        }
        let metric_key = panel_obj
            .get("metric_key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if metric_key.is_empty() {
            return Err(AppError::validation(format!(
                "panel_grid block {index}: panel {panel_index} requires `metric_key`"
            )));
        }
    }
    Ok(())
}

fn validate_llm_summary(index: usize, object: &Map<String, Value>) -> AppResult<()> {
    let panelgrid_index = object
        .get("panelgrid_index")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            AppError::validation(format!(
                "llm_summary block at index {index} requires `panelgrid_index`"
            ))
        })?;
    if panelgrid_index < 0 {
        return Err(AppError::validation(format!(
            "llm_summary block at index {index} `panelgrid_index` must be nonnegative"
        )));
    }
    let angle = object
        .get("angle")
        .and_then(Value::as_str)
        .unwrap_or("what-worked");
    if !SUPPORTED_LLM_ANGLES.contains(&angle) {
        return Err(AppError::validation(format!(
            "llm_summary block at index {index} angle `{angle}` is not supported"
        )));
    }
    Ok(())
}

/// Caller must be a non-demo org member with write privileges. Reuses the
/// existing dashboard write gate (which already enforces demo read-only and
/// browser-session presence).
pub fn ensure_owner_can_write(
    ctx_session_demo_read_only: bool,
    ctx_session_role: Option<&str>,
) -> AppResult<()> {
    if ctx_session_demo_read_only {
        return Err(AppError::forbidden(
            "demo workspace browser sessions are read-only",
        ));
    }
    if let Some(role) = ctx_session_role {
        if !matches!(role, "owner" | "admin" | "member") {
            return Err(AppError::forbidden("session role cannot write reports"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_supported_block_kinds() {
        let blocks = json!([
            { "kind": "heading", "level": 1, "text": "Hi" },
            { "kind": "paragraph", "text": "Some prose." },
            { "kind": "markdown", "text": "# heading\n\nbody" },
            { "kind": "code", "language": "python", "code": "print(1)" },
            { "kind": "callout", "variant": "info", "text": "FYI" },
            { "kind": "horizontal_rule" },
            { "kind": "image", "url": "https://example.com/x.png" },
            { "kind": "panel_grid", "runsets": [{ "name": "base", "projects": ["proj-a"] }], "panels": [{ "type": "line", "metric_key": "loss", "runset_index": 0 }] },
            { "kind": "llm_summary", "panelgrid_index": 7, "angle": "what-worked" }
        ]);
        let canonical = validate_blocks(Some(blocks)).expect("blocks ok");
        assert_eq!(canonical.as_array().unwrap().len(), 9);
    }

    #[test]
    fn rejects_unknown_block_kind() {
        let err = validate_blocks(Some(json!([{ "kind": "table" }]))).unwrap_err();
        assert!(err.message().contains("unsupported kind"));
    }

    #[test]
    fn rejects_non_array_blocks() {
        let err = validate_blocks(Some(json!({}))).unwrap_err();
        assert!(err.message().contains("must be a JSON array"));
    }

    #[test]
    fn rejects_invalid_heading_level() {
        let err = validate_blocks(Some(
            json!([{ "kind": "heading", "level": 9, "text": "h" }]),
        ))
        .unwrap_err();
        assert!(err.message().contains("level"));
    }

    #[test]
    fn rejects_unsupported_panel_type() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "x", "projects": ["p"] }],
            "panels": [{ "type": "scatter", "metric_key": "loss", "runset_index": 0 }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("not supported"));
    }

    #[test]
    fn panel_grid_requires_projects_list() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "x" }],
            "panels": []
        }])))
        .unwrap_err();
        assert!(err.message().contains("projects"));
    }

    #[test]
    fn visibility_accepts_known_values_only() {
        for value in ["private", "org", "public"] {
            assert_eq!(validate_visibility(Some(value)).unwrap(), value);
        }
        assert_eq!(validate_visibility(None).unwrap(), "private");
        assert!(validate_visibility(Some("internet")).is_err());
    }
}
