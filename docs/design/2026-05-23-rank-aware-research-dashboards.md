# Design: Rank-Aware Research Dashboards

Date: 2026-05-23

Status: Revised after fresh review

Owner: Codex

## Summary

InstantML should add a rank-aware research-analysis slice while keeping the
durable backend change narrow. The storage/API/SDK slice covers the feature the
current system cannot represent: multiple rank values for the same
`run_id/key/step`. The UI slice then adds honest dashboard views for the eight
requested high-value features:

1. rank reducer line charts,
2. rank heatmaps,
3. rank outlier panels,
4. rank coverage timelines,
5. grouped run reducers,
6. hyperparameter scatter and parallel-coordinate views,
7. K-means run clustering, and
8. evaluation metric panels.

The durable implementation is:

- `POST /runs/:run_id/rank-metrics`
- `GET /api/runs/:run_id/rank-metrics/summary`
- `Run.log_rank_metrics(...)` in the Python SDK
- a selected-run `Distributed` dashboard tab backed by rank metrics

The exploratory implementation is:

- an `Insights` dashboard tab for grouped reducers, hyperparameter views,
  K-means, and evaluation cards, derived only from the currently loaded full
  run summaries. It must display the exact run universe it uses and must not
  imply project-wide analytics when only page/selected summaries are loaded.

This split keeps the new backend contract safe and bounded while still giving
researchers a first usable surface for all eight features.

## Goals

- Let distributed workers log scalar metrics with `rank`, `world_size`,
  optional `local_rank`, optional `weight`, and optional `timestamp`.
- Count rank metric rows against the same plan metric-point limit as scalar
  metric rows.
- Deduplicate same `(run_id, key, step, rank)` observations deterministically
  at read time with `argMax(..., tuple(created_at, event_id))`.
- Compute rank reducers: `mean`, `weighted_mean`, `min`, `max`, `stddev`,
  `p05`, `p50`, and `p95`.
- Bound heatmap responses with a hard cell cap and truncation metadata.
- Surface partial/missing rank coverage and world-size mismatches.
- Add SDK validation and process-spool idempotency for rank metrics.
- Add `Distributed` and `Insights` dashboard tabs with clear empty/loading/error
  states and hidden-tab fetch gating.
- Keep `/dashboard/runs` as the default dashboard route while adding a
  built-in `Advanced reducers` view preset that opens a combined
  `/dashboard/advanced` page for rank reducers plus local advanced graphs.
- Add an SDK-driven seed/example that creates a new project exercising all
  eight dashboard features.
- Add tests and local benchmark coverage.

## Non-Goals

- Do not replace training-critical `torch.distributed` collectives.
- Do not use backend reducers for synchronous training control decisions.
- Do not encode ranks as metric keys such as `loss/rank_0`.
- Do not change scalar `metric_points` or `metric_series` shape.
- Do not add server-side K-means or a general query language in this slice.
- Do not add rich confusion-matrix/PR/ROC parsing beyond evaluation metric
  summary cards.
- Do not add deprecated Node implementation for the new rank endpoints.

## Users and Use Cases

Distributed training researchers inspect rank loss, reward, throughput, or
gradient-norm skew without adding observability-only GPU/NCCL collectives.

Sweep users inspect current loaded run summaries to answer:

- Which config values correlate with the active metric?
- Which groups have stable mean/median behavior?
- Which runs cluster together?
- Which evaluation metrics are strong, weak, or missing?

## Proposed Design

### Rank Metric Ingest

Add:

```text
POST /runs/:run_id/rank-metrics
```

Body:

```json
{
  "metrics": { "train/loss": 0.123 },
  "step": 42,
  "rank": 3,
  "world_size": 8,
  "local_rank": 3,
  "weight": 32,
  "timestamp": "2026-05-23T00:00:00Z"
}
```

Validation:

- `metrics`: same non-empty finite scalar map and 1,000-key cap as scalar
  metrics.
- `step`: finite nonnegative number.
- `rank`: integer, `0 <= rank < world_size`.
- `world_size`: integer, `1..512` for the first slice.
- `local_rank`: optional integer, `0 <= local_rank < world_size`, defaults to
  `rank`.
- `weight`: optional finite positive number, defaults to `1.0`.
- `timestamp`: optional, parsed like scalar metrics.

Auth, project access, billing write gates, and plan-limit checks match scalar
metric ingest. Rank points increment `UsageDelta.metric_points` by the number
of metric keys in the batch.

The SDK adds:

```python
run.log_rank_metrics(
    {"train/loss": loss_value},
    step=global_step,
    rank=rank,
    world_size=world_size,
    local_rank=local_rank,
    weight=batch_size,
)
```

