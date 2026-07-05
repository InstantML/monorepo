# Async Queue SQLite I/O Benchmark

Date: 2026-07-04T23:07:17.206401Z

## Context

- Branch: `claude/perf-audit-update`
- Benchmark subject commit: `2410313a771300cf71a3d3481e5ddf26b9ea11e4`
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
- http_requests counts actual _send_request invocations. Batched delivery groups consecutive same-run metric events into one /metrics/batch request, so events_per_http_request shows the round-trip reduction versus one request per event.
- SQLite runs with the SDK queue defaults: WAL journal mode, synchronous=NORMAL, producer timeout, and the default 1 MiB uploader drain byte budget.

## Summary

| Batch size | Samples | Prepare wall us/event | Write wall us/event | p95 write us/event | Write events/sec | Drain/read wall us/event | p95 drain/read us/event | Drain/read events/sec | Median write batches | Median drain batches | Median HTTP requests | Median events/HTTP request | Disk bytes after write |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 5 | 7.440 | 47.101 | 48.867 | 21231 | 19.303 | 19.861 | 51805 | 10000 | 40 | 40 | 250.0 | 7949984 |
| 16 | 5 | 7.429 | 6.641 | 6.790 | 150582 | 19.203 | 19.784 | 52076 | 625 | 40 | 40 | 250.0 | 7769808 |
| 64 | 5 | 7.426 | 3.794 | 10.173 | 263541 | 19.400 | 19.647 | 51545 | 157 | 40 | 40 | 250.0 | 7622352 |
| 256 | 5 | 7.430 | 3.101 | 3.185 | 322450 | 19.086 | 20.001 | 52395 | 40 | 40 | 40 | 250.0 | 7167552 |
