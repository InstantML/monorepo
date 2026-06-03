# GitHub Actions workflows

| Workflow | File | Triggers | Purpose |
| --- | --- | --- | --- |
| Stable Quality Gates | [`ci.yml`](./ci.yml) | Pull request, push to `main` | Parallel Rust, Node, Python/SDK, docs, and codegen-drift checks. A `changes` job (`dorny/paths-filter`) runs first so each split job only runs when its area is touched; the final `Stable Quality Gates` job always runs, aggregates the split jobs (treating skipped = untouched as a pass), and is used as the gate for the deploy workflow. |
| Python SDK Release | [`python-sdk-release.yml`](./python-sdk-release.yml) | Release published, manual dispatch | Publish the `instantml` Python SDK to (Test)PyPI via OIDC trusted publishing. |
| Deploy Cloud Run | [`deploy-cloud-run.yml`](./deploy-cloud-run.yml) | Manual dispatch, push of `deploy-*` / `release-*` tag | CI-triggered Cloud Run rollout. Replaces the laptop-only `npm run deploy:cloud-run`. |

## Cloud Run deploy

`deploy-cloud-run.yml` is the canonical path for shipping `instantml-control`
and `instantml-data-us-central1-a`. It reuses
[`tools/deploy-cloud-run.mjs`](../../tools/deploy-cloud-run.mjs) instead of
reimplementing the deploy in YAML, so the existing validation logic — most
importantly the Clerk publishable-key consistency check — keeps running.

Three guardrails apply:

1. The `Require Stable Quality Gates` job blocks the deploy until `ci.yml`
   has a successful run on the same SHA. Inside `ci.yml`, the final `Stable
   Quality Gates` job depends on every split CI job so deploys still require
   the full stable gate.
2. The `prod` GitHub Environment is configured with **required reviewers**.
   A reviewer must approve before either the build or the deploy job
   contacts GCP.
3. Authentication uses **Workload Identity Federation**. There is no
   `credentials_json` and no JSON service-account key anywhere in the repo.
   The runner exchanges its short-lived OIDC token for a GCP access token
   scoped to the `gha-cloud-run-deployer` service account (configurable per
   project; see the operator doc).
4. The deploy helper promotes each Cloud Run service to the latest ready
   revision after `gcloud run deploy` and verifies 100% traffic points at that
   revision and image tag. This prevents a deploy from only creating a revision
   while the public route remains pinned to an older one.

Secrets — `CLERK_SECRET_KEY`, `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD`,
`CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET`, the Stripe / R2 / Resend keys,
and the bootstrap token — are read directly from GCP Secret Manager via
the helper script’s `--from-secret-manager` flag. They never appear in the
workflow file, environment variables, or step logs.

### One-time operator setup

See [`docs/ops/github-deploy.md`](../../docs/ops/github-deploy.md) for the
GCP-side setup (Workload Identity Pool + provider, deploy service account
roles, binding the WIF principal, repository variables, GitHub Environment
reviewers, and the secret-id checklist).

### Triggering a deploy

- **Manual** (most common): GitHub UI → Actions → *Deploy Cloud Run* → *Run
  workflow* → pick `environment` (default `prod`) and `topology` (default
  `split`). Approve when the Environment review prompt appears.
- **Tag push**: `git tag deploy-2026-05-23-1 && git push origin deploy-2026-05-23-1`.
  Tag pushes always target `prod` with the `split` topology; `release-*`
  tags additionally refresh the public HTTPS router.

### Fallback: laptop deploy

`npm run deploy:cloud-run` still works exactly as it always has. It is no
longer the routine path, but it is preserved as an emergency fallback for
when GitHub Actions is unavailable or you need to bisect a deploy-helper
change locally.
