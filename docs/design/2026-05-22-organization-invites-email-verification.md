# Design: Organization Invites And Email Verification

Date: 2026-05-22

Status: Implemented first slice

Owner: Codex

## Summary

InstantML currently has the control-plane pieces for team access: owners and
admins can reserve an invited seat by email, sign-in activates the invited
membership when the provider-verified email matches, and active members can
view the same org's projects and run data. The missing product slice is the
actual invite email, a secure accept link, resend/revoke state, and clear
control-plane records that survive split control/data services.

This design keeps InstantML organizations, memberships, roles, sessions, API
keys, and tenant routes as the source of authorization truth. Clerk remains the
human identity provider and verified-email source. A delivered invite link does
not by itself grant org access; it only identifies a pending invitation. The
server grants access only after a verified Clerk or local-dev identity has a
primary email that matches the invited email and the invite token is still
valid.

The implemented first slice adds app-owned invite tokens, a
send-only transactional email adapter, an accept flow in the web app, fresh
session issuance for the accepted org, and control-plane records that make the
new active membership visible to the dashboard. Delivery webhooks and richer
provider status handling are deferred to a second slice so the authorization
flow can land without coupling it to provider event ordering.

Implementation landed on 2026-05-22 in `apps/rust-server`,
`apps/web`, and `tools/deploy-cloud-run.mjs`. It includes the `log` provider,
Resend send-only delivery, admin invitation create/list/resend/revoke routes,
`/invite#t=...` preview/accept, `accept_invite_token` auth exchange support,
fresh accepted-org sessions, seven-day invitation expiration, pending-invite
seat accounting, generated OpenAPI bindings, and staging deploy wiring for
Resend secrets.

## Research Notes

