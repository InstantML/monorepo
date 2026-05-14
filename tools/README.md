# Tools

Operational helper scripts for Training Observability live here. Keep scripts small, dependency-light, and documented in this README when adding or changing behavior.

Use the root `../SETUP.md` for fresh-clone setup. Node helpers assume `npm ci` has been run from the repo root.

## Neptune JSON Import

`import-neptune-json.mjs` sends a Neptune Exporter-shaped JSON fixture to the Training Observability import endpoint. Neptune import support is a migration path; the current product strategy is broader W&B-style training observability.

```bash
node tools/import-neptune-json.mjs ./export.json --project migrated-neptune --base-url http://127.0.0.1:8000 --dry-run
node tools/import-neptune-json.mjs ./export.json --project migrated-neptune --base-url http://127.0.0.1:8000
```

Set `RLOBS_API_KEY` when importing into an auth-required server.

## W&B JSON Import

`import-wandb-json.mjs` sends a transformed W&B JSON fixture to `POST /api/imports/wandb`. This first slice expects a small representative JSON file with `runs`, where each run may include `config`, `metadata`, `summary`, `tags`, scalar `history` rows, and artifact references. It does not call the W&B API or download artifact bytes.

```bash
node tools/import-wandb-json.mjs ./wandb-export.json --project migrated-wandb --base-url http://127.0.0.1:8000 --dry-run
node tools/import-wandb-json.mjs ./wandb-export.json --project migrated-wandb --base-url http://127.0.0.1:8000
```

## MLflow JSON Import

`import-mlflow-json.mjs` sends a transformed MLflow JSON fixture to `POST /api/imports/mlflow`. This slice expects a small representative JSON file with `runs`, where each run may include `info`, `data.params`, `data.tags`, `data.metrics`, complete or partial `metric_history`, and recursively flattened artifact file references. It does not call an MLflow tracking server or download artifact bytes.

```bash
node tools/import-mlflow-json.mjs ./mlflow-export.json --project migrated-mlflow --base-url http://127.0.0.1:8000 --dry-run
node tools/import-mlflow-json.mjs ./mlflow-export.json --project migrated-mlflow --base-url http://127.0.0.1:8000
```

Set `RLOBS_API_KEY` when importing into an auth-required server.

## Scale Smoke

`scale-smoke.mjs` generates the roadmap scale target in memory: 50 runs, 20 metrics per run, and 1,000 points per metric. It validates bounded summary and chart-series queries and prints timings.

```bash
node tools/scale-smoke.mjs
```

Use environment overrides for smaller local checks:

```bash
RLOBS_SCALE_RUNS=5 RLOBS_SCALE_METRICS=4 RLOBS_SCALE_POINTS=100 node tools/scale-smoke.mjs
```

## Rust Large-Run Benchmark

`rust-large-run-benchmark.mjs` is the regression gate for the design-partner scale case: a 90,000-run project with realistic names, statuses, tags, notes, config, selected metric summaries, and one 1,000-point chart series. It starts disposable Postgres, applies Rust migrations, seeds data, runs `ANALYZE`, starts the Rust API, and prints JSON p50/p95 timings.

```bash
npm run benchmark:large-runs
RLOBS_BENCH_RUNS=90000 RLOBS_BENCH_SAMPLES=10 RLOBS_BENCH_WARMUPS=2 npm run benchmark:large-runs
RLOBS_BENCH_RUNS=90000 RLOBS_BENCH_SAMPLES=10 RLOBS_BENCH_WARMUPS=2 RLOBS_BENCH_WEB=1 npm run benchmark:large-runs
```

Useful environment variables:

- `RLOBS_BENCH_RUNS`: number of seeded runs. Default: `90000`.
- `RLOBS_BENCH_SAMPLES`: measured requests per endpoint. Default: `15`.
- `RLOBS_BENCH_WARMUPS`: warmup requests per endpoint. Default: `2`.
- `RLOBS_BENCH_WEB=1`: additionally build/start the Next app and measure first useful render.
- `RLOBS_BENCH_ENFORCE=1`: exit nonzero if local budgets fail.

The JSON output includes timings for project newest summary, org newest summary, token search, selected metric-best sort, chart series, optional web first useful render, budget thresholds, and pass/fail status. Local 2026-05-11 evidence with `RLOBS_BENCH_WEB=1` measured project summary p95 78 ms, org summary p95 68 ms, search p95 118 ms, selected metric-best sort p95 66 ms, chart series p95 22 ms, and web first useful render 387 ms.

