# Training Observability

Training Observability is an early-stage W&B (Weights & Biases)-style SaaS competitor for serious training-loop observability. The product focuses on fast run comparison, reliable SDK ingestion, artifacts, checkpoints, reproducibility context, and predictable pricing for smaller startups, research labs, and lean ML teams.

Brand transition note: the user-facing product name is now Training Observability. Existing implementation names such as `rl_observability`, `.rlobs`, `rlobs_api`, and `RlobsError` remain for compatibility until a dedicated namespace migration is designed and tested.

Start with:

- `SETUP.md` for fresh-clone environment setup.
- `USER_DOCS.md` for external user-facing SDK usage and UI workflow guidance.
- `PRODUCT_STRATEGY.md` for product direction.
- `TODO.md` for the editable working task list.
- `AGENTS.md` for contributor and future-agent guidelines.
- `docs/architecture/current-system.md` for the implemented architecture.
- `docs/design/` for architecture and feature design documents.
- `docs/design/2026-05-14-clickhouse-only-storage.md` for the primary Rust/ClickHouse storage direction.
- `docs/users/day-1-customer-discovery.md` for planning-only customer discovery hypotheses.

## Repository Structure

```text
monorepo/
  apps/
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
- Keep `apps/server` as a deprecated Node compatibility oracle and JSON migration source. Use `npm run dev:api:node` or `npm run test:contract:node` only when comparing legacy route behavior.
- Keep `apps/api` as the Python bootstrap/reference API and SDK compatibility target.

## Backend Architecture Direction

The current primary product path is:

```text
Next/React frontend -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
Python SDK/uploader -> Rust API -> ClickHouse operational layer + ClickHouse metric layer -> artifact storage
```

The Rust service should use `axum`, `tokio`, `tower-http`, ClickHouse for operational records and high-volume metric time series, structured tracing, and a small worker path. The current local/test slice rebuilds operational state into an in-process index from ClickHouse records. Hosted deployment should split a global user/control-plane ClickHouse layer from org/cell data-plane services only after the coordination/reconciliation design is implemented.

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
- Local artifact upload/download with size, SHA256, MIME type, and local storage paths.
- Local user/org/API-key model for hosted-SaaS auth scaffolding, with optional org-scoped SDK bearer-token enforcement.
- Server idempotency keys for process-spooled metric replay.
- Maintained metric summaries so run tables do not scan full metric history.
- User-owned export path at `GET /api/export`.
- ClickHouse schema for the primary Rust service under `apps/rust-server/clickhouse/0001_initial.sql`.
- Black-box contract smoke at `npm run test:contract` for Rust and `npm run test:contract:node` for the deprecated Node compatibility server.
- Primary Rust service P0-P3 commands, health/readiness/metrics/OpenAPI endpoints, API-key auth, ClickHouse-backed projects/runs/scalar metrics/summaries/idempotency, typed attributes, artifacts, imports, bounded export, usage, and Rust-backed contract/SDK/UI smokes.
- Public landing page, local Google-style sign-in/sign-up, opaque browser sessions, org seat reservation, copy-once SDK API-key onboarding, and route-backed dashboard tabs at `/dashboard/:tab`.
- Side-by-side comparison, metric aggregate summaries, chart smoothing, grouped averages, x-axis mode, sorting, and saved local views.
- Runs workspace sections, top-level add-panel drawer, line-panel editing, fullscreen inspection, movable/resizable panels, local layout persistence, selected-run-only plotting, hover tooltips, and range zoom.
- Visible/searchable run tags and notes, with editing from Run Detail and Compare and Rust-backed indexed search over name/tags/config/notes text.
- Cursor-backed Rust run browsing for the Runs workspace with indexed server-side search/sort, a raw Python `Api.runs()` query helper, and a repeatable 90,000-run benchmark. Local 2026-05-11 evidence measured project summary p95 78 ms, search p95 118 ms, selected metric-best sort p95 66 ms, chart series p95 22 ms, and production web first useful render 387 ms.
- Rich-object benchmark evidence from 2026-05-11 measured selected-run object list p95 47.5 ms for 500 objects, table-only object list p95 8.3 ms, and table row p95 1.9 ms for 1,000 bounded rows.
- Keyboard workflow MVP covering quick search, shortcut help, overlay dismissal, workspace undo/redo, run selector collapse, focus handoff, and fullscreen panel traversal.
- Tab-aware frontend data fetching so hidden Metrics, Run Detail, Compare, and artifact surfaces no longer fan out requests during every dashboard entry.
- Neptune Exporter-shaped, transformed W&B, and transformed MLflow JSON importer endpoints and CLIs.
- Real-data NumPy Iris classification example with uploaded model, prediction, confusion-matrix, and dataset-profile artifacts.
- Docker Compose for a one-command local Rust/ClickHouse API and artifact-storage stack.

Known follow-ups before broadening the roadmap:

- Validate the W&B-competitor wedge with real users.
- Preserve the strategy that Training Observability should beat W&B on speed, UI quality, and predictable pricing for small teams.
- Keep Node compatibility checks available until JSON-to-ClickHouse migration tooling and legacy fallback needs are retired; `npm run test:contract`, `npm run test:rust:sdk`, and `npm run test:ui` exercise Rust against disposable ClickHouse.
- Keep batch/import/upload failure behavior tested as the storage layer evolves.
- Keep frontend async loaders cancellation-safe as workflow components continue to split.
- Validate W&B/MLflow/Neptune import and future W&B dual logging with real teams before broadening migration claims.
- Implement real Neptune Exporter Parquet import after a dependency/schema design.
- Keep proving broader Runs, Compare, chart, and metric-catalog behavior at the 90,000-run design-partner scale before making public hosted speed claims. The first local run-list/search/sort benchmark slice is complete, but high metric-key cardinality, Compare payloads, and workspace panel series fan-out still need dedicated gates.

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
```

