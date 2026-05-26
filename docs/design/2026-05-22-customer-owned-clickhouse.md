# Design: Customer-Owned ClickHouse Data Planes

Date: 2026-05-22

Status: Implemented first slice; reviewed; updated for GCP self-hosted BYOC

Owner: Codex

## Summary

InstantML should support a customer-owned ClickHouse data plane for teams that
do not want InstantML to host the warehouse that stores their runs, metrics,
attributes, console logs, and operational tenant records. InstantML would still
host the control plane for identity, organizations, sessions, API keys, billing,
and tenant-route metadata, but the org's product data would be routed to a
ClickHouse endpoint supplied by the customer.

The smallest useful version is a direct connection to a customer-provisioned
self-hosted ClickHouse deployment on Google Cloud. An owner/admin supplies a
public HTTPS ClickHouse HTTP endpoint, database, username, and password for an
InstantML-scoped database. The server validates connectivity, checks migration
privileges, runs the existing ClickHouse schema migration, and records a
`tenant_route` with the `customer-clickhouse` provisioner.

Reviewer feedback found that the first implementation should be narrower than
the original draft. The accepted candidate slice is Premium/Enterprise-gated,
empty-org only, public HTTPS ClickHouse HTTP endpoints only, pre-created
databases only, Secret Manager only, and validation/smoke from the actual
Rust data-plane egress path. Automatic database creation, private networking,
self-hosted private-network edge cases, customer-owned object storage, and any
ClickHouse Cloud API automation remain outside the customer-facing first slice.

Onboarding should make the storage choice explicit: InstantML can provision a
hosted ClickHouse warehouse for the customer, or the customer can bring their
own ClickHouse. When a user chooses BYOC, the product should show a recommended
ClickHouse provisioning flow and recommended settings before asking for
credentials.

The previous draft considered ClickHouse Cloud service automation. That is no
longer the recommended BYOC path after InstantML moved its hosted beta from
ClickHouse Cloud to self-hosted GCP ClickHouse. Customers should provision and
operate their own GCP ClickHouse endpoint, firewall it to InstantML egress
CIDRs, and create a narrow database user themselves. Hosted validation and
route creation must fail closed when InstantML does not have a non-empty,
versioned, environment-specific BYOC egress CIDR set.

External research sources, verified on 2026-05-25:

- ClickHouse installation options: https://clickhouse.com/docs/install
- ClickHouse HTTP interface: https://clickhouse.com/docs/interfaces/http
- ClickHouse TLS configuration: https://clickhouse.com/docs/guides/sre/tls/configuring-tls
- ClickHouse SQL `CREATE USER`: https://clickhouse.com/docs/sql-reference/statements/create/user
- ClickHouse SQL `GRANT`: https://clickhouse.com/docs/sql-reference/statements/grant
- ClickHouse access control: https://clickhouse.com/docs/operations/access-rights
- Google Cloud VPC firewall rules: https://cloud.google.com/firewall/docs/using-firewalls

## Goals

- Let an org owner choose customer-owned ClickHouse instead of InstantML-hosted
  ClickHouse before the org writes product data.
- Keep all SDK, frontend, and product API routes unchanged after tenant routing
  is ready.
- Use the existing Rust `MetricStore`, ClickHouse migration, and `tenant_route`
  model instead of creating a separate storage subsystem.
- Require only database-level read/write/migration credentials in the first
  slice.
- Make the access and security model explicit enough for customers to create a
  least-privilege ClickHouse user.
- Make the required InstantML Rust API/data-plane egress IP addresses visible
  before validation so the customer can add them to the GCP firewall,
  load-balancer allowlist, or reverse-proxy allowlist first.
- For BYOC org storage accounting, count only artifact bytes InstantML stores
  for that org in Cloudflare R2. Do not count or bill customer-owned ClickHouse
  warehouse bytes.
- Block product writes and SDK key reveal until a new org has selected and
  completed its storage setup.
- Validate BYOC reachability from the same Rust data-plane route that will serve
  SDK/UI product traffic.
- Keep hosted control-plane records in InstantML User Data so login, org
  membership, API keys, billing, and route status stay available even if the
  customer's warehouse is down.

## Non-Goals

- No one-click ClickHouse OAuth flow. Self-hosted ClickHouse setup uses direct
  database credentials, not delegated OAuth.
- No customer-owned artifact object storage in this slice. Artifacts still use
  the current InstantML artifact backend unless a separate BYO object storage
  design is accepted.
- No automatic migration of an org that already has hosted InstantML product
  data. Existing org migration needs an export/import or copy design.
- No ClickHouse Cloud service or BYOC infrastructure provisioning in the first
  slice.
- No private networking in the first slice: no PrivateLink, Private Service
  Connect, VPN, customer private DNS, or private BYOC service endpoints.
- No direct SDK-to-customer-ClickHouse writes. SDK traffic continues to hit
  InstantML's API so auth, idempotency, summaries, and route policy remain
  consistent.
- No customer-owned ClickHouse storage billing, byte metering, or warehouse size
  estimation. The customer's ClickHouse cost is between the customer and their
  GCP infrastructure/provider choices.
- No Free or self-serve Pro BYOC in the first slice. Customer-owned ClickHouse
  is Premium/Enterprise or explicit operator entitlement until support and
  security burden is measured.
