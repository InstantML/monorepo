# Design: Organization Workspace Selector

Date: 2026-05-26

Status: Accepted

Owner: Codex

## Summary

InstantML treats an organization as the workspace container for v1. The product
hierarchy remains `organization/workspace -> project -> runs`; no separate
workspace table is introduced.

This change makes the model explicit for returning users: a user can own one
personal workspace, belong to many organization workspaces, create another
organization from the dashboard, switch workspaces from the top-right account
menu, and manage billing at the active organization level.

## Goals

- Keep `OrganizationRow` as the source of truth for workspaces.
- Add a browser-session organization creation endpoint without changing the
  bootstrap `POST /api/orgs` route.
- Make the account/workspace menu the primary organization switcher.
- Keep role wire values compatible while presenting clearer role labels:
  Owner, Admin, Write/read, and Read only.
- Preserve org-scoped billing and invitation expiration behavior.

## Non-Goals

- No Clerk Organizations integration.
- No separate `Workspace` storage entity.
- No multi-org nested workspace hierarchy.
- No role wire rename from `member`/`viewer`.

## Proposed Design

Backend:

- Add `POST /api/orgs/current-user` on the control plane. It requires a browser
  session and mutation-origin validation.
- Accept only user-facing `account_type` values `personal` and `business`.
  Existing bootstrap/admin paths may continue to use legacy `customer`.
- Enforce at most one personal workspace per owner user.
- Create the owner membership immediately.
- For paid plans, create Stripe Checkout and mark the org billing account as
  `checkout_pending` until Stripe sync/webhook confirms payment.
- For free hosted orgs, ensure the tenant route and optionally mint a copy-once
  onboarding API key.
- Use token-backed invitation records for initial teammate invitations when
  the workspace can send immediately. Paid checkout workspaces defer teammate
  invitations until checkout completes so unpaid orgs cannot send invites or
  consume seats before billing is active.
- Return a refreshed session payload and Set-Cookie when the caller creates or
  switches into a workspace.

Frontend:

- Replace the interactive left-side org switcher with passive workspace
  context.
- Add a top-right account/workspace menu that shows the signed-in user, current
  workspace, searchable memberships, create workspace, settings, billing, and
  sign out.
- Add a compact create-workspace modal with Personal workspace / Organization,
  name availability, plan selection, hosted/BYOC storage, and optional teammate
  invitations.
- Centralize role labels and capability checks so read-only users can view run
  data but cannot activate mutation controls.

## Component Impact

Backend:

- Auth/org store, org HTTP handlers, OpenAPI, billing checkout state, and
  session switching.

Frontend:

- Dashboard topbar, settings/API role labels, account avatar/workspace menu,
  create workspace modal, and role-based mutation affordances.

Docs:

- Rust server README, web README, and this design doc.

## Data Model

- No new table.
- `OrganizationMembershipSummary` gains `account_type`, `is_personal`,
  `role_label`, and `capabilities`.
- New request/response structs model browser-session organization creation.

## API Contracts

`POST /api/orgs/current-user`

```json
{
  "name": "Acme Research",
  "account_type": "business",
  "plan_tier": "free",
  "storage_choice": "instantml-hosted",
  "initial_invitations": [{ "email": "teammate@example.com", "role": "member" }],
  "switch_on_create": true
}
```

Response includes `organization`, `membership`, `memberships`, and optionally
`session`, `billing_checkout`, and `onboarding_api_key`.

`GET /api/orgs/memberships`

- Preserves existing fields.
- Adds role labels and capabilities for the account/workspace menu.

## Performance Considerations

The membership endpoint remains a bounded per-user control-plane summary. It
counts active members per visible org, which is acceptable for the near-term
small-team target. No metric or artifact hot path changes are introduced.

## Simplicity Review

The design keeps the current org-centric storage model and avoids duplicating
workspace state. The only new backend route exists because overloading the
bootstrap `POST /api/orgs` route would mix operator and browser authorization.

## Failure Modes

- Duplicate personal workspace returns conflict.
- Duplicate org slug returns conflict.
- Paid org creation can leave an org in checkout-pending state if Checkout is
  abandoned; billing write gates already block product writes in that state.
- Paid org creation rejects inline initial invitations before persisting the
  org. Users can invite teammates after checkout unlocks the workspace.
