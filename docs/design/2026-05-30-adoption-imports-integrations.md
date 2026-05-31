# Design: Adoption Imports And Integrations

Date: 2026-05-30

Status: Accepted

Owner: Codex

## Summary

InstantML needs a fast adoption path for teams that already log real workloads
with W&B, Neptune, TensorBoard, Lightning, Hugging Face Trainer, or Keras. The
smallest useful production slice is not another dashboard tab by itself; it is
a reliable translation pipeline from those existing schemas into InstantML's
run, metric, config, tag, note, status, artifact-reference, and provenance
model.

This design replaces the current one-shot transformed JSON import path with an
Import v2 job API. SDK/CLI importers read third-party data locally, normalize it
into bounded canonical chunks, dry-run those chunks against the API, then commit
the exact reviewed chunks. The server validates, redacts, deduplicates, batches,
persists, and exposes job progress to the dashboard. The existing W&B, Neptune,
and MLflow JSON endpoints remain as small compatibility wrappers over this
foundation.

## Goals

- Let design partners import W&B projects, Neptune Exporter directories, and
  TensorBoard logs without handing third-party credentials to InstantML servers.
- Let teams dual-log to real W&B and InstantML while evaluating.
- Provide a W&B-compatible subset at `instantml.compat.wandb` without shadowing
  the official `wandb` package.
- Provide native Lightning, Hugging Face Trainer, and Keras adapters that use
  the existing async SDK path.
- Give the dashboard a dedicated `/dashboard/imports` workflow for commands,
  dry-runs, progress, warnings, retries, and framework snippets.

## Non-Goals

- Hosted W&B/Neptune connectors in the production v1 PR.
- Artifact byte migration or server-side external artifact fetching.
- W&B sweeps, reports, model registry, launch, full artifact lineage, or full
  media parity.
- Destructive `--replace` imports.
- Parsing raw Neptune Parquet or TensorBoard event files inside the Rust request
  path.

## Users and Use Cases

- A research engineer dual-logs new W&B runs to InstantML during evaluation.
- An ML platform engineer imports an existing W&B project through local W&B API
  credentials.
- A team leaving Neptune imports a Neptune Exporter Parquet directory.
- A researcher points TensorBoard sync at a logdir and either creates one
  InstantML run per logdir or attaches to an explicit run ID.
- A training script swaps in InstantML's Lightning, HF, or Keras adapter in
  under ten lines.

## Proposed Design

Import v2 is a server-side job state machine backed by persisted normalized
chunks. The legal states are:

- `created`: job metadata exists; no chunks are required yet.
- `uploading`: at least one chunk has been accepted; more chunks may arrive.
- `dry_run_ready`: final chunk received, chunks validated, summary/warnings are
  ready; no further chunks may be added.
- `committing`: server is committing the reviewed chunks; only reconciliation
  and retry are allowed.
- `committed`: terminal success.
- `failed`: terminal unless no partial imported runs were written and the
  failure is marked resumable.
- `cancelled`: terminal user cancellation before successful commit.

Legal transitions:

- `created -> uploading`
- `created/uploading -> cancelled`
- `uploading -> dry_run_ready`
- `dry_run_ready -> committing`
- `dry_run_ready -> cancelled`
- `committing -> committed`
- `committing -> failed`
- `failed -> committing` only for resumable transient failures where
  reconciliation proves no partial run writes exist. If partial writes exist,
  users create a new job; v1 favors safety over ambiguous retry.

Canonical chunks use schema version `2`. Required fields are
`schema_version`, `source_type`, `source_project`, `target_project`, `job_id`,
`chunk_id`, `sequence`, `content_hash`, `runs`, `metric_points`, `attributes`,
`artifact_refs`, `warnings`, and `final`.

The server persists normalized chunks with bounded retention so a commit uses
exactly the data the user reviewed during dry-run. Chunk replay is idempotent by
`job_id + chunk_id + content_hash`; a conflicting hash for an accepted chunk is
rejected. V1 replay is idempotent at the chunk level and at the completed
external-run identity level. Metric event-level dedupe is deferred; if a commit
fails after partial writes begin, the job becomes non-resumable and the user
creates a new import job.