- No persisted admin/migrator credential in the first slice.

## Users and Use Cases

Security-conscious ML startup choosing GCP self-hosted BYOC:

1. Creates an InstantML org.
2. Chooses between `InstantML provisions ClickHouse` and `Use my ClickHouse`.
3. Selects `Use my ClickHouse` before creating runs.
4. Follows InstantML's recommended GCP self-hosted ClickHouse provisioning
   instructions.
5. Adds the displayed InstantML Rust API/data-plane egress CIDRs to the
   GCP firewall, load balancer allowlist, or reverse-proxy allowlist protecting
   ClickHouse.
6. Creates a database and service user in its own GCP ClickHouse deployment.
7. Enters the endpoint and credentials in InstantML.
8. InstantML validates and migrates the database, then routes SDK/UI product
   traffic to that customer-owned ClickHouse deployment.

Small team choosing hosted provisioning:

1. Creates an InstantML org.
2. Chooses `InstantML provisions ClickHouse`.
3. InstantML uses the existing hosted ClickHouse tenant-route provisioning path
   and manages warehouse sizing, allowlists, and route credentials for that org.

Operator:

1. Keeps InstantML control-plane data and billing in the hosted User Data table.
2. Can see route status, provider type, endpoint host, database name, and last
   validation result without seeing plaintext credentials.
3. Can tell whether a failure is auth, network allowlist, migration privilege,
   schema drift, or warehouse availability.

## Research Findings

ClickHouse has one API surface that matters for the GCP self-hosted BYOC first
slice:

- Database HTTP/HTTPS interface. ClickHouse supports querying over HTTP/HTTPS
  using GET for readonly queries and POST for mutating queries. The current Rust
  server already uses HTTP URLs of the form
  `http://user:pass@host:port/database`, with `https` defaulting to port `8443`.
  This is enough to read and write InstantML's ClickHouse schema when the user
  provides database credentials.

The recommended deployment is a customer-owned GCP VM, managed instance group,
GKE StatefulSet, or equivalent that runs open-source ClickHouse and exposes the
ClickHouse HTTP interface over HTTPS. The production endpoint must be reachable
from InstantML's Cloud Run static egress CIDRs and must not be open to
`0.0.0.0/0`. A GCP firewall rule, HTTPS load balancer, or reverse proxy can
enforce the allowlist. ClickHouse itself must still authenticate a dedicated
database user.

ClickHouse Cloud is not part of the recommended customer-facing BYOC path.
InstantML should not ask for ClickHouse Cloud API keys, should not create paid
ClickHouse Cloud services as part of onboarding, and should keep any
provider-backed `cloud-service` compatibility behind explicit operator-only
configuration.

## Proposed Design

### First Slice

Add a customer-owned tenant-route provisioner:

- `provisioner`: `customer-clickhouse`
- `warehouse_kind`: `customer-owned`
- `status`: `validating`, `ready`, `migration_required`, `failed`, or
  `disabled`
- `endpoint`: sanitized endpoint origin, never including password
- `database`: customer-selected database
- `username`: customer-selected service user
- `password_secret_ref`: Secret Manager version reference
- `password_ciphertext`: not allowed for hosted customer-owned routes
- `service_id`: always null for the recommended GCP self-hosted BYOC path

Keep this route in the existing control-plane `tenant_route` record family.
Tenant-owned product data continues to live in the routed ClickHouse database.
The data service resolves the route, builds a `MetricStore`, runs the existing
idempotent schema migration, and then serves product routes exactly as it does
for hosted routes.

The candidate first implementation must be narrower:

- Premium/Enterprise orgs or explicit operator-entitled orgs only.
- Empty orgs only.
- Public HTTPS ClickHouse endpoints only.
- Customer pre-creates the database.
- Hosted BYOC secrets live only in Secret Manager.
- Hosted BYOC validation/create fails when `INSTANTML_BYOC_EGRESS_CIDRS` is
  empty, dynamic, or missing an environment-specific
  `INSTANTML_BYOC_EGRESS_SET_VERSION`.
- Route creation requires a successful data-plane validation and post-create
  smoke from the same egress path.
- No stored admin credential.
- No self-hosted private-network edge cases beyond public HTTPS endpoints.
- No rotation UI; rotation can be a later Settings feature after the initial
  path is stable.

### Connection Flow

The frontend should expose the flow only to owner/admin users:

1. New org enters a `storage_unconfigured` state before SDK keys are revealed
   and before product routes accept writes.
2. Select data storage: `InstantML provisions ClickHouse` or
   `Use my ClickHouse`.
3. If hosted provisioning is selected, use the current hosted tenant-route
   path: shared cell for eligible personal/free orgs, otherwise the existing
   database provisioner on InstantML-owned self-hosted GCP ClickHouse. The
   legacy `cloud-service` provisioner must not be part of self-serve signup.
4. If BYOC is selected, require the org to be Premium/Enterprise or explicitly
   entitled, then show a clear data-location panel: runs, metrics, logs,
   attributes, and tenant operational metadata go to customer ClickHouse; raw
   artifact bytes still go to InstantML R2 until a separate BYO object-storage
   design exists.
