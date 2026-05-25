# Benchmarks

Benchmark result summaries live here when they are useful for product or performance decisions. Keep committed reports sanitized: no ClickHouse credentials, raw endpoint URLs, cookies, API keys, org IDs, user IDs, or signed artifact URLs.

## Hosted ClickHouse Query Benchmark

Use the hosted demo script from the repo root:

```bash
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 \
INSTANTML_HOSTED_DEMO_RESULT_PATH=/tmp/instantml-hosted-clickhouse-query-benchmark.json \
npm run benchmark:hosted-demo
```

The script signs in as the shared `hello@instantml.ai` demo account, reuses the existing tenant route when present, verifies the 100,000-run project seed, warms each route, then measures the dashboard query shapes documented in `docs/design/2026-05-14-hosted-clickhouse-query-benchmarks.md`. Current hosted benchmark routes should point at the self-hosted GCP ClickHouse deployment unless a legacy provider-backed route is being tested intentionally.

The committed Markdown summaries should include:

- commit and branch tested
- project and dataset sizes
- warmup/sample counts
- ClickHouse deployment type/provider, region, and endpoint host only
- p50/p95/min/max per endpoint
- whether hosted budgets passed

Do not commit the optional JSON output unless it has been reviewed for the same sanitization rules.

## Hosted Cloud Run API Benchmark

Use the Cloud Run benchmark after the hosted-scale tenant has already been
seeded:

```bash
INSTANTML_API_KEY=instantml_... \
INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH=/tmp/instantml-cloud-run-benchmark.json \
npm run benchmark:cloud-run
```

This is now the preferred hosted backend latency signal because it measures the
actual deployed request path: benchmark client -> Cloud Run data service or
HTTPS router -> self-hosted GCP ClickHouse tenant database. It assumes `INSTANTML_DATA_API_BASE` or
`INSTANTML_API_BASE` points at the hosted API and validates at least 100,000
runs across the configured benchmark projects before timing requests.

Committed summaries for this benchmark should include the same sanitized fields
as the hosted ClickHouse benchmark plus the API host only, never full URLs or API
keys.

The latest current-path result is
`benchmarks/2026-05-23-gcp-clickhouse-cloud-run-results.md`: Cloud Run direct to
self-hosted GCP ClickHouse, reading the `normal-runs-50k` project with 50,000
runs and 522,000,000 metric points. It passed the current read-path budgets.

For the GCP self-hosted showcase workload, run the read-only direct benchmark
with a short-lived API key:

```bash
INSTANTML_API_KEY=instantml_... \
INSTANTML_API_BASE=https://instantml-data-us-central1-a-hfv667633q-uc.a.run.app \
INSTANTML_CLOUD_RUN_BENCH_PROJECTS=normal-runs-50k \
INSTANTML_CLOUD_RUN_BENCH_METRIC_KEY=train/loss \
INSTANTML_CLOUD_RUN_BENCH_SYSTEM_METRIC_KEY=train/loss \
python3 benchmarks/wandb_hosted_compare.py benchmark-instantml \
  --direct \
  --samples 8 \
  --warmups 2 \
  --output /tmp/instantml-gcp-clickhouse-result.json
```

Do not commit the API key or raw JSON unless it has been reviewed for
sanitization. If a one-off benchmark key is inserted directly into User Data,
append a revoked `api_key` control record immediately after the benchmark.

## W&B Hosted Comparison Benchmark

`wandb_hosted_compare.py` seeds and benchmarks W&B hosted cloud through the
documented W&B Python SDK/Public API, then renders `benchmarks/RESULTS.md`.
It is intentionally guarded because W&B seeding creates external hosted data and
can incur W&B costs. It never seeds InstantML hosted ClickHouse; the InstantML
subcommand only runs the existing read-only Cloud Run benchmark.

Install the W&B dependency into the repo virtualenv:

```bash
.venv/bin/python -m pip install -r benchmarks/requirements-wandb.txt
```

Run a small W&B smoke seed:

```bash
INSTANTML_WANDB_BENCH_ALLOW_UPLOAD=1 \
.venv/bin/python benchmarks/wandb_hosted_compare.py seed-wandb \
  --runs 100 --steps 20 --history-mode newest --history-newest-runs 5
```

Parallelize seeding with disjoint process-level shards:

```bash
INSTANTML_WANDB_BENCH_ALLOW_UPLOAD=1 \
.venv/bin/python benchmarks/wandb_hosted_compare.py seed-wandb-parallel \
  --runs 1000 --steps 1000 --history-mode none --workers 8
```

