# Design: Iframe Run Embeds

Date: 2026-06-25

Status: Revised after senior-engineer review

Owner: Codex

## Summary

InstantML should let a customer embed an interactive run chart on another page
by choosing run IDs and authorizing the embed with an InstantML API key. The
embedded view should feel like the Runs workspace chart canvas, but it must not
expose the full dashboard, mutate workspace state, or require a browser session
inside the iframe.

The reviewed v1 is a read-only, server-created embed session:

1. A customer backend calls `POST /api/embed/sessions` with an `export:read`
   API key, explicit run IDs, and one allowed parent origin.
2. InstantML creates a short-lived run-scoped embed session in the control-plane
   auth store so it can be resolved before tenant data is loaded.
3. The returned iframe URL contains only the non-authorizing session ID in the
   HTTP path and the bearer embed token in the URL fragment:
   `/embed/runs/:session_id#token=instantml_embed_...`.
4. The web route uses the session ID to set route-specific frame headers before
   HTML is returned; the client reads the fragment token for embed API calls and
   strips it immediately.
5. The iframe fetches bounded chart data through embed-only routes that reuse
   the existing workspace-view data projection path after embed auth resolves an
   org and tenant route.

Raw API keys and embed bearer tokens must not appear in HTTP query strings.
Browser `postMessage` API-key bootstrap is explicitly deferred out of v1.

This first slice is an interactive run chart embed, not a lineage graph. If the
desired "run diagram" later means checkpoint/run lineage, that should get a
separate design that reuses existing bounded lineage reads.

## Goals

- Embed selected runs on an external page through an iframe.
- Accept explicit run IDs and an API key with `export:read` access.
- Render a read-only interactive run chart canvas with hover, legends, chart
  zoom/range controls where already supported, theme sizing, and manual refresh.
- Reuse existing bounded run summary and metric series logic, especially
  `POST /api/workspace-view-data`, instead of creating a parallel metrics API.
- Keep raw API keys and embed bearer tokens out of HTTP URLs, logs, browser
  history, referrers, iframe persisted state, React state visible to UI, and
  safe frontend API logs.
- Enforce organization and project-scoped API-key access before any run or
  metric data is resolved.
- Keep the main dashboard protected by `frame-ancestors 'none'` and open only
  the dedicated embed route to approved framing origins.
- Keep v1 reversible and additive behind feature flags.

## Non-Goals

- Public permanent embeds.
- Browser-side API-key `postMessage` bootstrap.
- Custom saved workspace-view JSON in the first slice.
- Automatic polling in the first slice.
- Full dashboard embedding, editing, run selection, run stop controls, API-key
  management, artifact downloads, plotted CSV/SVG downloads, report editing, or
  saved-view mutation.
- A new share-token product surface for embeds. That needs separate product
  copy, revocation UI, audit behavior, and pricing policy.
- Embedding arbitrary user-authenticated dashboard sessions in third-party
  sites.
- Node compatibility implementation. New product work stays in
  `apps/rust-server`.
- Billing paid-overage changes.

## Users and Use Cases

ML platform engineers:

- Add a live InstantML chart panel to an internal experiment-review portal.
- Create an embed from a backend service using a project-scoped API key so the
  page can show only selected project runs.

Researchers:

- Share a focused set of run charts inside a notebook, wiki, or internal report
  without asking viewers to open the full dashboard.
- Keep interactive chart inspection while removing dashboard navigation and
  editing controls.

Support and operators:

- Diagnose embed failures with request IDs, status codes, token age, response
  size, point caps, and low-cardinality route metrics, without logging run IDs,
  metric keys, token values, parent origins, generated view JSON, or chart data.

## Proposed Design

### First-Slice User Flow

1. Customer backend receives or owns the selected run IDs.
2. Customer backend calls `POST /api/embed/sessions` with
   `Authorization: Bearer <instantml api key>`, `run_ids`, one
   `allowed_parent_origin`, and optional TTL.
3. InstantML validates the API key, `export:read` scope, current API-key
   project restriction, run visibility, parent origin, body caps, feature flag,
   and org allowlist. Create forces a fresh control-plane auth read before
   writing the session record.
4. InstantML stores a hashed embed token and returns the plaintext token only in
   this create response. The token is reusable until expiry, but copy-once in
   the sense that InstantML never reveals the plaintext again.
5. InstantML returns an iframe URL in this shape:

```text
https://app.instantml.ai/embed/runs/<session_id>#token=instantml_embed_...
```

6. The external page renders the iframe with `referrerpolicy="no-referrer"` and
   a restrictive `sandbox`.
7. The Next web route resolves `<session_id>` before the initial HTML response
   and sets route-specific frame headers.
8. The iframe client parses the fragment token, strips the whole fragment with
   `history.replaceState` on every outcome, calls
   `GET /api/embed/sessions/:session_id/current`, then calls
   `POST /api/embed/sessions/:session_id/runs/data`.
9. The iframe renders a standalone read-only chart canvas and supports manual
   refresh.

### Deferred Browser Bootstrap

Browser `postMessage` API-key bootstrap is not part of v1. If it is added
later, it must use an env-configured allowlist, a nonce in the iframe URL,
`event.source === window.parent`, versioned request/response payloads, exact
origin replies, and backend validation against the actual `event.origin`.

### Frontend Route

Add `apps/web/app/embed/runs/[session_id]/page.tsx` as a standalone route with
no dashboard shell, no Clerk flow, no nav rail, no account menu, no localStorage
workspace persistence, and no saved-view editing controls.

The route supports:

- Path parameter `session_id`: non-authorizing UUID used for frame-policy lookup
  and UI state keying.
- Fragment `#token=instantml_embed_...`: bearer credential read only by the
  iframe client.
- `?theme=light|dark|system` as a presentation hint only.

The route does not support:

- `?api_key=...`, `?token=...`, `?embed_token=...`, or any other bearer query
  parameter.
- Browser-session auth or dashboard cookies.
- Mutating actions.

Fragment-token bootstrap algorithm:

1. On first client render, parse `window.location.hash`.
2. Accept exactly one `token` field whose value starts with
   `instantml_embed_` and is within the server token length bounds.
3. Reject duplicate, missing, malformed, or unexpected fragment fields.
4. Always call `history.replaceState(null, "", pathname + search)` before any
   network request or visible error render.
5. Store the full token only in a closure/ref used for `Authorization`; never
   put it in React-rendered text, localStorage, sessionStorage, analytics, or
   frontend safe API logs.
6. Derive a short in-memory token fingerprint for stale-response keys, but do
   not render or log even that fingerprint.

Rendering:

- Add an `EmbeddedRunsCanvas` backed by a new read-only panel grid, for example
  `ReadOnlyWorkspacePanelGrid`.
- Build the grid from chart primitives and new read-only wrappers such as
  `EmbeddedLinePanel` and `ReadOnlyChartCard`. Do not mount `DashboardShell`,
  `RunsWorkspace`, `WorkspaceSectionView`, `WorkspacePanelCard`, run rail state,
  pagination, add/edit drawers, drag/drop, resize mutation, stop controls,
  download/export actions, saved-view mutation, or workspace localStorage.
