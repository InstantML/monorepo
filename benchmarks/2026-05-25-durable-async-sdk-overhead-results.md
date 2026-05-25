# SDK Logging Overhead Benchmark

Date: 2026-05-25T03:09:47.215350Z

## Context

- Branch: `codex/durable-async-logging`
- Benchmark subject commit: `c419c8593450ef13ae9a8ad27c97c1513fef2c53`
- Working tree dirty at run time: `true`
- Python: `3.11.5`
- Platform: `macOS-15.6.1-arm64-arm-64bit`
- CPU: `Apple M1`
- W&B version: `None`
- psutil version: `6.0.0`
- InstantML module: `packages/python-sdk/instantml/__init__.py`
- Steps per sample: `2000`
- Metrics per log call: `6`
- Samples per case: `5`
- Warmup logs per worker: `100`
- Sample order seed: `20260521`

## Caveats

- Hot-loop timings exclude setup/init and finish/drain phases; those phases are reported separately.
- InstantML sync-null/log-null are internal null-transport microbenchmarks and are not remote persistence benchmarks.
- InstantML async-queue disables the uploader process during the hot loop to isolate SQLite producer cost, then drains the queue through a fake successful transport after finish.
- InstantML spool-durable writes one local durable event file per log call; uploader drain CPU is reported separately.
- W&B offline uses local/offline mode and may perform work in a service process; hot-loop tree CPU is phase-sampled, while total worker CPU is monitored from the parent process.
- Finish and drain columns are case-specific lifecycle costs, not identical provider phases.
- Disk bytes are measured after finish and include setup, warmup, and finish artifacts, not just measured hot-loop logs.

## Hot Loop Summary

| Case | Samples | Median wall us/log | Median tree CPU us/log | p95 tree CPU us/log | Tree CPU overhead vs noop | Median total worker CPU s | Median finish CPU s | Median drain CPU s | Median disk bytes after finish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `noop` | 5 | 4.932 | 4.843 | 5.157 | baseline | 0.112000 | 0.003000 | 0.000000 | 0 |
| `instantml-sync-null` | 5 | 13.799 | 13.570 | 14.345 | 8.727 us/log | 0.131000 | 0.003000 | 0.000000 | 0 |
| `instantml-log-null` | 5 | 15.984 | 15.760 | 15.920 | 10.917 us/log | 0.138000 | 0.004000 | 0.000000 | 0 |
| `instantml-async-queue` | 5 | 122.149 | 115.329 | 116.594 | 110.486 us/log | 0.441000 | 0.006000 | 0.090000 | 1179648 |
| `instantml-spool-durable` | 5 | 257.110 | 234.652 | 238.344 | 229.809 us/log | 0.816000 | 0.004000 | 0.192000 | 1584087 |

## Case Notes

- `noop`: Synthetic metric computation with no SDK logging.
- `instantml-sync-null`: InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.
- `instantml-log-null`: InstantML internal ergonomic Run.log microbenchmark through the same fake local transport, including scalar classification.
- `instantml-async-queue`: InstantML async mode enqueueing one local SQLite WAL queue event per log call; the background uploader is disabled so the hot path isolates producer overhead.
- `instantml-spool-durable`: InstantML process-spool mode writing one durable local event file per log call.
