# Control plane: ClickHouse event-log → Postgres

- Status: **In progress** — core implemented and shipping dark behind `DATABASE_URL`.
- Date: 2026-05-28
- Scope: `apps/rust-server` control plane only. Metrics/run data stays on ClickHouse.

## Implemented in this PR (dark — gated on `DATABASE_URL`)

- Postgres schema (`migrations/0001_init_control_plane.sql`), `ControlDb`
  (`control_db.rs`), `sqlx` dependency, `control_database_url` config, and a
  `postgres` service in `docker-compose`.
- Full 18-entity typed repository (`control_repo.rs`): upsert + bulk-load.
- `persist_locked` chokepoint routes every control write to Postgres; startup
  rebuilds the projection from Postgres (bounded by live rows, not history).
- Atomic signup: `create_organization` and `create_current_user_organization`
  commit org + owner membership in one transaction; `create_user` commits
  user + identity atomically.
- Backfill: `backfill-control` command (`run_control_backfill`) replays the
  ClickHouse control log into Postgres, reporting (not dropping) collisions.
- 14 Postgres-backed tests (`#[sqlx::test]`); full suite green.

**Not in this PR (deliberate follow-ups):** deleting the in-memory projection
and porting the 278 in-memory tests to Postgres (the projection is retained as
the cutover safety net), and Cloud SQL provisioning.

## Summary

The control plane (users, orgs, memberships, sessions, API keys, invitations,
billing, tenant routes) is currently an **append-only event log on ClickHouse**
replayed into in-memory `BTreeMap`/`HashMap` projections. This design replaces
that with **Postgres** as the system of record. ClickHouse remains the store for
metrics and tenant run data — it is the right tool there and that code is good.

This is the root cause of findings across three of four reviews. The event-log
model has no uniqueness, no transactions, no read-after-write, depends on a
single writer (`maxScale=1`) that every deploy violates, grows unbounded, and
forces thousands of lines of Rust to reconstruct queryable state.

## Current architecture (what exists today)

- `control_store.rs` — a ClickHouse `MergeTree` table `instantml_user_data`
  with columns `(event_id, scope, kind, org_id, entity_id, payload JSON, created_at)`.
  Append-only; no constraints.
- `store/mod.rs::persist_locked` — every control mutation serializes a row to
  JSON and **appends** it (`insert_record`). No `ON CONFLICT`, no transaction.
- `store/mod.rs::rebuild` — on startup, `load_records(None)` does a **full-table
  scan** and replays every event ever written into `StoreData` (the in-memory
  projection, ~50 maps, `store/mod.rs:488-539`).
- Incremental refresh — a background task (`refresh_control_records`) re-reads
  `created_at > cursor` every 2s and re-applies. Cursor is a process-local
  microsecond clock (`record_clock_micros`), `next_record_created_at` mints
  `max(now, clock+1)`.
- Uniqueness (org slug, email, project name, API-key hash) is checked against
  the in-memory map, then a row is appended.

### Control entities (the migration surface)

From `is_control_record_kind` (`store/tenants.rs:71`):

`user`, `identity`, `organization`, `membership`, `org_invitation`,
`email_delivery`, `session`, `service_account`, `api_key`,
`dashboard_preference`, `workspace_view`, `billing_account`,
`billing_checkout_intent`, `billing_change_intent`, `billing_subscription`,
`billing_event`, `billing_usage_report`, and the tenant route record.

Backing Rust types: `UserRow`, `IdentityRecord`, `OrganizationRow`,
`MembershipRow`, `OrgInvitationRow`, `EmailDeliveryRow`, `SessionRecord`
(`UserSessionRow` + `token_hash`), `ServiceAccountRow`, `ApiKeyRecord`
(`PublicApiKeyRow` + `key_hash`), `DashboardPreferenceRow`, `WorkspaceViewRow`,
`BillingAccountProjection`, `BillingCheckoutIntent`, `BillingChangeIntent`,
`BillingSubscriptionRecord`, `BillingEventRecord`, `BillingUsageReportRecord`,
`TenantRouteRecord`. Plus device codes (currently a control-adjacent map).

> Note: `import`, `run`, `attribute`, `artifact`, `table_rows`, `project` etc.
> are **tenant** records (per-org ClickHouse), not control records, and are out
> of scope. `project`/`project_delete` are tenant-scoped today; confirm during
> Phase 0 whether project-name uniqueness must move to Postgres too.

