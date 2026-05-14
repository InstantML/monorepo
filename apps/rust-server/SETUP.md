# Rust Server Setup

Use this when working directly on `apps/rust-server`.

## Requirements

- Rust toolchain 1.83 or newer, matching `rust-version = 1.83`.
- Local Postgres command-line tools: `psql`, `initdb`, `pg_ctl`, and `createdb`.
- A ClickHouse server reachable via `CLICKHOUSE_URL`, or a local `clickhouse` binary so root helpers can start one automatically. The docker-compose stack at the repo root provides ClickHouse; for an ad-hoc container: `docker run --rm -p 8123:8123 -e CLICKHOUSE_DB=rlobs clickhouse/clickhouse-server:24.8-alpine`.
- Node/npm from the repo root for smoke wrappers.

## Fast Verification

From the repo root:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run test:contract:direct
npm run test:ui:direct
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

The `test:rust:*`, `test:contract:direct`, and `test:ui:direct` commands create and clean up disposable Postgres clusters and ClickHouse instances automatically unless you explicitly point them at an already-running backend with `RLOBS_CONTRACT_BASE_URL` or `RLOBS_UI_SMOKE_API_BASE`.

## Root Dev Helper

The root `npm run dev:api` command manages a generated local Postgres cluster under `.rlobs/postgres` and starts or reuses ClickHouse through `CLICKHOUSE_URL`, then starts this service on `http://127.0.0.1:8000`. If you need clean generated state without touching existing data, choose alternate paths and ports:

```bash
RLOBS_DEV_PGDATA=/tmp/rlobs-postgres \
RLOBS_DEV_PG_LOG=/tmp/rlobs-postgres.log \
RLOBS_DEV_PG_PORT=54339 \
RLOBS_DEV_CHDATA=/tmp/rlobs-clickhouse \
RLOBS_DEV_CH_LOG_DIR=/tmp/rlobs-clickhouse-logs \
CLICKHOUSE_URL=http://default:@127.0.0.1:8124/rlobs \
RLOBS_API_PORT=8010 \
npm run dev:api
```

If an older generated cluster reports a SQLx migration version mismatch, stop the server and remove `.rlobs/postgres` plus `.rlobs/postgres.log`, then rerun `npm run dev:api`.

## Manual Run

Create a database, then run:

```bash
DATABASE_URL=postgres://127.0.0.1:5432/rlobs \
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
RLOBS_BIND_ADDR=127.0.0.1:8001 \
RLOBS_AUTH_MODE=local \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Check:

```bash
curl http://127.0.0.1:8001/healthz
curl http://127.0.0.1:8001/readyz
curl http://127.0.0.1:8001/openapi.json
```

Run API-key mode:

```bash
DATABASE_URL=postgres://127.0.0.1:5432/rlobs \
RLOBS_AUTH_MODE=api-key \
RLOBS_BOOTSTRAP_TOKEN=dev-bootstrap \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Then run the shared contract from another terminal:

```bash
RLOBS_CONTRACT_BASE_URL=http://127.0.0.1:8001 \
RLOBS_CONTRACT_BOOTSTRAP_TOKEN=dev-bootstrap \
npm run test:contract:direct
```