5. Show recommended GCP ClickHouse provisioning instructions:
   create or choose a read-write self-hosted ClickHouse deployment on GCP,
   create a dedicated database, create a narrow `instantml_writer` user, expose
   the ClickHouse HTTP interface over HTTPS, and add InstantML egress CIDRs to
   the GCP firewall or load-balancer allowlist.
6. Show recommended settings for GCP self-hosted ClickHouse:
   - Region: choose a GCP region near the InstantML data-plane region that will
     write to ClickHouse; if training jobs are far away, remember the path is
     SDK -> InstantML API -> ClickHouse.
   - Deployment: use a dedicated VM, managed instance group, GKE StatefulSet, or
     equivalent with persistent disk, backups/snapshots, monitoring, and disk
     alerts owned by the customer.
   - Network access: expose only the HTTPS ClickHouse HTTP endpoint, and add
     every displayed InstantML Rust API/data-plane egress CIDR to the GCP
     firewall, load balancer, or reverse-proxy allowlist. Include production
     and staging only when the customer plans to use both environments.
   - Database: one dedicated database per InstantML org.
   - User: one dedicated user per InstantML org, scoped to that database.
   - TLS: require HTTPS from hosted InstantML to ClickHouse. Self-signed
     certificates are for local tests only; production must use a certificate
     trusted by the Rust service.
   - Endpoint: public HTTPS ClickHouse HTTP endpoint origin for the first
     slice, for example `https://clickhouse.customer.example.com:8443`.
   - Backups/retention: customer-owned and configured in GCP/ClickHouse, not by
     InstantML.
7. Fetch current setup status before validation and show
   `required_egress_cidrs` plus `egress_set_version`; validation/save remains
   disabled until these are configured.
8. Ask for endpoint, database, username, and password.
9. Validate and save in one flow, or issue a short-lived server-side validation
   token that binds the exact endpoint/database/username tuple and expires
   quickly. Do not let the create request change values after validation.
10. After validation, store the secret reference, write the ready tenant route,
   and block changing storage mode once product data exists.

For the first slice, support only empty orgs or orgs with no projects/runs.
Changing a route for an org with existing data must return a clear error and
point to future migration/export work.

### Storage State Machine

BYOC needs explicit control-plane state so users cannot accidentally write data
to an InstantML-hosted warehouse before choosing customer-owned storage:

| State | Meaning | Allowed writes |
| --- | --- | --- |
| `storage_unconfigured` | New org has no ready tenant route. | Control-plane setup only; no SDK key reveal; no project/run/import/artifact writes. |
| `storage_validating` | Owner/admin is validating BYOC. | Control-plane setup only; product writes blocked. |
| `storage_ready` | Hosted or BYOC route is ready. | Normal writes allowed under plan/payment limits. |
| `storage_migration_required` | Customer-owned route is reachable but behind the current InstantML schema and the runtime credential no longer has DDL. | Reads may remain available when compatible; writes and SDK-key reveal are blocked until owner/admin revalidates with temporary migration privileges. |
| `storage_locked` | Product data exists. | Route switching blocked; credential rotation may be allowed in a later slice. |

The commit from `storage_validating` to `storage_ready` must re-check that the
org is empty, write the route with compare-and-swap semantics, invalidate any
tenant metric-store cache for that org, and run the post-create smoke from the
data-plane service before SDK keys or onboarding API keys are returned.

### Validation Steps

The backend validation endpoint should perform these checks in order:

1. Require BYOC setup configuration to be production-shaped in hosted mode:
   non-empty static egress CIDRs, an environment/version label for that egress
   set, and a non-local credential store. `GET
   /api/storage/clickhouse-connections/current` must expose the egress values
   before validation so customers can allowlist first.
2. Parse and normalize the endpoint. Hosted UI flow requires `https`; local
   development may allow `http`.
3. Accept only normalized `https://host:port` endpoint origins. Reject userinfo,
   path, query, fragments, redirects, non-HTTPS schemes, and implicit mutation
   of endpoint values between validate and create.
4. Resolve DNS and reject loopback, link-local, private, multicast, reserved,
   metadata-service, and other non-public A/AAAA/CNAME targets at validation,
   create, and route-load time unless an operator-only allowlist permits them.
   Runtime clients must re-resolve before opening a new connection, disable
   redirects, and keep the actual HTTP request bound to the vetted hostname/IP
   set. Hosted infrastructure must also deny metadata/private egress; URL
   validation alone is not sufficient.
5. Enforce TLS with default trusted roots, hostname verification, and SNI for
   the submitted host. Hosted mode must not allow insecure verifiers or custom
   local CAs; TLS failures should produce stable diagnostics such as
   `tls_handshake_failed`, `tls_hostname_mismatch`, or
   `tls_certificate_expired`.
6. Connect from the same static egress path that the Rust data-plane service
   will use for product reads/writes, or require the customer allowlist to cover
   both validation and data-plane egress CIDRs. The existing hosted split deploy
   uses the same Cloud NAT egress for control and data services; if that changes,
   BYOC validation must list both.
7. Run `SELECT 1`, `SELECT version()`, and `SELECT currentUser()`.
8. Confirm the named database already exists. First-slice BYOC migration must
   skip the current `ensure_database` behavior so a database-scoped user does
   not need server-wide `CREATE DATABASE`. Database names must pass strict
   identifier validation before any query is built.
