# Design Documents

Every meaningful implementation should start here.

Current implemented design sequence:

- `2026-05-05-repository-operating-model.md`: repo and agent operating model.
- `2026-05-05-days-1-4-bootstrap.md`: Python bootstrap API, SDK, and first example.
- `2026-05-05-node-server-frontend-ui.md`: Node server and days 5-8 UI.
- `2026-05-06-dogfood-training-loops.md`: realistic examples and UI dogfood feedback.
- `2026-05-06-neptune-compatible-roadmap-implementation.md`: typed attributes, SDK buffering, local artifacts, comparison UI, and Neptune-shaped import.
- `2026-05-07-sdk-process-uploader.md`: process-isolated SDK upload mode with fsynced event files and a separate uploader.
- `2026-05-07-next-react-ui-migration.md`: Next/React UI migration with tabs, chart axes, point hover, and API rewrites.
- `2026-05-08-full-navigation-tabs.md`: frontend navigation expansion and derived workspace tabs.
- `2026-05-14-clickhouse-only-storage.md`: accepted primary Rust/ClickHouse storage plan, local/test first slice, and hosted control-plane/data-plane direction.
- `2026-05-09-usage-metering.md`: Rust/ClickHouse usage summaries, immutable daily rollup snapshots, UTC calendar-month metric-point periods, and Node compatibility coverage for pricing validation.
- `2026-05-09-migration-adoption-p4.md`: SDK metadata reservation, atomic importer core, Neptune hardening, and W&B JSON import first slice.
- `2026-05-09-mlflow-import-and-dual-logging.md`: MLflow JSON import follow-up and the original W&B dual-logging recommendation, later narrowed into the optional `shadow_wandb` SDK path.
- `2026-05-10-runs-workspace-panels.md`: W&B/Grafana-inspired Runs workspace sections, line panels, add/edit/fullscreen flows, local layout persistence, and future persisted workspace API shape.
- `2026-05-10-web-keyboard-shortcuts-mvp.md`: keyboard workflow MVP for quick search, shortcut help, overlay dismissal, undo/redo, run-rail collapse, focus handoff, and fullscreen panel traversal.
- `2026-05-10-compare-page-flow.md`: Compare page row/column layouts, sorting, artifact context, saved-view restore, and safe media preview behavior.
- `2026-05-10-run-tags-notes-editing.md`: searchable tags/notes across Rust, SDK, Runs, Run Detail, and Compare.
- `2026-05-11-rich-logged-objects.md`: first rich logged object slice using attributes/artifacts, paginated table preview rows, SDK wrappers, and Run Detail/Artifacts previews.
- `2026-05-11-landing-auth-onboarding.md`: landing page, Google-style local auth, browser sessions, org seats, copy-once SDK key onboarding, and real dashboard routes.
- `2026-05-14-mlop-inspired-sdk-ergonomics.md`: MLOP-inspired SDK ergonomics while preserving sync/buffer/offline/process-spool architecture, including auto-step `Run.log()`, local file wrappers, optional local SQLite audit, system metrics, console capture, and lightweight framework adapters.
- `2026-05-14-instantml-rescheme-and-chart-polish.md`: InstantML frontend rescheme, public brand-token reference, chart density polish, and project/saved-view acceptance criteria.
- `2026-05-14-hosted-clickhouse-query-benchmarks.md`: hosted ClickHouse demo benchmark protocol for 100,000-run dashboard query latency, response validation, budgets, and sanitized result reporting.
- `2026-05-16-clerk-hosted-auth.md`: Clerk hosted auth, org-name uniqueness, browser session authorization, and ClickHouse Cloud Mini warehouse defaults.
- `2026-05-16-python-sdk-packaging.md`: Python SDK package metadata, local build checks, and PyPI/TestPyPI trusted-publishing workflow.
- `2026-05-16-gcp-cloud-run-rust-api.md`: internal single-instance Cloud Run deployment for the Rust API, Secret Manager, static ClickHouse egress, and local-frontend-to-hosted-API workflow.
- `2026-05-16-multi-instance-control-data-plane.md`: accepted multi-instance control/data-plane direction, central hot-path proxy rejection, single-instance guardrails, mutation gates, deterministic operational replay, split `combined`/`control`/`data` service-plane roles, and data-plane control-record refresh before auth.
- `2026-05-16-cloud-run-multi-instance-launch.md`: split Cloud Run launch wiring, deploy helper target model, managed HTTPS public router, Docker Compose split profile, static egress reuse, scaling defaults, unsafe multi-writer guardrails, and frontend env behavior.
- `2026-05-16-pricing-signup-org-admin.md`: Free/Pro/Premium signup, plan-aware tenant-route warehouse profile intent, seat invites, invite activation, usage/admin settings, API-key management, and first pricing/admin boundaries.
- `2026-05-17-plan-limit-enforcement.md`: blocked-at-limit guardrails for new project, run, current-month metric-ingest, artifact-storage, import, and demo-reset writes plus Premium local/shared demo defaults.
- `2026-05-18-wandb-hosted-comparison-benchmarks.md`: guarded W&B-hosted comparison benchmark tooling, W&B public API mapping, seeded-mode caveats, competitive public-target gates, and sanitized result reporting against the existing InstantML hosted Cloud Run benchmark.
- `2026-05-21-cloudflare-r2-artifact-storage.md`: Cloudflare R2-backed hosted artifact bytes, per-org private buckets, opaque public artifact responses, R2 usage accounting, and media upload/download smoke coverage.
- `2026-05-21-stripe-billing-platform.md`: Stripe Checkout/Billing/Portal integration, payment-verified paid signup, billing access gates, subscription projection records, and webhook/reconciliation flows.
- `2026-05-21-sdk-logging-overhead-benchmarks.md`: SDK logging overhead benchmark protocol for no-op deltas, InstantML process spool/uploader CPU, W&B offline comparison, and safe hot-path optimization review.
- `2026-05-21-rust-server-observability.md`: narrowed Rust server structured logging slice, safe field contract, sanitized error/request correlation, and Cloudflare edge-log capture plan.
- `2026-05-28-api-frontend-observability.md`: accepted follow-up for frontend
  request IDs, safe browser API logging, redacted route-template paths,
  route-plane tags, and sanitized handled-error events across all Rust API
  calls.
