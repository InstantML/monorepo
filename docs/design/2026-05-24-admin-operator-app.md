# Design: Admin Operator App

Date: 2026-05-24

Status: Accepted for narrow first slice; amended 2026-06-04 for a single-email Clerk gate

Owner: Codex

## Summary

InstantML has org-level Settings and API-key management, but operators do not
have one place to inspect all users, organizations, storage posture, billing
state, API-key inventory, and risk signals. This first slice adds a separate
read-only Next app under `apps/admin` plus one bootstrap-protected Rust endpoint
that returns a bounded operator overview.

The smallest useful version is an internal console for support and operations:
search all known users/orgs/API keys, inspect a selected organization, see safe
storage and tenant-route metadata, identify stale or revoked API keys, and view
risk queues for storage, billing, seat, and plan-limit issues. It intentionally
does not mutate users, keys, billing, or storage routes.

## Goals

- Build a separate Next app for internal admin/operator workflows.
- Restrict the admin app viewer to the configured internal operator email, with
  the current default allowlist containing only `instantml.ai@gmail.com`.
- Return a real backend overview from Rust instead of hard-coded demo data.
- Keep the endpoint read-only and protected by the existing bootstrap token.
- Show safe user, organization, storage, billing, API-key, and risk summaries.
- Keep list responses bounded and searchable from the first version.
- Avoid exposing plaintext API keys, key hashes, session tokens, tenant
  passwords, signed URLs, or raw provider error text.

## Non-Goals

- No general admin role model beyond the current single-email allowlist.
- No create, revoke, rotate, resend, billing, or storage mutation controls.
- No fan-out across every tenant data plane in hosted split mode.
- No new database table or durable admin-specific state.
- No public customer-facing navigation to the admin app.

## Users and Use Cases

InstantML operator:

1. Opens the unlinked admin app URL.
2. Signs in with Clerk as the allowlisted operator email.
3. Searches for a user email, organization name, API-key prefix, or storage
   issue.
4. Selects an organization and checks plan, owner, seats, storage state,
   tenant-route status, API-key counts, billing state, and risk reasons.
5. Reviews users, storage incidents, API-key risks, and billing/storage
   warnings before taking action in existing operational tools.

Support engineer:

1. Finds a reported user or org quickly.
2. Confirms whether storage is configured, billing is read-only, API keys are
   active, and usage is near limits.
3. Uses the returned IDs and safe metadata to correlate with existing logs.

## Proposed Design

Add `GET /api/admin/overview` to the Rust control-plane routes. The handler
requires `X-InstantML-Bootstrap-Token` with strict bootstrap validation, even in
local mode when a token is configured for the admin app. It accepts:

- `q`: optional case-insensitive search across user email/name/id, org
  name/slug/id, API-key name/prefix/scope, and storage state.
- `limit`: optional list cap, default `100`, maximum `200`.

The endpoint reads the in-memory control projection and, in combined/local mode,
the local data-plane projection. It returns:

- Global totals for users, orgs, active/invited seats, API keys, storage states,
  billing states, and risk counts.
- Organization summaries with owner, counts, safe storage route summary, billing
  projection summary, usage percentages for retained resources, and risk
  reasons.
- User summaries with active/invited org memberships and last-seen information.
- API-key summaries with public key metadata only.
- Risk queue items with stable target/type/severity/message fields.

In hosted split control-plane mode, the endpoint does not query every tenant
warehouse. Tenant-owned project/run/artifact counts are marked unavailable or
left at the control projection values. A future design can add an operator
warehouse inventory service if cross-cell live counts become necessary.

Add `apps/admin` as a separate Next App Router application. It uses server-side
fetching only:

- The admin app layout uses Clerk only for the human viewer identity. The page
  renders the dashboard only when the signed-in primary email is verified and
  matches the configured allowlist.
- `INSTANTML_ADMIN_ALLOWED_EMAILS` may provide a comma-separated allowlist, but
  the default allowlist is exactly `instantml.ai@gmail.com` for the first
  hosted/internal slice.
- `INSTANTML_ADMIN_API_BASE` or `INSTANTML_API_BASE` points to the Rust API.
- `INSTANTML_ADMIN_BOOTSTRAP_TOKEN` or `INSTANTML_BOOTSTRAP_TOKEN` is sent only
  by the Next server when fetching the overview.
- The browser receives the overview data but never receives the bootstrap token.
- Production Clerk keys are usable only on HTTPS hosts under the configured
  production domain. The admin app therefore renders setup guidance instead of
  a sign-in button when a `pk_live_` key is used on plain localhost.
