# Design: Dogfood Training Loops and UI Feedback

Date: 2026-05-06

Status: Implemented dogfood pass

Update: the 2026-05-10 examples-quality pass added `examples/iris-classification`, a real-data NumPy classifier over the UCI Iris dataset with schema validation, stratified train/validation/test splits, model training, test metrics, and uploaded artifact bytes.

Owner: Codex

## Summary

This design covers a dogfood pass using realistic training loops. The goal is to test whether a senior engineer can use the framework to log real-ish experiments, inspect runs in the UI, compare metrics, and understand artifacts/checkpoints/rollouts without prior product context.

The work should add examples under `examples/`, run them against the Node server, exercise the UI with Playwright, collect no-context agent feedback, and patch the product based on the feedback.

## Goals

- Add realistic examples beyond deterministic CartPole-style fake metrics.
- Use the Python SDK as the primary logging path.
- Exercise runs table, search/filter, metric selector, chart comparison, run detail, checkpoints, rollouts, and artifacts.
- Collect senior-engineer feedback from fresh agents.
- Patch code to address clear UX and reliability gaps.
- Keep tests passing.

## Non-Goals

- Heavy ML dependencies.
- Long-running training jobs.
- Real model checkpoints as binary files.
- Production persistence replacement.
- Cloud deployment.

## Proposed Examples

- `examples/contextual-bandit/`: contextual bandit policy learning across seeds.
- `examples/supervised-regression/`: synthetic supervised regression training over epochs/configs.
- `examples/q-learning-gridworld/`: tabular Q-learning in a small gridworld.
- `examples/iris-classification/`: real-data NumPy softmax classifier with uploaded model, prediction, confusion-matrix, and dataset-profile artifacts.

Each example should:

- Run quickly.
- Log multiple runs/seeds.
- Use metric names that exercise UI selection.
- Log realistic configs/tags.
- Log artifact/checkpoint/rollout metadata when supported.
- Include a README and tests for deterministic helper logic.

## Expected Product Gaps

At the start of this pass, the Python SDK only supported `init`, `log`, and `finish`. The SDK now includes metadata helpers:

- `log_artifact`
- `log_checkpoint`
- `log_rollout`
- `log_video`
- `log_table`

These call the Node server artifact metadata endpoint. `upload_file()` can upload local bytes to server-managed artifact storage, while the `log_*` artifact helpers remain metadata-first and point at user-controlled URIs.

## Testing Plan

- Python tests for SDK artifact methods.
- Example tests for training-loop helper logic.
- Node tests should continue to pass.
- Browser smoke should continue to pass.
- Manual/automated playthrough with generated example data.

## Dogfood Feedback Synthesis

Two no-context senior-agent passes validated contextual bandit and supervised regression examples against the server and UI. The strongest positive signal was that the dense first screen, project filter, metric selector, run table, comparison chart, and artifact panels were fast enough to use without onboarding.

The most important UX gaps were:

- The UI was hard-coded around `eval/return_mean`, which made supervised projects look empty in "best/latest" surfaces.
- Empty filtered states told users to load demo data even when they had real data but an excluding filter.
- Artifact URI and metadata text could collide in narrow cards.
- Multi-run selection needed a clearer "primary run" label for the detail and artifact panes.
- Repeated metric switching should avoid obvious refetch churn.

Implemented changes:

- Added contextual bandit, supervised regression, and Q-learning gridworld examples.
- Added SDK artifact helpers and file upload support.
- Added primary-metric selection for non-RL projects.
- Improved filtered-empty copy.
- Added primary-run labeling when multiple runs are selected.
- Added metric-series caching for selected run/metric pairs.
- Overview metrics now honor project, status, search, and selected metric filters.
- KPI and table metric labels follow the selected metric.
- The frontend chooses a sensible primary metric for non-RL projects, such as `val/r2`.
- Empty filtered states now distinguish "no data" from "filters excluded data".
- Artifact cards wrap long URIs, show compact metadata summaries, and expose full text in tooltips.
- Detail panels label the first selected run as the primary run when multiple runs are selected.
- Metric series are cached client-side by run and metric during a session.
- Search reloads are debounced.
- Project, status, search, metric, and selected run IDs are persisted in the URL.

Outstanding simplification follow-ups from no-context review:

- Give the frontend separate chart, artifact, and side-by-side loaders with cancellation/generation checks.
- Add pagination before projects regularly exceed the first 100 runs.
- Add mid-width UI smoke coverage around 1280/1366px.
- Ensure grouped averages preserve timestamp semantics when the chart x-axis is time.
- Keep example failure paths marking runs as failed instead of leaving them running.
- Keep at least one real-data NumPy example maintained as the SDK/frontend realism benchmark.

## Dogfood Result

The final local dogfood run logged:

- `contextual-bandit`: 4 runs, 520 metric points, 8 checkpoints, 4 rollouts, 4 file artifacts.
- `q-learning-gridworld`: 2 runs, 144 metric points, 4 checkpoints, 2 rollouts, 2 file artifacts.
- `supervised-regression`: 3 runs, 216 metric points, 6 checkpoints, 3 rollouts, 3 file artifacts.

Automated browser verification selected each project, switched to a representative project-specific metric, rendered a chart, verified artifact surfaces, checked the primary-run state, and confirmed the improved filtered-empty copy.

## Review Notes

This is a dogfood/testing slice requested after the day 5-8 implementation. It uses existing accepted API/UI architecture and keeps example ownership scoped.

## Decision

Accepted.
