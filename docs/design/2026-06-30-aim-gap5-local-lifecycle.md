# Design: Aim Gap 5 Local Workflow And Run Lifecycle

Date: 2026-06-30

Status: Approved for Phase A and source-checkout Phase B implementation

Owner: Codex

Branch: `codex/aim-gap5-local-lifecycle`

## Summary

Aim gives users a simple local loop: initialize a repo/workspace, log locally or
to a small server, and open the UI. Aim also supports basic run hygiene such as
archive/delete from the runs table. InstantML has a stronger hosted/BYOC
architecture and Docker Compose, but the first-run local developer experience is
heavier and the dashboard lacks run archive/delete management.

This branch closes that parity gap with two staged product slices:

1. Production run lifecycle controls for archive, restore, and soft-delete.
2. A local-first CLI workflow that can start the real Rust/ClickHouse API stack
   from a source checkout and generate project-local loopback SDK credentials.

Lifecycle ships first because it is smaller and affects core data semantics.
Local CLI ships second, using the lifecycle controls in end-to-end cleanup
smokes. Both slices must pass review and real E2E verification before the PR is
considered complete.

## Goals

- Add archive, restore, delete, and batch lifecycle routes in Rust with role and
  API-key checks.
- Add Runs table/rail and Run Detail lifecycle UI with confirmations and batch
  actions.
- Ensure archived/deleted runs behave consistently in summaries, search,
  exports, object/artifact views, embeds, reports, and usage/accounting.
- Add `instantml local init`, `instantml local up`, `instantml local status`,
  and `instantml local down` for source checkouts.
- Generate local credentials/config so `instantml.init(project="...")` works
  without manual API-key copy/paste in the local workspace.
- Keep Docker Compose as the local service substrate.
- Document SDK-packaged Compose/web-image startup as a follow-up until published
  local images exist.
- Verify end-to-end with real CLI commands, SDK logging, browser UI actions, and
  backend data checks.

## Non-Goals

- No hosted hard-delete of metric or artifact bytes in this branch.
- No per-user private projects.
- No multi-tenant local auth beyond the existing local dev org/user path.
- No replacement of production Cloud Run/BYOC deployment.
- No Aim file-format compatibility.
- No project rename/delete.

## Users and Use Cases

- An OSS user starts InstantML locally, logs a first run, and opens the UI.
- A researcher archives failed runs and deletes obvious mistakes.
- A team member cleans up selected runs from a project table without deleting
  the project.
- An owner exports data while archived runs remain available only when
  requested.

## Implementation Stages

Phase A: Run Lifecycle

- Backend lifecycle records and projections.
- List/search/export/object/report/embed filtering.
- Runs UI and Run Detail lifecycle controls.
- SDK helpers only where needed for tests and CLI smoke cleanup.

Phase B: Source-checkout Local CLI

- Source-checkout compose adapter.
- Local config/credentials management.
- Service health checks and browser/open hints.
- E2E local stack smoke that logs a run and cleans it up through lifecycle UI.
- SDK-packaged compose templates and web image startup are deferred until the
  image publishing path exists.

If Phase A reveals lifecycle state needs a schema/projection change, update this
doc before starting Phase B.

## Run Lifecycle Model

Lifecycle state is separate from training `status` and stop-control state:

- `active`: default visible state.
- `archived`: hidden from default lists, visible with lifecycle filters.
- `deleted`: soft-deleted tombstone; hidden from product read paths and excluded
  from ordinary exports. Restore from deleted is not supported in this branch.

Lifecycle writes are append-only operational records. The in-memory/store
projection keeps the latest record per `(org_id, run_id)` and applies it before
pagination. Historical run/metric/artifact rows are not mutated.

Operational record:

```json
{
  "kind": "run_lifecycle",
  "id": "...",
  "org_id": "...",
  "run_id": "...",
  "state": "active|archived|deleted",
  "reason": "optional bounded text",
  "actor_id": "...",
  "actor_type": "session|api_key|local",
  "idempotency_key": "optional",
  "created_at": "..."
}
```

Projection fields surfaced in run summaries:

- `lifecycle_state`
- `lifecycle_updated_at`
- `archived_at`
- `deleted_at`

## Permission Matrix