Process-spooled rank metric events receive stable end-to-end idempotency:
the uploader sends the event id as `Idempotency-Key`, and the Rust endpoint
replays the stored inserted count for the same key/body before billing checks
or ClickHouse inserts.

### Storage

Add a separate ClickHouse table:

```sql
CREATE TABLE IF NOT EXISTS rank_metric_points (
    org_id      UUID,
    run_id      UUID,
    key         LowCardinality(String),
    step        Float64 CODEC(Delta, ZSTD(3)),
    rank        UInt32,
    local_rank  UInt32,
    world_size  UInt32,
    value       Float64 CODEC(ZSTD(3)),
    weight      Float64 CODEC(ZSTD(3)),
    logged_at   DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at  DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3)),
    event_id    UUID
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, run_id, key, step, rank, created_at, event_id)
SETTINGS index_granularity = 8192;
```

Reads canonicalize duplicates before reducer math:

```sql
SELECT
  org_id, run_id, key, step, rank,
  argMax(local_rank, tuple(created_at, event_id)) AS local_rank,
  argMax(world_size, tuple(created_at, event_id)) AS world_size,
  argMax(value, tuple(created_at, event_id)) AS value,
  argMax(weight, tuple(created_at, event_id)) AS weight,
  max(created_at) AS created_at
FROM rank_metric_points
WHERE org_id = ? AND run_id = ? AND key = ?
GROUP BY org_id, run_id, key, step, rank
```

Do not add a materialized aggregate table in this slice. A future aggregate
table must preserve deterministic duplicate handling before maintaining states.

### Rank Summary Read

Add:

```text
GET /api/runs/:run_id/rank-metrics/summary?key=train/loss&limit=1000
```

Query:

- `key`: optional. If absent, select the first available rank metric key.
- `limit`: requested step cap, default `1000`, max `5000`. The server lowers
  the effective step cap when needed to keep canonical rank rows under
  `65,536`.
- `start_step`, `end_step`: optional finite bounds.

Response:

```json
{
  "keys": ["train/loss"],
  "key": "train/loss",
  "reducers": [],
  "heatmap": [],
  "outliers": [],
  "coverage": [],
  "limits": {
    "step_limit": 1000,
    "max_world_size": 512,
    "max_canonical_rows": 65536,
    "max_heatmap_cells": 16384,
    "outlier_limit": 20
  },
  "truncated": {
    "steps": false,
    "heatmap": false,
    "outliers": false
  }
}
```

Reducer rows include:

- `step`
- `rank_count`
- `expected_world_size`
- `world_size_mismatch`
- `mean`
- `weighted_mean`
- `min`
- `max`
- `stddev`
- `p05`
- `p50`
- `p95`

Coverage rows include `missing_ranks` only when
`expected_world_size <= 128`; otherwise include `missing_rank_count` and omit
the full list to keep payloads bounded.

Canonical rank rows are capped at `65,536` before materialization. Heatmap rows
are capped at `16,384` cells. When the heatmap cell count exceeds that cap, the
route samples steps evenly after reducer computation and returns
`truncated.heatmap = true`.

Outliers are capped at 20 rows by absolute z-score/delta.

### Distributed Dashboard

Add a top-level `Distributed` tab in the core nav group after `Metrics`.

Data scope:

- selected/primary run only,
- selected rank metric key only,
- hidden tab makes no rank-metric request.

Panels:

- rank reducer line chart with mean and weighted mean,
- min/max reducer band summary,
- rank heatmap with truncation callout,
- outlier rank table,
- coverage timeline with partial/missing-rank state,
- empty setup state when no rank metrics exist.

### Insights Dashboard

Add a top-level `Insights` tab in the workspace nav group.

Data scope:

- current selected runs that have full summaries,
- otherwise current sorted summary page,
- never all matching runs unless those summaries are loaded.

Every panel must show `Using N loaded run summaries` and a missing/excluded
count when relevant.

Panels:

- grouped run reducers for the active metric, grouped by seed/tag/first numeric
  config key,
- hyperparameter scatter using two explicit numeric fields selected from loaded
  summaries,
- parallel-coordinate scan over up to five numeric fields,
- deterministic K-means over standardized numeric config/metric summary
  features,
- evaluation metric cards for accuracy, F1, precision, recall, AUC, loss,
  reward, and return-like keys.

This tab is exploratory/local-only in the first slice. It does not create a
backend field catalog. Nested configs are flattened with dot paths, categorical
values are excluded unless they are numeric, and every skipped field is counted
in panel metadata.

## Component Impact

Backend:

- `clickhouse/0001_initial.sql`: add `rank_metric_points`.
- `src/metric_store.rs`: add rank insert/key/summary/count methods.
- `src/metric_store.rs`: bump `METRIC_SCHEMA_VERSION` to 2 so existing BYOC
  tenant routes rerun the idempotent schema migration on first load.
- `src/domain.rs`: add rank request/response schemas and constants.
- `src/store/runs/rank_metrics.rs`: validate, insert, summarize.
- `src/http/handlers`: add rank handlers with OpenAPI.
- `src/http/mod.rs` and `src/http/openapi.rs`: register routes.
- `src/store/usage.rs`: include rank points in metric-point retained usage.

Frontend:

- Add `Distributed` and `Insights` nav entries.
- Add tab panes and helper functions.
- Add CSS for rank heatmap, coverage, scatter, parallel-coordinate, clustering,
  and evaluation cards.
- Add hidden-tab fetch gating and responsive assertions.

Python SDK:

- Add `Run.log_rank_metrics`.
- Add uploader idempotency for `/rank-metrics`.
- Add tests and example seed data.

Docs:

- Update current API/schema docs, component READMEs, and design index.

## Data Model

New physical table: `rank_metric_points`.

New request: `LogRankMetricsRequest`.

New response rows:

- `RankReducerPoint`
- `RankHeatmapPoint`
- `RankOutlierPoint`
- `RankCoveragePoint`
- `RankMetricsSummaryResponse`

## API Contracts

### `POST /runs/:run_id/rank-metrics`

Success:

```json
{ "inserted": 3 }
```

Errors match scalar metric ingest for auth, run access, billing, plan limits,
and validation.

### `GET /api/runs/:run_id/rank-metrics/summary`

Requires run read access. Returns rank keys and bounded summary arrays.

## Performance Considerations

- Expected first-slice rank scale: 8-256 ranks, 1-10 rank metrics, 1,000-5,000
  requested steps.
- Hard caps:
  - `MAX_RANK_WORLD_SIZE = 512`
  - `MAX_RANK_HEATMAP_CELLS = 16,384`
  - `MAX_RANK_OUTLIERS = 20`
  - rank summary `limit <= 5,000`
- Rank reads are selected-run and selected-key scoped.
- Insights uses already-loaded summaries and does not fan out metric-series
  requests.
- Benchmark target:
  - rank summary p95 under 250 ms for 64 ranks x 1,000 steps x 3 keys.
  - Insights helper p95 under 100 ms for 1,000 loaded run summaries.

## Simplicity Review

The durable backend slice adds only rank metrics. The other requested research
features are shipped as bounded, honest frontend panels over existing loaded
summary data. This avoids prematurely designing a project-wide analytics query
engine, a field catalog API, or server-side clustering.

Deferred:

- server-side K-means,
- field catalog API for scatter/parallel-coordinate panels,
- rich confusion-matrix/PR/ROC object parsing,
- rank aggregate materialized views,
- multi-run rank comparison,
- automatic distributed run rendezvous.

## Failure Modes

- Some ranks arrive late: reducers and coverage show partial state.
- Missing ranks: coverage reports missing rank count/list within payload caps.
- Duplicate rank/step/key writes: read-time canonicalization picks latest by
  `(created_at, event_id)`.
- Workers disagree on `world_size`: summary rows set `world_size_mismatch`.
- Uneven local batch sizes: UI labels `mean` and `weighted_mean` separately.
- User logs GPU-only values: SDK cannot avoid synchronization caused by
  user-side scalar extraction.
- No rank metrics exist: `Distributed` shows setup empty state.
- Too few numeric fields: `Insights` panels show scoped empty states.

## Testing Plan

- Rust tests:
  - rank metric validation for rank/world_size/local_rank/weight/step.
  - plan capacity counts rank points as metric points.
  - insert and summarize rank metrics.
  - duplicate same rank/key/step uses latest value.
  - coverage reports missing ranks and world-size mismatch.
  - heatmap and outlier truncation metadata.
  - project-scoped access rules match scalar metrics.
- SDK tests:
  - `log_rank_metrics` request body and validation.
  - process-spool rank metric event receives idempotency.
- Frontend node tests:
  - reducer chart conversion and heatmap truncation helpers.
  - deterministic K-means helpers.
  - hyperparameter feature extraction, including nested/missing/nonfinite
    fields.
  - evaluation metric detection.
  - Insights run-universe labeling.
- UI smoke:
  - seed new project with rank/eval/config data.
  - open `Distributed` and assert reducer, heatmap, outlier, and coverage render.
  - open `Insights` and assert grouped reducers, scatter, parallel coordinates,
    clusters, and eval cards render.
  - assert hidden tabs do not fetch rank summaries.
  - verify desktop and mobile layouts render without overlap.
- Benchmarks:
  - rank summary endpoint timing.
  - Insights helper timing over synthetic summaries.

