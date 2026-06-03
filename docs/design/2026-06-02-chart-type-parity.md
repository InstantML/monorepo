# Design: Research Comparison Graphs

Date: 2026-06-02

Status: Revised after fresh review, accepted for narrow second slice

Owner: Codex

## Summary

InstantML needs graph workflows for the questions researchers ask while
comparing training runs: which seed variance is real, which hyperparameters
trade off against quality, which distributions drift over training, and which
evaluation failures need inspection. The first accepted slice shipped a
summary-only Runs workspace field catalog plus saved scatter panels.

This second slice promotes the remaining requested graph workflows with
bounded, testable contracts:

- seed/group distribution panels over loaded run summaries,
- selected-run logged-histogram timeline panels backed by existing rich-object
  reads,
- parallel-coordinate analysis kept in Insights rather than saved Runs
  workspace panels,
- and a typed binary classification evaluation bundle logged by the Python SDK
  and rendered from rich objects.

Distribution panels are summary-only. They must not fetch
`/api/metrics/series` or `/objects`. Histogram timeline and evaluation bundle
views are selected-run rich-object workflows and stay bounded to one active run
until a separate multi-run object-series endpoint exists. Parallel coordinates
remain an exploratory Insights/HPO surface over loaded summaries and are not a
saved Runs workspace panel type.

## Goals

- Add saved Runs workspace distribution panels that expose visible-sample seed
  variance and ablation stability from current run summaries.
- Add selected-run logged-histogram timeline panels over
  `/api/runs/:id/objects?kind=histogram&key=...`.
- Keep parallel-coordinate HPO/sweep inspection in Insights instead of adding a
  saved Runs workspace panel type.
- Add a typed SDK helper, `log_classification_eval(...)`, that logs compact
  binary PR, ROC, confusion matrix, per-class metrics, and optional prediction
  rows.
- Keep every new workflow backward compatible with existing saved workspace
  view payloads and rich-object readers.
- Keep initial Runs workspace loads free of new metric-series/object fan-out.

## Non-Goals

- No project-wide or multi-run histogram-series endpoint in this slice.
- No automatic histogram-key catalog endpoint in this slice.
- No generic chart query language, Vega/Plotly editor, or custom-code chart.
- No lasso/brushing/filtering across panels in this slice.
- No server-side distribution aggregation in this slice.
- No saved Runs workspace parallel-coordinate panel in this slice.
- No image-only evaluation screenshots. Evaluation bundles must be typed data.
- No one-vs-rest PR/ROC curves or probability-vector storage in the eval MVP.

## Users And Use Cases

- Fine-tuning engineers compare whether validation loss or F1 improvements are
  stable across visible seeds, not just best-run spikes.
- Sweep users inspect how learning rate, batch size, duration, and metrics
  interact across selected or currently visible runs in Insights.
- Researchers inspect the latest logged histogram frames for a selected run,
  such as score, activation, gradient, or weight distributions over recent
  training steps.
- Classification researchers log a compact evaluation package once per eval
  step and inspect binary PR/ROC curves, confusion matrix, per-class metrics,
  and selected prediction rows without hand-assembling custom objects.

## Proposed Design

### Already Shipped First Slice

The first slice remains the foundation:

1. Stable numeric field IDs:
   - `metric:<encoded_metric_key>:latest`
   - `metric:<encoded_metric_key>:min`
   - `metric:<encoded_metric_key>:max`
   - `metric:<encoded_metric_key>:mean`
   - `metric:<encoded_metric_key>:best`
   - `config:<encoded_json_pointer>`
   - `metadata:<encoded_json_pointer>`
   - `run:duration_seconds`
   - `run:created_at_unix`
2. `buildRunFieldCatalog(...)` over loaded summaries.
3. Saved summary-only scatter panels.
4. Sanitized backward-compatible workspace view payloads.

### Categorical Field Contract

Add a separate categorical field parser and catalog. Numeric field parsing stays
unchanged for scatter and distribution values.

Supported categorical field IDs:

- `run:status`
- `run:first_tag`
- `config:<encoded_json_pointer>`
- `metadata:<encoded_json_pointer>`