| Caller | Archive | Restore archived | Delete | Batch | Notes |
| --- | --- | --- | --- | --- | --- |
| Browser owner/admin/member | yes | yes | yes | yes | must pass same-origin mutation check |
| Browser viewer | no | no | no | no | read-only export access only |
| Demo read-only browser session | no | no | no | no | existing demo write block applies |
| Org-scoped API key with `runs:control` | yes | yes | yes | yes | can affect all org runs |
| Project-scoped API key with `runs:control` | yes | yes | yes | yes | only runs in scoped project |
| API key without `runs:control` | no | no | no | no | `export:read` alone is insufficient |
| Local unauthenticated context | yes | yes | yes | yes | only non-hosted local mode via existing `RequestContext::local()` path |

All lifecycle routes also require run access. Project-scoped keys check the run's
project before writing the lifecycle record.

## API Contracts

Routes:

- `POST /api/runs/:run_id/archive`
- `POST /api/runs/:run_id/restore`
- `POST /api/runs/:run_id/delete`
- `POST /api/runs/batch-lifecycle`

`POST /delete` is used instead of `DELETE` with a JSON body so confirmations,
reasons, idempotency, and proxies behave predictably.

Archive request:

```json
{ "reason": "bad seed" }
```

Restore request:

```json
{ "reason": "needed for review" }
```

Delete request:

```json
{ "confirm": "delete", "reason": "duplicate" }
```

Batch request:

```json
{
  "run_ids": ["..."],
  "action": "archive",
  "confirm": "archive",
  "reason": "cleanup"
}
```

Responses return updated run summaries or:

```json
{
  "action": "archive",
  "results": [
    { "run_id": "...", "status": "updated", "run": {} },
    { "run_id": "...", "status": "error", "code": "run_not_found", "error": "Run not found" }
  ],
  "updated": 1,
  "failed": 1
}
```

List route additions:

- `lifecycle=active|archived|all`, default `active`.
- `include_archived=true` remains an alias for `lifecycle=all` for UI
  compatibility if simpler.
- Deleted runs are never returned by default list/search/export routes. A future
  admin/audit design may expose them.

Errors:

- `400 run_lifecycle_invalid`
- `403 run_lifecycle_forbidden`
- `404 run_not_found`
- `409 run_lifecycle_conflict`

Idempotency:

- Single and batch routes accept `Idempotency-Key`.
- Repeating archive on archived, restore on active, or delete on deleted returns
  the current projected state and `status: "unchanged"`.
- Restore of deleted returns `409 run_lifecycle_conflict`.
- Concurrent writes are last-write-wins by `created_at` then record id; tests pin
  deterministic replay order.

## Read-Path Semantics

Lifecycle filtering must happen before pagination, sorting, metric summary
hydration, object/artifact joins, and export/report/embed run-set expansion.

- Runs summary/search/overview: default active only; archived visible through
  lifecycle filter; deleted hidden.
- Run detail: active/archived visible; deleted returns 404 for normal users.
- Metrics series: explicit run ID reads for archived runs succeed only when the
  caller can access archived state; deleted runs return 404/empty according to
  existing route style, documented in tests.
- Artifacts/objects: archived visible only through archived run context or object
  explorer lifecycle filters; deleted hidden.
- Exports: active by default; `include_archived=true` includes archived; deleted
  excluded.
- Reports/embeds: saved run sets exclude archived by default unless an explicit
  lifecycle filter is present; deleted is always omitted.
- Stop controls: stop/ack routes reject archived/deleted runs with conflict.

## Usage And Accounting

- Monthly metric-point and API-request rollups are immutable; lifecycle changes
  do not rewrite historical usage.
- Archived runs remain retained resources and continue to count toward run,
  metric, and artifact-storage posture.
- Deleted runs are excluded from user-facing active run counts and from the
  retained run-count limit after soft-delete, but metric rows and artifact bytes
  remain stored until a future purge design.
- Artifact storage bytes for deleted runs are still counted in storage usage
  until purge; current-month high-water bytes are not decremented.
- Usage/admin views should eventually expose deleted-retained storage as a
  separate line item. This PR documents the behavior even if the first UI only
  shows unchanged storage totals.

## Local CLI Design

Commands:

```bash
instantml local init
instantml local up
instantml local status
instantml local down
```

`local init` writes `.instantml/local/config.toml` with:

- API base,
- web base,
- compose file,
- service name.

It also writes `.instantml/local/credentials` with `api_key = "local"` unless
`--no-credentials` is passed. The SDK treats that sentinel as no-auth only for
loopback API bases; hosted URLs still require real credentials.

`local up` supports the source-checkout mode in this PR:

- It adapts the repo-root `docker-compose.yml`.
- It starts the configured `instantml` service by default.
- It waits for `/health` unless `--no-wait` is passed.
- It prints API/web URLs and the SDK import hint.

Packaged mode remains a follow-up because this repository does not yet publish
the API and web images needed for a PyPI-only Compose template. That follow-up
must not print "go clone the repo" as the happy path. If Docker, Compose, or
images are unavailable, it should exit nonzero with the exact missing dependency
and the command it attempted.

`local status` prints service health, API base, web base, credential target, and
the compose project name. `local down` stops services without deleting volumes
unless `--volumes` is passed.

## Component Impact

Backend:

- Add lifecycle DTOs, operational records, projection helpers, routes, auth
  checks, OpenAPI annotations, and route coverage across summaries/search/export.

Frontend:

- Add lifecycle filters, row actions, selected-run batch actions,
  confirmations, Run Detail controls, and URL state.

Python SDK:

- Add local CLI commands.
- Generate project-local loopback credentials resolved before global login
  credentials.

Storage:

- Append lifecycle records to ClickHouse operational state.
- No hard mutation of historical run rows.

Docs:

- Update root setup, SDK CLI docs, Rust/web READMEs, and public quickstart.

## Performance Considerations

- Lifecycle filtering happens before pagination.
- Batch cap: 100 runs per request.
- Lifecycle writes are low-volume and append-only.
- Summary route p95 target remains inside existing large-run benchmark budgets.
- Add benchmark/search smoke covering archived runs so pagination does not
  return short pages after filtering.
- Local CLI status/up health checks should use short bounded timeouts and avoid
  unbounded log streaming.

## Simplicity Review

The simplest lifecycle model is append-only soft state layered over runs, not
destructive mutation. The simplest local workflow reuses Docker Compose and the
real Rust/ClickHouse/web stack rather than adding a second embedded backend.
Staging the branch keeps implementation honest: lifecycle semantics land before
the CLI relies on them for cleanup.

Deferred:

- Hard purge and artifact-byte deletion.
- Deleted-run restore.
- Project rename/delete.
- Per-user private visibility.
- SDK-packaged Compose templates and web/API image overrides once image
  publishing is available.

## Failure Modes

- Docker unavailable: CLI prints the missing dependency and exits nonzero.
- Local service health timeout: CLI shows the status/logs command and leaves
  config intact.
- Credential creation fails: CLI does not write partial credentials.
- Hosted credentials already exist: CLI asks for explicit `--overwrite-credentials`
  or writes a named local profile if profiles exist by implementation time.
- Archive/delete conflict: repeated archive/delete is idempotent where safe;
  restore of deleted run fails with conflict.
- Batch partial failure: response reports per-run status; UI summarizes
  successes and failures.
- Projection replay order conflict: deterministic tie-breaker by created time
  and record id.

## Testing Plan

- Rust tests for archive/restore/delete auth, projection replay, search/export/
  list filtering, idempotency, batch partial failures, deleted conflict, and
  project-scoped API-key enforcement.
- Frontend tests for lifecycle filters, confirmations, batch actions, Run Detail
  controls, keyboard/focus behavior, and empty states.
- SDK CLI tests with subprocess/mocked compose for init/status/down/up command
  construction and config parsing.
- Real local smoke: `instantml local init`, `instantml local up`, SDK log run,
  open UI, inspect run, archive/delete via browser, verify summaries.
- Browser/computer-use pass for the full local workflow and cleanup.
- Auto-review before commit: diff review, focused tests, real CLI/browser smoke,
  and evidence added to this doc.

## Documentation Plan

- `README.md` and `SETUP.md`: local quickstart.
- `packages/python-sdk/README.md`: local CLI commands and credential behavior.
- `apps/rust-server/README.md`: lifecycle endpoints, filtering rules, and local
  auth interaction.
- `apps/web/README.md`: lifecycle UI behavior.
- `apps/docs`: public local quickstart and run lifecycle docs.

