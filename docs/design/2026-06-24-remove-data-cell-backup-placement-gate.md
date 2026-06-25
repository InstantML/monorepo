# Design: Remove the data-cell backup-freshness placement gate

Date: 2026-06-24

Status: Accepted

Owner: Claude (agent), for Tony Xin

## Summary

Hosted placement (`ensure_eligible_cell`) failed closed when the target data
cell lacked recent backup evidence (`last_backup_at` null or older than 36h). By
design the auto-registration heartbeat refreshes health but never records
backups, and nothing else in the app records them either — so a freshly
registered cell stayed unbacked forever and every path that runs
`ensure_tenant_route` (login session creation, first-signin auto-provision,
workspace/org creation) returned `503 service_unavailable` with no recovery.

This deployment self-hosts ClickHouse on a single GCE VM and backs it up with
scheduled GCE disk snapshots — a real backup the app cannot observe. The
app-level backup gate therefore measured a signal the app never had: it could
only ever raise a false alarm (block on a null/stale timestamp while real
snapshot backups exist) or be satisfied by a hand-written timestamp (theater).
It provided no real protection for this architecture.

This design removes the backup-freshness placement gate entirely. Placement
still fails closed on the checks that reflect real, app-observable cell state:
closed, stale health, and full. `last_backup_at` is retained as a
visibility-only field.

## Goals

- Stop blocking login and workspace creation on a backup signal the app cannot
  truthfully produce.
- Keep the placement checks that reflect real cell state (closed / stale-health /
  full).
- Keep `last_backup_at` as a displayed field for operator visibility.

## Non-Goals

- Performing or scheduling backups (infra: GCE disk snapshots today;
  ClickHouse-native `BACKUP … TO` object storage later).
- Re-introducing an app-level backup gate. If app-observable backup evidence
  ever exists, a freshness gate can be reconsidered in a new design.

## Proposed Design

- Delete the `last_backup_at` freshness check (and its error) from
  `ensure_eligible_cell`; the function keeps the registered / open / health /
  capacity checks.
- Drop the now-unused `DATA_CELL_BACKUP_MAX_AGE_SECS` constant.
- Drop the `stale_backup` value from the admin `admission_status` so the admin
  view does not show a permanent false warning (the app never records backups).
  The raw `last_backup_at` is still reported.

## Component Impact

Backend:

- `ensure_eligible_cell` no longer checks backup freshness; one constant and the
  `stale_backup` admission status are removed.

Frontend / Python SDK / Storage:

- No API or schema change. `data_cells.last_backup_at` remains in the schema and
  in admin output.

Docs:

- `apps/rust-server/README.md` and `docs/architecture/current-api.md` updated to
  state placement does not gate on backups.

## Data Model

No change. `last_backup_at` is retained (visibility only).

## API Contracts

No public API change. The admin data-cell `admission_status` can no longer be
`stale_backup`.

## Performance Considerations

None (removes one timestamp comparison from the placement transaction).

## Simplicity Review

Removing the gate is simpler than gating it behind config: there is no
app-observable backup signal to enforce, so the check could only mislead. The
open/health/capacity checks — which do reflect real state — are unchanged.

## Failure Modes

- A cell whose external (snapshot) backups are broken can still receive
  placements. Accepted: detecting that is the backup system's job (snapshot
  monitoring), not a control-plane timestamp the app never writes.

## Testing Plan

- control_repo `#[sqlx::test]`: placement succeeds onto a cell with a null
  `last_backup_at` (was previously blocked). (Added.)
- store/admin `#[test]`: admission status is `stale_health` for stale health and
  `open` for cells with stale/null backups. (Updated.)
- Removed the obsolete `missing_/stale_/future_cell_backup_blocks_placement`
  tests.

## Documentation Plan

- `apps/rust-server/README.md`, `docs/architecture/current-api.md`. (Done.)

## Alternatives Considered

- **Config opt-out flag** (`INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE`):
  preserves the ability to re-enable the gate without code. Rejected as a knob
  nobody would turn — there is no app-observable backup signal to enforce, so
  the gate cannot be made meaningful for this architecture without a separate
  design. Re-add a gate (with a real signal) if that ever changes.
- **Operator endpoint to record backup evidence**: rejected for the same reason —
  it would only stamp an unverified timestamp.
- **Auto-stamp backups in the heartbeat**: rejected — the app has no knowledge a
  real backup occurred; this would record false evidence.

## Decision

Accepted. Remove the backup-freshness placement gate and the `stale_backup`
admission status; keep `last_backup_at` for visibility. Closed / stale-health /
full placement checks are unchanged.
