# Design: Repository Operating Model

Date: 2026-05-05

Status: Accepted and current operating model

Owner: Codex

## Summary

This design establishes the repository operating model before implementation begins. The project should be built as a small monorepo with separate areas for the backend API, frontend web app, Python SDK, examples, and documentation. Each component should have its own README, tests, commands, and clear ownership expectations.

The key product risk is not whether agents can create code quickly. The risk is accumulating complex, undocumented, loosely tested code before the first end-to-end workflow is validated. This operating model biases the project toward simple design docs, narrow implementation slices, high coverage, and documentation that stays close to the code.

## Goals

- Define future-agent expectations in a repo-level `AGENTS.md`.
- Require design documents before meaningful implementation.
- Require fresh no-context architecture review before implementation.
- Establish separate component directories for backend, frontend, SDK, examples, and docs.
- Require README files in every component and meaningful subdirectory.
- Set a 100% meaningful first-party code coverage target for product logic.
- Prefer simple, direct code over complex or archaic patterns.

## Non-Goals

- Choose the final backend, frontend, database, or SDK tooling.
- Implement product features.
- Create CI configuration.
- Create package managers or lockfiles.
- Define the full production deployment architecture.

## Users and Use Cases

The primary users of this design are future agents and contributors. They need a predictable way to decide:

- Where code belongs.
- What documentation must be updated.
- When a design doc is required.
- How much test coverage is expected.
- How to keep the architecture simple.
- How to ask for architecture review before building.
- What first vertical slice to build.
- When process can stay lightweight.

## Proposed Design

The repository should use this structure:

```text
rl-observability/
  apps/
    api/        # Python bootstrap/reference API
    rust-server/  # Primary Rust API + Postgres migrations
    server/     # Deprecated Node compatibility API and JSON migration source
    web/        # Next/React frontend application
  packages/
    python-sdk/
  examples/
  docs/
    design/
    product/
    architecture/
    users/
```

The repo root should contain:

- `README.md`: entry point for humans and agents.
- `AGENTS.md`: mandatory operating guidelines.
- `PRODUCT_STRATEGY.md`: product and market direction.

Each component directory should contain a README explaining:

- Purpose
- Setup
- Common commands
- Testing commands
- Coverage expectations
- Key files and subdirectories
- Relevant design docs
- Notes for future agents

Subdirectory READMEs should be added only when commands, ownership, conventions, public APIs, test behavior, or setup differ from the parent. This keeps documentation practical instead of ceremonial.

Design docs should live in `docs/design/` and follow `docs/design/TEMPLATE.md`. Substantial implementation should not begin until the design has review notes from two fresh reviewers or agents with no prior context.

The review requirement applies to:

- New product workflows.
- New backend services or database tables.
- New SDK public APIs.
- New frontend screens with data dependencies.
- Import/export pipelines.
- Authentication/authorization changes.
- Performance-sensitive paths.
- Cross-component contracts.
- Shared internal packages or abstractions across components.

The review requirement does not apply to:

- Scaffolding directories.
- README creation.
- Config placeholders.
- Typo fixes.
- Small test-only changes.
- Tiny localized bug fixes inside an accepted design.

Reviewers may approve a narrow first slice with known follow-ups. The review should prevent unnecessary complexity without forcing the entire future architecture to be designed at once.

The first preferred vertical slice is:

1. Python SDK creates a run.
2. Python SDK logs scalar metrics.
3. API stores the run and metrics locally.
4. UI lists runs with summary values.
5. UI shows a bounded metric chart for one run.

Auth, imports, artifacts, checkpoint lineage, deployment hardening, and shared internal packages should be deferred until this path works.

Current status: the first vertical slice is complete. Follow-up work should preserve the operating model while focusing on the current `PRODUCT_STRATEGY.md` priorities: W&B-style training observability, reliable SDK ingestion, durable Rust/Postgres/object storage, a fast/comprehensible comparison UI, and importer/dual-logging paths as adoption tools.

## Component Impact

Backend:

- Python bootstrap/reference API lives under `apps/api/`.
- Current product API work lives under `apps/rust-server`; the Next/React UI lives under `apps/web`.
- `apps/server` is retained as a deprecated Node compatibility oracle, JSON migration source, and legacy fallback unless a design doc explicitly retires it.
- Both backend surfaces must document commands, database/storage setup, tests, and coverage.

Frontend:

