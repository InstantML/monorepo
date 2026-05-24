# Architecture Docs

This directory is for longer-lived architecture references that remain useful after individual design docs are implemented.

Current product direction: InstantML is a general training-loop observability product with an owned backend stack and Free/Pro/Premium packaging. Architecture docs should preserve that framing even when they discuss RL examples, Neptune import compatibility, or pricing/usage telemetry. Metric-point plan limits are current UTC calendar-month counters; storage, project, run, seat, artifact, metric-series, and API-key usage is retained-resource posture.

Accepted backend direction: the default product path is now `Next/React frontend -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage` and `Python SDK/uploader -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage`. Signup records plan and tenant-route warehouse intent, but current InstantML-owned hosted storage uses database-mode tenant routing on self-hosted Google Cloud ClickHouse unless an explicit legacy/provider-backed provisioning path is selected. The Node server is deprecated compatibility infrastructure for route-shape checks, JSON migration fixtures, and legacy fallback. Architecture docs should say whether they describe the current Rust/ClickHouse system or the deprecated Node/JSON system.

`current-system.md` is the source of truth for current component ownership, runtime topology, generated local state, and the storage split after the repo move into `monorepo/`.

Use `docs/design/` for proposed changes and decision records. Promote stable architecture summaries here only when they are useful for future contributors.

Future agents should update this directory when accepted designs become part of the enduring system architecture.

Current references:

- `current-system.md`: implemented architecture, current ownership boundaries, runtime topology, API/storage shape, generated local state, and outstanding simplification follow-ups.
- `current-api.md`: current Rust API route reference with auth requirements, inputs, query parameters, response envelopes, limits, and examples.
- `current-schemas.md`: current control-plane and data-plane ClickHouse schemas, operational record kinds, JSON payload shapes, replay rules, and schema change checklist.
- `self-hosted-gcp-clickhouse.md`: current InstantML-owned GCP ClickHouse production/staging operating model, database layout, artifact/R2 cleanup guidance, and verification checklist.
- `auth-and-tenant-flow.md`: Clerk hosted auth, plan-aware signup, invited-member activation, InstantML browser sessions, SDK API keys, org authorization, and hosted ClickHouse tenant routing.
- `multi-instance-cloud-run.md`: split Cloud Run control/data topology, HTTPS public router, request flows, deploy commands, scaling guardrails, ClickHouse allowlisting, and launch checklist.
- `../design/2026-05-14-clickhouse-only-storage.md`: accepted ClickHouse-only local/test storage slice and hosted control-plane/data-plane direction.
- `../design/2026-05-21-rust-server-observability.md`: accepted first Rust server logging slice and Cloudflare edge-log correlation plan.
