# Training Observability Product Strategy

## Current Plan Snapshot

Date: 2026-05-10

Working name: **Training Observability**.

Training Observability is a hosted SaaS-first, W&B-style training observability product for smaller startups, research labs, and lean ML teams. The product should win on three axes:

1. **Speed**: faster SDK hot paths, faster run summaries, faster metric charts, and less waiting while comparing experiments.
2. **UI quality**: a calmer, denser, more legible daily workflow for training-run comparison.
3. **Pricing**: predictable pricing for small teams, with lower-friction tiers than W&B and no tracked-hour billing in v1.

The near-term product bet:

> Build the training observability tool a small serious ML team wants open all day: fast logging, fast comparison, clear artifacts, simple pricing, and a backend/data model teams can trust.

Brand transition note:

- User-facing docs and UI should say **Training Observability**.
- Existing package names, storage paths, and compatibility identifiers such as `rl_observability`, `.rlobs`, `rlobs_api`, and `RlobsError` remain until a dedicated namespace migration is designed and tested.
- RL, robotics, and simulation remain important differentiating workflows, but they are not the brand boundary.
- Open-source, public-name, and compatibility-name policy lives in `docs/product/2026-05-09-open-source-brand.md`.

Honest validation status:

- Customer discovery, ICP, outreach copy, and interview scripts are planning artifacts only.
- No live customer outreach or interviews have been completed from this repo environment.
- Pricing, competitive, and market statements here are working hypotheses until validated with real teams.
- Public pricing and competitor comparisons must be re-verified before launch.
- The current validation plan and scorecard live in `docs/users/2026-05-09-validation-plan.md`.

Current implementation status:

- Thin SDK -> API -> storage -> UI loop exists.
- Rust/Postgres/ClickHouse server is the current primary API and storage backend.
- Next/React frontend is the current UI.
- Python SDK supports run creation, scalar metrics, searchable tags/notes, typed helpers, buffering, explicit `flush()`, offline replay for post-run-create events, process-isolated post-init upload spooling, source metadata, artifacts, checkpoints, rollouts, tables, and local file upload.
- Server supports typed attributes, maintained metric aggregates, side-by-side comparison, local artifact upload/download, strict org/API-key scopes, warning-only usage summaries, trigger-backed run search text, and Neptune/W&B/MLflow JSON imports.
- UI supports tabbed run browsing, a W&B/Grafana-inspired Runs workspace with sections and movable/resizable line panels, chart smoothing, step/time x-axis, grouped averages, range zoom, point hover readouts, saved local views, tags/notes editing, artifact previews, checkpoints, rollouts, keyboard workflow shortcuts, and side-by-side diffs.
- Rust/Postgres/ClickHouse backend is implemented as the primary backend under `apps/rust-server`, with Postgres migrations, ClickHouse metric storage, health/readiness/metrics/OpenAPI endpoints, hosted API-key auth, project/run/scalar metric compatibility routes, maintained summaries, idempotency, typed attributes, artifacts, imports, export, usage, and Rust contract/SDK/UI smokes.

Target stack snapshot:

- API/runtime: Rust with `axum`, `tokio`, `tower-http`, `SQLx`, explicit service/store modules, structured tracing, and Prometheus-compatible metrics.
- OLTP plane: managed Postgres with org-scoped UUID tables for users, identities, organizations, memberships, service accounts, API keys, projects, runs, attributes, artifacts, imports, idempotency, audit events, and immutable daily usage rollups.
- OLAP plane: ClickHouse `metric_points` (MergeTree) and `metric_series` (AggregatingMergeTree, populated by a materialized view) for high-volume metric time series and fast summary/chart queries.
- Artifact plane: local filesystem storage first behind an abstraction, then S3-compatible object storage once hosted semantics are proven.
- Auth plane: managed Google login for humans plus database-owned memberships, service accounts, hashed API keys, scopes, project restrictions, and audit events.
- Hosting preference: Google Cloud Run for the Rust API, Neon for Postgres, Cloudflare R2 for object storage, and Clerk or an equivalent managed auth provider for organizations and identity.
- Migration rule: Node is deprecated and retained as the compatibility oracle, JSON migration source, and legacy fallback. New backend work defaults to Rust/Postgres/ClickHouse; route-shape changes should still run Node compatibility checks before breaking old clients.

