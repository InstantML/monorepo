# Design: Exporting Data

Date: 2026-05-31

Status: Accepted for bounded first slice after review

Owner: Codex

## Summary

InstantML already has a trust-oriented JSON export route at `GET /api/export`.
It is useful for machine-readable migration and backup workflows, but it is not
yet visible from the dashboard and it does not support two daily workflows that
users expect from experiment trackers:

- Export the runs they selected in the UI as CSV without rebuilding a query by
  hand.
- Export an individual chart's plotted data and visual evidence directly from
  the graph, similar to Trackio's per-plot download buttons.

This design keeps the existing JSON route backward-compatible and adds a narrow
first slice:

1. Add URL-safe `run_ids` selection support to `GET /api/export` while
   preserving the existing filter-based export behavior.
2. Add `format=csv` to the same route. JSON remains the default response.
3. Add a dashboard "Export data CSV" action that downloads the selected runs
   through the server route.
4. Add opt-in per-chart export controls that download chart data as CSV and a
   static chart image generated from the plotted series.

The broader roadmap should make exportability a product advantage, not only a
backup feature: async full-project exports, artifact byte bundles, Parquet,
Python SDK query/export helpers, report/PDF export, scheduled exports,
warehouse-native BYOC exports, and audit-visible export events.

## Research Notes

Trackio:

- Trackio stores local projects in SQLite and documents direct SQL plus Parquet
  exports for static Spaces and dataset exports. Sources:
  [Trackio storage schema](https://huggingface.co/docs/trackio/storage_schema),
  [Trackio CLI commands](https://huggingface.co/docs/trackio/cli_commands).
- Trackio's current line and bar plot Svelte components expose per-plot
  download buttons. The line plot filters original data rows, serializes CSV in
  the browser, and also calls Vega's `view.toImageURL("png", 4)` for PNG image
  export. Source file:
  [LinePlot.svelte](https://github.com/gradio-app/trackio/blob/main/trackio/frontend/src/components/LinePlot.svelte).
- Trackio's changelog also records a line-plot JSON export feature, but the
  current implementation is CSV plus PNG. Source:
  [Trackio changelog](https://github.com/gradio-app/trackio/blob/main/trackio/CHANGELOG.md).

Weights & Biases:

- W&B's public API exposes run config, metadata, summary metrics, sampled
  history, unsampled history, files, logged artifacts, and history export
  download helpers. Source:
  [W&B Run public API](https://docs.wandb.ai/models/ref/python/public-api/run).
- W&B reports can be exported as LaTeX zip files, and report panels/workspaces
  emphasize reusable visual evidence. Source:
  [W&B reports docs](https://docs.wandb.ai/guides/reports/).
- W&B tables and runs are built around tabular inspection, filters, and API
  retrieval. Source:
  [W&B customize run display](https://docs.wandb.ai/models/runs/customize-run-display).

Neptune:

- Neptune 3.x emphasizes flexible metadata, data frames, and querying tracked
  metadata through its Python API. Sources:
  [Neptune query docs](https://docs.neptune.ai/query/),
  [Neptune fetch metadata docs](https://docs.neptune.ai/fetch_metadata/).
- Neptune's Exporter flow uses local files and a documented exporter shape for
  migration and analysis workflows. Source:
  [Neptune Exporter](https://docs-legacy.neptune.ai/api/neptune_exporter/).
- Neptune reports and dashboards can be shared, downloaded, or used as static
  experiment evidence. Sources:
  [Neptune reports docs](https://docs.neptune.ai/reports/),
  [Neptune dashboards docs](https://docs.neptune.ai/dashboards/).

Competitor feature list InstantML lacks or only partially supports:

- UI run CSV export for selected runs.
- UI chart CSV export for the plotted graph.
- UI chart image export for a single graph.
- Stable, documented export schemas for JSON and CSV.
- Async project/workspace export jobs for exports larger than route limits.
- Multi-file export bundles: `runs.csv`, `metrics.csv`, `attributes.csv`,
  `artifacts.csv`, `table_rows.csv`, `manifest.json`.
- Artifact byte export bundles with checksums and defensive MIME handling.
- Parquet exports for metric-heavy analysis and BYOC warehouse users.
- Python SDK export helpers, including paginated run history scans.
- CLI export command matching the import CLIs.
- Report export beyond current Markdown, such as static HTML/PDF/PNG evidence.
- Saved chart/report export metadata so a downloaded graph is reproducible.
- Scheduled recurring exports to external storage.
- Audit events for hosted export downloads.
- Export rate limits and size preflight estimates.

## Goals

- Preserve `GET /api/export` JSON as the default route and response shape.
- Let callers export exactly selected runs through `run_ids` or `runs` query
  parameters within a URL-safe GET cap.
- Add a CSV representation that can carry selected runs, metric points,
  metric-series summaries, attributes, artifacts, table rows, imports,
  projects, and organization metadata without inventing many new endpoints.
- Add an obvious dashboard raw-data CSV export action for selected runs.
- Add opt-in per-chart export controls for chart CSV and chart image downloads.
- Keep the first slice synchronous and bounded by row, URL, and byte limits.
- Document the bigger export roadmap without implementing async jobs yet.

## Non-Goals

- Do not add a new database table or async export-job queue in this first
  slice.
- Do not stream unbounded metric history in the first slice.
- Do not download artifact bytes into the CSV export.
- Do not add W&B/Neptune account integrations or OAuth.
- Do not add SDK public APIs in the first slice.
- Do not change existing import routes.
- Do not add broad new product surface to the deprecated Node server. Minimal
  `/api/export?format=csv&run_ids=...` compatibility is allowed so legacy local
  fallback does not silently return JSON for the same route.

## Users and Use Cases

Researchers:

- Select the runs they are comparing, download a CSV, and inspect it in a
  notebook or spreadsheet.
- Download a chart's plotted data to reproduce a figure.
- Download a static chart image for a lab note, PR, issue, or report.

ML platform owners:

- Confirm that a team can leave InstantML with understandable data formats.
- Use `GET /api/export` with API keys that have `export:read`.
- Preserve compatibility with current JSON backup/import tooling.

Operators:

- Keep hosted exports bounded and scoped by org and API key.
- Avoid export paths that bypass auth, project restrictions, or tenant routing.

## Proposed Design

### First Slice

Backend:

- Extend `GET /api/export` with optional query params:
  - `run_ids=<uuid>,<uuid>` or `runs=<uuid>,<uuid>`: select exact runs.
  - `format=json|csv`: default `json`.
- Keep exact selected-run exports over `GET` URL-safe:
  - `MAX_EXPORT_SELECTED_RUN_IDS = 100`.
  - `run_ids` and `runs` are aliases; `run_ids` wins when both are present.
  - Dedupe repeated IDs while preserving first occurrence order.
  - Reject more than 100 exact IDs with `400`; do not silently export only a
    prefix.
- If `run_ids` is present, fetch those runs directly, enforce org/project
  access for each run, preserve the requested order, and reject hidden runs as
  not found so selected export does not leak existence across org or
  project-scoped API-key boundaries.
- If `run_ids` is absent, keep current filter behavior:
  `project`, `status`, `q`, `sort_by`, `metric_key`, then truncate at
  `MAX_EXPORT_RUNS`.
- Generate the existing JSON payload first, then convert the payload to a
  normalized single CSV file when `format=csv`.
- CSV columns:
  - `record_type`
  - `org_id`
  - `project_id`
  - `run_id`
  - `run_name`
  - `run_status`
  - `artifact_id`
  - `attribute_id`
  - `key`
  - `path`
  - `step`
  - `value`
  - `logged_at`
  - `created_at`
  - `row_index`
  - `json`
- CSV `record_type` values:
  - `organization`
  - `project`
  - `run`
  - `metric`
  - `metric_series`
  - `attribute`
  - `artifact`
  - `table_object_row`
  - `import`
- The `json` column contains the full row for nested fields so the CSV remains
  loss-tolerant even when records have heterogeneous shapes.
- CSV scalar cell serialization:
  - Empty string for absent columns.
  - JSON serialization for non-scalar `value` and every `json` cell.
  - RFC 4180 quote escaping for commas, quotes, CR, and LF.
  - Prefix every scalar cell whose first non-space character is `=`, `+`, `-`,
    or `@`, or whose text begins with tab/CR/LF, with a single apostrophe.
    This applies to backend export CSV and chart CSV helpers.
- Exported artifact records must use public artifact rows only. Local/R2
  artifacts export `instantml://artifacts/<id>` public URIs; no storage keys,
  object paths, bucket names, signed URLs, or raw internal artifact URIs may be
  serialized. External `uri` values remain user-provided references.
- CSV responses use:
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="instantml-export.csv"`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: private, no-store`
  - `Pragma: no-cache`
  - `Content-Security-Policy: sandbox`
- Synchronous CSV export has `MAX_EXPORT_CSV_BYTES = 25 MiB`. If CSV
  serialization would exceed that cap, return `400` with a stable validation
  error that tells the user to narrow the selection or wait for async exports.
- Add `MAX_EXPORT_METRIC_SERIES = 25_000`. Export at most that many
  metric-series summary rows and include metric-series truncation in
  `limits`/`truncated` accounting.
- Emit one sanitized structured export event for success or failure with actor
  kind, org_id, project restriction presence, format, selected-vs-filter scope,
  run count, truncation, and response size when available. Do not log raw CSV,
  raw query strings, run names, metric keys, artifact URIs, table values, or
  `q` text.

Frontend:

- Add "Export data CSV" to the Runs command bar.
- The button remains reachable when no runs are selected so it can announce the
  reason in the dashboard status region.
- The button calls `/api/export?format=csv&run_ids=<selected ids>` when the
  current selection is valid.
- If more than `MAX_EXPORT_SELECTED_RUN_IDS` are selected, the action announces
  the count/cap message. The UI must not export only the first subset without
  explicit user action.
- The browser uses fetch-to-Blob behavior, tracks busy state, prevents duplicate
  clicks, parses non-2xx JSON errors into the existing dashboard status
  message, revokes object URLs after download, and uses stable filenames such as
  `instantml-selected-runs.csv`.
- The first dashboard action downloads raw selected-run data because the user
  request is "selected runs and all their data." A future adjacent action should
  add one-row-per-run table CSV for spreadsheet-first workflows.
- Add opt-in per-chart buttons through a `MetricChart` export prop/action slot,
  not as default chrome for every chart reuse site:
  - Download plotted data as CSV.
  - Download chart image.
- The chart CSV is generated from the already plotted series, including
  `run_id`, display name, group, metric key, step, value, created_at, and
  smoothed value when present.
- The chart CSV is labeled as plotted data; if the chart endpoint returned M4
  or another bounded sample, the export is the plotted sample, not unsampled
  history.
- The chart image is generated client-side from the same visible plotted/zoomed
  series with a solid background and resolved colors. It should not make a new
  API request or fetch unbounded data.
- Chart exports are disabled above a client budget of 120 series or 20,000
  plotted points to avoid main-thread jank.

### Future Roadmap

Add an export drawer before implementing unbounded export jobs:

- Preflight selected/export scope:
  - selected runs count
  - metric point estimate
  - artifact reference count
  - artifact byte estimate
  - expected files and formats
- Formats:
  - JSON archive
  - CSV bundle
  - Parquet bundle
  - artifact byte bundle
- Scope:
  - selected runs
  - current search filter
  - entire project
  - entire organization
- Export modes:
  - synchronous bounded route for small exports
  - async export job for large history
  - direct BYOC ClickHouse SQL/Parquet recipe where the customer owns storage

Async job design should be a later design doc because it needs stored job
state, object storage writes, expiration, cancellation, audit events, and
rate/usage policy.

## Component Impact

Backend:

- `apps/rust-server/src/store/export.rs`: selected-run export and CSV payload
  serialization, CSV injection mitigation, byte caps, and metric-series caps.
- `apps/rust-server/src/http/handlers/usage.rs`: response negotiation between
  JSON and CSV.
- `apps/rust-server/src/http/openapi.rs` and generated OpenAPI output through
  `npm run codegen:api`. The handler returns `Response`; OpenAPI documents
  `format`, `run_ids`, `runs`, and both `application/json` and `text/csv`
  response content.
- `apps/server`: implement minimal deprecated Node compatibility for
  `format=csv` and `run_ids` so UI/dev fallback does not silently receive JSON
  from the same route.

Frontend:

- `apps/web/app/dashboard/runs/runs-commandbar.tsx`: selected-run CSV button.
- `apps/web/app/dashboard/runs/tab-pane.tsx`: pass export props.
- `apps/web/app/dashboard/dashboard-shell.tsx`: perform the CSV download.
- `apps/web/app/dashboard/metrics/metric-chart.tsx`: opt-in per-chart export controls.
- `apps/web/src/chart-export.js`: pure helpers for chart CSV/image export.
- CSS in the nearest chart/runs stylesheets.

Python SDK:

- No first-slice public API change.
- Future follow-up: add `Client.export_runs(...)`, paginated history helpers,
  and CLI wrappers after route semantics settle.

Storage:

- No schema change.
- No new ClickHouse indexes. The first slice reuses existing bounded export
  queries.

Docs:

- Update `apps/rust-server/README.md`.
- Update `apps/web/README.md`.
- Add this design doc to `docs/design/README.md`.
- Optionally update public docs after the UX stabilizes.

## Data Model

No durable data model changes in the first slice.

The new CSV file is a versioned representation of the existing JSON export
payload, not a stored entity. The CSV is normalized by `record_type` and keeps
the original row JSON for fields that do not fit into scalar columns.

Future async exports would need durable records such as:

```text
export_jobs:
  id
  org_id
  requested_by_user_id
  requested_by_service_account_id
  scope_kind
  scope_query
  formats
  state
  object_uri
  size_bytes
  checksum_sha256
  expires_at
  created_at
  updated_at
```

That table is explicitly deferred.

## API Contracts

Existing JSON:

```http
GET /api/export?project=demo&q=tag:baseline
Accept: application/json
```

Response remains the existing versioned JSON payload.

Selected JSON:

```http
GET /api/export?run_ids=<uuid>,<uuid>
```

CSV:

```http
GET /api/export?format=csv&run_ids=<uuid>,<uuid>
```

Responses:

- `200 text/csv; charset=utf-8` for CSV.
- `200 application/json` for JSON.
- `400` for invalid `format`, invalid run IDs, too many selected run IDs, or
  invalid search syntax.
- `401` for missing auth where auth is required.
- `403` for missing `export:read`.
- `404` if a selected run is not visible to the caller.

Backward compatibility rules:

- `format` is optional and defaults to JSON.
- Current query filters continue to work.
- Existing JSON keys and limits remain intact.
- `metric_key` remains relevant only for filter/sort behavior, not CSV column
  selection.
- API keys still require `export:read`; browser sessions use existing role to
  scope checks.
- Demo browser sessions and demo API keys may export only demo-visible data.
  Export paths do not create keys, mutate runs, or bypass read-only demo
  controls.

OpenAPI/codegen:

- The Rust handler must be annotated with all new query parameters.
- `200` must document both `application/json` and `text/csv`.
- Run `npm run codegen:api` and commit generated
  `apps/rust-server/openapi.generated.json` and
  `apps/web/src/types/api.generated.ts`.

## Performance Considerations

First-slice bounds:

- Runs: `MAX_EXPORT_RUNS = 500`.
- Exact selected run IDs over GET: `MAX_EXPORT_SELECTED_RUN_IDS = 100`.
- Metric points: `MAX_EXPORT_METRICS = 100_000`.
- Metric-series summaries: `MAX_EXPORT_METRIC_SERIES = 25_000`.
- Attributes: `MAX_EXPORT_ATTRIBUTES = 25_000`.
- Artifacts: `MAX_EXPORT_ARTIFACTS = 10_000`.
- Table rows: `MAX_EXPORT_TABLE_OBJECT_ROWS = 25_000`.
- CSV bytes: `MAX_EXPORT_CSV_BYTES = 25 MiB`.

Expected query shape:

- Selected-run export avoids scanning all runs and fetches operational rows by
  IDs from the in-process index.
- Metric points still use one bounded ClickHouse query filtered by
  `org_id` and `run_id IN ?`.
- Metric point truncation is currently global across selected runs, matching
  the existing route. This means one very large run can consume the sync metric
  point budget. The response's `truncated` flag must stay truthful; fair
  per-run metric allocation is deferred to async export or a future route
  change.
- Metric-series summaries use the new explicit metric-series cap.
- Chart CSV/image export is client-side and uses data already loaded for the
  chart.

Latency target:

- Selected-run CSV for <= 100 runs should feel like a normal route download.
- The route may be slower near the current metric limit, but it should stay
  bounded by existing ClickHouse query limits and request timeout.

Memory concerns:

- The first slice builds JSON then CSV in memory. This is acceptable only
  because the route is bounded by rows and CSV bytes.
- Async/streaming export jobs are required before raising limits or exporting
  artifact bytes.

Async export must be triggered instead of sync export when:

- selected run count exceeds the GET cap,
- estimated or actual response bytes exceed the sync cap,
- metric/table/artifact/metric-series limits would truncate data,
- artifact bytes are requested,
- the route would need POST/body-based selection,
- or preflight predicts route timeout risk.

No new indexes are needed because selected export reads are either in-process
operational maps or existing metric table filters.

## Simplicity Review

The simplest useful version is one route extension and client-side chart
downloads:

- No new endpoint family.
- No export-job storage.
- No object-store write path.
- No third-party dependency.
- No SDK API churn before the route is proven.
- No change to the importers.

Deferred complexity:

- Large async exports.
- Multi-file CSV/Parquet archive.
- Artifact byte bundles.
- Scheduled exports.
- Durable export audit records beyond the first-slice sanitized workflow log.
- SDK and CLI wrappers.
- One-row-per-run table CSV for spreadsheet-first dashboard workflows.

## Failure Modes

- Invalid `format`: return `400`.
- Invalid selected run ID: return `400`.
- Selected run not visible to caller: return `404`.
- Too many selected runs: return `400` explaining the current cap.
- CSV response too large: return `400` explaining the sync export byte cap.
- ClickHouse unavailable for metric reads: return existing warehouse error.
- Browser download blocked or cancelled: keep dashboard state unchanged and
  show a status message.
- Chart has no plotted data: disable or no-op chart export buttons.
- Chart image generation fails: chart CSV still works and the UI reports the
  image failure through the browser console/status message.

## Testing Plan

Backend unit tests:

- CSV cell escaping covers commas, quotes, CR/LF, nulls, and formula-like cells.
- CSV payload conversion emits header and expected `record_type` rows.
- Selected-run ID parsing remains comma-trimmed and rejects invalid values
  through existing parser tests.
- JSON default shape unchanged, explicit `format=json`, invalid `format`,
  CSV headers and security headers, exact selected-run order, `run_ids`
  precedence over `runs`, too many IDs, public artifact row redaction,
  metric-series truncation, and no-store headers.

Backend API tests or smokes:

- Existing JSON export route still returns JSON.
- `format=csv` returns CSV headers.
- `run_ids` selects exact runs and preserves org scoping.
- Project-scoped API keys cannot export other-project selected runs.
- Cross-org selected runs are not visible.
- Deprecated Node compatibility route handles `format=csv` and `run_ids`.

Frontend unit tests:

- Chart CSV helper serializes plotted series with proper escaping.
- Chart image/SVG helper creates a static representation without needing the
  DOM.
- Runs command bar renders reachable no-selection and cap messaging, then
  exports normally with selected runs.
- Cap messaging, busy state, download error parsing, object URL cleanup, and
  filenames are covered.

Manual/browser verification:

- Select runs in the Runs rail and download CSV.
- Download CSV and image from the main Metrics chart and a workspace panel.
- Verify no text overlap in the added controls at desktop and mobile widths.
- Playwright pass at desktop, tablet, and phone widths for the Runs command bar
  and chart export controls.

## Documentation Plan

- `apps/rust-server/README.md`: document `format=csv` and selected `run_ids`
  on `/api/export`.
- `apps/web/README.md`: document selected-run CSV and per-chart downloads.
- `docs/design/README.md`: add this design.

## Alternatives Considered

Separate `/api/export/csv` endpoint:

- Rejected for first slice because it duplicates auth/filtering and creates a
  second export contract. `format=csv` preserves one route.

CSV bundle zip:

- Better long term for clean `runs.csv`, `metrics.csv`, and `artifacts.csv`
  files, but it requires archive generation, response streaming, and stronger
  UX. Deferred to async export jobs.

Parquet first:

- Strong for metric-heavy analysis and Trackio parity, but it adds dependency
  and packaging questions. CSV is lower-friction for the immediate request.

Server-rendered chart image:

- Rejected for first slice because chart exports already have loaded series in
  the browser. Server rendering would add headless browser or image libraries
  and another data-fetch path.

Unbounded history export:

- Rejected for first slice because it violates current performance guidance.
  It needs an async job design and object-storage output.

## Review Notes

Fresh reviewer 1:

- Finding: Dashboard CSV should be explicit about raw data versus one-row
  spreadsheet summaries; over-cap behavior must not silently truncate; chart
  export controls should be opt-in per chart surface; download state/error and
  mobile placement need concrete UX.
- Risk: Users could receive a confusing raw CSV, a partial selection, or chart
  controls in report/detail contexts where they do not fit.
- Recommended edit: Label the button "Export data CSV", block over-cap
  exports, use opt-in chart export props, fetch blobs with busy/error handling,
  and cover responsive behavior.
- Decision: Accepted. First slice implements raw selected-run data CSV because
  the user requested all selected-run data; one-row run table CSV is documented
  as a follow-up.

Fresh reviewer 2:

- Finding: `run_ids` over GET can exceed URL limits, Node compatibility would
  silently return JSON, OpenAPI needs multi-content response docs, selected-run
  invisibility should be consistent, CSV formula protection needs exact rules,
  and tests need sharper backend coverage.
- Risk: Broken downloads through proxies, compatibility drift, generated type
  drift, existence leaks, and unsafe spreadsheet cells.
- Recommended edit: Cap exact GET IDs near 100, implement minimal Node parity
  or make a clear Rust-only break, return `Response` with OpenAPI content
  variants, map hidden selected runs to not found, define CSV serialization,
  and add route/header/access tests.
- Decision: Accepted. First slice caps exact GET IDs at 100 and includes
  minimal Node parity.

Fresh reviewer 3:

- Finding: CSV injection mitigation, selected-run metadata scoping, artifact
  URI redaction, sensitive download headers, minimal audit/observability, and
  demo/read-only tests were under-specified.
- Risk: Spreadsheet formula execution, cross-tenant leakage, internal object
  path leakage, cache persistence of sensitive exports, and invisible hosted
  data egress.
- Recommended edit: Prefix unsafe CSV cells, restrict org/project/import data
  to visible selected runs, use public artifact schemas, add no-store/sandbox
  headers, emit sanitized export events, and cover demo behavior.
- Decision: Accepted.

Fresh reviewer 4:

- Finding: Row caps alone do not bound sync CSV memory, metric-series summaries
  are uncapped, GET selection should be tighter, metric truncation fairness
  needs documentation, chart export CPU needs a budget, and async boundaries
  should be concrete.
- Risk: Large nested JSON rows can exceed memory, one large run can starve
  selected metrics, and browser image/CSV generation can jank the dashboard.
- Recommended edit: Add CSV byte cap, add `MAX_EXPORT_METRIC_SERIES`, cap GET
  selections, document global metric truncation, disable chart export above a
  plotted point/series budget, and list async triggers.
- Decision: Accepted except fair per-run metric allocation, which is deferred
  and documented because changing metric truncation semantics is broader than
  the first slice.

Post-implementation senior review:

- Security review finding: The Rust `GET /api/export` route needed central
  `export:read` enforcement for browser sessions as well as API keys; export
  observability should not log raw actor IDs; Node compatibility needed public
  artifact URI redaction and stronger CSV formula neutralization.
- Security resolution: `require_scope` now gates the handler, export events log
  only a stable actor fingerprint, internal artifact paths are redacted in JSON
  and CSV, imported run IDs are scoped to exported runs, and both backend and
  chart CSV helpers neutralize formula-like values after control/whitespace/BOM
  padding.
- Backend review finding: OpenAPI drift, selected-run 404 behavior, invalid
  Node `run_ids`, and test coverage for compatibility routes were too thin.
- Backend resolution: OpenAPI documents `run_ids`, `runs`, `format`, CSV
  content, and selected-run `404`; generated clients were regenerated; invalid
  Node selected IDs return `400`; Rust and Node tests cover selected export,
  public artifact rows, and compatibility CSV.
- Performance review finding: Node CSV generation and Rust in-memory
  collection paths could allocate after caps; UI needed an explicit truncation
  signal and chart export caps needed to be enforced inside helper functions.
- Performance resolution: Rust uses limited collection helpers and selected-run
  table-row scans, Node writes CSV incrementally against the byte cap, CSV
  responses expose `X-InstantML-Export-Truncated`, and chart CSV/SVG helpers
  enforce the series/point caps internally.
- Frontend review finding: Chart export stats were recomputed on hover,
  disabled export buttons were hard to inspect, SVG output lacked a legend, and
  the initial `useMemo` placement introduced a hook-order regression when a
  chart moved from empty/loading to populated.
- Frontend resolution: Export blocked state is memoized before any early
  return, export buttons expose hidden reason text without blocking activation,
  SVG chart exports include a compact legend, malformed `filename*` headers
  fall back safely, and Chrome manual QA verified selected-run and chart export
  controls after the hook-order fix.

Final production-readiness walkthrough:

- Finding: Rust attribute exports could still include private local/R2 artifact
  URIs through media-object `value.uri` and nested metadata values.
- Resolution: Export now serializes attributes through an export-specific
  redaction pass that rewrites local/R2 artifact URIs to public
  `instantml://artifacts/{id}` references before JSON or CSV serialization.
- Finding: JSON export lacked the hardened download/cache headers already used
  for CSV, and Node compatibility needed the same truncation and download
  headers.
- Resolution: Rust and Node JSON/CSV exports now emit attachment,
  `private, no-store`, `nosniff`, `sandbox`, and
  `X-InstantML-Export-Truncated` headers.
- Finding: The selected-run CSV button bypassed `ApiClient`, mobile command-bar
  specificity could overflow, disabled-state messages were unreachable, and
  duplicated charts could reuse hidden help IDs.
- Resolution: Selected-run download now uses `ApiClient.download`, mobile CSS
  overrides the workspace command bar at equal specificity, the export handler
  always receives button activation so it can announce no-selection/cap
  messages, and chart help IDs use React `useId`.
- Finding: CSV formula protection did not explicitly protect cells starting
  with tab, carriage return, or newline, and grouped chart CSV put synthetic
  group labels in the `run_id` column.
- Resolution: Rust, Node, and chart CSV helpers prefix tab/CR/LF-leading cells;
  chart CSV now distinguishes `series_id`, `series_type`, `run_id`, and
  `source_count` so aggregate rows do not masquerade as runs.

## Coverage Exceptions

None planned.

## Decision

Accepted for the bounded first slice above. Implementation must stay within the
reviewed caps and must not add async export jobs or new storage state in this
branch.
