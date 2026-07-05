# Local Public-Scale Benchmark Results

Date: 2026-07-03

Branch: `codex/performance-audit-optimization`

## Scope

This result records disposable local Rust API plus ClickHouse benchmark evidence
for public scale dimensions that are not covered by the hosted Cloud Run result:
10,000 runs/project, 500,000 metric steps/run, and 100,000 metric keys/project.
It also records a focused SDK producer-throughput run for the W&B scalar-value
throughput gate.

These are local benchmark results on `darwin arm64` (`MacBookAir`), not hosted
Cloud Run latency claims. Use the Cloud Run benchmark for deployed request-path
latency.

Public target sources rechecked on 2026-07-03:

- W&B logging-at-scale guidance: `https://docs.wandb.ai/models/track/limits`
- Neptune app claim: `https://docs.neptune.ai/about`

## Rust Large-Run Command

```bash
INSTANTML_BENCH_RUNS=10000 \
INSTANTML_BENCH_LONG_RUN_STEPS=500000 \
INSTANTML_BENCH_WIDE_METRIC_KEYS=100000 \
INSTANTML_BENCH_SAMPLES=1 \
INSTANTML_BENCH_WARMUPS=1 \
node tools/rust-large-run-benchmark.mjs > /tmp/instantml-large-cardinality-100k.json
```

## Rust Large-Run Dataset

| Dimension | Observed |
| --- | ---: |
| Runs | 10,000 |
| Steps on newest long run | 500,000 |
| Metric keys/project | 100,004 |
| Extra wide metric keys | 100,000 |

## Rust Large-Run Measurements

| Measurement | p95 ms | Budget ms |
| --- | ---: | ---: |
| `summary_newest_project` | 15 | 300 |
| `summary_newest_org` | 18 | 300 |
| `summary_search_seed_13` | 13 | 500 |
| `summary_search_tag_seed_13` | 14 | 750 |
| `summary_search_config_llm` | 27 | 750 |
| `summary_search_boolean_notes` | 15 | 750 |
| `summary_search_regex_seed` | 18 | 750 |
| `summary_sort_metric_best` | 31 | 500 |
| `chart_series` | 177 | 200 |
| `batched_series_m4` | 47 | 250 |
| `metric_catalog_100000` | 3,834 | 5,000 |

Result: passed local budgets with no failures.

Competitive gate summary for this payload:

- Pass: W&B runs/project, W&B steps/run, W&B metric cardinality/project,
  Neptune metric-scale seconds, internal benchmark budgets.
- Not measured in this payload: SDK ingest throughput and historical hosted W&B
  read-route aliases.
- Fail: none.

## SDK Producer Command

```bash
python3 benchmarks/sdk_logging_overhead.py run \
  --cases noop,instantml-async-queue \
  --steps 2000 \
  --metrics-per-log 6 \
  --samples 3 \
  --warmup-logs 100 \
  --output-json /tmp/instantml-sdk-ingest-current.json \
  --output-markdown /tmp/instantml-sdk-ingest-current.md
```

## SDK Producer Measurement

| Measurement | Observed |
| --- | ---: |
| `instantml-async-queue` producer rows/minute | 2,968,276 |
| `instantml-async-queue` producer scalar values/minute | 17,809,659 |
| W&B published scalar throughput guidance | 100,000 values/minute |

Result: passed the W&B scalar throughput gate. This is SDK hot-loop
producer-return throughput, not hosted remote-persistence throughput.
