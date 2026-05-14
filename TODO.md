# TODO

Owner-editable development backlog for Training Observability.

Current product goal: build a W&B-style training observability SaaS for smaller startups, research labs, and lean ML teams that wins on speed, UI quality, predictable pricing, and transparent data ownership.

Current architecture rule: the Rust server is the primary backend path for local and hosted development: `Next/React frontend -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage` and `Python SDK/uploader -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage`. The Node server is deprecated and retained only as a compatibility oracle, JSON migration source, and legacy fallback.

## Completed Baseline

- [x] Product strategy, pricing hypotheses, and W&B-competitor wedge documented.
- [x] Rust/ClickHouse hosted backend design accepted with diagrams and review notes.
- [x] Node compatibility server covers projects, runs, metrics, summaries, typed attributes, artifacts, org/API-key scaffolding, usage summaries, imports, export, idempotency, and local artifact storage.
- [x] Next/React UI covers daily run browsing, charting, saved views, comparison, artifacts, rollouts, checkpoints, usage-adjacent surfaces, and API visibility.
- [x] Python SDK covers run creation, metrics, typed helpers, buffering, offline replay for post-run-create events, process spool, uploader, API-key auth, source metadata, artifact metadata, and file upload.
- [x] Shared contract smoke exists for the primary Rust backend and deprecated Node compatibility backend.
- [x] ClickHouse schema exists under `apps/rust-server/clickhouse/`.
- [x] Importer first slices exist for Neptune-shaped, transformed W&B, and transformed MLflow JSON.

## Competitive Gap Review - W&B Docs (2026-05-10)

Reviewed official W&B docs sources:

- `https://docs.wandb.ai/llms.txt`
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
- `https://docs.wandb.ai/models/integrations`
- `https://docs.wandb.ai/models/app/features/panels/line-plot`
- `https://docs.wandb.ai/models/app/features/panels/media`
- `https://docs.wandb.ai/models/app/features/panels/run-comparer`
- `https://docs.wandb.ai/models/registry`
- `https://docs.wandb.ai/models/automations`

High-value gaps to close without copying W&B's whole platform:

- Design-partner feedback from 2026-05-10: speed is the top wedge. A W&B project with around 90,000 runs took seconds to load, so Training Observability must treat large-run-count browsing, search, filtering, and compare performance as core product work, not late polish.
- Run lifecycle depth: user-supplied run IDs, resume/reinit/fork semantics, true offline run creation and sync, disabled/no-op mode, notes, group, job type, settings, environment-variable defaults, and cleaner distributed-process behavior.
- Metric semantics: default step behavior, custom x-axes, summary policies such as min/max/best, explicit history pagination, unsampled metric export, system metrics, console logs, and code/dependency capture.
- Rich logged objects: first-class table, image, video, audio, histogram, HTML/plot, and 3D/point-cloud schemas instead of treating most non-scalar data as generic artifact metadata.
- Artifact graph: versioned artifacts, aliases such as `latest` and `vN`, custom aliases/tags, file manifests, input/output lineage, `use_artifact`, partial downloads, external references, cache behavior, TTL/retention, and eventually registry/model lifecycle workflows.
- Public query API: a Python `Api`-style client and server routes for listing/filtering runs, paginated history reads, artifact/file lookup, post-hoc metadata/config/summary updates, and export workflows.
- Run identification and compare ergonomics: push tags and notes harder in the SDK/UI, show tags and notes where runs are listed, support stronger search over tags/notes/config/metrics, and make compare usable for many runs by supporting row-oriented layouts plus row and column sorting.
- Workflow layer: sweeps/agents, alerts or automation webhooks, saved workspace/panel APIs, report/share surfaces, and framework integrations for PyTorch Lightning, Keras, Hugging Face, TensorBoard, Gym/RL, and common training libraries.
- Product strategy guardrail: prioritize the wedge first: fast scalar logging, fast comparison, trustworthy artifacts, portable exports, and predictable hosted operations. Treat registry, launch/jobs, reports, and broad automations as later expansion unless customer validation pulls them forward.

## P0 - Rust Service Development Loop

Goal: make `apps/rust-server` a runnable, testable service before replacing Node as the default.