## What the review wants fixed → how Postgres fixes it

| Finding | Postgres fix |
|---|---|
| Two concurrent signups for same slug both succeed | `UNIQUE` on `organizations.slug`, `users.primary_email`, `api_keys.key_hash`, `(org_id, project_name)`; insert returns conflict instead of silently appending. |
| Crash mid-signup leaves org with no owner | Single `BEGIN … COMMIT` wrapping user+identity+org+membership+session+route. |
| Two writers mint identical microsecond timestamps, refresh cursor skips records (`created_at >` strict) | No cursor, no projection. Reads hit the table directly (read-after-write within the connection/txn). |
| Unbounded log replay on every cold start | No replay. Startup connects a pool; cost is independent of lifetime writes. |
| `maxScale=1` correctness dependency | Postgres is the concurrency authority. Multiple Rust instances become safe writers. |
| `store/` bloat reconstructing queryable state | Delete the projection, refresh throttle, cursor, single-writer clock, control replay; `billing.rs`/`usage.rs`/`mod.rs` shrink to SQL. |

## Proposed Postgres schema (sketch)

One table per entity, real columns for what we filter/join/unique on, `JSONB`
for the long tail. Examples (not exhaustive):

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  primary_email text NOT NULL,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz,
  CONSTRAINT users_email_unique UNIQUE (lower(primary_email))
);

CREATE TABLE identities (
  provider         text NOT NULL,
  provider_subject text NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, provider_subject)
);

