# Rust Server

This directory contains the primary Rust backend for InstantML. The current storage slice is ClickHouse-only: a low-volume operational record log rebuilds local/control-plane state, while metric tables remain the high-volume analytical layer. Hosted ClickHouse mode adds an InstantML User Data control table for users, orgs, sessions, API keys, tenant routes, dashboard preferences, and saved workspace views, then stores tenant-owned runs and metrics in the org's routed ClickHouse database/service. The deprecated Node server remains only as a compatibility oracle, JSON migration source, and legacy fallback.

## Purpose

- Serve the product API with `axum`, `tokio`, and `tower-http`.
- Store users, orgs, sessions, API keys, dashboard preferences, saved workspace views, projects, runs, attributes, artifacts, imports, usage snapshots, and idempotency records as append-only operational records in ClickHouse.
- In hosted ClickHouse mode, store users, orgs, sessions, API keys, dashboard preferences, saved workspace views, tenant routes, and Stripe billing projections in the User Data control table, while projects/runs/metrics stay in each org tenant data plane.
- Accept Free/Pro/Premium signup, redirect paid signup through Stripe Checkout before unlocking writes, send token-backed organization invitation emails, activate verified invited members into the same org, expose UTC calendar-month metric usage plus retained-resource usage, enforce billing/payment gates and blocked-at-limit usage guardrails for new data-plane writes, and manage org API keys. For managed Clerk signups, auto-derive the workspace name from the Clerk display name or email handle when `org_name` is absent; mint a one-time `sdk:ingest`-scoped SDK key and return it in the auth response as `onboarding_api_key` only for new org creation after payment is verified and storage setup is ready.
- Support Premium customer-owned ClickHouse onboarding for empty orgs through a data-plane validation route. BYOC orgs stay in `storage_unconfigured` until an owner/admin validates and saves a public HTTPS ClickHouse endpoint, database, username, and password; SDK key creation and product writes are blocked until the route is ready.
- Store raw metric points and aggregated metric series in ClickHouse via `metric_store::MetricStore`.
- Store artifact bytes on the local filesystem for development or in private per-org Cloudflare R2 buckets when `INSTANTML_ARTIFACT_BACKEND=r2`, while ClickHouse stores artifact metadata, R2 references, exact byte counts, hashes, and MIME types.
- Preserve current REST response shapes for the SDK, contract smoke, and UI smoke.
- Keep hosted multi-process/control-plane routing work behind `docs/design/2026-05-16-multi-instance-control-data-plane.md`; the in-process operational index is accepted for local/test and narrow single-writer cells only. The server can now run as `combined`, `control`, or `data` through `INSTANTML_SERVICE_PLANE`, and data-plane auth refreshes User Data control records before request auth. Live multi-writer freshness, write uniqueness, public cell routing, and metric/log idempotency remain scale-out gates.

## Local Setup

Install Rust 1.83 or newer through `rustup` and make sure a ClickHouse service is reachable. The root helper can auto-start a local `clickhouse server` for loopback URLs when the binary is installed.

```bash
rustc --version
clickhouse --version
```

Start from the repo root:

```bash
CLICKHOUSE_URL=http://default:@127.0.0.1:8123/instantml \
INSTANTML_BIND_ADDR=127.0.0.1:8001 \
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
```

The `serve` command applies the ClickHouse schema before listening. It also creates a fixed local development organization for unauthenticated local compatibility mode. Browser dashboard sessions created by the local dev auth flow use their own signed-in org.

For the root `npm run dev:api` helper, generated ClickHouse state/logs live under `.instantml/clickhouse` and `.instantml/clickhouse-logs`. Set `CLICKHOUSE_URL` to use an existing service, or leave the default loopback URL so the helper can start a local `clickhouse server`.

## Commands

From the repo root:

```bash
npm run dev:api
npm run rust:fmt
npm run rust:fmt:check
npm run rust:lint
npm run rust:test
npm run rust:verify
npm run rust:migrate
npm run rust:serve
npm run deploy:cloud-run
npm run deploy:cloud-run:single
npm run deploy:cloud-run:multi
npm run deploy:cloud-run:staging
```

Binary subcommands:

```bash
cargo run --manifest-path apps/rust-server/Cargo.toml -- serve
cargo run --manifest-path apps/rust-server/Cargo.toml -- all
cargo run --manifest-path apps/rust-server/Cargo.toml -- migrate
cargo run --manifest-path apps/rust-server/Cargo.toml -- worker
```

`worker` prunes expired idempotency keys and expired/revoked browser sessions from the single-process index, then writes immutable `usage_daily` snapshots for each organization. With the ClickHouse-only first slice, cleanup compacts live memory only; durable operational-log compaction is deferred to the hosted storage follow-up.

## Hosted Cloud Run Deployment

`npm run deploy:cloud-run` deploys the Rust API to Google Cloud Run using the existing root `Dockerfile`. It is now the default production split control/data deployment path. `npm run deploy:cloud-run:multi` is the explicit equivalent. `npm run deploy:cloud-run:single` keeps the legacy combined-service path available when an operator needs one service. `npm run deploy:cloud-run:staging` deploys isolated staging Cloud Run services and a staging HTTPS router for `staging.api.instantml.ai`.

The helper enables required GCP APIs, ensures Artifact Registry, creates or reuses a runtime service account, syncs selected local secrets into Secret Manager, configures a regional VPC/Cloud NAT static egress IP, updates ClickHouse Cloud service and API-key access lists when ClickHouse Cloud API credentials are available, builds through Cloud Build, configures an HTTP startup probe against `/readyz`, and verifies `/health`, `/readyz`, `/api/auth/config`, and `/openapi.json`.

Expect hosted deploys to take a while. A normal `npm run deploy:cloud-run` or
`npm run deploy:cloud-run:staging` run can take 10-30 minutes because Cloud
Build uploads/builds the Rust image, Cloud Run rolls out revisions, managed
certificates may provision, and live smoke checks run after deployment. Sparse
or quiet `gcloud` output during those phases is not a timeout by itself.