- [x] Confirm the current Rust/ClickHouse storage slice in `docs/design/2026-05-14-clickhouse-only-storage.md` and record any narrowed implementation notes before coding.
- [x] Add Rust project scaffolding: `Cargo.toml`, module layout, binary entrypoint, and `serve`, `worker`, `migrate`, and local `all` subcommands.
- [x] Add app config from environment with clear local defaults for `CLICKHOUSE_URL`, bind address, request limits, artifact root, bootstrap token, auth mode, and logging.
- [x] Add `axum`, `tokio`, `tower-http`, `ClickHouse client`, `serde`, `tracing`, `uuid`, `chrono`, `sha2`, `base64`, `mime_guess`, and OpenAPI tooling.
- [x] Implement `GET /healthz`, `GET /readyz`, `GET /metrics`, and `GET /openapi.json`.
- [x] Add structured JSON error handling that preserves the current `{"error": "message"}` compatibility shape.
- [x] Add local request IDs, CORS, compression, body-size limits, timeouts, and structured tracing.
- [x] Add a disposable ClickHouse integration-test harness that applies the schema.
- [x] Add root commands for Rust formatting, linting, tests, migration checks, and contract-test startup once the binary exists.
- [x] Update `apps/rust-server/README.md`, `SETUP.md`, and root `README.md` with the actual commands.

## P1 - Rust Compatibility Vertical Slice

Goal: prove the smallest useful SDK -> Rust -> ClickHouse -> UI path.

- [x] Implement project create/list routes against ClickHouse.
- [x] Implement run create/list/get/update routes against ClickHouse.
- [x] Implement scalar metric ingestion with finite nonnegative numeric steps.
- [x] Store scalar points in `metric_points` and maintain `metric_series` summaries in the same transaction.
- [x] Implement bounded metric series reads ordered by `step asc, point id asc`.
- [x] Implement `GET /api/runs/summary` by paging runs first, then joining maintained summaries only for page run IDs.
- [x] Implement idempotent metric replay with org-scoped `Idempotency-Key` rows and request-body hashes.
- [x] Run `npm run test:contract` against Rust through `RLOBS_CONTRACT_BASE_URL`.
- [x] Run Python SDK tests against Rust for overlapping routes.
- [x] Run a minimal UI smoke against Rust by pointing `RLOBS_API_BASE` at the Rust service.
- [x] Keep Node as the default backend during P1, then retire it to compatibility after the slice passes repeatedly.
- [x] Promote Rust/ClickHouse to the default backend after Node/Rust contract, SDK, and frontend parity checks pass.

## P2 - Auth, Tenancy, And API Keys

Goal: make hosted org isolation real before broad product data moves to Rust.

- [x] Implement local bootstrap flow for creating users, orgs, memberships, service accounts, and API keys.
- [x] Hash API keys, store only prefixes plus hashes, and show plaintext only once.
- [x] Implement bearer API-key extraction, scope checks, expiry, revocation, disabled service accounts, and optional project restrictions.
- [x] Implement managed-auth adapter boundary for Google/JWT sessions without hard-locking the database model to one provider.
- [x] Add the first browser-session onboarding slice: local Google-style signup/signin, session cookies, org account type, seat reservation, and owner/admin API-key creation.
- [x] Add org context resolution for hosted org routes and compatibility routes.
- [x] Add authorization tests for cross-org run, metric, artifact, import, export, usage, and side-by-side access.
- [x] Add audit events for auth-sensitive mutations.
- [x] Evaluate ClickHouse RLS as defense in depth after application-level org checks pass.
- [x] Keep UI auth/org error states on existing API error surfaces until richer org switching lands in P5.

## P3 - Artifacts, Attributes, Imports, Export, And Usage

Goal: reach feature parity with the Node compatibility server on product workflows.

- [x] Implement typed attributes with filters for type and path prefix.
- [x] Implement artifact metadata create/list routes.
- [x] Implement local artifact storage trait with staged writes, SHA256, MIME type, size, download, cleanup, and repair behavior.
- [x] Implement artifact upload/download compatibility routes.
- [x] Implement side-by-side comparison from ClickHouse summaries, config, metadata, tags, attributes, artifacts, and selected metrics.
- [x] Implement portable JSON export filtered by org/project/project ID.
- [x] Implement Neptune-shaped, transformed W&B, and transformed MLflow import routes through a shared normalized importer path.
- [x] Keep import dry-run and real import validation identical.
- [x] Make bounded import writes transactional or explicitly documented with cleanup behavior.
- [x] Implement warning-only `GET /api/usage` and `GET /api/usage/export` from indexed ClickHouse data.
- [x] Add immutable `usage_daily` rollup writer before treating any usage value as invoice truth.

