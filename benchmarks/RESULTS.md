# Hosted Cloud Comparison Results

Latest update: `2026-05-23`

Current hosted storage now uses InstantML-owned self-hosted ClickHouse on Google
Cloud. The latest InstantML rerun measured Cloud Run direct to the GCP
ClickHouse VM against the `normal-runs-50k` showcase project: 50,000 runs and
522,000,000 metric points on `train/loss`. The run passed the current
read-path budgets; full sanitized details are in
`benchmarks/2026-05-23-gcp-clickhouse-cloud-run-results.md`.

Fresh W&B numbers were not collected on 2026-05-23 because this workspace had
no W&B package installed and no W&B API key or netrc auth. The W&B measurements
below remain the historical May 18 public API run and should be treated as
directional context, not a fresh A/B against the self-hosted GCP workload.

## Latest GCP ClickHouse Result

| Case | p95 | Notes |
| --- | ---: | --- |
| Org newest 100 | 325 ms | 70,029 org-wide runs visible during benchmark |
| Org metric-best sort | 272 ms | `train/loss` |
| Org overview | 414 ms | 570,162,046 org-wide metric points |
| Project newest 100 | 236 ms | `normal-runs-50k` |
| Project metric-best sort | 307 ms | 50,000-run project |
| Project overview | 418 ms | 522,000,000 project metric points |
| Single-run chart | 224 ms | 1,000 returned points from 20,000-step source series |

These results replace the ClickHouse Cloud hosted-path result as the current
InstantML beta operating signal. The closest historical ClickHouse Cloud result
used a different dataset shape, so compare it only directionally: the new GCP
project overview p95 is 418 ms versus roughly 2.9 s in the old project-overview
cases, while summary and chart reads remain within the same sub-second budget
class.

## Historical May 18 Report

Generated: `2026-05-18T19:18:43.230082Z`

This report compares the existing InstantML hosted Cloud Run benchmark against W&B hosted cloud using documented public APIs. No InstantML hosted ClickHouse seed command was run for this report.

## Dataset

- InstantML: `{"metric_key": "eval/return_mean", "observed_metric_points": 600000000, "observed_runs": 100000, "projects": ["hosted-scale-control", "hosted-scale-data"], "selection_search_query": "seed-13", "system_metric_key": "system/gpu_util"}`
- W&B: `{"configured_runs": 5001, "default_selected_run_count": 100, "expected_steps_per_run": 1000, "max_selected_run_count": 100, "metric_key": "eval/return_mean", "metric_keys": ["eval/return_mean", "eval/success_rate", "train/loss", "train/reward_mean", "system/cpu_percent", "system/gpu_util"], "search_selected_run_count": 20, "selection_search_query": "seed-13", "source_project_counts": {"hosted-scale-control": 2162, "hosted-scale-data": 2159}, "source_projects": ["hosted-scale-control", "hosted-scale-data"], "source_status_counts": {"failed": 22, "finished": 4160, "running": 139}}`

## Headline

- This is **not yet a full 1:1 100k W&B comparison**. InstantML was measured against the existing hosted `100,000` run / `600,000,000` metric-point dataset. W&B was measured against `4,321` visible seeded runs in the same schema because public W&B seeding hit `429 Too Many Requests` at 16 workers and then slowed in the four-worker retry tail.
- At the bounded W&B scale, newest/search/sort W&B public API timings were in the same broad range as InstantML hosted Cloud Run, and sometimes faster: newest 100 p95 `408 ms` W&B vs `480 ms` InstantML; seed search p95 `409 ms` W&B vs `606 ms` InstantML; metric-best sort p95 `305 ms` W&B vs `522 ms` InstantML.
- Chart reads are the clearer InstantML advantage in this run: InstantML `GET /runs/:id/metrics` returned 1,000 points at p95 `335 ms`; W&B `Run.history(samples=1000)` was p95 `675 ms`, and exact `Run.scan_history` had a p95 outlier at `5736 ms`.
- The W&B benchmark used `--no-include-length --no-hydrate-runs` for measured list cases after an earlier hydrated/counting pass spent too long in W&B Public API calls. InstantML measured full JSON route payloads from the deployed hosted API.
- The current tooling now supports a guarded exact W&B mode, but a true 100k x 1k-step x six-metric public-SDK seed is a large external workload. It should be run separately with a long window and conservative worker count.

## Seeding Notes

