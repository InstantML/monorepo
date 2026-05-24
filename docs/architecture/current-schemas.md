# Current Control And Data-Plane Schema Reference

Date: 2026-05-17

Status: Current implemented schema surface for `apps/rust-server`

## Purpose

This document is the durable schema reference for the current Rust/ClickHouse
backend. Keep it synchronized with:

- `apps/rust-server/src/control_store.rs`
- `apps/rust-server/clickhouse/0001_initial.sql`
- `apps/rust-server/src/domain.rs`
- `apps/rust-server/src/store/mod.rs`
- `apps/rust-server/src/store/tenants.rs`
- `apps/rust-server/src/metric_store.rs`

`docs/architecture/current-api.md` documents HTTP routes and request/response
contracts. This document documents the storage contracts behind those routes:
physical ClickHouse tables, control-plane record kinds, data-plane record kinds,
and JSON payload shapes stored in append-only operational logs.

## Storage Model

InstantML uses two logical storage planes.

```text
Control plane:
  ClickHouse table instantml_user_data
  -> users, identities, orgs, memberships, sessions, API keys, plan-aware tenant routes

Data plane:
  ClickHouse table operational_records
  -> tenant product metadata and low-volume state

  ClickHouse tables metric_points, rank_metric_points, console_log_lines, metric_series
  -> high-volume scalar metrics, per-rank metrics, console logs, and maintained summaries
```

In local/non-hosted mode, `operational_records` may contain both control and
data record kinds. In hosted mode, control record kinds are written to
`instantml_user_data`, and tenant product state is written to the org's routed
tenant ClickHouse database. The current InstantML-owned hosted path uses
database-mode routing on self-hosted GCP ClickHouse; `cloud-service` remains a
legacy/provider-backed route type.

All durable low-volume records are append-only. A newer record for the same
entity replaces the in-memory projection when replayed, but older records remain
in ClickHouse until a future compaction design exists.

## Serialization Conventions

- JSON field names are snake_case.
- UUIDs are serialized as strings in JSON payloads and as ClickHouse `UUID`
  columns in physical tables.
- Rust `DateTime<Utc>` values are serialized as RFC3339-style JSON strings in
  payloads and as ClickHouse `DateTime64(6, 'UTC')` columns in physical tables.
- `Vec<String>` fields serialize as JSON arrays of strings.
- `serde_json::Value` fields preserve arbitrary JSON objects, arrays, strings,
  numbers, booleans, or nulls after validation.
- Secret hashes such as `token_hash`, `key_hash`, and `request_hash` serialize
  as JSON arrays of byte values because they are Rust `Vec<u8>`.
- Append-only record payloads are complete serialized structs, not partial
  patches.

## Control Plane

### `instantml_user_data`

Owner: `apps/rust-server/src/control_store.rs`

Purpose: hosted User Data table for account, auth, organization, API-key,
Stripe billing, and tenant-route state that must be visible to control and data
services.

```sql
CREATE TABLE IF NOT EXISTS instantml_user_data (
    event_id   UUID,
    scope      LowCardinality(String),
    kind       LowCardinality(String),
    org_id     UUID,
    entity_id  String,
    payload    String CODEC(ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (scope, kind, org_id, entity_id, created_at, event_id)
SETTINGS index_granularity = 8192;
```

| Column | Type | Meaning |
| --- | --- | --- |
| `event_id` | `UUID` | Unique append event id. Used as a deterministic replay tie-breaker with `created_at`. |
| `scope` | `LowCardinality(String)` | `global` for users and identities, `org` for org-scoped control records. |
| `kind` | `LowCardinality(String)` | Control record kind listed below. |
| `org_id` | `UUID` | Owning org for `org` records. `00000000-0000-0000-0000-000000000000` for `global` records. |
| `entity_id` | `String` | Stable entity identifier, usually a UUID string. |
| `payload` | `String` | Complete JSON payload for the record kind. |
| `created_at` | `DateTime64(6, 'UTC')` | Append time. |

Replay order:

```sql
ORDER BY created_at ASC, event_id ASC
```

Do not implement incremental control replay with `(created_at, event_id)` as a
cursor while `event_id` is random. Full replay is the current safe path.

### Control Record Kinds

