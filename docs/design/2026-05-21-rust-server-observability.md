# Design: Rust Server Observability

Date: 2026-05-21

Status: Accepted for narrowed first slice

Owner: Codex

## Summary

InstantML has the product loop, but backend failures are still harder to debug than they should be. The first useful observability slice should make the Rust server emit structured, low-cardinality logs for every HTTP request and a narrow set of high-value product workflows, then document how to correlate those origin logs with Cloudflare edge logs when the hosted API is proxied through Cloudflare.

The smallest implementation stays inside `apps/rust-server`. It does not add a new logging vendor, a trace collector, or a database table. The Rust service already uses `tracing`, `tower-http`, and `INSTANTML_LOG_FORMAT=json` in Cloud Run deploys. This change will make that path useful by standardizing request fields, carrying Cloudflare Ray IDs from the `cf-ray` header into origin logs, logging workflow outcomes without payloads or secrets, and updating deployment/docs so operators know what to capture in Cloudflare.

Cloudflare should capture edge/request logs, not Rust process stdout. Origin logs remain structured stdout in Cloud Run or whatever container host runs the Rust server. The primary application correlation key is `x-request-id`. Cloudflare Ray ID is an edge correlation key when Cloudflare proxies the request, but it is not guaranteed unique, so operators must pair it with time window, host, path, status, and preferably `x-request-id` when Cloudflare custom response-header fields are configured. Cloudflare Logpush or Log Explorer can capture HTTP request fields such as `RayID`, status, path, host, and selected custom request/response headers; the origin logs include the matching observed `cf_ray` and `request_id` fields.

Relevant Cloudflare docs checked on 2026-05-21:

