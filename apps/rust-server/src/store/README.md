# Store Module

The store module owns the Rust API's ClickHouse-backed operational index and the storage-facing service logic used by HTTP handlers. In hosted ClickHouse mode, the module splits persistence between the InstantML User Data control table and each org's tenant ClickHouse data plane. Multi-instance hosting is still gated by `docs/design/2026-05-16-multi-instance-control-data-plane.md`: this module now has deterministic full replay helpers and tenant-scoped replay validation, but it does not provide live multi-instance freshness, atomic metric/log idempotency, or distributed write uniqueness yet.

## Module Map

- `mod.rs`: shared `Store`/`StoreData` types, deterministic control/tenant operational replay, tenant replay validation, local org bootstrap, durable append helper, and public re-exports.
- `auth.rs`: users, organizations, memberships, sessions, service accounts, API keys, and admin checks.
- `console_logs.rs`: bounded stdout/stderr validation, idempotent log writes, cursor encoding, and log read response shaping.
- `runs.rs`: project/run creation, run filtering, summaries, scalar metric writes, and metric point/series reads.
- `objects.rs`: typed attributes, rich objects, table rows, artifact metadata, and local upload metadata writes.
- `imports.rs`: Neptune, W&B, and MLflow import normalization plus import record creation/listing.
- `export.rs`: side-by-side comparison and bounded export response assembly.
- `usage.rs`: usage summaries, daily snapshots, idempotency cleanup, and session cleanup.
- `demo.rs`: synthetic demo project reset data.
- `access.rs`: shared project/run/session access checks and auth-adjacent row helpers.
- `summaries.rs`: run summaries, artifact counts, metric-series conversion, and export metric reads.
- `tenants.rs`: hosted tenant route payloads, database/cloud-service provisioning, lazy tenant loading, and per-org MetricStore resolution.
- `validation.rs`: shared validation, JSON value shaping, slugging, and focused unit tests.

## Testing

Run from the repo root:

```bash
npm run rust:test
npm run rust:lint
npm run test:contract
npm run test:rust:ui
npm run test:hosted-clickhouse
```

Pure helper behavior should get unit tests close to the module that owns it. Behavior that depends on ClickHouse, HTTP auth, SDK compatibility, hosted tenant routing, or the Next dashboard should be covered by the shared contract, SDK, hosted ClickHouse, and UI smokes.

Replay-specific tests should cover deterministic ordering, latest-record projection behavior, tenant org mismatch rejection, payload org mismatch rejection, and entity-id validation for tenant records that do not carry a top-level `org_id`.
