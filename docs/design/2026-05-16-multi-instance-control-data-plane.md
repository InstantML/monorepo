# Design: Multi-Instance Control/Data Plane

Date: 2026-05-16

Status: Accepted for narrow first slice after review revisions

Owner: Codex

## Summary

InstantML should not add a central application proxy that receives every SDK,
browser, metric, artifact, and admin request and then forwards it to hidden
handlers. That would concentrate latency, cost, and failure in the hottest path
without solving the deeper storage issue: each Rust process currently has its
own operational index.

The better hosted architecture is a global control plane plus one or more
stateless data-plane cells. The control plane owns identity, organizations,
memberships, API-key lookup/metadata, billing/account state, and tenant-route
selection. Data-plane cells own tenant product state and metrics for the orgs
routed to that cell. Cloud Run, a cloud load balancer, or an API gateway should
handle normal request distribution; InstantML should keep any app-level router
thin and focused on tenant discovery, auth/session exchange, and cell routing.

The smallest useful implementation in this change is not to raise Cloud Run
max instances yet. It is to factor operational replay into a deterministic,
unit-tested full-projection layer and document the route/storage contract
required before multi-instance Cloud Run is enabled. This gives later work a
clean place to add a stable operational event id, request-time catch-up, direct
operational queries, or an org-scoped write coordinator without changing public
REST route shapes.

## Goals

- Decide whether InstantML needs a central proxy for multi-instance hosting.
- Define the multi-instance hosted topology for control plane, data-plane cells,
  tenant routes, and Cloud Run/LB responsibilities.
- Preserve current frontend, SDK, and API route shapes.
- Keep the currently deployed Cloud Run service single-instance and treat that
  as a risk reducer, not as the correctness mechanism. Cloud Run's maximum
  instance setting can be briefly exceeded under automatic scaling according to
  the official max-instances docs, so public correctness still requires the
  storage gates below.
- Implement the first code slice: deterministic operational projection/replay
  helpers with focused unit tests.
- Update architecture and component docs so future agents do not accidentally
  scale the single-process cache by only changing Cloud Run settings.

## Non-Goals

- Do not deploy this change.
- Do not raise Cloud Run max instances.
- Do not introduce a central hot-path proxy for all traffic.
- Do not add Redis, Kafka, Spanner, Firestore, or another coordinator in this
  first slice.
- Do not change REST endpoints, SDK methods, request bodies, response shapes, or
  browser auth behavior.
- Do not claim public-launch multi-writer correctness until mutation uniqueness
  and stale-cache behavior are explicitly solved.

## Users and Use Cases

Operators need to scale the hosted Rust API without serving stale org state or
creating duplicate low-volume records when two API instances accept related
mutations at the same time.

Frontend users should keep using one configured API base URL. They should not
know whether their organization is in a shared data-plane cell or a dedicated
cell.

SDK users should keep sending the same bearer API-key requests. High-volume
metric logging should not detour through an avoidable central proxy once the org
is already routed to a healthy cell.

Future agents need a clear checklist before changing Cloud Run `maxScale` from
`1`, changing Cloud Run scaling mode, or adding traffic splits/tags that can
start more than one revision.

## Proposed Design

### Topology

Use three logical layers:

```text
Browser / Python SDK
  -> public InstantML API endpoint
  -> control-plane responsibility for auth, org lookup, and route selection
  -> data-plane cell Cloud Run service
  -> org ClickHouse operational records + metric tables + artifact storage
```

The public endpoint may be implemented by the same Rust binary initially, but
the responsibilities should stay separate in code and docs:

- Control plane: users, identities, organizations, memberships, sessions,
  API-key metadata, account status, billing state, and tenant routes.
- Data plane: projects, runs, attributes, artifacts, imports, idempotency,
  usage snapshots, console logs, scalar metric points, and metric summaries.
- Artifact plane: object storage for bytes once hosted artifact uploads are
  enabled.

