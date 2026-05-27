# Design: Async SQLite Producer Batching

Date: 2026-05-27

Status: Accepted after review

Owner: Codex

## Summary

Default async SDK logging currently commits one SQLite WAL transaction per queued
metric/log/status event. That keeps every returned `log()` call locally durable,
but local benchmarks show the producer path can cost hundreds of microseconds per
call on common laptop storage.

This design changes default async to buffered group commit. Async-supported
events are snapshotted into process memory first, then a single writer thread
persists them to the per-run SQLite queue when one of three thresholds is met:
64 events, 64 KiB of serialized payloads, or 20 ms since the oldest buffered
event. The uploader process and REST delivery semantics stay unchanged.

The tradeoff is explicit: a returned async `log()` can be lost if the Python
process dies before the short producer buffer reaches SQLite. `upload_mode="sync"`
remains the foreground-error escape hatch, while this default optimizes the MVP
training-loop hot path.

## Goals

- Reduce default async producer overhead by batching SQLite inserts.
- Preserve event order and existing uploader byte-budget draining.
- Keep async logging errors out of the training loop.
- Surface buffered producer state in `upload_status()`.
- Prove the improvement with repeatable SDK overhead benchmarks.

## Non-Goals

- Do not change Rust, REST API, OpenAPI, or frontend behavior.
- Do not add public batching knobs in this slice.
- Do not make async rich objects or artifact uploads replayable.
- Do not promise hard-kill durability for events still in the producer buffer.

## Users and Use Cases

Training engineers using default async logging want metric calls to add minimal
overhead and avoid network failures stopping training. Short scripts can call
`finish()`, `flush()`, or wait helpers to force buffered events into SQLite before
waiting for upload.

## Proposed Design

Add repository-level prepared event batching in `instantml.async_queue`:

- `PreparedQueuedEvent` stores immutable method, path, serialized JSON body,
  byte size, idempotency key, and log-call wall-clock time.
- `AsyncQueueRepository.enqueue_many_prepared()` inserts eligible events with one
  `executemany()` transaction and returns inserted/dropped counts.
- Existing `enqueue()` delegates to the prepared batch path for compatibility.

Add one private producer buffer per async `Run`:

- `Run._submit()` snapshots supported async requests and appends them to the
  buffer; SQLite I/O does not happen under `Run._lock`.
- A condition-driven writer thread owns SQLite producer flushes so insert order
  remains buffer order.
- Flush thresholds are 64 events, 64 KiB, or 20 ms. A hard cap of 4,096 events or
  4 MiB drops newest events with rate-limited warnings.
- Timer flushes retry transient SQLite busy/locked errors with bounded backoff.
  Forced flushes wait up to the caller timeout and report failure without raising
  into training code.
- `upload_status()`, `wait_for_submission()`, `wait_for_processing()`, `flush()`,
  and queue close force a local producer flush first. `finish()` flushes existing
  events, enqueues final status, flushes that status, then waits for processing.

`upload_status()` adds `buffered_events`, `buffered_bytes`, and
`last_flush_error`. It may perform a local SQLite write before returning.

## Component Impact

Backend:

- No change.

Frontend:

- No change.

Python SDK:

- Default async now uses a short in-memory producer buffer before SQLite.
- The async queue repository supports batch insert and structured enqueue
  results.
- Wait/status/finish paths force producer flushes before reading queue state.

Storage:

- Same per-run SQLite WAL file and schema.
- Fewer producer transactions; same uploader state machine.

Docs:

- Update SDK README, PyPI README, benchmarks README, and design index.

## Data Model

No SQLite schema changes. Prepared events map to the existing `events` table.

## API Contracts

No REST API changes and no public SDK parameters are added. The observable SDK
contract changes are:

- Default async `log()` means "snapshotted for local group commit," not
  "committed to SQLite before return."
- `upload_status()` includes buffered producer counts and last flush error.
- `flush()` persists buffered async events to SQLite before returning.

## Performance Considerations

Expected write frequency is one async-supported request per metric/log/status
SDK call, often many times per second in training loops. The producer target is
to reduce ordinary hot-path overhead below 50 us/log on local SSD-class storage
while keeping forced durability available through `flush()` and `finish()`.

A temporary prototype on an Apple M1 with JSON serialization included measured
about 336 us/event for one commit per event and about 16 us/event for 64-event
transactions. Larger batches improved less while increasing the crash-loss
window, so 64 events is the default.

## Simplicity Review

This keeps the current SQLite queue and uploader architecture. It avoids a new
daemon, socket, IPC layer, or public tuning surface. The added complexity is
limited to one prepared-event batch insert method and one private per-run writer
thread.

## Failure Modes

- Process dies before producer flush: buffered events are lost and cannot be
  recovered from SQLite.
- Queue unavailable, disk full, queue full, or oversized events: warn/drop and
  continue training.