- `2026-05-22-staging-cloud-run-environment.md`: production router cleanup, backend timeout alignment, and isolated staging Cloud Run services/router under `staging.api.instantml.ai`.
- `2026-05-22-organization-invites-email-verification.md`: app-owned organization invite tokens, Resend send-only email delivery, verified-email acceptance, fresh-session control-plane membership activation, pending-invite seat accounting, seven-day expiration, and recorded fresh-agent review notes.
- `2026-05-18-m4-chart-aggregation.md`: spike-preserving M4 chart downsampling for high-density series via an optional `buckets` body field on `POST /api/metrics/series`, with raw-path fallback when zoomed and a per-run threshold gate.
- `2026-05-23-rank-aware-research-dashboards.md`: rank-aware metric ingest,
  bounded rank reducers, SDK logging helper, Distributed dashboard, and
  exploratory loaded-summary Insights dashboard for grouped reducers,
  hyperparameter views, K-means clustering, and evaluation panels.
- `2026-05-23-mintlify-docs-mvp.md`: public docs source under `apps/docs`,
  same-origin `/docs` rendering from `apps/web`, filtered public OpenAPI
  reference generation, validation scripts, and docs-site guardrails that keep
  internal planning docs unpublished.
- `2026-05-23-api-request-rate-limits.md`: accepted first slice for
  Free/Pro/Premium API request allowances, per-process short-window rate
  limits, bounded request-usage rollups, SDK `429` retry/backoff, dashboard
  usage visibility, and pricing/docs updates.
- `2026-05-24-admin-operator-app.md`: separate hidden read-only Next admin app,
  now amended with a Clerk single-email allowlist gate, plus a
  bootstrap-protected Rust operator overview for users, orgs, storage, API
  keys, billing posture, and risk queues.