The config/metadata encoding is identical to numeric field IDs. Example:
`config:%2Fvariant`, not `config:/variant`. `run:tag` is not accepted in this
slice because multi-valued grouping would duplicate runs across groups; users
can use `run:first_tag` for a bounded tag grouping.

The categorical catalog includes:

- `id`
- `label`
- `source`
- `availableCount`
- `missingCount`
- `groupCount`

Group labels are capped to 80 characters. Fields with more than 24 distinct
groups are excluded from default recommendations and still render with visible
truncation if loaded from a saved view.

### Distribution Panel

Add `distribution` to Runs workspace panel types. It uses:

- `valueField`: required numeric field ID,
- `groupField`: optional categorical field ID,
- `replicateField`: optional categorical field ID, normally seed,
- `metricKey`: compatibility fallback, typically the value metric key.

Default selection:

1. `valueField`: current metric `best` when parseable, otherwise first numeric
   metric/config field.
2. `groupField`: preferred low-cardinality non-seed config/metadata field whose
   label matches `variant`, `group`, `dataset`, `model`, `policy`, `algo`, or
   `method`; otherwise `run:first_tag` when it has 2-12 groups; otherwise
   ungrouped.
3. `replicateField`: a low-cardinality config/metadata field matching `seed`
   when present. Seed is never the default `groupField`.

The renderer computes, per group:

- `n`,
- missing count,
- unique replicate count,
- min,
- q1,
- median,
- q3,
- max,
- mean,
- visible-sample standard error of the mean.

Visual honesty rules:

- For `n < 5`, render strip points plus median only. Suppress the quartile box
  and SEM.
- For `n >= 5`, render a compact box-and-strip plot.
- SEM is shown only when `n >= 5` and is labeled `visible-sample SEM`.
- Strip points are capped at 25 per group with deterministic sampling and a
  `25 of N shown` label.
- The panel footer shows selected/current-page scope, plotted `n`, cap state,
  missing count, and unique replicate count when a replicate field exists.

This covers the requested box/violin/strip workflow without introducing a
density estimate that would be misleading on small seed counts.

### Parallel Coordinates In Insights

Parallel coordinates stay in the Insights tab for this slice. That keeps the
Runs workspace focused on saved comparison panels while preserving the existing
HPO/sweep power-user workflow over loaded run summaries.

The reusable helper layer still supports deterministic numeric-axis selection,
seed exclusion, log-scale hints for learning-rate-like fields, per-axis
normalization, missing-run accounting, and axis caps. The saved Runs workspace
schema and add/edit panel controls do not include `parallel`.

### Selected-Run Logged Histogram Timeline

The user-facing chart label is `Logged histogram timeline`. The existing summary
histogram label remains `Value histogram`.

Use the existing selected-run object route only when a saved panel has an
explicit object key:

```text
GET /api/runs/:id/objects?kind=histogram&key=<key>&limit=100
```

The backend already normalizes public `histogram` to stored
`histogram_series`. The selected-run MVP:

- does not auto-discover keys by reading all histogram objects,
- uses the panel `objectKey` as the authoritative saved key,
- stores `metricKey` as the same object key for legacy panel compatibility,
- fetches at most 100 latest frames for the selected key,
- labels the visual as `latest 100 frames` when the returned page reaches the
  limit,
- sorts those returned frames by step ascending for rendering,
- validates finite bins/counts on the server at write time and on the client at
  read time for legacy rows,
- renders a heatmap only when frames share compatible bin edges,
- otherwise renders a selected-frame histogram with a non-comparable-bins
  warning,
- exposes a scrubber/frame control,
- and shows clear empty/truncated states.

Frontend request policy:

- Fetch only for the primary selected run.
- Fetch only when `objectKey` is non-empty.
- Deduplicate requests by `(primaryRunId, "histogram", objectKey)`.
- Limit active histogram timeline fetches to 3 visible panels per workspace
  render; later panels show a capped empty state.
- Use request concurrency `1` for object reads.
- Abort when primary run or object key changes.

This slice does not add a new endpoint. Multi-run or full-training histogram
drift needs a separate bounded endpoint with order, stride, first/last coverage,
and OpenAPI/codegen.

### Binary Classification Evaluation Bundle

Add a rich-object kind `classification_eval`. The SDK helper logs one object
under a user-supplied key:

```python
run.log_classification_eval(
    "eval/classification",
    y_true=[0, 1, 1, 0],
    y_score=[0.1, 0.8, 0.7, 0.2],
    y_pred=[0, 1, 1, 0],
    class_names=["negative", "positive"],
    positive_label="positive",
    split="validation",
    threshold=0.5,
    step=10,
    predictions=[
        {"id": "ex-1", "true_label": "positive", "predicted_label": "positive", "score": 0.8}
    ],
)
```

MVP semantics:

- `task` is `binary_classification`.
- `class_names` must contain exactly two unique labels.
- `positive_label` must be one of `class_names`.
- `y_true` labels must be class names or integer class indices.
- `y_score` is a one-dimensional positive-class score array.
- `y_pred` is optional. When omitted, predictions are derived by
  `score >= threshold`.
- `threshold_direction` is fixed to `score >= threshold predicts positive`.
- Confusion matrix orientation is rows=true class, columns=predicted class, in
  `class_names` order.
- Zero-division precision/recall/F1 values are `0.0`.
- PR/ROC thresholds are generated from sorted unique scores, capped to 200
  curve points through deterministic endpoint-preserving downsampling.
- Prediction rows are opt-in, accepted up to 100, and normalized to
  `id`, `true_label`, `predicted_label`, `score`, `correct`.

Backend validation accepts `classification_eval` objects and enforces:

- `schema_version == 1`,
- `task == "binary_classification"`,
- max object value bytes: 64 KiB,
- max metadata bytes: existing 16 KiB,
- max summary bytes: existing 16 KiB,
- max JSON depth: 8,
- max string bytes per value: 1 KiB,
- exactly two class names, each <= 128 bytes,
- `sample_count <= 1_000_000`,
- 2x2 nonnegative integer confusion matrix whose total matches
  `sample_count`,
- metric values in `0..1`,
- support counts are nonnegative integers,
- at most 200 PR points and 200 ROC points,
- curve numeric values are finite and in `0..1`,
- at most 100 prediction rows,
- prediction row JSON <= 2 KiB.

The UI renders classification eval objects in rich-object panels with:

- PR and ROC sparklines when present,
- confusion matrix heatmap,
- per-class metric table,
- compact prediction row preview when present,
- and an empty state when curves are missing rather than implying a logging
  failure.

## Panel Controls

Add drawer controls use the existing chart-type segmented control with these
labels:

- `Line`
- `Bar`
- `Value histogram`
- `Dot plot`
- `Scatter`
- `Distribution`
- `Logged histogram timeline`

Distribution edit controls:

- `Value field`
- `Group field`
- `Replicate field`
- `Max runs to show`

Logged histogram timeline edit controls:

- `Object key`
- disabled help text when no primary run is selected,
- `Max frames` fixed to 100 in this slice.
- no `Max runs to show`, because the panel is explicitly selected-run only.

Line/bar/value-histogram/dot controls keep their existing metric and axis
settings. Scatter keeps `X field`, `Y field`, and `Max runs to show`.

## Component Impact

Backend:

- Extend object kind validation to accept `classification_eval`.
- Add generic object value size caps and stricter histogram bin/count
  validation.
- Keep list/create object route shapes unchanged and OpenAPI/codegen current.

Frontend:

- Extend workspace panel types, sanitizer, add drawer, edit drawer, and Runs
  workspace rendering for `distribution` and `histogram_timeline`.
- Extend dashboard panel helpers for categorical fields, distribution
  summaries, Insights parallel-coordinate traces, histogram frame parsing, and
  eval object parsing.
- Extend Run Detail rich-object previews for classification eval objects.

Python SDK:

- Add `ClassificationEval` wrapper and `Run.log_classification_eval(...)`.
- Keep existing `log_objects(...)`, `log_histogram(...)`, and public imports
  backward compatible.

Storage:

- No new tables. Evaluation bundles and histogram frames remain typed
  attributes/rich objects.

Docs:

- Update web README, SDK README/PYPI README, rich object docs, Runs workspace
  docs, and core concepts.

## Data Model

`WorkspacePanelType` gains:

```ts
"distribution" | "histogram_timeline"
```

Additional saved panel fields:

```ts
valueField?: string;
groupField?: string;
replicateField?: string;
objectKey?: string;
```

Compatibility rules:

- Existing panel payloads remain valid.
- `metricKey` remains required for every panel as the legacy fallback.
- Invalid new field references drop only the invalid new panel, not the whole
  workspace view.
- Distribution always caps at `settings.maxRuns`, including when explicit
  selections exceed that cap.

`classification_eval` object value shape:

```json
{
  "schema_version": 1,
  "task": "binary_classification",
  "split": "validation",
  "positive_label": "positive",
  "threshold": 0.5,
  "threshold_direction": "score_gte_threshold",
  "class_names": ["negative", "positive"],
  "sample_count": 100,
  "confusion_matrix": [[50, 4], [6, 40]],
  "per_class": [
    {"class_name": "negative", "precision": 0.893, "recall": 0.926, "f1": 0.909, "support": 54},
    {"class_name": "positive", "precision": 0.909, "recall": 0.87, "f1": 0.889, "support": 46}
  ],
  "accuracy": 0.9,
  "macro_f1": 0.899,
  "pr_curve": [{"threshold": 0.1, "precision": 0.81, "recall": 0.98}],
  "roc_curve": [{"threshold": 0.1, "tpr": 0.98, "fpr": 0.22}],
  "predictions": [{"id": "ex-1", "true_label": "positive", "predicted_label": "positive", "score": 0.91, "correct": true}]
}
```

## API Contracts

No new route is required for distribution, Insights parallel coordinates, or selected-run
logged-histogram timeline.

Changed existing route:

- `POST /api/runs/:id/objects` accepts `kind="classification_eval"`.
- `GET /api/runs/:id/objects?kind=classification_eval` returns those objects
  through the existing object envelope.
- `GET /api/runs/:id/objects?kind=histogram&key=...` remains the selected-run
  logged-histogram timeline source.

OpenAPI/codegen must be regenerated after backend validation/docs changes.

## Performance Considerations

- Distribution operates on `workspacePanelRuns`, capped by `settings.maxRuns`,
  including selected-run scopes.
- Distribution sorting and quantile work is O(groups * n log n) over at most 25
  default panel runs.
- Histogram timeline reads at most 100 objects for one selected run and one
  key. No selected-run fan-out is allowed.
- Histogram requests are deduped and concurrency-limited to 1.
- Classification eval payloads are compact JSON with backend size limits.
- Initial Runs load must not fetch objects unless a visible
  `histogram_timeline` panel exists, a primary run is selected, and that panel
  has an explicit object key.

## Simplicity Review

The design uses existing summaries and object routes first. The only backend
contract expansion is the typed evaluation object plus stronger rich-object
validation. This avoids a premature multi-run object-series API while still
delivering the selected-run logged-histogram workflow. Distribution uses a
box-and-strip plot instead of a violin because seed counts are often small and
density estimates imply more support than the data has.

## Failure Modes

- No finite numeric value fields: distribution add controls are
  disabled and panels render `No numeric fields are available in this scope`.
- Saved numeric/group field no longer exists: keep the panel editable and show
  `Saved field is not present in the loaded runs`.
- Distribution has one group only: render one visible-sample distribution and
  label it `Ungrouped visible runs`.
- Distribution group `n < 5`: render strip plus median and show
  `not enough replicates for box/SEM`.
- Run subset is capped: show plotted count, cap, missing count, and selected or
  current-page scope.
- No primary run selected for histogram: show `Select one run to load logged
  histogram frames`.
- Selected run has no panel `objectKey`: show `Choose a histogram object key`.
- Histogram object route errors: retry transient failures through the existing
  request helper, then show the route error in the panel.
- Histogram returns 100 frames: label `latest 100 frames`.
- Histogram frames have incompatible bins: suppress heatmap and show the
  selected-frame histogram only.
- Eval object has no PR/ROC curve: show confusion matrix and metrics; curve
  area says `Curve data was not logged`.
- Older clients do not know `classification_eval`: existing object list still
  returns JSON; older UIs show preview unavailable.

## Testing Plan

- Unit tests for categorical field ID encoding/decoding and group extraction.
- Unit tests for distribution quantiles, SEM suppression, replicate counts,
  missing counts, and deterministic strip caps.
- Unit tests for parallel helper axis selection, log scaling, normalization,
  constant axes, missing axes, and capped runs/axes used by Insights.