9. Run schema migration in BYOC mode during validation/save and record the
   applied schema version on the route. Normal route loads skip migration while
   the route is current so the retained runtime user does not need DDL forever.
10. Insert and read a short-lived validation record in `operational_records` or
   use a dedicated validation table if a later review rejects writing to product
   tables during validation.
11. Run a post-create smoke from the data-plane service using the ready route:
   connect, migrate/verify schema, insert, and read.
12. Delete/expire any validation marker through normal operational-record
   semantics if needed. Do not require `DROP` for the service user.

### Customer SQL Setup

Recommended customer-owned setup:

```sql
CREATE DATABASE IF NOT EXISTS instantml_<org_slug_or_uuid>;

CREATE USER IF NOT EXISTS instantml_writer
IDENTIFIED WITH sha256_password BY '<generated-password>'
HOST IP '<instantml-egress-cidr-1>';

GRANT SHOW, SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER TABLE
ON instantml_<org_slug_or_uuid>.*
TO instantml_writer;
```

When there are multiple InstantML egress CIDRs, the UI should render every
value so the customer can copy them into GCP firewall source ranges, load
balancer security policy rules, or reverse-proxy allowlists. SQL `HOST IP`
restrictions are optional defense-in-depth for self-hosted ClickHouse and
should not be presented as the only allowlist step.

If the customer wants InstantML to create the database, the admin credential
used during validation also needs `CREATE DATABASE` on the server. This is not
part of the first slice. Prefer the pre-created database path so the stored
service credential is scoped to one database.

The allowlist value must be the egress IP or CIDR of the Rust API/data-plane
service, not the user's browser IP. The UI should render the exact current
values from server config, for example the production Cloud Run static egress
CIDR, and avoid hardcoding them in frontend code. Route records should include
an `egress_set_version` so operators know which allowlist values were used at
validation time.

The grant list above is for the current `0001_initial.sql` schema, which creates
tables and a materialized view. Future schema changes may need additional DDL;
if the customer has revoked DDL, InstantML should mark the route
`migration_required` and ask the owner/admin to temporarily re-grant migration
privileges and revalidate.

Storage-byte reporting must not read `system.parts` for customer-owned
ClickHouse. For BYOC orgs, usage and billing should count only artifact bytes
stored by InstantML in Cloudflare R2. The customer's ClickHouse warehouse bytes
should be displayed, if at all, as customer-managed and not included in
InstantML tracked-storage limits or invoices.

### Deferred Automation

Do not add ClickHouse Cloud account automation to BYOC onboarding. A future
automation slice, if accepted, should target customer-owned GCP infrastructure
that the customer explicitly authorizes, such as Terraform snippets, a
customer-run setup script, or operator-reviewed private connectivity. Any flow
that creates external paid resources remains Premium/Enterprise-only and must
require an explicit confirmation before resource creation.

### Secrets

Hosted BYOC must use Secret Manager, not User Data payloads or application-level
encrypted blobs in the first production slice:

- Secret path shape: `gcp-secret-manager:projects/<project>/secrets/<prefix>-<cell_id>-<org_id>/versions/<version>`.
- Control plane can create, read, rotate, and destroy secret versions used by
  customer-owned routes. Route disable should schedule destruction of the
  retained current version when self-serve disable is added.
- Data plane can read only the current version for orgs routed to that cell.
  Production IAM should use separate control/data service accounts and the
  narrowest Secret Manager permissions practical for the BYOC prefix or
  per-secret bindings. A broad project-wide `secretAccessor` grant is acceptable
  only for internal smoke rollout and must be tracked as an operational
  hardening follow-up before public BYOC.
- User Data stores only a versioned `password_secret_ref`.
- Request logs, error logs, audit records, and User Data payloads must never
  contain plaintext passwords, full connection URLs with userinfo, or raw
  request bodies.
- Route create, validation, future rotation, disable, and failed secret read
  write audit events with stable reason codes.
- Disabling a BYOC route must either destroy or schedule destruction of the
  retained secret version, subject to operator recovery policy.

### Runtime Credentials

Initial validation/save needs DDL because it applies the InstantML schema inside
the pre-created customer database. The saved route records the applied schema
version; normal route loads skip schema migration when the route is at the
current version, so customers can revoke DDL after setup and re-grant it only
for future InstantML migrations.

When InstantML deploys schema version `N+1` and a BYOC route is still at `N`,
route load must not silently keep accepting writes against an old schema if the
runtime credential cannot migrate. The route should enter
`migration_required`, preserve control-plane login/settings access, and block
new product writes until an owner/admin temporarily re-grants migration
privileges and reruns validation/save. A later design may split this into a
short-lived migrator credential plus a permanently low-privilege runtime
credential, but the first slice keeps one credential and makes the regrant
workflow explicit.

### Usage Accounting

BYOC storage accounting must not depend on the customer ClickHouse warehouse:

- Count only objects actually stored in InstantML R2.
- Do not count declared artifact sizes for metadata-only or externally stored
  artifacts.
- Keep a control-plane R2 byte ledger or daily rollup for BYOC orgs so usage
  summaries remain available when customer ClickHouse is down.
