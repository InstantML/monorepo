# Python SDK

This directory contains the Python SDK used by training scripts to send runs, metrics, attributes, artifacts, checkpoints, and source context to InstantML.

## Responsibilities

- Initialize runs.
- Log scalar metrics with explicit `log_metrics()` or ergonomic auto-step `log()`.
- Log rank-aware scalar metrics with `log_rank_metrics()` for distributed
  training reducers and coverage/outlier dashboards.
- Log configs, searchable run tags, and searchable run notes.
- Log rich table/histogram/image/audio/video objects.
- Log local file and artifact wrappers through the upload route. The SDK contract is unchanged for hosted R2 storage: it still sends the upload payload to the Rust API, which stores bytes in the organization's configured artifact backend and returns the public artifact metadata row with an opaque `instantml://artifacts/<artifact_id>` URI for stored bytes.
- Log versioned artifacts with immutable manifests, `latest`/`best` aliases,
  explicit input/output lineage, safe downloads, and SDK-originated upload
  sessions for local inline or R2 presigned uploads.
- Log checkpoints.
- Log videos.
- Log tables.
- Log text series and histogram series.
- Log stdout/stderr console lines.
- Upload local files to the Rust server.
- Buffer training-loop events and flush explicitly.
- Spool failed post-init events to local JSONL and replay them.
- Write post-init events to a process-isolated local spool for a separate uploader process.
- Optionally write metric/log hot-path events to a per-run SQLite WAL queue and drain them with an SDK-managed background uploader process.
- Capture metrics-focused timestamp snapshots with a defined dictionary shape.
- Optionally keep a local SQLite audit store for attempted SDK events.
- Optionally sample psutil/NVML system metrics during a run.
- Optionally wrap stdout/stderr and expose lightweight Torch, Hugging Face Trainer, Lightning, and Keras adapters.
- Provide local adoption tools: W&B-compatible logging, W&B/Neptune/MLflow transformed JSON import, TensorBoard scalar sync, and Import v2 chunk upload to the Rust API.
- Capture source metadata for reproducibility with privacy-safe defaults and explicit opt-in knobs for command, paths, branch, host/process identifiers, and git diff summaries.
- Fork an existing Rust-backed run from a checkpoint and attach logging to that created child run.
- Finish runs cleanly.

Target public API:

```python
import instantml as ro

run = ro.init(
    project="cartpole",
    config={"seed": 42},
    tags=["baseline"],
    notes="Initial CartPole baseline.",
)
run.log({"train/loss": 0.12})  # implicit step 1
run.log({"train/reward": 100.0}, step=2)
run.log_metrics({"train/reward": 100.0}, step=1)
run.log_rank_metrics(
    {"train/loss": 0.12},
    step=1,
    rank=0,
    world_size=8,
    local_rank=0,
    weight=1024,
)
run.log_stdout("Epoch 1 reward=100.0")
run.log_stderr(["warning: entropy dipped"])
run.log_text({"notes/eval": "policy stabilized"}, step=1)
run.set_notes("Reward stabilized after step 80.")
run.set_tags(["baseline", "reviewed"])
run.log_histogram("model/weights", {"bins": [0, 1], "counts": [10]}, step=1)
run.log_objects({
    "eval/samples": ro.Table(["prompt", "score"], [["hello", 0.92]]),
    "eval/scores": ro.Histogram([0, 0.5, 1.0], [3, 9]),
    "eval/frame": ro.Image.from_data([[[255, 0, 0]]]),
}, step=1)
checkpoint_policy = ro.CheckpointPolicy(every_steps=100)
if checkpoint_policy.should_save(100):
    run.log_checkpoint_file("checkpoints/policy.pt", step=100)
run.log({"checkpoint": ro.File("checkpoints/policy.pt", artifact_type="checkpoint")}, step=1)
run.log_checkpoint("checkpoint.pt", "demo://checkpoint.pt", step=1)
run.log_video("rollout.mp4", "demo://rollout.mp4", step=1)
run.log_table("eval-table.jsonl", "demo://eval-table.jsonl", step=1)
artifact = ro.VersionedArtifact("policy-checkpoints", type="model")
artifact.add_file("checkpoints/policy.pt", name="checkpoint.pt")
logged = run.log_versioned_artifact(artifact, step=1000, aliases=["best"])
run.flush()
run.finish()

api = ro.Api(base_url="http://127.0.0.1:8000", api_key="instantml_...")
checkpoint_path = api.download_artifact("artifact-id", "checkpoints/policy.pt")
resolved = api.artifact("policy-checkpoints:best", type="model", project="cartpole")
child = api.fork_run("source-run-id", checkpoint_artifact_id="artifact-id")
forked_run = ro.attach_run(child["id"], base_url="http://127.0.0.1:8000", api_key="instantml_...")
forked_run.use_artifact(resolved)
forked_run.log({"train/loss": 0.1}, step=101)
forked_run.finish()
```

