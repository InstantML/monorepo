# Design: SDK Process Uploader

Date: 2026-05-07

Status: Accepted

Owner: Codex

## Summary

Training loops should not block on observability network calls. The SDK already supports synchronous logging, in-process buffering, and failed-request JSONL replay, but those paths still let the training process perform HTTP work when the server is reachable or when `flush()` runs.

This design adds a narrow process-isolated upload mode. The training process writes canonical event snapshots to local spool files. A separate uploader process drains those files and performs the existing API calls. The default SDK behavior remains synchronous so existing examples, tests, and simple scripts keep working exactly as they do now.

The reviewed first slice is intentionally smaller than the first draft. It supports process upload for single-request SDK events, adds a metrics-focused `log_snapshot()` dictionary API, and defers broad multi-request snapshots until the server has idempotency support. It does not introduce a resident service, external queue, IPC protocol, or new backend endpoint.

## Goals

- Keep SDK logging hot paths free of HTTP calls when process upload mode is enabled.
- Capture a defined dictionary snapshot shape at each logging timestamp.
- Preserve existing SDK helper methods by writing one event file per existing API request.
- Add a separate uploader process that drains spooled events into the existing API.
- Keep the design understandable enough for researchers to debug with normal filesystem tools.
- Maintain 100% first-party Python coverage.

## Non-Goals

- True offline `init()` run creation. Run creation still requires the server in this slice.
- A long-running supervised daemon with lifecycle management.
- Cross-machine queues, Redis, Kafka, sockets, shared memory, or lock services.
- Binary artifact streaming outside the existing `upload_file()` payload shape.
- Guaranteed exactly-once delivery across process crashes. The target is at-least-once delivery with idempotence deferred to server-side request IDs.
- Multi-category `log_snapshot()` uploads. The first slice accepts metrics plus event-local metadata only.
- Durable copies of local artifact files. `upload_file()` in spool mode records the source path and the uploader reads it later, so callers must keep the file stable until upload succeeds.

## Users and Use Cases

Primary users are RL researchers, robotics teams, fine-tuning teams, and small AI labs running expensive training jobs. They want to log metrics, rollouts, checkpoints, and metadata without risking pauses from a slow UI/server, an overloaded laptop, or a transient network failure.

The target workflow:

1. The user starts the API/UI as usual.
2. The user starts an uploader process pointed at a spool directory.
3. The training loop calls `ro.init(..., upload_mode="spool", spool_dir=".rlobs/spool")`.
4. Each SDK logging call writes a canonical event file and returns quickly.
5. The uploader process reads pending event files, calls the existing API endpoints, and deletes each event file after a successful upload.

## Proposed Design

Add `upload_mode` to `Client.init()` and top-level `ro.init()`:

```python
run = ro.init(
    project="cartpole",
    upload_mode="spool",
    spool_dir=".rlobs/spool",
)
```

Accepted modes:

- `sync`: current default behavior.
- `spool`: write event snapshots to disk and return without HTTP for post-init logging calls.

Add `Run.log_snapshot(data, step=0, timestamp=None)`. In the first slice, `data` must be a dictionary with known top-level keys:

- `metrics`: dictionary of scalar metric values.
- `metadata`: user-defined dictionary kept in the event envelope for debugging and future server ingestion.

Existing SDK helpers build the same event envelope internally, but each event has exactly one API request. For example, `log_metrics()` creates one canonical event with `data.metrics` and one derived request to `POST /runs/:run_id/metrics`. `log_config()`, `log_text()`, `log_histogram()`, `add_tags()`, and artifact metadata helpers can use the same one-request envelope. A future snapshot API can combine categories after request-level idempotency exists.

Canonical event envelope:

```json
{
  "version": 1,
  "event_id": "01HX7F9P6K9W7Z3TQ6Z2N6RQ3C",
  "sequence": 1,
  "run_id": "run-123",
  "timestamp": "2026-05-07T12:00:00.000000Z",
  "step": 10,
  "data": {
    "metrics": {"reward": 12.0},
    "metadata": {"phase": "train"}
  },
  "requests": [
    {
      "method": "POST",
      "path": "/runs/run-123/metrics",
      "body": {
        "metrics": {"reward": 12.0},
        "step": 10,
        "timestamp": "2026-05-07T12:00:00.000000Z",
        "preview": false,
        "preview_completion": 0.0
      }
    }
  ]
}
```

Use one JSON file per event:

```text
.rlobs/spool/
  run-123/
    00000000000000000001-20260507T190000000000Z-4d7f2c1c.json
```

