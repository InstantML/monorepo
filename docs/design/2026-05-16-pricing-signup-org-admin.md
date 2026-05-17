# Design: Pricing Signup And Org Admin

Date: 2026-05-16

Status: Accepted for narrow first slice

Owner: Codex

## Summary

InstantML needs hosted signup to reflect the first commercial packaging: Free,
Pro, and Premium. The current backend already has org plans, browser sessions,
reserved seats, usage summaries, API keys, and hosted tenant routing, but the
signup flow always creates Free orgs and the dashboard does not expose the org
administration surfaces a beta team needs.

This slice makes plan selection part of signup, stores the selected plan on the
organization, applies plan-specific seat and usage limits, and records the
intended ClickHouse warehouse profile on tenant routes. Real cloud-service
capacity must stay capped at the operator-configured default unless an explicit
operator override allows plan-sized provisioning. It also adds the small admin
loop teams need after signup: invite teammates by email, let invited teammates
sign in and activate their existing membership, view current usage, and
create/revoke API keys. Billing collection, artifact registry/object-store work,
and paid seat overage charging remain out of scope.

## Goals

- Replace the planning Lab/Startup/Growth tiers with Free, Pro, and Premium.
- Let signup choose Free, Pro, or Premium and persist the selected plan.
- Use the selected plan to set included seat limits and warehouse profile intent
  metadata during tenant provisioning.
- Keep real cloud-service memory/replica provisioning capped by operator config
  unless an explicit plan-sized provisioning flag is present.
- Keep existing tenant warehouses/routes intact; never delete or recreate an
  existing route just because the plan UI changed.
- Let owner/admin users reserve invited seats by email and list current seats.
- Activate an invited membership when the invited user signs in with the same
  verified email.
- Surface current org usage, plan limits, warning thresholds, and API keys in
  the dashboard.
- Preserve SDK/API route compatibility for existing run/project/metric paths.

## Non-Goals

- No Stripe, invoice generation, payment enforcement, couponing, trials, or tax
  handling.
- No artifact registry/object-store implementation.
- No email delivery service. Invites are reserved seats and activation records;
  operators/users still share the signup/sign-in link manually.
- No public self-serve paid warehouse creation without the existing signup
  allowlist, budget, and abuse guardrails.
- No migration that rewrites existing tenant routes or historical org records.

## Users and Use Cases

Founder or ML lead:

1. Opens signup.
2. Chooses Free, Pro, or Premium.
3. Creates an org.
4. Invites teammates by email.
5. Creates SDK keys and watches usage.

Invited teammate:

1. Receives a link out of band.
2. Signs in with the invited email.
3. Joins the existing org and sees the same projects/runs.

Operator:

1. Keeps existing hosted ClickHouse warehouses alive.
2. Uses plan and usage data to validate margins before billing enforcement.

## Proposed Design

### Plans

Use three public plan IDs:

| Plan | Monthly price | Included seats | Included tracked data | Included metric points |
| --- | ---: | ---: | ---: | ---: |
| Free | `$0` | 2 | 2 GB | 1M/month |
| Pro | `$199/org/mo` | 3 | 1 TB | 250M/month |
| Premium | `$699/org/mo` | 10 | 5 TB | 2B/month |

Tracked data is the first billable planning unit for hosted storage. In this
slice it is still warning data, not invoice truth. Metric point limits are
fair-use limits in the usage summary, not hard ingest blocks.

Legacy plan names (`lab`, `startup`, `growth`) may appear in old local or
hosted records. New writes should use only `free`, `pro`, or `premium`. Usage
and docs should treat `lab` and `startup` as Pro-like legacy values and
`growth` as Premium-like legacy value where needed.

### Signup

Add `plan_tier` to the dev and Clerk signup request bodies:

```json
{
  "mode": "signup",
  "account_type": "business",
  "org_name": "Acme Research",
  "plan_tier": "pro",
  "seat_emails": ["teammate@example.com"]
}
```

The server validates the plan and sets:

- `organization.plan_tier`
- `organization.seat_limit`
- tenant route warehouse profile metadata
- invite acceptance target when `accept_invite_org_id` is supplied

Existing session payloads continue to include `organization`.

### Invites And Membership Activation

