# Documentation

This directory contains product, architecture, user research, and design documentation for InstantML.

Current product direction: InstantML is a hosted SaaS-first W&B-style competitor for smaller startups, research labs, and lean ML teams. The intended wedge is speed, UI quality, and predictable pricing. RL, robotics, simulation, Neptune migration, W&B import/dual-logging, and MLflow import remain important workflows, but they are not the top-level brand boundary.

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
- External user guide: `../USER_DOCS.md`.
- Working tasks: `../TODO.md`.
- Fresh setup: `../SETUP.md`.
- Current implemented architecture: `architecture/current-system.md`.
- Current Rust API reference: `architecture/current-api.md`.
- Primary backend foundation: `design/2026-05-14-clickhouse-only-storage.md`.
- Validation plan: `users/2026-05-09-validation-plan.md`.
- Open-source and brand policy: `product/2026-05-09-open-source-brand.md`.
- Future-agent workflow: `../AGENTS.md`.
- Accepted implementation decisions: `design/`.

Accepted backend direction:

```text
Default:    Next/React + Python SDK -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
Deprecated: Next/React + Python SDK -> Node compatibility API -> JSON state/local artifacts
```

Docs should keep that distinction explicit. The ClickHouse-only storage design is accepted for the local/test first slice, with hosted control-plane/data-plane service routing deferred to a later coordination design. The Node server remains only as a compatibility oracle, JSON migration source, and legacy fallback until migration tooling and any remaining route-shape checks are retired.

When these disagree, update the older document or create a superseding design before building.
