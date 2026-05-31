# Current Rust API Reference

Date: 2026-05-30

Status: Current implemented API surface for `apps/rust-server`

## Purpose

This document is the durable API reference for the current Rust/ClickHouse
server. Keep it synchronized with `apps/rust-server/src/http/mod.rs`,
`apps/rust-server/src/domain.rs`, and the Rust server README whenever routes,
request bodies, query parameters, auth rules, or response envelopes change.

The live internal Cloud Run service also exposes a compact route index at
`GET /openapi.json`. This document is intentionally more practical than that
machine-readable route list: it names auth requirements, accepted inputs,
pagination parameters, and response envelopes that the SDK, frontend, and
operator tools rely on.

## Base URLs

Local default:

```text
http://127.0.0.1:8000
```

Hosted Cloud Run direct services:

```text
https://instantml-control-<hash>-uc.a.run.app
https://instantml-data-us-central1-a-<hash>-uc.a.run.app
```

Hosted public router, when DNS and the managed HTTPS load balancer are
configured:

```text
https://api.instantml.ai
```

Hosted staging router:

```text
https://staging.api.instantml.ai
```

The Next frontend uses same-origin rewrites, not direct browser calls to these
hosts. The default local frontend workflow is a localhost Next app with its
rewrites pointed at the staging router:

```bash
INSTANTML_WEB_API_ENV=staging npm run web:dev
```

That sends all control and data rewrites to
`https://staging.api.instantml.ai` and overrides stale local API-base values
unless `INSTANTML_WEB_EXPLICIT_API_BASES=1` is set. Staging and preview
frontend deployments should also set `INSTANTML_WEB_API_ENV=staging`.
Production builds should leave it unset or set it to `prod`, so rewrites target
`https://api.instantml.ai`.

The local Next app should only use direct split Cloud Run service bases when
you intentionally bypass the staging router. After a direct split
`npm run deploy:cloud-run`, `apps/web/.env.local` can receive:

```text
INSTANTML_CONTROL_API_BASE=https://instantml-control-<hash>-uc.a.run.app
INSTANTML_DATA_API_BASE=https://instantml-data-us-central1-a-<hash>-uc.a.run.app
INSTANTML_API_ALLOWED_ORIGINS=https://instantml-control-<hash>-uc.a.run.app,https://instantml-data-us-central1-a-<hash>-uc.a.run.app
```

When `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER=1` and
`INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN` are set, the helper writes
`INSTANTML_API_BASE`, `INSTANTML_CONTROL_API_BASE`, and
`INSTANTML_DATA_API_BASE` to the same `https://<api-domain>` value.

The current public client contract is one stable API base URL. This
multi-instance first slice does not expose public data-plane cell URLs and does
not redirect SDK or browser requests to a cell. Any future direct-to-cell or
redirect behavior must preserve bearer auth, session/cookie rules,
`Idempotency-Key`, request bodies, and project-scoped/demo authorization.

For local split-service verification, the Rust binary also supports
`INSTANTML_SERVICE_PLANE=control` and `INSTANTML_SERVICE_PLANE=data`. The
control role exposes platform, auth/session, organization invitation, user/org,
seat, API-key, service-account, dashboard preference, and saved workspace-view
routes. The data role exposes platform and tenant product routes. `combined`
remains the default and the current deployed shape.

## Auth Model

There are three credential paths.

| Credential | Transport | Main use |
| --- | --- | --- |
| Browser session | `instantml_session` HttpOnly cookie | Next dashboard after Clerk or local dev sign-in |
| SDK API key | `Authorization: Bearer instantml_...` | SDK, uploader, import, export, and automation calls |
| Bootstrap token | `X-InstantML-Bootstrap-Token: ...` | Operator-only user/org/API-key bootstrap routes and read-only admin overview |

In `INSTANTML_AUTH_MODE=api-key`, tenant product routes require either a bearer
API key or a valid browser session cookie. Local mode allows unauthenticated
compatibility calls against the fixed local development org.

Cookie-authenticated mutating requests require an allowed `Origin`. Bearer-token
SDK requests are not origin-gated. Shared demo browser sessions are read-only
except for export reads.

## Common Shapes

All JSON API errors use HTTP status codes and a JSON body with at least an
`error` string. Some errors also include a stable `code` string. Most handlers
also attach `x-request-id`. Hosted tenant ClickHouse wake/start failures return
`503` with `code: "warehouse_unavailable"` so clients can distinguish a waking
tenant warehouse from a down control/API service. Run-search validation errors
return HTTP `400` with `code`, `field: "q"`, and optional `position`.

Important row shapes:

```json
{
  "project": {
    "id": "uuid",
    "org_id": "uuid",
    "name": "demo",
    "description": null,
    "created_at": "2026-05-16T00:00:00Z"
  },
  "run": {
    "id": "uuid",
    "org_id": "uuid",
    "project_id": "uuid",
    "project": "demo",
    "name": "train-seed-7",
    "status": "running",
    "config": {},
    "tags": ["baseline"],
    "metadata": {},
    "created_at": "2026-05-16T00:00:00Z",
    "started_at": "2026-05-16T00:00:00Z",
    "finished_at": null,
    "parent_run_id": null,
    "forked_from_step": null,
    "forked_from_artifact_id": null
  },
  "metric": {
    "key": "eval/accuracy",
    "step": 1,
    "value": 0.9,
    "created_at": "2026-05-16T00:00:00Z"
  }
}
```

Validation limits that affect callers:

| Input | Limit |
| --- | ---: |
| Text fields such as names, paths, tags | 512 bytes |
| Metrics per batch | 1,000 |
| Metric query limit | Default 1,000, max 5,000 |
| Rank metrics per batch | 1,000 metrics for one `(run, step, rank)` |
| Rank metric world size | Max 512 ranks; summary heatmaps return max 16,384 cells |
| Run page limit | Default 100, max 1,000 |
| Run search query | 512 bytes, 32 terms, 64 AST nodes, depth 8 |
| Run search regex | Max 4 regexes, 128 bytes each; regex must not match empty text |
| Per-run searched field text | First 32 KiB per indexed field |
| Batched metric series run IDs | 2,000 |
| Batched metric series response | Max 120,000 returned points; `effective_limit` is clamped per run |
| Workspace-view payload | 64 KiB |
| Console log lines per batch | 50 |
| Console log message | 16 KiB |
| Console log query limit | Default 250, max 1,000 |
| Object page limit | Default 100, max 500 |
| Object table row limit | Default 100, max 1,000 |
| Artifact list limit | Max 1,000 |
| Artifact collection list limit | Default 100, max 500 |
| Artifact version list limit | Default 100, max 1,000 |
| Artifact manifest entries | Default 100, max 1,000 per page |
| Versioned artifact manifest | Max 1,000 entries |
| Versioned artifact upload session | Max 20,000 total parts |
| Side-by-side comparison | Max 50 runs and 5,000 rows |
| Export | Max 500 runs, 100,000 metric points, 25,000 attributes, 10,000 artifacts |
| API requests | Free 5 req/sec general / 2 req/sec ingest; Pro 50 / 25; Premium 200 / 100 |

