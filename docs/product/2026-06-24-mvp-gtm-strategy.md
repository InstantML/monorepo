# MVP GTM Strategy And Launch Readiness

Date: 2026-06-24

Status: Draft GTM and MVP launch plan for private beta.

Owner lens: Head of Product.

## Executive Summary

InstantML is close enough to start acquiring design partners now, but not yet
ready for broad public self-serve paid launch.

The MVP wedge should be narrow:

> Fast hosted training observability for small ML teams that need W&B-style
> experiment tracking, faster daily run comparison, predictable
> storage-and-usage pricing, and a safe migration path from W&B, MLflow,
> TensorBoard, and exported Neptune history.

The repo already contains more than a demo: Python SDK and CLI, Rust/ClickHouse
backend, hosted auth/billing scaffolding, rich run comparison UI, artifacts,
checkpoints, imports, public docs, and benchmark evidence. The biggest gaps are
not "build sweeps" or "copy W&B completely." The launch blockers are proof and
trust: real customer validation, real migration evidence, operational backup
gates, billing/usage reconciliation, clear claims, and a few sharp-edge fixes in
the onboarding/import/large-project workflow.

Recommended launch posture:

- Start a concierge private beta immediately with 3 to 5 design partners.
- Sell one workflow, not a platform: log/import runs, compare many runs, inspect
  configs/artifacts/checkpoints, export data.
- Defer broad platform features such as sweeps, model registry, alert engines,
  production monitoring, LLM observability, and full offline/resume parity until
  customer pull is proven.
- Gate public self-serve on backup/restore proof, Stripe/live billing smokes,
  security/data-handling readiness, invite/email reliability, import validation
  on real projects, and a clean benchmark/claims page.

## Research Scope

Repo context read:

