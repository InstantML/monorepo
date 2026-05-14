# Design: Rich Logged Objects First Slice

Date: 2026-05-11

Status: Accepted first slice after architecture review amendments

Owner: Codex

## Summary

Training Observability needs first-class rich logged objects so users can inspect tables, histograms, images, videos, and audio samples without turning every non-scalar value into generic artifact metadata. The first slice keeps the implementation intentionally small: it reuses existing `attributes` as the object catalog, reuses existing `artifacts` for media bytes, and adds only a narrow `table_object_rows` table for paginated table previews.

This replaces the initial draft proposal for a separate `logged_objects` manifest. Two fresh reviewers rejected that as too much schema for the first slice because it duplicated `attributes` and `artifacts`, made export/import/usage broader than necessary, and introduced avoidable Compare fan-out. The accepted slice keeps scalar metric ingestion untouched and adds bounded object read/write routes around existing storage.

## Goals

- Add a UI/API concept of rich logged objects for `table`, `image`, `video`, `audio`, and `histogram`.
- Keep `POST /runs/:id/metrics`, `metric_points`, and `metric_series` unchanged.
- Store media bytes through existing artifact upload/download routes and link object attributes to same-run artifacts.
- Store table preview rows in a dedicated paginated table keyed to an attribute id.
- Add object list and row-read APIs with strict limits and validation.
- Add Python SDK wrappers and helper methods without breaking existing `log_histogram`, `log_video`, and `log_table` signatures.
- Show bounded object previews in Run Detail and Artifacts.
- Keep Compare on existing artifact context in this slice; do not add new object fan-out.
- Seed demo data with representative table and histogram objects.

## Non-Goals

- Do not add a separate object registry table in this slice.
- Do not add workspace media/table panels yet.
- Do not add rich-object routes to the deprecated Node server.
- Do not add artifact versions, aliases, manifests, lineage, signed URLs, or HTTP range streaming.
- Do not support process-spooled rich media object linking in this slice; uploader response chaining needs a separate design.
- Do not fetch table rows or histogram bodies for every compared run.

## Users And Use Cases

- LLM fine-tuning engineers inspect prompt/completion/eval sample tables.
- RL engineers inspect rollout media and histogram summaries for returns or action distributions.
- Speech/audio users attach MP3 samples to runs and verify playback/fallback behavior.
- Researchers open a selected run and quickly see what rich evidence was logged.

## Proposed Design

### Rust/ClickHouse Storage

Extend the existing `attributes.type` check to include:

- `table`
- `image`
- `video`
- `audio`

Continue to use `histogram_series` for histograms.

Add table preview rows as ClickHouse operational records keyed by `attribute_id`. Each row includes `row_index`, a JSON object payload, and `created_at`. The Rust service validates same-org/same-run ownership before writing or reading table rows.

Index query shapes:

- `attributes_rich_object_list_idx` covers selected-run rich-object list order by `(org_id, run_id, coalesce(step, -1) desc, created_at desc, id desc)` without scanning scalar attributes.
- Existing `attributes_org_run_type_path_step_idx` continues to cover direct typed attribute/path-prefix reads.
- Existing `attributes_artifact_id_idx` covers linked artifact lookups.
- The Rust store keeps table rows grouped by attribute id for bounded paginated reads.

### Rust API

Add these routes:

- `POST /api/runs/:run_id/objects`
- `GET /api/runs/:run_id/objects?kind=&key=&limit=&offset=`
- `GET /api/objects/:object_id/rows?limit=&offset=`

Create body:

```json
{
  "key": "eval/samples",
  "kind": "table",
  "step": 200,
  "artifact_id": "optional-existing-artifact-uuid",
  "metadata": {},
  "summary": { "columns": ["prompt", "completion", "score"] },
  "rows": [{ "prompt": "...", "completion": "...", "score": 0.9 }]
}
```

Storage mapping:

