# Benchmarks

Benchmark result summaries live here when they are useful for product or performance decisions. Keep committed reports sanitized: no ClickHouse credentials, raw endpoint URLs, cookies, API keys, org IDs, user IDs, or signed artifact URLs.

Public benchmark copy lives in `apps/docs/benchmarks.mdx`. Keep that page
strictly aligned with the committed summaries here: claim InstantML is faster
only for surfaces where the benchmark evidence supports it, and preserve
caveats for historical W&B runs, partial W&B seeds, mirrored W&B fields, and
sampled versus exact-history chart APIs.

## Chart Render Hot-Path Benchmark

Use the local helper and real-browser chart benchmarks after changing shared
normalization, dense rendering, hover, range zoom, or summary-table logic:

```bash
npm run benchmark:charts
npm run benchmark:charts:browser
```

`benchmark:charts` compares frozen legacy helpers with the current path at
100, 1,000, and 2,000 series, including retained Node heap, one-pass
no-regression variants, point/segment hit testing, tooltip-row construction,
and zoom-overview work. `benchmark:charts:browser` bundles the real React
`MetricChart` into a backend-independent Chromium fixture and checks 2,000 × 60
first paint, dense canvas DOM bounds, pointer-to-tooltip latency, zoom/reset
long tasks, summary switching, and console errors.

The latest result is
`benchmarks/2026-07-10-chart-render-hot-path-results.md`: at 2,000 × 60,
unzoomed normalization was 1.98× faster with retained normalized heap reduced
from 67.90 MB to 33.95 MB, combined hover work was 4.52× faster, and zoom
overview preparation was 7.05× faster. The real-browser fixture measured
208.6 ms first committed paint, 71.54 ms hover p95, and no zoom/reset long task
over 50 ms. These are local M1 measurements, not hosted or universal browser
SLOs.

## Hosted ClickHouse Query Benchmark

Use the hosted demo script from the repo root:

```bash
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 \
INSTANTML_HOSTED_DEMO_RESULT_PATH=/tmp/instantml-hosted-clickhouse-query-benchmark.json \
npm run benchmark:hosted-demo
```

The script signs in as the shared `hello@instantml.ai` demo account, reuses the existing tenant route when present, verifies the configured project seed, warms each route, then measures the dashboard query shapes documented in `docs/design/2026-05-14-hosted-clickhouse-query-benchmarks.md`. The historical hosted-demo seed targeted 100,000 runs. Current hosted benchmark routes should point at the self-hosted GCP ClickHouse deployment unless a legacy provider-backed route is being tested intentionally.

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

This remains the preferred hosted backend latency signal when measuring the
100,000-run hosted-scale tenant created by `seed:hosted-scale`, because it
measures the actual deployed request path: benchmark client -> Cloud Run data
service or HTTPS router -> self-hosted GCP ClickHouse tenant database. It
assumes `INSTANTML_DATA_API_BASE` or `INSTANTML_API_BASE` points at the hosted
API and validates `INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS` across the configured
benchmark projects before timing requests. The default minimum is 100,000 runs;
set it lower only for a named showcase dataset and record that in the result
summary. The selected-run series workload includes dashboard-style M4
downsampling (`INSTANTML_CLOUD_RUN_BENCH_M4_BUCKETS`, default 1,200) and
validates the actual rows returned against the 120,000-point batched-series
response cap.

For disposable local coverage of public high-cardinality guidance, run the Rust
large-run benchmark with `INSTANTML_BENCH_WIDE_METRIC_KEYS=100000`. That path
seeds 100,000 one-point metric keys on a stable catalog run and measures the
existing `GET /runs/{run_id}` summary/catalog response. The competitive gate
accepts that object-shaped local result for W&B metric-cardinality and Neptune
thousand-metric evidence, but hosted latency claims still need a sanitized Cloud
Run benchmark result from the deployed request path.

The latest local public-scale result is
`benchmarks/2026-07-03-local-public-scale-results.md`: 10,000 runs, 500,000
steps on the newest long run, 100,004 metric keys/project, and a 3,834 ms p95
for the 100,000-key run-detail metric catalog response. The same summary records
the focused SDK producer-throughput result used for W&B's scalar-throughput
gate.

Committed summaries for this benchmark should include the same sanitized fields
as the hosted ClickHouse benchmark plus the API host only, never full URLs or API
keys.

After writing a sanitized Cloud Run JSON result, run the competitive gates:

```bash
npm run benchmark:competitive-gates -- \
  --input /tmp/instantml-cloud-run-benchmark.json \
  --format markdown
```

The gate report compares the result against three public/reference targets:

- W&B's published at-scale guidance for Multi-tenant Cloud projects:
  10,000 runs/project, 500,000 steps/run, 100,000 metric keys/project,
  1,000 log rows/minute, and 100,000 scalar values/minute
  (`https://docs.wandb.ai/models/track/limits`).