- `PRODUCT_STRATEGY.md`
- `README.md`
- `TODO.md`
- `docs/product/README.md`
- `docs/product/pricing-and-margins.md`
- `docs/users/2026-05-09-validation-plan.md`
- `docs/architecture/current-system.md`
- `docs/architecture/current-api.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `packages/python-sdk/README.md`
- `apps/docs/README.md`
- Current public docs for pricing, benchmarks, quickstart, imports, W&B
  alternative positioning, and MLflow comparison.

External landscape checked on 2026-06-24:

- [W&B pricing](https://wandb.ai/site/pricing/)
- [W&B docs](https://docs.wandb.ai/)
- [W&B billing settings](https://docs.wandb.ai/platform/app/settings-page/billing-settings)
- [W&B artifacts](https://docs.wandb.ai/models/artifacts)
- [W&B sweeps](https://docs.wandb.ai/models/sweeps)
- [W&B reports](https://docs.wandb.ai/models/reports)
- [W&B media logging](https://docs.wandb.ai/models/track/log/media)
- [CoreWeave completes acquisition of W&B](https://www.coreweave.com/blog/coreweave-completes-acquisition-of-weights-biases)
- [Neptune transition hub](https://docs.neptune.ai/transition_hub)
- [OpenAI to acquire Neptune](https://openai.com/index/openai-to-acquire-neptune/)
- [Neptune legacy docs](https://docs-legacy.neptune.ai/about/intro/)
- [Neptune dashboards](https://docs-legacy.neptune.ai/app/custom_dashboard/)
- [Neptune export/download docs](https://docs-legacy.neptune.ai/usage/downloading_metadata/)
- [Comet pricing](https://www.comet.com/site/pricing/)
- [Comet experiment tracking](https://www.comet.com/site/products/ml-experiment-tracking/)
- [MLflow tracking docs](https://mlflow.org/docs/latest/ml/tracking/)
- [MLflow model registry docs](https://mlflow.org/docs/latest/ml/model-registry/)
- [MLflow tracing docs](https://mlflow.org/docs/latest/genai/tracing/)
- [MLflow on Databricks](https://docs.databricks.com/aws/en/mlflow/)
- [ClearML pricing](https://clear.ml/pricing)
- [Aim GitHub](https://github.com/aimhubio/aim)
- [Hugging Face Trackio](https://huggingface.co/docs/trackio/index)
- [TensorBoard quickstart](https://www.tensorflow.org/tensorboard/get_started)
- [DagsHub experiment tracking docs](https://dagshub.com/docs/feature_guide/experiment_tracking/)
- [Minfx Neptune migration offer](https://minfx.ai/)
- [Lightning Neptune migration guide](https://lightning.ai/blog/migrate-neptune-to-lightning)
- [ZenML Neptune migration positioning](https://www.zenml.io/blog/neptune-to-zenml)

## Current Product Assessment

### What Is Already MVP-Strong

InstantML already has enough product surface for a serious private beta:

- Python SDK can create runs, log scalar metrics, configs, tags, notes, rich
  objects, artifacts, checkpoints, console lines, rank metrics, and system
  telemetry.
- SDK has device login, API-key auth, buffered async logging, replay/spool
  concepts, W&B shadow logging, W&B mirror compatibility, and import CLIs.
- Rust/ClickHouse is the primary backend with org/API-key auth, maintained
  metric summaries, bounded metric series, usage guardrails, imports, export,
  artifacts, versioned artifact metadata, reports, and OpenAPI/codegen.
- Web app supports runs workspace, metrics, run detail, compare, distributed
  rank insights, imports, artifacts, reports, settings, API keys, auth, usage,
  pricing, org switching, and docs.
- Public docs already include quickstart, pricing, benchmarks, import flows,
  SDK guides, dashboard guides, and W&B/MLflow buyer-intent pages.
- Hosted benchmark evidence exists: 50,000 runs and 522M metric points stayed
  sub-second for the documented read-path cases.
- Pricing is concrete: Free, Pro, Premium, larger included storage than the
  most visible W&B Pro entry point, explicit storage/API request posture, and
  no training-duration meter in v1.

This is enough to ask real teams to try one workflow. It is not enough to imply
full W&B parity.

### What Is Not Yet Launch-Safe

The most important gaps:

1. No recorded customer validation.
   The repo explicitly says discovery and pricing are planning artifacts only.
   Do not broaden feature work before at least 8 discovery calls and 3 real
   pilots.

2. Import and dual-logging need real-project proof.
   W&B, Neptune, MLflow, and TensorBoard paths exist, but launch claims should
   be limited until at least one production-shaped W&B project and one exported
   Neptune directory are imported with warnings reviewed.

3. Hosted operations need a beta reliability gate.
   Backup/restore proof, ClickHouse disk/capacity alerts, R2 artifact
   reconciliation, and single-writer guardrails need to be recorded before
   paid self-serve.

4. Billing and usage are guardrail-credible, not invoice-truth complete.
   Stripe Checkout/Portal and usage meters exist, but provider reconciliation,
   live webhook/meter smokes, invite email delivery, and plan-change proration
   coverage remain launch hardening.

5. Docs and TODOs show some status drift.
   README/public docs say several surfaces are implemented; older component
   TODOs still mark some artifact, usage, import, and hosted workflow items as
   missing. Before public launch, run a claim audit and update stale TODOs so
   customer-facing claims match the actual shipped state.

6. SDK lifecycle parity is not complete.
   True offline run creation, disabled/no-op mode, client-generated run IDs,
   resume semantics, `define_metric`/custom x-axis summary policy, and broader
   post-hoc `Api` helpers are still open. These are not private-beta blockers
   if documented honestly, but they are W&B replacement objections.

7. Frontend scale/polish has a few visible sharp edges.
   Known issues include fixed caps in add-panel metrics and section panels,
   Compare responsiveness at high selected-run counts, quick-search scope, and
   richer server-backed filtering. These should be fixed in priority order as
   design partners hit them.

### Maturity Qualifiers

Use these qualifiers when talking to customers:

| Surface | Current status | Customer-facing qualifier |
| --- | --- | --- |
| SDK scalar logging | Beta-ready for hosted pilots. | Async logging exists, but benchmark and failure-mode evidence should be collected per pilot. |
| Offline/replay | Partial. | Post-run-create replay exists; true offline run creation is not supported yet. |
| Imports | Beta-ready as local CLI-first workflows. | Source credentials stay local; artifact bytes are not migrated automatically. |
| W&B compatibility | Evaluation bridge. | Shadow/mirror scalar flows exist; do not promise full W&B API/report/sweep parity. |
| Artifacts/checkpoints | Useful for MVP. | Versioned metadata/lineage exists, but full registry, TTL, and large multipart lifecycle should not be sold as complete platform parity. |
| Usage/billing | Guardrail-credible. | Usage counters protect limits and inform billing, but provider reconciliation and paid invoice truth need launch hardening. |
| Hosted durability | Conditional. | External pilots with non-disposable data require the Phase 0 backup/restore gate or an explicit disposable-evaluation agreement. |

## Competitive Landscape

### W&B

Verified position:

- W&B remains the dominant commercial mental model for experiment tracking.
- Current public pricing lists Pro starting at $60/month, up to 10 model seats,
  100 GB/month storage, and additional storage at $0.03/GB.
- W&B's platform is broad: experiments, sweeps, tables, artifacts, registry,
  reports, automations, media logging, Weave/LLM observability, and deployment
  adjacent surfaces.
- CoreWeave completed its acquisition of W&B on May 5, 2025 and frames the
  combination as an AI cloud platform from compute through training,
  evaluation, and monitoring.
- Current W&B billing docs say tracked hours are monitored but unlimited and
  not billed; storage, Weave ingestion, inference, and serverless training are
  the more relevant public usage categories.

Implication:

- Do not compete on breadth.
- Compete on "smaller in the right way": faster high-run-count comparison,
  clearer pricing, lighter SDK hot path, import/shadow logging, and transparent
  data/export posture.
- W&B's breadth creates a simplicity wedge, but its maturity means migration
  must be low-risk. Shadow logging and import must be core GTM assets.
- CoreWeave creates a distribution-bundling threat: W&B can ride compute,
  serverless training, inference, and monitoring procurement. InstantML should
  position as cloud-neutral experiment history for teams using AWS, GCP, Modal,
  Lambda, RunPod, local clusters, or mixed infrastructure.

### Neptune

Verified position:

- Neptune entered an acquisition agreement with OpenAI.
- Hosted Neptune SaaS was scheduled to shut down on March 5, 2026 at 10 AM PST,
  with hosted data deletion beginning at shutdown.
- New signups and trials are closed. Self-hosted customers had a separate
  transition path, and Neptune service images were scheduled to stop being
  available after March 8, 2026.
- Neptune's old product strength was metadata-first experiment tracking,
  custom dashboards, run comparison, query/export, model metadata, and
  reproducibility context.

Implication:

- As of 2026-06-24, the main hosted Neptune migration window has passed. The
  remaining wedge is "import your exported Neptune directories" and "replace
  your self-hosted Neptune workflow before it becomes stranded."
- InstantML should publish a clear Neptune Exporter import path, but should not
  market as if teams can still live-connect to Neptune SaaS.
- Former Neptune users will care about structured metadata, dashboards,
  exports, and artifact references. They are a strong ICP if we can import
  their exports cleanly.

### MLflow And Databricks-Managed MLflow

Verified position:

- MLflow remains the open-source and Databricks-native default for tracking
  plus model lifecycle.
- MLflow Tracking handles runs, params, metrics, artifacts, tracking server,
  artifact stores, and common local/remote setups.
- MLflow Model Registry provides model versioning, aliases, tags, lineage,
  annotation, and lifecycle management.
- MLflow's current AI platform surface also includes LLM/agent tracing,
  evaluation, prompt management, packaging/deployment, and managed Databricks
  workflows.

Implication:

- Do not pitch against MLflow as "open source is bad" or fight Databricks as a
  lakehouse platform. Pitch against the tracker workflow pain for teams outside
  Databricks or teams that want a faster hosted comparison UI without operating
  the stack.
- Keep MLflow import and coexistence credible. MLflow users trust portability
  and will reject lock-in language quickly.

### Comet

Verified position:

- Comet offers ML experiment tracking, model management/registry,
  visualizations, code panels, LLM evaluation/Opik, self-host, and enterprise
  packaging.
- Current public pricing shows a $19/user/month Pro plan for ML experiment
  management with up to 10 users and 1,500 training hours included; the same
  pricing page also exposes Opik observability packaging.

Implication:

- Comet undercuts InstantML's current Pro plan on visible seat price. InstantML
  should not lead with "cheaper than everyone."
- Lead with predictable org-level pricing, larger included storage, no
  training-duration meter, fast run comparison, and data portability.
- If price objections are frequent, test a lower beta Team tier or an annual
  design-partner discount without changing the public plan architecture yet.

### ClearML

Verified position:

- ClearML is broad and open source: experiment management, datasets, artifacts,
  pipelines, agents, CI/CD, reports, orchestration, model repository, and
  infrastructure control.
- Current public pricing lists Community at $0 for up to 3 users and Pro at
  $15/user/month plus usage, with additional artifact storage, metric-event,
  API-call, and application-hour costs.

Implication:

- ClearML wins when the buyer wants an AI infrastructure control plane.
- InstantML wins when the buyer wants a focused hosted tracker with excellent
  comparison UX and low operational burden.

### Aim

Verified position:

- Aim is open-source and self-hosted, focused on a performant UI for exploring
  and comparing tens of thousands of training runs.

Implication:

- Aim is close to InstantML's speed/UI wedge, but not a hosted SaaS product.
- Position InstantML as hosted, team-ready, import-ready, billing-aware, and
  supportable while respecting Aim as a credible self-host alternative.

### Hugging Face Trackio

Verified position:

- Trackio is a lightweight, free experiment tracking Python library built on
  Hugging Face Datasets and Spaces.
- It is API-compatible with `wandb.init`, `wandb.log`, and `wandb.finish`, runs
  locally by default, can log to Hugging Face Spaces for free, and is explicit
  that it is lightweight rather than fully featured.

Implication:

- Trackio is a real bottom-up threat for "free, local, drop-in" trials,
  especially in Hugging Face-native fine-tuning workflows.
- InstantML should not try to out-free Trackio. Win on hosted team workflow,
  private/customer-controlled data posture, high-run-count comparison, imports,
  export, support, usage controls, and artifacts/checkpoints beyond the
  lightweight local dashboard.

### TensorBoard, DagsHub, DVC, Lightning, ZenML, GoodSeed, Minfx

Verified position:

- TensorBoard remains a widely adopted baseline for local scalar/image/graph
  visualization.
- DagsHub builds experiment tracking on MLflow compatibility and Git/data
  workflows.
- Lightning, ZenML, GoodSeed, Minfx, Comet, MLflow, W&B, and others are
  explicitly showing up in Neptune migration resources or search results.

Implication:

- Buyer attention around Neptune migration is fragmented. A crisp import guide
  and a credible hosted demo matter more than a generic "experiment tracking"
  page.
- TensorBoard import/sync is a strong bottom-up adoption bridge. Many teams can
  try it without touching current W&B/MLflow usage.

## ICP And Segmentation

### First Beachhead

For the first 15 to 30 outbound messages, narrow the ICP to:

- Commercial AI startups with 2 to 20 ML practitioners.
- Already using W&B, Comet, TensorBoard, or MLflow.
- Comparing 50+ training runs in a typical project.
- Experiencing at least one of: slow many-run comparison, storage/cost
  confusion, import/export/data-control concerns, or artifact/checkpoint
  friction.
- Able to try a Python SDK or import path without procurement.

This beachhead keeps the first GTM loop measurable. Former Neptune users,
research labs, and open-source maintainers remain valuable secondary channels,
but they should not dilute the first outbound sprint.

### Primary ICP

Small serious ML teams with 2 to 20 practitioners:

- AI startups fine-tuning or training models.
- Robotics, RL, autonomy, and simulation-heavy teams.
- ML platform owners at startups who inherited W&B, MLflow, or Neptune and
  feel the pain from cost, UI speed, or data control.
- Commercial research labs only when they have budget, privacy, data-control,
  or self-host migration pain.

Common traits:

- Already understand experiment tracking.
- Compare 50+ runs often.
- Need metrics, configs, tags, notes, artifacts, checkpoints, and source context
  in one workflow.
- Have a current tool but do not love it.
- Can run a Python SDK and try a project without procurement.

### Secondary ICP

- Former Neptune users with exported Parquet/directories.
- MLflow users who want a better hosted UI while keeping their history
  portable.
- TensorBoard users who outgrew local event files.
- Open-source maintainers who want shareable experiment history.
- Academic labs as credibility/proof sources, not the default paid motion.

### Non-ICP For MVP

Avoid spending GTM energy on:

- Enterprises that need SSO/SAML, SOC 2 packet review, VPC procurement, audit
  controls, and legal review before any pilot.
- Teams primarily buying orchestration, pipelines, feature store, model serving,
  production monitoring, or LLM trace observability.
- Teams that are happy with W&B and have no speed, pricing, migration, or data
  control pain.
- Teams that require fully offline run creation before any network call.

## MVP Definition

### Must Ship For Private Beta

These are already present or need only hardening:

- Hosted signup/login, API key creation, and SDK device login.
- Python SDK quickstart: `init`, `log`, `finish`, tags, notes, configs, scalar
  metrics.
- W&B shadow/mirror path for low-risk evaluation.
- Import dry-run/commit for at least W&B and Neptune Exporter, with MLflow and
  TensorBoard available as secondary paths.
- Runs workspace with fast run list, search, sort, selected-run charts, and
  compare.
- Run detail with source context, configs, metrics, logs, artifacts,
  checkpoints, and files.
- Export path for selected data.
- Usage/plan visibility so design partners understand guardrails.
- Public docs for quickstart, imports, pricing, limits, benchmark evidence, and
  troubleshooting.
- Support loop: founder onboarding, shared Slack/email, response SLA for beta.
- A beta known-limitations page covering offline/resume limits, import
  artifact-byte limits, billing guardrails, data deletion/export, and support
  expectations.
- Weekly smoke checklist for clean signup-to-first-run, batch metric ingest,
  W&B mirror, import dry-run, export, artifact upload/download, invite
  acceptance, and dashboard compare.
- Lightweight security/privacy check before proprietary external data:
  cross-org auth tests pass, API-key revoke/scope tests pass, invite token
  expiry/revocation is verified, artifact downloads require authorization, and
  current secret/IAM bindings are reviewed.
- For non-disposable customer data, the Phase 0 backup gate must pass: backup
  job/snapshot policy, backup age alert, restore drill, and sampled artifact
  metadata-to-object check. If this is not complete, label the pilot as a
  disposable/concierge evaluation and ask the team to keep their source tracker
  as the source of truth.

### Must Ship Before Public Self-Serve Paid Launch

- Backup job or snapshot policy plus restore drill evidence for the current
  ClickHouse cell.
- Hosted cell capacity snapshot: Cloud Run, Cloud SQL, ClickHouse, R2, backups,
  active org count, and p95 routes.
- End-to-end billing matrix: Checkout, webhook idempotency, failed-payment
  lock/unlock, Portal, plan change, cancellation, extra seats, storage/API meter
  events, provider reconciliation, and customer-facing copy for guardrails vs
  invoice truth.
- Invite email delivery proven in production and staging.
- Billing/usage copy clearly labels what is invoice truth vs guardrail data.
- Security and data-handling readiness: tenant isolation tests, API-key
  scope/revocation checks, session/origin protection, invite token lifecycle,
  artifact authorization and safe headers, secret/IAM review, retention,
  deletion, export process, privacy policy, and terms.
- Import proof from at least one real W&B project and one real Neptune Exporter
  directory.
- Claim audit across `PRODUCT_STRATEGY.md`, public docs, root README, TODOs,
  and pricing pages.
- Fresh W&B benchmark rerun or conservative benchmark wording that avoids a
  blanket "faster than W&B" claim.
- Incident/support runbook: data deletion, export recovery, API request IDs,
  status page or at least a public support channel.

### Explicitly Not MVP

- Sweeps/agents.
- Full model registry lifecycle.
- Production model monitoring.
- LLM tracing/evaluation platform.
- Alert rule engine and webhook automations.
- Dataset registry.
- Full offline run creation and sync.
- Complete W&B report/sweep/launch parity.
- Server-side hosted vendor credential pulls.
- Multi-writer shared data cells.
- SOC 2, SAML, procurement-ready Enterprise motion.

## Feature Gap Prioritization

| Priority | Gap | Why it matters | MVP action |
| --- | --- | --- | --- |
| P0 | Customer validation | No real interviews or pilots are recorded. | Run 8 discovery calls and onboard 3 design partners before building broad new surfaces. |
| P0 | Import proof | Migration is the safest wedge against W&B/Neptune inertia. | Concierge-import one W&B project and one Neptune Exporter directory; document warnings and fixes. |
| P0 | Hosted backup/restore | Paid customers will ask if experiment history is durable. | Complete the Phase 0 backup gate and record restore evidence. |
| P0 | Billing/live usage hardening | Public Pro/Premium cannot rely on guardrail estimates. | Run Stripe webhook/meter smokes and label usage truth clearly. |
| P0 | Security/data handling | Proprietary runs need a minimum trust bar before external pilots. | Verify tenant isolation, API-key scopes, invite tokens, artifact auth, secret bindings, retention, deletion, and export posture. |
| P0 | Onboarding reliability | First 10 minutes determine activation. | Smoke hosted signup, device login, SDK key, first run, first chart, W&B mirror, and export weekly. |
| P0 | Claims audit | Current docs/TODOs conflict in places. | Reconcile stale TODOs and public claims before launch announcement. |
| P1 | SDK lifecycle clarity | W&B users expect resume/offline/no-op semantics. | Document current limits; add disabled/no-op mode and client run IDs before broad launch if design partners ask. |
| P1 | Public API helpers | Notebook users need post-hoc reads. | Add `Api.run()`, `Run.history()`, artifact listing/download, and export helpers after the route design is accepted. |
| P1 | Frontend scale sharp edges | High-run-count UX is the wedge. | Fix add-panel full metric search, section panel caps, quick-search scope, and Compare high-count ergonomics in response to beta usage. |
| P1 | Pricing objection handling | Comet, ClearML, and Trackio create low/free visible anchors. | Keep public tiers, but offer beta credits/discounts and sell storage-rich predictable team workflow. |
| P2 | Artifact parity | Artifact versions/lineage/status claims need one canonical truth. | Finish status audit, then decide whether to expose registry-like controls later. |
| P2 | Sweeps/alerts/registry | Common in W&B, but not needed to prove the wedge. | Defer until at least 3 design partners ask for the same workflow. |

## GTM Strategy

### Positioning

Primary statement:

> InstantML is fast hosted training observability for small ML teams that want
> W&B-like experiment tracking, faster many-run comparison, predictable
> storage-and-usage pricing, and portable experiment history.

Supporting claims:

- Compare many runs quickly.
- Keep metrics, configs, tags, notes, artifacts, checkpoints, logs, and source
  context together.
- Evaluate safely through W&B shadow logging and local-first imports.
- Understand usage and pricing before the project grows, with no
  training-duration meter in v1.
- Export data through documented APIs and schemas.

Avoid:

- "Full W&B replacement."
- "Faster than W&B" as a blanket claim.
- "Neptune migration" language that implies live Neptune SaaS access still
  exists after March 5, 2026.
- Enterprise compliance promises before the operational and legal surface is
  real.

### Offer

Private beta offer:

- Free 30-day design partner pilot.
- Concierge setup call.
- One imported historical project or one W&B-shadowed active project.
- Founder support channel.
- Export guarantee: if they churn, help them export data.
- Discounted first 6 months of Pro or Premium for teams that complete a real
  pilot and provide feedback.

The offer should ask for something concrete in return:

- One real project with at least 100 runs or 10M metric points, or a convincing
  equivalent for the team's workload.
- Weekly feedback for 3 weeks.
- Permission to use an anonymized quote if the pilot works.
- Agreement to discuss paid conversion at the end.

### Channels

1. Founder-led outbound.
   Target 40 teams, but start with the first beachhead:
   - First 20: commercial AI startups already using W&B, Comet, TensorBoard, or
     MLflow with 50+ runs and speed/cost/storage/export pain.
   - Next 10: platform owners at small companies with MLflow or custom tracker
     UI pain.
   - Next 5: verified exported or self-hosted Neptune users.
   - Next 5: RL/robotics/fine-tuning teams with many-seed workflows.

2. Migration content.
   Publish and keep current:
   - "Import W&B runs into InstantML."
   - "What to do with exported Neptune data after shutdown."
   - "InstantML vs MLflow for hosted experiment comparison."
   - "Predictable storage-and-usage pricing for experiment tracking."
   - "InstantML vs Trackio for hosted team experiment tracking."

3. Product-led docs.
   The quickstart should remain the main conversion path. Every page should
   push toward one of three actions: log a first run, import a project, or book
   a migration call.

4. Community launch after proof.
   HN, Reddit, and ML Twitter should wait until at least one design partner has
   completed a real workflow. Community attention without proof will mostly
   produce feature-parity objections.

5. Partner surface later.
   GPU clouds, fine-tuning platforms, and open-source examples are promising,
   but only after the core pilot funnel works.

### Sales Motion

Use a founder-led product-qualified motion:

1. Discovery call: confirm current tracker, project size, pain, and migration
   risk.
2. Technical setup: device login or API key, one training script, or one import.
3. Workflow review: compare runs live with the user.
4. Commitment ask: continue shadow logging or import a larger project.
5. Conversion ask: Pro/Premium, beta discount, or custom terms.

Do not run an enterprise procurement motion yet. Enterprise conversations are
useful for learning, but they should not pull the roadmap into SAML/VPC/SOC 2
before the SMB/team wedge is validated.

## GTM Execution Pack

### Pilot Qualification Rubric

Only accept design partners that can prove or falsify the wedge. A friendly
team with no real tracker pain is useful for demos, but not for launch
validation.

Required:

- Uses W&B, Comet, MLflow, TensorBoard, Neptune exports, or a custom tracker
  today.
- Has at least one active or recent project with 50+ runs, or expects to reach
  that within 30 days.
- Has one owner who can edit a training script, run the CLI, or provide an
  export directory.
- Can evaluate on non-production-critical data unless the Phase 0 durability
  gate is complete.
- Agrees to one kickoff, one workflow review, and one conversion/retrospective
  call.

Strong signals:

- Team complains about slow run tables, chart loading, search, or comparison.
- Team has storage/cost confusion or wants fewer pricing dimensions.
- Team has W&B lock-in concern but does not want a risky migration.
- Team has exported Neptune history or self-hosted Neptune risk.
- Team needs artifacts/checkpoints visible beside metrics and configs.
- Team wants a hosted tool but still cares about export and transparent schema.

Disqualifiers for the first 30 days:

- Procurement/security review is required before any pilot.
- Primary need is production model monitoring, prompt tracing, orchestration,
  sweeps, registry, or dataset management.
- The team cannot provide a real project, export, or current training script.
- The team needs true offline run creation before the first network call.
- The team expects a free unlimited hosted service with no feedback commitment.

Score each candidate before offering a pilot:

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Many-run pain | Fewer than 20 runs, rare comparisons | 20-50 runs or occasional comparisons | 50+ runs and weekly/daily comparisons |
| Current-tool pain | No pain | Mild cost/setup annoyance | Clear speed, UI, pricing, migration, or trust pain |
| Activation access | No script/export access | Needs another teammate | Can install SDK or run import this week |
| Buyer signal | User only, no budget path | Influencer | Founder, lead, platform owner, or budget holder |
| Wedge fit | Wants broad MLOps | Mixed needs | Training observability is the acute problem |

Accept pilots scoring 7+ out of 10. Keep lower-scoring teams as discovery
calls or waitlist leads.

### Funnel Hypothesis

First 30 days:

| Step | Target | Notes |
| --- | ---: | --- |
| Outbound targets researched | 40 | Start with the first beachhead; do not spend equal time across all segments. |
| Personalized messages sent | 25 | Keep 15 in reserve after the first response pattern is visible. |
| Positive replies | 6-10 | A lower rate means the pain or targeting is off. |
| Discovery calls | 5-8 | Count only calls with current tracker users. |
| Qualified pilots | 3 | Each must have a real project/script/export. |
| Activated pilots | 2 | Activated means first run or import plus dashboard review. |
| Paid-intent conversations | 1-2 | Written intent, budget owner interest, or willingness to convert after blockers. |

If reply rate is below 15%, revise the message and target list before sending
the remaining 15 messages. If reply rate is healthy but activation is weak,
prioritize onboarding/import fixes over new channels.

### Discovery Call Script

The first call should diagnose the current workflow, not pitch the roadmap.

Ask:

1. What do you use today for experiment tracking?
2. How many runs are in a normal project, and how many do you compare at once?
3. When was the last time the tracker slowed down a decision?
4. What is hard to find later: configs, metrics, source context, artifacts,
   checkpoints, logs, notes, or owners?
5. Do costs feel predictable before a big experiment batch?
6. Have you ever imported, exported, dual-logged, or migrated tracker data?
7. What would make a replacement safe to test on one project?
8. Which existing workflow must InstantML not break?
9. What would make you pay after a 30-day pilot?

End with a narrow proposed pilot:

```text
It sounds like the sharpest test is <workflow>. I would propose a 30-day pilot:
we either shadow-log one active script or import one historical project, then
review whether InstantML makes run comparison faster and clearer. If it does
not, we help you export anything you logged. Does that feel worth trying?
```

### Outbound Message Pack

Keep the ask small and concrete. Do not lead with a feature list.

W&B/Comet speed or pricing pain:

```text
Subject: quick question on experiment tracking at <team>