Operational correlation:

- Every response carries `x-request-id`; clients and support should keep it with
  bug reports.
- Hosted Rust origin logs include `request_id` and observed `cf_ray` when
  Cloudflare sends one. Cloudflare Ray IDs are correlation hints, not unique
  application request IDs, so pair them with timestamp, host, path, and status.
- Server logs intentionally omit request bodies, query strings, tokens, cookies,
  project/run names, metric values, console messages, artifact filenames, and
  object-storage keys.

## Platform And Health

| Method | Path | Auth | Inputs | Output |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | none | none | `{ "status": "ok" }` |
| `GET` | `/healthz` | none | none | Same as `/health` |
| `GET` | `/readyz` | none | none | `{ "status": "ok", "control_projection_loaded": true, "control_refresh_degraded": false }` when ClickHouse stores are reachable and the control projection has loaded |
| `GET` | `/metrics` | none | none | Prometheus text metrics, including control projection loaded/degraded gauges |
| `GET` | `/openapi.json` | none | none | Compact role-aware OpenAPI 3.1 route index with `x-instantml-service-plane` |

## Admin

### `GET /api/admin/overview`

Returns the read-only operator overview used by `apps/admin`.

Auth:

- Requires `X-InstantML-Bootstrap-Token`.

Query:

- `q`: optional case-insensitive search across users, organizations, API-key
  public metadata, storage state, and risk text.
- `limit`: optional per-list cap. Defaults to 100 and is clamped to 200.

Output:

- `schema_version`
- `generated_at`
- `data_counts_available`
- `query`
- `totals`
- `organizations`
- `users`
- `api_keys`
- `risks`

The response intentionally omits plaintext API keys, API-key hashes, session
tokens, tenant passwords, password references, signed object URLs, and raw
provider/storage error text. In hosted split control-plane mode, tenant-owned
project/run/artifact live counts are not fanned out across every data plane.

## Auth And Session

### `GET /api/auth/config`

Returns provider availability for the frontend on the current service-plane
role. Data-plane-only services return auth providers as disabled because they do
not expose session exchange routes.

Output:

```json
{
  "dev_auth_enabled": false,
  "managed_clerk_enabled": true,
  "service_plane": "combined"
}
```

### `POST /api/auth/dev/google`

Creates a local development Google-style browser session. Available only when
local dev auth is enabled.

Body:

```json
{
  "email": "hello@instantml.ai",
  "display_name": "InstantML Demo",
  "mode": "signup",
  "plan_tier": "premium",
  "account_type": "business",
  "org_name": "InstantML Demo",
  "storage_choice": "instantml-hosted",
  "seat_emails": ["teammate@example.com"],
  "accept_invite_org_id": null,
  "accept_invite_token": null
}
```

`mode` is `signup` or `signin`. `plan_tier` accepts `free`, `pro`, or
`premium`; legacy `lab`/`startup` canonicalize to `pro` and `growth`
canonicalizes to `premium`. `storage_choice` accepts `instantml-hosted` or
Premium-only `customer-clickhouse`; BYOC signups do not receive an onboarding
API key until the storage route is ready. On sign-in, `accept_invite_token` accepts a
token-backed organization invitation when the verified email address matches the
invite email. `accept_invite_org_id` remains only for local/dev compatibility
with legacy placeholder invited memberships. If a local/dev verified user has
multiple legacy pending invites and does not choose one, the server returns
`409` with `code: "multiple_pending_invites"`.

Output: authenticated session payload plus `Set-Cookie: instantml_session=...`.

### `POST /api/auth/clerk`

Exchanges a verified Clerk session token for an InstantML browser session.

Body:

```json
{
  "token": "clerk-session-jwt",
  "mode": "signup",
  "plan_tier": "premium",
  "account_type": "business",
  "org_name": "Acme Research",
  "storage_choice": "customer-clickhouse",
  "seat_emails": ["teammate@example.com"],
  "accept_invite_org_id": null,
  "accept_invite_token": null
}
```

`mode` is `signin` or `signup`. Managed Clerk signup can omit `account_type` and
`org_name`; the server then derives a personal workspace name from the verified
Clerk display name or email handle. `account_type: "business"` plus `org_name`
creates an explicit organization workspace. `plan_tier` is required only for
plan-specific signup behavior and defaults to `free` when omitted.
`storage_choice` accepts `instantml-hosted` or Premium-only
`customer-clickhouse`; BYOC signups stay in onboarding until customer storage is
validated. `accept_invite_token` is used on sign-in to activate a matching
token-backed invitation; hosted Clerk exchanges ignore tokenless legacy invite
activation. Output is the authenticated session payload plus
`Set-Cookie: instantml_session=...`.

### Organization Invitations

Invitation links use `/invite#t=<token>` on the web app. The fragment token is
read client-side, removed from browser history, previewed through the API, and
then exchanged only after Clerk or local dev auth confirms a matching email.
Pending unexpired invitations reserve seats for usage and plan-limit purposes;
accepted invitations become active `MembershipRow` records and no longer count
separately. First-slice invitation tokens expire after seven days.

| Method | Path | Auth | Body | Output |
| --- | --- | --- | --- | --- |
| `POST` | `/api/invitations/preview` | none | `{ "token": "instantml_invite_..." }` | `{ "invitation": { "org_name", "email_hint", "role", "status", "expires_at" } }` |
| `POST` | `/api/invitations/accept` | browser session | `{ "token": "instantml_invite_..." }` | authenticated session payload plus fresh `Set-Cookie`, bound to the invited org |

### `GET /api/auth/session`

Reads the current browser session.

Output when unauthenticated:

```json
{ "authenticated": false }
```

Output when authenticated:

```json
{
  "authenticated": true,
  "session": {},
  "user": {},
  "organization": {},
  "membership": {},
  "memberships": [],
  "account_type": "business",
  "provisioning": {
    "status": "ready",
    "mode": "database",
    "service_id": null
  }
}
```

### `POST /api/auth/logout`

Revokes the current browser session if one exists and clears the cookie.

Output:

```json
{ "authenticated": false }
```

## Dashboard Control State

These routes persist UI preference and saved workspace-view state in the
control plane. Hosted mode requires a browser session for the current org;
SDK/API keys are intentionally not accepted because these records are
human-dashboard state. Local compatibility mode may use the fixed local org
without a session.