- W&B seed target: project `instantml-hosted-cloud-compare` under entity `instantml-ai-instantml`.
- W&B seed mode: `hybrid`, using public `Api.create_run` for summary/list rows and `wandb.init` for the one dedicated full-history chart run.
- W&B public API seeding observed `429 Too Many Requests` at 16 process workers. Four workers avoided immediate parent-level failure but remained slow enough that the run was stopped after 4,321 visible W&B runs.
- The stopped W&B seed left seven recorded rate-limit failures in local shard manifests; these manifests are ignored and not committed.
- InstantML was never seeded or mutated during this benchmark. The InstantML measurement is a read-only direct fallback because the checked-in Cloud Run benchmark validator expected a newer `projection=selection` response field than the currently deployed API returned.

## InstantML Measurements

| Case | Kind | p50 | p95 | Min | Max | Rows/Stats | Caveat |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `org_newest_25` | summary | 401 ms | 404 ms | 312 ms | 404 ms | 25 |  |
| `org_newest_100_default_page` | summary | 392 ms | 480 ms | 390 ms | 480 ms | 100 |  |
| `org_search_hosted_scale` | summary | 387 ms | 452 ms | 354 ms | 452 ms | 25 |  |
| `org_search_seed_13` | summary | 413 ms | 606 ms | 348 ms | 606 ms | 25 |  |
| `org_sort_metric_best` | summary | 507 ms | 522 ms | 502 ms | 522 ms | 25 |  |
| `org_overview` | overview | 403 ms | 410 ms | 289 ms | 410 ms | 100000 |  |
| `hosted_scale_control_newest_25` | summary | 349 ms | 371 ms | 277 ms | 371 ms | 25 |  |
| `hosted_scale_control_newest_100` | summary | 413 ms | 563 ms | 383 ms | 563 ms | 100 |  |
| `hosted_scale_control_search_latest_name` | summary | 410 ms | 412 ms | 352 ms | 412 ms | 1 |  |
| `hosted_scale_control_search_project_tag` | summary | 329 ms | 402 ms | 323 ms | 402 ms | 25 |  |
| `hosted_scale_control_search_config_transformer` | summary | 353 ms | 366 ms | 320 ms | 366 ms | 25 |  |
| `hosted_scale_control_search_notes_scale_validation` | summary | 343 ms | 549 ms | 315 ms | 549 ms | 25 |  |
| `hosted_scale_control_filter_failed` | summary | 324 ms | 383 ms | 323 ms | 383 ms | 25 |  |
| `hosted_scale_control_filter_running` | summary | 324 ms | 359 ms | 323 ms | 359 ms | 25 |  |
| `hosted_scale_control_filter_finished` | summary | 497 ms | 609 ms | 484 ms | 609 ms | 25 |  |
| `hosted_scale_control_filter_finished_config` | summary | 415 ms | 417 ms | 409 ms | 417 ms | 25 |  |
| `hosted_scale_control_sort_metric_best` | summary | 473 ms | 508 ms | 437 ms | 508 ms | 25 |  |
| `hosted_scale_control_overview` | overview | 3042 ms | 3057 ms | 3013 ms | 3057 ms | 50000 |  |
| `hosted_scale_data_newest_25` | summary | 324 ms | 325 ms | 312 ms | 325 ms | 25 |  |
| `hosted_scale_data_newest_100` | summary | 427 ms | 434 ms | 419 ms | 434 ms | 100 |  |
| `hosted_scale_data_search_latest_name` | summary | 322 ms | 408 ms | 317 ms | 408 ms | 1 |  |
| `hosted_scale_data_search_project_tag` | summary | 327 ms | 433 ms | 318 ms | 433 ms | 25 |  |
| `hosted_scale_data_search_config_transformer` | summary | 414 ms | 480 ms | 317 ms | 480 ms | 25 |  |
| `hosted_scale_data_search_notes_scale_validation` | summary | 454 ms | 688 ms | 327 ms | 688 ms | 25 |  |
| `hosted_scale_data_filter_failed` | summary | 374 ms | 418 ms | 342 ms | 418 ms | 25 |  |
| `hosted_scale_data_filter_running` | summary | 322 ms | 386 ms | 308 ms | 386 ms | 25 |  |
| `hosted_scale_data_filter_finished` | summary | 359 ms | 442 ms | 309 ms | 442 ms | 25 |  |
| `hosted_scale_data_filter_finished_config` | summary | 398 ms | 408 ms | 369 ms | 408 ms | 25 |  |
| `hosted_scale_data_sort_metric_best` | summary | 491 ms | 543 ms | 411 ms | 543 ms | 25 |  |
| `hosted_scale_data_overview` | overview | 3141 ms | 3145 ms | 3137 ms | 3145 ms | 50000 |  |
| `chart_eval_return` | chart | 312 ms | 335 ms | 306 ms | 335 ms | 1000 |  |
| `chart_system_metric` | chart | 305 ms | 312 ms | 299 ms | 312 ms | 1000 |  |

