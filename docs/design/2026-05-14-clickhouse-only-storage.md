# Design: ClickHouse-Only Storage

Date: 2026-05-14

Status: Accepted for local/test first slice

Owner: Codex

## Summary

Training Observability should collapse the Rust backend storage stack from a split metadata database plus metric database into ClickHouse-backed control and data planes:

- A global control plane for low-volume account state such as users, identities, organizations, memberships, service routing, seats, plan state, and org bootstrap metadata.
- An org/cell data-plane service for tenant-owned training state such as API keys, sessions, projects, runs, attributes, artifacts, imports, idempotency records, audit events, usage snapshots, scalar metric points, and metric-series aggregates.

The smallest useful version removes the Rust server's relational database dependency, makes `CLICKHOUSE_URL` the only server database URL, and preserves the existing REST route shapes used by the SDK, UI, contract smoke, and deprecated Node compatibility oracle. Local development, smokes, and benchmarks start only ClickHouse plus the Rust API. The deprecated Node server remains JSON-backed compatibility infrastructure.

Hard scope gate: this first slice is accepted for local development, tests, and single Rust API process usage only. It must not be promoted to hosted multi-process production until a later coordination/reconciliation design is accepted.

This change intentionally favors a simple operational document/event layer over trying to recreate relational behavior in ClickHouse. The Rust API owns validation, tenant checks, uniqueness checks, and small transactional sequences in service code. ClickHouse owns durable append/replace storage, bounded analytical reads, and metric aggregation.

Hosted direction: a new organization should be assigned to a data-plane cell, and higher-value or higher-volume customers can receive a dedicated Rust service plus dedicated ClickHouse database/namespace. Tiny/free orgs may initially share a cell to keep cost and operations reasonable.

## Goals

- Remove the Rust server's relational database dependency from code, build configuration, local orchestration, CI setup, and documentation.
- Use ClickHouse for both operational state and analytical metrics while keeping the two layers explicit in schema and code.
- Model hosted storage as a global control plane plus org/cell data-plane services.
- Preserve current REST contracts for the Python SDK, frontend, and shared smokes.
- Keep scalar metric ingestion on the existing ClickHouse analytical path with bounded reads and maintained summaries.
- Keep local development simple: `npm run dev:api` starts or reuses ClickHouse and then starts the Rust API.
- Scrub product and architecture docs so they describe ClickHouse-only Rust storage.
- Keep this implementation explicitly local/single-process until a follow-up hosted coordination design exists.

## Non-Goals

- Do not remove the deprecated Node compatibility server in this change.
- Do not build a full distributed transaction system on top of ClickHouse.
- Do not add Kafka, Redis, or another coordination service.
- Do not change SDK public APIs or frontend route shapes.
- Do not migrate old local generated relational state; the generated local state is disposable.
- Do not implement hosted billing truth or object-store reconciliation.
- Do not claim hosted multi-writer correctness in this slice.

## Users and Use Cases

Daily users should see no route or UI behavior change:

1. A user signs in through the local Google-style development flow.
2. The API creates the user, organization, membership, service routing record, session, and optional API key in the ClickHouse-backed control/data planes.
3. The SDK creates projects and runs, logs scalar metrics, and uploads artifacts through the organization data-plane service.
4. The UI reads run summaries, bounded metric series, artifacts, rich objects, imports, and usage summaries through the same endpoints.

Operators and future agents should have fewer moving pieces:

- One local database service to start.
- One database URL to configure.
- One schema directory for Rust server storage.
- No relational migration checksum or local generated cluster state failures.

## Proposed Design

### Service Stack

Keep the Rust API stack:

- `axum`, `tokio`, `tower-http`, `serde`, `uuid`, `chrono`, `sha2`, `base64`, `tracing`, and the existing local artifact store.
- `clickhouse` crate as the only database client in the Rust server.

Remove the relational database client and migration runtime from the Rust server. The binary still exposes `serve`, `worker`, `migrate`, and `all`, but `migrate` applies ClickHouse schema only.

### Control Plane And Data Plane

The hosted model has two logical services:

- Control plane: owns human identity, organizations, memberships, plan/account fields, and the mapping from `org_id` to a data-plane endpoint or cell.
- Data plane: owns org-scoped API keys, browser sessions, service accounts, projects, runs, attributes, artifacts, imports, idempotency records, audit events, usage snapshots, and metrics.

The local/test first slice runs both logical planes inside one Rust process and one ClickHouse database. The code and docs should keep the boundary clear so a later hosted implementation can route an org to its own service without changing SDK/frontend route shapes.

