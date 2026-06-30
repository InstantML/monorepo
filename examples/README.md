# Examples

This directory contains runnable examples that prove InstantML works end to end across different training-loop shapes.

Use the root `../SETUP.md` for fresh-clone setup before running examples.

Examples now target the primary Rust/ClickHouse server through the same public SDK API. The deprecated Node compatibility server can still be used for legacy comparisons.

Expected examples:

- `iris-classification/`: real-data NumPy softmax classifier on the UCI Iris dataset with uploaded model, prediction, confusion-matrix, and dataset-profile artifacts.
- `checkpoints/`: deterministic checkpoint dogfood example that uploads checkpoint bytes and resumes a new run in the `checkpoints` project.
- `rl-cartpole/`: deterministic RL-style logging example.
- `q-learning-gridworld/`: tabular Q-learning dogfood example with checkpoints and rollout metadata.
- `contextual-bandit/`: online bandit dogfood example with policy comparison, regret, checkpoints, rollouts, and reports.
- `supervised-regression/`: non-RL training-loop dogfood example with train/validation curves and metadata artifacts.
- `rank-insights/`: synthetic distributed-rank and sweep-analysis seed data for the Distributed and Insights dashboards, including a direct ClickHouse scale seeder for multi-project 2k-run/10k-20k-step dogfood.
- `integrations/`: copy-pasteable framework adapter examples and a dependency-free integration smoke script that logs representative Optuna/tree/RL/dataset events.
- `query-api/`: deterministic post-hoc SDK query example that seeds 20 runs,
  then reads run pages, bounded metric series, single-run rich objects, and
  table rows through `Api.query_*` helpers.
- `agent-rl-tracing/`: GRPO-style tool-agent loop that exercises every
  telemetry surface in one run — rollout/model/tool/reward trace spans plus a
  stepless eval trace, step metrics, per-rank distributed metrics, console
  logs, checkpoints, and an uploaded file artifact — with a configurable tool
  outage correlated to a reward dip for the trace × metric timeline.
- Fine-tuning example if practical.
- Importer fixture/demo.

## Expectations

Each example should include:

- Its own README.
- Setup commands.
- Run commands.
- Expected output in the UI.
- Any data or model dependencies.
- Runtime expectations.

Future agents must update example READMEs whenever commands, dependencies, or expected behavior changes.

Example lifecycle expectations:

- Use public SDK APIs rather than direct REST helpers when the SDK supports the workflow.
- Keep runs short and deterministic enough for local verification.
- Mark runs as `failed` if an example catches an exception after creating a run.
- Prefer the root `python3 -m pytest` coverage run before finishing changes; targeted example tests are only for local iteration.

## Testing Expectations

Examples should be tested enough to prevent drift. Prefer fast smoke tests that verify examples can run in CI or local development without expensive training.

Run all current tests from the repo root:

```bash
python3 -m pytest
```
