# Tools

Operational helper scripts for InstantML live here. Keep scripts small, dependency-light, and documented in this README when adding or changing behavior.

Use the root `../SETUP.md` for fresh-clone setup. Node helpers assume `npm ci` has been run from the repo root.

## MCP Server

`mcp-server.mjs` exposes InstantML project, run, metric, comparison, export,
workspace-view, and report tools to MCP-compatible agents. The consumer API
base defaults to `https://api.instantml.ai`, and report share links default to
the hosted web app at `https://instantml.ai`.

Local stdio mode is useful for preview and clients that launch local MCP
processes:

```bash
INSTANTML_API_KEY=instantml_... node tools/mcp-server.mjs
```

Hosted Streamable HTTP mode is intended to run behind
`https://mcp.instantml.ai/mcp`. It requires each MCP request to provide an
InstantML API key as a bearer token and forwards tool calls to the hosted API:

```bash
node tools/mcp-server.mjs --transport http --host 0.0.0.0 --port 8080
```

Useful overrides:

- `INSTANTML_API_URL`: upstream InstantML API. Default:
  `https://api.instantml.ai`.
- `INSTANTML_WEB_URL`: frontend origin used when MCP report tools return public
  `/r/<share-token>` links. Defaults to `https://instantml.ai`; falls back to
  `INSTANTML_FRONTEND_BASE_URL` when set. The CLI also accepts `--web-url`.
- `INSTANTML_API_KEY`: API key for local stdio mode.
- `INSTANTML_MCP_TRANSPORT`: `stdio` or `http`.
- `INSTANTML_MCP_HOST`: HTTP bind host. Defaults to `127.0.0.1`, or
  `0.0.0.0` when `PORT` is set for a hosted runtime.
- `INSTANTML_MCP_PORT` / `PORT`: HTTP port. Default: `8080`.
- `INSTANTML_MCP_OAUTH_AUTH_SERVER`: OAuth authorization-server (issuer) URL.
  Opt-in; when set, the server advertises RFC 9728 protected-resource metadata
  and challenges unauthenticated requests so clients can run browser sign-in.
  Unset (default) keeps API-key bearer auth only.

OAuth MCP URLs may include `?org_id=<uuid>` when generated from the dashboard.
The MCP server forwards that selected workspace to the Rust API as
`X-InstantML-OAuth-Org-Id`; Rust still verifies the Clerk token and active org
membership before serving data.

### Deploying the hosted MCP server

The hosted `instantml-mcp` Cloud Run service is built from `tools/mcp.Dockerfile`
(a small Node image with only `@modelcontextprotocol/sdk`, separate from the
repo-root Rust Dockerfile) and deployed by `tools/deploy-mcp.mjs`:

```bash
npm run deploy:mcp                 # build + deploy prod (instantml-mcp)
npm run deploy:mcp -- --dry-run    # print the gcloud commands without running
npm run deploy:mcp:staging         # instantml-staging-mcp
```

CI/CD runs the same build/deploy via the **Deploy MCP Server** GitHub Action
(`.github/workflows/deploy-mcp.yml`), using Workload Identity Federation like the
Cloud Run deploy. The deploy sets `INSTANTML_MCP_OAUTH_AUTH_SERVER` (prod:
`https://clerk.instantml.ai`) unless `--no-oauth` / `enable_oauth: false`.

Run-analysis tools include `tracker.list_projects`, `tracker.list_runs`,
`tracker.compare_matching_runs`, `tracker.compare_runs`, metric readers,
artifact/checkpoint and lineage readers, bounded export, workspace-view data,
and report helpers. Prefer `tracker.compare_matching_runs` when the agent needs
to rank matching runs server-side before producing comparison evidence; prefer
the artifact tools when the user asks about checkpoints, run outputs, or
producer/consumer lineage.

## Local ClickHouse Helper

`local-clickhouse.mjs` is shared by `dev-rust-api.mjs`, Rust service smokes, and Rust benchmarks. It first checks `CLICKHOUSE_URL`, then starts a local `clickhouse server` only for loopback URLs that use the default user with no password. The dev helper writes generated state under `.instantml/clickhouse` and logs under `.instantml/clickhouse-logs`; smoke and benchmark scripts use temporary directories and clean them up afterward.

Useful overrides:

- `CLICKHOUSE_URL`: target ClickHouse HTTP URL. Default: `http://default:@127.0.0.1:8123/instantml`.
- `INSTANTML_DEV_CHDATA`: generated ClickHouse data path for `npm run dev:api`.
- `INSTANTML_DEV_CH_LOG_DIR`: generated ClickHouse log path for `npm run dev:api`.
- `INSTANTML_DEV_CH_TCP_PORT`, `INSTANTML_DEV_CH_INTERSERVER_PORT`, `INSTANTML_DEV_CH_MYSQL_PORT`: optional non-HTTP protocol ports when avoiding local collisions.

## Stripe Billing Smoke

`stripe-billing-smoke.mjs` starts a disposable Rust API and ClickHouse, then
uses the Stripe sandbox API to cover the paid billing path without relying on a
browser Checkout completion. It creates a paid signup Checkout Session, verifies
the unpaid sync stays blocked, creates a real test customer/subscription with
`tok_visa`, delivers signed local webhooks, verifies API-key writes after
activation, bills an extra seat, upgrades to Premium, records a storage-overage
report, schedules cancellation, and applies the downgrade webhook. Temporary
Stripe customers and subscriptions are canceled/deleted during cleanup; reusable
lookup-key prices and the storage meter are left in the sandbox account.

```bash
STRIPE_SECRET_KEY=sk_test_... npm run test:stripe-billing
```

The smoke refuses live keys unless `INSTANTML_STRIPE_SMOKE_ALLOW_LIVE=1` is set.
Hosted Stripe Checkout itself may still require manual browser completion
because Stripe test Checkout can present hCaptcha.

## Cloud Run Deploy Helper

`deploy-cloud-run.mjs` deploys the Rust API to Google Cloud Run for the internal hosted slice described in `docs/design/2026-05-16-gcp-cloud-run-rust-api.md`.

```bash
npm run deploy:cloud-run
npm run deploy:cloud-run -- --help
```

The helper reads the repo-root `.env` plus process env, then enables required GCP APIs, creates or reuses Artifact Registry, Cloud Run, Secret Manager, VPC, Cloud Router, Cloud NAT, and a regional static egress IP, syncs ClickHouse/Clerk/embed secrets to Secret Manager, builds the existing Rust image through Cloud Build, deploys Cloud Run, verifies `/health`, `/readyz`, `/api/auth/config`, and `/openapi.json`, then writes hosted API settings to `.env` and `apps/web/.env.local`. Current prod/staging storage should point at the self-hosted GCP ClickHouse endpoint through database-mode tenant routing. Single-service deploys write `INSTANTML_API_BASE`; split deploys write `INSTANTML_CONTROL_API_BASE` and `INSTANTML_DATA_API_BASE` unless the managed HTTPS router is created, in which case all three local API base values point to the router URL. The managed router pins auth, billing, org, dashboard preference, workspace-view, and iframe embed metadata routes to control; tenant product routes such as `/api/reports`, iframe session creation, and iframe run-data reads use the data backend. Admin endpoints stay on the control service for operator access and are not added to the public router path map. Default localhost frontend development should still run `INSTANTML_WEB_API_ENV=staging npm run web:dev`; that setting points Next rewrites at `https://staging.api.instantml.ai` and overrides those helper-written API bases unless an explicit router-bypass session sets `INSTANTML_WEB_EXPLICIT_API_BASES=1`.

When `INSTANTML_MCP_OAUTH_ENABLED=1`, the Rust data service also receives
`CLERK_SECRET_KEY` and `CLERK_API_BASE` so read-only MCP OAuth calls can verify
Clerk access tokens before resolving the selected org. Production deploys set
the flag through `deploy-cloud-run.yml` (enabled 2026-07-02); staging and local
deploys keep it unset for the API-key-only Rust auth path.

For split deployments with the managed HTTPS router, auth, billing,
organization, workspace-view, dashboard-preference, invitation, and
`GET /api/embed/sessions/:session_id/{frame-policy,current}` routes are routed
to the control service. Report routes, `POST /api/embed/sessions`, and
`POST /api/embed/sessions/:session_id/runs/data` use the data service.

Important environment variables:

- `GCP_PROJECT`: target project, otherwise the active `gcloud` project.
- `GCP_REGION`: deployment region. Default: `us-central1`.
- `INSTANTML_CLOUD_RUN_SERVICE`: legacy combined Cloud Run service name. Default: `instantml-rust-api`.
- `INSTANTML_CLOUD_RUN_CONTROL_SERVICE`: split control Cloud Run service name. Default: `instantml-control`.
- `INSTANTML_CLOUD_RUN_DATA_SERVICE`: split data Cloud Run service name. Default: `instantml-data-<region>-a`.
- `INSTANTML_CLOUD_RUN_DATA_CELL`: split data-cell label. Default: `<region>-a`; the helper sets runtime `INSTANTML_DEFAULT_DATA_CELL_ID` from this value for route placement and sets `INSTANTML_CELL_ID` only on the split data service so that service can register and heartbeat its `data_cells` row. Operators still need to seed backup freshness on the `data_cells` row before managed placement admits new routes.
- `INSTANTML_CLOUD_RUN_CONTROL_SCALING` / `INSTANTML_CLOUD_RUN_DATA_SCALING`: `manual` or `auto`. Prod defaults to manual one-instance services; staging defaults to auto min `0` max `1`.
- `INSTANTML_CLOUD_RUN_CONTROL_MIN_INSTANCES` / `INSTANTML_CLOUD_RUN_CONTROL_MAX_INSTANCES`: auto-scaling bounds for control. Defaults: `0` and `1`.
- `INSTANTML_CLOUD_RUN_DATA_MIN_INSTANCES` / `INSTANTML_CLOUD_RUN_DATA_MAX_INSTANCES`: auto-scaling bounds for data. Defaults: `0` and `1`.
- `INSTANTML_CLOUD_RUN_UNSAFE_CONTROL_MULTI_INSTANCE=1`: permits control scaling above one instance for controlled tests only.
- `INSTANTML_CLOUD_RUN_DATA_INSTANCES`: manual data instance count. Values above `1` fail unless `INSTANTML_CLOUD_RUN_UNSAFE_DATA_MULTI_WRITER=1` is set for a controlled test.
- `INSTANTML_CLOUD_RUN_STARTUP_PROBE`: optional full Cloud Run startup probe override. By default the helper probes `/readyz` every 10 seconds with a 10-minute failure window so split-service revision overlap can tolerate slow control-database replay.
- `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER=1`: creates or updates the managed HTTPS public router.
- `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN`: DNS host for the router, for example `api.instantml.ai`. Required when public router creation is enabled.
- `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_CERTIFICATE`: optional Google-managed SSL certificate resource name.
- `INSTANTML_ALLOWED_FRONTEND_ORIGINS`: comma-separated browser origins allowed for cookie-authenticated mutations. Default includes local Next and `https://instantml.ai`.
- `INSTANTML_FRONTEND_BASE_URL`: hosted web app origin used in device-code and organization invite links. Required when `RESEND_API_KEY` or `INSTANTML_EMAIL_PROVIDER=resend` is set.
- `INSTANTML_EMAIL_FROM`: verified sender used for organization invite email. Required when `RESEND_API_KEY` or `INSTANTML_EMAIL_PROVIDER=resend` is set.
- `INSTANTML_CLOUD_RUN_STATIC_EGRESS=0`: disables static egress setup. Keep static/private egress enabled for hosted GCP ClickHouse and BYOC/customer GCP ClickHouse endpoints unless there is an explicit networking plan.
- `INSTANTML_CLOUD_RUN_VPC_EGRESS`: Cloud Run VPC egress mode when static egress is enabled. Default: `all-traffic`; use `private-ranges-only` only when the service does not need the NAT IP for public BYOC/provider allowlists.
- `INSTANTML_CLOUD_RUN_NAT_LOGGING=1`: enables Cloud NAT logging for newly created NATs. Default is off to avoid paying for idle translation logs.
- `INSTANTML_CLICKHOUSE_ALLOWLIST_SERVICES=none`: skips legacy ClickHouse Cloud access-list updates.
- `INSTANTML_CLICKHOUSE_ALLOWLIST_KEYS=none`: skips legacy ClickHouse Cloud API-key access-list updates.
- `INSTANTML_CLICKHOUSE_PROVISIONER=database`: current hosted GCP ClickHouse tenant-routing mode.
- `INSTANTML_BYOC_EGRESS_CIDRS` / `INSTANTML_BYOC_EGRESS_SET_VERSION`: explicit static egress CIDRs and version label shown to BYOC customers. The deploy helper no longer falls back to legacy ClickHouse Cloud allowlist env for BYOC.
- `INSTANTML_REQUEST_TIMEOUT_SECONDS`: app-level HTTP timeout. Default hosted deploy value is `900` so first workspace creation and tenant schema setup have room to finish.
- `INSTANTML_EMBED_ENABLED`: enables iframe embed API routes. Hosted deploys default to `true`; set `false` only for an intentional hosted rollback.
- `INSTANTML_EMBED_FRAME_ENABLED`: enables iframe frame-policy lookup used by the Next embed proxy. Hosted deploys default to `true`; if disabled, iframe pages fail closed with `frame-ancestors 'none'`.
- `INSTANTML_EMBED_TOKEN_HMAC_SECRET`: HMAC secret for hashed embed bearer tokens. The helper syncs this to `instantml-embed-token-hmac-secret` and mounts it on control/data services.
- `INSTANTML_EMBED_ORG_ALLOWLIST`: optional comma-separated org UUID allowlist for embed session creation.
- `INSTANTML_ARTIFACT_BACKEND`: artifact byte backend. The helper defaults hosted deploys to `r2` when Cloudflare R2 credentials are present and to disabled local storage otherwise.
- `CLOUDFLARE_R2_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account used for per-org R2 buckets. The deploy helper normalizes either name to `CLOUDFLARE_ACCOUNT_ID` for the Rust service.
- `CLOUDFLARE_R2_API_KEY` / `CLOUDFLARE_API_TOKEN`: Cloudflare token used for R2 bucket management and S3-compatible object access.
- `CLOUDFLARE_R2_BUCKET_PREFIX`: optional bucket-name prefix. Default: `instantml-org`.
- `INSTANTML_LOG_FORMAT`: log format for the Rust service. Hosted deploys set `json`.
- `INSTANTML_SLOW_REQUEST_MS`: request latency threshold for `http_request_slow` warnings. Default: `1000`.

Do not run this from CI. It can create paid cloud resources, add Secret Manager versions, provision public Cloud Run or load-balancer URLs, and create Cloudflare R2 buckets when artifact uploads are enabled. The default deployment is the split `control` plus `data` shape; prod stays warm with one manual instance per service, while staging uses automatic min `0` max `1` to reduce idle cost without allowing multiple writers. The public router path refuses HTTP-only IP routing because auth/session and API-key traffic must use HTTPS; first router setup can return a pending DNS/certificate state before it writes the public API base. Hosted artifact byte uploads use Cloudflare R2 when configured; the helper mounts Cloudflare env/secrets only on non-control services, and any Cloudflare token Client IP filter must include every Cloud Run static egress IP that can run artifact uploads. See `docs/architecture/self-hosted-gcp-clickhouse.md` for the current self-hosted GCP ClickHouse operating model.

Before adding data cells or raising instance counts, run the Phase 0 capacity
preflight and record its JSON output in the operator ticket:

```bash
INSTANTML_CLOUD_SQL_CONNECTION_LIMIT=<cloud-sql-tier-limit> npm --silent run rust:capacity-plan
```

The runbook in `docs/ops/backend-phase-0-capacity.md` explains the active
revision, per-revision instance, deploy-overlap, operator-job, migration-job,
and headroom inputs. This preflight is intentionally separate from `deploy-cloud-run.mjs` so
operators can run it without mutating cloud resources.

Hosted Rust origin logs are Cloud Run stdout/stderr JSON logs. They include
request completion events with redacted route-template paths, `request_id`,
`trace_id`, `service_plane`, `route_plane`, and `plane_tag`; sanitized handled
error fields; rate-limit rejection events; slow-request warnings; and
first-slice workflow outcomes for project/run mutations, metric/log ingestion,
artifacts, imports, readiness, startup, and worker cleanup. If the public API
domain is proxied through Cloudflare, configure Cloudflare Log Explorer or
Logpush separately for edge request logs. Prefer path-only fields and custom
request-header capture for `x-request-id`; response-header capture is useful
when available but can be absent for edge-only failures. Avoid full URI fields
in normal jobs because query strings can contain user data. Treat observed
`cf-ray` as a correlation field, not a unique join key.

## Self-Hosted ClickHouse Migration Helper

`migrate-to-self-hosted-clickhouse.sh` is the one-off operator helper for the
current InstantML-owned GCP ClickHouse VM. It provisions or reuses the
`instantml-clickhouse` VM, writes the Rust server's User Data ClickHouse
secrets, and rolls the prod Cloud Run services.

The helper is rerun-safe for the common recovery path: when the VM already
exists, it reuses the latest `instantml-clickhouse-user-data-password` Secret
Manager value instead of generating a new password that the existing
ClickHouse container does not know. Password rotation is deliberately not
handled by this script; rotate inside ClickHouse first, then update Secret
Manager through a separate runbook.

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

`rust-large-run-benchmark.mjs` is the regression gate for the design-partner scale case: a 100,000-run project with realistic names, statuses, tags, notes, config, selected metric summaries, and one 20,000-step chart series. It starts disposable ClickHouse, applies the Rust ClickHouse schema, seeds operational records and metric rows directly into ClickHouse, starts the Rust API, and prints JSON p50/p95 timings for newest pages, literal search, field search, boolean search, regex search, metric sort, and chart reads.

```bash
npm run benchmark:large-runs
INSTANTML_BENCH_RUNS=100000 INSTANTML_BENCH_SAMPLES=10 INSTANTML_BENCH_WARMUPS=2 npm run benchmark:large-runs
INSTANTML_BENCH_RUNS=100000 INSTANTML_BENCH_SAMPLES=10 INSTANTML_BENCH_WARMUPS=2 INSTANTML_BENCH_WEB=1 npm run benchmark:large-runs
```

Useful environment variables:

- `INSTANTML_BENCH_RUNS`: number of seeded runs. Default: `100000`.
- `INSTANTML_BENCH_SAMPLES`: measured requests per endpoint. Default: `15`.
- `INSTANTML_BENCH_WARMUPS`: warmup requests per endpoint. Default: `2`.
- `INSTANTML_BENCH_WEB=1`: additionally build/start the Next app and measure first useful render.
- `INSTANTML_BENCH_ENFORCE=1`: exit nonzero if local budgets fail.

## Rank Insights Benchmark

`rank-insights-benchmark.mjs` measures the local frontend helper computations
behind the Insights dashboard over synthetic run summaries: grouped reducers,
numeric field extraction, k-means clustering, and evaluation metric cards. It
does not start ClickHouse or a browser.

```bash
npm run benchmark:rank-insights
INSTANTML_RANK_INSIGHTS_RUNS=2000 INSTANTML_RANK_INSIGHTS_SAMPLES=20 npm run benchmark:rank-insights
```

Useful environment variables:

- `INSTANTML_RANK_INSIGHTS_RUNS`: number of synthetic runs. Default: `1000`.
- `INSTANTML_RANK_INSIGHTS_SAMPLES`: measured repetitions. Default: `12`.
- `INSTANTML_RANK_INSIGHTS_WARMUPS`: warmup repetitions. Default: `3`.
- `INSTANTML_RANK_INSIGHTS_ENFORCE=1`: exit nonzero if local p95 exceeds the
  helper budget.

## Hosted Demo Benchmark Seed

`hosted-demo-seed-benchmark.mjs` signs in as the shared demo account, provisions or reuses its hosted tenant route, seeds the 100,000-run benchmark into that route once, restarts its temporary Rust server so tenant replay reads the direct seed, and prints sanitized hosted API p50/p95 timings. It benchmarks newest run pages, 100-row pages, name/tag/config/notes search, status filters, combined search+filter, selected-metric sorting, project overview, and a bounded chart series. It reads ClickHouse credentials from the local `.env`; do not run it from CI or against a disposable account unless you intend to create/use a hosted ClickHouse database or legacy provider service.

```bash
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 npm run benchmark:hosted-demo
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 INSTANTML_HOSTED_DEMO_SAMPLES=5 INSTANTML_HOSTED_DEMO_WARMUPS=1 npm run benchmark:hosted-demo
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 INSTANTML_HOSTED_DEMO_RESULT_PATH=/tmp/instantml-hosted-benchmark.json npm run benchmark:hosted-demo
```

Useful environment variables:

- `INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1`: required confirmation because this tool can create/use hosted tenant storage. In current prod/staging this should be database-mode self-hosted GCP ClickHouse; legacy cloud-service mode can still create paid provider services.
- `INSTANTML_HOSTED_DEMO_PROVISIONER`: `database` or `cloud-service`. Defaults to `INSTANTML_CLICKHOUSE_PROVISIONER` and then `database`.
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
- `INSTANTML_CLICKHOUSE_CLOUD_PROVIDER`, `INSTANTML_CLICKHOUSE_CLOUD_REGION`: legacy cloud-service location. Current self-hosted GCP ClickHouse/database-mode seeds do not need these.
- `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST`: comma-separated CIDRs allowed to query a legacy provider-backed tenant service. Current self-hosted GCP ClickHouse uses private VPC access instead.

## Hosted Cloud Run API Benchmark

`hosted-cloud-run-benchmark.mjs` is the default hosted performance signal after
the split Cloud Run deployment. It does not seed data. Instead, it expects a
pre-seeded tenant and validates `INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS` before
timing requests. The default remains the 100,000-run hosted-scale tenant usually
created by `seed:hosted-scale`; the May 23, 2026 GCP showcase result used
`normal-runs-50k` with `INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS=50000`. The benchmark
measures the real path the SDK/frontend use in production:

```text
benchmark client -> Cloud Run data service or HTTPS router -> self-hosted GCP ClickHouse tenant database
```

Run it from the repo root after setting an SDK API key for the tenant:

```bash
INSTANTML_API_KEY=instantml_... npm run benchmark:cloud-run
INSTANTML_API_KEY=instantml_... \
INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH=/tmp/instantml-cloud-run-benchmark.json \
npm run benchmark:cloud-run
```

The benchmark reads `INSTANTML_DATA_API_BASE` or `INSTANTML_API_BASE` from
`.env` by default. It rejects non-HTTPS API bases unless
`INSTANTML_CLOUD_RUN_BENCH_ALLOW_HTTP=1` is set for a local proxy. Measured
routes include org and project run summaries, the 100-row default dashboard
page, cursor page 2, lightweight selection-projection pages for the 100-run
default selection, 1,000-result search selection, and 2,000-run max selection,
name/tag/config/notes searches, status filters, combined search/filter,
selected-metric sorting, org/project overview, single-run chart series, and
batched selected-run `POST /api/metrics/series` calls for every configured
dashboard metric. By default the chart workload mirrors the current UI:
100 selected runs on fresh load, 1,000 selected `seed-13` search results, and
2,000 selected all-project results with adaptive per-run point limits. The
benchmark verifies the server-side 120,000-point batched-series cap. Results
are sanitized to host-only API metadata and never include API keys, raw URLs,
cookies, org IDs, or response bodies.

Useful environment variables:

- `INSTANTML_CLOUD_RUN_BENCH_API_BASE`: override the API base. Defaults to `INSTANTML_DATA_API_BASE` then `INSTANTML_API_BASE`.
- `INSTANTML_CLOUD_RUN_BENCH_API_KEY`: override the bearer API key. Defaults to `INSTANTML_API_KEY`.
- `INSTANTML_CLOUD_RUN_BENCH_PROJECTS`: comma-separated project names. Defaults to `INSTANTML_HOSTED_SCALE_PROJECTS` or `hosted-scale-control,hosted-scale-data`.
- `INSTANTML_CLOUD_RUN_BENCH_MIN_RUNS`: minimum runs expected across benchmark projects. Default: `100000`.
- `INSTANTML_CLOUD_RUN_BENCH_EXPECTED_STEPS`: expected metric steps per run for chart/window choices. Default: `1000`.
- `INSTANTML_CLOUD_RUN_BENCH_DEFAULT_SELECTED_RUNS`: default fresh-dashboard selected runs. Default: `100`.
- `INSTANTML_CLOUD_RUN_BENCH_SEARCH_SELECTED_RUNS`: selected runs for the search-result chart workload. Default: `1000`.
- `INSTANTML_CLOUD_RUN_BENCH_SELECTED_RUNS`: selected runs for the max-selection chart workload. Default: `2000`.
- `INSTANTML_CLOUD_RUN_BENCH_SELECTION_QUERY`: query used for the search-result selection workload. Default: `seed-13`.
- `INSTANTML_CLOUD_RUN_BENCH_CHART_LIMIT`: per-series chart row limit. Default: `1000`.
- `INSTANTML_CLOUD_RUN_BENCH_SAMPLES`: measured requests per endpoint. Default: `8`.
- `INSTANTML_CLOUD_RUN_BENCH_WARMUPS`: warmup requests per endpoint before timing. Default: `2`.
- `INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH`: optional sanitized JSON output path.
- `INSTANTML_CLOUD_RUN_BENCH_ENFORCE=1`: exit nonzero if hosted p95 budgets fail.

## Hosted Tenant Scale Seed

`hosted-tenant-scale-seed.mjs` is a guarded live cutover/load-test helper for an
already-provisioned hosted tenant. It reads the latest ready tenant route from
User Data, optionally verifies `INSTANTML_API_KEY` against the deployed data
service, can truncate tenant data tables, then seeds two projects with
100,000 total runs and 1,000 steps per run by generating metric rows inside the
tenant ClickHouse warehouse. This avoids millions of one-step public API calls
while preserving the deployed storage and dashboard read path.

```bash
INSTANTML_HOSTED_SCALE_SEED_ALLOW=1 \
INSTANTML_HOSTED_SCALE_TRUNCATE=1 \
INSTANTML_API_KEY=instantml_... \
npm run seed:hosted-scale
```

Useful environment variables:

- `INSTANTML_HOSTED_SCALE_SEED_ALLOW=1`: required confirmation because this writes to live hosted ClickHouse.
- `INSTANTML_HOSTED_SCALE_TRUNCATE=1`: wipe tenant `operational_records`, `metric_points`, `metric_series`, and `console_log_lines` before seeding.
- `INSTANTML_HOSTED_SCALE_ORG_ID`: target a specific org route; otherwise the latest ready tenant route is used.
- `INSTANTML_HOSTED_SCALE_RUNS`: total runs. Default: `100000`.
- `INSTANTML_HOSTED_SCALE_STEPS`: metric steps per run. Default: `1000`.
- `INSTANTML_HOSTED_SCALE_PROJECTS`: comma-separated project names. Default: `hosted-scale-control,hosted-scale-data`.
- `INSTANTML_HOSTED_SCALE_METRIC_KEYS`: comma-separated metric keys. Defaults include `eval/return_mean`, `eval/success_rate`, training metrics, and system metrics.
- `INSTANTML_HOSTED_SCALE_RUN_BATCH`: run batch size per server-side metric insert. Default: `500`.
- `INSTANTML_HOSTED_SCALE_KEEP_SEED_TABLE=1`: keep the temporary ClickHouse seed table for debugging.
- `INSTANTML_HOSTED_SCALE_CLICKHOUSE_ENDPOINT_OVERRIDE`: operator-only connection endpoint override for private hosted ClickHouse, such as an IAP/SSH tunnel to `http://127.0.0.1:18123`. The helper still uses the tenant route's database and credentials; only the network endpoint used by this local script changes.

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