## Product Positioning

### Working Positioning

Training observability for small ML teams that want W&B-like value with faster comparison workflows, simpler pricing, and clearer control over their experiment data.

### One-Sentence Pitch

Training Observability helps small ML teams log, compare, debug, and reproduce training runs faster than heavyweight trackers, with predictable pricing and a data model they can trust.

### Wedge

The first wedge is not a broad MLOps platform. It is the daily training workflow:

- Log a run quickly.
- Compare many runs quickly.
- See metrics, configs, artifacts, checkpoints, source context, and differences in one place.
- Avoid unexpected cost or lock-in as the team grows.

### First Buyer And User

Initial buyer:

- Founder, research lead, or ML infrastructure owner at a small AI company.
- Staff research engineer responsible for experiment quality and reproducibility.
- ML platform engineer trying to reduce tracker cost, lock-in, or data-control risk.

Initial daily user:

- Research engineer comparing many training runs.
- Fine-tuning engineer tracking metrics, configs, checkpoints, and evals.
- RL or robotics engineer debugging stochastic runs, rollouts, and reward components.
- Open-source model or benchmark maintainer who wants portable experiment history.

## Why This Can Work

Most ML teams already understand experiment tracking. The opportunity is not education; it is replacing friction:

- W&B is powerful, but small teams can feel pricing, breadth, and workflow complexity quickly.
- MLflow is portable, but the UI can feel slow or dated for dense comparison.
- Neptune has strong metadata ideas, but its future as an independent product has changed.
- Many teams want a hosted product now and self-host/VPC/export options later for trust.

Training Observability should become the product that feels smaller in the right ways:

- Fast by default.
- Clear by default.
- Cheaper to start.
- Easier to leave.
- Focused on training, not every adjacent MLOps workflow.

## Competitive Landscape

### W&B

Why users choose it:

- Familiar experiment tracking workflow.
- Strong SDK ergonomics.
- Rich charts, artifacts, sweeps, reports, and collaboration.
- Broad integrations and community familiarity.

Opportunity:

- Beat W&B on run table and chart speed for common training workflows.
- Beat W&B on first-month and small-team pricing clarity.
- Make data ownership, export, and backend transparency first-class.
- Keep the SDK hot path lightweight and explicit.
- Serve teams that want W&B-like value without W&B-like cost or broad-platform sprawl.

Strategy:

- Do not try to match every W&B feature immediately.
- Compete first on runs, metrics, configs, artifacts, comparison, reproducibility, and speed.
- Add W&B dual-logging/import so teams can evaluate without risky migration.
- Avoid tracked-hour billing in v1.

### MLflow

Opportunity:

- Better UI for many runs and metrics.
- Better comparison and artifact workflows.
- Better hosted SaaS experience for small teams.
- Keep exportability and open schemas as trust advantages.

### Neptune

Opportunity:

- Preserve useful typed metadata concepts.
- Keep Neptune import support as a migration path.
- Do not make Neptune parity the product identity.

### LLM Observability Tools

LangSmith, Langfuse, Phoenix, and similar tools are strong for prompts, traces, evals, retrieval, and agent runtime behavior. They do not replace long-running training observability: metric streams, checkpoints, artifacts, source context, and experiment comparison.

Training Observability should stay focused on training unless users clearly pull it toward runtime observability later.

## Pricing Strategy

Research date: 2026-05-09.

W&B's public pricing page currently lists Free, Pro, and Enterprise plans. The page shows Pro starting at `$60/month`, Pro including unlimited tracked hours and 100 GB/month storage, additional storage at `$0.03/GB`, and Enterprise as custom. W&B billing docs describe usage categories including storage, tracked hours, Weave ingestion, and inference.

