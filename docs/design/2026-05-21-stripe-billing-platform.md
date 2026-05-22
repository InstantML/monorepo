# Design: Stripe Billing Platform

Date: 2026-05-21

Status: Accepted for implementation

Owner: Codex

## Summary

InstantML has Free, Pro, and Premium packaging, plan-aware signup, usage
guardrails, seat invites, API-key management, and hosted tenant routing, but
payments are still absent. This design adds a Stripe Billing control-plane slice
that can collect payment during paid signup, upgrade or downgrade an existing
workspace, add paid seats, open Stripe Customer Portal, verify payment through
webhooks and explicit session sync, and gate write paths when billing access is
not active.

The smallest useful version uses Stripe Checkout for payment collection,
Stripe Billing subscriptions for plan and seat recurring items, Stripe Customer
Portal for self-service payment-method and cancellation flows, and InstantML
control records for the local billing projection. Stripe remains the payment
source of truth; InstantML stores only IDs, statuses, entitlement state, and
idempotent event records.

Storage overage is enabled as a metered-billing path only after the product can
compute exact retained bytes. The first implementation can report retained
billable GiB over the included pool from the usage summary into Stripe, but the
plan continues to document provider reconciliation as the launch hardening item.

## Goals

- Collect payment before unlocking Pro or Premium signup.
- Let owner/admin users upgrade, downgrade, cancel, resume through a controlled
  backend flow or Stripe Customer Portal.
- Add seats as a billable subscription quantity before reserving the seat.
- Verify payment using Stripe webhooks plus an explicit Checkout Session sync
  endpoint for return-page recovery.
- Persist billing accounts, checkout/change intents, subscription state, and
  processed Stripe events as User Data control records.
- Gate all new write paths when an org is pending payment, past grace, canceled,
  or payment-failed.
- Keep reads, exports, and usage visibility available during payment failure.
- Support sandbox operation with only `STRIPE_SECRET_KEY` by discovering or
  creating stable test prices with lookup keys.

## Non-Goals

- No card data touches InstantML servers.
- No tax location UX beyond passing customer email/name to Stripe Checkout and
  using Stripe's billing collection surfaces.
- No legacy Node billing surface.
- No automatic shared-to-dedicated ClickHouse migration on upgrade; paid orgs
  keep the current routing tier until the tenant migration design exists.
- No invoice PDFs or internal accounting ledger beyond Stripe IDs and projection
  state.

## Users and Use Cases

Founder during signup:

1. Chooses Pro or Premium.
2. Creates identity and pending workspace.
3. Is redirected to Stripe Checkout.
4. Returns after payment.
5. InstantML verifies the Checkout Session/subscription and unlocks the
   workspace, provisioning route/API key only after payment is active.

Existing owner/admin:

1. Opens Settings.
2. Starts an upgrade, downgrade, seat add, cancellation, or portal session.
3. Completes payment or confirmation in Stripe.
4. InstantML receives webhooks or syncs the session and updates the org plan,
   seat limit, and billing access state.

Operator:

1. Configures Stripe keys, webhook secret, optional price IDs, and public URLs.
2. Reads billing status and processed events from User Data.
3. Runs reconciliation when webhooks are delayed or after secret rotation.

## Proposed Design

### Stripe Surfaces

- Checkout Sessions:
  - `mode=subscription` for new paid signup and plan upgrades.
  - `client_reference_id` and metadata carry `org_id`, `user_id`, `intent_id`,
    `action`, and `target_plan_tier`.
  - Success URL includes `session_id={CHECKOUT_SESSION_ID}` so the frontend can
    call `/api/billing/checkout/sync`.
- Customer Portal:
  - Used for payment method changes, invoice history, customer-managed cancel
    or subscription updates.
  - Portal return URL points back to Settings.
- Webhooks:
  - Verify `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET`.
  - Process `checkout.session.completed`, `invoice.paid`,
    `invoice.payment_failed`, `customer.subscription.created`,
    `customer.subscription.updated`, and `customer.subscription.deleted`.
  - Store each Stripe event id before applying the projection. Duplicate events
    are no-ops.
- Prices:
  - Prefer configured IDs:
    - `STRIPE_PRO_PRICE_ID`
    - `STRIPE_PREMIUM_PRICE_ID`
    - `STRIPE_EXTRA_SEAT_PRICE_ID`
    - `STRIPE_STORAGE_OVERAGE_PRICE_ID`
  - If absent in sandbox, use lookup keys and create missing recurring test
    prices with the configured Stripe secret key.

### Billing Access States

- `free_active`: no Stripe subscription required.
- `checkout_pending`: paid signup or upgrade has not completed.
- `paid_active`: subscription is active or trialing.
- `past_due_grace`: subscription is past due but still inside the configured
  grace window.
- `read_only_payment_required`: grace expired, subscription unpaid/incomplete,
  canceled, or payment failed.
- `canceled`: subscription ended and the org has been downgraded to Free.

Write paths call the billing gate before plan-capacity checks. Read paths,
exports, usage summary, billing status, and portal access remain available.

### Signup Flow

Free signup behaves as today.

