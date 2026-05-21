# Design: Checkpoint Artifacts

Date: 2026-05-21

Status: Accepted for first slice

Owner: Codex

## Summary

InstantML already stores artifact bytes in the artifact plane and records artifact metadata in ClickHouse. The smallest useful checkpoint feature should make model checkpoints a first-class typed artifact workflow instead of adding another storage system or table.

External trackers follow the same broad shape. Neptune's legacy docs show checkpoints as files uploaded under a run namespace and separately note that users may store the bytes in S3-compatible storage while tracking metadata. Its restart guide fetches a chosen checkpoint, downloads it, loads model and optimizer state, and continues training from that step. W&B's current artifact docs describe model checkpoints as run output artifacts, with later restore through `use_artifact()`/download or framework callbacks such as `WandbModelCheckpoint`.

The first InstantML slice keeps checkpoint bytes in the existing local/R2 artifact backend, marks them with `type: "checkpoint"`, stores restore metadata in the artifact metadata JSON, and makes the frontend generate a copyable Python resume snippet that downloads the checkpoint and starts a new run in the `checkpoints` project.

## Goals

- Let SDK users define a checkpoint interval and upload real checkpoint bytes with one obvious helper.
- Keep checkpoints on the existing artifact upload/download path so R2 storage, usage accounting, and auth scopes stay shared.
- Show selected-run checkpoints in Run Detail without requiring users to hunt through the generic artifact browser.
- Generate Python resume code that downloads a checkpoint, carries the source run config forward, and starts a new run in project `checkpoints`.
- Verify a complete create-checkpoint-download-resume flow in tests and examples.

## Non-Goals

- Framework-specific PyTorch, Keras, Lightning, or Transformers callbacks in this first slice.
- A separate checkpoint table, model registry, alias system, retention policy, or lineage graph.
- Server-side execution of resume code.
- Cross-run dependency graphs beyond metadata stored on the resumed run.
- Large multipart/resumable artifact upload changes.

## Users and Use Cases

The first user is a researcher or ML engineer running a training script that wants to save progress every N steps. During or after training they can inspect checkpoints in Run Detail, copy the resume snippet, download the checkpoint, restore their model/optimizer state in their own framework code, and create a new run in `checkpoints` that records the source checkpoint relationship.

## Proposed Design

Checkpoint storage remains artifact storage:

- A checkpoint is an artifact row with `type: "checkpoint"`.
- Bytes are uploaded through `POST /api/runs/:id/artifacts/upload`.
- Download uses `GET /api/artifacts/:artifact_id/download`.
- Usage accounting already includes uploaded artifact bytes, including checkpoint artifacts.

SDK additions:

- Add `CheckpointPolicy(every_steps, include_step_zero=False)` with `should_save(step)` for simple `if policy.should_save(step)` loops.
- Add `Run.log_checkpoint_file(path, step, name=None, metadata=None)` as a thin wrapper over `upload_file(..., artifact_type="checkpoint")`.
- The wrapper enriches metadata with `kind: "checkpoint"` and a nested `checkpoint` object containing `step` and `source_run_id`.
- Add `Api.download_artifact(artifact_id, output_path)` for restore snippets and tests.

Frontend additions:

- Add a Run Detail checkpoint section for selected-run artifacts with `type === "checkpoint"`.
- Fetch selected-run artifacts for the Run Detail summary, not only for the Files local tab.
- Each checkpoint row shows name, step, size, download availability, and a `Resume Code` copy action.
- The generated code uses `im.Api(...).download_artifact(...)`, starts `im.init(project="checkpoints", ...)`, includes the source run config, and stores source checkpoint metadata.

Example additions:

- Add `examples/checkpoints/`, a deterministic standard-library example that trains a tiny model, saves JSON checkpoints every N steps, logs those files through `run.log_checkpoint_file()`, and can resume from a downloaded checkpoint into a new `checkpoints` project run.

## Component Impact

Backend:

- No new endpoint is required.
- Extend the black-box contract smoke to prove checkpoint upload, download, usage bytes, and resumed run creation.

Frontend:

- Add checkpoint resume-code generation helper and Run Detail UI.
- Keep object/table rich evidence fetches gated to the Files tab; artifact manifest fetches are small and bounded.

Python SDK:

- Add checkpoint interval helper, checkpoint file upload helper, and raw artifact download helper.
- Keep existing `log_checkpoint()` metadata-only helper for compatibility.

Storage:

- No new schema. Checkpoints are artifact rows and R2/local objects.
- Artifact bytes count toward retained storage as they do today.

Docs:

- Update SDK README, web README, examples README, and add an example README.

## Data Model

No new persisted table or index.

Checkpoint artifact metadata conventions:

```json
{
  "kind": "checkpoint",
  "checkpoint": {
    "step": 100,
    "source_run_id": "run-id"
  }
}
```

Resumed runs store:

```json
{
  "resumed_from_checkpoint": {
    "source_run_id": "run-id",
    "checkpoint_id": "artifact-id",
    "checkpoint_step": 100
  }
}
```

## API Contracts

No HTTP route shape changes.

SDK additions:

```python
policy = im.CheckpointPolicy(every_steps=100)
if policy.should_save(step):
    run.log_checkpoint_file("checkpoint.json", step=step)

api = im.Api(base_url="http://127.0.0.1:8000", api_key="...")
checkpoint_path = api.download_artifact("artifact-id", "checkpoints/model.json")
```

Errors:

- `CheckpointPolicy` rejects non-positive or non-integer intervals.
- `log_checkpoint_file()` keeps existing `upload_file()` validation for missing files and invalid steps.
- `download_artifact()` raises `InstantMLError` for HTTP/network failures and creates parent directories for the destination path.

## Performance Considerations

- Expected checkpoint writes are far less frequent than scalar metric writes. Users should checkpoint every hundreds or thousands of steps for large models.
- Checkpoint uploads stay outside scalar metric ingestion and use the existing artifact upload body limits.
- Run Detail fetches at most the existing artifact page limit for one selected run.
- Large checkpoint support beyond current upload limits remains deferred to resumable/multipart upload work.

## Simplicity Review

This design avoids a new checkpoint service, schema, lineage table, or framework callback layer. It makes the existing artifact path more ergonomic and visible. Deferred complexity includes checkpoint aliases, retention, model registry promotion, callbacks, and multipart uploads.

## Failure Modes

- Upload fails: SDK raises the existing artifact upload error unless offline/spool mode is enabled.
- Download fails or artifact is metadata-only: SDK raises an error; UI download action remains unavailable for metadata-only artifacts.
- User restore code loads the checkpoint incorrectly: generated code leaves framework-specific loading explicit instead of pretending InstantML can restore every model shape.
- Artifact manifest unavailable: Run Detail falls back to no checkpoint rows and shows the existing dashboard error message.

## Testing Plan

- SDK unit tests for `CheckpointPolicy`, `Run.log_checkpoint_file()`, and `Api.download_artifact()`.
- Example unit tests for checkpoint save/load and interval logging.
- Contract smoke extension for checkpoint upload/download, usage-byte accounting, and resumed run creation in project `checkpoints`.
- Frontend node tests for generated resume code.
- UI smoke assertion that Run Detail exposes checkpoint resume code for a seeded checkpoint artifact.

## Documentation Plan

- `packages/python-sdk/README.md`
- `apps/web/README.md`
- `examples/README.md`
- `examples/checkpoints/README.md`

## Alternatives Considered

Separate checkpoint table:

- Rejected for this slice because artifact rows already store type, name, URI, step, size, hash, MIME, metadata, org, and run relationship.

Framework callbacks first:

- Rejected for this slice because a small generic helper works for all frameworks and avoids integration-specific behavior before the core workflow is proven.

Metadata-only checkpoints:

- Rejected as the primary path because the product now has R2/local artifact byte storage and users need download/restore to work from the UI.

## Review Notes

Implementation review:

- Finding: Avoid adding a table until there is a query that cannot be served from bounded run artifact lists.
- Risk: Very large model checkpoints still hit current upload body limits.
- Recommended edit: Keep first slice byte-backed but document multipart upload as future work.
- Decision: Accepted.

Failure-mode review:

- Finding: Generated resume code should not hide framework restore details.
- Risk: A generic `continue_training()` stub could imply InstantML can load arbitrary checkpoint formats.
- Recommended edit: Download the file, create a run, and leave model/optimizer load as explicit user code.
- Decision: Accepted.

## Coverage Exceptions

None.

## Decision

Accepted for implementation as the first checkpoint slice.