- `2026-05-25-durable-async-sdk-logging.md`: Neptune-inspired durable async SDK
  logging slice with per-run SQLite WAL queues, a process uploader, recovery
  CLI, SDK waits/status, upload-health metrics, and silent dashboard polling.
- `2026-05-25-run-fork-lineage-source-capture.md`: Neptune-inspired run fork
  lineage, same-project checkpoint fork creation, bounded lineage reads,
  dashboard checkpoint forking, SDK `fork_run`/`attach_run`, and privacy-safe
  source-capture knobs.
- `2026-05-25-async-upload-default.md`: accepted follow-up that makes durable
  async the SDK `init()` default, keeps `Run(...)` sync by default, bounds idle
  health traffic, and documents the `upload_mode="sync"` escape hatch.
- `2026-05-27-async-sqlite-batching.md`: accepted buffered group-commit
  follow-up for default async SDK logging, with private 64-event/64 KiB/20 ms
  producer flush thresholds and an explicit short in-memory durability window.
- `2026-05-27-python-sdk-client-decomposition.md`: accepted first slice to split
  Python SDK rich objects, media helpers, and log-payload classification from
  the large `client.py` module while preserving the existing import surface.
- `2026-05-22-customer-owned-clickhouse.md`: implemented first slice for
  Premium BYOC ClickHouse onboarding, updated so customer-facing BYOC now
  recommends customer-owned self-hosted GCP ClickHouse with direct database
  credentials, static InstantML egress allowlisting, Secret Manager-backed
  credential storage, and R2-only InstantML storage accounting.

Current implemented design sequence, continued:

- `2026-05-30-artifact-lineage-parity.md`: first slice for W&B-parity
  versioned artifact manifests, `latest`/`best` aliases, artifact input/output
  edges, delete/retention state, presigned SDK-originated uploads, usage
  reservations, and artifact lineage UI.
- `2026-05-31-exporting-data.md`: reviewed export first slice with selected-run
  JSON/CSV exports, per-chart plotted-data/image downloads, CSV safety rules,
  bounded synchronous limits, and the async export roadmap.
- `2026-06-08-run-stop-signal.md`: reviewed cooperative stop-signal plan for
  Rust stop request endpoints, SDK polling/acknowledgement, dashboard request
  controls, backwards-compatible legacy status behavior, and production rollout
  checks.
- `2026-06-10-backend-cluster-scaling-plan.md`: draft backend scaling plan for
  moving from one control service, one data cell, and one ClickHouse host toward
  a Postgres-backed cell registry, multiple single-writer data cells, explicit
  route discovery, Free/Pro/Premium placement, org migration, control-plane
  horizontal scale, and later data-plane multi-writer gates.
- `2026-06-25-iframe-run-embeds.md`: reviewed first slice for short-lived,
  server-created, read-only iframe run embeds with scoped embed sessions, dynamic
  frame policy, fragment-token handling, split control/data routes, and
  production verification requirements.
- `2026-06-25-iframe-embed-panel-types.md`: reviewed follow-up for iframe
  embeds that adds generated bar, dot, latest-value histogram, scatter, and
  distribution panels while preserving read-only/no-export iframe boundaries and
  bounded workspace-view data reads.
- `2026-06-30-aim-gap2-query-api.md`: implemented Aim parity slice for a typed,
  bounded Python SDK query API over runs, metric series, rich objects, and table
  previews while keeping the server-backed `q` language authoritative.

Current draft designs:

- `2026-06-30-mcp-oauth.md`: draft MCP OAuth authentication plan; opt-in RFC 9728
  protected-resource discovery and a `WWW-Authenticate` challenge are
  implemented on the hosted MCP server, with the authorization-server (Clerk
  DCR/consent) config and the Rust token-acceptance bridge gated on a fresh auth
  review.
- `2026-06-30-zero-friction-mcp-setup.md`: draft phased plan for making
  `https://mcp.instantml.ai/mcp` easier to connect from agent clients through a
  dashboard setup panel, registry metadata, an npm installer scaffold, and a
  separately reviewed OAuth follow-up.
