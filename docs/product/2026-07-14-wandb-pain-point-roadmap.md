# W&B Pain-Point Roadmap

Date: 2026-07-14

Status: Proposed incremental roadmap based on the July 2026 W&B complaint
research and an audit of InstantML `main` at `20a51459`.

## Purpose

Turn the recurring W&B complaints into small InstantML pull requests without
rebuilding features that already exist. The ordering favors the core product
promise:

> Logging must not jeopardize training, offline/HPC runs must be recoverable,
> and experiment history must stay comprehensible as projects grow.

This is a product roadmap, not an accepted implementation design. Any PR that
changes an API, schema, SDK public interface, storage behavior, performance-
sensitive path, or cross-component contract still needs an accepted design doc
and two fresh reviews before implementation, as required by `AGENTS.md`.

## What Is Already Covered

Do not create new roadmap work for these complaints unless validation finds a
specific regression:

- Training-loop isolation: async run creation, default SQLite WAL logging,
  batched metric ingest, retry/backoff, bounded `finish()`, queue recovery, a
  process-isolated spool option, and fork-safe SQLite handling exist.
- Distributed visibility: rank-aware metric ingestion and bounded Distributed
  dashboards exist. The remaining gap is safe shared-run lifecycle behavior
  across ranks, not rank visualization.
- Dashboard scale: server-side run pagination/search/sort, bounded metric
  series, M4 downsampling, canvas rendering, 2,000-run selection, persisted
  workspace views, and 50k-run/522M-point hosted benchmarks exist.
- Experiment writeups: persisted block reports, share links, templates,
  Markdown export, tags, notes, Compare, and saved workspace views exist. The
  remaining gap is lightweight experiment intent/conclusion attached to the
  daily run workflow.
- Pricing foundations: Free/Pro/Premium plans, explicit limits, no tracked-hour
  billing, Stripe checkout/plan changes, seat and usage views, storage and API
  request overages, and BYOC ClickHouse exist.
- Artifact foundations: raw and versioned artifacts, manifests, aliases,
  lineage, partial downloads, R2 multipart upload sessions, retention state,
  soft delete, and exact byte accounting exist. The remaining gaps are client
  cache management, crash-resumable upload recovery, and physical garbage
  collection/reconciliation.
- Portability and data control: bounded CSV/JSON export, W&B/Neptune/MLflow
  import, TensorBoard sync, privacy-safe source capture, and Premium BYOC exist.
- UX baseline: route-backed tabs, keyboard workflows, responsive 390/768/1440
  layouts, useful loading/error/empty states, public docs, and recent chart/UI
  performance hardening exist.

The root and component TODO files contain stale unchecked items for several of
the shipped capabilities above. Current code, maintained READMEs, current
architecture docs, and implemented design status are the audit sources of
truth for this roadmap.

## Pull-Request Rules

- `XS`, `S`, and `M` are relative review/scope sizes, not calendar estimates.
- A listed implementation PR that needs a new design should be executed as two
  merge steps: a design-only PR with two fresh reviews, then the implementation
  PR after acceptance.
- Keep every implementation PR independently deployable or safely dark.
- Put backend contract/schema work before SDK and UI consumers.
- Add OpenAPI annotations and regenerate Rust OpenAPI and frontend types for
  every Rust route change.
- Preserve Node route compatibility only where an existing SDK contract still
  depends on it; new product surfaces belong in Rust.
- Include failure-mode tests, bounded-query tests, and docs in the PR that
  changes behavior.
- Use feature flags for hosted rollouts that could affect ingestion or data
  deletion.
- Do not claim zero data loss when the selected durability mode permits a short
  in-memory window. Surface the exact state instead.

## P0: Make Reliability And Offline Use Trustworthy

These PRs address the most severe complaint: experiment tracking must not hang,
slow, or silently lie about the training run.

### PR-00: Reconcile The Existing Backlog With Current Main

Type: docs-only, XS

- Mark shipped artifact versions/lineage, reports, workspace persistence,
  imports, query APIs, system metrics, and Compose work accurately in root and
  component TODOs.
- Link every remaining item to this roadmap or a current design doc.
- Remove contradictory statements such as "reports are local only" where the
  maintained README documents persisted reports.

Done when: a contributor cannot select a shipped feature from a stale unchecked
TODO item.

### PR-01: Design Offline Lifecycle And Upload Completeness

Type: design-only, S

- Define client-generated run IDs, create/resume/reopen modes, producer/session
  identity, per-stream sequence semantics, and final upload manifests.
- Define honest server/UI states: `uploading`, `complete`, `incomplete`, and
  `unknown`; a run status of `finished` must not imply data completeness.
