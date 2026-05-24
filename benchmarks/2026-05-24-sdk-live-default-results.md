# SDK Logging Overhead Benchmark

Date: 2026-05-24T05:12:40.301607Z

## Context

- Branch: `codex/streaming`
- Benchmark subject commit: `5b6b96465a487a7e55d75abfd1c86a1a343ca6d7`
- Working tree dirty at run time: `false`
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
- Live heartbeat interval: `15.0` seconds
- Sample order seed: `20260521`

## Caveats

- Hot-loop timings exclude setup/init and finish/drain phases; those phases are reported separately.
- InstantML sync-null/log-null are internal null-transport microbenchmarks and are not remote persistence benchmarks.
- InstantML sync-live-null uses the same null transport plus the SDK heartbeat thread. The heartbeat interval is configurable so runs can report default and stress settings explicitly.
- InstantML spool-durable writes one local durable event file per log call; uploader drain CPU is reported separately.
- W&B offline uses local/offline mode and may perform work in a service process; hot-loop tree CPU is phase-sampled, while total worker CPU is monitored from the parent process.
- Finish and drain columns are case-specific lifecycle costs, not identical provider phases.
- Disk bytes are measured after finish and include setup, warmup, and finish artifacts, not just measured hot-loop logs.

## Hot Loop Summary

| Case | Samples | Median wall us/log | Median tree CPU us/log | p95 tree CPU us/log | Tree CPU overhead vs noop | Median total worker CPU s | Median finish CPU s | Median drain CPU s | Median disk bytes after finish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `noop` | 5 | 5.516 | 5.461 | 6.144 | baseline | 0.116000 | 0.004000 | 0.000000 | 0 |
| `instantml-sync-null` | 5 | 13.659 | 13.441 | 14.026 | 7.980 us/log | 0.131000 | 0.005000 | 0.000000 | 0 |
| `instantml-sync-live-null` | 5 | 13.514 | 13.322 | 14.374 | 7.861 us/log | 0.129000 | 0.005000 | 0.000000 | 0 |

## Case Notes

- `noop`: Synthetic metric computation with no SDK logging.
- `instantml-sync-null`: InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.
- `instantml-sync-live-null`: InstantML internal Run.log_metrics microbenchmark with the online heartbeat thread enabled through the same fake local transport.
