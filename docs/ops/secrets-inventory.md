# Secrets inventory — InstantML monorepo

A snapshot of every secret and non-secret env var the deployed services need,
plus the mapping to Google Secret Manager (the new source of truth). This is
a reference; the operational pattern lives in [`docs/ops/secrets.md`](secrets.md).

Captured: 2026-05-24. Refresh by re-running `gcloud secrets list` and the
service-describe commands at the bottom of this page.

## Categorization rules

- **Secret**: leaking the value would compromise a production system or a
  third-party account (API keys, passwords, tokens, signing keys).
- **Non-secret**: a value that is either public (browser-visible URLs, the
  Clerk publishable key) or trivially recoverable from a console (a bucket
  name, a region, a feature flag). These live in `.env.example` with real
  defaults and may be committed.
- The Clerk publishable key (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) is
  classified as **non-secret** by Clerk's own threat model, but we still
  store it in Secret Manager because (a) it must stay in lock-step with
  `CLERK_SECRET_KEY` — drift between the two is the bug that motivated
  this work — and (b) keeping it next to its paired secret is the simplest
  way to keep them coherent.

## Secrets (Secret Manager is source of truth)

| Env var | Secret Manager name | Services that need it | Rotation |
| --- | --- | --- | --- |
| `CLERK_SECRET_KEY` | `instantml-clerk-secret-key` | `instantml-control`; `instantml-data-us-central1-a` only when `INSTANTML_MCP_OAUTH_ENABLED=1` | quarterly + on personnel change |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `instantml-clerk-publishable-key` | (build-time for `apps/web`; deploy-time validator) | rotate together with `CLERK_SECRET_KEY` |
| `DATABASE_URL` | `instantml-control-database-url` | `instantml-control`, `instantml-data-us-central1-a` | quarterly; **immediate on incident or personnel change** |
| `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID` | `instantml-clickhouse-cloud-key-id` | `instantml-control`, `instantml-data-us-central1-a` | quarterly |
| `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET` | `instantml-clickhouse-cloud-key-secret` | `instantml-control`, `instantml-data-us-central1-a` | quarterly + on personnel change |
| `INSTANTML_BOOTSTRAP_TOKEN` | `instantml-bootstrap-token` | `instantml-control` (admin bootstrap endpoint) | rotate on use; long-lived disabled |
| `CLOUDFLARE_R2_API_KEY` | `instantml-cloudflare-r2-api-key` | `instantml-data-us-central1-a` | quarterly |
| `CLOUDFLARE_API_TOKEN` | `instantml-cloudflare-api-token` | `instantml-data-us-central1-a` (optional; only when separate from R2 key) | quarterly |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | `instantml-cloudflare-r2-access-key-id` | `instantml-data-us-central1-a` (optional; S3 creds when not derived) | quarterly |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | `instantml-cloudflare-r2-secret-access-key` | `instantml-data-us-central1-a` (optional; S3 creds when not derived) | quarterly |
| `STRIPE_SECRET_KEY` | `instantml-stripe-secret-key` | `instantml-control` (billing) | quarterly + on personnel change |
| `STRIPE_WEBHOOK_SECRET` | `instantml-stripe-webhook-secret` | `instantml-control` (webhook signature verify) | rotate on Stripe endpoint rotation |
| `RESEND_API_KEY` | `instantml-resend-api-key` | `instantml-control` (transactional email) | quarterly |

Staging mirrors of every secret above exist under the `instantml-staging-`
prefix; see `INSTANTML_CLOUD_RUN_SECRET_PREFIX` in `tools/deploy-cloud-run.mjs`.

## Non-secret env (lives in `.env.example`)

These are committed defaults. The hosted services also accept overrides via
Cloud Run env (set inline in the service spec, not in Secret Manager).

