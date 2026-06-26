# Day 2: MVP Spec and Repo Structure

Date: 2026-05-05

Status: Implemented days 1-4 bootstrap; superseded by current InstantML strategy for roadmap planning

## Current Status

This file records the original day-2 bootstrap spec. It remains useful for understanding why the repo started with a standard-library Python API and small SDK, but `PRODUCT_STRATEGY.md` and `docs/architecture/current-system.md` are now the current sources of truth.

Current product direction: InstantML is now positioned as a general training-loop observability product and W&B-style competitor. RL and Neptune migration remain important workflows, but new roadmap work should not treat the product as RL-only or Neptune-first.

Implemented after this spec:

- Node compatibility API in `apps/server`.
- Next/React frontend in `apps/web`.
- Typed attributes, local artifact upload/download, SDK buffering/offline replay for post-init events, and Neptune-shaped JSON import.
- Dogfood examples for Q-learning, contextual bandits, and supervised regression.

## MVP Slice

Original backend/SDK bootstrap slice:

1. Python SDK initializes a run.
2. Python SDK logs scalar metrics.
3. Backend stores project, run, and metric rows in SQLite.
4. Backend returns projects, runs, and bounded metric history.
5. Example script proves the path end to end.

The frontend placeholder has been replaced by the current Next/React UI.

## Stack Decisions

Backend:

- Python standard library `http.server` for the dev-only bootstrap API.
- Explicit route handling, JSON-only requests, bounded request body size.
- SQLite for local persistence.

Current product backend:

- Rust API in `apps/rust-server`.
- ClickHouse state for local/default product development.
- Local filesystem artifact storage behind an abstraction first, with S3-compatible storage planned for hosted artifact bytes later. See `docs/design/2026-05-14-clickhouse-only-storage.md`.
- Deprecated Node JSON server in `apps/server` remains for route compatibility, JSON migration fixtures, and legacy fallback only.

SDK:

- Python package using `urllib.request`.
- Synchronous calls for the first slice.
- 2 second default timeout.
- Clear `InstantMLError` on network or non-2xx API failures.

Tests:

- `pytest`
- `pytest-cov`
- 100% meaningful coverage enforced by default.

Frontend:

- Next/React frontend in `apps/web`.
- The earlier plain HTML/CSS/JS slice has been replaced.
- Future UI work should preserve fast, legible training-run comparison as the primary moat.

## Data Model

Projects:

- `id`
- `name`
- `description`
- `created_at`

Runs:

- `id`
- `project_id`
- `name`
- `status`
- `config_json`
- `tags_json`
- `metadata_json`
- `created_at`
- `started_at`
- `finished_at`

Metrics:

- `id`
- `run_id`
- `key`
- `step`
- `value`
- `created_at`

## SDK Interface

```python
import instantml as im

run = im.init(
    project="cartpole",
    name="cartpole-seed-42",
    config={"seed": 42},
    tags=["example", "rl"],
    base_url="http://127.0.0.1:8000",
)
run.log({"train/reward": 25.0}, step=1)
run.finish()
```

## Development Commands

Install development dependencies:

```bash
python3 -m pip install -r requirements-dev.txt
```

Run tests with coverage:

```bash
python3 -m pytest
```

Start the API:

Recommended current UI/API path:

```bash
npm run dev:api
```

Historical Python bootstrap API:

```bash
PYTHONPATH=apps/api python3 -m instantml_api.server --db .instantml/instantml.sqlite3 --port 8000
```

Run the example:

```bash
PYTHONPATH=packages/python-sdk:examples/rl-cartpole python3 examples/rl-cartpole/train.py --server http://127.0.0.1:8000
```

## Acceptance Criteria

- Backend can create/list projects.
- Backend can create/list/get/update runs.
- Backend can log and query bounded metric history.
- SDK can initialize, log, and finish a run.
- Example script logs a complete run.
- Tests pass with 100% coverage.
