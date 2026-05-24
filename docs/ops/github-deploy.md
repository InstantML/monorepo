# GitHub Actions Cloud Run deploy — operator setup

The `Deploy Cloud Run` workflow (`.github/workflows/deploy-cloud-run.yml`)
replaces the laptop-only `npm run deploy:cloud-run` path. Devs no longer need
the production `.env` to ship; deploys happen via the Actions UI (or a tag
push), gated on the `CI` workflow being green and on a GitHub Environment
review for `prod`.

This document is the one-time setup checklist an operator (today: Tony) has
to complete before the workflow becomes usable. It assumes the underlying
GCP project, Cloud Run services, Artifact Registry repo, and Secret Manager
secrets already exist — they do — and only documents the GitHub <-> GCP
trust plumbing and the GitHub-side configuration.

## Prerequisites

You need:

- Owner / IAM admin on the GCP project that hosts Cloud Run (the same one
  `gcloud config get-value project` resolves to today).
- Admin on the `InstantML/monorepo` GitHub repo (or organization-level
  ability to create `vars` and configure Environments).
- `gcloud` CLI authenticated as a principal that can create IAM resources.

Throughout this doc, substitute these placeholders for your project:

| Placeholder | Meaning |
| --- | --- |
| `<GCP_PROJECT>` | Project id, e.g. `instantml-prod`. |
| `<GCP_PROJECT_NUMBER>` | Numeric project number (`gcloud projects describe <GCP_PROJECT> --format='value(projectNumber)'`). |
| `<GCP_REGION>` | Region, today `us-central1`. |
| `<WIF_POOL>` | A pool id, e.g. `github`. |
| `<WIF_PROVIDER>` | A provider id inside the pool, e.g. `instantml-monorepo`. |
| `<DEPLOY_SA>` | Service account name, e.g. `gha-cloud-run-deployer`. |

## 1. Create a Workload Identity Pool and provider trusting this repo

Workload Identity Federation lets the runner exchange its GitHub OIDC token
for a short-lived GCP access token. We do not store a JSON key.

```bash
gcloud iam workload-identity-pools create "<WIF_POOL>" \
  --project="<GCP_PROJECT>" \
  --location="global" \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "<WIF_PROVIDER>" \
  --project="<GCP_PROJECT>" \
  --location="global" \
  --workload-identity-pool="<WIF_POOL>" \
  --display-name="InstantML monorepo" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name" \
  --attribute-condition="assertion.repository == 'InstantML/monorepo'"
```

The `attribute-condition` is load-bearing: it stops any other GitHub repo
(including a fork) from minting tokens against your project.

The provider resource name is:

```
projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL>/providers/<WIF_PROVIDER>
```

You will need that exact string for the `GCP_WIF_PROVIDER` repo variable below.

## 2. Create a deploy service account and grant Cloud Run / Secret Manager / Artifact Registry roles

```bash
gcloud iam service-accounts create "<DEPLOY_SA>" \
  --project="<GCP_PROJECT>" \
  --display-name="GitHub Actions Cloud Run deployer"

DEPLOY_SA_EMAIL="<DEPLOY_SA>@<GCP_PROJECT>.iam.gserviceaccount.com"

for role in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer \
  roles/secretmanager.admin \
  roles/iam.serviceAccountUser \
  roles/storage.admin \
  roles/compute.networkAdmin \
  roles/compute.loadBalancerAdmin \
  roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "<GCP_PROJECT>" \
    --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
    --role="${role}"
done
```

Notes on the role set:

- `run.admin` — `gcloud run services update` mutations.
- `cloudbuild.builds.editor` — submitting the Rust server image build.
- `artifactregistry.writer` — pushing the resulting image tag.
- `secretmanager.admin` — the deploy helper still creates per-org BYOC
  ClickHouse password secrets on demand and (re)binds the runtime service
  account to `roles/secretmanager.secretAccessor`. It does not need to read
  the user-facing Cloud Run runtime secret; that is the Cloud Run service
  account’s job.
- `iam.serviceAccountUser` — required to bind the runtime
  `instantml-rust-api` service account to the Cloud Run service.
- `compute.networkAdmin` / `compute.loadBalancerAdmin` — the script
  provisions the static-egress NAT and the optional public router.
- `storage.admin` — Cloud Build staging bucket.

These roles match what an admin invoking `npm run deploy:cloud-run`
currently uses. Tighten them later (e.g. swap `secretmanager.admin` for
narrower grants on the BYOC secret name prefix) once usage stabilizes.

## 3. Bind the WIF principal to the deploy service account

Allow the federated principal (any workflow run from `InstantML/monorepo`)
to impersonate the deploy service account.

```bash
gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA_EMAIL}" \
  --project="<GCP_PROJECT>" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL>/attribute.repository/InstantML/monorepo"
```

For tighter scope, restrict by ref / environment / actor — for example,
only `refs/tags/release-*` can deploy to `prod`:

```bash
# Optional: ref-scoped binding for production tags only.
gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA_EMAIL}" \
  --project="<GCP_PROJECT>" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL>/attribute.ref/refs/tags/release-*"
```

## 4. Add the repository variables

Set these as **repository variables** (not secrets — they are not sensitive):

| Variable | Value |
| --- | --- |
| `GCP_WIF_PROVIDER` | `projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL>/providers/<WIF_PROVIDER>` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `<DEPLOY_SA>@<GCP_PROJECT>.iam.gserviceaccount.com` |
| `GCP_PROJECT` | `<GCP_PROJECT>` |
| `GCP_REGION` | `us-central1` |
| `GCP_ARTIFACT_REPOSITORY` | `instantml` (matches the repo today) |

```bash
gh variable set GCP_WIF_PROVIDER --body "projects/<GCP_PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL>/providers/<WIF_PROVIDER>"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --body "${DEPLOY_SA_EMAIL}"
gh variable set GCP_PROJECT --body "<GCP_PROJECT>"
gh variable set GCP_REGION --body "us-central1"
gh variable set GCP_ARTIFACT_REPOSITORY --body "instantml"
```

## 5. Configure GitHub Environments

In **Settings → Environments**, create:

- `prod` — add yourself (and anyone else you trust) as a **required
  reviewer**. This is what enforces the "manual approval before any
  production Cloud Run update" requirement.
- `staging` — no required reviewers; staging is free to roll forward.

The workflow targets `environment: ${{ inputs.environment || 'prod' }}` on
both the build and deploy jobs, so the approval prompt blocks the runner
before any GCP mutation.

## 6. Confirm the secrets the deploy helper expects already exist

The helper pulls these from Secret Manager in CI mode. None of them should
be created by GitHub Actions — they are already managed today by the
existing `npm run deploy:cloud-run` path and should be considered the
source of truth. List of secret ids that must exist with at least one
enabled version:

| GCP secret id (prod) | Maps to runtime env |
| --- | --- |
| `instantml-clickhouse-user-data-endpoint` | `CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT` |
| `instantml-clickhouse-user-data-username` | `CLICKHOUSE_INSTANTML_USER_DATA_USERNAME` |
| `instantml-clickhouse-user-data-password` | `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD` |
| `instantml-clickhouse-cloud-key-id` | `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID` |
| `instantml-clickhouse-cloud-key-secret` | `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET` |
| `instantml-clerk-secret-key` | `CLERK_SECRET_KEY` |
| `instantml-clerk-publishable-key` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (validator only — not bound at runtime) |
| `instantml-bootstrap-token` | `INSTANTML_BOOTSTRAP_TOKEN` |
| `instantml-cloudflare-r2-api-key` | `CLOUDFLARE_R2_API_KEY` |
| `instantml-cloudflare-api-token` | `CLOUDFLARE_API_TOKEN` |
| `instantml-cloudflare-r2-access-key-id` | `CLOUDFLARE_R2_ACCESS_KEY_ID` |
| `instantml-cloudflare-r2-secret-access-key` | `CLOUDFLARE_R2_SECRET_ACCESS_KEY` |
| `instantml-stripe-secret-key` | `STRIPE_SECRET_KEY` |
| `instantml-stripe-webhook-secret` | `STRIPE_WEBHOOK_SECRET` |
| `instantml-resend-api-key` | `RESEND_API_KEY` |

Staging uses the `instantml-staging-` prefix (same id sans the leading
`instantml-`). The `instantml-clerk-publishable-key` entry is new — it
mirrors the value in `.env` / `apps/web/.env.local` so the existing Clerk
consistency check (the one that recently caught a stale publishable key)
can still run in CI without reading any laptop file:

```bash
# One-time: load NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY into Secret Manager.
# Run from a laptop that already has the value in apps/web/.env.local.
gcloud secrets create instantml-clerk-publishable-key --replication-policy=automatic
echo -n "<pk_live_…>" | gcloud secrets versions add instantml-clerk-publishable-key --data-file=-
```

Do the same with the `instantml-staging-` prefix for staging.

## 7. Smoke test the WIF wiring without doing a real deploy

Run the workflow once with `environment=staging` and confirm:

1. The `Require Stable Quality Gates` job passes for the current SHA.
2. The `Build And Push Image` job successfully authenticates via WIF and
   submits the Cloud Build (you will see `gcloud auth list` showing the
   federated principal in the step logs).
3. If you want a no-mutation rehearsal first, comment out the
   `Run Cloud Run Deploy Helper` step body and replace it with
   `gcloud projects describe ${GCP_PROJECT}` — that proves the WIF token
   exchange and project access work without touching any service.

Once steps 1–7 are complete, the local `npm run deploy:cloud-run` path
still works as an emergency fallback (it has not been removed), but it
should no longer be the routine path. New devs do not need a hosted `.env`
to deploy.
