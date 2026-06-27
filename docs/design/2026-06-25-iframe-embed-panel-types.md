# Design: Iframe Embed Panel Types

Date: 2026-06-25

Status: Accepted for implementation

Owner: Codex

## Summary

Iframe run embeds currently render only generated line charts. The next useful
slice should let the same read-only iframe show the summary panel types users
already expect from the Runs workspace: latest-value bar charts, dot plots,
latest-value histograms, scatter plots, and distributions, while keeping the
embed API bounded and short-lived.

The implementation should reuse the existing `workspace_view_data` response
where possible. Line panels continue to fetch bounded metric series. Summary
panels should render from the bounded run summaries already returned by that
same response, so this follow-up does not add new data routes, storage tables,
or object/rank fan-out.

## Goals

- Render line, bar, dot, scatter, distribution, and latest-value histogram
  panels inside `/embed/runs/:session_id`.
- Generate a mixed default embed board from the selected runs' highest-signal
  metric keys.
- Preserve iframe security: no dashboard mutation, no browser credentials, no
  local-storage API keys, no chart export/download actions, and no extra
  unbounded data fetches.
- Keep the API response bounded by the existing run, panel, metric point, and
  response-size limits.

## Non-Goals

- Logged histogram timeline panels. Those need bounded rich-object reads by
  histogram object key and primary run.
- Distributed/rank heatmaps. Those need rank-metric summary data and are scoped
  to a selected run rather than a run set.
- Export adapters for non-line charts. Embeds remain read-only and export-free
  in this slice.
- User-authored custom embed layouts. The server still generates the default
  v1 embed board from run IDs.

## Users and Use Cases

ML platform teams embed a selected run set in an internal report or review
portal. Viewers should be able to inspect both trends and cross-run summaries:
metric trajectories, latest-value rank/order, value spread, metric tradeoffs,
and grouped distributions without opening the full InstantML dashboard.

## Proposed Design

Backend:

- Extend the generated embed workspace view to emit a deterministic mix of
  panel types:
  - `line` for top metric trends.
  - `histogram` for latest-value spread.
  - `bar` and `dot` for latest-value per-run comparisons.
  - `scatter` for a preferred numeric experiment field versus metric best.
  - `distribution` for metric best grouped by a preferred categorical field.
- Continue using the top metric keys from `metric_series_for_runs_limited`,
  excluding internal `system/instantml/*` keys.
- Treat embed session options as caps. The effective values for
  `max_panels` and `metric_point_limit` must be
  `min(request option, session option, global cap)`, with defaults applied
  only when neither side provides a value.
- Fill panels in deterministic priority order until the effective panel cap is
  reached. Generated responses emit `histogram` for latest-value histograms.
- Update `workspace_view_data` summary-panel support to accept both
  dashboard-facing `histogram` and legacy `value_histogram`; the frontend
  treats both names as latest-value histograms.
- Extend `WorkspaceViewDataPanelResult` with optional panel-spec fields:
  `x_field`, `y_field`, `value_field`, `group_field`, and `replicate_field`.
  These fields are populated from camel-case view payload keys (`xField`,
  `yField`, `valueField`, `groupField`, `replicateField`) and are omitted when
  absent. Generated scatter panels set `xField` with the same default-field
  heuristic used by the dashboard when enough run summaries are available,
  falling back to `run:duration_seconds`; `yField` is `metric:<key>:best`.
  Generated distribution panels set `valueField` to `metric:<key>:best` and
  choose the best categorical field with 2-12 groups when available, otherwise
  use an ungrouped distribution.
- Regenerate OpenAPI and frontend API types after changing the response
  schema.

Frontend:

- Replace the embed page's line-only panel conversion with a panel renderer
  that branches on `panel.type`.
- Use `MetricChart` for line panels, preserving hover, smoothing, y-axis
  controls, and range zoom.
- Extract the dashboard's read-only SVG renderers for bar, dot, histogram,
  scatter, and distribution panels into a shared component module. Keep the
  Runs workspace drag/edit/fullscreen chrome in `workspace-panel-card.tsx`.
- Use existing helper functions from `src/dashboard-panels.js` for latest
  values, field defaults, scatter points, histogram bins, and distributions.
- Keep export actions disabled and do not add dashboard edit menus.
- Preserve generated panels even when they have no finite data. Show
  type-specific per-panel empty states, missing/capped counts, and panel
  warnings. Reserve the top-level "no panels" state for an empty server panel
  list.

Docs:

- Update iframe embed docs and READMEs to state which panel types render in
  embeds and which remain deferred.
- Keep screenshots token-safe. If the rendered board changes materially, update
  the docs screenshot through the local iframe QA flow.

## Component Impact

Backend:

- `apps/rust-server/src/store/embed.rs` generated view only.
- `apps/rust-server/src/store/workspace_views.rs` panel-type allowlist and
  optional panel-spec extraction.
- `apps/rust-server/src/domain.rs` `WorkspaceViewDataPanelResult` schema.

Frontend:

- `apps/web/app/embed/runs/[session_id]/embedded-runs-canvas.tsx`.
- Embed static tests for supported panel types and continued security
  constraints.

Python SDK:

- No change.

Storage:

- No change.

Docs:

- `apps/docs/api/iframe-embeds.mdx`.
- `apps/rust-server/README.md`.
- `apps/web/README.md`.

## Data Model

No new durable data. Existing `EmbedSessionOptions` and `EmbedSessionRow`
remain unchanged. `WorkspaceViewDataPanelResult` gains optional response fields
for panel specs:

- `x_field` and `y_field` for scatter.
- `value_field`, `group_field`, and `replicate_field` for distributions.

The stored/generated view payload remains dashboard-compatible camel case:
`xField`, `yField`, `valueField`, `groupField`, and `replicateField`.

## API Contracts

No new endpoints. `POST /api/embed/sessions/:session_id/runs/data` may now
return generated panels whose `type` is `bar`, `dot`, `histogram`, `scatter`,
or `distribution` in addition to `line`.

`WorkspaceViewDataPanelResult.data_kind` remains:

- `metric_series` for `line`.
- `metric_summary` for summary panels.

Canonical histogram behavior:

- Generated embed views emit `type: "histogram"`.
- `workspace_view_data` accepts `histogram` and legacy `value_histogram`.
- The embed frontend renders both names as the same latest-value histogram
  panel.

Scatter/distribution contract:

- `scatter` panels require `x_field` and `y_field` in the response to render a
  chart. Missing fields produce a per-panel unsupported/empty state, not a
  failed iframe.
- `distribution` panels require `value_field`; `group_field` and
  `replicate_field` are optional.

## Performance Considerations

Expected read shape stays the same:

- Up to 100 selected runs.
- Up to 8 generated panels.
- Up to 500 points per run/series, capped by the existing total-point guard.
- Summary panels reuse `summarize_runs_for_metric_keys`; they do not fetch
  metric history.

Latency target should stay equivalent to the current embed data route. The only
added client work is SVG layout over bounded run summaries.

## Simplicity Review

This is the smallest useful multi-panel slice because it reuses existing run
summaries and chart helpers instead of introducing custom layouts, new object
fetches, or rank-metric APIs. Logged histogram timelines, rank heatmaps, and
exports are intentionally deferred until each has a bounded backend contract.

## Failure Modes

- No finite latest metric values: show an empty summary-panel state.
- Only one metric key exists: generate as many safe panel variants as fit.
- Very small run set: scatter/distribution may be sparse but should render or
  explain missing fields.
- Unsupported panel type from a future/stale payload: show a clear unsupported
  panel state instead of failing the whole iframe.
- Narrow iframe: no horizontal page overflow at 320 px width. Cards may stack,
  chart height clamps between 220 px and 320 px, legends wrap within the card,
  and long axis labels/titles truncate with full values available in SVG/title
  text.

## Testing Plan

- Rust unit tests for generated embed panel mix, min-of-limits option handling,
  optional panel-spec extraction, and `histogram`/`value_histogram`
  summary-panel support.
- Frontend Node tests that the embed canvas renders non-line panel branches and
  still keeps token/export/storage restrictions.
- Existing embed token and iframe route tests.
- `cargo check`, focused Rust embed/workspace tests, `npm run web:build`,
  `npm run verify:api-types`, docs checks, and `git diff --check`.
- Rendered local iframe QA with a temporary parent site, including at least one
  summary panel visible in the iframe, 320 px responsive checks, and a pass that
  confirms no export controls render.

## Documentation Plan

- Update `apps/docs/api/iframe-embeds.mdx`.
- Update `apps/rust-server/README.md` and `apps/web/README.md`.
- Add this design doc to `docs/design/README.md`.

## Alternatives Considered

- Add custom embed layouts now: rejected because it expands the API contract
  before the generated board proves useful.
- Add logged histogram timelines now: rejected because rich-object reads need
  separate object-key caps and primary-run semantics.
- Add rank heatmaps now: rejected because the distributed/rank API is scoped to
  a single run and should be designed separately for embeds.

## Review Notes

Fresh reviewer 1:

- Finding: scatter/distribution need explicit fields in
  `WorkspaceViewDataPanelResult`; otherwise the backend drops the chart spec.
- Risk: generated panels would appear supported by type but fail or guess on
  the frontend.
- Recommended edit: add optional `x_field`, `y_field`, `value_field`,
  `group_field`, and `replicate_field` to the response contract, regenerate API
  types, and test extraction.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: current embed option handling lets request options widen stored
  session caps, and histogram naming needs canonical compatibility.
- Risk: embed bearers can pull more data than intended; stale/custom payloads
  may treat `histogram` and `value_histogram` inconsistently.
- Recommended edit: apply effective limits as `min(request, session, global
  cap)` and accept both histogram names while emitting `histogram` from
  generated embeds.
- Decision: Accepted.

Frontend review:

- Finding: the visual renderers are embedded in the dashboard card, and empty
  line-only filtering would drop generated panels.
- Risk: duplicated chart behavior and confusing "no panels" states when only
  one chart lacks data.
- Recommended edit: extract shared read-only chart components and preserve
  per-panel empty/unsupported states.
- Decision: Accepted.

## Coverage Exceptions

None planned.

## Decision

Proceed with implementation after incorporating the fresh-agent review edits
above.