The first split hosted launch shape is:

- `instantml-control` with `INSTANTML_SERVICE_PLANE=control`, manual scaling, and 1 active instance by default.
- `instantml-data-<region>-a` with `INSTANTML_SERVICE_PLANE=data`, manual scaling, and 1 active instance by default.

Control and data-plane cells stay single-writer by default until the durable multi-writer gates in `docs/design/2026-05-16-multi-instance-control-data-plane.md` are complete. A Cloud Run `maxScale=1` setting reduces risk but is not a correctness mechanism under automatic scaling; customer-facing single-writer cells should use manual scaling or an app-level write lease before relying on one writer. The deploy helper rejects control/data scaling above one active instance unless the matching unsafe test flag is set for a controlled test.

On startup, the server retries the initial operational/User Data projection rebuild with 1s, 2s, and 4s backoff before exiting non-zero. `/readyz` fails until the projection has loaded, so Cloud Run does not route traffic to an instance that has an empty auth/org/API-key view. Later background refresh failures keep serving the last-known-good projection, log a warning, and expose degraded state through `/readyz` and `/metrics`. Valid data-plane requests stay on the warmed in-memory hot path; an API-key or session auth miss forces one control-record refresh and retries auth so newly created keys/sessions are usable immediately after control-plane writes.

Split deploys write local frontend env with direct control/data Cloud Run service URLs by default. When `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER=1` and `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN` are set, the helper creates a managed HTTPS external Application Load Balancer and writes that one public API base. The helper refuses HTTP-only public routing because hosted auth, session cookies, and API keys must not cross a cleartext `http://<ip>` endpoint. The single-service deploy writes the deployed API URL to both the repo-root `.env` and `apps/web/.env.local`, so the local frontend can be started afterward with `npm run web:dev`.

Production public API routing is `api.instantml.ai -> instantml-control/instantml-data-us-central1-a`. Staging routing is `staging.api.instantml.ai -> instantml-staging-control/instantml-staging-data-us-central1-a`. Staging uses scoped Secret Manager names and defaults the User Data ClickHouse database path to `instantml_user_data_staging`, so local staging tests do not write production User Data records. Staging still creates real ClickHouse Cloud tenant services when the cloud-service provisioner is exercised.

Hosted deploys use `INSTANTML_AUTH_MODE=api-key`, disable local dev auth, enable hosted ClickHouse routing, and enable Clerk only when `CLERK_SECRET_KEY` is configured. Managed Clerk deploys must also provide `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` or `CLERK_PUBLISHABLE_KEY` from the same Clerk application; the deploy helper decodes that public key, derives `CLERK_JWT_ISSUER`, validates `CLERK_SECRET_KEY` against Clerk Backend API domain metadata, writes the issuer into Cloud Run, and fails before cloud mutation when the secret, public key, or explicit issuer point at different Clerk instances. `GET /api/auth/config` exposes the client-safe `clerk_jwt_issuer` so a staging frontend can detect when it was built with the wrong publishable key instead of failing later during token exchange. Organization invitation email uses `INSTANTML_EMAIL_PROVIDER=resend` when `RESEND_API_KEY` is present; `INSTANTML_FRONTEND_BASE_URL` must point at the hosted web app and `INSTANTML_EMAIL_FROM` must point at a verified sender before Resend-backed deploys so invite emails never fall back to localhost links or an unverified sender. The deploy helper syncs the Resend secret only to control-plane services. Bootstrap routes remain disabled unless an operator explicitly provides `INSTANTML_BOOTSTRAP_TOKEN`.

Organization invitations are app-owned token records, not Clerk Organization
memberships. Create and resend write `email_delivery` attempts and share
rolling send-rate limits; a failed resend keeps the previous delivered token
valid, while a successful resend clears previous token hashes. Accepted,
revoked, and expired invitations are not token-indexed after replay, so old
links cannot re-authorize access. Managed Clerk acceptance must go through
`POST /api/auth/clerk` with `accept_invite_token` so the server preflights the
invite and reconciles the current verified Clerk email before creating or
activating a membership. Legacy `/seats` invited rows still count as reserved
seats, but a token invite for the same email/org reuses that reservation
instead of double-counting.

Logical control/data-plane division is available before deployment:

- `INSTANTML_SERVICE_PLANE=combined` is the default and exposes the current full route set from one Rust process.
- `INSTANTML_SERVICE_PLANE=control` exposes platform, auth/session, invitation, billing, user/org, seat, API-key, service-account, dashboard preference, workspace-view, tenant provisioning, and route-management surfaces. It requires hosted ClickHouse/User Data and does not expose project/run/metric/product data routes.
- `INSTANTML_SERVICE_PLANE=data` exposes platform and tenant product routes for projects, runs, metrics, logs, attributes, objects, artifacts, export, usage, imports, demo reset, and customer-owned ClickHouse validation/setup. It requires hosted ClickHouse/User Data, refreshes control records before bearer/session auth, and then loads the routed tenant data plane for the authenticated org.

The local `test:hosted-clickhouse` smoke runs this split against disposable ClickHouse to validate the division. The deploy helper now supports deploying the split shape, but shared data cells still must not be raised above the documented single-writer default until the remaining multi-writer gates are closed.

## Config

Environment variables:

- `CLICKHOUSE_URL`: ClickHouse HTTP connection string of the form `http://user:pass@host:port/database`. Default: `http://default:@127.0.0.1:8123/instantml`. The named database is created if missing on startup.
- `INSTANTML_BIND_ADDR`: API bind address. Default: `127.0.0.1:8001`.
- `INSTANTML_SERVICE_PLANE`: `combined`, `control`, or `data`. Default: `combined`. `control` and `data` require `INSTANTML_HOSTED_CLICKHOUSE_ENABLED=true`.
- `INSTANTML_CELL_ID`: optional operator label for a data-plane cell. The deploy helper sets it for split data services.
- `INSTANTML_AUTH_MODE`: `local` or `api-key`. Default: `local`.
- `INSTANTML_BOOTSTRAP_TOKEN`: required for bootstrap routes when `INSTANTML_AUTH_MODE=api-key`.
- `INSTANTML_ARTIFACT_BACKEND`: artifact byte backend, `local` or `r2`. Default: `local`.
- `INSTANTML_ARTIFACT_ROOT`: local artifact byte root when `INSTANTML_ARTIFACT_BACKEND=local`. Default: `.instantml/rust-artifacts`.
- `INSTANTML_MAX_BODY_BYTES`: general JSON body cap. Default: `1000000`.
- `INSTANTML_MAX_UPLOAD_BODY_BYTES`: upload JSON body cap. Default: `50000000`.
- `INSTANTML_REQUEST_TIMEOUT_SECONDS`: HTTP timeout. Default: `30`.
- `INSTANTML_LOG_FORMAT`: `pretty` or `json`. Default: `pretty`.
- `INSTANTML_SLOW_REQUEST_MS`: request latency threshold for `http_request_slow` warning logs. Default: `1000`.
- `INSTANTML_DEV_AUTH_ENABLED`: enables the local Google-style auth endpoint when `INSTANTML_AUTH_MODE=local`. Loopback local binds enable it by default.
- `CLERK_SECRET_KEY`: Clerk Backend API secret used to verify hosted browser sessions and fetch user profiles.
- `INSTANTML_MANAGED_CLERK_ENABLED`: enables hosted Clerk auth. Defaults to enabled when `CLERK_SECRET_KEY` is present and `INSTANTML_AUTH_MODE=api-key`.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` or `CLERK_PUBLISHABLE_KEY`: Clerk publishable key from the same application as `CLERK_SECRET_KEY`. The Cloud Run deploy helper requires this for managed Clerk, derives `CLERK_JWT_ISSUER` from it when unset, and rejects mismatches.
- `CLERK_API_BASE`: Clerk Backend API base URL. Default: `https://api.clerk.com`.
- `CLERK_JWT_ISSUER`: exact Clerk session-token issuer. Cloud Run deploys derive this from the publishable key when unset. When running the server manually without the deploy helper, set it to the Clerk frontend API origin to pin tokens to one instance.
- `INSTANTML_CLERK_SESSION_MAX_AGE_SECONDS`: maximum accepted age for a Clerk session token exchanged into an InstantML session. Default: `600`.
- `INSTANTML_FRONTEND_BASE_URL`: base URL of the web frontend used to build device-code verification URIs and organization invitation accept links (for example, `https://app.instantml.ai`). Resend-backed email requires a non-localhost value; local/log mode can fall back to `INSTANTML_ALLOWED_FRONTEND_ORIGINS`, then `http://localhost:3000`.
- `INSTANTML_ALLOWED_FRONTEND_ORIGINS`: comma-separated extra origins allowed to perform cookie-authenticated mutating requests.
- `INSTANTML_SIGNUP_ALLOWED_EMAILS`: comma-separated exact email allowlist for hosted Clerk signups. Sign-in for existing memberships is still allowed.
- `INSTANTML_SIGNUP_ALLOWED_DOMAINS`: comma-separated hosted Clerk signup domain allowlist. Domains may be written with or without a leading `@`.
- `INSTANTML_EMAIL_PROVIDER`: `disabled`, `log`, or `resend`. Defaults to `resend` when `RESEND_API_KEY` is present, `log` in local auth mode, and `disabled` in hosted API-key mode without Resend.
- `RESEND_API_KEY` or `INSTANTML_RESEND_API_KEY`: Resend API key for send-only organization invitation emails. Required when `INSTANTML_EMAIL_PROVIDER=resend`.
- `INSTANTML_EMAIL_FROM`: invitation sender address. Required with Resend and must use a verified sending domain, such as `InstantML <invites@mail.instantml.ai>`. Log/local email defaults to `InstantML <invites@instantml.ai>` when unset.
- `INSTANTML_EMAIL_REPLY_TO`: optional invitation reply-to address.
- `INSTANTML_ARTIFACT_UPLOADS_ENABLED`: enables artifact byte uploads. Defaults to `true` for local artifact storage in local mode, `false` for hosted ClickHouse without R2, and `true` when `INSTANTML_ARTIFACT_BACKEND=r2`.
- `CLOUDFLARE_R2_ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account id used for R2 bucket management and the S3-compatible endpoint default.
- `CLOUDFLARE_R2_API_KEY` or `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers R2 Storage read/write permissions. Used to create per-org buckets and, when explicit S3 credentials are omitted, derive R2 S3 credentials from the token id and SHA-256 token value. If the token uses Client IP Address Filtering, include the Cloud Run static egress IPs that run artifact uploads.
- `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`: optional explicit R2 S3 credentials for object PUT/GET/DELETE.
- `CLOUDFLARE_R2_BUCKET_PREFIX`: prefix for per-org private buckets. Default: `instantml-org`; bucket names are `<prefix>-<org_id.simple>`.
- `CLOUDFLARE_R2_ENDPOINT`: optional S3-compatible endpoint. Default: `https://<account_id>.r2.cloudflarestorage.com`.
- `INSTANTML_HOSTED_CLICKHOUSE_ENABLED`: enables User Data control-plane storage and tenant routing. Default: disabled.
- `CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT`, `CLICKHOUSE_INSTANTML_USER_DATA_USERNAME`, `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD`: ClickHouse endpoint and credentials for the `instantml_user_data` control table. Values may live in local `.env`; process env wins when both are set.
- `INSTANTML_TENANT_CLICKHOUSE_URL`: base ClickHouse HTTP URL for database-mode tenant provisioning. Set this explicitly for hosted experiments; falling back to the User Data endpoint is only a local/test convenience.
- `INSTANTML_CLICKHOUSE_PROVISIONER`: `database` or `cloud-service`. Default: `database`, which is local/test only unless paired with per-org least-privilege ClickHouse users and cross-database denial tests.
- `CLICKHOUSE_CLOUD_ENDPOINT`, `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID`, `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET`, `INSTANTML_CLICKHOUSE_CLOUD_ORG_ID`, `INSTANTML_CLICKHOUSE_CLOUD_PROVIDER`, `INSTANTML_CLICKHOUSE_CLOUD_REGION`, `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST`, `INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB`, `INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB`, `INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS`, `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING`, `INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS`: cloud-service provisioner settings. `INSTANTML_CLICKHOUSE_CLOUD_ORG_ID` is optional when the API key can discover an organization through `GET /v1/organizations`. `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST` is required in cloud-service mode and should include the Cloud Run static egress CIDR, currently `136.115.243.188/32`, so every new tenant service is created with API-only ClickHouse access. Cloud-service mode is opt-in because it can create external paid services. `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING=false` keeps selected Free/Pro/Premium warehouse sizes as recorded route intent while actual creation stays capped by operator memory/replica defaults.
- `INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS`: permits storing tenant passwords in User Data. Required for cloud-service mode until a secret manager is wired; database mode uses the configured tenant-base password reference instead.
- `INSTANTML_SHARED_CELL_URL`: ClickHouse HTTP connection string for the shared cell used by personal/free orgs. When set, new signups with `account_type=personal` (or no `account_type`) write a `tenant_route` record pointing at this cell and do not trigger a ClickHouse Cloud provisioning call. Format: `http://user:pass@host:port/database`. If absent, personal signups fall through to the existing dedicated provisioning path.
- `INSTANTML_SHARED_CELL_DATABASE`: database name inside the shared cell. Defaults to `instantml_shared`. Only relevant when `INSTANTML_SHARED_CELL_URL` is set.
- `INSTANTML_BYOC_EGRESS_CIDRS`: comma-separated static egress CIDRs shown to BYOC customers for ClickHouse IP allowlisting. Defaults to `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST` when unset. Hosted BYOC signup/validation is rejected until this is configured; local private-endpoint smoke tests can bypass it with `INSTANTML_BYOC_ALLOW_PRIVATE_ENDPOINTS=true`.
- `INSTANTML_BYOC_EGRESS_SET_VERSION`: operator label for the currently displayed BYOC egress set. Defaults to `configured` when CIDRs exist and `local-dev` otherwise.
- `INSTANTML_BYOC_ALLOW_PRIVATE_ENDPOINTS`: local/test-only flag that permits non-HTTPS and private/loopback BYOC endpoints. Keep unset in hosted environments.
- `INSTANTML_BYOC_SECRET_BACKEND`: BYOC credential storage backend. Use `gcp-secret-manager` in hosted environments. `local-user-data` is local/test-only and stores the customer password in the route record for disposable smoke tests. `disabled` blocks BYOC signup and route creation.
- `INSTANTML_BYOC_SECRET_PROJECT_ID`: Google Cloud project for BYOC Secret Manager storage. Falls back to `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, or `GCLOUD_PROJECT`.
- `INSTANTML_BYOC_SECRET_PREFIX`: Secret Manager secret-id prefix for customer ClickHouse passwords. Defaults to `instantml-byoc-clickhouse`.
- `INSTANTML_BYOC_SECRET_MANAGER_API_BASE`: Secret Manager API base URL. Defaults to `https://secretmanager.googleapis.com/v1`.
- `INSTANTML_BYOC_SECRET_MANAGER_ACCESS_TOKEN`: optional bearer token for local/operator tests. In Cloud Run, leave unset and grant the runtime service account Secret Manager access so the metadata token path is used.
- `INSTANTML_BYOC_ALLOW_USER_DATA_STORED_PASSWORDS`: deprecated alias that maps to `INSTANTML_BYOC_SECRET_BACKEND=local-user-data` for existing local scripts. Do not use in hosted environments.
- `INSTANTML_BILLING_ENABLED`: enables Stripe billing. Defaults to `true` when `STRIPE_SECRET_KEY` is present.
- `STRIPE_SECRET_KEY`: Stripe secret key used for Checkout, price lookup/creation, subscription updates, storage meter events, and Customer Portal sessions.
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret for `POST /api/billing/webhook`.
- `STRIPE_API_VERSION`: Stripe API version sent on server-side requests. Default: `2026-04-22.dahlia`.
- `STRIPE_PRO_PRICE_ID`, `STRIPE_PREMIUM_PRICE_ID`, `STRIPE_EXTRA_SEAT_PRICE_ID`, `STRIPE_STORAGE_OVERAGE_PRICE_ID`: optional Stripe price IDs. When omitted in sandbox, the server discovers or creates stable lookup-key prices for Pro, Premium, extra seats, and retained-storage overage.
- `STRIPE_STORAGE_METER_ID`: optional Stripe Billing Meter id for retained-storage overage. When omitted in sandbox, the server discovers or creates an active meter with `INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME`.
- `INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME`: Stripe meter event name used by `POST /api/billing/storage-overage/report`. Default: `instantml_storage_overage_gib_month`.
- `INSTANTML_BILLING_SUCCESS_URL`, `INSTANTML_BILLING_CANCEL_URL`, `INSTANTML_BILLING_PORTAL_RETURN_URL`: frontend URLs used by Checkout and Customer Portal. Defaults are built from `INSTANTML_FRONTEND_BASE_URL`.
- `INSTANTML_BILLING_GRACE_DAYS`: payment-failure write grace window. Default: `7`.
- `INSTANTML_EXTRA_SEAT_MONTHLY_USD`, `INSTANTML_STORAGE_OVERAGE_CENTS_PER_GIB_MONTH`: sandbox/default price creation amounts. Defaults: `$99/seat-month` and `$0.03/GiB-month`.