| Kind | Scope | Entity id | Payload schema |
| --- | --- | --- | --- |
| `user` | `global` | `UserRow.id` | `UserRow` |
| `identity` | `global` | `IdentityRecord.user_id` | `IdentityRecord` |
| `organization` | `org` | `OrganizationRow.id` | `OrganizationRow` |
| `membership` | `org` | `MembershipRow.id` | `MembershipRow` |
| `org_invitation` | `org` | `OrgInvitationRow.id` | Hashed app-owned invitation token plus previous token hashes retained only while a resend has not been confirmed, invited email/role, pending/accepted/revoked/expired state, seven-day expiration, delivery metadata. Terminal invitations are not re-indexed by token hash during replay. |
| `email_delivery` | `org` | `EmailDeliveryRow.id` | One durable send attempt for an organization invitation. Stores provider, recipient email, queued/sent/failed status, provider message id, and safe error code/message. |
| `session` | `org` | `SessionRecord.row.id` | `SessionRecord` |
| `service_account` | `org` | `ServiceAccountRow.id` | `ServiceAccountRow` |
| `api_key` | `org` | `ApiKeyRecord.row.id` | `ApiKeyRecord` |
| `tenant_route` | `org` | `TenantRouteRecord.org_id` | `TenantRouteRecord` |
| `billing_account` | `org` | `BillingAccountProjection.org_id` | Billing entitlement projection for write gates and Settings. |
| `billing_checkout_intent` | `org` | `BillingCheckoutIntent.id` | Pending or fulfilled Stripe Checkout action. |
| `billing_change_intent` | `org` | `BillingChangeIntent.id` | Pending plan/seat/cancel change action. |
| `billing_subscription` | `org` | `BillingSubscriptionRecord.stripe_subscription_id` | Last known Stripe subscription projection. |
| `billing_event` | `org` | `BillingEventRecord.stripe_event_id` | Processed Stripe event idempotency record. |
| `billing_usage_report` | `org` | `BillingUsageReportRecord.id` | Retained-storage overage report attempt. |
| `dashboard_preference` | `org` | `dashboard-preference:<org_id>:<user_id>` | `DashboardPreferenceRow` |
| `workspace_view` | `org` | `WorkspaceViewRow.id` | `WorkspaceViewRow` |

### `UserRow`