## Rust Rich-Object Benchmark

`rust-rich-objects-benchmark.mjs` is the regression gate for the first table/histogram/media object slice. It starts disposable Postgres, applies Rust migrations, seeds one run with 500 rich object attributes and a 1,000-row table preview, starts the Rust API, and prints object-list/table-row p95 timings.

```bash
npm run benchmark:rich-objects
RLOBS_OBJECT_BENCH_SAMPLES=10 RLOBS_OBJECT_BENCH_WARMUPS=2 npm run benchmark:rich-objects
```

Useful environment variables:

- `RLOBS_OBJECT_BENCH_OBJECTS`: seeded object count. Default: `500`.
- `RLOBS_OBJECT_BENCH_ROWS`: seeded rows for the first table object. Default: `1000`.
- `RLOBS_OBJECT_BENCH_SAMPLES`: measured requests per endpoint. Default: `15`.
- `RLOBS_OBJECT_BENCH_WARMUPS`: warmup requests per endpoint. Default: `2`.
- `RLOBS_BENCH_ENFORCE=1`: exit nonzero if local budgets fail.

Local 2026-05-11 evidence measured object list p95 47.5 ms for 500 objects, table-only object list p95 8.3 ms, and table row p95 1.9 ms for 1,000 bounded rows.

## API Contract Smoke

`contract-smoke.mjs` is a black-box compatibility suite for the SDK-facing API and hosted-backend foundation. The root `npm run test:contract` command runs it against the primary Rust/Postgres server through `rust-service-smoke.mjs`. Directly invoking `contract-smoke.mjs` with no base URL also defaults to the Rust/Postgres smoke harness. Set `RLOBS_CONTRACT_BACKEND=node` or use `npm run test:contract:node` only when comparing the deprecated Node route shapes.

The smoke verifies users, organizations, bootstrap-gated API keys, auth failures, cross-org denial, authenticated reads/downloads, run lifecycle, numeric metric steps, timestamped metrics, idempotent replay, validation/not-found/body-size errors, attributes, artifact upload/download, side-by-side comparison, maintained summaries, experiment export, `sdk:ingest`-guarded SDK mutations, `usage:read`-guarded usage summary/export, `imports:write`-guarded Neptune/W&B/MLflow imports, and source import visibility.

```bash
npm run test:contract
npm run test:contract:node
```

Run it against an already-running Rust server or another compatible backend:

```bash
RLOBS_CONTRACT_BASE_URL=http://127.0.0.1:8001 RLOBS_CONTRACT_BOOTSTRAP_TOKEN=dev-bootstrap npm run test:contract:direct
```

The contract smoke remains the gate for backend compatibility. Rust is the default backend for `test:contract`, `test:contract:direct`, and manual no-env invocation; use `npm run test:contract:node` when comparing deprecated Node behavior.

## Rust/Postgres Service Smokes

`rust-service-smoke.mjs` starts a disposable Postgres cluster, runs the Rust server, waits for `/readyz`, and drives one of the Rust parity smokes:

```bash
npm run test:contract
npm run test:ui
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

`rust-sdk-smoke.py` is the Python SDK overlap check used by `npm run test:rust:sdk`.

The web smoke in `apps/web/tests/ui-smoke.mjs` follows the same default: no API base means Rust/Postgres. Set `RLOBS_UI_SMOKE_API_BASE` to test an already-running Rust-compatible backend. The full UI smoke covers landing, local auth, onboarding, and dashboard routes, so it now depends on Rust session/auth endpoints rather than the deprecated Node compatibility server.

The accepted hosted schema lives in `apps/rust-server/migrations/`. Apply all migrations to a disposable Postgres database when reviewing schema changes:

```bash
for migration in apps/rust-server/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

Rust service commands:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run rust:migrate
npm run rust:serve
```

Expected JSON shape:

```json
{
  "runs": [
    {
      "name": "run-name",
      "config": {"seed": 1},
      "tags": ["migrated"],
      "metrics": [{"key": "eval/return_mean", "step": 1, "value": 10}],
      "attributes": [{"path": "notes/comment", "type": "string_series", "step": 1, "value": "ok"}],
      "artifacts": [{"type": "file", "name": "config.json", "uri": "file://config.json"}]
    }
  ]
}
```
