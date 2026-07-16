# Design: Aim Gap 3 Integration Breadth

Date: 2026-06-30

Status: Implemented

Owner: Codex

Branch: `codex/aim-gap3-integrations`

## Summary

Aim presents broad framework integration as a core adoption feature. InstantML
already has lightweight Hugging Face Trainer, PyTorch Lightning, and Keras
adapter surfaces, plus W&B/Neptune/MLflow/TensorBoard migration tools. The
parity gap is breadth and confidence: users from common ML stacks should see a
maintained adapter or guide that works in a real training loop without making
the core SDK heavy.

This branch adds thin, lazy, tested adapters and examples for Optuna, XGBoost,
LightGBM, CatBoost, Stable Baselines-style RL callbacks, and dataset provenance
helpers. Existing Hugging Face, Lightning, Keras, W&B, MLflow, Neptune, and
TensorBoard paths stay in place. New adapters translate framework events into
existing `Run.log()`, `Run.log_config()`, `Run.log_artifact()`, and rich-object
helpers.

## Goals

- Add integration modules without importing heavy frameworks at package import.
- Cover Optuna, XGBoost, LightGBM, CatBoost, Stable Baselines-style RL, and
  dataset metadata helpers.
- Preserve existing Hugging Face, Lightning, and Keras behavior.
- Preserve scalar logging hot-path performance for users who do not import
  integrations.
- Add examples and docs that a real user can copy into a training script.
- Test adapters with fakes/duck types plus at least one lightweight real
  dependency smoke where practical.

## Non-Goals

- No hosted integration marketplace.
- No server-side third-party credential connectors.
- No sweep/HPO scheduler.
- No mandatory optional dependencies in the core package.
- No deep model-weight introspection or automatic checkpoint discovery.
- No broad framework CI matrix beyond focused optional smoke tests.

## Users and Use Cases

- HPO users log Optuna trials and study-level best values.
- Tree-model users log evaluation metrics from XGBoost, LightGBM, and CatBoost.
- RL users log episode reward/length and optional rollout media from callbacks.
- Data-centric users attach dataset/card/provenance metadata to runs.

## Proposed Design

Add an `instantml.integrations` package with small modules:

- `optuna.py`
- `xgboost.py`
- `lightgbm.py`
- `catboost.py`
- `stable_baselines.py`
- `datasets.py`

Public imports:

- Stable classes documented in this branch are importable from
  `instantml.integrations.*`.
- Top-level `instantml.*` re-exports are limited to the most common stable
  callback names after tests pass; the module paths remain the canonical API.
- Missing optional dependencies raise `InstantMLError` with a copy-ready install
  hint only when the adapter is constructed or invoked.

Adapter patterns:

- Constructors accept an optional existing `Run`.
- If no run is supplied, constructors accept `project`, `config`, `tags`,
  `notes`, and other `instantml.init()` kwargs and lazily create a run on the
  first event that needs logging.
- Each adapter has explicit `close()`/`finish()` when it may own a run.
- `finish()` only finishes runs created by the adapter unless
  `finish_run=True` is explicitly passed with a user-owned run.
- Heavy frameworks are imported only inside adapter methods that need them.

## Event Mapping

