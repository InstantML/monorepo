# Hosted Cloud Run API Benchmark

Date: 2026-05-16

Result: Failed current budgets

Historical note: this result was collected before the hosted migration to
InstantML-owned self-hosted ClickHouse on Google Cloud. Current hosted
benchmarks should describe the path as Cloud Run -> self-hosted GCP ClickHouse
unless intentionally testing a legacy provider-backed route.

## Context

- Branch: `codex/multi-instance-architecture`
- Script git metadata at run time: `5475cf4eb160579e603a0f9561f4935017661a29`
- API mode: `cloud-run-direct`
- API host: `instantml-data-us-central1-a-hfv667633q-uc.a.run.app`
- API transport: `https`
- Node: `v21.7.1`
- Client platform: `darwin arm64`

This historical benchmark measured the deployed hosted request path at that time: benchmark client -> Cloud Run data service -> ClickHouse Cloud tenant. It did not start a local Rust or ClickHouse service.

## Dataset

- Projects: `hosted-scale-control`, `hosted-scale-data`
- Observed runs: `100000`
- Observed metric points: `600000000`
- Expected steps per run/key: `1000`
- Selected runs for batched series: `8`
- Chart limit: `1000`
- Primary metric: `eval/return_mean`
- System metric: `system/cpu_percent`
- Metric keys: `eval/return_mean`, `eval/success_rate`, `system/cpu_percent`, `system/gpu_util`, `train/loss`, `train/reward_mean`
- Status counts: `96283 finished`, `3209 running`, `508 failed`

## Protocol

- Warmups per endpoint: `2`
- Measured samples per endpoint: `8`
- p95 method: nearest-rank over measured samples
- Endpoint order: fixed
- Validation: every measured request was a 2xx JSON response with the expected bounded shape and non-empty known-result cases.

## Results

