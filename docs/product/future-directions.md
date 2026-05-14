# Future Directions

Exploratory product and architecture ideas for Training Observability. These are not accepted designs yet. Each direction below needs a focused design doc in `docs/design/`, fresh review, benchmarks, and user validation before implementation.

The common theme is to make Training Observability more than a passive experiment tracker. The long-term opportunity is to help training systems record raw distributed context, replay or reinterpret decisions, and branch experiments without forcing users to pre-collapse everything into scalar metrics.

## 1. Worker-Level Raw Signals And User-Defined Reductions

### Problem

Distributed training often hides useful information before it reaches the observability backend. A common pattern is:

1. Each worker computes local loss or reward statistics.
2. Workers communicate to rank 0.
3. Rank 0 reduces those values.
4. Only the reduced scalar is logged.

That is efficient, but it throws away the per-worker signal. When a run becomes unstable, users may want to know whether the global loss moved because every worker shifted, one worker diverged, a data shard changed, a GPU became slow, or a rollout worker started producing unusual trajectories.

### Direction

Allow workers to log raw per-worker observations and let users define reduction functions through an API.

Instead of requiring the training code to emit only `loss=0.123`, workers could emit structured records such as:

```python
run.log_worker_signal(
    key="train/loss_parts",
    worker_rank=rank,
    step=global_step,
    value={
        "tokens": token_count,
        "sum_loss": sum_loss,
        "num_examples": batch_size,
        "shard": shard_id,
    },
)
```

Then users could define named reductions such as:

```python
api.create_reduction(
    project="demo",
    source_key="train/loss_parts",
    output_key="train/loss_weighted",
    reducer="sum(value.sum_loss) / sum(value.tokens)",
)
```

The reduced metric could be materialized for charts, Compare, alerts, and exports while preserving the original worker records for debugging.

### Product Value

- Debug distributed training failures without changing the original training job.
- Compare rank-level behavior across runs, shards, GPUs, nodes, and data partitions.
- Recompute metrics after a run if the team changes a loss formula, reward shaping formula, normalization strategy, or filtering rule.
- Support RL workflows where raw rollout statistics may be more informative than one pre-reduced reward.

### Likely First Slice

- SDK: add a lightweight `log_worker_signal()` or `log_raw()` API that writes bounded JSON records with `run_id`, `step`, `rank`, `key`, and timestamp.
- Rust: store raw records in a partition-friendly table keyed by org, project, run, key, step, and rank.
- Rust: expose a safe first-slice reduction API with a small built-in reducer set: `mean`, `weighted_mean`, `sum`, `min`, `max`, `percentile`, and `count`.
- Web: show worker distributions and outlier ranks in Run Detail before allowing arbitrary user-defined expressions.

### Hard Questions

- How expressive should custom reductions be before they become a sandboxing problem?
- Should reductions run synchronously at ingest time, asynchronously in a worker, or lazily at query time?
- How do we protect the scalar metric hot path from large raw payloads?
- What retention policy should raw per-worker data have if it becomes much larger than scalar summaries?
- How do we make this useful without building a full distributed tracing product?

## 2. Mid-Flight Run Forking With Checkpoint Coordination

### Problem

Training runs often reveal an interesting branch point while they are still running:

- A loss curve begins to recover.
- A policy finds a promising reward region.
- A hyperparameter looks wrong, but the current weights are still valuable.
- A team wants to branch from the latest stable checkpoint without waiting for the original run to finish.

Today, run forking is usually manual: find a checkpoint, copy it, start a new job, remember which run it came from, and hope the metadata links stay intact.

### Direction

Support forking a run mid-flight by coordinating checkpoint capture, metadata lineage, and scheduler launch.

At a high level:

1. The SDK or trainer periodically records checkpoint metadata for the current run.
2. The backend tracks the latest forkable checkpoint per run and step.
3. A user requests a fork from the UI or API.
4. The system captures or reuses the last safe checkpoint, creates a child run with lineage metadata, and launches or prepares a job through a scheduler integration.

For SLURM-like environments, the product could generate a scheduler-ready job spec:

```python
api.fork_run(
    run_id="...",
    from_step=12500,
    overrides={
        "lr": 1e-5,
        "optimizer.beta2": 0.98,
    },
    scheduler="slurm",
    partition="a100",
)
```

If `slerm` refers to an internal scheduler wrapper, this should be treated as the same integration class: a job-launch adapter that receives a checkpoint reference, config diff, environment, and parent-run lineage.

