# Design: Aim Gap 2 Query API

Date: 2026-06-30

Status: Implemented

Owner: Codex

Branch: `codex/aim-gap2-query-api`

## Summary

Aim exposes a Pythonic query layer for runs and tracked objects. InstantML has a
dashboard `q` language, cursor-backed `/api/runs/summary`, bounded metric series
routes, and a raw `Api.runs()` helper. API users still lack a first-class
notebook/automation surface for querying runs, metric series, rich-object
summaries, and table rows without hand-assembling REST calls.

This branch turns the current run-search foundation into a typed, bounded SDK
query API. It does not clone AimQL or run Python expressions on the server.
Instead, it offers explicit filters, the existing server-backed `q` language,
bounded metric/object reads, and lazy iterators that make pagination and payload
size obvious.

## Goals

- Add public SDK methods for querying runs, metrics, and rich objects.
- Keep the server authoritative for access control, filtering, sorting, and
  pagination.
- Support notebook-friendly iteration without unbounded downloads.
- Reuse the existing `q` language rather than adding a second parser.
- Add backend endpoints only where current routes cannot support safe bounded
  reads.
- Verify with real SDK -> Rust -> ClickHouse data and notebook-like examples.

## Non-Goals

- No Python `eval`, SQL, or RestrictedPython query strings.
- No unbounded metric history downloads.
- No new search service.
- No breaking change to `Api.runs()`.
- No pandas dependency in the core SDK.
- No client-side filtering that can disagree with dashboard/server results.

## Users and Use Cases

- Researchers pull the top 20 runs matching `tag:candidate` into a notebook and
  run custom analysis.
- Platform engineers find failed/stale runs and export summaries.
- Evaluation engineers fetch bounded metric series for selected runs and keys.
- Users inspect rich-object metadata and table previews from scripts.

## Proposed Design

Add a typed SDK query layer:

```python
api = instantml.Api(...)

runs = api.query_runs(project="cartpole", q="tag:baseline status:finished")

series = api.query_metrics(
    run_ids=[run["id"] for run in runs.items],
    keys=["eval/return_mean"],
    point_limit=1000,
)

objects = api.query_objects(
    project="cartpole",
    kind="table",
    key="eval/samples",
    q="tag:reviewed",
)

rows = api.object_rows(objects.items[0]["id"], limit=100)
```

Return small result classes:

- `Page(items, next_cursor, raw, limit)`
- `MetricSeriesPage(series, raw, point_limit)`

`Api.runs()` remains the raw compatibility helper. `query_runs()` wraps it with
validation, clearer names, optional auto-pagination, stable result classes, and
no response-shape magic.

## Mergeability And Dependencies

This branch must be useful without Gap 1 merged:

- `query_runs()`, `iter_runs()`, and `query_metrics()` use routes that already
  exist in Rust and remain fully supported.
- `object_rows()` reuses `/api/objects/:object_id/rows`.
- `query_objects()` first probes `GET /api/objects/explorer` when available. If
  the route returns 404/405 on an older backend, it falls back only when
  `run_id` is supplied by calling `/api/runs/:run_id/objects`; otherwise it
  raises `InstantMLError` with code/message explaining that cross-run object
  queries require the Rust object explorer route.

The SDK must not silently fan out across every run to emulate cross-run object
queries.

## API Contracts

SDK:

```python
Api.query_runs(project=None, q=None, status=None, sort_by=None,
               metric_key=None, limit=100, cursor=None, max_pages=1)

Api.iter_runs(..., page_size=100, max_pages=None)

Api.query_metrics(run_ids, keys, x_axis="step", step_min=None, step_max=None,
                  time_min=None, time_max=None, point_limit=1000,
                  buckets=None)

Api.query_objects(project=None, q=None, kind=None, key=None, run_id=None,
                  from_step=None, to_step=None, limit=100, cursor=None,
                  max_pages=1)

Api.object_rows(object_id, limit=100, offset=0)
```

Hard SDK validation caps:

- `limit`: 1..100 for run and object pages.
- `max_pages`: `None` or 1..100. Default is 1.
- `run_ids`: 1..100.
- `keys`: 1..25, each non-empty and at most 256 bytes.
- `point_limit`: 1..10,000, default 1,000.
- `buckets`: optional 1..2,000. When set, it is passed through to the existing
  M4/downsampling route.
