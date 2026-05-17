# Design: Usage Metering First Slice

Date: 2026-05-09

Status: Accepted and implemented for Rust warning summaries plus daily rollup snapshots; Node remains compatibility coverage

Owner: Codex

## Summary

Superseding note, 2026-05-16: the original Free/Lab/Startup/Growth planning
thresholds below were replaced by the Free/Pro/Premium model in
`docs/design/2026-05-16-pricing-signup-org-admin.md`. The usage endpoint is
still warning-only, but it now returns the full plan catalog, current plan,
limits, overage policy, active API-key count, estimated metadata/storage bytes,
and `billable_storage_bytes: null`.

Pricing needs to be credible before hosted beta. The smallest useful metering slice is an org-scoped usage summary computed from product data we already store: seats, projects, runs, metric points, retained metric series, artifact bytes, and estimated metadata bytes.

This is not a billing engine and must not be treated as invoice truth. It gives admins and future billing code a stable usage shape, now documents Free/Pro/Premium warning thresholds through the superseding pricing design, and makes overage behavior explicit as fair-use warnings and plan-upgrade prompts.

## Goals

- Track org-level storage usage with artifact bytes separate from metric/metadata estimates.
- Track metric point volume and retained metric history per org.
- Return admin-visible summaries for storage, metric points, projects, runs, seats, artifacts, and API keys.
- Define billing-safe limits for the active Free, Pro, and Premium planning tiers.
- Expose a versioned JSON usage export for billing/debugging.

## Non-Goals

- Charge cards, invoices, Stripe integration, or plan enforcement.
- Exact ClickHouse table/storage byte accounting.
- Per-hour or tracked-hour billing.
- Public final pricing.

## Proposed Design

Add computed usage helpers to the compatibility store and equivalent Rust/ClickHouse queries:

- `usageSummary({ org_id? })`
- `usageExport({ org_id? })`

The summary uses existing state and returns one row per org unless `org_id` scopes it. Hosted/authenticated requests pass `org_id` from the bearer key. Local development can view all orgs.

Usage endpoints require a bearer key with `usage:read` when `requireApiKey` is enabled. A default SDK ingest key must not read usage or seat/API-key counts. The temporary local bootstrap token can still create a key with `usage:read`.

Each organization has an effective `plan_tier`, defaulting to `free`. The endpoint does not accept caller-selected tier overrides in this slice, so warnings are authoritative for the stored effective tier. Future UI "what if" pricing can be a separate endpoint or can return `tier_source: "what_if"` and `authoritative: false`.

Plan tiers are constants shared by tests and API responses. The active values
are defined in the superseding pricing design:

- Free: 2 included seats, 2 GiB storage, 2 projects, 100 runs, 1 million metric points.
- Pro: 3 included seats, 1 TiB storage, 100 projects, 100,000 runs, 250 million metric points.
- Premium: 10 included seats, 5 TiB storage, 500 projects, 1 million runs, 2 billion metric points.

Superseded enforcement note: `2026-05-17-plan-limit-enforcement.md` keeps this
usage shape but changes project, run, metric-point, and estimated-storage
overages from soft warnings to blocked-at-limit guardrails for new writes.

Original slice behavior:

- 80% of a limit: `approaching_limit`.
- 100% or more: `over_limit`.
- Storage overage remains `$0.02-$0.03/GB-month` as a planning range.
- Metric/event overage remains fair-use warning plus plan-upgrade prompt.
- Included seats report `paid_extra_seats` rather than blocking usage.
- Projects, runs, metric points, and warning storage bytes were soft warnings in the original slice.
- Artifact count and API-key count are visibility-only fields with no enforced or warning limit yet.

Canonical count sources:

- Metric point usage counts scalar rows in `metrics` only.
- Retained metric history counts maintained rows in `metricSeries`.
- Float-series attributes created for comparison/search are not counted as metric points.
- Artifact bytes use exact `size_bytes` when present and count missing sizes as unknown, not zero.

## Data Model

Node JSON storage adds `plan_tier` to organizations and otherwise does not add durable usage rows. Usage is recomputed from current state for compatibility checks.

The Rust/ClickHouse implementation computes the same current summary from operational records and metric counts. The accepted ClickHouse-only implementation records daily snapshots as durable operational records, and the Rust worker writes immutable daily snapshots for warning/debug rollups. Billable interpretation is still deferred. `usage_daily` must remain immutable rollup output, not a mutable current total:

- `org_id`
- `period_start date` in UTC
- `period_end date` in UTC, exclusive
- `rollup_kind text check in ('daily_snapshot', 'correction')`
- `schema_version integer`
- `correction_of_rollup_id uuid`
- `plan_tier`
- `seat_count`
- `project_count`
- `run_count`
- `metric_point_count`
- `metric_series_count`
- `artifact_count`
- `api_key_count`
- `artifact_bytes_exact`
- `artifact_bytes_unknown_count`
- `estimated_metadata_bytes`
- `estimated_storage_bytes_for_warnings`
- `generated_at`
- Primary key: generated rollup ID
- Unique active daily snapshot: `(org_id, period_start, rollup_kind)` where `rollup_kind = 'daily_snapshot'`

