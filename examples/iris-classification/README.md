# Iris Classification Example

This example trains a real-data NumPy softmax classifier on the UCI Iris dataset and logs the full experiment workflow through the public Python SDK.

It is the anchor example for a more rigorous daily ML workflow:

- Fetch or load a real public dataset.
- Validate the schema and class balance.
- Use a stratified train/validation/test split.
- Train multiple configurations across seeds with NumPy.
- Log train, validation, and test metrics.
- Upload real artifact bytes: dataset profile, model weights/preprocessing stats, prediction table, and confusion matrix.
- Mark runs as failed if training fails after run creation.

Dataset source: [UCI Machine Learning Repository Iris data](https://archive.ics.uci.edu/ml/machine-learning-databases/iris/iris.data). The dataset contains 150 flower measurements across three Iris species with four numeric features.

## Setup

From the repo root:

```bash
npm ci
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

Open:

```text
http://127.0.0.1:3000
```

If Next dev shows host-specific HMR warnings on `127.0.0.1`, open `http://localhost:3000`.

## Run

Run the full sweep:

```bash
PYTHONPATH=packages/python-sdk:examples/iris-classification \
  python3 examples/iris-classification/train.py \
  --server http://127.0.0.1:8000 \
  --summary-json .rlobs/iris-classification-summary.json
```

The default run creates six runs: `baseline`, `regularized`, and `fast-lr` across seeds `7` and `17`.

For a faster local smoke:

```bash
PYTHONPATH=packages/python-sdk:examples/iris-classification \
  python3 examples/iris-classification/train.py \
  --server http://127.0.0.1:8000 \
  --seeds 7 \
  --configs baseline \
  --epochs 40 \
  --log-every 5
```

To run offline from an already-downloaded dataset:

```bash
PYTHONPATH=packages/python-sdk:examples/iris-classification \
  python3 examples/iris-classification/train.py \
  --server http://127.0.0.1:8000 \
  --data-path .rlobs/datasets/iris.data \
  --no-download
```

## What To Inspect In The UI

Select project `iris-classification`.

Useful metrics:

- `test/accuracy`
- `test/macro_f1`
- `val/accuracy`
- `val/loss`
- `test/ece`
- `optimizer/grad_norm`
- `model/weight_norm`

Expected artifacts on each run:

- `dataset-profile.json`
- `softmax-model.json`
- `test-predictions.csv`
- `confusion-matrix.json`
- A table metadata record for the uploaded prediction table

The `Compare` tab should make it easy to compare learning rate, regularization, seed, validation accuracy, test accuracy, macro F1, and calibration error.

## Runtime Expectations

The dataset is tiny. The default sweep should complete in a few seconds on a normal laptop, excluding the first network fetch.

Generated local files are written under:

```text
.rlobs/datasets/
.rlobs/iris-classification-artifacts/
```

Both paths are ignored by git.

## Tests

Run the full Python suite from the repo root:

```bash
python3 -m pytest
```

For quick local iteration on this example only:

```bash
PYTHONPATH=packages/python-sdk:examples/iris-classification \
  python3 -m pytest examples/iris-classification/tests -q -o addopts=''
```

The targeted command is not a substitute for the root coverage run before finishing a change.
