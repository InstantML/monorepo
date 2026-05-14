# Current System Architecture

Date: 2026-05-14

Status: Current architecture summary

## Purpose

This document summarizes the implemented system so future agents do not need to reconstruct the architecture from older sprint docs. `PRODUCT_STRATEGY.md` remains the strategic source of truth; this file describes the current technical shape for Training Observability.

Brand transition note: user-facing docs and UI should say Training Observability. Existing implementation identifiers such as `rl_observability`, `.rlobs`, `rlobs_api`, and `RlobsError` remain compatibility names until a dedicated migration is designed.

Strategy note: the product direction is now a hosted SaaS-first W&B-style competitor for smaller startups, research labs, and lean ML teams. The current primary backend is Rust plus ClickHouse-only storage: operational records for local/control-plane state and analytical metric tables for high-volume scalar metrics. Hosted multi-process routing is intentionally deferred behind `docs/design/2026-05-14-clickhouse-only-storage.md`.

Architecture split:

```text
Current/default:
  apps/web + packages/python-sdk
    -> apps/rust-server
    -> ClickHouse operational records + ClickHouse metrics + artifact storage

Deprecated compatibility:
  apps/web + packages/python-sdk
    -> apps/server
    -> JSON state + local artifacts
```

The Rust/ClickHouse path preserves the Node route shapes that the SDK and UI use today. Node remains only as a compatibility oracle, JSON migration source, and legacy fallback.

Repository shape:

```text
monorepo/
  apps/
    api/           Python bootstrap/reference API
    rust-server/   primary Rust API, worker, ClickHouse schema
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

- `apps/rust-server`: Primary Rust API and worker service with ClickHouse operational storage, ClickHouse metric storage, and local artifact storage.
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

Rust API -> local ClickHouse operational log/index (.rlobs/clickhouse by default)
Rust API -> local ClickHouse metrics               (.rlobs/clickhouse by default)
Rust API -> local artifact bytes                   (.rlobs/rust-artifacts by default)
```

Docker Compose:

```text
Rust API container -> clickhouse service
Rust API container -> rlobs-artifacts volume
Next frontend runs separately with RLOBS_API_BASE=http://127.0.0.1:8000
```

Hosted direction:

```text
Next/React frontend -> global Rust control plane
Python SDK/uploader -> org/cell Rust data-plane service
Control plane -> ClickHouse user/org/service-routing layer
Data plane -> ClickHouse org operational layer + ClickHouse metric layer
Rust API -> S3-compatible artifact storage
```

For the hosted path, start with a shared cell only after a coordination/reconciliation design exists. Dedicated per-customer services/cells make sense for serious customers that need isolation, noisy-neighbor protection, or custom retention.

## Storage

Current dev/default storage:

- ClickHouse `operational_records` stores low-volume records for users, identities, organizations, memberships, sessions, API keys, projects, runs, attributes, artifacts, imports, idempotency, usage snapshots, and table preview rows. The Rust server rebuilds an in-process index from these records on startup.
- ClickHouse `metric_points` stores raw scalar points. ClickHouse `metric_series` is maintained by a materialized view for summary and chart queries.
- `npm run dev:api` starts a local ClickHouse server for the default loopback `CLICKHOUSE_URL` when the `clickhouse` binary is installed, stores generated state under `.rlobs/clickhouse`, and also works with an already-running `CLICKHOUSE_URL`. The docker-compose stack provides ClickHouse for the container path.
- Local artifact bytes are stored through the Rust artifact-store abstraction under `.rlobs/rust-artifacts` by default.
- Python bootstrap API uses SQLite for reference tests.

Deprecated storage:

- Node JSON state at `.rlobs/rlobs.json` for compatibility and migration fixtures.

Durable hosted direction:

- Control-plane ClickHouse layer for user and account data: users, identities, organizations, memberships, service routing, plans, seats, and account status.
- Data-plane ClickHouse layer per shared cell or customer service for API keys, projects, runs, attributes, artifacts, imports, idempotency, audit, usage, and metric tables.
- S3-compatible artifact storage for production byte payloads.
- JSON state retained only for deprecated Node compatibility and migration tooling.

The ClickHouse schema under `apps/rust-server/clickhouse/0001_initial.sql` owns:

- `operational_records`: append-only record log for low-volume operational state.
- `metric_points`: raw scalar metric points, partitioned monthly by `created_at`, ordered by `(org_id, run_id, key, step)`.
- `metric_series`: AggregatingMergeTree table with count/sum/sum_sq/min/max/latest/best states.
- `metric_series_mv`: materialized view that maintains series summaries on metric insert.

## Operational Commands

- `npm run dev:api`: starts or reuses local ClickHouse, applies the ClickHouse schema, then serves the Rust API.
- `npm run test:contract`, `npm run test:rust:sdk`, and `npm run test:ui`: run through `tools/rust-service-smoke.mjs`, which creates disposable ClickHouse state, starts Rust, runs the smoke, and cleans up.
- `npm run benchmark:large-runs`: seeds operational records and metric rows into disposable ClickHouse before measuring summary/search/sort/chart endpoints.
- `npm run dev:api:node` and `npm run test:contract:node`: explicit deprecated Node compatibility paths.

## Data Model

The Rust server stores in ClickHouse operational records:

- Control-plane/local data: users, identities, organizations, memberships, browser sessions, service accounts, API keys, account/plan fields, and service-routing-ready org identifiers.
- Product metadata: projects, runs, typed attributes, artifacts, imports, idempotency records, usage snapshots, and table preview rows.
- Project and run search text is derived in the Rust index from stored run name, tags, config, metadata, and explicit note fields.

The Rust server stores in ClickHouse metric tables:

- Raw `metric_points` rows: `org_id`, `run_id`, `key`, `step`, `value`, `logged_at`, `created_at`.
- Aggregated `metric_series`: `count`, `sum`, `sum_sq`, `min`, `max`, `latest`, `latest_step`, `best_step`, and `latest_logged_at`.
- `mean`, `variance`, and `best` are derived on read.

Metric `step` is a finite nonnegative number across the Rust server, deprecated Node server, Python bootstrap API, SDK, and importer-shaped payloads. Optional metric timestamps must be ISO-compatible datetimes.

## API Surface

SDK-compatible endpoints:

- `POST /runs`
- `PATCH /runs/:run_id`
- `POST /runs/:run_id/metrics`
- `GET /runs/:run_id/metrics`

Product endpoints include bootstrap users/orgs/API keys, auth/session/logout, org seats, run summaries, side-by-side comparison, attributes, artifacts, rich objects, imports, export, usage, and demo reset. See `apps/rust-server/README.md` for the maintained list.

## Design Links

- `docs/design/2026-05-14-clickhouse-only-storage.md`: current storage architecture decision and hosted direction.
- `docs/design/2026-05-11-large-run-query-performance.md`: run-list/query performance expectations.
- `docs/design/2026-05-11-rich-logged-objects.md`: rich object/table/histogram behavior.
- `docs/design/2026-05-11-landing-auth-onboarding.md`: local auth/onboarding route shape.

## Notes For Future Agents

- Treat `apps/rust-server` as the primary backend.
- Treat the ClickHouse operational index as local/test single-process until the hosted coordination design lands.
- Preserve route-shape compatibility unless a design doc explicitly changes the contract.
- Keep Node compatibility smokes available for deprecated route-shape checks until migration tooling no longer needs them.
- Keep list endpoints bounded and keep metric history on dedicated series endpoints.