CREATE TABLE organizations (
  id            uuid PRIMARY KEY,
  slug          text NOT NULL,
  name          text NOT NULL,
  plan_tier     text NOT NULL,
  account_type  text NOT NULL,
  seat_limit    integer NOT NULL,
  created_by_user_id uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL,
  tenant_routing_tier text NOT NULL DEFAULT 'dedicated',
  storage_choice text NOT NULL DEFAULT 'hosted',
  storage_state  text NOT NULL DEFAULT 'ready',
  CONSTRAINT orgs_slug_unique UNIQUE (slug)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT membership_org_user_unique UNIQUE (org_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  key_hash bytea NOT NULL UNIQUE,
  -- remaining PublicApiKeyRow fields ...
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE tenant_routes (
  org_id uuid PRIMARY KEY,
  status text NOT NULL,
  service_id text,
  payload jsonb NOT NULL,  -- TenantRouteRecord tail
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  error text
);
```

Billing tables (`billing_accounts`, `billing_subscriptions` keyed by Stripe id,
`billing_events` keyed by Stripe event id — natural idempotency via `UNIQUE`,
`billing_checkout_intents`, `billing_change_intents`, `billing_usage_reports`),
`org_invitations` (unique on token hash), `email_deliveries`, `service_accounts`,
`dashboard_preferences` (PK `(user_id, org_id)`), `workspace_views`,
`idempotency_keys` (PK `(org_id, key)`, replaces the in-memory `idempotency`
map and the `inflight_idempotency` set with `INSERT … ON CONFLICT DO NOTHING`).

## Driver & access choices (decisions needed — see below)

- **Driver:** `sqlx` (async, compile-time-checked queries, built-in migrator,
  rustls) is the natural fit alongside the existing async stack. Alternative:
  `tokio-postgres` + `deadpool`. Recommendation: `sqlx` with `runtime-tokio-rustls`.
- **Migrations:** `sqlx::migrate!` from `apps/rust-server/migrations/`, run by
  the existing `migrate` command in `main.rs` (which already migrates ClickHouse).
- **Hosting:** Cloud SQL for Postgres (simplest) vs AlloyDB. Cloud SQL is
  sufficient for control-plane volume; AlloyDB only if we expect heavy analytics
  on control tables (we don't — that's ClickHouse). Recommendation: Cloud SQL,
  connect via the Cloud SQL Go/Rust connector or private IP from Cloud Run.

## Migration / cutover strategy

**There is production control data to preserve, so the backfill and cutover are
mandatory** — we cannot greenfield. The *code* is built straight to the end
state (no long-lived dual-write compatibility layer); only the *data* moves
through a staged, verifiable cutover.

1. **Foundation (done — no behavior change).** `sqlx`, `control_database_url`
   in config (`DATABASE_URL` / Cloud SQL), `migrations/0001_init_control_plane.sql`,
   and `control_db.rs` (`ControlDb`). Ships dark; nothing reads/writes it yet.
2. **Write path.** Replace `persist_locked` for control kinds with typed SQL
   inserts/updates inside transactions. Add the atomic `signup` transaction
   (user+identity+org+membership+session+route in one `BEGIN…COMMIT`).
3. **Read path.** Replace the in-memory `StoreData` control reads with SQL,
   entity by entity. Each entity's tests flip to `#[sqlx::test]`.
4. **Backfill job** (new `migrate` subcommand step). Reads the ClickHouse
   control log and writes Postgres. **It must detect uniqueness collisions from
   the raw event stream** — the old `HashMap`-keyed projection silently
   collapses duplicate slugs/emails to last-writer-wins, so a naive
   replay-then-dump would inherit that loss. The job reports collisions for
   manual resolution rather than crashing or silently dropping rows.
5. **Cutover.** Assuming single-writer (`maxScale=1`, not yet multi-instance):
   brief maintenance window → quiesce the writer → run backfill → flip
   `DATABASE_URL` on → keep the ClickHouse control table read-only for one
   release as a safety net. (Zero-downtime would require dual-write; out of
   scope unless explicitly needed.)
   - **Deploy wiring:** `tools/deploy-cloud-run.mjs` gates this behind
     `INSTANTML_ENABLE_CONTROL_POSTGRES=1` + `INSTANTML_CLOUD_SQL_CONNECTION`.
     Off by default → dark deploys. On → mounts the Cloud SQL socket, injects
     `DATABASE_URL` from `instantml-control-database-url`, and grants the runtime
     SA secret access.
   - **Split-topology data-plane freshness (resolved).** Prod runs
     `--topology=split`, and the **data plane** must pick up control changes
     (new/revoked keys, route changes). The original refresh
     (`spawn_control_refresh_task` / `refresh_control_records`) was
     ClickHouse-only, so on Postgres a data instance would have frozen its
     control projection at startup — revoked keys still working, new keys
     rejected until restart. **Fixed:** `refresh_from_postgres` reloads the live
     control state from Postgres on the same background cadence and
     `adopt_control_projection` swaps **only** the control collections, preserving
     the data plane's lazily-loaded tenant data; changed tenant routes still
     evict their MetricStore caches. The refresh task now spawns whenever a
     control backing (Postgres or ClickHouse) is configured. (Combined/single is
     also fine: one instance, write-through keeps its projection fresh.)
6. **Delete.** Remove `control_store.rs`, the `StoreData` control maps,
   `apply_control_records`, `refresh_control_records`, the cursor
   (`record_clock_micros`), the 2s background task, `last_control_refresh*`,
   and the now-dead reconstruction logic in `billing.rs`/`usage.rs`/`mod.rs`.

## Out of scope / unchanged

- ClickHouse for metrics, run data, console logs, rank metrics.
- Tenant routing mechanics (which ClickHouse service an org uses) — only the
  *storage* of the route record moves to Postgres.
- Local single-binary mode: keep working. Either run an embedded/local Postgres
  for dev, or keep the in-memory path for `hosted_clickhouse.is_none()`.

## Risks

- **Local/test mode.** ~270 mutation call sites and a large test suite assume the
  in-memory store. Tests must get a real Postgres (testcontainers / a CI
  service) or a maintained in-memory fallback. This is the biggest cost.
- **Data correctness at backfill.** The old model may already contain duplicate
  slugs/emails. Backfill must surface and resolve these, not crash.
- **Connecting Cloud Run → Cloud SQL** (IAM, connector, pool sizing under Fluid
  Compute / multi-instance).
- **Multi-instance constraints in `CLAUDE.md`** become *easier* (Postgres is the
  authority) but the deploy gate ("do not deploy multi-instance from this
  branch") still applies until tests with 2+ live writers pass.

## Decisions (locked 2026-05-28)

1. **Driver:** `sqlx` 0.8.6 (tokio + rustls, built-in migrator, `#[sqlx::test]`).
2. **Host:** Cloud SQL Postgres.
3. **Tests:** real Postgres via `#[sqlx::test]` (fresh isolated DB per test).
4. **Cutover:** backfill + maintenance-window cutover — **not** greenfield
   (production control data must be preserved). Zero-downtime/dual-write only if
   later required.

Still open:
- Do project-name and other tenant-scoped uniqueness checks move to Postgres
  too, or stay in the tenant ClickHouse path? (Default: stay, out of scope.)
- Cloud SQL connectivity from Cloud Run: private IP vs Auth Proxy connector.