Reserved seats remain membership rows with `status="invited"`. Add:

- `GET /api/orgs/:org_id/seats`
- `POST /api/orgs/:org_id/seats`

The list endpoint returns membership rows joined with safe user fields so the
dashboard can show emails and statuses.

`POST /api/orgs/:org_id/seats` accepts:

```json
{
  "email": "teammate@example.com",
  "role": "member"
}
```

The server normalizes email, defaults role to `member`, allows only
`admin/member/viewer` for invited users, returns the existing membership when
the same email is already active or invited in the org, and returns `409` when
the active plus invited seat count would exceed the plan seat limit.

`GET /api/orgs/:org_id/seats` returns:

```json
{
  "seats": [
    {
      "membership": {
        "id": "uuid",
        "org_id": "uuid",
        "user_id": "uuid",
        "role": "owner",
        "status": "active",
        "created_at": "2026-05-16T00:00:00Z"
      },
      "user": {
        "id": "uuid",
        "primary_email": "founder@example.com",
        "display_name": "Founder",
        "avatar_url": null
      }
    }
  ]
}
```

When a user signs in, activation uses only the provider-verified, normalized
primary email fetched server-side:

- If the user already has an active membership, use it as today.
- If the user has exactly one invited membership and no active membership,
  activate that membership and issue a session for the invited org.
- If the user has multiple invited memberships and no `accept_invite_org_id`,
  return `409` with `code: "multiple_pending_invites"` and safe org choices.
- If the user sends `accept_invite_org_id`, activate only an invite for that
  verified email and org id.
- `org_name` is only a signup/create-org field. It must not silently
  disambiguate invites because that can be confused with creating a new
  workspace.

### API Key Management

Keep existing API-key route shapes:

- `GET /api/orgs/:org_id/api-keys`
- `POST /api/orgs/:org_id/api-keys`
- `POST /api/orgs/:org_id/api-keys/:api_key_id/revoke`
- `POST /api/orgs/:org_id/service-accounts/:service_account_id/disable`

The dashboard API tab lists existing keys, can create a copy-once key, and can
revoke active keys. The plaintext key is shown once and not persisted in browser
storage.

### Usage

Enhance `GET /api/usage` with plan metadata, limits, warnings, seat counts,
API-key counts, metric point counts, artifact byte counts, and estimated
metadata bytes. The response remains labeled `billing_precision:
"not_billable"`.

Example response fragment:

```json
{
  "schema_version": 1,
  "billing_precision": "not_billable",
  "plans": {
    "free": {
      "id": "free",
      "label": "Free",
      "monthly_base_usd": 0,
      "included_seats": 2,
      "included_storage_bytes": 2147483648,
      "metric_points": 1000000
    },
    "pro": {
      "id": "pro",
      "label": "Pro",
      "monthly_base_usd": 199,
      "included_seats": 3,
      "included_storage_bytes": 1099511627776,
      "metric_points": 250000000
    },
    "premium": {
      "id": "premium",
      "label": "Premium",
      "monthly_base_usd": 699,
      "included_seats": 10,
      "included_storage_bytes": 5497558138880,
      "metric_points": 2000000000
    }
  },
  "organizations": [{
    "org_id": "uuid",
    "plan_tier": "pro",
    "usage": {
      "seats": 2,
      "paid_extra_seats": 0,
      "projects": 4,
      "runs": 118,
      "metric_points": 1200000,
      "metric_series": 64,
      "artifacts": 0,
      "api_keys": 2,
      "artifact_bytes_exact": 0,
      "artifact_bytes_unknown_count": 0,
      "estimated_metadata_bytes": 250000,
      "estimated_storage_bytes_for_warnings": 250000,
      "billable_storage_bytes": null,
      "billing_precision": "not_billable"
    },
    "limits": {
      "included_seats": 3,
      "included_storage_bytes": 1099511627776,
      "metric_points": 250000000
    },
    "warnings": []
  }]
}
```

The dashboard Settings tab reads usage with the owner/admin session and renders
current plan, tracked data, metric points, seats, projects, runs, and warnings.

### Warehouse Profiles

Tenant routes get non-secret profile metadata derived from the selected plan:

| Plan | Warehouse kind | Min memory | Max memory | Replicas |
| --- | --- | ---: | ---: | ---: |
| Free | `shared` | 8 GB | 8 GB | 1 |
| Pro | `standard` | configured default or 12 GB | configured default or 12 GB | 1 |
| Premium | `dedicated` | max(configured default, 16 GB) | max(configured default, 16 GB) | max(configured replicas, 2) |

For the local/test `database` provisioner, the profile is recorded on the route
but still uses the existing per-org database on the tenant base ClickHouse
service.

For the cloud-service provisioner, the plan profile is intent by default. Real
create-service memory/replica fields remain capped by the operator-configured
`INSTANTML_CLICKHOUSE_CLOUD_*` values unless
`INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING=true` is set. This keeps signup
from turning a Premium click into uncapped paid capacity before payment and
budget gates exist. A future billing design should add payment approval,
per-day tenant creation quotas, budget alerts, and a provider-side maximum
profile before public plan-sized provisioning is enabled.

Existing ready routes are returned as-is and are not reprovisioned.

## Component Impact

Backend:

- Extend plan validation and plan constants.
- Extend auth signup input.
- Add seat-list route and invite activation behavior.
- Enrich usage summary.
- Add warehouse profile metadata and plan-aware ClickHouse Cloud create bodies.

Frontend:

- Add plan cards to signup.
- Add usage and seat management to Settings.
- Add create/list/revoke API-key management to API.

Python SDK:

- No SDK interface change.

Storage:

- No new ClickHouse tables.
- `organization.plan_tier` uses new public values for new writes.
- `tenant_route` payloads gain optional non-secret profile fields with serde
  defaults for old records.

Docs:

- Update product strategy, pricing/margins doc, architecture summaries, API
  references, component READMEs, and design index.

## Data Model

Changed:

- `OrganizationRow.plan_tier`: new writes use `free`, `pro`, or `premium`.
- `OrganizationRow.seat_limit`: set from selected plan.
- `TenantRouteRecord`: add optional profile metadata:
  - `plan_tier`
  - `warehouse_kind`
  - `min_replica_memory_gb`
  - `max_replica_memory_gb`
  - `num_replicas`

New response-only shape:

- `SeatRow` joins membership plus safe user email/display fields.

## API Contracts

Changed request bodies:

- `POST /api/auth/dev/google`: accepts optional `mode` and `plan_tier`.
- `POST /api/auth/clerk`: accepts optional `plan_tier` and
  `accept_invite_org_id`.

New route:

- `GET /api/orgs/:org_id/seats`
  - Auth: owner/admin browser session or bootstrap token.
  - Response: `{ "seats": [...] }`.

- `POST /api/orgs/:org_id/seats`
  - Auth: owner/admin browser session or bootstrap token.
  - Body: `{ "email": "teammate@example.com", "role": "member" }`.
  - Response: `{ "seat": { "membership": {...}, "user": {...} } }`.
  - Errors: `400` invalid email/role, `403` non-admin/cross-org/demo,
    `409` seat limit exceeded.

Changed route:

- `GET /api/usage`
  - Adds `plans`, `limits`, `usage.api_keys`,
    `usage.estimated_metadata_bytes`,
    `usage.estimated_storage_bytes_for_warnings`,
    `usage.billable_storage_bytes`, and `warnings`.
  - Keeps existing top-level organization array shape.

## Performance Considerations

- Seat and API-key lists are low-volume admin reads; they stay bounded by org
  membership/API-key count.
- Usage counts continue to rely on maintained in-memory operational indexes plus
  ClickHouse metric count queries; no metric history is returned.
- Signup provisions exactly one tenant route as today. Existing routes are not
  reprovisioned.
- Dashboard usage/seats/API keys load only on the Settings/API admin tabs.
- Existing per-request metric caps remain enforced. Free/internal beta hard
  stops for monthly metric or storage limits are deferred to a billing/safety
  enforcement design, but this slice keeps warnings explicit and visible.

## Simplicity Review

This uses existing org, membership, usage, API-key, and tenant-route concepts
instead of adding a billing engine or new database. It keeps email delivery and
payment collection out of scope while making the hosted beta workflow coherent.

Deferred complexity:

- Stripe and paid seat add-ons.
- Email invite delivery and invite tokens.
- Plan upgrades/downgrades after signup.
- Object storage reconciliation for invoice-grade byte accounting.
- Dedicated customer cell lifecycle management beyond profile metadata and
  cloud-service create request sizing.

## Failure Modes

- Invalid plan: signup returns `400`.
- Seat limit reached: invite route returns `409`.
- Existing ready route has old profile fields: route still loads through serde
  defaults and is not destroyed.
- Plan profile exceeds operator cloud cap: the tenant route records requested
  intent and applied capacity separately; applied capacity stays capped.
- Invited user signs in with wrong email: no invitation is activated.
- Invited user has multiple pending orgs: sign-in returns
  `multiple_pending_invites` with safe org ids/names until
  `accept_invite_org_id` is provided.
- API-key revoke fails for another org: route returns `404` or `403`.
- Usage cannot count ClickHouse metrics because the warehouse is waking:
  existing `warehouse_unavailable` behavior is preserved.

## Testing Plan

- Rust unit tests for plan validation, plan limits, warehouse profiles, and
  invitation activation.
- Rust handler/openapi tests for seat-list route availability.
- Rust negative tests for duplicate invites, wrong-email invite activation,
  multiple pending invites, member/viewer admin denial, and seat-limit
  conflicts.
- Contract smoke coverage for new usage shape and plan tiers.
- Hosted ClickHouse smoke coverage for plan signup, tenant route profile,
  invited teammate activation, shared project visibility, usage read, seat
  list, API key list/revoke, and tenant restart.
- UI smoke coverage for plan selection, seat invite controls, usage display,
  and API key management where practical.
- Web build to catch React/Next type and runtime issues.

## Documentation Plan

- `PRODUCT_STRATEGY.md`
- `docs/product/pricing-and-margins.md`
- `docs/architecture/current-system.md`
- `docs/architecture/current-api.md`
- `docs/architecture/current-schemas.md`
- `docs/architecture/auth-and-tenant-flow.md`
- `docs/architecture/README.md`
- `docs/README.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `docs/design/README.md`

## Alternatives Considered

Plan-only UI without warehouse metadata:

- Rejected because operators need to know which warehouse profile a signup
  intended, even before full billing exists.

Dedicated ClickHouse service for every signup:

- Rejected for Free and most Pro usage because current cost research shows this
  can erase margin. Shared/database test provisioning remains the safe default.

Full billing enforcement:

- Rejected because invoice-grade storage reconciliation and provider billing
  integration need a separate design.

Email invite delivery:

- Rejected for this slice. Reserved seats plus activation on sign-in are enough
  to prove same-org access and project sharing.

## Review Notes

Fresh reviewer 1:

- Finding: Plan selection could create costly ClickHouse capacity without
  payment or spend gates; provisioning failure/profile mismatch semantics needed
  more detail; invite activation needed verified-email specificity; warning-only
  usage is not enough long term.
- Risk: Premium signup could create expensive 16 GB x 2 services, retries could
  orphan paid services, and ambiguous invites could activate the wrong tenant.
- Recommended edit: Treat plan profile as intent unless an operator flag allows
  plan-sized cloud provisioning, add spend/creation guardrails as future gates,
  require server-verified primary email for invite activation, and specify
  admin/seat contracts.
- Decision: Accepted. The design now caps applied cloud-service sizing behind
  `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING`, records requested versus
  applied profile, keeps billing/spend enforcement deferred, and tightens invite
  activation semantics.

Fresh reviewer 2:

- Finding: Seat API and usage response contracts were incomplete, multiple
  pending invite UX was underspecified, and the slice was broad.
- Risk: Frontend/backend drift, accidental new org creation by invitees, and
  incomplete admin negative coverage.
- Recommended edit: Add `POST /seats` contract, concrete usage response
  examples, explicit `accept_invite_org_id` flow, and negative test coverage.
- Decision: Accepted. The API contracts and test plan were expanded. The slice
  remains broad because the user requested the complete beta admin loop and PR,
  but paid billing, email delivery, hard usage enforcement, and public
  plan-sized provisioning stay out of scope.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation after fresh review updates are recorded below.