Writing one file per event is intentionally simple:

- The training process writes to `*.tmp` and atomically renames to `*.json`.
- The training process fsyncs the temporary file before rename and fsyncs the run directory after rename.
- The uploader only reads `*.json`.
- A failed upload leaves the file in place for a later retry.
- There is no shared file truncation or rename collision between the training process and uploader.

The uploader creates a single lock file at the spool root using exclusive create. If another uploader is already active, the second uploader exits with a clear `RlobsError`. This avoids duplicate sends from competing uploaders without adding per-file claim state.

Add `packages/python-sdk/rl_observability/uploader.py` with:

- `drain_spool(spool_dir, client=None, base_url="http://127.0.0.1:8000", timeout=2.0, max_events=None) -> int`
- `main(argv=None) -> int`

The uploader sends the one request in each event and deletes the event file only after the request succeeds. It processes each run directory in filename order. If one event fails for a run, the uploader leaves that file in place, stops processing that run, and continues with other runs. This preserves per-run ordering while allowing independent runs to make progress.

Delivery semantics are at-least-once. If the uploader crashes after the server accepts a request but before deleting the event file, the request may be retried. As of the 2026-05-09 backend-foundation slice, metric event replay sends the event ID as `Idempotency-Key` so compatible servers can deduplicate metric writes. Non-metric events still remain one API request per file and should be kept naturally idempotent where possible.

## Component Impact

Backend:

- No new endpoints in this slice.
- Existing endpoints receive the same request payloads as synchronous SDK calls.

Frontend:

- No direct frontend change.
- Better perceived reliability because slow UI/server periods no longer block training when users enable process upload mode.

Python SDK:

- Adds `upload_mode`, `spool_dir`, `log_snapshot()`, canonical event helpers, and uploader CLI.
- Keeps synchronous HTTP as the default.
- Keeps legacy `offline_dir` JSONL failed-request replay unchanged.

Storage:

- Adds process-uploader spool files under a user-selected directory.
- Uses per-run subdirectories and one event file per event.

Docs:

- Update SDK README with process uploader usage and limits.
- Update current architecture docs and design index.

## Data Model

New SDK-only event file fields:

- `version`: integer, currently `1`.
- `run_id`: run identifier.
- `timestamp`: event capture timestamp as UTC ISO-8601 string.
- `step`: optional numeric step supplied by the caller.
- `data`: canonical user-facing snapshot dictionary.
- `requests`: list of existing API request dictionaries with `method`, `path`, and `body`.
- `event_id`: unique SDK-generated event identifier used for traceability. Current compatible servers send metric event IDs as `Idempotency-Key`; the Rust/Postgres backend persists org-scoped idempotency rows for retryable SDK/uploader/import writes.
- `sequence`: per-`Run` SDK sequence number used as the first filename component so fast consecutive events drain in call order.

Original slice had no backend schema changes. The later Rust/Postgres backend-foundation implementation adds an `idempotency_keys` table for hosted durability and keeps Node idempotent metric replay as deprecated compatibility behavior.

## API Contracts

Top-level init:

```python
ro.init(..., upload_mode="sync", spool_dir=None)
```

Client init:

```python
Client(...).init(..., upload_mode="sync", spool_dir=None)
```

Run method:

```python
run.log_snapshot(data, step=0, timestamp=None)
```

Uploader CLI:

```bash
python -m rl_observability.uploader \
  --spool-dir .rlobs/spool \
  --base-url http://127.0.0.1:8000
```

Error behavior:

- Invalid `upload_mode` raises `ValueError` during `init()` or `Run` construction.
- `log_snapshot()` raises `TypeError` for non-dictionary data and `ValueError` for unknown top-level keys.
- In `spool` mode, post-init log calls do not call HTTP.
- In `spool` mode, metadata-only artifact helpers return a local placeholder artifact with `id="spooled"`.
- In `spool` mode, `upload_file()` records `source_path`; the uploader reads and encodes the file when it uploads.
- Uploader upload failures leave files pending for retry.
- A second concurrent uploader raises `RlobsError` while the first uploader holds the lock.

## Performance Considerations

Expected write frequency:

- Scalar metrics can be logged many times per second.
- Artifact upload events are less frequent and larger.
- This first per-event-file implementation is intended for up to roughly 100 post-init SDK calls per second per run on a local SSD. Higher-frequency users should batch values into one metrics dictionary per training step until segment files or server-side bulk ingestion exists.

Latency target:

- Post-init SDK logging in `spool` mode should avoid network latency entirely.
- The hot path performs JSON serialization plus one atomic file write.

Memory:

- No unbounded in-memory queue in `spool` mode.
- The training process does not retain uploaded events.

Batching:

- Deferred. Per-event files are less efficient than segment files, but safer and simpler for the first process-isolated path.
- Future batching can use the same envelope and write larger segment files after measuring filesystem overhead.

Measurement plan:

- Unit tests verify that a fake network client is not called in `spool` mode.
- Existing scale smoke remains focused on server/UI behavior.
- A future SDK microbenchmark can compare sync, buffer, and spool call overhead.

## Simplicity Review

This design avoids introducing a queue server, background thread, daemon supervisor, external dependency, or backend contract change. The separate process is just a CLI over local files. Users can inspect, delete, or replay event files manually if needed.

Deferred complexity:

- Exactly-once delivery.
- Event compaction and segment rotation.
- Run creation while offline.
- Server-side event IDs and deduplication.
- Uploader health UI.
- Multi-category snapshot upload.

## Failure Modes

- Server down: uploader leaves event files pending.
- Training process crashes mid-write: only `*.tmp` may remain; uploader ignores it.
- Uploader crashes after server success but before delete: the one-request event file may be retried later and duplicate data until server idempotency is added.
- Second uploader starts: it fails fast on the spool lock.
- Stale lock after process crash: user may remove the `.uploader.lock` file after verifying no uploader is active.
- Disk fills: SDK raises an OS error while writing the spool file; this is preferable to silently dropping training data.
- User forgets uploader: event files accumulate until the user runs the uploader.
- Unknown snapshot keys: SDK raises early so typos do not silently disappear.
- `upload_file()` source disappears before upload: uploader leaves the event pending and reports the file error; users must keep source files stable in this first slice.

## Testing Plan

- SDK unit tests for `upload_mode` validation and `spool_dir` propagation.
- SDK unit tests proving `spool` mode writes event files without calling HTTP for post-init logging.
- SDK unit tests for `log_snapshot()` request generation and unknown-key rejection.
- SDK unit tests for artifact placeholder return values in `spool` mode.
- SDK unit tests proving `upload_file()` in `spool` mode records a source path instead of reading bytes in the training process.
- Uploader unit tests for successful drain, failed drain retry behavior, per-run failure ordering, max-event limits, lock conflicts, file upload preparation, and CLI invocation.
- Existing integration tests remain unchanged for synchronous behavior.
- Preserve 100% first-party Python coverage.

## Documentation Plan

- `packages/python-sdk/README.md`: add process uploader API, examples, and limitations.
- `docs/architecture/current-system.md`: summarize current SDK upload modes.
- `docs/design/README.md`: link this accepted design.

## Alternatives Considered

Background thread:

- Rejected for this slice because it still runs inside the training process and can disturb process shutdown, memory, and exception behavior.

Single JSONL file per run:

- Rejected for the first process uploader because safe concurrent truncation is easy to get wrong without locks or segment files.

SQLite spool:

- Rejected for now because it adds locking semantics and a larger implementation surface. It may become useful after measuring per-event file overhead.

External queue:

- Rejected because this product is local-first and self-hosted. Requiring Redis or another service would make adoption harder.

## Review Notes

Fresh reviewer 1:

- Finding: The initial proposal was too broad because it combined `log_snapshot()` with every metadata category and helper-wide behavior.
- Risk: Too much public API and too many edge cases for the first process-uploader slice.
- Recommended edit: Narrow the accepted first slice to metrics-focused snapshots, single-request events, deterministic event IDs, per-run ordered draining, and explicit duplicate behavior.
- Decision: Accepted. `log_snapshot()` is limited to `metrics` and event-local `metadata` for now; existing helpers can spool one request at a time.

Fresh reviewer 2:

- Finding: The initial proposal did not prevent two uploaders from processing the same files, overstated atomic-rename durability, allowed per-run reordering after failures, and blurred artifact snapshot semantics.
- Risk: Duplicate uploads, possible data loss after a power failure, confusing run state, and stale artifact references.
- Recommended edit: Add single-uploader locking or file claiming, fsync file and directory writes, stop each run at first failed event, and document `upload_file()` source-path durability.
- Decision: Accepted. The implementation will use a root lock file, fsync event writes, per-run ordered failure stops, and explicit `upload_file()` source-path semantics.

## Coverage Exceptions

None planned.

## Decision

Accepted after reviewer-driven revision for the narrow first slice described above.