```json
{
  "id": "uuid",
  "primary_email": "ada@example.com",
  "display_name": "Ada Lovelace",
  "avatar_url": "https://example.com/avatar.png",
  "created_at": "2026-05-16T00:00:00Z",
  "last_seen_at": null
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID string | User id. |
| `primary_email` | string | Lowercased canonical email. |
| `display_name` | string or null | Optional human name. |
| `avatar_url` | string or null | Optional hosted avatar URL. |
| `created_at` | datetime | Creation time. |
| `last_seen_at` | datetime or null | Informational last-seen value. |

### `IdentityRecord`

```json
{
  "user_id": "uuid",
  "provider": "clerk",
  "provider_subject": "user_123"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `user_id` | UUID string | Linked InstantML user. |
| `provider` | string | `dev_google`, `clerk`, or another accepted provider. |
| `provider_subject` | string | Provider-specific stable user id. |

### `OrganizationRow`

```json
{
  "id": "uuid",
  "slug": "acme-research",
  "name": "Acme Research",
  "plan_tier": "pro",
  "account_type": "customer",
  "seat_limit": 3,
  "created_by_user_id": "uuid",
  "created_at": "2026-05-16T00:00:00Z",
  "tenant_routing_tier": "customer-clickhouse",
  "storage_choice": "customer-clickhouse",
  "storage_state": "storage_unconfigured"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID string | Organization id and tenant owner. |
| `slug` | string | Unique URL-safe-ish workspace slug. |
| `name` | string | Display name. |
| `plan_tier` | string | Current tier: `free`, `pro`, or `premium`. Legacy `lab`/`startup` values canonicalize to `pro`; `growth` canonicalizes to `premium` on new writes. |
| `account_type` | string | `customer`, `business`, or validated account type. |
| `seat_limit` | integer | Max active plus invited seats from the selected plan: Free 2, Pro 3, Premium 10 by default. |
| `created_by_user_id` | UUID string or null | Creator when known. |
| `created_at` | datetime | Creation time. |
| `tenant_routing_tier` | string | `shared`, `dedicated`, or `customer-clickhouse`. Older records default to `dedicated` on deserialization. |
| `storage_choice` | string | `instantml-hosted` or `customer-clickhouse`. Older records default to hosted. |
| `storage_state` | string | `storage_unconfigured`, `storage_validating`, `storage_ready`, or `storage_locked`. Hosted and legacy records default to ready. Product writes and API-key creation are blocked until ready/locked. |

### `MembershipRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "owner_user_id": "uuid",
  "role": "owner",
  "status": "active",
  "created_at": "2026-05-16T00:00:00Z"
}
```

Roles are validated membership roles. Current auth paths expect owner/admin
roles for privileged organization administration.

Legacy reserved seats may still exist as normal `MembershipRow` records with
`status: "invited"` and a placeholder user whose primary email is the invite
target. The current hosted invite flow stores pending invitations as
`OrgInvitationRow` control records. When a matching verified identity accepts
the token before expiration, the server writes an active `MembershipRow` and
marks the invitation accepted.

### `OrgInvitationRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "email": "teammate@example.com",
  "role": "member",
  "status": "pending",
  "token_hash": [1, 2, 3],
  "invited_by_user_id": "uuid",
  "created_at": "2026-05-22T00:00:00Z",
  "expires_at": "2026-05-29T00:00:00Z",
  "last_sent_at": "2026-05-22T00:00:00Z",
  "accepted_at": null,
  "accepted_by_user_id": null,
  "revoked_at": null,
  "revoked_by_user_id": null,
  "delivery_status": "sent",
  "email_provider": "resend",
  "provider_message_id": "provider-message-id"
}
```

Plaintext invitation tokens are never stored. Pending unexpired invitations
reserve a seat; accepted, revoked, and expired invitations do not count beyond
any active membership they created.

### `EmailDeliveryRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "invitation_id": "uuid",
  "recipient_email": "teammate@example.com",
  "provider": "resend",
  "status": "sent",
  "provider_message_id": "provider-message-id",
  "error_code": null,
  "created_at": "2026-05-22T00:00:00Z"
}
```

### `SeatRow`

`GET /api/orgs/:org_id/seats` and `POST /api/orgs/:org_id/seats` return a
membership plus the joined user snapshot:

```json
{
  "membership": {
    "id": "uuid",
    "org_id": "uuid",
    "user_id": "uuid",
    "role": "member",
    "status": "invited",
    "created_at": "2026-05-16T00:00:00Z"
  },
  "user": {
    "id": "uuid",
    "primary_email": "teammate@example.com",
    "display_name": null,
    "avatar_url": null
  }
}
```

### `SessionRecord`

```json
{
  "row": {
    "id": "uuid",
    "user_id": "uuid",
    "org_id": "uuid",
    "metadata": {},
    "created_at": "2026-05-16T00:00:00Z",
    "last_seen_at": null,
    "expires_at": "2026-06-15T00:00:00Z",
    "revoked_at": null
  },
  "token_hash": [1, 2, 3]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `row` | `UserSessionRow` | Public session metadata. |
| `token_hash` | byte array | SHA-256 hash of the opaque session token. Plaintext token is never stored. |

### `ServiceAccountRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "name": "SDK key",
  "created_by_user_id": "uuid",
  "created_at": "2026-05-16T00:00:00Z",
  "disabled_at": null
}
```

Service accounts own API keys. Disabling a service account invalidates its keys
at auth time.

### `ApiKeyRecord`

```json
{
  "row": {
    "id": "uuid",
    "org_id": "uuid",
    "service_account_id": "uuid",
    "name": "SDK key",
    "key_prefix": "instantml_abc",
    "scopes": ["sdk:ingest", "artifacts:write"],
    "project_id": null,
    "created_at": "2026-05-16T00:00:00Z",
    "expires_at": null,
    "last_used_at": null,
    "revoked_at": null
  },
  "key_hash": [1, 2, 3]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `row` | `PublicApiKeyRow` | Public key metadata returned by list/create endpoints. |
| `key_hash` | byte array | SHA-256 hash of the API key secret. Plaintext key is returned only once on creation for non-demo orgs. |

Supported scopes include:

- `sdk:ingest`
- `artifacts:write`
- `imports:write`
- `usage:read`
- `export:read`
- `api_keys:write`

`project_id` restricts a key to one project when present. Demo org keys are
clamped to read-only export behavior at authorization time.

### `TenantRouteRecord`

```json
{
  "org_id": "uuid",
  "status": "ready",
  "provisioner": "database",
  "plan_tier": "premium",
  "warehouse_kind": "dedicated",
  "requested_min_replica_memory_gb": 16,
  "requested_max_replica_memory_gb": 16,
  "requested_num_replicas": 2,
  "applied_min_replica_memory_gb": 8,
  "applied_max_replica_memory_gb": 8,
  "applied_num_replicas": 1,
  "endpoint": "http://clickhouse.internal:8123",
  "database": "instantml_org_<org_id_simple>",
  "username": "instantml",
  "password_secret_ref": "gcp-secret-manager:instantml-clickhouse-user-data-password",
  "password_ciphertext": null,
  "service_id": null,
  "created_at": "2026-05-16T00:00:00Z",
  "updated_at": "2026-05-16T00:00:00Z",
  "error": null
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `org_id` | UUID string | Tenant owner. |
| `status` | string | `provisioning`, `ready`, or `failed`. Customer-owned routes also use the org-level storage state to gate setup. |
| `provisioner` | string | `database`, `cloud-service`, `local`, `shared-cell`, or `customer-clickhouse`. |
| `plan_tier` | string or null | Plan selected when the route was created. |
| `warehouse_kind` | string or null | `shared`, `standard`, `dedicated`, or `customer-owned` intent. |
| `requested_min_replica_memory_gb` | integer or null | Plan-requested minimum replica memory. |
| `requested_max_replica_memory_gb` | integer or null | Plan-requested maximum replica memory. |
| `requested_num_replicas` | integer or null | Plan-requested replica count. |
| `applied_min_replica_memory_gb` | integer or null | Actual provisioner minimum replica memory. |
| `applied_max_replica_memory_gb` | integer or null | Actual provisioner maximum replica memory. |
| `applied_num_replicas` | integer or null | Actual provisioner replica count. |
| `endpoint` | string | ClickHouse HTTP endpoint. |
| `database` | string | Tenant database name. Current hosted database-mode routes use `instantml_org_<org_id.simple>`. |
| `username` | string | ClickHouse username. |
| `password_secret_ref` | string or null | Config/Secret Manager reference. BYOC hosted routes use `gcp-secret-manager:projects/.../versions/...`; local BYOC smoke tests may use `local-user-data-byoc:<org_id>`. |
| `password_ciphertext` | string or null | Plaintext credential fallback for local smoke tests and the legacy hosted cloud-service provisioner only. Current self-hosted GCP and hosted BYOC routes should leave this null. |
| `schema_version` | integer or null | Applied InstantML ClickHouse schema version. BYOC route loads skip DDL when this is at least the current metric schema version. The current version is 2. |
| `service_id` | string or null | Legacy ClickHouse Cloud service id when known. Current self-hosted GCP database-mode routes leave this null. |
| `created_at` | datetime | Initial route creation time. |
| `updated_at` | datetime | Last route state update time. |
| `error` | string or null | Last provisioning error for failed routes. |

By default, `applied_*` records the actual hosted storage profile rather than
blindly applying a plan card's requested size. Current self-hosted GCP
database-mode routes use the shared ClickHouse deployment. Set
`INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING=true` only for the legacy
provider-backed path after payment and spend gates are in place.

### `DashboardPreferenceRow`

```json
{
  "user_id": "uuid",
  "org_id": "uuid",
  "selected_project": "hosted-scale-data",
  "updated_at": "2026-05-17T00:00:00Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `user_id` | UUID string | Browser user that owns the preference. |
| `org_id` | UUID string | Organization scope for the preference. |
| `selected_project` | string or null | Last selected dashboard project; `null` clears the preference. |
| `updated_at` | datetime | Last write time. |

### `WorkspaceViewRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "user_id": "uuid",
  "name": "Daily comparison",
  "project": "hosted-scale-data",
  "payload": {
    "schema_version": 2,
    "tab": "runs",
    "workspace_view": {}
  },
  "created_at": "2026-05-17T00:00:00Z",
  "updated_at": "2026-05-17T00:00:00Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID string | Stable saved-view id. |
| `org_id` | UUID string | Organization scope. |
| `owner_user_id` | UUID string or null | Browser user that owns the saved view; `null` is reserved for local compatibility mode. |
| `name` | string | User-visible saved-view name. |
| `project` | string or null | Project association used by dashboard selectors. |
| `payload` | JSON object | Saved dashboard state, limited to 64 KiB after serialization. |
| `created_at` | datetime | Initial save time. |
| `updated_at` | datetime | Last write time. |

Workspace-view payloads are complete JSON objects. The first persisted frontend
slice stores the active tab, selected runs/metrics, Compare settings, and the
Runs workspace layout; future schema versions should keep backward-compatible
read support for older payloads.

## Data Plane

### `operational_records`

Owner: `apps/rust-server/clickhouse/0001_initial.sql` and
`apps/rust-server/src/metric_store.rs`

Purpose: append-only tenant operational record log for low-volume product state.

```sql
CREATE TABLE IF NOT EXISTS operational_records (
    kind       LowCardinality(String),
    org_id     UUID,
    entity_id  String,
    payload    String CODEC(ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (kind, org_id, entity_id, created_at)
SETTINGS index_granularity = 8192;
```

| Column | Type | Meaning |
| --- | --- | --- |
| `kind` | `LowCardinality(String)` | Data record kind listed below. |
| `org_id` | `UUID` | Tenant owner. |
| `entity_id` | `String` | Entity id, project name, idempotency key, or usage snapshot key depending on kind. |
| `payload` | `String` | Complete JSON payload for the record kind. |
| `created_at` | `DateTime64(6, 'UTC')` | Append time. |

Replay order for tenant/local records:

```text
created_at, kind, org_id, entity_id, payload
```

Tenant replay validates that `org_id`, payload org ownership, and record entity
ids match the routed org before adding the record to the in-process projection.

### Data Record Kinds

| Kind | Entity id | Payload schema | Notes |
| --- | --- | --- | --- |
| `project` | `ProjectRow.id` | `ProjectRow` | Project metadata. |
| `project_delete` | `ProjectDeleteRecord.project_name` | `ProjectDeleteRecord` | Removes project, runs, attributes, artifacts, and table rows from the in-memory projection. |
| `run` | `RunRow.id` | `RunRow` | Run metadata and status. |
| `attribute` | `AttributeRow.id` | `AttributeRow` | Typed attributes and rich logged objects. |
| `artifact` | `ArtifactRow.id` | `ArtifactRow` | Artifact metadata, not hosted bytes. |
| `table_rows` | `TableRowsRecord.attribute_id` | `TableRowsRecord` | Preview rows for table objects. |
| `import` | `ImportRow.id` | `ImportRow` | Import job summary and produced run ids. |
| `idempotency` | `IdempotencyRecord.key` | `IdempotencyRecord` | Request replay response for metric/log idempotency keys. |
| `usage_daily` | `<org_id>-<YYYY-MM-DD>` | usage snapshot JSON | Immutable daily usage snapshot payload. |

In local/non-hosted mode, the control-plane record kinds can also appear in this
table because the combined service has no separate User Data table.

### `ProjectRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "name": "demo",
  "description": null,
  "created_at": "2026-05-16T00:00:00Z"
}
```

Project names are unique within the in-process org projection. Shared
multi-writer cells still need durable uniqueness before data cells can scale
above one active writer.

### `ProjectDeleteRecord`

```json
{
  "org_id": "uuid",
  "project_name": "demo"
}
```

This is a projection event. It removes the matching project and associated
product metadata when replayed.

### `RunRow`

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "project_id": "uuid",
  "project": "demo",
  "name": "train-seed-7",
  "status": "running",
  "config": {},
  "tags": ["baseline"],
  "metadata": {},
  "created_at": "2026-05-16T00:00:00Z",
  "started_at": "2026-05-16T00:00:00Z",
  "finished_at": null
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | Validated run status such as `running`, `finished`, or `failed`. |
| `config` | JSON object | User config object. |
| `tags` | string array | Searchable run tags. |
| `metadata` | JSON object | Searchable metadata. Notes are stored under metadata when edited. |

### `AttributeRow`

```json
{
  "id": 1,
  "org_id": "uuid",
  "run_id": "uuid",
  "path": "config/lr",
  "type": "config",
  "step": null,
  "logged_at": "2026-05-16T00:00:00Z",
  "value": 0.001,
  "summary": {},
  "artifact_id": null,
  "created_at": "2026-05-16T00:00:00Z"
}
```

Supported `type` values include scalar/config/string/file-like attributes and
rich object types such as `table`, `image`, `video`, `audio`, and
`histogram_series`. `id` is currently an org-local integer allocated by the Rust
projection, so shared multi-writer data cells need durable per-org ids or
deterministic ids before automatic write scaling.

### Internal `ArtifactRow` And Public Artifact Responses

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "run_id": "uuid",
  "type": "checkpoint",
  "name": "model.pt",
  "uri": "instantml://artifacts/instantml-org-.../runs/.../model.pt",
  "step": 10,
  "size_bytes": 128,
  "sha256": "hex",
  "mime_type": "application/octet-stream",
  "storage_backend": "r2",
  "storage_key": "instantml-org-.../runs/.../model.pt",
  "storage_path": "r2://instantml-org-.../runs/.../model.pt",
  "metadata": {},
  "created_at": "2026-05-16T00:00:00Z"
}
```

This row stores artifact metadata and byte references. Local uploads use
`storage_backend: "local"` with a relative local `storage_key`; hosted R2
uploads use `storage_backend: "r2"`, `storage_key: "<bucket>/<object_key>"`,
and `storage_path: "r2://<bucket>/<object_key>"`. External metadata-only rows
use `storage_backend: "external"` and do not download through the byte route.
Internal storage keys are not returned by artifact list/create/upload responses.
The public response shape preserves `id`, `org_id`, `run_id`, `type`, `name`,
`step`, `size_bytes`, `sha256`, `mime_type`, `storage_backend`, `metadata`, and
`created_at`, but returns `uri: "instantml://artifacts/<artifact_id>"` for
stored local/R2 bytes and omits `storage_key` and `storage_path`.

### `TableRowsRecord`

```json
{
  "attribute_id": 1,
  "rows": [
    {
      "row_index": 0,
      "row": { "prediction": "cat", "score": 0.91 },
      "created_at": "2026-05-16T00:00:00Z"
    }
  ]
}
```

Rows are bounded preview rows for `table` objects. The object metadata itself is
the corresponding `AttributeRow`.

### `ImportRow`

```json
{
  "id": 1,
  "org_id": "uuid",
  "project_id": "uuid",
  "source_type": "wandb_json",
  "status": "completed",
  "summary": { "runs": 1, "metrics": 10, "attributes": 2, "artifacts": 1 },
  "run_ids": ["uuid"],
  "created_at": "2026-05-16T00:00:00Z",
  "completed_at": "2026-05-16T00:01:00Z"
}
```

`id` is currently an org-local integer allocated by the Rust projection.

### `IdempotencyRecord`

```json
{
  "org_id": "uuid",
  "key": "client-idempotency-key",
  "request_hash": [1, 2, 3],
  "response_json": { "inserted": 100 },
  "expires_at": "2026-05-23T00:00:00Z"
}
```

The request hash is computed from the run id and canonical request body. The
current implementation reserves idempotency keys in-process while a request is
active, then stores the durable response record. Shared multi-writer data cells
still need atomic durable idempotency or ClickHouse dedupe keys before scaling
writes horizontally.

### Usage Snapshot JSON

`usage_daily` records store the same shape returned by `GET /api/usage`:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-16T00:00:00Z",
  "source": "computed_current_state",
  "billing_precision": "not_billable",
  "usage_period": {
    "kind": "calendar_month",
    "timezone": "UTC",
    "starts_at": "2026-05-01T00:00:00Z",
    "ends_at": "2026-06-01T00:00:00Z",
    "reset_at": "2026-06-01T00:00:00Z"
  },
  "plans": {
    "free": {},
    "pro": {},
    "premium": {}
  },
  "overage_policy": {
    "paid_extra_seats": "tracked_not_billed",
    "seats": "paid_extra_seats",
    "projects": "blocked_at_limit",
    "runs": "blocked_at_limit",
    "metric_points": "blocked_at_limit",
    "storage": "blocked_at_limit",
    "artifacts": "visibility_only",
    "api_keys": "visibility_only"
  },
  "organizations": [
    {
      "org_id": "uuid",
      "org_slug": "acme-research",
      "plan_tier": "pro",
      "plan": {
        "id": "pro",
        "label": "Pro",
        "monthly_base_usd": 199,
        "included_seats": 3,
        "included_storage_bytes": 1099511627776
      },
      "usage_period": {
        "kind": "calendar_month",
        "timezone": "UTC",
        "starts_at": "2026-05-01T00:00:00Z",
        "ends_at": "2026-06-01T00:00:00Z",
        "reset_at": "2026-06-01T00:00:00Z"
      },
      "limits": {
        "included_seats": 3,
        "included_storage_bytes": 1099511627776,
        "projects": 100,
        "runs": 100000,
        "metric_points": 250000000
      },
      "usage": {
        "seats": 2,
        "paid_extra_seats": 0,
        "projects": 1,
        "runs": 85000,
        "metric_points": 1000,
        "metric_points_current_period": 1000,
        "metric_points_retained_total": 250000,
        "metric_series": 10,
        "artifacts": 3,
        "api_keys": 1,
        "artifact_bytes_exact": 12345,
        "external_artifact_bytes_declared": 4096,
        "artifact_bytes_unknown": 0,
        "artifact_bytes_unknown_count": 0,
        "estimated_metadata_bytes": 8192,
        "warehouse_storage_bytes_exact": 32768,
        "storage_bytes_for_warnings": 45113,
        "estimated_storage_bytes_for_warnings": 45113,
        "billable_storage_bytes": null
      },
      "warnings": [
        {
          "target": "runs",
          "status": "approaching_limit",
          "value": 85000,
          "limit": 100000,
          "ratio": 0.85,
          "policy": "blocked_at_limit",
          "blocking": true,
          "code": "runs_approaching_limit",
          "message": "runs usage is approaching the plan limit. New writes will be blocked at the limit."
        }
      ]
    }
  ]
}
```

Usage is guardrail/debugging data, not invoice truth. Scalar and rank
metric-point usage is counted for the current UTC calendar-month
`usage_period`; the same current period value is exposed as
`usage.metric_points` and `usage.metric_points_current_period`, while
`usage.metric_points_retained_total` records retained history. Plan-owned
data-plane writes are checked against the stored tier before commit. New
project, run, metric-ingest, artifact, import, and demo-reset writes return
HTTP 402 with `code: "plan_limit_exceeded"` when current or projected usage
crosses a blocked `projects`, `runs`, current-month `metric_points`, or
retained `storage` limit. Seats remain tracked as `paid_extra_seats` until
billing is implemented. Storage, projects, runs, seats, artifacts, metric
series, and API keys are retained-resource counts and do not reset monthly.
`warehouse_storage_bytes_exact` comes from ClickHouse table parts for dedicated
tenant databases and is `null` for shared-cell orgs where exact per-org bytes
are not available. It is also `null` for customer-owned ClickHouse orgs because
InstantML must not meter the customer's warehouse. `storage_bytes_for_warnings`
is the guardrail value used for blocked storage checks; hosted orgs prefer exact
warehouse plus artifact bytes when available and otherwise fall back to the
metadata estimate. BYOC orgs use only retained InstantML-owned artifact bytes.
The older
`estimated_storage_bytes_for_warnings` field remains a compatibility alias for
that guardrail value, not an invoice source.

## Analytical Data Tables

### `metric_points`

Owner: `apps/rust-server/clickhouse/0001_initial.sql`

Purpose: high-volume scalar metric point storage.

```sql
CREATE TABLE IF NOT EXISTS metric_points (
    org_id     UUID,
    run_id     UUID,
    key        LowCardinality(String),
    step       Float64 CODEC(Delta, ZSTD(3)),
    value      Float64 CODEC(ZSTD(3)),
    logged_at  DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, key, step)
