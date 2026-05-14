# Supervised Regression Example

This example logs a small synthetic tabular regression sweep to Training Observability. It is intended to exercise the non-RL training-loop path: multiple configs, multiple seeds, epoch-level train/validation metrics, run comparison, and optional checkpoint/report/rollout metadata in the current Next UI backed by the Rust/ClickHouse API.

## Setup

From the repo root:

```bash
python3 -m pip install -r requirements-dev.txt
```

Start the primary Rust/ClickHouse API:

```bash
npm run dev:api
```

Start the Next UI in another terminal:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Run the sweep in another terminal:

```bash
PYTHONPATH=packages/python-sdk:examples/supervised-regression \
  python3 examples/supervised-regression/train.py \
  --server http://127.0.0.1:8000 \
  --seeds 11,29 \
  --epochs 30 \
  --summary-json .rlobs/supervised-regression-summary.json
```

Open `http://127.0.0.1:3000` and select the `supervised-regression` project.

## What It Logs

- Project: `supervised-regression`
- Runs: `baseline`, `regularized`, and `fast-lr` configs for each requested seed
- Metrics: `train/loss`, `train/rmse`, `train/mae`, `val/loss`, `val/rmse`, `val/mae`, `val/r2`, `optimizer/grad_norm`, and `model/weight_norm`
- Metadata artifacts: two checkpoint records, one final summary file record, and one prediction-scan rollout-style record per run

Metric and artifact metadata logging use the Python SDK. This example uses metadata-style artifact helpers, so it records durable URIs and sizes without uploading binary payloads. Use `run.upload_file()` in new examples when the goal is to dogfood server-managed artifact bytes.

## Testing

Run the repository test suite from the root to preserve the normal coverage policy:

```bash
python3 -m pytest
```

For quick local iteration on this example only, use:

```bash
PYTHONPATH=packages/python-sdk:examples/supervised-regression \
  python3 -m pytest examples/supervised-regression/tests -q -o addopts=''
```

The targeted command is not a substitute for the root coverage run before finishing a change.

The tests keep the example deterministic, verify loss improves on the synthetic task, and smoke-test the SDK/artifact calls with fakes.

## Notes for Future Agents

- Keep this example dependency-light. NumPy is used only when available; the standard-library path should remain first-class.
- Keep runtime short enough for local product checks. The default sweep logs 6 runs and 180 metric points.
- Keep artifact metadata calls on the public SDK helpers so examples dogfood the same API users see.
- Wrap future logging loops so exceptions mark runs as failed instead of leaving them `running`.