`rust-sdk-smoke.py` is the Python SDK overlap check used by `npm run test:rust:sdk`. The harness creates a disposable local signup and SDK API key before invoking the SDK, so it matches the SDK's credential requirement while still testing a throwaway Rust/ClickHouse stack.

The web smoke in `apps/web/tests/ui-smoke.mjs` follows the same default: no API base means Rust/ClickHouse. Set `INSTANTML_UI_SMOKE_API_BASE` to test an already-running Rust-compatible backend. The full UI smoke covers landing, local auth, onboarding, and dashboard routes, so it depends on Rust session/auth endpoints rather than the deprecated Node compatibility server.

When `rust-service-smoke.mjs` launches the UI smoke against a disposable Rust API, it overrides `INSTANTML_API_BASE` and `INSTANTML_API_ALLOWED_ORIGINS` together so hosted values in the repo-root `.env` cannot break local smoke builds.

Rust service commands:

```bash
npm run rust:fmt
npm run rust:lint
npm run rust:test
npm run rust:migrate
npm run rust:serve
```

`hosted-clickhouse-smoke.mjs` is the local control/data rollout gate behind
`npm run test:hosted-clickhouse`. It starts disposable ClickHouse plus two Rust
processes: `INSTANTML_SERVICE_PLANE=control` for auth/session/org/API-key and
tenant provisioning, and `INSTANTML_SERVICE_PLANE=data` for project/run/metric
and dashboard routes. It verifies role-specific route tables, data-plane
control-record refresh before auth, Python SDK ingestion through the data role,
and dashboard readback after a data-process restart. It does not deploy or touch
live GCP ClickHouse, ClickHouse Cloud, or Cloud Run resources.

The shared local ClickHouse helper starts loopback ClickHouse with writable
access storage, so local BYOC/browser checks can create a passworded
ClickHouse user that matches the self-hosted GCP setup flow. Disposable smokes
may still use the default user when they bypass the browser form directly.

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