SETTINGS index_granularity = 8192;
```

| Column | Type | Meaning |
| --- | --- | --- |
| `org_id` | `UUID` | Tenant owner. |
| `run_id` | `UUID` | Run owner. |
| `key` | `LowCardinality(String)` | Metric key, for example `eval/accuracy`. |
| `step` | `Float64` | Finite nonnegative training step. |
| `value` | `Float64` | Finite scalar value. |
| `logged_at` | `DateTime64(6, 'UTC')` | Client-supplied or server-normalized metric time. |
| `created_at` | `DateTime64(6, 'UTC')` | Server insert time. |

Metric list/chart endpoints must stay bounded by run, key, explicit limits, or
series chunking. Run-summary endpoints should read maintained series summaries,
not full metric history.

### `rank_metric_points`

Owner: `apps/rust-server/clickhouse/0001_initial.sql`

Purpose: append-only per-rank scalar metric storage for distributed training
debugging. The first API slice writes one row per `(run, key, step, rank)` and
derives reducers, coverage, heatmap, and outlier views at read time.

```sql
CREATE TABLE IF NOT EXISTS rank_metric_points (
    org_id     UUID,
    run_id     UUID,
    key        LowCardinality(String),
    step       Float64 CODEC(Delta, ZSTD(3)),
    rank       UInt32 CODEC(Delta, ZSTD(3)),
    local_rank UInt32 CODEC(Delta, ZSTD(3)),
    world_size UInt32 CODEC(Delta, ZSTD(3)),
    value      Float64 CODEC(ZSTD(3)),
    weight     Float64 DEFAULT 1 CODEC(ZSTD(3)),
    logged_at  DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3)),
    event_id   UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, key, step, rank, created_at, event_id)
