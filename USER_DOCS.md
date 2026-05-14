# Training Observability User Guide

Training Observability helps you log training runs from Python, compare metrics across runs, inspect configs and artifacts, and turn those logs into a fast experiment workspace.

This guide is written for users of the product and SDK. It avoids internal implementation detail unless it affects how you log data.

## What You Get

- A Python SDK for creating runs and logging metrics, configs, tags, notes, text, histograms, artifacts, checkpoints, rollouts, tables, and uploaded files.
- A Rust/Postgres API that stores run metadata, scalar metric history, summaries, artifacts, searchable tags, and searchable notes.
- A web UI for browsing runs, building dashboard panels, comparing selected runs, inspecting run details, and previewing safe artifact media.

## Start A Local Beta Server

From a source checkout, start the API:

```bash
npm run dev:api
```

This serves the Rust/Postgres API at:

```text
http://127.0.0.1:8000
```

Start the web UI in another terminal:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Open:

```text
http://127.0.0.1:3000
```

Sign up with the labeled local dev Google-style flow, create a copy-once SDK key, and open the dashboard. Click `Reset demo` if you want a rich synthetic project to explore before logging your own runs.

## Use The Python SDK

The current source package is imported as `rl_observability`.

For local source usage:

```bash
export PYTHONPATH="$PWD/packages/python-sdk"
```

For hosted or auth-required servers, set an API key:

```bash
export RLOBS_API_KEY="rlobs_..."
```

You can also pass `api_key="rlobs_..."` directly to `ro.init(...)`.

Common connection options:

```python
import rl_observability as ro

client = ro.Client(
    base_url="http://127.0.0.1:8000",
    timeout=2.0,
    api_key="rlobs_...",
)

run = client.init(project="cartpole", name="ppo-seed-42")
```

Most users can call `ro.init(...)` directly. Use `ro.Client(...)` when you want to reuse a base URL, timeout, API key, or offline directory across several runs in the same script.

## Minimal Example

```python
import rl_observability as ro

run = ro.init(
    project="cartpole",
    name="ppo-seed-42",
    config={"seed": 42, "algorithm": "ppo", "learning_rate": 3e-4},
    tags=["ppo", "baseline"],
    notes="First PPO baseline.",
    base_url="http://127.0.0.1:8000",
)

for step in range(100):
    run.log_metrics(
        {
            "train/reward": step * 1.5,
            "train/loss": 1.0 / (step + 1),
            "eval/accuracy": min(1.0, 0.5 + step / 200),
        },
        step=step,
    )

run.finish()
```

In the UI:

- `project="cartpole"` appears in the Project selector.
- `name="ppo-seed-42"` appears in the Runs list.
- `config` values appear in Run Detail and Compare.
- `tags` and `notes` are searchable in the run list and editable later.
- Metric keys such as `train/reward` and `eval/accuracy` become chartable series in Runs, Metrics, Run Detail, and Compare.
- `finish()` marks the run as finished.

## Recommended Metric Naming

Use slash-separated namespaces:

```text
train/loss
train/reward
eval/accuracy
eval/return_mean
system/gpu_memory_mb
optimizer/grad_norm
```

The UI uses these namespaces to group panels and make metric search easier. Unit-bounded metrics such as accuracy, precision, recall, F1, and AUC use normalized `0..1` y-axes in charts; return, reward, and loss metrics auto-scale to their observed values.

## Context Manager Pattern

Use a context manager when you want interrupted runs to be marked as failed automatically:

```python
import rl_observability as ro

with ro.init(project="mnist", name="cnn-seed-7", config={"seed": 7}) as run:
    for epoch in range(10):
        run.log_metrics(
            {"train/loss": 0.8 / (epoch + 1), "val/accuracy": 0.7 + epoch * 0.02},
            step=epoch,
        )
```

If the block exits normally, the SDK finishes the run as `finished`. If an exception escapes the block, the SDK marks it as `failed`.

## Configs, Tags, And Notes

Pass stable run identity at creation time:

```python
run = ro.init(
    project="iris-classification",
    name="softmax-regularized-seed-17",
    config={
        "dataset": "UCI Iris",
        "model": "softmax-regression",
        "seed": 17,
        "learning_rate": 0.12,
        "l2": 0.015,
    },
    tags=["real-data", "numpy", "regularized"],
    notes="Compare calibration and macro F1 against the baseline.",
)
```

Run notes are trimmed and limited to 512 UTF-8 bytes. Use notes for short searchable context, not full experiment reports.

Attach extra JSON metadata:

```python
run = ro.init(
    project="finetune",
    metadata={"trainer": "custom-loop", "cluster": "a100-dev"},
)
```

The SDK automatically captures Python, platform, hostname, process ID, current working directory, argv, and Git metadata when available. Disable that with `source_tracking=False`:

```python
run = ro.init(project="private-run", source_tracking=False)
```

`metadata["_rlobs"]` is reserved for SDK-owned source metadata and cannot be supplied by users.

Update searchable tags and notes later:

```python
run.set_tags(["real-data", "numpy", "regularized", "ready-for-report"])
run.set_notes("Best validation accuracy, but calibration needs review.")
```

Add typed tag attributes when you want tags recorded as event-style metadata:

```python
run.add_tags(["ablation"])
run.add_tags(["sweep-a"], group_tags=True)
```

Use `set_tags(...)` for the tags you want the Runs list, search, and Compare views to treat as run identity. Use `add_tags(...)` for typed tag history.

## Logging Scalars

`log(...)` is an alias for `log_metrics(...)`.

```python
run.log({"train/reward": 100.0}, step=1)

run.log_metrics(
    {
        "train/loss": 0.24,
        "train/accuracy": 0.91,
        "eval/loss": 0.31,
        "eval/accuracy": 0.88,
    },
    step=20,
)
```

Steps must be finite, nonnegative numbers. The UI expects a metric's step values to move forward over time; the SDK warns if you log a lower step for the same metric after a higher one.

You can attach an explicit timestamp:

```python
run.log_metrics({"train/loss": 0.18}, step=21, timestamp="2026-05-10T12:00:00Z")
```

## Logging Extra Data

Flatten config dictionaries into config attributes:

```python
run.log_config({"optimizer": {"name": "adamw", "lr": 3e-4}})
```

Log text series:

```python
run.log_text({"notes/eval": "Policy stabilized after entropy regularization."}, step=80)
```

Log histograms:

```python
run.log_histogram(
    "model/weights",
    {"bins": [-1.0, -0.5, 0.0, 0.5, 1.0], "counts": [2, 14, 31, 9]},
    step=100,
)
```

Log a metrics-focused snapshot:

```python
run.log_snapshot(
    {
        "metrics": {"train/reward": 128.0, "train/loss": 0.12},
        "metadata": {"phase": "train"},
    },
    step=100,
)
```

`log_snapshot(...)` currently sends scalar metrics to the server and keeps the `metadata` value in the local event envelope for debugging and future ingestion.

## Artifacts, Checkpoints, Rollouts, Videos, And Tables

Reference an artifact by URI:

```python
run.log_artifact(
    name="training-config.json",
    uri="s3://my-bucket/runs/ppo-seed-42/config.json",
    artifact_type="file",
    metadata={"format": "json"},
)
```

Log checkpoint metadata:

```python
run.log_checkpoint(
    name="policy-step-1000.pt",
    uri="s3://my-bucket/checkpoints/policy-step-1000.pt",
    step=1000,
    size_bytes=42_000_000,
    metadata={"framework": "pytorch"},
)
```

Log rollout or video metadata:

```python
run.log_rollout(
    name="eval-rollout-seed-42.mp4",
    uri="s3://my-bucket/rollouts/eval-rollout-seed-42.mp4",
    step=1000,
    metadata={"environment": "CartPole-v1"},
)

run.log_video(
    name="eval-video.mp4",
    uri="s3://my-bucket/rollouts/eval-video.mp4",
    step=1000,
)
```

Log a table reference:

```python
run.log_table(
    name="test-predictions.csv",
    uri="s3://my-bucket/tables/test-predictions.csv",
    step=160,
    metadata={"kind": "prediction-table"},
)
```

Log one or more generic file references:

```python
run.log_file(
    name="training-log.txt",
    uri="s3://my-bucket/logs/training-log.txt",
    step=160,
    metadata={"kind": "stdout"},
)

run.log_files(
    {
        "confusion-matrix.json": "s3://my-bucket/reports/confusion-matrix.json",
        "predictions.csv": "s3://my-bucket/reports/predictions.csv",
    },
    step=160,
)
```

Upload a local file to the server-managed artifact store:

```python
run.upload_file(
    "artifacts/model.json",
    name="softmax-model.json",
    artifact_type="checkpoint",
    step=160,
    metadata={"test_accuracy": 0.967},
)
```

In the UI:

- Artifact metadata appears in Run Detail, Compare, the Artifacts tab, and API snippets.
- Checkpoints appear in checkpoint-oriented surfaces.
- Rollouts appear in rollout-oriented surfaces.
- Safe same-origin MP3/MP4 artifacts can preview in Run Detail and Compare when stored bytes are available.
- Unsupported or external-reference artifacts fall back to copy/download actions.