Accepted chunk payloads are operational storage, not free temporary upload
space. Chunk append checks storage plan capacity before persistence, each job
has a hard staged-payload byte ceiling, and usage summaries include retained
chunk payload bytes so abandoned import jobs cannot bypass storage guardrails.

V1 conflict behavior is append-only with `skip_existing`. If a run with the
same `(org_id, project_id, source_type, external_project_id, external_run_id)`
already exists, commit skips that run and reports it in the summary. There is no
destructive replace path in v1. TensorBoard sync is the one narrow append case:
when an already-imported TensorBoard run has no imported attributes/artifacts,
later sync passes append new scalar points to that run so watch-style local
sync does not need to create a new run for every pass.

Redaction runs before persistence and before user-visible warnings. It scans
configs, metadata, tags, notes, artifact URIs, warnings, errors, logs, dry-run
summaries, and frontend previews. It redacts common API keys, bearer tokens,
credentialed URLs, signed query strings, private key blocks, and internal
credential-like values. Raw external artifact references are not fetched; API
responses expose redacted display references by default.

After the versioned artifact lineage slice, committed external artifact
references are also mirrored into one metadata-only artifact bundle per imported
run. The import still writes the legacy raw `ArtifactRow` so Run Detail,
Compare, and old SDK flows remain compatible, but the Artifacts catalog can now
show imported W&B/Neptune/MLflow references as active versions with external
manifest entries and output lineage edges from the imported run. These versions have
`storage_backend="external"`, are not downloadable through InstantML, and count
only metadata overhead rather than source artifact bytes.

## Component Impact

Backend:

- Add Import v2 job/chunk routes and state validation.
- Extend stored import records with job progress, warnings, source metadata,
  chunk digests, conflict counts, and failure details.
- Keep old JSON import routes as wrappers.

Frontend:

- Add `/dashboard/imports` to the route-backed dashboard.
- Render CLI-first import workflow, dry-run summary, warnings, progress, retry,
  cancel, and framework setup snippets.

Python SDK:

- Add import/sync CLI commands and canonical chunk upload helpers.
- Add W&B-compatible subset and harden `shadow_wandb`.
- Add native Lightning/HF/Keras adapters with lazy optional dependencies.

Storage:

- Persist import job/chunk metadata as operational records.
- Store source provenance under reserved `metadata.import`.
- Store external artifact references as legacy raw rows plus metadata-only
  run-level versioned artifact bundles/manifests so the artifact catalog and
  lineage graph remain compatible with imported workloads.

Docs:

- Add import, dual logging, TensorBoard sync, W&B compat matrix, and framework
  adapter docs.

## Data Model

Import job rows include:

- `id`, `org_id`, `project_id`, `source_type`, `source_project`,
  `target_project`, `schema_version`, `state`, `dedupe_policy`.
- `summary`, `warnings`, `error_summary`, `progress`.
- `created_by_user_id`, `created_at`, `updated_at`, `completed_at`.
- `run_ids`, `chunk_ids`, `accepted_chunk_count`, `committed_batch_count`.

Chunk metadata includes:

- `chunk_id`, `sequence`, `content_hash`, `final`, `received_at`, `summary`,
  and the redacted canonical payload for commit.

Run provenance is stored under:

```json
{
  "import": {
    "job_id": "...",
    "source_type": "wandb",
    "source_project": "...",
    "external_run_id": "...",
    "complete": true
  }
}
```

During Import v2 commit, newly created imported runs are first persisted with
`metadata.import.complete=false`, metric/attribute/artifact rows are written,
and the run is then persisted again with `complete=true`. Dashboard and run API
queries hide `complete=false` rows so an interrupted commit leaves an explicit
reconciliation marker rather than an orphaned metric series or a visible
half-imported run.

## API Contracts

- `POST /api/imports/jobs`: create a job.
- `GET /api/imports/jobs/:id`: read job status, progress, warnings, and summary.
- `POST /api/imports/jobs/:id/chunks`: append one canonical chunk.
- `POST /api/imports/jobs/:id/commit`: commit a dry-run-ready job.
- `POST /api/imports/jobs/:id/cancel`: cancel before commit.
- `GET /api/imports`: list recent import jobs.

