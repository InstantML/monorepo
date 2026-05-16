# Design: Hosted ClickHouse Routing

Date: 2026-05-14

Status: Accepted for narrow local/test first slice; shared hosted demo addendum accepted

Owner: Codex

## Summary

InstantML needs to turn the ClickHouse-only local slice into a hosted-shaped flow: signup creates durable account and organization records in the InstantML User Data ClickHouse service, provisions a tenant data plane, records the tenant route server-side, and routes SDK/API-key traffic to that tenant data plane. The frontend should stay on the existing signup, onboarding, and dashboard routes, and the Python SDK should keep using bearer API keys without learning ClickHouse tenant endpoints.

The smallest useful implementation keeps one Rust API process as the public control-plane API. It persists users, identities, organizations, memberships, sessions, service accounts, API keys, and tenant routes into a User Data ClickHouse table. Tenant-owned projects, runs, attributes, artifacts, imports, idempotency records, usage snapshots, and metric points live in the organization data plane selected by the tenant route. The Rust server keeps the current in-process operational index but separates control records from tenant records.

Provisioning uses a narrow `TenantProvisioner` boundary. The accepted first slice uses `database` mode: it creates an isolated per-org database on an existing ClickHouse endpoint and records the route. This is explicitly local/test or early-internal only unless paired with per-org least-privilege ClickHouse users and cross-database denial tests. `cloud-service` provisioning may be scaffolded behind explicit opt-in, but real production use remains blocked until secret storage, idempotent cleanup, and service lifecycle handling are hardened.

Shared demo addendum: the local Google-style demo path treats `hello@instantml.ai` as a canonical demo user and organization named `InstantML Demo`. The alias `hello@instantml.com` maps to the same canonical email for operator convenience. This path must reuse the existing org and tenant route so repeated demos do not create duplicate ClickHouse services. A guarded hosted benchmark seed tool may create or reuse that org's ClickHouse Cloud service and bulk seed the 100,000-run demo benchmark once for latency testing.

## Goals

- Persist signup users, orgs, memberships, sessions, routes, and API keys to the InstantML User Data ClickHouse endpoint.
- Persist service routes and API keys to the User Data layer instead of only the tenant data plane.
- Provision a tenant data plane during signup and save enough server-side routing fields to reconnect after restart.
- Route API-key SDK writes to the tenant data plane attached to that key's organization.
- Route dashboard reads through the same tenant data plane so SDK-ingested data appears in the frontend.
- Keep existing REST route shapes and Python SDK public API.
- Add focused Rust tests for control replay, route resolution, provisioning decisions, isolation checks, and route failure behavior.
- Add end-to-end smokes for signup -> key -> Python ingest -> dashboard read.
- Add guarded scale tooling for 100,000-run dashboard/search timing without forcing every test to write billions of rows.

## Non-Goals

- Do not build organization switching, invitation email delivery, billing, Clerk/Google production auth, service deletion, or a tenant-service cleanup UI.
- Do not expose service passwords, ClickHouse Cloud API keys, tenant endpoints, secret references, or ciphertext to the browser.
- Do not require the Python SDK to know the tenant service endpoint; the Rust API remains the stable SDK endpoint.
- Do not create one paid ClickHouse Cloud service per automated test run.
- Do not make multi-process hosted correctness claims beyond a single Rust API process with durable control-plane replay.
- Do not migrate existing local generated ClickHouse state automatically.

## Users and Use Cases

New user signup:

1. User clicks sign up in the Next frontend.
2. The Rust API validates the local/dev or managed-auth payload.
3. The API creates or reuses a global user/identity, creates or resumes an organization provisioning flow in User Data, provisions the tenant data plane, records its route, applies tenant schema, creates owner membership, and sets a browser session cookie.
4. The frontend shows onboarding and can create a copy-once SDK API key only after the route is ready.

SDK ingestion:

1. User copies the API key from onboarding.
2. Python SDK sends `Authorization: Bearer instantml_...` to the Rust API.
3. Rust authenticates the key from User Data, resolves the key's org route, and writes projects/runs/metrics to that org's tenant data plane.
4. Dashboard requests with the user's session resolve the same org route and read summaries/series from the tenant data plane.

Scale validation:

1. A benchmark creates or selects a test org/key.
2. A Python-driven ingest probe creates real runs and metrics through the SDK route.
3. A guarded bulk seed tool can fill the tenant data plane directly for 100,000-run dashboard/search timing, with row counts configurable so local and hosted runs do not accidentally create runaway cost.

## Proposed Design

### Configuration

Add hosted ClickHouse config to the Rust server:

- `INSTANTML_HOSTED_CLICKHOUSE_ENABLED`: enables User Data and tenant routing.
- `CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT`: HTTPS ClickHouse endpoint for control-plane storage.
- `CLICKHOUSE_INSTANTML_USER_DATA_USERNAME`
- `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD`
- `CLICKHOUSE_CLOUD_ENDPOINT`: ClickHouse Cloud API endpoint, default `https://api.clickhouse.cloud`.
- `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID`
- `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET`
- `INSTANTML_CLICKHOUSE_PROVISIONER`: `database` or `cloud-service`; default `database` only for local/test. Hosted deployments must set this explicitly.
- `INSTANTML_TENANT_CLICKHOUSE_URL`: optional base URL for database-mode tenant databases; defaults to the User Data endpoint.
- `INSTANTML_CLICKHOUSE_CLOUD_ORG_ID`: explicit ClickHouse Cloud org id for cloud-service mode. If omitted, cloud-service mode discovers the first available organization through `GET /v1/organizations`.
- `INSTANTML_CLICKHOUSE_CLOUD_PROVIDER`, `INSTANTML_CLICKHOUSE_CLOUD_REGION`, `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST`, `INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB`, `INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB`, `INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS`: optional cloud service shape and query access. The demo default allows `0.0.0.0/0`; production should restrict this to API egress CIDRs.
- `INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS`: wait cap for service readiness.
- `INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS`: required to store tenant passwords in User Data for cloud-service mode until a secret manager is wired. Database mode stores a config password reference instead of copying the base password into User Data.

Do not print these values. Logs may include org id, service id, endpoint host, provisioner mode, and route state.

### Control Plane Store

Add `control_store` for the User Data layer. It uses the same ClickHouse client style as `MetricStore` but applies a separate control schema. The control schema stores append-only JSON rows in an `instantml_user_data` table, not a relational set of mutable tables. This mirrors the current operational record approach, keeps the first slice simple, and makes replay deterministic.

Control-plane record kinds:

- `user`
- `identity`
- `organization`
- `membership`
- `session`
- `service_account`
- `api_key`
- `tenant_route`
- `tenant_provision_event`

Control rows include an explicit `scope`:

- `global`: users, identities, API-key hash lookup records, and provider identity uniqueness records. Stored with sentinel org id `00000000-0000-0000-0000-000000000000`.
- `org`: organizations, memberships, sessions, service accounts, API keys, tenant routes, and provisioning events. Stored with the real org id.

Rows include an `event_id` UUID and mutable payloads include a `version` integer. Replay sorts by `(created_at, event_id)` and applies the highest version per entity. Revocation and route failure are full replacement payloads, not partial deltas.

The existing `StoreData` remains the runtime index, but startup changes:

1. Load control-plane rows from User Data if hosted mode is enabled; otherwise load from the default local ClickHouse operational records.
2. Apply control-plane rows into `StoreData`.
3. Register tenant routes in the routing cache without opening every tenant.
4. Lazily initialize each tenant `MetricStore` on first request for that org, apply schema, load that tenant's `operational_records`, and apply project/run/object/artifact/import/idempotency rows into `StoreData`.
5. Cache per-tenant readiness state. A failed tenant returns `503` only for that org and does not block server readiness for unrelated orgs.
6. Ensure the local org only in non-hosted local mode.

### Tenant Routes

Add a `TenantRouteRecord` stored in User Data:

- `org_id`
- `mode`: `database` or `cloud-service`
- `status`: `provisioning`, `ready`, `failed`
- `provisioning_operation_id`: deterministic id derived from org id
- `service_id`: ClickHouse Cloud service id when cloud mode is used
- `endpoint`: HTTPS ClickHouse query endpoint
- `username`
- `password_secret_ref`: future secret-manager reference
- `password_ciphertext`: optional local/test-only stored password value until a secret manager exists
- `database`
- `created_at`
- `updated_at`
- `last_error`
- `version`

