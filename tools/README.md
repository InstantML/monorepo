# Tools

Operational helper scripts for InstantML live here. Keep scripts small, dependency-light, and documented in this README when adding or changing behavior.

Use the root `../SETUP.md` for fresh-clone setup. Node helpers assume `npm ci` has been run from the repo root.

## Local ClickHouse Helper

`local-clickhouse.mjs` is shared by `dev-rust-api.mjs`, Rust service smokes, and Rust benchmarks. It first checks `CLICKHOUSE_URL`, then starts a local `clickhouse server` only for loopback URLs that use the default user with no password. The dev helper writes generated state under `.instantml/clickhouse` and logs under `.instantml/clickhouse-logs`; smoke and benchmark scripts use temporary directories and clean them up afterward.

Useful overrides:

- `CLICKHOUSE_URL`: target ClickHouse HTTP URL. Default: `http://default:@127.0.0.1:8123/instantml`.
- `INSTANTML_DEV_CHDATA`: generated ClickHouse data path for `npm run dev:api`.
- `INSTANTML_DEV_CH_LOG_DIR`: generated ClickHouse log path for `npm run dev:api`.
- `INSTANTML_DEV_CH_TCP_PORT`, `INSTANTML_DEV_CH_INTERSERVER_PORT`, `INSTANTML_DEV_CH_MYSQL_PORT`: optional non-HTTP protocol ports when avoiding local collisions.

## Cloud Run Deploy Helper

`deploy-cloud-run.mjs` deploys the Rust API to Google Cloud Run for the internal hosted slice described in `docs/design/2026-05-16-gcp-cloud-run-rust-api.md`.

```bash
npm run deploy:cloud-run
npm run deploy:cloud-run -- --help
```

The helper reads the repo-root `.env` plus process env, then enables required GCP APIs, creates or reuses Artifact Registry, Cloud Run, Secret Manager, VPC, Cloud Router, Cloud NAT, and a regional static egress IP, syncs ClickHouse/Clerk secrets to Secret Manager, updates ClickHouse Cloud service and Cloud API-key IP access lists when API credentials are available, builds the existing Rust image through Cloud Build, deploys Cloud Run with `--max-instances 1`, verifies `/health`, `/readyz`, and `/api/auth/config`, then writes the hosted API URL to `.env` and `apps/web/.env.local`.

Important environment variables:

- `GCP_PROJECT`: target project, otherwise the active `gcloud` project.
- `GCP_REGION`: deployment region. Default: `us-central1`.
- `INSTANTML_CLOUD_RUN_SERVICE`: Cloud Run service name. Default: `instantml-rust-api`.
- `INSTANTML_ALLOWED_FRONTEND_ORIGINS`: comma-separated browser origins allowed for cookie-authenticated mutations. Default includes local Next and `https://instantml.ai`.
- `INSTANTML_SIGNUP_ALLOWED_EMAILS` / `INSTANTML_SIGNUP_ALLOWED_DOMAINS`: hosted Clerk signup allowlists. If neither is set, the helper defaults the email allowlist to the active `gcloud` account.
- `INSTANTML_CLOUD_RUN_STATIC_EGRESS=0`: disables static egress setup and requires manual ClickHouse Cloud allowlisting.
- `INSTANTML_CLICKHOUSE_ALLOWLIST_SERVICES=none`: skips ClickHouse Cloud access-list updates.
- `INSTANTML_CLICKHOUSE_ALLOWLIST_KEYS=none`: skips ClickHouse Cloud API-key access-list updates.

Do not run this from CI. It can create paid cloud resources, add Secret Manager versions, and provision a public Cloud Run URL. The service is intentionally pinned to one instance until the hosted operational-index coordination work lands, and artifact byte uploads remain disabled in hosted mode until object storage is designed.

## Import Helpers

`import-neptune-json.mjs`, `import-wandb-json.mjs`, and `import-mlflow-json.mjs` send representative export-shaped JSON files to the Rust import endpoints. They do not call vendor APIs or download artifact bytes.

```bash
node tools/import-neptune-json.mjs ./export.json --project migrated-neptune --base-url http://127.0.0.1:8000 --dry-run
node tools/import-wandb-json.mjs ./wandb-export.json --project migrated-wandb --base-url http://127.0.0.1:8000
node tools/import-mlflow-json.mjs ./mlflow-export.json --project migrated-mlflow --base-url http://127.0.0.1:8000
```

