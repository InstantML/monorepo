# Design: API and Frontend Observability Expansion

Date: 2026-05-28

Status: Accepted for Phase 1 after review

Owner: Codex

## Summary

The first Rust observability slice made Cloud Run logs useful by emitting one
structured completion event per Rust HTTP request, safe server-error events,
and targeted workflow logs for metrics, console logs, artifacts, imports,
readiness, startup, and worker cleanup. The next useful slice should make every
API call easier to follow across browser, Rust origin, Cloud Run logs, and
Cloudflare edge logs without adding a new observability vendor.

This design adds a safe trace/correlation contract for the frontend and Rust
API. Browser-origin calls should carry a request/trace ID, the Rust request log
should classify every request as `[Control]`, `[Data]`, `[Platform]`, or
`[Unknown]` even when running in combined mode, and browser-visible errors
should surface the same request ID so support can ask a user for it. The
frontend may log safe console events because browser console output is
user-facing; those events must contain only method, redacted route path, status,
duration, code, retryability, and request ID.

The implementation stays deliberately boring: structured stdout logs in Rust,
Cloud Run/Cloudflare as the log stores, no OpenTelemetry collector, and no app
log table. Workflow-specific Rust events expand only where a single helper can
cover high-value paths without payload logging.

## Goals

- Give every frontend-origin API call a stable `x-request-id` trace value and
  expose that same value in safe frontend error messages.
- Add route-plane tags to every Rust request log:
  `[Control]`, `[Data]`, `[Platform]`, or `[Unknown]`, plus machine fields
  `route_plane` and `plane_tag`.
- Keep service-plane fields separate from route-plane fields so split Cloud Run
  services and combined local servers are both debuggable.
- Add safe frontend console visibility for API calls without exposing query
  strings, raw path tokens, request bodies, tokens, cookies, emails, artifact
  names, metric keys, metric values, config JSON, or console log contents.
- Log every handled Rust `AppError` as a sanitized structured event, not only
  5xx failures, with status, code, field, position, retryability, and a static
  safe summary.
- Defer new handler-level workflow logs until the central request/error/frontend
  correlation contract is in place and verified.
- Preserve public API shapes and avoid logging payloads.

## Non-Goals

- Do not add Datadog, Sentry, OpenTelemetry export, Loki, Vector, Grafana, or a
  new paid logging service in this slice.
- Do not store application logs in ClickHouse product tables.
- Do not log request/response bodies, query strings, bearer tokens, cookies,
  session IDs, API-key plaintext, Clerk tokens, Stripe secrets, R2 object keys,
  signed URLs, emails, artifact names, metric keys, metric values, config JSON,
  metadata JSON, note text, or user console-log line contents.
- Do not require Cloudflare Logpush to be configured for local correctness.
- Do not add a user-facing log viewer in the product UI.
- Do not make every route handler manually print ad hoc messages.

## Users and Use Cases

Support asks a user for a failed browser request:

1. The user sees a safe error message that includes `Request <id>`.
2. Support searches Cloud Run logs for `request_id=<id>` or `trace_id=<id>`.
3. The matching origin log includes method, path, route plane, service plane,
   status, latency, Cloudflare Ray ID when present, and safe error/workflow
   fields.
4. If Cloudflare edge logs are available, support searches by response
   `x-request-id` or by `cf_ray` plus time window/path/status.

An engineer debugs split control/data behavior:

1. Logs show both the deployed `service_plane` and the route's logical
   `route_plane`.
2. A combined local server still emits `[Control]` for auth/billing/admin
   routes and `[Data]` for run/metric/artifact routes.
3. A data-plane service accidentally receiving a control route can be spotted
   from `service_plane=data` with `route_plane=control` and a non-2xx status.

An engineer debugs dashboard API flakiness:

1. Browser console logs safe API events with request ID, method, path only,
   status, duration, code, and retryability.
2. The frontend never logs bodies, auth headers, search query values, or user
   content.
3. The same request ID appears in Rust origin logs.

## Proposed Design

### Trace and Request IDs

Use `x-request-id` as the practical trace ID for this slice.

- Frontend `ApiClient` generates a request ID when the caller did not provide
  one and sends it as `x-request-id`.
- The generated ID is opaque and low-cardinality enough for logs, for example
  `web_<timestamp>_<random>` or a UUID-backed value when `crypto.randomUUID()`
  is available.