## Buffering And Flush

Use buffering when you want to batch post-init SDK calls in memory:

```python
run = ro.init(project="long-run", buffer_size=25)

for step in range(1000):
    run.log_metrics({"train/loss": 1.0 / (step + 1)}, step=step)

run.flush()
run.finish()
```

`finish()` calls `flush()` before updating status.

## Offline Replay For Existing Runs

`offline_dir` stores failed post-init requests so you can replay them later:

```python
run = ro.init(
    project="cartpole",
    offline_dir=".rlobs/offline",
)

run.log_metrics({"train/reward": 10.0}, step=1)
run.finish()

# Later, after the server is reachable:
replayed = run.replay_offline()
print(f"replayed {replayed} events")
```

Important limitation: `init()` still needs a reachable server because run creation is not spooled yet. `offline_dir` only covers failed requests for an already-created run.

## Process-Isolated Spool Mode

Use `upload_mode="spool"` when your training process should avoid post-init HTTP calls. The SDK writes one fsynced JSON event file per logging call. A separate uploader process drains those files.

Training process:

```python
run = ro.init(
    project="humanoid-rl",
    name="td3-seed-36970",
    upload_mode="spool",
    spool_dir=".rlobs/spool",
)

for step in range(10_000):
    run.log_snapshot(
        {
            "metrics": {
                "train/episode_reward": float(step),
                "eval/return_mean": float(step) * 0.8,
            },
            "metadata": {"phase": "train"},
        },
        step=step,
    )

run.finish()
```

Uploader process:

```bash
PYTHONPATH=packages/python-sdk python3 -m rl_observability.uploader \
  --spool-dir .rlobs/spool \
  --base-url http://127.0.0.1:8000
```

To run continuously:

```bash
PYTHONPATH=packages/python-sdk python3 -m rl_observability.uploader \
  --spool-dir .rlobs/spool \
  --base-url http://127.0.0.1:8000 \
  --follow
```

You can also call the uploader from Python:

```python
import rl_observability as ro

uploaded = ro.drain_spool(".rlobs/spool", base_url="http://127.0.0.1:8000")
print(uploaded)
```

Metric spool events send their SDK event ID as an `Idempotency-Key` so compatible servers can accept retries safely.

## Real NumPy Training Example

This condensed example trains a small softmax classifier and logs the pieces that matter for comparison:

```python
import numpy as np
import rl_observability as ro

run = ro.init(
    project="iris-classification",
    name="softmax-baseline-seed-7",
    config={
        "dataset": "UCI Iris",
        "model": "softmax-regression",
        "optimizer": "full-batch-gradient-descent",
        "seed": 7,
        "learning_rate": 0.14,
        "l2": 0.0005,
        "epochs": 160,
    },
    tags=["example", "real-data", "numpy", "classification"],
    notes="Track validation accuracy, calibration, and class-level errors.",
)

weights = np.random.default_rng(7).normal(0, 0.02, size=(4, 3))

for epoch in range(1, 161):
    train_loss = 1.0 / np.sqrt(epoch)
    val_loss = train_loss + 0.04
    val_accuracy = min(0.98, 0.55 + epoch * 0.003)
    grad_norm = float(np.linalg.norm(weights) / epoch)

    if epoch == 1 or epoch % 10 == 0 or epoch == 160:
        run.log_metrics(
            {
                "train/loss": train_loss,
                "val/loss": val_loss,
                "val/accuracy": val_accuracy,
                "optimizer/grad_norm": grad_norm,
                "model/weight_norm": float(np.linalg.norm(weights)),
            },
            step=epoch,
        )

run.log_histogram(
    "model/weights",
    {"bins": [-0.1, -0.05, 0.0, 0.05, 0.1], "counts": [3, 8, 10, 3]},
    step=160,
)
run.set_notes("Validation accuracy stabilized; inspect calibration before promotion.")
run.finish()
```

The repository includes a fuller real-data example with dataset download, real metrics, confusion-matrix artifacts, prediction tables, and model upload:

```bash
PYTHONPATH=packages/python-sdk python3 examples/iris-classification/train.py \
  --server http://127.0.0.1:8000 \
  --seeds 7,17 \
  --configs baseline,regularized,fast-lr
```

After it runs, open the UI, choose the `iris-classification` project, and compare runs by `val/accuracy`, `test/macro_f1`, `test/ece`, learning rate, L2 regularization, seed, tags, notes, and uploaded artifacts.

## How SDK Logs Translate To The UI