Cloud Run and/or a cloud load balancer should distribute requests among
instances inside a cell. A central app proxy is only acceptable as a thin
tenant-routing or compatibility layer, not as the permanent handler for all
metric and artifact traffic.

Phase plan:

| Phase | Public entrypoint | Data-plane shape | Allowed scale |
| --- | --- | --- | --- |
| Current internal hosted slice | One Rust Cloud Run service | Control and data-plane responsibilities in one binary | Single active instance only |
| Dedicated customer cell | Stable public API plus org-dedicated cell URL or internal routing | One org per cell/service | One active data-plane instance per org until write gates close |
| Shared multi-instance cell | Stable public API plus explicit tenant discovery/routing | Many orgs per cell | Multiple equivalent data-plane instances only after read/write gates close |

Cloud Load Balancing and serverless NEGs route by host, path, and load-balancer
configuration; they cannot choose a tenant cell from an org id hidden inside a
bearer token or session cookie before the application authenticates the request.
Tenant routing therefore needs a host/path-visible cell URL, an app/API-gateway
tenant discovery step, or internal application routing.

### Routing Contract

Every request must resolve exactly one tenant context before data-plane state is
read or mutated:

- Browser session requests resolve an active user membership and org.
- API-key requests resolve the key's org and optional project restriction.
- Bootstrap/operator requests either stay in the control plane or explicitly
  name the org they operate on.
- Data-plane reads and writes use the tenant route for that org.

The first public endpoint can keep serving the current route set from one Rust
binary. This slice does not introduce public redirects or public cell endpoints.
Future SDK cell caching or redirects must use semantics that preserve POST
bodies, `Authorization`, and `Idempotency-Key` headers, and must include explicit
SDK tests before rollout. Browser traffic should stay behind the same-origin
frontend/API path unless cookie, CORS, and session exchange rules are designed.

Before direct-to-cell SDK traffic exists, the data-plane cell auth contract must
be accepted. The likely choices are short-lived control-plane-issued cell tokens
or replicated/read-through API-key and session metadata with a documented
revocation staleness limit. Either model must preserve project-scoped keys,
revoked keys, session expiry, and demo read-only clamps.

### Data-Plane Instance Model

Data-plane Rust instances must become stateless with respect to durable truth:

- ClickHouse operational records are the durable source for low-volume tenant
  entities.
- ClickHouse metric tables are the durable source for scalar time series and
  summaries.
- Each instance may keep an in-memory operational projection for speed.
- Projection state must be rebuildable from ClickHouse and refreshable before
  serving routes that need recent operational data.
- Mutating routes must write complete operational payloads and then update the
  local projection only after durable write success.

The existing single-process mutex remains useful for local consistency inside
one process, but it is not a distributed coordination mechanism.

### Multi-Instance Read Gate

Before a cell can run more than one API instance, it needs one of these accepted
read strategies:

1. Request-time projection refresh for org-scoped operational reads, using a
   deterministic replay helper and a durable event id or per-org sequence.
2. Short-interval background projection refresh with bounded staleness
   documented per endpoint.
3. Direct ClickHouse operational queries for the endpoints where cache staleness
   is unacceptable.

The implementation in this PR starts with the deterministic projection helper
only. It centralizes replay rules so later refresh paths can call one tested
function instead of duplicating `apply_record` loops.

`created_at` alone is not an accepted incremental refresh watermark for
multi-instance writes. The current per-process monotonic clock prevents ties
inside one process, but not across multiple writers. Until the schema has a
stable event id or per-org sequence, refresh work must use full replay or a
direct ClickHouse query that does not skip equal-timestamp rows.

### Multi-Instance Write Gate

Before a cell can run more than one API instance for writes, every low-volume
mutation must fit one of these patterns:

- Deterministic/idempotent entity identity, where retries and duplicate creates
  converge to the same durable record.
