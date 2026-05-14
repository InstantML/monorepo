# Design: Migration Adoption First Slice

Date: 2026-05-09

Status: Accepted for narrowed first slice after review

Owner: Codex

## Summary

P4 should make evaluation safer for teams that already use W&B, MLflow, or Neptune. The first slice keeps the product simple: preserve SDK source metadata under a reserved namespace, make partial-write behavior explicit and tested, harden the existing Neptune importer, and add a dependency-free W&B JSON import route.

This is not a full migration platform. It is a narrow bridge that lets users bring representative runs into the current UI and lets future agents test importer semantics before the Rust/ClickHouse service exists.

## Research Notes

W&B public API docs expose run data through `Run.config`, `Run.metadata`, `Run.summary_metrics`, `Run.history(samples=..., keys=...)`, `Run.scan_history(keys=..., page_size=...)`, `Run.files(...)`, `Run.logged_artifacts(...)`, and `Run.download_history_exports(...)`. The least lock-in first slice is not to depend on the W&B SDK inside this repo; instead, accept a small JSON shape that can be produced by `wandb.Api()` scripts using `scan_history` for unsampled metrics and `files` or `logged_artifacts` for artifact references. Source: [W&B Run public API](https://docs.wandb.ai/models/ref/python/public-api/run).

MLflow exposes experiments, runs, params, metrics, tags, metric history, and artifacts through its REST API. `Search Runs` returns run info and latest run data, while metric history and artifact listing have dedicated endpoints. MLflow import was deferred from this first slice and implemented in `2026-05-09-mlflow-import-and-dual-logging.md` after the canonical importer core was proven with Neptune and W&B. Source: [MLflow REST API](https://mlflow.org/docs/latest/api_reference/rest-api.html).

## Goals

- Reserve automatic SDK source metadata so user metadata cannot overwrite it.
- Document and test partial-write behavior for batch attributes, imports, and artifact uploads.
- Add W&B JSON import or dual-logging first slice; choose JSON import for lower dependency and clearer review.
- Harden Neptune importer validation so dry-run and real import use the same validation path.
- Keep importer endpoints org-scoped and covered by contract/unit/API tests.

## Non-Goals

- Direct W&B OAuth/API-key integration.
- Pulling `wandb`, `mlflow`, pandas, pyarrow, or cloud SDKs into required repo dependencies.
- Downloading third-party artifact bytes.
- Full W&B sweeps/reports/artifact lineage parity.
- Full MLflow model registry, datasets, traces, or logged model support.
- MLflow JSON import implementation in this slice.
- Historical importer UI.

## Proposed Design

### SDK Source Metadata

Keep existing top-level environment metadata (`python`, `platform`, `hostname`, `pid`) for UI compatibility. Move automatic SDK source metadata from top-level `metadata.source` to reserved `metadata._rlobs.source`.

Rules:

- `_rlobs` is reserved for SDK-owned metadata.
- If user-provided metadata contains `_rlobs`, `init()` raises `ValueError`.
- User-provided `metadata.source` remains user-owned and does not affect SDK source tracking.
- `source_tracking=False` omits `_rlobs.source`.

### Import Validation And Partial Writes

Batch attributes:

- Validate every attribute in a batch before appending any of them.
- If validation fails, no attribute from that request is written.

Imports:

- Source parser -> canonical normalized import -> full validation -> commit against a cloned state.
- Dry-run executes the same parser and full canonical validator as real import.
- A real import summary must equal the dry-run summary for the same payload.
- If validation fails, no project, run, metric, attribute, artifact, or import record is written.
- Re-import policy for this first slice is append-only. Importing the same external run ID again creates a new local run and import record, and the original external ID is preserved in source metadata. Dedup/upsert is deferred until the UI can expose conflicts safely.

Canonical normalized import:

```json
{
  "source_type": "wandb_json",
  "project": "imported",
  "runs": [
    {
      "external_run_id": "run-1",
      "name": "seed-1",
      "status": "finished",
      "config": {},
      "tags": [],
      "metadata": {"wandb": {"run_id": "run-1"}},
      "metrics": [{"key": "reward", "step": 0, "value": 1.0, "timestamp": "2026-05-09T00:00:00.000Z"}],
      "attributes": [],
      "artifacts": [{"type": "file", "name": "policy.pt", "uri": "wandb://...", "metadata": {"external_type": "model"}}]
    }
  ]
}
```

Validation rules:

- `project` and run names are non-empty strings.
- `status` maps to `running`, `finished`, or `failed`; unknown source statuses become `finished`.
- Metric keys are non-empty strings, values are finite numbers, and steps are finite nonnegative numbers.
- Missing metric steps fall back to row index; invalid negative/nonfinite steps reject the whole import.
- W&B `_timestamp` accepts ISO strings or numeric epoch seconds and converts to ISO.
- Non-scalar W&B history values and keys starting with `_` are ignored.
- Unknown external artifact types map to internal `file` and preserve the original type in artifact metadata. Obvious checkpoint/model names may map to `checkpoint`; rollout/video names may map to `rollout`.
- First-party run metadata containing `_rlobs` is rejected. External `_rlobs` or source-reserved keys are preserved under source-specific metadata such as `wandb.metadata`.

Artifact uploads:

- Prevalidate run access, artifact type, name, step, metadata, path, MIME, and content before writing bytes.
- Add/keep tests that prove invalid upload metadata does not write bytes and does not leave an artifact record.
- Document that a process crash between byte write and cleanup can still leave an orphan local file in the Node dev backend; Rust/object storage should use temp object keys plus repair.

### W&B JSON Import

Add `POST /api/imports/wandb`.

This is an explicit transformed importer schema, not a native W&B export contract.

Request shape:

```json
{
  "schema_version": 1,
  "project": "imported-wandb",
  "dry_run": false,
  "runs": [
    {
      "id": "wandb-run-id",
      "name": "seed-1",
      "state": "finished",
      "config": {"seed": 1},
      "metadata": {"host": "trainer"},
      "summary": {"best_reward": 10},
      "tags": ["baseline"],
      "history": [
        {"_step": 0, "_timestamp": 1760000000, "reward": 1.0}
      ],
      "artifacts": [
        {"name": "policy.pt", "type": "checkpoint", "uri": "wandb://entity/project/run/files/policy.pt", "size_bytes": 123}
      ]
    }
  ]
}
```

Mapping:

- `config` -> run config.
- `metadata` plus `wandb_run_id`, `wandb_state`, `wandb_summary` -> run metadata.
- `tags` -> run tags.
- Numeric history keys not starting with `_` -> scalar metrics.
- `_step` -> metric step; fallback to history row index.
- `_timestamp` -> metric timestamp when ISO string or numeric epoch seconds.
- Artifact references -> artifact metadata only; bytes are not downloaded.

### MLflow JSON Import

MLflow was documented and researched here, then implemented in the follow-up slice `2026-05-09-mlflow-import-and-dual-logging.md`. It reuses the canonical importer and explicit transformed-schema approach rather than adding a route-specific writer.

### Tooling

Add dependency-free CLI wrappers:

- `tools/import-wandb-json.mjs`

They mirror `import-neptune-json.mjs`: read a local JSON file, inject/override `project`, support `--dry-run`, `--base-url`, and optional bearer auth through `RLOBS_API_KEY`.

## API Contracts

New routes:

- `POST /api/imports/wandb`

Shared behavior:

- `?dry_run=true` overrides body `dry_run`.
- Hosted mode requires bearer org auth with `imports:write`. A default `sdk:ingest` key also receives `imports:write` in local scaffolding for now; `usage:read`-only keys must be rejected.
- SDK mutation routes require `sdk:ingest`; `usage:read`-only keys can read usage summaries but cannot create projects, runs, metrics, attributes, artifacts, uploads, or status updates.
- Import records use `source_type` values `wandb_json` and existing `neptune_exporter_json`.
- All import summaries include `{project, runs, metrics, attributes, artifacts}`.
- Current Node import request bodies use the existing 1 MB JSON limit. This first slice is for small representative exports; larger historical imports need streaming/chunking design.

## Testing Plan

- Python SDK test for reserved `_rlobs.source` metadata and user `source` preservation.
- Node unit tests that dry-run and real import validation match, invalid imports do not partially write, Neptune validation is hardened, and W&B JSON imports expected metrics/artifacts.
- Specific importer tests for W&B numeric `_timestamp`, ignored non-scalar history values, `_step` fallback, unknown artifact type fallback, reserved `_rlobs` rejection, and read-only API key denial.
- Malformed importer fixture tests for non-object/null runs, history rows, metrics, attributes, and artifact references.
- Server route tests for W&B dry-run import and hosted org scoping.
- Artifact-upload tests for prevalidation before local byte writes.
- Contract smoke coverage for W&B import and `imports:write` denial/allow.
- Existing `python3 -m pytest`, `npm run test:node`, `npm run test:contract`, `npm run web:build`, and `npm run test:ui` must pass.

## Documentation Plan

- Update `packages/python-sdk/README.md` for `_rlobs.source`.
- Update `apps/server/README.md` for new import routes and partial-write semantics.
- Update `tools/README.md` with W&B JSON import examples and MLflow follow-up notes.
- Update `docs/architecture/current-system.md`.
- Update `PRODUCT_STRATEGY.md` and `TODO.md` P4.

## Implementation Notes

- Implemented SDK metadata reservation with `_rlobs.source`; user-provided `_rlobs` is rejected by the SDK.
- Implemented atomic batch attributes and cloned-state importer commit for Neptune and W&B.
- Implemented `POST /api/imports/wandb`, `tools/import-wandb-json.mjs`, and `imports:write` route scope checks.
- Implemented `sdk:ingest` scope checks for SDK mutation routes so usage-only keys cannot mutate training data.
- Added malformed importer fixture coverage for Neptune and W&B, including null run entries, non-object metrics/history rows, null attributes/artifacts, and sparse W&B history values.
- Implemented artifact upload prevalidation before writing local bytes.
- MLflow moved to the accepted follow-up design `2026-05-09-mlflow-import-and-dual-logging.md`.

## Review Notes

Fresh reviewer 1:

- Finding: Import auth needs explicit scope; any authenticated key is too broad.
- Decision: Require `imports:write` and test denial for usage-only keys.
- Finding: All-or-nothing import semantics need a concrete cloned-state commit shape.
- Decision: Accepted. Implement source parser -> canonical normalized import -> full validation -> cloned-state commit.
- Finding: First slice may be too broad.
- Decision: Narrowed to metadata reservation, import atomicity, Neptune hardening, W&B JSON import, and docs. MLflow remains researched follow-up.

Fresh reviewer 2:

- Finding: Dry-run parity needs exact contract.
- Decision: Dry-run runs same parser/validator and real import summary must match.
- Finding: Re-import policy missing.
- Decision: First slice is append-only with external IDs preserved in source metadata; dedup/upsert is deferred.
- Finding: Import schemas need explicit transformed-schema framing.
- Decision: W&B route is documented as a transformed importer schema, not a native export contract.

Post-implementation PR review:

- Finding: API-key scopes were enforced for imports and usage but not for SDK mutation routes.
- Decision: Added `sdk:ingest` checks for project, run, metric, attribute, artifact, upload, status update, and demo-reset mutations; added hosted-mode tests and contract-smoke coverage for usage-only denial.
- Finding: Malformed importer run entries could throw TypeError and return 500.
- Decision: Normalizers now validate run/metric/artifact objects before dereferencing, and route tests assert malformed Neptune/W&B payloads return 400.
- Finding: W&B sparse history values such as `null` and empty strings could be coerced to zero.
- Decision: W&B history import skips null/blank sparse values, and shared metric validation now rejects null/blank metric values instead of accepting JavaScript numeric coercion.

## Coverage Exceptions

None planned.