All mutating routes require tenant context, mutation-origin validation for
browser sessions, and `imports:write`. Project-scoped API keys may import only
into their project.

## Performance Considerations

- Browser upload is limited to 50 MB canonical bundles; raw W&B/Neptune/
  TensorBoard sources use CLI.
- CLI import memory budget is 512 MB by default.
- Metric insert batches target 5k-50k rows and are capped by serialized byte
  size.
- One active import commit per org by default; import rate limits are separate
  from live SDK ingestion.
- Dry-run summaries stream counts and sampled warnings instead of loading full
  histories into frontend state.
- Neptune parsing uses `pyarrow` record batches; run metadata/artifact
  references are collected first, while float-series metrics are streamed as
  bounded canonical chunks so metric history is not held in memory.
- TensorBoard watch keeps an in-process event identity set and caps points per
  sync pass; durable watch cursors can be added if teams need daemonized sync.

## Simplicity Review

The design keeps third-party parsing in the Python SDK/CLI first because that
avoids adding hostile-file parsing and third-party credential custody to the
Rust request path. It deliberately ships scalar-first migration with
artifact-reference metadata instead of full media/artifact byte parity.

Deferred complexity:

- Hosted third-party connectors.
- Artifact byte copying.
- Destructive replacement.
- Full W&B and TensorBoard media parity.

## Failure Modes

- Duplicate import: skipped by source identity and reported.
- Duplicate chunk: accepted if content hash matches; rejected otherwise.
- Commit fails mid-way: job records failure and retained batches. Retry is
  allowed only if reconciliation finds no partial run writes; otherwise the job
  remains failed and the operator creates a new import job to avoid duplicating
  or silently skipping partially written metrics.
- Stale durable `committing` jobs after a process crash: jobs with a recorded
  partial write are marked failed/non-resumable on the next commit attempt;
  jobs without partial writes can be retried. A single-process active-commit
  guard allows one org import commit at a time.
- Quota changes after dry-run: commit rechecks quota and fails with a clear
  action message if limits are exceeded.
- Credentials expire during local export: CLI reports local failure without
  sending credentials to InstantML.
- W&B offline/dryrun compatibility mode: rejected explicitly for now so users
  do not assume an offline W&B spool was migrated when InstantML would have
  otherwise dropped logs silently. This includes env-driven
  `WANDB_MODE=offline`/`dryrun`.
- W&B batched `wandb.log(..., commit=False)` semantics: rejected explicitly
  until we implement a compatible local batch accumulator.
- Import v2 dry-run readiness: the final chunk runs cross-record semantic
  validation before the job can enter `dry_run_ready`; malformed chunks can be
  corrected without committing a partial job.
- Unsupported schemas/media: skipped with stable warning codes.
- External artifact references contain secrets: redacted display URI is stored
  and raw values are not exposed by default.

## Testing Plan

- API tests for every legal and illegal state transition.
- Chunk replay and conflicting hash tests.
- Duplicate source run and metric idempotency tests.
- Project-scoped key, role, origin, and rate-limit isolation tests.
- W&B, Neptune Exporter, and TensorBoard golden fixtures.
- Malicious fixture tests for malformed JSON, malformed UTF-8, path traversal,
  symlinks, archive bombs, oversized strings/rows/files, and secret-bearing
  metadata.
- SDK tests with fake optional modules plus optional-dependency CI for W&B,
  pyarrow, tensorboard, Lightning, HF, and Keras.
- Frontend tests for route normalization, command copy, dry-run disabled commit,
  warning display, polling, failed recovery, and mobile collapse.
- Load tests for 50 runs/1M scalar points and one 1M-point run.

## Documentation Plan

- Update `apps/rust-server/README.md`.
- Update `packages/python-sdk/README.md` and `PYPI_README.md`.
- Update `apps/web/README.md`.
- Add docs pages for imports, W&B compat, TensorBoard sync, and framework
  adapters.

## Alternatives Considered

- Enlarging the existing JSON routes: rejected because real exports exceed the
  body limit and need resumability.