- Define online, offline, disabled, sync, async, and spool mode precedence,
  including environment variables.
- Specify idempotent replay, backward compatibility, distributed producers,
  dropped-event accounting, and bounded training-loop latency.

Done when: two fresh reviews accept the smallest contract that supports PR-02
through PR-08 without introducing a second event system.

### PR-02: Add Idempotent Client Run IDs And Resume Semantics

Depends on: PR-01. Type: Rust/OpenAPI, M

- Accept a client-generated run ID and explicit create/resume mode.
- Make repeated creation idempotent within the authorized org/project.
- Reject incompatible resume attempts clearly without mutating the existing
  run.
- Add auth, collision, restart/replay, and Node-compatibility boundary tests.

Done when: an offline client can reserve identity locally and safely create or
resume the same Rust-backed run later.

### PR-03: Add True Offline And Disabled SDK Modes

Depends on: PR-02. Type: Python SDK, M

- Create a local run directory and manifest without contacting a server.
- Persist run creation, config, tags/notes, metrics, logs, rich-object metadata,
  and finish state with stable idempotency keys.
- Add a strict no-network/no-disk disabled mode for tests.
- Document exactly which artifact bytes and generated media are supported in
  the first offline slice.

Done when: a process with DNS/network disabled can run end to end and leave a
valid, inspectable run directory without blocking the training loop.

### PR-04: Add Resumable `instantml sync`

Depends on: PR-03. Type: CLI + Rust integration, M

- Add inspect, dry-run, sync, retry, and status commands for a local run
  directory.
- Resume after interruption without duplicating a run or event.
- Report accepted, pending, failed, and unsupported items with actionable exit
  codes.
- Keep source-system credentials and private local paths off the server.

Done when: repeatedly syncing an interrupted offline run converges to one
complete hosted/local run.

### PR-05: Persist Final Upload Completeness

Depends on: PR-01, PR-02. Type: Rust + SDK, M

- Persist producer/session progress and the final upload manifest.
- Record attempted, durably queued, acknowledged, failed, and dropped counts by
  event class without storing per-call control records forever.
- Keep metric ingestion hot-path overhead within the accepted benchmark budget.

Done when: the server can distinguish a fully drained run from a finished run
with stranded or dropped data.

### PR-06: Add Honest Run Data-State And Recovery UI

Depends on: PR-05. Type: web, S

- Replace ambiguous upload-health jargon with `Uploading`, `Complete`, or
  `Incomplete` and the known pending/failed counts.
- Add a Run Detail explanation and copyable recovery command.
- Do not show an incomplete run as cleanly finished, and do not infer loss when
  completeness is unknown for an older SDK.

Done when: a finish-timeout fixture is visibly incomplete and gives the user a
tested recovery path.

### PR-07: Add Queue Auto-Recovery And A Redacted Doctor Bundle

Depends on: PR-03. Type: Python CLI, S

- Discover orphan async queues, process spools, and offline run directories
  under configured InstantML data roots.
- Add `instantml doctor` and `instantml recover --all` with dry-run support.
- Include SDK version, queue counts/bytes, permissions, last safe error code,
  API reachability, and request IDs; exclude tokens, metric values, paths not
  explicitly approved, and artifact contents.

Done when: a user does not need to know the exact queue directory to diagnose
or resume stranded uploads.

### PR-08: Add The Process, Crash, And Network Regression Matrix

Depends on: PR-05. Type: tests/benchmarks, M

- Cover Python fork/spawn, PyTorch DataLoader workers, DDP-style ranks,
  SIGTERM, abrupt producer death, uploader death, locked/full disks, slow DNS,
  timeouts, 429/5xx retry, and permanent 4xx errors.
- Assert no deadlock, bounded foreground latency, idempotent recovery, and
  honest completeness state.
- Run the dependency-light core in CI and the real PyTorch matrix in a scheduled
  or release gate.

Done when: the failure classes behind the most serious W&B regressions have
repeatable InstantML regression tests.

## P0: Make HPC And Distributed Workflows First-Class

### PR-09: Add Node-Local Scratch And Slurm Defaults

Depends on: PR-03, PR-04. Type: SDK/CLI/docs, S

- Add documented `INSTANTML_DATA_DIR`, queue, cache, and artifact directory
  precedence.
- Detect an explicitly enabled `SLURM_TMPDIR`/node-local scratch mode and avoid
  putting SQLite WAL or per-event spool files on Lustre/NFS by default.
- Emit a portable sync manifest and a login-node sync command/job example.

