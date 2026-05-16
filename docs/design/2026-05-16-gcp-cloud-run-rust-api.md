# Design: GCP Cloud Run Rust API Deployment

Date: 2026-05-16

Status: Accepted for internal single-instance first slice

Owner: Codex

## Summary

InstantML needs a first hosted Rust API deployment so local development can run only the frontend while the API, control data, and tenant data live in cloud services. The smallest useful version deploys the existing Rust container to Google Cloud Run, stores runtime secrets in Secret Manager, builds and stores images in Artifact Registry through Cloud Build, and points the local Next app at the Cloud Run service URL through `INSTANTML_API_BASE`.

The hosted API connects to the existing live ClickHouse Cloud User Data service and provisions tenant ClickHouse Cloud warehouses through the already accepted hosted ClickHouse routing path. Because the Rust operational index remains documented as single-process safe, this deployment must pin Cloud Run to one instance until a reconciliation or direct-query hosted coordination design is accepted.

ClickHouse Cloud access should be restricted to a static Cloud Run egress IP where possible. The deployment creates a regional VPC/subnet, static external address, Cloud Router, and Cloud NAT, then deploys Cloud Run with Direct VPC egress for all outbound traffic so ClickHouse Cloud can allowlist the static NAT address instead of opening the service or Cloud API key to the internet.

This first hosted release is internal-only. Public signup must be restricted by explicit email/domain allowlists so a public Cloud Run URL cannot create arbitrary paid ClickHouse Cloud warehouses. Tenant passwords may still be stored in User Data only under the accepted early-hosted secret-storage guard; that remains a blocker for public launch, not a permanent production posture.

## Goals

- Deploy the existing Rust API container to Cloud Run as a single-instance service.
- Use Artifact Registry and Cloud Build so local Docker is not required.
- Store ClickHouse, Clerk, and bootstrap secrets in Secret Manager.
- Connect the service to the live ClickHouse Cloud User Data endpoint and cloud-service tenant provisioner.
- Give Cloud Run a static outbound IP for ClickHouse Cloud allowlisting.
- Keep the local frontend workflow simple: after deploy, start Next with `npm run web:dev`.
- Add a repeatable deployment script for future releases.
- Restrict hosted signups and hosted artifact byte uploads until their durable production controls exist.

## Non-Goals

- Do not scale the Rust API above one instance in this slice.
- Do not redesign the ClickHouse operational index or add multi-process reconciliation.
- Do not replace local artifact storage with a full object-store backend.
- Do not deploy the Next frontend to GCP in this slice.
- Do not introduce Terraform before the first working hosted loop exists.
- Do not remove Docker Compose local development.
- Do not claim the Cloud Run service is public-launch ready.

## Users and Use Cases

Developer local workflow:

1. The Rust API runs on Cloud Run.
2. The API reads and writes live ClickHouse Cloud state.
3. The developer starts only the local Next frontend. The deploy helper writes the Cloud Run URL into `apps/web/.env.local` as `INSTANTML_API_BASE` and `INSTANTML_API_ALLOWED_ORIGINS`.
4. Browser users authenticate through Clerk when configured.
5. SDK users send API-key traffic to the same hosted API.

Operator release workflow:

1. Run a single deploy helper from the repo root.
2. The helper enables required Google APIs, ensures Artifact Registry, syncs selected local environment secrets to Secret Manager, builds the image through Cloud Build, deploys a single-instance Cloud Run revision, and prints the Cloud Run URL plus static egress IP.
3. The operator verifies `/health`, `/readyz`, and an API smoke against the hosted service.

## Proposed Design

### Cloud Resources

Use these defaults unless overridden:

- Project: `GCP_PROJECT` or the active `gcloud` project.
- Region: `us-central1`.
- Artifact Registry repository: `instantml`.
- Cloud Run service: `instantml-rust-api`.
- Runtime service account: `instantml-rust-api@PROJECT.iam.gserviceaccount.com`.
- VPC network: `instantml-cloud-run`.
- Subnet: `instantml-cloud-run-us-central1`.
- Static egress address: `instantml-cloud-run-egress-us-central1`.
- Cloud Router: `instantml-cloud-run-router-us-central1`.
- Cloud NAT: `instantml-cloud-run-nat-us-central1`.

The Cloud Run service uses:

- `--port 8000`
- `--max-instances 1`
- `--concurrency 20`
- `--timeout 900`
- `--ingress all`
- `--allow-unauthenticated`
- Direct VPC egress with `--network`, `--subnet`, and `--vpc-egress=all-traffic`

`--allow-unauthenticated` is required for browser and SDK access until a separate API gateway or custom-domain auth layer is designed. Product access still depends on InstantML sessions and API keys.

The first slice uses a lower concurrency than Cloud Run's broad default because tenant provisioning can be slow and the operational cache is still single-process. Raise concurrency only after hosted SDK and dashboard smoke evidence shows no store-lock pressure.

### Public Exposure And Bootstrap Controls

Bootstrap routes must stay disabled by default in hosted Cloud Run. If `INSTANTML_BOOTSTRAP_TOKEN` is not set, bootstrap-only routes return `401` in `api-key` mode. Operators may configure a generated bootstrap token for a one-off smoke or break-glass task, but the token must live in Secret Manager, must not be printed by scripts, and should be rotated or removed after use.

Cloud Run public ingress is acceptable only with these app-level controls enabled:

- `INSTANTML_AUTH_MODE=api-key`
- `INSTANTML_DEV_AUTH_ENABLED=false`
- `INSTANTML_MANAGED_CLERK_ENABLED=true` only when `CLERK_SECRET_KEY` is present
- `INSTANTML_SIGNUP_ALLOWED_EMAILS` or `INSTANTML_SIGNUP_ALLOWED_DOMAINS` set for hosted signup
- `INSTANTML_ARTIFACT_UPLOADS_ENABLED=false` until object storage lands

### Hosted Signup Guardrails

The Rust API rejects Clerk signup requests when signup allowlists are configured and the verified Clerk email is outside the allowed exact emails or domains. Sign-in for already-created memberships remains allowed. The deploy helper defaults `INSTANTML_SIGNUP_ALLOWED_EMAILS` to the active `gcloud` account when the operator has not set a broader allowlist.

Before public signup, a separate design must add at least invite/domain policy, budget alerts, provisioning quotas, abuse/rate limiting, and a durable tenant-secret design.

### Secret Manager

The deploy helper syncs these secrets when local values are present:

- `CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT`
- `CLICKHOUSE_INSTANTML_USER_DATA_USERNAME`
- `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD`
- `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID`
- `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET`
- `CLERK_SECRET_KEY`
- `INSTANTML_BOOTSTRAP_TOKEN` only when the operator explicitly provides one

The helper does not print secret values. It creates missing secrets and adds a new secret version when values change locally. The Cloud Run runtime service account receives `roles/secretmanager.secretAccessor` only on the managed secrets.

Non-secret Cloud Run environment variables:

- `INSTANTML_BIND_ADDR=0.0.0.0:8000`
- `INSTANTML_AUTH_MODE=api-key`
- `INSTANTML_LOG_FORMAT=json`
- `INSTANTML_HOSTED_CLICKHOUSE_ENABLED=true`
- `INSTANTML_CLICKHOUSE_PROVISIONER=cloud-service`
- `INSTANTML_CLICKHOUSE_CLOUD_PROVIDER=gcp`
- `INSTANTML_CLICKHOUSE_CLOUD_REGION=us-central1`
- `INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB=12`
- `INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB=12`
- `INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS=1`
- `INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS=true`
- `INSTANTML_MANAGED_CLERK_ENABLED=true` when `CLERK_SECRET_KEY` is present
- `INSTANTML_ALLOWED_FRONTEND_ORIGINS` from local/operator config
- `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST=<static-egress-ip>/32` when static egress is configured
- `INSTANTML_SIGNUP_ALLOWED_EMAILS=<operator email>` by default unless explicitly overridden
- `INSTANTML_ARTIFACT_UPLOADS_ENABLED=false`

### Build Context Safety

Cloud Build uploads the repo root as build context, so the helper must fail unless `.dockerignore` excludes `.env`, `.git`, `.instantml`, `node_modules`, and Rust build output. This prevents local secrets, generated ClickHouse data, artifact bytes, and build products from being sent to Cloud Build.

### ClickHouse Cloud Access

The deploy helper prints the static egress IP and can optionally call ClickHouse Cloud's API when `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID` and `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET` are present. The production target is:

- Existing User Data service allows the static egress IP.
- ClickHouse Cloud API keys used by the Rust API allow the static egress IP.
- New tenant services are created with the same static egress IP through `INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST`.
- Temporary `0.0.0.0/0` access is acceptable only with an explicit operator override such as `INSTANTML_ALLOW_OPEN_CLICKHOUSE_ACCESS=1`; normal deploys must print whether any targeted service or API key still has open access.

The UI path remains available for manual ClickHouse Cloud allowlist edits if the API shape changes or a service-specific update endpoint is unavailable.

### Deployment Script

Add `tools/deploy-cloud-run.mjs` and `npm run deploy:cloud-run`.

The script should:

1. Load `.env` without printing values; process environment overrides file values.
2. Resolve GCP project, region, service name, and image tag.
3. Enable required services.
4. Ensure Artifact Registry repository.
5. Ensure runtime service account.
6. Ensure static egress network resources unless disabled with `INSTANTML_CLOUD_RUN_STATIC_EGRESS=0`.
7. Sync selected secrets to Secret Manager.
8. Add the static egress IP to all ClickHouse Cloud services and Cloud API keys in the organization unless disabled with explicit operator env vars.
9. Build the image with Cloud Build using the existing root `Dockerfile`.
10. Deploy Cloud Run with explicit env vars and secret env mappings.
11. Verify max instances, dev auth, auth config, `/health`, and `/readyz`.
12. Write the Cloud Run URL to `.env` and `apps/web/.env.local` for local frontend use.
13. Print service URL, image URL, service account, and static egress IP.

The helper should be idempotent enough for normal releases: re-running creates a new image tag and Cloud Run revision without deleting existing services, networks, routers, NATs, repositories, or secrets.

## Component Impact

Backend:

- No REST contract changes.
- Runtime config is exercised in Cloud Run with hosted ClickHouse and Clerk enabled.

Frontend:

- No frontend code change is required.
- Local frontend runs against the hosted API through the deploy-written `apps/web/.env.local` values for `INSTANTML_API_BASE` and `INSTANTML_API_ALLOWED_ORIGINS`.

Python SDK:

- No SDK API change.
- SDK traffic points at the Cloud Run URL with normal InstantML API keys.

Storage:

- Existing live ClickHouse Cloud User Data endpoint is the control plane.
- New signed-up organizations use ClickHouse Cloud tenant services.
- Artifact bytes remain local-to-container and therefore ephemeral until object storage is designed.
- Hosted artifact byte uploads are rejected by config until object storage is designed; metadata-only artifact records for external/imported URIs remain supported.

Docs:

- Update root, Rust server, web, and tools docs with the hosted deployment workflow.
- Add this design to `docs/design/README.md`.

## Data Model

No new product data model is introduced. Cloud resource names and secret names become operational conventions documented in this design and the deploy helper.

## API Contracts

No public API shape changes.

Operational health checks used after deploy:

- `GET /health`
- `GET /readyz`
- `GET /api/auth/config`

## Performance Considerations

- Cloud Run starts with one instance because the in-process operational index is not yet multi-process safe.
- Cloud Run concurrency starts at `20` to preserve request throughput inside one process while avoiding multiple independent operational caches and excessive slow signup/provisioning pressure.
- Startup applies or verifies ClickHouse schemas. Cloud-service tenant schema migration happens when a tenant route is provisioned or loaded.
- The first hosted smoke should validate readiness and a narrow API path rather than seeding a large benchmark every deploy.

## Simplicity Review

This is the smallest production-shaped deployment because it uses the existing Dockerfile, Rust server, ClickHouse Cloud credentials, Clerk path, and ClickHouse tenant provisioner. It adds one deployment helper and operational docs instead of introducing Terraform, Kubernetes, a separate gateway, or a new artifact store.

Deferred complexity:

- Multi-instance Cloud Run.
- Secret-manager-backed tenant password references inside User Data.
- GCS/R2 artifact bytes.
- Terraform or Pulumi infrastructure ownership.
- Custom domain, CDN, and hosted frontend deployment.
- Background tenant provisioning jobs.

## Failure Modes

