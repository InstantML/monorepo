# RL CartPole-Style Example

This example logs deterministic RL-style metrics without requiring a simulator dependency. It proves the SDK -> API -> storage path and can run either synchronously or through the process uploader spool.

For the current product UI, run the primary Rust/ClickHouse API with `npm run dev:api`, run the Next app with `RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev`, and open `http://127.0.0.1:3000`. The Python bootstrap API below remains useful for reference SDK compatibility checks.

## Run

Start the API from the repo root:

```bash
PYTHONPATH=apps/api python3 -m rlobs_api.server --db .rlobs/rlobs.sqlite3 --port 8000
```

In another terminal, run:

```bash
PYTHONPATH=packages/python-sdk:examples/rl-cartpole python3 examples/rl-cartpole/train.py --server http://127.0.0.1:8000
```

To verify process-isolated upload mode against the primary backend, start the Rust/ClickHouse server from the repo root:

```bash
npm run dev:api
```

Run the example so the training process writes local event files instead of post-init HTTP requests:

```bash
PYTHONPATH=packages/python-sdk:examples/rl-cartpole \
  python3 examples/rl-cartpole/train.py \
  --server http://127.0.0.1:8000 \
  --steps 5 \
  --upload-mode spool \
  --spool-dir .rlobs/spool-demo
```

Drain the event files from a separate process:

```bash
PYTHONPATH=packages/python-sdk python3 -m rl_observability.uploader \
  --spool-dir .rlobs/spool-demo \
  --base-url http://127.0.0.1:8000
```

## Test

From the repo root:

```bash
python3 -m pytest
```

This example has a smoke test for deterministic metric generation and CLI behavior.