Per-organization dedicated services make sense for isolation and single-writer correctness, but not every small org needs a separate process on day one. The practical hosted rollout is:

1. Shared local/test cell in this PR.
2. Shared hosted cell for free/small orgs after coordination/reconciliation is designed.
3. Dedicated cell or service per serious customer where isolation, noisy-neighbor control, retention, or compliance justifies it.

### Storage Layers

Use one ClickHouse database with two table families:

- Operational table: `operational_records`, an append-only `MergeTree` log of complete JSON payloads keyed by record kind, org, entity id, and created time. The Rust process rebuilds users, organizations, memberships, sessions, service accounts, API keys, projects, runs, attributes, artifacts, table rows, imports, idempotency records, audit, and usage snapshots into an in-process index from this log.
- Analytical tables: `metric_points`, `metric_series`, and `metric_series_mv`.

The Rust process performs small-record uniqueness checks before writes. The first implementation avoids `FINAL` on hot paths by keeping operational writes append-only and by reading from the in-process index rebuilt from ClickHouse on startup. ClickHouse remains the durable backing store.

Analytical tables keep the existing `metric_points` and `metric_series` shape. Metric writes still insert points and let the materialized view maintain aggregate states.

### Operational Table Shape

| Table family | Engine | Ordering key | Replacement/version | Expected first-slice volume | `FINAL` use |
| --- | --- | --- | --- | ---: | --- |
| Operational records | MergeTree append log plus in-process latest index | `(kind, org_id, entity_id, created_at)` | entity updates append full current payload rows; delete-like operations append tombstone/replacement records | thousands to tens of thousands local/test | Avoid entirely |
| Metric points/series | MergeTree and AggregatingMergeTree | `(org_id, run_id, key, step)` and `(org_id, run_id, key)` | materialized aggregate states | millions | Not applicable |

The implementation may choose direct ClickHouse reads for cold diagnostics, but public route read-after-write semantics come from the in-process index. Startup rebuild must load operational rows from ClickHouse in deterministic created/version order, then reconstruct latest entities and append-only collections. Every mutating route must update the cache and then write the matching durable row.

### Transactions And Consistency

ClickHouse is not a row-transactional OLTP database. The accepted first slice handles this with explicit service-level sequencing:

- Validate all request inputs before the first write.
- Create dependent low-volume records under one process mutex in the Rust service.
- Write operational rows with complete payloads that can be read independently.
- Use deterministic idempotency records for SDK metric replay.
- Keep artifact byte writes staged before metadata write and clean up staged/finalized bytes on API errors where practical.
- For demo reset, use scoped replacement semantics in the cache and write the replacement rows afterward; if a crash occurs mid-write, the next local reset is the documented recovery path.
- For imports, validate the normalized payload before writing and document that a crash can leave a partial imported project in the local/test first slice; re-running the import into a new project or deleting local ClickHouse state is the recovery path until import staging is designed.
- Document that crash-only partial operational writes remain possible until a later compensation/reconciliation design.

This is intentionally smaller than introducing another coordination system and is not a hosted multi-process correctness story.

### Local And Test Orchestration

`npm run dev:api`, `npm run test:rust:contract`, `npm run test:rust:sdk`, `npm run test:rust:ui`, and benchmarks start only disposable ClickHouse and the Rust API. Helper environment variables are reduced to ClickHouse ports/data/log settings plus API port and artifact root.

### Documentation Scrub

Docs should describe the Rust backend as:

```text
Next/React frontend -> Rust API -> ClickHouse operational layer + ClickHouse analytical layer + artifact storage
Python SDK/uploader -> Rust API -> ClickHouse operational layer + ClickHouse analytical layer + artifact storage
```

Historical design docs that conflict with the new default should either be superseded, renamed, or removed from indexes so the repo no longer points agents toward a relational backend.

## Component Impact

Backend:

- Rust storage functions move from relational queries to ClickHouse-backed operational and analytical helpers.
- Startup connects to ClickHouse, applies schema, and ensures the local development organization.
- Readiness checks ClickHouse only.
- Worker cleanup and usage snapshots use operational ClickHouse tables.

Frontend:

- No API route or data shape change.
- Landing copy that mentions the old split changes to ClickHouse-only wording.
- UI smoke continues to use the Rust API by default.

Python SDK:

- No public API change.
- SDK smokes continue to use the existing REST contract.

Storage:

- `CLICKHOUSE_URL` is the only Rust database URL.
- Local state lives under `.rlobs/clickhouse` and artifact bytes under `.rlobs/rust-artifacts`.
- Deprecated Node JSON storage remains only for compatibility.

Docs:

- Update root, component, architecture, setup, user, product, and design docs.
- Remove or rewrite references to the removed relational backend.

## Data Model

Operational layer:

- Low-volume tables store one row per product entity or append-only event.
- Tenant-owned rows keep `org_id`.
- `org_routes` maps each organization to a data-plane cell/service endpoint in hosted mode; local/test mode maps every org to the in-process local cell.
- API keys store `key_prefix`, hashed key bytes, scopes, optional project restriction, and revocation/expiry timestamps.
- Runs store project identity, status, config JSON, tags, metadata JSON, timestamps, and derived searchable text.
- Attributes and rich objects store path/kind/step/value/summary/artifact links.
- Table object rows store bounded JSON row previews.
- Usage snapshots store immutable daily JSON snapshots.

Analytical layer:

- `metric_points`: raw scalar metric points ordered by `(org_id, run_id, key, step)`.
- `metric_series`: aggregate states ordered by `(org_id, run_id, key)`.
- `metric_series_mv`: materialized view from points to series.

## API Contracts

No route shape changes.

Important preserved behavior:

- API-key mode still requires bearer tokens for tenant routes.
- Local mode still creates/uses a fixed local organization unless a browser session is present.
- SDK metric writes still support `Idempotency-Key` replay and conflict detection.
- Project-scoped API keys still deny cross-project access.
- Run summary, metric, object, artifact, import, export, demo reset, and usage endpoints keep existing JSON shapes.
- Errors keep the current `{"error": "message"}` shape.

## Performance Considerations

- Expected operational volume per local project is small compared with metric volume: thousands of runs, attributes, artifacts, and sessions versus millions of metric points.
- Run list endpoints remain bounded by `limit`, `offset`, or cursor and return summaries only.
- Metric chart endpoints keep explicit run/key/step/limit filters.
- The operational layer should avoid loading raw metric history for tables.
- The first slice may use in-process indexes refreshed from ClickHouse on startup for operational reads; a later hosted slice can replace that with direct ClickHouse operational queries where scale demands it.
- Benchmarks should still measure run summaries, search, metric-sort paths, chart series, and production-web first useful render.

## Simplicity Review

This is the smallest useful ClickHouse-only version because it removes an entire database class without adding a new coordinator. The tradeoff is that service code owns more correctness checks than a relational database previously enforced.

Deferred:

- Hosted multi-writer coordination.
- Background reconciliation for crash-only partial writes.
- Full migration from old generated local relational state.
- Materialized operational projections beyond the routes needed today.

## Cache Semantics

The local/test first slice may cache these entities:

- Users, organizations, memberships, sessions, service accounts, and API keys for auth checks.
- Projects and runs for route summaries and access checks.
- Attributes, artifacts, table rows, imports, idempotency records, audit events, and usage snapshots for existing endpoints.

Rules:

- Rebuild once on startup after ClickHouse schema migration.
- Guard all mutations with one async mutex.
- Mutations must update the in-process index before returning success.
- Mutations must write durable ClickHouse rows before releasing the mutex unless the route is explicitly documented as best-effort cleanup.
- Public reads use the cache for operational entities and ClickHouse analytical queries for metrics.
- Tests must verify write/read behavior through public APIs, not by peeking into cache internals.

## Failure Modes

- ClickHouse unavailable: readiness fails and mutating routes return server errors.
- Duplicate operational creates: service-level uniqueness checks return validation/conflict-style errors.
- Crash between artifact byte finalization and metadata write: cleanup is best-effort; orphan cleanup remains a later hardening task.
- Crash during demo reset: the UI can show partial demo data until the user runs demo reset again or clears local ClickHouse state.
- Crash during import: the UI can show a partial imported project; recovery is re-run import into a new project or clear local ClickHouse state.
- Hosted multi-process writes: first slice assumes local/single-process semantics for operational uniqueness and idempotency; hosted deployment needs a later coordination design before scale-out.

## Testing Plan

- `npm ci`
- `npm audit --audit-level=high`
- `cargo fmt --manifest-path apps/rust-server/Cargo.toml --all -- --check`
- `npm run rust:lint`
- `npm run rust:test`
- `npm run test:node`
- `npm run test:python`
- `npm run test:contract`
- `npm run test:rust:sdk`
- `npm run test:ui`
- `npm run web:build`
- Browser pass against the restarted local stack.