SETTINGS index_granularity = 8192;
```

| Column | Type | Meaning |
| --- | --- | --- |
| `org_id` | `UUID` | Tenant owner. |
| `run_id` | `UUID` | Run owner. |
| `key` | `LowCardinality(String)` | Metric key, for example `train/loss`. |
| `step` | `Float64` | Finite nonnegative training step. |
| `rank` | `UInt32` | Zero-based global rank. Must be `< world_size`. |
| `local_rank` | `UInt32` | Zero-based rank on the local node. Defaults to `rank`. |
| `world_size` | `UInt32` | Expected number of global ranks, capped at 512. |
| `value` | `Float64` | Finite scalar value for this rank. |
| `weight` | `Float64` | Positive finite sample/work weight for weighted reducers. |
| `logged_at` | `DateTime64(6, 'UTC')` | Client-supplied or server-normalized metric time. |
| `created_at` | `DateTime64(6, 'UTC')` | Server insert time. |
| `event_id` | `UUID` | Per-insert tie-breaker used by summary read dedupe. |

Summary queries canonicalize duplicate `(org_id, run_id, key, step, rank)` rows
with `argMax(..., tuple(created_at, event_id))`. Rank metric rows count against
the same monthly metric-point usage guardrail as scalar metric rows, but do not
currently feed `metric_series`.

### `console_log_lines`

Purpose: stdout/stderr line storage for run terminal views.

```sql
CREATE TABLE IF NOT EXISTS console_log_lines (
    org_id      UUID,
    run_id      UUID,
    stream      LowCardinality(String),
    ingest_id   UUID,
    line_number UInt64 CODEC(Delta, ZSTD(3)),
    message     String CODEC(ZSTD(3)),
    logged_at   DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at  DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, stream, line_number, ingest_id)
