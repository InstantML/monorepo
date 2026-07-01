# Castform Research Brief

Research date: 2026-06-30.

## Executive Summary

Castform is positioned as an RL fine-tuning platform for adapting open-weight
models to task-specific data, success criteria, and output formats. Their public
materials emphasize:

- automated or SDK-controlled dataset/environment/reward setup;
- managed GPU training and evaluation through the `benchmax` Python SDK;
- reward, solve-rate, max-reward, and response-length monitoring;
- rollout inspection with messages, tool calls, reward breakdowns, and Python
  environment logs;
- training from RAG corpora and production agent traces;
- comparison evals against external models and interactive playground testing.

InstantML should not pitch itself as replacing Castform's run page. The stronger
collaboration story is: Castform owns RL training orchestration and per-rollout
debugging; InstantML provides the durable, cross-run observability layer for
comparing many Castform jobs, auditing configs and reward behavior, exporting
evidence, and letting agents analyze run history.

## Public Product Surface

Castform's home page frames the product around post-training, evaluation, and
shipping task-specific models, with a workflow that imports data, defines tools
and rewards, monitors training, and benchmarks against frontier models.

The docs describe Castform as a platform where users bring data while Castform
generates or runs RL environments, reward signals, and the training loop. The
SDK overview identifies `benchmax` as the open-source Python SDK used to define
datasets, environments, rewards, and launch runs.

## Training And SDK Touchpoints

The public launch flow has two core calls:

- `upload_training_run(...)` bundles an environment class plus train/eval
  datasets and uploads them to platform storage.
- `TrainerClient.launch_training_run(...)` starts the managed job.

Training parameters include model, learning rate, epochs, batch size, group
size, rollout length, max turns, and LoRA settings. The SDK also exposes
`TrainerClient.list_launch_args()` / `print_launch_args()` and the underlying
`GET /v1/train/launch-args` route for the accepted schema.

The open-source `benchmax` repo also includes run-read methods that matter for a
pull-sync demo:

- `list_runs(include_config=False)`
- `get_run(run_id, include_config=False)`
- `get_run_details(run_id)`
- `get_run_events(run_id)`
- `get_run_scalars(run_id, mode)`
- `get_environment_logs(run_id, rollout_id=None)`

Those methods make a low-risk demo possible without asking Castform to change
trainer code first.

## Existing Castform Observability

Castform already shows per-run reward curves, subreward breakdowns, rollout
deepdives, and rollout logs. Important metrics and concepts from the docs:

- average reward
- response lengths
- max reward
- solve rate / pass@k
- per-component reward curves
- train-vs-eval divergence and plateau detection
- rollout messages, tool calls, tool results, and environment logs
- comparison evals against base or external models

InstantML can add value by turning those same signals into an organization-wide
experiment system: cross-run search, dense comparison, saved dashboards,
artifact lineage, export, and MCP/agent run analysis.

## Observability Wedge For The Demo

Recommended demo promise:

> "Give Castform teams a second pane for comparing many training jobs and
> preserving the evidence behind model/reward decisions, without changing how
> they launch Castform runs."

Demo capabilities to show:

- Mirror Castform run metadata into InstantML config, tags, notes, and external
  links.
- Mirror scalar curves under normalized metric names such as
  `train/reward_mean`, `train/solve_rate`, `eval/reward_mean`, and
  `train/reward_components/quality/mean`.
- Store environment logs and lifecycle events as searchable console/text
  evidence.
- Compare 5-10 runs by model, group size, learning rate, reward components, and
  eval behavior.
- Identify a concrete failure mode: train reward improves while eval reward
  flattens, solve rate stalls, or response length grows.
- Export selected evidence or ask an agent to summarize the best run and likely
  regression cause.

## Partnership Framing

Best first integration:

- Castform remains the source of truth for raw rollout inspection and job
  control.
- InstantML mirrors run summaries, scalar series, lifecycle events, and selected
  artifacts for cross-run comparison and reporting.
- The integration starts as a pull sync through Benchmax public methods.
- A later first-party integration can use a Castform-side webhook or trainer
  observer hook for lower-latency metric batches and cleaner artifact metadata.

Avoid framing:

- Do not imply Castform lacks observability. Their run page already does
  per-run monitoring well.
- Do not pitch InstantML as a generic LLM trace viewer. The valuable overlap is
  training-loop observability and experiment comparison.
- Do not make claims about private Castform internals beyond public docs and the
  public `benchmax` repo.

## Sources

- Castform home page: https://castform.com/
- Castform docs introduction: https://castform.com/docs.md
- Benchmax SDK overview: https://castform.com/docs/getting-started/sdk-overview.md
- Launching a training run: https://castform.com/docs/train/launching.md
- Monitoring a run: https://castform.com/docs/train/managing.md
- Environment logging: https://castform.com/docs/environments/logging.md
- Rewards: https://castform.com/docs/environments/rewards.md
- Evaluating a model: https://castform.com/docs/evaluate/evaluating.md
- Trace-based training: https://castform.com/docs/traces/overview.md
- Benchmax GitHub repo: https://github.com/castform-ai/benchmax
- InstantML product strategy: `PRODUCT_STRATEGY.md`
- InstantML Python SDK README: `packages/python-sdk/README.md`
- InstantML agent run analysis guide: `docs/sdk/agent-run-analysis.md`
