# Design: MLOP-Inspired SDK Ergonomics

Date: 2026-05-14

Status: Accepted with review amendments

Owner: Codex

## Summary

Training Observability should keep its current durable SDK architecture: synchronous REST for simple scripts, existing memory buffering for explicit batching, and process-isolated spool files for long or expensive jobs. MLOP is useful as an ergonomics reference, but not as the core durability model. This design adds the MLOP-style user-facing conveniences without replacing the existing sync/spool architecture.

The smallest useful slice makes `Run.log()` smarter and easier to use while keeping the existing sync, buffer, offline, and process-spool paths. It auto-increments steps when the user omits `step`, classifies payloads into scalar metrics, rich objects, and files, adds local file wrappers and conversions for common media/data values, optionally records a SQLite audit store, optionally samples system metrics, optionally captures console output, and exposes lightweight Torch, Lightning, and Transformers adapters. All network writes continue to flow through the existing `_submit()` and process-spool paths.

After review, this implementation has five guardrails:

- Existing public wrapper call shapes stay backward-compatible.
- `Run` gets a single lock around mutable SDK state before any sampler, console wrapper, or framework hook can log concurrently.
- Mixed `log()` calls are validated before submit, then emitted as deterministic sub-events in this order: metrics, text, table/histogram objects, files, media objects. Those sub-events are not atomic across routes, and partial server writes remain possible after the first submit succeeds.
- Process-spool mode keeps one request per event. Path-based file uploads keep the existing `source_path` durability semantics; generated text/media values are copied into a spool-owned media directory before being referenced.
- SQLite is an attempted-event audit store only. It is not replay, not a delivery guarantee, and not a second source of truth.

## Goals

- Preserve existing `sync`, `buffer_size`, `offline_dir`, and `upload_mode="spool"` behavior.
- Make `run.log({"loss": 0.2})` work with automatic step increments.
- Let `run.log()` accept mixed values and route scalar metrics, tables, histograms, images, audio, video, and generic files to the existing API routes.
- Add simple file/artifact wrappers that copy/hash local files and upload through the existing artifact upload route.
- Add optional NumPy/PIL/soundfile/moviepy conversions without making heavyweight libraries required at import time.
- Add optional local SQLite recording for metrics, objects, and file events as an audit/debug aid.
- Add optional psutil/NVML system metric sampling during a run.
- Add optional stdout/stderr capture in debug logging mode.
- Add optional Torch hooks, a Transformers callback, and a Lightning logger.
- Pin dependency versions to known stable non-latest releases.
- Preserve 100% meaningful SDK test coverage for first-party logic.

## Non-Goals

- Do not replace process-spool files with in-process background upload threads.
- Do not make in-process queues the default durability mechanism.
- Do not add new backend endpoints in this slice.
- Do not add true offline run creation.
- Do not add W&B-style artifact versions, aliases, manifests, or lineage.
- Do not make Torch, Transformers, Lightning, moviepy, soundfile, or pynvml mandatory imports for users who do not use those features.
- Do not implement a full public post-hoc API client beyond the existing `Api.runs()`.

## Users and Use Cases

Research engineers want a short logging call that accepts the natural values already in a training loop:

```python
run.log({
    "train/loss": loss,
    "eval/examples": ro.Table(columns=["prompt", "score"], rows=rows),
    "eval/frame": ro.Image(frame_array),
    "checkpoint": ro.Artifact("policy.pt", artifact_type="checkpoint"),
})
```

Framework users want existing training frameworks to report metrics with minimal glue:

- PyTorch users call `run.watch(model, log="gradients", log_freq=100)`.
- Transformers users pass `ro.TransformersCallback()` to a trainer.
- Lightning users pass `ro.LightningLogger(project="demo")`.

Long-running or expensive jobs still use `upload_mode="spool"` for durable process-isolated logging.

## Proposed Design

### Preserve Upload Architecture

Keep the existing upload modes:

- `sync`: immediate REST calls.
- `sync` with `buffer_size`: existing in-memory batching until `flush()`.
- `spool`: one fsynced event file per post-init SDK event, drained by `rl_observability.uploader`.

No new background uploader thread is introduced. System metric sampling can use a small optional sampler thread because it produces user data, not because it owns network durability.

### Auto-Step Semantics

`Run` tracks `_auto_step`, initialized to `0`.