Run `npm run test:stripe-billing` with a Stripe sandbox `STRIPE_SECRET_KEY` to
exercise the paid signup, subscription webhook, payment-failure recovery,
extra-seat, upgrade, storage-overage report, scheduled cancel, and downgrade
paths against a disposable local Rust API and ClickHouse. The smoke refuses
live keys unless `INSTANTML_STRIPE_SMOKE_ALLOW_LIVE=1` is set, creates or reuses
lookup-key sandbox prices/meters, creates temporary test customers and
subscriptions, and cancels/deletes those temporary Stripe resources at the end.

Cloud-service retries recover from a service that was created before the route credentials were persisted by resetting that service password through the ClickHouse Cloud API, then writing a ready tenant route. This handles browser/API request timeouts during first provisioning without requiring manual User Data edits.

Shared demo auth:

- Local/dev Google-style auth canonicalizes `hello@instantml.ai` and the legacy typo alias `hello@instantml.com` to one Premium-tier `InstantML Demo` business org. Repeated demo sign-ins reuse that org and tenant route instead of creating another service.
- API keys created for the `InstantML Demo` org are forced to read-only `export:read` scope and the copy-once plaintext secret is not returned. Effective scopes are also clamped at API-key authentication/list time, so older demo keys cannot use stale write scopes to mutate the tenant warehouse or User Data control records such as API keys and service accounts. Demo browser sessions are also read-only for mutation routes, including SDK-style writes, imports, artifacts, API-key administration, and seat changes. This keeps the public demo browsable without encouraging writes into the shared warehouse.