- Do not query customer ClickHouse `system.parts` for billing, limits, or
  storage warnings.

## Component Impact

Backend:

- Add `customer-clickhouse` tenant-route creation/validation in
  `apps/rust-server`.
- Add a control-plane route for validation and route creation.
- Store credentials through Secret Manager for hosted customer-owned routes
  before accepting this for production.
- Reuse `MetricStore`, `parse_clickhouse_url`, and `metric_store::migrate`.
- Add BYOC migration mode that skips `CREATE DATABASE` for pre-created
  databases.
- Add SSRF protections around user-supplied endpoints.
- Add storage setup state and product-write gates before SDK key reveal.
- Add data-plane validation/smoke routing.

Frontend:

- Add an owner/admin storage setup panel in onboarding or Settings.
- Make onboarding choose between `InstantML provisions ClickHouse` and
  `Use my ClickHouse`.
- Display recommended BYOC provisioning settings, setup SQL, required Rust
  server egress CIDRs, validation status, and immutable route warnings.
- Hide or disable route switching after product data exists.

Python SDK:

- No public SDK change. SDK traffic continues to use InstantML API keys and the
  existing API base URL.

Storage:

- Add route metadata fields only if the current `TenantRouteRecord` fields are
  insufficient. Prefer using existing optional fields first.
- No ClickHouse tenant schema change for product data.
- Hosted control plane remains in InstantML User Data.
- BYOC usage storage accounting uses R2 artifact bytes only. It does not query
  or count customer-owned ClickHouse table bytes.
- BYOC R2 storage accounting should have a control-plane ledger or daily rollup
  so customer warehouse outages do not hide InstantML-stored artifact bytes.

Docs:

- Update `apps/rust-server/README.md`, `apps/web/README.md`, and architecture
  docs when implementation starts.
- Add customer setup docs with exact privileges, network allowlist guidance, and
  failure recovery.

## Data Model

Control-plane route payload additions or conventions:

- `provisioner = "customer-clickhouse"`
- `warehouse_kind = "customer-owned"`
- `status = "validating" | "ready" | "migration_required" | "failed" | "disabled"`
- `endpoint_host`: optional sanitized host for display, if the full endpoint
  becomes too sensitive to expose.
- `secret_version`: optional secret version reference for rotation.
- `last_validated_at`: optional timestamp.
- `validation_error_code`: optional stable code such as
  `network_unreachable`, `auth_failed`, `migration_denied`, `schema_failed`, or
  `not_read_write_service`.
- `egress_set_version`: version of the InstantML egress CIDR set shown and used
  during validation.
- `storage_state`: org-level state such as `storage_unconfigured`,
  `storage_validating`, `storage_ready`, `storage_migration_required`, or
  `storage_locked`.

Tenant ClickHouse schema remains the current `0001_initial.sql` schema:

- `operational_records`
- `metric_points`
- `console_log_lines`
- `metric_series`
- `metric_series_mv`

## API Contracts

Draft control-plane endpoints:

`GET /api/storage/clickhouse-connections/current`

Returns current route status and safe metadata for onboarding/Settings. This is
also the pre-validation egress contract: the UI uses
`required_egress_cidrs` and `egress_set_version` from this response before the
customer submits credentials. Hosted BYOC validation and creation are disabled
when the CIDR list is empty or unversioned.

`POST /api/storage/clickhouse-connections/validate`

Request:

```json
{
  "endpoint": "https://clickhouse.customer.example.com:8443",
  "database": "instantml_acme",
  "username": "instantml_writer",
  "password": "copy-once-secret",
  "allow_create_database": false,
  "storage_choice": "customer-clickhouse"
}
```

Response:

```json
{
  "status": "valid",
  "server_version": "25.x",
  "current_user": "instantml_writer",
  "database": "instantml_acme",
  "required_egress_cidrs": ["136.115.243.188/32"],
  "egress_description": "InstantML Rust API/data-plane outbound IPs",
  "egress_set_version": "prod-us-central1-2026-05-22",
  "can_create_database": false,
  "can_migrate_schema": true,
  "can_insert_validation_record": true
}
```

`POST /api/storage/clickhouse-connections`

Creates the route after validation and stores the credential secret. Returns
the safe tenant-route payload with no password.

`POST /api/storage/clickhouse-connections/rotate-credentials`

Implemented for operator/local smoke coverage and future Settings UX, but not
part of the self-serve first-slice onboarding surface. Customer-facing rotation
copy should stay deferred until the revalidation and migration-required UX are
complete.

All endpoints require owner/admin browser session. Hosted API keys must not be
able to create or rotate warehouse connections.

Error behavior:

- `400 invalid_clickhouse_connection` for malformed endpoint or unsupported
  scheme.
- `400 unsafe_clickhouse_host` for SSRF-blocked hosts.
- `401 clickhouse_auth_failed` for invalid ClickHouse credentials.
- `403 clickhouse_migration_denied` for missing migration privileges.
- `409 tenant_route_locked` when the org already has product data.
- `409 storage_setup_required` when product writes or SDK-key reveal are
  attempted before the org has a ready storage route.
- `409 storage_setup_in_progress` when product writes are attempted during
  validation.