- Missing `gcloud` auth or project: deploy helper stops before changing cloud resources.
- Missing ClickHouse secrets: helper stops before deploy.
- Missing Clerk secret: Cloud Run can deploy without managed Clerk, but hosted signup/sign-in are disabled and local frontend auth is not considered fully working.
- Static egress setup failure: helper stops unless static egress is explicitly disabled and the operator accepts manual ClickHouse allowlisting.
- ClickHouse Cloud allowlist does not include Cloud Run egress IP: `/readyz` or tenant routes fail to connect; operator must update allowlist and redeploy or retry.
- ClickHouse Cloud API-key allowlist does not include Cloud Run egress IP: new tenant-service creation fails from Cloud Run even though service query traffic may work; operator must update the key allowlist and redeploy or retry.
- Cloud Run cold starts: service may take longer while establishing Direct VPC egress and checking ClickHouse.
- Container-local artifacts are ephemeral: hosted byte uploads stay disabled until object storage lands.
- Multi-instance override: two API instances can serve stale operational state; keep `--max-instances 1`.
- Public signup abuse: signup allowlists are required for this internal slice; public-launch signup needs quotas, budget alerts, and abuse controls.

## Testing Plan

- `npm run rust:fmt`
- `npm run rust:lint`
- `npm run rust:test`
- `npm run test:hosted-clickhouse`
- `npm run web:build`
- Deploy with `npm run deploy:cloud-run`.
- Verify `GET /health`, `GET /readyz`, and `GET /api/auth/config` against the Cloud Run URL.
- Verify Cloud Run `maxScale` is `1`.
- Verify `dev_auth_enabled=false`.
- Verify the deploy helper writes `apps/web/.env.local` so `npm run web:dev` points at the hosted API without a local Rust server.
- Verify `INSTANTML_SIGNUP_ALLOWED_EMAILS` or `INSTANTML_SIGNUP_ALLOWED_DOMAINS` is set.
- Verify hosted artifact byte upload returns a clear forbidden response until object storage lands.
- Verify ClickHouse Cloud service and API-key access lists include the static egress IP and do not contain `0.0.0.0/0` unless an explicit temporary override was used.
- Run a narrow hosted API smoke with `INSTANTML_CONTRACT_BASE_URL=<cloud-run-url>` and `INSTANTML_CONTRACT_BOOTSTRAP_TOKEN` when a bootstrap token is configured.

## Documentation Plan

- `README.md`
- `apps/rust-server/README.md`
- `apps/web/README.md`
- `tools/README.md`
- `.env.example`
- `docs/design/README.md`

## Alternatives Considered

- Cloud Run Docker Compose: useful for quick experiments, but Google documents limitations and recommends stronger IaC for production. The first release path should be explicit `gcloud` commands.
- GKE: unnecessary operational load for a single Rust API process.
- Local Docker build/push: blocked on machines without Docker and less repeatable than Cloud Build.
- Opening ClickHouse Cloud to `0.0.0.0/0`: simpler, but less secure and can wake idle ClickHouse services unexpectedly.
- Deploying Next too: useful later, but the current user goal is hosted Rust API with local-only frontend.

## Review Notes

Fresh reviewer 1:

- Finding: Cloud-service tenant provisioning plus stored tenant passwords crosses from first hosted loop into early production risk.
- Risk: Public traffic could create paid services and store tenant credentials in User Data without the future secret-manager design.
- Recommended edit: Mark the deployment internal-only, require signup allowlists, and document the stored-password guard as a public-launch blocker.
- Decision: Accepted; signup allowlist and internal-only language were added.

Fresh reviewer 2:

- Finding: The draft under-specified cost/security guardrails, Cloud Build context leaks, and hosted validation.
- Risk: `.env` or generated state could be uploaded, open ClickHouse access could persist, and a public Cloud Run URL could create warehouses.
- Recommended edit: Require `.dockerignore` preflight, postdeploy assertions, static egress allowlisting, and explicit signup/cost controls.
- Decision: Accepted; build-context, allowlist, artifact, and postdeploy validation requirements were added.

## Coverage Exceptions

- Uncovered area: automated browser-authenticated hosted frontend smoke against the live Cloud Run service.
- Reason: this first deployment depends on live Clerk credentials and account state; local UI smoke already covers the route behavior with disposable infrastructure.
- Risk: a Clerk domain/origin mismatch can still require manual provider-console adjustment.
- Follow-up: add a hosted staging smoke after custom domain and frontend hosting are designed.
- Owner/date: future hosted platform owner, 2026-05-16.

## Decision

Accepted for the internal single-instance first slice after review revisions. Public launch remains blocked on tenant secret storage, object storage, signup abuse controls, budget/quota controls, and multi-process operational-state reconciliation.
