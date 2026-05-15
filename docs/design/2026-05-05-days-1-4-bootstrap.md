# Design: Days 1-4 Bootstrap

Date: 2026-05-05

Status: Implemented bootstrap slice

Owner: Codex

## Summary

This design covers the first four sprint days from `PRODUCT_STRATEGY.md`: customer discovery planning artifacts, MVP specification, repository structure, backend core, and Python SDK logging. The implementation should produce the days 1-4 backend/SDK bootstrap slice: a Python training script creates a run, logs scalar metrics to a local backend, and the backend persists and returns projects, runs, and metrics.

The bootstrap intentionally uses boring Python standard-library building blocks for the first slice: SQLite for persistence, `http.server` for the development API server, `urllib` for SDK HTTP calls, and `pytest` for tests. This avoids introducing framework complexity before the API surface is stable. The current production-oriented path builds on the accepted Rust/ClickHouse foundation design and the implemented ClickHouse metric plane, while this Python API remains a reference compatibility target.

This is not the complete repo-level vertical slice because it does not include UI visibility. A follow-up design should cover the UI list/chart slice: SDK -> API -> database -> UI run list -> bounded metric chart.

Current status: implemented. The Python bootstrap API remains a reference implementation and SDK compatibility target. Current product API work lives in `apps/rust-server`, the UI lives in `apps/web`, and the older Node product surface in `apps/server` is now deprecated compatibility/migration infrastructure.

## Goals

- Create customer discovery planning and hypothesized ICP documentation for day 1.
- Create MVP/spec decisions for day 2.
- Implement backend projects, runs, and metrics persistence for day 3.
- Implement backend create/list/get endpoints for projects, runs, and metrics.
- Implement Python SDK `init`, `log`, and `finish` for day 4.
- Capture basic environment metadata in the SDK.
- Add an RL-style example script that logs a run.
- Add tests with 100% meaningful coverage for first-party product logic in this slice.

## Non-Goals

- Production authentication.
- Artifact uploads.
- Checkpoints, videos, and tables.
- Frontend runs table or charts.
- Docker Compose.
- Importers.
- ClickHouse.
- Background SDK batching.
- Hosted SaaS.

## Users and Use Cases

The first user is a local developer or researcher testing whether the product can be added to a training loop quickly.

Use case:

1. Start the backend locally.
2. Run an example script.
3. The script initializes a project/run.
4. The script logs scalar training metrics.
5. The script finishes the run.
6. The backend stores and returns the run and metrics.

## Proposed Design

Create the following implementation areas:

```text
apps/
  api/
    instantml_api/
    tests/
packages/
  python-sdk/
    instantml/
    tests/
examples/
  rl-cartpole/
```

The backend will expose a small JSON API using `ThreadingHTTPServer`, a tiny explicit route table, and focused handler helpers. This server is dev-only for the bootstrap. It should enforce JSON-only request bodies, deterministic JSON errors, a small maximum request size, and no custom mini-framework.

Endpoints:

- `GET /health`
- `POST /projects`
- `GET /projects`
- `POST /runs`
- `GET /runs?project_id=...&project=...&limit=...&offset=...`
- `GET /runs/{run_id}`
- `POST /runs/{run_id}/metrics`
- `GET /runs/{run_id}/metrics?key=...&start_step=...&end_step=...&limit=...`
- `PATCH /runs/{run_id}`

`GET /runs` returns run metadata only in this slice. It does not return latest metric summaries.

The SDK will expose:

```python
import instantml as ro

run = ro.init(project="cartpole", config={"seed": 42})
run.log({"train/reward": 1.0}, step=1)
run.finish()
```

The example script will use deterministic fake RL metrics instead of requiring a simulator dependency.

## Component Impact

Backend:

- Add a standard-library JSON API server.
- Add SQLite schema and repository functions.
- Add validation and error responses.

Frontend:

- Keep only the placeholder README/shell for days 1-4.
- No UI implementation in this slice.

Python SDK:

- Add package code using `urllib.request`.
- Capture Python version, platform, hostname, and process ID.
- Keep logging synchronous and explicit for now.

Storage:

- SQLite file path is configurable.
- Local default is `.instantml/instantml.sqlite3`.
- Use one SQLite connection per request or repository operation.
- Enable `PRAGMA foreign_keys=ON`.
- Enable `PRAGMA journal_mode=WAL`.
- Set `PRAGMA busy_timeout=5000`.

Docs:

- Add ICP and MVP spec docs.
- Update component READMEs with commands and test expectations.

## Data Model

SQLite tables:

- `projects`: `id` text primary key, `name` unique required text, `description` nullable text, `created_at` UTC timestamp text.
- `runs`: `id` text primary key, `project_id` required text with foreign key, `name` required text, `status` required text, `config_json` required text, `tags_json` required text, `metadata_json` required text, `created_at` UTC timestamp text, `started_at` UTC timestamp text, `finished_at` nullable UTC timestamp text.
- `metrics`: `id` integer primary key, `run_id` required text with foreign key, `key` required text, `step` required nonnegative integer, `value` required real number, `created_at` UTC timestamp text.

Compatibility note: this bootstrap schema started with integer metric steps. The current Rust server, deprecated Node server, Python bootstrap API, SDK, and importers now use finite nonnegative numeric steps. Future backend work must preserve that contract.

Rules:

- IDs are UUID strings.
- Timestamps use UTC ISO 8601 with a `Z` suffix.
- Allowed run statuses: `running`, `finished`, `failed`.
- Metric values must be finite numeric values.
- Metric steps must be nonnegative integers.
- Duplicate `(run_id, key, step)` metrics are allowed for now.
- Metric query ordering is deterministic: `step ASC, id ASC`.

Indexes:

- Unique project name.
- Runs by project and creation time.
- Metrics by run, key, and step.

## API Contracts

All request and response bodies are JSON. Successful writes return `200` or `201`. Invalid requests return `400`. Unknown resources return `404`. Server errors return `500`.

Project creation:

```json
{"name": "cartpole", "description": "optional"}
```

Response:

```json
{
  "project": {
    "id": "uuid",
    "name": "cartpole",
    "description": "optional",
    "created_at": "2026-05-05T12:00:00.000000Z"
  }
}
```

Run creation:

```json
{
  "project": "cartpole",
  "name": "ppo-seed-42",
  "config": {"seed": 42},
  "tags": ["ppo"],
  "metadata": {"python": "3.11"}
}
```

Response:

```json
{
  "run": {
    "id": "uuid",
    "project_id": "uuid",
    "project": "cartpole",
    "name": "ppo-seed-42",
    "status": "running",
    "config": {"seed": 42},
    "tags": ["ppo"],
    "metadata": {"python": "3.11"},
    "created_at": "2026-05-05T12:00:00.000000Z",
    "started_at": "2026-05-05T12:00:00.000000Z",
    "finished_at": null
  }
}
```

Metric logging:

```json
{
  "metrics": {"train/reward": 1.0, "train/loss": 0.2},
  "step": 1
}
```

Response:

```json
{"inserted": 2}
```

Run finish:

```json
{"status": "finished"}
```

Response:

```json
{
  "run": {
    "id": "uuid",
    "status": "finished",
    "finished_at": "2026-05-05T12:01:00.000000Z"
  }
}
```

Run list response:

```json
{
  "runs": [],
  "limit": 100,
  "offset": 0
}
```

Metric query response:

```json
{
  "metrics": [
    {"key": "train/reward", "step": 1, "value": 1.0, "created_at": "2026-05-05T12:00:00.000000Z"}
  ],
  "limit": 1000
}
```

Errors return:

```json
{"error": "message"}
```

## Performance Considerations

- Expected rows/items per user action: 1 project, 1 run, and 1-10 metric rows per SDK `log` call.
- Expected write frequency: low for this bootstrap, but the schema supports many metric writes per run.
- Expected read/query shape: paginated run lists and bounded metric queries by run/key/step.
- Latency target: SDK `log` should complete quickly for local development and avoid artifact work entirely.
- Pagination, limits, or streaming behavior: run lists default to `limit=100`, max `limit=500`; metric queries default to `limit=1000`, max `limit=5000`.
- Indexes: metrics index by `(run_id, key, step)` supports bounded chart queries.
- Memory concerns: API handlers should not load all runs or all metric history.
- Batching needs: deferred until SDK/API throughput is measured.
- Measurement or profiling plan: test bounded query behavior now; add profiling in a future performance design.

