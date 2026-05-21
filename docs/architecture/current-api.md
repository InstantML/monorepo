# Current Rust API Reference

Date: 2026-05-17

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

The local Next app should normally call the Rust API through same-origin Next
rewrites. After a direct split `npm run deploy:cloud-run`,
`apps/web/.env.local` receives:

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
control role exposes platform, auth/session, user/org, seat, API-key,
service-account, dashboard preference, and saved workspace-view routes. The
data role exposes platform and tenant product routes. `combined` remains the
default and the current deployed shape.

## Auth Model

There are three credential paths.

| Credential | Transport | Main use |
| --- | --- | --- |
| Browser session | `instantml_session` HttpOnly cookie | Next dashboard after Clerk or local dev sign-in |
| SDK API key | `Authorization: Bearer instantml_...` | SDK, uploader, import, export, and automation calls |
| Bootstrap token | `X-InstantML-Bootstrap-Token: ...` | Operator-only user/org/API-key bootstrap routes |

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
tenant warehouse from a down control/API service.

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
    "finished_at": null
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
| Run page limit | Default 100, max 1,000 |
| Batched metric series run IDs | 2,000 |
| Batched metric series response | Max 120,000 returned points; `effective_limit` is clamped per run |
| Workspace-view payload | 64 KiB |
| Console log lines per batch | 50 |
| Console log message | 16 KiB |
| Console log query limit | Default 250, max 1,000 |
| Object page limit | Default 100, max 500 |
| Object table row limit | Default 100, max 1,000 |
| Artifact list limit | Max 1,000 |
| Side-by-side comparison | Max 50 runs and 5,000 rows |
| Export | Max 500 runs, 100,000 metric points, 25,000 attributes, 10,000 artifacts |

## Platform And Health

