# Agent Run Analysis

This guide describes the current MCP tools an agent should use to inspect,
compare, and export InstantML runs. The tools are thin wrappers around the Rust
API in `apps/rust-server`; they require `INSTANTML_API_URL` and an API key with
`export:read`.

```bash
INSTANTML_API_URL=https://api.instantml.ai \
INSTANTML_API_KEY=instantml_... \
node tools/mcp-server.mjs
```

## Tools

| Tool | Purpose |
| --- | --- |
| `tracker.list_runs` | Search and page run summaries. Use `project`, `query`, `status`, `sort_by`, `metric_key`, `cursor`, and `limit`. |
| `tracker.get_run` | Fetch one run summary by UUID. |
| `tracker.list_metrics` | List a run's metric keys with latest/min/max/mean summary values. |
| `tracker.query_metrics` | Fetch bounded metric points for one run/key, optionally with `start_step`/`end_step`. Legacy `since_step`/`until_step` arguments are accepted by the tool and mapped to the Rust API. |
| `tracker.get_metric_series_batch` | Fetch bounded series for one metric across many run IDs through `POST /api/metrics/series`. |
| `tracker.compare_runs` | Compare up to 50 selected runs through `GET /api/runs/side-by-side`. |
| `tracker.export_runs` | Export selected or filtered runs as bounded JSON or CSV through `GET /api/export`. |
| `tracker.workspace_view_data` | Resolve a portable workspace-view payload plus explicit run IDs into bounded panel data. |

## Recommended Flow

1. Call `tracker.list_runs` with a narrow `project`, `query`, and `sort_by`.
   For best-run searches, use `sort_by: "metric-best"` plus `metric_key`.
2. Read the returned `runs[]`, `metric_keys`, `total`, and `next_cursor`.
   Follow `next_cursor` only when the first page does not contain enough
   candidates.
3. Call `tracker.list_metrics` on one or two representative runs when the
   metric key is unknown.
4. Call `tracker.get_metric_series_batch` for the selected metric and candidate
   run IDs. Keep `limit` modest unless the user asked for curve detail.
5. Call `tracker.compare_runs` only after narrowing to at most 50 run IDs. This
   endpoint is for detailed selected-run diffs, not broad project-wide ranking.
6. Use `tracker.export_runs` when the user asks for portable evidence or wants
   data for a notebook/spreadsheet.

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

Export selected evidence:

```js
await call("tracker.export_runs", {
  run_ids: ["run-uuid-1", "run-uuid-2"],
  format: "json",
});
```