- `table`: insert an `attributes` row with `type='table'`, `path=key`, `value={"kind":"table"}`, summary metadata, then insert table rows in the same transaction.
- `image`, `video`, `audio`: require a same-run `artifact_id`, insert an object attribute with `type=kind`, `value` set to the artifact URI, and summary metadata that includes safe artifact fields.
- `histogram`: insert an `attributes` row with `type='histogram_series'` and `value={"bins":[...],"counts":[...]}`.

Response shape:

```json
{
  "object": {
    "id": 123,
    "run_id": "...",
    "key": "eval/samples",
    "kind": "table",
    "step": 200,
    "artifact_id": null,
    "metadata": {},
    "summary": { "columns": ["prompt", "completion", "score"], "row_count": 24 },
    "artifact": null,
    "created_at": "..."
  }
}
```

List responses include `{ "objects": [...], "limit": 100, "offset": 0 }`. Table row responses include `{ "object_id": 123, "rows": [...], "limit": 100, "offset": 0 }`.

### Validation And Auth

- Create requires `sdk:ingest`.
- Object list and table row reads require run access only; no write scope.
- Media bytes still require `artifacts:write` through the existing upload route.
- `key` is a non-empty bounded string.
- `kind` must be `table`, `image`, `video`, `audio`, or `histogram`.
- `step` must be finite and nonnegative when present.
- `metadata` and `summary` must be JSON objects.
- `artifact_id`, when present, must belong to the same org and same run. Tests must cover cross-run and project-scoped denials.
- `table`, `image`, `video`, and `audio` attributes are created only through the object API. Generic `/attributes` writes reject those types so callers cannot bypass rich-object caps and same-run artifact validation.
- Tables accept rows only for `kind='table'`.
- Table create accepts at most 1,000 rows, each row must be a JSON object, each row payload is capped, and the derived/declared column count is capped.
- Histograms require finite numeric `bins` and finite nonnegative numeric `counts`; counts and bins must have matching lengths.
- Summary and metadata payloads are byte-capped so a single object cannot produce huge list responses.
- Object and table rows are inserted in one transaction; any invalid row rolls back the attribute.

### Python SDK

Add wrappers:

- `Table(columns, rows, metadata=None)`
- `Histogram(bins, counts, metadata=None)`
- `Image(path, caption=None, metadata=None)`
- `Video(path, caption=None, metadata=None)`
- `Audio(path, caption=None, metadata=None)`

Add explicit object helpers:

- `run.log_objects({key: object}, step=None, metadata=None)`
- `run.log_table_object(key, columns, rows, step=None, metadata=None)`
- `run.log_image(key, path, step=None, caption=None, metadata=None)`
- `run.log_audio(key, path, step=None, caption=None, metadata=None)`

Compatibility:

- Preserve existing `run.log_histogram(path, histogram, step, timestamp=None)` behavior and validation, but also accept `Histogram` wrappers.
- Preserve existing `run.log_video(name, uri, step, size_bytes=None, metadata=None)` behavior for URI/artifact metadata logging. Path-upload rich video uses `run.log_objects({"key": Video(path)})` or a future `log_video_object` helper if needed.
- Preserve existing `run.log_table(name, uri, step=None, size_bytes=None, metadata=None)` behavior for table artifacts. Inline table rows use `log_table_object`.
- `run.log_metrics()` remains scalar-only and never inspects rich wrapper instances.
- Process spool continues to support artifact upload events and inline table/histogram object events. Rich media object upload+link is sync-only until uploader response chaining is designed.

### Frontend

Add `LoggedObject` types and load active-run objects only while `detail` or `artifacts` is active. Treat a 404 from `/objects` as unsupported so the deprecated Node backend keeps rendering existing artifact UI.

Render:

- Run Detail: add a Rich Objects section with table, histogram, and media cards.
- Artifacts tab: add object cards above raw artifact rows for the selected run.
- Compare: no new object fetches in this slice. Existing artifact/media context remains the Compare evidence surface.

Preview rules:

- Tables render at most 20 rows and 8 columns from the selected object.
- Histograms render at most 64 bins from object value/summary data.
- Media uses the existing safe same-origin artifact download helper when stored bytes are available.
- `demo://`, external, and missing-byte artifacts fall back to metadata text and copy/download actions.

