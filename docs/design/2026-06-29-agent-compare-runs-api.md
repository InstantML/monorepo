# Design: Agent Compare Runs API

Date: 2026-06-29

Status: Reviewed, accepted first slice

Owner: Codex

## Summary

Agents can already list runs, fetch batched metric series, compare up to 50
selected runs, export bounded data, and resolve workspace-view data. The missing
piece is a single server-side workflow for broad analytical comparison: "find
the best or most interesting matching runs, compare their key differences, and
return bounded evidence".

This design proposes a narrow read-only endpoint that turns a filtered run
query into an exact capped candidate set and a compact compare payload. It
should help agents answer common questions without manually paging through
thousands of runs or pulling metric history unnecessarily.

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
  "include_rows": true
}
```

Behavior:

1. Authorize with `export:read`; project-scoped API keys only see their project.
2. Apply the same filters and run search grammar as `/api/runs/summary`.
3. Sort using the same sort keys: `created`, `name`, `status`, `duration`,
   `metric-latest`, and `metric-best`, but compute the exact top-k within the
   effective visible candidate set. Do not reuse the org-wide metric-sort fast
   path unless it has already been constrained to the effective project/filter
   scope.
4. Cap `limit` to 50 so the compare row payload remains bounded.
5. Hydrate summaries only for selected candidates, and for metric-sort requests
   hydrate the requested `metric_key` by default instead of every metric key.
6. Build projected compare rows for config, metadata, tags, attributes, and the
   requested metric summary. Apply `diff_only` before the row cap and report
   accurate truncation.
7. Defer metric series previews to the existing `tracker.get_metric_series_batch`
   / `POST /api/metrics/series` contract in this first slice.

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
  "candidates": [
    {
      "rank": 1,
      "run_id": "uuid",
      "sort_value": 712.4,
      "sort_mode": "max",
      "metric_key": "eval/return_mean",
      "metric_count": 20000,
      "latest_step": 19999,
      "best_step": 18720,
      "missing_metric": false,
      "selection_reason": "selected"
    }
  ],
  "runs": [],
  "rows": [],
  "reference_run_id": "uuid",
  "limits": {
    "runs": 50,
    "rows": 5000
  },
  "truncated": {
    "runs": true,
    "rows": false
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
- `include_rows` default: `true`; callers can request candidate selection
  evidence only by setting it to `false`.
- `diff_only` default: `false`.

Reference behavior:

- `reference_run_id`, when supplied, must be visible to the caller and in the
  effective project scope. Invisible or out-of-project references return `404`
  to avoid leaking run existence.
- If the visible reference is outside the selected top-k candidate list, it is
  appended as reference context and counts against the 50-run compare cap by
  replacing the last selected candidate when needed. The corresponding
  `candidates[]` row uses `selection_reason: "reference"`.

Errors:

- `400` for invalid search syntax, sort key, metric key, or limits.
- `401` for missing auth.
- `403` for missing scope or project access.
- `404` when an explicit `reference_run_id` is missing, inaccessible, or outside
  the effective project scope.

## Performance Considerations

- Candidate selection should use existing run filtering/search helpers, but the
  selected candidate order must be exact within the filtered visible set.
- Metric sorts should use the existing ClickHouse aggregate queries.
- Response size is bounded by 50 selected runs and 5,000 compare rows.
- The endpoint must not fetch full metric history by default.
- Benchmark with the existing 100,000-run large-run dataset:
  - top 20 by created
  - top 20 by `metric-best`
  - filtered search plus `metric-best`
  - sparse project/filter case where matching runs are not globally top-ranked

Latency target:

- p95 under 750 ms for top-20 query compare on the hosted benchmark path.

## Simplicity Review

The design reuses accepted primitives: run search, summary sort semantics, and
side-by-side row semantics. It avoids a new query language, new table, or
frontend state model. The first slice chooses an exact bounded candidate set and
returns selection evidence plus projected compare rows. Metric series preview is
deferred to the existing batched metric-series tool to keep the API easier to
reason about.

Deferred:

- Group-by comparisons.
- Statistical summaries across all matching runs.
- Virtualized compare over more than 50 runs.
- Agent-authored saved views/reports from this endpoint.
- Inline metric series preview.

## Failure Modes

- Search syntax invalid: return the existing structured run-search validation
  error.
- Too many requested runs: reject explicit `limit > 50` for clear agent
  behavior.
- Metric sort has sparse coverage: selected rows with missing metric sort after
  rows with values, matching current summary behavior.
- Reference run not in selected candidates: include it only if visible and
  within the effective project scope. It replaces the last selected candidate
  if including it would exceed the 50-run cap, and the response marks it as
  `selection_reason: "reference"`.

## Testing Plan

- Unit tests for request validation, row truncation, reference handling, and
  exact candidate selection limits.
- API tests for auth scope, project-scoped API keys, invalid search, metric sort
  selection, reference behavior, and diff-only rows.
- Contract smoke coverage for route shape.
- Sparse metric-sort test where another project or filtered-out cohort dominates
  the org-wide metric leaderboard, proving exact filtered top-k.
- Large-run benchmark case for top-k query compare.
- OpenAPI/codegen drift check.

## Documentation Plan

- `apps/rust-server/README.md`: route list, limits, and route ownership.
- `docs/architecture/current-api.md`: endpoint contract.
- `docs/sdk/agent-run-analysis.md`: recommended use from MCP after the route is
  wrapped.
- `tools/mcp-server.mjs` and `tools/mcp-server-tools.mjs`: add
  `tracker.compare_matching_runs` only after the backend endpoint ships.

MCP wrapper:

```json
{
  "name": "tracker.compare_matching_runs",
  "input": {
    "project": "cartpole",
    "query": "tag:baseline status:finished",
    "status": "finished",
    "sort_by": "metric-best",
    "metric_key": "eval/return_mean",
    "limit": 20,
    "reference_run_id": "uuid",
    "diff_only": true,
    "include_rows": true
  }
}
```

The MCP tool maps `query` to API `q`, forwards the same bounded options, and
returns the endpoint JSON as text. Agents should use
`tracker.get_metric_series_batch` for curve detail after this tool selects
candidates.

## Alternatives Considered

- Use only `tracker.list_runs` plus `tracker.compare_runs`: works today, but
  agents must page and decide candidate selection client-side.
- Raise `GET /api/runs/side-by-side` above 50 runs: rejected because the payload
  is wide and detailed.
- Add arbitrary analytical SQL: rejected because it creates security, tenancy,
  and performance risk.

## Review Notes

Fresh reviewer 1:

- Finding: Candidate ranking needs an exact top-k contract; row truncation must
  be truthful; reference behavior and series-preview scope were underspecified.
- Recommended edit: Require exact filtered top-k, compute real row truncation,
  define reference counting, and defer or reuse the existing series contract.
- Decision: Accepted. The first slice now requires exact scoped candidate
  ranking, projected compare rows, accurate `truncated.rows`, explicit reference
  behavior, and no inline series preview.

Fresh reviewer 2:

- Finding: Project-scoped metric ranking can be wrong if org-wide leaderboard
  results are filtered after ranking; compact payloads should not blindly reuse
  side-by-side; the MCP contract and candidate evidence were missing.
- Recommended edit: Define effective project/filter scope before ranking, add
  candidate evidence, choose 404 reference semantics, and write the MCP schema.
- Decision: Accepted. The API now returns `candidates[]` selection evidence,
  treats inaccessible/out-of-scope references as 404, and documents the exact
  MCP wrapper schema.

## Approval

Approved for the first implementation slice after the two high-severity review
items were incorporated. The implementation must preserve the exact top-k and
truthful truncation guarantees above before the PR can be considered complete.
