# Design: Dashboard Reliability And Control Views

Date: 2026-05-17

Status: Revised after fresh review

Owner: Codex

## Summary

The hosted dashboard is useful but still feels unreliable under real ClickHouse-backed data volumes. The current web shell treats overview and run summary loading as one coupled request, so a transient overview or warehouse error can show "Server is unavailable" and leave the runs count stale even when run summaries are available. Search also misses project names because the Rust in-memory run search text does not include the run project.

The dashboard also keeps important user state in browser localStorage only. Saved views, workspace layouts, and the selected project should persist through the Rust control plane so users see the same workspace across devices and hosted sessions. LocalStorage remains a fallback for local development and offline browser state.

This design implements the requested reliability slice as a set of narrow, separable fixes: independent dashboard loads, control-plane saved view and project preference records, real ClickHouse warehouse byte reporting where it is safely scoped, bounded patch metric fetches for large run selections, Cmd+K backdrop close, and the first non-line panel types. Chart research from official W&B, Grafana, and TensorBoard/PyTorch docs supports adding bar and histogram panels now, plus a lightweight dot plot for latest-value comparison; true arbitrary x/y scatter is deferred until the field catalog can model chart axes honestly.

## Goals

- Make run summaries and the "Runs (n)" rail update even when overview data is temporarily unavailable.
- Persist selected project and saved dashboard/workspace views in Rust control-plane records.
- Make run search match project names, run names, tags, config, and metadata.
- Keep 500-run selections usable by chunking metric series requests and applying incremental UI patches.
- Close the Cmd+K quick search when users click the modal backdrop.
- Report warehouse storage from ClickHouse table bytes when available instead of metadata estimates alone.
- Add bar, histogram, and dot-plot panel types while preserving existing line panels and saved layouts.

## Non-Goals

- Full collaborative workspaces, sharing permissions, or view publishing.
- Billing-grade storage invoices. The new ClickHouse byte value is an operational warning metric.
- New SDK APIs for custom chart logging.
- A generic Vega/custom chart editor.
- Replacing the existing metric series endpoint or table schema.

## Users and Use Cases

Hosted users compare large training runs in the dashboard. They expect search and project filters to work against the current backend data, saved views to follow their account, and heavy selections to degrade gracefully rather than freezing the page. Operators need the topbar status to distinguish a warming warehouse from a real failure. Admins need storage warnings that roughly match ClickHouse's actual footprint.

## Proposed Design

### Resilient dashboard load

The frontend will request `/api/runs/summary` and `/api/overview` independently with `Promise.allSettled`. A successful summary updates the run list, selection, pagination, and rail count even if overview fails. A failed overview keeps the last known overview and shows a non-blocking syncing message only when there is no successful summary. If the summary fails with `warehouse_unavailable`, the existing retry loop remains. If overview fails with a transient warehouse error but summary succeeds, the UI avoids the red "API issue" state.

Rust's ClickHouse transient classifier will include enumerated connection reset/idle wakeup messages such as broken pipe, connection aborted, socket hang up, unexpectedly closed, connection reset by peer, EOF while reading response, and error trying to connect. It will not use a catch-all "connection error" or broad TLS match because auth, certificate, schema, and query failures should remain real API failures. These transient strings map to the existing `warehouse_unavailable` error code so the frontend can retry and show warehouse-starting copy.

### Control-plane route ownership

All new preference/view endpoints are control-plane routes. They are added to `control_routes()` and intentionally call request context with `tenant_route=false`, so they do not load or depend on the tenant ClickHouse warehouse. Next rewrites route these paths to `INSTANTML_CONTROL_API_BASE` before the broad `/api/:path*` data-plane rewrite:

- `/api/dashboard/preferences`
- `/api/workspace-views`
- `/api/workspace-views/:view_id`

Hosted writes require a non-demo browser session whose role is owner, admin, or member. Hosted reads require a browser session in the current org. API-key access is rejected for this first slice because these are user workspace records rather than SDK/product data. Local unauthenticated mode remains allowed for development.

### Control-plane dashboard preferences

Add a `dashboard_preference` control record keyed by `(org_id, user_id_or_nil)`:

```json
{
  "schema_version": 1,
  "org_id": "uuid",
  "user_id": "uuid-or-null",
  "selected_project": "hosted-scale-data",
  "updated_at": "2026-05-17T00:00:00Z"
}
```

