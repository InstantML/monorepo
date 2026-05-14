# Apps

This directory contains runnable applications.

Use the root `../SETUP.md` before running app commands from a fresh clone.

Expected apps:

- `api/`: Python bootstrap/reference API service.
- `rust-server/`: Primary Rust API and worker service home. It contains the accepted Postgres schema migration, runnable service commands, and Postgres-backed product API.
- `server/`: Deprecated Node.js compatibility server for route-shape regression tests, JSON migration fixtures, and legacy local fallback.
- `web/`: Next/React frontend web application.

Future agents must update this README when apps are added, renamed, removed, or when shared app-level commands change.

Current backend/product API work should start in `rust-server/`. Preserve `server/` compatibility where practical so Node can keep serving as a legacy behavior oracle and migration source. Keep `api/` small and compatible for SDK reference tests.

Primary local/hosted target:

```text
apps/web -> apps/rust-server -> managed Postgres -> artifact storage
packages/python-sdk/uploader -> apps/rust-server -> managed Postgres -> artifact storage
```

Deprecated local compatibility target:

```text
apps/web -> apps/server -> .rlobs/rlobs.json + local artifact files
packages/python-sdk/uploader -> apps/server -> .rlobs/rlobs.json + local artifact files
```

Rust work should preserve documented route shapes, use the migration in `rust-server/migrations/`, and keep `npm run test:contract`, `npm run test:rust:sdk`, `npm run test:ui`, and Node compatibility checks passing.
