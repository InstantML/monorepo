# Current System Architecture

Date: 2026-05-16

Status: Current architecture summary

## Purpose

This document summarizes the implemented system so future agents do not need to reconstruct the architecture from older sprint docs. `PRODUCT_STRATEGY.md` remains the strategic source of truth; this file describes the current technical shape for InstantML.

Strategy note: the product direction is now a hosted SaaS-first W&B-style competitor for smaller startups, research labs, and lean ML teams. The current packaging model is Free, Pro, and Premium with usage guardrails: new project, run, metric-ingest, artifact, import, and demo-reset writes are blocked at plan limits until billing/provider reconciliation and paid overages are implemented. Metric-point limits use the current UTC calendar month and reset on the first day of the next month; storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource counts. The current primary backend is Rust plus ClickHouse-only storage: operational records for local/control-plane state and analytical metric tables for high-volume scalar metrics. Hosted multi-process routing now has launch wiring through split Cloud Run `control` and `data` services; deterministic full replay, role-specific HTTP surfaces, and data-plane control-record refresh exist, but shared-cell multi-writer freshness and write uniqueness are not complete.

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

- `apps/rust-server`: Primary Rust API and worker service with ClickHouse operational storage, ClickHouse metric storage, plan-aware signup/admin routes, and local artifact storage.
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

Rust API -> local ClickHouse operational log/index (.instantml/clickhouse by default)
Rust API -> local ClickHouse metrics               (.instantml/clickhouse by default)
Rust API -> local artifact bytes                   (.instantml/rust-artifacts by default)
```

Docker Compose:

```text
Rust API container -> clickhouse service
Rust API container -> instantml-artifacts volume
Next frontend runs separately with INSTANTML_API_BASE=http://127.0.0.1:8000
```

Hosted direction:

```text
Next/React frontend -> global Rust control plane
Python SDK/uploader -> org/cell Rust data-plane service
Control plane -> ClickHouse user/org/service-routing layer
Data plane -> ClickHouse org operational layer + ClickHouse metric layer
Rust API -> S3-compatible artifact storage
```

For the hosted path, do not add a central hot-path application proxy for all SDK/browser/metric/artifact traffic. Use a global control-plane responsibility for auth, org lookup, account state, and tenant routes, then route to data-plane cells. The Rust binary can be started as `INSTANTML_SERVICE_PLANE=combined`, `control`, or `data`; the deploy helper can launch either the combined service or split control/data Cloud Run services. Start with dedicated single-active-instance customer cells when isolation is needed, and start shared multi-instance cells only after the read/write gates in `docs/design/2026-05-16-multi-instance-control-data-plane.md` are closed. Dedicated per-customer services/cells make sense for serious customers that need isolation, noisy-neighbor protection, or custom retention.

Internal hosted first slice:

```text
Local Next frontend on :3000 -> Cloud Run Rust API, max instances 1
Python SDK/uploader -----------> Cloud Run Rust API, max instances 1

Cloud Run Rust API -> ClickHouse Cloud User Data control table
Cloud Run Rust API -> ClickHouse Cloud tenant services
Cloud Run Rust API -> static Cloud NAT egress IP for ClickHouse service and API-key allowlisting
```

This Cloud Run slice is operationally useful but not public-launch complete. It uses Secret Manager for runtime secrets, keeps dev auth disabled, restricts ClickHouse Cloud services and API keys to the Cloud Run static egress IP plus explicit operator IPs, restricts hosted Clerk signup by allowlist, and disables hosted artifact byte uploads until object storage is designed.

Split Cloud Run launch wiring:

```text
Public HTTPS API URL / managed load balancer
  -> Cloud Run instantml-control, INSTANTML_SERVICE_PLANE=control
  -> Cloud Run instantml-data-<region>-a, INSTANTML_SERVICE_PLANE=data