The control record `entity_id` is `dashboard_preference:{user_id_or_nil}`. Replay is last-write-wins by the existing deterministic control-store order: `(created_at, event_id)`. The browser loads it from `GET /api/dashboard/preferences` after session and project list are available. Project selection writes through `PUT /api/dashboard/preferences` with `{ "selected_project": string | null }`. The backend validates string shape only; it does not read tenant projects because that would reintroduce data-plane availability. The frontend validates against `/projects` before applying the stored project. If the stored project no longer exists, the frontend falls back to All projects and overwrites the preference on the next explicit user change.

### Control-plane workspace views

Add a `workspace_view` control record keyed by UUID:

```json
{
  "schema_version": 1,
  "id": "uuid",
  "org_id": "uuid",
  "owner_user_id": "uuid-or-null",
  "name": "hosted-scale-data:eval-return",
  "project": "hosted-scale-data",
  "payload": {
    "dashboard": { "project": "...", "metricKey": "...", "selectedRunIds": [] },
    "workspace": { "schemaVersion": 2, "sections": [] }
  },
  "created_at": "2026-05-17T00:00:00Z",
  "updated_at": "2026-05-17T00:00:00Z",
  "deleted_at": null
}
```

The control record `entity_id` is the view UUID. Updates write a complete replacement row with the same `id`, original `created_at`, and a new `updated_at`; replay keeps the last row for each id using the existing deterministic control-store order: `(created_at, event_id)`. The payload is capped at 64 KiB and must be a JSON object. Names are validated with the existing name validator. Views are scoped to the owning user when a browser session exists and to the local org in unauthenticated local mode. A user can only update their own view. Demo sessions can read but cannot write. The first slice implements list summaries, create, read detail, and update. Delete can follow later.

Frontend saved views use the control API first and preserve localStorage as fallback. After the 2026-05-25 frontend audit hardening, authenticated localStorage fallback views are listed only from org/user/project-scoped keys so a shared browser cannot leak another workspace's run IDs, metric keys, or saved queries. Older unscoped local views are not auto-listed in authenticated sessions; users can recreate them by saving the view again. List calls are summary-only and capped; detail calls load full payloads only when the user applies a view.

### Search and live run counts

Rust `run_search_text` will include `run.project`. Summary requests already return `total`, so the frontend rail count updates from each successful summary load. The independent load change prevents stale counts when overview fails.

### Patch metric series fetches

The frontend will split metric series requests into fixed-size chunks, defaulting to 50 run IDs per request. It will reduce per-run point limits for large selections:

- fewer than 50 selected runs: 1000 points per run
- 50 to 99: 500 points per run
- 100 to 249: 250 points per run
- 250 to 399: 160 points per run
- 400 or more: 120 points per run

The existing `/api/metrics/series` endpoint already accepts bounded `run_ids` and `limit`, so no backend contract change is needed. The web shell applies each chunk as a patch to the relevant metric series state. It preserves per-metric dedupe, only fetches metric keys for panels in the active tab, and runs chunks through a small global queue with at most two in-flight chunk requests. This prevents a 500-run selection across several panels from becoming hundreds of simultaneous HTTP requests. It will keep prior chunks visible while later chunks load and abort outstanding chunks when filters, selection, active tab, or workspace panels change.

### Panel types

The workspace schema version increments to 2. Existing version 1 line panels migrate in-place. Supported types are:

- `line`: existing step/time metric history chart.
- `bar`: latest value per run as compact bars for categorical comparison.
- `histogram`: distribution of latest values across the selected/visible run set.
- `dot`: latest value per run plotted as individual points by selected run order.

The Add panels drawer exposes a chart type selector and uses the chosen type when adding any metric. The edit drawer can switch type for an existing panel. Line panels use the metric-series endpoint. Bar, histogram, and dot panels derive latest values from `RunSummary.metric_aggregates[metric].latest`, not from bounded history points, so large-run point limits cannot accidentally show early points as "latest". True x/y scatter, parallel coordinates, media, and query panels remain deferred until a field catalog and persisted axis references exist.

## Component Impact

Backend:

- Add control endpoints for dashboard preferences and workspace views.
- Add control record kinds and replay support.
- Add project names to run search text.
- Add ClickHouse table-byte counting for usage summaries.
- Broaden ClickHouse transient error classification.

Frontend:

- Load and save preferences/views via API with localStorage fallback.
- Load dashboard summary and overview independently.
- Chunk metric series requests and patch series state incrementally.
- Add bar, histogram, and dot workspace panels.
- Close Cmd+K on backdrop click.
- Rename the storage card to "Warehouse data" and prefer exact warehouse bytes.

Python SDK:

- No SDK change.

Storage:

- Control records gain `dashboard_preference` and `workspace_view` kinds.
- Tenant/data ClickHouse tables remain unchanged.

Docs:

- Update Rust and web READMEs with the new endpoints, saved-view behavior, chart types, and usage-byte semantics.

## Data Model

`DashboardPreferenceRow`:

- `org_id: Uuid`
- `user_id: Option<Uuid>`
- `schema_version: i32`
- `selected_project: Option<String>`
- `updated_at: DateTime<Utc>`

`WorkspaceViewRow`:

- `id: Uuid`
- `org_id: Uuid`
- `owner_user_id: Option<Uuid>`
- `schema_version: i32`
- `name: String`
- `project: Option<String>`
- `payload: serde_json::Value`
- `created_at: DateTime<Utc>`
- `updated_at: DateTime<Utc>`
- `deleted_at: Option<DateTime<Utc>>`

`UsageCounts` adds:

- `warehouse_storage_bytes_exact: Option<i64>`
- `storage_bytes_for_warnings: i64`

The persisted `estimated_storage_bytes_for_warnings` field remains for compatibility. For dedicated per-org databases, storage warnings use `artifact_bytes_exact + warehouse_storage_bytes_exact`. For local mode, the local database byte count is allowed because it is a developer-only operational estimate. For shared-cell/shared-database orgs, exact warehouse bytes are `null` because database-level `system.parts` would include other orgs; those orgs continue using `artifact_bytes_exact + estimated_metadata_bytes` until per-org table-byte accounting is designed.

## API Contracts

`GET /api/dashboard/preferences`

Response:

```json
{ "preferences": { "selected_project": "project-or-null", "updated_at": "iso8601-or-null" } }
```

`PUT /api/dashboard/preferences`

Request:

```json
{ "selected_project": "project-or-null" }
```

Response is the same shape as GET.

`GET /api/workspace-views`

Response:

```json
{ "workspace_views": [WorkspaceViewSummary], "next_cursor": "string-or-null" }
```

Query parameters:

- `limit`, default 50 and maximum 100
- `cursor`, opaque pagination cursor returned by the previous response. The current Rust implementation returns a numeric offset string, but clients must treat it as opaque.

Summary fields: `id`, `name`, `project`, `created_at`, `updated_at`. Full `payload` is not returned by list.

`POST /api/workspace-views`

Request:

```json
{ "name": "name", "project": "project-or-null", "payload": { } }
```

Response:

```json
{ "workspace_view": WorkspaceViewRow }
```

`GET /api/workspace-views/:view_id`

Response:

```json
{ "workspace_view": WorkspaceViewRow }
```

`PUT /api/workspace-views/:view_id`

Request:

```json
{ "name": "optional-name", "project": "project-or-null", "payload": { } }
```

Response:

```json
{ "workspace_view": WorkspaceViewRow }
```

All write endpoints require a non-read-only browser session in hosted mode. Local unauthenticated mode remains allowed for development. API keys are not part of this first slice.

The Rust OpenAPI schema and generated frontend types use these runtime envelope names (`workspace_views` and `workspace_view`) so callers do not need frontend-only translation for the primary contract. The web normalizer still accepts the earlier generated `views` and `view` aliases for compatibility with already-built local clients.

## Performance Considerations

- Saved views and preferences are small, low-frequency control writes.
- View payloads cap at 64 KiB and list responses only return capped summaries for the current user/org.
- Metric series chunking bounds each request to at most 50 runs and an adaptive point limit.
- Metric series chunking also bounds global client concurrency to two in-flight chunk requests.
- Chart derivations for dot/bar/histogram operate on run-summary latest values only and cap rendered marks to the selected run cap.
- The usage storage byte query reads `system.parts` for the active database only when that database is scoped to one org or local development. It is used on usage/settings pages, not the scalar metric ingestion path.
- Run list endpoints remain paginated and summary-only.

## Simplicity Review

This design keeps the existing REST route shapes and metric-series endpoint. It adds two narrow control-plane entities instead of building a general dashboard collaboration model. Non-line chart types reuse run-summary aggregates, so no new metric schema or SDK payload is required.

Deferred complexity:

- Shared/collaborative views.
- View deletion and restore.
- Vega/custom panel editor.
- Server-side downsampling per chart viewport.
- Billing-grade storage reconciliation.

## Failure Modes

- Control API unavailable: frontend falls back to localStorage and shows a normal message.
- Stored selected project deleted: frontend falls back to All projects.
- Stored view payload invalid or too large: backend rejects writes; frontend sanitizes reads.
- Shared-cell org usage: frontend shows estimated tracked data and does not display an exact warehouse byte claim.
- ClickHouse warming or idle close: backend maps common transient errors to `warehouse_unavailable`; frontend retries.
- Metric chunk fails after partial patches: frontend aborts or shows the existing metric-series error and keeps prior loaded chunks visible.
- Too many runs selected: selection remains capped by `MAX_SELECTED_RUNS` and series point limits adapt.

## Testing Plan

- Rust unit tests:
  - `run_search_text` includes project names.
  - ClickHouse transient classifier catches newly added network errors.
  - Usage warning bytes prefer exact warehouse bytes over estimates.
  - Workspace view validation rejects oversized or non-object payloads.
- Rust route/store tests where existing harnesses allow:
  - Create/list/update workspace views.
  - Read/write dashboard preferences.
- Web Node tests:
  - Workspace schema v1 line panels sanitize into schema v2.
  - Non-line panel types are accepted and can coexist for one metric.
  - Adaptive metric limit and patch merge helpers preserve run order.
  - Saved-view payload builders include dashboard and workspace state.
- Browser/manual verification:
  - Cmd+K opens and backdrop click closes.
  - Project preference and saved views survive refresh.
  - Search for a project name updates the run rail count.
  - 500 selected runs render charts without freezing.

## Documentation Plan

- `apps/rust-server/README.md`: add dashboard preferences/workspace-view routes and usage-byte semantics.
- `apps/web/README.md`: document control-plane saved views, chart types, patch metric fetching, and localStorage fallback.
- This design doc records review notes and implementation decisions.

## Alternatives Considered

- Keep saved views in localStorage only. Rejected because it fails hosted cross-device and session continuity.
- Store saved views in the tenant/data plane. Rejected because views are user/control-plane state and should not depend on data-plane warehouse health.
- Build server-side downsampling now. Rejected for this slice because chunked bounded fetches are simpler and use the existing endpoint.
- Add many chart types immediately. Rejected because line, dot, bar, and histogram cover the first dashboard baseline without creating a half-finished editor. True x/y scatter remains a follow-up because it needs field-axis semantics.

## Research Notes

- W&B custom charts and plot docs list line, scatter, bar, histogram, multi-line, ROC, and PR helpers. The workspace scatter docs specifically frame scatter as a way to compare multiple runs.
- Grafana visualization docs treat time series, bar chart, histogram, table, and related panels as standard dashboard primitives.
- TensorBoard/PyTorch docs emphasize scalars over time plus histograms/images/graphs/embeddings for training inspection.

## Review Notes

Fresh reviewer 1:

- Finding: The slice was too broad, control routes were underspecified for split deployment, view persistence lacked append-only semantics, non-line panels could misuse bounded series points as latest values, list responses returned full payloads, shared-cell storage bytes could overcount, and transient error matching was too broad.
- Risk: Implementation could depend on tenant warehouse availability for control state, create request storms, undercount or overcount storage, or display misleading charts.
- Recommended edit: Narrow contracts, route preferences/views to control, document entity IDs/replay/auth, make list summary-only, derive non-line charts from run summaries, scope warehouse bytes, and enumerate transient strings.
- Decision: Accepted. The revised design now makes control-plane ownership explicit, caps metric chunk concurrency, uses summary latest values for non-line panels, keeps list payloads small, and scopes exact warehouse bytes.

Fresh reviewer 2:

- Finding: Control-plane persistence, metric chunk scheduling, graph type semantics, storage warning math, and workspace-view list payloads needed sharper constraints.
- Risk: The implementation could violate the split control/data architecture, regress performance, or mislabel a dot plot as true scatter.
- Recommended edit: Add service-plane route ownership and control record semantics, cap chunk concurrency, rename/defer scatter, add summary/detail view API, and include warehouse bytes correctly.
- Decision: Accepted. The design now implements line/bar/histogram/dot only, defers arbitrary x/y scatter, and keeps exact storage bytes to dedicated/local databases.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation of the revised first slice on 2026-05-17.