Sources:

- [W&B pricing](https://wandb.ai/site/pricing/)
- [W&B billing settings docs](https://docs.wandb.ai/platform/app/settings-page/billing-settings)

### Pricing Thesis

Use a sustainable discount, not a race to zero:

- Primary billing unit: seats plus included storage.
- Avoid tracked-hour billing in v1.
- Keep metric/event limits generous with fair-use thresholds.
- Use storage overages only when needed.
- Make Free/Lab/Startup easy to self-serve.
- Keep Growth/Enterprise for compliance, SSO, VPC/self-host, and support.

### Draft Planning Tiers

These are planning assumptions, not public pricing.

| Tier | Draft price | Included |
| --- | ---: | --- |
| Free | `$0` | 1 user, local/dev use, 5 GB hosted storage, capped private projects, community support |
| Lab | `$29/org/mo` including 3 seats, then `$9/seat/mo` | 100 GB storage, unlimited tracked hours, generous metric/event limits, private projects, API keys |
| Startup | `$149/org/mo` including 10 seats, then `$12/seat/mo` | 500 GB storage, longer retention, priority support, larger metric limits, imports |
| Growth | `$399/org/mo` including 25 seats, then `$15/seat/mo` | 2 TB storage, audit logs, advanced roles, longer retention, higher limits |
| Enterprise | Custom | SSO/SAML, VPC or self-host option, custom retention, compliance, dedicated support |

Overage defaults:

- Artifact/storage overage: `$0.02-$0.03/GB-month`.
- Metric/event overage: start with fair-use warnings and plan-upgrade prompts.
- Import/storage-heavy workloads: require Startup/Growth or custom quote.

Current implementation status:

- The Rust/Postgres/ClickHouse server exposes warning-only org usage summaries at `GET /api/usage` and versioned usage export at `GET /api/usage/export`. The deprecated Node compatibility server keeps the same route shape for comparison and migration fixtures.
- Usage is scoped by org and requires `usage:read` in hosted API-key mode.
- The summary counts seats, projects, runs, scalar metric points, retained metric series, artifacts, active API keys, exact artifact bytes, unknown artifact-byte counts, and estimated metadata bytes.
- These values are for pricing validation and debugging, not invoice truth. Rust now writes immutable `usage_daily` snapshots, but billable storage still requires a separate billing implementation and provider/object-store reconciliation.

### Cost Basis

Preferred first hosted stack:

- Rust API: Google Cloud Run.
- Postgres: Neon.
- Artifact storage later: Cloudflare R2.
- Auth: Clerk or equivalent managed auth provider.

Why:

- Cloud Run offers low-ops container hosting with request/resource billing.
- Neon offers managed/serverless Postgres with usage-based compute and storage.
- Cloudflare R2 offers low-cost S3-compatible storage with free egress.
- Clerk offers managed auth, Google login, B2B organizations, and machine/API-key primitives.

Sources:

- [Google Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Neon pricing](https://neon.com/pricing)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Clerk pricing](https://clerk.com/pricing)
- [Render pricing](https://render.com/pricing)
- [Fly.io pricing](https://fly.io/docs/about/pricing/)
- [Supabase pricing](https://supabase.com/pricing)

## Product Principles

1. Training loops come first.
   SDK calls must be predictable, low-overhead, and explicit. Expensive upload work should move out of the training process.

2. Speed is a product feature.
   Run summaries, metric charts, and SDK logging must be measured and optimized around real workflows.

3. UI quality is the moat.
   The core app should be fast, legible, dense, and calm. Users should understand a run, compare runs, and spot regressions without fighting the interface.

4. Pricing must be predictable.
   Small teams should understand the bill before they log a serious run. Avoid tracked-hour billing in v1.

5. Own the backend stack.
   The product needs a clear ingestion API, durable metadata store, artifact storage path, and query layer.

6. Data stays portable.
   Use understandable schemas, exportable formats, and documented APIs. Users should trust that they can leave.

7. Be W&B-compatible enough where it matters.
   Support dual logging, import, familiar SDK concepts, and mental models without blindly copying every feature.

8. Self-hosting is a trust lever, not the v1 center.
   Hosted SaaS is the initial business motion. Exportability, VPC, and future self-host options support trust.

## MVP Scope

### Python SDK

The SDK should make the common path obvious:

- `init`
- `log_metrics`
- `log_config`
- `log_text`
- `log_histogram`
- `log_file`
- `log_artifact`
- `log_checkpoint`
- `log_video`
- `log_table`
- `upload_file`
- `add_tags`
- `flush`
- `replay_offline`
- `finish`

Training-loop hot path direction:

- Keep synchronous mode simple for local development.
- Prefer `upload_mode="spool"` for long or expensive runs.
- Move artifact and file upload work outside scalar metric logging.
- Add idempotency keys before claiming stronger delivery guarantees.
- Add API-key auth for hosted Rust/Postgres/ClickHouse ingestion.
- Add W&B dual-logging support only after import paths prove useful with real teams.

### Backend

Current backend:

- Rust API and worker service in `apps/rust-server`.
- Postgres metadata and ClickHouse metric store for local and hosted development.
- Organizations, users, memberships, service accounts, API keys, and audit events.
- Maintained metric summaries for fast run tables.
- Local artifact storage behind an S3-compatible abstraction.
- Bounded, indexed query paths for tables and charts.
- Explicit ingestion contracts for metrics, attributes, artifacts, logs, and source metadata.
- Clear export path.
- Deprecated Node compatibility server in `apps/server`, backed by JSON state, remains for contract comparison, migration fixtures, and legacy fallback.

### Frontend

The frontend should be the visible moat:

- Runs table with filters, search, tags, status, config values, latest metrics, and aggregates.
- Metric charts with multi-run overlays.
- Chart axes, labels, smoothing, point hover, and step/time x-axis modes.
- Run detail with config, metadata, source context, metrics, artifacts, checkpoints, and rollouts.
- Side-by-side comparison with diff-only mode, reference run, metric/config deltas, and relative changes.
- Saved views.
- Import dry-run/import summary UI.
- Hosted org context and clean auth states after backend support exists.

### Artifacts And Reproducibility

Must-have artifact behavior:

- Upload/download real files.
- Store SHA256, size, MIME type, path, run id, artifact type, step, and metadata.
- Separate artifact upload from scalar metric hot paths.
- Show artifact browser and checkpoint timeline in the UI.

Must-have reproducibility context:

- Git commit, branch, dirty flag, and eventually dirty diff.
- Run command and entrypoint.
- Hostname and pid.
- Python version and package snapshot where practical.
- Hardware metrics and GPU/CPU memory summaries in a future slice.

## Roadmap

### P0: Strategy, Pricing, And Architecture Lock

Status: completed as the current planning baseline through `docs/design/2026-05-09-rust-postgres-backend.md`.

Goal:

Make the W&B competitor strategy and Rust/Postgres/ClickHouse architecture explicit enough that implementation can proceed in reviewed slices.

Done when:

- Product strategy states speed, UI, and pricing as the wedge.
- Pricing research and draft tiers are documented.
- Rust/Postgres foundation design exists with diagrams and reviewer notes; current architecture docs describe the ClickHouse metric plane.
- TODO is prioritized by implementation importance.
- Docs clearly say Rust/Postgres/ClickHouse is primary, while Node is deprecated compatibility support.

### P1: Backend Speed And Durable SaaS Foundation

Status: foundation slice implemented and promoted to Rust/Postgres/ClickHouse as the default backend after contract, SDK, UI, importer/artifact, and scale checks passed.

Goal:

Move from demo storage to a trustworthy hosted team deployment path.

Foundation completed:

- Create black-box contract tests that run against both Node and Rust backends.
- Canonize metric step and timestamp semantics.
- Add idempotency keys for process-spooled event replay.
- Implement Postgres schema for orgs, users, projects, runs, attributes, artifacts, imports, API keys, and audit events, with ClickHouse schema for metric series and metric points.
- Implement maintained metric summaries.
- Add org-scoped API-key auth for SDK ingestion.
- Add managed-auth-backed user/org model.
- Add artifact storage abstraction.
- Add export path for experiment history.
- Add trigger-backed run search text for name, tags, config, and notes.
- Add Rust-backed tags/notes mutation routes used by the UI and SDK.

Exit criteria:

- A hosted team can run real projects without JSON demo storage as the hidden production database.
- Run summary and chart paths are measurably fast.
- Rust remains the default backend while the shared contract suite, SDK tests, UI smoke, importer/artifact tests, and scale smoke continue passing.

### P2: UI Quality And Daily Workflow

Goal:

Make the app feel like the reason to switch.

Current state:

- Runs workspace has a pinned summary/filter block, left run selector, sections, searchable panel canvas, top-level add-panel drawer, line-panel editing, fullscreen inspection, movable/resizable panels, and local layout persistence.
- Compare supports reference switching, diff-only mode, row and column layouts, row/run/config sorting, tags/notes/artifact context, a decision summary, and a 50-run cap aligned with the Rust side-by-side endpoint.
- Metrics and Runs charts support visible axes, point markers, hover readouts, range zoom, normalized unit-bounded metrics, smoothing, and selected-run-only plotting.
- Tags and notes are visible in run lists/workspace and editable from Run Detail and Compare.
- Keyboard MVP covers quick search, shortcut help, overlay dismissal, workspace undo/redo, run-rail collapse, focus handoff, and fullscreen panel traversal.
- Frontend fetches are tab-aware so hidden Metrics/Run Detail/Compare/Artifact surfaces do not reload on every dashboard entry.

Do next:

- Prove server-backed pagination/search/sort at the 90,000-run design-partner scale.
- Split remaining complex `apps/web/app/page.tsx` logic when a workflow justifies a dedicated container component.
- Add hosted org/auth/usage/import UI once those workflows are ready for beta.
- Add first-class media/table/query/text panels only after the field catalog and persisted workspace-view API are designed.
- Add URL-addressable high-value state for workspaces/fullscreen panels after the local saved-view shape stabilizes.

Exit criteria:

- A user can compare dozens of runs and understand which run is better, why, and what changed.

### P3: Pricing And Usage Metering

Goal:

Make pricing credible before public launch.

Current state:

- Org-level warning summaries are computed from Rust/Postgres/ClickHouse data.
- Immutable `usage_daily` snapshots exist for warning/debug rollups.
- Usage UI is not yet exposed in the hosted workflow.

Do next:

- Reconcile usage snapshots with object-storage accounting before treating any value as invoice truth.
- Add a small admin UI for the existing `GET /api/usage` summary when auth/org settings land.
- Validate the Free/Lab/Startup/Growth thresholds against real team workloads.

Exit criteria:

- Draft pricing can be tested with real teams without hand-wavy cost assumptions.

### P4: SDK, Ingestion, And Migration

Goal:

Let teams evaluate without burning their existing workflow.

Do next:

- Keep canonical importer validation shared across Neptune, W&B, and MLflow paths.
- Keep MLflow import narrow and transformed-schema based until real export fixtures prove the shape.
- Add larger malformed importer fixtures and migration-playbook examples.
- Revisit W&B dual logging only after the import path proves useful with real teams.

Exit criteria:

- A user can bring in an existing project or dual-log a new one and compare runs in the UI.

### P5: Docs, Brand, And Validation

Goal:

Validate that the wedge is real.

Do next:

- Interview W&B/MLflow/Neptune users.
- Validate pricing with small startups and labs.
- Use the validation scorecard in `docs/users/2026-05-09-validation-plan.md`.
- Keep the accepted open-source and compatibility-name policy in `docs/product/2026-05-09-open-source-brand.md` current.
- Keep docs aligned with implementation and Training Observability user-facing language.

## Differentiation

### Against W&B

- Faster daily run comparison.
- Lower and more predictable entry pricing.
- No tracked-hour billing in v1.
- Clearer SDK hot-path design.
- More transparent storage and export story.
- Focus on small teams before enterprise breadth.

### Against MLflow

- Better hosted UI for many runs and metrics.
- Better artifact and media browsing.
- More responsive table/chart workflow.
- Cleaner training observability mental model.

### Against Neptune

- Migration path without Neptune parity as the strategy.
- Strong typed metadata ideas adapted to a simpler model.
- Better fit for teams that want product direction independent of Neptune's post-acquisition future.

## Success Metrics

### Product Usage

- Time to first logged run under 10 minutes.
- Users can compare 50+ runs without UI degradation.
- Users can inspect metrics, configs, checkpoints, artifacts, and source context in one workflow.
- One real team dual-logs or imports a project.

### Speed Targets

- Run summary query p95 under 300 ms for 50 runs, 20 metrics per run, and 1,000 points per metric.
- Metric chart query p95 under 200 ms for one run/key with 1,000 points.
- Dashboard initial load p95 under 1 second for 100 visible runs after auth/session resolution.
- SDK process-spool mode avoids post-init network work in the training process.

### Pricing Targets

- Entry paid tier is clearly below W&B Pro's public monthly entry price.
- No tracked-hour billing in v1.
- Included storage is generous enough for serious small-team evaluation.
- Overage model is understandable before users hit it.

### Market Validation

These are targets, not completed claims:

- 10 user interviews completed.
- 3 teams agree to test the MVP.
- 1 real W&B, MLflow, or Neptune migration/import/dual-log evaluation.
- 5 meaningful issues or feature requests from real users.
- A clear answer on whether open source helps adoption.

## Risks

### Risk: W&B is too entrenched.

Mitigation:

Make dual-logging and import easy. Win one project or one team workflow before asking for full migration.

### Risk: We underprice heavy users.

Mitigation:

Use generous but explicit included storage, fair-use thresholds, usage dashboards, and Growth/Enterprise plans for heavy teams.

### Risk: UI quality takes too long.

Mitigation:

Build narrow but polished comparison workflows. Avoid reports, org settings, and dashboard sprawl until the core app is excellent.

### Risk: Rust data stack slows feature work.

Mitigation:

Keep Node as fallback, add black-box contract tests, and implement Rust/Postgres/ClickHouse in narrow reviewed slices.

### Risk: Hosted SaaS reduces trust for sensitive training data.

Mitigation:

Emphasize exportability, transparent schemas, API access, future VPC/self-host options, and clear artifact retention controls.

## Open Questions

1. Which W&B workflow should we replace first: training dashboard, artifacts, reports, sweeps, or team experiment search?
2. Should W&B compatibility be dual-logging first, import first, or API-shim first?
3. Should the first beta use the preferred Cloud Run, Neon, Cloudflare R2, and Clerk stack, or do validation and cost constraints point elsewhere?
4. Which managed auth provider gives enough Google/org/API-key support with the least lock-in?
5. What storage/metric limits feel generous but safe for the Lab tier?
6. What public name best conveys fast, affordable training observability?

## Final Viability Assessment

This idea is viable if it becomes a genuinely better daily training observability workflow, not merely another experiment tracker. W&B sets the mental model users know. The opening is to build a focused hosted product with faster comparisons, clearer pricing, a safer SDK hot path, and transparent storage.

The immediate work should stay practical:

- Validate the W&B replacement wedge with real users.
- Keep Rust/Postgres/ClickHouse as the default backend while preserving Node compatibility tests until JSON migration is complete.
- Harden SDK run lifecycle, offline creation, summary policies, public query APIs, and rich logged objects through reviewed slices.
- Prove run browsing, search, compare, and chart performance at the 90,000-run design-partner scale.
- Treat W&B/MLflow/Neptune importers as adoption paths.
