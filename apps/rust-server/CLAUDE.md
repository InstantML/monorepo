# Rust Server Agent Guide

This guide is for agents working in `apps/rust-server`. It complements the repo
root `AGENTS.md` and the Rust server `README.md`; read those first before making
substantial code changes.

## Development Posture

- Keep the Rust backend boring, explicit, and small. Prefer direct functions,
  typed structs, and narrow modules over framework magic or broad shared
  abstractions.
- New product API, storage, auth, importer, artifact, deployment, or
  cross-component behavior needs a design doc in `docs/design/` before code.
- Preserve the accepted backend direction: frontend and SDK talk to the Rust
  API; Rust owns ClickHouse operational records, metric tables, and hosted
  control/data routing.
- Do not deploy multi-instance control/data services from this branch. Local and
  disposable ClickHouse smokes are allowed; live deployment remains a separate
  explicit operator action.

## Rust Quality Bar

- Production code must not use `panic!`, `unreachable!`, `todo!`, unchecked
  `unwrap`, or unchecked `expect`. Return `AppResult<T>` and attach enough
  internal context for logs.
- Test-only `unwrap` and `expect` are acceptable when the assertion is clearer
  than manual matching. Keep them inside `#[cfg(test)]` or test modules.
- Public HTTP 5xx responses should be generic. Log internal ClickHouse, config,
  provider, and serialization details with `tracing`, but do not return those
  details to clients.
- Avoid leaking secrets through `Debug`, error strings, operational payloads, or
  route records. `password_ciphertext` is currently plaintext guarded by
  `INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS`; do not expand that
  pattern. Prefer Secret Manager or another secret reference design for any new
  hosted credential flow.
- Keep validation at boundaries. Request handlers should parse/shape input,
  store functions should enforce ownership and scope, and ClickHouse helpers
  should validate storage-specific invariants.
- Prefer deterministic ordering for replay, pagination, and tests. Tie-break
  equal timestamps with stable IDs already present in the record.

## Multi-Instance Constraints

- User Data control replay must remain a full ordered replay until the design
  adds a durable monotonic sequence or comparable cursor. Do not implement
  incremental replay with `(created_at, event_id)` because `event_id` is random
  and can skip same-timestamp records.
- Data-plane auth refreshes User Data before resolving bearer/session auth. If
  tenant routes change after replay, evict only affected tenant MetricStore
  caches.
- Tenant operational replay must reject records whose `org_id` or entity id does
  not match the routed org. Do not loosen these checks to make a fixture pass.
- Cloud Run `maxScale=1` is not a correctness guarantee for shared writers.
  Before enabling real multi-writer cells, add write uniqueness, freshness, and
  idempotency tests with at least two live Rust processes.
- Avoid holding `StoreData` locks across network I/O in new code. Legacy paths
  still exist; do not copy that shape. Validate under the lock, release it for
  ClickHouse/provider calls, then reacquire only to update the in-process index.

## Error Handling

- Use `AppError::validation`, `unauthorized`, `forbidden`, `not_found`,
  `conflict`, `payload_too_large`, or `internal` intentionally.
- Use `map_err` to convert external errors at the boundary where useful context
  is known.
- If a stored record cannot deserialize or violates tenant scope, treat it as an
  internal consistency error and fail replay. Do not silently skip malformed
  records.
- Do not replace ClickHouse read failures with zeroes in product responses.
  Propagate the error so readiness, logs, and callers see storage degradation.

## Performance Practices

- Keep list/table endpoints bounded. Run summaries should not fetch full metric
  histories; metric series endpoints must stay limited by run ids, key, ranges,
  or explicit limits.
- Batch writes where the public API accepts batches. Avoid per-point ClickHouse
  inserts.
- Measure before adding caches. The in-process index is already a cache of the
  operational log; any new cache needs invalidation tests.
- Be careful with clones in hot dashboard paths. Clone rows only when the
  response or ownership boundary requires it.
- Prefer deterministic BTree indexes for ordered pagination and HashMap lookups
  for direct id access. Add indexes only when a real query needs them.

## Required Commands

Run from the repo root:

```bash
npm run rust:fmt:check
npm run rust:lint
npm run rust:test
```

For hosted/control-data work, also run:

```bash
npm run test:rust:contract
npm run test:hosted-clickhouse
```

The combined Rust gate is:

```bash
npm run rust:verify
```

Useful focused commands:

```bash
npm run rust:fmt
cargo test --manifest-path apps/rust-server/Cargo.toml <test_name>
rg -n "panic!|unreachable!|todo!|unwrap\\(|expect\\(" apps/rust-server/src
```

`cargo audit`, `cargo udeps`, and `cargo hack` are recommended when installed,
but they are not yet required repo scripts.

## Files To Keep In Sync

- `src/http/mod.rs`, `src/http/handlers.rs`, and `src/domain.rs` for route,
  handler, request, and response contract changes.
- `src/store/mod.rs` and `src/store/*` for operational replay, auth, tenant,
  run, metric, object, import, and usage behavior.
- `src/control_store.rs` and `src/metric_store.rs` for ClickHouse schema and
  query behavior.
- `apps/rust-server/README.md` for commands, config, testing, and operational
  warnings.
- `docs/architecture/current-api.md` for public API inputs, parameters,
  outputs, auth, and limits.
- Relevant `docs/design/YYYY-MM-DD-*.md` files whenever implementation changes
  an accepted design.