- `object_rows.limit`: 1..1,000.
- `q`: max 512 bytes, matching the server run-search cap.

Potential Rust route additions:

- `GET /api/metrics/catalog` only if SDK examples need project/run/key catalog
  browsing not covered by `/api/runs/summary` metric keys. If added, it must be
  bounded, OpenAPI-registered, and behind `export:read`.
- `GET /api/objects/explorer` is reused when available and is designed in the
  Gap 1 branch.

Existing Rust routes reused:

- `GET /api/runs/summary`
- `POST /api/metrics/series`
- `GET /api/runs/:run_id/objects`
- `GET /api/objects/:object_id/rows`

Errors surface as `InstantMLError` with server `code`, `field`, and `position`
when present. Client-side validation raises `ValueError` or `TypeError` before
network calls.

## Ordering And Response Semantics

- `query_runs()` preserves server `/api/runs/summary` order exactly.
- `iter_runs()` yields page items in server order and stops when `next_cursor`
  is absent or `max_pages` is reached.
- `query_metrics()` returns series sorted by caller `run_ids` order, then caller
  `keys` order. Missing run/key pairs are omitted unless
  `include_empty=True` is added in a future design.
- Metric points preserve server point order. When `buckets` is passed, the
  result is explicitly marked as downsampled in `raw`/series metadata when the
  server indicates that state.
- `query_objects()` preserves explorer route order. The fallback per-run route
  preserves that route's order and only works for a single supplied `run_id`.
- `object_rows()` preserves `row_index ASC` from the existing row route.

## Component Impact

Backend:

- Prefer no backend change unless `/api/metrics/catalog` proves necessary.
- If a route is added, register OpenAPI annotations and run
  `npm run codegen:api`.
- Ensure every query endpoint enforces `export:read` and project-scoped API-key
  access identically to the dashboard.

Frontend:

- No required UI change, except generated type updates if Rust routes change.

Python SDK:

- Add result classes and SDK methods.
- Add tests for request encoding, pagination, validation, ordering, and
  unsupported-backend behavior.
- Add examples suitable for notebooks and automation.

Storage:

- No new durable data model.

Docs:

- Update SDK README, PyPI README, public docs, and examples.

## Performance Considerations

- Defaults read one page only.
- Iterators page lazily and stop at explicit `max_pages` when provided.
- Metric series reads keep existing bounded/downsampled point caps.
- No method returns more than 1,000 points per run/key by default.
- The SDK must not fan out per run except when the caller explicitly iterates or
  supplies a single `run_id` object fallback.
- Real E2E smoke uses at least 20 runs and multiple metric keys.

## Simplicity Review

The simple path is to wrap current REST routes and expose typed, bounded SDK
helpers. A Python-expression query engine would be powerful but creates a new
security and semantics surface that could diverge from the dashboard. This
design keeps one query language and makes missing backend capabilities explicit.

Deferred:

- AimQL-compatible expression parsing.
- Metric/config numeric comparisons inside `q`.
- Arbitrary server-side expressions.
- Pandas DataFrame helpers in the core wheel.
- Cross-run object query emulation on legacy backends.
- Timestamp-windowed metric queries; the SDK rejects `time_min`, `time_max`,
  and `x_axis="time"` until a backend timestamp-filtered series route is
  designed.

## Failure Modes

- Invalid `q`: SDK raises with `run_search_invalid` details from the server.
- Too many run IDs/keys/points: SDK validates first; server remains the final
  authority.
- Older backend lacks `/api/objects/explorer`: `query_objects()` falls back only
  for single-run queries, otherwise raises a clear unsupported-route error.
- Partial pagination failure: iterator raises at the failing page; already
  yielded user data remains in caller code.
- Downsampled metric response: result exposes that the server returned bucketed
  points so callers do not mistake it for raw history.

## Testing Plan

- SDK unit tests for every query method's request shape, cursor behavior, caps,
  errors, and result ordering.
- Fake-server tests for unsupported object explorer fallback and clear errors.
- Rust tests and OpenAPI drift checks only if a new route is added.
- End-to-end SDK smoke against disposable Rust/ClickHouse with real logged
  metrics and at least one table object.
