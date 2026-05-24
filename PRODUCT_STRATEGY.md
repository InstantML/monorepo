# InstantML Product Strategy

## Current Plan Snapshot

Date: 2026-05-17

Working name: **InstantML**.

InstantML is a hosted SaaS-first, W&B-style training observability product for smaller startups, research labs, and lean ML teams. The product should win on three axes:

1. **Speed**: faster SDK hot paths, faster run summaries, faster metric charts, and less waiting while comparing experiments.
2. **UI quality**: a calmer, denser, more legible daily workflow for training-run comparison.
3. **Pricing**: predictable pricing for small teams, with lower-friction tiers than W&B and no tracked-hour billing in v1.

The near-term product bet:

> Build the training observability tool a small serious ML team wants open all day: fast logging, fast comparison, clear artifacts, simple pricing, and a backend/data model teams can trust.

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
- Rust/ClickHouse server is the current primary API and storage backend.
- Next/React frontend is the current UI.
- Python SDK supports run creation, scalar metrics, searchable tags/notes, typed helpers, buffering, explicit `flush()`, offline replay for post-run-create events, process-isolated post-init upload spooling, source metadata, artifacts, checkpoints, rollouts, tables, and local file upload.
- Server supports typed attributes, maintained metric aggregates, side-by-side comparison, local artifact upload/download, strict org/API-key scopes, blocked-at-limit usage guardrails, trigger-backed run search text, and Neptune/W&B/MLflow JSON imports.
- UI supports tabbed run browsing, a W&B/Grafana-inspired Runs workspace with sections and movable/resizable line panels, chart smoothing, step/time x-axis, grouped averages, range zoom, point hover readouts, saved local views, tags/notes editing, artifact previews, checkpoints, rollouts, keyboard workflow shortcuts, side-by-side diffs, signup plan selection, token-backed org invites, topbar and Settings usage visibility, and API-key management.
- Rust/ClickHouse backend is implemented as the primary backend under `apps/rust-server`, with ClickHouse operational records, ClickHouse metric storage, health/readiness/metrics/OpenAPI endpoints, hosted API-key auth, project/run/scalar metric compatibility routes, maintained summaries, idempotency, typed attributes, artifacts, imports, export, usage, plan-aware signup, token-backed organization invitations, invited-member activation, tenant-route warehouse profile metadata, and Rust contract/SDK/UI smokes.

Target stack snapshot:

- API/runtime: Rust with `axum`, `tokio`, `tower-http`, explicit service/store modules, structured tracing, and Prometheus-compatible metrics.
- Operational plane: ClickHouse-backed low-volume records for users, identities, organizations, memberships, service accounts, API keys, projects, runs, attributes, artifacts, imports, idempotency, audit events, and immutable daily usage rollups.
- Analytical plane: ClickHouse `metric_points` (MergeTree) and `metric_series` (AggregatingMergeTree, populated by a materialized view) for high-volume metric time series and fast summary/chart queries.
- Artifact plane: local filesystem storage for development and Cloudflare R2-backed private per-org buckets for hosted artifact bytes, with ClickHouse retaining artifact references, sizes, hashes, and MIME metadata.
- Auth plane: managed Google login for humans plus database-owned memberships, service accounts, hashed API keys, scopes, project restrictions, and audit events.
- Hosting preference: Google Cloud Run or equivalent container hosting for Rust services, InstantML-owned ClickHouse on Google Cloud for the current hosted beta, Cloudflare R2 for object storage, and Clerk or an equivalent managed auth provider for organizations and identity. Managed ClickHouse-compatible and customer-owned ClickHouse remain future/Enterprise deployment options when their cost and isolation tradeoffs are justified.
- Migration rule: Node is deprecated and retained as the compatibility oracle, JSON migration source, and legacy fallback. New backend work defaults to Rust/ClickHouse; route-shape changes should still run Node compatibility checks before breaking old clients.

Current hosted performance signal:

- On 2026-05-23, the self-hosted GCP ClickHouse path passed the hosted
  read-path benchmark against the `normal-runs-50k` showcase project: 50,000
  runs and 522,000,000 metric points.
- Project read p95s were `236 ms` for newest-100, `307 ms` for metric-best
  sort, `418 ms` for overview, and `224 ms` for a 1,000-point chart response
  from a 20,000-step source series.