## P4 - Migration From Node JSON To ClickHouse

Goal: let existing local/demo data move forward without hand repair.

- [ ] Build a JSON-to-ClickHouse migration dry-run CLI for `.rlobs/rlobs.json`.
- [ ] Preserve projects, runs, metrics, maintained summaries, typed attributes, artifacts, imports, users, orgs, service accounts, API-key metadata, and usage-relevant counts.
- [ ] Preserve artifact byte references and detect missing local files.
- [ ] Emit a migration report with counts, skipped records, warnings, and estimated storage.
- [ ] Add representative migration fixtures from current demo, importer, artifact, and auth data.
- [ ] Add rollback/retry guidance for partial migration failures.
- [ ] Document migration commands in `apps/rust-server/README.md` and `tools/README.md`.

## P5 - Frontend Hosted Workflow

Goal: keep the UI as the product moat while the backend changes underneath it.

- [x] Verify every current UI tab against Rust once P1/P3 routes exist.
- [x] Make the Runs table/workspace credible at 90,000-run project scale with server-backed pagination, search, filters, and sorting instead of client-only loaded-page behavior.
  - First slice complete: Rust cursor pagination, indexed summary/search/sort paths, frontend cursor stack with Node offset fallback, Python `Api.runs()`, and local benchmark evidence in `docs/design/2026-05-11-large-run-query-performance.md`.
  - Remaining: richer explicit tag/config/artifact filters, high-cardinality metric-key catalog split, Compare-scale query gates, and hosted-environment SLO proof.
- [x] Add visible tags and notes to the Runs list/workspace and promote tag/notes editing in Run Detail and Compare.
- [x] Rework Compare so users can switch between column-oriented and row-oriented layouts; default to the layout that scans best for many compared runs.
- [x] Add row and column sorting to Compare for run name, status, tags, notes, config keys, metric latest/best values, artifact presence, and changed/unchanged rows.
- [x] Add inline MP3/MP4 artifact playback in Run Detail and Compare when artifacts are safe to stream, with download-only fallback for unsupported or external-reference files.
- [ ] Add an organization selector and clear empty/no-access/error states for hosted mode; the first single-org onboarding/dashboard redirect is implemented.
- [x] Add first-slice API-key creation and copy-once UX during onboarding.
- [ ] Add usage summary UI for seats, projects, runs, metric points, artifact bytes, active API keys, and warning thresholds.
- [ ] Add import dry-run/import summary UI for Neptune, W&B, and MLflow paths.
- [ ] Keep local unauthenticated Node development flow working while hosted auth is added.
- [ ] Expand Playwright coverage for auth errors, org switching, usage, import dry-run, artifact download, and Rust-backed smoke.
- [x] Use Computer Use for manual frontend QA after each substantial UI change.

## P6 - SDK And Uploader Hardening

Goal: make the training-loop hot path trustworthy against Rust/ClickHouse.

- [ ] Add SDK integration tests that run against Rust for sync mode, buffered mode, offline replay, process spool, uploader retry, and file upload.
- [ ] Confirm `RLOBS_API_KEY` and explicit `api_key` work against Rust API-key auth.
- [ ] Add optional org/project/entity context only after hosted route shape is final.
- [ ] Design SDK lifecycle parity before implementation: run ID, notes, group, job type, resume modes, reinit behavior, offline/disabled modes, env var defaults, and settings.
- [ ] Add true offline run creation and later sync after the design is accepted; keep the current post-run-create replay limitation documented until then.
- [ ] Add `define_metric` or equivalent summary policy support for last/min/max/best and custom step axes once server summaries can represent it.
- [ ] Add a compact post-hoc query client after Rust exposes stable public query routes for runs, history, artifacts, files, and exports.
- [ ] Keep metric logging independent from artifact upload work.
- [ ] Add larger process-spool replay tests for uploader crash/retry and idempotency conflicts.
- [ ] Document exact offline limitation: `init()` still requires a reachable server until offline run creation is designed.
- [ ] Add W&B dual-logging adapter only after import usefulness is validated with real teams.

## P7 - Deployment And Operations

Goal: make a beta deployment boring enough to trust.