- `run.log(data)` increments `_auto_step` by one and uses that step. The first implicit step is `1`.
- `run.log(data, step=N)` uses `N` and updates `_auto_step` to `max(_auto_step, N)`.
- `run.log_metrics(data, step=...)` remains explicit to preserve existing tests and route contracts.
- `run.log_metrics_auto(data, step=None)` is not added; `log()` is the ergonomic API.
- System sampler events use the current `_auto_step` without incrementing it.
- Steps must be finite nonnegative numbers. A failed submit does not roll back `_auto_step`; this preserves monotonic training-loop semantics and avoids duplicate implicit steps after retries.

This matches user expectation while keeping lower-level metric writes strict.

### Payload Classification

`run.log(data, step=None)` validates a dictionary with string keys and classifies each value before any submit:

- Scalar numeric values become one `log_metrics()` call.
- Strings become one `log_text()` call.
- `Table` and `Histogram` become rich objects through `log_objects()`.
- `Image`, `Audio`, and `Video` upload bytes and create linked media objects in sync mode. In spool mode, they raise the same clear response-chaining error as existing rich media helpers.
- `File` and `Artifact` upload bytes through `upload_file()`.
- Lists of homogeneous rich objects/files are expanded with `key/0`, `key/1`, and so on. Numeric lists are not flattened in this slice; users should use `Histogram.from_values()` or `Table`.
- Mixed lists are rejected.

If classification fails, no network request is attempted for that `log()` call. Once submission starts, each category is an independent request or upload flow. A later category failure can leave earlier categories written; this matches the existing route-level SDK behavior and will need idempotency support before becoming atomic.

### Wrappers And Conversions

Add/extend wrappers without breaking current positional forms:

- `File(path, name=None, artifact_type="file", metadata=None)`
- `Artifact(path, name=None, artifact_type="file", metadata=None)`
- `Text(data, name=None, metadata=None)` writes a temporary text file when logged.
- `Table(columns, rows, metadata=None)` remains valid and gains keyword-only `dataframe=`/`data=`.
- `Histogram(bins, counts, metadata=None)` remains valid and gains `Histogram.from_values(values, bins=64, metadata=None)`.
- `Image(path, caption=None, metadata=None)` remains valid and gains `Image.from_data(data, caption=None, metadata=None)`.
- `Audio(path, caption=None, metadata=None)` remains valid and gains `Audio.from_data(data, sample_rate=48000, caption=None, metadata=None)`.
- `Video(path, caption=None, metadata=None)` remains valid and gains `Video.from_data(data, fps=30, format="mp4", caption=None, metadata=None)`.

Path inputs are copied by `upload_file()` only when bytes are uploaded in sync/offline mode. In process-spool mode, path inputs keep the existing `source_path` behavior and must remain stable until drained. Generated text/media values are written under a run-local media directory before upload/spool reference. Hashes use SHA-256.

Optional conversion rules:

- NumPy arrays and Torch/JAX-like tensors are converted by duck-typing `.detach()`, `.cpu()`, `.numpy()`, or `.tolist()` where safe.
- `Image` accepts paths, PIL images, NumPy arrays, and matplotlib figures when installed.
- `Audio` accepts paths and NumPy arrays; arrays require `soundfile`.
- `Video` accepts paths and NumPy arrays; arrays require `moviepy` or `imageio` support.
- Missing optional dependencies raise `RlobsError` with the exact package name to install.

### Local SQLite Store

Add `local_store` and `local_store_dir` to `init()`.

```python
run = ro.init(project="demo", local_store=True, local_store_dir=".rlobs/local")
```

The store is an SDK-local audit trail, not a second source of truth. It records:

- `metrics(run_id, step, key, value, timestamp)`
- `events(run_id, step, kind, key, payload_json, timestamp)`
- `files(run_id, step, key, path, sha256, size_bytes, artifact_type, timestamp)`

Writes are synchronous SQLite inserts guarded by a lock before the matching submit is attempted. Rows represent attempted SDK events, not server acceptance. The database is opened with WAL mode and a short busy timeout. If local store writes fail, the SDK raises because the user explicitly enabled the audit store.

### System Metrics

Add optional sampler arguments:

```python
run = ro.init(project="demo", system_metrics=True, system_metrics_interval=15.0)
```

The sampler collects CPU percent, virtual memory usage, process RSS, disk usage for the current directory, network byte counters, and NVIDIA GPU utilization/memory/power when `pynvml` is available. It logs under `system/...` at the current `_auto_step` without incrementing the step. Sampler failures are warnings and do not finish the run.

