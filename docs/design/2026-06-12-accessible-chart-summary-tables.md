# Design: Accessible Chart Summary Tables

Date: 2026-06-12

Status: Accepted localized UI slice

Owner: Codex

## Summary

Metric charts should remain the default visual surface, but every line chart
needs a keyboard- and screen-reader-friendly way to read the same comparison
without interpreting paths, colors, or hover geometry. The smallest useful
version adds a per-chart `Chart / Summary table` switch to the existing shared
`MetricChart` component.

The table is generated from the already plotted series, including current zoom,
sampling, smoothing state, and grouping. No new endpoint or raw metric fan-out is
introduced.

## Goals

- Let screen-reader users switch a chart to a structured summary table.
- Surface final value, best value, best step, change, rank, trend, and data
  notes per plotted series.
- Reuse the shared chart data path so Metrics, Run Detail, and Runs workspace
  line panels behave consistently.

## Non-Goals

- No global accessibility preference in this slice.
- No LLM-generated narrative.
- No raw point table for every metric point.
- No backend, SDK, storage, or API changes.

## Users and Use Cases

Blind and low-vision users can navigate to a metric chart, activate `Summary
table`, and hear a concise comparison through their screen reader. Sighted users
also benefit when many runs overlap visually and exact final/best values are
faster to scan in rows.

## Proposed Design

Add a segmented button group inside each chart action area:

- `Chart`
- `Summary table`

The selected button uses `aria-pressed`. Switching to the table replaces the SVG
chart with a visible text takeaway and a real HTML table. The table uses
`<caption>`, `<thead>`, `<tbody>`, `<th scope="col">`, and `<th scope="row">`.

Rows are computed from `normalizedSeries`:

- first plotted value,
- final plotted value,
- goal-aware best value,
- best step,
- percent change from first to final,
- final-value rank,
- overall trend,
- plotted point count,
- notes such as aggregate or smoothed.

Metric direction reuses the existing `metricGoal` heuristic.

## Component Impact

Backend:

- None.

Frontend:

- `apps/web/src/charts.js`: deterministic chart summary helpers.
- `apps/web/app/dashboard/metrics/metric-chart.tsx`: view toggle and table.
- `apps/web/app/styles/charts.css`: compact table and toggle styles.

Python SDK:

- None.

Storage:

- None.

Docs:

- This design doc records the localized chart accessibility slice.

## Data Model

No data model changes.

## API Contracts

No API contract changes.

## Performance Considerations

Summary rows are computed from the plotted series already in memory. The work is
O(plotted points), matching existing chart render inputs, and does not request
raw unsampled history. The table stays bounded by the same selected-run and
plotted-series caps as the chart.

## Simplicity Review

The simplest useful version is a per-chart toggle in the shared component. A
global default view, raw data table, CSV enhancements, and authored narrative
quality controls are deferred until there is evidence that users need them.

## Failure Modes

- Empty series keep the existing chart empty state.
- Missing or non-finite values are omitted from summary calculations.
- Percent change is blank when the first value is zero.
- Dense charts remain dense charts; the table does not alter data fetching.

## Testing Plan

- Add Node tests for summary rows and deterministic takeaway text.
- Run the targeted frontend helper test.
- Run the existing chart export/helper test to catch regressions.

## Documentation Plan

The existing web README already documents chart responsibilities and does not
need command or API updates for this localized UI change.

## Alternatives Considered

- Global setting only: rejected because users need the control next to the chart
  they are trying to understand.
- Raw point table only: rejected because thousands of points are hard to hear and
  duplicate CSV export.
- LLM takeaway first: rejected because chart facts must be deterministic and
  auditable.

## Review Notes

Not required for this localized UI slice because it preserves existing API
contracts, routes, data dependencies, and dashboard state shape.

## Coverage Exceptions

None.

## Decision

Accepted for the first accessible chart summary-table slice.