Monthly storage warning math should use average daily `estimated_storage_bytes_for_warnings` snapshots across UTC days until exact ClickHouse/object-store billing fields exist. Deletes and retention reduce future snapshots but do not mutate historical snapshots; corrections append a correction row linked to the original.

ClickHouse counter needs:

- `metric_points(org_id, created_at)` for org/day point counting.
- Operational records for artifacts, runs, and projects must include `org_id` and timestamps so the Rust index can compute counts.
- Durable billing must not rely on ad hoc full-table scans; use immutable snapshots plus future object-store/provider reconciliation.

## API Contracts

`GET /api/usage`

Returns:

```json
{
  "generated_at": "2026-05-09T00:00:00.000Z",
  "schema_version": 1,
  "billing_precision": "not_billable",
  "units": {"bytes": "bytes", "metric_points": "rows"},
  "overage_policy": {
    "seats": "paid_extra_seats",
    "projects": "blocked_at_limit",
    "runs": "blocked_at_limit",
    "metric_points": "blocked_at_limit",
    "storage": "blocked_at_limit",
    "artifacts": "visibility_only",
    "api_keys": "visibility_only"
  },
  "plans": {},
  "organizations": [
    {
      "org_id": "local",
      "org_slug": "local",
      "plan_tier": "lab",
      "tier_source": "organization",
      "authoritative_for_plan": true,
      "usage": {
        "seats": 1,
        "paid_extra_seats": 0,
        "projects": 1,
        "runs": 6,
        "metric_points": 450,
        "metric_series": 3,
        "artifacts": 24,
        "api_keys": 1,
        "artifact_bytes_exact": 1234,
        "artifact_bytes_unknown_count": 0,
        "estimated_metadata_bytes": 2862,
        "estimated_storage_bytes_for_warnings": 4096,
        "billable_storage_bytes": null,
        "billing_precision": "not_billable"
      },
      "limits": {"included_seats": 3, "included_storage_bytes": 107374182400, "metric_points": 25000000},
      "warnings": []
    }
  ]
}
```

`GET /api/usage/export`

Returns versioned JSON:

```json
{
  "schema_version": 1,
  "exported_at": "2026-05-09T00:00:00.000Z",
  "format": "json",
  "units": {"bytes": "bytes", "metric_points": "rows"},
  "source": "computed_current_state",
  "billing_precision": "not_billable",
  "organizations": []
}
```

The export is a point-in-time current-state snapshot, not a historical billing ledger. It is not paginated because it returns one row per scoped org. Future historical exports should add date ranges and NDJSON/CSV streaming.

## Performance Considerations

The Node helper scans in-memory arrays and is acceptable for the compatibility server. The Rust/ClickHouse version computes usage from indexed org/run/artifact/metric tables and persists daily rollups through the worker. No endpoint returns metric history; only counts and byte totals.

## Simplicity Review

This avoids a premature ledger and billing integration while still giving product, UI, and future hosted work a concrete usage summary contract. Exact GB-day accounting remains deferred until object-storage/provider accounting and billing code are designed.

## Failure Modes

- Unknown tier returns a validation error.
- Missing `size_bytes` increments `artifact_bytes_unknown_count` and is not silently counted as billable storage.
- Estimated metadata bytes are labeled as estimates, not exact billable bytes.
- In hosted auth mode, usage endpoints require bearer auth with `usage:read` and are org-scoped.

## Testing Plan

- Unit/API tests for tier limits, usage counts, artifact bytes, unknown artifact bytes, metric point volume, retained series count, warnings, `usage:read` scope denial/allow, authenticated scoping, and usage export.
- Contract smoke coverage for authenticated usage summary and export.
- Rust integration/worker coverage plus Node compatibility coverage should stay in the relevant backend suites.

## Documentation Plan

- Update `apps/rust-server/README.md`.
- Update `apps/server/README.md`.
- Update `docs/architecture/current-system.md`.
- Update `PRODUCT_STRATEGY.md` with the accepted fair-use warning policy.
- Update `TODO.md` P3 items.

## Implementation Notes

- Implemented in the Rust/ClickHouse server as `GET /api/usage` and `GET /api/usage/export`.
- Implemented in the Node compatibility server with the same route shapes for legacy checks.
- Hosted/authenticated mode requires `usage:read`; default `sdk:ingest` keys receive `403`.
- Contract smoke now verifies usage scope denial plus authenticated summary/export.
- The Rust `worker` command writes immutable daily snapshots for each organization.

## Review Notes

Fresh reviewer 1:

- Finding: P3 should avoid exact billing semantics until hosted ClickHouse exists.
- Risk: Calling estimates "storage" could imply invoice precision.
- Recommended edit: Label metric/metadata bytes as estimated and keep overages as warning-only.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: The usage endpoint must be tenant-scoped in `requireApiKey` mode.
- Risk: An admin/debug endpoint can leak org size and billing posture.
- Recommended edit: Reuse bearer org scoping and add contract coverage.
- Decision: Accepted.

## Coverage Exceptions

None.