### `GET /api/dashboard/preferences`

Auth: browser session with org membership, or local compatibility access.

Output:

```json
{
  "preferences": {
    "selected_project": "hosted-scale-data",
    "updated_at": "2026-05-17T00:00:00Z"
  }
}
```

`preferences` is `null` when no preference has been saved.

### `PUT /api/dashboard/preferences`

Auth: owner/admin/member/viewer browser session for the current org, except
shared demo sessions are read-only.

Body:

```json
{
  "selected_project": "hosted-scale-data"
}
```

Set `selected_project` to `null` to clear the saved selection. Output is the
same shape as `GET /api/dashboard/preferences`.

### `GET /api/workspace-views`

Auth: browser session with org membership, or local compatibility access.

Query parameters:

| Name | Default | Notes |
| --- | ---: | --- |
| `limit` | `50` | Max `100`. |
| `cursor` | none | Opaque cursor returned by the previous response. |

Output:

```json
{
  "workspace_views": [
    {
      "id": "uuid",
      "name": "Daily comparison",
      "project": "hosted-scale-data",
      "created_at": "2026-05-17T00:00:00Z",
      "updated_at": "2026-05-17T00:00:00Z"
    }
  ],
  "next_cursor": null
}
```

List rows are summaries only and do not include the saved view payload.

### `POST /api/workspace-views`

Auth: owner/admin/member browser session for the current org, except shared
demo sessions are read-only.

Body:

```json
{
  "name": "Daily comparison",
  "project": "hosted-scale-data",
  "payload": {
    "schema_version": 1,
    "tab": "runs",
    "workspace_view": {}
  }
}
```

`payload` must be a JSON object and must be at most 64 KiB after serialization.
Output:

```json
{
  "workspace_view": {
    "schema_version": 1,
    "id": "uuid",
    "org_id": "uuid",
    "owner_user_id": "uuid",
    "name": "Daily comparison",
    "project": "hosted-scale-data",
    "payload": {},
    "created_at": "2026-05-17T00:00:00Z",
    "updated_at": "2026-05-17T00:00:00Z",
    "deleted_at": null
  }
}
```

### `GET /api/workspace-views/:view_id`

Auth: browser session with org membership, or local compatibility access.

Output: `{ "workspace_view": WorkspaceViewRow }`.

### `PUT /api/workspace-views/:view_id`

Auth: owner/admin/member browser session for the current org, except shared
demo sessions are read-only.

Body accepts any subset of `name`, `project`, and `payload`. When `payload` is
present it must satisfy the same object and size limits as create. Output:
`{ "workspace_view": WorkspaceViewRow }`.

## Bootstrap And Organization Administration

These routes are operator/admin surfaces. In API-key mode, user/org bootstrap
requires `X-InstantML-Bootstrap-Token`. API-key administration accepts an
owner/admin browser session, an unrestricted org API key with
`api_keys:write`, or the bootstrap token.

| Method | Path | Body or query | Output |
| --- | --- | --- | --- |
| `POST` | `/api/users` | `{ "email" or "primary_email", "provider"?, "provider_subject"?, "email_verified"?, "display_name"?, "avatar_url"? }` | `{ "user": UserRow }` |
| `GET` | `/api/users` | none | `{ "users": [UserRow] }` |
| `POST` | `/api/orgs` | `{ "name"?, "slug"?, "plan_tier"?, "owner_user_id"?, "storage_choice"? }` | `{ "organization": OrganizationRow }` |
| `GET` | `/api/orgs` | none | `{ "organizations": [OrganizationRow] }` |
| `GET` | `/api/orgs/name-availability` | `name` | `{ "name", "slug", "available", "message" }` |
| `GET` | `/api/orgs/:org_id/seats` | none | `{ "seats": [SeatRow] }` |
| `POST` | `/api/orgs/:org_id/seats` | `{ "email", "role"?: "owner" | "admin" | "member" | "viewer" }` | `{ "seat": SeatRow }` |
| `GET` | `/api/orgs/:org_id/invitations` | none | `{ "invitations": [PublicInvitationRow] }` |
| `POST` | `/api/orgs/:org_id/invitations` | `{ "email", "role"?: "admin" | "member" | "viewer" }` | `{ "invitation": PublicInvitationRow, "preview_link"?: string, "delivery_error"?: string }` |
| `POST` | `/api/orgs/:org_id/invitations/:invitation_id/resend` | none | `{ "invitation": PublicInvitationRow, "preview_link"?: string, "delivery_error"?: string }` |
| `POST` | `/api/orgs/:org_id/invitations/:invitation_id/revoke` | none | `{ "invitation": PublicInvitationRow }` |
| `POST` | `/api/orgs/:org_id/api-keys` | `{ "name"?, "scopes"?, "project_id"?, "project"?, "expires_at"? }` | `{ "api_key", "api_key_available", "key", "message", "service_account" }` |
| `GET` | `/api/orgs/:org_id/api-keys` | none | `{ "api_keys": [PublicApiKeyRow] }` |
| `POST` | `/api/orgs/:org_id/api-keys/:api_key_id/revoke` | none | `{ "key": PublicApiKeyRow }` |
| `POST` | `/api/orgs/:org_id/service-accounts/:service_account_id/disable` | none | `{ "service_account": ServiceAccountRow }` |

## Customer-Owned ClickHouse Setup

These routes are data-plane routes because validation must originate from the
same Rust service path that later serves SDK/UI product traffic. They require an
owner/admin browser session for the current org; API keys and bootstrap tokens
are not accepted. Shared demo sessions are read-only.

BYOC is currently Premium-only and empty-org-only. Product writes and SDK key
creation return `409` with `code: "storage_setup_required"` until
`storage_state` is `storage_ready` or `storage_locked`. The frontend mirrors
this gate for sign-in, invite acceptance, and direct `/dashboard/*` loads by
redirecting unready storage sessions back to `/onboarding`.

| Method | Path | Body | Output |
| --- | --- | --- | --- |
| `GET` | `/api/storage/clickhouse-connections/current` | none | `{ "connection": ClickHouseConnectionStatus }` |
| `POST` | `/api/storage/clickhouse-connections/validate` | `{ "org_id"?, "endpoint", "database", "username", "password", "allow_create_database"?: false, "storage_choice"?: "customer-clickhouse" }` | `{ "validation": ClickHouseConnectionValidationResponse }` |
| `POST` | `/api/storage/clickhouse-connections` | `{ "org_id"?, "endpoint", "database", "username", "password" }` | `{ "connection": ClickHouseConnectionStatus }` |
| `POST` | `/api/storage/clickhouse-connections/rotate-credentials` | `{ "org_id"?, "username"?, "password" }` | `{ "connection": ClickHouseConnectionStatus }` |