Paid signup creates the user, organization, owner membership, browser session,
and billing checkout intent, but it does not mint an onboarding SDK key and it
does not create/ensure tenant route capacity until Stripe verification marks the
subscription active. The org starts with Free effective limits and
`checkout_pending`. The auth response includes a `billing_checkout` URL, and the
frontend redirects to Stripe.

When Stripe verifies payment, the billing projection updates to `paid_active`,
the org plan and seat limit are updated to the paid tier, pending seats are
reserved if still valid, the tenant route is ensured, and the next onboarding
screen can create or receive an SDK key.

### Upgrade, Downgrade, Seats, And Cancel

- Upgrade to Pro/Premium: create Checkout Session or apply subscription update
  with Stripe pending updates. Local plan changes only after paid invoice or
  active subscription verification.
- Downgrade to Free or lower paid tier: schedule or apply the downgrade after
  Stripe confirms the subscription state. If the current retained usage exceeds
  the target plan, the org can read/export but new writes remain blocked until
  usage fits or payment is restored.
- Add paid seat: bill the extra-seat subscription item first. After Stripe
  verifies the payment/update, reserve the invited seat locally.
- Cancel: set `cancel_at_period_end` through Stripe. At period end or
  subscription deletion, set effective access to Free/canceled and reduce plan
  limits.

### Storage Overage

The billing module computes retained billable storage as:

```text
max(0, storage_bytes_for_warnings - plan.included_storage_bytes)
```

Paid subscription creation and plan updates attach the storage overage
meter-backed price to the Stripe subscription. The report endpoint sends whole
GiB-month quantity to Stripe using the configured or auto-created Billing Meter.
Exact artifact bytes are already included for local/R2 retained artifacts;
provider storage reconciliation remains the launch hardening requirement before
public overage invoices are treated as final billing truth.

## Component Impact

Backend:

- Add billing domain types, config, Stripe client, webhook verification, control
  records, store projection helpers, and billing HTTP routes.
- Add billing gates to write paths.
- Add OpenAPI annotations and generated API types.

Frontend:

- Redirect paid signup to Stripe Checkout when the auth response includes
  `billing_checkout.url`.
- Add a billing return page that syncs the Checkout Session and opens
  onboarding/dashboard after verification.
- Add Settings billing controls for portal, plan changes, cancellation, and
  paid seat flow.

Python SDK:

- No SDK API shape changes. Existing write calls receive HTTP 402
  `payment_required` when billing access is read-only.

Storage:

- Billing records are low-volume User Data control records.
- No ClickHouse metric hot path changes.

Docs:

- Update backend, frontend, architecture, product pricing, and design indexes.

## Data Model

Control-record kinds:

- `billing_account`
- `billing_checkout_intent`
- `billing_change_intent`
- `billing_subscription`
- `billing_event`
- `billing_usage_report`

`BillingAccountProjection` stores org id, access state, effective plan,
requested plan, Stripe customer/subscription IDs, subscription status, current
period, grace deadline, cancellation flag, paid extra seats, and last message.

`BillingCheckoutIntent` stores one user action, target tier, pending seats,
Stripe Checkout Session id/url, status, and expiry.

`BillingChangeIntent` stores post-signup plan/seat/cancel changes and their
Stripe invoice/subscription IDs.

`BillingEventRecord` stores processed Stripe event ids and payload summaries for
idempotency.

## API Contracts

- `GET /api/billing/status`
  - Browser session required.
  - Returns billing account projection, plan catalog, and billing actions.
- `POST /api/billing/checkout`
  - Browser owner/admin required.
  - Body: `{ "plan_tier": "pro" | "premium", "seat_emails"?: string[] }`.
  - Returns `{ "checkout": { "url", "session_id", "intent_id", "status" } }`.
- `POST /api/billing/checkout/sync`
  - Browser session required.
  - Body: `{ "session_id": "cs_test_..." }`.
  - Retrieves Stripe Checkout Session and applies verified subscription state.
- `POST /api/billing/portal`
  - Browser owner/admin required.
  - Returns `{ "url": "https://billing.stripe.com/..." }`.
- `POST /api/billing/change-plan`
  - Browser owner/admin required.
  - Body: `{ "plan_tier": "free" | "pro" | "premium" }`.
- `POST /api/billing/add-seat`
  - Browser owner/admin required.
  - Body: `{ "email": "teammate@example.com", "role": "member" }`.
- `POST /api/billing/cancel`
  - Browser owner/admin required.
  - Body: `{ "at_period_end": true }`.
- `POST /api/billing/storage-overage/report`
  - Browser owner/admin required.
  - Computes current retained storage overage, records an idempotent local
    `billing_usage_report`, and sends a Stripe meter event when `reported_gib`
    is greater than zero.
- `POST /api/billing/webhook`
  - No browser session.
  - Requires Stripe signature verification.

Error behavior:

- Billing write gate returns HTTP 402 with `code: "payment_required"`.
- Plan quota gate continues returning HTTP 402 with
  `code: "plan_limit_exceeded"`.
- Stripe configuration gaps return HTTP 503 `billing_unavailable`.

## Performance Considerations

