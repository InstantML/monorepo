# Current System Architecture

Date: 2026-05-14

Status: Current architecture summary

## Purpose

This document summarizes the implemented system so future agents do not need to reconstruct the architecture from older sprint docs. `PRODUCT_STRATEGY.md` remains the strategic source of truth; this file describes the current technical shape for Training Observability.

Brand transition note: user-facing docs and UI should say Training Observability. Existing implementation identifiers such as `rl_observability`, `.rlobs`, `rlobs_api`, and `RlobsError` remain compatibility names until a dedicated migration is designed.

Strategy note: the product direction is now a hosted SaaS-first W&B-style competitor for smaller startups, research labs, and lean ML teams. The intended differentiation is speed, UI quality, and predictable pricing. The primary durable backend is Rust plus Postgres metadata storage and ClickHouse metric storage, with the original Rust/Postgres foundation described in `docs/design/2026-05-09-rust-postgres-backend.md`.

Architecture split:

```text
Current/default:
  apps/web + packages/python-sdk
    -> apps/rust-server
    -> Postgres metadata + ClickHouse metrics + artifact storage

Deprecated compatibility:
  apps/web + packages/python-sdk
    -> apps/server
    -> JSON state + local artifacts
```

The Rust/Postgres/ClickHouse path preserves the Node route shapes that the SDK and UI use today. Node remains only as a compatibility oracle, JSON migration source, and legacy fallback.

Repository shape:

```text
monorepo/
  apps/
    api/           Python bootstrap/reference API
    rust-server/   primary Rust API, worker, Postgres migrations, ClickHouse schema
    server/        deprecated Node compatibility API
    web/           Next/React frontend
  packages/
    python-sdk/    public Python SDK and uploader
  examples/        dogfood and import fixtures
  tools/           local orchestration, smokes, benchmarks, import helpers
  docs/
    architecture/  stable system summaries
    design/        accepted and proposed design records
```

## Components

- `apps/rust-server`: Primary Rust API and worker service with Postgres metadata storage, ClickHouse metric storage, and local artifact storage.
- `apps/server`: Deprecated Node.js API compatibility server. Use it for route-shape regression tests, JSON migration fixtures, and legacy fallback only.
- `apps/web`: Next/React frontend application for the operational UI.
- `packages/python-sdk`: Standard-library Python SDK used by examples and training loops.
- `apps/api`: Python bootstrap/reference API from days 1-4. Keep it as a compatibility target, not the primary product backend.
- `examples`: Dogfood training loops for RL, bandits, and supervised regression.
- `tools`: Operational helpers for import experiments, Rust service smokes, local Rust API startup, ClickHouse orchestration, and scale benchmarks.

## Runtime Topology

Local development:

```text
Browser -> Next dev/server on :3000 -> Rust API on :8000
Python SDK/uploader ---------------------> Rust API on :8000

Rust API -> local Postgres metadata      (.rlobs/postgres by default)
Rust API -> local ClickHouse metrics     (.rlobs/clickhouse by default)
Rust API -> local artifact bytes         (.rlobs/rust-artifacts by default)
```

Docker Compose:

```text
Rust API container -> postgres service
Rust API container -> clickhouse service
Rust API container -> rlobs-artifacts volume
Next frontend runs separately with RLOBS_API_BASE=http://127.0.0.1:8000
```

Hosted direction:

```text
Next/React frontend -> Rust API on Cloud Run
Python SDK/uploader -> Rust API on Cloud Run
Rust API -> managed Postgres for OLTP metadata
Rust API -> managed ClickHouse-compatible OLAP metric store
Rust API -> S3-compatible artifact storage
```

## Storage

Current dev/default storage:

- Postgres metadata state under local Postgres by default. `npm run dev:api` manages a local cluster at `.rlobs/postgres`.
- Metric points and aggregated series stored in ClickHouse via the Rust `metric_store::MetricStore`. `npm run dev:api` starts a local ClickHouse server for the default loopback `CLICKHOUSE_URL` when the `clickhouse` binary is installed, stores generated state under `.rlobs/clickhouse`, and also works with an already-running `CLICKHOUSE_URL`. The docker-compose stack provides ClickHouse for the container path.
- Local artifact bytes stored through the Rust artifact-store abstraction under `.rlobs/rust-artifacts` by default.
- Python bootstrap API uses SQLite for reference tests.

Deprecated storage:

- Node JSON state at `.rlobs/rlobs.json` for compatibility and future P4 JSON-to-Postgres migration fixtures.

Durable storage direction:

- Managed Postgres for OLTP metadata (users, orgs, runs, attributes, artifacts, idempotency, audit events, usage rollups).
- Managed ClickHouse for the OLAP metric plane: raw `metric_points` (MergeTree) and aggregated `metric_series` (AggregatingMergeTree fed by a materialized view) for fast summary and chart queries.
- Local artifact storage behind an S3-compatible abstraction at first.
- S3-compatible artifact storage as the production-ready byte store after the local backend proves API and metadata semantics.
- JSON state retained only for deprecated Node compatibility and migration tooling.

