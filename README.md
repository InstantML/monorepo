# InstantML

InstantML is an early-stage W&B (Weights & Biases)-style SaaS competitor for serious training-loop observability. The product focuses on fast run comparison, reliable SDK ingestion, artifacts, checkpoints, reproducibility context, and predictable pricing for smaller startups, research labs, and lean ML teams.

Start with:

- `SETUP.md` for fresh-clone environment setup.
- `apps/docs/` for the public docs source rendered at `/docs` by the web app,
  including user guides, SDK/API references, architecture overview, operations
  guides, and generated public OpenAPI reference.
- `USER_DOCS.md` for the older condensed external-user guide. Prefer
  `apps/docs/` for new public docs work.
- `PRODUCT_STRATEGY.md` for product direction.
- `TODO.md` for the editable working task list.
- `AGENTS.md` for contributor and future-agent guidelines.
- `docs/architecture/current-system.md` for the implemented architecture.
- `docs/architecture/current-api.md` for the current Rust API routes, inputs, parameters, outputs, auth rules, and operational examples.
- `docs/architecture/current-schemas.md` for the current control-plane and data-plane schemas.
- `docs/design/` for architecture and feature design documents.
- `docs/design/2026-05-14-clickhouse-only-storage.md` for the primary Rust/ClickHouse storage direction.
- `docs/design/2026-05-16-gcp-cloud-run-rust-api.md` for the internal Cloud Run deployment slice.
- `docs/architecture/multi-instance-cloud-run.md` for the current split Cloud Run control/data topology.
- `docs/architecture/self-hosted-gcp-clickhouse.md` for the current
  InstantML-owned GCP ClickHouse production/staging operating model.
- `docs/design/2026-05-19-utoipa-migration.md` for the OpenAPI-driven TS codegen pipeline. Run `npm run codegen:api` after any Rust handler change.
- `docs/users/checkpoint-forking-agent-guide.md` for agent-facing checkpoint
  logging, fork/resume, scope, and docs-sync guidance.
- `docs/users/day-1-customer-discovery.md` for planning-only customer discovery hypotheses.

Optional deeper product-research context lives in the separate InstantML
product wiki repo. If it is available locally, link it into this workspace with:

```bash
mkdir -p .context
ln -sfn /path/to/instantML/product .context/product
```

The `.context` directory is gitignored, so this symlink is local workspace
context, not a monorepo dependency. Implementation-relevant product decisions
should still be copied or summarized into `PRODUCT_STRATEGY.md`,
`docs/product/`, or `docs/design/`.

## Repository Structure

```text
monorepo/
  apps/
    admin/
    docs/
    api/
    rust-server/
    server/
    web/
  packages/
    python-sdk/
  examples/
  docs/
    design/
    product/
    architecture/
    users/
```

Every component directory and meaningful subdirectory should include a README. When agents change code, commands, tests, architecture, or behavior, they must update the closest README and any relevant design documents.

Current backend ownership:

- Use `apps/rust-server` for current product API, hosted-backend, and UI-serving API work.
- Use `apps/docs` for public docs source and generated public OpenAPI
  reference; `apps/web` renders it at `/docs`.
- Keep `apps/server` as a deprecated Node compatibility oracle and JSON migration source. Use `npm run dev:api:node` or `npm run test:contract:node` only when comparing legacy route behavior.
- Keep `apps/api` as the Python bootstrap/reference API and SDK compatibility target.

## Backend Architecture Direction

The current primary product path is:

```text
Next/React frontend -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
Python SDK/uploader -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
```

The Rust service should use `axum`, `tokio`, `tower-http`, ClickHouse for operational records and high-volume metric time series, structured tracing, and a small worker path. The current local/test slice rebuilds operational state into an in-process index from ClickHouse records. Hosted deployment now supports both a combined single Cloud Run service, split `control`/`data` Cloud Run services, and an optional managed HTTPS public router. Production and staging currently use InstantML-owned self-hosted ClickHouse on Google Cloud for User Data and tenant databases, with Cloudflare R2 for artifact bytes. Data-plane cells remain single-writer by default until the coordination/reconciliation gates for shared multi-writer cells are implemented.

Migration rule: the Node server is deprecated but remains the compatibility oracle and JSON migration source until P4 migration tooling and any remaining legacy fallback needs are retired.

## Development Principles

- Design before implementation.
- Have fresh reviewers inspect architecture for simplicity and performance before building.
- Keep code simple, direct, and well-tested.
- Target 100% coverage for first-party code.
- Build thin end-to-end workflows before broad feature sets.
- Prefer data portability, transparent storage, and deployment paths teams can own.