Add or preserve storage behavior coverage for:

- Duplicate project/user/org creation behavior.
- API-key scope and project restriction checks.
- Idempotency replay and conflict.
- Public read-after-write after each mutation class.
- Artifact byte and metadata linkage.
- Restart-from-ClickHouse recovery for at least users/orgs/projects/runs/basic artifacts/idempotency.
- Demo reset recovery by re-running reset after existing demo data.

Meaningful coverage is preserved by keeping Rust unit tests for schema splitting and adding storage behavior coverage where the old relational tests are removed or replaced.

## Documentation Plan

Update:

- `AGENTS.md`
- `PRODUCT_STRATEGY.md`
- `README.md`
- `SETUP.md`
- `USER_DOCS.md`
- `TODO.md`
- `apps/README.md`
- `apps/rust-server/README.md`
- `apps/rust-server/SETUP.md`
- `apps/server/README.md`
- `apps/web/README.md`
- `docs/README.md`
- `docs/architecture/README.md`
- `docs/architecture/current-system.md`
- relevant design docs and design index
- package/example README files that mention the removed storage stack
- tool README and local orchestration docs

## Alternatives Considered

Keep the split database stack:

- Rejected because the requested direction is to remove the relational database and simplify operations.

Use ClickHouse for metrics only and JSON for operational state:

- Rejected because the Rust backend should have one durable database layer, and JSON remains only deprecated Node compatibility storage.

Add a separate coordination store:

- Rejected for this first slice because it would replace one removed database with another.

Rewrite the API around append-only events only:

- Rejected because it would risk breaking route shapes and frontend workflows in one step.

## Review Notes

Fresh reviewer 1:

- Finding: Service-level uniqueness, tenant checks, idempotency, and multi-record sequencing are only safe for local/single-process usage.
- Risk: Hosted or multi-process use could accept duplicate users/projects/runs/API keys or conflicting idempotency records.
- Recommended edit: Make the first slice explicitly local/single-process only and add a hard implementation gate before hosted deployment.
- Decision: Accepted; the scope gate is now explicit.

- Finding: Import/demo reset/artifact workflows can leave partial writes after crashes.
- Risk: Route behavior may be confusing if old and new state mix.
- Recommended edit: Either shrink the slice or document exact staging/recovery semantics per workflow.
- Decision: Accepted; demo reset and imports now have documented first-slice recovery behavior.

- Finding: Optional in-process cache was underspecified.
- Risk: Cache freshness could diverge between tests and local use.
- Recommended edit: Define cache scope, rebuild timing, and mutation update rules.
- Decision: Accepted; cache semantics are now explicit.

- Finding: Testing plan was broad but not tied to storage semantics.
- Risk: Contract tests could pass while storage correctness bugs survive.
- Recommended edit: Add duplicate, project-scope, idempotency, read-after-write, artifact linkage, and restart-recovery tests.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: The first slice is acceptable only for local/single-process Rust API usage.
- Risk: Future hosted deployment could silently violate uniqueness/idempotency assumptions.
- Recommended edit: Add a hard launch gate.
- Decision: Accepted.

- Finding: `FINAL`/`ReplacingMergeTree` expectations were not mapped to operational tables.
- Risk: `FINAL` could become an invisible performance tax.
- Recommended edit: Add an operational table shape table with engine, ordering, volume, and `FINAL` expectations.
- Decision: Accepted.

- Finding: Import/demo reset partial-write behavior was not concrete enough.
- Risk: User-visible partial states could violate product expectations.
- Recommended edit: Stage/swap or document recovery and tests.
- Decision: Accepted for local/test first slice with documented recovery behavior.

- Finding: Cache invalidation boundaries were not specified.
- Risk: Maintainers could add stale read paths.
- Recommended edit: Define cache scope and mutation/update rules.
- Decision: Accepted.

## Coverage Exceptions

Coverage exception:
- Uncovered area: hosted multi-process reconciliation, service routing, and cross-process uniqueness/idempotency enforcement.
- Reason: this accepted slice is local/test single-process only.
- Risk: a hosted deployment pointed at the same operational table from multiple Rust processes could serve stale state or accept conflicting writes.
- Follow-up: design and implement the coordination/reconciliation layer before hosted promotion.
- Owner/date: future storage owner, 2026-05-14.

## Decision

Accepted for a local/test, single-process ClickHouse-only first slice after reviewer-requested guardrails. Hosted multi-process deployment requires a follow-up coordination/reconciliation design.