The Postgres schema under `apps/rust-server/migrations/` is the durable OLTP target and default local/backend metadata schema:

- `0001_initial.sql`: core users, orgs, projects, runs, attributes, artifacts, imports, usage, idempotency, audit, and legacy metric tables from the first Rust slice.
- `0002_run_search_text.sql`: trigger-maintained run search text plus tag/search indexes for name/tag/config/note search.
- `0003_large_run_query_indexes.sql`: run-list/search/sort indexes from the 90,000-run benchmark slice. Its metric-table indexes are now historical because metric tables move in `0006`.
- `0004_rich_logged_objects.sql`: rich object attribute types and bounded table preview rows.
- `0005_landing_auth_onboarding.sql`: browser sessions, org seat/account fields, and local hosted-auth onboarding.
- `0006_drop_metric_tables.sql`: removes Postgres `metric_points` and `metric_series` after ClickHouse becomes canonical.

The ClickHouse schema under `apps/rust-server/clickhouse/0001_initial.sql` owns raw `metric_points`, aggregated `metric_series`, and the materialized view that maintains series summaries on insert. The Node JSON server still includes a local version of organizations, users, service accounts, API keys, audit events, maintained metric summaries, idempotent metric ingestion, export, and warning-only usage summaries so it can remain the compatibility oracle and migration source.

## Operational Commands

- `npm run dev:api`: starts or reuses local Postgres and ClickHouse, applies Rust migrations, applies ClickHouse schema, then serves the Rust API.
- `npm run test:contract`, `npm run test:rust:sdk`, and `npm run test:ui`: run through `tools/rust-service-smoke.mjs`, which creates disposable Postgres and ClickHouse state, starts Rust, runs the smoke, and cleans up.
- `npm run benchmark:large-runs`: seeds run metadata into disposable Postgres and metric rows into disposable ClickHouse before measuring summary/search/sort/chart endpoints.
- `npm run dev:api:node` and `npm run test:contract:node`: explicit deprecated Node compatibility paths.

## Data Model

The Rust server stores in Postgres:

- Projects.
- Runs.
- Typed attributes for config, float series, string series, files, file series, histograms, and tags.
- Artifacts with type, name, URI, step, size, SHA256, MIME type, storage path, and metadata.
- Import summaries.
- Local users, organizations, service accounts, hashed API keys, idempotency records, and audit events.
- Organization plan tiers used for warning-only Free/Lab/Startup/Growth usage summaries.
- Trigger-maintained run search text derived from run name, tags, config text, and explicit note fields.

The Rust server stores in ClickHouse:

- Raw `metric_points` rows (org_id, run_id, key, step, value, logged_at, created_at), partitioned monthly by `created_at`, ordered by `(org_id, run_id, key, step)`.
- Aggregated `metric_series` (AggregatingMergeTree with `count`, `sum`, `sum_sq`, `min`, `max`, `latest`, `latest_step`, `best_step`, `latest_logged_at`), populated automatically by the `metric_series_mv` materialized view on insert.
- `mean`, `variance`, and `best` are derived on read: `mean = sum/count`, `variance = sum_sq/count - mean^2`, `best = max`.

Metric `step` is a finite nonnegative number across the Rust server, deprecated Node server, Python bootstrap API, SDK, and importer-shaped payloads. Optional metric timestamps must be ISO-compatible datetimes.

## API Surface

SDK-compatible endpoints:

- `POST /runs`
- `PATCH /runs/:run_id`
- `POST /runs/:run_id/metrics`
- `GET /runs/:run_id/metrics`

Product endpoints:

- `POST /api/users`
- `GET /api/users`
- `POST /api/orgs`
- `GET /api/orgs`
- `POST /api/orgs/:org_id/api-keys`
- `GET /api/orgs/:org_id/api-keys`
- `GET /api/runs/summary`
- `GET /api/runs/side-by-side`
- `POST /api/runs/:run_id/attributes`
- `GET /api/runs/:run_id/attributes`
- `POST /api/runs/:run_id/artifacts`
- `GET /api/runs/:run_id/artifacts`
- `POST /api/runs/:run_id/artifacts/upload`
- `GET /api/artifacts/:artifact_id/download`
- `POST /api/imports/neptune`
- `POST /api/imports/wandb`
- `POST /api/imports/mlflow`
- `GET /api/imports`
- `GET /api/export`
- `GET /api/usage`
- `GET /api/usage/export`

Tenant reads, SDK writes, imports, exports, usage summaries, and artifact downloads require bearer API keys when Rust runs with `RLOBS_AUTH_MODE=api-key`. Bootstrap/admin scaffolding routes require `X-RLOBS-Bootstrap-Token` matching `RLOBS_BOOTSTRAP_TOKEN` or an unrestricted org key with the right scopes. SDK mutations require `sdk:ingest`; artifact writes require `artifacts:write`; import routes require `imports:write`; usage routes require `usage:read`; API-key administration requires `api_keys:write`. Local Rust development remains unauthenticated by default with `RLOBS_AUTH_MODE=local`.

