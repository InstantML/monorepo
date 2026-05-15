# Rust Server Setup

Use this when working directly on `apps/rust-server`.

## Requirements

- Rust toolchain 1.83 or newer, matching `rust-version = 1.83`.
- A ClickHouse server reachable via `CLICKHOUSE_URL`, or a local `clickhouse` binary so root helpers can start one automatically. The docker-compose stack at the repo root provides ClickHouse; for an ad-hoc container: `docker run --rm -p 8123:8123 -e CLICKHOUSE_DB=instantml clickhouse/clickhouse-server:24.8-alpine`.
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

The `test:rust:*`, `test:contract:direct`, and `test:ui:direct` commands create and clean up disposable ClickHouse instances automatically unless you explicitly point them at an already-running backend with `INSTANTML_CONTRACT_BASE_URL` or `INSTANTML_UI_SMOKE_API_BASE`.

## Root Dev Helper

The root `npm run dev:api` command starts or reuses ClickHouse through `CLICKHOUSE_URL`, applies the ClickHouse schema, then starts this service on `http://127.0.0.1:8000`. If you need clean generated state without touching existing data, choose alternate paths and ports:

```bash
INSTANTML_DEV_CHDATA=/tmp/instantml-clickhouse \
INSTANTML_DEV_CH_LOG_DIR=/tmp/instantml-clickhouse-logs \
CLICKHOUSE_URL=http://default:@127.0.0.1:8124/instantml \
INSTANTML_API_PORT=8010 \
npm run dev:api
```

## Manual Run

Run:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/instantml \
INSTANTML_BIND_ADDR=127.0.0.1:8001 \
INSTANTML_AUTH_MODE=local \
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
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/instantml \
INSTANTML_BIND_ADDR=127.0.0.1:8001 \
INSTANTML_AUTH_MODE=api-key \
INSTANTML_BOOTSTRAP_TOKEN=dev-bootstrap \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Then run the shared contract from another terminal:

```bash
INSTANTML_CONTRACT_BASE_URL=http://127.0.0.1:8001 \
INSTANTML_CONTRACT_BOOTSTRAP_TOKEN=dev-bootstrap \
npm run test:contract:direct
```
