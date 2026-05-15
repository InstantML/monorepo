# Backend API

This directory contains the days 1-4 Python bootstrap backend API service for InstantML projects, runs, and metrics.

Current product note: `apps/rust-server` is now the primary product API. `apps/web` owns the Next/React UI, and `apps/server` remains a deprecated Node compatibility oracle. Keep `apps/api` as a simple reference implementation and SDK compatibility target unless a design doc changes backend ownership.

## Responsibilities

- Receive basic run/metric data from the Python SDK.
- Persist projects, runs, configs, and metrics in SQLite.
- Provide a small compatibility surface for SDK tests.

Out of scope for this bootstrap API:

- Typed attributes.
- Artifact upload/download.
- Importers.
- UI summary endpoints.
- Production deployment.

## Design Requirement

Before implementation, create or update design docs for:

- API framework selection
- Database schema
- Metric ingestion
- Artifact storage
- Importers
- Authentication or authorization
- Performance-sensitive query paths

## Testing Expectations

Backend code should target 100% first-party code coverage.

Expected tests:

- Unit tests for pure logic.
- API tests for endpoints.
- Persistence tests for database behavior.
- Integration tests for SDK -> API workflows when applicable.
- Importer tests with fixtures.

## Setup

From the repo root:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
```

## Run

```bash
PYTHONPATH=apps/api python3 -m instantml_api.server --db .instantml/instantml.sqlite3 --port 8000
```

## Test

```bash
python3 -m pytest
```

The root pytest configuration enforces 100% coverage for the bootstrap code.

## API Endpoints

- `GET /health`
- `POST /projects`
- `GET /projects`
- `POST /runs`
- `GET /runs`
- `GET /runs/{run_id}`
- `PATCH /runs/{run_id}`
- `POST /runs/{run_id}/metrics`
- `GET /runs/{run_id}/metrics`

Metric contract:

- `step` is a finite nonnegative number.
- Optional metric `timestamp` must be an ISO-compatible datetime and is stored as `created_at`.
- Metric queries accept numeric `start_step` and `end_step` bounds.

## Notes for Future Agents

- Keep endpoints simple and explicit.
- Avoid premature service decomposition.
- Document API contracts before changing them.
- Do not load unbounded metric history in list endpoints.
- Prefer adding new product backend capabilities to `apps/rust-server`.
- Keep metric step and timestamp compatibility aligned with the Rust server, deprecated Node server, and SDK.
- Do not add hosted SaaS auth, ClickHouse migrations, imports, or artifact storage here; those belong in `apps/rust-server`.
