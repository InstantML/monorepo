# Design: Research Comparison Graphs

Date: 2026-06-02

Status: Revised after fresh review

Owner: Codex

## Summary

InstantML needs better graph workflows for the questions researchers ask during
run comparison: which tradeoffs are real, which seeds are stable, which
distributions drift over time, and which model failures need inspection. W&B
and Neptune both expose a broader chart menu than InstantML, but this design
does not treat menu parity as the implementation target. The first accepted
slice promotes one high-value workflow into the daily Runs workspace: a saved,
summary-only scatter panel over loaded or selected runs.

The reviewed first slice contains:

- a reusable loaded-run field catalog,
- backward-compatible workspace panel schema migration and sanitization,
- saved Runs workspace scatter panels,
- chart-specific add/edit controls for scatter, and
- docs/tests proving scatter does not fetch scalar metric series or rich
  objects.

Distribution panels, histogram-over-step, parallel coordinates, and typed
evaluation objects remain important follow-ups, but fresh execution reviewers
blocked them from this PR because they need additional field/group semantics,
object validation, endpoint/windowing contracts, SDK APIs, and heavier browser
QA.

## Goals

- Let researchers plot two numeric loaded-run fields in the Runs workspace.
- Keep scatter panels synchronized with the current Runs filter and selection
  scope.
- Make panel scope visible so users do not mistake a paginated subset for a
  project-wide analysis.
- Add stable persisted field references with escaping rules.
- Preserve existing line, bar, latest-value histogram, and dot panel behavior.
- Keep initial Runs load free of new object or metric-series fan-out.

## Non-Goals

- No distribution, histogram-series, parallel-coordinate, or evaluation-object
  implementation in this PR.
- No generic Vega, Plotly, query, or custom-code chart editor.
- No server-side chart query language.
- No lasso selection, regression/frontier line, density overlay, or brushing in
  scatter v1.
- No project-wide all-matching scatter until a bounded backend summary/export
  contract is designed.

## Users And Use Cases

- Fine-tuning engineers compare learning rate, dataset version, model size,
  validation loss, F1, calibration, and runtime tradeoffs across the current run
  set.
- Sweep users inspect whether numeric configs correlate with the active metric
  without leaving the Runs workspace.
- Researchers identify outliers, hover for run identity, and click through to
  the existing selected-run workflow.

## Proposed Design

### Accepted First Slice

Implement only:

1. Loaded-run field catalog.
2. Workspace schema migration/sanitization for `scatter`.
3. Runs workspace scatter panel.
4. Chart-type-specific add/edit controls for scatter.
5. Unit/static tests and docs.

### Field Catalog

Create a helper that derives numeric fields from already loaded run summaries.
Persist field IDs as URL-encoded segments:

- `metric:<encoded_metric_key>:latest`
- `metric:<encoded_metric_key>:min`
- `metric:<encoded_metric_key>:max`
- `metric:<encoded_metric_key>:mean`
- `metric:<encoded_metric_key>:best`
- `config:<encoded_json_pointer>`
- `metadata:<encoded_json_pointer>`
- `run:duration_seconds`
- `run:created_at_unix`

`encodeURIComponent` is used for each dynamic segment. Config and metadata
paths are encoded as JSON Pointer strings so `/` and `~` inside field names are
unambiguous. Dots are path separators for display only. Tests must cover metric
keys and paths containing `/`, `.`, `:`, spaces, and nested config keys.

Each catalog item includes:

- `id`
- `label`
- `source`: `metric`, `config`, `metadata`, or `run`
- `valueType`: `number`
- `availableCount`
- `missingCount`

Non-finite values are excluded from geometry and counted as missing. The
`best` metric aggregate uses the existing `metricGoal()` helper to pick `min`
for minimize metrics and `max` for maximize metrics.

### Scatter Panel

Panel fields:

```ts
type ScatterWorkspacePanel = {
  id: string;
  type: "scatter";
  title: string;
  metricKey: string; // compatibility fallback; usually mirrors yField label
  xField: string;
  yField: string;
  layout?: WorkspacePanelLayout;
  settings?: Partial<WorkspacePanelSettings>;
};
```