- Billing records are low-volume per org and live in the control plane.
- Webhook processing is idempotent and single-event scoped.
- Checkout/portal creation is one external Stripe call per user action.
- Price lookup/creation is cached in memory per process after first use.
- Usage overage reporting should run as a bounded org-scoped job, not inside
  scalar metric ingestion.
- Mutation gates read the in-memory control projection and avoid Stripe calls.

## Simplicity Review

This design uses Stripe-hosted Checkout and Portal instead of embedding card UI,
keeps Stripe as the billing source of truth, and stores only the projection the
app needs for entitlements. It avoids building an invoice ledger, tax engine,
payment-method UI, or cross-cell migration in the first slice.

## Failure Modes

- Checkout return arrives before webhook: `/checkout/sync` retrieves the session
  and applies verified state.
- Webhook duplicate: event id record makes it a no-op.
- Webhook secret missing: webhook endpoint returns configuration error; manual
  sync still works for Checkout returns.
- Payment fails: org moves to `past_due_grace` or `read_only_payment_required`;
  reads and exports remain available.
- Stripe API unavailable: local state is unchanged and the user action returns
  a safe retryable error.
- Upgrade paid but tenant provisioning fails: billing remains active and the
  provisioning status reports the route failure for retry.
- Current usage exceeds downgrade target: org downgrades, then plan-capacity
  guardrails block new writes until usage fits.

## Testing Plan

- Unit tests:
  - Stripe webhook signature verification.
  - Billing access-state write gate.
  - Event idempotency.
  - Status-to-entitlement projection.
- API/OpenAPI tests:
  - New billing paths appear in utoipa output.
  - Generated API types remain in sync.
- Store tests:
  - Pending paid signup does not mint SDK key or tenant route.
  - Active subscription unlocks org plan and seats.
- Frontend tests:
  - Paid signup redirects when `billing_checkout.url` is present.
  - Settings shows billing actions and handles 402 payment errors.
- Manual sandbox checks:
  - Checkout Session creation with sandbox key.
  - Return-page sync against Stripe test session.
  - Webhook verification with Stripe CLI secret.
- Repeatable sandbox smoke:
  - `npm run test:stripe-billing` starts disposable local ClickHouse/Rust API
    services, creates a real Stripe test subscription with `tok_visa`, delivers
    signed local webhooks, verifies paid activation, payment-failure recovery,
    extra-seat billing, Premium upgrade, storage-overage report creation,
    scheduled cancellation, and downgrade projection.
  - Hosted Checkout browser completion remains manual when Stripe presents
    hCaptcha, but downstream subscription and webhook handling are covered by
    the smoke.

Coverage exception:

- Full live Stripe webhook round-trip is not deterministic in unit tests.
- Reason: it needs Stripe CLI or Dashboard webhook delivery.
- Risk: environment-specific webhook secret or route setup mistakes.
- Follow-up: add a hosted smoke that runs against Stripe CLI in CI once secrets
  are available.
- Owner/date: Codex / 2026-05-21.

## Documentation Plan

- `docs/design/README.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `docs/architecture/current-api.md`
- `docs/architecture/current-schemas.md`
- `docs/product/pricing-and-margins.md`
- `PRODUCT_STRATEGY.md`

## Alternatives Considered

Embedded Payment Element:

- Rejected for the first slice because Checkout handles subscription creation,
  SCA, saved payment methods, and hosted redirects with less local surface.

Instantly mutating local plan on `checkout.session.completed`:

- Rejected. The implementation must retrieve the Checkout Session and/or
  subscription and tie paid invoices to the local intent before granting paid
  access.

Custom invoice ledger:

- Rejected. Stripe already stores invoice/payment history; InstantML only needs
  entitlements and event idempotency.

## Review Notes

Fresh reviewer 1:

- Finding: Payment success must be tied to retrieved Checkout Session,
  subscription, and invoice data, not only a webhook event name.
- Risk: A spoofed or incomplete event could unlock paid capacity.
- Recommended edit: Add explicit `checkout/sync`, event idempotency, and
  subscription projection logic.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: Current signup creates tenant routes and onboarding keys before
  billing exists.
- Risk: Paid signups could use paid resources without successful payment.
- Recommended edit: Pending paid signup must skip route/key creation and all
  write paths need a billing gate.
- Decision: Accepted.

Fresh reviewer 3:

- Finding: Storage billing needs exact units and reconciliation language.
- Risk: Charging estimated bytes as invoice truth creates billing disputes.
- Recommended edit: Report retained GiB over included pool only where exact
  bytes exist, keep provider reconciliation as a launch guardrail.
- Decision: Accepted.

## Coverage Exceptions

- Uncovered area: Live Stripe Dashboard webhook delivery.
- Reason: Requires external Stripe CLI/Dashboard configuration and a webhook
  signing secret.
- Risk: Misconfigured deploy secret could block automated webhook fulfillment.
- Follow-up: Add a Stripe CLI smoke workflow once CI can hold sandbox secrets.
- Owner/date: Codex / 2026-05-21.

## Decision

Accepted. Implement the narrow Stripe Checkout/Billing/Portal slice with local
control-plane projections and billing gates before adding more billing product
surface.