- Org-scoped write coordination for routes that need uniqueness checks that
  ClickHouse cannot enforce directly.
- Direct operational query plus conflict detection that safely rejects a stale
  create/update after another instance wins.

Metric point insertion is also gated. Points are append-heavy, but the current
idempotency check is an in-memory check followed by a ClickHouse insert and then
an operational idempotency record. Two instances can double-insert the same
request. Metrics/log ingestion needs atomic durable idempotency, an ingest id
that can be deduped in ClickHouse, or an org/idempotency-key write coordinator
before it is considered multi-writer safe.

Mutation gate matrix:

| Route class | Current uniqueness/state source | Multi-instance risk | Gate before scale-out |
| --- | --- | --- | --- |
| API-key auth/revocation | In-memory projection from control records | Revoked or demo-clamped keys can stay accepted on stale cells | Cell auth contract plus revocation/session tests |
| Project create | In-memory `(org_id, name)` index with random project id | Duplicate project names and divergent ids | Durable uniqueness or coordinated create |
| Run create/update | In-memory project/run projection | Writes can attach to stale project state or overwrite stale run fields | Request-time refresh/direct project lookup plus conflict tests |
| Metric/log ingest | In-memory idempotency record | Duplicate metric/log rows on concurrent retry | Atomic durable idempotency or dedupe key in metric/log rows |
| Attribute/import ids | Per-process integer counters | Duplicate local integer ids | Durable per-org sequence or deterministic ids |
| Sessions/API keys | In-memory control projection | Revocation, expiry, and scope changes can be stale | Auth metadata refresh/token contract |
| Demo reset/imports | Multi-record partial operations | Mixed old/new state across instances | Staging, compensation, or single-writer lease |
| Usage snapshots | In-memory org/product projection | Missing or duplicated snapshots | Idempotent daily key plus refreshed projection |

### Dedicated Cells

For serious customers, the first safe scale-out mode can be a dedicated
data-plane cell per org with `maxScale=1` per cell. That gives isolation and
keeps single-writer semantics while the product grows. Shared multi-instance
cells can follow once the read and write gates above are closed.

For Cloud Run specifically, `maxScale=1` under automatic scaling is not a
correctness boundary. Internal dedicated cells should prefer manual scaling at
one instance or an app-level single-writer lease before they are used for
external customers.

## Component Impact

Backend:

- Add a small operational replay/projection helper inside `apps/rust-server`.
- Route startup and tenant load paths through the helper.
- Keep existing route handlers and DTOs unchanged.
- Keep Cloud Run deployment guarded for one active instance. Future deployment
  work should verify scaling mode, active traffic revisions, and tag-only
  revisions before treating the service as single-instance.

Frontend:

- No route or environment variable change in this slice.
- Future cell redirects or discovery should be hidden behind the configured API
  base.

Python SDK:

- No public API change.
- Future endpoint caching or redirect support should be optional and backward
  compatible.

Storage:

- No schema change in this slice.
- Operational replay remains based on complete JSON payloads sorted
  deterministically for full projection rebuilds.
- A future refresh watermark requires an additional durable sequence or record
  id. Timestamp ordering is not sufficient for incremental catch-up.

Docs:

- Update `apps/rust-server/README.md`, `apps/rust-server/src/store/README.md`,
  `docs/architecture/current-system.md`, `docs/architecture/current-api.md`,
  and `docs/design/README.md`.

## Data Model

No new persisted fields in this slice.

The logical model adds these terms:

- Control-plane route record: existing `tenant_route` payload that maps `org_id`
  to the data-plane service/database.
- Operational projection: an in-memory `StoreData` view rebuilt by replaying
  durable operational records.
- Replay scope: all records for local/control startup, or one expected org for
  tenant data-plane replay.

Future schema additions to consider:

- Stable operational `event_id` or monotonic per-org sequence for incremental
  refresh.
