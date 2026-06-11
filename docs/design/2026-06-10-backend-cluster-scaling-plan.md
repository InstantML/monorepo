# Design: Backend Cluster Scaling Plan

Date: 2026-06-10

Status: Phase 0 preflight/runbook, Phase 1 cell registry, and Phase 2/3
route-discovery slices accepted and implemented

Owner: Codex

Implementation note, 2026-06-10: the first Phase 0 slice is implemented as an
operator runbook plus a Rust `capacity-plan` preflight for Cloud SQL connection
budgeting. It does not change public APIs, schemas, service scaling, routing,
or cell placement.

Implementation note, 2026-06-10: the Phase 2/3 slice is implemented with a
Postgres-backed data-cell writer lease, API-key-only `GET /api/routing/current`,
data-cell route/version enforcement, Python SDK and async-uploader route
discovery with stale-route refresh, and Cloud Run deploy-helper support for
multiple single-writer data cells plus `cell-<cell>.<domain>` public hostnames.
Browser/session direct-to-cell routing and shared-cell multi-writer admission
remain deferred.

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

The accepted Phase 0 implementation in this change is limited to:

- Phase 0 hardening: ClickHouse backups/restore drill, Cloud SQL connection
  budget, cell-scoped dashboards, and current-cell capacity limits.

Phase 1 is now implemented as:

- Postgres `data_cells`, route placement fields, and route audit events.
- Bootstrap-protected admin/operator visibility for cell inventory, health,
  assigned orgs, and route status.
- Conservative current-cell assignment with transactional route-version
  updates.
- Cloud Run env wiring for `INSTANTML_DEPLOY_ENV`,
  `INSTANTML_DEFAULT_DATA_CELL_ID`, and per-data-service `INSTANTML_CELL_ID`.

The proposed Phase 2/3 implementation slice for this change is:

- The Phase 1A writer-lease prerequisite, limited to single-writer data-cell
  readiness and write fencing.
- A manifest or repeatable deploy command that can create one internal second
  data cell and reconcile its HTTPS router host/backend.
- Public control-plane route discovery for API-key callers:
  `GET /api/routing/current`.
- Data-cell public API base registration through
  `INSTANTML_DATA_CELL_PUBLIC_API_BASE`, surfaced only when a cell has a safe
  HTTPS public base.
- SDK route discovery and cache for authenticated training writes, including
  run/project creation, run updates/finish, scalar/rank metric batches, console
  logs, typed attributes, rich objects, artifact metadata, and versioned
  artifact upload-session mutations. Direct requests include
  `X-InstantML-Route-Version`.
- Async uploader route discovery so default async metric/log traffic follows
  the same route-version and idempotency behavior as sync logging.
- Data-cell wrong-cell and stale-route rejection for tenant-route requests that
  hit a service with `INSTANTML_CELL_ID`.

This slice intentionally does not implement browser direct-to-cell routing,
org migration/rebalancing, multi-writer data cells, or a route-aware apex
compatibility proxy. Browser sessions stay on the existing app/API origin.
Legacy SDKs stay compatible for orgs assigned to the default compatibility data
cell; operators must not place legacy-dependent orgs on non-default cells until
the route-aware proxy or a required SDK version gate exists.

The proposed Phase 4/5 implementation slice for the next change, revised after
fresh review, is intentionally narrower:

- Phase 4A: move request-critical API-key, browser-session, organization,
  membership, service-account, billing-account, tenant-route, and initial
  tenant-load reads on the hosted control path to narrow Postgres point
  queries. The in-memory projection remains for local mode, operator
  summaries, broad listings, and compatibility while mutations stay
  write-through through the existing `persist_locked` chokepoint.
- Phase 4A adds tests with two `Store` instances backed by the same control Postgres
  database. One instance creates/revokes/switches API keys or sessions; the
  other instance must observe the result without a rebuild or background
  projection refresh.
- Phase 5A: add `org_migrations` as a Postgres-backed operator state machine and
  expose bootstrap-token-only control endpoints under `/api/admin/org-migrations`.
  This first migration slice supports `planned`, `write_blocked`, and
  `failed/restored` transitions so operators can rehearse and safely unwind
  migration write blocking before any production cutover.
