# Async Queue SQLite I/O Benchmark

Date: 2026-05-27T04:49:37.771562Z

## Context

- Branch: `codex/batched-transactions`
- Benchmark subject commit: `85a36d428423f5e86584f150f2e7058b594ac3f5`
- Working tree dirty at run time: `true`
- Python: `3.11.5`
- Platform: `macOS-15.6.1-arm64-arm-64bit`
- CPU: `Apple M1`
- Events per sample: `10000`
- Metrics per event: `6`
- Samples per batch size: `5`
- Batch sizes: `1, 16, 64, 256`

## Caveats

- Write timing measures AsyncQueueRepository.enqueue_many_prepared() over pre-serialized PreparedQueuedEvent objects.
- Prepare timing separately measures JSON serialization, idempotency assignment, byte counting, and event object creation.
- Drain/read timing uses drain_queue_once() with a fake successful transport, so it includes SQLite claim reads, JSON decode, fake request serialization, mark_processed updates, and pruning, but no network.
- SQLite runs with the SDK queue defaults: WAL journal mode, synchronous=NORMAL, producer timeout, and the default 1 MiB uploader drain byte budget.

## Summary

| Batch size | Samples | Prepare wall us/event | Write wall us/event | p95 write us/event | Write events/sec | Drain/read wall us/event | p95 drain/read us/event | Drain/read events/sec | Median write batches | Median drain batches | Disk bytes after write |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 5 | 8.363 | 572.792 | 590.378 | 1746 | 56.606 | 59.674 | 17666 | 10000 | 40 | 7929432 |
| 16 | 5 | 8.381 | 42.689 | 47.105 | 23425 | 63.109 | 63.694 | 15846 | 625 | 40 | 7400976 |
| 64 | 5 | 8.275 | 12.734 | 14.426 | 78527 | 64.136 | 66.419 | 15592 | 157 | 40 | 7851680 |
| 256 | 5 | 8.328 | 5.513 | 6.152 | 181404 | 65.093 | 68.526 | 15362 | 40 | 40 | 7253520 |