The endpoint must be a normalized origin such as
`https://clickhouse.acme.example.com:8443`; userinfo, path, query, fragment,
private/loopback DNS targets, and non-HTTPS schemes are rejected in hosted mode.
BYOC signup, validation, and route creation are rejected until InstantML BYOC
egress CIDRs, an egress-set version, and credential storage are configured. The
customer database must already exist. `GET current` returns the configured
`required_egress_cidrs` and `egress_set_version` before validation so the
customer can allowlist the GCP firewall or load balancer first. Initial
validation/save runs BYOC schema migration without `CREATE DATABASE`, inserts
an operational validation record, stores only a Secret Manager reference in the
route record, and returns the same egress metadata in validation responses.
After the route records the current metric schema version, normal route loads
skip schema migration. Version 2 adds the `rank_metric_points` table; older
ready BYOC routes are migrated and updated on first load when DDL is still
available. If DDL was revoked before a future schema upgrade, the customer must
temporarily re-grant DDL and revalidate. Credential rotation validates the new
credential against the existing saved endpoint/database without rerunning schema
migration, stores a new Secret Manager version, swaps the route reference, and
attempts to destroy the prior version.

Supported API-key scopes:

```text
sdk:ingest
artifacts:write
imports:write
usage:read
api_keys:write
export:read
```

Tenant read access normally means owner/admin/member/viewer browser sessions for
the current org, or API keys that include `export:read`. Data-plane read routes
do not treat `sdk:ingest` alone as read permission. Current control-plane
report reads and import-history reads are narrower exceptions: they accept any
valid same-org browser session or same-org API key because they expose
workspace-authored control records rather than metric/history export payloads.

## Stripe Billing

Billing routes are control-plane browser-session routes except the Stripe
webhook. Paid signup returns `billing_checkout` in the auth response and the
frontend redirects to the returned Checkout URL. Paid access is granted only
after the backend syncs or receives a verified Stripe event for the Checkout
Session/subscription.

| Method | Path | Body | Output |
| --- | --- | --- | --- |
| `GET` | `/api/billing/status` | none | `{ "billing", "plans", "actions" }` |
| `POST` | `/api/billing/checkout` | `{ "plan_tier": "pro" | "premium", "seat_emails"?: [...] }` | `{ "checkout": { "intent_id", "status", "session_id", "url" } }` |
| `POST` | `/api/billing/checkout/sync` | `{ "session_id": "cs_test_..." }` | `{ "billing": BillingAccountProjection }` |
| `POST` | `/api/billing/portal` | `{ "return_url"? }` | `{ "url": "https://billing.stripe.com/..." }` |
| `POST` | `/api/billing/change-plan` | `{ "plan_tier": "free" | "pro" | "premium" }` | `{ "checkout": ... }` for first paid subscription or `{ "billing": ... }` for existing subscription updates and scheduled Free downgrade |
| `POST` | `/api/billing/add-seat` | `{ "email", "role"?: "admin" | "member" | "viewer" }` | `{ "seat": SeatRow, "billing"?: BillingAccountProjection }`; when the org is at its included seat limit, Stripe extra-seat subscription quantity is updated before the seat is reserved |
| `POST` | `/api/billing/cancel` | `{ "at_period_end"?: true }` | `{ "billing": BillingAccountProjection }` |
| `POST` | `/api/billing/storage-overage/report` | none | Backward-compatible alias for the combined overage report |
| `POST` | `/api/billing/usage-overage/report` | none | `{ "usage_report": BillingUsageReportRecord, "usage": ... }`; reports positive storage and API request overage deltas as Stripe meter events |
| `POST` | `/api/billing/webhook` | raw Stripe event JSON with `Stripe-Signature` | `{ "processed": true }` |

Billing write gates return HTTP `402` with `code: "payment_required"` when an
org is in `checkout_pending`, `read_only_payment_required`, or `canceled`.
Plan-capacity guardrails keep using HTTP `402` with
`code: "plan_limit_exceeded"`. Reads, exports, usage, billing status, and portal
creation remain available during payment failures.

## Projects

### `POST /projects`

Auth: `sdk:ingest` API key or owner/admin/member session.

Body:

```json
{
  "name": "cartpole",
  "description": "Optional project description"
}
```

Output:

```json
{ "project": {} }
```

Project-scoped API keys cannot create projects.

### `GET /projects`

Auth: tenant read access.

Output:

```json
{ "projects": [] }
```

Project-scoped API keys only see their project.

## Runs

### `POST /runs`

Auth: `sdk:ingest` API key or owner/admin/member session.

Body:

```json
{
  "project": "cartpole",
  "name": "seed-7",
  "config": { "seed": 7 },
  "tags": ["baseline"],
  "metadata": { "notes": "first pass" }
}
```

The project is created automatically unless the caller uses a project-scoped
API key for a different project.

Output:

```json
{ "run": {} }
```

### `GET /runs`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `project` | Project name, omit or `all` for all projects |
| `status` | `running`, `finished`, `failed`, omit or `all` for all statuses |
| `q` | Run search query over run name, project, tags, notes, config, metadata, status, and ID |
| `sort_by` | `created`, `name`, `status`, `duration`, `metric-latest`, `metric-best` |
| `metric_key` | Metric used by metric sorts, default `eval/return_mean` |
| `limit` | Page size, max 1,000 |
| `offset` | Offset pagination |

Output:

```json
{ "runs": [] }
```

Run search keeps existing bare-text behavior: `seed 13` is an implicit `AND`
over all searchable run fields. The same `q` language is shared by
`GET /runs`, `/api/overview`, `/api/runs/summary`, summary selection
projection, and `/api/export`.

Supported syntax:

- Quoted phrases: `"long context"`.
- Fields: `name:`, `project:`, `notes:`, `config:`, `metadata:`, `tag:` /
  `tags:`, `status:`, `id:`, and `all:`.
- Exact tag/status and ID prefix matches: `tag:baseline status:finished`,
  `id:8f34`.
- Uppercase booleans and grouping: `(tag:baseline OR tag:candidate) -tag:debug`.
  The `-` shorthand is an exclusion operator only before a field, regex, or
  grouped expression, so literal terms such as `-1` still search as text.
- Explicit Rust regex: `re:/seed-(13|14)/` or `name:re:/baseline-.*/`.

Invalid closed syntax returns HTTP `400` with `code: "run_search_invalid"`,
`field: "q"`, and an optional 1-based `position`. The deprecated Node
compatibility server supports the non-regex subset and returns
`code: "run_search_regex_unsupported"` for completed regex queries.