| Endpoint Case | Kind | Rows/Total | p50 | p95 | Min | Max | Budget | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `org_newest_25` | summary | 25 / 100000 | 142 ms | 145 ms | 140 ms | 145 ms | 750 ms | Pass |
| `org_search_hosted_scale` | summary | 25 / 100000 | 182 ms | 308 ms | 174 ms | 308 ms | 1000 ms | Pass |
| `org_search_seed_13` | summary | 25 / 1000 | 189 ms | 307 ms | 181 ms | 307 ms | 1000 ms | Pass |
| `org_sort_metric_best` | summary | 25 / 100000 | 270 ms | 318 ms | 227 ms | 318 ms | 1000 ms | Pass |
| `org_overview` | overview | 100000 runs / 600000000 points | 152 ms | 156 ms | 149 ms | 156 ms | 1000 ms | Pass |
| `hosted_scale_control_newest_25` | summary | 25 / 50000 | 139 ms | 147 ms | 130 ms | 147 ms | 750 ms | Pass |
| `hosted_scale_control_newest_100` | summary | 100 / 50000 | 162 ms | 184 ms | 145 ms | 184 ms | 750 ms | Pass |
| `hosted_scale_control_search_latest_name` | summary | 1 / 1 | 192 ms | 306 ms | 177 ms | 306 ms | 1000 ms | Pass |
| `hosted_scale_control_search_project_tag` | summary | 25 / 50000 | 171 ms | 258 ms | 162 ms | 258 ms | 1000 ms | Pass |
| `hosted_scale_control_search_config_transformer` | summary | 25 / 10000 | 156 ms | 176 ms | 154 ms | 176 ms | 1000 ms | Pass |
| `hosted_scale_control_search_notes_scale_validation` | summary | 25 / 50000 | 164 ms | 240 ms | 159 ms | 240 ms | 1000 ms | Pass |
| `hosted_scale_control_filter_failed` | summary | 25 / 254 | 153 ms | 250 ms | 150 ms | 250 ms | 1000 ms | Pass |
| `hosted_scale_control_filter_running` | summary | 25 / 1604 | 146 ms | 201 ms | 140 ms | 201 ms | 1000 ms | Pass |
| `hosted_scale_control_filter_finished` | summary | 25 / 48142 | 150 ms | 273 ms | 147 ms | 273 ms | 1000 ms | Pass |
| `hosted_scale_control_filter_finished_config` | summary | 25 / 9628 | 169 ms | 250 ms | 161 ms | 250 ms | 1000 ms | Pass |
| `hosted_scale_control_sort_metric_best` | summary | 25 / 50000 | 286 ms | 332 ms | 220 ms | 332 ms | 1000 ms | Pass |
| `hosted_scale_control_overview` | overview | 50000 runs / 300000000 points | 2751 ms | 2933 ms | 2730 ms | 2933 ms | 1000 ms | Fail |
| `hosted_scale_control_cursor_page_2` | summary | 25 / 50000 | 138 ms | 151 ms | 133 ms | 151 ms | 750 ms | Pass |
| `hosted_scale_data_newest_25` | summary | 25 / 50000 | 142 ms | 215 ms | 133 ms | 215 ms | 750 ms | Pass |
| `hosted_scale_data_newest_100` | summary | 100 / 50000 | 152 ms | 164 ms | 142 ms | 164 ms | 750 ms | Pass |
| `hosted_scale_data_search_latest_name` | summary | 1 / 1 | 206 ms | 308 ms | 177 ms | 308 ms | 1000 ms | Pass |
| `hosted_scale_data_search_project_tag` | summary | 25 / 50000 | 151 ms | 160 ms | 146 ms | 160 ms | 1000 ms | Pass |
| `hosted_scale_data_search_config_transformer` | summary | 25 / 10000 | 154 ms | 158 ms | 151 ms | 158 ms | 1000 ms | Pass |
| `hosted_scale_data_search_notes_scale_validation` | summary | 25 / 50000 | 160 ms | 253 ms | 151 ms | 253 ms | 1000 ms | Pass |
| `hosted_scale_data_filter_failed` | summary | 25 / 254 | 140 ms | 144 ms | 136 ms | 144 ms | 1000 ms | Pass |
| `hosted_scale_data_filter_running` | summary | 25 / 1605 | 134 ms | 151 ms | 132 ms | 151 ms | 1000 ms | Pass |
| `hosted_scale_data_filter_finished` | summary | 25 / 48141 | 141 ms | 153 ms | 137 ms | 153 ms | 1000 ms | Pass |
| `hosted_scale_data_filter_finished_config` | summary | 25 / 9628 | 159 ms | 169 ms | 154 ms | 169 ms | 1000 ms | Pass |
| `hosted_scale_data_sort_metric_best` | summary | 25 / 50000 | 285 ms | 306 ms | 216 ms | 306 ms | 1000 ms | Pass |
| `hosted_scale_data_overview` | overview | 50000 runs / 300000000 points | 2778 ms | 2879 ms | 2729 ms | 2879 ms | 1000 ms | Fail |
| `hosted_scale_data_cursor_page_2` | summary | 25 / 50000 | 141 ms | 144 ms | 137 ms | 144 ms | 750 ms | Pass |
| `chart_eval_return` | chart | 1000 points | 107 ms | 124 ms | 100 ms | 124 ms | 750 ms | Pass |
| `chart_system_metric` | chart | 1000 points | 105 ms | 114 ms | 102 ms | 114 ms | 750 ms | Pass |
| `batched_series_eval_return_selected_runs` | batched_series | 8 series / 8000 points | 173 ms | 189 ms | 170 ms | 189 ms | 750 ms | Pass |
| `batched_series_system_window` | batched_series | 8 series / 2000 points | 115 ms | 120 ms | 110 ms | 120 ms | 750 ms | Pass |

## Budget Notes

Current budget failures:

- hosted_scale_control_overview p95 2933ms exceeded 1000ms
- hosted_scale_data_overview p95 2879ms exceeded 1000ms

All run summary, search, status filter, selected metric sort, org overview, single-run chart, and batched selected-run series cases passed their current budgets. The misses are project-scoped overview calls over 50,000-run projects with 300,000,000 metric points each.

## Operational Notes

- The first live attempt failed because local `.env` contained a stale API key after User Data had been emptied. API keys are stored as hashes and plaintext cannot be recovered from ClickHouse.
- The InstantML org was recreated for `instantml.ai@gmail.com`, a new API key was minted, the accidentally printed key was revoked, and the replacement key was stored only in local ignored env/temp storage.
- The 100,000-run hosted-scale seed used the new ClickHouse tenant service and verified 600,000,000 metric points before this benchmark ran.
- The data-plane Cloud Run service was restarted after direct ClickHouse seeding so its in-memory tenant projection replayed the new operational records.
