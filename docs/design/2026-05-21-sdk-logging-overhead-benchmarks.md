# Design: SDK Logging Overhead Benchmarks

Date: 2026-05-21

Status: Accepted for benchmark tooling

Owner: Codex

## Summary

InstantML's SDK has a process-isolated spool mode so training loops do not wait
on network calls, but we do not yet have a repeatable benchmark for the CPU and
wall-time cost of calling the SDK inside a tight training loop. The existing W&B
benchmark under `benchmarks/` measures hosted read/query latency, not per-step
logging overhead.

This slice adds a separate benchmark harness for foreground logging overhead. It
runs each provider case in a fresh Python process, compares against a no-op
training-loop baseline, and reports CPU, wall time, child-process CPU, RSS, and
disk writes for InstantML and W&B modes.

## Goals

- Measure training-process overhead for scalar metric logging.
- Include a no-op baseline with the same synthetic metric computation.
- Compare InstantML durable process-spool logging to W&B offline logging without
  network calls.
- Measure InstantML uploader drain cost as a separate phase because it is
  intentionally outside the training process.
- Capture package versions, git metadata, Python/platform details, payload
  shape, sample rows, and clear caveats.
- Keep the benchmark runnable locally without mutating hosted InstantML or W&B
  projects.

## Non-Goals

- Hosted online persistence benchmarks.
- GPU utilization measurement. The benchmark is CPU/process focused and should
  not require a GPU.
- Artifact/checkpoint upload benchmarks.
- Claims that W&B hosted read timings and SDK logging timings are the same
  category of evidence.

## Proposed Design

Add `benchmarks/sdk_logging_overhead.py` with two entry points:

- `run`: execute an interleaved sample matrix and write sanitized JSON plus a
  Markdown report.
- `worker`: internal subprocess target for one provider/mode/sample.

Initial cases:

- `noop`: compute and consume the same metric dictionaries without logging.
- `instantml-sync-null`: call `Run.log_metrics()` with a fake local transport
  that JSON-serializes request bodies but performs no network I/O. This is an
  internal/null-transport microbenchmark, not a public hosted persistence path.
- `instantml-log-null`: call ergonomic `Run.log()` with the same fake
  transport, so classification overhead is visible separately.
- `instantml-spool-durable`: call `Run.log_metrics()` with
  `upload_mode="spool"` into a fresh temporary directory.
- `wandb-offline`: call `wandb.log()` in `mode="offline"` with quiet, no-code,
  no-git, no-console settings.

The InstantML spool case also records an uploader-drain phase by draining the
spooled files through a fake client after the hot loop. The report keeps hot
loop and drain costs separate.

Each worker process:

- Disables InstantML source tracking, system metrics, local store, and console
  capture.
- Excludes init/setup and finish/drain from hot-loop timing but reports them
  separately.
- Uses explicit steps and identical scalar metric keys/values.
- Captures parent CPU with `time.process_time()` and process-tree CPU/RSS with
  `psutil` when installed.
- Monitors the whole worker process tree from the parent process so W&B
  service-process work is visible as lifecycle CPU even when it happens outside
  the hot loop.
- Counts files and bytes written under the worker's temp directory.

## Performance Considerations

The benchmark should default to a modest local run, for example thousands of log
calls and six scalar metrics per call, so it is safe to run during development.
Larger runs can be requested explicitly.

The first likely optimization target is the InstantML spool hot path. Before
changing durability semantics, prefer low-risk optimizations that preserve one
event file per log call and the current fsync behavior.

## Testing Plan

- Unit-test deterministic metric payloads, overhead calculations, case ordering,
  and report rendering without importing W&B.
- Run the benchmark locally before and after any SDK hot-path optimization.
- Keep benchmark result JSON out of committed source by default; commit only a
  sanitized Markdown result when it is useful product evidence.

## Documentation Plan

- Update `benchmarks/README.md` with the SDK overhead benchmark command and
  interpretation caveats.
- Update `docs/design/README.md`.
- If SDK internals change, update `packages/python-sdk/README.md` only when
  behavior or public usage changes.

## Review Notes

Fresh methodology review:

- Finding: Current benchmarks measure hosted query/read latency, not SDK
  logging overhead.
- Recommendation: Use fresh child processes, no-op deltas, identical payloads,
  interleaved sample order, and separate init/hot-loop/finish timings.
- Decision: Accepted.

Fresh SDK overhead review:

- Finding: Spool mode serializes events twice, sorts JSON keys, and re-resolves
  paths for each event; `Run.log()` also revalidates scalar metrics after
  classification.
- Recommendation: Add the benchmark first, then prefer safe serialization/path
  optimizations before changing durability semantics.
- Decision: Accepted.

Fresh W&B fairness review:

- Finding: W&B offline/local logging is the closest durable-local comparison to
  InstantML process spool; W&B online enqueue and InstantML sync remote
  acknowledgement are not equivalent.
- Recommendation: Label modes by behavior class and report W&B version and
  service-process CPU separately from parent-process CPU.
- Decision: Accepted.

Fresh benchmark trust review:

- Finding: W&B child CPU can be missed by phase-boundary snapshots, no-op
  checksums must match SDK cases, and repeated warmup step `0` can bias
  provider behavior.
- Recommendation: Consume payload checksums for every case, use unique warmup
  steps, monitor worker process-tree CPU from the parent, and soften claims
  around non-identical durability semantics.
- Decision: Accepted.

## Coverage Exceptions

Coverage exception:
- Uncovered area: full W&B benchmark execution in routine CI.
- Reason: W&B is an optional third-party dependency and the benchmark is
  timing/environment sensitive.
- Risk: local developer environments may see different absolute values.
- Follow-up: keep pure helper tests in CI and record resolved versions in every
  committed benchmark result.
- Owner/date: Codex, 2026-05-21.

## Decision

Accepted for benchmark tooling and narrow SDK hot-path optimizations.