| Adapter | Event/hook | Metric keys | Step source | Config/artifacts | Finish ownership | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| Optuna `InstantMLCallback` | `__call__(study, trial)` | `optuna/value`, `optuna/intermediate/<name>`, plus scalar `trial.user_attrs` only when prefixed/configured | `trial.number` by default; optional `step_attr` | logs `trial.params` under config prefix `optuna/params`, study direction/name as metadata | never auto-finishes study-owned runs unless `finish_on_complete=True` and adapter-created | fake `Study`/`Trial`, failed/pruned trial skip rules |
| XGBoost `InstantMLCallback` | `after_iteration(model, epoch, evals_log)` | `<dataset>/<metric>` from `evals_log` latest values | `epoch` | optional `log_config(params)` when user supplies params; no automatic model artifact | adapter-created run finishes in `after_training`; user run not finished by default | duck-typed callback invocation and no import at `import instantml` |
| LightGBM `InstantMLCallback` | callback env with `evaluation_result_list` | `<dataset>/<metric>`; include `-mean`/`-stdv` suffixes when provided by CV | `env.iteration` | optional config from `env.params` filtered to JSON scalars | adapter-created run finishes when explicit `close()` is called; framework lacks universal terminal hook | fake env for train and CV tuple shapes |
| CatBoost `InstantMLCallback` | `after_iteration(info)` | `<dataset>/<metric>` from `info.metrics` latest values | `info.iteration` | optional JSON-scalar config from constructor | adapter-created run finishes on `after_train`/`close()` when available | fake info objects for train/validation |
| Stable Baselines `InstantMLCallback` | `_on_step()`, `_on_rollout_end()` | `rl/episode_reward`, `rl/episode_length`, plus scalar logger values under `rl/<key>` | `num_timesteps` | optional rollout media path via explicit `log_rollout(path, step=...)` only | user-owned run not finished; adapter-created run finishes on `_on_training_end()` | fake base callback fields; missing dependency path |
| Datasets helper | explicit function call | none by default | n/a | logs bounded dataset metadata under `datasets/<key>` and optional preview table/text | never finishes | fake HF dataset/dataset-dict and DVC metadata file fixtures |

Non-numeric framework values are skipped with a warning unless the adapter
explicitly documents a text/object helper. Metric keys are sanitized with the
same conservative key validation used by SDK logging.

## Dataset Metadata Rules

Dataset helpers are explicit and bounded:

- `log_hf_dataset(run, dataset, key="data/train", include_preview=False,
  preview_rows=20)`
- `log_dvc_metadata(run, repo_path=".", key="data/dvc")`

Limits and redaction:

- serialized metadata max 32 KiB per call;
- preview rows max 100, default 20;
- string fields previewed to 1,000 characters;
- local paths are stored as basenames or repo-relative paths only;
- environment variables, credentials, tokens, and absolute home directories are
  redacted by default;
- helpers never scan dataset contents unless `include_preview=True`.

## Component Impact

Backend:

- No endpoint changes.

Frontend:

- Imports/integrations tab copy should mention the new adapter families if that
  copy already exists in the dashboard.

Python SDK:

- New integration modules, optional extras metadata, tests, and examples.
- Keep lazy imports and avoid import-time dependency failures.

Storage:

- No schema changes.

Docs:

- Update SDK README, PyPI README, examples README, apps/docs integration pages,
  and dashboard integration snippets.

## API Contracts

Representative APIs:

```python
from instantml.integrations.optuna import InstantMLCallback as OptunaCallback
from instantml.integrations.xgboost import InstantMLCallback as XGBoostCallback
from instantml.integrations.lightgbm import InstantMLCallback as LightGBMCallback
from instantml.integrations.catboost import InstantMLCallback as CatBoostCallback
from instantml.integrations.stable_baselines import InstantMLCallback as SB3Callback
from instantml.integrations.datasets import log_hf_dataset, log_dvc_metadata

optuna_callback = OptunaCallback(run=run, metric_name="optuna/value")
xgb_callback = XGBoostCallback(run=run)
lgb_callback = LightGBMCallback(run=run)
cat_callback = CatBoostCallback(run=run)
rl_callback = SB3Callback(run=run)

log_hf_dataset(run, dataset, key="data/train")
log_dvc_metadata(run, repo_path=".")
```

Optional extras:

- `instantml[frameworks]`: keeps existing HF/Lightning/Keras pins.
- Add narrow extras such as `instantml[optuna]`, `instantml[xgboost]`,
  `instantml[lightgbm]`, `instantml[catboost]`, `instantml[rl]`, and
  `instantml[datasets]`.
- `instantml[all]` includes the new optional packages.

## Performance Considerations

- Importing `instantml` must not import optional frameworks.
- Callback overhead target: no more than one `Run.log()` call per framework
  metric event unless the framework already batches metrics.
- Adapters do not inspect model weights or datasets unless the user calls an
  explicit helper.
- Lazy import test verifies no `optuna`, `xgboost`, `lightgbm`, `catboost`,
  `stable_baselines3`, `datasets`, or `dvc` modules are loaded by
  `import instantml`.

## Simplicity Review