## Alternatives Considered

- Build a standalone local SQLite backend. Rejected because current product
  truth is Rust/ClickHouse, and users need to test the real stack.
- Keep local CLI source-checkout only. Rejected for Aim-style local parity; the
  packaged SDK must carry a runnable compose template.
- Use `DELETE /api/runs/:id` with a JSON body. Rejected because JSON bodies on
  DELETE are brittle across clients/proxies; `POST /delete` carries
  confirmation and idempotency cleanly.
- Hard-delete immediately. Rejected because artifact retention, lineage, usage,
  imports, and audit need a separate purge policy.
- Make lifecycle just a tag. Rejected because archived/deleted visibility must
  affect pagination, exports, search, and permissions consistently.

## Review Notes

Fresh reviewer 1:

- Finding: Combining local startup and lifecycle was too broad without staging;
  lifecycle semantics, permissions, usage effects, and projection consistency
  were underspecified.
- Risk: The PR could produce inconsistent search/export behavior or unsafe
  destructive routes.
- Recommended edit: Stage implementation, define permission matrix, use
  `POST /delete`, specify idempotency/concurrency and usage/accounting effects.
- Decision: Block until revised.

Fresh reviewer 2:

- Finding: Local CLI could not claim Aim-style parity while telling installed SDK
  users outside a checkout to go elsewhere.
- Risk: The local workflow would work only for contributors, not real users.
- Recommended edit: Add SDK-packaged compose templates or narrow the claim; make
  startup failures explicit and testable.
- Decision: Block until revised.

Re-review:

- Reviewer 1: Approved with stage guardrail. Begin with Phase A lifecycle only;
  before Phase B local CLI work, confirm packaged compose templates and required
  images are available or provide a tested override/build path.
- Reviewer 2: Approved. Keep Phase A and Phase B separately reviewable inside
  the PR.

## Progress Log

- 2026-06-30: Created dedicated branch/worktree and drafted design before
  implementation.
- 2026-06-30: Revised design after two fresh reviews to stage lifecycle/local
  work, replace DELETE-with-body with `POST /delete`, define permissions,
  idempotency, read-path filtering, usage effects, and packaged local compose
  requirements.
- 2026-06-30: Two fresh reviewers approved Phase A implementation; Phase B must
  re-check packaged compose/image feasibility before edits begin.
- 2026-06-30: Packaged compose/image feasibility check found no published web
  image path in this repository. Narrowed Phase B in this PR to a
  source-checkout local CLI with project-local loopback credentials and kept
  SDK-packaged templates as a documented follow-up.
- 2026-06-30: Implemented Phase A lifecycle records, Rust routes, OpenAPI
  generation, Runs/Detail UI controls, and lifecycle-aware summary/export/read
  filtering. Added Phase B source-checkout `instantml local` config,
  credential, status, and Compose adapter commands.
- 2026-06-30: Verification passed for focused Rust lifecycle/control tests,
  Rust lint, web typecheck/build, Python SDK CLI/credential tests, local
  `instantml local init` credential creation, and a browser-backed dashboard
  archive action. Docker Compose startup could not run on this workstation
  because Docker is not installed; the CLI exits with the intended dependency
  message and the Compose command path is covered by unit tests.
- 2026-06-30: Added a session-cookie local API smoke using `/api/auth/dev/google`
  to create a throwaway workspace/run, archive it, restore it, soft-delete it,
  verify lifecycle-filtered summaries, and confirm exact reads return 404 after
  deletion.
- 2026-06-30: Independent PR review found lifecycle accounting drift: deleted
  runs still counted toward retained run usage/write gates, and active summary
  totals could use raw run counters after archive/delete. Fixed by counting only
  readable non-deleted runs for usage while keeping archived runs retained, and
  by disabling the raw active-total fast path when an org has archived/deleted
  lifecycle rows. Added regression tests for both paths.

## Coverage Exceptions

No permanent coverage exceptions planned. Focused local verification may disable
the global whole-repo coverage gate when running a narrow subset; the full CI
suite remains responsible for the repository-wide 100% meaningful coverage
target.

## Decision

Approved for Phase A and the source-checkout Phase B slice. SDK-packaged
Compose/web-image startup requires a new implementation pass after image
publishing exists.
