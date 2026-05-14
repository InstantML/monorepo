# Agent Guidelines

These guidelines are for every future agent or contributor working in this repository. Keep them current as the product, architecture, and development workflow evolve.

## Core Principles

1. Prefer simple code.
   Use clear data structures, direct control flow, and boring technology choices. Avoid clever abstractions, metaprogramming, hidden magic, or archaic patterns unless a design document explains why they are necessary.

2. Design before implementation.
   Every meaningful feature, architectural change, storage change, API contract, or cross-component workflow must start with a design document in `docs/design/`.

3. Optimize for performance through clarity.
   Measure before adding complexity. Prefer simple schemas, explicit indexes, streaming or batching where needed, and straightforward profiling over speculative optimization.

4. Maintain component boundaries.
   Backend, frontend, SDK, examples, and docs live in separate directories. Each directory and meaningful subdirectory must have a README that explains its purpose, commands, tests, and ownership expectations.

5. Keep documentation alive.
   If you change behavior, APIs, architecture, setup, tests, or conventions, update the nearest README and any relevant design docs in the same change.

6. Test thoroughly.
   The project target is 100% meaningful coverage for first-party core logic, API behavior, SDK behavior, and important UI states. Do not chase brittle tests around generated files, framework glue, or placeholder scaffolding. If full coverage is temporarily unreasonable, document the exclusion, reason, risk, and follow-up in the relevant README or design doc.

7. Build thin end-to-end paths first.
   A small working loop is better than a broad half-built platform. Prioritize SDK -> API -> database -> UI visibility before secondary features.

8. Avoid lock-in.
   Keep data portable and APIs understandable. Prefer open formats, documented schemas, and clear export paths.

## Required Workflow

### 1. Read Context

Before changing code, read:

- `PRODUCT_STRATEGY.md`
- This `AGENTS.md`
- The README in every component you will touch
- Any relevant design docs in `docs/design/`

### 2. Classify the Change

Use this rubric before editing:

- Substantial change: requires a design doc and fresh review before implementation.
- Localized change: does not require fresh review, but update nearby docs/tests if behavior changes.
- Doc/test-only change: does not require a design doc unless it changes accepted architecture or policy.

Substantial changes include:

- New product workflow
- New backend service or database table
- New SDK public API
- New frontend screen with data dependencies
- Import/export pipeline
- Authentication/authorization change
- Performance-sensitive path
- Cross-component contract
- Shared internal package or abstraction across components

Localized changes include:

- Small bug fix within an accepted design
- Minor endpoint/UI adjustment that preserves an existing contract
- Adding tests for existing behavior
- Small refactor within a single module that does not alter behavior

Doc/test-only changes include:

- README updates
- Typo fixes
- Design-doc review notes
- Test fixture cleanup
- Empty directory or placeholder setup

### 3. Create or Update a Design Doc

Create a design doc before implementing:

- New product workflow
- New backend service or database table
- New SDK API
- New frontend screen with data dependencies
- Import/export pipeline
- Authentication/authorization change
- Performance-sensitive path
- Cross-component contract

Small typo fixes, doc-only edits, obvious test additions, scaffolding directories, config placeholders, and tiny localized bug fixes do not need a new design doc.

Use `docs/design/TEMPLATE.md` as the starting point.

### 4. Request Architecture Review

Before implementation begins, ask at least two fresh reviewers or agents with no prior context to review the design doc. They should focus on:

- Simplicity
- Performance
- Correctness
- Maintainability
- Failure modes
- Whether the feature can be built in a smaller first slice

Record review notes in the design doc under "Review Notes" or create a linked file beside it.

Reviewers may approve a narrow first slice with known follow-ups. The review should block unnecessary complexity, not require the entire future architecture to be designed at once.

### 5. Implement Narrowly

Implement only the accepted design slice. Avoid unrelated refactors. If implementation reveals the design is wrong, update the design doc before continuing.

### 6. Test and Verify

Every change should include tests appropriate to its risk:

- Unit tests for pure logic and SDK behavior
- API tests for backend endpoints and persistence behavior
- Component tests for UI states and interactions
- Integration tests for SDK -> API -> storage workflows
- Importer tests with representative fixtures

Run the relevant test suite before finishing. If tests cannot run, document why.

### 7. Update Documentation

Update all relevant README files and design docs before completing work. Documentation updates are part of the change, not a follow-up.

## Directory Expectations

Each top-level component directory must include a README with:

- Purpose
- Local setup
- Common commands
- Testing commands
- Coverage expectations
- Key files and subdirectories
- Design docs that affect the component
- Notes for future agents

Add subdirectory READMEs only when commands, ownership, conventions, public APIs, test behavior, or setup differ from the parent. Avoid ceremonial README sprawl.

Expected structure:

```text
monorepo/
  apps/
    api/        # Python bootstrap/reference API
    rust-server/  # Primary Rust API + ClickHouse schema
    server/     # Deprecated Node compatibility API
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

Current backend ownership:

- Put new product API, typed attributes, importer, artifact, and UI-serving work in `apps/rust-server`. It is now the primary backend after passing shared contract, SDK, and UI parity checks against the Node server.
- Keep `apps/server` as a deprecated Node compatibility oracle for route-shape regression tests, JSON migration fixtures, and legacy local fallback only. Do not add new product surface there unless the change exists to preserve or compare compatibility.
- Keep `apps/api` as the days 1-4 Python bootstrap/reference implementation and SDK compatibility test target. Do not expand it into a competing production backend without a design doc.
- Keep endpoint overlap between `apps/api`, `apps/server`, and `apps/rust-server` compatible where the SDK depends on more than one implementation.

## Simplicity Guidelines

Prefer:

- Small modules with one clear responsibility
- Explicit data models
- Typed interfaces at component boundaries
- Plain SQL or a lightweight ORM used consistently
- Simple REST endpoints before complex RPC or event systems
- Local-first defaults
- Minimal dependencies
- Reusable helpers only after duplication is real
- Per-component code before shared internal packages

Avoid:

- Premature microservices
- Complex inheritance trees
- Framework features that obscure control flow
- Dynamic code generation for normal app logic
- Global mutable state
- Unbounded background work
- Untested concurrency
- Hidden network calls
- Large abstractions created before the second use case exists
- Shared cross-component abstractions before duplication proves they are needed

## Performance Guidelines

Design for expected scale without overbuilding. The first credible target is:

- 50+ runs compared smoothly
- Thousands of metric points per run
- Artifacts stored without blocking metric logging
- Responsive runs table filtering and sorting
- SDK logging that does not materially slow a training loop

Performance expectations:

- Batch metric writes in the SDK or API when useful.
- Keep artifact uploads separate from scalar metric logging.
- Add database indexes intentionally and document why.
- Avoid loading all metric history for every table view.
- Prefer pagination or bounded queries for list endpoints.
- Use profiling before introducing complex caching.
- Document expected data volume in every performance-sensitive design doc.
- Table and list endpoints should return summaries only.
- Metric series should be fetched through separate bounded endpoints filtered by run, key, step range, time range, or explicit limit.
- Artifact upload/download paths must not share the scalar metric hot path.

Initial performance budgets:

- SDK `log` calls should avoid blocking the training loop on slow artifact work or expensive serialization.
- Run list endpoints must be paginated from the start.
- Default dashboard queries must not fetch full metric history.
- Metric comparison views must request bounded series data.
- Any endpoint expected to return more than 1,000 records needs an explicit pagination or streaming design.

## Testing and Coverage Guidelines

The repository target is 100% meaningful coverage for first-party code that contains product logic.

Coverage alone is not enough. Tests should also verify behavior that matters:

- Failed API requests return useful errors.
- SDK logging survives transient failures where practical.
- Metrics are stored with correct run IDs, steps, and keys.
- Artifacts are associated with the right run and step.
- Importers preserve key run/config/metric/artifact data.
- UI components handle loading, empty, error, and populated states.

Do not lower coverage thresholds casually. If an exception is needed, explain:

- What is uncovered
- Why it cannot reasonably be covered now
- What risk remains
- How to cover it later

Coverage exception template:

```text
Coverage exception:
- Uncovered area:
- Reason:
- Risk:
- Follow-up:
- Owner/date:
```

## Documentation Guidelines

Documentation should be practical and close to the code it describes.

Update docs when:

- Commands change
- Dependencies change
- Public APIs change
- Data models change
- Screens or workflows change
- Tests are added or reorganized
- Architecture decisions are accepted or reversed

Keep docs concise, but do not omit operational details future agents need.

## First Vertical Slice

The first implementation should be the smallest useful end-to-end workflow:

1. Python SDK creates a run.
2. Python SDK logs scalar metrics.
3. API stores the run and metrics locally.
4. UI lists runs with summary values.
5. UI shows a bounded metric chart for one run.

Defer auth, imports, artifacts, checkpoint lineage, deployment hardening, and shared internal packages until this path works.

Status: this first vertical slice is complete. The current strategy now positions the product as Training Observability: a general training-loop observability product and W&B-style competitor. Near-term work should prioritize reliable SDK ingestion, a fast/comprehensible comparison UI, durable Rust/ClickHouse/object storage, and importer/dual-logging paths as adoption tools.

Accepted backend direction: `Next/React frontend -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage` and `Python SDK/uploader -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage` is now the default setup. Hosted work should split a global user/control-plane ClickHouse layer from org/cell data-plane services only after the coordination/reconciliation design in `docs/design/2026-05-14-clickhouse-only-storage.md` is implemented. Rust work should use `axum + tokio + ClickHouse`, preserve current route shapes, keep `org_id` on tenant-owned data, maintain metric summaries at ingestion time, and keep the shared Node compatibility smokes available before removing or changing legacy route behavior.

Current known simplicity/comprehensibility follow-ups:

- Make server batch/import/upload failures transactional or explicitly documented as partial writes.
- Split frontend chart, artifact, and side-by-side loading so stale async responses cannot render old state.
- Add UI pagination before projects exceed the first 100 runs.
- Canonize metric step semantics across the Node server, Python bootstrap API, SDK, docs, and importers.
- Keep automatic SDK source metadata from being overwritten by user-provided metadata.
- Document that SDK offline replay currently covers post-run-create events only.

## Design Doc Naming

Use this format:

```text
docs/design/YYYY-MM-DD-short-topic.md
```

Examples:

- `docs/design/2026-05-05-python-sdk-logging.md`
- `docs/design/2026-05-05-metric-storage.md`
- `docs/design/2026-05-05-run-comparison-ui.md`

## Definition of Done

A change is done when:

- The implementation matches an accepted design doc, if one was required.
- Relevant tests pass.
- Coverage remains at the repository target or any gap is documented.
- Relevant README files are updated.
- Public APIs and commands are documented.
- The change is scoped and does not include unrelated refactors.
- Future agents can understand why the change exists.