The first slice may store a tenant password in User Data only when `INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS=true`. That flag is for local/test and early hosted experiments only. Production cloud-service use is blocked until credentials are stored as secret-manager references or KMS/envelope-encrypted values with rotation semantics. The frontend never receives endpoint, username, password, ciphertext, or secret refs.

### Signup And Provisioning State Machine

Signup is modeled as an idempotent provisioning flow:

1. Normalize provider identity and email.
2. Reuse an existing user for the identity/email, or create a global `user` and `identity`.
3. Resolve organization by `(created_by_user_id, requested org name, account_type)` for local/dev signup retries. If a ready org exists, create a fresh session and return it.
4. If an org exists with a `provisioning` route, retry or resume provisioning for that org instead of creating another org.
5. If an org exists with a `failed` route, replace the failed route only when the retry request matches the same owner/name/account type; otherwise return a conflict.
6. Create organization and owner membership as control records.
7. Write a `tenant_route` with `status=provisioning`.
8. Run the provisioner. The provisioner must be idempotent for the operation id and service/database name.
9. Apply tenant schema and mark route `ready`.
10. Only after route readiness create the browser session. SDK API key creation is rejected until the route is ready.

If cloud-service mode creates a service and later fails, it records `service_id`, `status=failed`, and `last_error`. Cleanup is operator-owned in this PR; automated deletion is deferred because deleting external services is destructive.

### Provisioning

`database` provisioner:

- Creates a database named from the org id, for example `org_<uuid_without_dashes>`.
- Records route endpoint/user/password/database from configured User Data values only when local/test credential reuse is explicitly allowed.
- Future hardening: create per-org ClickHouse users with least-privilege grants and verify cross-database denial before this mode is considered hosted-safe.
- Applies the Rust tenant schema to that database.
- Marks route `ready`.

`cloud-service` provisioner:

- Calls `GET /v1/organizations` or uses `INSTANTML_CLICKHOUSE_CLOUD_ORG_ID`.
- Calls `POST /v1/organizations/{organizationId}/services` with a service name derived from the org name plus a stable org-id prefix, and the configured provider/region/replica shape.
- Stores the returned service id and password as a secret reference or, only with the explicit stored-password flag, as local/test ciphertext/plaintext in User Data; default username is `default` unless the API returns otherwise.
- Polls `GET /v1/organizations/{organizationId}/services/{serviceId}` until the service is `running` or the timeout expires.
- Extracts the HTTPS endpoint from the service endpoints.
- Applies the tenant schema to the service.
- Marks route `ready`; on failure, stores a failed route and returns a clear signup error. Repeated signup attempts with the same owner/org resume or replace according to the state machine above.

### Routing

Add these `Store` helpers:

- `tenant_metric_store_for_context(ctx: &ResolvedTenantContext) -> MetricStore`
- `control_or_default_store_for_kind(kind, org_id) -> MetricStore`
- `persist_control_locked(kind, org_id, entity_id, payload)`
- `persist_tenant_locked(kind, org_id, entity_id, payload)`
- `resolve_tenant_context(ctx: &RequestContext) -> ResolvedTenantContext`

Tenant resolution must only accept an authenticated/session-derived context, not a raw untrusted org id from a path or body. Bootstrap/admin paths that operate by org id must validate admin/bootstrap authority before resolving the tenant route.

Move public methods to the correct persistence layer:

- Control layer: users, identities, organizations, memberships, sessions, service accounts, API keys, tenant routes.
- Tenant layer: projects, project deletes, runs, attributes, artifacts, table rows, imports, idempotency records, usage snapshots, metric points, metric series.

Metric reads and writes that currently call `store.metric_store()` must use the resolved tenant store for the request org. That includes run summary, overview, metrics, batched series, side-by-side, export, usage metric counts, imports, demo reset, and benchmark helpers.

### Frontend

The visible local/dev flow stays mostly the same:

- `/signup` posts to `/api/auth/dev/google` only in local/dev mode.
- The local/dev auth page includes a shared demo action that posts `hello@instantml.ai`, `InstantML Demo`, and `business`; the Rust API canonicalizes that identity server-side so direct API calls get the same reuse behavior.
- Hosted signup must use `/api/auth/clerk` once managed auth is enabled. This PR keeps `/api/auth/dev/google` as the local verification route and tests that it is disabled when dev auth is disabled.
- On success, the API response may include a safe `provisioning` object with `status`, `mode`, and optional `service_id`, never password or endpoint secrets.
- Onboarding still creates the SDK API key through `/api/orgs/:org_id/api-keys`.
- Dashboard reads are unchanged and should show SDK-ingested data for the signed-in org.

If provisioning is slow, the signup route should return only after the database-mode route is ready. For cloud-service mode, the first implementation may block up to the configured timeout; background provisioning is deferred because it needs durable job state and retry semantics. API-key creation is disabled until the route is ready.

### Python SDK

No public API change. The SDK continues to send bearer API keys to the Rust API. Add or update integration scripts/tests that prove a key created by frontend/onboarding can ingest through Python and the dashboard can read the resulting data.

## Component Impact

Backend:

- Add hosted ClickHouse config.
- Add control-plane schema/client/provisioner modules.
- Extend `Store` with tenant route records and dynamic tenant `MetricStore` selection.
- Update storage methods to persist control records to User Data and tenant records to the org data plane.

Frontend:

- Keep the current signup/onboarding UI for local/dev verification.
- Optionally display a non-secret provisioning status message.
- Browser smoke should verify signup, API-key creation, SDK ingest visibility, and dashboard readback.

Python SDK:

- No API change.
- Add an end-to-end script or smoke that uses a real API key against Rust and measures run creation/metric logging/readback.

Storage:

- Add a User Data ClickHouse schema.
- Reuse existing tenant ClickHouse schema for org services/databases.
- Add a routing cache keyed by org id.

Docs:

- Update Rust server README, web README if signup status changes, Python SDK README if a new smoke script is added, and this design doc.

## Data Model

`instantml_user_data`:

```text
event_id   UUID
scope      LowCardinality(String)
kind       LowCardinality(String)
org_id     UUID
entity_id  String
payload    String CODEC(ZSTD(3))
created_at DateTime64(6, 'UTC')
```

Ordering: `(scope, kind, org_id, entity_id, created_at, event_id)`.

Tenant data planes keep the existing `operational_records`, `metric_points`, `metric_series`, and `metric_series_mv` tables.

`TenantRouteRecord` payload contains service routing fields. API key payloads keep hashed key bytes only; copy-once key secrets are still returned only at creation time.

## API Contracts

No route shape changes are required.

Changed response detail:

`POST /api/auth/dev/google` may include:

```json
{
  "authenticated": true,
  "organization": { "...": "..." },
  "provisioning": {
    "status": "ready",
    "mode": "database",
    "service_id": "optional-cloud-service-id"
  }
}
```

This field is additive and safe for old frontend code.

Error behavior:

- Provisioning failure returns a validation/server error with no secrets.
- A route in `failed` or missing state causes tenant routes to return `503`.
- API keys for an org with no ready route cannot ingest data.
- `/api/auth/dev/google` returns unauthorized/disabled outside local dev mode.

## Performance Considerations

Signup writes fewer than ten control records and creates one tenant route. It is not on the metric hot path.

API-key auth reads from the in-process index. It should not call ClickHouse per request after startup. Tenant store initialization is lazy and cached; the first request for an org may pay schema/readiness/replay cost, later requests should not.

Metric ingestion continues to batch scalar metrics through the existing insert path, but now targets the tenant store. SDK hot-path budgets remain unchanged.

Dashboard list/search/sort:

- Run list endpoints stay paginated.
- Name/tag/note search still filters the in-process operational index in this slice.
- Metric sorting still queries ClickHouse aggregates for bounded run ids.
- Large-scale validation should measure summary page latency, token search latency by run name/tag/note, metric-key catalog latency, metric-sort latency, and chart series latency.