## Current Status

Days 1-4 bootstrap is implemented:

- Day 1 customer discovery plan and wedge hypotheses.
- Day 2 MVP spec and repo structure.
- Day 3 backend core with SQLite persistence and JSON API.
- Day 4 Python SDK with `init`, `log`, and `finish`.
- Deterministic RL-style example script.
- Tests with 100% measured coverage for the bootstrap code.
- Customer discovery artifacts are planning-only; no live interviews or outreach are recorded in this repo.

Days 5-8 UI/server slice is implemented:

- Deprecated Node.js compatibility server for the legacy JSON-backed product API.
- Next/React operational UI with tabbed runs, metrics, run detail, and comparison workflows.
- Modernized metric chart with axes, labels, visible point markers, grouped averages, and hover readouts.
- Demo data reset scoped to the `demo` project only, with 1,000 deterministic synthetic LLM/RL runs, rich training/eval/system metrics, tags, notes, hardware metadata, checkpoints, MP3 audio artifacts, and MP4 rollout artifacts.
- Python SDK compatibility against the primary Rust server and deprecated Node server.

Training-observability roadmap first slice is implemented:

- Typed attributes for configs, float series, string series, file/file series, histograms, and tags.
- Attribute-backed rich logged objects for selected-run tables, histograms, and media attachments, with paginated table preview rows.
- Buffered SDK logging, explicit `flush()`, offline JSONL spool/replay, source metadata, and typed helper methods.
- Process-isolated SDK spool mode with a separate uploader for long-running training loops.
- Artifact upload/download with size, SHA256, MIME type, local filesystem storage for development, and Cloudflare R2-backed per-org buckets for hosted artifact bytes.
- Local user/org/API-key model for hosted-SaaS auth scaffolding, with optional org-scoped SDK bearer-token enforcement.
- Server idempotency keys for process-spooled metric replay.
- Maintained metric summaries so run tables do not scan full metric history.
- User-owned export path at `GET /api/export`.
- ClickHouse schema for the primary Rust service under `apps/rust-server/clickhouse/0001_initial.sql`.
- Black-box contract smoke at `npm run test:contract` for Rust and `npm run test:contract:node` for the deprecated Node compatibility server.
- Primary Rust service P0-P3 commands, health/readiness/metrics/OpenAPI endpoints, API-key auth, ClickHouse-backed projects/runs/scalar metrics/summaries/idempotency, typed attributes, artifacts, imports, bounded export, usage, and Rust-backed contract/SDK/UI smokes.
- Versioned artifact collections for the Rust/ClickHouse path, including immutable manifests, stable `vN` versions, automatic `latest`, movable `best`, explicit run input/output edges, retention/soft-delete state, SDK-originated upload sessions, and an Artifacts lineage dashboard beside the legacy raw artifact browser.
- Public landing page, local Google-style sign-in/sign-up, opaque browser sessions, Stripe Checkout/Portal-backed paid signup and billing settings, org seat reservation, copy-once SDK API-key onboarding, and route-backed dashboard tabs at `/dashboard/:tab`. For managed Clerk signups, the workspace name is auto-derived from the Clerk display name or email handle; free signups can receive a ready-to-use SDK key in the auth response (`onboarding_api_key`), while paid signups redirect to Stripe before writes and SDK keys are unlocked.
- Side-by-side comparison, metric aggregate summaries, chart smoothing, grouped averages, x-axis mode, sorting, and saved local views.
- Runs workspace sections, top-level add-panel drawer, line-panel editing, fullscreen inspection, movable/resizable panels, local layout persistence, selected-run-only plotting, hover tooltips, and range zoom.
- Visible/searchable run tags and notes, with editing from Run Detail and Compare and Rust-backed indexed search over name/tags/config/notes text.
- Server-backed run search uses the shared `q` language across dashboard pages and API routes, including field filters, exact tag/status search, uppercase boolean operators, quoted phrases, negation, grouping, and explicit Rust `re:/.../` regex.
- Run Detail supports stored checkpoint resume snippets and same-project checkpoint forks; forked child runs preserve direct lineage and can be continued from Python with `instantml.attach_run(...)`.
- Reports are persisted workspace documents backed by `/api/reports`, with live panel grids, autosave, share tokens, legacy LLM-summary rendering, and Markdown export.
- Hosted pricing is Free/Pro/Premium with visible plan usage, no tracked-hour billing in v1, and explicit paid storage/API request overage.
- Cursor-backed Rust run browsing for the Runs workspace with indexed server-side search/sort, a raw Python `Api.runs()` query helper, a repeatable local 100,000-run benchmark, and a hosted Cloud Run API benchmark for the deployed Cloud Run -> ClickHouse path. Local 2026-05-11 evidence measured project summary p95 78 ms, search p95 118 ms, selected metric-best sort p95 66 ms, chart series p95 22 ms, and production web first useful render 387 ms; the current 2026-05-23 hosted GCP showcase stayed sub-second on 50,000 runs and 522M metric points.
- Rich-object benchmark evidence from 2026-05-11 measured selected-run object list p95 47.5 ms for 500 objects, table-only object list p95 8.3 ms, and table row p95 1.9 ms for 1,000 bounded rows.
- Keyboard workflow MVP covering quick search, shortcut help, overlay dismissal, workspace undo/redo, run selector collapse, focus handoff, and fullscreen panel traversal.
- Tab-aware frontend data fetching so hidden Metrics, Run Detail, Compare, and artifact surfaces no longer fan out requests during every dashboard entry.
- Real Neptune Exporter Parquet import, transformed W&B, transformed MLflow JSON, and TensorBoard scalar importer/sync endpoints and CLIs.
- Real-data NumPy Iris classification example with uploaded model, prediction, confusion-matrix, and dataset-profile artifacts.
- Docker Compose for a one-command local Rust/ClickHouse API and artifact-storage stack.
- Internal Cloud Run deployment for the Rust API with Secret Manager secrets, bounded single-instance control/data cells, private VPC access to the self-hosted GCP ClickHouse VM, and local frontend-only development against the hosted API.
- Structured Rust server observability: JSON Cloud Run logs include request completion events, sanitized handled-error fields, slow-request warnings, and first-slice workflow outcomes for project/run mutations, metric/log ingestion, artifacts, imports, readiness, and worker cleanup. Hosted edge correlation uses the request `x-request-id` header and observed Cloudflare `cf-ray` when the API is proxied through Cloudflare.