- Frontend-generated, response-header, and caller-provided IDs are accepted only
  when they match a strict token rule: ASCII alphanumeric plus `._:-`, length
  `1..=128`, and no common secret-looking prefix such as bearer,
  InstantML/Stripe/GitHub/Slack token patterns. Unsafe response IDs are not
  shown to users; unsafe caller-provided IDs are replaced with a generated ID
  before logging or display.
- Rust normalizes incoming `x-request-id` before the request-id layer logs or
  echoes it. Invalid IDs are removed so `SetRequestIdLayer` generates a safe
  UUID. Tests must cover overlong IDs, control characters, email-looking values,
  bearer-looking values, and ordinary valid frontend IDs.
- Rust keeps using `SetRequestIdLayer::x_request_id` to generate IDs for
  non-frontend or legacy callers and `PropagateRequestIdLayer::x_request_id`
  to return the value on responses.
- Rust request logs emit both `request_id` and `trace_id`; for now they are the
  same value. This leaves room for a future W3C `traceparent` or OpenTelemetry
  span ID without renaming the current support key.
- Frontend errors read and sanitize `x-request-id` from the response header and
  fall back to the locally generated request ID when the header is unavailable
  or unsafe.
- CORS exposes `x-request-id` and allows frontend-origin `x-request-id` so
  direct Cloud Run/staging browser calls keep the same contract as same-origin
  Next rewrites.

### Safe Route Paths

Do not log raw paths or "path-only" URLs. Path segments can still contain share
tokens, object IDs, report share tokens, or future user-controlled slugs.

Rust and frontend logs should emit a redacted/template-like path:

- Strip query strings and fragments.
- Preserve static route segments.
- Replace dynamic IDs/tokens with stable placeholders, for example
  `/api/reports/share/:share_token`,
  `/api/reports/:report_id/blocks/:block_index/refresh`,
  `/api/orgs/:org_id/invitations/:invitation_id/resend`, and
  `/runs/:run_id/metrics`.
- Unknown long/token-like segments become `:token`; UUID-looking segments become
  `:id`. This fallback is only a safety net, not a substitute for known route
  templates.

Frontend console logs use the same safe-route helper style and must never print
the raw URL passed to `fetch`.

### Route-Plane Tags

Add a pure, segment-aware route classifier in
`apps/rust-server/src/http/observability.rs`:

- `platform`: `/health`, `/healthz`, `/readyz`, `/metrics`, `/openapi.json`,
  `/api/auth/config`.
- `control`: auth/session/device-code, invitations, billing, dashboard
  preferences, workspace views, reports, users/orgs/seats/API keys/service
  accounts.
- `data`: projects, runs, metrics, rank metrics, console logs, artifacts,
  objects, overview, summaries, comparison, export, usage, imports, demo reset,
  and customer-owned ClickHouse routes.
- `unknown`: fallback and future routes until classified.

Classification must use exact matches or segment-boundary prefixes, not naive
string prefixes. Tests should cover every current route family and guard
against false positives such as `/api/auth/configuration`.

Request spans add:

- `route_plane`: `platform`, `control`, `data`, or `unknown`.
- `plane_tag`: `[Platform]`, `[Control]`, `[Data]`, or `[Unknown]`.
- Existing `service_plane`: `combined`, `control`, or `data`.

The message names remain stable (`http_request_completed`,
`http_request_slow`, etc.). The tag is a field, not a string prefix only, so
JSON logs stay searchable.

### Frontend API Visibility

`apps/web/src/api.js` is the product API boundary. Static/docs fetches and
third-party calls may use direct `fetch`, but product `/api`, `/runs`, and
`/projects` calls should go through `ApiClient`; add or update a static test to
guard that convention with documented exceptions.

`ApiClient` should:

- Attach `x-request-id` to every request unless already provided.
- Avoid logging full URLs with query strings or raw dynamic path segments. Use a
  helper that returns redacted safe route paths from the same input sent to
  `fetch`.
- Capture duration with `performance.now()` when available.
- On success, emit a safe `console.info` event only when verbose frontend API
  logging is enabled by local storage or a public env flag.
- On failure, emit a safe `console.warn` for 4xx and `console.error` for 5xx or
  malformed/invalid responses.
- Preserve `AbortError` without console noise because route changes and
  dashboard cancellation are expected. Wrap real network failures as retryable
  `ApiError` values with `code="network_error"` and `status=0`, and update
  `isTransientApiError` to treat that code as retryable.