Set `INSTANTML_API_KEY` when importing into an auth-required server.

## Scale Smoke

`scale-smoke.mjs` generates the roadmap scale target in memory: 50 runs, 20 metrics per run, and 1,000 points per metric. It validates bounded summary and chart-series queries and prints timings.

```bash
node tools/scale-smoke.mjs
INSTANTML_SCALE_RUNS=5 INSTANTML_SCALE_METRICS=4 INSTANTML_SCALE_POINTS=100 node tools/scale-smoke.mjs
```

## Rust Large-Run Benchmark

`rust-large-run-benchmark.mjs` is the regression gate for the design-partner scale case: a 100,000-run project with realistic names, statuses, tags, notes, config, selected metric summaries, and one 20,000-step chart series. It starts disposable ClickHouse, applies the Rust ClickHouse schema, seeds operational records and metric rows directly into ClickHouse, starts the Rust API, and prints JSON p50/p95 timings.

```bash
npm run benchmark:large-runs
INSTANTML_BENCH_RUNS=90000 INSTANTML_BENCH_SAMPLES=10 INSTANTML_BENCH_WARMUPS=2 npm run benchmark:large-runs
INSTANTML_BENCH_RUNS=90000 INSTANTML_BENCH_SAMPLES=10 INSTANTML_BENCH_WARMUPS=2 INSTANTML_BENCH_WEB=1 npm run benchmark:large-runs
```

Useful environment variables:

- `INSTANTML_BENCH_RUNS`: number of seeded runs. Default: `90000`.
- `INSTANTML_BENCH_SAMPLES`: measured requests per endpoint. Default: `15`.
- `INSTANTML_BENCH_WARMUPS`: warmup requests per endpoint. Default: `2`.
- `INSTANTML_BENCH_WEB=1`: additionally build/start the Next app and measure first useful render.
- `INSTANTML_BENCH_ENFORCE=1`: exit nonzero if local budgets fail.

## Hosted Demo Benchmark Seed

`hosted-demo-seed-benchmark.mjs` signs in as the shared demo account, provisions or reuses its ClickHouse Cloud service, seeds the 100,000-run benchmark into that service once, restarts its temporary Rust server so tenant replay reads the direct seed, and prints sanitized hosted API p50/p95 timings. It benchmarks newest run pages, 100-row pages, name/tag/config/notes search, status filters, combined search+filter, selected-metric sorting, project overview, and a bounded chart series. It reads ClickHouse credentials from the local `.env`; do not run it from CI or against a disposable account unless you intend to create/use a hosted ClickHouse service.

```bash
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 npm run benchmark:hosted-demo
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 INSTANTML_HOSTED_DEMO_SAMPLES=5 INSTANTML_HOSTED_DEMO_WARMUPS=1 npm run benchmark:hosted-demo
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 INSTANTML_HOSTED_DEMO_RESULT_PATH=/tmp/instantml-hosted-benchmark.json npm run benchmark:hosted-demo
```

Useful environment variables:

- `INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1`: required confirmation because this tool can create/use paid ClickHouse Cloud services.
- `INSTANTML_HOSTED_DEMO_EMAIL`: shared demo email. Default: `hello@instantml.ai`.
- `INSTANTML_HOSTED_DEMO_ORG`: shared demo organization name. Default: `InstantML Demo`.
- `INSTANTML_HOSTED_DEMO_PROJECT`: seeded project name. Default: `instantml-demo-100k`.
- `INSTANTML_HOSTED_DEMO_RUNS`: seeded run count. Default: `100000`.
- `INSTANTML_HOSTED_DEMO_LONG_RUN_STEPS`: metric steps on the newest run. Default: `20000`.
- `INSTANTML_HOSTED_DEMO_METRIC_KEY`: primary metric used for summaries, sorting, and chart reads. Default: `eval/return_mean`.
- `INSTANTML_HOSTED_DEMO_SAMPLES`: measured requests per endpoint. Default: `8`.
- `INSTANTML_HOSTED_DEMO_WARMUPS`: warmup requests per endpoint before timing. Default: `2`.
- `INSTANTML_HOSTED_DEMO_RESULT_PATH`: optional path for sanitized JSON output. The result includes endpoint host only, not ClickHouse credentials, cookies, raw URLs, or org/user IDs.
- `INSTANTML_HOSTED_DEMO_ENFORCE=1`: exit nonzero if hosted p95 budgets fail. Default budgets are 750 ms for run pages/charts and 1000 ms for search/filter/sort/overview.
- `INSTANTML_HOSTED_DEMO_API_BASE`: use an already-running API instead of starting a temporary Rust server. Restart that API after a direct seed before expecting the dashboard to replay the new rows.
- `INSTANTML_CLICKHOUSE_CLOUD_PROVIDER`, `INSTANTML_CLICKHOUSE_CLOUD_REGION`: service location. When unset, the tool infers these from the User Data ClickHouse Cloud host when possible.
- `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST`: comma-separated CIDRs allowed to query the tenant service. Required for `cloud-service` provisioning; the Cloud Run deployment uses `136.115.243.188/32`.

