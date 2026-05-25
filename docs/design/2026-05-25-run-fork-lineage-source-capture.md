# Design: Run Fork Lineage And Source Capture

Date: 2026-05-25

Status: Accepted for narrowed first slice after review

Owner: Codex

## Summary

InstantML already has checkpoint artifacts and resume snippets, but restarting a failed run from the UI is still a copy-code workflow rather than a first-class run relationship. Neptune's explicit fork semantics are the right inspiration for the next slice: create a new run from an existing run at a chosen step, optionally tie it to a checkpoint artifact, optionally inherit config, and make that parent/child relationship visible in the dashboard.

The smallest useful implementation adds a Rust-backed fork endpoint, a bounded lineage read endpoint, SDK helpers for attaching to a forked run and source-capture settings, and basic UI controls in Run Detail/Graph. The fork endpoint creates a normal run with first-class lineage fields. It does not start user training, schedule jobs, copy metric history, or mutate artifact bytes.

This same slice tightens SDK source metadata. Today `source_tracking=True` captures argv/cwd by default. The revised default keeps smaller reproducibility context: git commit, dirty flag, entrypoint filename, Python version, and platform. Users can explicitly opt into command, paths, branch, hostname, pid, and a diff summary through `SourceTracking`. Raw patch text is not stored in run metadata because run summaries and search include metadata today.

## Goals

- Add explicit fork semantics for `source run -> child run`.
- Let a fork point at a concrete step and optional checkpoint artifact on the source run.
- Let callers inherit source config by default and apply shallow config overrides.
- Make lineage visible in the UI for the selected run and checkpoint rows.
- Add SDK source-capture knobs with safer defaults.
- Keep the implementation narrow, synchronous, and compatible with the existing Rust/ClickHouse operational record model.

## Non-Goals

- Do not launch training jobs from the UI.
- Do not copy metric history, artifacts, logs, or rich objects into the child run.
- Do not add checkpoint registries, artifact versions, aliases, manifests, or model packages.
- Do not add a separate lineage table until query volume or graph complexity requires it.
- Do not enable command capture, path capture, hostname/pid capture, branch capture, or diff summary capture by default.
- Do not store raw git patch text in run metadata.
- Do not change the deprecated Node compatibility server unless a shared SDK contract requires it.

## Users and Use Cases

Research engineers reviewing a failed run want to click a checkpoint and create a retry run that keeps the original config, records the checkpoint source, and appears immediately in the run list. They can then resume their training script against the checkpoint and log into the new run.

Platform-minded users want source metadata that is useful for reproducibility without surprising privacy leakage. Commit and dirty state are safe enough defaults for most teams; command, cwd, repo root, branch, host, pid, and diff summary capture should be explicit.

## Proposed Design

### Run Forks

Add `POST /api/runs/{run_id}/forks`.

The endpoint creates a new run in the caller's org. By default it:

- always uses the source run's project in this first slice,
- inherits the source run config,
- names the run `fork-of-<source-name>-step-<step>` when a step is known,
- copies source tags and appends `forked`,
- sets status to `running` because existing SDK/server status values are `running`, `finished`, and `failed`; the UI must label this as a run record and explicitly say InstantML has not started training,
- records lineage top-level fields:
  - `parent_run_id`
  - `forked_from_step`
  - `forked_from_artifact_id`
- records user-visible lineage metadata under `metadata.lineage`, derived from the authoritative first-class fields.

Request:

```json
{
  "name": "retry-seed-13",
  "step": 120,
  "checkpoint_artifact_id": "artifact-uuid",
  "inherit_config": true,
  "config_overrides": {"lr": 0.0001},
  "tags": ["retry", "checkpoint"],
  "notes": "Retry from the last stable checkpoint.",
  "metadata": {"reason": "nan loss after eval"}
}
```

Validation:

- Source run must be readable by the caller.
- Mutating callers need both `export:read` on the source run and `sdk:ingest` or an equivalent browser session role that can create runs.
- Forks are same-project only. There is no `project` request override in this slice.
- Project-scoped API keys can fork only runs in their scoped project, and the child remains in that same project.
- `checkpoint_artifact_id`, when present, must reference a `checkpoint` artifact on the source run.
- `step`, when present, must be finite and nonnegative.
- If a checkpoint artifact is present and `step` is omitted, the server derives the fork step from `artifact.step` or `artifact.metadata.checkpoint.step`.
- If both a checkpoint artifact and `step` are present, the values must match when the artifact has a known checkpoint step.
- `config_overrides` and `metadata` must be JSON objects.
- Request metadata may not include `lineage`, `parent_run_id`, `forked_from_step`, or `forked_from_artifact_id`; those are server-owned fork fields for this endpoint.
- Final merged config and metadata must fit the same 1 MiB JSON body budget used by normal API requests.
- `Idempotency-Key` is supported and recommended. Repeating the same key/body returns the same child run response; reusing a key with a different body returns conflict.
- The endpoint uses the same billing/plan capacity checks as normal run creation.