- `409 storage_migration_required` when BYOC route schema is behind the current
  server version and the customer must temporarily re-grant migration
  privileges.
- `503 byoc_egress_unconfigured` when hosted BYOC egress CIDRs are missing or
  unversioned.
- `503 warehouse_unavailable` for transient connection and startup failures.

Customer-facing statuses should distinguish `allowlist_missing`,
`auth_failed`, `migration_denied`, `schema_drift`, and `transient_unavailable`
instead of showing all failures as warehouse startup.

## Performance Considerations

- Connection validation is low-frequency admin traffic.
- Tenant product traffic stays on the existing data-plane route path.
- Metric ingestion write frequency is unchanged.
- Validation must use short deadlines, bounded retries, and no unbounded
  schema/table scans.
- Normal run lists remain summary-only and paginated.
- Metric series remain fetched through existing bounded endpoints.
- The first implementation should measure validation latency and normal metric
  insert latency against local disposable ClickHouse and at least one GCP
  self-hosted HTTPS endpoint.
- BYOC storage usage queries must stay on the artifact metadata/R2 accounting
  path. Do not add customer ClickHouse `system.parts` or table-byte scans to
  usage summaries.

## Simplicity Review

The direct-connection first slice is the simplest useful version because it
requires only the database access InstantML already knows how to use. It avoids
new vendor account permissions, paid service creation, Cloud API key custody,
and ClickHouse BYOC infrastructure setup.

Deferred complexity:

- Automatic ClickHouse service creation in customer GCP.
- ClickHouse Cloud service or BYOC infrastructure creation.
- Warehouse read/write service selection UI.
- Customer-owned artifact storage.
- Existing org data migration.
- Customer-facing credential rotation UI.
- Direct SDK-to-cell routing.
- Private connectivity: PrivateLink, Private Service Connect, VPN, or customer
  private DNS.
- Automated database/user creation.
- Broad self-hosted ClickHouse support beyond the documented GCP public HTTPS
  endpoint testing path.
- Multi-instance data-plane write gates beyond the current single-writer
  documented limits.

## Failure Modes

- Customer revokes the password: data-plane product routes return
  `warehouse_unavailable` or auth-specific diagnostics; control-plane login and
  Settings remain available.
- Customer removes InstantML egress from IP allowlist: validation and product
  routes fail with network/access diagnostics.
- InstantML rotates or changes Rust server egress IPs: BYOC orgs must be shown
  a required allowlist update before traffic moves, or both old and new CIDRs
  must be listed during a migration window.
- Hosted service has no static/versioned egress set: BYOC validation/create is
  disabled and the UI shows setup unavailable instead of letting customers paste
  credentials that cannot validate.
- Customer TLS certificate expires or does not match the submitted hostname:
  validation and route load fail with TLS-specific diagnostics, not generic
  warehouse startup copy.
- Customer DNS changes from a public address to a private/reserved address:
  route load and new connections fail closed before product writes.
- Validation comes from control egress but writes come from data egress:
  creation must fail until data-plane smoke passes from the actual product
  route.
- Customer points to a read-only service: migration or insert validation fails
  before route creation.
- Customer rotates credentials: future owner/admin rotation updates the Secret
  Manager version and must pass validation before the route changes.
- InstantML ships a schema migration after DDL was revoked: the route enters
  `migration_required`; writes stay blocked until the customer re-grants DDL and
  reruns validation/save.
- Customer drops tables: readiness or route load fails; repair path is rerun
  migration if privileges allow it.
- Existing hosted data exists: route creation is blocked until a migration
  design exists.
- Customer ClickHouse is slow or idle: frontend should reuse existing
  warehouse-starting retry copy and avoid showing a global control-plane outage.
- Secret read failure: data-plane routes return a stable customer-owned
  connection error; control plane remains available for owner/admin repair.
- BYOC outage during usage summary: usage returns R2 artifact ledger values and
  marks customer warehouse status separately instead of blocking billing/admin
  views.

## Observability And Runbooks

Implementation should add BYOC-specific observability before rollout:

- Structured events for validation start/success/failure, route create,
  post-create data-plane smoke, secret read failure, future credential rotation,
  route disable, schema migration-required, and egress-set mismatch.
- Stable failure labels: `allowlist_missing`, `dns_blocked`,
  `unsafe_endpoint`, `auth_failed`, `migration_denied`, `schema_drift`,
  `secret_unavailable`, `warehouse_unavailable`, and `data_plane_smoke_failed`.
- Metrics/counters for validation failures and data-plane BYOC failures by
  stable code, org plan tier, and service plane.
- `/readyz` should expose aggregate BYOC degradation only when customer-owned
  failures indicate InstantML infrastructure problems, not when one customer's
  warehouse is misconfigured.
- Runbooks for egress CIDR rotation, customer credential rotation, schema drift,
  customer warehouse outage, and Secret Manager/IAM failure.

## Testing Plan

Design-only work does not need tests. Implementation should add:

- Unit tests for endpoint normalization and SSRF rejection.
- Unit tests for route locking when product data exists.
- Unit tests for database identifier validation and BYOC migration skipping
  `CREATE DATABASE`.
