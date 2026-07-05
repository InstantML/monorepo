# Metric Ingest Write-Path Benchmark

Date: 2026-07-04T22:48:49Z

## Context

- Branch: `claude/perf-audit-update` (PR #350 follow-up)
- Working tree dirty at run time: `true`
- Harness: `tools/rust-ingest-benchmark.mjs` (`npm run benchmark:ingest`)
- Build profile: `release`
- CPU: Apple M1
- Backend: disposable loopback ClickHouse + local-auth Rust API (no credentials,
  no hosted warehouse, no network egress)
- Points per case: 20,000
- Metrics per point: 6
- Request concurrency: 8
- Rate limiting: disabled via the local-only `INSTANTML_TEST_DISABLE_RATE_LIMIT`
  flag so the comparison measures the server, not the per-credential limiter

## Method

Each case logs the same 20,000 points to one run. The `single_point` case uses
`POST /runs/{id}/metrics` (one point per request); the `batch_N` cases use
`POST /runs/{id}/metrics/batch` packing N points per request. Throughput is
wall-clock points/second at concurrency 8; latency percentiles are per HTTP
request. See `docs/design/2026-07-04-ingest-write-path-throughput.md`.

## Results

| Case | Batch size | Requests | Points/sec | Requests/sec | p50 req ms | p95 req ms | Speedup vs single |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single_point | 1 | 20,000 | 42.0 | 42.0 | 189.16 | 224.55 | 1.0x |
| batch_50 | 50 | 400 | 1,953.8 | 39.1 | 224.39 | 235.53 | 46.5x |
| batch_200 | 200 | 100 | 7,485.8 | 37.4 | 237.26 | 248.81 | 178.2x |
| batch_500 | 500 | 40 | 15,398.8 | 30.8 | 254.26 | 260.83 | 366.6x |

## Interpretation

- **Per-request latency is dominated by the ClickHouse async-insert flush
  window.** The point tables now insert with `async_insert=1,
  wait_for_async_insert=1`, so each request waits for the server-side buffer to
  flush (ClickHouse's default busy timeout is ~200 ms) before returning a
  durable `inserted` count. That is why p50 sits near 190–254 ms across all
  cases and requests/second is roughly flat (~30–42/s) regardless of batch size
  at this concurrency. `wait_for=1` is the deliberate durability trade: the
  response only reports points ClickHouse has accepted.

- **Because requests/second is latency-bound, points/second scales almost
  linearly with batch size.** Packing 500 points into one request that costs
  only ~34% more latency than a single-point request (254 ms vs 189 ms) yields
  ~367x the throughput. This is the core reason the SDK's batched delivery
  matters: it turns a fixed per-request budget — whether bounded by the async
  flush window here or by the per-credential ingest rate limit in production —
  into many more delivered points per second.

- **Absolute throughput scales with concurrency** until the server's real
  CPU/IO ceiling. These numbers are a concurrency-8 snapshot (a modest fleet of
  ~8 concurrent loggers); more concurrent uploaders raise aggregate points/sec
  proportionally until saturation. The robust, concurrency-independent result is
  the batch-vs-single **ratio**.

- The write-gate usage cache keeps the per-request capacity check off the
  ClickHouse aggregate path in steady state, so per-request latency stays flat
  as an org's run/metric/artifact counts grow rather than rising with data
  size. This benchmark seeds a fresh org, so it exercises the warm-cache path;
  the effect is most visible on large orgs, where the pre-change path re-ran
  several COUNT aggregates plus an artifact scan on every ingest request.

## Caveats

- Disposable local write-path signal only. Hosted end-to-end ingest durability
  throughput still needs a measurement on the deployed Cloud Run request path.
- Release build on a single M1; absolute numbers are machine-specific. The
  batch-vs-single ratio is the portable result.
- Rate limiting was disabled for measurement. Under the production per-credential
  ingest limiter, both cases share the same request budget, so the batching
  points/sec multiplier is at least as large as shown here.
