# Design: GPU & System Usage Insights

Date: 2026-06-18

Status: Accepted

Owner: Codex

## Summary

InstantML should help teams understand how training runs are using GPUs without introducing tracked-hour billing. This design adds a GPU & System view inside Insights that summarizes observed GPU telemetry by employee, project, GPU model, and run over a bounded time window.

The first shipped slice uses existing SDK system metric keys and run metadata. It returns estimates with coverage and attribution confidence instead of claiming invoice-grade cost accounting.

## Goals

- Show observed GPU hours, utilization-weighted GPU hours, low-utilization time, memory pressure, energy when power is logged, and telemetry coverage.
- Let owner/admin users filter and group by time window, employee attribution label, project, GPU model, and coverage threshold.
- Keep reads bounded and summary-only so the frontend never fetches raw metric history for this dashboard.

## Non-Goals

- No tracked-hour billing, invoice reconciliation, cloud bill import, scheduler allocation, or fleet-idle accounting in v1.
- No new SDK public API is required for the first slice.
- No persisted saved usage reports in this change.

## Users and Use Cases

ML leads and platform engineers use this view to answer:

- Which employees or projects are consuming the most observed GPU time?
- Which runs show low GPU utilization, failed-run GPU time, or missing telemetry?
- Is a low-usage number believable, or is telemetry coverage incomplete?

## Proposed Design

Add `GET /api/insights/system-usage` on the Rust data plane. The endpoint requires an owner/admin browser session or an org-scoped API key with `usage:read`, accepts a maximum 31-day window, and aggregates existing metric points for GPU/system keys using `logged_at` only after the visible run set is scoped by organization, API-key project restrictions, and request filters. The response includes summary KPIs, grouped rows, top runs, attention cards, filter options, and coverage metadata.

Add a reusable frontend pane inside `/dashboard/insights`:

- `InsightsTabPane` becomes a local two-view shell: `GPU & System` and `Run Analysis`.
- `SystemUsageInsightsPane` owns filters, fetch lifecycle, loading/error/empty states, and layout.
- Smaller components render KPI strip, scope controls, attention cards, coverage, grouped breakdown, and top runs.

Copy uses “observed”, “estimated”, “logged”, and “coverage” language. It avoids “billable”, “actual cost”, and “waste” unless qualified.

## Component Impact

Backend:

- New data-plane route and OpenAPI schema.
- New ClickHouse aggregate query over `metric_points`, bounded by period and result limit.

Frontend:

- New Insights subview and reusable GPU usage components.
- Existing run-analysis Insights stays available and keeps its current behavior.

Python SDK:

- No change. The view consumes current `system/gpu/{index}/...` metrics and also supports legacy demo `gpu/{index}/...` keys.

Storage:

- No new table in this slice. Future high-scale work should add daily rollups before expanding beyond 31-day windows.

Docs:

- Update web and Rust README notes with the new route/view.

## Data Model

No persisted data model changes. Runtime attribution comes from run metadata fields such as `owner`, `owner_email`, `user`, `user_email`, `created_by`, or `created_by_email`; otherwise rows are grouped under `Unknown` with low confidence. Email-like metadata is masked before it is returned because v1 attribution is a label, not a trusted identity join.

## API Contracts

`GET /api/insights/system-usage`

Query:

- `family=gpu|system`, default `gpu`
- `range=7d|14d|30d`, default `14d`
- `start` / `end` RFC3339 timestamps, capped to 31 days
- `group_by=actor|project|gpu_model|run`, default `actor`
- `project`, `actor`, `gpu_model`, `min_coverage_pct`, `limit`

Response:

- `summary`: observed/utilized/low-util GPU hours, average utilization, memory pressure, energy, sample count, coverage, utilization buckets
- `coverage`: runs in scope, runs with/missing GPU metrics, sample count, truncation, low-confidence attribution count
- `groups`, `top_runs`, `attention`, `available_filters`, `notes`
- `is_invoice_grade=false`

## Performance Considerations

- Expected read: one bounded aggregate query over `metric_points` for system/GPU keys in the selected org, period, and visible run ID set.
- Window cap: 31 days.
- Run-scope cap: 5,000 visible runs before the aggregate query; users must narrow the time/project filter above that.
- Aggregate row cap: 50,000 run/key rows.
- Frontend table cap: 100 grouped rows and 50 top runs by default.
- Latency target: comparable to other summary endpoints for normal dashboard windows.
- Future scale path: add `system_metric_rollups_daily` when customers need longer windows or larger org-wide usage reporting.

## Simplicity Review

This is the smallest end-to-end version that is useful: existing telemetry in, summary endpoint out, UI with coverage and warnings. It avoids scheduler/cloud integrations and durable rollups until usage proves the need.

## Failure Modes

- Missing GPU telemetry shows an empty state and explains how to enable system metrics.
- Partial telemetry shows coverage badges and warning copy.
- Query errors show an accessible retry banner.
- Ambiguous attribution is labeled low-confidence instead of mapped to a user incorrectly.
- Aggregate truncation is disclosed in the coverage panel.

## Testing Plan

- Rust tests cover GPU key parsing, window bounding, and attribution fallback.
- Web tests cover query defaults, payload normalization, empty-state classification, attention sorting, formatting, and source-level accessibility contracts.
- Run `npm run codegen:api`, targeted Node tests, Rust tests for touched code, and `npm run web:build`.
- Use Computer Use/browser QA to verify the Insights view loads, filters collapse responsively, and no major visual/a11y nits are visible.

## Documentation Plan

- Update `apps/rust-server/README.md` with the new endpoint.
- Update `apps/web/README.md` with the new Insights subview.

## Alternatives Considered

- Frontend-only derivation from run summaries: rejected because GPU hours need logged timestamps and sample coverage.
- New daily rollup table now: deferred because the first slice can stay bounded to 31 days and raw aggregate reads are simpler.
- Billing/cost dashboard: rejected because product strategy explicitly avoids tracked-hour billing in v1.

## Review Notes

Fresh reviewer 1:

- Finding: Employee usage can be mistaken for billing.
- Risk: Users over-trust directional estimates.
- Recommended edit: Put coverage and “not invoice-grade” language in API and UI.
- Decision: Accepted.

Fresh reviewer 2:

- Finding: Average utilization hides stalls.
- Risk: Low-utilization periods disappear in aggregate means.
- Recommended edit: Add utilization buckets and attention cards.
- Decision: Accepted.

Fresh reviewer 3:

- Finding: Attribution needs confidence.
- Risk: Metadata-only owner fields can be wrong.
- Recommended edit: Include `actor_source` and `actor_confidence`.
- Decision: Accepted.

Fresh reviewer 4:

- Finding: Long windows over raw metrics can become expensive.
- Risk: Org-wide usage queries may compete with chart reads.
- Recommended edit: Cap v1 windows and document daily rollups as the scale path.
- Decision: Accepted.

## Decision

Accepted for implementation as a narrow MVP.
