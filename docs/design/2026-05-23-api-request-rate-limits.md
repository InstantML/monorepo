# Design: API Request Rate Limits And Usage

Date: 2026-05-23

Status: Accepted for active enforcement and paid overage slice after fresh review

Owner: Codex

## Summary

InstantML already enforces project, run, metric-point, and storage plan
guardrails. The hosted Cloud Run path now also needs request-level protection so
bursty SDK/dashboard traffic cannot overwhelm Cloud Run or the ClickHouse data
plane, and admins can see API request usage beside existing plan usage.

The first slice added short-window token buckets and monthly API request
visibility. This revision makes the request quota active: authenticated product
requests are checked against the org's current UTC calendar-month allowance
before the handler runs. Free workspaces are blocked at the monthly limit.
Paid workspaces can continue past the included allowance, and Stripe
subscriptions carry metered overage prices for both retained storage and API
request millions. Overage reports send only positive deltas for the current
period so repeated reports remain idempotent from an invoicing perspective.

## Goals

- Add Free/Pro/Premium API request allowances and rate-limit defaults to the
  existing plan catalog.
- Track authenticated product API requests per org for the current UTC calendar
  month and expose them in `GET /api/usage` and `GET /api/usage/export`.
- Return clear `429` errors with `Retry-After`, `RateLimit-Limit`,
  `RateLimit-Remaining`, and `RateLimit-Reset` for short-window rate limits.
- Return clear monthly quota `429` errors with reset headers when a Free org, or
  any org without an active paid overage path, reaches the monthly allowance.
- Expose reset information for both limiter scopes: per-second refill headers
  on responses and UTC calendar-month `usage_period.reset_at` in usage/UI.
- Attach storage and API-request metered prices to paid Stripe subscriptions and
  report overage deltas to Stripe Billing meter events.
- Show API request usage in the dashboard Settings usage panel and include it in
  the topbar usage badge.
- Update public/internal pricing docs to reflect the agreed model:
  Free 500k requests/month with upgrade required, Pro 25M requests/month with
  `$2 / 1M` request overage, Premium 150M requests/month with `$1 / 1M`
  request overage, and paid storage overage at `$0.03 / GiB-month`.

## Non-Goals

- No distributed global limiter. The first runtime limiter is per process and
  is not a security boundary in multi-instance Cloud Run.
- No exact invoice-grade per-request ledger. Stripe overage is reported from
  bounded rollups and remains reconcilable, not a raw request log.
- No new external dependency such as Redis, Memorystore, or Upstash.
- No customer-configurable hard-cap UI in this slice.
- No SDK public API change.

## Users and Use Cases

Workspace admins need to see whether an org is using API traffic heavily and
whether it is approaching a plan allowance. SDK users need bursts to receive a
retryable `429` instead of causing ClickHouse or Cloud Run incidents. Operators
need a simple first guardrail that is easy to replace with a shared limiter when
Cloud Run data cells become durable multi-writer services.

## Proposed Design

Extend `PlanTier` with:

- `api_requests`: monthly included authenticated product API requests.
- `api_request_overage_cents_per_million`: paid overage price; `null`
  for Free because Free upgrades before billing.
- `rate_limit_rps`: general per-org request rate.
- `rate_limit_burst`: general per-org burst.
- `ingest_rate_limit_rps`: stricter per-org ingest rate for write-heavy
  endpoints.

Plan defaults:

| Tier | API requests/month | Overage | General rate | Ingest rate |
| --- | ---: | ---: | ---: | ---: |
| Free | 500k | upgrade required | 5 req/sec, burst 30 | 2 req/sec |
| Pro | 25M | `$2 / 1M` metered | 50 req/sec, burst 250 | 25 req/sec |
| Premium | 150M | `$1 / 1M` metered | 200 req/sec, burst 1000 | 100 req/sec |

Add a small `http::rate_limit` module:

- Classify data-plane routes as `general` or `ingest`.
- Apply a small unauthenticated IP/header bucket before any auth work.
- Authenticate enough to identify `org_id` without loading tenant data before
  applying org limits. Handlers still load tenant data only after the request
  passes the limiter.
- Skip platform routes, CORS preflight, health/ready/metrics/openapi, and
  unauthenticated failures from customer metering.
- Apply per-process token buckets keyed by `(org_id, class)` for authenticated
  traffic.
- On rejection, return `429` with a JSON body:

```json
{
  "error": "rate limit exceeded for ingest API",
  "code": "rate_limit_exceeded"
}
```

Monthly quota checks:

- Run after authentication and before the product handler.
- Refresh bounded `api_usage_monthly` rollups for the current org/period from
  ClickHouse before making the decision, subject to a short per-org throttle,
  then include the local process's in-memory counters. This makes enforcement a
  shared persisted guardrail with bounded staleness, not a raw request ledger.
- Free orgs are blocked when `api_requests + 1 > plan.api_requests`.
- Paid Pro/Premium orgs are allowed past the included request allowance only
  when one of these is true:
  - billing projection is `paid_active` and has Stripe customer/subscription IDs
    for metered overage reporting,
  - the org is a legacy paid/local org without a billing projection, which is
    treated as an explicit non-invoiceable compatibility entitlement.
  Paid orgs in pending, past-due, canceled, or non-billable projected states are
  blocked at the monthly allowance.
- Usage and usage-export routes remain readable when the monthly request limit
  is exceeded so admins can diagnose and upgrade. They still receive
  short-window limiter headers.
- Monthly quota errors use HTTP `429` with `code:
  "api_request_monthly_limit_exceeded"`, `Retry-After` set to seconds until the
  UTC month reset, and `X-InstantML-Monthly-RateLimit-*` headers.

Route classification:

- `OPTIONS`, platform routes, health/ready/metrics/openapi, and auth failures:
  excluded.
- `POST /projects`, `POST /runs`, `/runs/:run_id/metrics`, artifact write
  paths, import paths, demo reset, and storage test/provisioning writes:
  `ingest`, metered.
- Dashboard/list/read/export/settings routes under the data router: `general`,
  metered after auth.

Request metering:

- Count authenticated data-plane product-handler requests after the short-window
  limiter allows them, including handler-level 4xx responses. Do not count
  limiter rejections, auth failures, preflights, or platform routes.
- Aggregate counters in process memory by `(org_id, YYYY-MM, class)`.
- Flush only bounded rollup records to append-only operational records as
  `api_usage_monthly`. The first slice flushes one rollup per
  `(org_id, period, class, instance_id, minute)` when that minute is first
  observed and then at most once per configurable interval for the active
  minute. Replay takes the largest absolute count for each rollup key and sums
  rollups by `(org_id, period)`.
- Monthly quotas appear in `GET /api/usage`, warnings, pricing docs, active
  Free/non-billable blocking, and paid overage reporting.

Stripe billing:

- Paid Checkout Sessions and paid subscription updates attach three recurring
  components:
  - Base plan price.
  - Storage overage metered price using the existing retained
    GiB-month Billing Meter.
  - API request overage metered price using an exact request-unit Billing Meter.
- Storage overage remains `$0.03 / GiB-month` over the included retained storage
  pool. The first active billing slice treats this as the maximum observed
  retained overage GiB for the current UTC month and reports only positive
  deltas when that maximum grows. A later reconciliation job can replace this
  with time-weighted provider measurements without changing the subscription
  shape.
- API request overage prices are tier-specific:
  - Pro: `$2 / 1M` requests over the 25M included allowance.
  - Premium: `$1 / 1M` requests over the 150M included allowance.
- The new `POST /api/billing/usage-overage/report` endpoint computes current
  storage and request overage, subtracts the latest cumulative report for the
  current period, sends only positive deltas to Stripe meter events, and stores a
  `billing_usage_report` record. API requests are reported as exact request
  units against a decimal-cent Stripe Price (`$0.000002` per Pro request and
  `$0.000001` per Premium request), avoiding per-started-million rounding drift.
  Meter events use deterministic identifiers and Stripe idempotency keys based
  on org, period, meter, previous cumulative value, and new cumulative value.
  The existing storage-only endpoint remains as a backward-compatible alias to
  the combined report, and old storage-only report records deserialize with
  defaulted API-request fields.

## Component Impact

Backend:

- Add plan fields and rate-limit helpers.
- Add data-route middleware for short-window rate limits and request metering.
- Add `api_usage_monthly` rollup replay and usage summary fields.
- Add monthly quota checks and monthly reset headers to the rate-limit
  middleware.
- Extend Stripe Billing helpers to create/attach the API request overage meter
  and price, and to report storage/request overage deltas.

Frontend:

- Add API request usage to Settings.
- Show plan RPS/burst policy and monthly reset in Settings. Per-second reset is
  response-specific and lives in rate-limit headers, not a stable usage-summary
  timestamp.
- Include API request percent in the compact topbar usage badge.
- Keep error handling for `429` retryable; improve copy through the server
  error body. SDK retries only short-window `429` responses, not monthly quota
  `429` responses.

Python SDK:

- No public API change. The client adds internal bounded retry/backoff for
  `429` and honors `Retry-After` where present so SDK ingestion does not fail
  immediately on short-window limiter pressure.

Storage:

- No ClickHouse schema change. `api_usage_monthly` uses the existing
  append-only operational record table with bounded rollup records, not one row
  per request.

Docs:

- Update product pricing/margins, strategy, public usage/limits docs, API
  limits docs, Rust/Web READMEs, and generated OpenAPI docs only if schemas
  change.

## Data Model

New bounded operational payload:

```json
{
  "org_id": "uuid",
  "period": "2026-05",
  "rollup_key": "2026-05-23T18:42Z:general:instance-a",
  "request_count": 37,
  "class": "general",
  "instance_id": "instance-a",
  "window_started_at": "2026-05-23T18:42:00Z",
  "updated_at": "2026-05-23T18:42:17Z",
  "created_at": "2026-05-23T18:42:00Z"
}
```

`entity_id` is `<org_id>:<period>:<class>:<instance_id>:<minute>`. Replay keeps
the largest `request_count` seen for the same entity and sums entities by
`(org_id, period)`. This keeps operational replay bounded by active orgs,
classes, instances, and minutes instead of request count.

Usage summaries expose:

- `usage.api_requests`
- `limits.api_requests`
- `usage.billable.api_requests`
- `usage.billable.api_request_overage_cents`
- `usage.billable.storage_bytes`
- `plan.api_requests`
- `plan.api_request_overage_cents_per_million`
- `plan.rate_limit_rps`
- `plan.rate_limit_burst`
- `plan.ingest_rate_limit_rps`
- `rate_limits.general.requests_per_second`
- `rate_limits.general.burst`
- `rate_limits.ingest.requests_per_second`
- `rate_limits.ingest.burst`

## API Contracts

`GET /api/usage` and `GET /api/usage/export` remain schema version 1 dynamic
JSON but add fields under the existing `usage`, `limits`, `plans`, and warning
shapes.

Short-window rate-limit errors use HTTP `429` and code
`rate_limit_exceeded`. The response includes `X-InstantML-RateLimit-Scope:
second`. Monthly quota errors also use HTTP `429`, but use code
`api_request_monthly_limit_exceeded` and `X-InstantML-RateLimit-Scope:
monthly`.

Monthly quota warnings use the existing warning shape:

```json
{
  "target": "api_requests",
  "status": "approaching_limit",
  "value": 400000,
  "limit": 500000,
  "ratio": 0.8,
  "policy": "blocked_or_metered_overage",
  "blocking": true,
  "code": "api_requests_approaching_limit",
  "message": "API request usage is approaching the plan allowance."
}
```

`POST /api/billing/usage-overage/report` returns:

```json
{
  "usage_report": {
    "usage_period_start": "2026-05-01T00:00:00Z",
    "usage_period_end": "2026-06-01T00:00:00Z",
    "billable_storage_bytes": 1073741824,
    "reported_gib": 1,
    "reported_storage_gib_delta": 1,
    "billable_api_requests": 1500000,
    "reported_api_requests": 1500000,
    "reported_api_requests_delta": 1500000,
    "status": "reported"
  }
}
```

## Performance Considerations

The short-window limiter is memory-only and O(1) per request. Request usage
flushes bounded rollups, not per-request rows. In multi-instance Cloud Run,
short-window limiter capacity still multiplies by active instances, while
monthly usage visibility converges through shared operational rollup replay and
usage summaries. Monthly quota checks refresh shared rollups on a short
per-org/period throttle and then include local in-memory counters. This can
still undercount by in-flight requests and by other instances that have not
flushed their bounded rollup yet; the short-window limiter bounds that staleness.
Monthly quota checks are active product guardrails, not a replacement for
Stripe/provider reconciliation.

The limiter must not substitute for endpoint-specific bounds that already exist
or are still needed: body size, metric batch size, chart series limits, export
limits, import limits, and artifact upload limits remain separate.

## Simplicity Review

This design reuses current plan constants, usage summaries, operational replay,
Stripe Billing meters, and dashboard usage widgets. It avoids introducing Redis
or a new billing ledger while still making the end-to-end product behavior
visible: short-window limiter, monthly reset, monthly blocking, paid overage
subscription items, and reportable overage deltas.

## Failure Modes

- Per-process limits multiply when Cloud Run runs more than one active instance.
  This is acceptable for the first protective slice but must be documented and
  replaced before treating limits as security or billing controls.
- If an `api_usage_monthly` rollup fails to persist after a request is accepted,
  the request still succeeds and a warning is logged. Request usage is guardrail
  visibility, not invoice truth.
- If request usage is already over the monthly allowance, Free orgs are blocked
  for product data routes until `usage_period.reset_at` or upgrade. Paid orgs
  continue and show billable overage.