SETTINGS index_granularity = 8192;
```

| Column | Type | Meaning |
| --- | --- | --- |
| `org_id` | `UUID` | Tenant owner. |
| `run_id` | `UUID` | Run owner. |
| `stream` | `LowCardinality(String)` | `stdout` or `stderr`. |
| `ingest_id` | `UUID` | Batch ingest id used as a stable cursor tie-breaker. |
| `line_number` | `UInt64` | Client line number within stream. |
| `message` | `String` | Log line text. |
| `logged_at` | `DateTime64(6, 'UTC')` | Client-supplied or server-normalized line time. |
| `created_at` | `DateTime64(6, 'UTC')` | Server insert time. |

### `metric_series`

Purpose: maintained per-run/per-key metric aggregates populated by
`metric_series_mv`.

```sql
CREATE TABLE IF NOT EXISTS metric_series (
    org_id           UUID,
    run_id           UUID,
    key              LowCardinality(String),
    count            AggregateFunction(count, Float64),
    sum              AggregateFunction(sum, Float64),
    sum_sq           AggregateFunction(sum, Float64),
    min              AggregateFunction(min, Float64),
    max              AggregateFunction(max, Float64),
    latest           AggregateFunction(argMax, Float64, Float64),
    latest_step      AggregateFunction(max, Float64),
    best_step        AggregateFunction(argMax, Float64, Float64),
    latest_logged_at AggregateFunction(argMax, DateTime64(6, 'UTC'), Float64)
)
ENGINE = AggregatingMergeTree
ORDER BY (org_id, run_id, key);
```

Read queries finalize aggregate states into:

| Output | Meaning |
| --- | --- |
| `count` | Point count. |
| `sum` | Sum of values. |
| `sum_sq` | Sum of squared values for variance. |
| `min` | Minimum value. |
| `max` | Maximum value. |
| `mean` | Derived `sum / count`. |
| `variance` | Derived from `sum`, `sum_sq`, and `count`. |
| `latest` | Value at max step. |
| `latest_step` | Max step. |
| `best` | Usually max value, or min value for minimize-oriented metric keys at query time. |
| `best_step` | Step associated with the max value in the stored aggregate. |
| `latest_logged_at` | Logged time at max step. |

### `metric_series_mv`

Purpose: materialized view that updates `metric_series` as points are inserted.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS metric_series_mv TO metric_series AS
SELECT
    org_id,
    run_id,
    key,
    countState(value)                AS count,
    sumState(value)                  AS sum,
    sumState(value * value)          AS sum_sq,
    minState(value)                  AS min,
    maxState(value)                  AS max,
    argMaxState(value, step)         AS latest,
    maxState(step)                   AS latest_step,
    argMaxState(step, value)         AS best_step,
    argMaxState(logged_at, step)     AS latest_logged_at
FROM metric_points
GROUP BY org_id, run_id, key;
```

