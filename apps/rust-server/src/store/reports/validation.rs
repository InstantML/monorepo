//! Validation for report blocks and visibility values. Block payloads are
//! authored by the dashboard editor (and eventually the SDK / MCP tool), so
//! we keep the schema permissive — JSON objects with a known `kind`
//! discriminator and a small set of per-kind required fields — while bounding
//! total payload size and recursion.

use super::*;

use serde_json::Map;

use crate::domain::{REPORT_VISIBILITY_ORG, REPORT_VISIBILITY_PRIVATE, REPORT_VISIBILITY_PUBLIC};

/// Hard cap on a report's serialized block array. 256 KiB is plenty for the
/// Notion-style documents we expect (markdown + a handful of panels) and
/// keeps the operational-record payload small enough to round-trip cheaply
/// through ClickHouse.
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
        // Empty text is allowed on paragraph / markdown / heading / callout
        // blocks so the editor's auto-save can fire the moment a block is
        // inserted, before the user has typed anything. Block-presence is
        // the user's intent; emptiness is the in-progress state.
        "paragraph" => validate_text_field(index, object, "text", true),
        "markdown" => validate_text_field(index, object, "text", true),
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
    validate_text_field(index, object, "text", true)
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
    validate_text_field(index, object, "text", true)
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

const SUPPORTED_PANEL_TYPES: &[&str] = &[
    "line",
    "bar",
    "scalar",
    "scatter",
    "parallel_coordinates",
    "run_comparer",
    "markdown_panel",
    "code_panel",
    "image_panel",
];
const SUPPORTED_SCALAR_AGGS: &[&str] = &["min", "max", "mean", "latest"];

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
        // `pinned_run_ids` is optional but if present must be a string array.
        if let Some(pinned) = runset_obj.get("pinned_run_ids") {
            if pinned.is_null() {
                // null is allowed as a sentinel for "no pins".
            } else {
                let pinned_array = pinned.as_array().ok_or_else(|| {
                    AppError::validation(format!(
                        "panel_grid block {index}: runset {runset_index} `pinned_run_ids` must be an array"
                    ))
                })?;
                for entry in pinned_array {
                    let value = entry.as_str().ok_or_else(|| {
                        AppError::validation(format!(
                            "panel_grid block {index}: runset {runset_index} `pinned_run_ids` entries must be strings"
                        ))
                    })?;
                    if value.trim().is_empty() {
                        return Err(AppError::validation(format!(
                            "panel_grid block {index}: runset {runset_index} `pinned_run_ids` entries must be non-empty"
                        )));
                    }
                }
            }
        }
        // `run_settings` (added in v1.2 for the run-set table widget) is an
        // optional map keyed by run id whose values are `{ color?, disabled?,
        // hidden? }`. The widget mutates this map when a user toggles a row's
        // checkbox / eye icon / color dot.
        if let Some(settings) = runset_obj.get("run_settings") {
            if settings.is_null() {
                // Null sentinel allowed.
            } else {
                let settings_obj = settings.as_object().ok_or_else(|| {
                    AppError::validation(format!(
                        "panel_grid block {index}: runset {runset_index} `run_settings` must be an object"
                    ))
                })?;
                for (run_id, entry) in settings_obj {
                    let entry_obj = entry.as_object().ok_or_else(|| {
                        AppError::validation(format!(
                            "panel_grid block {index}: runset {runset_index} `run_settings[{run_id}]` must be an object"
                        ))
                    })?;
                    if let Some(color) = entry_obj.get("color") {
                        if !color.is_null() && !color.is_string() {
                            return Err(AppError::validation(format!(
                                "panel_grid block {index}: runset {runset_index} `run_settings[{run_id}].color` must be a string"
                            )));
                        }
                    }
                    for flag in ["disabled", "hidden"] {
                        if let Some(value) = entry_obj.get(flag) {
                            if !value.is_null() && !value.is_boolean() {
                                return Err(AppError::validation(format!(
                                    "panel_grid block {index}: runset {runset_index} `run_settings[{run_id}].{flag}` must be a boolean"
                                )));
                            }
                        }
                    }
                }
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
        if !SUPPORTED_PANEL_TYPES.contains(&panel_type) {
            return Err(AppError::validation(format!(
                "panel_grid block {index}: panel {panel_index} type `{panel_type}` is not supported"
            )));
        }
        // Every panel references a runset by index — must be present and
        // nonnegative; runset_index out-of-bounds is enforced at render time
        // (so a runset can be removed without immediately invalidating the
        // report).
        let runset_index = panel_obj
            .get("runset_index")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if runset_index < 0 {
            return Err(AppError::validation(format!(
                "panel_grid block {index}: panel {panel_index} `runset_index` must be nonnegative"
            )));
        }
        match panel_type {
            "line" | "bar" | "scalar" => {
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
                if panel_type == "scalar" {
                    let agg = panel_obj
                        .get("agg")
                        .and_then(Value::as_str)
                        .unwrap_or("latest");
                    if !SUPPORTED_SCALAR_AGGS.contains(&agg) {
                        return Err(AppError::validation(format!(
                            "panel_grid block {index}: scalar panel {panel_index} `agg` `{agg}` is not supported"
                        )));
                    }
                }
            }
            "scatter" => {
                let x_metric = panel_obj
                    .get("x_metric")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let y_metric = panel_obj
                    .get("y_metric")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if x_metric.is_empty() || y_metric.is_empty() {
                    return Err(AppError::validation(format!(
                        "panel_grid block {index}: scatter panel {panel_index} requires both `x_metric` and `y_metric`"
                    )));
                }
            }
            "parallel_coordinates" => {
                let dimensions = panel_obj
                    .get("dimensions")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        AppError::validation(format!(
                            "panel_grid block {index}: parallel_coordinates panel {panel_index} requires `dimensions` array"
                        ))
                    })?;
                for (dim_index, dim) in dimensions.iter().enumerate() {
                    let dim_obj = dim.as_object().ok_or_else(|| {
                        AppError::validation(format!(
                            "panel_grid block {index}: parallel_coordinates panel {panel_index} dimension {dim_index} must be an object"
                        ))
                    })?;
                    let metric = dim_obj
                        .get("metric_key")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let config = dim_obj
                        .get("config_key")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if metric.is_empty() && config.is_empty() {
                        return Err(AppError::validation(format!(
                            "panel_grid block {index}: parallel_coordinates panel {panel_index} dimension {dim_index} requires `metric_key` or `config_key`"
                        )));
                    }
                }
            }
            "run_comparer" => {
                let run_ids = panel_obj.get("run_ids").and_then(Value::as_array).ok_or_else(|| {
                    AppError::validation(format!(
                        "panel_grid block {index}: run_comparer panel {panel_index} requires `run_ids` array"
                    ))
                })?;
                for entry in run_ids {
                    if !entry.is_string() {
                        return Err(AppError::validation(format!(
                            "panel_grid block {index}: run_comparer panel {panel_index} `run_ids` entries must be strings"
                        )));
                    }
                }
                let fields = panel_obj.get("fields").and_then(Value::as_array).ok_or_else(|| {
                    AppError::validation(format!(
                        "panel_grid block {index}: run_comparer panel {panel_index} requires `fields` array"
                    ))
                })?;
                for entry in fields {
                    let value = entry.as_str().ok_or_else(|| {
                        AppError::validation(format!(
                            "panel_grid block {index}: run_comparer panel {panel_index} `fields` entries must be strings"
                        ))
                    })?;
                    if value.trim().is_empty() {
                        return Err(AppError::validation(format!(
                            "panel_grid block {index}: run_comparer panel {panel_index} `fields` entries must be non-empty"
                        )));
                    }
                }
            }
            "markdown_panel" => {
                if !panel_obj.get("text").map(Value::is_string).unwrap_or(false) {
                    return Err(AppError::validation(format!(
                        "panel_grid block {index}: markdown_panel {panel_index} requires `text`"
                    )));
                }
            }
            "code_panel" => {
                let language = panel_obj
                    .get("language")
                    .and_then(Value::as_str)
                    .unwrap_or("plain");
                if !SUPPORTED_CODE_LANGUAGES.contains(&language) {
                    return Err(AppError::validation(format!(
                        "panel_grid block {index}: code_panel {panel_index} `language` `{language}` is not supported"
                    )));
                }
                if !panel_obj.get("code").map(Value::is_string).unwrap_or(false) {
                    return Err(AppError::validation(format!(
                        "panel_grid block {index}: code_panel {panel_index} requires `code`"
                    )));
                }
            }
            "image_panel" => {
                let url = panel_obj
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if url.is_empty() {
                    return Err(AppError::validation(format!(
                        "panel_grid block {index}: image_panel {panel_index} requires non-empty `url`"
                    )));
                }
            }
            _ => unreachable!("panel type set is enumerated above"),
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
            "panels": [{ "type": "heatmap", "metric_key": "loss", "runset_index": 0 }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("not supported"));
    }

    #[test]
    fn accepts_bar_scalar_scatter_panels() {
        let blocks = json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "base", "projects": ["proj-a"] }],
            "panels": [
                { "type": "bar", "metric_key": "eval/return_mean", "runset_index": 0, "group_by": "project" },
                { "type": "scalar", "metric_key": "loss", "runset_index": 0, "agg": "mean" },
                { "type": "scatter", "x_metric": "loss", "y_metric": "eval/return_mean", "runset_index": 0 }
            ]
        }]);
        let canonical = validate_blocks(Some(blocks)).expect("blocks ok");
        assert_eq!(
            canonical.as_array().unwrap()[0]["panels"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn bar_panel_requires_metric_key() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "x", "projects": ["p"] }],
            "panels": [{ "type": "bar", "runset_index": 0 }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("metric_key"));
    }

    #[test]
    fn scalar_panel_rejects_unknown_aggregation() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "x", "projects": ["p"] }],
            "panels": [{ "type": "scalar", "metric_key": "loss", "runset_index": 0, "agg": "median" }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("agg"));
    }

    #[test]
    fn scatter_panel_requires_both_axes() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "x", "projects": ["p"] }],
            "panels": [{ "type": "scatter", "x_metric": "loss", "runset_index": 0 }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("x_metric") || err.message().contains("y_metric"));
    }

    #[test]
    fn pinned_run_ids_round_trip_on_runset() {
        let blocks = json!([{
            "kind": "panel_grid",
            "runsets": [{
                "name": "with-pins",
                "projects": ["proj-a"],
                "pinned_run_ids": ["run-uuid-1", "proj-a/baseline"]
            }],
            "panels": [{ "type": "line", "metric_key": "loss", "runset_index": 0 }]
        }]);
        let canonical = validate_blocks(Some(blocks.clone())).expect("blocks ok");
        let runset = &canonical.as_array().unwrap()[0]["runsets"][0];
        let pinned = runset["pinned_run_ids"].as_array().expect("pinned array");
        assert_eq!(pinned.len(), 2);
        assert_eq!(pinned[0].as_str(), Some("run-uuid-1"));
        assert_eq!(pinned[1].as_str(), Some("proj-a/baseline"));
    }

    #[test]
    fn pinned_run_ids_rejects_non_string_entries() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "x", "projects": ["p"], "pinned_run_ids": [42] }],
            "panels": []
        }])))
        .unwrap_err();
        assert!(err.message().contains("pinned_run_ids"));
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
    fn run_settings_round_trip_with_hidden_flag() {
        let blocks = json!([{
            "kind": "panel_grid",
            "runsets": [{
                "name": "rs",
                "projects": ["proj-a"],
                "run_settings": {
                    "run-1": { "color": "#5d89dd", "disabled": false, "hidden": true },
                    "run-2": { "hidden": false, "disabled": true }
                }
            }],
            "panels": []
        }]);
        let canonical = validate_blocks(Some(blocks)).expect("blocks ok");
        let settings = &canonical.as_array().unwrap()[0]["runsets"][0]["run_settings"];
        assert_eq!(settings["run-1"]["hidden"].as_bool(), Some(true));
        assert_eq!(settings["run-1"]["disabled"].as_bool(), Some(false));
        assert_eq!(settings["run-2"]["disabled"].as_bool(), Some(true));
    }

    #[test]
    fn run_settings_rejects_non_boolean_hidden() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{
                "name": "rs",
                "projects": ["p"],
                "run_settings": { "run-1": { "hidden": "yes" } }
            }],
            "panels": []
        }])))
        .unwrap_err();
        assert!(err.message().contains("hidden"));
    }

    #[test]
    fn run_settings_rejects_non_string_color() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{
                "name": "rs",
                "projects": ["p"],
                "run_settings": { "run-1": { "color": 42 } }
            }],
            "panels": []
        }])))
        .unwrap_err();
        assert!(err.message().contains("color"));
    }

    #[test]
    fn parallel_coordinates_panel_round_trips() {
        let blocks = json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{
                "type": "parallel_coordinates",
                "runset_index": 0,
                "dimensions": [
                    { "config_key": "lr" },
                    { "metric_key": "eval/return_mean" }
                ]
            }]
        }]);
        validate_blocks(Some(blocks)).expect("blocks ok");
    }

    #[test]
    fn parallel_coordinates_panel_requires_at_least_one_key_per_dimension() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{
                "type": "parallel_coordinates",
                "runset_index": 0,
                "dimensions": [{ "metric_key": "" }]
            }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("metric_key") || err.message().contains("config_key"));
    }

    #[test]
    fn run_comparer_panel_round_trips() {
        let blocks = json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{
                "type": "run_comparer",
                "runset_index": 0,
                "run_ids": ["run-1", "run-2"],
                "fields": ["config.lr", "summary.val_acc"]
            }]
        }]);
        validate_blocks(Some(blocks)).expect("blocks ok");
    }

    #[test]
    fn run_comparer_rejects_empty_field_strings() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{
                "type": "run_comparer",
                "runset_index": 0,
                "run_ids": ["r-1"],
                "fields": [""]
            }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("fields"));
    }

    #[test]
    fn markdown_code_image_panels_round_trip() {
        let blocks = json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [
                { "type": "markdown_panel", "text": "## hello" },
                { "type": "code_panel", "code": "x = 1", "language": "python" },
                { "type": "image_panel", "url": "https://example.com/x.png", "caption": "fig 1" }
            ]
        }]);
        validate_blocks(Some(blocks)).expect("blocks ok");
    }

    #[test]
    fn markdown_panel_requires_text_field() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{ "type": "markdown_panel" }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("text"));
    }

    #[test]
    fn code_panel_rejects_unknown_language() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{ "type": "code_panel", "code": "x", "language": "brainfuck" }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("language"));
    }

    #[test]
    fn image_panel_requires_url() {
        let err = validate_blocks(Some(json!([{
            "kind": "panel_grid",
            "runsets": [{ "name": "rs", "projects": ["p"] }],
            "panels": [{ "type": "image_panel", "url": "" }]
        }])))
        .unwrap_err();
        assert!(err.message().contains("url"));
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
