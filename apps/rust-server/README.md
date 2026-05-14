# Rust Server

This directory contains the primary Rust backend for Training Observability. The current storage slice is ClickHouse-only: a low-volume operational record log rebuilds local/control-plane state, while metric tables remain the high-volume analytical layer. The deprecated Node server remains only as a compatibility oracle, JSON migration source, and legacy fallback.

## Purpose

- Serve the product API with `axum`, `tokio`, and `tower-http`.
- Store users, orgs, sessions, API keys, projects, runs, attributes, artifacts, imports, usage snapshots, and idempotency records as append-only operational records in ClickHouse.
- Store raw metric points and aggregated metric series in ClickHouse via `metric_store::MetricStore`.
- Preserve current REST response shapes for the SDK, contract smoke, and UI smoke.
- Keep hosted multi-process/control-plane routing work behind `docs/design/2026-05-14-clickhouse-only-storage.md`; the in-process operational index is accepted for local/test and narrow single-process use only.

## Local Setup

Install Rust 1.83 or newer through `rustup` and make sure a ClickHouse service is reachable. The root helper can auto-start a local `clickhouse server` for loopback URLs when the binary is installed.

```bash
rustc --version
clickhouse --version
```

Start from the repo root:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
RLOBS_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

The `serve` command applies the ClickHouse schema before listening. It also creates a fixed local development organization for unauthenticated local compatibility mode. Browser dashboard sessions created by the local dev auth flow use their own signed-in org.

For the root `npm run dev:api` helper, generated ClickHouse state/logs live under `.rlobs/clickhouse` and `.rlobs/clickhouse-logs`. Set `CLICKHOUSE_URL` to use an existing service, or leave the default loopback URL so the helper can start a local `clickhouse server`.

## Commands

From the repo root:

```bash
npm run dev:api
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run rust:migrate
npm run rust:serve
```

Binary subcommands:

```bash
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
cargo run --manifest-path apps/rust-server/Cargo.toml -- all
cargo run --manifest-path apps/rust-server/Cargo.toml -- migrate
cargo run --manifest-path apps/rust-server/Cargo.toml -- worker
```

`worker` prunes expired idempotency keys and expired/revoked browser sessions from the single-process index, then writes immutable `usage_daily` snapshots for each organization. With the ClickHouse-only first slice, cleanup compacts live memory only; durable operational-log compaction is deferred to the hosted storage follow-up.

## Config

Environment variables:

- `CLICKHOUSE_URL`: ClickHouse HTTP connection string of the form `http://user:pass@host:port/database`. Default: `http://default:@127.0.0.1:8123/rlobs`. The named database is created if missing on startup.
- `RLOBS_BIND_ADDR`: API bind address. Default: `127.0.0.1:8001`.
- `RLOBS_AUTH_MODE`: `local` or `api-key`. Default: `local`.
- `RLOBS_BOOTSTRAP_TOKEN`: required for bootstrap routes when `RLOBS_AUTH_MODE=api-key`.
- `RLOBS_ARTIFACT_ROOT`: local artifact byte root. Default: `.rlobs/rust-artifacts`.
- `RLOBS_MAX_BODY_BYTES`: general JSON body cap. Default: `1000000`.
- `RLOBS_MAX_UPLOAD_BODY_BYTES`: upload JSON body cap. Default: `50000000`.
- `RLOBS_REQUEST_TIMEOUT_SECONDS`: HTTP timeout. Default: `30`.
- `RLOBS_LOG_FORMAT`: `pretty` or `json`. Default: `pretty`.
- `RLOBS_DEV_AUTH_ENABLED`: enables the local Google-style auth endpoint when `RLOBS_AUTH_MODE=local`. Loopback local binds enable it by default.
- `RLOBS_ALLOWED_FRONTEND_ORIGINS`: comma-separated extra origins allowed to perform cookie-authenticated mutating requests.

Root helper-only environment variables:

- `RLOBS_DEV_CHDATA`, `RLOBS_DEV_CH_LOG_DIR`: generated ClickHouse state and logs for `npm run dev:api`.
- `RLOBS_DEV_CH_TCP_PORT`, `RLOBS_DEV_CH_INTERSERVER_PORT`, `RLOBS_DEV_CH_MYSQL_PORT`: optional non-HTTP ports for avoiding local collisions.

## HTTP Surface

Implemented health and platform endpoints:

- `GET /health`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `GET /openapi.json`

Implemented compatibility routes cover bootstrap users/orgs/API keys, API-key auth, local dev Google-style onboarding, browser sessions, org seat reservation, projects, runs, scalar metrics, typed attributes, rich logged objects, artifact metadata/upload/download, side-by-side comparison, bounded export, Neptune/W&B/MLflow imports, usage summaries/export, and demo reset. List endpoints are bounded; raw metric history is fetched through separate series endpoints.

In `RLOBS_AUTH_MODE=api-key`, tenant context comes from the bearer API key. Project-scoped keys can access only their project; org-wide usage, demo reset, and API-key administration require unrestricted org-scoped keys, an owner/admin browser session, or the bootstrap token depending on route class. Run/metric/attribute mutations require `sdk:ingest`, artifact metadata/upload routes require `artifacts:write`, imports require `imports:write`, usage requires `usage:read`, and key administration requires `api_keys:write` or an owner/admin session.

