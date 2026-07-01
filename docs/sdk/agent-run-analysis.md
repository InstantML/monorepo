# Agent Run Analysis

This guide describes the current MCP tools an agent should use to inspect,
compare, and export InstantML runs. The tools are thin wrappers around the Rust
API in `apps/rust-server`; hosted consumers should connect to
`https://mcp.instantml.ai/mcp` with an InstantML API key that has `export:read`.

Local preview from a repository checkout still uses stdio:

```bash
INSTANTML_API_KEY=instantml_... \
node tools/mcp-server.mjs
```

## Tools

| Tool | Purpose |
| --- | --- |
| `tracker.list_projects` | List projects visible to the caller before choosing a project for run searches. |
| `tracker.list_runs` | Search and page run summaries. Use `project`, `query`, `status`, `sort_by`, `metric_key`, `cursor`, and `limit`. |
| `tracker.compare_matching_runs` | Rank matching runs through `POST /api/runs/compare-query` and return selected candidate evidence, run summaries, and optional side-by-side difference rows. |
| `tracker.get_run` | Fetch one run summary by UUID. |
| `tracker.list_metrics` | List a run's metric keys with latest/min/max/mean summary values. |
| `tracker.query_metrics` | Fetch bounded metric points for one run/key, optionally with `start_step`/`end_step`. Legacy `since_step`/`until_step` arguments are accepted by the tool and mapped to the Rust API. |
| `tracker.get_metric_series_batch` | Fetch bounded series for one metric across many run IDs through `POST /api/metrics/series`. |
| `tracker.compare_runs` | Compare up to 50 already selected runs through `GET /api/runs/side-by-side`. |
| `tracker.get_run_lineage` | Fetch direct parent/fork lineage for one run. |
| `tracker.list_run_artifacts` | List raw artifact metadata attached to one run. |
| `tracker.list_run_artifact_edges` | List versioned artifact input/output edges for one run. |
| `tracker.list_artifact_collections` | Discover versioned artifact collections by project, type, and name search; use `type: "checkpoint"` for checkpoints. |
| `tracker.get_artifact_version` | Fetch one versioned artifact by UUID. |
| `tracker.list_artifact_versions` | List available versions in an artifact collection. |
| `tracker.resolve_artifact_version` | Resolve an artifact reference such as `policy:latest` or `checkpoint/policy:best`. |
| `tracker.list_artifact_manifest` | Page manifest entries for a versioned artifact. |
| `tracker.get_artifact_lineage` | Fetch versioned artifact producer/consumer lineage. |
| `tracker.export_runs` | Export selected or filtered runs as bounded JSON or CSV through `GET /api/export`. |
| `tracker.workspace_view_data` | Resolve a portable workspace-view payload plus explicit run IDs into bounded panel data. |
| `tracker.export_report_markdown` | Export an InstantML report as Markdown text when the user wants a portable narrative artifact. |

## Recommended Flow

1. Call `tracker.list_projects` when the user has not named a project or when
   you need to confirm project names.
2. Call `tracker.list_runs` with a narrow `project`, `query`, and `sort_by`.
   For best-run searches, use `sort_by: "metric-best"` plus `metric_key`.
3. Read the returned `runs[]`, `metric_keys`, `total`, and `next_cursor`.
   Follow `next_cursor` only when the first page does not contain enough
   candidates.
4. Call `tracker.list_metrics` on one or two representative runs when the
   metric key is unknown.
5. Call `tracker.get_metric_series_batch` for the selected metric and candidate
   run IDs. Keep `limit` modest unless the user asked for curve detail.
6. Call `tracker.compare_matching_runs` when the user asks to compare the top
   matching runs and you do not already have the exact run IDs. It applies the
   same filters and metric sort as `tracker.list_runs`, returns `candidates[]`
   explaining why each run was selected, and can include bounded diff rows.
7. Call `tracker.compare_runs` only after narrowing to at most 50 exact run IDs.
   This endpoint is for detailed selected-run diffs, not broad project-wide
   ranking.
8. Use artifact tools when the user asks about checkpoints, model files,
   datasets, run inputs/outputs, or lineage:
   `tracker.list_run_artifacts` for legacy run artifacts,
   `tracker.list_artifact_collections` plus `tracker.list_artifact_versions`
   for versioned checkpoints, and `tracker.get_artifact_lineage` or
   `tracker.list_run_artifact_edges` for producer/consumer relationships.
9. Use `tracker.export_runs` when the user asks for portable evidence or wants
   data for a notebook/spreadsheet.
10. Use `tracker.export_report_markdown` when the user asks for a Markdown copy
    of an existing report or wants to include a shared report in another
    document.

## Search Examples

```text
tag:baseline status:finished
notes:"reward stability" -tag:debug
(tag:baseline OR tag:candidate) config:lr
re:/seed-(13|14)/
```

Bare text is still useful: `seed 13 reward` searches name, tags, notes, config,
metadata, status, project, and ID as implicit `AND` terms.

## Limits To Preserve

- `tracker.list_runs`: page size is capped by the Rust API at 1,000 rows.
- `tracker.get_metric_series_batch`: max 2,000 run IDs and server-capped total
  returned points.
- `tracker.compare_runs`: max 50 run IDs and 5,000 compare rows.
- `tracker.workspace_view_data`: max 100 run IDs, 50 panels, 500 points per
  series, and 50,000 total metric points.
- `tracker.export_runs`: selected-run export accepts at most 100 exact run IDs.

## Common Patterns

Find best finished runs:

```js
await call("tracker.list_runs", {
  project: "cartpole",
  query: "tag:baseline status:finished",
  sort_by: "metric-best",
  metric_key: "eval/return_mean",
  limit: 25,
});
```

Compare candidate configs and summaries:

```js
await call("tracker.compare_matching_runs", {
  project: "cartpole",
  query: "tag:baseline status:finished",
  sort_by: "metric-best",
  metric_key: "eval/return_mean",
  limit: 5,
  diff_only: true,
});
```

Compare exact selected configs and summaries:

```js
await call("tracker.compare_runs", {
  run_ids: ["run-uuid-1", "run-uuid-2"],
  reference_run_id: "run-uuid-1",
  diff_only: true,
});
```

Fetch curves for selected runs:

```js
await call("tracker.get_metric_series_batch", {
  run_ids: ["run-uuid-1", "run-uuid-2"],
  key: "eval/return_mean",
  limit: 500,
  buckets: 256,
});
```

Find checkpoint lineage:

```js
const collections = await call("tracker.list_artifact_collections", {
  project: "cartpole",
  type: "checkpoint",
  query: "policy",
  limit: 10,
});
await call("tracker.list_artifact_versions", {
  collection_id: collections.collections[0].id,
  limit: 5,
});
```

Export selected evidence:

```js
await call("tracker.export_runs", {
  run_ids: ["run-uuid-1", "run-uuid-2"],
  format: "json",
});
```