Hey <name>, I am building InstantML, a hosted training observability tool for
small ML teams that compare lots of runs.

The wedge is simple: faster many-run comparison, local-first W&B import/shadow
logging, and predictable storage/usage pricing.

If your team has ever waited on run tables/charts or had trouble reasoning
about tracker usage, could I ask you 5-6 workflow questions? Not a pitch; I am
trying to map where W&B/Comet-style tracking breaks for serious small teams.
```

MLflow/custom tracker UI pain:

```text
Subject: MLflow run comparison question

Hey <name>, I am researching where MLflow or custom experiment tracking gets
painful once a project has dozens or hundreds of runs.

InstantML is a hosted tracker focused on fast run comparison, artifacts,
checkpoints, and exportable history. I am not trying to replace the value of
open-source MLflow; I am trying to understand when teams want a faster hosted
UI around the training loop.

Could I ask you a few questions about your current comparison workflow?
```

Neptune exported-data path:

```text
Subject: Neptune export migration question

Hey <name>, I saw that many Neptune users are deciding what to do with exported
experiment history after the hosted shutdown.

InstantML has a local-first Neptune Exporter import path. I am looking for a
few teams willing to test one exported project and tell us where the mapping is
wrong or useful.

If you have a Neptune export or self-hosted migration risk, could I ask what
you are moving to and what metadata you cannot afford to lose?
```

Follow-up after no reply:

```text
Quick bump. The specific thing I am trying to learn is whether fast comparison
of 50+ training runs plus import/shadow logging is enough to make a small ML
team try a new tracker for one project.

