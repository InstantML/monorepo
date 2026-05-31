# Apps

This directory contains runnable applications.

Use the root `../SETUP.md` before running app commands from a fresh clone.

Expected apps:

- `api/`: Python bootstrap/reference API service.
- `admin/`: separate internal Next/React operator console for read-only users,
  orgs, storage, API-key, billing, and risk inspection.
- `docs/`: public documentation source and filtered OpenAPI reference rendered
  by `web/` at `/docs`.
- `rust-server/`: Primary Rust API and worker service home. It contains the accepted ClickHouse schema migration, ClickHouse metric-store integration, raw/versioned artifact API, runnable service commands, and product API.
- `server/`: Deprecated Node.js compatibility server for route-shape regression tests, JSON migration fixtures, and legacy local fallback.
- `web/`: Next/React frontend web application.

Future agents must update this README when apps are added, renamed, removed, or when shared app-level commands change.

Current backend/product API work should start in `rust-server/`. Preserve `server/` compatibility where practical so Node can keep serving as a legacy behavior oracle and migration source. Keep `api/` small and compatible for SDK reference tests.

Primary local/hosted target:

```text
apps/web -> apps/rust-server -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
apps/admin -> apps/rust-server control plane -> projected users/orgs/API keys/storage/billing/risk
packages/python-sdk/uploader -> apps/rust-server -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
```

Hosted production/staging currently implement that target with split Cloud Run
control/data services, self-hosted ClickHouse on Google Cloud for User Data and
tenant databases, and Cloudflare R2 for raw and versioned artifact bytes.

Deprecated local compatibility target:

```text
apps/web -> apps/server -> .instantml/instantml.json + local artifact files
packages/python-sdk/uploader -> apps/server -> .instantml/instantml.json + local artifact files
```

Rust work should preserve documented route shapes, use the schema in `rust-server/clickhouse/`, keep ClickHouse metric-store behavior compatible, and keep `npm run test:contract`, `npm run test:rust:sdk`, `npm run test:ui`, and Node compatibility checks passing.

Public docs content work should start in `apps/docs/`; production serving for
the docs route lives in `apps/web/app/docs/`. Run
`npm run docs:sync-openapi` after API codegen changes that should appear in
public docs, and run `npm run docs:validate` before finishing docs-site edits.
