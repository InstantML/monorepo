# Design: Durable Async SDK Logging

Date: 2026-05-25

Status: Revised after fresh review

Owner: Codex

## Summary

InstantML should replace the old SSE/live-run streaming PR direction with a
durable async logging slice inspired by Neptune Scale's client architecture:
validated training-loop events are written to a local SQLite WAL queue first,
logging calls return without waiting on the network, and a separate uploader
process continuously drains the queue to the existing Rust REST API.

The first slice is intentionally narrower than Neptune's full operation log. It
supports the hot paths that are already idempotent enough to retry safely:
scalar metrics, rank metrics, console logs, and run finish status. Rich objects,
attributes, artifact uploads, and response-chaining media helpers stay on the
existing sync/process-spool paths until their server contracts are idempotent.

Browser "somewhat live" behavior comes from bounded summary polling plus SDK
upload-health metrics. There is no SSE or WebSocket in this design. Persisted
REST reads remain the UI source of truth.

## Goals

- Add opt-in `upload_mode="async"` for metric/log hot paths.
- Store async events in a per-run SQLite WAL queue with sequence IDs, byte
  sizes, idempotency keys, retry state, leases, and local status.
- Start a separate SDK-managed uploader process after run creation succeeds.
- Keep delivery/network/API errors out of training-loop `log_metrics()`,
  `log_rank_metrics()`, `log_console()`, and `finish()` calls.
- Drain by byte budget without deadlocking oversized first events.
- Add `Run.upload_status()`, `Run.wait_for_submission()`, and
  `Run.wait_for_processing()`.
- Add `instantml-uploader --queue-dir ...` recovery for orphaned async queues.
- Add a minimal upload-health UI chip backed by silent, visibility-gated
  summary polling.
- Preserve existing `sync`, `buffer_size`, `offline_dir`, and
  `upload_mode="spool"` behavior.

## Non-Goals

- Do not add SSE, WebSockets, or browser event streams.
- Do not add a new Rust batch-ingest endpoint.
- Do not make run creation offline-capable; `init()` still needs the API.
- Do not make artifact uploads direct-to-object-storage.
- Do not support async rich media response chaining.
- Do not flip the default from `sync` to `async` in this PR.
- Do not add one-click cluster/job restart.
- Do not make SDK upload-health metrics non-billable or server-reserved.

## Users and Use Cases

Training engineers running long jobs want metric and log calls to avoid blocking
on transient API/network failures. If a connection drops, data should queue
locally and retry instead of stopping the actual training run.

Dashboard users want an honest signal that recent metrics are arriving and the
SDK uploader is not badly behind. A small upload-health chip is enough for the
first slice.

## Proposed Design

### Upload Modes

Keep existing modes:

- `sync`: direct REST calls. Errors raise as today.
- `spool`: fsynced JSON event files for a user-managed uploader process.

Add:

- `async`: SQLite queue plus SDK-managed background uploader process.

`async` remains opt-in until benchmarks and UI verification establish overhead
and failure behavior.

### Allowed Route Matrix

Async v1 only queues routes with acceptable retry behavior:

| SDK operation | Route | Async behavior |
| --- | --- | --- |
| `log_metrics` / metric part of `log` | `POST /runs/:id/metrics` | queued, stable `Idempotency-Key` |
| `log_rank_metrics` | `POST /runs/:id/rank-metrics` | queued, stable `Idempotency-Key` |
| `log_console`, `log_stdout`, `log_stderr` | `POST /api/runs/:id/logs` | queued, stable `Idempotency-Key` |
| `finish` | `PATCH /runs/:id` | queued, at-least-once status set |
| attributes/config/text/histogram/tags/notes | mixed | sync for now |
| objects/artifacts/uploads/media | mixed | existing sync/spool behavior |

This means async mode is a durable metric/log mode first. Unsupported
response-returning helpers must not pretend to be durable async until their
server contracts support idempotent replay.

### Queue Repository

Create `packages/python-sdk/instantml/async_queue.py`, following Neptune's
clean split between a repository and uploader worker.

One SQLite database is created per run under:

```text
.instantml/async/<safe-run-id>/queue.sqlite3
```

