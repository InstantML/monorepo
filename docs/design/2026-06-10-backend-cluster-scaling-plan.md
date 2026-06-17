# Design: Backend Cluster Scaling Plan

Date: 2026-06-10

Status: Phase 0, Phase 1, and Phase 1A foundation slices accepted and
implemented; later public-routing, migration, and multi-writer phases remain
draft

Owner: Codex

Implementation note, 2026-06-10: Phase 0 added the operator runbook plus a
Rust `capacity-plan` preflight for Cloud SQL connection budgeting. Phase 1
added the Postgres data-cell registry, route placement metadata, route audit
events, current-cell heartbeats, and admin visibility. Phase 1A adds the
Postgres per-cell writer lease and route-aware hosted data write guard. These
foundation slices do not create a second public cell, move tenant traffic, or
change SDK/browser route discovery yet.

## Summary

InstantML can scale the hosted backend most safely by adding more cells before
adding more active writers inside one cell. The current production shape is one
control Cloud Run service, one data Cloud Run service/cell, one self-hosted GCP
ClickHouse VM for tenant data, Cloud SQL Postgres for hosted control-plane
state, and Cloudflare R2 for artifact bytes. That is a reasonable beta shape,
but it has several single points of operational pressure: one data cell, one
ClickHouse tenant host, one active control instance, one active data writer, and
no first-class registry for cell placement or migration.

The near-term scaling plan should not introduce a central hot-path proxy that
forwards every SDK metric write and artifact request forever. The existing
design docs already rejected that as a latency, cost, and failure
concentration. A load balancer remains useful for TLS, path/host routing,
Cloud Armor, and control/data separation, and a temporary thin router can help
legacy clients, but the durable shape should be:

```text
Browser / SDK
  -> public control endpoint for auth, org lookup, and route discovery
  -> routed data-plane cell endpoint for product reads/writes
  -> org-assigned ClickHouse cell/database plus R2 artifacts
```

The smallest useful implementation is narrower than public multi-cell routing:
first harden the current cell, add an operator-visible cell registry, add an
app-level writer fence for single-writer cells, and prove one internal second
cell can be deployed and observed without public SDK traffic. Public route
discovery, SDK direct-to-cell writes, and migration/rebalancing should follow
only after auth, route-version, and deployment-fencing gates are accepted.

## Slice Boundaries

Accepted and implemented foundation slices:

- Phase 0 hardening: ClickHouse backups/restore drill, Cloud SQL connection
  budget, cell-scoped dashboards, and current-cell capacity limits.
- Phase 1 ledger: Postgres `data_cells`, tenant-route placement fields,
  `tenant_route_events`, transactional initial placement, current-cell
  heartbeat, and bootstrap-protected admin visibility.
- Phase 1A writer lock: Postgres `data_cell_writer_leases`, status-gated
  acquire/renew/release, side-effect-free write readiness, route-aware mutation
  guard, authoritative route-cell verification for hosted writes, and
  backwards-compatible local/combined behavior.

Later implementation slices should be reviewed separately and may include:

- A manifest or repeatable deploy command that can create one internal second
  data cell, with no public placement until the writer lease and health checks
  pass.

Public route discovery, SDK cell caching, browser cell auth, org migration, and
multi-writer data cells are explicitly later slices.

## Current Architecture Findings

- Hosted control-plane truth is now Postgres/Cloud SQL, not the older
  ClickHouse event log. The Rust server still keeps a process-local projection
  for handler lookups, but Postgres owns uniqueness and atomicity for users,
  orgs, memberships, sessions, API keys, billing, invitations, and tenant
  routes.
- Tenant product data is still ClickHouse-first. Low-volume tenant records live
  in `operational_records`; metric rows live in `metric_points`,
  `rank_metric_points`, `console_log_lines`, and `metric_series`.
- The deploy helper can deploy split `control` and `data` Cloud Run services,
  but it currently targets one control service and one data service/cell per
  run.
- Both control and data deploys are deliberately bounded to one active instance
  unless unsafe test flags are set.
- Control-plane multi-instance risk is now mostly projection freshness,
  connection budgeting, and rate-limit semantics.
- Data-plane multi-writer risk remains larger: project uniqueness, run/attribute
  mutation freshness, import/demo multi-record writes, and metric/log
  idempotency still depend on process-local coordination plus ClickHouse
  operational records.
- Free/shared-cell routing exists, but there is no multi-cell placement
  registry, no route version, and no migration/rebalancing workflow for moving
  an org between cells.
- The current self-hosted GCP ClickHouse path has strong read-path benchmark
  evidence, but its next risks are operational: backups, monitoring, disk
  growth, HA, and cell-level capacity management.

## Goals

- Add a concrete path to scale from one data cell to many data cells without
  first solving every multi-writer problem.
- Make Free, Pro, Premium, and BYOC placement explicit and cost-aware.
- Keep public SDK and UI API shapes stable while adding route discovery and
  cell-aware deployments.
- Preserve one active data writer per cell until data-plane write gates are
  closed.
- Allow the control plane to scale horizontally after request-critical reads no
  longer depend on stale projections.
- Add the operational model needed to grow ClickHouse capacity, add backups,
  and move orgs between cells.
- Define the later gates for true multi-instance data cells and ClickHouse
  shard/replica clusters.

## Non-Goals

- Do not implement later multi-cell routing, placement, migration, or
  horizontal-writer phases in this Phase 0 slice.
