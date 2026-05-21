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

By default the SDK talks to a local InstantML API at `http://127.0.0.1:8000`. For hosted or auth-required APIs, pass `base_url=` and `api_key=` or set `INSTANTML_API_KEY`:

```python
run = im.init(
    project="cartpole",
    base_url="https://api.example.com",
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

License note: this package is not currently published as open source. Public licensing or source-available terms should be confirmed before a broad public release.