Scatter operates on the same resolved run set as other workspace panels:
selected visible runs first, otherwise visible loaded runs capped by
`maxRuns`. The panel footer shows the plotted count, missing count, and that the
scope is selected or visible loaded runs.

Required states:

- no numeric fields,
- missing saved x/y field,
- no overlapping data for x/y,
- populated scatter,
- truncated/capped scope.

Clicking a point should use the existing workspace selection/inspection action
if available. If that integration is too invasive for this slice, the point
must at least expose a hover/title with the run name and values, and the design
should record table-linked click selection as the next scatter follow-up.

### Workspace Schema

Current panels remain valid. The sanitizer must accept `scatter`, preserve
`xField` and `yField`, and cap string lengths. Color/group semantics are
deferred until there is a visible control and legend behavior. Invalid scatter
panels are dropped or normalized only when required fields are missing. Existing
line/bar/latest-histogram/dot panels must round-trip unchanged.

### Deferred Follow-Ups

Distribution panel:

- Requires numeric and categorical field catalogs.
- Must support explicit grouping by config/tag/metadata/seed.
- Must show `n`, missing count, median/IQR, and mean/CI or SEM.
- Must avoid arbitrary first-tag defaults.

Histogram-series:

- Must align public `histogram` object kind with stored `histogram_series`.
- Must support both rich-object and attribute-style histogram paths or document
  exactly which path is supported.
- Needs object `value` byte caps, finite bins/counts validation, step/window
  semantics, visible truncation, selected-frame histogram, and a step/time
  scrubber before implementation.

Classification evaluation objects:

- Need a separate backend/SDK contract.
- Current backend rejects unknown object kinds and does not cap arbitrary object
  value size, so this cannot be a frontend-only change.
- Must include `split`, `step`, `positive_label`, threshold policy,
  normalization mode, class support counts, and optional prediction table links.
- PR, confusion matrix, and per-class metrics are higher priority than ROC for
  imbalanced classification.

Parallel coordinates:

- Deferred until axis selection, hover/table highlighting, log/invert controls,
  and ideally brushing/filtering are accepted.
- Otherwise it risks becoming visual parity without workflow value.

Roadmap-only graph types:

- calibration/reliability plots,
- residual plots,
- metric correlation heatmaps,
- resource/rank heatmaps,
- faceted small-multiple line charts,
- Pareto/frontier views, and
- embedding/projector views.

## Component Impact

Backend:

- No backend change in the accepted first slice.

Frontend:

- Add field-catalog helpers.
- Extend workspace panel types, labels, sanitization, add drawer, edit drawer,
  and panel rendering for scatter.
- Keep scatter summary-only.

Python SDK:

- No SDK change in the accepted first slice.

Storage:

- No storage change. Existing workspace view JSON payloads persist the new
  scatter fields.

Docs:

- Update web README and Runs workspace docs.

## Data Model

`WorkspacePanelType` gains `scatter`.

`WorkspacePanel` gains optional fields:

```ts
xField?: string;
yField?: string;
```

The current `metricKey` field remains for compatibility with existing helpers
and saved-view payloads. Scatter renderers should prefer `xField`/`yField`.

## API Contracts

No new API contract in the accepted first slice. Scatter uses loaded
`RunSummary` data only.

## Performance Considerations

- Scatter derives points from current `workspacePanelRuns`; no new network
  request.
- Field catalog derivation should be memoized by run set and metric catalog.
- Rendered marks are capped by `maxRuns` and selected-run caps.
- Initial Runs load must make zero new object requests and scatter must not
  request `/api/metrics/series`.

## Simplicity Review

The accepted slice changes only the frontend workspace schema and rendering. It
does not change ClickHouse, Rust endpoints, SDK APIs, or scalar metric storage.
That keeps the feature reviewable and preserves the existing dashboard
performance model.

Deferred complexity is documented in follow-up sections instead of being
half-implemented.

## Failure Modes

- Saved field no longer exists: keep the panel and show a missing-field state.
- Selected fields have no overlapping finite values: show an empty chart state.
- Run subset is capped: show plotted and missing counts.
- Unknown panel type in an old/future payload: sanitizer keeps existing fallback
  behavior and drops/normalizes safely.

## Testing Plan

- Unit tests for field ID encoding/decoding, catalog extraction, best metric
  resolution, nested config/metadata paths, non-finite filtering, and scatter
  point generation.