## Observability

Local development defaults to `INSTANTML_LOG_FORMAT=pretty`. Hosted Cloud Run
deploys set `INSTANTML_LOG_FORMAT=json`; keep
`RUST_LOG=instantml_rust_server=info,tower_http=info` unless an incident needs
temporary debug-level detail.

Every HTTP request emits a structured completion event with method, path only
(no query string), status, latency, service plane, generated/propagated
`x-request-id`, observed `cf-ray` when present, a coarse user-agent family, and
whether Cloudflare's connecting-IP header was present. Slow requests at or
above `INSTANTML_SLOW_REQUEST_MS` emit an additional warning.

Server-error logs are sanitized: they include status, stable code, retryability,
and a static safe summary instead of raw provider or storage error text. The
first workflow slice logs batch-level outcomes for metric ingestion, console-log
ingestion, artifact upload/download, imports, readiness failures, startup, and
worker cleanup. These events may include stable product IDs such as `org_id`,
`project_id`, `run_id`, `artifact_id`, and `import_id`; they must not include
emails, bearer tokens, session IDs, API-key plaintext, object-storage keys,
signed URLs, query strings, project/run names, metric values, metric keys,
config/metadata JSON, console line messages, or artifact filenames.

Cloudflare captures edge/request logs separately from Rust origin logs. When an
API domain is proxied through Cloudflare, configure Log Explorer or Logpush for
path-only HTTP request fields where the plan supports them, plus custom
response-header capture for `x-request-id` before relying on that search path.
Avoid normal Logpush jobs that store full `ClientRequestURI`, because it can
include user query strings. Treat observed `cf-ray` as a correlation field, not
a unique join key; pair it with time window, host, path, status, and
`x-request-id` whenever possible.

Root helper-only environment variables:

- `INSTANTML_DEV_CHDATA`, `INSTANTML_DEV_CH_LOG_DIR`: generated ClickHouse state and logs for `npm run dev:api`.
- `INSTANTML_DEV_CH_TCP_PORT`, `INSTANTML_DEV_CH_INTERSERVER_PORT`, `INSTANTML_DEV_CH_MYSQL_PORT`: optional non-HTTP ports for avoiding local collisions.
- `INSTANTML_CLOUD_RUN_TOPOLOGY`: `single` or `split` for `tools/deploy-cloud-run.mjs`. `deploy:cloud-run` and `deploy:cloud-run:multi` pass `split`.
- `INSTANTML_DEPLOY_ENV`: `prod` or `staging`. Defaults to `prod`; staging changes default service/router names, secret names, and User Data database path.
- `INSTANTML_CLOUD_RUN_SCALING`, `INSTANTML_CLOUD_RUN_INSTANCES`: combined-service scaling mode and manual instance count. The legacy single deploy defaults to manual `1`.
- `INSTANTML_CLOUD_RUN_CONTROL_SERVICE`, `INSTANTML_CLOUD_RUN_DATA_SERVICE`, `INSTANTML_CLOUD_RUN_DATA_CELL`: split Cloud Run service/cell names.
- `INSTANTML_CLOUD_RUN_CONTROL_SCALING`, `INSTANTML_CLOUD_RUN_DATA_SCALING`: `auto` or `manual`. Both default to `manual`.
- `INSTANTML_CLOUD_RUN_CONTROL_INSTANCES`, `INSTANTML_CLOUD_RUN_DATA_INSTANCES`: manual split instance counts. Values above `1` are blocked unless the matching unsafe control/data test flag is set.
- `INSTANTML_CLOUD_RUN_STARTUP_PROBE`: optional raw Cloud Run startup probe override. Defaults to `httpGet.path=/readyz,httpGet.port=8000,initialDelaySeconds=0,timeoutSeconds=10,periodSeconds=10,failureThreshold=30`.
- `INSTANTML_CLOUD_RUN_BACKEND_TIMEOUT_SECONDS`: public-router backend timeout. Defaults to Cloud Run/Rust timeout and then `900`.
- `INSTANTML_CLOUD_RUN_UNSAFE_CONTROL_MULTI_INSTANCE`: permits control scaling above one instance for controlled tests only.
- `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER`, `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN`, `INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_CERTIFICATE`: managed HTTPS public router controls.
- `INSTANTML_CLOUD_RUN_SECRET_PREFIX`: Secret Manager prefix for non-prod deploys. Staging defaults to `instantml-staging-`.
- `INSTANTML_STAGING_USER_DATA_DATABASE`, `INSTANTML_STAGING_USER_DATA_ENDPOINT`: staging User Data database/path override. Defaults to database `instantml_user_data_staging` on the configured User Data ClickHouse endpoint.
- `INSTANTML_PUBLIC_API_BASE`: public load balancer/router URL written to local frontend env after a split deploy.

## HTTP Surface