- `2026-06-29-hosted-mcp-server.md`: draft first slice for exposing the
  existing MCP tools through a hosted Streamable HTTP server at
  `https://mcp.instantml.ai/mcp`, while preserving local stdio fallback.
- `2026-06-29-agent-compare-runs-api.md`: draft read-only API for agent
  top-k/filter-based run comparison that reuses run search, summaries,
  side-by-side rows, and optional bounded series previews.

Use `PRODUCT_STRATEGY.md` as the strategic source of truth. The current strategy positions the product as InstantML: a general training-loop observability product and W&B-style competitor. If a design doc conflicts with it, update the design doc or create a superseding design before implementation.

Current strategic emphasis: beat W&B for smaller startups, labs, and lean ML teams on speed, UI quality, and predictable pricing. The current public tier model is Free, Pro, and Premium, with Stripe-backed payment collection for paid signup and plan changes plus blocked-at-limit usage guardrails. Metric-point and API-request limits are scoped to the current UTC calendar month and reset on the first day of the next month; storage/project/run quotas are retained-resource posture. Free/non-billable API request overage is blocked, paid Pro/Premium request overage is Stripe-metered, and paid storage overage is reported as current-month high-water retained GiB deltas. The Rust/ClickHouse design is accepted for the backend foundation path, and the implemented default backend now uses Rust with ClickHouse for metadata and ClickHouse for metric time series.

Backend direction:

```text
Default:    apps/web + packages/python-sdk -> apps/rust-server -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
Deprecated: apps/web + packages/python-sdk -> apps/server -> JSON/local artifacts
```

Future backend design docs should build on `2026-05-14-clickhouse-only-storage.md`, `2026-05-16-multi-instance-control-data-plane.md`, `2026-05-16-cloud-run-multi-instance-launch.md`, `2026-05-16-pricing-signup-org-admin.md`, `2026-05-21-cloudflare-r2-artifact-storage.md`, `2026-05-21-stripe-billing-platform.md`, and the current architecture summary: `axum + tokio + ClickHouse`, ClickHouse-backed operational records and metric time series, org-scoped tenant data, hashed API keys, maintained metric summaries, bounded chart queries, local development artifact storage plus Cloudflare R2 hosted artifact storage, split service-plane roles for hosted control/data rollout, HTTPS-only public routing, payment-verified paid signup, plan-aware signup that preserves existing tenant routes, and explicit compatibility checks against the deprecated Node server before route-shape changes. Do not treat deterministic full replay, data-plane full control refresh, split Cloud Run services, Cloud Run session affinity, or Cloud Run `maxScale=1` as sufficient for shared multi-instance write correctness.

Create a design doc before changing:

- Backend APIs
- Database schemas
- SDK public interfaces
- Frontend screens with data dependencies
- Importers/exporters
- Storage paths
- Authentication or authorization
- Performance-sensitive workflows
- Cross-component contracts

Use `TEMPLATE.md` as the starting point.

## Review Requirement

Before implementation, at least two fresh reviewers or agents with no prior context should review the design for:

- Simplicity
- Performance
- Correctness
- Maintainability
- Failure modes
- Smaller first slices

Record their feedback in the design doc under "Review Notes" or in a linked review file.

Current recurring review themes to check before future implementation:

- Failed API requests should not leave partial state unless explicitly documented.
- UI async loaders should be cancellation-aware.
- List/table views need explicit pagination.
- Metric step and timestamp semantics must stay consistent across SDK, Rust server, deprecated Node server, Python bootstrap API, and importers.
- Offline SDK behavior must be described exactly as implemented.
- SDK process spool events should remain one request per file unless idempotency covers every request in a wider event.
- New user-facing docs and UI should use InstantML, while legacy code identifiers remain until a namespace migration is designed.
- Hosted SaaS backend work should preserve documented API compatibility and keep shared contract tests passing against Rust and the deprecated Node server where legacy behavior matters.
- Performance-sensitive frontend work should keep hidden tab data fetches gated and panel/series requests bounded.