- Explicit tombstone record kinds for delete-like operations that need simpler
  reconciliation.
- Tenant cell health/status metadata in the control plane.

## API Contracts

No public contract changes in this slice.

Future routing must preserve these external contracts:

- Existing REST paths stay valid.
- Error bodies keep the `{"error": "message"}` shape.
- API-key project restrictions stay enforced after routing.
- Browser sessions resolve to exactly one active org before tenant state is
  accessed.
- No public cell redirects in this slice.
- Any future redirect must use method-preserving semantics, be safe for SDK
  clients, preserve auth and idempotency headers, and must not expose tenant
  secrets.

## Performance Considerations

Expected first-slice cost:

- Startup replay remains O(number of operational records) for the loaded control
  plane or tenant.
- Unit-tested replay sorting is in-memory and only used for low-volume records.
- Metric reads/writes remain on existing ClickHouse metric tables.

Expected future scale targets:

- Shared cells should support many orgs with bounded run list and metric-series
  endpoints.
- Hot metric ingestion should eventually terminate at the routed data-plane cell
  after atomic idempotency or dedupe exists.
- Control-plane routing reads should stay low-volume and cacheable.
- Projection refresh should be org-scoped and avoid replaying unrelated tenants.

Before enabling multi-instance Cloud Run, benchmark:

- API-key auth and tenant route lookup.
- Project/run list after writes from another instance.
- SDK metric logging latency under multiple Cloud Run instances.
- Browser session exchange while another instance creates the same org/project.

## Simplicity Review

The simplest safe answer is to keep the public API shape and split
responsibilities, not to add a new central hot-path service. Cloud Run already
provides request distribution; InstantML should fix shared-state correctness at
the storage/projection layer.

Deferred complexity:

- Distributed locks or queues.
- SDK cell endpoint caching.
- Per-org operation leases.
- Incremental replay schema changes.
- Atomic metric/log idempotency.
- Hosted object storage and artifact byte reconciliation.

## Failure Modes

- ClickHouse unavailable: readiness fails and routes return server errors.
- Stale projection: an instance can miss records written by another instance
  until refresh exists; this is why the hosted service stays single-instance
  and why single-instance scaling is not the final correctness mechanism.
