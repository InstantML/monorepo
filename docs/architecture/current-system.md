# Current System Architecture

Date: 2026-05-10

Status: Current architecture summary

## Purpose

This document summarizes the implemented system so future agents do not need to reconstruct the architecture from older sprint docs. `PRODUCT_STRATEGY.md` remains the strategic source of truth; this file describes the current technical shape for Training Observability.

Brand transition note: user-facing docs and UI should say Training Observability. Existing implementation identifiers such as `rl_observability`, `.rlobs`, `rlobs_api`, and `RlobsError` remain compatibility names until a dedicated migration is designed.

Strategy note: the product direction is now a hosted SaaS-first W&B-style competitor for smaller startups, research labs, and lean ML teams. The intended differentiation is speed, UI quality, and predictable pricing. The primary durable backend is Rust plus Postgres, described in `docs/design/2026-05-09-rust-postgres-backend.md`.

Architecture split:

```text
Current/default: Next/React + Python SDK -> Rust API -> Postgres (metadata) + ClickHouse (metrics) -> artifact storage
Deprecated:      Next/React + Python SDK -> Node API -> JSON state + local artifacts
```

The Rust/Postgres path preserves the Node route shapes that the SDK and UI use today. Node remains only as a compatibility oracle, JSON migration source, and legacy fallback.

## Components

- `apps/rust-server`: Primary Rust API and worker service with Postgres storage.
- `apps/server`: Deprecated Node.js API compatibility server. Use it for route-shape regression tests, JSON migration fixtures, and legacy fallback only.
- `apps/web`: Next/React frontend application for the operational UI.
- `packages/python-sdk`: Standard-library Python SDK used by examples and training loops.
- `apps/api`: Python bootstrap/reference API from days 1-4. Keep it as a compatibility target, not the primary product backend.
- `examples`: Dogfood training loops for RL, bandits, and supervised regression.
- `tools`: Operational helpers for import experiments, Rust service smokes, local Rust API startup, and scale smoke.

## Storage

Current dev/default storage:

- Rust/Postgres state under local Postgres by default. `npm run dev:api` manages a local cluster at `.rlobs/postgres`.
- Metric points and aggregated series stored in ClickHouse via the Rust `metric_store::MetricStore`. Local dev expects a ClickHouse server reachable through `CLICKHOUSE_URL` (the docker-compose stack provides one).
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

The Rust/Postgres schema under `apps/rust-server/migrations/` is the durable target and default local/backend schema. `0001_initial.sql` defines the core tables; `0002_run_search_text.sql` adds trigger-maintained run search text and tag/search indexes for fast name/tag/config/note search. The Node JSON server still includes a local version of organizations, users, service accounts, API keys, audit events, maintained metric summaries, idempotent metric ingestion, export, and warning-only usage summaries so it can remain the compatibility oracle and migration source.

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

Importer writes go through a shared normalized importer path. Neptune, W&B, and MLflow dry-runs and real imports validate the same canonical representation before any state is committed. Batch attributes and imports are transactional in Rust/Postgres. Importers use strict JSON-number validation for request-body metrics and steps; query strings are parsed separately for read filters.

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

`npm run test:contract` and `npm run test:ui` exercise Rust/Postgres by default through disposable Postgres. Use `npm run test:contract:node` for deprecated Node route-shape compatibility checks; the full UI smoke now depends on Rust session/auth endpoints.

Rust/Postgres verification:

- Shared HTTP contract tests run against Rust by default and against Node through the explicit Node compatibility scripts.
- Hosted auth tests should prove org isolation, API-key scopes, revocation, and cross-org denial.
- Database tests should prove maintained metric summaries and bounded chart queries.
- Migration tests should preserve representative `.rlobs/rlobs.json` data and artifact references.
- UI smoke, importer tests, artifact upload/download tests, and scale smoke should keep passing against Rust before broader hosted rollout.