Known follow-ups before broadening the roadmap:

- Validate the W&B-competitor wedge with real users.
- Preserve the strategy that InstantML should beat W&B on speed, UI quality, and predictable pricing for small teams.
- Keep Node compatibility checks available until JSON-to-ClickHouse migration tooling and legacy fallback needs are retired; `npm run test:contract`, `npm run test:rust:sdk`, and `npm run test:ui` exercise Rust against disposable ClickHouse.
- Keep batch/import/upload failure behavior tested as the storage layer evolves.
- Keep frontend async loaders cancellation-safe as workflow components continue to split.
- Validate W&B/MLflow/Neptune import, the optional `shadow_wandb` SDK path, W&B dual logging, TensorBoard sync, and real Neptune Exporter Parquet import against design-partner production traces before broadening migration claims.
- Public hosted speed claims should stay limited to measured surfaces such as the current 50,000-run / 522M-point GCP read-path benchmark. Keep proving broader Runs, Compare, chart, and metric-catalog behavior at the 100,000+ run design-partner scale before broadening those claims. The local run-list/search/sort benchmark slice is complete, and `npm run benchmark:cloud-run` is the default hosted backend signal for API calls through Cloud Run into the self-hosted GCP ClickHouse tenant database. High metric-key cardinality, Compare payloads, and richer workspace panel fan-out still need dedicated gates.

## Quickstart

Recommended local versions:

- Node.js 22 LTS with npm 10+.
- Python 3.11.
- Rust 1.83 or newer.
- Local ClickHouse binary (`clickhouse`) or a reachable `CLICKHOUSE_URL`; Docker Compose can provide ClickHouse for the container path.

For a clean machine or teammate handoff, follow [SETUP.md](SETUP.md). The short path is:

```bash
nvm install
nvm use
python3.11 -m venv .venv
source .venv/bin/activate
npm ci
npm run setup
```

Run tests:

```bash
npm run check:setup
npm run rust:lint
npm run rust:test
npm run test:python
npm run test:contract
npm run test:rust:contract
npm run test:rust:sdk
npm run test:ui
npm run test:ui:direct
npm run test:node
npm run test:contract:node
npm run test:scale
npm run benchmark:large-runs
npm run benchmark:cloud-run -- --help
```

Validate the public Mintlify docs MVP:

```bash
npm run docs:sync-openapi
npm run docs:validate
```

CI runs `npm run docs:validate`, so public docs fail when their filtered
OpenAPI copy is stale or when public pages link into internal planning docs.