| Method | Path | Auth | Inputs | Output |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | none | none | `{ "status": "ok" }` |
| `GET` | `/healthz` | none | none | Same as `/health` |
| `GET` | `/readyz` | none | none | `{ "status": "ok" }` when operational and metric ClickHouse stores are reachable |
| `GET` | `/metrics` | none | none | Prometheus text metrics |
| `GET` | `/openapi.json` | none | none | Compact role-aware OpenAPI 3.1 route index with `x-instantml-service-plane` |

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
  "seat_emails": ["teammate@example.com"],
  "accept_invite_org_id": null
}
```

`mode` is `signup` or `signin`. `plan_tier` accepts `free`, `pro`, or
`premium`; legacy `lab`/`startup` canonicalize to `pro` and `growth`
canonicalizes to `premium`. On sign-in, `accept_invite_org_id` can activate a
pending invited membership for the verified email address. If a verified user
has multiple pending invites and does not choose one, the server returns `409`
with `code: "multiple_pending_invites"`.

Output: authenticated session payload plus `Set-Cookie: instantml_session=...`.

### `POST /api/auth/clerk`

Exchanges a verified Clerk session token for an InstantML browser session.

Body:

```json
{
  "token": "clerk-session-jwt",
  "mode": "signup",
  "plan_tier": "premium",
  "account_type": "customer",
  "org_name": "Acme Research",
  "seat_emails": ["teammate@example.com"],
  "accept_invite_org_id": null
}
```

`mode` is `signin` or `signup`. `org_name` is required for signup and omitted
for normal sign-in. `plan_tier` is required only for plan-specific signup
behavior and defaults to `free` when omitted. `accept_invite_org_id` is used on
sign-in to activate a matching invited membership. Output is the authenticated
session payload plus `Set-Cookie: instantml_session=...`.

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
  "account_type": "customer",
  "provisioning": {
    "status": "ready",
    "mode": "cloud-service",
    "service_id": "clickhouse-service-id"
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
| `POST` | `/api/orgs` | `{ "name"?, "slug"?, "plan_tier"?, "owner_user_id"? }` | `{ "organization": OrganizationRow }` |
| `GET` | `/api/orgs` | none | `{ "organizations": [OrganizationRow] }` |
| `GET` | `/api/orgs/name-availability` | `name` | `{ "name", "slug", "available", "message" }` |
| `GET` | `/api/orgs/:org_id/seats` | none | `{ "seats": [SeatRow] }` |
| `POST` | `/api/orgs/:org_id/seats` | `{ "email", "role"?: "owner" | "admin" | "member" | "viewer" }` | `{ "seat": SeatRow }` |
| `POST` | `/api/orgs/:org_id/api-keys` | `{ "name"?, "scopes"?, "project_id"?, "project"?, "expires_at"? }` | `{ "api_key", "api_key_available", "key", "message", "service_account" }` |
| `GET` | `/api/orgs/:org_id/api-keys` | none | `{ "api_keys": [PublicApiKeyRow] }` |
| `POST` | `/api/orgs/:org_id/api-keys/:api_key_id/revoke` | none | `{ "key": PublicApiKeyRow }` |
| `POST` | `/api/orgs/:org_id/service-accounts/:service_account_id/disable` | none | `{ "service_account": ServiceAccountRow }` |

Supported API-key scopes:

```text
sdk:ingest
artifacts:write
imports:write
usage:read
api_keys:write
export:read
```

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
| `q` | Whitespace-token search over run name, tags, config, metadata, and notes |
| `sort_by` | `created`, `name`, `status`, `duration`, `metric-latest`, `metric-best` |
| `metric_key` | Metric used by metric sorts, default `eval/return_mean` |
| `limit` | Page size, max 500 |
| `offset` | Offset pagination |

Output:

```json
{ "runs": [] }
```

### `GET /runs/:run_id`

Auth: tenant read access.

Output:

```json
{ "run": {} }
```

The returned run is a summary value that includes metric aggregates and artifact
counts used by the dashboard.

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
| `limit` | Page size, max 500 |

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

## Export, Usage, Imports, And Demo

### `GET /api/export`

Auth: tenant read access. API keys require `export:read`; browser sessions with
viewer or higher role can export. Query accepts the same run filters as
`GET /runs`.

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
        "metric_points": 2000000000
      },
      "usage": {
        "seats": 2,
        "paid_extra_seats": 0,
        "projects": 1,
        "runs": 2,
        "metric_points": 6,
        "metric_points_current_period": 6,
        "metric_points_retained_total": 18,
        "metric_series": 4,
        "artifacts": 0,
        "api_keys": 1,
        "artifact_bytes_exact": 0,
        "artifact_bytes_unknown": 0,
        "artifact_bytes_unknown_count": 0,
        "estimated_metadata_bytes": 2048,
        "warehouse_storage_bytes_exact": 4096,
        "storage_bytes_for_warnings": 4096,
        "estimated_storage_bytes_for_warnings": 4096,
        "billable_storage_bytes": null
      },
      "warnings": []
    }
  ]
}
```

The response is guardrail/debug telemetry only, not invoice truth.
`billable_storage_bytes` remains `null` until provider/object-store
reconciliation is implemented. Metric-point limits are evaluated against the
current UTC calendar-month `usage_period`; `usage.metric_points` is the same
value as `usage.metric_points_current_period`, while
`usage.metric_points_retained_total` is retained history for debugging.
Projects, runs, storage, seats, artifacts, metric series, and API keys are
current retained-resource counts and do not reset monthly. Warning rows include
`target`, `status`, `value`, `limit`, `ratio`, `policy`, `blocking`, `code`,
and `message`; blocked plan targets use `policy: "blocked_at_limit"` and
`blocking: true`.
`usage.warehouse_storage_bytes_exact` is the ClickHouse `system.parts` byte
count for the routed tenant database when that database belongs only to the
org; it is `null` for shared-cell orgs where per-org table bytes are not exact.
`usage.storage_bytes_for_warnings` is the retained storage guardrail value and
prefers exact warehouse bytes plus exact artifact bytes when available.
`usage.estimated_storage_bytes_for_warnings` is retained as a compatibility
alias for clients that have not yet moved to the exact/guardrail split.

New project, run, metric-ingest, artifact, import, and demo-reset writes that
exceed blocked limits fail with:

```json
{
  "error": "plan limit exceeded: storage would exceed the Free limit while trying to create an artifact",
  "code": "plan_limit_exceeded"
}
```

Status: `402 Payment Required`. Reads, exports, and usage summaries remain
available for over-limit orgs.

### `GET /api/usage/export`

Auth and output shape match `/api/usage`, including `usage_period`. The
endpoint is versioned for future billing/debug exports.

### `GET /api/imports`

Auth: tenant read access.

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
