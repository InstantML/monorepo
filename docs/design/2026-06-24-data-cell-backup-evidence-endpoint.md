# Design: Data-cell backup-evidence — operator endpoint and gate opt-out

Date: 2026-06-24

Status: Accepted

Owner: Claude (agent), for Tony Xin

## Summary

Hosted placement (`ensure_eligible_cell`) fails closed when a data cell lacks
recent backup evidence (`last_backup_at` null or older than
`DATA_CELL_BACKUP_MAX_AGE_SECS` = 36h). By design the data service's
auto-registration heartbeat refreshes health but never marks backups fresh, and
backup evidence is "operator-owned". The gap: there was **no production path** to
record that evidence — `upsert_data_cell` is test-only and the admin data-cell
route is read-only. A freshly registered cell therefore stays unbacked forever,
and every path that runs `ensure_tenant_route` (login session creation,
first-signin auto-provision, workspace/org creation) returns
`503 service_unavailable`.

This was observed in prod: cell `us-central1-a` (env `prod`) was `open`, health
fresh, capacity unlimited, but `last_backup_at` was `NULL`, blocking all logins
and workspace creation. The immediate unblock was a manual
`UPDATE data_cells SET last_backup_at = now()`. This design adds the missing
operator mechanism so that is a supported, auditable action instead of a raw SQL
write.

The smallest useful version: a bootstrap-authenticated `POST` that stamps
`last_backup_at = now()` for one existing cell and returns the refreshed
registry.

A follow-on observation drove a second, complementary change. The current
hosted deployment self-hosts ClickHouse on a single GCE VM and has no backup
regime at all, so no app component can truthfully record backup evidence;
recording a timestamp would assert a backup that never happened. The chosen
operational fix for that deployment is scheduled GCE disk snapshots (a real
backup the app cannot observe). To avoid asserting false evidence, this design
also adds an explicit opt-out, `INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE`
(default `true`), that disables only the backup-freshness placement gate when
backups are owned outside the app. The endpoint and the opt-out are independent:
use the endpoint when an app-recorded backup signal exists; use the opt-out when
backups are external.

## Goals

- Provide a supported operator action to record data-cell backup evidence.
- Keep the existing fail-closed placement gate unchanged (do not weaken safety).
- Make the action idempotent, auditable (bootstrap-gated), and easy to wire into
  a backup process or scheduler.

## Non-Goals

- Automating real backups, or inferring backup freshness from the data plane.
- Changing the freshness window or the fail-closed semantics of placement.
- A general data-cell admin CRUD surface (status/capacity edits remain out of
  scope).

## Users and Use Cases

Operators (holders of the bootstrap token). After a backup runs — or via a
scheduler in deployments without a formal backup regime — they call the endpoint
to keep `last_backup_at` within the freshness window so placement stays open.

## Proposed Design

- `ControlDb::record_data_cell_backup(environment, cell_id, observed_at)` runs
  `UPDATE data_cells SET last_backup_at = $observed, updated_at = $observed
  WHERE environment = $env AND cell_id = $id RETURNING *`. Returns
  `Option<DataCellRow>` (`None` when no row matches).
- `store::record_data_cell_backup(store, environment, cell_id)` resolves the
  environment (defaulting to the service's configured environment), calls the
  control_db method with `now()`, refreshes the in-memory projection via
  `insert_data_cell`, and returns the rebuilt `AdminDataCellsResponse`. Requires
  the hosted control plane (validation error otherwise); `404` when the cell is
  missing.
- `POST /api/admin/data-cells/{cell_id}/backup` (handler
  `admin_record_data_cell_backup`) is guarded by `require_strict_bootstrap`,
  takes `cell_id` as a path param and optional `environment` query param, and
  returns the refreshed registry.
- `ControlDb` carries a `require_data_cell_backup_evidence` flag, set from
  `INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE` (default `true`) and passed into
  `ensure_eligible_cell`, which skips only the backup-freshness check when the
  flag is `false`. The open/health/capacity checks are unaffected.

## Component Impact

Backend:

- New control_repo method, store function, admin handler, route, and OpenAPI
  registration; a `ControlDb` backup-evidence policy flag threaded into
  `ensure_eligible_cell`.

Frontend:

- None required. The admin health view already surfaces `stale_backup`; an
  operator action button could be added later.

Python SDK:

- None.

Storage:

- No schema change. Writes the existing `data_cells.last_backup_at` /
  `updated_at` columns.

Docs:

- `apps/rust-server/README.md` operational note and
  `docs/architecture/current-api.md` admin section updated.

## Data Model

No new entities. Updates `data_cells.last_backup_at` and `updated_at` for one
existing row.

## API Contracts

- `POST /api/admin/data-cells/{cell_id}/backup`
  - Auth: `X-InstantML-Bootstrap-Token`.
  - Params: `cell_id` (path); `environment` (query, optional, defaults to the
    service environment).
  - `200`: refreshed data-cell registry (same shape as
    `GET /api/admin/data-cells`).
  - `404`: no matching cell. `400`: missing cell id / non-hosted control plane.
    `401`: missing bootstrap token.

## Performance Considerations

- One indexed single-row UPDATE per operator/scheduler call (expected at most a
  few per cell per day). Negligible. No new indexes; the response reuses the
  existing bounded registry builder.

## Simplicity Review

This is the smallest change that fills the documented-but-missing "operator-owned
backup evidence" path: one UPDATE behind the existing admin/bootstrap surface,
reusing the existing response type. It deliberately does not add a config flag to
relax the gate (see Alternatives), which would change safety defaults.

## Failure Modes

- Missing cell / wrong environment → `404`, no write.
- Non-hosted control plane → validation error.
- Clock skew: a future `last_backup_at` >5m ahead is already rejected by
  placement; this endpoint stamps server `now()`, so it cannot push the cell
  into that state.

## Testing Plan

- control_repo `#[sqlx::test]`: heartbeat leaves `last_backup_at` null; recording
  evidence persists the timestamp and bumps `updated_at`; missing cell id and
  mismatched environment return `None`. (Added.)
- control_repo `#[sqlx::test]`: with the gate disabled, a cell with a null
  backup still accepts placement. (Added.)
- Existing placement tests (`missing_/stale_/future_cell_backup_blocks_placement`)
  still cover the fail-closed gate under the default (`true`).

## Documentation Plan

- `apps/rust-server/README.md`, `docs/architecture/current-api.md`. (Done.)

## Alternatives Considered

- **Relax the gate unconditionally / by default**: rejected as default-changing;
  it silently weakens a documented safety gate for every deployment. Instead the
  relaxation is an explicit opt-out env flag defaulting to the safe behavior.
- **Implicit "null backup allows, stale backup fails"**: rejected as too clever;
  it would silently let a deployment that intends backups place orgs even if the
  recorder never once succeeded. An explicit operator decision is clearer.
- **Auto-stamp backups in the heartbeat**: rejected — the data service has no
  knowledge that a real backup occurred; this would record false evidence.

## Decision

Accepted. Two complementary mechanisms: (1) the operator endpoint to record
real backup evidence, and (2) `INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE`
(default `true`) to disable only the backup-freshness gate when backups are
owned outside the app. The gate's closed/stale-health/full checks are unchanged.