- Unit tests for histogram frame parsing, compatible-bin heatmap dimensions,
  incompatible-bin fallback, key extraction from saved panel state, and invalid
  finite-value rejection.
- Workspace sanitizer tests for new panel types and legacy payloads.
- Static tests proving only line panels request metric series and only
  histogram timeline panels request objects.
- SDK tests for `ClassificationEval`, `log_classification_eval(...)`,
  prediction caps, PR/ROC/confusion helpers, and validation failures.
- Rust tests for object kind validation, generic value size caps, histogram
  count validation, and classification eval caps.
- UI smoke coverage for adding/editing/fullscreening/reloading distribution and
  logged-histogram timeline panels, plus Insights parallel-coordinate rendering.
- Browser QA against local Rust/ClickHouse with seeded histogram and eval
  objects.

## Documentation Plan

- `docs/design/2026-06-02-chart-type-parity.md`
- `apps/web/README.md`
- `apps/rust-server/README.md`
- `packages/python-sdk/README.md`
- `packages/python-sdk/PYPI_README.md`
- `apps/docs/dashboard/runs-workspace.mdx`
- `apps/docs/sdk/rich-objects.mdx`
- `apps/docs/concepts/core-concepts.mdx`

## Alternatives Considered

- Add a multi-run histogram-series endpoint now. Rejected for this slice: the
  selected-run object route is enough for a useful MVP, while multi-run object
  windows need separate limits and OpenAPI shape.
- Auto-discover histogram keys from all selected-run objects. Rejected because
  the existing route returns full values and newest frames, not a bounded key
  catalog.
- Ship violin plots immediately. Rejected: small seed counts make kernel
  density visually overconfident. Box/median/strip is more honest.
- Implement classification eval as screenshots or generic tables. Rejected:
  the product requirement is typed rich objects and an SDK helper.
- Add saved Runs workspace parallel-coordinate panels. Rejected for this slice:
  the accepted scope keeps parallel coordinates in Insights as an exploratory
  HPO/sweep surface.

## Review Notes

Previous first-slice reviewers approved the scatter-only foundation and
explicitly deferred the features now covered by this second-slice contract.

Fresh execution reviewer 1:

- Finding: Categorical field IDs, object-key panel creation, histogram key
  discovery, eval semantics, and selected-run caps were not executable enough.
- Risk: Saved panels could be dropped, histogram panels could not be created,
  eval tests would be ambiguous, and selected-run panels could overfetch.
- Recommended edit: Add exact categorical IDs, require explicit histogram
  `objectKey`, state compatibility fallback values, define eval calculations,
  and cap distribution at `settings.maxRuns`.
- Decision: Accepted.

Fresh execution/security reviewer 2:

- Finding: Rich-object value caps, histogram server validation, histogram key
  strategy, object request fan-out, and eval semantic caps were underspecified.
- Risk: Large stored JSON or saved views could create oversized responses,
  malformed histogram/eval data, or object-read denial-of-service.
- Recommended edit: Add explicit byte/depth/count caps, server-authoritative
  histogram/eval validators, no automatic key discovery, and deduped
  concurrency-limited object reads.
- Decision: Accepted.

Fresh ML product reviewer 1:

- Finding: Grouping by seed confuses replication with variants; capped
  summaries and SEM can look more authoritative than the visible sample.
- Risk: Researchers could draw false conclusions about ablation stability or
  full-training drift.
- Recommended edit: Treat seed as `replicateField`, show scope/caps/missing
  values, suppress SEM for small groups, label histogram panels as latest
  frames, and avoid heatmaps for incompatible bins.
- Decision: Accepted.

Fresh ML workflow reviewer 2:

- Finding: Panel controls, histogram naming, tiny-group rendering, eval fields,
  and empty states needed exact product language.
- Risk: Users could confuse summary histograms with logged histograms, see
  overconfident boxes, or misunderstand absent eval curves.
- Recommended edit: Add panel control labels, rename object panel to `Logged
  histogram timeline`, suppress box/SEM below `n=5`, narrow eval MVP to binary
  curves, and enumerate empty states.
- Decision: Accepted.

## Coverage Exceptions

None planned.

## Decision

Accepted for a narrow second slice after fresh review.