- [ ] Add complete Docker Compose path for ClickHouse, Rust API, worker, Next web, and local artifact volume.
- [ ] Add health, readiness, migration, and seed/bootstrap commands for local hosted-mode testing.
- [ ] Prepare first hosted beta deployment on the preferred stack: Cloud Run, managed ClickHouse, Cloudflare R2, and Clerk or equivalent managed auth.
- [ ] Add secret management guidance for database URLs, API-key pepper if used, auth provider keys, object storage credentials, and bootstrap tokens.
- [ ] Add database backup, restore, migration, and connection-pooling notes.
- [ ] Add artifact retention and cleanup job documentation.
- [ ] Add structured logs and basic dashboards for request latency, error rate, ingestion volume, DB pool usage, and artifact failures.
- [ ] Add deployment runbook and rollback checklist before inviting design partners.

## P8 - Performance, Reliability, And Quality Gates

Goal: prove speed and reliability claims before making them public.

- [ ] Add Rust/ClickHouse scale smoke for the daily small-team case: 50 runs, 20 metrics per run, and 1,000 points per metric.
- [x] Add Rust/ClickHouse scale smoke for the design-partner case: 90,000 runs in one project with realistic names, tags, notes, statuses, configs, metric summaries, and artifact counts.
- [x] Measure Runs page first useful render under 2 seconds for the 90,000-run project on local production build plus local Rust/ClickHouse.
  - 2026-05-11 local result: 387 ms with `RLOBS_BENCH_WEB=1`.
- [x] Measure server-side run search/filter/sort p95 under 500 ms for the 90,000-run project with indexed status, tag, note/name text, config, and selected metric-summary sorts.
  - 2026-05-11 local result: `q=seed 13` p95 118 ms; `metric-best` p95 66 ms.
- [x] Measure run summary p95 under 300 ms for the target data shape.
  - 2026-05-11 local result: project newest p95 78 ms; org newest p95 68 ms.
- [x] Measure metric chart p95 under 200 ms for one run/key with 1,000 points.
  - 2026-05-11 local result: p95 22 ms.
- [ ] Measure dashboard initial load p95 under 1 second after auth/session resolution.
- [ ] Add query-plan/timing checks for summary, chart, artifact, usage, import-history, run search, tag/note search, and compare queries.
- [ ] Add load tests for SDK metric ingestion batches and process-spool replay.
- [ ] Add failure-mode tests for idempotency conflicts, body-too-large errors, storage finalize failures, import rollback, and DB transaction errors.
- [ ] Keep first-party code at 100% meaningful coverage or document precise coverage exceptions.
- [x] Add CI once the command set stabilizes.
  - First CI slice covers stable pull-request gates: Rust fmt/clippy/unit tests, Node tests, and Python tests. Rust service/UI smokes stay local until the ClickHouse service harness is settled.

## P9 - Validation And Launch Readiness

These are product validation tasks, but they should feed development priority.

- [ ] Validate the W&B-competitor positioning with real ML teams. Outreach plan exists in `docs/users/2026-05-09-validation-plan.md`.
- [ ] Validate pricing with small startups and labs before publishing final prices.
- [ ] Validate whether Cloud Run, managed ClickHouse, Cloudflare R2, and Clerk are acceptable for first beta users.
- [ ] Validate whether import, dual logging, or a direct W&B/MLflow migration guide is the most important adoption path.
- [ ] Decide license and public-source posture before representing the repo as open source.

## P10 - Cross-Component W&B-Informed Feature Tracks

Goal: coordinate global features that span the Rust API, Python SDK, and web app. The root TODO tracks product-level completion; component TODOs carry implementation detail. A track is done only when design docs are accepted where required, component TODOs are complete, docs are updated, and relevant Rust, SDK, contract, and UI tests pass.

Component detail backlogs:

- Rust server details: `apps/rust-server/TODO.md`
- Python SDK details: `packages/python-sdk/TODO.md`
- Web app details: `apps/web/TODO.md`

