# Design: Neptune-Compatible Feature Roadmap Implementation

Date: 2026-05-06

Status: Implemented first local-first slice

Owner: Codex

## Summary

This design implemented the first broad pass of the Neptune comparison roadmap without trying to clone Neptune enterprise features. It remains useful as the typed-attribute/import/comparison design record.

Current strategy note: `PRODUCT_STRATEGY.md` now positions the product as InstantML, a general training-loop observability product and W&B-style competitor. Neptune compatibility remains an adoption and migration path, not the primary product identity.

The implementation keeps the existing SDK and UI working, then adds typed attributes, a safer SDK hot path, artifact upload/download, a small Neptune Exporter-style importer, and comparison UI controls.

## Goals

- Preserve existing project/run/metric/artifact APIs.
- Add a typed attribute store that can represent configs, float series, string series, file/file series, histograms, and tags.
- Map existing metrics and artifacts into typed attributes so old data remains useful.
- Add SDK helpers for configs, metrics, text, histograms, file series, tags, flushing, and offline replay.
- Add local artifact storage with SHA256, size, MIME type, upload, and download endpoints.
- Add importer endpoints and a CLI that accept a JSON fixture shaped like Neptune Exporter output for now.
- Add comparison UI improvements: sorting, local saved views, side-by-side diffs, smoothing, x-axis mode, and grouped seed averages.
- Add Docker Compose for a one-command local stack.

## Non-Goals

- ClickHouse implementation in this slice. The later Rust/ClickHouse design in `2026-05-14-clickhouse-only-storage.md` is now the accepted durable storage path; this implemented slice intentionally kept the running server on JSON storage.
- S3-compatible storage implementation. The server will expose local filesystem storage first.
- Full Parquet parsing. The first importer accepts JSON fixtures that mirror Neptune Exporter concepts; real Parquet support comes after dependency and schema review.
- Auth, RBAC, hosted SaaS, Kubernetes, and model registry.

## Data Model

The JSON state gains:

- `attributes`: typed attribute events and values.
- `nextAttributeId`: monotonic id.
- `imports`: import job summaries.
- `nextImportId`: monotonic id.
- `storage_dir`: derived from the database path unless passed by server options.

Attribute shape:

- `id`: integer.
- `run_id`: run id.
- `path`: Neptune-style namespace path.
- `type`: one of `config`, `float_series`, `string_series`, `file`, `file_series`, `histogram_series`, `tag`.
- `step`: number or null.
- `timestamp`: ISO string.
- `value`: JSON value.
- `summary`: small JSON object for table/UI use.
- `artifact_id`: optional artifact id.
- `created_at`: ISO string.

Existing APIs remain canonical for old clients:

- `POST /runs/{run_id}/metrics` also creates `float_series` attributes.
- `POST /api/runs/{run_id}/artifacts` also creates file/file-series attributes.

New APIs:

- `POST /api/runs/{run_id}/attributes`
- `GET /api/runs/{run_id}/attributes`
- `GET /api/runs/side-by-side`
- `POST /api/runs/{run_id}/artifacts/upload`
- `GET /api/artifacts/{artifact_id}/download`
- `POST /api/imports/neptune`
- `GET /api/imports`

## SDK Hot Path

The SDK keeps synchronous defaults for compatibility, but each `Run` includes:

- An in-memory queue with configurable `buffer_size`.
- `flush()` to submit queued events.
- `finish()` calls `flush()` before status update.
- `offline_dir` to spool failed events as JSONL.
- `replay_offline()` to submit spooled events later.

Typed helpers:

- `log_config(data)`
- `log_metrics(data, step, timestamp=None, preview=False, preview_completion=0)`
- `log_text(data, step=None, timestamp=None)`
- `log_histogram(path, bins/counts or dict, step)`
- `log_file`, `log_files`
- `add_tags(tags, group_tags=False)`

Compatibility aliases:

- `log()` maps to `log_metrics()`.
- Existing artifact helpers keep their names and call typed artifact APIs.

## UI Behavior

The single-page UI adds pragmatic comparison features:

- Sort selector for newest, name, selected metric latest, selected metric best, status, duration.
- Group selector for none, seed, tag, config key.
- Smoothing control and grouped-average toggle for charts.
- X-axis mode for step or logged time.
- Saved local views in `localStorage`, including filters, metric, sort, group, smoothing, and selected run ids.
- Side-by-side panel for selected runs with diff-only mode. The first selected run is treated as the reference in this slice.

## Importer

The first importer accepts JSON:

```json
{
  "project": "imported-project",
  "runs": [
    {
      "name": "run-name",
      "config": {},
      "tags": [],
      "attributes": [],
      "metrics": [],
      "artifacts": []
    }
  ]
}
```

It creates runs, typed attributes, metrics, and artifact metadata. `dry_run=true` validates and returns counts without mutating state.

## Testing

- Python SDK unit tests for buffering, typed helpers, offline spool/replay, source tracking, and old aliases.
- Node store/API tests for typed attributes, summaries, side-by-side diffs, artifact upload/download, and importer dry-run/import.
- UI smoke test for sort/group/smoothing/saved view/side-by-side.
- Existing examples must still pass.
- Keep 100% Python coverage for configured first-party code.

## Implementation Notes

- ClickHouse and S3-compatible storage remain future work; this slice uses JSON state plus local filesystem artifact storage to keep the implementation reviewable.
- The importer accepts a JSON shape that preserves Neptune concepts but does not parse Parquet yet.
- Docker Compose runs the Node API and static frontend with a persistent Docker volume.
- Future agents should update this doc or supersede it before replacing the JSON store, adding auth, or implementing full Neptune Exporter Parquet import.

## Outstanding Simplification Review

No-context code review after implementation found these issues to address before broadening the roadmap:

- Server batch/import/upload flows should either validate fully before mutation or use rollback semantics. Failed requests should not leave surprising partial attributes, imported runs, or orphan artifact files.
- Neptune dry-run should validate the payload shape deeply enough that a successful dry-run predicts a successful import.
- `runsSummary()` currently keeps code simple by scanning JSON state; durable storage work should introduce an explicit aggregate/index strategy rather than expanding hidden full-history scans.
- Metric `step` should be canonized as a nonnegative number or nonnegative integer across Node, Python bootstrap API, SDK, docs, and importers.
- Frontend chart, artifact, and side-by-side loaders should be separated and cancellation-aware.
- The UI needs pagination before projects exceed the first 100 matching runs.
- SDK source metadata should be reserved or merged so user metadata cannot overwrite reproducibility context.
- SDK offline docs should stay explicit: current offline replay covers post-run-create events, not server-down run creation.

## Decision

Accepted and implemented as the first local-first migration/comparison slice. Remaining production storage/auth/importer gaps are documented in component READMEs.