Implemented health and platform endpoints:

- `GET /health`
- `GET /healthz`
- `GET /readyz`: returns `status`, `control_projection_loaded`, and `control_refresh_degraded`; fails with 503 until ClickHouse is reachable and the local projection has loaded.
- `GET /metrics`: includes `instantml_control_projection_loaded` and `instantml_control_refresh_degraded` gauges.
- `GET /openapi.json`

Implemented compatibility routes cover bootstrap users/orgs/API keys, API-key auth, hosted Clerk onboarding, local dev Google-style onboarding, Free/Pro/Premium plan selection, Stripe billing status/Checkout sync/Customer Portal/webhook endpoints under `/api/billing`, browser sessions, org seat list/reservation, token-backed organization invitations (`/api/orgs/:org_id/invitations`, resend/revoke, `/api/invitations/preview`, `/api/invitations/accept`), customer-owned ClickHouse setup (`GET /api/storage/clickhouse-connections/current`, `POST /api/storage/clickhouse-connections/validate`, `POST /api/storage/clickhouse-connections`, `POST /api/storage/clickhouse-connections/rotate-credentials`), invited-member activation, dashboard project preferences, saved workspace views, projects, runs, scalar metrics, typed attributes, rich logged objects, artifact metadata/upload/download, side-by-side comparison, bounded export, Neptune/W&B/MLflow imports, usage summaries/export with UTC calendar-month metric usage, retained ClickHouse storage bytes for dedicated tenant databases, BYOC storage warnings that count only InstantML-owned artifact bytes, billing/payment and blocked-at-limit write guardrails, API-key management, demo reset, and RFC 8628 device-code CLI login (`POST /api/auth/device-code/start`, `POST /api/auth/device-code/poll`, `POST /api/auth/device-code/confirm`). List endpoints are bounded; raw metric history is fetched through separate series endpoints.

Run-summary pages default to 100 rows and are capped at 1,000 rows. Bulk UI
selection should use `GET /api/runs/summary?projection=selection`, which skips
ClickHouse metric aggregate hydration and returns only run display metadata plus
frontend-compatible empty summary fields. Batched metric-series reads accept up
to 2,000 run IDs, but the server clamps `effective_limit` so a single response
cannot exceed 120,000 metric points.

Device-code grant: `start` returns a `device_code` and `user_code`; `poll` is called every 5 s by the SDK until `authorized`, `denied`, or `expired`; `confirm` requires a browser session and mints a scoped API key (`sdk:ingest` + `export:read`) whose plaintext is returned exactly once on the first authorized poll then cleared. Codes are stored in-memory with a 15-minute TTL and evicted lazily.

The durable route reference lives in `docs/architecture/current-api.md`, and
the durable control/data-plane schema reference lives in
`docs/architecture/current-schemas.md`. Keep those documents, this README,
`src/http/mod.rs`, `src/http/handlers.rs`, `src/domain.rs`,
`src/control_store.rs`, `src/metric_store.rs`, and `clickhouse/0001_initial.sql`
synchronized whenever an endpoint, request body, query parameter, response
envelope, auth rule, limit, table, record kind, or payload field changes. The
live service's `GET /openapi.json` returns a compact role-aware route index and
includes `x-instantml-service-plane` for operator verification.

In `INSTANTML_AUTH_MODE=api-key`, tenant context comes from the bearer API key. Project-scoped keys can access only their project; org-wide usage, demo reset, seat administration, and API-key administration require unrestricted org-scoped keys, an owner/admin browser session, or the bootstrap token depending on route class. Run/metric/attribute mutations require `sdk:ingest`, artifact metadata/upload routes require `artifacts:write`, imports require `imports:write`, usage requires `usage:read`, and key administration requires `api_keys:write` or an owner/admin session.

Dashboard preference and workspace-view routes are browser-session control
state. Hosted SDK/API keys cannot read or mutate them; owner/admin/member
browser sessions may save views, viewers may read preferences/views, and shared
demo sessions remain read-only. Local compatibility mode keeps the same route
shapes without requiring a hosted browser session.

Console logs are stored in tenant ClickHouse through `console_log_lines`.
`POST /api/runs/:run_id/logs` requires `sdk:ingest`, accepts client-supplied
stdout/stderr line batches of up to 50 lines with idempotency keys, and
`GET /api/runs/:run_id/logs` returns one bounded run/stream page at a time for
the frontend terminal.

## Testing

Rust unit tests:

```bash
npm run rust:test
```

Rust static verification:

```bash
npm run rust:fmt:check
npm run rust:lint
npm run rust:verify
```

Run shared smokes against Rust:

```bash
npm run test:contract
npm run test:ui
npm run test:contract:direct
npm run test:ui:direct
npm run test:rust:contract
npm run test:rust:sdk
npm run test:rust:ui
npm run test:hosted-clickhouse
```

These commands start disposable ClickHouse and the Rust server automatically. `test:rust:contract` and `test:contract:direct` run the shared black-box API contract in API-key mode. `test:rust:sdk` creates a disposable local signup/API key and drives the Python SDK against Rust local mode. `test:rust:ui` and `test:ui:direct` build the Next app and run the default Playwright smoke with Rust as `INSTANTML_API_BASE`, including landing, local auth, plan selection, onboarding, topbar/Settings usage/seats, API-key management, initial dashboard load, and fetch-gating checks. Set `INSTANTML_UI_SMOKE_FULL_WORKSPACE=1` for the longer workspace interaction regression. `test:hosted-clickhouse` exercises hosted-shaped routing end to end with separate local `control` and `data` Rust processes: local sign-up writes User Data control records, selected plan metadata and tenant route requested/applied warehouse profiles are preserved, invited teammates can activate into the same org, API-key creation writes User Data records, role-specific route tables are enforced, data-plane auth refreshes control records, direct and Python SDK ingestion write to the tenant database, safe provisioning payloads omit tenant secrets, and dashboard summary reads survive a data-plane API restart. Use `npm run test:contract:node` only for deprecated Node route-shape compatibility checks.