Worth a 15-minute workflow chat, or not a pain for your team right now?
```

### Pilot Operating Checklist

Before kickoff:

- Confirm source tracker, project size, run count, metric count, artifact needs,
  current pain, and data sensitivity.
- Decide pilot mode: SDK first run, W&B shadow logging, W&B import, Neptune
  import, MLflow import, or TensorBoard sync.
- Confirm whether data is disposable evaluation data or requires Phase 0
  durability gates.
- Share the beta known-limitations page.
- Create support channel and name the owner on both sides.

Day 0:

- Create/sign in to workspace.
- Create or confirm SDK key/device login.
- Log first run or run import dry-run.
- Open Runs, Metrics, Run Detail, Compare, Artifacts/Files, and Export.
- Capture activation time and first error.

Day 7:

- Review whether the run table, search, charts, and compare answered a real
  decision faster than the current tool.
- Review import warnings or shadow-logging gaps.
- Classify blockers as must-fix, can-document, or non-MVP.

Day 21:

- Ask whether they would continue for the next project.
- Ask what plan/price would feel fair.
- Ask what would block team rollout.
- Request anonymized quote or refusal reason.

Pilot success is not "they liked the demo." A pilot succeeds when a team uses
InstantML to make one real experiment decision or commits to shadow logging the
next real project.

### Objection Handling

| Objection | Response |
| --- | --- |
| "Why not just W&B?" | Use W&B if it works. InstantML is for teams that want a faster, calmer many-run comparison workflow, exportable history, and a lower-risk evaluation path through import/shadow logging. |
| "Why not Trackio?" | Trackio is excellent for free/local/drop-in trials. InstantML is for hosted team workspaces, private/supportable data workflows, imports, artifacts/checkpoints, usage controls, and high-run-count dashboard comparison. |
| "Why not MLflow?" | MLflow is a strong open-source and Databricks-native platform. InstantML is for teams that want a hosted tracker-first UI without operating the stack or buying into a lakehouse workflow. |
| "Is this cheaper?" | Not always on entry price. The promise is predictable training-observability pricing, larger included storage on Pro, fewer usage dimensions to reason about, and no training-duration meter in v1. |
| "Can we trust hosted storage?" | For private beta, non-disposable customer data requires the Phase 0 backup/restore gate; otherwise the pilot is explicitly evaluation-only and the source tracker remains the source of truth. Export is part of the pilot promise. |
| "Do you support sweeps/registry/alerts?" | Not as the MVP wedge. If that is the deciding workflow, capture it as roadmap evidence; do not contort the pilot into a platform sale. |

### Launch Assets Backlog

Private beta assets:

- Beta known-limitations page.
- Design partner pilot one-pager.
- Clean-account quickstart with device login and API key fallback.
- W&B shadow logging guide.
- W&B import guide.
- Neptune Exporter import guide.
- MLflow/TensorBoard coexistence guide.
- Support and export promise.
- Internal pilot scorecard template under `docs/users/`.

Public self-serve assets:

- Conservative benchmark page with latest dated evidence and no blanket speed
  claim.
- Pricing page explaining storage, API requests, metric-point guardrails, and
  no training-duration meter.
- Security/data-handling page covering tenant isolation, API keys, artifact
  downloads, retention, deletion, and export.
- Status/support route or public support channel.
- Comparison pages: W&B alternative, InstantML vs MLflow, InstantML vs Trackio,
  Neptune exported-data migration.
- Changelog/release notes for beta reliability fixes.

## 30/60/90 Day Plan

### Days 0-14: Launch Readiness

Goals:

- Make the private beta safe enough to invite real teams.
- Remove ambiguous claims.
- Prepare design-partner outreach.

Work:

- Complete claim audit across public docs, README, TODOs, and product strategy.
- Run hosted smoke: signup, login, device login, first SDK run, W&B mirror,
  W&B import dry-run, Neptune Exporter dry-run, dashboard compare, export.
- Record backup/restore status for the current ClickHouse path. If the Phase 0
  gate is missing, early pilots must be disposable evaluations with the source
  tracker retained as source of truth.
- Run the private-beta security/privacy checklist: tenant isolation, API-key
  scopes/revocation, invite token lifecycle, artifact auth, export/deletion
  posture, and secret/IAM review.
- Confirm Resend/invite email secret bindings in prod and staging.
- Create a short "Design Partner Pilot" doc and email template.
- Identify 40 outbound targets and send 15 initial messages.

Exit criteria:

- 3 qualified calls scheduled.
- Hosted first-run path works from a clean account.
- Public docs have no obvious overclaims.
- Support owner and response path are explicit.
- Beta known-limitations page is ready for design partners.

### Days 15-30: Concierge Private Beta

Goals:

- Prove one active logging workflow and one migration workflow.
- Learn whether speed/UI/pricing wedge resonates.

Work:

- Onboard 3 design partners.
- Import at least one W&B project or shadow-log one active W&B project.
- Import at least one exported Neptune project if available.
- Capture activation times: signup to first run, first chart, first compare.
- Capture blocker tickets and classify as docs, SDK, backend, UI, or trust.
- Fix P0 activation/import blockers immediately.
- Run weekly private-beta smokes for signup, SDK logging, batch ingest,
  process-spool replay where relevant, import dry-run/commit, export, R2
  artifact upload/download, invite acceptance, and dashboard compare.

Exit criteria:

- 2 teams log or import real runs.
- 1 team compares at least 50 runs in the app.
- 1 team says they would keep using it for a real project if top blockers are
  fixed.

### Days 31-60: Beta Expansion

Goals:

- Turn learnings into a repeatable acquisition funnel.
- Strengthen proof gates.

Work:

- Publish updated W&B alternative, Neptune exported-data, and MLflow comparison
  docs with conservative claims.
- Add or improve the highest-value SDK/API helpers requested by beta teams.
- Fix the top large-project UI sharp edges hit in pilots.
- Run a fresh hosted benchmark and update the public benchmark page.
- Add migration examples from anonymized real import warnings.
- Start a small waitlist/community launch only if private beta evidence is
  positive.

Exit criteria:

- 5 active beta workspaces.
- 3 teams have imported, shadow-logged, or logged real workloads.
- 2 teams discuss paid conversion or an annual pilot.
- No P0 data-loss, auth, billing, or import correctness issues open.

### Days 61-90: Paid Beta Or Public Waitlist

Choose one path based on evidence.

Paid beta if:

- At least 2 teams would pay for Pro/Premium or custom beta terms.
- Backup/restore and billing smokes are done.
- Import/dual-log claims are backed by real projects.
- Activation is consistently under 15 minutes for clean first runs.

Public waitlist if:

- Users like the idea but do not activate.
- Import/dual-log is too brittle.
- Hosted trust or billing remains fuzzy.
- The top ask is a non-MVP platform feature such as sweeps or registry.

Work for paid beta:

- Convert 2 to 3 teams.
- Keep beta discount explicit and time-bound.
- Add lightweight status/support communication.
- Complete billing matrix before charging self-serve paid plans; concierge
  invoicing or manually reviewed Stripe subscriptions can bridge earlier paid
  pilots if copy is explicit.
- Continue founder-led onboarding.

Work for public waitlist:

- Keep Free signup limited.
- Publish educational content.
- Continue discovery.
- Fix activation/migration blockers before asking for payment.

## Pricing Recommendation

Keep the current Free/Pro/Premium architecture for now:

- Free: limited, good for quickstart and evaluation.
- Pro: $199/org/month, positioned as predictable team pricing with 1 TiB
  included storage and no training-duration meter.
- Premium: $699/org/month, positioned for heavier teams, larger projects,
  BYOC interest, or higher included limits.

Do not claim "cheaper than W&B" without context. W&B's current Pro entry price
is visibly lower than InstantML Pro, and W&B currently says tracked hours are
unlimited/not billed. The better claim is:

- larger included storage on Pro;
- clear included usage;
- predictable training-observability pricing with fewer usage categories to
  reason about;
- no training-duration meter in v1, which is more directly a contrast with
  Comet/ClearML-style training-hour or application-hour models than W&B's
  current Pro billing;
- exportable data and transparent limits.

Use private-beta discounts instead of changing public packaging too early.
Pricing validation should ask whether buyers prefer:

- current $199 org plan;
- $99-$149 smaller Team plan;
- more included Pro seats at the current price;
- per-seat price with bundled storage;
- usage-heavy Premium/custom plan.

Do not add paid metric/event overage until real workload data shows where the
safe threshold should be.

## Metrics

### Product Activation

- Account to first SDK run: target under 10 minutes.
- First run to first chart: target under 2 minutes.
- First compare action: target under 15 minutes from first run or import.
- Import dry-run to committed import: target under 1 business day for one
  representative project.

### Adoption

- 8 discovery calls in 30 days.
- 3 design partner pilots in 30 days.
- 2 teams with real weekly usage by day 60.
- 1 paid or written-intent conversion by day 90.

### Product Quality

- No data-loss incidents in beta.
- Hosted newest/search/sort/chart p95 remains under 1 second on the benchmark
  showcase.
- Weekly private-beta workflow smokes pass for clean signup-to-first-run, batch
  metric ingest, import dry-run/commit, export, artifact upload/download,
  invite acceptance, and dashboard compare.
- Public-launch SLO review includes p95/p99 latency, 5xx rate, 429 rate, 402
  payment/limit behavior, ingest failures, import failures, artifact failures,
  and backup age.
- SDK metric logging overhead stays below the documented budget.
- Import warnings are explainable and actionable for every pilot.

### GTM Learning

- At least 5 scored validation records in `docs/users/`.
- At least 3 concrete pricing reactions.
- At least 3 migration/dual-log objections captured.
- One clear answer on whether W&B, MLflow, Neptune export, or TensorBoard sync
  is the strongest acquisition hook.

## Review Notes

Fresh review requested from three independent agents after the initial draft.

Product/GTM review:

- High: ICP was too broad for the first 30 days.
  Disposition: accepted. Added a first beachhead of commercial AI startups
  already using W&B/Comet/TensorBoard/MLflow with 50+ runs and concrete
  speed/cost/storage/export pain; narrowed outbound sequencing.
- High: Pricing needed sharper value proof against W&B, Comet, and ClearML.
  Disposition: accepted. Clarified that InstantML should not claim cheapest
  entry price; added beta discount and Team-tier validation questions.
- High: "No tracked-hour billing" was too central as a W&B contrast.
  Disposition: accepted. Reframed around predictable storage-and-usage pricing
  and "no training-duration meter in v1."
- Medium: Neptune is a shrinking outbound channel after shutdown.
  Disposition: accepted. Reduced Neptune to verified exported/self-hosted users
  plus content/SEO.
- Medium: Days 0-14 were overloaded and mixed beta-safe with paid-ready gates.
  Disposition: partially accepted. Split Phase 0 durability as required for
  non-disposable customer data and moved fuller billing matrix to paid launch.

Engineering/launch readiness review:

- High: Private beta durability gate was too loose for real customer data.
  Disposition: accepted. Added Phase 0 backup/restore as required for
  non-disposable customer data, otherwise pilots must be disposable
  evaluations with the source tracker retained.
- High: Minimum security/privacy gate was missing.
  Disposition: accepted. Added private-beta security checklist and public
  security/data-handling launch blocker.
- High: Billing gate was narrower than known billing risks.
  Disposition: accepted. Added end-to-end billing matrix for paid public launch.
- Medium: Feature-scope claims needed maturity qualifiers.
  Disposition: accepted. Added maturity qualifier table.
- Medium: Reliability metrics over-indexed on read-path p95.
  Disposition: accepted. Added workflow smokes and public-launch SLO review.
- Medium: Known-limitations and support expectations should block beta.
  Disposition: accepted. Added beta known-limitations page requirement.

Competitive strategy review:

- High: Trackio was missing as a bottom-up threat.
  Disposition: accepted. Added Hugging Face Trackio to research sources and
  competitor section.
- High: W&B tracked-hour contrast was no longer sharp.
  Disposition: accepted. Updated positioning and pricing language.
- Medium: MLflow/Databricks scope was too narrow.
  Disposition: accepted. Added MLflow LLM/agent tracing, evaluation, prompt,
  deployment, and Databricks-native platform context.
- Medium: W&B/CoreWeave distribution bundling was underplayed.
  Disposition: accepted. Added cloud-neutral positioning against compute-tied
  procurement.
- Low: Final differentiation could be more measurable.
  Disposition: accepted. Tightened final recommendation.

## Final Recommendation

Launch the MVP as a controlled private beta now. The product has enough core
value to put in front of real teams, and waiting for W&B-style breadth would
weaken the learning loop. The sharpest measurable wedge is:

> For 2-20 person ML teams comparing 50+ training runs, InstantML is the
> hosted tracker that feels fast all day, can be evaluated without migration
> through W&B shadow logging/imports, and keeps experiment history exportable.

Keep the public claim set disciplined:

- "Fast hosted training observability for many-run comparison."
- "W&B-style daily workflow, not full W&B parity."
- "Predictable storage-and-usage pricing."
- "Local-first imports and W&B shadow logging for low-risk evaluation."
- "Portable data and transparent limits."

The next product work should be chosen by design-partner activation and
migration evidence, not by a parity checklist.