### `GET /runs/:run_id`

Auth: tenant read access.

Output:

```json
{ "run": {} }
```

The returned run is a summary value that includes metric aggregates and artifact
counts used by the dashboard.

### `POST /api/runs/:run_id/forks`

Auth: source read plus run creation rights: `export:read` and `sdk:ingest`
API-key scopes, or an owner/admin/member browser session.

Headers:

- `Idempotency-Key`: optional but recommended. Reusing the same key/body returns
  the same child run; reusing the key with a different body returns `409`.

Body:

```json
{
  "name": "retry-seed-7",
  "step": 120,
  "checkpoint_artifact_id": "uuid",
  "inherit_config": true,
  "config_overrides": { "lr": 0.0001 },
  "tags": ["retry", "checkpoint"],
  "notes": "Retry from stable checkpoint.",
  "metadata": { "reason": "nan loss" }
}
```

Forks are same-project only. `checkpoint_artifact_id`, when present, must be a
checkpoint artifact on the source run. If the checkpoint has a known step, the
request step must match; if the request omits `step`, the server derives it
from the artifact. The child run stores authoritative `parent_run_id`,
`forked_from_step`, and `forked_from_artifact_id` fields. `metadata.lineage` is
a convenience snapshot, not the source of truth. The endpoint creates only a
linked run record; it does not start training, copy metrics, or copy artifact
bytes.

Output:

```json
{ "run": {}, "fork": {} }
```

### `GET /api/runs/:run_id/lineage`

Auth: tenant read access.

Returns the selected run summary, optional parent, latest 100 direct children,
the checkpoint artifact for a forked child when present, and truncation fields.

Output:

```json
{
  "run": {},
  "parent": null,
  "children": [],
  "checkpoint_artifact": null,
  "children_total": 0,
  "has_more_children": false,
  "limit": 100
}
```

### `PATCH /runs/:run_id`

Auth: `sdk:ingest` API key or owner/admin/member session.

Body:

```json
{
  "status": "finished",
  "tags": ["baseline", "reviewed"],
  "notes": "Reward stabilized after step 80."
}
```

At least one field is required. `status` must be `running`, `finished`, or
`failed`. Empty notes remove the stored note.

Output:

```json
{ "run": {} }
```

## Metrics

### `POST /runs/:run_id/metrics`

Auth: `sdk:ingest` API key or owner/admin/member session.

Optional header: `Idempotency-Key`.

Body:

```json
{
  "metrics": {
    "train/loss": 0.12,
    "eval/accuracy": 0.9
  },
  "step": 1,
  "timestamp": "2026-05-16T00:00:00Z"
}
```

`metrics` values and `step` must be finite nonnegative numbers. Up to 1,000
metrics are accepted per batch.

Output:

```json
{ "inserted": 2 }
```

### `GET /runs/:run_id/metrics`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `key` | Optional metric key filter |
| `start_step` | Optional lower step bound |
| `end_step` | Optional upper step bound |
| `limit` | Max 5,000 |

Output:

```json
{ "metrics": [] }
```

### `POST /runs/:run_id/rank-metrics`

Auth: `sdk:ingest` API key or owner/admin/member session.

Optional header: `Idempotency-Key`. Process-spool uploaders set this to the
spooled event id. The durable table keeps append-only rows; summary reads use
the newest `(created_at, event_id)` value for a `(run, key, step, rank)`.

Body:

```json
{
  "metrics": {
    "train/loss": 0.12
  },
  "step": 1,
  "rank": 0,
  "local_rank": 0,
  "world_size": 8,
  "weight": 1024,
  "timestamp": "2026-05-16T00:00:00Z"
}
```

`rank` and `local_rank` are zero-based. `world_size` must be between 1 and
512. `weight` is optional and defaults to `1.0`; it supports sample-weighted
mean reducers for uneven rank workloads. Rank metric rows count against the
same monthly `metric_points` write guardrail as scalar metric rows.

Output:

```json
{ "inserted": 1 }
```

### `GET /api/runs/:run_id/rank-metrics/summary`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `key` | Optional metric key filter. Defaults to the first key for the run. |
| `start_step` | Optional lower step bound |
| `end_step` | Optional upper step bound |
| `limit` | Max step count requested, capped at 5,000. The server may lower this to keep canonical rank rows under `limits.max_canonical_rows`. |

Output:

```json
{
  "keys": ["train/loss"],
  "key": "train/loss",
  "reducers": [
    {
      "step": 1,
      "rank_count": 8,
      "expected_world_size": 8,
      "world_size_mismatch": false,
      "mean": 0.12,
      "weighted_mean": 0.12,
      "min": 0.10,
      "max": 0.14,
      "stddev": 0.01,
      "p05": 0.10,
      "p50": 0.12,
      "p95": 0.14
    }
  ],
  "heatmap": [{ "step": 1, "rank": 0, "value": 0.12, "delta_from_mean": 0.0 }],
  "outliers": [{ "step": 1, "rank": 7, "value": 0.14, "z_score": 2.1, "delta_from_mean": 0.02 }],
  "coverage": [{
    "step": 1,
    "rank_count": 8,
    "expected_world_size": 8,
    "missing_rank_count": 0,
    "missing_ranks": [],
    "world_size_mismatch": false
  }],
  "limits": {
    "step_limit": 1000,
    "max_world_size": 512,
    "max_canonical_rows": 65536,
    "max_heatmap_cells": 16384,
    "outlier_limit": 20
  },
  "truncated": { "steps": false, "heatmap": false, "outliers": false }
}
```

The summary endpoint is intentionally run-scoped for the first slice. It backs
the dashboard's Distributed tab without adding a cross-run rank query fan-out.
When a key is supplied, the API skips full key discovery and returns `keys`
containing the selected key only.

### `POST /api/metrics/series`

Auth: tenant read access.

Body:

```json
{
  "key": "eval/accuracy",
  "run_ids": ["uuid"],
  "limit": 1000,
  "start_step": 0,
  "end_step": 100
}
```

Output:

```json
{
  "series": [
    { "run_id": "uuid", "metrics": [] }
  ]
}
```

## Console Logs

### `POST /api/runs/:run_id/logs`

Auth: `sdk:ingest` API key or owner/admin/member session.

Optional header: `Idempotency-Key`.

Body:

```json
{
  "stream": "stdout",
  "lines": [
    {
      "line_number": 1,
      "message": "epoch=1 loss=0.12",
      "timestamp": "2026-05-16T00:00:00Z"
    }
  ]
}
```

`stream` is `stdout` or `stderr`.

Output:

```json
{ "inserted": 1 }
```