- Do not raise `INSTANTML_CLOUD_RUN_DATA_INSTANCES` above one for production.
- Do not rely on Cloud Run `maxScale=1`, session affinity, or active revision
  count as a correctness boundary.
- Do not introduce Redis, Kafka, Spanner, or another coordinator in the first
  slice.
- Do not shard one org's metrics across ClickHouse clusters in the first
  scaling step.
- Do not move customers automatically between cells without a separately tested
  migration workflow.

## Users and Use Cases

Operators need to add capacity before the first data cell is full, isolate noisy
or high-value orgs, and understand which service/database owns an org.

Free users should be placed on inexpensive shared cells with strict quotas and
clear upgrade paths.

Pro users should receive a standard hosted data plane with better capacity and
more predictable latency than the Free shared cells.

Premium users should be eligible for dedicated cells, larger ClickHouse
profiles, replicas, or customer-owned ClickHouse without changing SDK calls.

SDK users should keep using a stable API key and should not need to understand
ClickHouse. The SDK may learn a data-cell API base internally after route
discovery.

Frontend users should keep using the same dashboard URL. Control-plane routing
and browser data-cell auth should be hidden behind the app.

## Proposed Design

### Phase 0: Capacity Baseline And Hardening

Before new cells carry production traffic, make the current cell observable and
recoverable:

- Add a cell-capacity runbook that records Cloud Run latency/concurrency,
  Cloud SQL connections, ClickHouse CPU/memory/disk, active orgs, retained
  metric points, monthly API requests, R2 bytes, and route failures.
- Schedule ClickHouse backups or disk snapshots to durable GCP storage, and run
  a restore drill before onboarding customers with durability expectations.
- Add alerts for ClickHouse disk usage, memory pressure, CPU saturation,
  failed backups, Cloud Run 5xxs, `/readyz` degraded state, and p95 dashboard
  query latency crossing the product budget.
- Choose and document the backup mechanism for each InstantML-owned ClickHouse
  cell. The beta default can be GCP persistent-disk snapshots or a
  ClickHouse-native backup job, but the runbook must name the mechanism,
  retention, encryption/IAM owner, backup destination, RPO, RTO, and restore
  target.
- Run a restore drill into an isolated VM/database and validate row counts,
  selected run summaries, chart queries, and artifact metadata references before
  onboarding durability-sensitive customers.
- Add backup-age and restore-drill age alerts. A cell with stale backups should
  be marked `draining` or `disabled` for new paid placements until fixed.
- Budget Cloud SQL connections before adding any data cell. The deploy helper
  gives every control and data service `DATABASE_URL`, and the Rust default is
  `CONTROL_DB_MAX_CONNECTIONS=10`, so use:

  ```text
  total_control_connections =
    active_revisions * active_instances_per_revision * per_instance_pool_size
    + deploy_overlap
    + operator_jobs
    + migration_jobs
  ```

  Set `CONTROL_DB_MAX_CONNECTIONS` per service, document the chosen Cloud SQL
  tier's connection ceiling, alert on connection utilization and pool waits, and
  ensure the runtime service account has `roles/cloudsql.client`.
- Add cell-scoped SLO dashboards and labels for Cloud Run latency/5xxs,
  concurrency, Cloud SQL pool waits/timeouts/connections, ClickHouse query
  latency by route family, insert failures, disk days-to-full, backup age,
  route-discovery failures, wrong-cell rejects, and stale-route rejects. Avoid
  high-cardinality run IDs, metric keys, artifact names, and user payload fields
  in metrics.
- Continue using `npm run benchmark:cloud-run` as the hosted read-path signal,
  but add a write-path benchmark for SDK metric batches and artifact metadata
  writes.
- Keep the current production data cell single-writer while these basics land.

### Phase 1: Cell Registry And Placement

Add a Postgres-backed registry for data cells. This is the first real scaling
primitive because it gives operators a durable inventory independent of Cloud
Run service names and ClickHouse connection strings.

Implementation status on June 10, 2026: the accepted Phase 1 slice is the
registry, tenant-route placement metadata, transactional route-version/audit
chokepoint, conservative current-cell assignment, Cloud Run env wiring, and
bootstrap-protected admin visibility. Public route discovery, SDK direct
cell routing, data-cell writer leases, and multi-writer cells remain later
phases.

New control-plane entities:

```text
data_cells
  cell_id text primary key
  environment text not null
  region text not null
  tier text not null                 -- free, standard, premium, byoc, internal
  status text not null               -- open, draining, full, disabled, failed
  service_name text not null
  public_api_base text
  internal_api_base text
  clickhouse_endpoint_secret_ref text
  clickhouse_username_secret_ref text
  clickhouse_password_secret_ref text
  clickhouse_database_mode text       -- shared-database, per-org-database, byoc
  max_orgs integer
  max_metric_points_monthly bigint
  max_api_requests_monthly bigint
  max_retained_bytes bigint
  max_disk_usage_pct integer
  reserved_headroom_pct integer
  last_health_at timestamptz
  last_backup_at timestamptz
  notes text
  created_at timestamptz not null
  updated_at timestamptz not null
```

Extend `tenant_routes` with:

```text
cell_id text null references data_cells(cell_id)
route_version bigint not null default 1
placement_reason text null
assigned_at timestamptz null
```

Constraints and state rules:

- `data_cells` is unique on `(environment, cell_id)`.
- `service_name`, `public_api_base`, and `internal_api_base` are unique within an
  environment when present.
