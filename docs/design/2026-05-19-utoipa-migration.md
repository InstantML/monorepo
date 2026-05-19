# utoipa-driven OpenAPI + TypeScript codegen pipeline

Status: in flight (partial rollout). Owner: api / web infra.
Started: 2026-05-19.

## Why

Every new endpoint touched ~7 files because Rust types, OpenAPI spec, and
TypeScript types were maintained manually in three places that could drift.

The org-switcher PR exemplified the cost: adding the
`OrganizationMembershipSummary` type required a hand-written Rust struct, a
hand-written OpenAPI entry in `openapi_json`, and a hand-written TS shape in
the dashboard components — all of which had to stay in sync.

The fix is "Option B" — eliminate drift at the source by annotating Rust
handlers with `utoipa` macros so the OpenAPI spec is generated FROM the
handlers, then running TypeScript codegen against that generated spec. Single
source of truth: the Rust code itself.

## What shipped in the initial PR

### Backend (`apps/rust-server`)

- `utoipa = "5.3.1"` added with `axum_extras`, `chrono`, `uuid` features.
- `crate::http::openapi::ApiDoc` is the root `#[derive(OpenApi)]` struct.
  It collects annotated handlers via `paths(...)` and registers all public
  domain types via `components(schemas(...))`.
- 30+ types in `domain.rs` now derive `utoipa::ToSchema`. `Value` fields use
  `#[schema(value_type = Object)]` so they emit as free-form `object` in the
  spec.
- Envelope wrapper structs (`RunEnvelope`, `ProjectsEnvelope`,
  `InsertedEnvelope`, etc.) model the `{ "run": ... }` / `{ "projects": [...] }`
  response shapes that handlers emit. Each handler references the matching
  envelope in its `responses(...)`.
- 12 handlers carry full `#[utoipa::path(...)]` annotations in the initial
  pass:
  - platform: `health`, `readyz`
  - auth: `auth_config`, `auth_session`, `auth_logout`
  - orgs: `list_orgs`, `list_seats`, `list_api_keys`
  - runs: `create_project`, `list_projects`, `create_run`, `list_runs`,
    `get_run`, `update_run`, `log_metrics`
- `GET /openapi.json` (the existing endpoint) now serves `ApiDoc::openapi()`
  merged with the legacy hand-rolled paths. Utoipa paths win on collision —
  so as handlers migrate, the legacy entry becomes dead code that we can
  delete.
- New CLI subcommand `instantml-rust-server emit-openapi` prints the
  utoipa-generated spec to stdout. No running server / database needed for
  codegen.

### Frontend (`apps/web`)

- `openapi-typescript@7.5.2` added as a dev dependency at the monorepo root.
- `npm run codegen:api` (`tools/codegen-api.mjs`) drives the full pipeline:
  1. `cargo run -- emit-openapi` → JSON spec.
  2. Spec written to `apps/rust-server/openapi.generated.json` (committed —
     acts as a snapshot for code review).
  3. `openapi-typescript` converts the spec into
     `apps/web/src/types/api.generated.ts`.
- `npm run verify:api-types` is the same pipeline plus a `git diff
  --exit-code` guard. Wire this into CI so PRs that change Rust handlers
  but skip codegen fail loudly.
- Proof-of-concept frontend migration: `dashboard-shell.tsx` swaps its
  hand-rolled `SeatRow`, `ApiKeyRow`, and `WorkspaceViewSummaryPayload`
  declarations for `components["schemas"][...]` aliases sourced from
  `api.generated.ts`.

## Validation gates (as of this PR)