The requested 100,000 runs x 20,000 steps implies at least 2,000,000,000 metric steps before multiple metric keys. This is a real storage/cost workload, not a normal CI smoke. The implementation should provide a guarded benchmark command with explicit env vars and a safety confirmation variable. It should run a smaller Python SDK e2e plus a larger ClickHouse-side seed unless the user explicitly enables the full hosted load. Acceptance output should include machine/date, run count, metric point count, summary latency, name/tag search latency, metric sort latency, and chart query latency. Direct ClickHouse seeding must insert through the same tenant tables/materialized views used by API ingestion.

## Simplicity Review

This design keeps the Rust API as the only public API and keeps bearer API keys as the SDK contract. It introduces one new abstraction, `TenantProvisioner`, because provisioning real ClickHouse services and test databases need different mechanics but the rest of the server should not care.

Deferred complexity:

- Production secret manager/KMS enforcement.
- Async provisioning jobs.
- Cloud service deletion and cleanup.
- Multi-process cache invalidation.
- Per-org API process deployment on Cloud Run.
- Full production managed Google auth.

## Failure Modes

- User Data ClickHouse unavailable: hosted signup, API-key creation, session auth, and server startup fail clearly.
- Tenant provisioning timeout: signup returns a failure and records a failed route.
- Route stuck provisioning: API-key creation is denied and dashboard shows no tenant data until route readiness.
- Tenant route missing after restart: API-key ingest and dashboard reads return `503`.
- Tenant ClickHouse unavailable: only that org's tenant routes fail.
- Cloud service created but schema migration fails: route is marked failed; operator cleanup may be required.
- Password stored incorrectly: tenant readiness fails; route remains failed.
- Large benchmark accidentally configured too high: command refuses without an explicit safety env var.

## Testing Plan

- Rust unit tests for:
  - hosted config parsing
  - control-plane record replay
  - tenant route selection
  - database provisioner URL/database construction
  - API-key persistence routed to User Data
  - missing/failed route errors
  - two-org isolation and cross-org denial
  - lazy tenant init where one failed tenant does not block another
  - dev auth disabled in hosted/API-key mode
- Rust integration/API smoke:
  - signup creates control records and tenant route
  - create API key writes a User Data API-key record
  - API key creates a project/run/metric in tenant data plane
  - session dashboard reads tenant summaries/series
  - restart after signup/key/ingest still authenticates and reads tenant data
- Python smoke:
  - use the created API key with `instantml.init`
  - log metrics
  - query runs with `ro.Api.runs(q=..., sort_by=...)`
- Frontend/Computer Use:
  - click sign up
  - create SDK key
  - confirm dashboard shows the Python-ingested run
  - confirm search by name/tag works
- Scale:
  - guarded benchmark tool for 100,000 run metadata and configurable metric rows
  - timing output for run summary, name/tag search, metric sort, and chart series
  - hosted demo seed requires explicit `INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1`, is idempotent for `hello@instantml.ai`, and refuses partial duplicate seeds unless the operator chooses a new project name

## Documentation Plan

- `apps/rust-server/README.md`
- `apps/rust-server/src/store/README.md`
- `apps/web/README.md` if visible signup copy changes.
- `packages/python-sdk/README.md` if a new hosted smoke script is added.
- Root `.env.example` with non-secret variable names.
- `tools/README.md` for the hosted demo seed/benchmark command and its cost-sensitive environment variables.

## Alternatives Considered

- Direct browser-to-ClickHouse writes: rejected because service credentials must never reach the frontend.
- SDK routing directly to tenant service: rejected because it would expose tenant endpoints/passwords and complicate API-key validation.
- One real ClickHouse Cloud service in every automated test: rejected because it is slow, externally visible, and potentially costly.
- Relational control plane: rejected because this branch is explicitly building on the ClickHouse-only storage direction.

## Review Notes

Fresh reviewer 1:

- Finding: database mode reused User Data credentials, tenant passwords were stored directly, startup eagerly loaded every tenant, provisioning was not idempotent, control replay needed deterministic versions, and raw org-id routing risked cross-tenant access.
- Risk: tenant isolation failure, secret exposure, runaway service creation/cost, startup fragility, and cross-org data leaks.
- Recommended edit: limit database mode to local/test or least-privilege users, block production cloud service without secret handling, lazy-load tenant stores, add a provisioning state machine, add event ids/versions, and resolve tenants only from checked auth context.
- Decision: accepted. The design now makes database mode local/test by default, gates stored passwords, adds lazy tenant init, defines a provisioning flow, adds event ids/scope/version, and requires resolved tenant context.