- Valid `data_cells.status` transitions are `open -> draining -> disabled`,
  `open -> full -> open`, `open -> failed`, and `failed -> open` after an
  operator health check. `disabled` cells require an explicit operator action to
  reopen.
- `current_orgs` and similar counters should be derived from `tenant_routes` or
  periodically reconciled, not trusted as billing truth.
- Every placement writes a `tenant_route_events` audit row with old/new
  `cell_id`, old/new route status, route version, actor, and reason.

Placement rules:

- Free/personal orgs go to an `open` Free shared cell with enough remaining
  capacity.
- Pro orgs go to a standard cell, normally with a per-org database on an
  InstantML-owned ClickHouse host.
- Premium orgs default to dedicated database or dedicated data cell depending
  on expected volume, compliance needs, and paid plan settings.
- BYOC orgs keep the hosted control plane but route product data to the
  validated customer-owned ClickHouse route.
- Full or draining cells receive no new org assignments.

Placement must be transactional. The control plane should select an eligible
cell with `SELECT ... FOR UPDATE` or a conditional update, write the
`tenant_routes` row, increment `route_version`, and write the audit event in the
same Postgres transaction. Concurrent signups must not be able to overfill the
same cell through a stale capacity read.

Keep the first implementation operator-driven: seed `data_cells` from deploy
configuration or an admin-only script, then choose cells through simple
capacity checks. Avoid an autoscheduler until real placement pressure exists.

Initial admission-control defaults should be explicit and conservative:

| Tier | Cell style | Admission gate | Overbooking stance |
| --- | --- | --- | --- |
| Free | Shared database/cell | Admit only while disk is below 70%, p95 key dashboard reads stay below budget, backup age is healthy, and projected Free planning units leave configured headroom. | Allowed only against measured usage plus a documented Free planning unit; never against unbounded plan-max fantasy. |
| Pro | Standard cell, often per-org database | Admit while measured cell load plus one Pro planning unit leaves CPU, disk, request, and metric-point headroom. | Conservative until Pro overage behavior and migration are proven. |
| Premium | Dedicated database/cell or BYOC | Require operator approval, named capacity profile, backup posture, and customer expectations. | No overbooking unless the customer contract explicitly allows it. |

Free shared-cell byte usage remains an operational estimate because exact
per-org ClickHouse table bytes are not available in a shared database today.
Plan/billing usage remains org-scoped; cell admission uses cell-level capacity
and org-level estimates only.

### Phase 1A: Data-Cell Writer Lease

Single-writer cells need an application-level fence before carrying production
traffic. A Cloud Run max-instance setting, session affinity, or traffic split is
not enough because deploy overlap and accidental scaling can still create two
writers.

Add a Postgres-backed writer lease:

```text
data_cell_writer_leases
  cell_id text primary key references data_cells(cell_id)
  fence_token bigint not null
  holder_instance_id text not null
  service_name text not null
  revision text not null
  acquired_at timestamptz not null
  heartbeat_at timestamptz not null
  expires_at timestamptz not null
```

Rules:

- A hosted split data service must have `INSTANTML_CELL_ID` before it can write.
  Local, combined-plane, and no-Postgres development modes keep their current
  write behavior.
- A data service may acquire a lease only for an existing `data_cells` row whose
  status is `open`, `full`, or `draining`. `disabled` and `failed` cells reject
  writer acquisition. `full` and `draining` still allow writes for already routed
  orgs while preventing new placement through Phase 1 admission rules.
- Lease SQL must use Postgres `clock_timestamp()` and conditional
  `INSERT ... ON CONFLICT ... WHERE ... RETURNING` or `UPDATE ... WHERE ...
  RETURNING` statements. The holder identity is a process-start UUID;
  `service_name` and `revision` are diagnostics.
- First acquisition inserts `fence_token = 1`. Takeover can increment
  `fence_token` only after `expires_at <= clock_timestamp()`. Renewal must
  require the exact `(cell_id, holder_instance_id, fence_token)` tuple, an
  unexpired lease, and a still write-enabled cell status; it must not increment
  the token.
- `/readyz` continues to report whole-service read readiness. Data services add
  side-effect-free `write_ready` and `writer_lease` fields that do not acquire
  or renew a lease and do not expose holder, token, or expiry details. Deploy
  smokes can require write readiness with a dedicated post-handoff write check,
  but no-traffic revisions must not deadlock startup while the old revision
  still owns the writer lease.
- Route-classified mutating tenant-data requests must pass one centralized
  route/store guard before handler side effects. The guard verifies the process
  holds the current cell writer lease and rejects authenticated writes whose
  authoritative Postgres tenant route records a different `cell_id`; legacy
  routes without `cell_id` remain allowed for backwards compatibility. BYOC
  storage setup routes configure customer-owned storage and remain outside this
  current-cell writer lease. Guard failures, including Postgres outages, return
  retryable `503` with `code: "cell_writer_unavailable"`. Reads and read-style
  POST endpoints remain available if the operational store is otherwise
  healthy.
- Phase 1A is a write-admission fence, not full downstream multi-writer
  ClickHouse fencing. Long-running mutation paths must either keep the lease TTL
  comfortably above the first implementation's request timeout or re-check at
  durable side-effect boundaries before a later phase claims true downstream
  fence-token enforcement.