### `GET /api/runs/:run_id/logs`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `stream` | `stdout` or `stderr`, default `stdout` |
| `limit` | Default 250, max 1,000 |
| `cursor` | Cursor returned by a previous page |
| `q` | Optional message search |

Output:

```json
{
  "lines": [],
  "next_cursor": null,
  "limit": 250,
  "truncated": false
}
```

## Dashboard Summaries

### `GET /api/overview`

Auth: tenant read access.

Query accepts `project`, `status`, `q`, and `metric_key`.

Output:

```json
{
  "overview": {
    "total_runs": 2,
    "active_runs": 1,
    "failed_runs": 0,
    "best_eval_return": 1,
    "metric_points": 6
  }
}
```

### `GET /api/runs/summary`

Auth: tenant read access.

Query accepts the same filters as `GET /runs`, plus cursor pagination:

| Parameter | Meaning |
| --- | --- |
| `cursor` | Cursor such as `offset:25`; when present it overrides `offset` |
| `limit` | Page size, max 1,000 |

Output:

```json
{
  "runs": [],
  "metric_keys": ["eval/accuracy"],
  "total": 2,
  "next_cursor": null,
  "page_info": {
    "pagination": "cursor",
    "has_next_page": false
  }
}
```

### `GET /api/runs/side-by-side`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `run_ids` or `runs` | Comma-separated run IDs, max 50 |
| `reference_run_id` | Optional reference run ID |
| `diff_only` | `true` to hide rows where all values match |

Output:

```json
{
  "runs": [],
  "reference_run_id": "uuid",
  "rows": [
    {
      "path": "metric/eval/accuracy/latest",
      "values": { "uuid": 0.9 },
      "reference_run_id": "uuid",
      "reference": 0.9,
      "different": false
    }
  ],
  "truncated": false
}
```

## Attributes And Rich Objects

### `POST /api/runs/:run_id/attributes`

Auth: `sdk:ingest` API key or owner/admin/member session.

Body can use a batch:

```json
{
  "attributes": [
    {
      "path": "config/optimizer",
      "type": "text",
      "step": 1,
      "timestamp": "2026-05-16T00:00:00Z",
      "value": "adam",
      "summary": {},
      "artifact_id": null
    }
  ]
}
```

Or a single attribute with top-level `path`, `type`, `step`, `timestamp`,
`value`, and `summary`. Rich media/table object types must use
`/api/runs/:run_id/objects`.

Output:

```json
{ "attributes": [] }
```

### `GET /api/runs/:run_id/attributes`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `type` | Optional attribute type filter |
| `path_prefix` | Optional path prefix |
| `limit` | Max 5,000 |
| `offset` | Offset pagination |

Output:

```json
{ "attributes": [] }
```

### `POST /api/runs/:run_id/objects`

Auth: `sdk:ingest` API key or owner/admin/member session.

Body:

```json
{
  "key": "eval/samples",
  "kind": "table",
  "step": 1,
  "artifact_id": null,
  "metadata": {},
  "summary": { "columns": ["prompt", "score"] },
  "value": { "kind": "table" },
  "rows": [
    { "prompt": "hello", "score": 0.92 }
  ]
}
```

Supported rich object kinds are `table`, `image`, `video`, `audio`, and
`histogram_series`. Media objects require an `artifact_id` from the same run.
Tables accept up to 1,000 rows per create request.

Output:

```json
{ "object": {} }
```

### `GET /api/runs/:run_id/objects`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `kind` | Optional object kind filter |
| `key` | Optional exact object key |
| `limit` | Default 100, max 500 |
| `offset` | Offset pagination |

Output:

```json
{ "objects": [], "limit": 100, "offset": 0 }
```

### `GET /api/objects/:object_id/rows`

Auth: tenant read access.

Query:

| Parameter | Meaning |
| --- | --- |
| `limit` | Default 100, max 1,000 |
| `offset` | Offset pagination |

Output:

```json
{
  "object_id": 123,
  "rows": [
    { "row_index": 0, "row": {}, "created_at": "2026-05-16T00:00:00Z" }
  ],
  "limit": 100,
  "offset": 0
}
```

## Artifacts

### `POST /api/runs/:run_id/artifacts`

Auth: `artifacts:write` API key or owner/admin/member session.

Body:

```json
{
  "type": "checkpoint",
  "name": "policy.pt",
  "uri": "s3://bucket/policy.pt",
  "step": 1,
  "size_bytes": 12345,
  "sha256": "hex",
  "mime_type": "application/octet-stream",
  "metadata": {},
  "path": "policy.pt"
}
```

Output:

```json
{ "artifact": {} }
```

### `POST /api/runs/:run_id/artifacts/upload`

Auth: `artifacts:write` API key or owner/admin/member session.

Body:

```json
{
  "type": "file",
  "name": "plot.png",
  "content_base64": "base64-bytes",
  "step": 1,
  "mime_type": "image/png",
  "metadata": {},
  "path": "plots/plot.png"
}
```

Uploads validate the decoded byte size and plan storage capacity before
touching the configured byte backend. With `INSTANTML_ARTIFACT_BACKEND=local`,
uploads store bytes under the configured artifact root. With
`INSTANTML_ARTIFACT_BACKEND=r2`, uploads create or reuse the organization's
private Cloudflare R2 bucket, write the object under
`runs/<run_id>/artifacts/<artifact_id>/<filename>`, and commit a ClickHouse
artifact row with `storage_backend: "r2"`, exact `size_bytes`, `sha256`, and
`mime_type`. Public artifact responses use an opaque
`instantml://artifacts/<artifact_id>` URI for stored local/R2 bytes and omit
internal bucket keys and storage paths. Hosted uploads remain disabled only when
no durable artifact backend is configured.

Output:

```json
{ "artifact": {} }
```

### `GET /api/runs/:run_id/artifacts`

Auth: tenant read access. API keys require `export:read`; browser sessions with
viewer or higher role can list.

Query: `limit`, max 1,000.

Output:

```json
{ "artifacts": [] }
```

### `GET /api/artifacts/:artifact_id/download`

Auth: tenant read access. API keys require `export:read`; browser sessions with
viewer or higher role can download.

Streams local or R2 stored artifact bytes with the artifact MIME type. R2 bytes
are streamed through this same-origin API route, and R2 downloads forward valid
`Range` requests so browser media previews can request byte ranges. Raw bucket
names, signed URLs, and object keys are not exposed in public artifact metadata.
External artifact metadata rows without stored bytes are not downloadable
through this endpoint.

### Versioned Artifact Collections

Versioned artifact routes are the W&B-style reproducibility layer beside the
raw artifact routes above. Raw artifact metadata/upload/download remains
unchanged for existing SDK helpers and checkpoint fork flows.

