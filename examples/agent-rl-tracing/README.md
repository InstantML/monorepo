# Agent-RL Tracing Example

This example dogfoods every production telemetry surface from a single
GRPO-style tool-agent loop: rollout traces with nested model/tool/reward
spans, step metrics, per-rank distributed metrics, console logs, checkpoint
artifacts, an uploaded file artifact, and a stepless evaluation trace.

Steps 18–22 (configurable) simulate a tool outage: rollouts fail on the
calculator tool and `reward/mean` dips in the same window. Open the run's
Traces tab to see the trace × metric timeline surface the correlation —
error markers and the danger band line up with the reward dip.

The default project is `agent-rl-tracing`.

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

```bash
python3 examples/agent-rl-tracing/train.py --server http://127.0.0.1:8000
```

Against a hosted deployment, pass the API base and a workspace API key:

```bash
python3 examples/agent-rl-tracing/train.py \
  --server https://api.instantml.ai \
  --api-key "$INSTANTML_API_KEY" \
  --summary-json .instantml/agent-rl-tracing/summary.json
```

Then open the run in the dashboard and check:

- **Traces tab**: the trace × metric timeline shows ok/error markers per
  step, a danger band over the outage window, and the stepless eval trace
  counted in the panel-head totals; clicking a marker pins the recent-traces
  list to that step.
- **Metrics tab**: `reward/mean`, `kl`, and `loss` show the outage-window
  regression.
- **Distributed**: per-rank `grad_norm` and `tokens_per_second` for the
  simulated 4-rank world.
- **Checkpoints / Artifacts**: `policy-step-*.json` checkpoints every 10
  steps plus the uploaded `eval-report.json`.
- **Logs**: per-step stdout lines and stderr lines for failed rollouts.

## Test

```bash
python3 -m pytest examples/agent-rl-tracing/tests -p no:cacheprovider --no-cov
```