- If a Stripe overage report is retried, only positive storage/request deltas
  over the latest cumulative report are sent. Deterministic meter-event
  identifiers and Stripe idempotency keys make a Stripe-success/local-persist
  retry address the same external event instead of double-counting it.
- Unauthenticated abuse is limited by IP buckets before auth and is never shown
  as customer usage.

## Testing Plan

- Rust unit tests for plan values, token bucket behavior, route classification,
  monthly quota decisions, request usage rollup/replay, period rollover, warning
  shape, billable overage math, Stripe price/meter helper selection, and usage
  summary fields.
- Rust HTTP tests for short-window `429` headers/body, monthly `429`
  headers/body, `429` not metered, successful request metered once, legacy
  ingest route limiting, preflight exclusion, auth failure exclusion, and
  usage-route visibility above quota.
- Frontend tests for Settings displaying API request usage and topbar including
  request percent, rate limits, and monthly reset.
- Stripe smoke updates that verify paid subscriptions include storage and API
  request metered items and that usage-overage reporting stores a report.
- Run focused Rust tests, focused web tests, and at least a rendered Settings
  smoke. Run OpenAPI/doc sync only if code generation inputs change.

## Documentation Plan

- `PRODUCT_STRATEGY.md`
- `docs/product/pricing-and-margins.md`
- `docs/product/README.md`
- `docs/README.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `apps/docs/guides/export-usage-limits.mdx`
- `apps/docs/api/errors-and-limits.mdx`
- `apps/docs/api/import-export-usage.mdx`
- `apps/docs/dashboard/settings-api-keys.mdx`
- `docs/architecture/current-schemas.md`

## Alternatives Considered

- Use Redis or Memorystore now: rejected for the first slice because it adds a
  paid dependency before the product has proven the exact policy.
- Meter only Cloud Run logs: rejected because usage must appear in the existing
  org usage API and dashboard without log-export dependencies.
- Write one operational record per request: rejected after review because it
  makes replay and tenant-load costs scale with request volume.
- Treat request quota as billable immediately in the first warning-only slice:
  rejected at that time because billing controls did not exist yet. Superseded
  by this active paid-overage revision.

Revision update: the user explicitly chose active paid overage billing for this
slice. The accepted revision charges paid overage through Stripe metered prices,
still avoids raw request logs, and reports only positive deltas from bounded
rollups so the launch surface remains simple.

## Review Notes

Fresh reviewer 1:

- Finding: per-request operational records would make replay and startup scale
  with request volume.
- Risk: Pro/Premium request allowances could produce tens or hundreds of
  millions of low-value operational rows per month.
- Recommended edit: use batched or bounded org/period/class deltas, make
  monthly quota behavior warning-only in this slice, and add SDK `429`
  retry/backoff instead of claiming current retryability.
- Decision: accepted. The first slice uses bounded minute rollups and
  warning-only monthly quotas.

Fresh reviewer 2:

- Finding: multi-instance Cloud Run and auth ordering were underspecified.
- Risk: per-process counters can diverge, and auth via full handler context can
  load tenant ClickHouse records before the limiter sheds traffic.
- Recommended edit: pre-auth IP bucket, auth-only org extraction before tenant
  load, explicit route classification, and either shared aggregate reads or a
  documented first-slice limitation.
- Decision: accepted. The first slice uses pre-auth shedding, auth-only org
  extraction, bounded shared rollups, and documents that short-window limits are
  protective rather than distributed.

Fresh reviewer 3, active billing revision:

- Finding: active monthly enforcement cannot rely only on process memory, and
  paid-overage eligibility must be explicit.
- Risk: Cloud Run restarts or extra instances could undercount; paid orgs could
  exceed quotas without a billable Stripe path.
- Recommended edit: refresh shared ClickHouse rollups with bounded staleness,
  include local counters, define Free/non-billable blocking, and allow only
  active Stripe-paid or explicit legacy/local paid compatibility overage.
- Decision: accepted.

Fresh reviewer 4, active billing revision:

- Finding: overage reporting needed stronger idempotency and clearer units.
- Risk: retries could double-report Stripe usage, and per-started-million
  rounding could overcharge if reports run early.
- Recommended edit: use deterministic meter-event identifiers/idempotency keys,
  report API request overage as exact request units with decimal-cent pricing,
  define storage overage as current-month high-water retained GiB, and preserve
  backward-compatible storage report records.
- Decision: accepted.

## Coverage Exceptions

None planned.

## Decision

Proceed with the active enforcement and paid overage slice above. Monthly API
request tracking is active for both UI/reporting and Free/non-billable blocking;
short-window rate limits remain per-process protective token buckets; paid
Stripe subscriptions carry storage and API-request metered overage items.