- SQLite busy during timer flush: keep buffered events and retry.
- Forced flush times out: return `False` from waits or expose the error in
  status; do not raise from hot logging paths.
- Writer thread fails unexpectedly: record `last_flush_error`, warn/drop only when
  recovery fails, and keep training alive.

## Testing Plan

- Repository tests for prepared insert order, timestamps, idempotency keys,
  exact inserted/dropped counts, oversized events, queue-full behavior, disk-full
  behavior, and rollback on SQLite errors.
- Buffer tests with fake time for count, byte, age, hard cap, retry, forced flush,
  worker exception, stop/join, and no write after queue close.
- SDK tests for no foreground network, forced flush from status/waits/finish,
  final status persistence, warnings without training failure, default init and
  attach behavior, concurrent producer calls, and fake-uploader contention.
- Benchmark updates for batched and unbatched async, producer return latency,
  forced durability timing, and p50/p95/p99 call latency.

## Documentation Plan

- Update `packages/python-sdk/README.md`.
- Update `packages/python-sdk/PYPI_README.md`.
- Update `benchmarks/README.md`.
- Update `docs/design/README.md`.
- Add a dated benchmark result after implementation.

## Alternatives Considered

Keep per-call SQLite durability:

- Rejected for the default because it preserves overhead that is high for tight
  training loops.

Make batching opt-in:

- Rejected for this alpha slice because the product goal is fast-by-default SDK
  logging and there are no SDK consumers requiring rollout staging yet.

Use sockets or a daemon:

- Deferred because SQLite group commit gives most of the expected improvement
  without adding a second IPC/storage system.

## Review Notes

Fresh durability review:

- Finding: Producer batching changes a returned `log()` from locally durable to
  buffered in memory.
- Risk: Hard process death can lose up to the configured buffer window.
- Recommended edit: Document the durability contract and expose buffered status.
- Decision: Accepted.

Fresh performance/concurrency review:

- Finding: Timer and foreground flush paths can invert SQLite order if more than
  one writer inserts.
- Risk: Uploader drains in sequence order, so order inversion changes retry
  semantics.
- Recommended edit: Use one writer path and avoid SQLite I/O under `Run._lock`.
- Decision: Accepted.

Fresh SDK/API review:

- Finding: Public tuning knobs would widen the slice and timing assertions would
  be flaky in CI.
- Risk: Hard-to-support configuration and brittle tests.
- Recommended edit: Keep constants private, add deterministic unit tests, and
  use benchmarks for performance evidence.
- Decision: Accepted.

## Coverage Exceptions

None planned.

## Decision

Accepted. Implement the default buffered async producer with private thresholds:
64 events, 64 KiB, 20 ms, hard cap 4,096 events or 4 MiB.

## Implementation Benchmark Results

Committed local results:

- `benchmarks/2026-05-27-async-sqlite-batching-results.md`: end-to-end SDK
  logging overhead with buffered and unbuffered async producer modes.
- `benchmarks/2026-05-27-async-queue-io-results.md`: direct SQLite queue I/O
  experiment for event preparation, producer batch writes, and fake successful
  uploader read/drain work.

On the Apple M1 test machine, the SQLite I/O benchmark measured median prepared
write cost of about 573 us/event at one event per transaction, 43 us/event at
16-event batches, 13 us/event at 64-event batches, and 6 us/event at 256-event
batches. The 64-event threshold remains the MVP default because it captures most
of the write-path improvement while bounding the in-memory crash-loss window.

## Post-Implementation Review

Three senior Python review passes covered performance, security/reliability, and
cleanliness. The blocking issues were fixed before PR:

- Uploader process startup is protected by a dedicated lock and no longer runs
  from buffered append; it starts after successful SQLite flush.
- `finish()` no longer closes the SQLite repository if the producer writer fails
  to stop before the caller timeout.
- Wait helpers now fail when repository-level dropped events exist, not only when
  local process drops or failed rows exist.
- Queue directories and SQLite/WAL/SHM files are hardened to owner-only
  permissions where the OS supports `chmod`.
- Buffer append rolls back if the writer thread cannot start.
- Benchmark return-latency labels now report median p50 and median sample p99
  instead of mislabeling p99 across sample medians.

Accepted follow-ups:

- Replace the O(backlog) queued-byte scan in `_available_queue_bytes()` with a
  transactional byte counter or another bounded-capacity strategy.
- Batch uploader-side `mark_processed`/pruning; the read/drain benchmark now
  shows uploader draining is more expensive per event than 64-event writes.
- Make `finish(timeout=...)` a strict total deadline across all async phases.
- Move the private producer buffer into a smaller module with injected queue and
  callback dependencies once this path has a second maintenance pass.
- Replace retryability string matching with typed retryable SQLite enqueue
  errors.