- Never log request bodies, response bodies, auth headers, cookies, full search
  params, emails, names, metric keys, metric values, filenames, or artifact
  URLs.
- Keep the browser-facing `ApiError.message` client-safe. It may include
  `Request <id>` because that is the support correlation value.

Suggested console payload shape:

```js
{
  event: "instantml_api_request",
  requestId,
  traceId: requestId,
  method,
  path,
  status,
  durationMs,
  code,
  retryable
}
```

Verbose success logging can be enabled by either:

- `NEXT_PUBLIC_INSTANTML_API_LOGS=1` at build time, or
- `localStorage.setItem("instantml:api-logs", "1")`.

Failures are always logged because they are the moments users and support need
to correlate. Success spam remains opt-in.

### Rust Error Events

Replace `server_error` with a more general `error_response` helper called by
`AppError::into_response`.

Fields:

- `workflow="http_error"`
- `operation="respond"`
- `outcome="failure"`
- `status`
- `code`, defaulting to `request_rejected`, `service_unavailable`, or
  `internal_server_error`
- `field` and `position` only when `field` is an allowlisted static API field
  name, never a raw JSON pointer, metric key, metadata key, config key, or
  user-provided property path
- `retryable`, true for `503`, `warehouse_unavailable`, and other explicitly
  retryable codes
- `safe_summary`, a static string derived from status/code, never
  `AppError.message()`

Level:

- `INFO` for expected non-retryable 4xx handled rejections.
- `WARN` for retryable/degraded states such as 429 and 503.
- `ERROR` for unexpected 5xx conditions.

The request span supplies method/path/trace fields, so the error event should
not duplicate payload details.

### Expanded Workflow Logs

Phase 1 does not add new handler-level workflow helpers beyond the existing
first-slice events. Central request completion, safe route tags, frontend
request IDs, and sanitized error events already provide coverage for every API
call.

Before coding, audit the existing metric, console-log, artifact, import,
readiness, startup, and worker events against the no-payload/no-name policy.
Regression tests should ensure helpers do not expose metric keys/values,
console contents, artifact names, object keys, query strings, or request bodies.

Phase 2 can add more typed, batch-level workflow helpers where they cover
important paths without per-route boilerplate explosion:

- `auth_outcome`: Clerk/dev sign-in, logout, switch-organization, device-code
  confirm/poll/start. Safe fields: operation, outcome, status, code,
  retryable, org_id when available, and coarse booleans/enums such as
  `session_created`, `has_org`, `org_selected`, and `storage_ready`. No emails,
  Clerk IDs, role labels, detailed membership status, tokens, invite tokens, or
  session IDs.
- `run_mutation_outcome`: create run, update run, fork run. Safe fields:
  org_id, project_id, run_id when known, operation, idempotency present,
  status/code/retryable.
- `project_mutation_outcome`: create project. Safe fields: org_id,
  project_id when known, operation, status/code/retryable. No project names.
- `rank_metric_ingest`: mirror scalar metric ingest at batch level. Safe
  fields: org_id, run_id, rank, metric_count, inserted, idempotency present.
- Keep existing metric, console-log, artifact, import, readiness, startup, and
  worker events.

Do not add read-path workflow logs for every dashboard query. Every read path is
already covered by request completion logs. Add detailed read workflow logs
later only for expensive fan-out or warehouse wake failures.

### Cloudflare and Cloud Run

The Cloudflare plan from `2026-05-21-rust-server-observability.md` remains the
hosted capture plan. This design strengthens the join key by ensuring the web
client supplies `x-request-id` before the request enters Cloudflare.

Operators should still prefer:

- Cloud Run logs for Rust origin request/workflow/error events.
- Cloudflare Log Explorer/Logpush for edge status, Ray ID, path, host, and the
  request `x-request-id` header where plan support exists.
- Cloudflare response-header `x-request-id` capture as a secondary lookup path;
  it may be absent when Cloudflare rejects or fails a request before origin
  response.

## Component Impact

Backend:

- Extend `http::observability` with route-plane classification, trace ID alias,
  safe request ID handling, redacted route paths, frontend-safe header
  extraction, and `error_response`.
- Update CORS to allow and expose `x-request-id`.
- Audit existing typed workflow helpers for field safety; defer new helpers.
- Add narrow workflow helpers for reviewed zero-visibility mutation paths when
  they can be implemented without payload logging.
