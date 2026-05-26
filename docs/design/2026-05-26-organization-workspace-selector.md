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

## Decision

Accepted for implementation.
