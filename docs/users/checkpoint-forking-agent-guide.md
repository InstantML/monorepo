# Checkpoint And Forking Agent Guide

This guide is for agents or contributors wiring checkpoint restore, same-project
forking, and resume workflows. Keep it aligned with the Rust API, Python SDK,
and dashboard docs.

## Current Contract

- Artifact `type` accepts only `checkpoint`, `file`, or `rollout`.
- Checkpoint artifacts are ordinary artifact rows with `type: "checkpoint"`.
- A fork creates a linked child run record. It does not start training, copy
  historical metrics, or copy artifact bytes.
- The dashboard exposes checkpoint download, resume-code, and fork actions from
  Run Detail. The fork modal makes source run, checkpoint, and step read-only;
  users choose child name, reason/notes, and whether to inherit config.
- Lineage reads direct parent, children, fork step, and checkpoint context from
  the run and artifact metadata.

## Scope Matrix

| Action | Required API-key scope |
| --- | --- |
| Log metrics/status/rich objects | `sdk:ingest` |
| Create artifact metadata | `artifacts:write` |
| Upload artifact bytes | `artifacts:write` |
| Create a fork | `export:read` and `sdk:ingest` |
| Attach to an existing run with validation | `export:read` |
| Download artifact bytes | `export:read` |
| Read usage/billing counters | Unrestricted org API key with `usage:read` |

Local rich media objects (`Image`, `Audio`, `Video`) upload artifact bytes and
then create a linked rich object, so they need both `artifacts:write` and
`sdk:ingest`. They are not supported in `upload_mode="spool"` because the object
link needs the upload response.

## Log Checkpoints From Python

Use metadata-only checkpoint logging when bytes are already stored elsewhere:

```python
import instantml as im

run = im.init(project="cartpole", name="ppo-seed-13")
run.log_checkpoint(
    name="policy-step-1000",
    uri="s3://bucket/checkpoints/policy-step-1000.pt",
    step=1000,
    metadata={"framework": "torch", "score": 812.4},
)
run.finish()
```

Use `log_checkpoint_file(...)` when InstantML should store the bytes:

```python
import instantml as im

run = im.init(project="cartpole", name="ppo-seed-13", upload_mode="sync")
run.log_checkpoint_file(
    "checkpoints/policy-step-1000.pt",
    name="policy-step-1000",
    step=1000,
    metadata={"framework": "torch", "score": 812.4},
)
run.finish()
```

The local-file helper records size, SHA-256, MIME type when detectable, run ID,
and step. In `upload_mode="spool"`, the SDK also records source path metadata so
the uploader process can read the file later. Use `CheckpointPolicy(every_steps=N)`
when a training loop needs a fixed checkpoint interval.

## Fork And Resume From Python

Use `Api.fork_run(...)` to create the child run, then `attach_run(...)` to log
from the resume script:

```python
import instantml as im

api = im.Api()
child = api.fork_run(
    "source-run-id",
    checkpoint_artifact_id="artifact-id",
    step=1000,
    name="ppo-seed-13-resume",
    notes="Resume from the best checkpoint after reward instability.",
)

run = im.attach_run(child["id"])
run.log({"train/loss": 0.11}, step=1001)
run.finish(timeout=30)
```

`Api.fork_run(...)` derives a stable idempotency key from the fork body unless
one is passed explicitly. `attach_run(...)` validates the child run exists by
default; use `validate=False` only for write-only credentials or intentionally
offline attach flows.

## Fork Through HTTP

```http
POST /api/runs/{source_run_id}/forks
Authorization: Bearer instantml_...
Content-Type: application/json
Idempotency-Key: fork-source-run-id-artifact-id-step-1000

{
  "checkpoint_artifact_id": "artifact-id",
  "step": 1000,
  "name": "ppo-seed-13-resume",
  "inherit_config": true,
  "notes": "Resume from the best checkpoint after reward instability."
}
```

The caller needs read access to the source run and write access to create the
child. Retrying with the same `Idempotency-Key` returns the same fork result.

## Download Checkpoint Bytes

```python
import instantml as im

api = im.Api()
path = api.download_artifact("artifact-id", "checkpoints/policy-step-1000.pt")
print(path)
```

Stored bytes are served by the Rust artifact download route. Browser and SDK
callers should preserve the filename/MIME metadata shown in the artifact row
when building restore scripts.

## Public Docs To Keep In Sync

- `/docs/sdk/artifacts-checkpoints` and `/docs/sdk/artifacts-checkpoints.md`
- `/docs/sdk/querying-data` and `/docs/sdk/querying-data.md`
- `/docs/quickstart` and `/docs/quickstart.md`
- `/docs/dashboard/checkpoints` and `/docs/dashboard/checkpoints.md`
- `/docs/api/projects-runs` and `/docs/api/projects-runs.md`
- `/docs/api/artifacts` and `/docs/api/artifacts.md`

Do not add duplicate checked-in Markdown mirrors under `apps/docs/`; the web app
generates `.md` mirrors from MDX at request time.