React Doctor can be run from the repo root when using Node `^20.19.0` or
`>=22.12.0`:

```bash
npx react-doctor@latest
```

`react-doctor.config.json` disables the dead-code pass because the monorepo root
is the React package while Next App Router entries, generated API types, tests,
tools, and legacy compatibility modules are reached through framework or
script entrypoints that the generic dead-code scanner does not model. The score
surface also treats the existing broad advisory categories as visible CLI
findings rather than score gates; make planned fixes in narrow design-backed
slices instead of churning the dashboard shell to satisfy every advisory at
once.

Pull requests run the stable CI subset from `.github/workflows/ci.yml` as
parallel jobs: Rust format, Rust lint, Rust unit tests/API type drift, docs
validation, Node tests, and Python tests/SDK packaging. The final `Stable
Quality Gates` job aggregates those split checks and preserves the deploy and
branch-protection check name. The Rust service, SDK, and UI smokes still run
locally because they require disposable service dependencies and are being
hardened alongside the ClickHouse metric-store harness.

Default smoke behavior is Rust/ClickHouse-first: `npm run test:contract`, `npm run test:contract:direct`, `npm run test:ui`, `npm run test:ui:direct`, and direct no-env invocations of `tools/contract-smoke.mjs` or `apps/web/tests/ui-smoke.mjs` all start disposable ClickHouse and `apps/rust-server`. The deprecated Node backend is opt-in for contract compatibility through `npm run test:contract:node` or `INSTANTML_CONTRACT_BACKEND=node`; full UI smoke now depends on Rust session/auth endpoints.

Default development setup is a local Next frontend on localhost with its
server-side rewrites pointed at the hosted staging API:

```bash
INSTANTML_WEB_API_ENV=staging npm run web:dev
```

Then open `http://127.0.0.1:3000`. `INSTANTML_WEB_API_ENV=staging` routes the
Next rewrite proxy to `https://staging.api.instantml.ai` and intentionally
overrides stale API-base values in repo-local env files. Restart `next dev`
after changing rewrite env. Hosted sign-in requires a
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the same Clerk application as staging;
the local dev Google-style auth flow is only for a local Rust API.

When backend work needs a disposable local API and ClickHouse state instead,
start the primary Rust API:

```bash
npm run dev:api
```

Start the separate internal admin app against a Rust API configured with a
bootstrap token:

```bash
INSTANTML_ADMIN_API_BASE=http://127.0.0.1:8000 \
INSTANTML_ADMIN_BOOTSTRAP_TOKEN=local-admin-token \
npm run admin:dev
```

Start the Next UI in another terminal:

```bash
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:build
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:start
```

Then open `http://127.0.0.1:3000`, sign up with the labeled local dev Google-style flow, create a copy-once SDK API key, and open the dashboard. To populate the shared demo workspace, run `cargo run --manifest-path apps/rust-server/Cargo.toml -- seed-demo` once from a terminal; from the landing page, click `Continue as shared demo` to browse the seeded read-only data. The generated database rows are not committed to git.

For faster frontend iteration:

```bash
INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Use explicit split bases only when you intentionally want the local Next proxy
to bypass the staging router and call direct Cloud Run services:

```bash
INSTANTML_WEB_EXPLICIT_API_BASES=1 \
INSTANTML_CONTROL_API_BASE=https://instantml-staging-control-<hash>-uc.a.run.app \
INSTANTML_DATA_API_BASE=https://instantml-staging-data-us-central1-a-<hash>-uc.a.run.app \
INSTANTML_API_ALLOWED_ORIGINS=https://instantml-staging-control-<hash>-uc.a.run.app,https://instantml-staging-data-us-central1-a-<hash>-uc.a.run.app \
npm run web:dev
```

Deploy the default split control/data Cloud Run topology:

```bash
npm run deploy:cloud-run
```

`npm run deploy:cloud-run` now creates a control service and a data service from the same Rust image. Set `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER=1` and `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN=<api-domain>` to create the managed HTTPS public router and write one local API base after DNS/certificate activation. Prod control/data services default to manual one-instance scaling, while staging defaults to automatic min `0` max `1`; scaling above one instance is blocked unless an explicit unsafe test flag is set. Hosted artifact byte uploads use Cloudflare R2 when `INSTANTML_ARTIFACT_BACKEND=r2` and Cloudflare credentials are configured.

Hosted Rust logs should run with `INSTANTML_LOG_FORMAT=json`,
`RUST_LOG=instantml_rust_server=info,tower_http=info`, and
`INSTANTML_SLOW_REQUEST_MS=1000` unless an incident needs a temporary override.
Origin logs are Cloud Run stdout/stderr; Cloudflare Log Explorer or Logpush
captures edge request logs separately and should be joined with origin logs by
the request `x-request-id` header plus time/host/path/status. Response-header
capture for `x-request-id` is helpful when available, but it can be missing for
edge-only failures. Use observed `cf-ray` as an additional correlation key.

The explicit aliases are:

```bash
npm run deploy:cloud-run:multi
npm run deploy:cloud-run:single
```

Use `deploy:cloud-run:single` only for the legacy combined Cloud Run service. A single-service deploy writes `INSTANTML_API_BASE` and `INSTANTML_API_ALLOWED_ORIGINS` into `apps/web/.env.local`; the normal localhost frontend path still runs `INSTANTML_WEB_API_ENV=staging npm run web:dev` so stale deploy-helper bases do not override the staging router.

Run the one-command local stack:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build
```

