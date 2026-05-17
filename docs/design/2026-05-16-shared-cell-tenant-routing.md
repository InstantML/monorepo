# Design: Shared-Cell Tenant Routing

Date: 2026-05-16

Status: Accepted

Owner: Codex

## Context

Today every new organization gets its own ClickHouse Cloud Mini 12 GiB service
provisioned inside `POST /api/auth/clerk`. Each service costs roughly $70–$200
per month. At 500 paid orgs this totals more than $50 k/mo—which is far above
the margin ceiling for the Lab tier ($29/mo). Something cheaper is needed for
personal/free signups.

Cost math:
- 500 orgs × $70/mo minimum = $35 000/mo in ClickHouse Cloud services alone.
- At $29/mo/org that is $14 500/mo revenue, a negative-$20 000/mo gap.
- The tipping point is at roughly 50 orgs at the $200/mo maximum tier: still
  negative at $29 price point.

One ClickHouse service shared by many small orgs can serve the long tail cheaply
because isolation is enforced with `org_id` predicates—not database-level
tenant separation—while paid business orgs continue to receive a dedicated
service.

## Goals

- New signups with `account_type=personal` (or absent, which defaults to
  personal) land instantly with no ClickHouse Cloud provisioning call.
- The shared cell is one ClickHouse database pre-configured via env vars at
  deploy time.
- `org_id` filtering enforces logical isolation: every read/write in the shared
  cell includes an `org_id` predicate.
- `account_type=business` retains the existing per-org Cloud provisioning path.
- Existing orgs remain on `dedicated` tier without any automated migration.
- The shared-cell URL/database is operator-configured, not auto-provisioned.
- A regression test proves cross-org reads in the shared cell return empty.

## Non-Goals

- **No migration of existing orgs** this PR. Any existing org that already has a
  dedicated tenant route keeps it. Migration tooling is a separate follow-up.
- **No hibernation/wake-up** for the shared cell. The shared cell is always
  on—it is a single inexpensive service.
- **No billing integration** in this slice; usage metering by `org_id` is a
  separate concern.
- **No row-level security at the ClickHouse layer.** Isolation remains
  application-enforced through `org_id` predicates on every query. A future
  slice may add ClickHouse row policies.