Producer connection settings:

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 100`

Uploader connections may use a longer timeout, but producer enqueue must stay
bounded. The parent hot path target is p95 under 2 ms for normal metric payloads
on a local SSD. If enqueue cannot complete within the short timeout, the SDK
rate-limits a warning, increments an in-memory dropped-event counter, and
continues the training loop.

Queue bounds:

- default max queue bytes: `512 MiB`
- default min free disk bytes: `64 MiB`
- default max event bytes: `1 MiB` for async v1
- processed retention: keep newest `1,000` processed events per run

When bounds are exceeded, new async events are dropped with a warning and the
drop count appears in `upload_status()`. A future strict mode can raise on local
durability failures, but default async must not stop training.

### State Machine

The first slice does not persist a separate `submitted` status. Instead it uses
leases:

- `pending`: eligible for upload when `next_attempt_at <= now`.
- `in_flight`: claimed by one uploader with `lease_token` and `leased_until`.
- `processed`: client observed a 2xx response.
- `failed`: terminal local failure that should not retry automatically.

Uploader startup recovers stale leases by moving expired `in_flight` rows back
to `pending`. `wait_for_submission()` waits until there are no `pending` rows.
`wait_for_processing()` waits until there are no `pending` or `in_flight` rows.
Both return `False` if terminal failures exist or if the timeout expires.
Because Rust currently processes REST requests synchronously, `processed` means
"the client observed HTTP success," not exactly-once durable server processing.

Delivery semantics are at-least-once with bounded server idempotency where the
existing Rust routes support it.

### Retry Classification

Uploader errors are classified by HTTP status and decoded error code:

| Response | Behavior |
| --- | --- |
| network timeout/connect/read error | retry with exponential backoff and jitter |
| `408`, `409`, short-window `429 rate_limit_exceeded`, `5xx` | retry; honor `Retry-After` |
| monthly API request limit, `plan_limit_exceeded`, `payment_required` | mark `failed` |
| `401`, `403` | mark `failed` |
| `400`, validation errors | mark `failed` |
| unknown malformed response | retry a bounded number of times, then `failed` |

Rows store `attempts`, `last_attempt_at`, `next_attempt_at`, `last_error`,
`last_error_code`, and `last_http_status`. Backoff caps at 60 seconds.

### Byte-Budget Draining

The uploader selects eligible rows in sequence order until the cumulative
`body_size_bytes` reaches `max_batch_bytes` (default `1 MiB`). If the first
eligible row is larger than `max_batch_bytes` but no larger than
`max_event_bytes`, the uploader still sends it alone. If a row exceeds
`max_event_bytes`, it becomes `failed`.

### Background Uploader

Async run creation starts the uploader after the real `run_id` is known. Use a
separate Python subprocess that imports the queue worker directly, not
`multiprocessing.spawn`. This avoids re-importing user training scripts, which
can otherwise rerun top-level training code unless users add a main guard. Pass
only primitive process arguments:

- queue DB path
- base URL
- API key
- timeout
- run ID
- parent PID
- byte limits and poll intervals

If the process cannot start, logging calls still enqueue and `upload_status()`
shows pending growth. The user can drain later with the queue CLI.

The uploader exits after `finish()` requests stop and the queue is drained, or
when the parent PID disappears. It uses short transactions for status changes
and performs HTTP outside SQLite write locks.

### Recovery CLI

Extend `instantml-uploader`:

```bash
instantml-uploader --queue-dir .instantml/async --base-url http://127.0.0.1:8000
```

The command discovers `*/queue.sqlite3` files, recovers stale leases, drains
them once, and exits. `--follow` can keep draining. It uses a lock file beside
each queue DB so only one uploader drains a queue at a time.

### Upload Health Metrics

The uploader emits bounded health metrics at startup, on state changes, and at
most once every 5 seconds:

```text
system/instantml/upload_health_unix_seconds
system/instantml/upload_lag_seconds
system/instantml/queued_events
system/instantml/processed_events
system/instantml/failed_events
system/instantml/dropped_events
```

These are ordinary billable metric points in v1. They are SDK-convention keys,
not Rust-reserved keys. Emission is intentionally coarse to avoid consuming
meaningful usage quota.

The UI hides `system/instantml/*` from normal metric catalogs, auto panels,
pinned metric menus, and chart defaults. The keys remain visible in raw run
detail/system JSON and upload-health chips.

### Minimal UI

Add a shared frontend helper that derives upload health from summary metrics:

- `errors`: failed or dropped events are positive.
- `syncing`: queued events are positive or lag is above the low threshold.
- `synced`: recent heartbeat, zero queued events, no failures.
- `stale`: heartbeat metric is older than the stale threshold.
- `unknown`: no health metrics exist.

Add a compact chip only to visible run rail rows in this slice. Run Detail/System
can use the same helper if it is already rendering current summary data.

Add silent, visibility-gated summary polling for the current dashboard page:

- poll every 5 seconds while the document is visible and the dashboard is
  authorized;
- abort on dependency changes/unmount;
- do not show the global loading screen or "Loading runs..." message;
- back off naturally through the existing transient retry helper.

## Component Impact

Backend:

- No new Rust routes, schemas, OpenAPI, or billing exemptions.
- Existing metric ingest receives coarse upload-health metrics.

Frontend:

- Hide internal SDK metric keys from normal metric selectors.
- Add upload-health derivation and one rail chip.
- Add silent current-page polling.

Python SDK:

- Add async queue repository and uploader process.
- Add `upload_mode="async"` validation.
- Add `Run.upload_status()`, `Run.wait_for_submission()`, and
  `Run.wait_for_processing()`.
- Add queue recovery to `instantml-uploader`.

Storage:

- SDK-local SQLite queue only.

Docs:

- Update SDK README, web README, design index, SDK TODO, and benchmark results.

## Data Model

```sql
CREATE TABLE queue_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE events (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body_json TEXT NOT NULL,
  body_size_bytes INTEGER NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at REAL,
  next_attempt_at REAL NOT NULL DEFAULT 0,
  lease_token TEXT,
  leased_until REAL,
  last_error TEXT,
  last_error_code TEXT,
  last_http_status INTEGER
);

CREATE INDEX events_status_attempt_sequence_idx
ON events (status, next_attempt_at, sequence_id);

CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER,
  created_at REAL NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

## API Contracts

Python:

```python
run = instantml.init(project="cartpole", upload_mode="async")
run.log_metrics({"reward": 1.0}, step=1)
run.upload_status()
run.wait_for_submission(timeout=30)
run.wait_for_processing(timeout=30)
run.finish(status="finished", timeout=30)
```

`finish` preserves the existing positional status argument:

```python
run.finish("failed")
run.finish(status="failed", timeout=10)
```

`upload_status()` returns:

```python
{
    "mode": "async",
    "pending": 2,
    "in_flight": 0,
    "processed": 10,
    "failed": 0,
    "dropped": 0,
    "oldest_pending_age_seconds": 1.25,
    "last_error": None,
}
```

## Performance Considerations

- Expected write frequency: 10-100 SDK logging calls/second.
- Producer enqueue target: p95 under 2 ms and p99 under 10 ms for normal metric
  events on local SSD.
- Uploader idle poll: 1 second. Busy poll: 250 ms.
- Drain byte budget: default `1 MiB`.
- Queue stress test: 100,000 queued events must keep status reads bounded.
- Failure-state CPU: API-down uploader should sleep/back off, not spin.
- WAL growth: tests or benchmark notes should record WAL size and checkpoint
  behavior after draining.

## Simplicity Review

This design keeps the first slice narrow by avoiding Rust contract changes,
browser event streams, server-side batch ingest, direct object storage uploads,
and true offline run creation. The complexity that remains is necessary for the
durability claim: local queue bounds, lease recovery, retry state, and a recovery
CLI.

## Failure Modes

- API down: events remain pending with backoff; training continues.
- API auth/quota/payment failure: events become failed; waits return `False`;
  training still continues.
- Queue DB locked: producer waits only briefly, then drops with a rate-limited
  warning and counter.
- Disk nearly full or queue over max bytes: new events are dropped with counter.
- Uploader dies: queued events remain; stale leases recover on restart/CLI drain.
- Process exits without `finish()`: queue remains on disk and `instantml-uploader
  --queue-dir` can drain it.
- Health metric upload fails: user metric data remains queued; UI may show stale
  or unknown health.

## Testing Plan

Python SDK:

- Queue schema initializes with WAL.
- Producer enqueue uses short timeout and records dropped counters.
- Events enqueue in sequence order with deterministic idempotency keys.
- Byte-budget reads include an oversized first eligible event when allowed.
- Lease claim/recovery works after stale `in_flight` rows.
- Retryable and terminal errors transition correctly.
- `wait_for_submission()` and `wait_for_processing()` success, timeout, and
  failed-row paths.
- `finish("failed")` and `finish(status="failed", timeout=...)` stay compatible.
- No foreground HTTP happens for async metric/log hot paths.
- Recovery CLI drains an orphan queue.
- Existing sync/spool tests continue to pass.

Frontend:

- Upload-health helper covers `unknown`, `synced`, `syncing`, `stale`, and
  `errors`.
- Internal metric keys are hidden from normal metric options.
- Silent polling refreshes summaries without global loading/message churn.
- Rail chip does not expand row height beyond existing bounds.

Integration and verification:

- Local Rust API + async SDK run logs metrics.
- Dashboard summary shows metrics and upload-health chip after polling.
- Computer Use/Chrome verifies visible results update without manual refresh.

Benchmarks:

- Compare sync no-op, process-spool JSON, and async SQLite queue hot-path
  latency.
- Measure uploader drain throughput and API-down backoff behavior.

## Documentation Plan

- `docs/design/README.md`
- `packages/python-sdk/README.md`
- `packages/python-sdk/TODO.md`
- `apps/web/README.md`
- `benchmarks/README.md` and a dated benchmark result

## Alternatives Considered

Keep SSE/live-run streaming:

- Rejected for this PR because it improves browser freshness but not SDK
  delivery reliability.

Use process-spool JSON as the async implementation:

- Rejected because one file per event is weaker for byte-budget drains, lag
  metrics, queue status, and high-volume scans.

Add Rust batch ingest immediately:

- Deferred until the client queue proves its value on existing routes.

Use a background thread:

- Rejected for the main mode because the user asked for a separate background
  process and Neptune's process-isolated model is the better fit for long jobs.

## Review Notes

Fresh frontend reviewer:

- Finding: The draft assumed polling that did not exist, and `latest_metrics`
  alone could not prove freshness.
- Risk: UI would not update without manual refresh, and stale health metrics
  could falsely show synced.
- Recommended edit: Add silent visibility-gated polling, a heartbeat metric,
  stale thresholds, and hide internal metric keys from normal selectors.
- Decision: Accepted. The design now adds polling, heartbeat/stale semantics,
  hidden internal keys, and narrows the UI to one rail chip.

Fresh API/Rust reviewer:

- Finding: Idempotency was underspecified and health metrics are ordinary
  billable metric writes.
- Risk: Retrying non-idempotent routes could duplicate side effects, and health
  metrics could clutter or consume quota unexpectedly.
- Recommended edit: Add an allowed-route matrix, document at-least-once
  semantics, keep Rust unchanged, and bound/hide health metrics.
- Decision: Accepted. Async v1 is limited to metrics/rank metrics/logs/finish,
  keeps Rust unchanged, and documents billing side effects.

Fresh SDK reviewer:

- Finding: Queue state, multiprocessing lifecycle, recovery, and public API
  compatibility were underspecified.
- Risk: Events could strand, process start could be fragile, and `finish` could
  break existing callers.
- Recommended edit: Add a lease state machine, process-isolated uploader,
  recovery CLI, and explicit `finish(status, timeout)` compatibility.
- Decision: Accepted. The design now includes those requirements.

Fresh performance reviewer:

- Finding: Busy timeout, queue bounds, retry state, oversized event handling,
  crash recovery, and benchmark gates were missing or unsafe.
- Risk: Logging could block for seconds, queues could grow without bounds, and
  failures could spin or silently lose data.
- Recommended edit: Use a short producer timeout, queue/disk bounds, retry
  fields, oversized-first-row handling, recovery CLI, and benchmark gates.
- Decision: Accepted. The design now captures those constraints.

## Coverage Exceptions

None planned.

## Decision

Accepted for a narrow first implementation: SDK-local async queue, process
uploader, recovery CLI, waits/status, minimal upload-health UI, silent polling,
tests, benchmarks, and docs.