## Plane Placement By Mode

| Mode | Control records | Data records | Metrics/logs |
| --- | --- | --- | --- |
| Local/default combined | `operational_records` | `operational_records` | local/default ClickHouse database |
| Hosted combined | `instantml_user_data` | routed tenant `operational_records` | routed tenant ClickHouse database |
| Hosted split control | `instantml_user_data` | route/provisioning only, via tenant route creation | tenant schema migration/provisioning only |
| Hosted split data | full User Data replay before auth | routed tenant `operational_records` | routed tenant ClickHouse database |
| Hosted BYOC data | User Data `organization` + `tenant_route` records | customer-owned `operational_records` | customer-owned ClickHouse database |

## Change Checklist

When changing schemas or payload fields:

1. Update Rust structs and replay validation.
2. Update ClickHouse SQL or control-store SQL.
3. Update `docs/architecture/current-schemas.md`.
4. Update `docs/architecture/current-api.md` when HTTP inputs or outputs change.
5. Update `apps/rust-server/README.md` when operational commands or config change.
6. Add or update replay, validation, hosted split, and contract tests.
7. Run `npm run rust:verify`.

## Known Gaps

- There is no durable compaction for append-only operational records yet.
- Shared data-plane cells remain single-writer by default. Durable uniqueness,
  per-org sequences or deterministic ids, and atomic idempotency are required
  before multi-writer data cells are safe.
- R2-backed artifact storage uses the current JSON/base64 upload route. Large
  checkpoint direct-upload, multipart upload, provider reconciliation, and
  retention/delete policies remain future designs.
- Usage storage guardrails count retained InstantML-owned local/R2 artifact
  bytes. External/imported artifact sizes remain visible as declared metadata
  but do not consume retained-storage quota unless a future import copies those
  bytes into InstantML-owned storage.
- `password_ciphertext` in `TenantRouteRecord` is currently a temporary
  plaintext field gated by config. Production secret-manager-backed tenant
  passwords need a separate design.
