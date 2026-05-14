# Design: Metrics, Run Detail, And Compare Redesign

Date: 2026-05-11

Status: Implemented first slice after senior design review

Owner: Codex

## Summary

The Runs workspace now has a coherent dark neon-navy language, but the Metrics, Run Detail, and Compare tabs still feel like older utility panels. This redesign makes those three surfaces feel like one analysis suite:

- Metrics answers "Which signals matter right now?"
- Run Detail answers "What happened in this one run?"
- Compare answers "Which run should I trust, and why?"

The slice stays frontend-only. It reuses the existing Rust API, current data fetches, custom controls, chart components, and CSS tokens.

## Goals

- Make all three tabs visually align with the Runs workspace: compact, dark, low-radius, dense, and purposeful.
- Remove the clunky Compare control/editor stack and make row-oriented Compare the default daily workflow.
- Keep column matrix Compare available as a secondary explicit mode.
- Reduce nested-card feeling by using one page shell, one toolbar band, and clear content zones.
- Prevent overlap, clipped controls, and horizontal surprise in normal 1280px desktop usage.
- Preserve current keyboard/select behavior and saved-view fields.
- Keep hidden-tab fetch gating and bounded chart/compare requests.

## Non-Goals

- No new backend API.
- No new charting library or table/grid package.
- No hosted persisted layout changes.
- No new panel types.
- No visual rebrand beyond applying the existing dark/neon design language consistently.

## Shared Design System

Use a shared "analysis page" pattern:

- `analysis-page`: full tab surface with a single-column page flow.
- `analysis-header`: compact top band with title, intent, key count/status, and primary controls.
- `analysis-toolbar`: responsive control grid using existing custom selects and inputs.
- `analysis-kpi-row`: compact stat cards aligned to the same height.
- `analysis-layout`: main content grid with a primary canvas and optional side rail.
- `analysis-card`: one-level flat panel with consistent border, background, padding, and no nested decorative cards.

Visual rules:

- Use the current dark tokens and electric-blue accent.
- Use 8px or lower radii.
- Use a clear 12px spacing rhythm.
- Do not center large empty blocks in data-dense pages unless the state is genuinely empty.
- Every dense table/rail must have an obvious sticky header or bounded scroll container.
- Long run names truncate with title tooltips; values use tabular numerals.

## Metrics Tab Design

User story:

An ML researcher opens Metrics to choose a signal, understand coverage, inspect the curve, and pin related metrics for quick side-by-side monitoring.

Layout:

- Top `analysis-header`:
  - Title: `Metrics`
  - Intent text: selected metric, selected-run coverage, point count.
  - Inline chart controls: metric filter, metric, group, x-axis, smoothing, average, pin.
- Body:
  - Left rail: metric catalog, with active metric and pin controls.
  - Main canvas: large selected metric chart, full width of the central region.
  - Right insight rail: hover detail, leaderboard, and summary cards.
  - Pinned metrics: compact charts below the main chart in a responsive grid.

Behavior:

- Metric chart remains the hero; catalog and insight rail are supporting surfaces.
- Pinned charts share the same visual treatment as Runs workspace panels.
- At mobile width, catalog, chart, insight, and pinned charts stack.

## Run Detail Tab Design

User story:

An ML researcher opens Run Detail after selecting a run to inspect its current objective, tags/notes, timeline, source metadata, config, metrics, and artifacts without jumping between tabs.

Layout:

- Top `analysis-header`:
  - Run name, status pill, project, selected-run count.
  - Tags and notes editor presented as a compact annotation panel rather than a full-width heavy block.
- KPI row:
  - Latest selected metric.
  - Goal-aware best selected metric.
  - Metric key count.
  - Artifact count.
- Body:
  - Main column: selected metric chart, metric summary table, artifact groups.
  - Side rail: timeline, source, reproducibility, and compact config preview.

Behavior:

- The chart stays visually related to the run identity.
- JSON config/latest metrics are constrained and readable, not giant raw dumps.
- Artifact groups use consistent cards and previews.

## Compare Tab Design

User story:

An ML researcher selects several runs and wants a row-first comparison that scans like a leaderboard plus evidence table: one run per row, fixed identity context, best/reference signals, tags/notes/artifacts, and high-signal changed attributes.

Layout:

- Top `analysis-header`:
  - Title: `Compare`
  - Count and 50-run cap note.
  - A compact objective summary: active metric and whether higher/lower is better.
