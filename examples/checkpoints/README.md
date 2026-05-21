# Checkpoints Example

This example dogfoods the first-class checkpoint workflow. It trains a tiny deterministic model, writes JSON checkpoint files every N steps, uploads those files as InstantML checkpoint artifacts, and can resume a new run from a downloaded checkpoint.

The default project is `checkpoints`.

## Setup

From the repo root:

```bash
npm ci
python3 -m pip install -r requirements-dev.txt
```

Start the Rust API:

```bash
npm run dev:api
```

Start the web app in another terminal:

```bash
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

## Run

Create a source run with checkpoints:

```bash
PYTHONPATH=packages/python-sdk \
  python3 examples/checkpoints/train.py \
  --server http://127.0.0.1:8000 \
  --steps 12 \
  --checkpoint-every 4 \
  --summary-json .instantml/checkpoint-example/source-summary.json
```

Resume from the latest local checkpoint written by the first command:

```bash
PYTHONPATH=packages/python-sdk \
  python3 examples/checkpoints/train.py \
  --server http://127.0.0.1:8000 \
  --resume-from .instantml/checkpoint-example/checkpoint-step-12.json \
  --steps 6 \
  --checkpoint-every 3 \
  --name resume-from-step-12 \
  --summary-json .instantml/checkpoint-example/resume-summary.json
```

For an auth-required API, pass `--api-key instantml_...` or set `INSTANTML_API_KEY`.

## What To Inspect In The UI

Select project `checkpoints`, open a run, and inspect Run Detail.

Expected checkpoint artifacts:

- `checkpoint-step-4.json`
- `checkpoint-step-8.json`
- `checkpoint-step-12.json`

Run Detail should show a Checkpoints section with a download action and a `Resume Code` copy action. The copied snippet downloads the checkpoint artifact and creates a new run in project `checkpoints`.

## Runtime Expectations

The example is standard-library only and should finish in under a second, excluding API startup.

Generated local files are written under:

```text
.instantml/checkpoint-example/
```

That path is ignored by git.

## Tests

Run this example's tests:

```bash
PYTHONPATH=packages/python-sdk:examples/checkpoints \
  python3 -m pytest examples/checkpoints/tests -q -o addopts=''
```

Run the full Python suite before finishing a change:

```bash
python3 -m pytest
```
