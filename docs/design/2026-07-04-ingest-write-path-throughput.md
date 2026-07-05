# Design: Metric Ingest Write-Path Throughput

Date: 2026-07-04

Status: Accepted (implemented)

Owner: Claude (perf handoff PR #350)

## Summary

Metric ingest was the single-point bottleneck on the SDK→API→ClickHouse path.
Each `Run.log()` scalar became its own `POST /runs/{id}/metrics` request, and on
the server every such request paid a full plan-capacity recomputation (several
ClickHouse aggregate queries plus a scan of the org's artifacts under the global
store lock) and a standalone ClickHouse insert. Under the standard per-credential
ingest rate limit the effective ceiling was roughly one point per request per
round trip.

This design records the accepted write-path changes that ship together, because
they only pay off in combination:

1. A batch ingest endpoint, `POST /runs/{run_id}/metrics/batch`, that accepts up
   to 500 points per request under one idempotency key, one capacity check, and
   one insert.
2. A per-org write-gate usage cache so repeated ingest requests inside a short
   TTL reuse the last capacity computation and apply the incoming delta, instead
   of re-running ClickHouse aggregates every request.
3. ClickHouse async inserts (`async_insert=1, wait_for_async_insert=1`) on the
   point tables so many small ingest requests coalesce into server-side batches
   instead of one part per request.
4. SDK batched delivery: the async uploader groups consecutive same-run metric
   events from its SQLite queue into one batch request, with keep-alive HTTP
   connection reuse and gzip.
5. Process-spool crash recovery: active append-only JSONL segments carry the
   writer PID, and the standalone uploader promotes segments left by dead
   writers before replaying them.

## Goals

- Raise sustained ingest throughput for training loops that log at high step
  rates without changing the public single-point contract.
- Keep per-request server cost flat as an org's run/metric/artifact counts grow.
- Avoid ClickHouse part explosion from per-point inserts.
- Preserve idempotency, ordering, and plan-limit enforcement semantics.

## Non-Goals

- Changing the durability contract of `upload_mode="sync"`.
- Removing the single-point endpoint; the SDK falls back to it against older
  servers and for non-metric events.
- Hosted end-to-end throughput claims; those still come from the Cloud Run
  benchmark on the deployed request path.

## Proposed Design

### Batch endpoint

`POST /runs/{run_id}/metrics/batch`, data-plane, scope `sdk:ingest`, same
middleware as `log_metrics`. Body `{"points": [{"metrics": {"<key>": <f64>},
"step": <number>, "timestamp": "<ISO8601, optional>"}, ...]}`, capped at 500
entries. Per-entry validation is identical to the single-point path (`step` is
required; null/missing is a 400, matching `log_metrics`). One `Idempotency-Key`
header covers the whole batch: one reserve/replay/persist record, one capacity
check with the total point delta, and one `insert_points` call for all rows.
Response `{"inserted": <total points>}`.

The batch route ends in `/metrics/batch`, so `is_ingest_route` matches it
explicitly (the earlier `ends_with("/metrics")` check does not) and it shares
the ingest rate-limit class and metering with the single-point endpoint.

### Write-gate usage cache

`enforce_plan_capacity` gets a per-org cache entry `(computed_at, counts)` with
a ~20s TTL. Within the TTL, if projected usage sits outside a 2% near-limit
margin on every gated target, the request is allowed immediately and its
`UsageDelta` is accumulated into the cached counts. Anything inside the margin
(which necessarily includes every possible rejection) forces a fresh
`usage_counts_for_org` recompute before allowing or rejecting, so limit
decisions are always made on exact data. Summary/export paths never use the
cache.

### ClickHouse async inserts

`insert_points`, `insert_rank_points`, and console-log inserts set
`async_insert=1, wait_for_async_insert=1` at the insert client. `wait_for=1`
preserves the durability semantics the idempotency response depends on while
still letting ClickHouse coalesce parts server-side. Operational-record inserts
stay strongly consistent (unchanged).

### SDK batched delivery

The async uploader's drain loop groups consecutive claimed events that are
metric posts to the same run into one `/metrics/batch` request (≤500 points),
under a deterministic idempotency key derived from the member events. Success
acks all grouped sequence ids in one SQLite update. On a 404/405 (older server)
it permanently falls back to per-event delivery for the process. Requests reuse
a keep-alive connection pool and gzip bodies over 1 KiB.

## Component Impact

Backend:

- New route, handler, store function, and OpenAPI entry for the batch endpoint.
- Write-gate cache on `Store`; async-insert options on the metric store.
- `is_ingest_route` covers `/metrics/batch`.
- Local-only `INSTANTML_TEST_DISABLE_RATE_LIMIT` flag (honored solely in `local`
  auth mode) so ingest load benchmarks are not limiter-bound.

Frontend:

- None.

SDK:

- Batched delivery, connection pooling, gzip, batched acks, and running
  queue-byte accounting in the async queue.

## Testing and Measurement

- Store unit tests for batch validation, the write-gate cache fast path and
  near-limit recompute, and route classification.
- New `tools/rust-ingest-benchmark.mjs` (`npm run benchmark:ingest`) measures
  single-point vs batched ingest through the real API against disposable local
  ClickHouse. See `benchmarks/README.md` and the dated result summary.
- SDK batch grouping, queue-byte accounting, and batched-ack tests in the
  python-sdk suite.

## Rollout and Risk

- The single-point endpoint is unchanged, so mixed old/new SDKs keep working and
  the SDK downgrades automatically against servers without the batch route.
- The write-gate cache is a process-local cache over the operational log. Plan
  mutation paths clear the local org entry immediately; otherwise invalidation
  is time-bounded (TTL) with a forced recompute near limits. Hosted multi-writer
  deployments still need the documented single-writer data-plane shape, or a
  shared usage-counter design before this cache can be treated as globally
  authoritative across instances.