## Performance Considerations

- Object list endpoint defaults to `limit=100`, max `limit=500`, and reads only one run at a time.
- Table rows endpoint defaults to `limit=100`, max `limit=1,000`, ordered by `(org_id, attribute_id, row_index)`.
- Run Detail/Artifacts load one active-run object manifest; initial dashboard load makes zero object calls.
- Compare adds no object calls in this slice.
- Media bytes are not fetched during page load. Browser media controls use `preload="metadata"` only for same-origin downloadable artifacts.

## Security Considerations

- All object routes enforce run access through the same org/project checks as existing run routes.
- Same-run artifact attachment is validated before insert.
- Table row reads authorize the owning run before revealing whether an object id is a table, so project-scoped keys cannot probe same-org objects outside their project.
- Object list responses do not expose local storage paths.
- Frontend continues to redact raw artifact URIs through `safeArtifactUri`.

## Failure Modes

- Object list route fails or Node returns 404: detail/artifacts continue with scalar metrics and raw artifacts.
- Linked artifact is missing or metadata-only: media preview falls back to text.
- Table is larger than the preview: UI shows bounded rows and row count.
- Spool-mode media object helper is requested: SDK raises a clear error rather than writing an invalid placeholder id.

## Testing Plan

- Rust integration tests for create/list, table row pagination, invalid-row rollback, histogram validation, metadata/summary validation, same-run artifact enforcement, project-scoped authorization, limit/offset validation, 404 missing objects, and no rows for non-table kinds.
- SDK tests preserving existing helper signatures, validating wrappers, proving `log_metrics()` remains scalar-only, covering inline table/histogram object events, and covering clear spool-mode media rejection.
- Frontend smoke tests proving initial dashboard load makes zero `/objects` calls, Run Detail/Artifacts load only active-run objects, table previews are bounded, image previews/fallback media render, Node 404 is handled as unsupported, and Compare does not add object requests.
- Benchmarks for object list p95 under 100 ms for one run with 500 objects, table rows p95 under 100 ms for 1,000 bounded rows, and scalar log microbench remaining within 5% of baseline.

## Documentation Plan

- Update root README and TODO.
- Update `apps/rust-server/README.md` and TODO.
- Update `packages/python-sdk/README.md` and TODO.
- Update `apps/web/README.md` and TODO.
- Update `tools/README.md` with rich-object benchmark usage and recorded local results.

## Review Notes

- Rust/ClickHouse review blocked the separate `logged_objects` manifest as too much schema for the first slice, recommended reusing `attributes`/`artifacts`, and required same-run artifact validation plus tighter payload caps. The accepted design follows that path.
- Full-stack review blocked Compare fan-out, invalid `artifact_id: "spooled"`, helper signature breakage, vague auth scopes, and loose payload bounds. The accepted design removes Compare object fetches, preserves helper compatibility, rejects async rich-media spool links, states scopes explicitly, and adds validation/benchmark gates.

## Implementation Notes

- Implemented in Rust with ClickHouse-backed operational records, `POST/GET /api/runs/:run_id/objects`, and `GET /api/objects/:object_id/rows`.
- Implemented in the SDK with `Table`, `Histogram`, `Image`, `Video`, `Audio`, `log_objects`, `log_table_object`, `log_image`, `log_audio`, and `log_video_object` while preserving existing URI/artifact helper signatures.
- Implemented in the web app with active-run-only object loading in Run Detail and Artifacts. Initial Runs entry and Compare do not add object requests.
- Post-implementation review fixes: generic attribute writes reject rich media/table types, table-row reads authorize before revealing object kind, and object listing maps query kinds to concrete storage types.
- Local benchmark evidence on 2026-05-11: `RLOBS_OBJECT_BENCH_SAMPLES=10 RLOBS_OBJECT_BENCH_WARMUPS=2 npm run benchmark:rich-objects` with 500 objects and 1,000 table rows measured object list p95 47.5 ms, table-only object list p95 8.3 ms, and table rows p95 1.9 ms.