- Server-side Parquet/TensorBoard parsing: rejected for v1 because it expands
  attack surface and dependency complexity.
- True `import wandb` package shadowing: rejected because it is surprising and
  risky; use `instantml.compat.wandb`.
- Hosted connectors in v1: rejected for production because credential custody
  changes security and compliance posture.

## Review Notes

Backend/data:

- Finding: one-shot imports cannot support real workloads.
- Risk: partial writes and duplicate retries.
- Recommended edit: Import v2 jobs, chunks, source identities, OpenAPI updates.
- Decision: accepted.

SDK/frameworks:

- Finding: W&B compatibility and framework adapters need explicit native
  contracts.
- Risk: users expect more W&B and framework behavior than a duck-typed helper.
- Recommended edit: compatibility matrix, bounded shadow queue, native adapter
  subclasses.
- Decision: accepted.

Frontend/UX:

- Finding: dedicated imports tab is correct, but browser upload must be
  secondary and local-export states must not say connected.
- Risk: misleading security posture and poor large-import UX.
- Recommended edit: CLI-first workflow, job polling, warning/status UI.
- Decision: accepted.

Final UX/security polish:

- Finding: dashboard import commands described dry-run behavior but could copy
  commit commands or unsafe shell strings.
- Resolution: accepted; generated commands now shell-quote user values and copy
  explicit `--dry-run` commands for first-pass review.

Performance/reliability:

- Finding: chunks, batching, backpressure, and retry semantics are P0.
- Risk: duplicated metric points and imports starving live logging.
- Recommended edit: chunk idempotency, metric batch identity, rate-limit
  isolation, load tests.
- Decision: accepted.

Security/privacy:

- Finding: third-party credentials and untrusted files are the largest risks.
- Risk: token leakage, SSRF, path traversal, secret persistence.
- Recommended edit: local export by default, redaction, artifact references
  only, hostile-input tests.
- Decision: accepted.

Final readiness:

- Finding: this should be sequenced with Import v2 first and connectors out of
  production v1.
- Risk: one large PR can hide correctness gaps.
- Recommended edit: feature-flagged slices and strict PR gate.
- Decision: accepted.

Post-implementation review:

- Finding: commit retries could be unsafe after durable partial writes.
- Resolution: accepted; commit now records `partial_write_started` before the
  first durable imported write, persists new imported runs hidden until complete,
  and marks interrupted partial failures non-resumable.
- Finding: final chunks could close a job before earlier chunks arrived.
- Resolution: accepted; chunk appends must now be contiguous by sequence, with
  duplicate chunk-id replay allowed only for identical content.
- Finding: TensorBoard watch handled only the first run and `--run-id --dry-run`
  still wrote metrics.
- Resolution: accepted; watch filters all runs by source-run event identity,
  multi-run `--run-id` sync is rejected, and dry-run returns a summary without
  API writes.
- Finding: client and server redaction coverage differed for signed storage
  URLs and legacy one-shot imports.
- Resolution: accepted; both paths redact common S3, GCS, Azure, bearer, and
  exact credential-like fields before persistence while preserving normal ML
  fields such as `max_tokens`, `tokenizer`, and metric token rates.
- Finding: framework adapters should not eagerly import optional ML frameworks,
  but should behave as native subclasses when those frameworks are installed.
- Resolution: accepted; adapter classes lazily specialize at instantiation time
  and plain `import instantml` remains lightweight.
- Finding: PR #147's versioned artifact catalog required imports to mirror
  external artifact refs into lineage without breaking raw artifact flows.
- Resolution: accepted; imports now preserve legacy raw `ArtifactRow`s and create
  one redacted metadata-only versioned artifact bundle per imported run, with
  output lineage edges, retry repair for already-complete imports, project-scoped
  artifact collection listing, native collection collision avoidance, full
  multi-chunk manifest repair, and conservative metadata/ref-size plan gating.
- Residual risk: Neptune Exporter parsing still groups run metadata/artifact
  references in memory while metric history streams and job caps bound the
  production import; fully streaming run metadata remains a follow-up if design
  partners exceed the v1 caps.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation as the production v1 adoption path. Hosted
third-party connectors remain design-only follow-up work.