### Product Value

- Makes Training Observability active in the training loop, not just a dashboard after the fact.
- Preserves lineage between parent and child runs.
- Helps teams exploit promising partial runs without hand-copying checkpoints.
- Makes Compare more useful by showing branch relationships and config diffs from a known step.

### Likely First Slice

- SDK: add checkpoint registration metadata without moving large checkpoint bytes through scalar logging.
- Rust: add run lineage fields for `parent_run_id`, `forked_from_step`, `forked_from_checkpoint_id`, and config override metadata.
- Rust: expose a `POST /api/runs/:id/forks` planning endpoint that creates the child run and returns launch instructions, but does not execute jobs yet.
- Web: add a Run Detail action for "Plan fork from latest checkpoint" and show parent/child lineage in Compare.
- Later: add scheduler adapters for SLURM, Kubernetes Jobs, Ray, Modal, or a user-provided webhook.

### Hard Questions

- How do we define a checkpoint as safe to fork while a trainer may still be writing it?
- Do we cache weights ourselves, store external references, or rely on user-managed checkpoint paths?
- How do we avoid making artifact upload part of the scalar metric hot path?
- Should the first version launch jobs, or only generate reproducible launch commands?
- How do we handle distributed checkpoints that require rank-specific shards?

## 3. Custom Step Semantics

### Problem

Step semantics need to be simple for new users and precise for serious training loops. Some users want to pass an explicit step. Others want the SDK to do the obvious thing and increment from the previous step.

The current product already treats metric series as ordered, bounded time series, but future SDK lifecycle work should canonize the default behavior across Python SDK, Rust, docs, imports, and UI.

### Direction

Support both explicit and automatic steps:

- If the user passes `step`, use it.
- If the user omits `step`, the SDK assigns `last_step + 1` for that run.
- The SDK should keep local step state per run and per process.
- The server should validate explicit steps and preserve ordering by `(step, point_id)` for duplicate-step events.

Example:

```python
run.log({"train/loss": 0.31})              # step 1
run.log({"train/loss": 0.28})              # step 2
run.log({"eval/accuracy": 0.81}, step=10)  # step 10
run.log({"train/loss": 0.24})              # step 11, unless policy says auto-step only follows auto steps
```

The exact rule after an explicit step is a design choice. Two plausible policies:

- `global_last`: omitted steps always use the largest known step plus one.
- `auto_counter`: omitted steps follow a separate SDK counter and explicit steps do not move it.

The recommended default is `global_last` because it is easier to explain and aligns with "whatever the last one was + 1." Advanced users can later configure stricter behavior if needed.

### Product Value

- Simpler SDK onboarding.
- Better W&B-style ergonomics without hiding ordering rules.
- Cleaner imported data because step behavior is documented and consistent.
- Fewer off-by-one or duplicate-step surprises in charts and summaries.

### Likely First Slice

- SDK: make `step` optional in `Run.log()`.
- SDK: maintain a per-run `last_step` and persist it in offline/process-spool state.
- Rust: keep accepting explicit steps, but add tests that document duplicate-step ordering and auto-step client behavior.
- Docs: explain `global_last` semantics and how to use custom x-axis metrics later.
- Web: show the step mode in Run Detail metadata if it becomes part of run settings.

### Hard Questions

- How should auto-step behave in multi-process or distributed logging?
- Should each rank have independent auto-step state for raw worker signals?
- Should the server ever assign steps, or should it stay an SDK responsibility?
- How do imported runs with non-integer or sparse steps interact with SDK-generated integer steps?

## Cross-Cutting Requirements

Any implementation of these directions should preserve the product's speed wedge:

- Scalar metric logging must stay cheap and predictable.
- Large raw payloads, checkpoints, and media must use separate bounded paths.
- Run list and dashboard queries must continue to load summaries only.
- Every new endpoint needs org-scoped authorization from the start.
- New storage tables need explicit indexes and query-plan checks before scale claims.
- SDK APIs need benchmarks for per-call overhead.
- UI surfaces need empty, loading, error, and large-data states.

## Promotion Criteria

Before moving one of these ideas into implementation:

1. Write a design doc in `docs/design/`.
2. Define the smallest useful first slice.
3. Have at least two fresh reviewers inspect the design.
4. Add a benchmark target before adding schema or API complexity.
5. Make the user-facing story clear enough to test with design partners.
