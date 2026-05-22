# InstantML Python SDK

InstantML is a training-loop observability SDK for logging runs, scalar metrics, configs, tags, notes, artifacts, checkpoints, tables, histograms, media, and source context to an InstantML API.

```bash
python -m pip install instantml
python train.py
```

```python
import instantml as im

run = im.init(project="llm-7b-sft", config=cfg)
checkpoint_policy = im.CheckpointPolicy(every_steps=500)

for step, batch in enumerate(loader):
    loss = train_step(batch)
    run.log({"loss": loss}, step=step)
    if checkpoint_policy.should_save(step):
        save_model("./ckpt/model.pt")
        run.log_checkpoint_file("./ckpt/model.pt", step=step)

run.finish()
```

By default the SDK talks to the hosted InstantML API at `https://api.instantml.ai`. Set `INSTANTML_API_KEY` (or pass `api_key=`) — that's all most users need. Override the base URL for local development or self-hosted deployments via `INSTANTML_API_BASE_URL` (or pass `base_url=`):

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

The package also installs the `instantml` CLI for browser-based device login:

```bash
instantml login --api-host https://api.example.com
instantml whoami
instantml logout
```

The core package has no required third-party runtime dependencies. Optional extras are available for richer local conversions and system metrics:

```bash
python -m pip install "instantml[media]"
python -m pip install "instantml[system]"
python -m pip install "instantml[all]"
```

The SDK also ships a process-isolated spool uploader:

```bash
instantml-uploader --spool-dir .instantml/spool --base-url http://127.0.0.1:8000
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

## License

Apache 2.0 — see [LICENSE](LICENSE). The InstantML hosted backend (dashboard, API, storage) is a separate commercial offering; the SDK in this package is open source.
