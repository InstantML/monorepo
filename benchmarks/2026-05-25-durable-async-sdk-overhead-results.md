# SDK Logging Overhead Benchmark

Date: 2026-05-25T03:56:16.349882Z

## Context

- Branch: `codex/durable-async-logging`
- Benchmark subject commit: `8fbb118af48eb90063918f8ee42614ca671f9418`
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
| `noop` | 5 | 5.631 | 5.490 | 5.668 | baseline | 0.119000 | 0.005000 | 0.000000 | 0 |
| `instantml-sync-null` | 5 | 13.726 | 13.469 | 14.165 | 7.979 us/log | 0.135000 | 0.005000 | 0.000000 | 0 |
| `instantml-log-null` | 5 | 16.356 | 16.136 | 16.966 | 10.646 us/log | 0.146000 | 0.005000 | 0.000000 | 0 |
| `instantml-async-queue` | 5 | 134.724 | 126.173 | 126.921 | 120.683 us/log | 0.484000 | 0.008000 | 0.112000 | 1179648 |
| `instantml-spool-durable` | 5 | 250.042 | 232.962 | 238.819 | 227.472 us/log | 0.814000 | 0.005000 | 0.191000 | 1584087 |

## Case Notes

- `noop`: Synthetic metric computation with no SDK logging.
- `instantml-sync-null`: InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.
- `instantml-log-null`: InstantML internal ergonomic Run.log microbenchmark through the same fake local transport, including scalar classification.
- `instantml-async-queue`: InstantML async mode enqueueing one local SQLite WAL queue event per log call; the background uploader is disabled so the hot path isolates producer overhead.
- `instantml-spool-durable`: InstantML process-spool mode writing one durable local event file per log call.