- Phase 5B remains deferred: operator-attested copy/validation progress, route
  cutover, rollback-window entry, completion, cleanup, and automated ClickHouse
  bulk copy. The code in this branch must not mutate `tenant_routes` to the
  target cell or claim a migration is complete.
- Extend data-cell route validation so `write_blocked` routes keep source-cell
  reads available but reject writes with HTTP `503`, code
  `org_migration_in_progress`, and `Retry-After`.
- Keep public SDK/UI APIs compatible. Migration endpoints are operator-only,
  and route discovery continues to return only ready target routes.

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

- A data service must acquire or renew the lease for its `INSTANTML_CELL_ID`
  before `/readyz` reports write-ready.
- Lease acquisition increments `fence_token` in a Postgres transaction.
- Mutating data-plane handlers must prove the local holder still owns the
  unexpired lease before performing side effects. A short heartbeat cache is
  acceptable only if the staleness bound is documented and tested; the safest
  first implementation checks before each mutation.
- Losing the lease immediately disables writes and returns a retryable `503`
  with `code: "cell_writer_unavailable"` until another writer is ready.
- Deploys should use no-traffic revision deploy, readiness verify, lease
  acquire, traffic flip, old revision drain, old lease release/expiry, then
  post-flip smoke.
- Add a two-process test proving that only one writer can mutate a cell and
  that the loser fails closed.

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

Accepted first implementation details:

- `--data-cell=<cell_id>` is repeatable. `INSTANTML_CLOUD_RUN_DATA_CELLS` may
  also contain a comma-separated cell list. The existing
  `INSTANTML_CLOUD_RUN_DATA_CELL` and `INSTANTML_CLOUD_RUN_DATA_SERVICE`
  variables remain the single-cell compatibility path.
- Per-cell service names default to
  `<service-prefix>-data-<slug(cell_id)>`. Operators may later grow this into a
  richer JSON manifest, but the repeatable flag keeps the first slice small.
- The public router keeps the apex API host as the compatibility route and adds
  host rules for `cell-<slug(cell_id)>.<router-domain>` to each data backend.
  Control paths remain routed to the control backend from both the apex host
  and wildcard host rule.
- The deploy helper writes each data service's
  `INSTANTML_DATA_CELL_PUBLIC_API_BASE` to the cell host only after the public
  router is active. Without the public router, operators may set
  `INSTANTML_DATA_CELL_PUBLIC_API_BASE` explicitly for a single cell; otherwise
  route discovery omits direct routing and clients stay on the configured base.
- The existing single-writer scaling guard remains in place for every data-cell
  target. This is not the final writer fence; it keeps Phase 2 deploys from
  accidentally increasing writers while Phase 1A remains outstanding.

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

Route discovery response rules:

- The endpoint is control-plane only and requires API-key authentication. Browser
  sessions do not receive a direct cell route in this slice.
- API keys must have at least one data-plane scope that can use the route
  (`sdk:ingest`, `artifacts:write`, `imports:write`, or `export:read`).
- It returns `409` with `code: "route_discovery_unavailable"` when the caller's
  org has no ready tenant route, no assigned managed cell, or the assigned cell
  has no safe `public_api_base`.
- It returns `503` with `code: "cell_writer_unavailable"` when the assigned
  cell has no unexpired writer lease. Discovery should not hand out a public
  mutation route that cannot currently fence writes.
- It never returns ClickHouse endpoints, usernames, password references, or
  internal service URLs.
- Cache TTL starts at five minutes. The response includes the authoritative
  `route_version`; clients must treat it as an opaque freshness token.
- `public_api_base` safety means: HTTPS only for non-loopback hosts, no userinfo,
  query, fragment, or non-root path, no private/internal hostnames, host under
  the configured owned router domain suffix, and a registered data-cell row in
  the same deploy environment. Local loopback bases may be used only in local
  development tests.
- Public cell hostnames and cell IDs must be opaque deployment labels. Do not
  encode customer names or sensitive tier/compliance details in externally
  visible hostnames.

SDK behavior:

- On first use of an API key, call a control-plane route discovery endpoint.
- Cache `data_api_base` and `route_version` for that key/org.
- Send SDK hot-path writes directly to the cell endpoint.
- Include `X-InstantML-Route-Version: <route_version>` on data-cell requests.
- Refresh discovery on `401`, `403`, `404`, `409 tenant_route_changed`, or
  route-discovery expiry.
- Preserve the existing `api_base` override for local, staging, and BYOC
  testing.
- First SDK implementation routes the full authenticated write dependency chain
  once discovery succeeds: project/run creation, run updates/finish, scalar
  metric batches, rank metric batches, console logs, typed attributes, rich
  objects, raw artifact metadata/upload writes, and versioned artifact
  upload-session mutations. Reads keep using the configured base until browser
  and query traffic are explicitly moved.
- If route discovery is unavailable or a direct cell request returns
  `wrong_cell`/`tenant_route_changed`, the SDK clears the cached route.
  Discovery-unavailable before any direct attempt falls back to the configured
  base for compatibility. After a `wrong_cell` or `tenant_route_changed`
  response, the SDK may retry only after successful rediscovery and only against
  the newly discovered authoritative cell. It must not retry the stale mutation
  through the apex compatibility base.
- The async uploader resolves and caches routes in the uploader process, sends
  the same route-version header, and retries a `wrong_cell` or
  `tenant_route_changed` result once after rediscovery with the original
  idempotency key. It must treat repeated stale-route results as retryable but
  bounded by the existing queue backoff.

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
- The first implementation enforces cell ownership and ready status for every
  authenticated tenant-route request that reaches a process with
  `INSTANTML_CELL_ID`, regardless of whether the route-version header is
  present. The header adds stale-version detection. Missing route-version
  headers are allowed only for the apex compatibility host and only when the org
  is assigned to that same cell; missing headers on a configured cell public
  host fail closed.
- Public cell hosts require API-key auth in this slice. Cookie/session auth on
  cell public hosts returns `401` until the browser token/CORS/CSRF design is
  accepted.

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
  Postgres queries. Do not add TTL caching in the first slice; revocation and
  membership changes should have database read-after-write semantics.
- Keep broad projection loads only for admin/operator views and low-risk
  summaries.
- Add tests that create, revoke, and switch API keys/sessions through one
  control instance and observe the result through another instance without a
  restart.
- Re-check the Phase 0 Cloud SQL connection budget with the proposed control
  instance count, all active data cells, deploy overlap, operator jobs,
  migration jobs, background refreshers, and per-plane pool sizes before
  raising max instances. `capacity-plan` must pass with the exact proposed
  hosted values; lowering per-instance `CONTROL_DB_MAX_CONNECTIONS` is preferred
  over silently exceeding the Cloud SQL budget.
- Raise control to autoscaling min 1, max 2 or 3 only after the tests and
  capacity preflight pass. This implementation slice should not change
  production scaling defaults by itself.

Phase 4A direct read contract:

| Request path | Postgres read contract |
| --- | --- |
| API-key auth | One hash lookup joined to service account and org, preserving revoked/expired key rejection, disabled service-account rejection, exact stored scopes, project restriction, and demo scope clamping. |
| Browser session auth | One token-hash lookup joined to user, org, and the active membership for that session's org, preserving revoked/expired session rejection, role changes, membership removal, and demo read-only derivation. |
| Org admin gates | Point reads for org and membership when a live session or API key needs an admin decision; broad list endpoints may still use the projection. |
| Org switch | Reads the live source session, target org, and target active membership from Postgres before minting a new target session and revoking the source session. |
| Route discovery and data write admission | Keep the existing `get_tenant_route`, `get_data_cell`, and writer-lease point reads; route discovery remains API-key-only. |

Hot-path bounds and rollout gates:

- API-key data-plane writes should perform at most one control-plane API-key
  auth read and, for direct public cell writes, the existing route/cell point
  reads. If this becomes too expensive, the next design is short-lived
  cell-scoped tokens, not unbounded projection refreshes.
- Browser dashboard reads should perform at most one session auth read per
  request on hosted control paths. Browser direct-to-cell routing remains out
  of scope.
- Before production control scale increases, run a staging load test covering
  route discovery, API-key SDK writes, browser sessions, org switching,
  API-key revoke/use, and session revoke/use while watching Cloud SQL active
  connections, pool waits, query latency, and errors.