## Rust Rich-Object Benchmark

`rust-rich-objects-benchmark.mjs` is the regression gate for the first table/histogram/media object slice. It starts disposable ClickHouse, applies the Rust ClickHouse schema, seeds one run with rich object attributes and a bounded table preview, starts the Rust API, and prints object-list/table-row p95 timings.

```bash
npm run benchmark:rich-objects
INSTANTML_OBJECT_BENCH_SAMPLES=10 INSTANTML_OBJECT_BENCH_WARMUPS=2 npm run benchmark:rich-objects
```

Useful environment variables:

- `INSTANTML_OBJECT_BENCH_OBJECTS`: seeded object count. Default: `500`.
- `INSTANTML_OBJECT_BENCH_ROWS`: seeded rows for the first table object. Default: `1000`.
- `INSTANTML_OBJECT_BENCH_SAMPLES`: measured requests per endpoint. Default: `15`.
- `INSTANTML_OBJECT_BENCH_WARMUPS`: warmup requests per endpoint. Default: `2`.
- `INSTANTML_BENCH_ENFORCE=1`: exit nonzero if local budgets fail.

## API Contract Smoke

`contract-smoke.mjs` is a black-box compatibility suite for the SDK-facing API and hosted-backend foundation. The root `npm run test:contract` command runs it against the primary Rust/ClickHouse server through `rust-service-smoke.mjs`. Directly invoking `contract-smoke.mjs` with no base URL also defaults to the Rust/ClickHouse smoke harness. Set `INSTANTML_CONTRACT_BACKEND=node` or use `npm run test:contract:node` only when comparing the deprecated Node route shapes.

The smoke verifies users, organizations, bootstrap-gated API keys, auth failures, cross-org denial, authenticated reads/downloads, run lifecycle, numeric metric steps, timestamped metrics, idempotent replay, validation/not-found/body-size errors, attributes, artifact upload/download, side-by-side comparison, maintained summaries, experiment export, `sdk:ingest`-guarded SDK mutations, `usage:read`-guarded usage summary/export, `imports:write`-guarded Neptune/W&B/MLflow imports, and source import visibility.

```bash
npm run test:contract
npm run test:contract:node
```

Run it against an already-running Rust server or another compatible backend:

```bash
INSTANTML_CONTRACT_BASE_URL=http://127.0.0.1:8001 INSTANTML_CONTRACT_BOOTSTRAP_TOKEN=dev-bootstrap npm run test:contract:direct
```

## Rust/ClickHouse Service Smokes

`rust-service-smoke.mjs` starts a disposable ClickHouse instance, runs the Rust server, waits for `/readyz`, and drives one of the Rust parity smokes:

```bash
npm run test:contract
npm run test:ui
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
```

`rust-sdk-smoke.py` is the Python SDK overlap check used by `npm run test:rust:sdk`.

The web smoke in `apps/web/tests/ui-smoke.mjs` follows the same default: no API base means Rust/ClickHouse. Set `INSTANTML_UI_SMOKE_API_BASE` to test an already-running Rust-compatible backend. The full UI smoke covers landing, local auth, onboarding, and dashboard routes, so it depends on Rust session/auth endpoints rather than the deprecated Node compatibility server.

Rust service commands:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run rust:migrate
npm run rust:serve
```

Expected import JSON shape:

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