Response:

```json
{
  "run": {
    "...": "normal run summary fields",
    "parent_run_id": "source-run-uuid",
    "forked_from_step": 120,
    "forked_from_artifact_id": "artifact-uuid"
  }
}
```

The returned run is summarized like `GET /runs/{id}`, so the UI can immediately add it to local run state without a full page refresh. The first-class lineage fields are authoritative; `metadata.lineage` is a convenience snapshot only.

### Lineage Read

Add `GET /api/runs/{run_id}/lineage`.

The endpoint returns a bounded summary graph for the selected run:

```json
{
  "run": {"id": "...", "name": "..."},
  "parent": {"id": "..."} | null,
  "children": [{"id": "..."}],
  "checkpoint_artifact": {"id": "..."} | null,
  "children_total": 3,
  "has_more_children": false,
  "limit": 100
}
```

The first slice returns at most 100 children sorted newest-first. It summarizes only the selected run, parent, and children. It does not recursively walk large graphs. The store keeps an in-memory `(org_id, parent_run_id, created_at, run_id)` projection index during replay and `insert_run`, avoiding a full run scan without adding a new ClickHouse table.

### UI

Run Detail keeps the existing checkpoint list and adds a `Fork` action beside each checkpoint. The Summary view must show this checkpoint list when checkpoints exist, not only the full detail body. Clicking `Fork` opens a confirmation dialog/drawer with editable child name, editable reason, inherited-config toggle, read-only source run/checkpoint/step summary, and the explicit copy: `InstantML creates a linked run record only. It does not start training.`

Submitting the dialog calls `POST /api/runs/{run_id}/forks` with the checkpoint artifact id, derived step, inherited config setting, reason metadata, and an `Idempotency-Key`. The per-checkpoint action is disabled while pending so double-clicks cannot create duplicate children. The new run is inserted into the current summary/page state, cached in selected-run details, and selected for inspection even when it is outside the current paginated page.

The existing Run Workspace `Graph` tab becomes the lineage panel. It fetches `GET /api/runs/{run_id}/lineage` only when `activeTab === "detail" && runWorkspaceTab === "graph"`, uses abort/request-key guards to ignore stale responses, and shows parent/source, selected run, latest children, checkpoint artifact, loading, empty, error, retry, and truncated states. The graph is a semantic list/table with clear labels so keyboard and screen-reader users can inspect it without relying on a visual-only diagram.

Failed-run triage should show a visible retry affordance only when a checkpoint exists. No UI copy should imply InstantML starts the training process; it creates the child run and lineage link.

### SDK

Add:

```python
api = im.Api(base_url="http://127.0.0.1:8000", api_key="...")
child = api.fork_run(
    "source-run-id",
    step=120,
    checkpoint_artifact_id="artifact-id",
    inherit_config=True,
    config_overrides={"lr": 0.0001},
)
```

`Api.fork_run()` returns the decoded `run` object. It derives a stable idempotency key from the source run id and fork request body unless the caller passes `idempotency_key` explicitly, so a timeout followed by the same SDK call replays the same child. It raises `InstantMLError` on non-2xx responses like other SDK calls. It is a Rust-primary SDK helper; callers using the deprecated Node compatibility server receive the normal 404/unsupported-route error.

Add `Client.attach_run(run_id)` and top-level `attach_run(run_id, ...)` to return a `Run` handle for an existing run. This lets SDK users log to a run created through UI/API fork:

```python
fork = api.fork_run("source-run-id", checkpoint_artifact_id="artifact-id")
run = im.attach_run(fork["id"], base_url="http://127.0.0.1:8000")
run.log({"train/loss": 0.1}, step=121)
run.finish()
```

`attach_run()` validates the target run by default so typos or insufficient
read credentials fail before async logging starts. `validate=False` is available
for intentionally write-only or offline attach flows. Because attach uses the
SDK default async upload mode, short examples must call `finish()` or
`wait_for_processing()` before process exit.

Add `SourceTracking`:

```python
run = im.init(
    project="cartpole",
    source_tracking=im.SourceTracking(
        command=True,
        paths=True,
        git_diff=True,
    ),
)
```

Existing `source_tracking=True` remains accepted and intentionally maps to `SourceTracking.privacy_safe()` as a privacy-hardening change. Existing `source_tracking=False` disables `_rlobs.source`.

Default source metadata:

- `entrypoint`: basename of `sys.argv[0]` when available.
- `git.available`
- `git.commit`
- `git.dirty`
- `capture`: the resolved capture settings.
- environment `python` and `platform`.

