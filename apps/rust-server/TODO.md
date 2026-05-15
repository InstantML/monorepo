# Rust Server TODO

Implementation-facing backlog from the W&B docs gap review on 2026-05-10.

Rust/ClickHouse remains the primary backend. Any item that changes storage, route shape, auth behavior, or a cross-component contract needs a design doc in `docs/design/` and at least two fresh architecture reviews before implementation.

Primary W&B references reviewed:

- `https://docs.wandb.ai/models/ref/python/functions/init`
- `https://docs.wandb.ai/models/ref/python/experiments/run`
- `https://docs.wandb.ai/models/track/log`
- `https://docs.wandb.ai/models/track/log/media`
- `https://docs.wandb.ai/models/track/log/log-tables`
- `https://docs.wandb.ai/models/artifacts`
- `https://docs.wandb.ai/models/artifacts/download-and-use-an-artifact`
- `https://docs.wandb.ai/models/artifacts/create-a-custom-alias`
- `https://docs.wandb.ai/models/artifacts/explore-and-traverse-an-artifact-graph`
- `https://docs.wandb.ai/models/artifacts/track-external-files`
- `https://docs.wandb.ai/models/artifacts/ttl`
- `https://docs.wandb.ai/models/track/public-api-guide`
- `https://docs.wandb.ai/models/sweeps/initialize-sweeps`
- `https://docs.wandb.ai/models/app/features/panels/line-plot`
- `https://docs.wandb.ai/models/app/features/panels/media`
- `https://docs.wandb.ai/models/app/features/panels/run-comparer`
- `https://docs.wandb.ai/models/registry`
- `https://docs.wandb.ai/models/automations`

## Current Hosted Auth Slice

- [x] Add local Google-style signup/signin for development without committing provider credentials.
- [x] Store opaque browser sessions as hashed tokens in ClickHouse and require active memberships for session payloads.
- [x] Add `organizations.account_type`, `organizations.seat_limit`, `memberships.status`, and transactional seat reservation with owner/admin authorization.
- [x] Allow session owner/admin users to create copy-once SDK API keys through the existing hashed key path.
- [x] Add client-safe provider discovery, managed Google placeholder, logout, session lookup, and session cleanup.
- [ ] Add real managed Google token verification and hosted provider configuration.
- [ ] Add invitation email delivery and active-member acceptance for reserved seats.
- [ ] Add multi-org switching and richer hosted no-access/error states with frontend support.

## P0 - Contract And Run Lifecycle

- [ ] Design run lifecycle parity: client-provided run IDs, display names, notes, groups, job types, resume/reopen semantics, fork/resume-from metadata, shared/distributed run metadata, and run path identity.
- [ ] Add schema fields and indexes for group, job type, dedicated notes, user-provided stable run ID, resume metadata, sweep ID, code/source snapshot pointers, and system-log pointers. First-slice searchable tags and metadata notes stay in existing `runs.tags` and `runs.metadata.notes`.
- [x] Add the first searchable run identity slice for name, tags, config text, and explicit note fields.
  - Design: `docs/design/2026-05-10-run-tags-notes-editing.md`
  - Remaining: group, job type, source metadata, artifact names, and metric-summary-derived labels.
- [ ] Add API behavior for idempotent client-generated run creation and explicit resume modes without weakening org/project authorization.
- [ ] Add summary policy support for `last`, `min`, `max`, and `best` metrics, including design for custom x-axis or step metric behavior.
- [ ] Add bounded history pagination routes that can return sampled and unsampled scalar metric data without scanning all metric history.
- [ ] Expand OpenAPI output from placeholder route stubs to useful request/response schemas for SDK and frontend consumers.

## P1 - Public Query API

- [ ] Design a Python `Api`-style server surface for post-hoc queries: list/filter runs, fetch one run, read history, fetch summaries/config/metadata, list files, list artifacts, and export data.
- [ ] Add authenticated pagination, sorting, and filter grammar for runs and histories with explicit query-plan tests.
  - First run-list slice complete: `/api/runs/summary` and `/runs` support cursor pagination, direct auth/project/status/search filters, and server-side sorting by newest/name/status/duration/selected metric latest/best.
  - Remaining: broader filter grammar, history pagination, explicit query-plan assertions, and versioned public API route naming.
- [x] Add 90,000-run project support for run list/search: keyset pagination, server-side sort, indexed status/tag/note/name/config filters, and selected metric-summary sorts.
  - Design: `docs/design/2026-05-11-large-run-query-performance.md`
  - Evidence: local benchmark p95 project summary 78 ms, search 118 ms, metric-best sort 66 ms, chart series 22 ms.
  - Follow-up: split metric-key catalog discovery or add `include_metric_keys=false` before claiming scale for projects with very high metric-key cardinality.