- Invitation send failure is surfaced through the invitation delivery status.
- Viewers may still try hidden actions via direct requests; backend scopes
  remain authoritative.

## Testing Plan

- Backend unit tests for personal uniqueness, user-facing account type
  validation, membership summaries, role gates, and fresh-session switching.
- Backend API/OpenAPI coverage for the new route.
- Frontend tests for role labels, menu/modal source contracts, and permission
  affordance visibility.
- Smoke verification for free create/switch and paid checkout URL behavior.

## Documentation Plan

- Update `apps/rust-server/README.md` with the browser-session organization
  creation endpoint and account/workspace semantics.
- Update `apps/web/README.md` with the top-right account/workspace menu and
  create-workspace flow.

## Review Notes

Fresh backend reviewer:

- Finding: do not overload bootstrap `POST /api/orgs`; use a dedicated
  browser-session route.
- Risk: `customer` currently behaves like personal/shared routing and should
  not be accepted by the user-facing create flow.
- Recommended edit: add `POST /api/orgs/current-user`, keep roles wire
  compatible, and prefer fresh sessions on switching.
- Decision: accepted.

Fresh frontend reviewer:

- Finding: the current `OrgSwitcher` is a listbox and the avatar is a passive
  desktop-only div.
- Risk: a mixed action selector needs menu/dialog semantics and mobile reach.
- Recommended edit: add `AccountWorkspaceMenu` and a separate create modal.
- Decision: accepted.

Fresh UX reviewer:

- Finding: avatar-only switching is not discoverable enough.
- Risk: two switchers create trust issues.
- Recommended edit: make the top-right trigger workspace-aware and leave the
  left workspace text passive.
- Decision: accepted.

Post-implementation frontend/UX reviewer:

- Finding: the smoke test ignored generic 403 resource errors, the personal
  signup field still said organization, and the create modal could briefly
  reuse stale positive name availability.
- Decision: accepted. The smoke now allowlists only expected 403 paths, the
  personal signup field is workspace-labeled, and create availability is tied
  to the checked name.

Post-implementation backend/security reviewer:

- Finding: paid org creation needed a recoverable checkout intent and a write
  blocking account projection before contacting Stripe, and owner self-invite
  checks needed case-insensitive comparison.
- Decision: accepted. Paid create now persists `checkout_initializing`, blocks
  writes with `checkout_pending`, records `checkout_failed` on Stripe setup
  failure, and compares owner invite email case-insensitively.

Post-implementation E2E reviewer:

- Finding: read-only coverage hid controls but did not prove direct browser
  session mutations were denied.
- Decision: accepted. The UI smoke now asserts viewer 403s for run creation,
  invitation creation, API key creation, and shared workspace view creation.

Final senior backend/security reviewer:

- Finding: auto-derived personal signups could still carry teammate seats when
  the requested `account_type` was `business`; duplicate seat adds could update
  Stripe before detecting an existing member or pending invite; paid workspaces
  needed to remain paid-but-blocked if checkout persistence failed; checkout
  sync needed a local intent org assertion; saved dashboard/view writes also
  needed billing-state gates.
- Decision: accepted. Effective personal workspace type is now validated after
  derivation, paid org rows keep their requested plan tier while billing
  projects `effective_plan_tier = free` until checkout completes, duplicate
  member/invite checks run before capacity billing, checkout sync rejects local
  intent org mismatches, and dashboard preference/workspace view writes call
  the billing write gate.

Final senior frontend/QA reviewers:

- Finding: smoke coverage should prove seeded run evidence and artifact paths,
  workspace switching, role labels, viewer denials, and modal/menu focus flows
  rather than accepting empty states.
- Decision: accepted. The full UI smoke seeds a concrete run with metrics,
  notes, artifacts, logs, and rich objects; exercises organization creation,
  switching, personal workspace restrictions, invite expiration/seat behavior,
  role labels, viewer direct mutation denials, and data isolation; and keeps the
  menu/modal focus and mobile affordances under test.

Final blocker re-review:

- Backend/security finding: browser device-code confirmation still let a viewer
  mint an SDK ingest key, checkout-pending BYOC orgs could configure customer
  ClickHouse before payment, checkout-pending paid orgs could self-downgrade,
  and user-created paid orgs without a billing projection looked active.