- If `MetricChart` is reused, implementation must split chart behavior into
  separate flags such as `showChartOptions` and `showExportActions`. Embed v1
  may keep hover, axes, legends, y-axis controls, smoothing, and local range
  inspection, but plotted CSV/SVG/image export buttons stay disabled.
- V1 uses one deterministic default view generated from the selected runs:
  up to eight line panels, grouped by metric prefix, excluding internal
  `system/instantml/*` upload-health keys. Custom portable views are deferred.
- Range brushing is a progressive pointer enhancement in v1. Keyboard users
  must still get the accessible chart summary table/readout and all refresh,
  status, and panel controls.
- Keep panel data bounded by server caps. Unsupported panel types are impossible
  in v1 because the server generates only line panels.
- Provide loading, expired-token, disabled-feature, forbidden, missing-run,
  empty-metric, limit, and refresh states.

Responsive acceptance criteria:

- Default documented iframe height: `640px`; minimum supported height: `420px`.
- No horizontal body overflow at 320, 640, and 1024 CSS-pixel widths.
- Required viewport checks: `320x420`, `640x420`, and `1024x640`.
- Under 640px width, panels collapse to one column with compact headers.
- The iframe document may scroll vertically. Each chart panel should keep a
  stable minimum height, with at least 180 CSS pixels reserved for the plot area
  when the iframe height is 420px.
- The top status/refresh area remains visible at the top of the document and is
  reachable by keyboard before panel content.
- Legends wrap or collapse instead of pushing chart controls off-screen.
- Refresh and status controls remain reachable by keyboard.
- All error and loading states expose `role="status"` or `role="alert"` as
  appropriate.

### Web Headers, Layout, And Clerk Boundary

The main app keeps its current default security posture:

- `Content-Security-Policy` includes `frame-ancestors 'none'`.
- `X-Frame-Options: SAMEORIGIN` remains on non-embed pages.

The embed route needs response headers before the browser decides whether the
page may be framed. A client page cannot set this after load. Implementation
must move application CSP and `X-Frame-Options` ownership into route-aware
`proxy.ts`/middleware, or an equivalent server path, as a required first
implementation step. It is not optional because `next.config.mjs` currently
sets anti-framing headers for `/:path*`.

The route-aware web layer must:

- Detect `/embed/runs/:session_id` before Clerk middleware and bypass Clerk.
- Resolve the non-secret `session_id` through the frame-policy lookup.
- Emit exactly one embed CSP and no `X-Frame-Options` header for embed HTML.
- Preserve the current CSP and `X-Frame-Options: SAMEORIGIN` behavior for every
  non-embed route.
- Set `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`,
  `Pragma: no-cache`, `X-Content-Type-Options: nosniff`, and
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`.
- Use an embed-specific CSP that keeps the normal restrictive defaults but
  excludes Clerk and Stripe sources: `default-src 'self'; base-uri 'none';
  object-src 'none'; form-action 'none'; frame-ancestors <allowed origin>;
  img-src 'self' data: blob:; connect-src 'self'; script-src 'self'
  'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`.
  If Next requires additional first-party script allowances, document them in
  the implementation PR and keep third-party auth/billing sources out.
- For unknown sessions or frame-policy backend failures, fail closed with
  `frame-ancestors 'none'`.
- For known expired, feature-disabled, or source-key-invalid sessions, allow
  framing only on the stored `allowed_parent_origin` so the iframe can show a
  no-data expired/disabled state. Data APIs still reject these sessions.

The root Next layout currently wraps the app in Clerk surfaces and runs storage
scripts. Implementation must also add a provider/layout plan so `/embed/*` has
no Clerk or browser-storage dependency. The preferred path is a minimal top-level
root layout with no ClerkProvider and no theme/session localStorage scripts,
then dashboard/landing/auth routes move under a Clerk-wrapped route group. A
separate embed root layout is also acceptable if Next route grouping can keep it
isolated. A conditional no-op provider is acceptable only if tests prove embed
loads without Clerk runtime config, no Clerk network calls occur, and
`localStorage`/`sessionStorage` access can be made to throw without breaking the
embed route.

The embed client must use an embed-specific API client with `credentials:
"omit"`. Backend `/api/embed/*` routes must ignore or reject session cookies and
must never set cookies.

### Backend API And Auth Flow

All new backend work lives in `apps/rust-server`.

Embed sessions are low-volume auth/control-plane records, not tenant-only
records. Hosted mode must store and index them in the global User Data/control
plane so `session_id` and embed-token lookups can resolve `org_id` before tenant
data is loaded. Local mode can project the same records in the in-memory store.
After embed auth resolves `{ org_id, session_id }`, data reads load the tenant
route and read runs/metrics from the org's data plane.

Route ownership and layering:

| Route | Service plane | Next rewrite target | Auth/layers | Tenant data? | Writes? |
| --- | --- | --- | --- | --- | --- |
| `POST /api/embed/sessions` | Data | Data before generic `/api/:path*` | Normal API-key auth, existing org plan limiter, embed create-rate cap | Yes, bounded run visibility validation only | Writes one control-plane `embed_session` after validation |
| `GET /api/embed/sessions/:session_id/frame-policy` | Control | Control before generic `/api/:path*` | Pre-auth frame-policy limiter, UUID validation, no product auth | No | No |
| `GET /api/embed/sessions/:session_id/current` | Control | Control before generic `/api/:path*` | Embed auth extractor, no tenant route | No | Usage reservation only |
| `POST /api/embed/sessions/:session_id/runs/data` | Data | Data before generic `/api/:path*` | Embed auth extractor, embed request accounting reservation, per-session limiter, tenant route load | Yes, bounded summaries/series | Usage reservation only |

The data route for `POST /api/embed/sessions` is intentionally data-plane owned
because the API must validate selected run IDs before minting a usable iframe
session. That route performs a narrow control-plane write after tenant run
validation succeeds. The two control-owned lookup routes must not load tenant
data. The embed data-read route must either bypass the existing generic
`data_plane_rate_limit` layer and run the embed auth/accounting helpers
explicitly, or the generic layer must learn embed auth before normal
API-key/session auth. Implementation must choose one path and cover it in
split-service route tests.

Add an embed auth extractor/middleware for `/api/embed/*` token routes:

- Parse `Authorization: Bearer instantml_embed_...`.
- Require a path `:session_id` and match it to the token hash.
- Resolve `EmbedSessionRow` from the control-plane embed-session index.
- Force-refresh current control-plane API-key and service-account state for
  create, `current`, and data reads. Successful stale in-memory hits are not
  enough for embed reads.
- Compare `source_api_key_id`, `source_service_account_id`, active/revoked/
  expired state, effective scopes, and `source_project_restriction_id`.
- Fail closed when control lookup fails. `current` and data use retryable `503`;
  frame-policy lookup uses `frame-ancestors 'none'` for backend failure.
- Produce an `EmbedAuthContext` containing `org_id`, `session_id`,
  `source_api_key_id`, `source_service_account_id`, and
  `source_project_restriction_id`.
- Apply org plan limits and per-session limits after embed auth resolves org
  and before product data reads.

Embed token generation and hashing:

