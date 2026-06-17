# Store Module

The store module owns the Rust API's ClickHouse-backed operational index and the storage-facing service logic used by HTTP handlers. In hosted ClickHouse mode, the module splits persistence between the InstantML User Data control table and each org's tenant ClickHouse data plane. Multi-instance hosting is still gated by `docs/design/2026-05-16-multi-instance-control-data-plane.md`: this module now has deterministic full replay helpers, tenant-scoped replay validation, a full User Data refresh path used by `INSTANTML_SERVICE_PLANE=data` before auth, and a Postgres-backed data-cell writer lease used as a write-admission fence for hosted split data services. It does not provide shared-cell multi-writer freshness, atomic metric/log idempotency, or downstream ClickHouse fence-token validation yet.

## Module Map

- `mod.rs`: shared `Store`/`StoreData` types, deterministic control/tenant
  operational replay, data-plane control-record refresh, current-cell data-cell
  heartbeat, data-cell writer-lease acquisition/renewal state, tenant replay
  validation, local org bootstrap, durable append helper, readiness checks, and
  public re-exports. Route movement events stay in Postgres audit tables and
  are not loaded on every projection refresh.
- `admin.rs`: read-only operator overview projection for users, orgs, storage
  posture, billing state, public API-key metadata, data-cell registry summaries,
  and risk queues.
- `auth.rs`: users, organizations-as-workspaces, memberships, sessions, browser-session workspace creation/switching, service accounts, API keys, and admin checks.
- `billing.rs`: Stripe billing projections, Checkout intent fulfillment, Customer Portal responses, webhook event idempotency, and payment-state write gates.
- `console_logs.rs`: bounded stdout/stderr validation, idempotent log writes, cursor encoding, and log read response shaping.
- `runs.rs`: project/run creation, run filtering, the run-search query
  language, summaries, scalar metric writes, rank metric writes/summaries, and
  metric point/series reads.
- `objects.rs`: typed attributes, rich objects, table rows, raw artifact metadata, and raw upload metadata writes.
- `artifact_versions.rs`: versioned artifact collections, immutable manifests,
  upload sessions, aliases, retention/delete state, run input/output lineage,
  and manifest-entry downloads.
- `imports.rs`: Neptune, W&B, and MLflow import normalization plus import record creation/listing.
- `export.rs`: side-by-side comparison, selected-run export selection, bounded
  JSON export response assembly, and normalized CSV export serialization with
  formula-cell protection and public artifact rows.
- `usage.rs`: usage summaries, daily snapshots, versioned-artifact active,
  pending-delete, and reserved byte accounting, idempotency cleanup, and
  session cleanup.
- `demo.rs`: synthetic demo project reset data.
- `access.rs`: shared project/run/session access checks and auth-adjacent row helpers.
- `summaries.rs`: run summaries, artifact counts, metric-series conversion, and export metric reads.
- `tenants.rs`: hosted tenant route payloads, current-cell placement metadata,
  database/cloud-service provisioning, lazy tenant loading, and per-org
  MetricStore resolution.
- `device_code.rs`: RFC 8628 device-code grant state machine — pending/authorized/denied/expired lifecycle, rate-limit enforcement, user-code generation, and API key issuance on confirm.
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

Pure helper behavior should get unit tests close to the module that owns it. Behavior that depends on ClickHouse, HTTP auth, SDK compatibility, hosted tenant routing, Postgres writer leases, or the Next dashboard should be covered by the shared contract, SDK, hosted ClickHouse, and UI smokes. The hosted ClickHouse smoke starts separate `control` and `data` service-plane processes to verify control-record refresh, data-cell writer lease acquisition, route-cell write admission, and tenant replay across process boundaries.

Run-search parser/evaluator tests live beside the run store. Keep route-level
search behavior aligned across `/runs`, `/api/overview`, `/api/runs/summary`,
selection projection, and `/api/export`; regex matching must stay on the Rust
`regex` crate path and within the documented query limits.

Replay-specific tests should cover deterministic ordering, latest-record projection behavior, tenant org mismatch rejection, payload org mismatch rejection, and entity-id validation for tenant records that do not carry a top-level `org_id`.
