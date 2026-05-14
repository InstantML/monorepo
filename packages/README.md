# Packages

This directory contains reusable packages.

Expected packages:

- `python-sdk/`: Python SDK for logging runs, metrics, artifacts, checkpoints, videos, and tables.

Future agents must update this README when packages are added, renamed, removed, or when shared package-level commands change.

Current SDK caveats to keep documented:

- `init()` requires a reachable server; offline replay only covers events logged after a run exists.
- `upload_mode="spool"` avoids post-init HTTP calls in the training process. Metric replay now sends event IDs as idempotency keys to servers that support them; non-metric events remain one request per file and should stay idempotent where possible.
- Automatic source metadata should remain reserved from user metadata overwrites.
- Metric step semantics must stay aligned with both server implementations before expanding compatibility claims.
- The SDK should remain backend-agnostic at the REST-contract level. It targets the primary Rust/Postgres/ClickHouse server by default and keeps compatibility with the deprecated Node server through the same documented routes. Use `RLOBS_API_KEY`/`api_key` when hosted or API-key auth is required.