- [ ] Add compare data routes that support row-oriented and column-oriented clients, including row sorting, column sorting, diff-only filtering, artifact-presence sorting, and bounded payloads.
- [ ] Add post-hoc mutation routes for safe metadata, config, summary, and file updates after a run finishes.
- [ ] Add export endpoints for per-run and project-wide CSV/JSON history with hard limits or streaming.
- [ ] Keep compatibility route shapes stable while adding the richer public API under a clearly versioned namespace.

## P2 - Artifacts, Versions, And Lineage

- [ ] Design artifact collections, versions, aliases, tags, file manifests, digests, and input/output lineage edges before changing schema.
- [ ] Support `latest`, monotonic `vN`, and custom aliases for artifact versions.
- [ ] Support `use_artifact` semantics with run-to-artifact input edges and run-to-artifact output edges.
- [ ] Add artifact download by collection/version/alias plus partial file downloads by manifest path.
- [ ] Add media artifact streaming support for safe MP3/MP4 playback, including MIME validation, HTTP range requests, auth checks, and download-only fallback for unsupported or external-reference files.
- [ ] Add external reference artifacts for S3/GCS/Azure/HTTP/NFS-style URIs where bytes stay outside InstantML.
- [ ] Add object-storage backend support and direct or multipart upload planning for large files.
- [ ] Add artifact retention and TTL fields with safe worker behavior and audit events.
- [ ] Defer registry/model lifecycle until artifact versions and lineage are stable.

## P3 - Rich Logged Objects

- [x] Design the first rich-object slice for tables, images, video, audio, and histograms.
  - Design: `docs/design/2026-05-11-rich-logged-objects.md`
  - Implemented slice: attributes remain the object catalog, artifacts remain the media byte store, and `table_object_rows` stores paginated table previews.
  - Security/perf guardrails: generic `/attributes` writes reject `table`/`image`/`video`/`audio`, table-row reads authorize before revealing object kind, and `attributes_rich_object_list_idx` covers active-run object list order.
- [x] Store first-slice table schemas and rows separately enough to query and page selected-run tables without loading whole files.
  - Evidence: local 2026-05-11 rich-object benchmark measured table rows p95 1.9 ms for 1,000 bounded rows.
- [ ] Add media metadata routes and storage conventions for thumbnails/previews where useful.
- [ ] Preserve scalar metric ingestion performance: rich object ingestion must not share the hot scalar write path.
- [x] Add first-slice server validation for histogram bins/counts, table column/row shape, metadata/summary size limits, and same-run artifact attachment.
- [x] Add UI-facing selected-run read routes for object manifests and table rows.
  - Remaining: batch/catalog routes for workspace or Compare after a no-fan-out design.
- [ ] Add server validation for image boxes/masks, richer media metadata, HTML/plot objects, and optional 3D/point-cloud payloads.

## P4 - Sweeps And Workflow APIs

- [ ] Design a minimal sweeps schema: sweep config, agent heartbeat, run assignment, run result, best-run query, and cancellation.
- [ ] Implement random and grid sweeps first; defer Bayesian optimization until usage proves the need.
- [ ] Add narrow automation support only after design: metric threshold events and signed webhook delivery.
- [ ] Add saved workspace/panel APIs only when frontend persistence needs them.

## P5 - Reliability And Coverage

- [ ] Add integration tests for every new route with real ClickHouse and org/project auth checks.
- [ ] Add query-plan checks for history, public API filters, 90,000-run search/sort, tag/note search, compare row/column sorting, artifact alias lookup, table pagination, and sweep assignment.
  - First 90,000-run benchmark exists, but it is latency-based rather than `EXPLAIN`-plan asserted.
- [ ] Add load tests for scalar ingestion, 90,000-run project browsing, table writes, artifact manifest reads, MP3/MP4 media streaming, and public history export.
  - First 90,000-run browsing benchmark exists in `tools/rust-large-run-benchmark.mjs`.
  - First rich-object read benchmark exists in `tools/rust-rich-objects-benchmark.mjs`; 2026-05-11 local evidence: object list p95 47.5 ms for 500 objects, table-only object list p95 8.3 ms, table row p95 1.9 ms for 1,000 rows. Remaining load tests should cover ingestion, media/artifact streaming, histories, table writes, and compare.
- [ ] Keep first-party Rust service logic at 100% meaningful coverage or document precise coverage exceptions in this README/TODO.
- [ ] Keep Node compatibility smokes for old route shapes until migration from Node JSON is complete.