- Keep public route shapes unchanged.

Frontend:

- Update `ApiClient` to generate/sanitize request IDs, read sanitized response
  request IDs, emit safe console events for failed requests, preserve aborts
  without noise, wrap true network failures as retryable, and support opt-in
  info events for success.
- Update tests around `ApiClient`.
- No new visible screen is introduced.

Python SDK:

- No SDK API change. SDK calls without `x-request-id` still get one from Rust.

Storage:

- No schema changes. No app logs are stored in product tables.

Docs:

- Update Rust README, Web README, root/tools docs as needed with request ID,
  route-plane tags, safe frontend logging, and local verification commands.

## Data Model

No product data model changes.

New/changed log-only fields:

- `trace_id`
- `route_plane`
- `plane_tag`
- `safe_summary`

New or changed public HTTP headers:

- Request: frontend may send `x-request-id`.
- Response: existing `x-request-id` remains and is now explicitly read by the
  frontend; CORS exposes it for direct browser calls.

## API Contracts

No JSON route shape changes.

Browser-visible errors may include the response `x-request-id` when available,
for example:

```text
Server is unavailable. Try again shortly. Request web_abc123.
```

This is already compatible with existing `ApiError` formatting and does not
change server response bodies.

## Performance Considerations

- Rust request logging remains one event per HTTP request.
- Route-plane classification is a small path-prefix match on the already
  sanitized path.
- Frontend ID generation and console logging are O(1) per request. Successful
  call logs are opt-in to avoid noisy production browser consoles.
- Workflow logs remain per request/batch, not per metric point, artifact byte,
  console line, or selected run.
- CORS changes add no storage or database work.

## Simplicity Review

This is the smallest useful expansion because it strengthens the existing
Cloud Run/Cloudflare logging path instead of adding an observability backend.
It centralizes most behavior in two choke points: Rust HTTP observability and
frontend `ApiClient`. Handler-level additions are limited to mutations where
workflow status materially helps incident triage.

Deferred:

- W3C `traceparent` propagation.
- OpenTelemetry spans and collectors.
- Cloudflare Worker/Tail Worker edge proxy.
- Frontend beacon ingestion endpoint.
- Detailed read-path workflow logs for every dashboard query.
- Hashing metric keys/names for searchable but non-raw diagnostics.

## Failure Modes

- Browser cannot read `x-request-id` because an old backend does not expose it:
  frontend falls back to its generated request ID; origin logs still include it
  if the request header was allowed.
- Direct API client spoofs `x-request-id`: logs treat it as caller-supplied
  correlation, not identity or authentication; unsafe values are replaced before
  propagation.
- A route is misclassified as `unknown`: request logs still exist; tests should
  cover representative control/data/platform paths and docs should remind
  contributors to extend classification for new route families.
- A route path contains a future sensitive path segment: known templates and
  fallback redaction reduce exposure; code review must reject raw path logging.
- Console logs become noisy: success logs are opt-in; failures are limited to
  safe summaries.
- A developer adds a sensitive field to logs: review and tests should enforce
  path-only URLs, no bodies, and allowed field names.
- Frontend fetch fails before a response exists: console event uses the local
  request ID and status `0`; `ApiError` still shows a safe network failure.

## Testing Plan

- Rust unit tests for safe route redaction/template paths, route-plane
  classification, plane tags, and `trace_id` alias behavior. Include
  share-token paths, query stripping, ordinary ID paths, and false-positive
  prefix paths.
- Rust unit tests for strict request ID normalization and replacement of unsafe
  caller-provided values.
- Rust unit tests for error field sanitization and retryability mapping.
- Rust integration assertions for CORS preflight with
  `Access-Control-Request-Headers: x-request-id` and cross-origin responses
  exposing `x-request-id`.
- Frontend Node tests for `ApiClient` generated `x-request-id`, response-header
  request ID extraction, unsafe response ID fallback, redacted safe logging,
  opt-in success logging, always-on failure logging, silent aborts, retryable
  network failures, and static product API boundary coverage.