All read routes require tenant read access (`export:read` for API keys). Upload
routes require `artifacts:write`. Alias, retention, and delete routes require
`artifacts:manage` or an owner/admin browser session.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/artifact-collections?project=&type=&q=&limit=` | List project-scoped collections with latest/best summaries and retained bytes. |
| `GET` | `/api/artifact-collections/:collection_id` | Fetch one collection summary. |
| `GET` | `/api/artifact-collections/:collection_id/versions?limit=` | List versions newest-first. |
| `GET` | `/api/artifact-versions/resolve?ref=<name-or-type/name:alias>&type=&project=` | Resolve `latest`, `best`, or `vN`. |
| `GET` | `/api/artifact-versions/:version_id` | Fetch one version summary. |
| `GET` | `/api/artifact-versions/:version_id/manifest?limit=&offset=&path_prefix=` | Page manifest entries. |
| `GET` | `/api/artifact-versions/:version_id/lineage?limit=` | Return bounded run/artifact nodes and edges. |
| `GET` | `/api/artifact-entries/:entry_id/download` | Stream one stored manifest entry through the API. |
| `POST` | `/api/runs/:run_id/artifact-uploads` | Initiate an SDK upload session from a manifest. |
| `POST` | `/api/artifact-uploads/:upload_session_id/renew` | Renew a contiguous range of presigned upload URLs. |
| `POST` | `/api/artifact-uploads/:upload_session_id/complete` | Complete local inline, R2 single PUT, or R2 multipart upload and commit metadata. |
| `POST` | `/api/artifact-uploads/:upload_session_id/abort` | Mark an uncommitted upload session failed. |
| `POST` | `/api/runs/:run_id/artifact-inputs` | Record `artifact_version -> run` input lineage. |
| `GET` | `/api/runs/:run_id/artifact-edges?direction=both` | List input/output artifact edges for one run. |
| `PUT` | `/api/artifact-collections/:collection_id/aliases/:alias` | Move a custom alias such as `best`. |
| `DELETE` | `/api/artifact-collections/:collection_id/aliases/:alias` | Remove a custom alias. |
| `PATCH` | `/api/artifact-versions/:version_id/retention` | Update `inherit`, `forever`, or TTL-day retention. |
| `DELETE` | `/api/artifact-versions/:version_id` | Soft-delete a version; custom aliases require `delete_aliases=true`. |

Initiate body:

```json
{
  "collection": { "name": "policy", "type": "model", "description": null, "metadata": {} },
  "manifest": {
    "entries": [
      {
        "path": "checkpoint.pt",
        "kind": "file",
        "size_bytes": 12345,
        "sha256": "64-hex",
        "mime_type": "application/octet-stream"
      }
    ]
  },
  "aliases": ["best"],
  "ttl_days": 30,
  "source_step": 1200
}
```

Initiate returns an `upload_session` plus file upload targets. Local storage
targets use `upload_kind: "inline"` and are completed with `content_base64`.
R2 targets use presigned single `put` URLs or `multipart` part URLs. Object keys
are opaque server-generated keys under the versioned artifact namespace and do
not include project names, run IDs, collection names, or filenames. Complete
returns `{ "artifact_version": { ... } }` and creates the output lineage edge.

## Export, Usage, Imports, And Demo

### `GET /api/export`

Auth: tenant read access. API keys require `export:read`; browser sessions with
viewer or higher role can export. Query accepts the same run filters as
`GET /runs`, including the shared run-search `q` language.

Output:

```json
{
  "version": 1,
  "exported_at": "2026-05-16T00:00:00Z",
  "generated_at": "2026-05-16T00:00:00Z",
  "organizations": [],
  "projects": [],
  "runs": [],
  "metric_series": [],
  "metrics": [],
  "attributes": [],
  "artifacts": [],
  "table_object_rows": [],
  "imports": [],
  "limits": {},
  "truncated": false
}
```

### `GET /api/usage`

Auth: unrestricted org API key with `usage:read`, or owner/admin browser
session.

Output:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-16T00:00:00Z",
  "source": "computed_current_state",
  "billing_precision": "not_billable",
  "usage_period": {
    "kind": "calendar_month",
    "timezone": "UTC",
    "starts_at": "2026-05-01T00:00:00Z",
    "ends_at": "2026-06-01T00:00:00Z",
    "reset_at": "2026-06-01T00:00:00Z"
  },
  "plans": {
    "free": {
      "id": "free",
      "label": "Free",
      "monthly_base_usd": 0,
      "included_seats": 2,
      "included_storage_bytes": 2147483648,
      "projects": 2,
      "runs": 100,
      "metric_points": 1000000,
      "api_requests": 500000,
      "api_request_overage_cents_per_million": null,
      "rate_limit_rps": 5,
      "rate_limit_burst": 30,
      "ingest_rate_limit_rps": 2,
      "warehouse_kind": "shared",
      "min_replica_memory_gb": 8,
      "max_replica_memory_gb": 8,
      "num_replicas": 1
    },
    "pro": {},
    "premium": {}
  },
  "overage_policy": {
    "paid_extra_seats": "tracked_not_billed",
    "seats": "paid_extra_seats",
    "projects": "blocked_at_limit",
    "runs": "blocked_at_limit",
    "metric_points": "blocked_at_limit",
    "api_requests": "blocked_or_metered_overage",
    "storage": "blocked_at_limit",
    "artifacts": "visibility_only",
    "api_keys": "visibility_only"
  },
  "organizations": [
    {
      "org_id": "uuid",
      "org_slug": "demo",
      "plan_tier": "premium",
      "plan": {
        "id": "premium",
        "label": "Premium",
        "monthly_base_usd": 699,
        "included_seats": 10,
        "included_storage_bytes": 5497558138880
      },
      "usage_period": {
        "kind": "calendar_month",
        "timezone": "UTC",
        "starts_at": "2026-05-01T00:00:00Z",
        "ends_at": "2026-06-01T00:00:00Z",
        "reset_at": "2026-06-01T00:00:00Z"
      },
      "limits": {
        "included_seats": 10,
        "included_storage_bytes": 5497558138880,
        "projects": 500,
        "runs": 1000000,
        "metric_points": 2000000000,
        "api_requests": 150000000
      },
      "usage": {
        "seats": 2,
        "paid_extra_seats": 0,
        "projects": 1,
        "runs": 2,
        "metric_points": 6,
        "metric_points_current_period": 6,
        "api_requests": 42,
        "metric_points_retained_total": 18,
        "metric_series": 4,
        "artifacts": 0,
        "raw_artifacts": 0,
        "artifact_collections": 0,
        "artifact_versions_active": 0,
        "artifact_versions_pending_delete": 0,
        "api_keys": 1,
        "artifact_bytes_exact": 0,
        "versioned_artifact_bytes_active": 0,
        "versioned_artifact_bytes_pending_delete": 0,
        "versioned_artifact_bytes_reserved": 0,
        "artifact_bytes_unknown": 0,
        "artifact_bytes_unknown_count": 0,
        "estimated_metadata_bytes": 2048,
        "warehouse_storage_bytes_exact": 4096,
        "storage_bytes_for_warnings": 4096,
        "storage_bytes_for_write_gate": 4096,
        "estimated_storage_bytes_for_warnings": 4096,
        "billable_storage_bytes": null
      },
      "warnings": []
    }
  ]
}
```