Fresh reviewer 2:

- Finding: hosted signup should not use the dev Google route, provisioning needed retry/resume semantics, global user/key records needed explicit scope, database mode needed isolation caveats, startup should be lazy, tests need two-org/restart/failure coverage, and scale benchmarks need thresholds.
- Risk: local-only auth leaking into hosted flow, duplicate/orphan tenant services, ambiguous replay, weak isolation, poor startup behavior, and untrustworthy benchmark claims.
- Recommended edit: split local vs hosted signup contracts, add signup/provisioning state machine, define global sentinel scope, local/test database mode caveat or least-privilege grants, lazy tenant loading, explicit isolation/restart/failure tests, and benchmark budgets/output.
- Decision: accepted. This doc now separates dev and hosted auth contracts, defines the state machine and global scope, gates database/cloud modes, adds lazy loading and testing/benchmark requirements.

## Coverage Exceptions

- Uncovered area: full 100,000 x 20,000-step hosted cloud benchmark in every test run.
- Reason: this is a multi-billion-row external-cost workload and cannot be a default CI check.
- Risk: dashboard performance at maximum requested scale may differ from smaller automated smokes.
- Follow-up: run the guarded hosted benchmark before production launch and store timing output in the PR/design notes.
- Owner/date: Codex, 2026-05-14.

## Decision

Accepted for a narrow first implementation:

- User Data control-plane table and replay.
- Local/test database provisioner using isolated per-org databases and a server-side config password reference.
- Tenant routing for signup, API-key creation, Python SDK ingest, and dashboard readback.
- Cloud-service provisioner scaffolding may be present only behind explicit opt-in and tests/mocks; real service creation is not enabled by default in this PR.
- Guarded scale benchmark tooling and measured smaller E2E run.

## Implementation Notes

Implemented in this branch:

- `src/control_store.rs` creates and replays `instantml_user_data`.
- `src/store/tenants.rs` owns `TenantRouteRecord`, database provisioning, cloud-service opt-in provisioning, lazy tenant loading, and per-org `MetricStore` resolution.
- `POST /api/auth/dev/google` returns safe provisioning status in the session payload.
- Tenant-local numeric IDs for attributes, table rows, and imports are keyed internally by org to avoid cross-tenant collisions when multiple tenant databases are replayed into the single-process index.
- Tenant replay rejects operational rows whose row org or payload org does not match the tenant route org.
- Local/dev signup now resolves retry candidates by owner/name/account type and writes owner membership before provisioning, so database-mode failed/provisioning routes can be retried instead of creating duplicate orgs.
- Cloud-service schema migration failures preserve the created service id in the failed route so operators have a cleanup handle.
- Cloud-service route retries first attempt to resume stored service credentials and check for an existing deterministic ClickHouse Cloud service name before POSTing a new service, preventing accidental duplicate paid services after a timeout or crash. The deterministic name includes the org-id prefix so normalized/truncated org-name collisions cannot route two orgs to the same service during recovery.
- Cloud-service server startup skips the primary/default metric-store schema migration so the User Data service keeps only control-plane tables; per-org metric schema is migrated after routing to the tenant service.
- Local/dev demo auth canonicalizes `hello@instantml.ai` and `hello@instantml.com` to one `InstantML Demo` business org, preventing repeated demo sign-ins from creating multiple orgs or ClickHouse services.
- Cloud-service provisioning can discover the ClickHouse Cloud organization id from the API when `INSTANTML_CLICKHOUSE_CLOUD_ORG_ID` is not set.
- `npm run test:hosted-clickhouse` verifies signup, User Data control rows, API-key creation, API-key scope enforcement, direct API-key ingest, Python SDK ingest, safe non-secret provisioning payloads, dashboard readback, and API restart replay.
- `npm run benchmark:large-runs` now defaults to 100,000 run records and a 20,000-step long-run series across multiple metric keys.
- `INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 npm run benchmark:hosted-demo` provisions/reuses the shared demo cloud-service route, seeds the hosted 100,000-run benchmark once, and prints hosted ClickHouse latency measurements.
