# SDK Logging Overhead Benchmark

Date: 2026-05-24T05:13:23.435052Z

## Context

- Branch: `codex/streaming`
- Benchmark subject commit: `26b130f3cad5a79d2517ab2c544d371825783bbf`
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
- Live heartbeat interval: `0.005` seconds
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
| `noop` | 5 | 4.854 | 4.767 | 5.423 | baseline | 0.116000 | 0.005000 | 0.000000 | 0 |
| `instantml-sync-null` | 5 | 13.534 | 13.319 | 13.496 | 8.552 us/log | 0.128000 | 0.005000 | 0.000000 | 0 |
| `instantml-sync-live-null` | 5 | 13.509 | 13.347 | 14.320 | 8.580 us/log | 0.130000 | 0.005000 | 0.000000 | 0 |

## Case Notes

- `noop`: Synthetic metric computation with no SDK logging.
- `instantml-sync-null`: InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.
- `instantml-sync-live-null`: InstantML internal Run.log_metrics microbenchmark with the online heartbeat thread enabled through the same fake local transport.
