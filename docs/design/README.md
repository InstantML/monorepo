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
- `2026-05-09-usage-metering.md`: warning-only Rust/ClickHouse usage summaries, immutable daily rollup snapshots, and Node compatibility coverage for pricing validation.
- `2026-05-09-migration-adoption-p4.md`: SDK metadata reservation, atomic importer core, Neptune hardening, and W&B JSON import first slice.
- `2026-05-09-mlflow-import-and-dual-logging.md`: MLflow JSON import follow-up and W&B dual-logging recommendation.
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
- `2026-05-16-gcp-cloud-run-rust-api.md`: internal single-instance Cloud Run deployment for the Rust API, Secret Manager, static ClickHouse egress, and local-frontend-to-hosted-API workflow.
- `2026-05-16-multi-instance-control-data-plane.md`: accepted multi-instance control/data-plane direction, central hot-path proxy rejection, single-instance guardrails, mutation gates, and deterministic operational replay first slice.

Use `PRODUCT_STRATEGY.md` as the strategic source of truth. The current strategy positions the product as InstantML: a general training-loop observability product and W&B-style competitor. If a design doc conflicts with it, update the design doc or create a superseding design before implementation.

Current strategic emphasis: beat W&B for smaller startups, labs, and lean ML teams on speed, UI quality, and predictable pricing. The Rust/ClickHouse design is accepted for the backend foundation path, and the implemented default backend now uses Rust with ClickHouse for metadata and ClickHouse for metric time series.

Backend direction:

```text
Default:    apps/web + packages/python-sdk -> apps/rust-server -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
Deprecated: apps/web + packages/python-sdk -> apps/server -> JSON/local artifacts
```

Future backend design docs should build on `2026-05-14-clickhouse-only-storage.md`, `2026-05-16-multi-instance-control-data-plane.md`, and the current architecture summary: `axum + tokio + ClickHouse`, ClickHouse-backed operational records and metric time series, org-scoped tenant data, hashed API keys, maintained metric summaries, bounded chart queries, local artifact storage first, and explicit compatibility checks against the deprecated Node server before route-shape changes. Do not treat deterministic full replay or Cloud Run `maxScale=1` as sufficient for shared multi-instance correctness.

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