## Testing

Rust unit tests:

```bash
npm run rust:test
```

Run shared smokes against Rust:

```bash
npm run test:contract
npm run test:ui
npm run test:contract:direct
npm run test:ui:direct
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

These commands start disposable ClickHouse and the Rust server automatically. `test:rust:contract` and `test:contract:direct` run the shared black-box API contract in API-key mode. `test:rust:sdk` drives the Python SDK against Rust local mode. `test:rust:ui` and `test:ui:direct` build the Next app and run the Playwright smoke with Rust as `RLOBS_API_BASE`, including landing, local auth, onboarding, and dashboard routes. Use `npm run test:contract:node` only for deprecated Node route-shape compatibility checks.

Large-run benchmark:

```bash
RLOBS_BENCH_RUNS=90000 RLOBS_BENCH_SAMPLES=10 RLOBS_BENCH_WARMUPS=2 RLOBS_BENCH_WEB=1 npm run benchmark:large-runs
```

The large-run and rich-object benchmarks seed disposable ClickHouse operational records and metric rows directly, then start the Rust API and measure bounded summary/search/sort/chart/object endpoints.

## Coverage Expectations

Rust first-party service logic targets 100% meaningful coverage for validation, storage orchestration, idempotency handling, auth decisions, artifact byte handling, and API compatibility. Contract, SDK, UI, and benchmark smokes are part of the required verification because the current ClickHouse-only operational index is a storage-layer change with broad route impact.

Coverage exception:
- Uncovered area: durable multi-process reconciliation and hosted service routing for the ClickHouse operational log.
- Reason: the accepted first slice is local/test single-process only.
- Risk: multiple Rust API processes pointed at the same operational table can serve stale index state until a later coordination design lands.
- Follow-up: implement the hosted control-plane/data-plane design in `docs/design/2026-05-14-clickhouse-only-storage.md`.
- Owner/date: future storage owner, 2026-05-14.

## Key Files

- `Cargo.toml`: Rust dependencies and binary target.
- `src/main.rs`: CLI subcommands and server startup.
- `src/config.rs`: environment config and local defaults.
- `src/http/mod.rs`: HTTP app state, route table, and middleware wiring.
- `src/http/handlers.rs`: route handlers, auth context resolution, request parsing, cookies, and response shapes.
- `src/store/mod.rs`: ClickHouse-backed operational index core and module re-exports.
- `src/store/auth.rs`: users, organizations, sessions, API keys, and admin authorization helpers.
- `src/store/runs.rs`: projects, runs, run filtering/summaries, scalar metric writes, and metric read endpoints.
- `src/store/objects.rs`: typed attributes, rich objects, table rows, artifacts, and local artifact upload metadata.
- `src/store/imports.rs`: Neptune, W&B, and MLflow import normalization and import records.
- `src/store/export.rs`: side-by-side comparison and bounded JSON export.
- `src/store/usage.rs`: usage summaries, daily snapshots, and worker cleanup helpers.
- `src/store/demo.rs`: demo project reset and synthetic data generation.
- `src/store/access.rs`: shared project/run/session access checks and auth-adjacent row helpers.
- `src/store/summaries.rs`: run summaries, artifact counts, metric-series conversion, and export metric reads.
- `src/store/validation.rs`: shared store validation, JSON value shaping, slugging, and unit tests for pure store logic.
- `src/metric_store.rs`: ClickHouse schema migration, operational record append/load helpers, metric point writes, and metric-series reads.
- `src/domain.rs`: DTOs and validation helpers.
- `src/artifact_store.rs`: local staged artifact byte storage and root-confined reads.
- `src/managed_auth.rs`: provider-neutral managed-auth adapter boundary.
- `clickhouse/0001_initial.sql`: operational record log, metric points, metric series, and materialized view schema.

## Design Docs

- `docs/design/2026-05-14-clickhouse-only-storage.md`
- `docs/design/2026-05-10-run-tags-notes-editing.md`
- `docs/design/2026-05-11-large-run-query-performance.md`
- `docs/design/2026-05-11-landing-auth-onboarding.md`

## Notes For Future Agents

- Rust is the default backend; preserve documented route shapes and run `npm run test:contract` after behavior changes.
- Keep `npm run test:contract:node` available when a change might break legacy Node compatibility or future JSON migration assumptions.
- Keep scalar metric summaries maintained by ClickHouse materialized views; summary/list endpoints must not scan raw metric history.
- Keep run list endpoints cursor/page bounded.
- Keep compatibility org context explicit: API-key mode uses the key org, local mode uses the fixed local org.
- Keep project-scoped API keys flowing through project-aware helpers before returning run-derived data.
- Keep bounded JSON export caps explicit until streaming export has its own design.
- Artifact byte writes should stage, finalize, commit metadata, and clean up temp/finalized bytes on finalize or storage errors. Crash-only orphan cleanup/retention remains operational hardening work.