- `npm run rust:fmt:check`
- `npm run rust:test`
- `npm run test:node`
- Local Rust/ClickHouse smoke against `npm run dev:api` or a dedicated harness:
  run with `INSTANTML_LOG_FORMAT=json`, capture Rust stdout, parse JSON log
  events, hit representative control and data endpoints with a custom
  `x-request-id`, and assert logs include `trace_id`, `request_id`,
  `plane_tag`, `route_plane`, request completion, and safe error events while
  omitting query/body/raw token fields.

## Documentation Plan

- Update `docs/design/2026-05-21-rust-server-observability.md` or this doc's
  decision section with accepted follow-up scope.
- Update `docs/design/README.md`.
- Update `apps/rust-server/README.md` Observability section.
- Update `apps/web/README.md` with frontend API logging safety and request ID
  behavior.
- Update `tools/README.md` if local verification commands or env vars change.

## Alternatives Considered

- Add OpenTelemetry now: rejected because it adds a collector/exporter and a
  new operational dependency before the current Cloud Run logs are fully
  usable.
- Log all frontend successes unconditionally: rejected because browser console
  output is user-facing and would be noisy for the dashboard.
- Add per-route manual logs everywhere: rejected because it is brittle and easy
  to leak payloads. Request completion logs plus typed workflow helpers provide
  better coverage.
- Store logs in ClickHouse: rejected because product data tables should not
  become an app-log backend in this slice.

## Review Notes

Fresh reviewer 1:

- Finding: Path-only logging can leak dynamic path segments such as report share
  tokens; the first slice was too wide because new handler-level workflow
  helpers are not needed for all-API visibility.
- Risk: Sensitive tokens could appear in Cloud Run/browser logs, and touching
  many handlers would increase the chance of log-policy drift.
- Recommended edit: Require route templates/redacted paths, narrow Phase 1 to
  central request/error/frontend correlation, and move new workflow helpers to
  Phase 2.
- Decision: Accepted. The design now requires safe route paths and narrows the
  implementation slice.

Fresh reviewer 2:

- Finding: Caller-controlled `x-request-id` and raw path segments need strict
  sanitization before they become user-facing or searchable logs.
- Risk: A malicious or accidental request ID/path token could leak emails,
  bearer-looking strings, or token material into logs and UI messages.
- Recommended edit: Enforce a token charset/length, replace invalid IDs, log
  redacted route templates, restrict validation field logging to static fields,
  and audit existing workflow events.
- Decision: Accepted. The design now adds strict ID normalization, route
  redaction, static-field-only error logging, and an existing-event audit.

Fresh reviewer 3:

- Finding: Frontend network errors and aborts need explicit handling, CORS needs
  preflight coverage, route classification should be segment-aware, and local
  verification should parse JSON logs instead of relying on manual inspection.
- Risk: Retry logic could regress, expected aborts could spam console errors,
  direct Cloud Run browser calls could lose request ID visibility, and route
  tags could drift.
- Recommended edit: Preserve aborts, wrap real network failures as retryable
  `network_error`, test CORS preflight/exposed headers, make classifier tests
  segment-aware, and parse captured logs in local verification.
- Decision: Accepted. The design now includes those requirements.

Post-implementation review pass:

- Finding: Several important paths still had low visibility or unsafe edge
  cases: rate-limit rejections, rank metric ingest, project/run mutations,
  secret-looking request IDs, arbitrary billing path tails, and raw
  `AppError.message()` in warning logs.
- Risk: Incidents could lack a typed workflow event, and secret-like caller
  values could be echoed into user-facing errors or logs.
- Recommended edit: Add targeted sanitized workflow logs, reject
  secret-looking request IDs in Rust and frontend code, make rate-limit errors
  retryable in log fields, template only known billing routes, and replace raw
  warning messages with safe error facts.
- Decision: Accepted as a narrow hardening slice because it closes concrete
  zero-visibility gaps without adding payload logging or a new logging backend.

## Coverage Exceptions

None expected.

## Decision

Accepted for Phase 1 after reviewer-requested revisions:

- Safe request ID generation/normalization.
- Redacted route path/template logging.
- Route-plane tags and trace ID aliases on every Rust request.
- Sanitized `AppError` events for all handled errors.
- Sanitized rate-limit, project/run mutation, and rank-metric ingest workflow
  events.
- Frontend `ApiClient` correlation, safe console logging, abort/network-error
  handling, and request ID user-facing messages.
- CORS allow/expose support for `x-request-id`.

Broad per-route handler logging remains deferred; only reviewed mutation paths
with concrete visibility gaps are included in this phase.