| SDK input | Where it appears |
| --- | --- |
| `project` | Project selector and project-scoped dashboards |
| `name` | Runs list, workspace run selector, Run Detail, Compare |
| `config` | Run Detail config, Compare config rows, search/filter context |
| `tags` / `set_tags(...)` | Run rows, workspace selector chips, Run Detail, Compare, run search |
| `notes` / `set_notes(...)` | Run rows, Run Detail, Compare, run search |
| `log_metrics(...)` | Runs workspace panels, Metrics tab, Run Detail charts, Compare metric rows |
| Metric namespaces like `eval/...` | Automatic panel grouping and metric catalog organization |
| `log_config(...)` | Typed config attributes and detail/comparison context |
| `log_text(...)` | Text-series attributes for run inspection |
| `log_histogram(...)` | Histogram attributes for run inspection and future richer panels |
| `log_artifact(...)` | Generic artifact metadata in Run Detail, Compare, Artifacts, and API tabs |
| `log_checkpoint(...)` | Checkpoint timeline and artifact surfaces |
| `log_rollout(...)` / `log_video(...)` | Rollout/artifact surfaces and safe media previews when available |
| `log_table(...)` | Artifact/table references for Run Detail and Compare |
| `log_file(...)` / `log_files(...)` | Generic file references for Run Detail, Compare, Artifacts, and API tabs |
| `upload_file(...)` | Server-managed artifact bytes, previews/downloads when supported |
| SDK source metadata | Reproducibility/source fields in Run Detail |
| `finish("failed")` or context-manager exceptions | Run status filters and status chips |

## UI Workflow After Logging

1. Select your project from the top bar.
2. Use the Runs list to search by run name, tag, note, seed, or config text.
3. Click a run row to inspect it, or select multiple runs for comparison.
4. In the Runs workspace, use automatic panels for a quick overview or switch to manual mode and add only the metric panels you need.
5. Drag panels between sections, resize panels from the lower-right handle, hover points for run/value tooltips, and drag the range brush to zoom into a training interval.
6. Open Run Detail to inspect one run's metrics, config, source metadata, notes, tags, artifacts, checkpoints, and rollouts.
7. Open Compare to scan selected runs side by side or row by row. Use diff-only mode, sorting, reference switching, and tags/notes editing to decide what changed.
8. Save local views or workspace layouts for repeated local analysis.

## Practical Tips

- Log many scalar values in one `log_metrics(...)` call instead of making one call per metric.
- Use stable run names that include the algorithm, dataset/environment, and seed.
- Put important searchable identity in `tags` and `notes`; put structured hyperparameters in `config`.
- Prefer metric namespaces such as `train/`, `val/`, `eval/`, `test/`, `system/`, `optimizer/`, and `model/`.
- Upload small, high-signal artifacts directly. For large remote artifacts, log metadata and a stable URI.
- Use `upload_mode="spool"` for long training jobs where logging must not block the training process.
- Call `finish()` in `finally` blocks when you are not using a context manager.

## Current Limitations

- True offline run creation is not implemented yet; `init()` needs a reachable server.
- Workspace layouts and saved views are local-browser state today, not hosted team objects.
- First-slice workspace panels are line plots. Rich table, media, query, text, scatter, and parallel-coordinate panels are planned follow-ups.
- The SDK package name is still `rl_observability` for compatibility.
- The deprecated Node server is for compatibility checks only; new product usage should target the Rust/Postgres API.

## Troubleshooting

If `import rl_observability` fails in a source checkout:

```bash
export PYTHONPATH="$PWD/packages/python-sdk"
python3 -c "import rl_observability as ro; print(ro.Client())"
```

If SDK calls fail with connection errors, confirm the API is running:

```bash
npm run dev:api
curl http://127.0.0.1:8000/healthz
```

SDK network, server, and invalid-response failures raise `rl_observability.RlobsError`:

```python
import rl_observability as ro

try:
    run = ro.init(project="demo")
except ro.RlobsError as exc:
    print(f"Training Observability logging is unavailable: {exc}")
```

If a hosted/auth-required server returns `401` or `403`, check:

```bash
echo "$RLOBS_API_KEY"
```

or pass:

```python
ro.init(project="demo", api_key="rlobs_...", base_url="https://your-api.example.com")
```

If charts look empty, check that you logged finite numeric metrics with nonnegative steps:

```python
run.log_metrics({"eval/accuracy": 0.91}, step=1)
```

If artifacts do not preview, the UI may not have same-origin bytes or a supported MIME type. Unsupported and external-reference artifacts still show metadata and copy/download actions.
