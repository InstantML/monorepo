# Run Search Local Benchmark

Date: 2026-05-26

Result: Passed local search budgets

## Context

- Branch: `codex/improve-search`
- Command:
  `INSTANTML_BENCH_RUNS=20000 INSTANTML_BENCH_SAMPLES=5 INSTANTML_BENCH_WARMUPS=1 INSTANTML_BENCH_ENFORCE=1 npm run benchmark:large-runs`
- Storage path: disposable local ClickHouse plus local Rust API
- Dataset: 20,000 synthetic runs, one 20,000-step selected run, four metric keys
- Protocol: one warmup and five measured samples per endpoint; nearest-rank p95

Fresh W&B hosted search was not run in this workspace because the `wandb`
package and W&B API credentials were unavailable. The comparison notes below
use the existing sanitized May 18 W&B public-API run in
`benchmarks/RESULTS.md`; treat that as directional context rather than a fresh
A/B against this local dataset.

## Results

| Case | p50 | p95 | Notes |
| --- | ---: | ---: | --- |
| Newest project page | 58 ms | 114 ms | 25-row summary page |
| Bare literal `seed-13` | 101 ms | 125 ms | legacy bare-text path |
| Exact tag `tag:seed-13` | 115 ms | 124 ms | exact tag match |
| Config `config:llm` | 122 ms | 139 ms | field-qualified text |
| Boolean notes | 101 ms | 106 ms | `(tag:seed-13 OR tag:seed-14) notes:stability` |
| Regex `re:/seed-(13\|14)/` | 313 ms | 372 ms | broad Rust regex scan |
| Metric-best sort | 81 ms | 97 ms | selected metric summary sort |
| Chart series | 97 ms | 112 ms | 5,000-point bounded chart read |

## W&B Context

The historical W&B public-API comparison in `benchmarks/RESULTS.md` measured
4,321 visible W&B runs after public API seeding hit rate limits. In that run,
W&B seed search p95 was 409 ms, newest 100 p95 was 408 ms, and metric-best sort
p95 was 305 ms. Those W&B numbers are not directly comparable to this local
20,000-run Rust benchmark, but they are useful directional context: the new
InstantML local search paths are comfortably sub-second, and the broad regex
case stayed in the same sub-second band as the historical W&B search result.