- Unit tests for storage state write gates.
- API tests for validate/create/current connection endpoints.
- API tests for auth rules: owner/admin only; hosted API keys denied.
- API tests that product writes and SDK key reveal fail until storage is ready.
- ClickHouse integration tests against disposable local ClickHouse for
  successful validate/migrate/insert/read.
- Negative integration tests for missing `CREATE TABLE`, missing `INSERT`,
  wrong password, unreachable host, and read-only route if testable.
- Frontend tests for empty org setup, validation failure, validation success,
  and locked existing org state.
- Frontend tests for the onboarding storage choice and recommended BYOC
  settings panel.
- Contract/smoke tests proving SDK -> API -> customer route -> ClickHouse still
  creates runs and metrics with existing SDK calls.
- Usage tests proving BYOC storage totals count R2 artifact bytes only and do
  not call customer ClickHouse table-byte accounting.
- Secret handling tests proving User Data route payloads never contain
  plaintext credentials.
- Data-plane smoke tests proving validation from control alone is insufficient
  unless the actual data-plane route also connects, inserts, and reads.
- Source-level tests or runtime tests proving the customer-facing setup grants
  match `clickhouse/0001_initial.sql`, including table creation, materialized
  view creation, validation insert/read, and no `CREATE DATABASE` requirement.

Implemented first-slice tests in this branch cover storage-choice validation,
storage-ready write gates, BYOC database identifier validation, and BYOC
storage warning accounting. Full ClickHouse BYOC integration and browser
onboarding smokes are expected to run against a real or disposable ClickHouse
service before rollout.

## Documentation Plan

Implementation must update:

- `apps/rust-server/README.md`: config, route ownership, credential storage,
  egress CIDRs, and customer-owned provisioner behavior.
- `apps/web/README.md`: onboarding/Settings storage setup flow.
- `docs/architecture/current-system.md`: customer-owned data-plane topology.
- `docs/architecture/current-schemas.md`: tenant-route payload conventions.
- `docs/architecture/current-api.md`: new control-plane endpoints.
- Customer setup doc under `docs/users/` or `docs/product/` with exact SQL and
  GCP firewall/load-balancer allowlist steps.
- Operator runbooks for egress rotation, BYOC validation failures, credential
  rotation, and BYOC customer warehouse outages.

## Alternatives Considered

ClickHouse Cloud API first:

- Pros: can create services, update IP allowlists, and potentially create a
  service in a BYOC infrastructure using `byocId`.
- Cons: requires broad Cloud API credentials, can create paid resources, and is
  no longer matches InstantML's current self-hosted GCP ClickHouse operating
  model.
- Decision: reject for the recommended BYOC flow; keep only as legacy research.

Ask for ClickHouse admin database credentials:

- Pros: easiest setup and lets InstantML create database/user.
- Cons: too much privilege to store and harder to justify for security-minded
  customers.
- Decision: reject for first slice except maybe as an operator-only local test.

Require one permanently DDL-capable runtime credential:

- Pros: simplest code path because route load could keep running migration.
- Cons: stores more privilege than normal reads/writes need.
- Decision: rejected after review. The implemented route records schema version
  and skips route-load migration once the initial save succeeds.

Self-host the entire InstantML API in the customer's cloud:

- Pros: strongest data control story.
- Cons: different product, support, deployment, auth, billing, and upgrade
  model.
- Decision: separate self-host/VPC design.

Use ClickHouse service query endpoints:

- Pros: Cloud API exposes endpoint management for executing queries via API.
- Cons: current Rust data path already uses the database HTTP interface, and
  service query endpoints add a Cloud-specific integration layer that does not
  help self-hosted ClickHouse.
- Decision: defer.

Separate migrator and runtime credentials:

- Pros: avoids storing DDL-capable credentials after setup.
- Cons: adds UI, secret storage, route schema, and support complexity before we
  know how often BYOC customers revoke DDL.
- Decision: defer. First slice uses one credential, records schema version, and
  blocks with `migration_required` when DDL is needed again.

## Review Notes

Fresh reviewer 1:

- Finding: Migration and credential privilege were too broad. Current
  `metric_store::migrate` calls `CREATE DATABASE IF NOT EXISTS`, which conflicts
  with a pre-created database and database-scoped user. Stored runtime
  credentials should not retain DDL forever. SSRF defenses and Secret Manager
  behavior also needed production-level specifics.
- Risk: Customers could follow the setup SQL and fail validation, or InstantML
  could retain excessive ClickHouse privileges and turn persistent routes into
  outbound SSRF targets.
- Recommended edit: Skip database creation in BYOC migration, validate database
  identifiers, require Secret Manager, normalize and re-resolve endpoints at
  route load, bind create to validation, and move toward separate one-time
  migrator and runtime credentials.
- Decision: Incorporated as blockers before implementation acceptance.

Fresh reviewer 2:

- Finding: Onboarding lock timing, entitlement, and customer-facing data
  ownership copy were underspecified. BYOC could be misunderstood as covering
  artifact bytes, and Free/Pro access would create support/pricing confusion.
- Risk: Users could accidentally create hosted data before choosing BYOC, or
  believe all product data is customer-owned while artifacts remain in R2.
- Recommended edit: Make storage setup a required step before SDK key reveal or
  product writes, gate first-slice BYOC to Premium/Enterprise or operator
  entitlement, and show explicit copy about ClickHouse-owned data versus
  InstantML R2 artifact bytes.