The response is guardrail/debug telemetry and exposes reportable overage
fields, but Stripe remains the payment source of truth. Metric-point limits are
evaluated against the current UTC calendar-month `usage_period`;
`usage.metric_points` is the same value as `usage.metric_points_current_period`,
while `usage.metric_points_retained_total` is retained history for debugging.
`usage.api_requests` is the current monthly data-plane request rollup. Free and
non-billable orgs are blocked at the monthly API request allowance; paid
Pro/Premium overage is reported to Stripe as exact request-unit deltas.
Projects, runs, storage, seats, artifacts, metric series, and API keys are
current retained-resource counts and do not reset monthly. Warning rows include
`target`, `status`, `value`, `limit`, `ratio`, `policy`, `blocking`, `code`,
and `message`; blocked plan targets use `policy: "blocked_at_limit"` and
`blocking: true`.
`usage.warehouse_storage_bytes_exact` is the ClickHouse `system.parts` byte
count for an InstantML-hosted routed tenant database when that database belongs
only to the org. It is `null` for shared-cell orgs where per-org table bytes are
not exact and for customer-owned ClickHouse orgs where warehouse bytes are not
InstantML-hosted storage. `usage.storage_bytes_for_warnings` is the retained
storage guardrail value and prefers exact hosted warehouse bytes plus exact
artifact bytes when available. For BYOC orgs, it uses only retained artifact
bytes stored by InstantML and never includes customer-owned ClickHouse bytes.
`usage.estimated_storage_bytes_for_warnings` is retained as a compatibility
alias for clients that have not yet moved to the exact/guardrail split.
`usage.storage_bytes_for_write_gate` is the value used before accepting writes;
for versioned artifacts it includes bytes reserved by pending upload sessions
as well as active and pending-delete committed bytes.

New project, run, scalar metric ingest, rank metric ingest, artifact-storage,
import, and demo-reset writes that exceed blocked limits fail with:

```json
{
  "error": "plan limit exceeded: storage would exceed the Free limit while trying to create an artifact",
  "code": "plan_limit_exceeded"
}
```

Status: `402 Payment Required`. Reads, exports, and usage summaries remain
available for over-limit orgs.

Short-window rate limits fail with:

```json
{
  "error": "rate limit exceeded for ingest API",
  "code": "rate_limit_exceeded"
}
```

Status: `429 Too Many Requests`. Responses include `Retry-After`,
`RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.

### `GET /api/usage/export`

Auth and output shape match `/api/usage`, including `usage_period`. The
endpoint is versioned for future billing/debug exports.

### `GET /api/imports`

Auth: same-org browser session or same-org API key. This import-history route is
an exception to the normal `export:read` tenant-read rule.

Output:

```json
{ "imports": [] }
```

### `POST /api/imports/neptune`

Auth: `imports:write` API key or owner/admin session.

Query: `dry_run=true` to validate and summarize without writing rows.

Body:

```json
{
  "project": "imported-project",
  "runs": [
    {
      "id": "external-id",
      "name": "neptune-run",
      "status": "finished",
      "config": {},
      "metadata": {},
      "metrics": [
        { "key": "eval/accuracy", "step": 1, "value": 0.9 }
      ],
      "attributes": [],
      "artifacts": [],
      "tags": ["imported"],
      "started_at": "2026-05-16T00:00:00Z",
      "finished_at": "2026-05-16T00:01:00Z"
    }
  ]
}
```

Output:

```json
{
  "dry_run": false,
  "summary": { "runs": 1, "metrics": 1, "attributes": 0, "artifacts": 0 },
  "import": {}
}
```

### `POST /api/imports/wandb`

Auth and `dry_run` behavior match the Neptune import.

Body uses:

```json
{
  "project": "imported-project",
  "runs": [
    {
      "id": "wandb-id",
      "name": "wandb-run",
      "state": "finished",
      "config": {},
      "metadata": {},
      "summary": {},
      "history": [
        { "_step": 1, "_timestamp": "2026-05-16T00:00:00Z", "eval/accuracy": 0.9 }
      ],
      "artifacts": [],
      "tags": []
    }
  ]
}
```

### `POST /api/imports/mlflow`

Auth and `dry_run` behavior match the Neptune import.

Body uses:

```json
{
  "project": "mlflow-import",
  "runs": [
    {
      "info": {
        "run_id": "mlflow-id",
        "run_name": "mlflow-run",
        "status": "FINISHED",
        "start_time": 1778918400000,
        "end_time": 1778918460000
      },
      "data": {
        "params": [{ "key": "seed", "value": "7" }],
        "tags": [{ "key": "mlflow.runName", "value": "mlflow-run" }],
        "metrics": [{ "key": "eval/accuracy", "step": 1, "value": 0.9 }]
      },
      "metric_history": [],
      "artifacts": []
    }
  ]
}
```

### `POST /api/demo/reset`

Auth: unrestricted org access plus `sdk:ingest`; demo browser sessions are
read-only and cannot call this route.

Body is ignored if present.

Output is the seeded demo run summary payload used by the dashboard.

## Operational Verification

Useful live checks:

```bash
curl -sS https://instantml-rust-api-hfv667633q-uc.a.run.app/health
curl -sS https://instantml-rust-api-hfv667633q-uc.a.run.app/readyz
curl -sS https://instantml-rust-api-hfv667633q-uc.a.run.app/api/auth/config
curl -sS https://instantml-rust-api-hfv667633q-uc.a.run.app/openapi.json
```

For SDK ingestion against hosted API-key mode:

```bash
export INSTANTML_API_KEY=instantml_...
PYTHONPATH=packages/python-sdk python3 - <<'PY'
import instantml as ro

run = ro.init(project="live-check", name="api-reference-check",
              base_url="https://instantml-rust-api-hfv667633q-uc.a.run.app")
run.log({"qa/accuracy": 1.0, "qa/loss": 0.0}, step=1)
run.finish()
PY
```

Do not commit real API keys, Clerk secrets, ClickHouse credentials, or session
cookies. SDK keys are copy-once secrets and should be stored only in an ignored
local env file or a secret manager.