Done when: the Slurm example trains on an egress-blocked compute node, uses
node-local writes, and syncs from an allowed node without manual file surgery.

### PR-10: Add Safe Shared-Run Distributed Producers

Depends on: PR-02, PR-05. Type: SDK + Rust, M

- Give every producer a rank/process identity and independent sequence space.
- Let ranks attach to one stable run ID without racing run creation or sharing
  one unsafe SQLite connection/queue.
- Preserve rank-0-only as the simplest documented option.
- Report missing producer finalization as incomplete rather than silently
  complete.

Done when: fork and spawn examples with multiple ranks produce one run, no
duplicate conflicts, and deterministic completeness reporting.

### PR-11: Add A One-Command Local Review Path

Depends on: PR-04. Type: CLI/docs, S

- Reuse the existing Docker Compose Rust/ClickHouse/web stack; do not build a
  second local dashboard.
- Add a small `instantml local` helper or equivalent documented command that
  starts/checks the stack and syncs selected offline runs into it.
- Keep the underlying Compose commands visible for debugging.

Done when: an air-gapped run can be reviewed in the normal InstantML UI with a
short, reproducible local workflow.

## P1: Prevent Experiment And Dashboard Sprawl

### PR-12: Design Run Archival And Experiment Context

Type: design-only, S

- Define reversible run archive/restore before hard deletion.
- Define the smallest experiment-memory fields: group/study, job type,
  hypothesis, change summary, conclusion, and review/decision state.
- Specify search, sorting, export, import, auth, and retention behavior.
- Reuse reports for long narratives; do not turn every run into a document.

Done when: two fresh reviews accept a narrow schema and reject duplicate report
or registry concepts.

### PR-13: Add Run Archive/Restore And Filters

Depends on: PR-12. Type: Rust/OpenAPI, M

- Add owner/admin/member authorization, archived timestamps/actors, restore,
  and default exclusion from normal lists.
- Preserve exports, lineage, artifacts, and audit history while archived.
- Add indexed filters and retained-usage semantics.

Done when: archiving removes junk from daily views without deleting evidence or
breaking bounded run queries.

### PR-14: Add Bulk Archive/Restore To Existing Selection Workflows

Depends on: PR-13. Type: web, S

- Reuse current page/all-matching selection semantics with a dry-run count and
  explicit cap.
- Add confirmation, partial-failure reporting, undo/restore, and read-only-role
  states.
- Add quick filters for failed, zero-user-metric, stale, and unreviewed runs.

Done when: a user can clean hundreds of low-value runs without clicking each
row or accidentally deleting data.

### PR-15: Add Experiment Context To Rust And The SDK

Depends on: PR-12. Type: Rust/OpenAPI + Python SDK, M

- Add typed fields and safe post-hoc updates for group/job type, hypothesis,
  change summary, conclusion, and decision state.
- Include them in search/export/import and client environment precedence where
  appropriate.
- Keep field sizes bounded and source metadata separate from user-authored
  conclusions.

Done when: a training script can state what changed and a reviewer can record
what was learned without opening Notion or a spreadsheet.

### PR-16: Surface Experiment Memory In Runs, Detail, And Compare

Depends on: PR-15. Type: web, M

- Add compact table columns/filters, detail editing, Compare diff rows, and a
  `Needs review` queue.
- Group runs by study/group and summarize status, best objective, and reviewed
  conclusion without fetching every metric history.
- Link to a full report when the conclusion needs a longer narrative.

Done when: a project with hundreds of runs makes intent, change, and conclusion
discoverable from the primary workflow.

### PR-17: Split High-Cardinality Metric Catalog Discovery

Type: Rust/OpenAPI + web performance, S

- Add a paginated/bounded project metric catalog route with coverage/count
  summaries.
- Add `include_metric_keys=false` or remove catalog discovery from default run
  summaries after compatibility review.
- Add high-cardinality fixtures and query-plan/latency gates.

Done when: run table latency does not scale with the total distinct metric-key
catalog.

### PR-18: Make Quick Search Server-Backed Beyond Loaded Pages

Depends on: PR-17. Type: Rust/OpenAPI + web, M

- Search off-page runs, projects, artifacts, reports, and saved views through
  bounded typed results.
- Keep keyboard navigation and route/focus behavior from the current palette.
- Debounce, cancel stale responses, and disclose result caps.

Done when: Cmd/Ctrl-K finds an old experiment that is not in the current run
page or browser cache.

## P1: Integrate HPO Instead Of Owning A Sweep Scheduler

Users frequently prefer Optuna/Ray for scheduling and W&B for visualization.
InstantML should embrace that split before considering an internal agent
scheduler.