## CLI: Login, logout, whoami

The `instantml` CLI provides a frictionless setup path via the OAuth 2.0 device-authorization grant (RFC 8628). No API key copy/paste required.

```bash
# Authenticate: opens browser, prints a user code, polls until confirmed.
instantml login [--api-host URL]

# Remove stored credentials.
instantml logout

# Print the current org and user from stored credentials.
instantml whoami
```

After `instantml login`, credentials are written to `~/.instantml/credentials` (mode 0600) in TOML format:

```toml
api_key = "instantml_..."
api_host = "https://api.instantml.ai"
org_id = "..."
user_email = "alice@example.com"
```

The device-login key is org-scoped for SDK ingestion, artifact uploads,
Import v2 writes, and exports, so the same login supports dry-run imports,
TensorBoard sync, and normal training-loop logging.

## CLI: Imports And TensorBoard Sync

Import commands are intentionally local-first. They read source exports or
event files on the training machine, redact secret-looking values, translate
into canonical Import v2 chunks, upload dry-run summaries, and commit only when
the server accepts the final chunk. Third-party credentials are never sent to
InstantML.

```bash
# Transformed JSON exports.
instantml import wandb --project cartpole --input wandb.json
instantml import neptune --project cartpole --input neptune.json
instantml import mlflow --project cartpole --input mlflow.json

# Real Neptune Exporter Parquet directories. Pass --files-path when you want
# imported artifact references to point at the exported local files tree.
instantml import neptune --project cartpole --input ./exports/data --files-path ./exports/files

# Direct W&B local export through the official wandb SDK, then Import v2 upload.
instantml import wandb --project cartpole --entity my-team --source-project old-project

# TensorBoard scalar event import.
instantml sync tensorboard runs/tensorboard --project cartpole
instantml sync tensorboard runs/tensorboard --project cartpole --run-id existing-run-id
instantml sync tensorboard runs/tensorboard --project cartpole --watch --watch-interval 10

# Validate and inspect server-side warnings without committing runs.
instantml import neptune --project cartpole --input neptune.json --dry-run
```

Install only the extras you need:

```bash
pip install 'instantml[imports]'       # transformed JSON + Neptune Parquet helpers
pip install 'instantml[wandb]'         # direct local W&B export
pip install 'instantml[tensorboard]'   # TensorBoard event parsing
pip install 'instantml[frameworks]'    # HF/Lightning/Keras adapter imports
```

The Import v2 production slice covers runs, scalar metrics, configs, tags,
notes/metadata, statuses, typed attributes, external artifact references,
provenance metadata, dry-run warnings, and job history. It does not fetch
hosted W&B/Neptune data server-side and does not migrate artifact bytes.
Neptune Exporter metric histories stream out as bounded Import v2 chunks; run
metadata and external artifact references remain metadata-only. Repeated
TensorBoard syncs append scalar points to the existing imported TensorBoard run
when source identity matches.

## Credential resolution

`init()` resolves credentials in this order:

1. Explicit `api_key=` kwarg.
2. `INSTANTML_API_KEY` environment variable.
3. `~/.instantml/credentials` file (written by `instantml login`).
4. No credentials → `init()` raises `InstantMLError` immediately with a message directing you to `instantml login` or `INSTANTML_API_KEY`.

```python
# Option 1: explicit kwarg
run = ro.init(project="cartpole", api_key="instantml_...", base_url="https://api.example.com")

# Option 2: environment variable
# export INSTANTML_API_KEY=instantml_...
run = ro.init(project="cartpole", base_url="https://api.example.com")

# Option 3: after `instantml login`
run = ro.init(project="cartpole", base_url="https://api.example.com")
```

```bash
INSTANTML_API_KEY=instantml_... PYTHONPATH=packages/python-sdk python3 train.py
```

Design doc: `docs/design/2026-05-16-device-code-cli-login.md`

The hosted ClickHouse smoke proves this path against the Rust API's User Data and tenant-routing layer:

```bash
npm run test:hosted-clickhouse
```

That smoke creates an API key through the onboarding route, passes it to `instantml.init(...)`, logs metrics through the Python SDK, and verifies the dashboard summary route can read the tenant data after an API restart.

Run summary, artifact download, versioned artifact, and fork helpers use the
raw `Api` helper:

```python
api = ro.Api(base_url="http://127.0.0.1:8000", api_key="instantml_...")
page = api.runs(
    project="cartpole",
    q='tag:baseline status:finished notes:"reward stability"',
    sort_by="metric-best",
    metric_key="eval/return_mean",
    limit=25,
)
```

`Api.runs()` returns the decoded `/api/runs/summary` payload as a dictionary. It accepts `cursor`, `limit`, `offset`, `project`, `project_id`, `status`, `q`, `sort_by`, and `metric_key`, omits `None` and empty-string parameters, and raises `ValueError` when `cursor` is combined with a nonzero `offset`. Prefer `project` for Rust filtering; `project_id` remains a legacy SDK compatibility parameter and Rust-hosted summaries do not expose it as a query filter outside project-scoped API-key auth. The `q` language matches the dashboard search bar: bare terms are implicit `AND`, fields include `all`, `name`, `project`, `notes`, `config`, `metadata`, `tag`/`tags`, `status`, and `id`, uppercase `AND`/`OR`/`NOT` and grouping are supported, `-tag:debug` excludes field/group terms, quoted phrases are literal, and Rust supports explicit regex like `re:/seed-(13|14)/`. The deprecated Node compatibility API rejects completed regex with `run_search_regex_unsupported`.

`Api.download_artifact(artifact_id, output_path)` downloads stored raw artifact bytes, creates parent directories, and returns the written path. It is the restore primitive used by checkpoint resume snippets in the web UI. `Api.artifact(ref, type=..., project=...)` resolves a versioned artifact ref such as `policy-checkpoints:latest`, `policy-checkpoints:best`, or `policy-checkpoints:v0` and returns a `LoggedArtifact`; `LoggedArtifact.download(output_dir=...)` downloads stored manifest entries while keeping paths inside the requested root, `promote(alias="best", reason="...")` moves a custom alias, and `delete(delete_aliases=False, reason="...")` soft-deletes the version with the API's required confirmation fields. `Run.use_artifact(...)` records an input lineage edge from a resolved version to the run. `Api.fork_run(source_run_id, checkpoint_artifact_id=..., step=...)` calls the Rust same-project fork route and returns the created child run dictionary; the SDK derives a stable idempotency key from the fork body unless you pass `idempotency_key` explicitly. `attach_run(run_id, ...)` validates the run exists by default, then returns a default-async `Run` handle for logging into an existing child run. Use `validate=False` only with write-only credentials or intentionally offline attach flows, and call `finish()` or `wait_for_processing()` before short scripts exit so queued async events are drained.

Backend compatibility note: the SDK talks to the Rust/ClickHouse server by default, and it keeps compatibility with the deprecated Node server through the same REST contract. Do not add server-specific SDK branches unless a design doc changes the public API. Hosted Rust routes may eventually add explicit org context, but bearer API keys remain the first SDK auth path.