Large-run benchmark:

```bash
INSTANTML_BENCH_RUNS=100000 INSTANTML_BENCH_LONG_RUN_STEPS=20000 INSTANTML_BENCH_SAMPLES=10 INSTANTML_BENCH_WARMUPS=2 INSTANTML_BENCH_WEB=1 npm run benchmark:large-runs
```

The large-run and rich-object benchmarks seed disposable ClickHouse operational records and metric rows directly, then start the Rust API and measure bounded summary/search/sort/chart/object endpoints. The large-run benchmark uses 100,000 run records by default and gives the newest run 20,000 steps across several metric keys so chart reads exercise the same bounded dashboard path without forcing a multi-billion-row write in normal verification.

Hosted demo seed/benchmark:

```bash
INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1 npm run benchmark:hosted-demo
```

This command reads the local `.env`, signs in as `hello@instantml.ai`, creates or reuses the `InstantML Demo` cloud-service tenant route, seeds the hosted 100,000-run benchmark only when that project is absent, restarts its temporary Rust API for tenant replay, and prints hosted ClickHouse latency timings. The explicit `INSTANTML_HOSTED_DEMO_ALLOW_PROVISION=1` guard is required because the command can create/use paid ClickHouse Cloud services; do not run it from CI or against an account where that would be surprising.

The hosted benchmark now validates and times the dashboard's critical 100,000-run query shapes: newest run pages, larger pages, name/tag/config/notes search, failed/running/finished filters, combined search+filter, selected-metric sort, project overview, and a bounded chart series. Set `INSTANTML_HOSTED_DEMO_RESULT_PATH=/tmp/instantml-hosted-benchmark.json` to save the sanitized JSON result, and `INSTANTML_HOSTED_DEMO_ENFORCE=1` to fail if hosted p95 budgets are missed.

Cloud Run API benchmark:

```bash
INSTANTML_API_KEY=instantml_... npm run benchmark:cloud-run
```

Use this after `seed:hosted-scale` has created the large tenant dataset. It
measures the deployed Cloud Run data service or HTTPS router with bearer auth,
so the measured path is client -> Cloud Run -> ClickHouse Cloud. It covers org
and project run summaries, searches, status filters, metric sort, overview,
single-run chart series, selection-projection pages, and batched selected-run
series calls against the 100,000+ run hosted-scale projects. The default
workload now mirrors the dashboard's high-load behavior: the 100-run fresh
selection, a 1,000-run `seed-13` search selection, and the 2,000-run max
selection with adaptive metric-series point limits. Set
`INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH=/tmp/instantml-cloud-run-benchmark.json`
to save sanitized JSON output.

In `cloud-service` hosted mode the Rust server migrates only the User Data control table at startup. Tenant metric/object tables are created in each org's routed ClickHouse service, not in the User Data database.

Hosted tenant warehouse wakeups are reported as `503` errors with the stable
JSON code `warehouse_unavailable`. Public error text stays sanitized, but the
code lets the frontend show "Starting data warehouse" and retry instead of
presenting the condition as a generic API outage.

## Coverage Expectations

Rust first-party service logic targets 100% meaningful coverage for validation, storage orchestration, idempotency handling, auth decisions, artifact byte handling, and API compatibility. Contract, SDK, UI, and benchmark smokes are part of the required verification because the current ClickHouse-only operational index is a storage-layer change with broad route impact.

Agent/contributor guidance lives in `CLAUDE.md`. Production Rust code should propagate `AppResult` instead of panicking, keep 5xx response details out of public JSON, avoid silent storage fallbacks, and preserve deterministic full User Data replay until a durable monotonic control cursor is designed.

Coverage exception (shared-cell isolation):
- Uncovered area: ClickHouse row-level security and EXPLAIN-plan org_id predicate verification for the shared cell.
- Reason: ClickHouse does not expose EXPLAIN output in a test-friendly way in the current harness.
- Risk: a future metric read helper written without an org_id predicate would silently cross tenant boundaries in the shared cell. The cross-org isolation test (`shared_cell_cross_org_isolation_in_process_index`) covers the in-process index layer but not the ClickHouse query layer.
- Follow-up: add ClickHouse row policies or an EXPLAIN-plan test gate before raising the shared cell to production scale.
- Owner/date: hosted backend owner, 2026-05-16.

Coverage exception (multi-writer):
- Uncovered area: live multi-writer freshness, write uniqueness, public cell routing/SDK redirects, and atomic metric/log idempotency.
- Reason: the accepted multi-instance slice adds deterministic full operational replay, tenant-scoped replay validation, role-specific control/data HTTP surfaces, and data-plane control-record refresh before auth. It still does not enable shared cells with multiple concurrent writers.
- Risk: multiple Rust data-plane writers pointed at the same tenant operational table can still create duplicate low-volume entities or duplicate metric/log rows if scaled outside the accepted gates.
- Follow-up: add a stable operational event id or per-org sequence, close the mutation matrix gates, and run two-instance ClickHouse-backed integration tests before enabling shared cells.
- Owner/date: hosted backend owner, 2026-05-16.

## Key Files

