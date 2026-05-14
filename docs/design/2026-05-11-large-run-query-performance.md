# Design: Large Run Query Performance

Date: 2026-05-11

Status: Implemented first slice

Owner: Codex

## Summary

Training Observability should win on speed in the daily run-browsing workflow. Design-partner feedback called out a W&B project with roughly 90,000 runs taking seconds to load. The current app already calls the Rust-backed `GET /api/runs/summary` route with server-side filters, search, sort, totals, and page-scoped summaries, but the implementation still uses offset pagination, index-hostile token predicates, and no large-project performance gate.

This design keeps the existing summary endpoint and response shape compatible, then adds cursor pagination, targeted indexes, indexable search predicates, a compact Python `Api.runs()` client, frontend cursor navigation, and a Rust/Postgres/ClickHouse scale benchmark. The smallest useful version does not add a new query language or a separate search service. It makes the existing Runs workspace credible for a 90,000-run project while preserving local Node compatibility for old route shapes.

## Goals

- Keep `/api/runs/summary` as the main UI and SDK run-query route.
- Add keyset cursor pagination for deep 90,000-run browsing while keeping `offset` for compatibility.
- Keep run list responses summary-only: run identity, tags, notes, config, maintained metric summaries, and artifact counts for page rows only.
- Add indexes for the sorts and filters used by the Runs workspace.
- Make search predicates indexable enough for name, tag, note, and config text searches at the target scale.
- Add a Python `Api.runs()` first slice that maps directly to the Rust route.
- Update the web app to use cursor navigation for Next/Previous page controls.
- Add a repeatable Rust/Postgres/ClickHouse benchmark that reports 90,000-run first-page, search, sort, and chart timings.

## Non-Goals

- Do not build a full W&B public API surface in this slice.
- Do not add a separate search service, materialized search table, Redis cache, or background indexing job.
- Do not implement arbitrary filter grammar, config-key operators, or regex search.
- Do not remove offset pagination yet; deprecated Node compatibility and old saved views may still use it.
- Do not make quick search org-wide in this slice. The Runs workspace search is the primary speed gate.
- Do not solve workspace panel series fan-out with a batch-series endpoint here; that remains a separate P0 frontend scale item.

## Users and Use Cases

Primary users are researchers and ML platform engineers with large projects:

- Browse the newest page of a 90,000-run project without waiting for full-project data.
- Search by run name, tags, notes, and config text such as `seed 13` or `reward stability`.
- Sort by newest, name, status, duration, and selected metric latest/best values.
- Page through runs while selected off-page runs stay available for Run Detail and Compare.
- Query the same run pages from Python scripts without scraping UI routes.

## Proposed Design

### Backend

Keep `GET /api/runs/summary` and `GET /runs` routed through the same bounded run query logic. Add an optional `cursor` query parameter. When `cursor` is present, it takes precedence over `offset` and returns the next keyset page after the encoded last row from the previous page.

Cursor tokens are opaque, URL-safe base64 JSON values with:

```json
{
  "v": 1,
  "sort_by": "created",
  "metric_key": "eval/return_mean",
  "filter_hash": "sha256-base64url-of-normalized-query-and-auth-scope",
  "values": {
    "created_at": "2026-05-11T00:00:00Z",
    "id": "..."
  }
}
```

The server validates that the cursor `sort_by`, `metric_key`, and `filter_hash` match the current query. A mismatch returns `400` instead of silently mixing order contracts. The hash is a correctness guard, not an authorization mechanism. Authorization is still enforced by normal `org_id` and project-scope predicates. The cursor never contains raw org IDs, project IDs, names, tags, notes, API keys, or raw search text. Cursor length is capped before decode, and JSON type validation is strict.

The normalized hash input includes cursor schema version, auth org and restricted project scope, effective project filter after resolving `project` or `project_id`, status, normalized escaped search tokens, sort field, metric key, and page limit.

Each supported sort has a stable order, cursor values, and keyset predicate:

- `created`: cursor `{created_at, id}`; order `created_at desc, id desc`; predicate `created_at < cursor.created_at or (created_at = cursor.created_at and id < cursor.id)`.
- `name`: cursor `{name, id}` where `name` is lowercase; order `lower(name) asc, id asc`; predicate `lower(name) > cursor.name or (lower(name) = cursor.name and id > cursor.id)`.
- `status`: cursor `{status, name, id}`; order `status asc, lower(name) asc, id asc`; predicate walks status, then name, then id.
- `duration`: cursor `{duration, created_at, id}`; order `duration desc nulls last, created_at desc, id desc`. If cursor duration is non-null, rows after are non-null durations below the cursor, ties after the cursor by created/id, plus null-duration rows. If cursor duration is null, rows after are null-duration ties after the cursor by created/id.
- `metric-latest`: cursor `{value, created_at, id}`; order `latest desc nulls last, created_at desc, id desc`. If cursor value is non-null, rows after are non-null values below the cursor, ties after the cursor by created/id, plus rows missing the metric. If cursor value is null, rows after are missing-metric ties after the cursor by created/id.
- `metric-best`: same cursor and null handling as `metric-latest`, using `metric_series.max` for this slice.

Metric minimize semantics remain a follow-up until summary policy support lands. The UI already labels the chosen metric objective, but the server stores only `max`/`latest` today and cannot safely infer every custom metric direction.

For search, replace the current `not exists` token predicate with a small fixed set of indexable `LIKE` clauses. The server still caps token count. Each token is escaped for `LIKE`, and all tokens must match `runs.search_text`. Short tokens under three characters, such as `13`, are still allowed for UX parity but are explicitly benchmarked because trigram indexes are less helpful for them.

The run-list query should resolve `project` names to `project_id` before querying `runs`, then build SQL with direct predicates for present filters instead of nullable `OR` clauses on the hot path. Project-scoped API keys add the restricted project predicate before pagination and before cursor predicates.

The summary route should fetch `limit + 1` rows to compute `next_cursor`, then hydrate summaries for only the returned page rows. The route keeps `total` as an exact count for now so existing UI copy stays useful. The benchmark gate measures the full route cost, including count and metric-key discovery. If either dominates latency, this slice must add `include_total` / `include_metric_keys` flags or split metric catalog discovery before marking the 90,000-run gate complete.

Metric-key discovery stays in the summary response for compatibility, but the benchmark will report it separately. If it becomes the bottleneck at 90,000 runs, split metric catalog discovery into its own route in a follow-up design.

### Frontend

The Runs workspace keeps the same controls. Internally, it stores cursor history:

- Page index 0 has no cursor and sends `offset=0` for compatibility.
- A successful Rust response exposes `next_cursor` and `page_info.has_next_page`.
- Next page stores the current page's `next_cursor` in a cursor stack and increments local `pageIndex`.
- Previous page pops back to the prior cursor and decrements local `pageIndex`.
- If a backend does not return `next_cursor`, the UI falls back to existing offset pagination so deprecated Node compatibility smokes keep working.
- Changing project, status, query, sort, metric key, or page size clears cursor history.

The UI continues to show `1-25 of 90,000` style ranges using `pageIndex * pageSize` plus the exact `total` returned by the backend. Saved views keep `pageSize`, filters, and sort state; they do not persist opaque cursor tokens because cursors are temporary positions inside a changing dataset.

### Python SDK

Add a compact `Api` class:

```python
api = rl_observability.Api(base_url="http://127.0.0.1:8000", api_key="...")
page = api.runs(project="demo", q="seed 13", sort_by="metric-best", metric_key="eval/return_mean")
```

`Api.runs()` returns the raw summary payload dict and accepts `cursor`, `limit`, `offset`, `project`, `project_id`, `status`, `q`, `sort_by`, and `metric_key`. It omits `None` and empty-string parameters. `cursor` and nonzero `offset` are mutually exclusive client-side. It reuses the existing `Client` request behavior for auth, timeouts, JSON validation, and `RlobsError`. This is deliberately a raw read-only helper, not the full future public API client.

## Component Impact

Backend:

- Add a migration with run-query indexes.
- Update `store.rs` run query helpers, cursor validation/encoding, tests, and benchmark support.
- Update OpenAPI placeholder docs enough to mention cursor query support.

Frontend:

- Update Runs workspace page state to call `/api/runs/summary` with `cursor` for Next/Previous navigation.
- Keep selected-run detail hydration for off-page selections.
- Extend smoke tests to assert cursor requests and page navigation still work.

Python SDK:

- Add `Api` class and tests for query-string construction, auth reuse, and returned payload.
- Export `Api` from `rl_observability`.

Storage:

- Add indexes for lower-name sort, status/name sort, duration sort helper expression, created tie-breakers, and metric latest/best sort joins.
- Keep existing `runs.search_text` trigger and trigram index.

Docs:

- Update root, Rust, web, SDK, and tools READMEs.
- Update TODOs to mark the first 90,000-run speed/query slice complete only after benchmark results are recorded.

## Data Model

No new tables.

Add migration `0003_large_run_query_indexes.sql`:

```sql
create index if not exists runs_org_created_id_idx
  on runs (org_id, created_at desc, id desc);

create index if not exists runs_org_project_created_id_idx
  on runs (org_id, project_id, created_at desc, id desc);

create index if not exists runs_org_project_name_id_idx
  on runs (org_id, project_id, lower(name), id);

create index if not exists runs_org_project_status_name_id_idx
  on runs (org_id, project_id, status, lower(name), id);

create index if not exists runs_org_project_duration_created_id_idx
  on runs (
    org_id,
    project_id,
    (extract(epoch from (finished_at - started_at))) desc nulls last,
    created_at desc,
    id desc
  );

create index if not exists metric_series_org_key_latest_run_idx
  on metric_series (org_id, key, latest desc nulls last, run_id);

create index if not exists metric_series_org_key_max_run_idx
  on metric_series (org_id, key, max desc nulls last, run_id);
```

The implementation must benchmark both the default org-wide UI path and the project-scoped 90,000-run path. If org-wide plans miss budget, add org-wide variants for the affected sort before completion.

## API Contracts

`GET /api/runs/summary`

Query parameters:

- Existing: `project`, `project_id`, `status`, `q`, `limit`, `offset`, `sort_by`, `metric_key`.
- New: `cursor`.

Response adds:

```json
{
  "runs": [],
  "limit": 25,
  "offset": 0,
  "total": 90000,
  "metric_keys": ["eval/return_mean"],
  "next_cursor": "opaque-or-null",
  "page_info": {
    "pagination": "cursor",
    "page_index": 0,
    "has_next_page": true
  }
}
```

`next_cursor` is `null` when there is no next page. Old clients may ignore the new fields.

`GET /runs` may also return `next_cursor` and `page_info`, but it is not the preferred public query surface because it lacks hydrated summaries.

`Api.runs()` in the Python SDK maps to `/api/runs/summary` and returns the decoded JSON dict.

## Performance Considerations

- Expected target project: 90,000 runs, realistic names/tags/notes/status/config, and selected metric summaries.
- Run list initial query should avoid full metric history and hydrate only page rows.
- Default page limit remains small. Max limit remains bounded by existing server validation.
- Cursor pagination avoids deep-offset scans.
- Indexable token predicates and trigram index keep search bounded for human query strings.
- Exact `count(*)` and metric-key discovery are measured. If either exceeds the budget, the follow-up is to make totals and metric catalog opt-in/separate.
- Benchmark gates:
  - Runs page first useful render under 2 seconds on local production build plus local Rust/Postgres/ClickHouse.
  - Server-side run search/filter/sort p95 under 500 ms for the 90,000-run fixture.
  - Run summary p95 under 300 ms for default newest page.
  - Metric chart p95 under 200 ms for one run/key with 1,000 points.

## Simplicity Review

This design reuses the existing route, summary DTOs, search column, and web controls. The only new backend concept is an opaque cursor, and the only new SDK concept is a read-only `Api` helper. It avoids a broad filter DSL, a search service, caching, and persistent workspace API changes.

Deferred complexity:

- Query grammar for tags, notes presence, config keys, and artifact presence.
- Direction-aware metric best policies.
- Approximate counts or count caching.
- Separate metric catalog endpoint.
- Batch metric-series endpoint for workspace panels.
- Org-wide quick search.

## Failure Modes

- Invalid cursor: return `400` with the existing client-safe error shape.
- Cursor/query mismatch: return `400`.
- Cursor with invalid base64, oversized data, non-object JSON, unknown schema version, wrong sort payload, or tampered filter hash: return `400`.
- Rows deleted between pages: keyset pagination returns the next valid rows after the cursor position; selected-run detail hydration may drop missing IDs as it already does.
- Newer runs inserted while paging: first page changes on refresh; cursor pages remain ordered relative to their cursor.
- Metric key missing for metric sort: rows without that metric sort after rows with values.
- Search too broad: route still returns a bounded page and exact total.
- Auth-restricted key: org/project filters remain enforced before cursor predicates.

## Testing Plan

- Rust integration tests:
  - Cursor page two does not duplicate page one.
  - Cursor mismatch rejects.
  - Invalid base64/JSON cursor, tampered hash, wrong sort payload, and terminal page `next_cursor: null` are covered.
  - Equal names, equal timestamps, equal metric values, null durations, and missing metric rows page correctly.
  - Deleted row between pages and inserted newer row while paging remain stable.
  - Search token behavior still matches tags/notes/config.
  - Short-token searches such as `q=13` and mixed searches such as `q=seed 13` are benchmarked.
  - Sort-specific cursor works for created, name, status, and selected metric sorts.
  - Project-scoped API key cannot page/search outside its project.
  - Query-plan smoke verifies indexed scans for the main large-run query shapes.
- Python SDK tests:
  - `Api.runs()` builds the expected encoded query string.
  - API key and timeout are passed through existing request behavior.
  - Invalid server response still raises `RlobsError`.
- Frontend tests:
  - UI smoke verifies Next/Previous use cursor params and still preserve off-page selected runs.
  - Existing search, sorting, tags/notes, and saved-view behavior stays intact.
- Benchmark:
  - Tooling creates a 90,000-run fixture and records p50/p95 query timings.
  - Benchmark output is recorded in this design doc or tools docs with machine/date caveats.

## Documentation Plan

- `apps/rust-server/README.md`: document cursor pagination, indexes, and benchmark commands.
- `apps/web/README.md`: document cursor-backed Runs browsing.
- `packages/python-sdk/README.md`: document `Api.runs()`.
- `tools/README.md`: document 90,000-run benchmark tool and output fields.
- `TODO.md`, `apps/rust-server/TODO.md`, `apps/web/TODO.md`, `packages/python-sdk/TODO.md`: mark completed first-slice items and keep follow-ups explicit.

## Alternatives Considered

- New `/api/v1/runs` route: rejected for this slice because `/api/runs/summary` already serves the UI and SDK needs. A versioned public API can wrap it later.
- Offset-only pagination plus indexes: rejected because deep pages remain increasingly expensive.
- Full-text `tsvector`: rejected for now because current searches are substring/token searches over identifiers, tags, notes, and config snippets.
- Approximate counts: deferred because exact totals are useful in the current UI and must be measured before adding count complexity.
- Materialized run summary table: rejected because `metric_series` is already the maintained summary table, and page hydration is bounded.

## Review Notes

Fresh reviewer 1:

- Finding: Cursor tokens were only bound to `sort_by` and `metric_key`.
- Risk: Reusing a cursor with a different project, status, search, page size, or auth-project scope could silently skip rows.
- Recommended edit: Add a normalized filter/scope hash, max cursor length, strict decode/type validation, and tests for mismatches.
- Decision: Accepted. The design now binds cursors to a normalized non-sensitive query/auth fingerprint.

- Finding: Nullable `duration` and metric sorts lacked explicit keyset predicates.
- Risk: `DESC NULLS LAST` pagination can duplicate or skip rows around null values and ties.
- Recommended edit: Specify cursor payloads and null branches per sort.
- Decision: Accepted. The design now defines cursor fields and predicates for every supported sort.

