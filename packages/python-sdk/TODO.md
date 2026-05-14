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

- [ ] Design SDK lifecycle parity: `id`, `name`, `notes`, `tags`, `group`, `job_type`, `mode`, `resume`, `resume_from`, `fork_from`, `reinit`, `dir`, settings, and environment-variable defaults.
- [x] Make tags and notes first-class in the public API, examples, and docs so users naturally label runs in ways the web search and compare surfaces can use.
- [x] Add ergonomic helpers for replacing tags and updating notes after run creation once Rust exposes safe post-hoc mutation routes.
  - Implemented: `init(notes=...)`, `Run.set_notes(...)`, and `Run.set_tags(...)`.
  - Remaining: append/remove tag helpers after a server-side append/remove route or public API read-modify-write design exists.
- [ ] Add true offline run creation with a local run directory and later sync. Keep the current post-run-create replay limitation documented until this lands.
- [ ] Add disabled/no-op mode for tests and scripts that want the API shape without network or disk writes.
- [ ] Add client-generated run IDs and resume modes that match Rust server semantics.
- [ ] Add config include/exclude handling and clear config mutation rules.
- [ ] Add `RLOBS_PROJECT`, `RLOBS_ENTITY` or org equivalent, `RLOBS_RUN_ID`, `RLOBS_RUN_GROUP`, `RLOBS_MODE`, cache/data/artifact dir variables, and documented precedence with explicit arguments.
- [ ] Keep context-manager finish behavior and make failed/keyboard-interrupted exits explicit in tests.

## P1 - Metric Hot Path

- [ ] Design default step behavior for `run.log()` so users can omit `step` while keeping server-side monotonicity clear.
- [ ] Add `define_metric` or an equivalent API for summary policy (`last`, `min`, `max`, `best`) and custom x-axis fields once the server supports it.
- [ ] Add fast batching benchmarks for sync, buffered, process-spool, and offline modes.
- [ ] Add optional system metric capture for CPU, memory, GPU, network, process info, and environment metadata without slowing scalar metric calls.
- [ ] Add optional console stdout/stderr capture and code/dependency snapshot capture behind explicit settings.
- [ ] Keep artifact uploads, media encoding, and table serialization off the scalar metric hot path.

## P2 - Rich Data Types

- [x] Design first-class data wrappers for the first `Table`, `Image`, `Video`, `Audio`, and `Histogram` slice.
  - Design: `docs/design/2026-05-11-rich-logged-objects.md`
  - Remaining wrappers: `Html`, `Plot`, optional `Object3D`/point-cloud payloads, masks/boxes, and NumPy/PIL/pandas optional adapters.
- [x] Add first-slice `Table` support for typed columns and list-of-rows/list-of-values input.
  - Remaining: incremental append and pandas DataFrame input behind optional dependencies.
- [x] Add first-slice `Image` support for file paths and captions.
  - Remaining: PIL images, NumPy arrays, masks, and bounding boxes.
- [x] Add first-slice `Video` and `Audio` wrappers for file paths plus lightweight metadata. Existing URI-based `log_video` remains compatible; path-upload rich media uses `log_objects`/`log_video_object`/`log_audio`.
  - Remaining: process-spool media response chaining and optional metadata extraction such as duration.
- [x] Add `Histogram` support from explicit bins/counts.
  - Remaining: NumPy-like arrays with optional dependency guards.
- [x] Add serialization tests for the first data types and Rust integration tests for server routes.

## P3 - Artifacts And Files

- [ ] Design an `Artifact` class with `add_file`, `add_dir`, `add_reference`, metadata, tags, aliases, TTL, and manifest behavior.
- [ ] Add `run.log_artifact`, `run.use_artifact`, `artifact.download`, partial file download, and local cache semantics after Rust artifact versions exist.
- [ ] Add artifact alias/version support including `latest`, `vN`, and custom aliases.
- [ ] Add external reference artifact support for object stores, HTTP, and filesystem paths where bytes are not uploaded.
- [ ] Add resumable or uploader-backed large file support before encouraging checkpoint-heavy workflows.
- [ ] Add file upload/download helpers for finished runs through the post-hoc API.
- [ ] Add media artifact helpers for MP3/MP4 files that set MIME type, step, captions/notes, duration if available, and safe metadata for web playback.

## P4 - Public API Client

- [x] Design the first compact raw `Api.runs()` read-only slice in `docs/design/2026-05-11-large-run-query-performance.md`.
- [x] Add raw read-only `Api.runs()` for `/api/runs/summary` with cursor pagination parameters.
- [ ] Design the broader `Api` client for post-hoc reads and safe updates.
- [ ] Add `Api.run()`, paginated `Run.history()`, run summary/config/metadata access, file listing, artifact lookup, and export helpers.
- [ ] Add filter syntax that maps directly to Rust server filters and fails clearly when unsupported.
- [ ] Add artifact and file download helpers with cache directory configuration.
- [ ] Add tests against a fake server and Rust integration tests against the real API.

## P5 - Sweeps And Integrations

- [ ] Design minimal `sweep()` and `agent()` APIs after Rust sweep routes are accepted.
- [ ] Add random/grid sweep agent support before any smarter optimizer.
- [ ] Add PyTorch Lightning logger, Hugging Face Transformers callback, Keras callbacks, TensorBoard sync, and Gym/RL video helpers only after customer validation picks priority.
- [ ] Add a generic logger protocol so third-party libraries can integrate without depending on private SDK internals.
- [ ] Keep dual logging to W&B or MLflow optional and behind explicit configuration.

## Quality Gates

- [ ] Maintain 100% meaningful SDK coverage for first-party logic or document a precise coverage exception.
- [ ] Add Rust-backed SDK integration tests for every new public method before documenting it as supported.
- [ ] Add performance tests that measure per-call overhead for scalar logging with and without optional integrations.
- [ ] Update `packages/python-sdk/README.md`, examples, and any relevant design docs in the same change as each feature.
