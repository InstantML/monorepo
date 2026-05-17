# Pricing And Margins

Date: 2026-05-16

Status: Current pricing model and margin plan for the first hosted beta.

## Purpose

This document explains the Free, Pro, and Premium pricing model, the current cost assumptions, and the operational guardrails needed to keep hosted ClickHouse costs sustainable. It is a planning and product-finance document, not an invoicing implementation.

## Implemented Tiers

| Tier | Price | Included seats | Included storage | Product limits | Warehouse profile intent |
| --- | ---: | ---: | ---: | --- | --- |
| Free | `$0/org/mo` | 2 | 2 GiB | 2 projects, 100 runs, 1M metric points | Shared, 8 GiB, 1 replica |
| Pro | `$199/org/mo` | 3 | 1 TiB | 100 projects, 100k runs, 250M metric points | Standard, 12 GiB, 1 replica |
| Premium | `$699/org/mo` | 10 | 5 TiB | 500 projects, 1M runs, 2B metric points | Dedicated, 16 GiB, 2 replicas |

Current overage policy:

- Extra seats are tracked as `paid_extra_seats` but are not billed yet.
- Projects, runs, metric points, and estimated storage are `blocked_at_limit` for new writes until paid overages or custom terms are implemented.
- API-key count and artifact counts are visibility-only.
- Artifact registry is out of scope for this pricing slice.

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
| ClickHouse Cloud/User Data and tenant services | Compute, storage, service sizing, uptime, provider region | Dominant COGS. Free must be pooled. Pro should not receive uncapped dedicated services by default. Premium can justify dedicated capacity after payment/review. |
| Cloud Run API | vCPU-second, GiB-second, requests, min instances | Usually secondary; request-based billing and low min instances keep control/data API overhead small. |
| Clerk | Plan, retained users, org features, billing add-on if used | Low at beta scale but can become per-MRU/org-admin overhead. |
| Object storage later | GB-month plus operation classes | Artifact bytes are not billable truth yet. R2 is attractive because standard storage is low cost and egress is not charged. |

External pricing facts to re-check before launch:

- ClickHouse Cloud separates compute and storage, meters key usage drivers, supports autoscaling, and can scale unused services down to zero.
- Cloud Run request-based services in `us-central1` list active CPU and memory rates, request charges, and a monthly free tier.
- Cloudflare R2 Standard lists `$0.015/GB-month`, Class A and B operation charges, and no egress bandwidth charges.
- Clerk lists a free Hobby plan, paid Pro/Business plans, B2B org features, and billing add-on charges if Clerk Billing is used.

Sources:

- [ClickHouse Cloud pricing](https://clickhouse.com/pricing)
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
- `applied_*` tenant-route fields record the actual profile sent to ClickHouse Cloud.
- `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING=false` keeps real provisioning capped by operator defaults.
- Existing tenant routes and warehouses are preserved; signups and tests do not delete or recreate them.

## Pricing Rationale

Free exists to reduce adoption friction, but it cannot carry dedicated 24/7 warehouse cost. It should stay pooled, limited, and warning-driven.

Pro is intentionally higher than W&B's published Pro entry price because it includes far more storage and is sold as predictable team pricing without tracked-hour billing. The initial price needs to absorb small-team support, shared control-plane cost, auth, API traffic, and a meaningful chunk of ClickHouse usage while keeping a simple signup decision.

Premium exists for teams that want a larger included pool and stronger isolation. It is not yet a full Enterprise replacement. If a customer's dedicated ClickHouse profile must be up 24/7 at two replicas and their true monthly COGS exceeds the target COGS band, they should move to Enterprise/custom rather than silently eroding margin.

## Billing Gaps

Not implemented yet:

- Payment collection.
- Plan changes and proration.
- Email delivery for invites.
- Paid extra-seat billing.
- Storage overage billing.
- Billable GB-day accounting from object storage/provider truth.
- Enterprise contract terms.

Until those exist, usage outputs are product/admin guardrails, not invoices.
Writes that would exceed project, run, metric-point, or estimated-storage
limits are rejected with `plan_limit_exceeded`; reads and exports remain
available so teams can inspect and reduce usage.

## Launch Guardrails

Before public self-serve paid launch:

- Require payment verification before enabling plan-sized cloud-service provisioning.
- Keep hosted signup allowlists until public spend gates are implemented.
- Reconcile `GET /api/usage` with provider storage and ClickHouse service usage before billing storage.
- Add spend alerts and internal dashboards for per-org ClickHouse service cost.
- Validate Pro and Premium COGS on at least three real workloads before publishing stronger margin claims.
- Decide whether extra seats are `$79`, `$99`, or bundled-only for beta.