- Cloud Run automatic max instances: a `maxScale=1` setting can reduce risk, but
  official Cloud Run [maximum instance docs](https://cloud.google.com/run/docs/configuring/max-instances)
  describe brief overrun behavior for maximum instances. Cloud Run
  [manual scaling](https://cloud.google.com/run/docs/configuring/services/manual-scaling)
  or an app-level lease is needed before relying on one writer for
  customer-facing correctness.
- Concurrent duplicate create: ClickHouse does not enforce unique project names,
  API-key names, or membership constraints; write gates must close before
  multi-writer cells launch.
- Misrouted tenant record: replay must reject a tenant record whose row or
  payload belongs to a different org.
- Central router outage: if a future router does more than tenant discovery, it
  becomes a hot-path single point of failure.
- Dedicated single-instance cell outage: one customer's cell can be isolated but
  may need Cloud Run restart or failover before requests recover.

## Testing Plan

This PR should add Rust unit tests for:

- Deterministic replay ordering.
- Latest entity updates replacing older projection indexes.
- Tenant-scoped replay rejecting records for another org.
- Tenant-scoped replay rejecting payloads whose nested org differs from the
  expected org.
- Full replay reporting the latest observed record timestamp for the local
  single-process write clock without treating that timestamp as a multi-instance
  incremental cursor.

Existing verification to run:

- `cargo fmt --manifest-path apps/rust-server/Cargo.toml --all -- --check`
- `npm run rust:test`
- `npm run test:rust:contract`
- `npm run test:rust:sdk`
- `npm run test:hosted-clickhouse`
- `npm run test:rust:ui`

No live GCP or ClickHouse Cloud deployment commands should be run for this
change.

## Documentation Plan

Update:

- `docs/design/README.md`
- `docs/architecture/current-system.md`
- `docs/architecture/current-api.md`
- `apps/rust-server/README.md`
- `apps/rust-server/src/store/README.md`
- `tools/README.md` if smoke tooling changes while verifying the slice.

## Alternatives Considered

Central proxy for all requests:

- Rejected as the default architecture. It adds a hot-path bottleneck and does
  not by itself fix stale per-instance operational projections.

Dedicated one-instance service per org:

- Useful as an intermediate hosted isolation model. It is not enough for free
  or small shared cells, but it can safely serve serious customers before
  shared multi-writer cells are ready.

Add Redis/Kafka/Spanner now:

- Deferred. A coordinator may become necessary for write uniqueness, but the
  first step is to isolate the exact places where ClickHouse-only semantics are
  insufficient.

Direct ClickHouse reads for every operational endpoint:

- Possible for some reads, but it risks recreating OLTP patterns in ClickHouse
  and may complicate route code. Keep this as a targeted option for endpoints
  where stale cache is unacceptable.

## Review Notes

Fresh reviewer 1:

- Finding: `maxScale=1` is a risk reducer, not a correctness boundary; the
  topology still implied a central forwarding service; direct data-plane traffic
  lacked an auth model; metric ingestion and timestamp watermarks were
  overclaimed.
- Risk: Multiple Rust instances can still race writes or serve stale state, and
  a temporary router can become a permanent hot-path proxy.
- Recommended edit: Add a phase table, L7-versus-tenant routing wording,
  direct-cell auth gate, metric-idempotency gate, and full-replay-only scope.
- Decision: Accepted. The design now rejects direct public redirects in this
  slice, treats metrics as gated, and keeps full replay as the only implemented
  helper.

Fresh reviewer 2:

- Finding: Metric idempotency is not multi-writer safe; operational replay has
  no durable tie-breaker; stale cache and write uniqueness blockers need an
  explicit matrix; shared-cell org replay is unsupported by current unfiltered
  tenant loads.
- Risk: Duplicate metric aggregates, skipped records during incremental
  refresh, stale revocation/session/project state, and accidental shared-cell
  scale-out.
- Recommended edit: Mark metric/log ingestion blocked, require event id or
  per-org sequence for incremental refresh, enumerate mutation gates, and add
  tenant replay validation tests.
- Decision: Accepted. The first slice implements deterministic full replay and
  tenant-scoped validation only; shared-cell incremental refresh is deferred.

Fresh reviewer 3:

- Finding: Future SDK cell routing needs an explicit auth/redirect contract;
  the test plan was too narrow; docs/coverage should acknowledge deferred
  multi-instance behavior.
- Risk: SDK POSTs can lose auth/idempotency across redirects, browser cookies can
  break across origins, and deferred correctness could look covered when it is
  not.
- Recommended edit: Ban public redirects in this slice, require future
  method-preserving redirects and SDK tests if redirects are added, expand
  verification, and document coverage exceptions.
- Decision: Accepted. The API contract and coverage sections now state the
  deferred behavior explicitly.

## Coverage Exceptions

- Uncovered area: live multi-instance freshness, write uniqueness, direct-cell
  auth, SDK cell redirects, and atomic metric/log idempotency.
- Reason: This accepted first slice only factors deterministic full replay and
  documents scale-out gates. It intentionally does not enable multiple live API
  instances.
- Risk: Operators could still create stale state or duplicate writes by scaling
  the hosted service manually outside the accepted gates.
- Follow-up: Add a stable operational event id or per-org sequence, close the
  mutation matrix gates, and run two-instance ClickHouse-backed integration
  tests before enabling shared cells.
- Owner/date: hosted backend owner, 2026-05-16.

## Decision

Accepted for the narrow first slice: deterministic full operational replay,
tenant-scoped replay validation, route/mutation gate documentation, and no
deployment.
