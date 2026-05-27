# Design: Async Upload Default

Date: 2026-05-25

Status: Accepted after review; producer durability timing superseded by `2026-05-27-async-sqlite-batching.md`

Owner: Codex

## Summary

Durable async SDK logging is now merged behind `upload_mode="async"`. The
benchmarks show the SQLite WAL producer costs roughly 130 microseconds per
metric log call on the local benchmark machine. That is higher than the
internal sync-null transport path, but it is still small for normal training
loops and buys the behavior we want by default: metric/log calls do not wait on
the network, transient connectivity failures remain queued locally, and
metric/log delivery errors should not stop user training.

The accepted buffered producer follow-up keeps async as the default but changes
the producer hot path from one SQLite commit per returned log call to bounded
group commit. A returned default-async log call may now be lost if the Python
process dies before the short producer buffer reaches SQLite.

The smallest useful change is to make `instantml.init()` and `Client.init()`
default to `upload_mode="async"` while preserving `upload_mode="sync"` and
`upload_mode="spool"` as explicit opt-outs. Direct `Run(...)` construction
keeps its existing `sync` default because it is an advanced/test escape hatch
and changing it would unexpectedly start a background uploader process for code
that bypasses `init()`.

## Goals

- Make the recommended SDK initialization path use durable async metric/log
  delivery by default.
- Preserve explicit `upload_mode="sync"` for tests, scripts that need immediate
  foreground errors, and very high-frequency microbenchmarks.
- Preserve explicit `upload_mode="spool"` for user-managed process-spool
  workflows.
- Keep rich object, media, config, tags, notes, and artifact behavior unchanged.
- Document the changed default and the sync escape hatch close to the SDK API.

## Non-Goals

- Do not change Rust API routes, schemas, idempotency, billing, or OpenAPI.
- Do not make run creation offline-capable.
- Do not make async apply to response-returning rich media/artifact helpers.
- Do not change `Run.__init__`'s default upload mode in this slice.
- Do not remove sync mode.

## Users and Use Cases

Training engineers usually want logging to be low-friction and resilient. The
default should protect the training loop from transient API/network failures and
avoid synchronous request latency on scalar metric/log hot paths.

SDK and CI users who want exact foreground failures can still request
`upload_mode="sync"`. Existing tests and examples that exercise sync behavior
should be explicit rather than relying on the default.

## Proposed Design

Change the default `upload_mode` parameter from `"sync"` to `"async"` in:

- `Client.init(...)`
- top-level `instantml.init(...)`

Leave `Run.__init__(..., upload_mode="sync")` unchanged. `Run` is exported, but
the public creation path is `init()`. Keeping the lower-level constructor sync by
default avoids accidental background processes in direct unit tests or advanced
manual handles.

Async semantics remain exactly those accepted in
`2026-05-25-durable-async-sdk-logging.md`:

- run creation still happens against the API;
- scalar metrics, rank metrics, console logs, and final run status enqueue to
  the SQLite WAL queue;
- unsupported response-returning helpers continue on sync/spool paths;
- `finish()` waits up to the client timeout by default, then warns and leaves
  data recoverable on disk if the queue is not drained;
- `upload_status()`, `wait_for_submission()`, `wait_for_processing()`, and
  `instantml-uploader --queue-dir` remain the recovery/status interfaces.

Two guardrails are included with the default flip:

- The uploader no longer emits idle health metrics forever. It sends health
  when work is processed, while queue/error state is outstanding, or once when a
  previously outstanding queue becomes idle.
- If the local SQLite queue cannot open, async hot-path events are dropped with
  rate-limited warnings and `upload_status()` reports `queue_available: false`.
  Queue setup failures must not become a default training-loop failure.

Update tests so default initialization proves the new mode, existing sync
behavior is covered through explicit `upload_mode="sync"`, idle uploader health
traffic is bounded, and local queue setup failures warn/drop rather than raise.
Update SDK docs, benchmark notes, and the async design doc to record that the
default was flipped after benchmark and UI verification.

## Component Impact

Backend:

- No backend change.

Frontend:

- No frontend code change. Existing upload-health UI becomes more likely to show
  useful data for default SDK runs.

Python SDK:

- `instantml.init()` and `Client.init()` default to async mode.
- Tests that depended on implicit sync mode become explicit.
- Async local queue setup failure warns and keeps training code moving.
- Public docs describe async as the default and sync as the escape hatch.

Storage:

- Default SDK runs now create `.instantml/async/<run-id>/queue.sqlite3` unless
  callers provide `queue_dir` or explicitly select sync/spool.

Docs:

- Update `packages/python-sdk/README.md`, `packages/python-sdk/PYPI_README.md`,
  `benchmarks/README.md`, `docs/design/README.md`, and the durable async design
  doc.

## Data Model

No server data model changes.

Client-local behavior changes: default SDK runs use the existing per-run SQLite
WAL queue under `.instantml/async/<safe-run-id>/queue.sqlite3`.

## API Contracts

No REST API changes.

