# SDK Logging Overhead Benchmark

Date: 2026-05-21T11:09:02.542653Z

## Context

- Branch: `codex/sdk-overhead-benchmarks`
- Benchmark subject commit: `f368c19df0c3a7e7ad6bc6aa29861cdadac30ce0`
- Working tree dirty at run time: `false`
- Python: `3.11.5`
- Platform: `macOS-15.6.1-arm64-arm-64bit`
- CPU: `Apple M1`
- W&B version: `0.26.1`
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
- InstantML spool-durable writes one local durable event file per log call; uploader drain CPU is reported separately.
- W&B offline uses local/offline mode and may perform work in a service process; hot-loop tree CPU is phase-sampled, while total worker CPU is monitored from the parent process.
- Finish and drain columns are case-specific lifecycle costs, not identical provider phases.
- Disk bytes are measured after finish and include setup, warmup, and finish artifacts, not just measured hot-loop logs.

## Hot Loop Summary

| Case | Samples | Median wall us/log | Median tree CPU us/log | p95 tree CPU us/log | Tree CPU overhead vs noop | Median total worker CPU s | Median finish CPU s | Median drain CPU s | Median disk bytes after finish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `noop` | 5 | 4.245 | 4.215 | 4.309 | baseline | 0.515000 | 0.004000 | 0.000000 | 0 |
| `instantml-sync-null` | 5 | 12.684 | 12.595 | 12.736 | 8.380 us/log | 0.531000 | 0.003000 | 0.000000 | 0 |
| `instantml-log-null` | 5 | 14.589 | 14.482 | 14.531 | 10.267 us/log | 0.532000 | 0.004000 | 0.000000 | 0 |
| `instantml-spool-durable` | 5 | 223.846 | 210.834 | 219.968 | 206.619 us/log | 1.153000 | 0.004000 | 0.175000 | 1584087 |
| `wandb-offline` | 5 | 111.474 | 146.963 | 185.296 | 142.748 us/log | 1.272000 | 0.000000 | 0.000000 | 1348304 |

## Case Notes

- `noop`: Synthetic metric computation with no SDK logging.
- `instantml-sync-null`: InstantML internal Run.log_metrics microbenchmark through a fake local transport that serializes bodies and does no network I/O.
- `instantml-log-null`: InstantML internal ergonomic Run.log microbenchmark through the same fake local transport, including scalar classification.
- `instantml-spool-durable`: InstantML process-spool mode writing one durable local event file per log call.
- `wandb-offline`: W&B offline mode with quiet/no-git/no-code/no-console settings.