- This makes self-hosted GCP ClickHouse the preferred beta path forward for
  InstantML-owned hosted storage. The remaining product risk is operational,
  not basic query viability: backups, monitoring, disk capacity, and HA need to
  mature before broad paid launch.

## Product Positioning

### Working Positioning

Training observability for small ML teams that want W&B-like value with faster comparison workflows, simpler pricing, and clearer control over their experiment data.

### One-Sentence Pitch

InstantML helps small ML teams log, compare, debug, and reproduce training runs faster than heavyweight trackers, with predictable pricing and a data model they can trust.

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

InstantML should become the product that feels smaller in the right ways:

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

InstantML should stay focused on training unless users clearly pull it toward runtime observability later.

## Pricing Strategy

Research date: 2026-05-16.

W&B's public pricing page currently lists cloud-hosted Free, Pro, and Enterprise plans. It shows Pro starting at `$60/month`, up to 10 model seats, 100 GB/month storage, and additional storage at `$0.03/GB`. W&B billing docs also describe usage categories and alerts for storage, tracked hours, Weave ingestion, inference, and training.

Pluto is ambiguous in the current market scan. Pluto Bio publishes a personalized-pricing page for a hosted scientific discovery platform with Premium and Enterprise packaging, unlimited users on Premium, automated cloud pipelines, and single-tenant/multi-cloud storage on Enterprise, but it does not publish self-serve prices. Pluto's web-data/API product documentation describes a developer API for web data, embedded automations, and functions, but no official public pricing page was found in this research pass. Treat any Pluto comparison as qualitative unless the intended Pluto vendor is narrowed.

Sources:

- [W&B pricing](https://wandb.ai/site/pricing/)
- [W&B billing settings docs](https://docs.wandb.ai/platform/app/settings-page/billing-settings)

### Pricing Thesis

Use a sustainable discount, not a race to zero:

- Primary billing unit: seats plus included storage.
- Avoid tracked-hour billing in v1.
- Keep metric/event limits generous with fair-use thresholds.
- Use storage overages only when needed.
- Make Free, Pro, and Premium easy to understand at signup.
- Keep Enterprise/custom for SSO, VPC/self-host, compliance, dedicated support, and unusually heavy data footprints.

### Implemented Initial Tiers

These are the current product defaults implemented in Rust and mirrored in the deprecated Node compatibility server.

| Tier | Draft price | Included |
| --- | ---: | --- |
| Free | `$0/org/mo` | 2 seats, 2 GiB included storage, 2 projects, 100 runs, 1M metric points, 500k API requests/month, shared 8 GiB warehouse intent |
| Pro | `$199/org/mo` | 3 seats, 1 TiB included storage, 100 projects, 100k runs, 250M metric points, 25M API requests/month, standard 12 GiB warehouse intent |
| Premium | `$699/org/mo` | 10 seats, 5 TiB included storage, 500 projects, 1M runs, 2B metric points, 150M API requests/month, dedicated 16 GiB x 2 replica warehouse intent |
| Enterprise | Custom | SSO/SAML, VPC or self-host option, custom retention, compliance, dedicated support, custom warehouse and storage terms |

Overage defaults:

- Extra seats: billed through a Stripe extra-seat subscription item when an org
  reserves seats beyond the plan's included count. The price target remains
  `$79-$99/seat/month` until invoice smoke coverage is complete.
- Storage overage: paid subscriptions include a Stripe meter-backed storage
  overage item, and the server reports positive deltas of the current-month
  high-water retained-storage overage at `$0.03/GB-month` after the included
  pool, based on Cloudflare R2 Standard currently listing `$0.015/GB-month`.
- Metric/event overage: new metric writes are blocked at the current UTC calendar-month fair-use threshold until paid overages or custom terms exist. Metric-point usage resets at 00:00 UTC on the first day of each month.
- API request overage: Free is blocked at 500k requests/month. Paid Pro and
  Premium subscriptions attach Stripe metered request-overage prices at
  `$2 / 1M` Pro requests and `$1 / 1M` Premium requests after the included
  monthly allowance, reported as exact request-unit deltas.
- Project/run limits: new projects and runs are blocked at the stored plan limit.
- Import/storage-heavy workloads: require Premium or custom quote.

Current implementation status:

- The Rust/ClickHouse server exposes org usage summaries at `GET /api/usage` and versioned usage export at `GET /api/usage/export`. The deprecated Node compatibility server keeps the same route shape for comparison and migration fixtures.
- Usage is scoped by org and requires `usage:read` in hosted API-key mode.
- The summary returns the full plan catalog, current org plan, limits, overage policy, the UTC calendar-month usage period, seats, projects, runs, current-period scalar metric points, current-period API requests, billable storage/request overage fields, retained metric-point totals, retained metric series, artifacts, active API keys, exact artifact bytes, unknown artifact-byte counts, estimated metadata bytes, and blocked-at-limit storage estimates.
- Paid signup uses Stripe Checkout; existing paid plan changes, extra-seat changes, cancellation, storage/API request overage reporting, and Customer Portal use Stripe Billing APIs plus User Data billing projections. New project, run, metric-ingest, artifact, import, API-key, seat, and demo-reset writes fail with HTTP 402 and `code: "payment_required"` when the org is pending payment or payment-failed, with `code: "plan_limit_exceeded"` when current or projected usage crosses a blocked Free/Pro/Premium limit, and with HTTP 429 `code: "api_request_monthly_limit_exceeded"` when a Free or non-billable org reaches the monthly API request allowance.
- Project, run, storage, artifact, API-key, and seat counts are current retained-resource posture; they do not reset monthly except through deletion, retention, or plan changes. Metric-point and API-request counters reset monthly.
- Signup accepts `plan_tier` for Free, Pro, and Premium. Legacy plan values `lab` and `startup` canonicalize to Pro; `growth` canonicalizes to Premium for migration compatibility.
- Local InstantML and the shared `InstantML Demo` org now default to Premium so the seeded demo exercises the Premium-scale warehouse profile and does not trip Free limits.
- Hosted tenant routes record both requested warehouse profile and applied warehouse profile. The current InstantML-owned hosted path uses database-mode tenant routing on self-hosted GCP ClickHouse; legacy provider-backed `cloud-service` create bodies remain capped by operator defaults unless `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING=true`.
- The dashboard includes plan selection in signup, paid signup redirect/return handling, a compact plan usage badge in the topbar near account controls, full usage, billing, and seat controls in Settings, and API-key list/create/revoke controls in the API tab.
- These values are for pricing validation, billing operations, and debugging. Rust now writes immutable `usage_daily` snapshots, bounded API request usage rollups, Stripe billing control records, and storage/API request meter-event reports. Provider/object-store reconciliation remains a hardening item, but paid subscriptions now include the metered storage and request overage items.
- Detailed pricing and margin assumptions live in `docs/product/pricing-and-margins.md`.

### Cost Basis

Preferred first hosted stack:

- Rust API: Google Cloud Run.
- Operational and analytical storage: InstantML-owned self-hosted ClickHouse on Google Cloud for the beta hosted path.
- Artifact storage: Cloudflare R2 private per-org buckets.
- Auth: Clerk or equivalent managed auth provider.

Why:

- Cloud Run offers low-ops container hosting with request/resource billing.
- Self-hosted ClickHouse on Google Cloud keeps the beta data path fast, private to the Cloud Run VPC, and materially cheaper while workload shape is still being validated.
- Cloudflare R2 offers low-cost S3-compatible storage with free egress.
- Clerk offers managed auth, Google login, B2B organizations, and machine/API-key primitives.
- Managed ClickHouse-compatible providers can still be reconsidered for Enterprise/VPC or high-availability needs once real usage and cost data justify the extra operating expense.

Sources:

- [Google Cloud Run pricing](https://cloud.google.com/run/pricing)
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
- Add API-key auth for hosted Rust/ClickHouse ingestion.
- Add W&B dual-logging support only after import paths prove useful with real teams.

### Backend

Current backend:

- Rust API and worker service in `apps/rust-server`.
- ClickHouse operational records and ClickHouse metric store for local development; hosted control-plane/data-plane services require the follow-up coordination design.
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

Status: completed as the current planning baseline, superseded for storage by `docs/design/2026-05-14-clickhouse-only-storage.md`.

Goal:

Make the W&B competitor strategy and Rust/ClickHouse architecture explicit enough that implementation can proceed in reviewed slices.

Done when:

- Product strategy states speed, UI, and pricing as the wedge.
- Pricing research and draft tiers are documented.
- ClickHouse-only storage design exists with reviewer notes; current architecture docs describe the operational and metric layers.
- TODO is prioritized by implementation importance.
- Docs clearly say Rust/ClickHouse is primary, while Node is deprecated compatibility support.

### P1: Backend Speed And Durable SaaS Foundation

Status: foundation slice implemented and promoted to Rust/ClickHouse as the default backend after contract, SDK, UI, importer/artifact, and scale checks passed.

Goal:

Move from demo storage to a trustworthy hosted team deployment path.

Foundation completed:

- Create black-box contract tests that run against both Node and Rust backends.
- Canonize metric step and timestamp semantics.
- Add idempotency keys for process-spooled event replay.
- Implement ClickHouse operational records for orgs, users, projects, runs, attributes, artifacts, imports, API keys, and audit events, with ClickHouse schema for metric series and metric points.
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
- Harden hosted org/auth/settings UI with Stripe webhook smoke coverage, invite delivery, and org-member management beyond seat reservation.
- Add hosted import UI once that workflow is ready for beta.
- Add first-class media/table/query/text panels only after the field catalog and persisted workspace-view API are designed.
- Add URL-addressable high-value state for workspaces/fullscreen panels after the local saved-view shape stabilizes.

Exit criteria:

- A user can compare dozens of runs and understand which run is better, why, and what changed.

### P3: Pricing And Usage Metering

Goal:

Make pricing credible before public launch.

Current state:

- Free, Pro, and Premium are the active planning and implementation tiers.
- Org-level usage summaries are computed from Rust/ClickHouse data, with UTC
  calendar-month metric counters and retained-resource storage/project/run
  counters.
- Immutable `usage_daily` snapshots exist for warning/debug rollups.
- Signup records selected plan and tenant-route warehouse intent.
- Stripe Checkout/Portal handles paid signup and billing-management redirects;
  User Data stores billing projections and event idempotency records.
- The topbar and Settings expose usage; Settings exposes billing controls and
  seat invites; the API tab exposes API-key list/create/revoke.

Do next:

- Reconcile usage snapshots with object-storage accounting before treating any value as invoice truth.
- Finish live Stripe webhook/price/meter smoke automation, email delivery, and
  plan-change proration polish after the guardrail/debug usage contract
  stabilizes.
- Validate the Free/Pro/Premium thresholds against real team workloads.

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
- Keep docs aligned with implementation and InstantML user-facing language.

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

- Pro offers a substantially larger included storage pool than W&B Pro while remaining simple enough to explain in one signup card.
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

Use generous but explicit included storage, fair-use thresholds, usage dashboards, Premium/Enterprise plans for heavy teams, and warehouse profile guardrails so paid cloud services cannot be oversized by public signup alone.

### Risk: UI quality takes too long.

Mitigation:

Build narrow but polished comparison workflows. Avoid reports, org settings, and dashboard sprawl until the core app is excellent.

### Risk: Rust data stack slows feature work.

Mitigation:

Keep Node as fallback, add black-box contract tests, and implement Rust/ClickHouse in narrow reviewed slices.

### Risk: Hosted SaaS reduces trust for sensitive training data.

Mitigation:

Emphasize exportability, transparent schemas, API access, future VPC/self-host options, and clear artifact retention controls.

## Open Questions

1. Which W&B workflow should we replace first: training dashboard, artifacts, reports, sweeps, or team experiment search?
2. Should W&B compatibility be dual-logging first, import first, or API-shim first?
3. Should the first beta use shared hosted ClickHouse cells, dedicated customer services, or a hybrid based on validation and cost constraints?
4. Which managed auth provider gives enough Google/org/API-key support with the least lock-in?
5. What storage/metric limits feel generous but safe for the Pro tier?
6. What public name best conveys fast, affordable training observability?

## Final Viability Assessment

This idea is viable if it becomes a genuinely better daily training observability workflow, not merely another experiment tracker. W&B sets the mental model users know. The opening is to build a focused hosted product with faster comparisons, clearer pricing, a safer SDK hot path, and transparent storage.

The immediate work should stay practical:

- Validate the W&B replacement wedge with real users.
- Keep Rust/ClickHouse as the default backend while preserving Node compatibility tests until JSON migration is complete.
- Harden SDK run lifecycle, offline creation, summary policies, public query APIs, and rich logged objects through reviewed slices.
- Prove run browsing, search, compare, and chart performance at the 90,000-run design-partner scale.
- Treat W&B/MLflow/Neptune importers as adoption paths.