Python public API default changes:

```python
run = instantml.init(project="cartpole")
assert run.upload_status()["mode"] == "async"

sync_run = instantml.init(project="cartpole", upload_mode="sync")
```

This is a behavior change, not a signature change. Existing explicit
`upload_mode` arguments keep their behavior.

## Performance Considerations

The current dated benchmark reports:

- `instantml-sync-null`: median 13.416 us/log, p95 tree CPU 14.023 us/log.
- `instantml-async-queue`: median 130.690 us/log, p95 tree CPU 126.358 us/log.
- `instantml-spool-durable`: median 245.959 us/log, p95 tree CPU 230.656 us/log.

Async is about 10x slower than the internal fake sync transport, but that sync
case is not real remote persistence and still raises/stalls on network failures.
Async remains well below 1 ms per normal log call and is materially faster than
process-spool durability. Users with very high-frequency logging can choose
`upload_mode="sync"` or reduce logging frequency.

The previous async health cadence could add up to 720 health requests/hour and
4,320 health metric points/hour for a completely idle run. This slice removes
that idle polling behavior before making async the default. Health metrics stay
ordinary metric writes in this slice, but they are now emitted only when queue
work or queue/error state makes them useful.

No new indexes or server pagination are needed.

## Simplicity Review

The implementation is intentionally a default flip plus the two guardrails
reviewers identified as practical blockers: bounded health traffic and local
queue setup failure handling. It does not add env-var policy, migration code, or
another upload mode. The repository has no SDK consumers yet, so a staged
rollout switch is unnecessary for this alpha slice.

## Failure Modes

- Queue cannot open, enqueue fails, disk is full, or queue limits are exceeded:
  default async warns and continues training, matching the accepted durable
  async design.
- Uploader cannot start: events remain queued and recoverable via
  `instantml-uploader`.
- Auth/quota/payment/validation failures: queued rows become failed; waits
  return `False`; training is not stopped by metric/log hot paths.
- Users expecting immediate exceptions from metric logging: must pass
  `upload_mode="sync"`.
- Very short scripts may exit before background drain: `finish()` performs a
  bounded wait and warns if data remains.

## Testing Plan

- Add/adjust Python SDK tests:
  - `Client.init()` defaults to async.
  - top-level `instantml.init()` forwards the async default.
  - explicit `upload_mode="sync"` still produces sync runs and foreground HTTP
    behavior.
  - idle async uploader loops do not emit periodic health metrics.
  - local queue setup failure warns, reports unavailable status, and drops
    hot-path events without foreground API calls.
  - existing async queue tests continue to pass.
- Run `npm run test:python` and preserve 100% coverage.
- Run `git diff --check`.

## Documentation Plan

- Update SDK README and PyPI README examples/default text.
- Update durable async design doc decision notes.
- Add this design to `docs/design/README.md`.
- Update benchmarks README to say the dated async overhead result was used for
  the default flip.

## Alternatives Considered

Keep sync as default:

- Rejected because the product goal is reliable, non-blocking training-loop
  logging by default, and async's measured local overhead is acceptable.

Add an environment-variable default override first:

- Rejected for now. The repository has no SDK consumers yet, and explicit
  `upload_mode="sync"` is simpler and more visible for this alpha slice.

Change `Run.__init__` default too:

- Rejected for now because direct construction is a lower-level path commonly
  used in tests; silently starting uploader processes there would be surprising.

## Review Notes

Fresh reviewer 1:

- Finding: Default async would create billable/background health traffic and
  local queue setup failures could become new default init/log failures.
- Risk: Idle runs could consume unnecessary quota, and read-only/bad queue
  directories could stop training code.
- Recommended edit: Make uploader health event-driven or non-billable, catch
  queue initialization failures, and add tests for local queue failure.
- Decision: Accepted. This slice bounds health emission to useful queue state,
  reports unavailable queues through `upload_status()`, and drops hot-path async
  events with warnings if local queue setup fails.

Fresh reviewer 2:

- Finding: The draft lacked a rollout/rollback guard, did not model health quota
  impact, understated operation-specific failure semantics, and left the durable
  async design doc contradictory.
- Risk: The default flip could be harder to reverse for real users, obscure
  which operations are still synchronous, and leave future agents with
  conflicting docs.
- Recommended edit: Add a kill switch or smaller rollout, quantify health
  traffic, document local storage/failure semantics, and update the earlier
  design doc.
- Decision: Partially accepted. The user clarified there are no SDK consumers
  yet, so no rollout switch is needed. The implementation still reduces idle
  health traffic, documents default local storage and sync escape hatch, and
  updates the durable async design doc.

## Coverage Exceptions

None. Python SDK coverage remains at 100% for this slice.

None planned.

## Decision

Accepted for implementation: make `instantml.init()` and `Client.init()` default
to async mode, keep direct `Run(...)` sync by default, bound idle health traffic,
handle local queue setup failures without stopping training, and document
`upload_mode="sync"` as the explicit foreground-error path.