The control plane should usually scale horizontally before it is sharded.
Control data is low volume and globally authoritative; premature control-plane
sharding would complicate org switching, billing, invites, API-key lookup, and
tenant routing without solving the current data-plane bottleneck.

### Phase 5: Org Migration And Rebalancing

Multiple cells are only useful if operators can move orgs when cells fill or
when customers upgrade.

Phase 5A adds an operator-only migration-control workflow backed by
`org_migrations`. It is deliberately a control-plane safety slice: it lets
operators plan a move, block source writes, observe the blocked state from data
cells, and restore writes or mark the attempt failed. It does not cut traffic to
the target cell. Real cutover belongs to Phase 5B after structured copy and
validation evidence exists.

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
  transition_actor text not null
  customer_notice text
  copy_evidence jsonb not null default '{}'
  validation_evidence jsonb not null default '{}'
  restored_route_version bigint
  started_at timestamptz
  updated_at timestamptz not null
  completed_at timestamptz
  failed_at timestamptz
  error text
```

Database invariants:

- `source_cell_id` and `target_cell_id` reference `data_cells`.
- `source_cell_id <> target_cell_id`.
- `state` is constrained to known values.
- A partial unique index allows at most one active migration per org while
  `state` is not terminal.
- `source_route_version` is compared against the live route during write-block
  and restore transitions. If the route changed, the operator must re-plan.
- Every transition inserts a `tenant_route_events` row when it mutates the route
  and must run in one Postgres transaction with the `org_migrations` update.

Migration states:

| State | Behavior |
| --- | --- |
| `planned` | Operator has selected source/target; no traffic change. |
| `write_blocked` | Source route status is `write_blocked`; source cell rejects new writes with `503`, `code: "org_migration_in_progress"`, and bounded `Retry-After`; source reads may continue. |
| `failed` | Terminal failure record. If writes had been blocked, the fail transition restores the source route to `ready` in the same transaction. If the source route drifted and cannot be restored safely, the transition returns `tenant_route_changed` and leaves the migration `write_blocked` for operator recovery. |
| `restored` | Terminal state for a blocked migration that restored the source route to `ready` with a route-version bump. |
| `copying` | Deferred to Phase 5B: tenant ClickHouse rows are copied to the target; source remains write-blocked. |
| `validating` | Deferred to Phase 5B: row counts, min/max timestamps, selected checksums, summary parity, and artifact metadata/object checks run. |
| `cutover` | Deferred to Phase 5B: control plane writes the target `tenant_route`, increments `route_version`, and makes source reject wrong-cell traffic. |
| `rollback_window` | Deferred to Phase 5B. The rollback semantics must either keep the target read-only or define reverse-delta copy/idempotency reconciliation before target writes are accepted. |
| `complete` | Deferred to Phase 5B: rollback window expired and cleanup/retention decisions are recorded. |

Phase 5A workflow:

1. Create `org_migrations` in `planned`.
2. Confirm customer impact policy for the tier and provide a named
   `requested_by` actor. In hosted production, this should be called only by the
   hidden admin app or an internal operator surface protected by the bootstrap
   token plus infrastructure controls such as IAP/Cloud Armor/internal origin.
3. Mark the source route `write_blocked` in the same transaction that advances
   the migration. The transaction must lock the route, confirm
   `source_route_version`, increment `route_version`, and write an audit event.
4. Data cells allow source reads while the route is `write_blocked`; all writes
   fail with the migration error. Route discovery must not return a target route
   while the source route is write-blocked.
5. Restore source writes by advancing the migration to `restored` and setting
   the source route back to `ready` with another route-version bump. A fail
   transition from `write_blocked` restores the source route in the same
   transaction before marking the migration `failed`; route drift returns
   `tenant_route_changed` and leaves the migration blocked for operator
   recovery.

Deferred Phase 5B workflow:

1. Create and migrate the target cell/database schema.
2. Copy tenant `operational_records`, `metric_points`, `rank_metric_points`,
   and `console_log_lines` for that `org_id`.
3. Copy or intentionally quiesce idempotency records so retries cannot land on
   both cells with different outcomes.
4. Let `metric_series` rebuild from the materialized view on the target instead
   of copying aggregate state blindly.
5. Validate row counts, min/max timestamps, selected run checksums, summary
   query parity, R2 artifact metadata-to-object presence for active artifacts,
   target schema version, and idempotency posture. Evidence must be structured
   on the migration record using snapshots/query ids, row counts, checksums, and
   validation failure summaries; raw ClickHouse credentials, secret refs, object
   keys, and customer payload text must not be returned by public APIs.
6. Write the target `tenant_route` with incremented `route_version` in the same
   transaction that records `cutover`, guarded by the expected source route
   version.
7. Keep old data only according to retention, backup, and customer-support
   checks. If rollback after target writes is required, design reverse-delta
   copy and durable idempotency reconciliation first.

This workflow also handles Free shared cell to Pro/Premium dedicated placement.
Do not promise automatic upgrades to dedicated storage until this exists.

Route-status behavior:

| Route status | Route discovery | Source-cell reads | Source-cell writes |
| --- | --- | --- | --- |
| `ready` | Returns the current ready cell for API-key callers. | Allowed on the assigned cell. | Allowed on the assigned cell if the writer lease is valid. |
| `write_blocked` | Unavailable; SDKs should keep/backoff existing route state instead of treating it as stale-route cutover. | Allowed on the source cell. | Rejected with `503`, `code: "org_migration_in_progress"`, and a bounded `Retry-After`. |
| `provisioning` / `failed` / other | Unavailable. | Rejected unless a later design names a read-only recovery state. | Rejected. |

Legacy-client guard:

- Migration creation must reject moving orgs to a non-default data cell unless a
  route-aware compatibility proxy exists, a minimum SDK version gate exists, or
  the operator records explicit customer approval in the migration record.

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

- Add Postgres `data_cells` and tenant route placement fields.
- Add route discovery and route-version checks in a later public-routing slice.
- Add cell-aware tenant route selection in `apps/rust-server/src/store/tenants.rs`.
- Add admin/operator reads for cell health and route placement.
- Add `data_cell_writer_leases` and write-fence checks in Phase 1A.
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

- Add `data_cells`.
- Extend `tenant_routes`.
- Add `tenant_route_events`.
- Add `data_cell_writer_leases` in Phase 1A.
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

Possible follow-up schema:

- `data_cell_writer_leases` before any shared cell can run multiple active
  writers.
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
references, operator notes, and tenant credentials. Current-cell services also
heartbeat an auto-registered `data_cells` row so configured placement has a
fresh liveness/backup attestation even before a richer operator write API
exists.

First future route-discovery endpoint:

```text
GET /api/routing/current
```

Authenticated by API key only in the accepted Phase 2/3 and Phase 4/5A slices.
Browser sessions must receive `401` until a separate CSRF/CORS/cell-session
token design exists. The endpoint returns the API key's active org `cell_id`,
`route_version`, and safe `data_api_base`. It never returns ClickHouse
endpoints, usernames, password references, or storage keys.

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
- Migration write-block restore fails because the source route drifted: leave
  the migration `write_blocked`, return `tenant_route_changed`, alert on
  write-block duration, and avoid pretending the route is healthy until an
  operator performs a guarded recovery.
- ClickHouse migration copy or validation fails in deferred Phase 5B: restore
  the source route to `ready` with a route-version bump if writes had been
  blocked, or keep it `write_blocked` with customer-visible recovery guidance.
  Do not cut over to a target route without structured copy/validation evidence.
- Free shared-cell org leak: any missing `org_id` predicate can leak data.
  Keep cross-org tests and consider ClickHouse row policies before increasing
  shared-cell density.
- Thin router overload: SDK route discovery should bypass it for hot-path
  writes; legacy routing should have Cloud Run limits and clear deprecation.

## Testing Plan

- Unit tests for cell placement and route-version comparison.
- Postgres migration tests for `data_cells` and extended `tenant_routes`.
- Two-process writer-lease test proving only one data writer can mutate a cell.
- API tests for `GET /api/routing/current` through API key plus an explicit
  browser-session `401` regression.
- Two-Store hosted control tests for API-key creation/revocation, service
  account disablement, scope/project restrictions, session creation/revocation,
  org switching, membership removal, role changes, expired sessions, and demo
  read-only behavior without projection rebuild.
- Multi-process smoke with one control service and two data services, verifying
  org A writes to cell A and org B writes to cell B.
- Wrong-cell and stale-route tests for direct data-cell requests.
- Write-blocked route tests proving source-cell reads continue, representative
  writes return `503 org_migration_in_progress` with bounded `Retry-After`, and
  restored routes bump the route version.
- SDK smoke proving route discovery, cached data-cell writes, and refresh after
  `tenant_route_changed`.
- Cross-org shared-cell isolation regression for every metric/read path used by
  Free cells.
- Phase 5A migration tests for schema constraints, one active migration per org,
  guarded `planned -> write_blocked -> restored`, failed restore recovery text,
  and operator endpoint idempotency. Phase 5B later adds copy/cutover tests for
  row counts, summary parity, route-version cutover, and R2 artifact
  metadata/object presence.
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

Fresh reviewer 4: Phase 2/3 correctness and failure modes

- Finding: Public SDK direct writes were proposed before the writer fence
  existed; run creation stayed on the configured base while later writes moved
  to a cell; stale-route enforcement was header-gated; async uploader routing
  was underspecified; direct-to-cell auth needed a fail-closed contract; and the
  first slice was too broad.
- Risk: A deploy overlap could accept writes from two revisions, the SDK could
  split run creation and metrics across cells, legacy/no-header traffic could
  bypass cell ownership, async queues could loop against stale routes, and data
  cells could rely on stale auth projections without a documented boundary.
- Recommended edit: Make the writer lease a prerequisite, route the full SDK
  write dependency chain together, verify cell ownership for all hosted
  data-cell tenant requests, specify async rediscovery/idempotency behavior,
  define API-key-only discovery, and split artifact/session/browser follow-ups
  if they cannot meet the same guarantees.
- Decision: Accepted. This Phase 2/3 slice now includes the writer lease,
  full SDK write-chain direct routing, server-side route ownership checks,
  async uploader route discovery, and API-key-only discovery. Browser direct
  routing and route-aware apex proxying remain separate follow-ups.

Fresh reviewer 5: Phase 2/3 security and auth boundaries

- Finding: Missing route-version headers could bypass wrong-cell checks; SDK
  fallback to the apex base could undo stale-route protection; browser/session
  callers were mixed into a direct-cell slice; `public_api_base` safety was not
  defined; and externally visible cell IDs could leak placement details.
- Risk: Valid API keys could write to the wrong cell, route-refresh protection
  could be bypassed through fallback, bearer tokens could be sent to a bad
  public base, and cell hostnames could expose customer/tier information.
- Recommended edit: Enforce `(org_id, cell_id, status)` on every public data
  cell request, retry stale-route failures only after rediscovery, make
  discovery API-key-only, reject session auth on cell hosts, strictly validate
  public bases, and keep public cell labels opaque.
- Decision: Accepted. The implementation now treats the route-version header as
  a freshness token rather than the ownership gate, makes discovery API-key
  scoped, forbids apex fallback after stale-route responses, validates public
  bases before discovery returns them, and documents opaque public labels.

Fresh reviewer 6: Phase 2/3 implementation correctness, performance, security,
and cleanliness

- Finding: Direct cell requests could bypass stale-route checks by arriving on
  an alternate data-cell host without `X-InstantML-Route-Version`; health
  heartbeats could accidentally fabricate fresh backup attestations; and read
  handlers were coupled to the writer lease even though they do not perform
  side effects.
- Risk: Stale API-key traffic could continue writing through a non-authoritative
  host, cells without fresh backups could look placement-ready, and a healthy
  read-only cell could return unnecessary write-fence failures for dashboards or
  exports.
- Recommended edit: Require route-version headers for API-key traffic on any
  configured public data-cell host, keep backup freshness owned by the
  backup/operator path, and split read route validation from mutating writer
  admission.
- Decision: Accepted. The implementation now validates route ownership for read
  and write requests, requires the writer lease only for mutating handlers, and
  leaves `last_backup_at` untouched by process heartbeats.

Fresh reviewer 7: Phase 2/3 implementation data freshness and deploy hygiene

- Finding: Write admission relied on process-local route projection after
  discovery had been made public; route discovery could return cells that were
  not open or recently healthy; stale-route refresh was too narrow in the SDK;
  and deploy-helper cell ids were not constrained for public hostnames.
- Risk: A recently migrated org could still write through a stale data process,
  discovery could advertise an unhealthy cell, SDK retries could get stuck on
  auth or not-found route drift, and unsafe cell labels could produce bad or
  confusing host rules.
- Recommended edit: Read the authoritative control route and cell row before
  every mutating data-cell request, require open/recently healthy cells for
  discovery and route validation, refresh SDK routes on `401`, `403`, `404`,
  and `409` refresh signals, and validate cell ids before producing hostnames.
- Decision: Accepted. The final slice refreshes route ownership from Postgres
  on write admission, checks cell status and health before returning or
  accepting a route, broadens the SDK refresh signals, and restricts deploy
  cell ids to lowercase Cloud Run/DNS-safe labels.

Fresh reviewer 8: Final Phase 2/3 diff validation

- Finding: `INSTANTML_DEFAULT_DATA_CELL_ID` was being treated as the current
  data-cell identity for control processes; the public-router suffix was only
  injected into data services even though route discovery runs on control; route
  discovery forced a full control projection reload; and local writer-lease
  admission could be measured from after the SQL round trip instead of before
  the Postgres lease was acquired.
- Risk: Control-hosted routes could reject orgs assigned away from the default
  cell, hosted route discovery could fail closed for valid cell hosts, route
  discovery traffic could become an accidental Postgres full-scan path, and a
  slow lease refresh could allow local writes past the real Postgres lease TTL.
- Recommended edit: Split default placement from explicit process cell
  identity, inject `INSTANTML_DATA_CELL_PUBLIC_API_BASE_ALLOWED_SUFFIX` into
  control and data targets, use point reads for route/cell/lease discovery, and
  derive the local lease deadline from a monotonic timestamp captured before
  the database call.
- Decision: Accepted. The implementation now keeps default placement separate
  from `INSTANTML_CELL_ID`, uses narrow Postgres reads for
  `/api/routing/current`, gives control the public-router suffix, and bounds the
  local writer-lease deadline conservatively.

Fresh reviewer 9: Final security and SDK behavior validation

- Finding: Loopback public cell bases were accepted outside local/test
  environments, a plain HTTP `409` could trigger SDK rediscovery/replay even
  without a route-change code, and the OpenAPI operation referenced an undefined
  bearer scheme.
- Risk: Hosted clients could send bearer keys to their own localhost after a bad
  deploy configuration, non-routing application conflicts could be replayed once
  unnecessarily, and generated OpenAPI consumers would see an invalid security
  scheme.
- Recommended edit: Allow loopback public cell bases only for local/test/dev,
  narrow `409` refreshes to `tenant_route_changed`/`wrong_cell`, and use the
  existing `bearerApiKey` security scheme.
- Decision: Accepted. Rust route discovery and the Cloud Run deploy helper now
  reject hosted loopback public bases, SDK rediscovery no longer triggers on an
  unqualified `409`, and `/api/routing/current` references `bearerApiKey`.

Fresh reviewer 10: Final compatibility and deploy-readiness validation

- Finding: Explicit data-cell validation rejected BYOC and legacy tenant routes
  whose `cell_id` is intentionally `NULL`; public-router deploys could publish
  `INSTANTML_DATA_CELL_PUBLIC_API_BASE` before DNS and certificates were active;
  and long-running mutations still prove the writer lease only at admission.
- Risk: Customer-owned ClickHouse orgs and pre-cell compatibility routes could
  fail on split data services, SDKs could cache a not-yet-routable cell host
  during first router provisioning, and very long requests can still outlive the
  short local lease-admission proof.
- Recommended edit: Preserve `NULL cell_id` compatibility on the apex/default
  path while rejecting direct cell routing for unassigned routes, publish direct
  cell bases only after router activation, and keep long-running mutation
  fencing as a documented follow-up.
- Decision: Accepted for the blocking compatibility and deploy-readiness
  issues. The implementation now allows unassigned BYOC/legacy routes through
  compatibility paths, rejects invented direct cell routes for them, and
  updates data services with public cell bases only after the router is active.
  Request-long writer fencing remains a later hardening item for import and
  other long-running mutation workflows.

Fresh reviewer 11: Phase 4/5 operations and performance review

- Finding: Direct Postgres reads could turn every request into unbounded Cloud
  SQL QPS; control scaling lacked a hard capacity-plan gate; migration records
  were too thin for incidents; rollback after target writes was unsafe; and
  informal operator copy attestation was too weak for production cutover.
- Risk: Control scaling could exhaust Cloud SQL, migrations could leave an org
  blocked without enough evidence to recover, and rollback could lose accepted
  target writes.
- Recommended edit: Define query-count bounds, staging load-test gates, and
  explicit `capacity-plan` requirements; add migration events/evidence fields;
  defer rollback/cutover until reverse-delta or read-only target semantics are
  designed; treat the first migration slice as control-plane/write-block only.
- Decision: Accepted. Phase 4A now specifies direct point-read contracts,
  per-route hot-path bounds, and a hard capacity preflight before control
  scaling. Phase 5A is narrowed to planning, write blocking, restore/failure,
  and structured records; copy, cutover, rollback window, completion, and
  cleanup are deferred to Phase 5B.

Fresh reviewer 12: Phase 4/5 security and compatibility review

- Finding: The doc still contradicted itself about browser-session route
  discovery; auth freshness tests were too narrow; bootstrap-only migration
  endpoints lacked named operator boundaries; `write_blocked` behavior and
  `Retry-After` were underspecified; public cell labels could leak placement
  details; and legacy clients could be moved away from compatibility cells.
- Risk: Browser cookies could be sent to cell hosts before CSRF/CORS rules
  exist, direct reads could drop existing auth invariants, powerful migration
  operations could become anonymous bootstrap-token actions, and legacy SDKs
  could stop writing after a migration.
- Recommended edit: Make route discovery API-key-only throughout the doc; add
  the direct-read invariant matrix; require hidden admin/internal operator
  controls and transition audit; specify read/write/discovery behavior for
  `write_blocked`; require bounded `Retry-After`; and add a legacy-client
  migration guard.
- Decision: Accepted. The API contract and tests now require API-key-only route
  discovery with browser-session `401`; Phase 4A includes the auth invariant
  matrix; Phase 5A names operator boundary expectations, route-status behavior,
  bounded retry semantics, and legacy-client safeguards.

Fresh reviewer 13: Phase 4/5 distributed correctness review

- Finding: The initial slice was too broad; current route loading rejected
  non-ready routes before read/write policy; `org_migrations` lacked database
  invariants and guarded transitions; direct reads needed exact contracts and
  query limits; cutover preconditions were too weak; copy-failure wording
  conflicted with write-block-first flow; and route-discovery docs still drifted
  toward browser direct-cell auth.
- Risk: A single PR could mix unrelated correctness domains, source reads could
  fail during write-block windows, two migrations could race for one org, route
  cutover could happen without enough proof, and failure recovery could be
  ambiguous.
- Recommended edit: Split Phase 4A, Phase 5A, and Phase 5B; add
  `route_allows_reads`/`route_allows_writes` semantics; enforce active-migration
  uniqueness, state checks, source/target FK checks, and transactional
  transitions; stage target route information in migrations until cutover; and
  rewrite failure recovery in terms of restoring `ready` or staying blocked
  with recovery steps.
- Decision: Accepted. The revised implementation slice is Phase 4A plus Phase
  5A. Phase 5B is explicitly deferred until structured copy/validation,
  cutover, rollback, idempotency reconciliation, and cleanup receive a separate
  accepted design.

## Coverage Exceptions

None for the Phase 0 preflight/runbook slice or the Phase 2/3 route-discovery
slice.

## Decision

Phase 0 Cloud SQL capacity preflight and operator runbook, Phase 1 cell
registry, and the Phase 2/3 route-discovery slice are accepted and implemented.
The revised Phase 4A direct-control-read slice and Phase 5A
migration-control/write-block slice are the candidate implementation for this
branch pending final fresh review. Phase 5B copy, cutover, rollback window,
completion, cleanup, and automated ClickHouse copy remain draft until they
receive a separate accepted design.