- OWASP's reset-link guidance is directly applicable to invite links: tokens
  should be generated with a cryptographically secure random generator, be long
  enough to resist brute force, be stored securely, be invalidated after use,
  use HTTPS, avoid Host-header-derived URLs, and protect against referrer
  leakage and brute forcing. Source:
  [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
- Gmail sender guidance requires at least SPF or DKIM for all senders, SPF plus
  DKIM plus DMARC for bulk senders, and From-domain alignment with SPF or DKIM
  to pass DMARC. Even though org invites are transactional, InstantML should set
  SPF, DKIM, DMARC, and a custom return path before enabling hosted email.
  Source:
  [Google email sender guidelines](https://support.google.com/a/answer/81126?hl=en).
- Clerk application invitations can send a unique invite link and can redirect
  to an app URL. Clerk also notes that accepted application invitations can
  auto-verify the user's email. This is useful context, but the current
  InstantML architecture intentionally does not use Clerk Organizations and
  should not move org authorization into Clerk metadata. Source:
  [Clerk invite users guide](https://clerk.com/docs/guides/users/inviting).
- Clerk's backend invitation API supports `redirectUrl`, `publicMetadata`,
  `notify`, `ignoreExisting`, and expiration options, but it is also a Clerk
  application-level invitation surface. It can remain an alternative sender for
  identity onboarding, not the first source of org membership truth. Source:
  [Clerk createInvitation reference](https://clerk.com/docs/reference/backend/invitations/create-invitation).
- Resend documents domain verification, SPF, DKIM, custom return path, domain
  status, and webhook event types for delivered, bounced, complained, delayed,
  failed, sent, and suppressed email. It also documents at-least-once webhook
  delivery with duplicate handling via `svix-id`. Sources:
  [Resend domains](https://resend.com/docs/dashboard/domains/introduction),
  [Resend webhook events](https://resend.com/docs/webhooks/event-types), and
  [Resend webhook delivery](https://resend.com/docs/webhooks/introduction).
- AWS SES is a credible future provider, especially because SES can publish
  bounce, complaint, and delivery notifications through SNS, but it has more
  operational surface than the first InstantML slice needs. Source:
  [Amazon SES SNS notifications](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html).
- GitHub's org invitation behavior is useful prior art: email-based org invites
  can only be accepted by accounts with a matching verified email, and pending
  invitations expire. Source:
  [GitHub organization invitations](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization).

## Goals

- Send real transactional organization invite emails from InstantML-controlled
  org admin actions.
- Require a verified identity-provider email that matches the invite email
  before activating an org membership.
- Store invite, delivery attempt, resend, revoke, expiration, and acceptance
  state in the User Data control plane.
- Keep active membership in the InstantML control plane as the only gate that
  lets a person view org run data.
- Preserve existing SDK/API-key behavior and route-shape compatibility for run,
  metric, artifact, and export endpoints.
- Make the local/test path deterministic without a real email provider.
- Keep provider lock-in low by introducing a thin email provider adapter rather
  than scattering Resend calls through auth and org code.

## Accepted First Slice

Implement this design in phases. The first implementation slice should include:

- Control-plane `org_invitation` token records.
- Local `log` email provider for deterministic tests.
- Resend send-only provider for hosted invite emails, without webhook handling.
- Admin create/list/resend/revoke invitation routes.
- `/invite` frontend preview and accept route.
- `accept_invite_token` support in hosted Clerk and local dev auth exchange.
- Fresh browser session token issued on successful accept, bound to the invited
  org.
- Hosted-mode removal of tokenless invite activation for real invitations.
- Role-specific authorization tests for accepted invitees reading run data.

Defer to slice 2:

- Resend webhook endpoint and delivery-status precedence.
- Complaint/suppression automation beyond blocking manual resend after a known
  failed provider response.
- SES provider.
- Background outbox workers or queue-backed retry.

## Non-Goals

- No Clerk Organizations migration.
- No SSO/SAML, SCIM, domain-claiming, or directory sync.
- No marketing email, contact lists, newsletters, or unsubscribe-product work.
- No passwordless auth implementation owned by InstantML; Clerk still owns
  hosted human sign-in.
- No new SDK public API.
- No changes to metric ingestion, artifact storage, or tenant data schemas.
- No promise that invite email delivery is invoice-grade or compliance-grade.

## Users and Use Cases

Owner/admin:

1. Opens Settings -> Seats.
2. Enters an email and role.
3. InstantML reserves a pending invitation, creates an invite token, sends a
   transactional email, and shows pending delivery/acceptance state.
4. Owner/admin can resend or revoke the invitation.

Invited teammate:

1. Receives an email with an InstantML invite link.
2. Opens the link, signs in or signs up with Clerk if needed.
3. InstantML verifies the Clerk primary email and accepts the invite only if it
   matches the invited email.
4. InstantML creates the active membership, issues a fresh browser session for
   the invited org, and routes the teammate to the dashboard where the org's
   projects and run data are visible.

Operator:

1. Configures a sending domain, SPF, DKIM, DMARC, custom return path, provider
   API key, and optional webhook secret.
2. Reads invite and send-attempt records from User Data.
3. Can disable hosted email or fall back to log-only delivery during incidents.

## Proposed Design

### Ownership Boundary

Use this split:

- Clerk owns hosted identity, sign-in UX, and verified primary email.
- InstantML owns organization IDs, memberships, roles, invite records, session
  binding, API keys, tenant routes, and run-data authorization.
- The email provider owns message delivery only. Provider delivery status is
  advisory and never grants access.

Do not rely on Clerk public metadata for org authorization. Metadata can be
useful for UX, but the Rust control plane must independently check the invite
token, email, org, role, status, expiry, billing gate, and seat limit before
activating the membership.

### Invite Token Rules

- Generate a 32-byte or larger random token with a CSPRNG and encode it as
  URL-safe base64 without padding.
- Store only a server-side hash of the token, using the existing secret-hashing
  style for sessions/API keys where possible.
- Make tokens one-time use. Accepting, revoking, or expiring an invitation makes
  the token unusable.
- Default expiry: 7 days. This matches common org-invite expectations and is
  shorter than Clerk's one-month application invitation default.
- Keep invite URLs under the configured `INSTANTML_FRONTEND_BASE_URL`; never
  derive the public URL from the incoming Host header.
- Put the secret in a URL fragment, for example
  `https://app.instantml.ai/invite#t=<token>`, so the token is not sent to the
  frontend server, reverse proxies, or normal HTTP request logs.
- The invite page must read the fragment once, immediately call
  `history.replaceState` to remove it from the address bar, keep it in memory
  where possible, and set `Cache-Control: no-store` plus
  `Referrer-Policy: no-referrer`.
- If a full-page Clerk handoff requires persistence, store the token in
  `sessionStorage` with a short timestamped envelope, clear it on success,
  expiry, mismatch, logout, and page unload where practical, and never copy it
  into analytics, crash reports, visible errors, or logs.
- Redact invite tokens from application logs, UI errors, webhook records, and
  analytics events.
- Rate-limit token preview and accept attempts by IP, token hash prefix, and
  normalized email where available.

### Email Normalization

Use one documented normalization rule everywhere the invite email participates
in identity matching, rate limits, seat counts, and display:

- Trim leading/trailing whitespace.
- Apply the current server email validator.
- Lowercase the stored comparison value with the existing ASCII-lowercase
  behavior.
- Require exact equality with the Clerk primary verified email after the same
  server normalization.
- Do not apply provider-specific canonicalization such as Gmail dot removal or
  plus-address stripping.
- Do not silently merge Unicode variants. If IDNA/unicode normalization becomes
  important, add it in a separate auth-storage design and migration.

### Sending Domain And Provider

Add an email provider boundary in `apps/rust-server`:

```text
EmailSender
  send_org_invite(input) -> EmailSendResult

Providers:
  log      local/test; writes the rendered link to structured test state/logs
  resend   first hosted provider, send-only in slice 1
  ses      future provider, not implemented in the first slice
```

Hosted email should be disabled unless all required config is present:

- `INSTANTML_EMAIL_PROVIDER=log|resend`
- `INSTANTML_EMAIL_FROM`, required for Resend and set to a verified sender,
  such as `InstantML <invites@mail.instantml.ai>`
- `INSTANTML_EMAIL_REPLY_TO`, optional
- `INSTANTML_FRONTEND_BASE_URL`, required for hosted invite URLs
- `RESEND_API_KEY`, required for `resend`
- `RESEND_WEBHOOK_SECRET`, required only for the deferred webhook slice

Operational DNS checklist before enabling `resend` in production:

- Use a stable sending subdomain, such as `mail.instantml.ai` or
  `notify.instantml.ai`.
- Configure SPF or a provider custom return path, DKIM, DMARC, and DMARC
  reports.
- Use aligned From/return-path/DKIM domains where possible.
- Start with a conservative DMARC policy such as `p=none` while monitoring
  reports, then move toward stricter policy after normal traffic is known.
- Keep invite messages transactional: clear product/org context, no marketing
  copy, no tracking pixels in the first slice, and no list-unsubscribe headers
  unless a future subscribed-message category is added.

### Abuse Controls

Invite creation and resend are the reputation-sensitive paths. The first slice
should enforce conservative defaults, configurable by operators:

- Per org: at most `max(5, seat_limit * 3)` invite send attempts per rolling
  24 hours.
- Per admin user: at most 10 invite send attempts per hour and 50 per rolling
  24 hours.
- Per recipient per org: at most 3 send attempts per rolling 24 hours.
- Per recipient globally: at most 5 send attempts per rolling 24 hours.
- Resend cooldown: at least 15 minutes between sends for the same pending
  invitation.
- Free orgs cannot send more than 5 invite emails per 24 hours even if the
  global default is higher.
- A known bounce, complaint, suppression, or provider rejection blocks further
  resend to that recipient until an admin changes the email or an operator
  clears the suppression.
- Every create, resend, revoke, and accept action writes an invite control
  record that is sufficient for an audit trail without storing raw tokens.

### Invite Creation

Prefer a new explicit route:

```text
POST /api/orgs/:org_id/invitations
```

Request:

```json
{
  "email": "teammate@example.com",
  "role": "member"
}
```

Auth:

- Owner/admin browser session for the same org.
- Bootstrap token for local/operator setup.
- Shared demo sessions cannot invite.

Behavior:

1. Validate origin for cookie-authenticated mutation.
2. Normalize the email and validate role. Invited users can be `admin`,
   `member`, or `viewer`, not `owner`.
3. Run the billing write gate before reserving a seat.
4. Check active memberships plus pending, unexpired invitations against plan
   seat limit and paid extra-seat state.
5. If the invited email already maps to a legacy
   `MembershipRow.status="invited"` seat for the org, treat the token invite as
   the delivery mechanism for that existing reserved seat instead of reserving
   another seat.
6. Reuse an existing pending invitation for the same org/email/role when
   reasonable, or create a new token when resending after expiry/revocation.
7. Do not create an active or invited `MembershipRow` yet for new invitees. The pending
   `org_invitation` itself reserves the seat until it is accepted, revoked, or
   expired.
8. Write an `org_invitation` control record with status `pending`.
9. Write an `email_delivery` attempt record, send the email outside the store
   lock, then persist the best-effort send result.
10. Return the safe invitation summary. In local `log` provider mode only,
   include a development-only preview link.

Keep the existing `POST /api/orgs/:org_id/seats` as a compatibility/admin route
for legacy "reserve without sending" during local tests and migration. Hosted
real-invite activation must not auto-activate these tokenless rows unless an
explicit operator migration flag is enabled. The Settings UI should move to the
new invitations route when this design is implemented.

### Invite Email Content

The email should be simple and transactional:

- Subject: `<inviter or org> invited you to InstantML`
- From: configured InstantML transactional address.
- To: invited email.
- Body: org name, inviter display name/email if available, role, expiry date,
  single accept button/link, and support contact.
- Do not include run names, project names, artifact names, API keys, tokens
  other than the accept URL, or tenant IDs.
- Add provider tags/metadata: `category=org_invite`, `invite_id`, and
  environment. Do not tag with raw email, run data, or tenant route details.

### Invite Preview And Acceptance

Frontend route:

```text
/invite#t=<token>
```

Phase 1 API routes:

```text
POST /api/invitations/preview
POST /api/invitations/accept
```

Preview request:

```json
{ "token": "..." }
```

Preview response:

```json
{
  "invitation": {
    "org_name": "Acme Research",
    "role": "member",
    "expires_at": "2026-05-29T00:00:00Z",
    "status": "pending",
    "email_hint": "t***@example.com"
  },
  "authenticated": false,
  "requires_matching_email": true
}
```

Accept request:

```json
{ "token": "..." }
```

Auth:

- Browser session required.
- Clerk/local provider email must be verified and normalized.
- In managed Clerk mode, browser-session accept is disabled; `/invite` must
  exchange a fresh Clerk token through `POST /api/auth/clerk` with
  `accept_invite_token` so the server reconciles the current verified provider
  email immediately before acceptance.

Accept behavior:

1. Hash token and look up a pending unexpired invitation.
2. Resolve the current browser session and user.
3. Require the session user's verified primary email to equal the invited email.
4. Re-check that the org exists, billing allows seat activation, and active
   memberships plus other pending invitations still fit the plan. If the seat
   was paid separately, use the billing projection's paid extra seats.
5. Create the `MembershipRow` as `status="active"` for the invited email/user,
   activate an existing legacy `status="invited"` membership for the same
   org/user, or reuse an active membership for the same org/user if a previous
   accept response was lost.
6. Write `org_invitation.status="accepted"` with `accepted_by_user_id` and
   `accepted_at`.
7. Always create a fresh browser session row and set a fresh session cookie
   bound to the accepted org. Do not mutate an existing session in place, so
   split data-plane services cannot keep using a cached old session/org tuple.
8. Return `AuthSessionPayload` plus a redirect target such as
   `/dashboard/runs`.

Accept idempotency:

- If the same verified user retries after a successful accept and the
  invitation is already accepted by that user, return success with a fresh
  session payload instead of `invite_already_accepted`.
- If a different user retries an accepted token, return `invite_already_accepted`.
- Revoked and expired invitations never become successful through retry.

Extend `POST /api/auth/clerk` and `POST /api/auth/dev/google` with optional
`accept_invite_token` for a smoother unauthenticated flow. In hosted mode, an
invited membership must not be activated by `accept_invite_org_id` or by
"single pending invite" auto-activation once this design is implemented. Those
tokenless paths may remain for local/dev or explicit operator migration only,
behind a documented off-by-default flag.

### Frontend Invite State

The `/invite` page should use a small explicit state machine:

- `reading_token`: read `#t=...`, remove it from history, set no-store/no-referrer.
- `preview`: call `/api/invitations/preview` with the token.
- `needs_auth`: show Clerk sign-in/sign-up. Persist the token only if the Clerk
  handoff requires a reload.
- `wrong_email`: signed-in email does not match; show the masked invited email
  and a sign-out/retry action.
- `ready_to_accept`: matching verified session is present.
- `accepted`: accept succeeded, clear token storage, redirect to dashboard.
- `expired_or_revoked`: clear token storage and ask for a fresh invite.
- `error`: clear token storage unless the error is retryable.
- `wrong_email` keeps the in-memory token and refreshes the short
  `sessionStorage` envelope before signing out, so a Clerk reload during
  account switching does not strand the user.

### Run Data Access After Acceptance

No tenant data-plane rows need to change. Run-data access follows existing
context resolution:

```text
Browser session cookie
  -> User Data session record
  -> active MembershipRow for session.org_id
  -> tenant route for org_id
  -> product routes read projects/runs/metrics/artifacts for that org_id
```

After acceptance, the session payload should include the active membership and
the invited org in `memberships`. The dashboard org switcher can then show the
workspace, and product routes should use the newly issued `session.org_id` to
show that org's run data. In split control/data mode, the new session token
forces a new control lookup path instead of relying on an old cached session.

Role expectations for the first slice:

| Surface | Viewer | Member | Admin | Owner |
| --- | --- | --- | --- | --- |
| Project list, run summaries, run detail, metric series, logs, artifact list/download | yes | yes | yes | yes |
| Export/read-only data egress | yes, matching current `export:read` session scope | yes | yes | yes |
| Save dashboard/workspace views | no | yes | yes | yes |
| Edit tags/notes or other dashboard annotations | no | yes | yes | yes |
| Create runs, ingest metrics, upload artifacts, imports | no | yes, matching current session scope | yes | yes |
| Create/revoke API keys | no | no | yes | yes |
| Invite/resend/revoke seats | no | no | yes | yes |
| Billing, plan changes, usage admin | no | no | yes where already allowed | yes |

The first slice should match the existing session scope model unless a route is
explicitly changed under this design. Any mismatch between UI affordances and
server enforcement must be fixed before implementation is considered done.

### Service-Plane Routing

All new invite and email routes are control-plane routes:

- Invitation create/list/resend/revoke.
- Invite preview/accept.
- Auth exchange with `accept_invite_token`.
- Resend webhook route in the deferred slice.

They should be exposed only by `combined` and `control` service-plane roles.
The `data` service-plane role should not expose these routes. Same-origin
frontend rewrites for `/invite` and Settings invitation actions must target the
control API base in split deployments. OpenAPI role-filter tests should prove
the route split.

### Resend And Webhook Handling

Deferred slice 2 adds:

```text
POST /api/email/webhooks/resend
```

Behavior:

- Verify the Resend/Svix signature using `RESEND_WEBHOOK_SECRET`.
- Store processed webhook delivery IDs idempotently. Resend documents
  at-least-once delivery, so duplicate events must be no-ops.
- Treat event order as non-deterministic; use provider timestamps for display
  but do not rely on ordering for authorization.
- Store only allowlisted webhook summaries. Do not store raw provider payloads,
  message bodies, headers, full recipient lists, click URLs, or raw suppression
  details in append-only User Data records.
- Map `email.delivered`, `email.bounced`, `email.complained`,
  `email.delivery_delayed`, `email.failed`, and `email.suppressed` into
  `email_delivery` updates.
- On hard bounce or complaint, mark the invitation delivery as failed and
  surface the status to admins. Do not automatically activate, revoke, or delete
  memberships from delivery webhooks.

## Component Impact

Backend:

- Add email config and provider adapter.
- Add invite token generation/hash helpers.
- Add `org_invitation` and `email_delivery` control record kinds in slice 1.
  Add `email_webhook_event` in slice 2.
- Add invitation routes, accept flow, resend/revoke flows, and Resend send-only
  provider in slice 1. Add Resend webhook in slice 2.
- Extend Clerk/dev auth request DTOs with `accept_invite_token`.
- Keep `/api/orgs/:org_id/seats` for compatibility, but move product UI to the
  invitation routes.
- Update OpenAPI annotations and regenerate API types during implementation.

Frontend:

- Add `/invite` route with preview, sign-in/sign-up handoff, wrong-email
  recovery, expired/revoked states, and post-accept redirect.
- Update Settings seats panel to show pending/sent/failed/accepted invitation
  states and resend/revoke actions. In slice 1, delivered/bounced/complained
  status may be unavailable until webhooks land.
- Change the existing "Invite" action from "reserve seat only" to "send invite"
  when hosted email is configured.
- Preserve local/test UX by showing a copyable invite link only in log-provider
  local mode, never in hosted production responses.

Python SDK:

- No public API change.
- SDK writes remain controlled by API keys. Human invite acceptance does not
  mint SDK keys automatically for invitees unless a future onboarding design
  explicitly allows it.

Storage:

- Add low-volume User Data control records only.
- No tenant metric/product table changes.
- No artifact storage changes.

Docs:

- Update Rust server README, web README, current API reference, current schema
  reference, auth/tenant flow docs, product/user docs, and design index during
  implementation.

## Data Model

New control record kind in slice 1: `org_invitation`.

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "membership_id": null,
  "email": "teammate@example.com",
  "role": "member",
  "status": "pending",
  "token_hash": [1, 2, 3],
  "token_prefix": "optional-safe-prefix",
  "invited_by_user_id": "uuid",
  "created_at": "2026-05-22T00:00:00Z",
  "expires_at": "2026-05-29T00:00:00Z",
  "last_sent_at": "2026-05-22T00:00:00Z",
  "accepted_at": null,
  "accepted_by_user_id": null,
  "revoked_at": null,
  "revoked_by_user_id": null,
  "delivery_status": "sent",
  "provider": "resend",
  "provider_message_id": "email-id"
}
```

Statuses:

- `pending`
- `accepted`
- `revoked`
- `expired`

Delivery statuses in slice 1:

- `not_sent`
- `sent`
- `send_failed`

Additional delivery statuses in slice 2:

- `delivered`
- `delivery_delayed`
- `bounced`
- `complained`
- `suppressed`

Seat accounting:

- Active `MembershipRow.status="active"` records consume active seats.
- Pending, unexpired `org_invitation.status="pending"` records consume
  reserved seats.
- Pending invitations whose email already maps to an active or legacy invited
  membership in the same org do not consume an additional seat.
- Revoked, expired, or accepted invitation records do not consume reserved
  seats after replay. Accepted invitations consume seats through the active
  membership created at accept time.
- Legacy `MembershipRow.status="invited"` rows from `/seats` remain
  compatibility records. Token invites may activate them, but hosted
  tokenless activation remains disabled by default.

New control record kind in slice 1: `email_delivery`.

```json
{
  "id": "uuid",
  "org_id": "uuid",
  "kind": "org_invite",
  "related_id": "invitation_uuid",
  "provider": "resend",
  "provider_message_id": "email-id",
  "to_email": "teammate@example.com",
  "status": "sent",
  "attempt": 1,
  "created_at": "2026-05-22T00:00:00Z",
  "updated_at": "2026-05-22T00:00:00Z",
  "last_error": null
}
```

New control record kind in slice 2: `email_webhook_event`.

```json
{
  "id": "svix-id-or-provider-event-id",
  "provider": "resend",
  "event_type": "email.delivered",
  "provider_message_id": "email-id",
  "received_at": "2026-05-22T00:00:00Z",
  "processed_at": "2026-05-22T00:00:00Z"
}
```

Use complete JSON payloads for InstantML domain records such as
`org_invitation`, but store only allowlisted summaries for provider webhook
events. Do not persist raw webhook JSON in User Data.

## API Contracts

Phase 1 routes:

```text
POST /api/orgs/:org_id/invitations
GET  /api/orgs/:org_id/invitations
POST /api/orgs/:org_id/invitations/:invitation_id/resend
POST /api/orgs/:org_id/invitations/:invitation_id/revoke
POST /api/invitations/preview
POST /api/invitations/accept
```

Phase 2 route:

```text
POST /api/email/webhooks/resend
```

Changed routes:

- `POST /api/auth/clerk`: accepts optional `accept_invite_token`.
- `POST /api/auth/dev/google`: accepts optional `accept_invite_token` for local
  smoke coverage.
- `POST /api/orgs/:org_id/seats`: retained for compatibility and local reserve
  without email. Hosted tokenless activation must be disabled by default.

Common error codes:

- `invite_not_found`: token or invite id not found.
- `invite_expired`: token expired.
- `invite_revoked`: invite was revoked.
- `invite_already_accepted`: invite already used by another user.
- `invite_email_mismatch`: signed-in verified email does not match invite.
- `email_delivery_unavailable`: provider config missing or provider call failed.
- `plan_limit_exceeded`: seat limit or usage limit blocks the invite.
- `payment_required`: billing state blocks seat changes.

## Performance Considerations

- Invite and email records are low-volume control-plane writes.
- Expected write frequency is admin-driven, not hot path. A busy org might send
  dozens of invites, not thousands per minute.
- List endpoints should be bounded and paginated from the start. Default 100,
  max 500 invites per page is enough for the first slice.
- Preview and accept endpoints do one token lookup plus control-plane state
  checks. They should not touch tenant metric tables.
- Email sending must happen outside the store lock. Persist the pending invite
  first, persist an attempt id, send once, then persist best-effort delivery
  state. This is not atomic with the external provider.
- Invite accept/revoke/resend routes remain single-active-control-writer
  correctness paths until the broader control-plane compare-and-set/write
  coordination gates exist.
- Webhooks in slice 2 are at-least-once and low-volume. Process one webhook in
  a bounded request and make duplicate records harmless through replay and
  delivery-status precedence.
- No metric series, run summary, or artifact paths change.

## Simplicity Review

This design extends the existing org/membership model instead of introducing a
new permission system. It uses Clerk only for identity verification and keeps
org authorization state in InstantML's control plane, which matches the current
hosted architecture. It adds a provider adapter because direct Resend calls in
handlers would be simple today but expensive to unwind later.

Deferred complexity:

- Clerk Organizations.
- Domain-claim auto-join.
- SSO/SAML/SCIM.
- Multiple email providers in the first implementation.
- Background delivery workers or queues.
- Resend webhooks and delivery-status precedence.
- Marketing/subscription email compliance.
- Automatic SDK key creation for invitees.

## Failure Modes

- Provider send fails after control record creation: keep the invite pending,
  set delivery status to `send_failed`, and let admins resend.
- Provider send succeeds but the process fails before recording delivery state:
  the invite remains pending with an attempted send record. Admin resend uses a
  new attempt id and cooldown.
- Resend delivery fails after token rotation: keep the previously delivered
  token hashes valid until a resend succeeds, so admins do not strand users on
  a broken replacement link.
- Resend delivery succeeds: clear previous token hashes so older links stop
  resolving and only the latest delivered link can be accepted.
- Invitation is accepted, revoked, or expired: remove its token hashes from the
  in-process lookup index during replay. Terminal invite links can no longer
  preview org metadata or re-authorize a removed member.
- Provider webhook is duplicated in slice 2: skip by stored webhook event id or
  make duplicate records harmless through projection.
- Provider webhook is out of order in slice 2: update delivery status only
  through precedence rules that do not affect authorization.
- Invite token leaks in email forwarding: token alone is insufficient; the
  accepting account must have the matching verified email.
- Invite URL is opened while signed in as a different user: show email mismatch
  and offer sign-out/retry.
- Invite expires: reject accept with `410` and show "ask for a new invite".
- Seat limit changes between send and accept: reject accept with
  `plan_limit_exceeded` and keep the invite pending or expired according to
  expiry time.
- Billing enters read-only before accept: reject with `payment_required`.
- Control record is visible to control plane but not data plane yet: accept
  issues a fresh browser session, and hosted smoke must prove accepted users can
  read run data immediately after acceptance.
- Admin revokes pending invite after the email is delivered: accept rejects
  because token status is revoked.
- Concurrent accept/revoke/resend: first slice is single active control writer.
  Same-user accept retry after success returns success; different-user retry
  returns already accepted.

## Testing Plan

Unit tests:

- Token generation length, hashing, one-time use, expiry, and no plaintext
  persistence.
- Email normalization and verified-email matching.
- Role validation and owner-invite rejection.
- Invite status transitions: pending, accepted, revoked, expired.
- Delivery send-attempt status for send success/failure.
- Slice 2 webhook idempotency and out-of-order handling.
- Seat-limit and billing-gate behavior on create and accept.
- Legacy reserved seats can receive a token invite and activate without
  double-counting seats.
- Successful resend invalidates previous tokens; failed resend keeps the
  previously delivered token usable.
- Preview and accept token-attempt limits are scoped separately, with per-client
  in-memory limits and a high global backstop for bogus unique-token attempts.
  Attempts that are already rejected by the per-token cap do not burn the
  global budget.
- No hosted sign-in path can activate a pending real invitation without
  `accept_invite_token`.
- Email normalization does not apply provider-specific dot/plus canonicalization.

Backend/API tests:

- New route auth and origin requirements.
- OpenAPI route registration and generated API type drift.
- Role-filtered OpenAPI output: invite routes appear in control/combined and
  not in data service-plane output.
- Wrong-email accept returns `invite_email_mismatch`.
- Expired/revoked/accepted tokens cannot be reused.
- Existing `/seats` compatibility remains intact.
- Split control/data smoke: admin invites teammate, teammate accepts, data
  plane has previously seen the old session, accept issues a fresh session, and
  teammate can immediately read run summaries and bounded metric series for the
  invited org.
- Accepted viewer can read run summaries and bounded metric series but is denied
  API-key creation, imports, artifact upload, tag/note mutation, workspace-view
  writes, and invite routes.
- Accepted admin can invite, resend, revoke, and list invitations.

Frontend tests:

- Settings invite creation, pending list, resend, revoke, and delivery-failed
  states.
- `/invite` preview, unauthenticated sign-in handoff, wrong-email recovery,
  expired/revoked states, and successful dashboard redirect.
- No invite token appears in visible error text or analytics payload helpers.
- Fragment token is removed with `history.replaceState`; any `sessionStorage`
  token is cleared on success, mismatch, expiry, logout, and unrecoverable
  error.

Manual/provider checks:

- Resend sandbox/dev send from verified domain.
- Resend webhook signature verification with a replayed delivered/bounced event
  in slice 2.
- Gmail inbox smoke after SPF/DKIM/DMARC/custom return path are verified.

Coverage exception:

- Real mailbox deliverability cannot be fully deterministic in unit or CI
  tests.
- Risk is provider/DNS-specific delivery failure.
- Follow-up is a manual pre-launch checklist and later scheduled synthetic inbox
  monitor.

## Documentation Plan

- `apps/rust-server/README.md`: email env vars, Resend send-only config, local
  log-provider behavior, DNS checklist, service-plane route placement, and test
  commands.
- `apps/web/README.md`: `/invite` UX, Settings invite/resend/revoke controls,
  wrong-email recovery, and split control API routing.
- `docs/architecture/current-api.md`: new invitation/auth contracts, error
  codes, role matrix, and route service-plane placement.
- `docs/architecture/current-schemas.md`: `org_invitation`, `email_delivery`,
  reserved-seat counting, and legacy `/seats` compatibility semantics.
- `docs/architecture/auth-and-tenant-flow.md`: verified-email invite accept,
  fresh session issuance, and run-data access after membership activation.
- `docs/design/README.md`: move this doc from draft to accepted only after the
  implementation scope is approved.
- `docs/users/README.md` and `USER_DOCS.md`: user-facing accept, resend,
  revoke, expiry, and wrong-email recovery behavior.

## Alternatives Considered

Use Clerk application invitations as the primary invite system:

- Pros: Clerk sends an email, supports redirect URLs, and can auto-verify email
  during invited signup.
- Cons: It is application-level, not InstantML-org-level; authorization would
  rely on public metadata unless every accept still calls Rust; it introduces
  Clerk-specific invite lifecycle and rate limits into an app-owned org model.
- Decision: Do not use as the first org membership source of truth. Keep as a
  possible future identity-onboarding optimization.

Keep reserved seats and tell admins to copy a signup link manually:

- Pros: Already implemented.
- Cons: Poor beta workflow, no audit trail for delivery, and easy to invite the
  wrong person or lose activation context.
- Decision: Reject.

Activate membership purely by clicking the email token:

- Pros: Shorter flow.
- Cons: Forwarded links or compromised inboxes would grant access without an
  authenticated InstantML identity; this is too risky for run data.
- Decision: Reject. Require matching verified identity-provider email.

Use AWS SES first:

- Pros: Durable AWS-native sending and SNS feedback path.
- Cons: More setup and operations than needed for the first hosted beta slice.
- Decision: Defer behind the provider adapter.

## Review Notes

Fresh reviewer 1:

- Finding: Legacy tokenless activation, query-string token exposure, raw
  webhook retention, send abuse limits, concurrency, and email normalization
  were underspecified.
- Risk: Revoked invites could still activate, tokens/PII could leak, provider
  reputation could be damaged, and multi-writer transitions could conflict.
- Recommended edit: Require hosted `accept_invite_token`, use URL fragment plus
  history cleanup, store allowlisted webhook summaries, add send quotas, state
  single-writer limits, and define normalization.
- Decision: Accepted. The design now requires token-based hosted activation,
  fragment tokens, privacy-minimized webhook records, concrete send limits,
  single-control-writer first-slice semantics, and explicit email normalization.

Fresh reviewer 2:

- Finding: Existing-session mutation can be stale in split control/data mode,
  invite routes lacked service-plane placement, email send is not atomic with
  ClickHouse records, retry idempotency was thin, and the first slice was too
  large.
- Risk: Accepted users might not see run data immediately, control routes could
  leak onto data services, duplicate/missing delivery state could confuse
  admins, and implementation scope could sprawl.
- Recommended edit: Always issue a fresh session on accept, mark all invite
  routes control-plane-only, use an explicit send attempt model, define
  same-user accept retry success, and defer webhooks if needed.
- Decision: Accepted. The design now uses fresh sessions, control/combined-only
  route placement, best-effort send attempts, accept retry semantics, and a
  narrower first slice with webhooks deferred.

Fresh reviewer 3:

- Finding: The first slice was broad, revoked/expired invitation seat lifecycle
  was unclear, role expectations were not route-level, frontend token state
  needed a stronger flow, tests needed role assertions, and docs needed
  required deltas.
- Risk: Pending invites could consume seats forever, accepted invitees could
  gain the wrong capabilities, token state could linger, and docs could miss
  operator-critical email setup.
- Recommended edit: Narrow the slice, count pending invitations rather than
  pre-creating memberships, add a role matrix, define the frontend state
  machine, add role-specific tests, and enumerate doc updates.
- Decision: Accepted. The design now reserves seats through pending invitations,
  creates membership only on accept, includes a route-level role matrix,
  describes frontend token handling, adds role tests, and expands the
  documentation plan.

## Coverage Exceptions

- Uncovered area: Real-world inbox placement and DNS/provider reputation.
- Reason: Inbox placement depends on external mailbox providers, DNS
  propagation, sender reputation, and provider-specific filtering.
- Risk: Invite emails could be delayed or routed to spam despite passing unit
  and integration tests.
- Follow-up: Add a pre-launch DNS/deliverability checklist and later a
  scheduled synthetic Gmail/Workspace inbox monitor once production sending is
  enabled.
- Owner/date: Codex / 2026-05-22

## Decision

Implemented after fresh review. Three review agents re-vetted the first slice
on 2026-05-22 and blocked the initial patch set on frontend token handling,
public preview privacy, tokenless hosted activation, stale verified-email
matching, billing-state checks on accept, API-key invitation power, resend
failure semantics, disabled-provider behavior, hosted invite URL defaults, and
test/doc gaps.

The accepted implementation tightens those points: hosted Clerk invite accept
requires `accept_invite_token`, the server reconciles the current verified
provider email before accepting, accept re-checks billing and seats, preview
returns only an `email_hint`, invite mutations require owner/admin browser
sessions or bootstrap, send attempts are durable before provider calls,
previous delivered tokens remain valid across failed resends, disabled email
providers reject create/resend before reserving a seat, `/invite` persists the
fragment token through Clerk redirects and serves no-referrer/no-store headers,
Settings exposes log-provider links and delivery status, and tests cover token
indexing, masked previews, accepted-member run scoping, deploy-time Resend URL
configuration, Rust unit coverage, web build, and deploy-helper behavior.

Follow-up hardening incorporated after the first post-implementation review:
successful resends now clear previous token hashes while failed resends keep the
old delivered link usable, resend attempts share the same send-rate limits and
billing gate as create, legacy reserved seats can be upgraded through token
invites without double-counting, preview and accept token throttles are scoped
separately behind a bounded global cap, and hosted Clerk invite acceptance no
longer trusts a stale InstantML session cookie.

Second post-implementation review hardening: terminal invitations are no longer
indexed by token hash, accepted tokens cannot become permanent rejoin links,
invite auth exchange preflights token/email before creating or linking a user,
public invite throttling now includes a coarse client key that retains the
backend peer IP and splits forwarded clients when a proxy supplies a valid
client IP, per-token rejects do not consume the global backstop, read data
routes require `export:read` for API keys, Settings hides admin invite/billing
actions from non-admin sessions, and pricing copy no longer claims free
unlimited viewers until the billing model implements that.

Post-implementation verification also ran a local HTTP smoke against the Rust
API with the log email provider: owner signup created an org and run, an
invitation for the provided test Gmail account returned a seven-day
fragment-link token, usage seats moved from 1 to 2 while pending and stayed 2
after accept, the invited viewer accepted into the same org, and the viewer
session read the run plus its `accuracy=0.99` metric series. Staging was
redeployed to
`https://staging.api.instantml.ai` with the invite routes live. The Resend
sender domain `mail.instantml.ai` was verified with Cloudflare DNS, a
send-only staging API key was stored in GCP Secret Manager, and the hosted
control plane sent a real invitation email from `invites@mail.instantml.ai` to
the provided Gmail test account.

Additional Playwright browser verification exercised the rendered web UI
against a local Rust API and two separate browser contexts. The owner context
loaded `/dashboard/runs` and saw the seeded run; the invited
provided test Gmail account context accepted the `/invite#t=...` link through
the local dev-auth form, landed on `/dashboard/runs`, saw the same run, and
both contexts fetched the `accuracy=0.99` metric series through browser
credentials. Seat usage again moved from 1 to 2 while pending and stayed 2
after accept.

Chrome Computer Use verification on staging then exercised the real hosted
Clerk and Gmail path. The invite email was received in Gmail, opened in Chrome,
accepted by the `lunreclipsespam@gmail.com` Google account, and produced an
active membership in the invited org. The org switcher showed two members
after accept, and both the owner account and invited account could load the
same seeded InstantML org run, summary metrics, and bounded accuracy/loss
charts through browser credentials.