- Workspace sanitizer tests for scatter round-trip and backward compatibility
  with line/bar/histogram/dot.
- Static tests proving only line panels fetch full metric series.
- Component/static tests for scatter add/edit controls and labels.
- Browser QA against local Rust/ClickHouse for adding, editing, fullscreening,
  and saving/reloading scatter panels.

## Documentation Plan

- `docs/design/2026-06-02-chart-type-parity.md`
- `apps/web/README.md`
- `apps/docs/dashboard/runs-workspace.mdx`

## Alternatives Considered

- Implement all requested chart types together. Rejected by four fresh
  reviewers as too broad and unsafe for one PR.
- Add histogram-series first. Valuable, but blocked until object value caps,
  histogram validation, and object windowing semantics are accepted.
- Add classification eval helpers first. Valuable, but it is a backend/SDK API
  contract change and not safe as a frontend-only slice.
- Add parallel coordinates first. Rejected because the useful MVP needs heavier
  interaction design than this PR can safely deliver.

## Review Notes

Fresh execution reviewer 1:

- Finding: The first implementation slice was too broad and crossed frontend,
  backend, SDK, storage, and object-contract boundaries.
- Risk: Partial implementation would create misleading or unsafe graph
  surfaces, especially for histogram-series and evaluation objects.
- Recommended edit: Revise to field catalog plus saved Runs scatter only;
  leave distribution, histogram-series, parallel, and eval objects as separate
  accepted slices.
- Decision: Accepted.

Fresh execution/security reviewer 2:

- Finding: Workspace sanitizer would drop new panel fields; object payload
  validation is insufficient for histogram/eval work; field ID grammar was
  ambiguous.
- Risk: Saved panels could silently lose fields, object payloads could exceed
  intended bounds, and persisted field IDs could fail for normal metric names.
- Recommended edit: Add explicit sanitizer rules and tests for scatter, block
  object-backed graph types, and use escaped field ID segments.
- Decision: Accepted.

Fresh ML product reviewer 1:

- Finding: Loaded-run scope can mislead researchers, distribution needs stronger
  seed/group semantics, and scatter needs to inherit the Runs workflow.
- Risk: Users may draw false project-wide conclusions from a paginated subset or
  get a chart that is visually present but not workflow-linked.
- Recommended edit: Show plotted/scope counts, prioritize explicit scope
  language, and require hover/run identity for scatter.
- Decision: Accepted for scatter; distribution is deferred.

Fresh ML workflow reviewer 2:

- Finding: The original draft still led with W&B/Neptune parity and
  under-specified best metric semantics, histogram drift workflows, and eval
  metadata.
- Risk: The roadmap could match chart menus without solving training-debugging
  questions.
- Recommended edit: Reframe around tradeoffs, seed stability, distribution
  drift, and evaluation failures; add best metric fields; demote parallel until
  interaction requirements are accepted.
- Decision: Accepted.

Final security diff reviewer:

- Finding: Malformed encoded field IDs and unbounded supplemental metric keys
  could waste client CPU.
- Resolution: Field decoding now normalizes malformed segments to `null`, and
  catalog derivation bounds metric keys, nested-field traversal, and loaded-run
  sampling.

Final performance diff reviewer:

- Finding: Field catalog and enriched run summaries could allocate heavily on
  large visible run sets or repeated panel renders.
- Resolution: Catalog derivation samples a bounded run set, caps leaves and
  nodes, and avoids fallback summary merging when the primary summary already
  has all keys.

Final product/frontend diff reviewers:

- Finding: Scatter defaults and empty states could overemphasize metrics,
  understate current-page scope, or clip field labels.
- Resolution: Defaults now prefer numeric config/run fields for x-axis, best
  metric labels show direction, empty states name missing fields, and legend
  labels wrap without clipping.

Final cleanliness diff reviewer:

- Finding: The review should keep the implementation scoped and leave unrelated
  worktree changes alone.
- Resolution: The PR remains frontend/docs/tests only, and unrelated `TODO.md`
  edits are intentionally excluded from the commit.

## Coverage Exceptions

None planned.

## Decision

Accepted for the first slice only: loaded-run field catalog, workspace schema
migration/sanitization, and summary-only Runs scatter panels.