- [Cloudflare Ray ID](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/)
- [Cloudflare Logpush](https://developers.cloudflare.com/logs/logpush/)
- [HTTP requests Logpush dataset](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)
- [Logpush HTTP destination](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/http/)
- [Logpush R2 destination](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/)
- [Cloudflare Log Explorer](https://developers.cloudflare.com/log-explorer/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/)

## Goals

- Emit one structured request completion event per Rust HTTP request with method, sanitized path, status, latency, service plane, `x-request-id`, and optional `cf-ray`.
- Log important workflow events for the narrowed first slice: startup/readiness, sanitized server errors, metric ingestion, console-log ingestion, artifact upload/download, and import outcomes. Defer the broader auth/admin/dashboard/run-read workflow matrix.
- Keep logs safe: no bearer tokens, cookies, API-key plaintext, Clerk tokens, artifact object keys, user emails, request bodies, metric values, console log messages, signed URLs, or Cloudflare/R2 credentials.
- Make hosted Cloud Run JSON logs easy to search by safe identifiers such as `org_id`, `project_id`, `run_id`, `artifact_id`, `import_id`, `request_id`, and observed `cf_ray`.
- Document a Cloudflare capture plan that joins edge logs and origin logs without requiring a new app service in this slice.

## Non-Goals

- Do not add distributed tracing, OpenTelemetry export, Sentry, Datadog, Grafana, Loki, Vector, or another paid logging backend in this first slice.
- Do not store application logs in ClickHouse product tables.
- Do not log full request/response bodies or user-generated training log content.
- Do not add a Cloudflare Worker proxy in this slice.
- Do not change public API route shapes.
- Do not add frontend UI for internal server logs.

## Users and Use Cases

Operators debug a production incident:

1. A user reports an error with `x-request-id` from the response or a browser-visible Cloudflare Ray ID.
2. The operator searches Cloud Run logs for `request_id` or `cf_ray`.
3. If Cloudflare is in front of the hosted API, the operator searches Log Explorer or Logpush storage for the matching `RayID`.
4. The joined view explains the edge status, origin status, route, latency, org, workflow, and sanitized failure code.

Developers debug product workflows locally:

1. Run the Rust server with `INSTANTML_LOG_FORMAT=pretty` for readable logs.
2. Set `RUST_LOG=instantml_rust_server=debug,tower_http=info` when deeper diagnostics are needed.
3. Reproduce the workflow and read workflow events without sensitive payloads.

Support triages SDK ingestion issues:

1. Search for `run_id`, `project_id`, or `org_id`.
2. Inspect metric/log ingestion events for batch sizes, idempotency use, inserted counts, and plan-limit or warehouse failures.
3. Avoid inspecting scalar metric values or console log messages in internal logs.

## Proposed Design

### Log Levels

- `INFO`: service startup/shutdown milestones, request completions, successful mutating workflows, successful tenant provisioning/loading, worker cleanup counts.
- `WARN`: retryable/expected degraded states such as background control refresh failures, warehouse unavailable, missing artifact bytes, non-2xx Cloudflare/R2 responses, request latency above a conservative threshold.
- `ERROR`: 5xx responses, storage failures, unexpected internal errors, failed metadata commit after byte upload.
- `DEBUG`: optional read-path detail that could be noisy, enabled only through `RUST_LOG`.

### Request Logs

Replace the default `TraceLayer::new_for_http()` behavior with a small local `http::observability` helper that builds an `http_request` span and completion event.

Fields:

- `method`
- `path`: path only, no query string.
- `version`
- `request_id`: from `x-request-id`, generated by the existing request-id layer when missing.
- `cf_ray`: from `cf-ray` when present.
- `cf_connecting_ip_present`: boolean only; never log the IP.
- `user_agent_family`: optional coarse category such as `browser`, `python-sdk`, `curl`, `unknown`; never log full user-agent strings in this slice.
- `status`
- `latency_ms`
- `service_plane`

Rules:

- Log one completion event for every request.
- Use `INFO` for status below 500, `ERROR` for 500+.
- Add a `WARN` event for slow requests over `INSTANTML_SLOW_REQUEST_MS`, default `1000`.
- Do not log query strings because search terms, artifact names, and cursors can contain user data.
- Normalize correlation headers before logging: only printable ASCII, max 128 bytes for `x-request-id`, max 128 bytes for observed `cf-ray`, otherwise log them as absent. Direct Cloud Run traffic can spoof both headers, so log names should say `cf_ray` means observed request header, not verified Cloudflare provenance.

### Error Logs

Keep public JSON errors sanitized. Improve internal error events by logging:

- `status`
- `code`, defaulting to `internal_server_error` when no stable code exists
- `error_kind`, derived from status and stable code
- `retryable`, true only for `503` or `warehouse_unavailable`
- `safe_summary`, a static string such as `server_error`, `warehouse_unavailable`, or `service_unavailable`

The request span supplies method/path/request correlation. Do not add raw request data to `AppError`.

Do not log `AppError.message()` for server errors in production logs because provider errors can include endpoints, storage paths, object keys, SQL, or user data. Raw internal messages remain available only through explicit local debugging, not the default JSON event contract.

### Workflow Logs

The reviewed first slice adds compact outcome events near a small set of route/store boundaries:

| Workflow | Event fields |
| --- | --- |
| Startup/migrate | `service_plane`, `bind_addr`, `auth_mode`, `artifact_backend`, `hosted_clickhouse_enabled` |
| Readiness failure | `service_plane`, `status`, `code`, `store` |
| Metric ingestion | `workflow`, `operation`, `outcome`, `stage`, `org_id`, `run_id`, `metric_count`, `inserted`, `idempotency_key_present`, `duplicate_request` when known |
| Console log ingestion | `workflow`, `operation`, `outcome`, `stage`, `org_id`, `run_id`, `stream`, `line_count`, `inserted`, `idempotency_key_present`, `duplicate_request` when known |
| Artifacts | `workflow`, `operation`, `outcome`, `stage`, `org_id`, `run_id`, `artifact_id`, `artifact_type`, `storage_backend`, `size_bytes`, `range_requested` |
| Imports | `workflow`, `operation`, `outcome`, `stage`, `org_id`, `source`, `dry_run`, `project_id`, `run_count`, `metric_count`, `artifact_count` |
| Worker cleanup | `expired_idempotency`, `expired_sessions`, `usage_snapshots` |

Field hygiene:

- Stable product IDs are okay. Session tokens, session IDs, API keys, and bearer tokens are not okay.
- Emails, tokens, API-key plaintext, object storage paths, signed URLs, raw metric keys from user payloads, raw query strings, project names, run names, config JSON, metadata JSON, note text, console line messages, and artifact filenames are not logged.
- Metric key presence is enough on high-volume read/write paths. Where a key is needed for debugging, log a short stable hash in a later slice.
- Route handlers should use typed helper functions from `http::observability` for first-slice workflow events rather than ad hoc `tracing::info!` calls with user payload fields.

### Cloudflare Capture Plan

Use Cloudflare as the edge/request log source:

- If the hosted API domain is proxied by Cloudflare, configure Log Explorer or Logpush for the zone-scoped `http_requests` dataset.
- Include fields where the Cloudflare plan supports them: `RayID`, `ClientRequestHost`, `ClientRequestMethod`, path-only request field such as `ClientRequestPath`, `EdgeResponseStatus`, `OriginResponseStatus`, `EdgeStartTimestamp`, `EdgeEndTimestamp`, `EdgeColoCode`, and selected `ResponseHeaders` custom fields for `x-request-id`.
- Avoid full `ClientRequestURI` in normal Logpush jobs because it can include query strings with search terms, cursors, names, or accidental secrets. If a Cloudflare plan/dataset exposes only full URI, treat edge logs as more sensitive than origin logs and require restricted retention/access or a separately reviewed emergency/debug job.
- Verify plan support for the `http_requests` dataset fields before relying on them. Custom request/response headers such as `ResponseHeaders.x-request-id` must be configured as Cloudflare custom fields ahead of time.
- If long-term archive is needed and an existing SIEM is not available, push Logpush output to a dedicated R2 prefix such as `cloudflare-logs/http_requests/api.instantml.ai/{DATE}`. R2 is already part of the product stack.
- If an HTTP destination is chosen instead, the destination must be HTTPS, accept `POST`, and authenticate Cloudflare log pushes with a header or token in the destination configuration.
- For non-Enterprise Cloudflare zones, do not depend on `http_requests` Logpush. Either use Log Explorer availability for the plan, keep origin logs in Cloud Run, or design a future Cloudflare Worker/Tail Worker edge proxy. Workers Logs are short-retention and request-volume priced, so a Worker proxy should be a separate design.

Join workflow:

- User has `x-request-id`: search origin logs directly, then search Cloudflare `ResponseHeaders.x-request-id` when configured.
- User has Cloudflare Ray ID: search origin logs for observed `cf_ray`, then narrow Cloudflare logs by `RayID`, time window, host, path, and status. Do not rely on Ray ID alone.
- User has neither: search by time window, path, status, org/run IDs, and approximate latency.

### Deployment Defaults

Existing deploy helper behavior already sets `INSTANTML_LOG_FORMAT=json` for Cloud Run. Add docs, not a new deploy flag, for:

```text
RUST_LOG=instantml_rust_server=info,tower_http=info
INSTANTML_LOG_FORMAT=json
INSTANTML_SLOW_REQUEST_MS=1000
```

For local development, keep `pretty` default.

## Component Impact

Backend:

- Add `src/http/observability.rs` for request span/completion helpers and typed first-slice workflow outcome helpers.
- Update `src/http/mod.rs` to use the custom TraceLayer.
- Add `INSTANTML_SLOW_REQUEST_MS` to config.
- Add workflow logs only for startup/readiness, sanitized server errors, metric ingestion, console-log ingestion, artifact upload/download, import outcomes, and worker cleanup. Defer the broader matrix.
- Keep public errors and route shapes unchanged.

Frontend:

- No frontend behavior change in this slice.
- Existing `x-request-id` response header remains the support correlation ID.

Python SDK:

- No SDK API change.
- SDK requests continue to carry bearer auth and optional idempotency keys.

Storage:

- No schema change.
- No product table stores app logs.

Docs:

- Update root/Rust/architecture/tools/design docs with logging fields, Cloudflare capture, and local/hosted commands.

## Data Model

No product data model changes.

New config field:

- `INSTANTML_SLOW_REQUEST_MS`: unsigned integer, default `1000`. Requests whose completion latency is at or above this threshold emit a `WARN` slow-request event.

## API Contracts

No public API contract changes.

Existing response header behavior remains important:

- `x-request-id` is generated when missing and propagated on responses.

Operators should configure Cloudflare custom fields for `x-request-id` where the plan supports response-header capture, but the application does not require that for correctness.

## Performance Considerations

- One request completion event per HTTP request is O(1) and acceptable for the current hosted traffic target.
- Workflow outcome events are low volume except metric and console-log ingestion. Ingestion logs one event per request batch, not per metric point or per console line.
- No log writes are synchronous network calls from the app; the Rust service emits stdout/stderr to the host runtime.
- JSON logs may increase Cloud Run log volume. Keep high-volume read details at `DEBUG` and omit payloads.
- Slow-request warning threshold is configurable so production can tune noise without a code change.

## Simplicity Review

This is the simplest useful observability step because it improves the existing `tracing` stack and Cloud Run JSON logs instead of adding an external collector. It uses Cloudflare for the edge logs Cloudflare can actually see and uses correlation IDs to join to app logs. After review, the first slice is narrowed to request/error correlation and the highest-value workflow events so the change does not touch every product path at once.

Deferred:

- OpenTelemetry traces and spans exported to a collector.
- Prometheus counters/histograms beyond the current `/metrics` placeholder.
- Sentry-style error grouping.
- Cloudflare Worker/Tail Worker edge proxy.
- Application-log archival to R2.
- Hashing high-cardinality names/metric keys for search-safe diagnostics.
- Auth/admin/dashboard/run-read workflow events.

## Failure Modes

- Cloudflare is not proxying the API: no `cf-ray` header appears; origin logs still have `request_id`.
- Cloudflare Logpush job is disabled or unhealthy: edge logs can be lost because Logpush does not backfill. Origin logs still exist in Cloud Run.
- Cloudflare plan does not support HTTP request Logpush/custom fields: use Cloud Run logs and a future Worker edge design if Cloudflare-native capture is required.
- Logs become noisy under high metric ingestion: tune `RUST_LOG`, keep ingestion logs batch-level, and lower read-path details to `DEBUG`.
- A sensitive field is accidentally added: tests and docs should enforce the logging field allowlist; code review should reject payload/body/token logging.
- Request latency warning threshold is too low: adjust `INSTANTML_SLOW_REQUEST_MS` without redeploying code.
- Direct-origin clients spoof `cf-ray` or `x-request-id`: normalized logs still mark them only as observed headers. Operators should rely on Cloudflare logs only for traffic known to pass through Cloudflare.

## Testing Plan

- Unit tests for user-agent categorization, Cloudflare header extraction, request ID normalization, request path sanitization, and slow-request config parsing.
- Rust unit tests for `AppConfig::from_env` validation defaults where practical.
- `cargo fmt --manifest-path apps/rust-server/Cargo.toml --all -- --check`
- `npm run rust:lint`
- `npm run rust:test`
- `npm run test:contract` if time and local ClickHouse allow it.

No coverage exception is expected because the new helper logic is pure and local.

## Documentation Plan

- `README.md`: mention structured Rust logs and Cloudflare correlation.
- `apps/rust-server/README.md`: document log format, log fields, safe field policy, slow request threshold, and Cloudflare Ray correlation.
- `docs/architecture/current-system.md`: add current observability topology.
- `docs/architecture/multi-instance-cloud-run.md`: add operational logging/correlation notes for split control/data services.
- `tools/README.md`: note deploy helper keeps hosted JSON logs enabled and describe Cloudflare capture setup.
- `docs/design/README.md`: list this design after acceptance.

## Alternatives Considered

- Add OpenTelemetry now: richer long term, but it adds collector/exporter choices before logs are even useful.
- Send Rust logs directly to Cloudflare R2: possible through a sidecar or host pipeline, but Cloud Run stdout is the native origin-log path and there is no sidecar in the current deployment.
- Put a Cloudflare Worker in front of Cloud Run now: useful for non-Enterprise Cloudflare-native edge logs, but it changes the public request path and deserves its own routing/auth/cost design.
- Store server logs in ClickHouse: rejected because product ClickHouse should stay focused on user data, metrics, and operational records.
- Log all request bodies on failures: rejected because SDK metrics, config, metadata, and console logs are user data and can be sensitive.

## Review Notes

Fresh reviewer 1:

- Finding: The first slice was too broad and would touch too many workflows at once; Cloudflare `ClientRequestURI` could log query strings; raw internal errors could leak provider details; `cf-ray` and client request IDs need trust-boundary normalization.
- Risk: Regression surface and privacy leakage.
- Recommended edit: Narrow to request/error correlation plus startup/readiness, metric/log ingestion, artifact, and import outcomes; use typed helpers; avoid full URI; sanitize server errors.
- Decision: Accepted. Design narrowed before implementation.

Fresh reviewer 2:

- Finding: Production incident response needs stage/outcome failure events, but raw `AppError.message()`, `session_id`, and raw `project` fields are unsafe.
- Risk: Logs could expose sessions, project names, object keys, provider URLs, or user payload fragments while still failing to identify the failure stage.
- Recommended edit: Replace raw messages with `code`, `error_kind`, `retryable`, and static summaries; drop `session_id` and project names; add `workflow`, `operation`, `outcome`, and `stage`.
- Decision: Accepted. First-slice workflow events use safe IDs and sanitized outcome fields.

Fresh reviewer 3:

- Finding: Origin-vs-edge split is sound, but `ClientRequestURI` contradicts no-query logging and Ray ID is not unique enough to be a sole join key.
- Risk: Edge logs may retain sensitive query strings; Ray-only correlation may misattribute incidents.
- Recommended edit: Prefer `ClientRequestPath`, document plan/custom-field requirements, and pair Ray ID with time/host/path/status plus `x-request-id`.
- Decision: Accepted. Cloudflare plan revised.

## Coverage Exceptions

None.

## Decision

Accepted for the narrowed first slice after three fresh reviews. Implementation should not add the broader workflow matrix until a follow-up review.
