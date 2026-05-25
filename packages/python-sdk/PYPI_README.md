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

```bash
instantml whoami    # confirm who you're logged in as
instantml logout    # clear the cached credential
```

## Log a run

```python
import os
import instantml as im

run = im.init(project="llm-7b-sft", config=cfg)
checkpoint_policy = im.CheckpointPolicy(every_steps=500)
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
    if checkpoint_policy.should_save(step):
        save_model("./ckpt/model.pt")
        run.log_checkpoint_file("./ckpt/model.pt", step=step)

run.finish()
```

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

If you're migrating from W&B and want to compare numbers side-by-side, pass `shadow_wandb=True` to `init`. Every `log`, `finish`, and `log_artifact` call is mirrored to a parallel `wandb.Run`, using your existing `WANDB_API_KEY` / `WANDB_ENTITY` env vars. `wandb.init` runs on a background thread so InstantML's init stays sub-millisecond.

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

## Optional extras

The core package has no required third-party runtime dependencies. Install extras for richer local conversions and system metrics:

```bash
pip install "instantml[media]"     # Pillow, imageio, moviepy, soundfile
pip install "instantml[system]"    # psutil, pynvml
pip install "instantml[all]"
```

The SDK also ships a process-isolated spool uploader for high-throughput offline replay:

```bash
instantml-uploader --spool-dir .instantml/spool
```

For long-running jobs, opt into durable async metric/log uploads:

```python
run = instantml.init(project="cartpole", upload_mode="async")
run.log_metrics({"train/reward": 100.0}, step=1)
run.log_stdout("step=1 reward=100.0")
run.wait_for_submission(timeout=30)
run.finish(timeout=30)
```

Async mode stores scalar metrics, rank metrics, console logs, and final status in
a per-run SQLite WAL queue, then drains that queue in a background uploader
process. Network and delivery errors are surfaced through `run.upload_status()`
and warnings instead of raising from the hot logging path. Orphaned queues can be
recovered with the same environment or `instantml login` credentials:

```bash
instantml-uploader --queue-dir .instantml/async
```

## License

Apache 2.0 — see [LICENSE](LICENSE). The InstantML hosted backend (dashboard, API, storage) is a separate commercial offering; the SDK in this package is open source.
