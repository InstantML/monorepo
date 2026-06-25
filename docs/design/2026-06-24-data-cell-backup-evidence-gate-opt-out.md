# Design: Opt-out for the data-cell backup-evidence placement gate

Date: 2026-06-24

Status: Accepted

Owner: Claude (agent), for Tony Xin

## Summary

Hosted placement (`ensure_eligible_cell`) fails closed when the target data cell
lacks recent backup evidence (`last_backup_at` null or older than
`DATA_CELL_BACKUP_MAX_AGE_SECS` = 36h). By design the data service's
auto-registration heartbeat refreshes health but never marks backups fresh, and
backup evidence is "operator-owned". The problem: nothing in the app records
that timestamp, so a freshly registered cell stays unbacked forever and every
path that runs `ensure_tenant_route` (login session creation, first-signin
auto-provision, workspace/org creation) returns `503 service_unavailable` with
no way to recover.

This was observed in prod: cell `us-central1-a` (env `prod`) was `open`, health
fresh, capacity unlimited, but `last_backup_at` was `NULL`, blocking all logins
and workspace creation.

The current deployment self-hosts ClickHouse on a single GCE VM. Its backups are
handled outside the app via scheduled GCE disk snapshots (real, but invisible to
the app). So the app cannot truthfully record backup evidence — writing a
timestamp would assert a backup the app never verified.

This design adds an explicit opt-out, `INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE`
(default `true`), that disables only the backup-freshness placement gate when
backups are owned outside the app. It is the smallest change that unblocks the
product without weakening the gate by default or asserting false evidence.

## Goals

- Let a deployment whose backups are external place workspaces without faking an
  app-side backup timestamp.
- Preserve the existing fail-closed behavior by default (opt-out, not opt-in).
- Keep the rest of the placement gate (open / health / capacity) unchanged.

## Non-Goals

- Performing or scheduling real backups (that is infra: GCE disk snapshots, and
  later ClickHouse-native `BACKUP … TO` object storage).
- Recording app-side backup evidence (no app component can observe the external
  snapshot today).
- Changing the freshness window or the open/health/capacity checks.

## Users and Use Cases

Operators of a hosted deployment whose ClickHouse backups are handled outside
the app set the flag to `false` so placement is not blocked by an unrecorded
`last_backup_at`. Deployments that do maintain app-recorded backup evidence
leave the default and keep the gate.

## Proposed Design

- `ControlDb` carries a `require_data_cell_backup_evidence` flag, set from
  `INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE` (default `true`; `false`/`0`/`no`/
  `off` disable it). `from_pool` (tests) defaults to `true`.
- `ensure_eligible_cell` takes the flag and skips only the backup-freshness check
  when it is `false`. The closed/stale-health/full checks are unaffected.

## Component Impact

Backend:

- `ControlDb` gains a backup-evidence policy flag threaded into
  `ensure_eligible_cell`.

Frontend / Python SDK:

- None.

Storage:

- No schema change; the flag gates whether `data_cells.last_backup_at` freshness
  is enforced during placement.

Docs:

- `apps/rust-server/README.md` (env var + operational note) and
  `docs/architecture/current-api.md` (admin data-cells note) updated.

## Data Model

No new entities or fields.

## API Contracts

No public API change. This is an operator-set environment flag on the control
service.

## Performance Considerations

None. The flag is read from a struct field during the existing placement
transaction; it removes one timestamp comparison when disabled.

## Simplicity Review

A single boolean on `ControlDb`, defaulting to current behavior, gating one
check. No new endpoints, schema, or config plumbing through `Store`. Deferred:
recording real backup evidence and ClickHouse-native backups.

## Failure Modes

- Flag set `false` on a deployment that actually has no backups: placement
  proceeds onto an unbacked cell. Acceptable only because backups are owned
  externally (disk snapshots); documented as the operator's explicit decision.
- Flag left `true` with no backup regime: placement fails closed (the original
  bug) — surfaced clearly via the `stale_backup` admission status.

## Testing Plan

- control_repo `#[sqlx::test]`: with the gate disabled, a cell with a null backup
  still accepts placement. (Added.)
- Existing `missing_/stale_/future_cell_backup_blocks_placement` tests still
  cover the fail-closed gate under the default (`true`).

## Documentation Plan

- `apps/rust-server/README.md`, `docs/architecture/current-api.md`. (Done.)

## Alternatives Considered

- **Operator endpoint to record backup evidence** (`POST
  /api/admin/data-cells/{cell_id}/backup`): builds a way to *satisfy* the gate.
  Rejected for this deployment because there is no app-observable backup signal
  to record — calling it would just stamp a timestamp by hand, equivalent to
  faking evidence. Worth revisiting if an app-side backup signal ever exists.
- **Relax the gate unconditionally / by default**: rejected as default-changing;
  it silently weakens the gate for every deployment.
- **Implicit "null allows, stale fails"**: rejected as too clever; it would
  silently place orgs even if an intended backup recorder never once succeeded.
- **Auto-stamp backups in the heartbeat**: rejected — the data service has no
  knowledge that a real backup occurred; this would record false evidence.

## Decision

Accepted. Add `INSTANTML_REQUIRE_DATA_CELL_BACKUP_EVIDENCE` (default `true`) to
disable only the backup-freshness gate when backups are owned outside the app.
The gate's open/stale-health/full checks are unchanged.