- Generate at least 256 bits of entropy from the OS CSPRNG.
- Encode as `instantml_embed_` plus unpadded base64url characters with fixed
  server-side length bounds.
- Store only a domain-separated hash or HMAC, for example
  `embed_session:v1:<token>`, using a server-secret HMAC when available. Plain
  reuse of a generic SHA-256 API-key hash helper is not sufficient unless it is
  updated to support explicit domain separation.
- Compare token hashes with a constant-time equality helper where practical.
- Never log token prefixes. `token_prefix` exists only for bounded operator
  diagnostics in control storage and must not be emitted to request logs,
  metrics, frontend payloads, or public docs.

Embed route CORS contract:

- Browser callers should use same-origin Next rewrites only. Hosted
  `/api/embed/*` routes must not expose permissive CORS.
- Token routes must not return `Access-Control-Allow-Credentials: true` for
  arbitrary origins. If the global CORS layer would add credentialed CORS,
  implementation must add route-level overrides or split these routes before the
  global CORS layer.
- `OPTIONS` for `/api/embed/*` should return no permissive hosted CORS headers
  unless explicitly called from an allowed InstantML web origin. Tests must
  prove ordinary third-party origins cannot call embed APIs directly with
  credentials.

#### `POST /api/embed/sessions`

Feature gates:

- Disabled unless `INSTANTML_EMBED_ENABLED=true`.
- Hosted rollout may additionally require
  `INSTANTML_EMBED_ORG_ALLOWLIST=<org uuid list>` until staging and internal
  dogfood pass.

Auth:

- Bearer API key with `export:read`.
- Browser sessions are not accepted in v1.
- Project-scoped API keys can create sessions only when every requested run
  belongs to the current scoped project.

Request:

```json
{
  "run_ids": ["uuid", "uuid"],
  "allowed_parent_origin": "https://portal.example.com",
  "ttl_seconds": 900,
  "options": {
    "theme": "system",
    "metric_point_limit": 500,
    "max_panels": 8
  }
}
```

Validation:

- `run_ids` is required, deduped, and capped at 100.
- Every run must be visible to the API key's current org/project scope.
- `allowed_parent_origin` is required in hosted production and must be a single
  canonical HTTPS origin with no path, credentials, wildcard, query string, or
  fragment. Loopback HTTP origins are allowed only in local development.
- Hosted production rejects InstantML-owned app, API, and docs origins as
  `allowed_parent_origin`. The recommended iframe sandbox uses
  `allow-same-origin` so the child frame can call same-origin InstantML APIs and
  render charts normally; allowing an InstantML parent origin would weaken that
  sandbox boundary.
- `ttl_seconds` defaults to 15 minutes and is capped at 60 minutes in v1.
- `options.max_panels` is clamped to the v1 generated-panel cap of 8.
- `options.metric_point_limit` is clamped to 500 points per series.

Response:

```json
{
  "embed_session": {
    "id": "uuid",
    "expires_at": "2026-06-25T20:00:00Z",
    "allowed_parent_origin": "https://portal.example.com",
    "run_count": 2,
    "iframe_src": "https://app.instantml.ai/embed/runs/uuid#token=instantml_embed_..."
  },
  "embed_token": "instantml_embed_..."
}
```

Headers:

- `Cache-Control: private, no-store`
- `Pragma: no-cache`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`

Lost response behavior:

- Because plaintext embed tokens are copy-once, a network failure after
  persistence can leave a live but unrecoverable session until TTL expiry. The
  v1 mitigation is the 60-minute maximum TTL and session cap. Manual embed
  session revocation is deferred until an embed management surface exists.

#### `GET /api/embed/sessions/:session_id/frame-policy`

Purpose:

- Minimal public lookup for the web server/proxy to set initial HTML frame
  headers.
- Returns no run IDs, metric keys, token data, API-key data, or chart data.
- Returning the canonical `allowed_parent_origin` to anyone with the non-secret
  session ID is acceptable in v1 because it is not a bearer secret, but the
  endpoint must not expose CORS broadly or return product data.

Response:

```json
{
  "frame_policy": {
    "session_id": "uuid",
    "status": "active|expired|disabled|source_inactive",
    "allowed_parent_origin": "https://portal.example.com",
    "expires_at": "2026-06-25T20:00:00Z"
  }
}
```

Unknown sessions return `404`. Known inactive sessions can return `200` with a
non-active status so the web route can frame the error shell only on the stored
origin. Control-plane lookup failure returns `503`; the web layer treats it as
fail-closed.

Headers:

- `Cache-Control: private, no-store`
- `Pragma: no-cache`
- `X-Content-Type-Options: nosniff`
- No permissive CORS headers in hosted production.

Abuse controls:

- Validate `session_id` as a UUID before any control-plane lookup; malformed
  values return `400` without hitting the control store.
- Apply a pre-auth short-window limiter keyed by trusted client IP/proxy key and
  route template. V1 default: 30 requests/minute with burst 10 per client key.
- Unknown valid UUIDs return `404` and may be stored in a small in-memory
  negative cache for 30 seconds, keyed by `session_id`, to avoid repeated
  control-store misses. The cache must be capped and must not store parent
  origins or tokens.
- Known expired/disabled sessions still use `no-store`; edge/CDN caching must
  not preserve inactive frame-policy responses.

#### `GET /api/embed/sessions/:session_id/current`

Auth:

- `Authorization: Bearer <instantml_embed_...>`.
- Token hash must match `:session_id`.

Response:

```json
{
  "embed_session": {
    "id": "uuid",
    "expires_at": "2026-06-25T20:00:00Z",
    "run_count": 2,
    "theme": "system",
    "has_custom_view": false
  }
}
```

Headers:

- `Cache-Control: private, no-store`
- `Pragma: no-cache`
- `Vary: Authorization`
- `X-Content-Type-Options: nosniff`

#### `POST /api/embed/sessions/:session_id/runs/data`

Auth:

- `Authorization: Bearer <instantml_embed_...>`.
- Token hash must match `:session_id`.

Request:

```json
{
  "refresh_reason": "initial|manual",
  "options": {
    "metric_point_limit": 500,
    "max_panels": 8
  }
}
```

Behavior:

- Resolve the embed session, confirm it is unexpired, and confirm the source API
  key and service account are still active.
- Revalidate that the current source API key still has `export:read` and the
  same project restriction captured at session creation. If scopes or project
  restriction differ, fail closed.
- Re-check run visibility and project scope before data reads.
- Generate the deterministic v1 line-panel view from selected run summaries.
- Build a `WorkspaceViewDataRequest` from the generated view and stored run IDs,
  then call the same store helper behind `POST /api/workspace-view-data`.
- Return `WorkspaceViewDataResponse`.

Headers:

- `Cache-Control: private, no-store`
- `Pragma: no-cache`
- `Vary: Authorization`
- `X-Content-Type-Options: nosniff`

Errors:

- `401` for missing, invalid, mismatched, expired, or revoked embed token.
- `403` if the source API key no longer has `export:read`, the source project
  restriction changed, or embeds are disabled.
- `404` if any stored run is no longer visible, using the existing no-leak
  missing-run behavior.
- `429` for the per-session read limiter or normal plan limiter.
- `503` for control-plane refresh failure, tenant ClickHouse unavailable, or
  usage accounting failure before product data is served.

### Data Model

Add `EmbedSessionRow` as a control-plane operational record projected into
local/control state:

```text
kind: "embed_session"
entity_id: session_id
schema_version: 1
id: Uuid
org_id: Uuid
source_api_key_id: Uuid
source_service_account_id: Uuid
source_project_restriction_id: Uuid | null
source_scopes_snapshot: string[]
token_hash: bytes
token_prefix: string
run_ids: Uuid[]
allowed_parent_origin: string
options: Json
created_at: DateTime<Utc>
expires_at: DateTime<Utc>
deleted_at: DateTime<Utc> | null
```

Storage rules:

- Store only the embed token hash and prefix, never plaintext.
- Do not store the caller's raw API key.
- Keep the full v1 session record in the control plane because pre-auth
  session lookup must resolve org and source auth state before tenant routing.
- During replay, reject cross-org malformed records, invalid origins, invalid
  run ID arrays, expired records past retention, and duplicate entity IDs where
  the newer `created_at`/`deleted_at` ordering is invalid.
- `entity_id` is the session UUID. Session creation writes one live row.
  Deletion/tombstone is not exposed to users in v1; `deleted_at` is reserved for
  future management or operator cleanup.
- Duplicate live `session_id` records are invalid and must be rejected during
  write and replay. A future tombstone may share the same entity ID only when it
  has a later timestamp than the live row.
- Do not persist `last_used_at` in v1. Use low-cardinality counters and
  in-memory rate-limit state instead of writing on every embed read.
- The worker prunes expired embed sessions after a configurable retention
  window, default 24 hours after `expires_at`. Hosted control storage should
  compact or delete records past retention so short-lived session churn does not
  grow replay without bound.
- Live caps count only unexpired, non-deleted sessions. Expired but unpruned
  records never authorize data reads and should not block new session creation
  once their TTL has passed.
- Add a create-rate cap per source API key, live-session cap per source key, and
  live-session cap per org. V1 defaults: 20 creates/min/source key, 100 live
  sessions/source key, 1,000 live sessions/org.

### Usage, Rate Limits, And Cost

Embed routes are classified as `general` API traffic unless explicitly noted.

Accounting matrix:

| Route | Monthly counted? | Notes |
| --- | --- | --- |
| `POST /api/embed/sessions` | Yes after API key resolves org and short-window limit passes | Count 2xx, validation 4xx, and route 5xx after org resolution. Do not count pre-auth 401 or pre-auth 429. |
| `GET /api/embed/sessions/:id/frame-policy` | No | Pre-auth short-window limited only; returns no product data. |
| `GET /api/embed/sessions/:id/current` | Yes after embed token resolves org and per-session limit passes | Reserve/count before returning the response. Count 2xx and post-auth 4xx/5xx. Do not count invalid-token requests that cannot resolve org or limiter 429s. |
| `POST /api/embed/sessions/:id/runs/data` | Yes after embed token resolves org and per-session limit passes | Reserve/count before tenant product data is read. Count 2xx and post-auth 4xx/5xx after reservation. Do not count invalid-token requests that cannot resolve org or limiter 429s. |

Embed token routes use an embed-specific request accounting reservation helper,
not the generic post-response metering path. Sequence:

1. Resolve embed token and source org.
2. Apply per-session and org short-window limiters.
3. Check monthly API request guardrail.
4. Persist or reserve the monthly request usage row.
5. Only then serve `current` metadata or tenant product data.

If monthly usage guardrail evaluation or usage reservation persistence fails
before a product-data response, fail closed with retryable `503` and emit
`usage_failed` instead of serving unmetered data. If a route returns 5xx after a
successful reservation, the reservation remains counted. This is intentionally
stricter than the generic request-usage middleware because iframe embeds can be
embedded outside the app and should not silently bypass request accounting.

Per-session throttling:

- `POST /api/embed/sessions/:id/runs/data` has a per-session token bucket:
  default one data read every five seconds with burst three.
- V1 uses a per-process in-memory bucket plus the existing org plan limiter.
  Hosted rollout requires embed-enabled data cells to stay at one active
  instance/manual scaling, verified by deploy preflight, unless a shared
  distributed limiter has shipped. There is no operator override for multiplied
  per-session limits in hosted production.
- Process restart resets the per-session bucket. That is acceptable in v1
  because the bucket is an abuse smoother, not the billing source of truth.
- A shared limiter is required before broad multi-instance public embed launch.
- Responses include standard rate-limit and `Retry-After` headers on `429`.

Initial iframe load normally costs:

- One frame-policy lookup, not monthly counted.
- One `current` request, monthly counted.
- One data request, monthly counted.

Manual refresh adds one monthly counted data request. Automatic polling is
deferred so v1 cannot silently create unbounded request usage on a popular page.
Public docs must warn that v1 embeds are for internal or low-traffic pages, not
public high-traffic publishing.

### Resource Caps

V1 source of truth:

- Run IDs per embed: max 100.
- Generated line panels: default 8, max 8.
- Points per series: default 500, max 500.
- Aggregate metric points: max 50,000, inherited from workspace-view data.
- Response bytes: max 10 MiB, inherited from workspace-view data.
- Create body: max 64 KiB.
- Stored options JSON: max 8 KiB.

If `options.max_panels` is omitted, generate up to 8 panels. If it is provided
above 8, clamp to 8 and return a warning in the session create response. If the
requested run/panel/point shape would exceed the 50,000 aggregate point cap,
reduce the effective per-series point limit using the existing
workspace-view-data strategy and return warnings plus populated `limits`. Return
a validation error only when the response would still exceed aggregate point or
byte caps after clamping.

### Component Impact

Backend:

- Add embed session domain types.
- Add control-plane store helpers for create, frame-policy lookup, token lookup,
  current-auth revalidation, rate limiting, and pruning.
- Add route handlers and OpenAPI registration.
- Add an embed auth extractor for token routes that resolves org before usage
  accounting and tenant routing.
- Add ordered split-service route registration so control-owned embed routes are
  available only on control/combined services and data-owned routes are
  available only on data/combined services.
- Reuse workspace-view data projection by constructing a deterministic generated
  view server-side.
- Add route-template observability and safe logs, including backend
  `known_route_template` / `route_plane_for_path` coverage for every
  `/api/embed/*` route.

Frontend:

- Add `/embed/runs/[session_id]` route and `EmbeddedRunsCanvas`.
- Move app CSP/XFO ownership into route-aware middleware and add a provider-free
  embed layout or equivalent.
- Add ordered Next rewrites for `/api/embed/sessions`,
  `/api/embed/sessions/:session_id/frame-policy`,
  `/api/embed/sessions/:session_id/current`, and
  `/api/embed/sessions/:session_id/runs/data` before the generic `/api/:path*`
  rewrite.
- Add an embed-specific API client with `credentials: "omit"`.
- Add read-only chart grid components instead of mounting the full Runs
  workspace.
- Add frontend safe-path coverage, such as `safeKnownRouteSegments`, so session
  IDs are never logged as raw paths.
- Add tests for fragment token handling, expiry, error states, responsive
  widths, stale refresh protection, and route headers.

Python SDK:

- No SDK change in v1.

Storage:

- Add an embed session control-plane operational record kind.
- Add pruning and caps.
- No metric or artifact schema changes.

Docs:

- Update `apps/rust-server/README.md`, `apps/web/README.md`, public docs, and
  architecture API docs during implementation.
- Document safe server-side embedding as the only supported v1 path.

## API Contracts

Add OpenAPI coverage for:

- `POST /api/embed/sessions`
- `GET /api/embed/sessions/:session_id/frame-policy`
- `GET /api/embed/sessions/:session_id/current`
- `POST /api/embed/sessions/:session_id/runs/data`

Run `npm run codegen:api` after adding routes and commit both generated files.

Example recommended embed snippet:

```html
<iframe
  src="https://app.instantml.ai/embed/runs/SESSION_ID#token=EMBED_TOKEN"
  title="InstantML run comparison"
  width="100%"
  height="640"
  loading="lazy"
  referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

Example server-side session creation:

```bash
curl https://api.instantml.ai/api/embed/sessions \
  -H "Authorization: Bearer $INSTANTML_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "run_ids": ["..."],
    "allowed_parent_origin": "https://portal.example.com",
    "ttl_seconds": 900
  }'
```

## Performance Considerations

Endpoint p95 targets in hosted staging:

- `POST /api/embed/sessions`: p95 under 250 ms for 20 run IDs after ClickHouse
  is warm.
- `GET /api/embed/sessions/:id/frame-policy`: p95 under 100 ms.
- `GET /api/embed/sessions/:id/current`: p95 under 150 ms.
- `POST /api/embed/sessions/:id/runs/data`: p95 under 500 ms for 8 panels,
  20 runs, and 10,000 returned points.
- Iframe first useful paint: shell under 500 ms, data under 1,500 ms on a warm
  hosted path for the benchmark shape above.

Frontend bundle/import budget:

- `/embed/*` must not import `DashboardShell`, dashboard tab panes, Clerk UI,
  Stripe UI, report editor, artifact browser, or API-key management surfaces.
- `next build` output must record the embed route size before merge. The embed
  route should not pull dashboard or Clerk chunks; any shared chart chunk must be
  justified in the implementation PR.
- Target budget for v1: the embed route's first-load JavaScript should stay
  under 250 KiB gzip above the Next runtime. If chart library reuse makes that
  impossible, the PR must document the measured size, why it is acceptable, and
  what will be split later.
- Add a route-size regression check or snapshot in the frontend test/docs output
  so future dashboard imports do not silently bloat the iframe route.

Benchmark conditions:

- Run at 1, 5, and 20 concurrent iframe loads against staging.
- Use 20 runs, 8 generated panels, and at least 10,000 returned points for the
  normal case.
- Include a manual-refresh burst that should hit per-session `429` after burst
  capacity.
- Acceptable staging error rate for the benchmark window: under 1% excluding
  intentionally induced `429` and forced revocation/disable cases.

Query shape:

- The embed data route fetches summaries only for the stored explicit run IDs
  and metric keys needed by generated panels.
- Metric series are read through the existing bounded metric-series path.
- No artifact bytes, table rows, logs, or full metric histories are fetched in
  v1.

Memory:

- Server holds one bounded response model.
- Client holds only the returned bounded series and panel state.

Measurement:

- Add route tests for caps and response size.
- Add a UI smoke with at least 10 runs and 4 panels.
- Add a hosted staging check before advertising embeds in public docs.

## Observability

Metric contracts:

- `instantml_embed_requests_total{route,status_class,result}` counter.
- `instantml_embed_request_duration_ms{route}` histogram.
- `instantml_embed_response_bytes{route}` histogram.
- `instantml_embed_returned_points{route}` histogram for data responses.
- `instantml_embed_sessions_live{plan_tier}` gauge.
- `instantml_embed_session_creates_total{result}` counter.
- `instantml_embed_cap_rejections_total{cap}` counter.
- `instantml_embed_rate_limit_rejections_total{limiter}` counter.
- `instantml_embed_usage_accounting_failures_total{route}` counter.
- `instantml_embed_frame_policy_failures_total{reason}` counter.
- `instantml_embed_token_auth_failures_total{reason}` counter.

Low-cardinality route labels must use route templates only:

- `/api/embed/sessions`
- `/api/embed/sessions/:session_id/frame-policy`
- `/api/embed/sessions/:session_id/current`
- `/api/embed/sessions/:session_id/runs/data`

Allowed result/reason labels:

- `ok`, `disabled`, `scope`, `origin`, `run_access`, `limit`,
  `rate_limited`, `expired`, `source_inactive`, `token_invalid`,
  `control_unavailable`, `tenant_unavailable`, `usage_failed`, `validation`,
  `unknown`.

Logs may include route template, status, request ID, org ID, actor kind,
source API-key ID, session age bucket, error code, and low-cardinality result.
Logs and metrics must not include raw tokens, token prefixes, run IDs, metric
keys, project names, parent origins, generated view JSON, metric values, config
values, or metadata values.

Initial alert suggestions:

- Page on sustained `usage_failed` or `control_unavailable` above 1% for
  embed data reads over 10 minutes.
- Page on embed data p95 above 1 second for 10 minutes during enabled rollout.
- Page on embed data 5xx above 2% for 10 minutes, excluding deliberate staging
  failure-injection windows.
- Warn on sustained `tenant_unavailable` above 1% for enabled orgs.
- Warn on frame-policy failures above 5% after excluding intentionally disabled
  orgs.
- Warn on `token_invalid` or frame-policy unknown-session spikes that exceed the
  pre-auth abuse baseline.
- Warn on response byte cap rejections above 2% for enabled orgs.
- Warn when live sessions approach 80% of per-org cap through a bounded operator
  query or admin report grouped by org, not through high-cardinality Prometheus
  labels.

## Rollout And Rollback

Rollout gates:

- API flag: `INSTANTML_EMBED_ENABLED=false` by default in hosted production.
- Web/header flag: `INSTANTML_EMBED_FRAME_ENABLED=false` by default in hosted
  production. When false, `/embed/*` emits anti-framing headers and a disabled
  no-data shell.
- Hosted deploy preflight must reject enabling embeds unless the target data
  cell has one active instance/manual scaling or a shared distributed
  per-session limiter is configured.
- Local development may enable embeds with loopback parent origins.
- Staging enables embeds for the shared demo/internal org first.
- Production enables embeds through `INSTANTML_EMBED_ORG_ALLOWLIST` before a
  broader launch.

Staging acceptance:

- Create session, load iframe, refresh, expire token, revoke source API key,
  and verify frame-origin denial.
- Run synthetic 20-run/8-panel/10k-point p95 checks at 1, 5, and 20 concurrent
  iframe loads.
- Run a two-active-instance staging test with embeds disabled and verify deploy
  preflight blocks hosted enablement until the data cell is one active instance
  or a shared limiter is configured.
- Run reload/manual-refresh burst tests and verify expected `429` behavior.
- Verify multi-origin allow/deny cases.
- Revoke source key under load and confirm next reads fail closed.
- Flip API and web flags under load and verify disabled/closed behavior.
- Inject control DB unavailable/slow, tenant ClickHouse unavailable/slow,
  usage-rollup failure, Cloud Run restart, prune-worker failure, and
  unknown-session storms.
- Confirm non-embed routes keep anti-framing headers.
- Confirm request accounting and per-session rate limits.
- Confirm route-level CORS behavior for `/api/embed/*`, including absence of
  credentialed CORS for ordinary third-party origins.
- Scan Cloud Run, Next, and edge logs for raw tokens, run IDs, metric keys, and
  parent origins.
- Spin up a temporary same-machine embedding site on a separate localhost port
  with a real `<iframe>` using the created session URL. Verify the iframe
  succeeds only when the temp site's origin matches `allowed_parent_origin`, and
  fails when the same iframe is served from a different port/origin.
- Use Browser/Computer Use QA to inspect the dashboard docs page, the temporary
  embedding page, the successful iframe, the denied-origin page, manual refresh,
  and the expired/disabled states as a user would see them.

Rollback runbook:

1. Set `INSTANTML_EMBED_ENABLED=false` on API services. New session creation
   fails, and existing data reads return disabled/forbidden.
2. Set `INSTANTML_EMBED_FRAME_ENABLED=false` on web services when framing itself
   must be stopped. Embed HTML emits anti-framing headers.
3. Verify with:
   - `curl -I https://app.instantml.ai/embed/runs/<id>` shows exactly one CSP.
   - Non-embed dashboard routes still show anti-framing headers.
   - `POST /api/embed/sessions` returns disabled.
   - Existing iframe data reads return disabled and no product data.
4. No cache purge should be required because all embed HTML/API responses are
   `no-store`, but operators should still verify edge/CDN behavior with `curl
   -I` after flag changes.
5. Existing `EmbedSessionRow` records remain until normal pruning; no migration
   is needed.

Mixed deploy behavior:

- New web + disabled API: frame-policy lookup returns disabled or fail-closed;
  iframe shows disabled/no-data or is blocked depending on web flag.
- New API + old web: no embed route is advertised because session creation is
  feature-gated and docs remain dark until both deploys pass staging.

## Simplicity Review

This is the simplest useful version because it:

- Reuses `export:read` API keys and project-scoped key restrictions.
- Uses a control-plane embed-session record so pre-auth lookup and token auth are
  feasible in hosted split mode.
- Reuses workspace-view data projection with a deterministic generated view.
- Avoids raw API keys in browser code and avoids bearer tokens in HTTP URLs.
- Avoids public permanent sharing and dashboard session embedding.
- Adds one standalone iframe route instead of making the full dashboard
  frameable.
- Defers browser bootstrap, custom views, polling, artifacts, downloads,
  management UI, and long-lived share tokens.

Deferred complexity:

- Browser `postMessage` bootstrap for trusted internal pages.
- Custom portable workspace views.
- Public share-token embeds with UI revocation.
- Embed management screens, manual revoke, and audit logs.
- Artifact/media panels and table/log panels.
- Server-side cached embed data.
- SDK helpers.
- Cross-window resize protocol for automatic iframe height.
- Shared distributed per-session rate limiter for multi-instance data cells.

## Failure Modes

- Raw API key or embed token in query string: reject in the frontend route and
  document as unsupported.
- Fragment token missing/malformed/duplicated: strip fragment, render a
  non-sensitive auth error, and do not call data APIs.
- Embed token expired: show a clear expired state with no retry loop when the
  stored session can still be framed on its allowed origin.
- Source API key revoked, scope changed, project restriction changed, or service
  account disabled: reject all further embed data reads.
- Parent origin not allowed: browser blocks framing through CSP.
- Unknown session ID: fail closed with `frame-ancestors 'none'`.
- Control-plane refresh failure: data/current return retryable `503`; frame HTML
  fails closed with `frame-ancestors 'none'`.
- Tenant ClickHouse unavailable or waking: data route returns retryable `503`
  and the iframe shows a retry affordance.
- Usage-accounting failure: data route returns retryable `503` before serving
  product data.
- Rate-limit state loss after process restart: per-process bucket resets; org
  plan limits remain authoritative; emit a low-cardinality restart/reset metric
  if practical.
- Prune-worker failure: live sessions may remain visible until the next worker;
  reads still check `expires_at` synchronously and fail expired sessions.
- Clock skew around TTL: use server time only; allow at most 30 seconds of
  tolerance for frame-policy status display, never for data reads.
- Missing or inaccessible run: return the existing no-leak missing-run error and
  show a non-sensitive error state.
- Metric data too large: server returns validation error before product data;
  frontend shows the limit and suggests fewer runs.
- Network failure: show retry affordance, preserve the last successful data only
  if it came from the same `{sessionId, tokenFingerprint}`.
- Stale async responses: frontend must use abort controllers and request keys
  such as `{sessionId, tokenFingerprint, requestSeq}` so old refreshes cannot
  overwrite newer state.
- Third-party cookie blocking: no dependency on browser session cookies.
- Lost create response after persistence: plaintext token cannot be recovered;
  the session expires within 60 minutes and counts against caps until expiry.

## Testing Plan

Rust:

- `POST /api/embed/sessions` requires `INSTANTML_EMBED_ENABLED=true` and
  `export:read`.
- Split-service route tests verify create/data routes are data-owned,
  frame-policy/current routes are control-owned, and Next rewrites route them
  before generic `/api/:path*`.
- Hosted org allowlist gates session creation.
- Browser sessions cannot create embed sessions.
- Embed-token routes ignore/reject browser cookies and require
  `Authorization`.
- Embed token generation uses at least 256 bits of CSPRNG entropy, fixed
  `instantml_embed_` length bounds, domain-separated hashing/HMAC, and
  constant-time comparison where practical.
- Project-scoped API keys can create sessions only for runs in the current
  scoped project.
- Invalid, expired, disabled-source-key, changed-scope, and
  changed-project-restriction sessions cannot read data.
- Embed token hash must match the path `session_id`.
- Embed session stores token hash only and never persists raw API keys or
  plaintext embed tokens.
- Origin validation rejects paths, wildcards, credentials, non-HTTPS hosted
  origins, fragments, query strings, and over-limit origins.
- Session create-rate and live caps reject excessive sessions per source key
  and per org.
- Data route calls bounded workspace-view data helpers and preserves run/panel/
  point/byte caps.
- Default-view generation excludes internal SDK health keys and caps panels at
  8.
- Per-session data read limiter returns `429` and `Retry-After`.
- Accounting matrix tests cover pre-auth 401, invalid-token no-org, 2xx,
  validation 4xx, limiter 429, route 5xx, and usage-rollup failure.
- Every embed API response has `no-store`; token-auth responses also include
  `Vary: Authorization`.
- CORS tests verify hosted `/api/embed/*` routes are same-origin/Next-only and
  do not expose credentialed CORS to ordinary third-party origins.
- OpenAPI includes all embed routes with the correct auth schemes.
- Observability tests verify safe route templates, `route_plane_for_path`,
  frontend safe-path templates, and low-cardinality reasons.

Frontend:

- `/embed/runs/:session_id#token=...` loads without dashboard shell, Clerk
  redirects, or Clerk network calls.
- `/embed/runs/:session_id?token=...` and `?api_key=...` refuse to proceed and
  do not call data APIs.
- The fragment token is read once and removed with `history.replaceState` on
  success and error paths.
- Duplicate/malformed fragment tokens are rejected and never rendered.
- Header tests prove non-embed pages keep anti-framing headers and embed pages
  get exactly one route-specific CSP and no `X-Frame-Options`.
- Loading, expired, disabled, forbidden, missing-run, no-data, limit, and
  success states render accessibly.
- Manual refresh aborts stale in-flight requests and keys responses by session.
- Embed API fetches use `credentials: "omit"`.
- Read-only chart grid cannot render edit, drag, resize, remove, stop, download,
  export, localStorage, or saved-view controls.
- Responsive tests cover `320x420`, `640x420`, and `1024x640` iframe sizes with
  no horizontal overflow and reachable refresh/status controls.
- Keyboard-only Playwright coverage exercises refresh, chart/table summary
  access, legend overflow handling, y-axis/chart option controls, and error
  states inside the iframe.
- Build output records the `/embed/*` route size and proves Clerk/dashboard
  chunks are not imported.
- Browser/Computer Use QA captures screenshots for the successful embedded
  chart, denied-origin/frame-policy state, expired or disabled session state,
  narrow iframe layout, and the public docs section that explains iframe usage.

Integration/smoke:

- Create a project-scoped API key, create an embed session for selected runs,
  load the iframe from the allowed origin, and verify rendered run names/series
  match the dashboard.
- Revoke the API key and verify the next embed refresh fails.
- Try to embed from an unlisted origin and verify framing is blocked.
- Verify selected run IDs never appear in request logs or frontend safe API
  logs.
- Start the InstantML web/API stack plus a temporary static test site, such as
  `http://127.0.0.1:4177`, that contains only the documented iframe snippet.
  Create one embed session whose `allowed_parent_origin` matches that temp
  origin and one whose origin deliberately does not. Verify both with
  Browser/Computer Use and record screenshots in the implementation PR or docs
  assets.
- Confirm the iframe can be embedded in ordinary HTML without dashboard cookies,
  Clerk session state, browser extension assumptions, or same-origin parent
  privileges.
- Run `npm run verify:api-types`, Rust tests, frontend node tests, UI smoke,
  `npm run docs:validate`, and `npm run docs:test`.

Coverage:

- No coverage exception planned.

## Documentation Plan

Implementation must update:

- `apps/rust-server/README.md`: embed routes, auth, config, TTLs, caps, request
  accounting, and pruning.
- `apps/web/README.md`: `/embed/runs/:session_id`, security headers, Clerk
  bypass/provider split, rendering scope, and local testing.
- `docs/architecture/current-api.md`: route contracts and error behavior.
- `apps/docs`: public embedding guide with server-side examples and token
  safety warnings.
- Public docs must include screenshots for the generated embed, the code snippet
  placement, and at least one error/expired state. Screenshots should be taken
  from the verified local or staging embed flow, not mocked. Live `iframe_src`
  values are short-lived bearer secrets; screenshots and code snippets must use
  placeholders or expired/revoked tokens, never live tokens.
- Public docs must warn that full iframe URLs contain short-lived bearer
  credentials in the fragment and should not be logged, stored in analytics/CMS
  systems, or copied into public pages in v1.
- Add a short "Testing an embed locally" section that tells future agents how to
  start the API/web app, start the temporary static parent site, mint an embed
  session for that origin, paste the returned iframe snippet, and verify allowed
  and denied origins.
- `docs/design/README.md`: add this design after implementation.

## Alternatives Considered

Raw API key in iframe query string:

- Rejected. URLs leak through browser history, logs, referrers, screenshots,
  analytics, and copy/paste. Even `Referrer-Policy` cannot protect already
  logged URLs.

Embed bearer token in iframe query string:

- Rejected after review. It is safer than a raw API key but still a bearer
  credential. V1 uses a non-secret session ID in the path and a fragment token
  read by client JavaScript.

Tenant-only embed session storage:

- Rejected after senior review. Hosted split mode needs pre-auth lookup by
  session ID/token before tenant routing, so v1 stores low-volume embed session
  records in the control plane.

Browser `postMessage` API-key bootstrap in v1:

- Rejected after review. It makes origin validation and raw-key handling harder
  to audit. It can come later behind an explicit design and hosted flag.

Make the full dashboard frameable:

- Rejected. It weakens the main app's anti-framing posture, pulls in Clerk
  sessions and mutating UI, and exposes far more surface than a read-only run
  chart needs.

Use existing report share links:

- Rejected for v1. Reports are document artifacts with share-token semantics;
  run embeds need explicit run IDs, API-key project scope, and bounded live
  metric reads.

Custom saved workspace views in v1:

- Rejected after review to keep the security-sensitive first slice small. The
  deterministic generated chart view is enough for run-ID embeds.

Long-lived public embed tokens:

- Rejected for now. Public embeds need management UI, rotation, audit policy,
  and pricing/usage decisions.

## Review Notes

Fresh reviewer 1 - backend/security:

- Finding: The initial draft put the embed bearer token in the iframe query
  string, underspecified dynamic `frame-ancestors`, kept browser API-key
  `postMessage` bootstrap in scope, blurred control/data auth revalidation, and
  could create write load by persisting `last_used_at`.
- Risk: Bearer tokens could leak to logs/history/referrers, framing could be
  blocked or too broad, browser bootstrap could self-authorize origins, revoked
  or narrowed API keys could continue serving data, and polling could spam the
  operational log.
- Recommended edit: Use session ID plus fragment token, require route-aware
  initial CSP, remove browser bootstrap from v1, revalidate current control
  auth on every read, rename project restriction fields, and omit persisted
  `last_used_at`.
- Decision: Accepted. The design uses `/embed/runs/:session_id#token=`, fails
  closed on unknown frame policy, defers browser bootstrap, records source scope
  and project restriction snapshots, revalidates them, and removes persisted
  read timestamps.

Fresh reviewer 2 - frontend/UX:

- Finding: The current Next global headers and Clerk proxy would apply to
  `/embed/runs`; a client page cannot set frame headers; the embed token should
  not be in an HTTP URL; Runs workspace reuse needed a stricter read-only
  boundary; responsive and stale-response criteria were too vague.
- Risk: The iframe could fail to load under Clerk or anti-framing headers, or
  implementation could accidentally mount dashboard state and mutating handlers.
- Recommended edit: Add route-aware middleware/handler requirements, bypass
  Clerk for `/embed/*`, use fragment bearer tokens, build a read-only panel
  grid, define responsive widths, and key async state by session/token/request.
- Decision: Accepted. The design adds Clerk bypass/header requirements,
  read-only component boundaries, responsive criteria, fragment stripping, and
  stable async request keys.

Fresh reviewer 3 - product/performance/reliability:

- Finding: The first slice was too wide, usage/rate-limit behavior was vague,
  rollout/rollback was missing, observability needed measurable counters, and
  embed caps needed clearer public docs.
- Risk: V1 would be hard to review, could create unbounded request usage, and
  would lack a clean hosted kill switch.
- Recommended edit: Limit v1 to server-created sessions with deterministic
  panels and manual refresh, classify embed APIs for metering, add a
  per-session limiter, gate rollout behind feature flags/org allowlist, and add
  rollback behavior.
- Decision: Accepted. The design narrows v1, adds usage accounting and rate
  limits, introduces rollout flags, and defines observability and rollback.

Senior reviewer 1 - backend/security implementation readiness:

- Finding: Tenant-only storage could not support pre-auth lookup; embed-token
  routes conflicted with normal API-key/session middleware; API-key revalidation
  needed a forced control refresh; token routes should bind session ID to token;
  and operational replay/pruning needed clearer semantics.
- Risk: Hosted split mode could fail before tenant routing, stale control auth
  could leak data, normal middleware could reject embed tokens, and short-lived
  session churn could grow replay cost.
- Recommended edit: Store embed sessions in the control plane, add an embed auth
  extractor, force current control auth revalidation, route token calls through
  `:session_id`, and define replay/entity/prune/cap behavior.
- Decision: Accepted. The revised design makes embed sessions control-plane
  records, adds embed auth before usage/tenant routing, binds token routes to
  path session IDs, and documents replay/pruning/caps.

Senior reviewer 2 - frontend/platform implementation readiness:

- Finding: Dynamic headers needed a required route-aware implementation; expired
  UX conflicted with fail-closed framing; ClerkProvider/root layout needed an
  embed plan; private API cache headers were incomplete; fragment parsing and
  chart export behavior needed exact rules.
- Risk: The iframe could stay blocked by global headers, require Clerk runtime,
  cache private data, leak fragment tokens, or expose download/edit UI in a
  sandboxed frame.
- Recommended edit: Move CSP/XFO to route-aware middleware, allow known inactive
  sessions to frame only on stored origin for no-data UX, add provider-free
  embed layout or equivalent, require `credentials: "omit"` and no-store headers,
  and disable chart downloads in v1.
- Decision: Accepted. The revised design adds required route-aware headers,
  known-inactive frame behavior, provider/layout and cookie boundaries,
  fragment algorithm, cache headers, and read-only/no-download chart rules.

Senior reviewer 3 - reliability/performance implementation readiness:

- Finding: Request accounting needed a route/status matrix, per-session
  throttling needed a multi-instance decision, cache headers were incomplete,
  rollback needed web/header coverage, observability needed concrete metric
  contracts, staging validation needed synthetic/failure tests, p95 targets were
  incomplete, caps conflicted, and hosted dependency failures were missing.
- Risk: Embeds could serve unmetered data, multiply limits under scale-out,
  cache private responses, roll back unclearly, or fail opaquely under hosted
  dependency issues.
- Recommended edit: Add accounting matrix, per-process limiter decision, no-store
  headers everywhere, web/API rollback runbook, concrete metrics/alerts,
  synthetic staging gates, endpoint p95 targets, unified v1 caps, and expanded
  failure modes.
- Decision: Accepted. The revised design includes those reliability contracts
  and keeps a shared limiter as a deferred multi-instance requirement.

PR senior reviewer 1 - frontend security/platform:

- Finding: Split-service routing and middleware ownership were still
  underspecified; provider-free layout needed to remove root storage scripts;
  sandbox/origin rules needed a same-origin guard; iframe docs/screenshots could
  accidentally expose live bearer fragment URLs; and safe route templating needed
  explicit backend/frontend updates.
- Risk: Embed-token requests could hit the wrong service or middleware, embeds
  could still depend on Clerk/storage globals, same-origin parents could weaken
  the sandbox, and route IDs/tokens could leak through logs or screenshots.
- Recommended edit: Add route/service/layer matrix, minimal provider-free embed
  layout, reject InstantML-owned parent origins in hosted production, treat
  `iframe_src` as a bearer secret in docs, and update safe route templates.
- Decision: Accepted. The design now includes split route ownership, ordered
  rewrites, provider/storage isolation, same-origin rejection, bearer-safe docs,
  and safe route template tests.

PR senior reviewer 2 - frontend performance/UX:

- Finding: Bundle/import boundaries were underspecified, chart reuse needed a
  sharper read-only contract, vertical iframe behavior was missing, screenshot
  docs were not tied to repo checks, and keyboard QA needed more specificity.
- Risk: The embed route could pull dashboard/Clerk chunks, read-only iframes
  could inherit export/edit controls, small iframes could become unusable, and
  docs screenshots could drift from tested behavior.
- Recommended edit: Add route-size budgets, require `EmbeddedLinePanel` /
  `ReadOnlyChartCard`, split `showChartOptions` from `showExportActions`, add
  `320x420`/`640x420`/`1024x640` acceptance, run docs checks, and add
  keyboard-only iframe tests.
- Decision: Accepted. The design now includes bundle budgets, explicit
  read-only chart boundaries, vertical responsive criteria, docs validation, and
  keyboard QA.

PR senior reviewer 3 - backend security/architecture:

- Finding: Route service-plane ownership was incomplete, embed token generation
  and hashing were not production-specific, accounting fail-closed behavior
  conflicted with generic post-response metering, pre-auth frame-policy abuse
  controls and CORS were incomplete, and replay/pruning semantics needed more
  determinism.
- Risk: Hosted split routing could fail, token hashes could lack domain
  separation, embeds could serve unmetered data, frame-policy lookups could be
  abused, and session churn could grow control replay cost.
- Recommended edit: Add route/service/layer matrix, require 256-bit CSPRNG
  tokens with domain-separated HMAC/hash and constant-time compare, add
  embed-specific usage reservation before product reads, define pre-auth
  limiter/negative cache/CORS behavior, and tighten duplicate/prune semantics.
- Decision: Accepted. The design now includes those contracts.

PR senior reviewer 4 - backend reliability/performance:

- Finding: Per-session throttling allowed a soft multi-instance override,
  request accounting lacked exact integration details, control-plane load was
  under-budgeted, cap behavior did not match the existing adaptive view-data
  helper, observability alerts were not actionable enough, and staging gates
  needed hosted failure injection.
- Risk: Hosted embeds could multiply per-session limits, overuse control
  storage, serve unmetered data, reject valid large requests inconsistently, or
  pass staging without exercising real failure modes.
- Recommended edit: Make one-active-instance/shared-limiter a hard hosted gate,
  define accounting reservation sequence, add pre-auth limiter and control-read
  budgets, use adaptive point-limit reduction, add actionable alerts, and expand
  staging failure injection.
- Decision: Accepted. The design now requires deploy preflight, explicit usage
  reservation, pre-auth controls, adaptive cap semantics, concrete alerts, and
  failure-injection staging gates.

## Coverage Exceptions

None planned.

## Decision

Revised after fresh-agent and senior-engineer review. Recommended v1 is accepted
for implementation planning: server-created, short-lived, run-scoped, read-only
interactive chart embeds with a control-plane session record, a non-secret
session ID in the iframe path, the bearer embed token in the URL fragment,
route-specific frame headers, explicit embed auth, metered bounded data reads,
and hosted rollout gates. Implementation has not started.