Source capture defaults intentionally favor reproducibility without broad local
environment leakage. `source_tracking=True` records entrypoint basename, git
availability/commit/dirty state, Python version, and platform. Use
`source_tracking=False` to omit `_rlobs.source`, or pass
`SourceTracking(command=True, paths=True, branch=True, hostname=True, pid=True,
git_diff=True)` to opt into argv, cwd/repo root, branch, host/pid, and a safe
git diff summary/digest. Raw patch text is never stored in run metadata.

`Run.log_rank_metrics(data, step, rank, world_size, local_rank=None, weight=None,
timestamp=None)` posts to `/runs/:run_id/rank-metrics`. `rank` is zero-based,
`world_size` is capped at 512, and `weight` defaults to `1.0`. Process-isolated
spool mode writes the same request shape to JSONL and the uploader replays it
with the spooled event id as `Idempotency-Key`.

Process-isolated upload mode for long training loops:

```python
run = ro.init(
    project="cartpole",
    upload_mode="spool",
    spool_dir=".instantml/spool",
)
run.log_snapshot(
    {
        "metrics": {"train/reward": 100.0, "train/loss": 0.12},
        "metadata": {"phase": "train"},
    },
    step=1,
)
run.finish()
```

Async metric/log mode is the default for `init()` and `Client.init()`. It is
inspired by Neptune-style local-first logging: scalar metrics, rank metrics,
console logs, and final run status are validated, snapshotted into a small
process-local producer buffer, group-committed to a per-run SQLite WAL queue,
and drained by a separate uploader process. The default producer flushes at 64
events, 64 KiB of serialized payloads, or 20 ms since the oldest buffered event.
Delivery, network, and API errors on those queued hot paths are reflected in
`Run.upload_status()` and dashboard upload-health metrics instead of raising
from `log_metrics()`, `log_rank_metrics()`, `log_console()`, or `finish()`.

```python
run = ro.init(
    project="cartpole",
)
run.log_metrics({"train/reward": 100.0}, step=1)
run.log_stdout("step=1 reward=100.0")
status = run.upload_status()
run.wait_for_submission(timeout=30)
run.finish(timeout=30)
```

Pass `queue_dir="..."` to move the default `.instantml/async` queue. The queue
stores flushed metric and console payloads locally as plaintext SQLite WAL files
with owner-only permissions where the OS supports them; add
`.instantml/` to `.gitignore` for projects that do not already ignore local SDK
state. A returned async `log()` can be lost if the Python process is killed
before the short producer buffer reaches SQLite, so call `flush()`, `finish()`,
or a wait helper before short scripts exit. `Run.upload_status()` forces a local
producer flush before returning and includes `buffered_events`, `buffered_bytes`,
and `last_flush_error`. If the queue cannot open or local queue limits are
reached, the SDK warns and continues the training loop. Use `upload_mode="sync"`
for scripts and CI checks that need metric/log API errors to raise in the
foreground.

Async v1 intentionally keeps response-returning helpers synchronous: configs,
attributes, tags, notes, rich objects, media, and artifact uploads stay on the
existing sync/process-spool paths until their replay contracts are idempotent.
If the managed uploader cannot start or a Python process exits early, drain
orphaned queues later with the same `INSTANTML_API_KEY` or `instantml login`
credentials used by normal SDK calls:

```bash
instantml-uploader --queue-dir .instantml/async --base-url http://127.0.0.1:8000
```

`Run.wait_for_submission(timeout=...)` first flushes the producer buffer, then
returns when pending rows have been claimed or processed.
`Run.wait_for_processing(timeout=...)` first flushes, then returns when queued
rows have either processed or failed. Both return `False` on timeout or terminal
queue failures. `Run.finish(timeout=None)` flushes existing events, queues and
flushes the final status, then waits using the client's HTTP timeout as a
bounded default. Pass an explicit timeout or call `wait_for_processing()` first
when you want a longer wait. See
`docs/design/2026-05-25-durable-async-sdk-logging.md` and
`docs/design/2026-05-27-async-sqlite-batching.md`.