Importer writes go through a shared normalized importer path. Neptune, W&B, and MLflow dry-runs and real imports validate the same canonical representation before any state is committed. Batch attributes and imports are transactional in Rust/Postgres. Scalar metric history is stored in ClickHouse through the Rust metric store. Importers use strict JSON-number validation for request-body metrics and steps; query strings are parsed separately for read filters.

## Frontend Shape

The frontend now uses Next/React. `apps/web/app/page.tsx` is the public landing page, `app/auth-flow.tsx` owns local sign-in/sign-up/onboarding, `app/dashboard/dashboard-shell.tsx` owns the dashboard controller, and `src/state.js`, `src/charts.js`, `src/routes.js`, and `src/api.js` hold testable helpers.

Current UI capabilities:

- Twelve tabs: Runs, Metrics, Run Detail, Compare, Alerts, Datasets, Artifacts, Models, Reports, Settings, Integrations, and API.
- Project/status/search filters with server-sorted, paginated run summaries.
- Runs table with configurable base columns plus pinned metric columns.
- Runs workspace with a pinned summary/filter block, compact left run selector, searchable panel canvas, collapsible sections, add/edit/remove/duplicate/fullscreen line panels, movable/resizable panels, and local layout persistence.
- Metric overlays for selected runs with axes, labels, point markers, metric-aware hover readouts, regex metric filtering, and pinned multi-metric panels.
- Smoothing, step/time x-axis, grouping, and timestamp-preserving grouped averages.
- Range-brush zoom for metric charts and fullscreen panel charts, with y-axis fitting recalculated for the visible x-range.
- Side-by-side comparison with reference-run selection, relative numeric deltas, diff-only mode, row/column layouts, row/run/config sorting, tags/notes/artifact context, and safe MP3/MP4 previews when stored bytes are available.
- Run detail, searchable/editable tags and notes, checkpoints, rollouts, artifacts, config-derived datasets, local saved views, and API surface browsing.
- Named local saved views that capture filters, metric controls, selection, pinned metrics, table columns, and page size.
- Keyboard workflow MVP: quick search, shortcut help, overlay dismissal, workspace undo/redo, run-rail collapse, focus handoff, and fullscreen panel traversal.
- Loading/performance behavior: the root loading shell avoids white flash, tabs initialize from `/dashboard/:tab` routes with legacy hash normalization, and hidden tab data fetches are gated so dashboard reloads do not fan out Metrics/Run Detail/Compare requests unnecessarily.

Known simplification follow-ups:

- Continue shrinking `app/page.tsx` as new workflows justify dedicated container components.
- Add URL/query persistence for high-value daily-workflow state after the local saved-view shape settles.
- Add persisted hosted workspace/panel views after user/org membership context lands.

## SDK Shape

The SDK keeps synchronous HTTP as the default for clarity. `buffer_size` queues post-init events in memory and `flush()` submits them. `offline_dir` spools failed post-init events to JSONL for later `replay_offline()`.

For long training loops, `upload_mode="spool"` writes one fsynced JSON event file per post-init SDK call under a process spool directory. `python -m rl_observability.uploader` runs separately, holds a single uploader lock, drains each run in filename order, and stops a run on the first failed event while continuing other runs. `log_snapshot()` currently accepts a defined dictionary with `metrics` and event-local `metadata`.

Automatic SDK-owned source metadata is stored under `metadata._rlobs.source`. User metadata may still use top-level `source`, but SDK calls reject user-provided `_rlobs`.

Important limitation:

- `init()` still requires the server. Offline mode does not yet create runs while disconnected.
- Process-spooled metric events send the event ID as `Idempotency-Key`, so compatible servers can deduplicate metric replay after uploader crashes. Other one-request event files should remain naturally idempotent where possible.
- `upload_file()` in process spool mode records `source_path`; users must keep the source file stable until the uploader drains it.

Known simplification follow-ups:

- Consider true offline run creation only after a design doc.
- Do not expand process spool into multi-request snapshot events without idempotency coverage for every request.
- Add larger real-world importer fixtures and a migration playbook for W&B, MLflow, and Neptune.

## Testing

Primary verification commands:

```bash
npm run check:setup
npm run rust:lint
npm run rust:test
python3 -m pytest
npm run test:node
npm run test:contract
npm run test:ui
npm run test:scale
```

`npm run test:contract` and `npm run test:ui` exercise Rust/Postgres/ClickHouse by default through disposable Postgres and ClickHouse. Use `npm run test:contract:node` for deprecated Node route-shape compatibility checks; the full UI smoke now depends on Rust session/auth endpoints.

Rust/Postgres/ClickHouse verification:

- Shared HTTP contract tests run against Rust by default and against Node through the explicit Node compatibility scripts.
- Hosted auth tests should prove org isolation, API-key scopes, revocation, and cross-org denial.
- Database tests should prove Postgres metadata behavior, ClickHouse summary maintenance, and bounded chart queries.
- Migration tests should preserve representative `.rlobs/rlobs.json` data and artifact references.
- UI smoke, importer tests, artifact upload/download tests, and scale smoke should keep passing against Rust before broader hosted rollout.
