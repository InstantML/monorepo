# Documentation

This directory contains product, architecture, user research, and design documentation for InstantML.

Current product direction: InstantML is a hosted SaaS-first W&B-style competitor for smaller startups, research labs, and lean ML teams. The intended wedge is speed, UI quality, and predictable pricing. RL, robotics, simulation, Neptune migration, W&B import/dual-logging, and MLflow import remain important workflows, but they are not the top-level brand boundary.

Current pricing direction: the first self-serve packaging model is Free, Pro, and Premium. Signup records the selected plan, the dashboard topbar and Settings expose plan usage guardrails and seat invites, the API tab exposes API-key management, and warehouse sizing is recorded as plan intent unless explicit operator spend gates allow plan-sized provisioning. New project, run, metric-ingest, artifact, import, and demo-reset writes are blocked at plan limits until billing/provider reconciliation and paid overages exist. Metric-point limits are measured within the current UTC calendar month and reset on the first day of the next month; storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource counts.

Future agents must update documentation whenever they change:

- Product behavior
- Architecture
- Setup commands
- API contracts
- SDK APIs
- Frontend workflows
- Database schemas
- Testing strategy
- Coverage expectations

## Subdirectories

- `design/`: Required design docs before meaningful implementation.
- `product/`: Product requirements, positioning, and roadmap material.
- `architecture/`: Longer-lived architecture references.
- `users/`: Customer discovery, user personas, and interview notes.

## Current Sources Of Truth

- Strategy and roadmap: `../PRODUCT_STRATEGY.md`.
- Public user, SDK, API, architecture, and operations docs:
  `../apps/docs/`.
- Legacy condensed external-user guide: `../USER_DOCS.md`.
- Working tasks: `../TODO.md`.
- Fresh setup: `../SETUP.md`.
- Current implemented architecture: `architecture/current-system.md`.
- Split Cloud Run architecture: `architecture/multi-instance-cloud-run.md`.
- Current Rust API reference: `architecture/current-api.md`.
- Current control/data-plane schemas: `architecture/current-schemas.md`.
- Pricing and margin model: `product/pricing-and-margins.md`.
- Primary backend foundation: `design/2026-05-14-clickhouse-only-storage.md`.
- Pricing/signup/admin implementation design: `design/2026-05-16-pricing-signup-org-admin.md`.
- Validation plan: `users/2026-05-09-validation-plan.md`.
- Open-source and brand policy: `product/2026-05-09-open-source-brand.md`.
- Future-agent workflow: `../AGENTS.md`.
- Accepted implementation decisions: `design/`.

Accepted backend direction:

```text
Default:    Next/React + Python SDK -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
Deprecated: Next/React + Python SDK -> Node compatibility API -> JSON state/local artifacts
```

Docs should keep that distinction explicit. The ClickHouse-only storage design is accepted for the local/test first slice, and hosted control-plane/data-plane service routing now has split Cloud Run launch wiring with single-writer data-cell defaults. The Node server remains only as a compatibility oracle, JSON migration source, and legacy fallback until migration tooling and any remaining route-shape checks are retired.

When these disagree, update the older document or create a superseding design before building.
