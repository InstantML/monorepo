# Python SDK TODO

SDK backlog from the W&B docs gap review on 2026-05-10.

The SDK should stay tiny and fast on the training-loop path. Any public API expansion, offline behavior change, artifact contract, rich data type, or framework integration needs a design doc in `docs/design/` and fresh review before implementation.

Primary W&B references reviewed:

- `https://docs.wandb.ai/models/ref/python/functions/init`
- `https://docs.wandb.ai/models/ref/python/experiments/run`
- `https://docs.wandb.ai/models/track/log`
- `https://docs.wandb.ai/models/track/log/media`
- `https://docs.wandb.ai/models/track/log/log-tables`
- `https://docs.wandb.ai/models/artifacts`
- `https://docs.wandb.ai/models/artifacts/download-and-use-an-artifact`
- `https://docs.wandb.ai/models/artifacts/create-a-custom-alias`
- `https://docs.wandb.ai/models/artifacts/track-external-files`
- `https://docs.wandb.ai/models/track/public-api-guide`
- `https://docs.wandb.ai/models/sweeps/initialize-sweeps`
- `https://docs.wandb.ai/models/integrations`

## P0 - Run Lifecycle And Settings

Remaining lifecycle/offline items below are tracked in `docs/product/2026-07-14-wandb-pain-point-roadmap.md` (PR-01..PR-08).

- [ ] Design SDK lifecycle parity: `id`, `name`, `notes`, `tags`, `group`, `job_type`, `mode`, `resume`, `resume_from`, `fork_from`, `reinit`, `dir`, settings, and environment-variable defaults.
- [x] Make tags and notes first-class in the public API, examples, and docs so users naturally label runs in ways the web search and compare surfaces can use.
- [x] Add ergonomic helpers for replacing tags and updating notes after run creation once Rust exposes safe post-hoc mutation routes.
  - Implemented: `init(notes=...)`, `Run.set_notes(...)`, and `Run.set_tags(...)`.
  - Remaining: append/remove tag helpers after a server-side append/remove route or public API read-modify-write design exists.
- [x] Add true offline run creation with a local run directory and later sync. Keep the current post-run-create replay limitation documented until this lands.
  - Implemented (PR-03, write side): `init(mode="offline", run_id=, resume=)` writes `<data_root>/offline/<run_id>/` (run.json manifest, spool segments with session/class/persisted deterministic idempotency keys, staged `files/`), bounded drop-on-write-failure, and offline finish/SIGTERM signatures. Design: `docs/design/2026-07-15-offline-lifecycle-upload-completeness.md` §3–§4.
  - Remaining: resumable `instantml sync` that replays the directory (PR-04).
- [x] Add disabled/no-op mode for tests and scripts that want the API shape without network or disk writes.
  - Implemented (PR-03): `init(mode="disabled")` — full inert Run surface, no network/disk/lifecycle-handler side effects, generates a local run id. Design §4.
- [x] Add client-generated run IDs and resume modes that match Rust server semantics.
  - Implemented SDK-side (PR-03): `run_id`/`INSTANTML_RUN_ID` (validated canonical UUID) and `resume` (`never`/`must`/`allow` → `create`/`resume`/`auto`), passed as `{id, mode}` in the online create body. Server acceptance is PR-02.
- [ ] Add config include/exclude handling and clear config mutation rules.
- [ ] Add `INSTANTML_PROJECT`, `INSTANTML_ENTITY` or org equivalent, `INSTANTML_RUN_ID`, `INSTANTML_RUN_GROUP`, `INSTANTML_MODE`, cache/data/artifact dir variables, and documented precedence with explicit arguments.
- [ ] Keep context-manager finish behavior and make failed/keyboard-interrupted exits explicit in tests.

## P1 - Metric Hot Path

- [x] Design and implement default step behavior for `run.log()` so users can omit `step` while keeping server-side monotonicity clear.
  - Design: `docs/design/2026-05-14-mlop-inspired-sdk-ergonomics.md`
  - Implemented: implicit steps start at `1`; explicit steps are used as provided and advance the implicit counter.
- [ ] Add `define_metric` or an equivalent API for summary policy (`last`, `min`, `max`, `best`) and custom x-axis fields once the server supports it.
- [ ] Add fast batching benchmarks for sync, buffered, process-spool, and offline modes.
- [x] Add default durable async logging for metric/log hot paths with local
  SQLite WAL queueing, a process uploader, status/wait helpers, and recovery
  CLI.
  - Design: `docs/design/2026-05-25-durable-async-sdk-logging.md`
  - Default decision: `docs/design/2026-05-25-async-upload-default.md`
  - Implemented first slice: metrics, rank metrics, console logs, and finish
    status are queued by default through `upload_mode="async"`.
  - Remaining: broaden only after idempotent contracts exist for config,
    attributes, rich objects, media response chaining, and artifact uploads.
- [x] Add optional system metric capture for CPU, memory, GPU, network, process info, and environment metadata without slowing scalar metric calls.
  - Implemented: `system_metrics=True` samples psutil/NVML metrics on a small data-sampler thread and logs at the current step.
- [ ] Add optional console stdout/stderr capture and code/dependency snapshot capture behind explicit settings.
  - Implemented: `capture_console=True` wraps stdout/stderr and restores them on finish. Remaining: dependency snapshot capture.
- [ ] Keep artifact uploads, media encoding, and table serialization off the scalar metric hot path.

## P2 - Rich Data Types

