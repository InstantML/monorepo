# Python SDK

This directory contains the Python SDK used by training scripts to send runs, metrics, attributes, artifacts, checkpoints, and source context to InstantML.

## Responsibilities

- Initialize runs.
- Log scalar metrics with explicit `log_metrics()` or ergonomic auto-step `log()`.
- Log configs, searchable run tags, and searchable run notes.
- Log rich table/histogram/image/audio/video objects.
- Log local file and artifact wrappers through the upload route.
- Log checkpoints.
- Log videos.
- Log tables.
- Log text series and histogram series.
- Log stdout/stderr console lines.
- Upload local files to the Rust server.
- Buffer training-loop events and flush explicitly.
- Spool failed post-init events to local JSONL and replay them.
- Write post-init events to a process-isolated local spool for a separate uploader process.
- Capture metrics-focused timestamp snapshots with a defined dictionary shape.
- Optionally keep a local SQLite audit store for attempted SDK events.
- Optionally sample psutil/NVML system metrics during a run.
- Optionally wrap stdout/stderr and expose lightweight Torch, Transformers, and Lightning adapters.
- Capture source metadata for reproducibility.
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
run.log({"checkpoint": ro.File("checkpoints/policy.pt", artifact_type="checkpoint")}, step=1)
run.log_checkpoint("checkpoint.pt", "demo://checkpoint.pt", step=1)
run.log_video("rollout.mp4", "demo://rollout.mp4", step=1)
run.log_table("eval-table.jsonl", "demo://eval-table.jsonl", step=1)
run.flush()
run.finish()
```

Hosted or auth-required servers can use an API key directly or through `INSTANTML_API_KEY`:

```python
run = ro.init(project="cartpole", api_key="instantml_...", base_url="https://api.example.com")
```

```bash
INSTANTML_API_KEY=instantml_... PYTHONPATH=packages/python-sdk python3 train.py
```

The hosted ClickHouse smoke proves this path against the Rust API's User Data and tenant-routing layer:

```bash
npm run test:hosted-clickhouse
```

That smoke creates an API key through the onboarding route, passes it to `instantml.init(...)`, logs metrics through the Python SDK, and verifies the dashboard summary route can read the tenant data after an API restart.

Read-only run summary queries use the raw `Api` helper:

```python
api = ro.Api(base_url="http://127.0.0.1:8000", api_key="instantml_...")
page = api.runs(
    project="cartpole",
    q="seed 13",
    sort_by="metric-best",
    metric_key="eval/return_mean",
    limit=25,
)
```

`Api.runs()` returns the decoded `/api/runs/summary` payload as a dictionary. It accepts `cursor`, `limit`, `offset`, `project`, `project_id`, `status`, `q`, `sort_by`, and `metric_key`, omits `None` and empty-string parameters, and raises `ValueError` when `cursor` is combined with a nonzero `offset`.

Backend compatibility note: the SDK talks to the Rust/ClickHouse server by default, and it keeps compatibility with the deprecated Node server through the same REST contract. Do not add server-specific SDK branches unless a design doc changes the public API. Hosted Rust routes may eventually add explicit org context, but bearer API keys remain the first SDK auth path.

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
- Integration tests against a local API test server when applicable.

## Setup

From the repo root:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
python3 -m pip install -r packages/python-sdk/requirements-optional.txt  # optional integrations
```

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
    system_metrics=True,
    system_metrics_interval=15.0,
    capture_console=True,
)
```

The SQLite store records attempted SDK events before submit; it is not replay and not proof the server accepted the event. System metrics log under `system/...` at the current step without incrementing it. Console capture writes through to the original streams and logs non-empty lines under `console/stdout` and `console/stderr`.

Framework adapters stay deliberately small:

```python
run.watch(model, log="gradients", log_freq=100)
trainer.add_callback(ro.TransformersCallback(run=run))
logger = ro.LightningLogger(project="cartpole")
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
```

For local development without packaging:

```bash
PYTHONPATH=packages/python-sdk python3 -c "import instantml as ro; print(ro.Client())"
```

## Test

```bash
python3 -m pytest
```

The SDK uses synchronous HTTP calls by default with a 2 second timeout and raises `InstantMLError` for network or non-2xx API failures. Set `buffer_size` to batch post-init events in memory, `offline_dir` to spool failed existing-run requests as JSONL for later replay, or `upload_mode="spool"` to move post-init HTTP work into a separate uploader process. Artifact/checkpoint/rollout metadata works through the Rust server endpoints; `upload_file()` additionally hashes and sends bytes to local artifact storage in sync mode and records a source path for the uploader in process spool mode.

The SDK is tested against the primary Rust server, the deprecated Node compatibility server, and the Python bootstrap API for overlapping endpoints. Metric `step` values are finite nonnegative numbers across the SDK, Rust server, Node server, Python bootstrap API, and importer-shaped metric payloads. Metric timestamps are ISO-compatible datetimes when supplied.

Automatic SDK source metadata is reserved under `metadata["_rlobs"]["source"]`. User metadata may still use a top-level `source` key for its own meaning, but `_rlobs` is SDK-owned and `init(metadata={"_rlobs": ...})` raises `ValueError`.

## Notes for Future Agents

- Keep the API tiny and obvious.
- Logging should not materially slow training loops.
- Avoid surprising background behavior.
- Make failure behavior explicit and documented.
- Keep process spool events to one API request each unless a design doc expands idempotency across multi-request snapshots.
- Preserve per-run uploader ordering when retrying failed event files.
- Support dual-logging or coexistence with MLflow/W&B where practical.
- Keep SDK-owned metadata under `_rlobs` and reject user-provided `_rlobs` keys before merging metadata.
- Add true offline run creation only after a design doc; do not imply it in README examples until implemented.
- Keep API-key auth, idempotency keys, metric step validation, and artifact upload behavior compatible with the primary Rust/ClickHouse backend and deprecated Node backend.