- A short positive lease cache is acceptable for hot paths only when bounded by
  the lease expiry with a safety margin and capped at no more than 1 second.
  Negative availability should not be cached beyond normal retry/backoff.
- Losing the lease immediately disables writes and returns a retryable `503`
  with `code: "cell_writer_unavailable"` until another writer is ready.
- Deploys should use no-traffic revision deploy, read-readiness verify,
  deliberate writer handoff or expiry window, traffic flip, old revision drain,
  conditional old lease release/expiry, then post-flip write smoke.
- Add tests for concurrent acquire, expired takeover increments, unexpired
  takeover fails, stale holder renew fails, disabled/missing cells reject
  acquisition, local/backwards-compatible bypasses, and a two-process guard path
  proving that only the lease holder can mutate a hosted split data cell.

### Phase 2: More Single-Writer Data Cells

Deploy more data cells as separate Cloud Run services and ClickHouse databases
or VMs:

```text
instantml-data-free-us-central1-a
instantml-data-free-us-central1-b
instantml-data-standard-us-central1-a
instantml-data-premium-acme-us-central1-a
```

Each data cell starts with one active data writer. This scales capacity by
adding independent cells, not by adding writers to one cell. It also keeps
failure blast radius understandable:

- Free cells can be cheap and quota-strict.
- Standard cells can hold multiple Pro orgs or per-org databases.
- Premium cells can be dedicated to one large customer or one noisy workload.
- BYOC cells can be routed through the same API/data-plane code while the
  customer's ClickHouse remains outside InstantML storage accounting.

The deploy helper should grow from one `INSTANTML_CLOUD_RUN_DATA_CELL` target to
either:

- a repeatable `--data-cell=<cell_id>` deploy command, or
- a small cells manifest consumed by the deploy helper.

Do not add a broad service mesh or orchestrator. A manifest with cell id,
service name, region, Cloud SQL secret, tenant ClickHouse URL secret, and
scaling mode is enough for the first multi-cell shape.

The manifest-driven deploy path must reconcile all public routing resources for
each cell, not just Cloud Run:

- Cloud Run service and revision settings.
- Serverless NEG for the cell.
- Backend service with timeout and Cloud Armor policy.
- Host rule/path matcher for the cell hostname.
- Managed certificate or wildcard certificate plan.
- DNS record or emitted DNS action.
- Static egress/VPC settings and Secret Manager access.
- `/health`, `/readyz`, `/api/auth/config`, `/openapi.json`, writer-lease, and
  route-discovery verification checks.

Adding Phase 2 cells helps new placements only. It does not relieve an
overloaded existing org or cell until Phase 5 migration/rebalancing exists.

### Phase 3: Public Routing And Client Discovery

Google's HTTPS load balancer can route by host/path, but it cannot inspect an
org id inside a bearer token before the application authenticates the request.
The scalable routing contract should make the cell visible to the routing layer
without exposing ClickHouse secrets.

Recommended first route shape:

```text
https://api.instantml.ai/api/auth/*        -> control
https://api.instantml.ai/api/orgs/*        -> control
https://cell-free-us-central1-a.api.instantml.ai/*     -> free cell A
https://cell-standard-us-central1-a.api.instantml.ai/* -> standard cell A
```

Control-plane route discovery returns:

```json
{
  "org_id": "uuid",
  "cell_id": "standard-us-central1-a",
  "route_version": 7,
  "data_api_base": "https://cell-standard-us-central1-a.api.instantml.ai",
  "expires_at": "2026-06-10T12:30:00Z"
}
```

SDK behavior:

- On first use of an API key, call a control-plane route discovery endpoint.
- Cache `data_api_base` and `route_version` for that key/org.
- Send SDK hot-path writes directly to the cell endpoint.
- Include `X-InstantML-Route-Version: <route_version>` on data-cell requests.
- Refresh discovery on `401`, `403`, `404`, `409 tenant_route_changed`, or
  route-discovery expiry.
- Preserve the existing `api_base` override for local, staging, and BYOC
  testing.

Data-cell behavior:

- Resolve the API key or session to an org through the accepted data-cell auth
  contract.
- Before loading tenant data for a mutating request, compare authoritative
  `tenant_routes.cell_id`, `tenant_routes.route_version`, and route status
  against the data service's `INSTANTML_CELL_ID` and the request's
  `X-InstantML-Route-Version`.
- Reject wrong-cell traffic with HTTP `409` and `code:
  "tenant_route_changed"` or `code: "wrong_cell"`; do not silently proxy to the
  new cell.
- Reject writes when the route is `draining`, `write_blocked`, `cutover`, or
  otherwise not write-ready.

Direct-to-cell SDK traffic is blocked on an explicit auth contract. The simple
first contract should use direct/read-through Postgres API-key validation from
the data cell, preserving revoked-key, expired-key, project-scoped key, demo
read-only, and route-change behavior without restart. If this becomes too
expensive for the SDK hot path, a later design can replace it with
short-lived control-plane-issued cell tokens that include org id, scopes,
project restriction, route version, expiry, and a bounded revocation-staleness
policy.

Browser behavior:

- Keep the dashboard's public app origin unchanged.
- First slice may keep browser product requests behind the existing public API
  compatibility path or Next server proxy because browser traffic is not the
  hottest SDK metric path.
- Before direct browser-to-cell requests, design short-lived cell session tokens
  or a cookie/CORS policy that preserves session revocation, org switching,
  CSRF protections, and same-origin expectations.

Compatibility:

- Keep the existing public API base working for legacy SDKs during an explicit
  deprecation window. The implementation design must name the minimum SDK
  version that supports route discovery before new orgs depend on direct cell
  routing.
- If a thin app router is needed for legacy product routes, keep it stateless
  and tenant-routing-only. It should not become the permanent bottleneck for
  SDK metric ingestion.
- The compatibility path must preserve `Authorization`, `Idempotency-Key`,
  request bodies, project-scoped API-key behavior, and error shapes.
- `tenant_route_changed` is an HTTP `409` response and is the SDK's refresh
  signal.

### Phase 4: Control Plane Horizontal Scale

Postgres makes control writes safe across multiple instances, but handler reads
still use process-local projection paths in several places. Close that gap
before raising the control service above one active instance:

- Move request-critical auth/session/API-key/org/tenant-route reads to direct
  Postgres queries or a very short TTL cache with read-through invalidation.
- Keep broad projection loads only for admin/operator views and low-risk
  summaries.
- Add tests that create, revoke, and switch API keys/sessions through one
  control instance and observe the result through another instance without a
  restart.
- Re-check the Phase 0 Cloud SQL connection budget with the proposed control
  instance count and any active data cells before raising max instances.
- Raise control to autoscaling min 1, max 2 or 3 only after the tests pass.

The control plane should usually scale horizontally before it is sharded.
Control data is low volume and globally authoritative; premature control-plane
sharding would complicate org switching, billing, invites, API-key lookup, and
tenant routing without solving the current data-plane bottleneck.

### Phase 5: Org Migration And Rebalancing

Multiple cells are only useful if operators can move orgs when cells fill or
when customers upgrade.

Add an operator-only migration workflow backed by `org_migrations`:

```text
org_migrations
  id uuid primary key
  org_id uuid not null
  source_cell_id text not null
  target_cell_id text not null
  source_route_version bigint not null
  target_route_version bigint
  state text not null
  requested_by text not null
  customer_notice text
  started_at timestamptz
  updated_at timestamptz not null
  completed_at timestamptz
  failed_at timestamptz
  error text
```

Migration states:

| State | Behavior |
| --- | --- |
| `planned` | Operator has selected source/target; no traffic change. |
| `write_blocked` | Source cell rejects new writes with `503` and `code: "org_migration_in_progress"` plus `Retry-After`; reads may continue. |
| `copying` | Tenant ClickHouse rows are copied to the target; source remains write-blocked. |
| `validating` | Row counts, min/max timestamps, selected checksums, summary parity, and artifact metadata/object checks run. |
| `cutover` | Control plane writes the target `tenant_route`, increments `route_version`, and makes source reject wrong-cell writes. |
| `rollback_window` | Target serves reads/writes; source data is retained read-only for rollback. |
| `complete` | Rollback window expired and cleanup/retention decisions are recorded. |
| `failed` | Operator-visible failure; route is either restored to source or left blocked with explicit recovery steps. |

Migration workflow:

1. Create `org_migrations` in `planned`.
2. Confirm customer impact policy for the tier.
3. Mark source route `write_blocked` and wait for SDK route-cache TTL drain.
4. Create and migrate the target cell/database schema.
5. Copy tenant `operational_records`, `metric_points`, `rank_metric_points`,
   and `console_log_lines` for that `org_id`.
6. Copy or intentionally quiesce idempotency records so retries cannot land on
   both cells with different outcomes.
7. Let `metric_series` rebuild from the materialized view on the target instead
   of copying aggregate state blindly.
8. Validate row counts, min/max timestamps, selected run checksums, summary
   query parity, and R2 artifact metadata-to-object presence for active
   artifacts. Artifact bytes stay in R2; route migration only changes metadata
   placement unless a separate artifact-storage migration is designed.
9. Write the target `tenant_route` with incremented `route_version` in the same
   transaction that records `cutover`.
10. Keep the old route read-only for a rollback window.
11. Delete old data only after retention, backup, and customer-support checks
   pass.

This workflow also handles Free shared cell to Pro/Premium dedicated placement.
Do not promise automatic upgrades to dedicated storage until this exists.

Customer impact:

- Free migrations can be best-effort and may use short read-only/write-blocked
  windows, but the UI and SDK must return clear retryable errors.
- Pro migrations should be scheduled, with dashboard messaging and bounded SDK
  retry guidance.
- Premium migrations require explicit operator/customer approval, a rollback
  plan, and a completed backup on both source and target cells.
- Reads should remain available whenever the source cell is healthy and the
  migration state is before `cutover`; writes are blocked once
  `write_blocked` begins.

### Phase 6: Data-Plane Multi-Writer Gates

Only after cells and migration are working should a single data cell run more
than one active writer. Required gates:

- Durable idempotency for metric, rank metric, console log, artifact, and fork
  writes. The current process-local `inflight_idempotency` and
  `operational_records` replay are not enough.
- A mutation uniqueness strategy for project names, imports, demo reset, run
  updates, artifact collections, and any per-org counters.
- Request-time refresh or direct tenant operational queries for stale-sensitive
  reads.
- A route-version check so a stale data instance rejects or refreshes when an
  org moves to another cell.
- A shared limiter or deliberately conservative per-instance limits for
  short-window API throttling.
- Load tests with two data instances receiving duplicate SDK retries and mixed
  dashboard reads.

Durable idempotency must specify:

- Reserve before side effects with a unique `(org_id, idempotency_key)` record.
- Store request hash and reject conflicting reuse.
- Store completed response shape for replay.
- Store pending/failed/completed states and clear retry semantics.
- Expire records after a documented TTL.
- Decide whether metric/log rows carry an ingest/dedupe id, and prove aggregate
  summaries do not double-count duplicate retries.
- Copy idempotency records during org migration or keep writes blocked until
  retries cannot hit both source and target cells.

Preferred first data multi-writer step:

- Keep low-volume tenant mutations single-writer with an org-scoped lease or
  route them to one writer.
- Allow read-only dashboard routes on multiple data instances after direct
  tenant reads or bounded refresh land.
- Only then allow metric ingestion on multiple data instances after idempotency
  is durable.

### Phase 7: ClickHouse Scaling Strategy

Use cell-level sharding before table-level sharding:

- Add more ClickHouse cells/VMs and route whole orgs to one cell.
- Keep queries local to one org's assigned cell.
- Avoid ClickHouse `Distributed` tables across cells for normal dashboard
  routes; cross-cell dashboards are not a v1 user workflow.

For each InstantML-owned ClickHouse cell:

- Start with a right-sized single host plus backups and disk alerts.
- Grow disk and CPU/memory based on measured pressure, not benchmark pride.
- Add replicas for Premium or production durability once restore and failover
  runbooks exist.
- Move from plain `MergeTree` to `ReplicatedMergeTree` only through a dedicated
  schema/operations design, because materialized views and duplicate ingestion
  behavior need careful testing.

Table-level sharding inside one large org is a later Enterprise problem. It
requires a separate design for distributed query fan-out, metric-series
aggregation correctness, deduplication, and failure behavior when one shard is
unavailable.

## Component Impact

Backend:

- Added Postgres `data_cells` and tenant route placement fields in Phase 1.
- Add route discovery and route-version checks in a later public-routing slice.
- Added cell-aware tenant route selection in `apps/rust-server/src/store/tenants.rs`.
- Added admin/operator reads for cell health and route placement.
- Added `data_cell_writer_leases` and write-fence checks in Phase 1A.
- Later: move request-critical control reads to direct Postgres helpers.

Frontend:

- No immediate dashboard route changes for Phase 1.
- Later: fetch route discovery for active orgs or rely on a server-side proxy
  until short-lived cell browser auth exists.
- Admin app can show cells, assigned orgs, capacity status, and route-version
  mismatches.

Python SDK:

- Later: add internal route discovery and data-cell API-base caching.
- Later: refresh cached routing on route-version errors or auth failures.
- Keep public SDK methods unchanged.

Storage:

- Added `data_cells`.
- Extended `tenant_routes`.
- Added `tenant_route_events`.
- Added `data_cell_writer_leases` in Phase 1A.
- Add backups/restore runbooks for ClickHouse cells.
- Add `org_migrations` when Phase 5 starts.

Docs:

- Update `docs/architecture/multi-instance-cloud-run.md`,
  `docs/architecture/current-system.md`, `apps/rust-server/README.md`,
  `apps/rust-server/src/store/README.md`, `tools/README.md`, and public docs
  only when implementation starts.

## Data Model

Initial schema changes:

- `data_cells` table in the control-plane Postgres schema.
- `tenant_routes.cell_id`.
- `tenant_routes.route_version`.
- `tenant_routes.placement_reason`.
- `tenant_routes.assigned_at`.
- `tenant_route_events` for route movement audit history.
- `data_cell_writer_leases` for Phase 1A per-cell write admission.

Possible follow-up schema:

- `org_migrations` for resumable cell moves. This is required before Phase 5,
  not optional for any production migration.
- `cell_capacity_snapshots` if operator UI needs historical placement trends.
- `tenant_idempotency_keys` only if the accepted multi-writer design chooses
  Postgres-backed idempotency for hot-path writes.

## API Contracts

Implemented Phase 1 operator/control endpoint:

```text
GET /api/admin/data-cells
```

Authenticated by bootstrap token. Returns safe data-cell metadata, admission
status, and route counts. It omits internal API bases, Secret Manager
references, operator notes, and tenant credentials. Data services with
`INSTANTML_CELL_ID` also heartbeat an auto-registered `data_cells` row so
configured placement has fresh liveness evidence. Backup freshness stays
operator-owned, must not be refreshed by service heartbeats, and is invalid
when it is more than five minutes in the future.

First future route-discovery endpoint:

```text
GET /api/routing/current
```

Authenticated by browser session or API key. Returns the active org's
`cell_id`, `route_version`, and safe `data_api_base`. It never returns
ClickHouse endpoints, usernames, password references, or storage keys.

Data-cell requests include:

```text
X-InstantML-Route-Version: <route_version>
```

Data cells should reject stale clients with:

```json
{
  "error": "tenant route changed",
  "code": "tenant_route_changed",
  "route_version": 8
}
```

This is an HTTP `409`. The SDK treats it as a discovery refresh signal.
Wrong-cell traffic should also return HTTP `409` with `code: "wrong_cell"` or
`code: "tenant_route_changed"` and must not silently proxy.

Admin/operator endpoints should be scoped to the hidden admin app and bootstrap
token path, not public user APIs.

## Performance Considerations

- Route discovery is one control-plane read per SDK startup/key/org and should
  be cached with a bounded TTL.
- Direct-to-cell SDK requests either perform direct/read-through Postgres API-key
  validation or use a future short-lived cell token. The implementation must
  measure Cloud SQL load before broad rollout.