- The admin app sets Clerk's production root domain to `instantml.ai` so browser
  scripts and Frontend API calls use the configured custom Clerk host
  `clerk.instantml.ai`. It does not use the `/__clerk` Frontend API proxy for
  the production custom-domain deployment.
- The app remains separate from `apps/web`; the public landing page and product
  navigation do not link to it.

The app renders an internal console with:

- Left rail: Overview, Users, Orgs, Storage, API Keys, Risk.
- Top bar: environment, search, last refreshed, read-only operator state, and
  the signed-in operator email.
- KPI strip: users, orgs, active keys, storage issues, risk queue.
- Organization table and user activity table.
- Selected-org detail panel with plan, owner, seats, storage, API keys, usage,
  billing, and risk reasons.
- Storage incident and API-key risk queues.

The visual direction is restrained and operational: dense tables, clear status
dots, crisp borders, small progress bars, and minimal icons. No marketing hero,
decorative imagery, or mutation CTAs.

## Component Impact

Backend:

- Add a control-plane `GET /api/admin/overview` route.
- Add a store projection helper for admin overview data.
- Register the route with utoipa/OpenAPI and regenerate generated API files.

Frontend:

- Add `apps/admin` as a separate Next app using root dependencies.
- Add a Clerk-backed viewer gate in `apps/admin` and keep the dashboard hidden
  from unsigned or non-allowlisted users.
- Add app-specific components, CSS, view-model helpers, and focused tests.
- Import generated API response types rather than duplicating the backend
  contract by hand.

Python SDK:

- No impact.

Storage:

- No schema or storage writes. The endpoint reads existing projected rows.

Docs:

- Update `apps/README.md`, root `README.md`, `docs/design/README.md`, and add
  `apps/admin/README.md`.

## Data Model

No new persisted entities.

New response-only models:

- `AdminOverviewResponse`
- `AdminOverviewTotals`
- `AdminOrganizationSummary`
- `AdminUserSummary`
- `AdminApiKeySummary`
- `AdminStorageSummary`
- `AdminBillingSummary`
- `AdminRiskItem`

Storage route summaries must omit:

- Tenant passwords and password references.
- API-key hashes and plaintext secrets.
- Session tokens and token hashes.
- Raw provider/storage error text.
- Signed object-storage URLs or bucket object keys.

## API Contracts

### `GET /api/admin/overview`

Auth:

- `X-InstantML-Bootstrap-Token` required.
- The admin Next app additionally requires a Clerk-authenticated viewer whose
  primary verified email is on the admin allowlist before it calls this endpoint.

Query:

- `q?: string`
- `limit?: number`, default `100`, max `200`.

