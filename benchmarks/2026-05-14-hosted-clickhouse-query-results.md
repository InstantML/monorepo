# Hosted ClickHouse Query Benchmark

Date: 2026-05-14

Result: Passed

Historical note: this result was collected against a ClickHouse Cloud tenant
before the hosted migration to InstantML-owned self-hosted ClickHouse on Google
Cloud. Keep it as dated evidence, not as the current hosted storage topology.

## Context

- Branch: `codex/clickhouse-query-benchmarks`
- Script git metadata at run time: `b8892f47ce58c544b8d0230349515b60c3fe73dd`
- API mode: temporary Rust server, warmed before timing
- Node: `v21.7.1`
- Client platform: `darwin arm64`
- Tenant route: `cloud-service`
- ClickHouse host: `yg9ji6sw2t.us-east-1.aws.clickhouse.cloud:8443`
- ClickHouse location: `aws us-east-1`

The script records the current commit before this result file is committed, so the SHA above identifies the stacked branch base plus the working-tree benchmark changes exercised by this run.

## Dataset

- Project: `instantml-demo-100k`
- Runs: `100000`
- Metric points: `180000`
- Long-run steps: `20000`
- Primary metric: `eval/return_mean`
- Status counts: `89973 finished`, `8997 running`, `1030 failed`

## Protocol

- Warmups per endpoint: `2`
- Measured samples per endpoint: `8`
- p95 method: nearest-rank over measured samples
- Endpoint order: fixed
- Validation: every measured request was a 2xx JSON response with the expected bounded shape and non-empty known-result cases.

## Results

| Endpoint Case | Rows/Total | p50 | p95 | Min | Max | Budget | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `runs_newest_25` | 25 / 100000 | 374 ms | 378 ms | 368 ms | 378 ms | 750 ms | Pass |
| `runs_newest_100` | 100 / 100000 | 384 ms | 413 ms | 377 ms | 413 ms | 750 ms | Pass |
| `search_name_latest_run` | 1 / 1 | 788 ms | 810 ms | 784 ms | 810 ms | 1000 ms | Pass |
| `search_seed_13` | 25 / 9617 | 562 ms | 581 ms | 556 ms | 581 ms | 1000 ms | Pass |
| `search_tag_config_llm` | 25 / 33333 | 503 ms | 512 ms | 498 ms | 512 ms | 1000 ms | Pass |
| `search_notes_reward_stability` | 25 / 100000 | 663 ms | 733 ms | 656 ms | 733 ms | 1000 ms | Pass |
| `filter_failed` | 25 / 1030 | 346 ms | 353 ms | 339 ms | 353 ms | 1000 ms | Pass |
| `filter_running` | 25 / 8997 | 345 ms | 424 ms | 325 ms | 424 ms | 1000 ms | Pass |
| `filter_finished` | 25 / 89973 | 367 ms | 394 ms | 358 ms | 394 ms | 1000 ms | Pass |
| `filter_finished_notes` | 25 / 89973 | 633 ms | 650 ms | 621 ms | 650 ms | 1000 ms | Pass |
| `sort_metric_best` | 25 / 100000 | 623 ms | 639 ms | 538 ms | 639 ms | 1000 ms | Pass |
| `overview_project` | 100000 runs / 180000 points | 469 ms | 475 ms | 440 ms | 475 ms | 1000 ms | Pass |
| `chart_eval_return_5000` | 5000 points | 189 ms | 197 ms | 186 ms | 197 ms | 750 ms | Pass |

## Optimization Notes

The first full hosted pass exposed two misses:

- Broad notes search p95 was `1024 ms`, barely above the `1000 ms` search/filter budget.
- Project overview p95 was `5281 ms`, because it counted project metric points through many run-id chunks.

This PR keeps the API contract unchanged and applies two narrow fixes:

- Created-sort summary pages now use the existing created index for text/status filtered pages, with exact status and precomputed search-text matching.
- Project overview now asks ClickHouse for project-scoped top metric and point-count aggregates directly instead of issuing many chunked run-id queries.

After those changes, all hosted p95s passed the documented budgets.