List endpoints return summaries only. Metric history is fetched through bounded endpoints filtered by run, key, step range, or explicit limit. Invalid limits, offsets, and step ranges return `400`. Artifact upload/download paths are not part of this slice.

Performance test:

- Seed 50 runs with 1,000 metric points each.
- Verify bounded metric queries return only the requested limit and deterministic order.

## Simplicity Review

This is the simplest useful version because it has no framework dependency, no auth, no async worker, no artifact storage, no frontend complexity, and no shared internal package. It validates the product's most important path before broader tooling choices.

Complexity deferred:

- FastAPI or another production API framework.
- ClickHouse migrations.
- SDK buffering and retries.
- Artifact/checkpoint/video uploads.
- Frontend tables and charts.
- Docker Compose.

## Failure Modes

- Invalid JSON request.
  - Return `400` with an error body.

- Missing or invalid required fields.
  - Return `400` with an error body.

- Unknown run.
  - Return `404` with an error body.

- Backend unavailable from SDK.
  - Raise a clear `InstantMLError`.

- SDK HTTP call hangs.
  - Use a configurable timeout, defaulting to 2 seconds.

- SQLite path parent does not exist.
  - Create parent directories before opening the database.

## Testing Plan

Backend:

- Database initialization and indexes.
- Project creation and idempotent project lookup.
- Run creation/list/get/update.
- Metric logging and bounded queries.
- HTTP handler success and error paths.
- Malformed JSON and oversized request handling.

SDK:

- `init` creates a backend run.
- `log` sends metrics with step.
- `finish` patches run status.
- Environment metadata capture.
- Network/backend failures raise `InstantMLError`.
- HTTP timeout defaults are passed to requests.

Example:

- Smoke test deterministic metric generation without requiring an external RL package.

Integration:

- Start the HTTP server in-process on an ephemeral port.
- Use the SDK to create a run, log metrics, and finish.
- Read the run and bounded metrics back through the API.

Coverage:

- Target 100% meaningful coverage for first-party product logic in this slice.

## Documentation Plan

Update:

- `README.md`
- `apps/api/README.md`
- `packages/python-sdk/README.md`
- `examples/README.md`
- `examples/rl-cartpole/README.md`
- `docs/users/day-1-customer-discovery.md`
- `docs/product/day-2-mvp-spec.md`

## Alternatives Considered

### FastAPI immediately

Deferred. The standard-library server kept the first slice dependency-light and made the data/API contract the focus. Later strategy chose a Node compatibility server for product work and Rust/ClickHouse as the hosted backend path, so FastAPI is no longer the expected production upgrade.

### SQLAlchemy immediately

Deferred. Plain SQLite and explicit SQL are simpler for the first schema and keep query behavior visible.

### SDK background batching immediately

Deferred. Synchronous calls are easier to reason about and test. Batching should come after measuring SDK overhead.

## Review Notes

Fresh reviewer 1:

- Finding: The design is a backend/SDK bootstrap, not the full SDK/API/UI vertical slice; API contracts, SQLite constraints, bounded query semantics, and SDK failure semantics need more detail.
- Risk: Future agents could implement incompatible assumptions or let invalid data into the system.
- Recommended edit: Rename the slice, add a UI follow-up note, define response shapes/status codes, constraints, limits, ordering, and SDK timeout/error behavior.
- Decision: Accepted and incorporated.

Fresh reviewer 2:

- Finding: Standard-library HTTP is acceptable only if tightly constrained; SQLite runtime settings and true SDK-through-HTTP integration tests should be explicit.
- Risk: Bespoke HTTP handling could become accidental framework work, and synchronous SDK calls could hang training loops.
- Recommended edit: Require `ThreadingHTTPServer`, a tiny explicit route table, max body size, SQLite pragmas, SDK timeout, and integration/performance tests.
- Decision: Accepted and incorporated.

## Coverage Exceptions

None planned.

## Decision

Accepted for days 1-4 bootstrap implementation.