Explicit knobs:

- `command=True` includes `argv`.
- `paths=True` includes `cwd` and `git.root`.
- `branch=True` includes the current branch name.
- `hostname=True` and `pid=True` include host/process identifiers.
- `git_diff=True` includes `diff_summary` from safe git diff commands plus a SHA-256 digest/truncation status for the combined staged/unstaged patch. It does not store raw patch text in metadata.

## Component Impact

Backend:

- Add domain request/response schemas for fork and lineage.
- Add `RunRow` optional lineage fields with serde defaults for old records.
- Add an in-memory child-by-parent projection index.
- Add store functions for fork creation and bounded lineage summary.
- Add two Rust handlers and OpenAPI annotations.

Frontend:

- Extend run types with optional lineage fields.
- Add checkpoint fork buttons and lineage graph tab.
- Keep fetches gated to active Run Detail/Graph usage.

Python SDK:

- Add `Api.fork_run()`.
- Add `attach_run()`.
- Add `SourceTracking` and update source metadata capture.
- Preserve bool compatibility for `source_tracking`.

Storage:

- No new ClickHouse table.
- Operational `run` records carry optional lineage fields and a user-visible `metadata.lineage` snapshot.

Docs:

- Update root/design index, Rust README, web README, SDK README, and SDK package README.

## Data Model

`RunRow` adds:

```rust
#[serde(default)]
pub parent_run_id: Option<Uuid>,
#[serde(default)]
pub forked_from_step: Option<f64>,
#[serde(default)]
pub forked_from_artifact_id: Option<Uuid>,
```

New forked runs also include:

```json
{
  "lineage": {
    "kind": "fork",
    "source_run_id": "...",
    "source_project": "...",
    "source_run_name": "...",
    "source_step": 120,
    "checkpoint_artifact_id": "...",
    "checkpoint_name": "...",
    "checkpoint_step": 120,
    "inherit_config": true,
    "created_at": "..."
  }
}
```

## API Contracts

- `POST /api/runs/{run_id}/forks`
- `GET /api/runs/{run_id}/lineage`
- SDK `Api.fork_run(...)`
- SDK `attach_run(...)`
- SDK `SourceTracking`

Errors:

- `400 validation_error` for invalid step/config/metadata or a non-checkpoint artifact.
- `401` when auth is missing.
- `403` when scope/project/org access is invalid.
- `404` when the source run or checkpoint artifact is not visible.
- `402` when plan or billing gates block run creation.
- `409` when an idempotency key is reused with a different request body.

## Performance Considerations

Expected write frequency is low: one fork action per failed/retry workflow. It writes one run record only; same-project-only semantics avoid project creation and partial project-write exposure. It does not touch metric hot paths or artifact byte storage.

Expected read shape for lineage is bounded: selected run, optional parent, up to 100 direct children, and one optional checkpoint artifact. The first slice uses an in-memory parent-run index and fetches only when the Graph tab is active. If lineage reads become dashboard-wide or recursive, add a dedicated read model or ClickHouse table.

SDK source capture remains cheap by default. Git commands have short timeouts. Diff summary/digest capture is opt-in, capped, and only runs during `init()`, not on the metric logging hot path. Raw diffs are intentionally not inserted into run metadata because summaries and search currently include metadata.

## Simplicity Review

This avoids a new lineage table, avoids async job launching, avoids cross-project visibility rules, and avoids artifact-copy semantics. A fork is just a same-project new run with explicit parent pointers and immutable metadata. That is enough to support restart-from-checkpoint workflows while preserving the current SDK -> API -> UI loop.

Deferred complexity:

- recursive lineage DAGs,
- checkpoint package/version management,
- background training job orchestration,
- bulk lineage queries for run tables,
- raw source diff artifacts and default branch/command/path capture.

## Failure Modes

- Fork creation fails validation: no child run is created.
- Checkpoint artifact disappears or belongs to another run: return validation/not-found error; no child run is created.
- Config inheritance creates a config or metadata payload that is too large: return validation error before persisting anything.
- UI fork succeeds but summary refresh fails: keep the created child in local state and show the response message.
- UI fork request is slow or rejected by billing/auth: show the existing API error message and leave the selected run unchanged.
- Fork request times out after success and is retried: SDK-derived or caller-provided idempotency key returns the same child run instead of creating a duplicate.
- Source metadata git command times out: set `git.available` false or omit optional fields, never fail run creation.
- Git diff summary/digest capture exceeds the cap: stop reading, record `diff_truncated=true`, and never fail run creation.

## Testing Plan

Backend:

- Unit tests for fork request validation, config inheritance/override, checkpoint validation, project-scope denial, and lineage response shape.
- Unit tests for checkpoint step mismatch rejection, same-project behavior, idempotent retry, old `RunRow` serde defaults, and parent-run index replay.
- Rust route/OpenAPI coverage through generated OpenAPI and existing API type drift checks.

