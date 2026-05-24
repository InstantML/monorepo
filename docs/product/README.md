# Product Docs

This directory is for product requirements, positioning, roadmap notes, and launch planning for InstantML.

Keep `PRODUCT_STRATEGY.md` at the repository root as the main strategic entry point unless the project later outgrows it.

Current note: `day-2-mvp-spec.md` is historical bootstrap context. For current roadmap, W&B-style competitor positioning, implementation status, and next priorities, read `PRODUCT_STRATEGY.md` first.

Backend/product planning note: the accepted hosted product architecture is Rust API plus ClickHouse operational and metric layers, with artifact storage behind an abstraction and managed auth for Google/org workflows. Rust/ClickHouse is now the default local/product backend, and the current hosted beta uses InstantML-owned self-hosted ClickHouse on Google Cloud instead of ClickHouse Cloud for InstantML-owned control and tenant data; the source of truth is `../design/2026-05-14-clickhouse-only-storage.md`. The current pricing model is Free, Pro, and Premium with plan-aware signup, seat invites, topbar/Settings usage visibility, API-key management, and blocked-at-limit usage guardrails for new project, run, metric-ingest, artifact, import, and demo-reset writes. Metric-point and API-request limits are current UTC calendar-month counters with `usage_period.reset_at`; Free/non-billable API request overage is blocked and paid Pro/Premium request overage is Stripe-metered. Storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource counts; paid storage overage uses current-month high-water retained GiB deltas. Provider and margin assumptions remain planning hypotheses until validated with bills and customer workloads.

Current planning docs:

- `2026-05-09-open-source-brand.md`: accepted open-source, brand, and compatibility-name policy.
- `pricing-and-margins.md`: current Free/Pro/Premium packaging, competitive pricing notes, infrastructure COGS assumptions, margin targets, and launch guardrails.
- `customer-owned-clickhouse-setup.md`: first-slice BYOC ClickHouse customer/operator setup guidance, egress allowlist expectations, SQL grants, and limitations.
- `future-directions.md`: exploratory ideas for worker-level raw signals, user-defined reductions, mid-flight run forking, scheduler coordination, and custom step semantics.
- `day-2-mvp-spec.md`: historical bootstrap MVP context.

Future agents should update product docs when:

- Target users change
- MVP scope changes
- Competitor positioning changes
- Roadmap priorities change
- User research materially changes the thesis