- Will live under `apps/web/`.
- Must document UI commands, component conventions, tests, accessibility expectations, and coverage.

Python SDK:

- Will live under `packages/python-sdk/`.
- Must document SDK setup, public API, tests, packaging, and examples.

Storage:

- Current product storage is Postgres through `apps/rust-server`, with local artifact storage behind an abstraction and future S3-compatible object storage planned for hosted bytes.
- Future storage changes must have their own design docs.

Docs:

- Documentation becomes a required part of the development workflow.

## Data Model

No application data model is introduced by this design.

## API Contracts

No product API contracts are introduced by this design.

## Performance Considerations

This operating model affects performance indirectly by requiring future designs to document expected data volume, query patterns, batching, indexes, and latency expectations before implementation.

Future agents should be especially careful around:

- Metric ingestion throughput.
- Metric query fanout.
- Runs table pagination and filtering.
- Artifact upload paths.
- SDK overhead inside training loops.

The process should prevent speculative optimization while making real performance requirements explicit early.

Default performance rules:

- SDK metric logging should avoid blocking the training loop on artifact work or expensive serialization.
- Run list endpoints must be paginated from the start.
- Table and list endpoints should return summaries only.
- Metric history should be fetched through separate bounded endpoints filtered by run, key, step range, time range, or explicit limit.
- Default dashboards must not fetch full metric history.
- Artifact upload/download paths must not share the scalar metric hot path.
- Endpoints expected to return more than 1,000 records need explicit pagination, limits, or streaming behavior.

Future design docs must state expected rows/items, write frequency, read/query shape, latency target, pagination or streaming behavior, indexes, memory concerns, batching needs, and measurement plan.

## Simplicity Review

This is the simplest useful operating model because it introduces only:

- A repo-level agent guide.
- A design-doc template.
- Component directories with READMEs.
- A review checkpoint before implementation.

It intentionally does not add tooling, CI, package management, or code scaffolding yet.

It also avoids shared internal packages at the start. Shared abstractions across API, web, and SDK should require a design note and should usually wait until duplication is real.

## Failure Modes

- Future agents may skip design docs.
  - Mitigation: `AGENTS.md` and component READMEs repeat the requirement.

- READMEs may become stale.
  - Mitigation: documentation updates are included in the definition of done.

- 100% coverage may encourage low-value tests.
  - Mitigation: guidelines state that coverage is necessary but not sufficient; tests must verify meaningful behavior.

- Architecture review may slow down tiny changes.
  - Mitigation: tiny localized fixes and doc-only edits do not require a new design doc.

- Review requirements may become too heavy for greenfield iteration.
  - Mitigation: the change-size rubric separates substantial changes from localized and doc/test-only changes.

- Documentation may become ceremonial.
  - Mitigation: subdirectory READMEs are required only when they add distinct commands, ownership, conventions, public APIs, test behavior, or setup.

## Testing Plan

This change is documentation-only. No code tests are required.

When implementation begins, each component should define its own test runner and coverage command. First-party product logic should target 100% meaningful coverage. Intentional exclusions should be documented with uncovered area, reason, risk, follow-up, and owner/date.

## Documentation Plan

This design is accompanied by:

- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/design/README.md`
- `docs/design/TEMPLATE.md`
- Component README files

## Alternatives Considered

### Single README only

Rejected because component-specific commands and conventions will diverge quickly.

### Full tool scaffolding now

Rejected because stack choices should be made in focused design docs rather than implied by placeholder code.

### No review requirement

Rejected because the user explicitly wants no-context review before implementation, focused on performance and simplicity.

## Review Notes

Fresh reviewer 1:

- Finding: The operating model is appropriately small and avoids premature stack choices, but the review rule and README rule could become too heavy without sizing guidance.
- Risk: Future agents may spend too much time on process or generate documentation churn.
- Recommended edit: Add a change-size rubric, define when subdirectory READMEs are useful, and allow narrow first-slice approvals.
- Decision: Accepted and incorporated.

Fresh reviewer 2:

- Finding: The design protects simplicity, but it needs operational performance budgets and a concrete first vertical slice.
- Risk: Future list views or dashboards could accidentally load all metrics, and future agents may not know where to start.
- Recommended edit: Add default performance rules for bounded queries, pagination, metric history, SDK logging, artifact paths, and a first SDK -> API -> UI slice.
- Decision: Accepted and incorporated.

## Decision

Accepted for repository bootstrap.