- [x] Design first-class data wrappers for the first `Table`, `Image`, `Video`, `Audio`, and `Histogram` slice.
  - Design: `docs/design/2026-05-11-rich-logged-objects.md`
  - Remaining wrappers: `Html`, `Plot`, optional `Object3D`/point-cloud payloads, masks/boxes, and NumPy/PIL/pandas optional adapters.
- [x] Add first-slice `Table` support for typed columns and list-of-rows/list-of-values input.
  - Implemented follow-up: `Table.from_data(...)` and `Table.from_dataframe(...)`.
  - Remaining: incremental append.
- [x] Add first-slice `Image` support for file paths and captions.
  - Implemented follow-up: `Image.from_data(...)` for PIL images, NumPy-like arrays, and matplotlib figures.
  - Remaining: masks and bounding boxes.
- [x] Add first-slice `Video` and `Audio` wrappers for file paths plus lightweight metadata. Existing URI-based `log_video` remains compatible; path-upload rich media uses `log_objects`/`log_video_object`/`log_audio`.
  - Implemented follow-up: `Audio.from_data(...)` with `soundfile` and `Video.from_data(...)` with `imageio`/`moviepy`.
  - Remaining: process-spool media response chaining and optional metadata extraction such as duration.
- [x] Add `Histogram` support from explicit bins/counts.
  - Implemented follow-up: `Histogram.from_values(...)` for lists and tensor-like objects.
- [x] Add serialization tests for the first data types and Rust integration tests for server routes.

## P3 - Artifacts And Files

- [ ] Design a full `Artifact` class with `add_file`, `add_dir`, `add_reference`, metadata, tags, aliases, TTL, and manifest behavior.
  - Implemented first wrapper: `File(...)`/`Artifact(...)` upload a single local path through the existing upload route.
- [ ] Add `run.log_artifact`, `run.use_artifact`, `artifact.download`, partial file download, and local cache semantics after Rust artifact versions exist.
  - Shipped: `Run.log_artifact`, `Run.use_artifact`, `LoggedArtifact.download`, and partial file download in `instantml/client.py`. Remaining: local content-addressed cache. Tracked in `docs/product/2026-07-14-wandb-pain-point-roadmap.md` (PR-29).
- [x] Add artifact alias/version support including `latest`, `vN`, and custom aliases.
  - Shipped: `Api.artifact(ref)` resolves `:latest`/`:best`/`:vN` via `/api/artifact-versions/resolve`; `LoggedArtifact.promote` sets custom aliases.
- [ ] Add external reference artifact support for object stores, HTTP, and filesystem paths where bytes are not uploaded.
- [ ] Add resumable or uploader-backed large file support before encouraging checkpoint-heavy workflows.
  - Tracked in `docs/product/2026-07-14-wandb-pain-point-roadmap.md` (PR-31).
- [ ] Add file upload/download helpers for finished runs through the post-hoc API.
- [ ] Add media artifact helpers for MP3/MP4 files that set MIME type, step, captions/notes, duration if available, and safe metadata for web playback.

## P4 - Public API Client

- [x] Design the first compact raw `Api.runs()` read-only slice in `docs/design/2026-05-11-large-run-query-performance.md`.
- [x] Add raw read-only `Api.runs()` for `/api/runs/summary` with cursor pagination parameters.
- [ ] Design the broader `Api` client for post-hoc reads and safe updates.
- [ ] Add `Api.run()`, paginated `Run.history()`, run summary/config/metadata access, file listing, artifact lookup, and export helpers.
  - Shipped: `Api.query_runs`/`iter_runs`, `Api.query_metrics`, `Api.query_objects`/`object_rows`, and `Api.artifact` lookup in `instantml/client.py`. Remaining: an `Api.run()` accessor, paginated `Run.history()`, and export helpers.
- [ ] Add filter syntax that maps directly to Rust server filters and fails clearly when unsupported.
- [ ] Add artifact and file download helpers with cache directory configuration.
  - `Api.download_artifact` is shipped. Remaining: cache-directory configuration. Tracked in `docs/product/2026-07-14-wandb-pain-point-roadmap.md` (PR-29).
- [ ] Add tests against a fake server and Rust integration tests against the real API.

## P5 - Sweeps And Integrations

- [ ] Design minimal `sweep()` and `agent()` APIs after Rust sweep routes are accepted.
  - Tracked in `docs/product/2026-07-14-wandb-pain-point-roadmap.md` (PR-19..PR-22).
- [ ] Add random/grid sweep agent support before any smarter optimizer.
- [ ] Add broader framework integrations after customer validation picks priority.
  - Implemented first slice: `Run.watch(...)`, `TransformersCallback`, and `LightningLogger`.
  - Shipped follow-up: TensorBoard sync via `instantml/importers.py` `tensorboard_logdir_payload` and the `instantml sync tensorboard` CLI command.
  - Remaining: Keras callbacks, Gym/RL video helpers, and deeper framework-specific behavior.
- [ ] Add a generic logger protocol so third-party libraries can integrate without depending on private SDK internals.
- [ ] Keep dual logging to W&B or MLflow optional and behind explicit configuration.
  - W&B dual logging shipped: `instantml/shadow.py` `ShadowWandb` via `init(shadow_wandb=...)`. Remaining: MLflow dual logging.

## Quality Gates

- [ ] Maintain 100% meaningful SDK coverage for first-party logic or document a precise coverage exception.
- [ ] Add Rust-backed SDK integration tests for every new public method before documenting it as supported.
- [ ] Add performance tests that measure per-call overhead for scalar logging with and without optional integrations.
- [ ] Update `packages/python-sdk/README.md`, examples, and any relevant design docs in the same change as each feature.