Both services -> same Cloud NAT static egress IP
Both services -> ClickHouse User Data control table
Data service  -> routed tenant ClickHouse service/database
```

The default deploy command is now `npm run deploy:cloud-run`, which launches the split control/data topology. `npm run deploy:cloud-run:multi` is the explicit split alias, and `npm run deploy:cloud-run:single` is the legacy combined-service path. Both control and data default to manual scaling with one active instance until their multi-process freshness and uniqueness gates are complete. Set `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER=1` and `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN` to create the managed HTTPS public router; HTTP-only public IP routing is rejected.

## Storage

Current dev/default storage:

- ClickHouse `operational_records` stores low-volume records for users, identities, organizations, memberships, sessions, API keys, projects, runs, attributes, artifacts, imports, idempotency, usage snapshots, and table preview rows. The Rust server rebuilds an in-process index from these records on startup.
- ClickHouse `metric_points` stores raw scalar points. ClickHouse `metric_series` is maintained by a materialized view for summary and chart queries.
- `npm run dev:api` starts a local ClickHouse server for the default loopback `CLICKHOUSE_URL` when the `clickhouse` binary is installed, stores generated state under `.instantml/clickhouse`, and also works with an already-running `CLICKHOUSE_URL`. The docker-compose stack provides ClickHouse for the container path.
- Local artifact bytes are stored through the Rust artifact-store abstraction under `.instantml/rust-artifacts` by default.
- Python bootstrap API uses SQLite for reference tests.

Deprecated storage:

- Node JSON state at `.instantml/instantml.json` for compatibility and migration fixtures.

Durable hosted direction:

- Control-plane ClickHouse layer for user and account data: users, identities, organizations, memberships, service routing, tenant-route warehouse profile metadata, plans, seats, API keys, and account status.
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
- `npm run deploy:cloud-run`: builds one Rust image and deploys split control/data Cloud Run services with role-specific environment. The data service remains manual single-instance by default; use this as launch wiring, not as permission to run shared data cells with multiple active writers. With `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER=1` and a router domain, it can also create the managed HTTPS public router.
- `npm run deploy:cloud-run:single`: deploys the Rust API to the internal single-instance combined Cloud Run service, syncs secrets, configures static egress, updates ClickHouse Cloud service and API-key allowlists when credentials are present, and writes the hosted API URL to local frontend env files.
- `npm run test:contract`, `npm run test:rust:sdk`, and `npm run test:ui`: run through `tools/rust-service-smoke.mjs`, which creates disposable ClickHouse state, starts Rust, runs the smoke, and cleans up.
- `npm run test:hosted-clickhouse`: runs separate local Rust `control` and `data` service-plane processes against disposable ClickHouse User Data and tenant databases, then verifies control-only routes, data-only routes, plan-aware signup, tenant-route warehouse profile metadata, seat invites and invited-member activation, API-key/session auth refresh, SDK ingestion, usage/admin reads, and data-plane restart replay.
- `npm run benchmark:large-runs`: seeds operational records and metric rows into disposable ClickHouse before measuring summary/search/sort/chart endpoints.
- `npm run benchmark:cloud-run`: measures the deployed hosted data API with bearer auth against the large hosted-scale tenant, covering Cloud Run -> ClickHouse summary/search/filter/sort/overview/chart and batched selected-run series paths.
- `npm run dev:api:node` and `npm run test:contract:node`: explicit deprecated Node compatibility paths.

## Data Model

The Rust server stores in ClickHouse operational records:

- Control-plane/local data: users, identities, organizations, memberships, browser sessions, service accounts, API keys, account/plan fields, tenant-route requested/applied warehouse profile fields, and service-routing-ready org identifiers.
- Product metadata: projects, runs, typed attributes, artifacts, imports, idempotency records, usage snapshots, and table preview rows.
- Project and run search text is derived in the Rust index from stored run name, tags, config, metadata, and explicit note fields.

The Rust server stores in ClickHouse metric tables:

- Raw `metric_points` rows: `org_id`, `run_id`, `key`, `step`, `value`, `logged_at`, `created_at`.
- Aggregated `metric_series`: `count`, `sum`, `sum_sq`, `min`, `max`, `latest`, `latest_step`, `best_step`, and `latest_logged_at`.
- `mean`, `variance`, and `best` are derived on read.

Metric `step` is a finite nonnegative number across the Rust server, deprecated Node server, Python bootstrap API, SDK, and importer-shaped payloads. Optional metric timestamps must be ISO-compatible datetimes.

## API Surface

The maintained route reference is `docs/architecture/current-api.md`. The Rust
service also exposes a compact live route index at `GET /openapi.json` so
operators can verify the deployed surface.

The maintained schema reference is `docs/architecture/current-schemas.md`. It
documents the User Data control table, tenant operational records, metric/log
tables, materialized summaries, JSON payload schemas, and plane placement by
local/hosted mode.

Core SDK-compatible endpoints:

- `POST /runs`
- `PATCH /runs/:run_id`
- `POST /runs/:run_id/metrics`
- `GET /runs/:run_id/metrics`

Product endpoints include bootstrap users/orgs/API keys, auth/session/logout, plan-aware signup, org seat invite/list, API-key admin, run summaries, side-by-side comparison, attributes, artifacts, rich objects, imports, export, usage, and demo reset. See `apps/rust-server/README.md` for the maintained list.

Human hosted auth is documented in `auth-and-tenant-flow.md`: Clerk sign-up selects a plan, records warehouse intent, and establishes an InstantML browser session for one active org membership; Clerk sign-in can activate an invited membership by verified email. SDKs continue to use org-scoped API keys. Session and API-key requests both resolve an org before tenant data is read or mutated.

## Design Links

- `docs/design/2026-05-14-clickhouse-only-storage.md`: current storage architecture decision and hosted direction.
- `docs/design/2026-05-11-large-run-query-performance.md`: run-list/query performance expectations.
- `docs/design/2026-05-11-rich-logged-objects.md`: rich object/table/histogram behavior.
- `docs/design/2026-05-11-landing-auth-onboarding.md`: local auth/onboarding route shape.
- `docs/design/2026-05-16-clerk-hosted-auth.md`: Clerk hosted auth, org-name uniqueness, and ClickHouse Cloud warehouse defaults.
- `docs/design/2026-05-16-gcp-cloud-run-rust-api.md`: internal single-instance Cloud Run deployment, Secret Manager, static ClickHouse egress, and local frontend-to-hosted API workflow.
- `docs/design/2026-05-16-multi-instance-control-data-plane.md`: accepted multi-instance architecture direction, central-proxy rejection, route/auth/storage gates, and deterministic replay first slice.
- `docs/design/2026-05-16-cloud-run-multi-instance-launch.md`: Cloud Run split deploy helper, Docker Compose split profile, scaling defaults, and launch wiring.
- `docs/design/2026-05-16-pricing-signup-org-admin.md`: Free/Pro/Premium signup, warehouse profile metadata, seat invites, invited-member activation, usage/admin settings, and API-key management.
- `docs/product/pricing-and-margins.md`: current packaging, cost assumptions, margin targets, and launch guardrails.
- `docs/architecture/multi-instance-cloud-run.md`: current split Cloud Run overview with diagrams and launch checklist.
- `docs/architecture/current-schemas.md`: current control/data-plane schema reference.
- `docs/architecture/auth-and-tenant-flow.md`: current human/session/API-key tenant authorization flow.

## Notes For Future Agents

- Treat `apps/rust-server` as the primary backend.
- Treat the ClickHouse operational index as local/test or data-cell single-writer until the multi-instance control/data-plane gates land. The deterministic replay helper, split service-plane roles, and split Cloud Run deployment helper are groundwork, not permission to run shared data cells with multiple active writers.
- Preserve route-shape compatibility unless a design doc explicitly changes the contract.
- Keep Node compatibility smokes available for deprecated route-shape checks until migration tooling no longer needs them.
- Keep list endpoints bounded and keep metric history on dedicated series endpoints.
