# Examples

This directory contains runnable examples that prove InstantML works end to end across different training-loop shapes.

Use the root `../SETUP.md` for fresh-clone setup before running examples.

Examples now target the primary Rust/ClickHouse server through the same public SDK API. The deprecated Node compatibility server can still be used for legacy comparisons.

Expected examples:

- `iris-classification/`: real-data NumPy softmax classifier on the UCI Iris dataset with uploaded model, prediction, confusion-matrix, and dataset-profile artifacts.
- `rl-cartpole/`: deterministic RL-style logging example.
- `q-learning-gridworld/`: tabular Q-learning dogfood example with checkpoints and rollout metadata.
- `contextual-bandit/`: online bandit dogfood example with policy comparison, regret, checkpoints, rollouts, and reports.
- `supervised-regression/`: non-RL training-loop dogfood example with train/validation curves and metadata artifacts.
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
