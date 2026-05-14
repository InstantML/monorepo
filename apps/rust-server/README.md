# Rust Server

This directory contains the primary Rust backend for Training Observability. Postgres stores OLTP metadata; ClickHouse stores the high-volume metric time series. The deprecated Node server remains only as a compatibility oracle, JSON migration source, and legacy fallback.

## Purpose

- Serve the first hosted-backend slice with `axum`, `tokio`, `tower-http`, and SQLx.
- Store projects, runs, bootstrap users/orgs/API keys, attributes, artifacts, imports, usage summaries, immutable usage rollups, and idempotency rows in Postgres.
- Store raw metric points and aggregated metric series in ClickHouse via `metric_store::MetricStore`.
- Preserve current REST response shapes for the SDK, contract smoke, and UI smoke.
- Provide the first hosted-auth slice: local Google-style onboarding, opaque browser sessions, org memberships/seats, and copy-once SDK API-key creation.
- Keep migration tooling, managed Google verification, invitation email delivery, and richer hosted org switching scoped to later TODO phases.

## Local Setup

Install Rust 1.83 or newer through `rustup` and make sure local Postgres tools and either a ClickHouse binary or reachable ClickHouse service are available:

```bash
rustc --version
psql --version
initdb --version
pg_ctl --version
# Needed only when relying on root helpers to auto-start local ClickHouse.
clickhouse --version
```

Start from the repo root. For a normal local Rust run, point `DATABASE_URL` at a Postgres database:

```bash
DATABASE_URL=postgres://127.0.0.1:5432/rlobs \
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
RLOBS_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

The `serve` command applies migrations before listening. The service also creates a fixed local development organization for unauthenticated local compatibility mode. Browser dashboard sessions created by the local dev auth flow use their own signed-in org instead.

For the root `npm run dev:api` helper, local generated Postgres state lives under `.rlobs/postgres` and local ClickHouse state/logs live under `.rlobs/clickhouse` and `.rlobs/clickhouse-logs`. If the Postgres cluster was created by an older checkout and SQLx reports a migration version mismatch, remove `.rlobs/postgres` and `.rlobs/postgres.log`, or start a separate generated cluster by setting `RLOBS_DEV_PGDATA`, `RLOBS_DEV_PG_LOG`, `RLOBS_DEV_PG_PORT`, and `RLOBS_API_PORT`. Set `CLICKHOUSE_URL` to use an existing ClickHouse service, or leave the default loopback URL so the helper can start a local `clickhouse server` when the binary is installed.

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

`worker` deletes expired idempotency rows and expired/revoked browser sessions, then writes immutable `usage_daily` snapshots for each organization. It remains intentionally small until broader Postgres-backed jobs are needed.

## Config

Environment variables:

- `DATABASE_URL`: Postgres connection string. Default: `postgres://postgres:postgres@127.0.0.1:5432/rlobs`.
- `CLICKHOUSE_URL`: ClickHouse HTTP connection string of the form `http://user:pass@host:port/database`. Default: `http://default:@127.0.0.1:8123/rlobs`. The named database is created if missing on startup.
- `RLOBS_BIND_ADDR`: API bind address. Default: `127.0.0.1:8001`.
- `RLOBS_AUTH_MODE`: `local` or `api-key`. Default: `local`.
- `RLOBS_BOOTSTRAP_TOKEN`: required for bootstrap routes when `RLOBS_AUTH_MODE=api-key`.
- `RLOBS_ARTIFACT_ROOT`: local artifact byte root. Default: `.rlobs/rust-artifacts`.
- `RLOBS_MAX_BODY_BYTES`: general JSON body cap. Default: `1000000`.
- `RLOBS_MAX_UPLOAD_BODY_BYTES`: upload JSON body cap. Default: `50000000`.
- `RLOBS_REQUEST_TIMEOUT_SECONDS`: HTTP timeout. Default: `30`.
- `RLOBS_DB_ACQUIRE_TIMEOUT_SECONDS`: SQLx pool acquire timeout. Default: `5`.
- `RLOBS_LOG_FORMAT`: `pretty` or `json`. Default: `pretty`.
- `RLOBS_DEV_AUTH_ENABLED`: enables the local Google-style auth endpoint when `RLOBS_AUTH_MODE=local`. Loopback local binds enable it by default.
- `RLOBS_ALLOWED_FRONTEND_ORIGINS`: comma-separated extra origins allowed to perform cookie-authenticated mutating requests.

Root helper-only environment variables:

- `RLOBS_DEV_PGDATA`, `RLOBS_DEV_PG_LOG`, `RLOBS_DEV_PG_PORT`: generated Postgres state, log, and port for `npm run dev:api`.
- `RLOBS_DEV_CHDATA`, `RLOBS_DEV_CH_LOG_DIR`: generated ClickHouse state and logs for `npm run dev:api`.
- `RLOBS_DEV_CH_TCP_PORT`, `RLOBS_DEV_CH_INTERSERVER_PORT`, `RLOBS_DEV_CH_MYSQL_PORT`, `RLOBS_DEV_CH_POSTGRESQL_PORT`: optional ClickHouse non-HTTP ports for avoiding local collisions.

