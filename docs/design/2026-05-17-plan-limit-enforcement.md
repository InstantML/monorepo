# Design: Plan Limit Enforcement

Date: 2026-05-17

Status: Accepted narrow first slice by implementation owner; fresh review required before expanding scope

Owner: Codex

## Summary

InstantML already stores Free, Pro, and Premium plan tiers and exposes current
usage through `GET /api/usage`, but the first pricing slice only produced
warnings. That lets orgs keep writing projects, runs, metric points, and
artifact bytes after crossing their included limits, which is risky for a
hosted data plane with always-on ClickHouse warehouses.

This design adds a narrow enforcement layer before new data-plane writes. The
server computes current usage, applies the pending write delta, and rejects the
request with a structured plan-limit error if the org is already over a blocked
limit or the write would exceed one. Usage summaries keep their warning role,
but warnings now tell callers whether the target is blocking.

## Goals

- Block new data-plane writes that would exceed project, run, metric-point, or
  storage limits for the org's stored plan tier.
- Return a stable machine-readable error for clients and the dashboard.
- Keep idempotent metric replays free when the original request was already
  accepted.
- Keep local and shared InstantML demo usage on the Premium tier so seeded demo
  data exercises the higher warehouse profile and does not trip Free limits.

## Non-Goals

- No payment collection, proration, or invoice truth.
- No billed overage ledger or provider/object-store reconciliation.
- No artifact registry enforcement.
- No hard blocking of reads, exports, or usage-summary endpoints.
- No per-user seat billing change beyond the existing invitation/reservation
  limits.

## Users and Use Cases

Team owners need to understand when they are approaching plan limits and why a
new write was rejected. SDK and importer clients need a deterministic error so
they can stop retrying, surface the upgrade path, or ask an operator to raise
the plan. Operators need the shared InstantML demo to remain useful as a
Premium-scale sample without special-case warehouse deletion or recreation.

## Proposed Design

Add a shared usage-capacity helper in the Rust store:

- Count current projects, runs, metric points, metric series, artifacts,
  artifact bytes, API keys, and active/invited seats for an org.
- Estimate metadata bytes with the same constants used by usage summaries.
- Accept a write delta for projects, runs, metric points, and storage bytes.
- Block when current usage is already above a blocked limit or projected usage
  after the delta is above a blocked limit.
- Return HTTP 402 with `code: "plan_limit_exceeded"` and an explanatory
  message.

The Node compatibility store mirrors this behavior so contract tests and legacy
fixtures still catch route-shape regressions.

Covered writes:

- Creating a new project.
- Creating a run, including auto-creating its project.
- Logging metric points.
- Creating/uploading artifact metadata with known sizes or metadata overhead.
- Importing Neptune/W&B/MLflow payloads.
- Resetting the demo dataset.

Idempotent metric replay is checked before enforcement. If an idempotency key
matches a stored successful response, the replay returns that response without
consuming additional usage.

Usage warnings become structured records with `target`, `status`, `value`,
`limit`, `ratio`, `policy`, `blocking`, `code`, and `message`. Storage, project,
run, and metric warnings use `policy: "blocked_at_limit"` and
`blocking: true`; seat warnings remain tracked as paid extra seats and
non-blocking in this slice.

## Component Impact

Backend:

- Rust data-plane writes call the new enforcement helper before persisting.
- Node compatibility writes call a matching helper before mutating JSON state.
- Both servers default the local/InstantML demo org to Premium.

Frontend:

- The shared demo signup payload requests Premium. Normal signup plan choices
  remain unchanged.

Python SDK:

- No SDK API changes. The SDK receives HTTP 402 with a stable code if the API
  rejects an ingest request.

Storage:

- No new durable tables. Current enforcement is computed from current state and
  ClickHouse metric counts.

Docs:

- Update pricing, schemas, API, strategy, and component README notes to state
  that usage limits are now enforced for new writes.

## Data Model

No schema migration is required. `OrganizationRow.plan_tier` remains the source
of truth for effective limits:

- `free`
- `pro`
- `premium`

The local org and shared `InstantML Demo` org are now seeded or canonicalized as
`premium`.

## API Contracts

Plan-limit errors use:

```json
{
  "error": "plan limit exceeded: metric_points would exceed the Free limit",
  "code": "plan_limit_exceeded"
}
```

HTTP status: `402 Payment Required`.

`GET /api/usage` and `GET /api/usage/export` continue to return schema version
1. Warning rows are more explicit but remain backward-compatible for callers
that only inspect `target` and `status`.

## Performance Considerations

Each guarded write reads current org usage. Operational counts are in memory in
the Rust store and JSON arrays in the Node compatibility store. Metric point and
series counts are queried from the metric store in Rust. This is acceptable for
the first hosted beta because writes already go through the API and plan checks
are small compared with ClickHouse insert costs.

Expected write frequency:

- SDK metric logging can be frequent and batched. The check runs per API
  request, not per metric point.
- Imports and demo reset estimate the whole payload before writing.

Future optimization:

- Maintain durable usage counters as part of ingestion once the multi-writer
  data-plane design has atomic idempotency and reconciliation.

## Simplicity Review

This is the smallest useful enforcement slice: one helper, existing plan fields,
existing usage sources, and no new billing ledger. It intentionally avoids
payment state, invoice truth, and provider reconciliation until the product has
real paid-account data.

## Failure Modes

- If current metric counts cannot be read, the write fails instead of allowing
  unbounded usage.
- If an artifact upload is staged locally and then blocked, the existing upload
  cleanup path removes the finalized file.
- If an org is already over limit, additional writes for that blocked target
  fail until the plan changes or usage is reduced.
- Existing reads, exports, and usage summaries continue working for over-limit
  orgs.

## Testing Plan

- Rust unit tests cover warning shape and storage-limit enforcement.
- Node store tests cover storage-limit enforcement, warnings, and local Premium
  defaults.
- Node HTTP tests cover the 402 error body.
- Existing auth, usage, importer, artifact, and idempotency tests continue to
  run.

## Documentation Plan

- `PRODUCT_STRATEGY.md`
- `docs/product/pricing-and-margins.md`
- `docs/architecture/current-api.md`
- `docs/architecture/current-schemas.md`
- `apps/rust-server/README.md`
- `apps/server/README.md` if behavior details require a compatibility note
- `apps/web/README.md` for the shared Premium demo default

## Alternatives Considered

- Warning-only: rejected because it does not protect hosted costs.
- Hard monthly billing ledger now: rejected as too much schema before payment
  and provider reconciliation exist.
- Enforce only artifact storage: rejected because project/run/metric caps are
  also plan commitments and operational guardrails.

## Review Notes

Fresh reviewer 1:

- Finding: Pending.
- Risk: The implementation is intentionally narrow, but a fresh reviewer should still check the cost/control-plane failure modes before this expands into billing or multi-writer enforcement.
- Recommended edit: Review `enforce_plan_capacity`, import/demo preflights, and the 402 API contract before adding paid overages.
- Decision: Follow-up review required before expanding scope.

Fresh reviewer 2:

- Finding: Pending.
- Risk: The current slice blocks new writes but does not add durable usage counters.
- Recommended edit: Review the durable-counter and reconciliation plan before enabling shared-cell multi-writer enforcement.
- Decision: Follow-up review required before expanding scope.

## Coverage Exceptions

None.

## Decision

Accepted as a narrow first slice for immediate implementation.