- [ ] 90,000-run speed, search, tags, notes, and compare ergonomics.
  - Product outcome: a project with around 90,000 runs loads quickly, search is useful, tags/notes are visible and editable, and compare supports row-oriented scanning plus row/column sorting.
  - Current slice: visible tag/note previews, Run Detail/Compare editing, SDK notes/tag helpers, demo tags/notes, indexed Rust search across note/tag/name/config text, cursor-backed Runs pagination/sorting, Python `Api.runs()`, and 90,000-run local benchmark gates are implemented.
  - Remaining: explicit tag/config/artifact filter grammar, high-cardinality metric catalog route or include flag, quick search over off-page objects, Compare-scale payload gates, and hosted-environment benchmark proof.
  - Rust reference: `apps/rust-server/TODO.md` P0 - Contract And Run Lifecycle, P1 - Public Query API, P5 - Reliability And Coverage.
  - SDK reference: `packages/python-sdk/TODO.md` P0 - Run Lifecycle And Settings for first-class tags/notes; P4 - Public API Client for search/query access.
  - Web reference: `apps/web/TODO.md` P0 - Large Run Count Speed, Search, And Run Identification; P1 - Compare Page Ergonomics.

- [ ] Run lifecycle, resume, offline, and reproducibility.
  - Product outcome: users can start, resume, fork, group, annotate, and finish runs predictably online or offline, with code/source/system context visible later.
  - Rust reference: `apps/rust-server/TODO.md` P0 - Contract And Run Lifecycle.
  - SDK reference: `packages/python-sdk/TODO.md` P0 - Run Lifecycle And Settings, P1 - Metric Hot Path.
  - Web reference: `apps/web/TODO.md` P2 - Public Query, Export, And Run History UI; P2 - Sweeps, Automations, And Integrations UI for integration setup/status.

- [ ] Metric semantics, summaries, history, and exports.
  - Product outcome: scalar logging remains fast while supporting default steps, custom x-axes, summary policies, paginated history, unsampled export, system metrics, console logs, and code/dependency capture.
  - Rust reference: `apps/rust-server/TODO.md` P0 - Contract And Run Lifecycle, P1 - Public Query API, P5 - Reliability And Coverage.
  - SDK reference: `packages/python-sdk/TODO.md` P1 - Metric Hot Path, P4 - Public API Client.
  - Web reference: `apps/web/TODO.md` P2 - Public Query, Export, And Run History UI; P2 - Panel Types Needed For Shortcut-Adjacent Parity.

- [ ] Rich logged objects and typed media.
  - Product outcome: tables, images, video, audio including MP3, video including MP4, histograms, HTML/plots, and optional 3D/point-cloud objects are first-class logged data, not generic file metadata.
  - Current slice: accepted design `docs/design/2026-05-11-rich-logged-objects.md` uses attributes/artifacts as the catalog, adds paginated table preview rows, Rust object routes, Python `Table`/`Histogram`/media wrappers, Run Detail/Artifacts previews, demo table/histogram objects, object-route-only rich media/table validation, and local benchmark evidence (object list p95 47.5 ms, table-only list p95 8.3 ms, table rows p95 1.9 ms).
  - Remaining: workspace media/table panels, image masks/boxes, HTML/plot/3D objects, object search/catalog, process-spooled rich media response chaining, artifact versions/lineage, and Compare/server batch object context after a no-fan-out design.
  - Rust reference: `apps/rust-server/TODO.md` P3 - Rich Logged Objects.
  - SDK reference: `packages/python-sdk/TODO.md` P2 - Rich Data Types.
  - Web reference: `apps/web/TODO.md` P1 - Media Panel Shortcuts; P2 - Panel Types Needed For Shortcut-Adjacent Parity; P2 - Rich Logged Object And Media UI.

- [ ] Artifact versions, lineage, external references, and model lifecycle.
  - Product outcome: artifacts support versions, aliases, tags, manifests, input/output lineage, `use_artifact`, partial downloads, external references, retention/TTL, and a later registry/model workflow if validated.
  - Rust reference: `apps/rust-server/TODO.md` P2 - Artifacts, Versions, And Lineage.
  - SDK reference: `packages/python-sdk/TODO.md` P3 - Artifacts And Files.
  - Web reference: `apps/web/TODO.md` P2 - Artifacts, Lineage, Registry, And Models UI.

- [ ] Public query API and post-hoc management.
  - Product outcome: users can programmatically and visually query runs, histories, summaries, configs, metadata, files, artifacts, sweeps, and exports with pagination and safe updates.
  - Rust reference: `apps/rust-server/TODO.md` P1 - Public Query API.
  - SDK reference: `packages/python-sdk/TODO.md` P4 - Public API Client.
  - Web reference: `apps/web/TODO.md` P2 - Public Query, Export, And Run History UI.