The Docker stack starts ClickHouse and the Rust API with durable ClickHouse rows, metric rows, and artifact bytes in Docker volumes. The example override enables the dev Google-style auth flow inside the container and remaps the host port to 8010 (the gitignored override file is per-machine). Without it the stack ships with secure defaults — `/signup` will render disabled buttons because the dev auth endpoint stays gated. See `SETUP.md` for the full Docker path and security notes.

Run the split local container shape:

```bash
docker compose --profile split up --build instantml-control instantml-data
```

This starts `instantml-control` on host port `8001` and `instantml-data` on host port `8002` against the same ClickHouse container. It is useful for understanding service-plane wiring; `npm run test:hosted-clickhouse` remains the stronger automated split-process verification.

Run Rust checks and smokes:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

Run the 100,000-run local benchmark:

```bash
INSTANTML_BENCH_RUNS=100000 INSTANTML_BENCH_SAMPLES=10 INSTANTML_BENCH_WARMUPS=2 INSTANTML_BENCH_WEB=1 npm run benchmark:large-runs
```

Run the hosted Cloud Run -> ClickHouse benchmark after `seed:hosted-scale` has
created the large tenant dataset and `.env` points at the deployed data API:

```bash
INSTANTML_API_KEY=instantml_... npm run benchmark:cloud-run
```

`npm run test:ui:direct` and `npm run test:contract:direct` also default to the same Rust/ClickHouse harness unless `INSTANTML_UI_SMOKE_API_BASE` or `INSTANTML_CONTRACT_BASE_URL` points them at an already-running compatible server.

Apply the accepted ClickHouse schema against a disposable or local database:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/instantml \
cargo run --manifest-path apps/rust-server/Cargo.toml -- migrate
```

Start the Rust service directly against an existing ClickHouse database:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/instantml \
INSTANTML_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Run the deprecated Node compatibility server only when comparing legacy behavior:

```bash
npm run dev:api:node
npm run test:contract:node
```

Start the Python bootstrap API, still available for reference:

```bash
PYTHONPATH=apps/api python3 -m instantml_api.server --db .instantml/instantml.sqlite3 --port 8000
```

Run the example in another terminal:

```bash
PYTHONPATH=packages/python-sdk:examples/rl-cartpole python3 examples/rl-cartpole/train.py --server http://127.0.0.1:8000
```

Run the real-data NumPy Iris classification example:

```bash
PYTHONPATH=packages/python-sdk:examples/iris-classification \
  python3 examples/iris-classification/train.py --server http://127.0.0.1:8000
```

Drain process-spooled SDK events from another terminal:

```bash
PYTHONPATH=packages/python-sdk python3 -m instantml.uploader \
  --spool-dir .instantml/spool \
  --base-url http://127.0.0.1:8000
```

Dry-run local-first SDK imports:

```bash
PYTHONPATH=packages/python-sdk instantml import wandb \
  --project migrated-wandb --entity my-team --source-project old-project --dry-run
PYTHONPATH=packages/python-sdk instantml import neptune \
  --project migrated-neptune --input ./neptune-export --dry-run
PYTHONPATH=packages/python-sdk instantml import tensorboard \
  --project tensorboard-sync --logdir ./runs --dry-run
```

Dry-run legacy transformed JSON imports:

```bash
node tools/import-neptune-json.mjs ./export.json --project migrated-neptune --dry-run
node tools/import-wandb-json.mjs ./wandb-export.json --project migrated-wandb --dry-run
node tools/import-mlflow-json.mjs ./mlflow-export.json --project migrated-mlflow --dry-run
```
