# InstantML Python SDK

InstantML is a training-loop observability SDK for logging runs, scalar metrics, rank-aware distributed metrics, configs, tags, notes, artifacts, checkpoints, tables, histograms, media, and source context to the InstantML platform.

## Install

```bash
pip install --pre instantml
```

(The `--pre` flag opts in to the current alpha. Drop it once `0.1.0` ships.)

## Log in

```bash
instantml login
```

Opens your browser, completes a device-code flow against the InstantML platform, and stores the resulting credential at `~/.instantml/credentials`. The SDK reads it automatically — no env vars to manage. Same UX as `wandb login`, `gh auth login`, `gcloud auth login`.

Device-code credentials are scoped for scalar/rich-object SDK ingest and read/export jobs. Use a dashboard or onboarding API key with `artifacts:write` when a script uploads files, checkpoints, or artifact bytes.

```bash
instantml whoami    # confirm who you're logged in as
instantml logout    # clear the cached credential
```

## Log a run

```python
import os
import instantml as im

run = im.init(project="llm-7b-sft", config=cfg)
rank = int(os.environ.get("RANK", "0"))
world_size = int(os.environ.get("WORLD_SIZE", "1"))

for step, batch in enumerate(loader):
    loss = train_step(batch)
    run.log({"loss": loss}, step=step)
    # Optional: distributed workers can log per-rank values for reducer,
    # coverage, heatmap, and outlier dashboards.
    run.log_rank_metrics(
        {"loss": loss},
        step=step,
        rank=rank,
        world_size=world_size,
        weight=len(batch),
    )
run.finish()
```

To upload checkpoints, use an API key that includes `artifacts:write`:

```python
run = im.init(project="llm-7b-sft", api_key="instantml_...")
policy = im.CheckpointPolicy(every_steps=500)

for step, batch in enumerate(loader):
    loss = train_step(batch)
    run.log({"loss": loss}, step=step)
    if policy.should_save(step):
        save_model("./ckpt/model.pt")
        run.log_checkpoint_file("./ckpt/model.pt", step=step)

run.finish()
```

## Fork and attach to a checkpoint retry

When the dashboard or API creates a linked fork from a checkpoint, attach the
SDK to that existing run record and continue logging:

```python
api = im.Api(base_url="http://127.0.0.1:8000", api_key="instantml_...")
child = api.fork_run("source-run-id", checkpoint_artifact_id="artifact-id", step=500)
run = im.attach_run(child["id"], base_url="http://127.0.0.1:8000", api_key="instantml_...")
run.log({"loss": 0.12}, step=501)
run.finish()
```

Forking creates a same-project linked run record only; it does not start
training or copy metrics/artifacts. The SDK derives a stable fork idempotency
key from the request body by default so retrying the same fork call returns the
same child run instead of creating duplicates. `attach_run()` validates the
target run by default and uses async uploads; use `validate=False` only for
write-only credentials or intentionally offline attach flows, and call
`finish()` or `wait_for_processing()` before short scripts exit.

## Running on a remote server or CI

Skip `instantml login` and pass credentials explicitly. Two ways:

```bash
export INSTANTML_API_KEY=instantml_...
```

```python
run = im.init(project="cartpole", api_key="instantml_...")
```

Get a key from **Settings → API Keys** in the dashboard.

## Self-hosted / local development

Override the API base URL via env var or kwarg:

```bash
export INSTANTML_API_BASE_URL=http://127.0.0.1:8000
```

```python
run = im.init(
    project="cartpole",
    base_url="http://127.0.0.1:8000",
    api_key="instantml_...",
)
```

## Shadow Weights & Biases

If you're migrating from W&B and want to compare numbers side-by-side, pass `shadow_wandb=True` to `init`. Scalar `run.log(...)` calls, `finish()`, and local-file metadata artifacts created with `log_artifact("name", "file://path", ...)` are mirrored to a parallel `wandb.Run`, using your existing `WANDB_API_KEY` / `WANDB_ENTITY` env vars. `wandb.init` runs on a background thread so InstantML's init stays sub-millisecond.

```python
run = im.init(project="llm-7b-sft", config=cfg, shadow_wandb=True)
```

Override the W&B project or entity independently:

```python
run = im.init(
    project="llm-7b-sft",
    shadow_wandb={"project": "llm-experiments", "entity": "my-team"},
)
```

Attach to an already-initialized `wandb.Run`:

```python
import wandb
wb_run = wandb.init(project="llm-7b-sft")
run = im.init(project="llm-7b-sft", shadow_wandb=wb_run)
```

If `wandb` is not installed or `wandb.init` fails, shadow logging is disabled with a warning and InstantML logging continues unaffected.

InstantML remains the source of truth for rich objects, uploaded files,
checkpoint uploads, console capture, and system metrics.

## Optional extras

The core package has no required third-party runtime dependencies. Install extras for richer local conversions and system metrics:

```bash
pip install "instantml[media]"     # Pillow, imageio, moviepy, soundfile
pip install "instantml[system]"    # psutil, pynvml
pip install "instantml[all]"
```

`source_tracking=True` uses privacy-safe defaults: entrypoint basename, git
availability/commit/dirty state, Python version, and platform. Pass
`im.SourceTracking(...)` to opt into argv, cwd/repo root, branch, host/pid, and
safe git diff summary/digest capture; raw patch text is not stored in run
metadata.

The SDK also ships a process-isolated spool uploader for high-throughput offline replay:

```bash
instantml-uploader --spool-dir .instantml/spool
```

By default, `instantml.init()` uses buffered async metric/log uploads:

```python
run = im.init(project="cartpole")
run.log_metrics({"train/reward": 100.0}, step=1)
run.log_stdout("step=1 reward=100.0")
run.wait_for_submission(timeout=30)
run.finish(timeout=30)
```

Async mode snapshots scalar metrics, rank metrics, console logs, and final
status into a small process-local producer buffer, group-commits them to a
per-run SQLite WAL queue, then drains that queue in a background uploader
process. The default producer flushes at 64 events, 64 KiB, or 20 ms. A returned
async `log()` can be lost if the Python process is killed before that short
buffer reaches SQLite, so call `finish()`, `flush()`, or a wait helper before
short scripts exit. Network and delivery errors are surfaced through
`run.upload_status()` and warnings instead of raising from the hot logging path.
Pass `upload_mode="sync"` when a script or CI check needs immediate foreground
API errors from metric/log calls. Pass `queue_dir="..."` to move the default
`.instantml/async` local queue. Flushed queue payloads are stored as plaintext
SQLite WAL files with owner-only permissions where the OS supports them.
Orphaned flushed queues can be recovered with the same environment or
`instantml login` credentials:

```bash
instantml-uploader --queue-dir .instantml/async
```

## License

Apache 2.0 — see [LICENSE](LICENSE). The InstantML hosted backend (dashboard, API, storage) is a separate commercial offering; the SDK in this package is open source.