- [ ] Workspace, report, and panel persistence.
  - Product outcome: workspace views, report drafts, panel settings, sections, share links, and keyboard-driven panel workflows become durable team objects instead of local-only state.
  - Rust reference: `apps/rust-server/TODO.md` P4 - Sweeps And Workflow APIs for saved workspace/panel APIs, plus a future design doc before schema changes.
  - SDK reference: no SDK work expected unless report/workspace export helpers become part of the public API client.
  - Web reference: `apps/web/TODO.md` P0/P1 keyboard and report sections, P1 - Workspace And Panel Parity Beyond The Shortcut Page, P3 - Documentation And Discoverability.

- [ ] Hosted org, auth, API-key, usage, and import workflows.
  - Product outcome: hosted users can choose org context, create/copy API keys, see warning-only usage, run import dry-runs, and recover from auth/no-access states without leaving the app.
  - Current slice: landing page, local Google-style signup/signin, session-backed dashboard access, seat reservation, copy-once onboarding API key, and route-backed tabs are implemented.
  - Rust reference: root P2/P3/P7 plus `apps/rust-server/TODO.md` P5 - Reliability And Coverage for auth checks and future route tests.
  - SDK reference: `packages/python-sdk/TODO.md` P0 - Run Lifecycle And Settings for env defaults and API-key behavior; P4 - Public API Client for authenticated post-hoc access.
  - Web reference: `apps/web/TODO.md` P1 - Hosted Workflow UI From The Global TODO.

- [ ] Sweeps and agent workflows.
  - Product outcome: users can define a small random/grid sweep, run agents, inspect assignments, compare results, and find the best run.
  - Rust reference: `apps/rust-server/TODO.md` P4 - Sweeps And Workflow APIs.
  - SDK reference: `packages/python-sdk/TODO.md` P5 - Sweeps And Integrations.
  - Web reference: `apps/web/TODO.md` P2 - Sweeps, Automations, And Integrations UI.

- [ ] Automations, alerts, and webhook workflows.
  - Product outcome: narrow first slice supports metric-threshold events and signed webhook delivery, with artifact-event automations later.
  - Rust reference: `apps/rust-server/TODO.md` P4 - Sweeps And Workflow APIs.
  - SDK reference: no SDK work expected in the first slice unless run-side alert helpers are designed later.
  - Web reference: `apps/web/TODO.md` P2 - Sweeps, Automations, And Integrations UI.

- [ ] Framework integrations and adoption bridges.
  - Product outcome: setup for PyTorch Lightning, Hugging Face Transformers, Keras, TensorBoard, Gym/RL media, W&B dual logging, and MLflow/W&B imports becomes easy to discover and test.
  - Rust reference: import and public query support from root P3/P4 and `apps/rust-server/TODO.md` P1 - Public Query API.
  - SDK reference: `packages/python-sdk/TODO.md` P5 - Sweeps And Integrations, plus P1/P2 for system metrics and rich data helpers.
  - Web reference: `apps/web/TODO.md` P2 - Sweeps, Automations, And Integrations UI; P1 - Hosted Workflow UI From The Global TODO for import UX.

- [ ] Cross-component quality gates.
  - Product outcome: every new global surface has tests at the right level, bounded data access, no secret leakage, and updated docs.
  - Rust reference: `apps/rust-server/TODO.md` P5 - Reliability And Coverage.
  - SDK reference: `packages/python-sdk/TODO.md` Quality Gates.
  - Web reference: `apps/web/TODO.md` Verification Checklist For Each Shortcut Feature and relevant section-level tests.
  - Root reference: P8 - Performance, Reliability, And Quality Gates.

## User Notes

- [x] Brendan product notes: Rust/ClickHouse is now the primary backend; keep Node only as deprecated compatibility/migration support while aiming to beat W&B on speed, UI quality, and predictable pricing.
- [x] Target customer notes: smaller startups, research labs, lean ML teams, RL/robotics/simulation teams, fine-tuning teams, and ML platform owners who already understand experiment tracking.
- [x] Feature ideas to validate before implementation: W&B dual logging, MLflow import depth, hosted admin/billing UI, self-host/VPC, public naming, and open-source launch model.
- [x] W&B docs gap review completed on 2026-05-10 and translated into root, Rust server, and Python SDK TODOs.
- [x] Design-partner feedback from 2026-05-10: speed at 90,000-run scale, better search, visible tags/notes, MP3/MP4 artifacts in compare, row-oriented compare, and row/column sorting are important product differentiators.
