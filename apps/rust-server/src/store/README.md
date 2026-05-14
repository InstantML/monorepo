# Store Module

The store module owns the Rust API's ClickHouse-backed operational index and the storage-facing service logic used by HTTP handlers.

## Module Map

- `mod.rs`: shared `Store`/`StoreData` types, operational record replay, local org bootstrap, durable append helper, and public re-exports.
- `auth.rs`: users, organizations, memberships, sessions, service accounts, API keys, and admin checks.
- `runs.rs`: project/run creation, run filtering, summaries, scalar metric writes, and metric point/series reads.
- `objects.rs`: typed attributes, rich objects, table rows, artifact metadata, and local upload metadata writes.
- `imports.rs`: Neptune, W&B, and MLflow import normalization plus import record creation/listing.
- `export.rs`: side-by-side comparison and bounded export response assembly.
- `usage.rs`: usage summaries, daily snapshots, idempotency cleanup, and session cleanup.
- `demo.rs`: synthetic demo project reset data.
- `access.rs`: shared project/run/session access checks and auth-adjacent row helpers.
- `summaries.rs`: run summaries, artifact counts, metric-series conversion, and export metric reads.
- `validation.rs`: shared validation, JSON value shaping, slugging, and focused unit tests.

## Testing

Run from the repo root:

```bash
npm run rust:test
npm run rust:lint
npm run test:contract
npm run test:rust:ui
```

Pure helper behavior should get unit tests close to the module that owns it. Behavior that depends on ClickHouse, HTTP auth, SDK compatibility, or the Next dashboard should be covered by the shared contract, SDK, and UI smokes.