- **No multi-region shared cells.** One shared cell per region is a follow-up.
- **No automatic shared-cell schema migration at signup.** The shared-cell
  database is pre-migrated by the operator or during server startup (same path
  as today's local migration).

## Data Model

### `OrganizationRow` — new field `tenant_routing_tier`

Add `tenant_routing_tier: String` to `OrganizationRow` with values `shared` or
`dedicated`.

- Default for all new signups: `shared`.
- Backfill rule: existing orgs that already have a `dedicated` tenant route
  record keep `dedicated`. Because org records are rebuilt from
  `operational_records` on startup, older rows that were serialized before this
  field existed deserialize to `dedicated` (the safe fallback, see
  implementation note).

```
OrganizationRow {
    ...
    tenant_routing_tier: String  // "shared" | "dedicated", default "shared"
}
```

### Shared-cell `TenantRouteRecord`

The shared cell is represented by one canonical tenant route record with a
well-known `org_id` sentinel:

```
SHARED_CELL_ORG_ID = Uuid::from_u128(0xFFFF_FFFF_FFFF_FFFF_FFFF_FFFF_FFFF_FFFF)
```

This record is written once at startup (or on first signup) when shared-cell env
vars are present. Its shape matches the existing `TenantRouteRecord` struct:

```
TenantRouteRecord {
    org_id:     SHARED_CELL_ORG_ID,  // sentinel — not a real org
    status:     "ready",
    provisioner: "shared-cell",
    endpoint:   $INSTANTML_SHARED_CELL_URL (host:port portion),
    database:   $INSTANTML_SHARED_CELL_DATABASE,
    username:   $INSTANTML_SHARED_CELL_USERNAME,
    password_ciphertext: $INSTANTML_SHARED_CELL_PASSWORD,
    ...
}
```

`StoreData` holds an optional `shared_cell_route: Option<TenantRouteRecord>` and
the `MetricStore` for the shared cell is kept in a dedicated field on `Store`
(`shared_cell_metric_store: Option<MetricStore>`), separate from per-org tenant
stores.

### Routing logic at signup

```
account_type == "personal" (or absent/None)
    → tenant_routing_tier = "shared"
    → NO ClickHouse Cloud provisioning
    → ensure_tenant_route writes a TenantRouteRecord pointing at the shared cell

account_type == "business"
    → tenant_routing_tier = "dedicated"
    → existing per-org provisioning path unchanged
```

`validate_account_type` is extended to accept `"personal"` as a valid value
(synonym for shared tier).

### Routing logic at request time

`metric_store_for_org(org_id)`:

1. Look up the `OrganizationRow` for `org_id`.
2. If `tenant_routing_tier == "shared"`: return `shared_cell_metric_store`.
3. If `tenant_routing_tier == "dedicated"`: existing per-org path.
4. Fallback (missing tier field on older records): `dedicated`.

## Isolation

Every read/write path already carries `org_id` in every query. The shared
ClickHouse database is the same database used for the local single-process
slice, except now multiple orgs share it. The existing predicates already
include `org_id` on every operational record (`kind, org_id, entity_id,
created_at`) and every metric table (`org_id, run_id, key, step`).

### Inventory of affected query paths

| Path | org_id predicate enforced by |
| --- | --- |
| `operational_records` insert | `org_id` column always written |
| `operational_records` load (startup replay) | partition scan on `(kind, org_id, entity_id, created_at)` ordering; replay validates `org_id` in payload |
| `metric_points` insert | `org_id` column always written |
| `metric_series` / `metric_series_mv` | `org_id` in primary ordering key |
| Metric series reads | `WHERE org_id = ?` in every query |
| Console log reads | `WHERE org_id = ?` in every query |

### Regression test (non-negotiable)

A dedicated test `shared_cell_cross_org_isolation`:

1. Build a `StoreData` instance loaded from shared-cell operational records
   containing data for org A and org B.
2. Call metric point insertion for org A and org B using the same `MetricStore`
   (shared cell).
3. Query metric series for org A → assert zero rows with `run_id` from org B.
4. Query metric series for org B → assert zero rows with `run_id` from org A.

This test is part of `npm run rust:test` and must pass.

### Enforcement proposal

- **Review-only for operational reads:** startup `apply_operational_records` with
  `ReplayScope::Tenant(org_id)` already validates org ownership on every
  payload. Extend this to the shared-cell load path so shared-cell records are
  still validated per-org during replay.
- **Wrapper for metric writes:** `MetricStore::insert_metric_points` and
  `insert_operational_record` already accept `org_id` from the caller. No
  wrapper needed; the predicate is structural.
- **EXPLAIN-plan gate:** not added in this slice (no ClickHouse EXPLAIN-plan
  runner in the test harness). Flagged as a follow-up.

## Operations

### Environment variables (new)

| Variable | Purpose | Required |
| --- | --- | --- |
| `INSTANTML_SHARED_CELL_URL` | HTTP URL for the shared ClickHouse cell, e.g. `http://default:pass@host:8123/default` | Required when shared cell is enabled |
| `INSTANTML_SHARED_CELL_DATABASE` | Database name inside the shared cell | Defaults to `instantml_shared` |

Shared-cell mode is enabled when `INSTANTML_SHARED_CELL_URL` is set in the
environment. If the variable is absent, new signups fall through to the existing
dedicated provisioning path (preserving backward compatibility).

### Dev/test provisioning

In dev/test: `INSTANTML_SHARED_CELL_URL` points at the same local ClickHouse
instance used by `CLICKHOUSE_URL` but with a different database name (e.g.
`instantml_shared`). The schema migration is applied automatically on startup.

In prod: the shared cell is a separate low-cost ClickHouse Cloud service
(e.g. a single Mini 8 GiB service shared by all free orgs). The operator sets
`INSTANTML_SHARED_CELL_URL` at deploy time. The shared-cell service is not
created by the signup path.

### Backup considerations

The shared cell contains data for many free-tier orgs. Backup policy should
follow the same ClickHouse Cloud automatic backup defaults. Because free-tier
orgs have a 2 GiB storage warning and the shared service is small, the operator
should monitor total shared-cell size and plan an expansion or new cell when
approaching 80 % of the service's storage.

## Schema migration

No ClickHouse schema change is required. `tenant_routing_tier` is a field in
the `OrganizationRow` JSON payload stored inside `operational_records`. The
ClickHouse table schema (`operational_records`) is unchanged.

Rust struct migration: the `OrganizationRow` struct gains
`#[serde(default = "default_routing_tier")]` on the new field, which returns
`"dedicated"` for any record that predates this change. This ensures existing
orgs that already have a dedicated route continue to route correctly after the
code is deployed.

## Reviewer Notes

> **Reviewer A — org-leak risk:**
>
> The shared cell routes all personal orgs to one MetricStore instance. If a
> query path constructs a metric query without an `org_id` predicate—even once—
> it will read data belonging to other orgs. The `metric_points` and
> `metric_series` tables have `org_id` in their primary ordering key, but
> ClickHouse does not enforce row-level security by default.
>
> Resolution in this PR: (a) the cross-org isolation regression test is
> non-negotiable and must pass, (b) every MetricStore read method carries an
> explicit `org_id: Uuid` parameter, and (c) the `ReplayScope::Tenant(org_id)`
> check is preserved for shared-cell operational record loads. A follow-up
> should add ClickHouse row policies or EXPLAIN-plan tests to catch any future
> predicate omission.
>
> **Remaining risk:** a new metric read helper added in the future without an
> `org_id` predicate would silently cross org boundaries. The regression test
> only covers the paths that exist today.

> **Reviewer B — migration semantics:**
>
> Existing orgs are not auto-migrated by this PR. Their `OrganizationRow` records
> were serialized before `tenant_routing_tier` existed, so they deserialize to
> the `default = "dedicated"` value. This is the safe direction: defaulting to
> `dedicated` preserves existing behavior for all current orgs.
>
> The concern is the reverse: if an operator needs to move a `personal` org to
> `dedicated` (e.g. they upgrade), there is no migration path in this slice.
> Flagged as a follow-up. In the interim, an operator can manually write an
> updated `organization` operational record with `tenant_routing_tier =
> "dedicated"` and restart the server.
>
> A future migration tool should: (1) verify no shared-cell tenant route exists
> for the org, (2) provision a dedicated route, (3) write a
> `tenant_routing_tier = "dedicated"` update to the org record, and (4) copy
> data from the shared cell to the dedicated service. None of this is in scope
> for this PR.

## Open Follow-Ups

1. **Migration of existing personal orgs to dedicated** (e.g. when they upgrade
   to Pro). Requires a copy-on-upgrade pipeline.
2. **Hibernation policy for the shared cell.** Not needed: shared cell is always
   on.
3. **ClickHouse row policies** as a second enforcement layer against cross-org
   reads.
4. **EXPLAIN-plan test gate** to catch new metric reads missing `org_id`
   predicates.
5. **Multiple shared cells** (one per region or capacity shard) for scale.
6. **Personal → dedicated upgrade path** and tier-change API.

## Coverage Exception

Coverage exception:
- Uncovered area: ClickHouse row-level security and EXPLAIN-plan org_id predicate verification.
- Reason: ClickHouse does not expose EXPLAIN output in a test-friendly way in the current test harness.
- Risk: a future query without org_id predicate silently crosses tenant boundaries in the shared cell.
- Follow-up: add ClickHouse row policies or an EXPLAIN-plan test gate.
- Owner/date: hosted backend owner, 2026-05-16.
