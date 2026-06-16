# Operations

Operational runbooks and inventories for hosted InstantML live here. These docs
are for operator-facing procedures that are too concrete for design docs but
not part of public user documentation.

## Key Runbooks

- `backend-phase-0-capacity.md`: backend scaling Phase 0 gates for current-cell
  capacity, Cloud SQL connection budgeting, ClickHouse backup/restore checks,
  cell-scoped observability, and write-path benchmark evidence.
- `github-deploy.md`: GitHub Actions deployment setup.
- `secrets.md`: hosted secret-management conventions.
- `secrets-inventory.md`: current secret inventory.

## Notes For Future Agents

- Keep customer data, tokens, raw secret values, signed URLs, and ClickHouse
  credentials out of committed runbooks.
- Prefer commands that emit sanitized IDs or aggregate counts.
- Update the nearest architecture/design doc when a runbook changes an accepted
  operating model.