- Decision: Incorporated as first-slice constraints and onboarding
  requirements.

Fresh reviewer 3:

- Finding: Validation must prove data-plane reachability, not just control-plane
  reachability. BYOC storage accounting also needs a control-plane R2 ledger,
  and observability/runbooks need stable codes.
- Risk: A customer could pass validation from one egress path and fail all SDK
  writes from another; usage summaries could depend on customer warehouse
  health; support could see generic warehouse errors instead of actionable
  customer misconfiguration.
- Recommended edit: Run validation and post-create smoke from the actual
  data-plane route, store `egress_set_version`, count only retained R2 objects
  through a control-plane ledger, and add BYOC metrics/events/runbooks.
- Decision: Incorporated as required implementation constraints.

2026-05-25 GCP self-hosted update reviewer A:

- Finding: The GCP direction was correct, but hosted BYOC needed to fail closed
  when static egress CIDRs were absent or unversioned, and schema-upgrade
  behavior after DDL revocation needed a clear customer/operator path.
- Risk: Customers could paste credentials before they had a usable allowlist, or
  a future InstantML schema version could either store excessive DDL privilege
  forever or break BYOC writes without actionable status.
- Recommended edit: Make `GET current` the pre-validation egress contract, reject
  hosted validation/create without a configured egress set, document
  `migration_required`, and test the customer SQL grants against the current
  schema.
- Decision: Incorporated. Rotation remains implemented for operator/local smoke,
  but customer-facing rotation UX stays deferred.

2026-05-25 GCP self-hosted update reviewer B:

- Finding: Endpoint SSRF, TLS, and Secret Manager scoping were too declarative
  for a persisted customer-supplied endpoint.
- Risk: A customer DNS change or compromised data-plane service could turn BYOC
  into unsafe outbound access or expose more customer ClickHouse passwords than
  the affected cell needs.
- Recommended edit: Require re-resolution/new-connection checks, no redirects,
  metadata/private egress deny, trusted-root TLS with hostname verification/SNI,
  TLS-specific failure codes, separate control/data service accounts, and
  narrow Secret Manager grants before public rollout.
- Decision: Incorporated as production invariants. Existing broad Secret Manager
  access remains acceptable only for internal smoke rollout and must be tracked
  as hardening before public BYOC.

2026-05-25 GCP self-hosted update reviewer C:

- Finding: Customer-facing copy clearly pointed to GCP self-hosted BYOC and
  R2-only InstantML storage accounting, but the design index still listed this
  doc as draft and legacy Cloud caveats could be copied into user docs.
- Risk: Future agents could reintroduce ClickHouse Cloud onboarding or believe
  the design still awaited approval.
- Recommended edit: Update the design index and keep Cloud-specific details in
  alternatives/operator-only notes.
- Decision: Incorporated. Customer-facing docs and UI must teach only GCP
  self-hosted ClickHouse for BYOC.

2026-05-25 implementation review:

- Finding: Usage docs still had hosted-warehouse wording that could imply BYOC
  database bytes count when a customer database is org-scoped. The onboarding
  form also defaulted the BYOC username to `default`, and the BYOC smoke used
  direct REST calls instead of the Python SDK.
- Risk: Customers could follow less-safe SQL guidance, support could misread
  storage usage for BYOC orgs, and local verification could miss SDK upload
  behavior.
- Recommended edit: Clarify that BYOC storage guardrails use only InstantML R2
  artifact bytes, default to `instantml_writer`, and make the BYOC smoke create
  an SDK run, log metrics, upload a file artifact, then verify R2/local artifact
  accounting after DDL grants are revoked.
- Decision: Incorporated.

2026-05-25 runtime safety review:

- Finding: Endpoint safety was enforced at validation/save time but not checked
  again when cached customer routes were reused.
- Risk: A DNS or stored-route change after setup could point product writes at a
  private or reserved address.
- Recommended edit: Re-resolve and re-normalize customer endpoints before route
  load and before returning a cached customer tenant store, without taking the
  main store-data lock from write paths.
- Decision: Incorporated with a customer-endpoint cache and unit coverage for
  rejecting a cached route that resolves to loopback, including IPv4-mapped IPv6
  private/reserved targets. The ClickHouse HTTP client uses Hyper directly
  rather than a redirect-following browser-style client, so customer redirects
  are not part of the accepted runtime path.

## Coverage Exceptions

Coverage exception:
- Uncovered area: Short-lived validation-token binding between validate and
  create.
- Reason: The API no longer exposes a validation token. Create revalidates the
  submitted endpoint, database, and credentials synchronously instead of
  trusting a previous validation response.
- Risk: Users may repeat a slow validation on save; this does not permit a route
  to be saved without validation.
- Follow-up: Add expiring server-side validation records only if validation
  latency becomes painful.
- Owner/date: Codex / 2026-05-22

## Decision

The implemented first slice is a gated, empty-org, public-HTTPS,
pre-created-database BYOC path for customer-owned GCP ClickHouse with explicit
storage setup state, data-plane-origin validation, Secret Manager-backed
customer credential storage, R2-only storage accounting, and no ClickHouse
Cloud API automation.
