# Architecture Docs

This directory is for longer-lived architecture references that remain useful after individual design docs are implemented.

Current product direction: Training Observability is a general training-loop observability product with an owned backend stack. Architecture docs should preserve that framing even when they discuss RL examples or Neptune import compatibility.

Accepted backend direction: the default product path is now `Next/React frontend -> Rust API -> Postgres + ClickHouse -> artifact storage` and `Python SDK/uploader -> Rust API -> Postgres + ClickHouse -> artifact storage`. The Node server is deprecated compatibility infrastructure for route-shape checks, JSON migration fixtures, and legacy fallback. Architecture docs should say whether they describe the current Rust/Postgres/ClickHouse system or the deprecated Node/JSON system.

`current-system.md` is the source of truth for current component ownership, runtime topology, generated local state, and the storage split after the repo move into `monorepo/`.

Use `docs/design/` for proposed changes and decision records. Promote stable architecture summaries here only when they are useful for future contributors.

Future agents should update this directory when accepted designs become part of the enduring system architecture.

Current references:

- `current-system.md`: implemented architecture, current ownership boundaries, runtime topology, API/storage shape, generated local state, and outstanding simplification follow-ups.
- `../design/2026-05-09-rust-postgres-backend.md`: accepted hosted backend plan, provider research, schema, auth/tenancy model, and migration rollout.