- Example/notebook-style script that queries runs, fetches metric series, and
  prints table rows.
- Auto-review before commit: diff review plus focused SDK/Rust tests and E2E
  smoke evidence added to this doc.

## Documentation Plan

- `packages/python-sdk/README.md`: public query API section.
- `packages/python-sdk/PYPI_README.md`: concise query examples.
- `apps/docs`: public SDK query guide.
- `README.md`: update current status.
- `apps/rust-server/README.md`: document any new query route or explicitly note
  that this branch is SDK-only over existing routes.

## Alternatives Considered

- Implement AimQL-like Python expressions. Rejected for v1 because it introduces
  a second parser/evaluator and a security-sensitive expression language.
- Add pandas as a dependency. Rejected because the core SDK stays lightweight;
  examples can show optional conversion.
- Make `Api.runs()` magic and auto-paginated. Rejected to preserve the existing
  raw helper contract.
- Emulate cross-run object queries client-side by paging every matching run.
  Rejected because it hides an unbounded fan-out from notebook users.

## Review Notes

Fresh reviewer 1:

- Finding: The API direction was right, but caps, response ordering,
  downsampling semantics, route availability, and the object-route dependency
  were underspecified.
- Risk: Users could accidentally trigger hidden fan-out or get result ordering
  that differs from the dashboard.
- Recommended edit: Add hard method caps, order guarantees, unsupported-backend
  behavior, and independent mergeability rules.
- Decision: Revise.

Fresh reviewer 2:

- Finding: The branch needed to avoid depending on Gap 1 unless that dependency
  was explicit and feature-detected.
- Risk: PR sequencing could block query helpers or leave the SDK advertising
  unsupported object queries.
- Recommended edit: Ship run/metric helpers independently and gate cross-run
  object queries on a detected explorer route.
- Decision: Revise.

Re-review:

- Reviewer 1: Approved. Earlier blockers are resolved; no must-fix before
  implementation.
- Reviewer 2: Approved. Hard caps, ordering semantics, and route availability
  behavior are sufficient to begin.

## Progress Log

- 2026-06-30: Created dedicated branch/worktree and drafted design before
  implementation.
- 2026-06-30: Revised design after two fresh reviews to add hard caps,
  ordering/downsampling semantics, unsupported-route behavior, and mergeability
  rules around the object explorer dependency.
- 2026-06-30: Two fresh reviewers approved the revised design for
  implementation.
- 2026-06-30: Implemented SDK result wrappers plus `Api.query_runs()`,
  `iter_runs()`, `query_metrics()`, `query_objects()`, and `object_rows()`.
  The branch remains backend-independent: run/metric/table-row helpers use
  existing routes, and object queries probe `/api/objects/explorer` while
  falling back only for explicit single-run reads on older backends.
- 2026-06-30: Added focused query unit tests for request encoding, pagination,
  ordering, validation caps, invalid response shapes, and unsupported explorer
  fallback; broader Python SDK tests pass with the existing async warning
  profile.
- 2026-06-30: Added public SDK/PyPI/docs coverage and
  `examples/query-api/query.py`, a deterministic smoke script that seeds 20
  runs and reads back run pages, metric series, rich-object summaries, and table
  rows through the new helpers.
- 2026-06-30: Real E2E smoke passed against disposable Rust/ClickHouse in
  API-key mode on `127.0.0.1:8022`: bootstrap-created Pro org/API key, seeded
  20 `query-api-gap2-final-e2e` runs, queried a 10-run page, iterated 14 runs
  across two lazy pages, returned 10 metric series entries for two keys across
  five runs, found the single-run table object fallback, and read two table
  rows.
- 2026-06-30: Full `python -m pytest` was attempted and failed on pre-existing
  example test import mismatches (`train.ro` expected in RL/gridworld/
  regression/iris tests while those modules import `instantml as im`), plus the
  resulting repo-wide coverage shortfall. Gap 2-relevant SDK tests, docs
  validation, compile checks, and real Rust/ClickHouse E2E passed.

## Coverage Exceptions

None planned.

## Decision

Approved for implementation.