- `cargo check --manifest-path apps/rust-server/Cargo.toml` — clean.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo fmt -- --check` — clean.
- `cargo test --lib` — 100 passed (was 99 before; adds
  `utoipa_apidoc_emits_annotated_paths_and_schemas`).
- `npm run codegen:api` — succeeds; emits 12 paths and 64 schemas.
- `cd apps/web && next build` — clean.

## What's queued (un-annotated handlers)

The current `/openapi.json` is still legacy-driven for these. Migrate one
batch at a time. The pattern (see `list_seats` or `log_metrics` for examples):

1. Add `#[utoipa::path(...)]` directly above the handler with:
   - `method` (`get`, `post`, `patch`, `put`).
   - `path` (use `{name}` for axum path params).
   - `tag` (one of platform / auth / orgs / runs / dashboard, or add a new
     tag in `openapi.rs`).
   - `request_body = crate::domain::SomeRequest` for handlers that consume
     a body.
   - `params(...)` for path / query params.
   - `responses(...)` — point each status code at an envelope or domain
     type. Add a new envelope struct in `openapi.rs` if no existing one
     matches.
   - `security(...)` — `("bearerApiKey" = [])`, `("browserSession" = [])`,
     `("bootstrapToken" = [])`, or `security()` for fully public endpoints.
2. Add the handler ident to `paths(...)` in `crate::http::openapi::ApiDoc`.
3. Add the test path string to `utoipa_apidoc_emits_annotated_paths_and_schemas`.
4. Remove the corresponding `openapi_insert(...)` block from the legacy
   `openapi_json` handler in `handlers.rs`.
5. `npm run codegen:api` and commit the diff in
   `apps/rust-server/openapi.generated.json` and
   `apps/web/src/types/api.generated.ts`.

### Handlers still on the legacy index

```
GET    /metrics
GET    /openapi.json                                # self-referential, low value
POST   /api/auth/dev/google
POST   /api/auth/clerk
POST   /api/auth/device-code/{start,poll,confirm}
GET    /api/dashboard/preferences                   # PUT, too
GET    /api/workspace-views                         # POST, too
GET    /api/workspace-views/{view_id}               # PUT, too
POST   /api/users                                   # GET, too
POST   /api/orgs                                    # POST sibling
GET    /api/orgs/name-availability
POST   /api/orgs/{org_id}/api-keys
POST   /api/orgs/{org_id}/seats
POST   /api/orgs/{org_id}/api-keys/{api_key_id}/revoke
POST   /api/orgs/{org_id}/service-accounts/{service_account_id}/disable
GET    /runs/{run_id}/metrics
POST   /api/metrics/series
POST   /api/runs/{run_id}/logs                      # GET, too
GET    /api/overview
GET    /api/runs/summary
GET    /api/runs/side-by-side
POST   /api/runs/{run_id}/attributes                # GET, too
POST   /api/runs/{run_id}/objects                   # GET, too
GET    /api/objects/{object_id}/rows
POST   /api/runs/{run_id}/artifacts                 # GET, too
POST   /api/runs/{run_id}/artifacts/upload
GET    /api/artifacts/{artifact_id}/download
GET    /api/export
GET    /api/usage
GET    /api/usage/export
GET    /api/imports
POST   /api/imports/neptune                         # wandb, mlflow
```

Approximately 35 paths. Each is ~15 LOC of macro. Suggested
batching: one PR per logical area (auth / dashboard / workspace-views /
attributes+objects / artifacts+imports / metrics/series/overview).

### Frontend migration plan

`dashboard-shell.tsx` still hand-rolls ~10 types. Migrate one-per-PR as the
corresponding Rust handler is annotated. Target list:

- `DashboardSessionPayload` → `components["schemas"]["AuthSessionPayload"]`
  (already annotated; safe to migrate immediately as a follow-up).
- `UsagePayload` / `UsageOrg` / `UsagePeriod` → blocked on annotating
  `usage_summary`.
- `ShortcutCommand`, `QuickSearchItem`, `SavedViewOption`, `ChartZoomRange`,
  `ThemeMode` — pure-frontend shapes; do NOT migrate.

## Non-goals

- Replacing axum.
- Changing route paths.
- Restructuring handler signatures (we only add macros above them).
- Touching `store/`, `clickhouse_*` types, or the MCP server (which uses
  hand-written route strings and doesn't consume OpenAPI).
- Migrating every frontend hand-written type in one shot.
