# Q-Learning Gridworld Example

This example dogfoods Training Observability with a small tabular Q-learning training loop. It logs multiple seeds, episode returns, success rate, epsilon, mean absolute TD error, checkpoint metadata, rollout metadata, and a config artifact.

## Run

Start the primary Rust/Postgres API from the repo root:

```bash
npm run dev:api
```

Start the Next UI in another terminal:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Run the example:

```bash
PYTHONPATH=packages/python-sdk python3 examples/q-learning-gridworld/train.py --server http://127.0.0.1:8000
```

Then open `http://127.0.0.1:3000`, filter to project `q-learning-gridworld`, and compare `train/episode_return`, `train/success_rate`, `train/td_error`, and `train/epsilon`. The default `eval/return_mean` and `eval/success_rate` often saturate once the small gridworld is solved, so the training metrics are usually more useful for panel review.

## Test

From the repo root:

```bash
python3 -m pytest examples/q-learning-gridworld/tests
```