- The committed historical W&B public-API comparison in `benchmarks/RESULTS.md`,
  using the matching InstantML route names and a 10% tolerance because that W&B
  seed only exposed 4,321 visible runs and some closest-public-equivalent cases.
- Neptune's public claim that its app can visualize and compare thousands of
  metrics in seconds (`https://docs.neptune.ai/about`), represented as a
  conservative >=1,000 metric-key gate with p95 <= 5 seconds.

Default reports may contain `not_measured` gates when a payload does not include
matching dataset cardinality, ingest throughput, or metric-catalog measurements.
Use `--strict` only when a release or marketing claim requires every public
target to be measured in that run.

The latest current-path result is
`benchmarks/2026-05-23-gcp-clickhouse-cloud-run-results.md`: Cloud Run direct to
self-hosted GCP ClickHouse, reading the `normal-runs-50k` project with 50,000
runs and 522,000,000 metric points. That committed run used the Python direct
fallback because the deployed API at the time was older than the Node validator.
Use `npm run benchmark:cloud-run` with `INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS=50000`
for fresh reruns so the expected dataset size is enforced before timing.

The run-search language benchmark result in
`benchmarks/2026-05-26-run-search-local-results.md` covers the new literal,
tag, config, boolean, and Rust regex search paths over a disposable 20,000-run
local ClickHouse dataset. It also records why a fresh W&B hosted search rerun
was not collected in that workspace and points to the existing sanitized W&B
public-API comparison for directional context.

For the GCP self-hosted showcase workload, prefer the Node Cloud Run benchmark
because it validates the expected run count before timing requests:

```bash
INSTANTML_API_KEY=instantml_... \
INSTANTML_API_BASE=https://<hosted-data-api-host> \
INSTANTML_CLOUD_RUN_BENCH_PROJECTS=normal-runs-50k \
INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS=50000 \
INSTANTML_CLOUD_RUN_BENCH_METRIC_KEY=train/loss \
INSTANTML_CLOUD_RUN_BENCH_SYSTEM_METRIC_KEY=train/loss \
npm run benchmark:cloud-run
```

Do not commit the API key or raw JSON unless it has been reviewed for
sanitization. If a one-off benchmark key is inserted directly into User Data,
append a revoked `api_key` control record immediately after the benchmark.
`wandb_hosted_compare.py benchmark-instantml --direct` is a manual historical
fallback for older deployed APIs; it records observed rows but does not enforce
`INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS`, so confirm the dataset shape separately
before using direct fallback numbers in docs.

## Metric Ingest Write-Path Benchmark

`tools/rust-ingest-benchmark.mjs` (`npm run benchmark:ingest`) measures the
metric ingest *write* path through the real Rust API: single-point
`POST /runs/{id}/metrics` versus batched `POST /runs/{id}/metrics/batch`. It is
the write-side counterpart to the large-run benchmark, which seeds ClickHouse
directly and only times reads. The batch endpoint, the per-org write-gate usage
cache, and ClickHouse async inserts all sit on this path, so the batch speedup
reflects their combined effect. See
`docs/design/2026-07-04-ingest-write-path-throughput.md`.

It launches a disposable loopback ClickHouse and a local-auth Rust API, creates
one project and one run per case, then logs the same total point count each way.
No credentials, hosted warehouse, or network egress are involved.

```bash
INSTANTML_INGEST_BENCH_RELEASE=1 \
INSTANTML_INGEST_BENCH_POINTS=20000 \
INSTANTML_INGEST_BENCH_BATCH_SIZES=50,200,500 \
INSTANTML_INGEST_BENCH_RESULT_PATH=/tmp/instantml-ingest-benchmark.json \
npm run benchmark:ingest
```

Notes and caveats:

- Use `INSTANTML_INGEST_BENCH_RELEASE=1` for committed throughput numbers; debug
  builds inflate absolute per-request latency. The reported `build_profile`
  records which was used.
- The harness sets `INSTANTML_TEST_DISABLE_RATE_LIMIT=1`. That flag is honored
  only in `local` auth mode (config ignores it otherwise), and without it the
  per-credential ingest limiter caps every case at the same rps so the
  comparison would measure the limiter, not the server. Under the production
  limiter, batched delivery is exactly what turns that fixed request budget into
  many more points per second.
- Throughput is wall-clock points/second at the configured request concurrency;
  latency percentiles are per HTTP request. `speedups` reports each batch case
  relative to the single-point baseline. The default budget gate requires the
  largest batch case to reach at least 2x the single-point baseline.
- This is a disposable local write-path signal. Hosted end-to-end ingest
  durability throughput still needs a deployed-path measurement.

The latest committed summary is
`benchmarks/2026-07-04-ingest-write-path-results.md`.

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

Smoke the W&B read benchmark:

```bash
.venv/bin/python benchmarks/wandb_hosted_compare.py benchmark-wandb \
  --runs 100 --steps 20 --samples 3 --warmups 1
```

As of the 2026-05-23 GCP ClickHouse benchmark rerun, this workspace did not
have the W&B package installed and had no W&B API key or netrc auth, so W&B was
not rerun. Keep that caveat in any report that compares the new GCP numbers to
the historical W&B measurements in `benchmarks/RESULTS.md`.

Run the InstantML read-only hosted benchmark when the hosted-scale dataset
already exists. Use the Node command when you need dataset-size validation:

```bash
npm run benchmark:cloud-run
```

Use the Python direct fallback only when the deployed API is older than the Node
validator expects, and label the result as direct fallback in the summary:

```bash
.venv/bin/python benchmarks/wandb_hosted_compare.py benchmark-instantml --direct
```

Render the comparison report:

```bash
.venv/bin/python benchmarks/wandb_hosted_compare.py render-results
```

The harness includes a guarded mode intended for a full W&B exact-history
dataset: explicitly set `--runs 100000 --steps 1000 --history-mode exact
--allow --allow-exact`. That mode would log 100 million W&B history rows and
600 million scalar values through public SDK calls; it has not been completed
in a committed result yet, so use it only when you intentionally want that
external workload and have time to publish a fresh sanitized summary. A
summary/list-fidelity run can seed one summary row per run with `--history-mode
none`; bounded chart fidelity can seed selected full-history runs with
`--history-mode newest` or `--history-mode dashboard`.

## SDK Logging Overhead Benchmark

`sdk_logging_overhead.py` measures foreground scalar logging overhead, not hosted
read/query latency. It runs each case in a fresh Python process, compares
against a no-op training-loop baseline, and reports hot-loop CPU/wall time
separately from setup, finish, and InstantML uploader-drain work. The current
matrix includes `instantml-async-queue`, which disables the managed uploader
during the hot loop so the result isolates buffered producer return overhead,
then forces SQLite durability and drains the queue through a fake successful
transport after finish. `instantml-async-queue-unbatched` disables the producer
buffer to compare against the old one-SQLite-transaction-per-event path.

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
`docs/design/2026-05-25-durable-async-sdk-logging.md`; the buffered producer
follow-up is tracked by `docs/design/2026-05-27-async-sqlite-batching.md`.
Commit dated benchmark Markdown when using results to decide whether async
producer settings should change.

The 2026-05-25 async producer benchmark was used to accept
`docs/design/2026-05-25-async-upload-default.md`. That default flip also bounds
idle upload-health emission before enabling async by default, so the benchmark
remains a hot-path producer-cost signal rather than a full quota model for
background health traffic.

The JSON and Markdown summaries also report hot-loop producer rows/minute and
scalar values/minute. The top-level JSON `ingest.values_per_minute` field is
intended for the competitive gate and maps to W&B's public scalar-throughput
unit. Treat it as SDK producer-return throughput, not hosted remote persistence:
it proves the training loop can hand off values at that rate under the measured
local mode, while separate hosted ingest benchmarks are still needed for
end-to-end durability throughput claims.

The default matrix is:

- `noop`: metric computation with no SDK logging.
- `instantml-sync-null`: `Run.log_metrics()` through a fake local transport, so
  validation/serialization cost is visible without network noise. This is an
  internal/null-transport microbenchmark, not a public hosted persistence path.
- `instantml-log-null`: ergonomic `Run.log()` through the same fake transport,
  including scalar classification.
- `instantml-async-queue`: default async buffered producer return overhead plus
  a separately reported forced SQLite durability phase.
- `instantml-async-queue-unbatched`: the old unbuffered async producer path,
  kept as a local comparison case.
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

## Async Queue SQLite I/O Benchmark

`async_queue_io.py` isolates the local SQLite queue path after payloads have
been snapshotted by the SDK. It reports event preparation separately from
`AsyncQueueRepository.enqueue_many_prepared()` write cost and from the
`drain_queue_once()` read/drain loop. The drain loop uses a fake successful
transport, so it includes SQLite claim reads, JSON decode, fake request
serialization, processed-row updates, and pruning, but no network latency.

Run the default batch-size comparison:

```bash
.venv/bin/python benchmarks/async_queue_io.py run \
  --events 10000 \
  --metrics-per-event 6 \
  --samples 5 \
  --batch-sizes 1,16,64,256 \
  --output-json /tmp/instantml-async-queue-io.json \
  --output-markdown benchmarks/2026-05-27-async-queue-io-results.md
```

Use this benchmark when tuning producer batch thresholds or investigating read
side uploader costs. The SDK logging overhead benchmark remains the better
end-to-end hot-loop signal because it includes `Run.log_metrics()` validation,
buffer append, and lifecycle behavior.