### Console Capture

Add optional console capture:

```python
run = ro.init(project="demo", capture_console=True)
```

The SDK wraps `sys.stdout` and `sys.stderr`, writes through to the original stream, and logs non-empty lines as string series under `console/stdout` and `console/stderr` at the current step. The wrapper is restored on `finish()` and context-manager exit. Recursive SDK logging output is avoided by writing through first and using a guard flag.

### Framework Adapters

Add optional adapters without hard dependencies:

- `Run.watch(model, log="gradients", log_freq=1000, bins=64, log_graph=False)` registers PyTorch-like hooks when `torch` is importable and the model exposes `named_parameters()`.
- `TransformersCallback` lazily initializes a run if needed and logs `on_log()` metrics at `state.global_step`.
- `LightningLogger` exposes `name`, `version`, `experiment`, `log_metrics()`, `log_hyperparams()`, `log_image()`, `log_audio()`, `log_video()`, and `finalize()`.

Adapters should be small and best-effort. They must not import heavy frameworks at package import time.

## Component Impact

Backend:

- No endpoint or schema changes.
- Existing `/runs/:id/metrics`, `/api/runs/:id/attributes`, `/api/runs/:id/objects`, and artifact upload routes are reused.

Frontend:

- No direct UI change. Existing rich-object and artifact previews receive more useful SDK payloads.

Python SDK:

- Extend `client.py` public wrappers and `Run.log()`.
- Add small modules for media conversion, local store, system metrics, console capture, and integrations if keeping `client.py` readable requires it.
- Export new wrappers and adapter classes from `rl_observability`.

Storage:

- Optional SDK-local SQLite database under `.rlobs/local` or a user-supplied directory.
- Temporary converted media files under a run-local SDK media directory.

Docs:

- Update SDK README, package README, design index, SDK TODO, and dependency pins.

## Data Model

Local SQLite tables:

```sql
create table if not exists metrics (
  id integer primary key autoincrement,
  event_id text not null,
  run_id text not null,
  step real not null,
  key text not null,
  value real not null,
  status text not null,
  timestamp text not null
);

create table if not exists events (
  id integer primary key autoincrement,
  event_id text not null,
  run_id text not null,
  step real,
  kind text not null,
  key text not null,
  status text not null,
  payload_json text not null,
  timestamp text not null
);

create table if not exists files (
  id integer primary key autoincrement,
  event_id text not null,
  run_id text not null,
  step real,
  key text not null,
  path text not null,
  sha256 text not null,
  size_bytes integer not null,
  artifact_type text not null,
  status text not null,
  timestamp text not null
);
```

Indexes:

- `(run_id, key, step)` for metrics.
- `(run_id, kind, key)` for events.
- `(run_id, key)` for files.

## API Contracts

Changed SDK methods:

```python
ro.init(..., local_store=False, local_store_dir=None, system_metrics=False,
        system_metrics_interval=15.0, capture_console=False)

Client.init(... same additions ...)

run.log(data: dict[str, Any], step: int | float | None = None) -> None
run.watch(model, log="gradients", log_freq=1000, bins=64, log_graph=False) -> None
```

New classes:

```python
File(path, name=None, artifact_type="file", metadata=None)
Artifact(path, name=None, artifact_type="file", metadata=None)
Text(data, name=None, metadata=None)
TransformersCallback(...)
LightningLogger(...)
```

Existing methods and wrappers keep backward-compatible call shapes.

Error behavior:

- Invalid `log()` payload raises before any request is sent.
- Missing optional conversion dependencies raise `RlobsError`.
- Console wrappers restore original streams on `finish()` even if finish network calls fail.
- System sampler warnings do not fail training.
- In `spool` mode, media object upload+link remains unsupported and raises clearly.

## Performance Considerations

Expected write frequency:

- `run.log()` can be called a few times per second for mixed payloads.
- High-frequency scalar loops should still batch multiple scalars into one dictionary.
- `upload_mode="spool"` remains the recommended mode for expensive jobs that cannot block on network.

Latency target:

- Scalar-only `run.log()` should add classification overhead only, with no media conversion work.
- Media conversion and hashing happen only for file/media values.
- Optional local SQLite writes are simple inserts and should remain below a few milliseconds for normal logging.

Memory:

- No unbounded SDK upload queue is added.
- Media conversions materialize files; callers should not log huge arrays every step.

Measurement:

- Add tests proving scalar-only `log()` still emits a single metric request.
- Future microbenchmarks should compare `log_metrics`, `log`, `spool`, and `local_store`.

## Simplicity Review

This design borrows the pleasant parts of MLOP while refusing the risky part: a default in-process uploader. It keeps every server-facing write on existing routes and treats optional features as thin wrappers around existing SDK helpers.

Deferred complexity:

- True offline run creation.
- Background upload threads.
- SQLite replay.
- Artifact aliases/manifests/versions.
- Framework-specific deep integrations beyond basic metric/media logging.
- Rich media response chaining in process-spool mode.

## Failure Modes

- Server down in sync mode: existing `RlobsError` or `offline_dir` behavior applies.
- Server down in spool mode: event files remain pending as today.
- Optional dependency missing: SDK raises a package-specific error only when that feature is used.
- System sampler crashes: warning is recorded and sampler stops.
- Console wrapper logging fails: original stdout/stderr still receive the user output.
- Local SQLite unavailable: initialization or insert raises because the user explicitly enabled it.
- Torch hook logs after finish: adapter ignores because the run is finished.
- Framework callback created without active run: it initializes one using provided kwargs.

## Testing Plan

- SDK tests for `log()` auto-step and explicit-step behavior.
- SDK tests for mixed payload classification and no partial submit on invalid values.
- SDK tests for `File`, `Artifact`, and `Text` wrappers, including SHA-256 and artifact upload payloads.
- SDK tests for `Table`, `Histogram`, and image path/PIL/NumPy conversion where dependencies are present.
- SDK tests for missing optional dependency errors.
- SDK tests for local SQLite schema and inserted metrics/events/files.
- SDK tests for system metric collection with fake psutil/NVML inputs and sampler lifecycle.
- SDK tests for console capture write-through and restoration.
- SDK tests for Torch hook behavior with lightweight fake tensors/parameters where possible.
- SDK tests for Transformers and Lightning adapter method routing without importing the actual frameworks.
- Existing process-spool and rich-object tests must continue to pass.
- Preserve repository coverage target or document precise exceptions.

## Documentation Plan

- `packages/python-sdk/README.md`: new ergonomic logging examples, optional features, dependency notes, and architecture note.
- `packages/python-sdk/TODO.md`: mark auto-step/classification/local-store/adapters first slice and list remaining follow-ups.
- `packages/README.md`: update SDK caveats.
- `docs/design/README.md`: link this design.
- `requirements-dev.txt`: add pinned non-latest dependency versions used by SDK tests.
- `packages/python-sdk/requirements-optional.txt`: add pinned non-latest dependency versions for optional SDK features.

## Alternatives Considered

Adopt MLOP's threaded uploader:

- Rejected because process exit, fork/multiprocessing, backpressure, and delivery certainty are weaker than the existing process-spool architecture.

Make optional dependencies hard imports:

- Rejected because a tiny scalar logger should not require media/framework stacks.

SQLite as the main offline queue:

- Rejected for this slice. It is useful as an audit store, but replay and durability semantics need a separate design.

## Review Notes

Fresh reviewer 1:

- Finding: the first slice was too broad; mixed `run.log()` spans multiple one-request process-spool events; threaded samplers/hooks need a lock; file durability and numeric list flattening were ambiguous; SQLite ordering needed a precise meaning.
- Risk: introducing pleasant MLOP-style APIs could accidentally weaken the reliable SDK path or create hidden partial-write behavior.
- Recommended edit: keep the existing upload architecture, add deterministic category sub-events, document partial writes, add a `Run` lock before threaded features, preserve current spool `source_path` semantics or copy generated files, remove numeric list flattening, and define SQLite as attempted-event audit.
- Decision: accepted. The design was amended with the guardrails above before implementation.

Fresh reviewer 2:

- Finding: proposed wrapper constructor changes would break users; mixed `log()` is not atomic across routes; local SQLite, generated media in spool mode, heavy dependency tests, and auto-step semantics needed tightening.
- Risk: breaking the public SDK surface and creating hard-to-debug delivery semantics.
- Recommended edit: preserve existing positional constructors and add factory methods; keep one process-spool request per event; specify exact auto-step validation; avoid hard imports of heavy frameworks; use fakes/duck types for adapter tests.
- Decision: accepted. Existing call shapes remain valid, optional features are lazy, and auto-step/mixed-log semantics are explicit.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation with the review amendments above.