### PR-19: Design The HPO Trial Metadata Contract

Depends on: PR-12. Type: design-only, XS

- Define study ID/name, trial ID/number, sampler/pruner metadata, state,
  objective keys/directions, and parent run/group mapping.
- Map the contract to existing run config, summaries, stop requests, and
  experiment context.
- Explicitly exclude an InstantML-owned scheduler, GPU allocator, and Bayesian
  optimizer.

Done when: both an Optuna integration and later Ray integration can use the
contract without pretending InstantML owns process lifecycle.

### PR-20: Add An Optuna Integration

Depends on: PR-15, PR-19. Type: Python SDK, S

- Add a callback/helper that creates or attaches trial runs, logs params and
  objectives, records pruned/failed/completed state, and links the study.
- Keep Optuna optional and avoid importing it on normal SDK paths.
- Add real Optuna tests and a runnable example.

Done when: an existing Optuna study gains InstantML tracking without replacing
its sampler, pruner, storage, or worker orchestration.

### PR-21: Add A Full-Population HPO Explorer

Depends on: PR-17, PR-20. Type: Rust/OpenAPI + web, M

- Add a bounded server projection over the full filtered study population,
  rather than only the currently loaded run page.
- Show objective leaderboard, parameter importance/correlation, parallel
  coordinates, failures/prunes, and the best run with honest truncation.
- Reuse existing Insights chart primitives and accessibility tables.

Done when: a large Optuna study can be analyzed without loading all run rows or
metric histories into the browser.

### PR-22: Add Ray Tune Integration After Optuna Feedback

Depends on: PR-20, PR-21. Type: Python SDK, S

- Add a Ray Tune callback using the proven HPO metadata contract.
- Reuse only abstractions that became genuinely shared after Optuna.
- Cover worker restarts, repeated result callbacks, and terminal trial states.

Done when: Ray owns scheduling/resources and InstantML owns durable tracking and
analysis, with no private-SDK coupling.

## P1: Remove Pricing And Security Surprises

### PR-23: Publish A No-Security-Tax Packaging Decision

Type: product/docs/config, S

- Validate and publish a feature matrix that keeps core security and data
  portability out of custom-contract-only packaging.
- Proposed baseline for paid self-serve plans: scoped/expiring API keys, audit
  log read/export, full export, retention controls, and BYOC as a priced add-on
  or clear Premium option.
- Keep SAML/SCIM, formal compliance attestations, dedicated infrastructure, and
  custom support in Enterprise only where vendor/operational cost requires it.
- Remove employee-count eligibility cliffs; price by explicit seats, storage,
  requests, and selected add-ons.

Done when: pricing copy and the server plan catalog express the same rules and a
small team can predict which security capabilities require a contract.

### PR-24: Add Forecasted Usage And Budget Alerts

Depends on: PR-23. Type: Rust/OpenAPI + web, M

- Project month-end metric/API usage and retained-storage cost from clearly
  labeled assumptions.
- Add user-configurable in-app/email thresholds with deduplicated notices.
- Show price, included amount, current use, forecast, next reset, and the exact
  action when a hard limit is reached.

Done when: a team can see a likely overage or block before it interrupts a
training job.

### PR-25: Add A Customer-Facing Audit Log

Depends on: PR-23. Type: Rust/OpenAPI + web, M

- Expose bounded, paginated audit events for auth, membership, API keys, plan
  changes, exports, run archive/delete, artifact retention/delete, and BYOC
  configuration.
- Add CSV/JSON export and owner/admin authorization.
- Keep request bodies, secrets, metric values, and artifact paths out of events.

Done when: a paid self-serve team can answer who changed or exported data
without an Enterprise support ticket.

## P1: Make Data Control Explicit And Complete

### PR-26: Publish The Customer Data-Use And Model-Training Policy

Type: legal/product/docs, S

- State plainly that customers retain ownership of their data.
- Commit that customer runs, metrics, artifacts, source metadata, reports, and
  traces are not used to train models without separate, explicit, revocable
  opt-in.
- Document subprocessors, retention after termination, backup deletion windows,
  support access, security contact, export rights, and BYOC boundaries.
- Have counsel review terms/DPA language before publication; do not treat this
  repository PR as legal approval by itself.

Done when: product, privacy, terms, and in-app copy are consistent enough for a
small-team procurement review.

### PR-27: Add Async Organization Export With A Manifest

Depends on: accepted export-job design. Type: Rust + worker + web/CLI, M

- Build on current bounded export with an asynchronous, resumable org/project
  export job.
- Include runs, configs, metrics, annotations, reports, workspace views,
  artifact manifests/lineage, audit records, and optionally stored artifact
  bytes in open formats.
