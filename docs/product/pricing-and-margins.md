# Pricing And Margins

Date: 2026-05-17

Status: Current pricing model and margin plan for the first hosted beta.

## Purpose

This document explains the Free, Pro, and Premium pricing model, the current cost assumptions, and the operational guardrails needed to keep hosted ClickHouse costs sustainable. It is a planning and product-finance document, not an invoicing implementation. The current beta hosted path uses InstantML-owned self-hosted ClickHouse on Google Cloud instead of ClickHouse Cloud for InstantML-owned control and tenant data.

## Implemented Tiers

| Tier | Price | Included seats | Included storage | Product limits | Warehouse profile intent |
| --- | ---: | ---: | ---: | --- | --- |
| Free | `$0/org/mo` | 2 | 2 GiB | 2 projects, 100 runs, 1M metric points/month, 500k API requests/month | Shared, 8 GiB, 1 replica |
| Pro | `$199/org/mo` | 3 | 1 TiB | 100 projects, 100k runs, 250M metric points/month, 25M API requests/month | Standard, 12 GiB, 1 replica |
| Premium | `$699/org/mo` | 10 | 5 TiB | 500 projects, 1M runs, 2B metric points/month, 150M API requests/month | Dedicated, 16 GiB, 2 replicas |

Current overage policy:

- Extra seats are billed by updating a Stripe extra-seat subscription item
  before reserving seats above the plan's included count. Public pricing should
  still treat the `$79-$99/seat/month` amount as a beta target until invoice
  smoke coverage is complete.
- Projects, runs, and metric points are `blocked_at_limit` for new writes until paid overages or custom terms are implemented.
- API request quotas are `blocked_or_metered_overage`: Free and non-billable
  orgs are blocked at the monthly allowance, while paid Pro/Premium orgs
  continue with Stripe-metered overage at `$2 / 1M` Pro requests and
  `$1 / 1M` Premium requests. The meter reports exact request-unit deltas to
  decimal-cent Stripe prices.
- API-key count and artifact counts are visibility-only.
- Artifact bytes are now included in the retained storage guardrail through exact `ArtifactRow.size_bytes`. The Stripe meter-backed price is attached to paid subscriptions and the overage report path sends positive deltas of the current-month high-water retained GiB overage at the `$0.03/GiB-month` target.

Usage-period semantics:

- Metric-point usage is counted only inside the current UTC calendar month, from the first day at 00:00 UTC to the first day of the next month at 00:00 UTC. The API returns this window as `usage_period` with `reset_at`.
- `usage.metric_points` and `usage.metric_points_current_period` are the current monthly value used for warnings and blocking. `usage.metric_points_retained_total` is retained history for visibility and debugging.
- `usage.api_requests` is counted inside the same current UTC calendar month
  through bounded data-plane rollups. Free and non-billable orgs are blocked at
  the monthly allowance; paid org overage is reportable to Stripe as exact
  request-unit deltas.
- Storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource posture. They do not reset monthly; usage drops only when data is deleted/expired, seats or keys are removed, or the org changes plan. Artifact counts are visibility-only; artifact bytes feed the retained storage guardrail.

## Competitive Context

W&B cloud-hosted Pro is the main public benchmark. As of this research date, W&B lists Pro starting at `$60/month`, up to 10 model seats, 100 GB/month storage, and additional storage at `$0.03/GB`. Its docs also describe storage, tracked hours, Weave ingestion, inference, and training billing/alert categories.

Sources:

- [W&B pricing](https://wandb.ai/site/pricing/)
- [W&B billing settings](https://docs.wandb.ai/platform/app/settings-page/billing-settings)

Pluto is not a clean one-to-one competitor in public pricing. Pluto Bio publishes Premium and Enterprise packaging for a scientific discovery platform, but no self-serve prices. Pluto's web-data/API product documentation describes an API, embedded automations, and functions, but this research pass did not find official public pricing for that product.

Sources:

- [Pluto Bio pricing](https://pluto.bio/pricing)
- [Pluto web-data API docs](https://docs.pluto.xyz/)

## Infrastructure Cost Model

Primary hosted costs:

| Cost center | Billing driver | Margin implication |
| --- | --- | --- |
| Self-hosted GCP ClickHouse/User Data and tenant databases | VM, disk, backups, monitoring, operator time, and future HA capacity | Dominant COGS. Free and Pro should be pooled or database-routed by default. Premium can justify more isolated capacity after payment/review. |
| Cloud Run API | vCPU-second, GiB-second, requests, min instances | Usually secondary; request-based billing and low min instances keep control/data API overhead small. |
| Clerk | Plan, retained users, org features, billing add-on if used | Low at beta scale but can become per-MRU/org-admin overhead. |
| Cloudflare R2 artifact storage | GB-month plus operation classes | Retained local/R2 artifact bytes are counted for usage guardrails now. R2 Standard storage is the cost basis, but invoice truth still needs provider reconciliation. |

Current beta benchmark signal:

- The 2026-05-23 self-hosted GCP ClickHouse benchmark passed the current
  hosted read budgets on the `normal-runs-50k` showcase project: 50,000 runs
  and 522,000,000 metric points.
- Key p95s were `236 ms` for project newest-100, `307 ms` for project
  metric-best sort, `418 ms` for project overview, and `224 ms` for a
  single-run chart read.
- This supports self-hosted GCP ClickHouse as the beta path forward for
  InstantML-owned hosted storage. Margin planning should still reserve budget
  for backups, monitoring, disk growth, operator time, and a later HA posture.

External pricing facts to re-check before launch:

- Self-hosted GCP ClickHouse trades provider autoscaling for a lower, more predictable beta cost basis. Re-check actual Google Cloud VM, disk, backup, and operations costs before launch.
- Cloud Run request-based services in `us-central1` list active CPU and memory rates, request charges, and a monthly free tier.
- Cloudflare R2 Standard lists `$0.015/GB-month`, Class A and B operation charges, and no egress bandwidth charges.
- Clerk lists a free Hobby plan, paid Pro/Business plans, B2B org features, and billing add-on charges if Clerk Billing is used.

Current product copy should frame hosted artifact storage as included capacity
with paid overage on Pro/Premium at `$0.03/GiB-month` after the included pool.
The first billing slice uses current-month high-water retained GiB and positive
delta reports; provider reconciliation remains launch hardening.

Current product copy should frame API requests as included fair-use capacity:
500k/month on Free, 25M/month on Pro, and 150M/month on Premium. Short-window
rate limits protect Cloud Run and ClickHouse immediately. Monthly Free and
non-billable overages are blocked; paid request overage is active at
`$2 / 1M` on Pro and `$1 / 1M` on Premium.

Sources:

- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Clerk pricing](https://clerk.com/pricing)

## Margin Targets

These are operating targets until real provider bills and customer telemetry replace assumptions.

| Tier | Revenue | Target monthly COGS | Target gross margin | Required operating stance |
| --- | ---: | ---: | ---: | --- |
| Free | `$0` | `$0-$5` marginal | Negative but capped | Shared pooled warehouse, strict fair-use limits, no dedicated paid service per signup. |
| Pro | `$199` | `$35-$80` | `60%-82%` | Shared or small standard tenant profile, no plan-sized service unless payment/spend gates are active. |
| Premium | `$699` | `$140-$280` | `60%-80%` | Dedicated profile is acceptable only after payment/review; high-uptime two-replica customers may need Enterprise/custom. |

The key margin rule is simple: a plan card may record requested warehouse intent, but public signup must not unconditionally create the most expensive requested warehouse. The implementation now preserves that distinction:

- `requested_*` tenant-route fields record the selected plan's desired profile.
- `applied_*` tenant-route fields record the actual hosted profile. In the current GCP self-hosted path, this is database-mode routing on the shared ClickHouse deployment rather than a new provider service.
- `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING=false` keeps legacy provider-backed provisioning capped by operator defaults when that optional path is exercised.
- Existing tenant routes and warehouses are preserved; signups and tests do not delete or recreate them.

## Pricing Rationale

Free exists to reduce adoption friction, but it cannot carry dedicated 24/7 warehouse cost. It should stay pooled, limited, and warning-driven.

Pro is intentionally higher than W&B's published Pro entry price because it includes far more storage and is sold as predictable team pricing without tracked-hour billing. The initial price needs to absorb small-team support, shared control-plane cost, auth, API traffic, and a meaningful chunk of ClickHouse usage while keeping a simple signup decision.

Premium exists for teams that want a larger included pool and stronger isolation. It is not yet a full Enterprise replacement. If a customer's dedicated ClickHouse profile must be up 24/7 at two replicas and their true monthly COGS exceeds the target COGS band, they should move to Enterprise/custom rather than silently eroding margin.

## Billing Gaps

Not implemented yet:

- Public production Stripe launch hardening beyond the current Checkout/Portal
  integration.
- Live Stripe webhook, plan-change proration, extra-seat invoice, and storage
  meter-event smoke coverage.
- Email delivery for invites.
- Billable GiB-day accounting from object storage/provider truth.
- Enterprise contract terms.

Implemented billing slice:

- Stripe Checkout collects payment before paid signup unlocks writes or SDK-key
  creation.
- Stripe Customer Portal opens from Settings for payment-method and invoice
  management.
- Stripe webhook signatures are verified and processed idempotently into User
  Data billing records.
- Existing subscriptions are updated for plan changes and extra-seat quantities;
  new paid subscriptions still start with Checkout.
- Storage overage reports create idempotent `billing_usage_report` records and
  Stripe meter events for whole GiB over the included plan pool.
- Billing gates return HTTP 402 `payment_required` for pending/failed paid
  workspaces while reads, exports, usage, and billing status remain available.

Until those exist, usage outputs are product/admin guardrails, not invoices.
Writes that would exceed project, run, metric-point, or estimated-storage
limits are rejected with `plan_limit_exceeded`; reads and exports remain
available so teams can inspect and reduce usage. Metric-point blocking uses the
current UTC calendar-month counter, while storage/project/run blocking uses the
current retained-resource counter. API request counters share the monthly usage
period and now drive Free/non-billable blocking plus paid Stripe overage reports.

## Launch Guardrails

Before public self-serve paid launch:

- Require payment verification and an explicit operator review before enabling plan-sized dedicated capacity or legacy provider-backed `cloud-service` provisioning.
- Keep hosted signup allowlists until public spend gates are implemented.
- Reconcile `GET /api/usage` with object storage, ClickHouse table bytes, and GCP VM/disk costs before billing storage.
- Add spend, disk, backup, and capacity alerts for the self-hosted GCP ClickHouse deployment.
- Validate Pro and Premium COGS on at least three real workloads before publishing stronger margin claims.
- Decide whether extra seats are `$79`, `$99`, or bundled-only for beta.