## Documentation Plan

- `docs/architecture/current-api.md`
- `docs/architecture/current-schemas.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `packages/python-sdk/README.md`
- `docs/design/README.md`
- New example README if a seed example directory is added.

## Scale Dogfood

The SDK example remains the public-API proof path. For local volume testing,
`examples/rank-insights/scale-projects.mjs` seeds product-shaped ClickHouse rows
directly:

- three separate projects by default
- 2,000 runs per project
- two long rank-metric runs per project
- 10,000, 15,000, and 20,000 step profiles
- rank metrics over eight ranks with reducer, throughput, and grad-norm keys

This exists because the accepted first-slice SDK/API logs one rank-step batch at
a time. Direct bulk seeding lets the UI and summary endpoints be dogfooded at
millions of rows without introducing a new bulk ingest API before that path has
its own design.

## Alternatives Considered

- Encode rank as a metric-key suffix: rejected because it explodes key
  cardinality and hides reducer semantics.
- Add nullable `rank` columns to `metric_points`: rejected because scalar
  summaries and route compatibility would need a broader migration.
- Use `ReplacingMergeTree FINAL` for dedupe: rejected after review because
  deterministic latest-row selection must include a tie-breaker.
- Server-side Insights/K-means immediately: rejected because existing summaries
  can support a bounded exploratory first slice.

## Review Notes

Fresh reviewer 1:

- Finding: rank metrics bypass current usage accounting.
- Risk: large distributed jobs could store rank rows without plan guardrails.
- Recommended edit: count rank points toward `UsageDelta.metric_points` or add
  explicit rank usage fields.
- Decision: Accepted. Rank rows count as metric points in plan capacity and
  retained usage.

- Finding: `ReplacingMergeTree(created_at)` does not define deterministic
  latest-row semantics.
- Risk: duplicate replacement can be ambiguous.
- Recommended edit: canonicalize reads with `argMax(..., tuple(created_at,
  event_id))` or use monotonic versions.
- Decision: Accepted. Storage uses `MergeTree`; summary reads canonicalize with
  `argMax` over `(created_at, event_id)`.

- Finding: response bounds are unsafe.
- Risk: heatmaps can return `limit * world_size` cells.
- Recommended edit: cap world size, heatmap cells, outliers, and truncation
  metadata.
- Decision: Accepted.

- Finding: SDK spool idempotency does not cover `/rank-metrics`.
- Risk: process-spooled retries can duplicate events.
- Recommended edit: update uploader idempotency path checks and tests.
- Decision: Accepted.

Post-implementation Rust review:

- Finding: rank ingest ignored server-side `Idempotency-Key` even though the
  SDK uploader sent it.
- Decision: Accepted. Rank ingest now mirrors scalar metric idempotency.

- Finding: rank summary could materialize `limit * world_size` rows, up to
  millions under max settings.
- Decision: Accepted. Reads now compute observed world size, lower the effective
  step limit when needed, and apply a hard canonical-row limit.

- Finding: existing BYOC routes at schema version 1 would not receive
  `rank_metric_points`.
- Decision: Accepted. The metric schema version is now 2 and upgraded routes
  persist the new version after successful migration.

- Finding: the scale seeder could write directly to a remote `CLICKHOUSE_URL`.
- Decision: Accepted. The seeder refuses non-loopback ClickHouse by default and
  requires an explicit remote override.

- Finding: the UI sliced heatmap cells client-side after the backend reported
  no truncation.
- Decision: Accepted. The UI renders the full backend-bounded heatmap in a
  scrollable panel.

Fresh reviewer 2:

- Finding: first slice is over-scoped.
- Risk: shallow delivery for Insights/K-means/eval.
- Recommended edit: keep durable slice to rank metrics and label Insights as
  exploratory/local-only if included.
- Decision: Accepted. Backend scope is rank-only; Insights uses loaded summaries
  and visible run-universe labels.

- Finding: scatter/parallel coordinates need field semantics.
- Risk: ad hoc config extraction can mislead users.
- Recommended edit: defer or define exact first-slice field rules.
- Decision: Accepted. First slice flattens numeric dot paths only, excludes
  categorical/nonfinite fields, and reports skipped fields.

- Finding: rank heatmap bounds and dashboard placement are underspecified.
- Risk: browser freezes and navigation sprawl.
- Recommended edit: add heatmap cap/truncation and specify nav placement.
- Decision: Accepted. `Distributed` goes in core nav after Metrics; `Insights`
  goes in workspace nav with explicit data scope.

## Coverage Exceptions

None expected.

## Decision

Accepted for the revised implementation slice after addressing both fresh
reviewers' blocking issues.