`seed-wandb-parallel` splits the run-index range into independent child
processes and writes one manifest per shard. This is safer than threading one
W&B SDK process because each shard owns disjoint run IDs and its own SDK
process. Keep worker counts conservative and watch for W&B `429`/rate-limit
failures in `wandb-parallel-seed-result.json`.

The default `--seed-mode hybrid` uses W&B's public `Api.create_run` path for
summary/list rows and normal `wandb.init` only for runs that need full metric
history. This is faster than `wandb.init` for every run, but W&B-created
summary-only runs remain in W&B's `running` state; benchmark status filters use
the mirrored `config.instantml_source_status` field and the report calls that
out. Use `--seed-mode init` when actual W&B finished/failed states matter more
than seeding speed.

Run W&B read benchmarks:

```bash
.venv/bin/python benchmarks/wandb_hosted_compare.py benchmark-wandb \
  --runs 100 --steps 20 --samples 3 --warmups 1
```

As of the 2026-05-23 GCP ClickHouse benchmark rerun, this workspace did not
have the W&B package installed and had no W&B API key or netrc auth, so W&B was
not rerun. Keep that caveat in any report that compares the new GCP numbers to
the historical W&B measurements in `benchmarks/RESULTS.md`.

Run the InstantML read-only hosted benchmark when the hosted-scale dataset
already exists:

```bash
.venv/bin/python benchmarks/wandb_hosted_compare.py benchmark-instantml
```

Render the comparison report:

```bash
.venv/bin/python benchmarks/wandb_hosted_compare.py render-results
```

For the full W&B exact-history dataset, explicitly set `--runs 100000
--steps 1000 --history-mode exact --allow --allow-exact`. That mode logs
100 million W&B history rows and 600 million scalar values through public SDK
calls, so use it only when you intentionally want that external workload. A
summary/list-fidelity run can seed one summary row per run with
`--history-mode none`; bounded chart fidelity can seed selected full-history
runs with `--history-mode newest` or `--history-mode dashboard`.

## SDK Logging Overhead Benchmark

`sdk_logging_overhead.py` measures foreground scalar logging overhead, not hosted
read/query latency. It runs each case in a fresh Python process, compares
against a no-op training-loop baseline, and reports hot-loop CPU/wall time
separately from setup, finish, and InstantML uploader-drain work. The current
matrix includes `instantml-async-queue`, which disables the managed uploader
during the hot loop so the result isolates SQLite WAL producer overhead, then
drains the queue through a fake successful transport after finish.

Install the benchmark dependencies into the repo virtualenv:

```bash
.venv/bin/python -m pip install -r benchmarks/requirements-wandb.txt
```

Run the default local comparison:

```bash
.venv/bin/python benchmarks/sdk_logging_overhead.py run \
  --steps 2000 \
  --metrics-per-log 6 \
  --samples 5 \
  --warmup-logs 100 \
  --output-json /tmp/instantml-sdk-overhead.json \
  --output-markdown benchmarks/2026-05-21-sdk-logging-overhead-results.md
```

For a quick stdout-only run with the default system Python, use:

```bash
npm run benchmark:sdk-overhead
```

The durable async queue implementation is tracked by
`docs/design/2026-05-25-durable-async-sdk-logging.md`. Commit dated benchmark
Markdown when using results to decide whether async should become the default
upload mode.

The default matrix is:

- `noop`: metric computation with no SDK logging.
- `instantml-sync-null`: `Run.log_metrics()` through a fake local transport, so
  validation/serialization cost is visible without network noise. This is an
  internal/null-transport microbenchmark, not a public hosted persistence path.
- `instantml-log-null`: ergonomic `Run.log()` through the same fake transport,
  including scalar classification.
- `instantml-spool-durable`: process-spool mode writing one durable local event
  file per log call.
- `wandb-offline`: W&B offline mode with quiet, no-console, no-git, and no-code
  settings.

Interpret results by behavior class. `instantml-spool-durable` measures
foreground durable per-log file and directory fsync overhead. `wandb-offline`
measures W&B's offline local path, including service-process work when psutil
can observe it. They are useful directional local-overhead signals, but their
durability semantics are not identical. `instantml-sync-null` is a hot-path
SDK/serialization probe, not a remote persistence benchmark. Commit Markdown
summaries when they are useful; keep raw JSON in `/tmp` unless it has been
reviewed for size and sanitization.