On the async path, invalid payloads never crash the training loop either:
`log()`, `log_metrics()`, `log_rank_metrics()`, and `log_console()` warn-and-drop
a bad value (a `NaN`/`inf` scalar, a raw tensor, an unsupported type) and count
it under `Run.upload_status()["dropped"]` instead of raising. Use
`upload_mode="sync"` when you want validation errors to raise in the foreground
(scripts and CI).

## Process lifecycle, signals, and forked workers

The SDK installs best-effort shutdown handling the first time a run is created:

- **`atexit`** flushes buffered events and PATCHes the run to `finished` if you
  forget to call `finish()`, so a short script that exits early does not silently
  drop its last buffered metrics.
- **`SIGTERM`/`SIGINT`** (SLURM/Kubernetes preemption, Ctrl-C) flush buffered
  events and PATCH the run to `failed` before chaining to any pre-existing
  handler and re-raising — a preempted job stops being stuck in `running`
  forever. Signal handlers are only installed from the main thread; chained
  handlers and `SIG_IGN`/`SIG_DFL` dispositions are preserved.
- **`os.register_at_fork`** resets inherited SQLite connections, locks, and the
  uploader-process handle in forked children. A PyTorch
  `DataLoader(num_workers>0)` worker therefore never writes through the parent's
  queue file descriptor (which would corrupt the WAL); each process opens its own
  connection lazily.

`finish()` is idempotent, so an explicit `finish()` plus the lifecycle handlers
never double-PATCH or double-drain.

### Distributed (DDP / multi-process) training

All ranks sharing a single `run_id` also share one per-run queue file guarded by
a single-holder uploader lock, so only one rank can drain it. For distributed
runs:

- **Log from rank 0 only.** Call `init()`/`log()` solely on the rank-0 process
  and let other ranks skip logging. This is the simplest and recommended pattern.
- **Or give each rank its own queue.** If every rank must log to the same run,
  pass a distinct `queue_dir` per rank (e.g. `queue_dir=f".instantml/async/rank{rank}"`)
  so each rank owns an independent queue and uploader.
- Use `log_rank_metrics(..., rank=rank, world_size=world_size)` from rank 0 to
  attribute per-rank scalars without spinning up a queue per rank.

## Design Requirement

Before implementation, create or update design docs for:

- SDK package structure
- Public API
- Buffering and retry behavior
- Offline/local logging behavior
- Artifact upload behavior
- Compatibility with existing training loops

## Testing Expectations

SDK code should target 100% first-party code coverage.

Expected tests:

- Unit tests for public API behavior.
- Tests for serialization and validation.
- Tests for failed network calls.
- Tests for buffering/retry behavior if implemented.
- Tests for process spool and uploader behavior.
- Tests for async SQLite queue enqueue, retry/failure state, waits, recovery CLI, and no foreground HTTP on queued metric/log hot paths.
- Integration tests against a local API test server when applicable.

## Setup

From the repo root:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
python3 -m pip install -r packages/python-sdk/requirements-optional.txt  # optional integrations
```

## Package Distribution

The SDK is packaged as the `instantml` Python distribution. The core wheel has no required third-party runtime dependencies; optional media and system integrations stay behind extras and lazy imports.

Build and check the package from the repo root:

```bash
npm run sdk:build
npm run sdk:check
npm run sdk:test-install
```

For local editable development without `PYTHONPATH`:

```bash
python3 -m pip install -e packages/python-sdk
```

Once the package is published, users install it with:

```bash
python3 -m pip install instantml
```

Optional extras:

```bash
python3 -m pip install "instantml[media]"
python3 -m pip install "instantml[system]"
python3 -m pip install "instantml[all]"
```

Release upload uses `.github/workflows/python-sdk-release.yml` with PyPI/TestPyPI Trusted Publishing. Before the first upload, configure pending trusted publishers for the `instantml` project, using workflow file `python-sdk-release.yml` and GitHub Environments `pypi` and `testpypi`. Public PyPI publication should remain gated on final public license/terms approval; the package metadata currently marks the SDK as `LicenseRef-Proprietary` rather than open source.

## Module Layout

`instantml.client` remains the public compatibility facade for `Client`, `Api`,
`Run`, `init()`, `attach_run()`, rich object wrappers, and private helpers that
older tests or scripts may import. The first decomposition slice moves leaf
helpers into focused modules:

- `instantml.objects`: table, histogram, file/artifact, checkpoint policy, text,
  image, audio, and video value wrappers.
- `instantml.media`: local-file URI checks, file hashing, and lazy image/audio/
  video materialization helpers.
- `instantml.log_payload`: `Run.log()` payload classification and rank-metric
  context validation helpers.

Keep new leaf modules free of runtime imports from `instantml.client`. Stateful
run lifecycle, async queue coordination, console capture, system metrics,
process spooling, and framework adapters still live in `client.py` until a
follow-up design splits those collaborator boundaries.

## Usage

```python
import instantml as ro