- `Cargo.toml`: Rust dependencies and binary target.
- `src/main.rs`: CLI subcommands and server startup.
- `src/config.rs`: environment config and local defaults.
- `src/control_store.rs`: User Data ClickHouse control-plane table and replay helpers for hosted mode.
- `src/http/mod.rs`: HTTP app state, route table, and middleware wiring.
- `src/http/observability.rs`: structured request logging, header normalization, sanitized error/workflow outcome helpers, and observability unit tests.
- `src/http/handlers.rs`: route handlers, auth context resolution, request parsing, cookies, and response shapes.
- `src/store/mod.rs`: ClickHouse-backed operational index core, deterministic replay helpers, tenant replay validation, and module re-exports.
- `src/store/auth.rs`: users, organizations, sessions, API keys, and admin authorization helpers.
- `src/store/console_logs.rs`: stdout/stderr validation, idempotent writes, cursor encoding, and read response shaping.
- `src/store/runs.rs`: projects, runs, run filtering/summaries, scalar metric writes, and metric read endpoints.
- `src/store/objects.rs`: typed attributes, rich objects, table rows, artifacts, and artifact metadata writes after local/R2 byte preflight.
- `src/store/imports.rs`: Neptune, W&B, and MLflow import normalization and import records.
- `src/store/export.rs`: side-by-side comparison and bounded JSON export.
- `src/store/usage.rs`: usage summaries, UTC calendar-month metric periods, daily snapshots, and worker cleanup helpers.
- `src/store/demo.rs`: demo project reset and synthetic data generation.
- `src/store/access.rs`: shared project/run/session access checks and auth-adjacent row helpers.
- `src/store/summaries.rs`: run summaries, artifact counts, metric-series conversion, and export metric reads.
- `src/store/tenants.rs`: hosted tenant route records, database/cloud provisioners, lazy tenant store loading, and tenant MetricStore selection.
- `src/store/workspace_views.rs`: control-plane dashboard project preferences and saved workspace-view records.
- `src/store/validation.rs`: shared store validation, JSON value shaping, slugging, and unit tests for pure store logic.
- `src/metric_store.rs`: ClickHouse schema migration, operational record append/load helpers, metric point writes, and metric-series reads.
- `src/domain.rs`: DTOs and validation helpers.
- `src/artifact_store.rs`: local staged artifact byte storage, Cloudflare R2 bucket/object access, opaque public artifact references, and root-confined local reads.
- `src/managed_auth.rs`: Clerk session-token verification and provider-neutral managed-auth principal shaping.
- `clickhouse/0001_initial.sql`: operational record log, metric points, console log lines, metric series, and materialized view schema.

## Design Docs

- `docs/design/2026-05-14-clickhouse-only-storage.md`
- `docs/design/2026-05-14-hosted-clickhouse-routing.md`
- `docs/design/2026-05-14-pluto-style-frontend-workspace.md`
- `docs/design/2026-05-14-hosted-clickhouse-query-benchmarks.md`
- `docs/design/2026-05-10-run-tags-notes-editing.md`
- `docs/design/2026-05-11-large-run-query-performance.md`
- `docs/design/2026-05-11-landing-auth-onboarding.md`
- `docs/design/2026-05-16-clerk-hosted-auth.md`
- `docs/design/2026-05-16-auto-personal-workspace.md`
- `docs/design/2026-05-16-device-code-cli-login.md`
- `docs/design/2026-05-16-gcp-cloud-run-rust-api.md`
- `docs/design/2026-05-16-multi-instance-control-data-plane.md`
- `docs/design/2026-05-16-pricing-signup-org-admin.md`
- `docs/design/2026-05-16-shared-cell-tenant-routing.md`
- `docs/design/2026-05-17-dashboard-reliability-control-views.md`
- `docs/architecture/current-api.md`
- `docs/product/pricing-and-margins.md`
- `docs/design/2026-05-19-utoipa-migration.md`
- `docs/design/2026-05-21-rust-server-observability.md`

## Adding a new endpoint (utoipa + codegen pipeline)

The OpenAPI spec is generated from the Rust handlers themselves via
[`utoipa`](https://docs.rs/utoipa). To add an endpoint:

1. Add (or reuse) the request/response Rust structs in `src/domain.rs`. Add
   `#[derive(..., utoipa::ToSchema)]`. For fields typed `serde_json::Value`,
   annotate `#[schema(value_type = Object)]` (or `Option<Object>`).

2. Add the handler in `src/http/handlers.rs` and annotate it:

   ```rust
   #[utoipa::path(
       post,
       path = "/runs",
       tag = "runs",
       request_body = crate::domain::CreateRunRequest,
       security(("bearerApiKey" = []), ("browserSession" = [])),
       responses(
           (status = 200, description = "Created run", body = super::openapi::RunEnvelope),
           (status = 400, description = "Validation error", body = super::openapi::ErrorResponse),
       ),
   )]
   pub(super) async fn create_run(...) -> AppResult<Json<Value>> { ... }
   ```

3. Register the handler in `crate::http::openapi::ApiDoc#[openapi(paths(...))]`
   and add any new envelope/schema structs to `components(schemas(...))`.

4. Add the new path string to the
   `utoipa_apidoc_emits_annotated_paths_and_schemas` test so the schema
   contract is exercised in CI.

5. Regenerate TypeScript bindings:

   ```bash
   npm run codegen:api
   ```

   This runs `cargo run -- emit-openapi`, writes
   `apps/rust-server/openapi.generated.json`, and emits
   `apps/web/src/types/api.generated.ts`. Commit both.

6. (Optional but encouraged) Migrate the corresponding frontend type to the
   generated definition:

   ```ts
   import type { components } from "../../src/types/api.generated";
   type RunRow = components["schemas"]["RunRow"];
   ```

CI should run `npm run verify:api-types`, which re-runs the codegen and
fails if the generated files differ from the committed copies. See
`docs/design/2026-05-19-utoipa-migration.md` for the rollout plan and the
list of handlers still on the legacy hand-rolled spec path.

## Notes For Future Agents

- Rust is the default backend; preserve documented route shapes and run `npm run test:contract` after behavior changes.
- Keep `npm run test:contract:node` available when a change might break legacy Node compatibility or future JSON migration assumptions.
- Keep scalar metric summaries maintained by ClickHouse materialized views; summary/list endpoints must not scan raw metric history.
- Keep run list endpoints cursor/page bounded.
- Keep compatibility org context explicit: API-key mode uses the key org, local mode uses the fixed local org.
- Keep project-scoped API keys flowing through project-aware helpers before returning run-derived data.
- Keep bounded JSON export caps explicit until streaming export has its own design.
- Artifact byte writes should validate the decoded byte size and plan capacity before local/R2 writes, then stage/finalize or upload, commit metadata, and clean up temp/finalized bytes on finalize or storage errors. Crash-only orphan cleanup/retention remains operational hardening work.