SDK:

- Unit tests for `SourceTracking` default, disabled, command/path/branch/host/pid/diff-summary capture, and missing git behavior.
- Unit tests for `Api.fork_run()` request shape and error propagation.
- Unit tests for `attach_run()`.

Frontend:

- Node tests for checkpoint fork payload construction, duplicate-submit guards, and lineage row rendering helpers.
- Component/model tests for lineage helpers where possible.
- Browser/Computer Use verification against a local Rust/ClickHouse + Next server: create a run, log a checkpoint, click Fork, confirm the dialog says training is not started, confirm child appears with parent/checkpoint lineage, and confirm the Graph tab shows the relationship.

Full checks:

- `npm run rust:fmt`
- `npm run rust:test`
- `npm run test:python`
- `node --test apps/web/tests/state.test.js`
- `npm run codegen:api`
- `npm run verify:api-types`
- `npm run web:build`
- targeted local UI smoke with Computer Use

## Documentation Plan

- `docs/design/README.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `packages/python-sdk/README.md`
- `packages/python-sdk/PYPI_README.md`

## Alternatives Considered

Separate lineage table:

- Rejected for this slice because direct parent fields and a replayed in-memory index cover the UI workflow without adding ClickHouse table complexity.

SDK-only fork via normal `init(metadata=...)`:

- Rejected because it would not give the UI or API a validated first-class relationship and would not enforce same-run checkpoint references.

UI-only resume code:

- Rejected because that is the current state and does not create a discoverable run lineage.

Default full command/diff capture:

- Rejected for privacy and payload-size reasons.

## Review Notes

Fresh reviewer 1:

- Finding: Fork route must require both read and write authorization; cross-project forks leak project-scoped lineage; checkpoint step consistency needs a hard rule; child scans should use an in-memory parent index; project creation during fork creates partial-write risk; final config/metadata size needs validation; source tracking may be a separate change.
- Risk: Unauthorized metadata/config reads, lineage leaks, misleading checkpoint state, avoidable lock scans, orphan projects, oversized operational records, and too much scope.
- Recommended edit: Require `export:read` and `sdk:ingest`, make first slice same-project only, derive/reject checkpoint step mismatches, add a `runs_by_parent` index, remove project creation, validate final payload size, and consider splitting source tracking.
- Decision: Accepted all except splitting source tracking. Source tracking remains because the user explicitly requested it, but raw diffs are narrowed to summary/digest metadata.

Fresh reviewer 2:

- Finding: One-click fork could imply job launch; checkpoint action placement missed the current Summary rendering; loading/error/cancellation and duplicate-submit states were underspecified; lineage cap needed count/truncation fields; accessibility and Computer Use verification were too light.
- Risk: Accidental billed writes, confusing retry semantics, hidden primary workflow, stale UI state, duplicate children, misleading graph completeness, and inaccessible graph controls.
- Recommended edit: Add a confirmation dialog with explicit non-launch copy, show checkpoint action in Summary, use busy/disabled/idempotent submit state, abort/ignore stale lineage fetches, return child totals/truncation fields, and verify pointer/keyboard UI flows locally.
- Decision: Accepted.

Fresh reviewer 3:

- Finding: First-class lineage fields and metadata snapshot could diverge; `_instantml` reservation is not global; SDK helper is Rust-only while Node remains deprecated; first slice is broad; parent-child scans need an index; fork creation needs idempotency.
- Risk: Multiple sources of truth, metadata collision, unsupported Node route surprises, larger blast radius, performance decay, and duplicate children after retries.
- Recommended edit: Make first-class fields authoritative, avoid `_instantml` server-owned metadata in this slice, document Rust-primary SDK behavior, add parent index, add idempotency, and split source tracking if possible.
- Decision: Accepted except splitting source tracking; source knobs are narrowed and documented.

Fresh reviewer 4:

- Finding: `Api.fork_run()` alone creates child runs without a way to log into them; raw git diff in metadata is unsafe because summaries/search include metadata; privacy-safe defaults still leaked hostname/pid/branch; `source_tracking=True` compatibility needed an explicit migration stance; SDK fork signature and diff guardrails needed precision.
- Risk: Orphan forked runs, secret exposure, bloated run summaries/search, privacy surprise, and inconsistent SDK behavior.
- Recommended edit: Add `attach_run()`, avoid raw diffs in metadata, make hostname/pid/branch opt-in, treat the bool `True` remap as an intentional privacy hardening, specify SDK signatures and safe git flags/timeouts.
- Decision: Accepted.

## Coverage Exceptions

None expected.

## Decision

Accepted for the narrowed first slice above.