run = ro.init(project="cartpole", config={"seed": 42}, tags=["baseline"], notes="CartPole baseline.")
run.log({"train/reward": 100.0})
run.log({"train/loss": 0.12, "notes/eval": "policy stabilized"}, step=2)
run.log_config({"optimizer": {"lr": 0.0003}})
run.add_tags(["baseline"])
run.set_tags(["baseline", "ready-for-compare"])
run.set_notes("Reward improved but entropy dipped late.")
run.log_checkpoint("policy.pt", "demo://policy.pt", step=1)
run.log_rollout("eval.mp4", "demo://eval.mp4", step=1)
run.log_video("rollout.mp4", "demo://rollout.mp4", step=1)
run.log_table("rollout-table.jsonl", "demo://rollout-table.jsonl", step=1)
run.log_table_object("eval/samples", ["prompt", "score"], [["hello", 0.92]], step=1)
run.finish()
```

`Run.log()` is the ergonomic API. If `step` is omitted it auto-increments from `1`; if `step` is provided it uses that value and advances the implicit counter to at least that step. It classifies values before sending any request:

- finite numeric scalars -> metric batch
- strings and `Text(...)` -> string series
- `Table`, `Histogram`, `Image`, `Audio`, `Video` -> rich objects
- `File(...)` and `Artifact(...)` -> artifact upload

Mixed `log()` calls are deterministic but not atomic across routes: metrics are sent first, then text, table/histogram objects, files, and media objects. If a later request fails, earlier requests may already be stored. In `upload_mode="spool"`, each sub-event remains one fsynced request file. Rich media object helpers still require sync mode because object linking needs the upload response.

Data wrappers preserve the original path-first constructors and add conversion factories:

```python
run.log({
    "eval/table": ro.Table.from_data([{"prompt": "hello", "score": 0.92}]),
    "eval/scores": ro.Histogram.from_values([0.1, 0.3, 0.9], bins=8),
    "eval/frame": ro.Image.from_data(frame_array),
    "checkpoint": ro.File("checkpoints/policy.pt", artifact_type="checkpoint"),
})
```

Optional media conversions import dependencies lazily. `Image.from_data()` supports PIL images, NumPy-like arrays, and matplotlib figures. `Audio.from_data()` requires `soundfile`; `Video.from_data()` requires `imageio` or `moviepy`.

Optional audit and runtime capture:

```python
run = ro.init(
    project="cartpole",
    local_store=True,
    local_store_dir=".instantml/local",
    system_metrics_interval=15.0,
    capture_console=True,
)
```

The SQLite store records attempted SDK events before submit; it is not replay and not proof the server accepted the event. System metrics are enabled by default and log under `system/...` at the current step without incrementing it; pass `system_metrics=False` to disable. Console capture writes through to the original streams and logs non-empty lines under `console/stdout` and `console/stderr`.

Framework adapters stay deliberately small:

```python
run.watch(model, log="gradients", log_freq=100)
trainer.add_callback(ro.InstantMLCallback(run=run))  # alias: TransformersCallback
logger = ro.InstantMLLogger(project="cartpole")      # alias: LightningLogger
keras_callback = ro.InstantMLKerasCallback(project="cartpole")
```

W&B compatibility is opt-in and intentionally a small logging subset:

```python
import instantml.compat.wandb as wandb

