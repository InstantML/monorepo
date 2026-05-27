# SDK Logging Overhead Benchmark

Date: 2026-05-27T04:49:21.668601Z

## Context

- Branch: `codex/batched-transactions`
- Benchmark subject commit: `85a36d428423f5e86584f150f2e7058b594ac3f5`
- Working tree dirty at run time: `true`
- Python: `3.11.5`
- Platform: `macOS-15.6.1-arm64-arm-64bit`
- CPU: `Apple M1`
- W&B version: `None`
- psutil version: `6.0.0`
- InstantML module: `packages/python-sdk/instantml/__init__.py`
- Steps per sample: `5000`
- Metrics per log call: `6`
- Samples per case: `5`
- Warmup logs per worker: `200`
- Sample order seed: `20260521`

## Caveats

- Hot-loop timings exclude setup/init and finish/drain phases; those phases are reported separately.
- InstantML sync-null/log-null are internal null-transport microbenchmarks and are not remote persistence benchmarks.
- InstantML async-queue disables the uploader process during the hot loop to isolate buffered producer return cost; forced SQLite durability is measured separately before finish.
- InstantML async-queue-unbatched disables the producer buffer and measures the old one-SQLite-transaction-per-event producer path.
- InstantML spool-durable writes one local durable event file per log call; uploader drain CPU is reported separately.
- W&B offline uses local/offline mode and may perform work in a service process; hot-loop tree CPU is phase-sampled, while total worker CPU is monitored from the parent process.
- Finish and drain columns are case-specific lifecycle costs, not identical provider phases.
- Disk bytes are measured after finish and include setup, warmup, and finish artifacts, not just measured hot-loop logs.

## Hot Loop Summary

| Case | Samples | Median return p50 us/log | Median sample p99 return us/log | Median wall us/log | Median tree CPU us/log | p95 tree CPU us/log | Tree CPU overhead vs noop | Median durable flush CPU s | Median total worker CPU s | Median finish CPU s | Median drain CPU s | Median disk bytes after finish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `noop` | 5 | 2.875 | 6.958 | 3.720 | 3.649 | 3.763 | baseline | 0.000000 | 0.123000 | 0.002000 | 0.000000 | 0 |
| `instantml-sync-null` | 5 | 11.375 | 33.417 | 12.660 | 12.488 | 12.609 | 8.839 us/log | 0.000000 | 0.180000 | 0.003000 | 0.000000 | 0 |
| `instantml-async-queue` | 5 | 16.667 | 68.042 | 19.527 | 21.286 | 22.398 | 17.637 us/log | 0.017000 | 0.547000 | 0.012000 | 0.293000 | 2867200 |
| `instantml-async-queue-unbatched` | 5 | 228.938 | 1541.209 | 401.160 | 389.399 | 411.148 | 385.750 us/log | 0.002000 | 2.401000 | 0.007000 | 0.318000 | 2871296 |
| `instantml-spool-durable` | 5 | 247.709 | 781.833 | 280.451 | 246.057 | 248.052 | 242.408 us/log | 0.000000 | 1.926000 | 0.003000 | 0.492000 | 3926491 |

## Case Notes

- `noop`: Synthetic metric computation with no SDK logging.
- `instantml-sync-null`: InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.
- `instantml-async-queue`: InstantML async mode with buffered SQLite WAL group commit; the background uploader is disabled so the hot path isolates producer return overhead and forced durability is reported separately.
- `instantml-async-queue-unbatched`: InstantML async mode using the old one-SQLite-transaction-per-event producer path; the background uploader is disabled so the hot path isolates unbatched SQLite producer overhead.
- `instantml-spool-durable`: InstantML process-spool mode writing one durable local event file per log call.