- Toolbar:
  - Search.
  - Reference.
  - Metric.
  - Rows sort.
  - Runs sort.
  - Config key.
  - Diff-only checkbox.
  - Layout toggle: `Runs as rows` default, `Runs as columns` optional.
- Summary ribbon:
  - Best run.
  - Reference.
  - Largest deltas.
  - Matched run/row count.
- Annotation dock:
  - Compact edit-run selector plus tags/notes editor for the selected compared run.
  - It should not split the page into an awkward separate band.
- Main table:
  - Default row layout for `auto` and explicit rows.
  - Fixed columns: Run, Status, Tags, Notes, Artifacts, Latest, Best, selected config.
  - Evidence columns: high-signal changed attributes.
  - Sticky run column and header, bounded horizontal scroll only inside table.
- Column matrix:
  - Available only when user explicitly picks `Runs as columns`.
  - Styled as secondary inspection mode, not the default.

Behavior:

- Change `auto` layout resolution to row layout by default for Compare; users can force columns.
- Keep the existing saved-view shape and `compareLayout` values.
- Keep Compare cap at 50 selected runs.
- Preserve row/run sorting and search semantics.

## Responsive Behavior

- 1280px desktop: no overlapping headers, no clipped toolbar labels, Compare row table starts below the summary/annotation area.
- Tablet: analysis toolbar wraps to two rows; side rails stack below main content.
- Mobile: all three tabs use single-column stacking with bounded horizontal table scroll only where unavoidable.

## Implementation Plan

1. Add shared analysis-page CSS primitives in `apps/web/app/globals.css`.
2. Restructure Metrics markup in `apps/web/app/page.tsx` around header, catalog, chart canvas, and insight rail.
3. Restructure Run Detail markup and `RunDetail` internals to use a dossier header, KPI row, main/side sections, and constrained data blocks.
4. Restructure Compare markup around row-first controls, summary ribbon, compact annotation dock, and row table default.
5. Update Compare `auto` layout to resolve to row layout by default.
6. Update responsive CSS and dark-theme overrides.
7. Extend or adjust UI smoke assertions if selectors/classes move.
8. Run unit/build/UI validation and Computer Use QA.

## Risks

- `apps/web/app/page.tsx` is large, so keep the slice scoped and avoid unrelated refactors.
- Compare row layout can still be wide when many evidence rows are visible. Keep horizontal scroll inside the table only.
- Run Detail can become too long. Preserve scan order: identity, chart, metrics, artifacts, then raw detail.

## Review Notes

Fresh design reviewer themes:

- Row-first Compare is correct, but a row-shaped wide spreadsheet would fail the user story. Default row mode must show decision evidence in the first viewport: run identity, latest/best objective values, reference delta, annotations, artifact/checkpoint signal, and only a small ranked set of evidence columns.
- `Auto` should be treated as saved-view compatibility. The user-facing Compare control should default to rows and keep columns as an explicit secondary inspection mode.
- The row/evidence label should say `Evidence` or `Attributes`, not `Rows`, because in row mode the actual runs are rows.
- The Compare annotation editor must not sit as a large band between controls and evidence. Tags/notes belong in run identity context; editing should be compact and secondary.
- Metrics must stay chart-first. Keep title/counts in the header and move chart controls into a separate responsive toolbar.
- Run Detail must reconnect identity, annotation, KPIs, and selected metric chart above raw source/config dumps. Failure/debug evidence stays first-class.
- New CSS primitives must use tokens and avoid inheriting old full-height `.chart-card` behavior inside the analysis pages.
- Preserve stable IDs/classes used by UI smoke where possible: `#metric-filter`, `#metric-select`, `#pin-metric`, `#run-detail`, `.run-detail-chart`, `.compare-metadata-editor`, `#compare-layout`, `.compare-run-layout`, `.compare-matrix`, `.compare-artifact-strip`, and `#side-by-side`.

Accepted implementation decisions:

- Compare row mode renders at most 8 evidence columns by default. Fuller evidence remains available by search/sort and column matrix mode.
- Combine tags and notes visually into a single annotation column in Compare row mode.
- Default `compareLayout` state to `rows`; saved `auto` values resolve to rows.
- Default `compareRunSort` to `metric-best` so the first Compare view is objective-oriented.
- Keep `compareRowSort` state internally, but relabel the toolbar control as `Evidence`.
- Use `analysis-page` primitives as additive classes so existing tests and selectors remain valid.