- Produce checksums, schema versions, counts, skipped/external-byte warnings,
  expiry, and an audit event.

Done when: a large org can leave with a verifiable portable archive without
requesting support or exhausting one HTTP response.

### PR-28: Add Organization Deletion And Purge Receipts

Depends on: PR-25, PR-27, PR-30. Type: Rust + worker + web, M

- Add owner-confirmed, delayed deletion with cancellation and optional export
  first.
- Purge tenant rows, local/R2 artifact bytes, credentials/references, share
  tokens, and control-plane projections according to the published policy.
- Retain only the minimum non-customer-data receipt required for billing/legal
  obligations.

Done when: deletion completes across control, data, artifact, and backup-policy
boundaries with a user-visible status and audit/purge receipt.

## P2: Finish Artifact And Local-Storage Lifecycle

### PR-29: Add A Content-Addressed SDK Artifact Cache

Type: design-gated Python SDK, M

- Cache downloads by digest under a configurable directory with owner-only
  permissions.
- Add cache inspect, verify, size, and prune commands plus LRU/age/size limits.
- Never create duplicate full copies when a verified cached blob can be linked
  or copied safely; disclose filesystem fallback behavior.

Done when: repeated checkpoint downloads reuse one verified blob and users can
see and reclaim local disk safely.

### PR-30: Physically Garbage-Collect Deleted/Expired Artifact Bytes

Type: design-gated Rust worker, M

- Turn soft-deleted/expired version state into idempotent local/R2 byte
  deletion, with retry/backoff and audit events.
- Reconcile metadata/provider truth and report pending-delete bytes separately
  until physical deletion succeeds.
- Protect live aliases, manifests, shared digests, active upload sessions, and
  lineage references according to the accepted policy.

Done when: retention/delete lowers provider storage after the grace period and
can recover from provider-success/persist-failure ambiguity.

### PR-31: Resume Multipart Uploads Across Process Restarts

Depends on: PR-07. Type: Python SDK + Rust/R2, M

- Persist upload ID, part size, completed part ETags, digest progress, and local
  source fingerprint without storing presigned URLs.
- Probe provider state, resume missing parts, renew URLs, and abort safely when
  the local file changed.
- Add interrupted-upload tests and an operator/user repair command.

Done when: a multi-GB checkpoint upload can resume after process or network
failure without re-uploading completed valid parts or blocking scalar logging.

## Recommended Merge Order

1. PR-00.
2. PR-01, then PR-02/PR-03, then PR-04/PR-05, then PR-06/PR-07/PR-08.
3. PR-09/PR-10/PR-11 once true offline identity and sync exist.
4. PR-12, then PR-13/PR-15/PR-17, followed by PR-14/PR-16/PR-18.
5. PR-19, then Optuna PR-20 and explorer PR-21; Ray PR-22 only after feedback.
6. PR-23 and PR-26 can proceed as product/legal work while reliability ships;
   PR-24/PR-25 follow the accepted packaging contract.
7. PR-27 and PR-30 before destructive org deletion PR-28.
8. PR-29 and PR-31 can run after the P0 reliability contracts stabilize.

## Explicit Non-Roadmap Items

- Do not build an InstantML sweep scheduler, agent heartbeat service, GPU
  allocator, or Bayesian optimizer before Optuna/Ray integrations are used and
  validated.
- Do not build a second offline dashboard; reuse the existing Rust/ClickHouse/
  web stack.
- Do not rebuild reports, saved views, versioned artifacts, rank dashboards,
  generic imports, responsive layout, or chart downsampling.
- Do not add artifact work to the scalar metric hot path.
- Do not expand alerting into a general automation platform to deliver the
  first budget notification; keep the first channel narrow.
- Do not promise exactly-once delivery. Use stable idempotency plus honest
  completeness and replay semantics.

## Complaint Coverage

| Complaint area | Remaining PRs |
| --- | --- |
| SDK hangs, sync failures, silent loss | PR-01 through PR-08 |
| Offline, Slurm, Lustre/NFS, distributed conflicts | PR-02 through PR-11 |
| Dashboard scale and experiment sprawl | PR-12 through PR-18 |
| Brittle sweeps | PR-19 through PR-22 |
| Pricing/security packaging cliff | PR-23 through PR-25 |
| Data ownership, privacy, portability | PR-25 through PR-28 |
| Artifact cache, disk, cleanup, large uploads | PR-29 through PR-31 |
| UX/mobile/docs quirks | Existing responsive/docs baseline plus PR-06, PR-07, PR-09, and PR-11 |