## HTTP Surface

Implemented health and platform endpoints:

- `GET /health`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `GET /openapi.json`

Implemented compatibility routes cover the P0-P3 slices: bootstrap users/orgs/API keys, API-key auth, local dev Google-style onboarding, browser sessions, org seat reservation, projects, runs, scalar metrics, typed attributes, rich logged objects, artifact metadata/upload/download, side-by-side comparison, bounded export, Neptune/W&B/MLflow imports, usage summaries/export, and demo reset. Demo reset generates 1,000 deterministic synthetic LLM/RL runs with rich train/eval/system metrics, searchable tags, searchable notes, hardware metadata, checkpoints, MP3 audio artifact metadata, MP4 rollout artifact metadata, and representative table/histogram logged objects through a transactional reset path so failed resets do not leave partial demo projects. Run summaries honor project/status/search filters, server-side sorting, cursor pagination, full filtered metric-key discovery for the Runs workspace, and whitespace-token search across run name/tags/config/explicit note fields so queries such as `seed 13` and `reward stability` match split search text. Artifact list reads accept a bounded `limit` query. Object list reads use `GET /api/runs/:run_id/objects`, table rows use `GET /api/objects/:object_id/rows`, and rich-object writes use `POST /api/runs/:run_id/objects` with same-run artifact validation. Generic `/attributes` writes reject `table`, `image`, `video`, and `audio` so callers cannot bypass object caps or artifact validation. Scalar metric ingestion validates finite nonnegative steps, bulk-writes `metric_points`, batch-upserts `metric_series` in the same transaction, and stores idempotency responses for replay. General JSON routes are capped at `RLOBS_MAX_BODY_BYTES`; only artifact upload uses `RLOBS_MAX_UPLOAD_BODY_BYTES`.

Auth and onboarding routes:

- `GET /api/auth/config`: provider availability for the frontend.
- `POST /api/auth/dev/google`: local-only Google-style signup/signin that creates a user, org, owner membership, optional reserved seats, and an `HttpOnly` session cookie.
- `POST /api/auth/google`: managed Google placeholder; returns a client-safe unavailable error until a verifier is configured.
- `GET /api/auth/session`: current session payload or `{ "authenticated": false }`.
- `POST /api/auth/logout`: revokes and clears the browser session.
- `POST /api/orgs/:org_id/seats`: owner/admin session seat reservation with transactional seat-limit enforcement.

Run identity updates:

- `PATCH /runs/:id` accepts optional `status`, `tags`, and `notes`; at least one field is required.
- `tags` replaces the searchable `runs.tags` list.
- `notes` writes `metadata.notes`; an empty string removes the note.
- Search is backed by a trigger-maintained `runs.search_text` column plus trigram index. The trigger includes run name, tags, config text, and explicit note fallback fields (`notes`, `note`, `description`, `summary`, `comment`) without exposing `search_text` in API responses.

Large-run query behavior:

- `GET /api/runs/summary` accepts `cursor` in addition to existing `limit`, `offset`, `project`, `project_id`, `status`, `q`, `sort_by`, and `metric_key` parameters.
- Rust responses include `next_cursor` and `page_info.has_next_page`; old clients can ignore those fields.
- Cursor tokens are URL-safe base64 JSON values bound to sort, selected metric, normalized filter scope, and auth/project scope. Mismatches return the existing `{"error": "..."}` 400 shape.
- Supported server-side sorts are newest, name, status, duration, selected metric latest, and selected metric best. Metric sorts page rows with values first, then rows missing the selected metric.
- Migration `0003_large_run_query_indexes.sql` adds the run and metric-series indexes used by the 90,000-run benchmark.

In `RLOBS_AUTH_MODE=api-key`, tenant context comes from the bearer API key. Project-scoped keys can access only their project; org-wide usage, demo reset, and API-key administration require unrestricted org-scoped keys, an owner/admin browser session, or the bootstrap token depending on route class. Run/metric/attribute mutations require `sdk:ingest`, artifact metadata/upload routes require `artifacts:write`, imports require `imports:write`, usage requires `usage:read`, and key administration requires `api_keys:write` or an owner/admin session. Managed Google/JWT auth remains a provider-neutral boundary only.

## Testing

Rust integration tests start disposable Postgres with `initdb`/`pg_ctl`, apply all migrations in `migrations/`, and exercise the real SQL paths:

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

These commands start disposable Postgres, disposable ClickHouse, and the Rust server automatically. `test:rust:contract` and `test:contract:direct` run the shared black-box API contract in API-key mode. `test:rust:sdk` drives the Python SDK against Rust local mode. `test:rust:ui` and `test:ui:direct` build the Next app and run the Playwright smoke with Rust as `RLOBS_API_BASE`, including landing, local auth, onboarding, and dashboard routes. Use `npm run test:contract:node` only for deprecated Node route-shape compatibility checks.

Large-run benchmark:

```bash
RLOBS_BENCH_RUNS=90000 RLOBS_BENCH_SAMPLES=10 RLOBS_BENCH_WARMUPS=2 RLOBS_BENCH_WEB=1 npm run benchmark:large-runs
```

On 2026-05-11 local hardware, the 90,000-run fixture measured project newest summary p95 78 ms, org newest summary p95 68 ms, token search p95 118 ms, selected metric-best sort p95 66 ms, chart series p95 22 ms, and production-web first useful render 387 ms. The rich-object fixture measured selected-run object list p95 47.5 ms for 500 objects, table-only object list p95 8.3 ms, and table rows p95 1.9 ms for 1,000 bounded rows. Treat these as local regression evidence, not hosted SLOs.

## Coverage Expectations

Rust first-party service logic targets 100% meaningful coverage for validation, SQL transaction orchestration, idempotency handling, auth decisions, artifact byte handling, and API compatibility. The current tests cover migrations, concurrent org/project creation, project/run creation, batch metric ingestion, idempotency replay/conflict, maintained summaries, rich-object create/list/table-row reads, same-run artifact object validation, API-key auth, browser session creation/authentication/revocation, seat-limit reservation, owner/admin API-key creation from sessions, revoked/expired/disabled service accounts, project-scoped authorization, artifact byte cleanup and missing-file detection, imports, exports, usage counts, immutable usage snapshots, and Rust-backed SDK/UI/contract smokes.

## Key Files

- `Cargo.toml`: Rust dependencies and binary target.
- `src/main.rs`: CLI subcommands and server startup.
- `src/config.rs`: environment config and local defaults.
- `src/http/mod.rs`: HTTP app state, route table, and middleware wiring.
- `src/http/handlers.rs`: route handlers, auth context resolution, request parsing, cookies, and response shapes.
- `src/store/mod.rs`: store module root, shared constants, database connection/migration helpers, worker cleanup entry points, and shared audit helpers.
- `src/store/projects.rs`: project create/list helpers and restricted-project lookup.
- `src/store/runs.rs`: run create/list/detail/update, run summaries, overview stats, run filtering/cursors, and run access checks.
- `src/store/metrics.rs`: scalar metric ingestion, metric reads, batched metric series reads, idempotency locks, and metric value validation.
- `src/store/objects.rs`: typed attributes, rich logged objects, table rows, object validation, and attribute insert helpers.
- `src/store/artifacts.rs`: artifact metadata, local upload persistence, artifact lookup, and artifact insert helpers.
- `src/store/export.rs`: bounded project/run/metric/attribute/artifact export assembly.
- `src/store/comparison.rs`: side-by-side run comparison assembly and run-id parsing.
- `src/store/auth_admin.rs`: users, organizations, memberships, browser sessions, API keys, and service account auth.
- `src/store/demo.rs`: deterministic demo-project reset data and demo metric/artifact generation.
- `src/store/imports.rs`: Neptune, W&B, and MLflow import normalization and persistence.
- `src/store/usage.rs`: warning-only usage summaries, exports, and daily usage snapshots.
- `src/domain.rs`: DTOs and validation helpers.
- `src/artifact_store.rs`: local staged artifact byte storage and root-confined reads.
- `src/managed_auth.rs`: provider-neutral managed-auth adapter boundary.
- `migrations/0001_initial.sql`: core Postgres schema.
- `migrations/0002_run_search_text.sql`: trigger-maintained run search text and tag/search indexes.
- `migrations/0003_large_run_query_indexes.sql`: run-list and metric-sort indexes for large projects.
- `migrations/0004_rich_logged_objects.sql`: rich logged object table-row storage and object-list indexes.
- `migrations/0005_landing_auth_onboarding.sql`: org account type, membership status, and browser sessions.
- `tests/postgres.rs`: disposable Postgres integration tests.

## Design Docs

- `docs/design/2026-05-09-rust-postgres-backend.md`
- `docs/design/2026-05-10-run-tags-notes-editing.md`
- `docs/design/2026-05-11-large-run-query-performance.md`
- `docs/design/2026-05-11-landing-auth-onboarding.md`

## Notes For Future Agents

- Rust is the default backend; preserve documented route shapes and run `npm run test:contract` after behavior changes.
- Keep `npm run test:contract:node` available when a change might break legacy Node compatibility or future JSON migration assumptions.
- Keep scalar metric summaries maintained at ingestion time; summary/list endpoints must not scan raw metric history.
- Keep run list endpoints cursor/page bounded. If projects develop very high metric-key cardinality, split metric-key catalog discovery from the hot summary route before claiming broader scale.
- Keep compatibility org context explicit: API-key mode uses the key org, local mode uses the fixed local org.
- Keep project-scoped API keys flowing through `ensure_run_access`/project-aware helpers before returning run-derived data.
- Keep idempotency checks inside the metric transaction and protected by the transaction-scoped advisory lock.
- Keep bounded JSON export caps explicit until P6 adds streaming export.
- Artifact byte writes should stage, finalize, commit metadata, and clean up temp/finalized bytes on finalize or DB errors. Crash-only orphan cleanup/retention remains a P8 operational hardening task.