- Decision: accepted. Device-code confirmation now requires mutation-origin,
  non-demo, active admin membership, billing write allowance, and storage
  readiness. BYOC validation/create/rotate call the billing write gate.
  Checkout-pending and customer-ClickHouse workspaces cannot downgrade to free,
  and user-created paid orgs with missing billing projections fail closed as
  `checkout_pending` with effective free access until Stripe sync confirms.
- Frontend/QA finding: the full smoke exposed production UI bugs around the
  hover-expanded nav intercepting metric-catalog clicks, Metrics rendering an
  empty chart when no selected run was visible, fullscreen range zoom rejecting
  tiny domains, and project/search filters leaking between deep checks.
- Decision: accepted. The nav expansion now overlays only while the rail is in
  its explicit auto-open state and collapses after tab selection, the smoke
  clears stale cross-page selections and selects a visible run before Metrics
  assertions, range zoom uses a percentage threshold for small domains, and the
  smoke explicitly restores filters before multi-run assertions.
- Test harness finding: local stress can generate retry-backed 429s while
  browser console messages omit URLs.
- Decision: accepted. Project/usage reads now use transient retry handling, and
  the smoke only allowlists concrete retry-backed/media-preview 429 endpoints
  while preserving hard failures for unexpected rate-limited URLs.

Final production-readiness re-review:

- Backend/security finding: paid personal workspaces could inherit multi-seat
  paid limits after checkout/subscription sync, personal workspaces could still
  accept invite/seat paths, BYOC cancellation could downgrade a customer-owned
  ClickHouse workspace to Free, and Stripe checkout creation failures for new
  paid orgs needed a retryable control-plane state.
- Decision: accepted. Billing seat limits now stay at one for personal
  workspaces, personal invite/seat mutation paths are rejected, BYOC subscription
  end keeps the workspace Premium but canceled/blocked until storage is
  migrated, and failed new-org checkout returns a retryable `checkout_failed`
  intent without undoing the recoverable workspace/session state.
- Frontend/UX finding: org-local saved views and workspace layouts needed to be
  scoped by active org, hover-expanded nav labels were hidden by a later CSS
  rule, stale selected run ids could default-select the whole result set, and
  scoped local saved views needed to hydrate when the active org becomes known.
- Decision: accepted. Browser persistence keys are org-scoped, the nav auto-open
  cascade is fixed, invalid explicit selections now clear instead of selecting
  all visible runs, and active-org hydration merges local saved views before the
  workbar selector is used.
- E2E finding: the full workspace smoke should click through the scoped local
  saved-view path and paid checkout path rather than only asserting backend
  payloads.
- Decision: accepted. The full UI smoke writes a real scoped local-view key,
  waits for it in the selector, validates off-page selections, exercises free
  organization create/switch and viewer isolation, and smoke-tests mock paid
  checkout/sync before returning to the active org.
- Backend/security finding: paid checkout sync still assumed the user had
  already switched into the checkout org, the legacy reserved-seat endpoint
  could invite into personal workspaces with stale multi-seat capacity, and
  create-org initial invitation delivery failures were not surfaced in the
  response.
- Decision: accepted. Checkout sync now authorizes against the checkout
  session's org, with local intent fallback when metadata is absent; personal
  workspaces reject legacy reserved-seat invites even if old capacity data says
  otherwise; and `POST /api/orgs/current-user` returns per-invite delivery
  status so the UI can expose retryable send failures.
- Frontend/QA finding: failed workspace switches were only rendered inside the
  menu that closes before the failure returns, Metrics could show `0/N selected`
  while rendering all visible runs, current-plan checkout failures had no retry
  affordance in Settings, and legacy unscoped local saved views could disappear.
- Decision: accepted. Switch failures now also use the persistent dashboard
  message, metric catalog counts use the same effective run scope as charts,
  Settings exposes `Retry Pro`/`Retry Premium` when checkout is pending without
  a subscription, and legacy local saved views migrate into the active org
  namespace.
- Backend/security finding: replaying an old fulfilled Checkout Session after
  cancellation could reactivate billing locally, and `status = complete` was
  treated as paid even when Stripe still reported `payment_status = unpaid`.
- Decision: accepted. Fulfilled checkout intents are idempotent only while the
  matching billing account is still paid-active; replay after cancellation or
  payment blocking is rejected, and checkout fulfillment now requires
  `payment_status = paid`.

## Decision

Accepted for implementation.