Success response:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-24T00:00:00Z",
  "data_counts_available": true,
  "query": {
    "q": "acme",
    "limit": 100,
    "matched_organizations": 1,
    "matched_users": 1,
    "matched_api_keys": 0
  },
  "totals": {
    "users": 12,
    "organizations": 4,
    "active_memberships": 8,
    "invited_memberships": 2,
    "pending_invitations": 1,
    "active_api_keys": 9,
    "revoked_api_keys": 3,
    "storage_ready_orgs": 3,
    "storage_unconfigured_orgs": 1,
    "risk_items": 2
  },
  "organizations": [],
  "users": [],
  "api_keys": [],
  "risks": []
}
```

Error behavior:

- `401` when the bootstrap token is missing, incorrect, or not configured.
- `400` only for invalid query values.
- No partial writes because the endpoint is read-only.

## Performance Considerations

- Expected rows per action: hundreds of users/orgs/API keys in the first slice.
- Expected write frequency: none.
- Expected read shape: one bounded projection read from memory.
- Latency target: under 200 ms locally for thousands of projected control rows.
- Pagination: `limit` caps each list at 200; future pagination can add cursors
  without changing the top-level endpoint purpose.
- Indexes: no new ClickHouse indexes because no direct ClickHouse scan is added.
- Memory: response is bounded; API keys and org/user rows are cloned only for
  the request.
- Batching: not applicable.
- Measurement: Rust unit tests cover projection behavior; existing hosted
  benchmarks remain the source for tenant data-plane query performance.

The endpoint must not fetch full metric history. It uses retained summary
counts from existing projections and does not touch scalar metric hot paths.

## Simplicity Review

This is simpler than building a full admin RBAC system or a new operator
database. It reuses the bootstrap token, existing control projection, existing
OpenAPI/codegen pipeline, and a standalone Next app with server-side fetching.

Deferred complexity:

- Admin-auth identity, audit logging, and per-operator roles.
- Mutation workflows for users, API keys, billing, storage, and tenant routes.
- Cross-cell live tenant data aggregation in hosted split mode.
- Persistent admin filters, saved views, and incident acknowledgement.

## Failure Modes

- Missing admin token: the app renders setup/error guidance; the API returns
  `401`.
- Rust API unavailable: the app renders an API error state without exposing the
  token.
- Hosted control plane has stale projection: overview reflects the same
  last-known-good state as existing control routes.
- Tenant route failed: show safe status and a generic route-error marker, not
  raw provider text.
- Very large control plane: lists remain capped; a future paginated endpoint can
  be added before the operator data exceeds the first slice.

## Testing Plan

- Rust unit tests for admin overview projection, query filtering, risk
  generation, and secret redaction.
- OpenAPI path tests for `/api/admin/overview` on control/combined planes only.
- Next/admin tests for view-model helpers, admin allowlist helpers, and static
  wiring that verifies the page checks Clerk/allowlist access before fetching
  admin data.
- `npm run codegen:api`
- `npm run verify:api-types`
- `npm run test:node`
- `npm run web:build`
- `npm run admin:build`
- Browser/Chrome Computer Use smoke of the admin app: load overview, search,
  click org/user/API-key/storage/risk sections, and check responsive behavior.

Coverage exception:

- Uncovered area: Full browser automation of every admin visual state.
- Reason: The first slice is read-only and mostly server-rendered; focused unit
  tests plus Chrome smoke cover the meaningful behavior without creating brittle
  layout assertions.
- Risk: A rare visual regression may pass tests.
- Follow-up: Add Playwright coverage if the admin app gains mutations or more
  complex route state.
- Owner/date: Codex, 2026-05-24.

## Documentation Plan

- Add `apps/admin/README.md`.
- Update `apps/README.md`.
- Update root `README.md` repository structure and command list.
- Update `docs/design/README.md` implemented design sequence.
- Document the temporary `INSTANTML_ADMIN_ALLOWED_EMAILS` allowlist, Clerk
  environment requirements, and the absence of public web navigation.

## Alternatives Considered

- Extend `apps/web` Settings with an operator tab. Rejected because operators
  need a separate internal surface and the customer dashboard should not carry
  bootstrap-token assumptions.
- Build mutation controls immediately. Rejected because read-only inspection is
  the safer first vertical slice.
- Add a new admin database. Rejected because the existing control projection
  already contains the required first-slice data.
- Query every tenant warehouse for live usage. Rejected because hosted split
  fan-out needs a separate performance and failure-mode design.

## Review Notes

Fresh reviewer 1:

- Finding: The initial temptation is to let the app call existing org/user/key
  endpoints separately, but that would create many bootstrap-token server
  requests and uneven loading states.
- Risk: Multiple partial fetches could show users from one projection point and
  keys/orgs from another.
- Recommended edit: Add one read-only overview endpoint that builds a coherent
  snapshot from the current projection.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: Showing tenant route endpoint, username, password reference, and raw
  error text would be useful during incidents but risky in a browser-delivered
  admin payload.
- Risk: The admin app could become a secondary source of sensitive operational
  detail.
- Recommended edit: Return only safe route status, provisioner, database,
  service id, capacity profile, endpoint host, and a generic error marker.
- Decision: Accepted.

2026-06-04 access-control amendment:

- Finding: The original first slice protected only the Rust admin API with a
  bootstrap token. That kept secrets off the browser, but it did not prove which
  human opened the admin app if the app URL itself was reachable.
- Risk: A publicly reachable admin Next app with a configured server-side
  bootstrap token could disclose operator overview data to any viewer.
- Recommended edit: Add a Clerk-authenticated viewer gate before
  `fetchAdminOverview`, default the allowlist to `instantml.ai@gmail.com`, keep
  the app unlinked from `apps/web`, render explicit setup guidance when
  production Clerk keys are used on non-HTTPS local hosts, and keep the Rust
  bootstrap-token check.
- Decision: Accepted as a narrow amendment. A durable admin role model,
  admin-view audit ledger, and edge access control remain separate follow-ups.

## Decision

Accepted for a read-only first slice: one bootstrap-protected Rust overview
endpoint and one separate Next admin app. Mutations, admin RBAC, audit logs,
and cross-cell live usage aggregation require separate designs.