## W&B Measurements

| Case | Kind | p50 | p95 | Min | Max | Rows/Stats | Caveat |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `wandb_newest_25` | summary | 305 ms | 323 ms | 231 ms | 323 ms | 25 |  |
| `wandb_newest_100_default_page` | summary | 386 ms | 408 ms | 300 ms | 408 ms | 100 |  |
| `wandb_search_hosted_scale` | summary | 251 ms | 310 ms | 221 ms | 310 ms | 25 |  |
| `wandb_search_seed_13` | summary | 312 ms | 409 ms | 307 ms | 409 ms | 25 |  |
| `wandb_sort_metric_best_exact_key` | summary | 291 ms | 305 ms | 222 ms | 305 ms | 25 |  |
| `wandb_sort_metric_best_alias` | summary | 309 ms | 320 ms | 190 ms | 320 ms | 25 | alias metric because some W&B public API paths do not sort slash keys consistently |
| `wandb_default_selection_100` | summary | 328 ms | 377 ms | 318 ms | 377 ms | 100 |  |
| `wandb_max_selection_page_1` | summary | 2183 ms | 2251 ms | 2069 ms | 2251 ms | 1000 |  |
| `wandb_search_seed_13_selection` | summary | 247 ms | 256 ms | 241 ms | 256 ms | 20 |  |
| `wandb_derived_overview` | overview | 900 ms | 5823 ms | 744 ms | 5823 ms | 4321 | derived from multiple W&B count queries |
| `wandb_chart_eval_return_history` | chart | 509 ms | 675 ms | 354 ms | 675 ms | 1000 |  |
| `wandb_chart_eval_return_scan_history` | chart | 921 ms | 5736 ms | 820 ms | 5736 ms | 1000 | exact scan is not the same sampled surface W&B charts normally use |
| `hosted_scale_control_newest_25` | summary | 251 ms | 255 ms | 248 ms | 255 ms | 25 |  |
| `hosted_scale_control_newest_100` | summary | 363 ms | 435 ms | 328 ms | 435 ms | 100 |  |
| `hosted_scale_control_search_project_tag` | summary | 402 ms | 403 ms | 219 ms | 403 ms | 25 |  |
| `hosted_scale_control_search_config_transformer` | summary | 217 ms | 218 ms | 202 ms | 218 ms | 25 |  |
| `hosted_scale_control_search_notes_scale_validation_mirror` | summary | 325 ms | 355 ms | 214 ms | 355 ms | 25 | notes search uses mirrored config field |
| `hosted_scale_control_filter_failed_source_status` | summary | 248 ms | 313 ms | 184 ms | 313 ms | 11 | source status mirror |
| `hosted_scale_control_filter_running_source_status` | summary | 414 ms | 3278 ms | 317 ms | 3278 ms | 25 | source status mirror |
| `hosted_scale_control_filter_finished_source_status` | summary | 218 ms | 378 ms | 209 ms | 378 ms | 25 | source status mirror |
| `hosted_scale_data_newest_25` | summary | 234 ms | 253 ms | 221 ms | 253 ms | 25 |  |
| `hosted_scale_data_newest_100` | summary | 410 ms | 413 ms | 408 ms | 413 ms | 100 |  |
| `hosted_scale_data_search_project_tag` | summary | 307 ms | 696 ms | 206 ms | 696 ms | 25 |  |
| `hosted_scale_data_search_config_transformer` | summary | 307 ms | 309 ms | 212 ms | 309 ms | 25 |  |
| `hosted_scale_data_search_notes_scale_validation_mirror` | summary | 214 ms | 242 ms | 201 ms | 242 ms | 25 | notes search uses mirrored config field |
| `hosted_scale_data_filter_failed_source_status` | summary | 172 ms | 173 ms | 165 ms | 173 ms | 11 | source status mirror |
| `hosted_scale_data_filter_running_source_status` | summary | 315 ms | 410 ms | 198 ms | 410 ms | 25 | source status mirror |
| `hosted_scale_data_filter_finished_source_status` | summary | 314 ms | 2118 ms | 219 ms | 2118 ms | 25 | source status mirror |

## Caveats

- W&B timings use public SDK/Public API surfaces, not private GraphQL documents.
- W&B project/status/notes equivalents use mirrored config and tags where W&B has no documented matching top-level route.
- Exact W&B full-history parity for 100,000 runs x 1,000 steps x six metrics is supported by the seed tool but is intentionally guarded because it is a 600M-scalar external workload.
- InstantML data in this report is read-only from the existing hosted Cloud Run benchmark path.
