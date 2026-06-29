# Design: Agent Compare Runs API

Date: 2026-06-29

Status: Draft, awaiting fresh-agent review

Owner: Codex

## Summary

Agents can already list runs, fetch batched metric series, compare up to 50
selected runs, export bounded data, and resolve workspace-view data. The missing
piece is a single server-side workflow for broad analytical comparison: "find
the best or most interesting matching runs, compare their key differences, and
return bounded evidence".

This design proposes a narrow read-only endpoint that turns a filtered run
query into a capped candidate set and a compact compare payload. It should help
agents answer common questions without manually paging through thousands of
runs or pulling metric history unnecessarily.

## Goals

- Let agents compare filtered runs without first downloading many pages.
- Reuse the existing run search grammar, metric summary tables, and side-by-side
  row model.
- Keep the first slice read-only, bounded, and API-key compatible.
- Return enough evidence for an agent to explain why candidate runs were chosen.
- Preserve the existing detailed `GET /api/runs/side-by-side` endpoint for
  explicit selected-run diffs.

## Non-Goals

- No new database table or background indexer.
- No unbounded metric history fetch.
- No arbitrary SQL, expression language, or notebook-like compute endpoint.
- No mutation or agent-authored annotations in this slice.
- No frontend screen in the first slice.

## Users and Use Cases

Agents and automation need to answer:

- "Find the best 20 finished runs matching `tag:baseline` by
  `eval/return_mean` and summarize what changed."
- "Compare failed runs against the best successful run and identify config
  differences."
- "Select the top candidates for a report without paging through a 100,000-run
  project."

## Proposed Design

Add a Rust data-plane endpoint:

```http
POST /api/runs/compare-query
Authorization: Bearer instantml_...
Content-Type: application/json
```

Request:

```json
{
  "project": "cartpole",
  "q": "tag:baseline status:finished",
  "status": "finished",
  "sort_by": "metric-best",
  "metric_key": "eval/return_mean",
  "limit": 20,
  "reference_run_id": "optional-uuid",
  "diff_only": true,
  "include_series_preview": false,
  "series_limit": 200
}
```

Behavior:

1. Authorize with `export:read`; project-scoped API keys only see their project.
2. Apply the same filters and run search grammar as `/api/runs/summary`.
3. Sort using the same sort keys: `created`, `name`, `status`, `duration`,
   `metric-latest`, and `metric-best`.
4. Cap `limit` to 50 so the response can reuse the selected-run side-by-side
   model safely.
5. Hydrate summaries only for selected candidates.
6. Build compare rows using the same helper behind `GET /api/runs/side-by-side`.
7. Optionally include a small metric series preview for the chosen `metric_key`
   only, capped by `series_limit`.

Response:

```json
{
  "query": {
    "project": "cartpole",
    "q": "tag:baseline status:finished",
    "sort_by": "metric-best",
    "metric_key": "eval/return_mean"
  },
  "total_matching_runs": 423,
  "selected_run_ids": ["uuid"],
  "runs": [],
  "rows": [],
  "reference_run_id": "uuid",
  "metric_series_preview": [],
  "limits": {
    "runs": 50,
    "rows": 5000,
    "series_limit": 200
  },
  "truncated": {
    "runs": true,
    "rows": false,
    "series": false
  }
}
```

## Component Impact

Backend:

- Add a new Rust handler in `apps/rust-server`.
- Factor the selected-run side-by-side builder so it can be called from both
  explicit selected-run compare and query compare.
- Register the route in OpenAPI and regenerate API types.

Frontend:

- No first-slice UI changes.

Python SDK:

- No first-slice SDK wrapper unless a later design expands the public `Api`
  query client.

Storage:

- No schema changes.

Docs:

- Update `docs/architecture/current-api.md`, `apps/rust-server/README.md`, and
  the MCP agent run-analysis guide after implementation.

## Data Model

No persisted model changes.

## API Contracts

New endpoint:

- `POST /api/runs/compare-query`
- Auth: bearer API key or browser session with tenant read access and
  `export:read`.
- Request body is bounded JSON, reusing existing filter names.
- `limit` default: 20. Max: 50.
- `series_limit` default: 0 unless `include_series_preview=true`. Max: 500.

Errors:

- `400` for invalid search syntax, sort key, metric key, or limits.
- `401` for missing auth.
- `403` for missing scope or project access.
- `404` only when an explicit `reference_run_id` is missing or inaccessible.

## Performance Considerations

- Candidate selection should use the existing indexed run-summary query paths.
- Metric sorts should use the existing ClickHouse aggregate queries.
- Response size is bounded by 50 selected runs, 5,000 compare rows, and optional
  preview series capped to 50 * 500 points.
- The endpoint must not fetch full metric history by default.
- Benchmark with the existing 100,000-run large-run dataset:
  - top 20 by created
  - top 20 by `metric-best`
  - filtered search plus `metric-best`
  - optional preview series

Latency target:

- p95 under 750 ms for top-20 query compare on the hosted benchmark path.

## Simplicity Review

The design reuses accepted primitives: run search, summary sort, side-by-side
rows, and batched series. It avoids a new query language, new table, or
frontend state model. The first slice only chooses a bounded candidate set and
returns evidence.

Deferred:

- Group-by comparisons.
- Statistical summaries across all matching runs.
- Virtualized compare over more than 50 runs.
- Agent-authored saved views/reports from this endpoint.

## Failure Modes

- Search syntax invalid: return the existing structured run-search validation
  error.
- Too many requested runs: clamp only if documented in response limits, or
  reject if the caller explicitly requested above max. Prefer reject for clear
  agent behavior.
- Metric sort has sparse coverage: selected rows with missing metric sort after
  rows with values, matching current summary behavior.
- Reference run not in selected candidates: include it only if visible and
  within the same org/project scope, and mark it as extra reference context.

## Testing Plan

- Unit tests for request validation and candidate selection limits.
- API tests for auth scope, project-scoped API keys, invalid search, metric sort
  selection, reference behavior, and diff-only rows.
- Contract smoke coverage for route shape.
- Large-run benchmark case for top-k query compare.
- OpenAPI/codegen drift check.

## Documentation Plan

- `apps/rust-server/README.md`: route list, limits, and route ownership.
- `docs/architecture/current-api.md`: endpoint contract.
- `docs/sdk/agent-run-analysis.md`: recommended use from MCP after the route is
  wrapped.
- `tools/mcp-server.mjs` and `tools/mcp-server-tools.mjs`: add
  `tracker.compare_matching_runs` only after the backend endpoint ships.

## Alternatives Considered

- Use only `tracker.list_runs` plus `tracker.compare_runs`: works today, but
  agents must page and decide candidate selection client-side.
- Raise `GET /api/runs/side-by-side` above 50 runs: rejected because the payload
  is wide and detailed.
- Add arbitrary analytical SQL: rejected because it creates security, tenancy,
  and performance risk.

## Review Notes

Fresh reviewer 1:

- Pending. This draft exists so fresh reviewers can evaluate the API before
  implementation.

Fresh reviewer 2:

- Pending. This draft exists so fresh reviewers can evaluate the API before
  implementation.