- Finding: Existing optional `OR` predicates may not use the proposed indexes well.
- Risk: Prepared/generic plans can miss hot-path indexes at 90,000 runs.
- Recommended edit: Resolve project name to project ID and build fixed SQL for present filters.
- Decision: Accepted for the run-list hot path.

- Finding: Exact totals and metric-key discovery remain potentially expensive.
- Risk: The endpoint can miss budget even if page-row query is fast.
- Recommended edit: Benchmark the full endpoint and add include flags or a separate metric catalog route if needed.
- Decision: Accepted as a gate. The benchmark must measure full route cost before TODO completion.

Fresh reviewer 2:

- Finding: Frontend cursor page state was under-specified.
- Risk: Visible ranges and buttons could drift from cursor-backed requests.
- Recommended edit: Specify page index, cursor stack, fallback to offset for Node compatibility, and reset behavior.
- Decision: Accepted.

- Finding: Org-wide default UI path may not be covered by project-scoped indexes.
- Risk: The app can still be slow before users choose a project.
- Recommended edit: Benchmark org-wide and project-scoped query plans or make the slice project-scoped.
- Decision: Accepted. Benchmark both paths and add indexes if org-wide misses budget.

- Finding: SDK helper should be explicitly raw and small.
- Risk: A small query client could accidentally become an unstable public abstraction.
- Recommended edit: Document raw payload, query encoding, and cursor/offset exclusivity.
- Decision: Accepted.

## Implementation Notes

Implemented on 2026-05-11:

- Rust `GET /api/runs/summary` and `GET /runs` now share bounded run-page query helpers with cursor pagination, direct filter predicates, strict cursor validation, and selected metric latest/best sorting.
- Migration `apps/rust-server/migrations/0003_large_run_query_indexes.sql` adds created/name/status/duration run indexes plus metric latest/best indexes.
- Metric sort uses a metric-first query for rows with non-null selected metric values, then appends rows missing that metric in created order. Offset compatibility adjusts the missing-row offset after counting metric-bearing rows.
- Name/status cursor values use the database `lower(r.name)` value selected with the row, so cursor comparisons match the Postgres sort key.
- The web Runs workspace keeps a cursor stack for Rust responses, falls back to offset for the deprecated Node server, clears cursors synchronously when filters/sorts/page size change, and disables pagination while page navigation is in flight.
- The Python SDK exports `Api.runs()` as the raw read-only first slice.
- `tools/rust-large-run-benchmark.mjs` seeds 90,000 runs, runs `ANALYZE`, measures the full summary route, and can optionally measure production Next first useful render.

## Benchmark Results

Local benchmark on 2026-05-11 with disposable local Postgres, local Rust API, local Next production build, 90,000 seeded runs, one selected metric summary per run, and 1,000 chart points on the target run. Current CLI benchmark runs use disposable ClickHouse for metric rows in addition to disposable Postgres metadata:

```text
RLOBS_BENCH_RUNS=90000 RLOBS_BENCH_SAMPLES=10 RLOBS_BENCH_WARMUPS=2 RLOBS_BENCH_WEB=1 npm run benchmark:large-runs

summary_newest_project p50 68 ms, p95 78 ms
summary_newest_org     p50 67 ms, p95 68 ms
summary_search_seed_13 p50 110 ms, p95 118 ms
summary_sort_metric_best p50 65 ms, p95 66 ms
chart_series           p50 21 ms, p95 22 ms
web first useful render 387 ms
```

All measured gates passed on this machine: first useful render stayed under 2 seconds, server-side search/metric sort stayed under 500 ms p95, default project summary stayed under 300 ms p95, and chart series stayed under 200 ms p95. These numbers are local-development evidence, not a hosted SLO.

The full summary route still returns exact totals and all distinct metric keys for the filtered result set. That remained inside budget for this fixture, but projects with very high metric-key cardinality should split metric-key discovery into a bounded catalog endpoint or add an `include_metric_keys=false` hot-path flag before broader claims.

## Coverage Exceptions

None planned.

## Decision

Accepted for the narrow first slice after review edits above.
