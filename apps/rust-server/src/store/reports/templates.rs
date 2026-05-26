//! Baked-in templates that pre-populate a new report with a sensible
//! scaffolding. V1 ships exactly one template — the ablation showcase —
//! covering the workflow surfaced in the wiki spec (hypothesis → live
//! panels → LLM-driven conclusions). v1.5 will add sweep summary, weekly
//! update, model card, and paper supplement.

use serde_json::{json, Value};

pub(super) fn ablation_template_blocks(report_title: &str) -> Value {
    let scoped_title = if report_title.trim().is_empty() {
        "<fill in>".to_string()
    } else {
        report_title.to_string()
    };
    json!([
        {
            "kind": "heading",
            "level": 1,
            "text": format!("Ablation: {scoped_title}")
        },
        {
            "kind": "markdown",
            "text": "**Hypothesis:** _State the variable you're isolating and the expected effect on the primary metric._\n\n**Setup:** _Datasets, model, training budget, seeds._"
        },
        {
            "kind": "panel_grid",
            "runsets": [
                {
                    "name": "baseline",
                    "projects": [],
                    "filters": null,
                    "groupby": null,
                    "limit": 50
                },
                {
                    "name": "ablation",
                    "projects": [],
                    "filters": null,
                    "groupby": null,
                    "limit": 50
                }
            ],
            "panels": [
                {
                    "type": "line",
                    "metric_key": "loss",
                    "runset_index": 0,
                    "smoothing": null
                }
            ]
        },
        {
            "kind": "llm_summary",
            "panelgrid_index": 2,
            "angle": "what-worked"
        },
        {
            "kind": "heading",
            "level": 2,
            "text": "Conclusions"
        },
        {
            "kind": "paragraph",
            "text": "_Write up what worked, what didn't, and what to try next._"
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ablation_template_has_expected_block_shape() {
        let blocks = ablation_template_blocks("Batch-size ablation");
        let array = blocks.as_array().unwrap();
        assert_eq!(array.len(), 6);
        assert_eq!(array[0]["kind"], "heading");
        assert_eq!(array[2]["kind"], "panel_grid");
        assert_eq!(array[3]["kind"], "llm_summary");
        // The llm_summary should reference the panel_grid at index 2.
        assert_eq!(array[3]["panelgrid_index"], 2);
        // Cross-project runset structure should be present even if empty.
        let projects = array[2]["runsets"][0]["projects"].as_array().unwrap();
        assert!(projects.is_empty());
    }
}