- SDK metric writes should go directly to the assigned data cell after
  discovery; they should not pay a permanent central proxy hop.
- Free shared cells must keep every read/write org-filtered and bounded.
- Cell placement decisions are low QPS and can use simple Postgres queries.
- Control-plane direct reads should use existing indexes on token hashes,
  memberships, org ids, and tenant routes. Add indexes only after query plans
  show they are needed.
- Data-cell migration is bulk work and should run out of band with explicit
  limits, progress records, and operator approval.
- ClickHouse cell capacity should be measured by sustained p95 latency, CPU,
  memory, disk, active org count, retained metric points, and bytes, not by
  signup count alone.

## Simplicity Review

This plan scales by replication of simple cells and explicit routing records,
not by introducing distributed transactions or table-level sharding first. It
keeps the current Rust/ClickHouse architecture, uses Postgres where the control
plane already moved, and preserves SDK/UI public workflows.

Deferred complexity:

- Automatic cell autoscheduling.
- Direct browser-to-cell cookies or cell session tokens.
- Multi-writer data cells.
- ClickHouse `ReplicatedMergeTree`/`Distributed` table migration.
- Global distributed short-window rate limiting.
- Cross-region active-active control plane.

## Failure Modes

- Cell unavailable: route discovery can still succeed, but data requests return
  `503 warehouse_unavailable` or a cell-unhealthy error. Operators can drain the
  cell and migrate affected orgs.
- Writer lease unavailable or lost: mutating data routes return `503` with
  `code: "cell_writer_unavailable"` and fail closed.
- Route version stale: data cell returns HTTP `409` with `code:
  "tenant_route_changed"`; SDK refreshes route discovery.
- Wrong cell: data cell returns HTTP `409` with `code: "wrong_cell"` or
  `tenant_route_changed`; it does not proxy.
- Control Postgres unavailable: control routes fail and data-plane auth refresh
  degrades to last-known-good only for a bounded period. New route discovery and
  org switching fail closed.
- ClickHouse migration copy fails: keep source route active/read-write unless
  the migration already acquired a write lease; if so, release the lease and
  restore normal writes after validation.
- Free shared-cell org leak: any missing `org_id` predicate can leak data.
  Keep cross-org tests and consider ClickHouse row policies before increasing
  shared-cell density.
- Thin router overload: SDK route discovery should bypass it for hot-path
  writes; legacy routing should have Cloud Run limits and clear deprecation.

## Testing Plan

- Unit tests for cell placement and route-version comparison.
- Postgres migration tests for `data_cells` and extended `tenant_routes`.
- Two-process writer-lease test proving only one data writer can mutate a cell.
- API tests for `GET /api/routing/current` through browser session and API key.
- Multi-process smoke with one control service and two data services, verifying
  org A writes to cell A and org B writes to cell B.
- Wrong-cell and stale-route tests for direct data-cell requests.
- SDK smoke proving route discovery, cached data-cell writes, and refresh after
  `tenant_route_changed`.
- Cross-org shared-cell isolation regression for every metric/read path used by
  Free cells.
- Migration dry-run test copying a small org between cells and validating row
  counts, summary parity, route-version cutover, and R2 artifact metadata/object
  presence.
- Hosted benchmark updates covering route discovery, default data-cell writes,
  and dashboard read p95s.

The Phase 0 preflight adds first-party Rust unit coverage for connection-budget
math and environment parsing. Later implementation slices must preserve
meaningful first-party coverage or document a temporary exception in the
touched component README.

## Documentation Plan

Later implementation slices should update:

- `docs/architecture/current-system.md`
- `docs/architecture/multi-instance-cloud-run.md`
- `docs/architecture/current-schemas.md`
- `apps/rust-server/README.md`
- `apps/rust-server/src/store/README.md`
- `tools/README.md`
- `docs/design/README.md`
- Public docs under `apps/docs/` only after user-visible routing behavior
  changes.

This Phase 0 slice updates `docs/design/README.md`,
`docs/ops/backend-phase-0-capacity.md`, the Rust server README, and related
operator documentation so future agents find the accepted preflight.

Docs drift to resolve before implementation:

- `docs/architecture/current-system.md` and some older diagrams still describe
  hosted control-plane User Data as ClickHouse-backed. The current
  implementation uses Postgres/Cloud SQL for hosted control truth. Update those
  architecture references before accepting implementation work from this plan.

## Alternatives Considered

Central hot-path proxy:

- Rejected as the permanent architecture because it concentrates SDK metric
  latency, artifact bandwidth, cost, and failure in one service. Acceptable only
  as a thin compatibility/router layer while SDKs learn cell discovery.

Raise Cloud Run instances on the current data service:

- Rejected for production until durable idempotency and tenant mutation
  uniqueness land. The existing code and docs explicitly mark this unsafe.

Shard one ClickHouse database by table first:

- Rejected for the first scaling step because whole-org cell placement is
  simpler, easier to migrate, and matches v1 query shapes.

Separate Free control plane:

- Deferred. Free orgs need cheaper data cells first; control-plane load is not
  the current bottleneck and splitting control would complicate org switching,
  billing, and API-key lookup.

Add a distributed coordinator now:

- Deferred. Postgres already handles control-plane correctness. Data-plane
  single-writer cells plus migration buy time without adding a new system.

Scale up current ClickHouse plus dedicated Premium cells only:

- This is the smallest paid-beta path if current traffic remains light. It
  should be the fallback until a second shared cell is actually needed. It stops
  being enough when Free/Pro signups approach disk or p95 budgets, when one
  noisy org needs isolation without BYOC, or when operators need a rehearsed
  migration path before selling Premium isolation.

## Review Notes

Fresh reviewer 1: distributed correctness

- Finding: Single-writer cells were asserted but not fenced; route versions were
  cached by the SDK but not sent or checked; direct-to-cell auth and durable
  idempotency were underspecified; first slice mixed registry work with public
  routing.
- Risk: Accidental deploy overlap or stale clients could create split-brain
  writes across data cells, duplicate metric/log inserts, or accepted revoked
  API keys.
- Recommended edit: Add a Postgres-backed writer lease/fencing token, require
  `X-InstantML-Route-Version`, make data cells compare `(org_id, cell_id,
  route_version, route_status)` before mutations, block direct SDK cells on an
  explicit auth contract, narrow the first slice, and define durable
  idempotency semantics.
- Decision: Accepted. The plan now includes a candidate first slice,
  `data_cell_writer_leases`, route-version headers, wrong-cell/stale-route
  rejection, direct-to-cell auth gating, and explicit durable-idempotency gates.

Fresh reviewer 2: infrastructure and operations

- Finding: Backup/restore, Cloud SQL connection limits, load-balancer
  reconciliation, deployment-time write exclusion, cell registry constraints,
  cell-scoped observability, and architecture-doc drift were too vague.
- Risk: More cells could exhaust Cloud SQL, deploy two active writers, route
  traffic to unverified services, or carry paid customers without a tested
  restore path.
- Recommended edit: Move Cloud SQL budgeting and backup/restore into Phase 0,
  require manifest-driven reconciliation for Cloud Run/LB/DNS/certs/Cloud
  Armor, add writer-lease deploy flow, add health/secret/audit fields to the
  registry, and call out Postgres/ClickHouse docs drift.
- Decision: Accepted. The plan now includes Phase 0 backup RPO/RTO/restore
  gates, Cloud SQL connection math, cell-scoped SLOs, manifest deploy
  mechanics, writer-lease deployment flow, and a docs-drift note.

Fresh reviewer 3: product/platform and economics

- Finding: Placement economics were too vague, migration lacked a resumable
  state machine, customer impact was unclear, API compatibility needed a sharper
  legacy-client contract, and the alternatives missed the simplest
  scale-up-current-cell path.
- Risk: Free shared cells could silently destroy margins, migrations could leave
  customers in ambiguous write-blocked states, and existing overloaded tenants
  would not be helped by new-cell placement alone.
- Recommended edit: Add admission-control rules by tier, transactional
  placement, `org_migrations` states, tier-specific customer impact, exact
  stale-route response behavior, legacy SDK compatibility/deprecation notes, and
  the scale-up-current-ClickHouse alternative.
- Decision: Accepted. The plan now includes tiered admission gates,
  transactional placement, migration states, customer impact policy,
  compatibility details, and the near-term scale-up alternative.

Fresh reviewer 4: Phase 1A distributed correctness

- Finding: Writer lease acquisition, renewal, and takeover needed exact atomic
  SQL semantics; `/readyz` could deadlock deploys if write ownership was coupled
  to startup readiness; long-running mutations needed a bounded claim; and a
  scattered guard would be easy to bypass.
- Risk: Deploy overlap could still produce two accepted writers, a no-traffic
  revision could never become startup-ready while the old revision held the
  lease, or one unguarded endpoint could bypass the single-writer invariant.
- Recommended edit: Use Postgres time and conditional lease transitions, expose
  read readiness separately from write readiness, centralize the data-plane
  mutation guard, fail closed on Postgres guard outages, and document the first
  slice as write admission rather than full downstream fence-token enforcement.
- Decision: Accepted. Phase 1A now requires conditional Postgres-time SQL,
  explicit write-readiness fields, a single guard boundary for mutating
  data-plane routes, hosted fail-closed behavior when `INSTANTML_CELL_ID` is
  missing, and a bounded long-running request claim.

Fresh reviewer 5: Phase 1A Rust/Postgres implementation

- Finding: Renewal must match the holder and fence token, acquisition must not
  approve typo or disabled cells, token reset must be impossible, and hot-path
  Postgres checks need either a tested small cache or an explicit cost decision.
- Risk: Renewing by holder alone or deleting lease rows could let stale writers
  regain authority; silently accepting unknown cells could route writes to the
  wrong service; and unbounded per-mutation checks could harm ingest latency.
- Recommended edit: Keep the row forever, condition release/renew on
  `(cell_id, holder_instance_id, fence_token)`, permit writer leases only for
  `open`, `full`, or `draining` cells, add focused sqlx and two-process tests,
  and document cache/TTL/readiness/deploy handoff semantics.
- Decision: Accepted. The implementation slice will use a process-start UUID,
  diagnostics-only service/revision labels, conditional release without row
  deletion, status-gated acquisition, and focused tests for SQL races, stale
  renewal, status semantics, and backwards-compatible local behavior.

## Coverage Exceptions

None for the implemented Phase 0, Phase 1, or Phase 1A foundation slices.

## Decision

Phase 0 Cloud SQL capacity preflight and operator runbook are accepted and
implemented. Later phases remain draft until their review notes are resolved
and a narrow implementation slice is accepted.