The design favors thin adapters over a shared callback framework. The SDK
already has durable logging; integrations should translate framework callback
events into that logging API. Shared helpers are allowed only for small repeated
tasks such as metric sanitization, lazy import errors, and owned-run finishing.

Deferred:

- Sweep/HPO orchestration.
- Model registry integration.
- Automatic checkpoint discovery.
- Full optional dependency CI matrix.
- Deep dataset version-control integrations beyond metadata helpers.

## Failure Modes

- Missing framework dependency: raise a clear install-hint error only when the
  adapter is constructed or invoked.
- Framework callback after run finish: follow existing `Run.log()` behavior and
  warn only when the adapter can detect the issue.
- Framework sends nonnumeric metric: skip with warning and record no metric.
- User-owned run finish: adapters do not finish it unless `finish_run=True`.
- Oversized dataset metadata: truncate safe previews and raise/return a bounded
  warning instead of uploading arbitrary content.

## Testing Plan

- Unit tests with fake framework callback inputs for every adapter event mapping
  above.
- Lazy import tests prove heavy modules are not imported by `import instantml`
  or `import instantml.integrations`.
- Optional smoke tests for at least one lightweight real dependency where
  practical, skipped when dependency is unavailable.
- One local E2E script logs representative integration data into Rust/ClickHouse
  and verifies run summaries.
- Browser smoke opens integration docs/snippets and verifies new pages are
  reachable and copyable.
- Auto-review before commit: diff review plus Python tests, E2E smoke, and docs
  validation evidence added to this doc.

## Documentation Plan

- `packages/python-sdk/README.md`: integration API examples and lifecycle
  ownership table.
- `packages/python-sdk/PYPI_README.md`: extras and adapter list.
- `packages/python-sdk/requirements-optional.txt`: optional pins if needed.
- `examples/README.md` and new `examples/integrations/README.md`.
- `apps/docs`: integration guide pages.
- `apps/web/README.md`: dashboard integration snippet update if applicable.

## Alternatives Considered

- Add a generic adapter base class now. Deferred because event semantics differ
  enough that a shared base would hide details before duplication is proven.
- Require optional dependencies for all CI tests. Rejected for CI reliability
  and core SDK lightness.
- Build server-side integrations. Rejected because current adoption design is
  local-first and avoids third-party credentials in the browser/server.
- Ship only docs for these frameworks. Rejected because Aim parity requires
  copy-pasteable maintained hooks, not just "call `run.log()` yourself."

## Review Notes

Fresh reviewer 1:

- Finding: Lazy thin adapters were right, but the draft was too broad without
  exact per-integration event mappings.
- Risk: Implementers could create inconsistent keys, unclear steps, or
  accidental run-finishing behavior.
- Recommended edit: Add an event mapping table covering metric keys, step
  source, config/artifact behavior, lifecycle ownership, and tests.
- Decision: Revise.

Fresh reviewer 2:

- Finding: Dataset metadata needed explicit size caps and redaction rules; the
  optional dependency story also needed to be testable.
- Risk: Dataset helpers could leak local paths or credentials, and imports could
  make the core SDK heavy.
- Recommended edit: Bound metadata/previews, redact sensitive/local values, and
  prove lazy imports for every new optional framework.
- Decision: Revise.

Re-review:

- Reviewer 1: Approved. Earlier blockers are resolved; keep adapters thin and
  tested independently.
- Reviewer 2: Approved. Event mappings, lifecycle ownership, optional extras,
  lazy-import tests, and dataset caps/redaction are concrete enough.

## Progress Log

- 2026-06-30: Created dedicated branch/worktree and drafted design before
  implementation.
- 2026-06-30: Revised design after two fresh reviews to add per-adapter event
  mapping, lifecycle ownership, optional extras, dataset caps/redaction, and
  lazy-import test requirements.
- 2026-06-30: Two fresh reviewers approved the revised design for
  implementation.
- 2026-06-30: Implemented `instantml.integrations` with lazy modules for
  Optuna, XGBoost, LightGBM, CatBoost, Stable Baselines-style callbacks, and
  Hugging Face Dataset/DVC metadata helpers.