with wandb.init(project="cartpole", config={"seed": 13}) as run:
    wandb.log({"train/loss": 0.1}, step=1)
    artifact = wandb.Artifact("checkpoint", type="model")
    artifact.add_reference("s3://bucket/checkpoint.pt")
    run.log_artifact(artifact)
```

Unsupported W&B surfaces such as sweeps, `mode="offline"`/`"dryrun"`,
`WANDB_MODE=offline`/`dryrun`, and batching kwargs such as
`wandb.log(..., commit=False)` raise `UnsupportedWandbFeature` with a clear
message. Use the official `wandb` package in parallel when you need full W&B
behavior during a transition.
```

Buffered logging and post-init offline replay:

```python
run = ro.init(
    project="cartpole",
    buffer_size=25,
    offline_dir=".instantml/offline",
)
for step in range(1000):
    run.log_metrics({"train/reward": step}, step=step)
run.finish()

# Later, after the server is reachable, replay events logged after run creation:
run.replay_offline()
```

Important limitation: `init()` still requires a reachable server because run creation is not spooled yet. `offline_dir` only applies to failed requests made by an existing `Run`.

Process-isolated upload mode:

```python
run = ro.init(
    project="cartpole",
    upload_mode="spool",
    spool_dir=".instantml/spool",
)

for step in range(1000):
    run.log_snapshot(
        {
            "metrics": {
                "train/reward": reward,
                "train/policy_loss": policy_loss,
            },
            "metadata": {"phase": "train"},
        },
        step=step,
    )

run.finish()
```

Run the uploader in a separate process:

```bash
PYTHONPATH=packages/python-sdk python3 -m instantml.uploader \
  --spool-dir .instantml/spool \
  --base-url http://127.0.0.1:8000
```

Use `upload_mode="spool"` when the training process should avoid post-init HTTP calls. The SDK writes one fsynced JSON event file per logging call, and the uploader drains those files through the existing API. Metric and console-log event files send their `event_id` as an `Idempotency-Key`, so a compatible server can safely accept retried metric/log events. This first implementation is intended for roughly 100 SDK calls per second per run on a local SSD; batch many scalar values into one metrics dictionary for higher-frequency loops.

Console logging uses the same one-request event format. `Run.log_console(...)`,
`Run.log_stdout(...)`, and `Run.log_stderr(...)` assign deterministic
per-run/per-stream line numbers before sending or spooling the event. Each
console-log request accepts at most 50 lines so worst-case messages fit under
the Rust API's default JSON body limit.

`log_snapshot()` currently accepts only:

- `metrics`: scalar metrics sent to the server.
- `metadata`: JSON metadata kept in the local event envelope for debugging and future ingestion.

`step` defaults to `0` for `log_snapshot()` so strict servers receive a numeric metric step. Pass an explicit step for normal training-loop use.

Existing helpers such as `log()`, `log_config()`, `log_text()`, `log_histogram()`, `log_objects()` for inline table/histogram objects, `add_tags()`, `log_artifact()`, and `finish()` also write single-request events in process spool mode. Mixed `log()` payloads are split into deterministic single-request sub-events. `upload_file()` records `source_path`, SHA-256, and size, then lets the uploader read and encode the file later, so keep source files stable until the uploader succeeds. Rich media object helpers are sync-only for now because linking the object to the uploaded artifact requires the upload response.

Run identification helpers:

- `init(notes="...")` writes the searchable run note into `metadata.notes`.
- `Run.set_notes("...")` updates `metadata.notes`; pass an empty string to clear the note on compatible Rust/Node servers.
- `Run.set_tags([...])` replaces the searchable `runs.tags` list.
- `Run.add_tags([...])` still logs typed tag attributes. Use `set_tags()` when the Runs workspace/search identity should change.