| Env var | Default | Purpose |
| --- | --- | --- |
| `INSTANTML_API_BASE` | `http://127.0.0.1:8000` | Local frontend -> Rust API target. |
| `INSTANTML_API_ALLOWED_ORIGINS` | unset | Frontend allow-list when API is hosted. |
| `NEXT_PUBLIC_INSTANTML_API_BASE` | `http://127.0.0.1:8000` | Browser-side API base. |
| `INSTANTML_LOG_FORMAT` | `pretty` (local), `json` (hosted) | Tracing layer format. |
| `RUST_LOG` | `instantml_rust_server=info,tower_http=info` | Tracing filter. |
| `INSTANTML_SLOW_REQUEST_MS` | `1000` | Slow-request log threshold. |
| `INSTANTML_BIND_ADDR` | `0.0.0.0:8000` (hosted) | Server listen address. |
| `INSTANTML_AUTH_MODE` | service-dependent | `clerk` for hosted, `dev` locally. |
| `INSTANTML_DEV_AUTH_ENABLED` | `false` | Bypass auth in dev only. |
| `INSTANTML_SERVICE_PLANE` | `control` or `data` | Per-service role. |
| `INSTANTML_HOSTED_CLICKHOUSE_ENABLED` | `false` (local) / `true` (hosted) | Toggle hosted CH routing. |
| `INSTANTML_CLICKHOUSE_PROVISIONER` | `database` | Tenant provisioning mode. Current hosted prod/staging use database-mode tenant routing on self-hosted GCP ClickHouse; `cloud-service` is legacy operator-only. |
| `INSTANTML_CLICKHOUSE_CLOUD_PROVIDER` | `aws` | CH Cloud provider. |
| `INSTANTML_CLICKHOUSE_CLOUD_REGION` | `us-east-1` | CH Cloud region. |
| `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST` | egress CIDRs | Cloud Run static-NAT IP allow-list. |
| `INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB` | `8` | CH replica sizing floor. |
| `INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB` | `8` | CH replica sizing ceiling. |
| `INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS` | `1` | CH replica count. |
| `INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS` | `600` | CH provisioning timeout. |
| `INSTANTML_CLICKHOUSE_CLOUD_ALLOW_PLAN_SIZING` | `false` | Gate plan-driven warehouse upsizing. |
| `INSTANTML_CLICKHOUSE_CLOUD_ORG_ID` | unset | Optional explicit CH org id. |
| `INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS` | `false` | Whether per-tenant CH passwords may live in user-data DB. |
| `INSTANTML_BYOC_EGRESS_CIDRS` | static egress | BYOC outbound allow-list shown to customers for GCP firewall/load-balancer rules. Must be set explicitly; legacy ClickHouse Cloud allowlist env is not a BYOC fallback. |
| `INSTANTML_BYOC_EGRESS_SET_VERSION` | deploy label | Version/label for the displayed BYOC static egress set. Hosted BYOC is disabled when CIDRs are unversioned. |
| `INSTANTML_BYOC_SECRET_BACKEND` | `gcp-secret-manager` | BYOC credential store choice. |
| `INSTANTML_BYOC_SECRET_PROJECT_ID` | current project | BYOC secret project. |
| `INSTANTML_BYOC_SECRET_PREFIX` | `<service>-byoc-clickhouse` | BYOC secret id prefix. |
| `INSTANTML_BYOC_ALLOW_PRIVATE_ENDPOINTS` | `false` | Whether tenants may register RFC1918 endpoints. |
| `INSTANTML_MANAGED_CLERK_ENABLED` | `true` (hosted) | Toggle Clerk path. |
| `INSTANTML_ALLOWED_FRONTEND_ORIGINS` | `127.0.0.1:3000,localhost:3000` | CORS allow-list. |
| `INSTANTML_FRONTEND_BASE_URL` | hosted URL | Used for redirect/canonical links. |
| `INSTANTML_MAX_BODY_BYTES` | server default | Body size cap. |
| `INSTANTML_MAX_UPLOAD_BODY_BYTES` | server default | Upload body size cap. |
| `INSTANTML_REQUEST_TIMEOUT_SECONDS` | server default | Per-request timeout. |
| `INSTANTML_ARTIFACT_BACKEND` | `local` (dev) / `r2` (hosted) | Artifact store backend. |
| `INSTANTML_ARTIFACT_UPLOADS_ENABLED` | `false` (dev) / `true` (hosted) | Toggle uploads. |
| `INSTANTML_ARTIFACT_ROOT` | `.instantml/rust-artifacts` | Local artifact dir. |
| `CLOUDFLARE_ACCOUNT_ID` | account id | Public Cloudflare account. |
| `CLOUDFLARE_R2_ACCOUNT_ID` | account id | Public R2 account. |
| `CLOUDFLARE_R2_BUCKET_PREFIX` | `instantml-org` | Bucket prefix. |
| `CLOUDFLARE_R2_ENDPOINT` | derived | Optional R2 S3 endpoint override. |
| `CLERK_API_BASE` | `https://api.clerk.com` | Clerk Backend API base URL. |
| `CLERK_JWT_ISSUER` | derived | Clerk issuer URL (validated against publishable key). |
| `CLICKHOUSE_CLOUD_ENDPOINT` | `https://api.clickhouse.cloud` | CH Cloud control-plane API base. |
| `INSTANTML_TENANT_CLICKHOUSE_URL` | unset | Optional explicit tenant CH override. |
| `INSTANTML_SHARED_CELL_URL` | unset | Shared-cell routing. |
| `STRIPE_API_VERSION` | pinned | Pinned API version string. |
| `STRIPE_PRO_PRICE_ID` / `INSTANTML_STRIPE_PRO_PRICE_ID` | price id | Public price id for the Pro plan. |
| `INSTANTML_BILLING_ENABLED` | derived (`true` when `STRIPE_SECRET_KEY` present) | Toggle billing. |
| `INSTANTML_BILLING_SUCCESS_URL` / `INSTANTML_BILLING_CANCEL_URL` | hosted URLs | Stripe Checkout return URLs. |
| `INSTANTML_BILLING_GRACE_DAYS` | server default | Grace period. |
| `INSTANTML_EMAIL_PROVIDER` | `resend` (hosted) | Email provider name. |
| `INSTANTML_EMAIL_FROM` | sender address | From: header. |
| `INSTANTML_EMAIL_REPLY_TO` | reply address | Reply-To header. |
| `INSTANTML_SUPPORT_EMAIL` | support address | Support contact. |
| `INSTANTML_CELL_ID` | service-specific | Data plane cell id. |
| `GCP_PROJECT`, `GCP_REGION`, `INSTANTML_CLOUD_RUN_SERVICE`, `INSTANTML_ARTIFACT_REPOSITORY`, `INSTANTML_LAST_WAREHOUSE_CLEANUP` | per environment | Deploy/cron metadata. |