- 2026-06-30: Added narrow optional extras, top-level stable callback aliases,
  integration examples, public docs pages, PyPI/SDK README updates, and example
  navigation.
- 2026-06-30: Added fake-framework unit tests for adapter event mappings,
  lifecycle ownership, missing-dependency hints, lazy imports, dataset
  redaction/caps, and DVC metadata parsing.
- 2026-06-30: Ran real Rust/ClickHouse E2E on disposable ports
  `8033/8153/9015-9017`: bootstrapped an API-key org, ran
  `examples/integrations/smoke.py`, verified the finished run via
  `/api/runs/summary`, verified `optuna/value` via `/api/metrics/series`,
  verified dataset preview rows via `/api/objects/:id/rows`, and verified HF
  Dataset/DVC config paths via `/api/runs/:run_id/attributes`.
- 2026-06-30: Ran browser docs smoke against local Next docs on port `3033`.
  Rendered `/docs/integrations/optuna`, `/tree-boosting`,
  `/stable-baselines`, `/datasets`, and `/overview`; checked headings and
  expected snippets in the DOM. The dev terminal served each route with 200s
  and only emitted the standard Clerk keyless development warning.
- 2026-06-30: Validation passed:
  `python -m py_compile packages/python-sdk/instantml/__init__.py
  packages/python-sdk/instantml/integrations/*.py examples/integrations/smoke.py`;
  `python -m pytest packages/python-sdk/tests/test_integrations.py -q -o
  addopts='' --cov=instantml.integrations --cov-report=term-missing
  --cov-fail-under=0` (97% integration-package coverage);
  `python -m pytest packages/python-sdk/tests -q --no-cov`;
  `python -m build packages/python-sdk`;
  `python -m twine check packages/python-sdk/dist/*`;
  `npm run docs:validate`; `git diff --check`.
  Docs validation emitted the existing duplicate sharp/libvips Objective-C
  warning but passed.
- 2026-07-04: Review hardening pass fixed adapter edge cases:
  NumPy-style scalar metrics and XGBoost CV `(mean, std)` tuples now preserve
  the intended scalar value; CatBoost-owned runs finish from the last iteration
  callback when total iteration metadata is available; empty HF datasets no
  longer crash preview selection; DVC discovery includes bounded nested
  `*.dvc` files; Optuna multi-objective/no-complete property reads no longer
  abort callbacks; Stable Baselines logger values are logged once per rollout
  timestep instead of every environment step, with simultaneous episode
  completions aggregated instead of overwritten.
- 2026-07-04: Validation passed:
  `python3 -m compileall -q packages/python-sdk/instantml/integrations
  packages/python-sdk/tests/test_integrations.py`;
  `pytest packages/python-sdk/tests/test_integrations.py -q --no-cov`;
  `python -m pytest packages/python-sdk/tests/test_integrations.py -q -o
  addopts='' --cov=instantml.integrations --cov-report=term-missing
  --cov-fail-under=0` (95% integration-package coverage);
  `git diff --check`. A `python3 -m pytest ...` retry was not used because the
  system `python3` interpreter lacks pytest; the repository `pytest`/`python`
  environment is Python 3.11.5.
- 2026-07-15: Follow-up review hardening releases callback-owned runs after
  finish so one callback instance can create a fresh run when reused across
  trainings. Explicitly supplied runs remain bound.

## Coverage Exceptions

Coverage exception:
- Uncovered area: A small set of defensive branches in
  `instantml.integrations._common`, dataset fallback parsing, and Optuna study
  completion edge paths.
- Reason: Focused tests cover every documented adapter event mapping,
  lifecycle ownership rule, missing dependency hint, lazy import guarantee,
  dataset redaction/cap rule, and the real SDK -> Rust API -> ClickHouse path.
  The remaining branches are malformed framework inputs or fallback-only
  guards that would require brittle synthetic cases.
- Risk: Low. The covered tests exercise all user-facing integration behavior;
  malformed inputs continue to skip/warn or return bounded metadata.
- Follow-up: Add framework-specific optional smoke tests in CI if the repo later
  installs one or more real optional dependencies.
- Owner/date: Codex, 2026-06-30.

## Decision

Implemented.