Local file upload against the Rust server:

```python
run.upload_file("checkpoints/policy.pt", artifact_type="checkpoint", step=100)
run.log_checkpoint_file("checkpoints/policy.pt", step=100, metadata={"framework": "torch"})
```

Use `CheckpointPolicy(every_steps=N)` when a training loop wants an explicit interval. `Run.log_checkpoint_file()` is a checkpoint-specific wrapper around `upload_file()` that stores bytes as `type="checkpoint"` and records restore metadata such as the source run ID and step. Existing metadata-only `log_checkpoint()` remains available when bytes are stored outside InstantML.

For local development without packaging:

```bash
PYTHONPATH=packages/python-sdk python3 -c "import instantml as ro; print(ro.Client())"
```

## Test

```bash
python3 -m pytest
```

The SDK defaults to buffered async metric/log uploads with a 10 second client timeout for foreground setup and bounded `finish()` waits. Short-window HTTP `429` rate-limit responses are retried by the uploader, honoring `Retry-After` when the server sends it; monthly quota `429` responses become failed queued rows. Use `upload_status()` or the wait helpers to detect async delivery failures, or pass `upload_mode="sync"` when foreground metric/log HTTP errors should raise `InstantMLError`. Set `buffer_size` to batch sync post-init events in memory, `offline_dir` to spool failed existing-run requests as JSONL for later replay, or `upload_mode="spool"` to move post-init HTTP work into a separate uploader process. Artifact/checkpoint/rollout metadata works through the Rust server endpoints; `upload_file()` and `log_checkpoint_file()` additionally hash and send bytes to local/R2 raw artifact storage in sync mode and record a source path for the uploader in process spool mode. Versioned artifacts require sync mode in this slice because presigned upload URLs are short-lived bearer secrets and the process spool contract does not yet persist multipart state.

The SDK is tested against the primary Rust server, the deprecated Node compatibility server, and the Python bootstrap API for overlapping endpoints. Metric `step` values are finite nonnegative numbers across the SDK, Rust server, Node server, Python bootstrap API, and importer-shaped metric payloads. Metric timestamps are ISO-compatible datetimes when supplied.

Automatic SDK source metadata is reserved under `metadata["_rlobs"]["source"]`. User metadata may still use a top-level `source` key for its own meaning, but `_rlobs` is SDK-owned and `init(metadata={"_rlobs": ...})` raises `ValueError`.

## TODO: v1.5 Reports SDK

The dashboard now ships a Reports surface — Notion-style documents that combine
prose, code, and live PanelGrids for cross-project run queries. Legacy
LLM-summary blocks may render in existing reports, but the public SDK builder
should track the dashboard-supported block set. Programmatic
creation from the SDK lands in v1.5: an
`instantml.Report(title=..., blocks=[...]).save()` builder mirroring the
`Runset` / `Panel` data classes the Rust API already accepts. Track this
against the wiki `reports-feature` spec when the time comes; the operational
record kind is `report` and the schema is documented under
`apps/rust-server/src/store/reports/`.

## Notes for Future Agents

- Keep the API tiny and obvious.
- Logging should not materially slow training loops.
- Avoid surprising background behavior.
- Make failure behavior explicit and documented.
- Keep process spool events to one API request each unless a design doc expands idempotency across multi-request snapshots.
- Preserve per-run uploader ordering when retrying failed event files.
- Support dual-logging or coexistence with MLflow/W&B where practical.
- Keep `instantml.compat.wandb` opt-in so importing `wandb` still means the official W&B package unless a user intentionally aliases the compatibility module.
- Keep import translators local-first; do not add hosted W&B/Neptune credential flows without a new design doc and threat model update.
- Keep SDK-owned metadata under `_rlobs` and reject user-provided `_rlobs` keys before merging metadata.
- Add true offline run creation only after a design doc; do not imply it in README examples until implemented.
- Keep API-key auth, idempotency keys, metric step validation, and artifact upload behavior compatible with the primary Rust/ClickHouse backend and deprecated Node backend.