Pull requests run the stable CI subset from `.github/workflows/ci.yml`: Rust format/lint/unit tests, Node tests, and Python tests. The Rust service, SDK, and UI smokes still run locally because they require disposable service dependencies and are being hardened alongside the ClickHouse metric-store harness.

Default smoke behavior is Rust/ClickHouse-first: `npm run test:contract`, `npm run test:contract:direct`, `npm run test:ui`, `npm run test:ui:direct`, and direct no-env invocations of `tools/contract-smoke.mjs` or `apps/web/tests/ui-smoke.mjs` all start disposable ClickHouse and `apps/rust-server`. The deprecated Node backend is opt-in for contract compatibility through `npm run test:contract:node` or `RLOBS_CONTRACT_BACKEND=node`; full UI smoke now depends on Rust session/auth endpoints.

Start the primary Rust API with local generated ClickHouse state:

```bash
npm run dev:api
```

Start the Next UI in another terminal:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:build
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:start
```

Then open `http://127.0.0.1:3000`, sign up with the labeled local dev Google-style flow, create a copy-once SDK API key, and open the dashboard. Use `Reset demo` inside the signed-in dashboard to generate 1,000 deterministic demo runs locally; the generated database rows are not committed to git.

For faster frontend iteration:

```bash
RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:dev
```

Run the one-command local stack:

```bash
docker compose up --build
```

The Docker stack starts ClickHouse and the Rust API at `http://127.0.0.1:8000` with durable ClickHouse rows, metric rows, and artifact bytes in Docker volumes. Run the Next frontend separately with `RLOBS_API_BASE=http://127.0.0.1:8000`.

Run Rust checks and smokes:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

Run the 90,000-run local benchmark:

```bash
RLOBS_BENCH_RUNS=90000 RLOBS_BENCH_SAMPLES=10 RLOBS_BENCH_WARMUPS=2 RLOBS_BENCH_WEB=1 npm run benchmark:large-runs
```

`npm run test:ui:direct` and `npm run test:contract:direct` also default to the same Rust/ClickHouse harness unless `RLOBS_UI_SMOKE_API_BASE` or `RLOBS_CONTRACT_BASE_URL` points them at an already-running compatible server.

Apply the accepted ClickHouse schema against a disposable or local database:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
cargo run --manifest-path apps/rust-server/Cargo.toml -- migrate
```

Start the Rust service directly against an existing ClickHouse database:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/rlobs \
RLOBS_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

Run the deprecated Node compatibility server only when comparing legacy behavior:

```bash
npm run dev:api:node
npm run test:contract:node
```

Start the Python bootstrap API, still available for reference:

```bash
PYTHONPATH=apps/api python3 -m rlobs_api.server --db .rlobs/rlobs.sqlite3 --port 8000
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
PYTHONPATH=packages/python-sdk python3 -m rl_observability.uploader \
  --spool-dir .rlobs/spool \
  --base-url http://127.0.0.1:8000
```

Dry-run a Neptune-shaped JSON import:

```bash
node tools/import-neptune-json.mjs ./export.json --project migrated-neptune --dry-run
```

Dry-run transformed W&B or MLflow JSON imports:

```bash
node tools/import-wandb-json.mjs ./wandb-export.json --project migrated-wandb --dry-run
node tools/import-mlflow-json.mjs ./mlflow-export.json --project migrated-mlflow --dry-run
```