## Source-of-truth comparison

`tools/deploy-cloud-run.mjs::deploySecretSpecs()` enumerates the env -> secret
mapping the deploy uses. Compared to what is actually live in Secret Manager
today (`gcloud secrets list`):

**Present in prod Secret Manager and bound by Cloud Run:**

- `instantml-clerk-secret-key` (control)
- `instantml-clickhouse-user-data-endpoint` (control, data)
- `instantml-clickhouse-user-data-username` (control, data)
- `instantml-clickhouse-user-data-password` (control, data)
- `instantml-clickhouse-cloud-key-id` (control, data)
- `instantml-clickhouse-cloud-key-secret` (control, data)
- `instantml-cloudflare-r2-api-key` (data)

**Present in prod Secret Manager but not bound to a service:**

- `instantml-stripe-secret-key` — billing was added in PR #85 but the secret
  is not yet wired into the running service revisions. This is the next
  redeploy's job; it will pick up automatically through
  `deploySecretSpecs()` because `STRIPE_SECRET_KEY` is in that list.
- `instantml-bootstrap-token` — present, listed in the deploy spec, but the
  current revisions of both prod services do not bind it. Picked up at the
  next deploy.

**Referenced by `deploySecretSpecs()` but not yet present in prod Secret Manager:**

- `instantml-cloudflare-api-token`
- `instantml-cloudflare-r2-access-key-id`
- `instantml-cloudflare-r2-secret-access-key`
- `instantml-stripe-webhook-secret`
- `instantml-clerk-publishable-key` (from `nonSecretValidationEnvSpecs()`)

These are all flagged `required: false` in the spec, so the deploy succeeds
without them. Several should be created and populated before the next deploy
to keep the GH-Actions deploy in PR #80 from silently degrading features
(signed webhooks, R2 S3 creds, and optional publishable-key validation).
Tracked in the PR description that introduced this doc, not fixed here.

Production invite email is no longer allowed to degrade silently: prod deploys
now fail unless `RESEND_API_KEY` is present, which means
`instantml-resend-api-key` must be created and populated before the next prod
deploy. The 2026-06-16 production invite failures came from the control service
running without this secret binding.

**Staging mirror coverage:** staging has the prod-aligned secret set plus
`instantml-staging-resend-api-key` and `instantml-staging-stripe-secret-key`.
Prod was missing the matching resend secret when this inventory was audited;
create `instantml-resend-api-key` before redeploying prod.

## How to refresh this page

```bash
# Names only — never read values.
gcloud secrets list --format='value(name)'

# Per-service env binding (control):
gcloud run services describe instantml-control \
  --region=us-central1 \
  --format=json \
  | jq '.spec.template.spec.containers[0].env'

# Same for instantml-data-us-central1-a.
```

Cross-check against `deploySecretSpecs()` and
`nonSecretValidationEnvSpecs()` in `tools/deploy-cloud-run.mjs`.
