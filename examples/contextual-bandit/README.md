# Contextual Bandit Example

This example logs a realistic online contextual bandit workflow to the local Training Observability server. It creates multiple runs across seeds and policy variants, logs bounded scalar metrics through the Python SDK, and records checkpoint, rollout, and report metadata through the SDK artifact helpers.

## What It Simulates

- Four promotion arms competing for each user context.
- Context features for budget sensitivity, novelty affinity, loyalty, and time of day.
- Seeded stochastic click rewards from hidden per-arm reward weights.
- Two online policies: decaying epsilon-greedy and optimistic exploration.
- Metrics for reward, click rate, regret, evaluation return, exploration, and arm usage.

## Setup

From the repository root, install development dependencies:

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

Run the example in another terminal:

```bash
PYTHONPATH=packages/python-sdk:examples/contextual-bandit \
  python3 examples/contextual-bandit/train.py --server http://127.0.0.1:8000
```

The default run creates six runs: two policies across seeds `11`, `23`, and `37`. Local artifact files are written under `.rlobs/contextual-bandit-artifacts/`.

## Useful Variants

```bash
PYTHONPATH=packages/python-sdk:examples/contextual-bandit \
  python3 examples/contextual-bandit/train.py \
  --server http://127.0.0.1:8000 \
  --seeds 3,5,8,13 \
  --policies epsilon-greedy,optimistic \
  --steps 360 \
  --log-every 12 \
  --artifact-every 120
```

Open `http://127.0.0.1:3000`, select the `contextual-bandit` project, and compare `eval/return_mean`, `train/click_rate_50`, `train/cumulative_regret`, `eval/optimality_gap`, and `policy/arm_entropy`.

## SDK Note

The Python SDK exposes `init`, `log`, `log_artifact`, `log_checkpoint`, `log_rollout`, `log_video`, `log_table`, `upload_file`, and `finish`. This example uses metadata-style artifact helpers, so it writes small local JSON/JSONL files and points the UI at their file URIs rather than uploading bytes.

## Tests

Run the repository test suite from the root to preserve the normal coverage policy:

```bash
python3 -m pytest
```

For quick local iteration on this example only, use:

```bash
PYTHONPATH=packages/python-sdk:examples/contextual-bandit \
  python3 -m pytest examples/contextual-bandit/tests -q -o addopts=''
```

The targeted command is not a substitute for the root coverage run before finishing a change.
