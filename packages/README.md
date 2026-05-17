# Packages

This directory contains reusable packages.

Expected packages:

- `python-sdk/`: Python SDK for logging runs, auto-step metrics, rich objects, local files/artifacts, optional system metrics, optional console capture, checkpoints, videos, and tables.

Package distribution:

- Build the SDK wheel and source distribution with `npm run sdk:build`.
- Check package metadata with `npm run sdk:check`.
- Install the built wheel locally with `npm run sdk:test-install`.
- Public upload is handled by `.github/workflows/python-sdk-release.yml` after PyPI/TestPyPI Trusted Publishers are configured for the `instantml` project and the public license/terms decision is approved.

Future agents must update this README when packages are added, renamed, removed, or when shared package-level commands change.

Current SDK caveats to keep documented:

- `init()` requires a reachable server; offline replay only covers events logged after a run exists.
- `upload_mode="spool"` avoids post-init HTTP calls in the training process. Metric replay now sends event IDs as idempotency keys to servers that support them; non-metric events remain one request per file and should stay idempotent where possible.
- `Run.log()` is ergonomic and may split mixed payloads into multiple route-level sub-events. Those writes are deterministic but not atomic across routes.
- `upload_file()` hashes local files. In process-spool mode it still records a `source_path`, so local files must remain stable until the uploader drains them.
- Optional media/framework dependencies are pinned in `packages/python-sdk/requirements-optional.txt` and must remain lazy imports.
- Automatic source metadata should remain reserved from user metadata overwrites.
- Metric step semantics must stay aligned with both server implementations before expanding compatibility claims.
- The SDK should remain backend-agnostic at the REST-contract level. It targets the primary Rust/ClickHouse server by default and keeps compatibility with the deprecated Node server through the same documented routes. Use `INSTANTML_API_KEY`/`api_key` when hosted or API-key auth is required.
