# Self-Hosted GCP ClickHouse Cloud Run Benchmark

Date: 2026-05-23

Result: Passed current read-path budgets

## Context

- Script git metadata at run time: `6d9da3db37ce43fd056275585b25f7980a8b41ab`
- API mode: `hosted-api-direct`
- API host: `instantml-data-us-central1-a-hfv667633q-uc.a.run.app`
- API transport: `https`
- Storage path: Cloud Run data service -> self-hosted GCP ClickHouse VM
- Benchmark account/workspace: `instantml.ai@gmail.com` / `InstantML Warehouse`

This benchmark supersedes the May 16 ClickHouse Cloud result as the current
hosted-path read signal. It did not seed or mutate run data. A temporary
read/usage-scoped API key was inserted into User Data for the benchmark and
revoked after the run.

## Dataset

- Project: `normal-runs-50k`
- Observed project runs: `50000`
- Observed project metric points: `522000000`
- Org-wide read surface during org-scoped cases: `70029` runs /
  `570162046` metric points
- Primary metric: `train/loss`
- Chart metric: `train/loss`
- Showcase coverage in the same workspace:
  - `normal-runs-50k`: normal high-scale run table and charts
  - `hard-intensive-runs`: 10 dense runs with 100+ metric keys
  - `distributed-runs`: distributed/rank and system/loss data
  - `artifact-runs`: artifact metadata plus R2 object storage

## Protocol

- Warmups per endpoint: `2`
- Measured samples per endpoint: `8`
- p95 method: nearest-rank over measured samples
- Endpoint order: fixed
- Runner: `benchmarks/wandb_hosted_compare.py benchmark-instantml --direct`
  direct fallback. The direct fallback records observed rows but does not enforce
  `INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS`; the result was accepted because the
  visible `normal-runs-50k` and org-wide counts matched the showcase dataset.

## Results

| Endpoint Case | Kind | Rows/Total | p50 | p95 | Min | Max | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `org_newest_25` | summary | 25 / 70029 | 199 ms | 207 ms | 192 ms | 207 ms | Pass |
| `org_newest_100_default_page` | summary | 100 / 70029 | 272 ms | 325 ms | 236 ms | 325 ms | Pass |
| `org_search_hosted_scale` | summary | 25 / 20000 | 241 ms | 250 ms | 211 ms | 250 ms | Pass |
| `org_search_seed_13` | summary | 25 / 700 | 221 ms | 240 ms | 196 ms | 240 ms | Pass |
| `org_sort_metric_best` | summary | 25 / 70029 | 253 ms | 272 ms | 245 ms | 272 ms | Pass |
| `org_overview` | overview | 70029 runs / 570162046 points | 264 ms | 414 ms | 248 ms | 414 ms | Pass |
| `normal_runs_50k_newest_25` | summary | 25 / 50000 | 168 ms | 191 ms | 159 ms | 191 ms | Pass |
| `normal_runs_50k_newest_100` | summary | 100 / 50000 | 215 ms | 236 ms | 187 ms | 236 ms | Pass |
| `normal_runs_50k_search_latest_name` | summary | 1 / 1 | 198 ms | 551 ms | 192 ms | 551 ms | Pass |
| `normal_runs_50k_search_project_tag` | summary | 25 / 50000 | 183 ms | 224 ms | 171 ms | 224 ms | Pass |
| `normal_runs_50k_search_config_transformer` | summary | 0 / 0 | 182 ms | 215 ms | 174 ms | 215 ms | Not exercised |
| `normal_runs_50k_search_notes_scale_validation` | summary | 0 / 0 | 180 ms | 211 ms | 168 ms | 211 ms | Not exercised |
| `normal_runs_50k_filter_failed` | summary | 25 / 237 | 154 ms | 169 ms | 146 ms | 169 ms | Pass |
| `normal_runs_50k_filter_running` | summary | 25 / 1157 | 159 ms | 170 ms | 152 ms | 170 ms | Pass |
| `normal_runs_50k_filter_finished` | summary | 25 / 48606 | 171 ms | 478 ms | 170 ms | 478 ms | Pass |
| `normal_runs_50k_filter_finished_config` | summary | 0 / 0 | 179 ms | 205 ms | 176 ms | 205 ms | Not exercised |
| `normal_runs_50k_sort_metric_best` | summary | 25 / 50000 | 262 ms | 307 ms | 251 ms | 307 ms | Pass |
| `normal_runs_50k_overview` | overview | 50000 runs / 522000000 points | 403 ms | 418 ms | 365 ms | 418 ms | Pass |
| `chart_eval_return` | chart | 1000 points | 191 ms | 224 ms | 152 ms | 224 ms | Pass |
| `chart_system_metric` | chart | 1000 points | 189 ms | 216 ms | 153 ms | 216 ms | Pass |

## Comparison Notes

- Compared with the May 16 ClickHouse Cloud Cloud Run result, this GCP run uses
  a different dataset shape: one 50,000-run / 522M-point project with 20,000
  steps per run rather than two 50,000-run / 300M-point projects with 1,000
  steps per run. Treat the comparison as directional, not a clean A/B.
- The new GCP project overview p95 is `418 ms`, materially below the old
  ClickHouse Cloud project-overview p95s of roughly `2.9 s` that missed budget.
- Summary/search/sort requests remain comfortably below the current
  `750-1000 ms` budgets. Single-run chart reads over a 20,000-step source
  series are `224 ms` p95 for a 1,000-point response.
- The `normal-runs-50k` config and notes search rows returned zero matches, so
  they are recorded for transparency but should not be used as evidence for
  search coverage. Use the local run-search benchmark and the nonzero
  `org_search_*` / tag rows for search-path evidence until the showcase dataset
  includes matching config and notes fixtures.
- W&B was not rerun on this machine because the W&B package was not installed
  and no W&B API key or netrc auth was present. Historical W&B public API
  numbers from May 18 remain useful only as directional context.

## Path Forward

The self-hosted GCP ClickHouse deployment is the preferred beta hosted path.
The measured read latencies are good enough for the current showcase workload,
and the cost basis should be more predictable than ClickHouse Cloud for
InstantML-owned hosted storage. The tradeoff is operational: before public
paid launch, add backups/snapshot restore tests, disk and memory alerts, table
size monitoring, and a high-availability decision for customers that need a
stronger uptime posture.
