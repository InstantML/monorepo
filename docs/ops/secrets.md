# Secrets — operational reference

**Effective 2026-05-24.** Google Secret Manager is the single source of truth
for every secret InstantML services need. `.env` is for non-secret local
configuration only and is gitignored.

This doc covers the practical workflows. For the categorical inventory of
what is a secret vs what is not, see
[`docs/ops/secrets-inventory.md`](secrets-inventory.md). For the deploy
plumbing that consumes these secrets, see
[`docs/ops/github-deploy.md`](github-deploy.md) (PR #80).

## The pattern in one paragraph

A secret value (Clerk secret key, ClickHouse password, Stripe key, R2 token,
etc.) is created once in Google Secret Manager and rotated by adding a new
version there. Cloud Run revisions reference `<secret>:latest`, so the next
deploy automatically picks up the new version. Developers `source
tools/load-secrets.sh` once per shell session to pull the same secrets into
their local environment for development. Nobody emails a `.env` around. Nobody
commits a secret. Drift is structurally impossible because everything reads
the same store.

## Local-dev workflow

```bash
# One time:
gcloud auth login
gcloud config set project <GCP_PROJECT>
cp .env.example .env       # edit non-secret defaults if you want

# Once per shell session (refreshes if you re-run it):
source tools/load-secrets.sh
```

Re-running is idempotent — it just refreshes. To check the manifest is
in sync with Secret Manager without fetching values:

```bash
tools/load-secrets.sh --check
```

If you use [direnv](https://direnv.net/), copy `.envrc.example` to `.envrc`
and `direnv allow`. After that, `cd`ing into the repo triggers the loader
automatically.

## Onboarding a new developer

1. `gcloud auth login` with their `@instantml.ai` account.
2. Have them run `tools/load-secrets.sh --check` and confirm every
   required entry reports `OK`. If any are `MISS!`, the grantor (the
   operator on call this week) needs to grant `roles/secretmanager.secretAccessor`
   on that secret to their account:
   ```bash
   gcloud secrets add-iam-policy-binding <secret-id> \
     --member="user:newdev@instantml.ai" \
     --role="roles/secretmanager.secretAccessor"
   ```
3. `cp .env.example .env` for the non-secret side.
4. `source tools/load-secrets.sh`. Done.

## Adding a new secret

```bash
# 1. Create the secret container (one-time).
gcloud secrets create <secret-id> --replication-policy="automatic"

# 2. Add the first version. Pipe via stdin — never `--data-file` from a
#    plaintext file you wrote with the value, and never echo the value in
#    a way that lands in shell history.
printf %s "<paste-value-from-vendor-dashboard>" \
  | gcloud secrets versions add <secret-id> --data-file=-

# 3. Grant the deployer service account access (if not already covered by
#    a broader binding):
gcloud secrets add-iam-policy-binding <secret-id> \
  --member="serviceAccount:<deploy-sa>@<GCP_PROJECT>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# 4. Add a row to tools/secrets-manifest.txt and (if Cloud Run needs it at
#    runtime) tools/deploy-cloud-run.mjs::deploySecretSpecs().
# 5. Redeploy through the GH-Actions workflow (PR #80). The new revision
#    will bind <secret-id>:latest as the env var.
```

Use lowercase kebab-case for the secret id, prefixed with `instantml-`.
Staging mirrors use `instantml-staging-` (the deploy helper handles the
prefix when `INSTANTML_CLOUD_RUN_SECRET_PREFIX` is set).

## Rotating an existing secret

```bash
# 1. Add a new version. Stdin only.
printf %s "<new-value-from-vendor-dashboard>" \
  | gcloud secrets versions add <secret-id> --data-file=-

# 2. Roll Cloud Run to pick up the new :latest. Either:
#    - trigger the deploy workflow from the Actions UI, OR
#    - `gcloud run services update <service> --region=<region>` to force a
#      revision with the same image (Cloud Run resolves :latest at start).
```

The deploy helper (`tools/deploy-cloud-run.mjs`) deliberately does NOT
overwrite Secret Manager values when run with `--from-secret-manager` /
in CI mode (see PR #80) — it treats Secret Manager as authoritative. The
old (laptop, pre-PR-80) deploy path would push a new version every deploy,
which inflated version counts; the CI path avoids that.

Once verified, disable the previous version to prevent rollback to a known
bad credential:

```bash
gcloud secrets versions disable <prev-version-number> --secret=<secret-id>
```

## What never goes in `.env`

The categorical list. If your local `.env` or any `.env.example` row
contains any of these in cleartext, fix it before committing:

- Clerk: `CLERK_SECRET_KEY` (any `sk_live_*` or `sk_test_*`).
- ClickHouse: `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD`, the cloud key
  pair `CLICKHOUSE_INSTANTML_GENERAL_KEY_ID` /
  `CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET`.
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Cloudflare / R2: `CLOUDFLARE_R2_API_KEY`, `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_R2_SECRET_ACCESS_KEY`.
- Resend: `RESEND_API_KEY`.
- Bootstrap / admin: `INSTANTML_BOOTSTRAP_TOKEN`.

What may live in `.env`: connection URLs without embedded credentials,
region/provider/feature flags, public Stripe price ids, the Clerk
publishable key while developing locally (it leaks no auth power on its
own), bind addresses, log filters.

## Rotation cadence

| Class | Cadence |
| --- | --- |
| API keys (Clerk, Stripe, Resend, Cloudflare, ClickHouse Cloud) | Quarterly |
| Database passwords (ClickHouse user-data) | Quarterly, **immediate on incident** |
| Webhook signing secrets (Stripe) | When the Stripe endpoint is rotated, not on a fixed cadence |
| `INSTANTML_BOOTSTRAP_TOKEN` | Rotate on every use; the token should be short-lived by design |
| **All of the above** | **Immediately on personnel change** for anyone who had access |

Rotations are journalled in the GitHub Actions deploy summary (PR #80
emits `Annotate Deploy Summary` on every deploy). Tag the rotation in the
deploy log message so the on-call can correlate later.

## Pre-commit guard against accidental secret commits

The repo ships an opt-in pre-commit scanner at
`tools/check-no-secrets.sh`. It scans staged file contents for the patterns
listed below. To wire it into git locally:

```bash
ln -s ../../tools/check-no-secrets.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

(We do not auto-install hooks; opt-in keeps the contributor workflow
explicit. CI catches the same patterns at PR time.)

The scanner trips on:

- `sk_live_...` and `sk_test_...` (Clerk and Stripe live/test secret keys).
- `whsec_...` (Stripe webhook signing secrets).
- `instantml_[A-Za-z0-9_]{30,}` (InstantML-issued API keys).
- A `CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD=` line that is followed by
  more than 4 non-placeholder characters.
- Any `re_live_...` Resend key.

False positives can be silenced with a `# allow-secret-pattern: <reason>`
trailing comment on the same line — use sparingly and with a real reason.

## Incident response: a secret leaked

1. Rotate the secret in the vendor dashboard immediately.
2. `gcloud secrets versions add <secret-id> --data-file=-` with the new
   value (stdin).
3. Trigger a redeploy via the Actions UI.
4. `gcloud secrets versions disable <leaked-version>` once the new
   revision is live.
5. File an incident note in `log.md` / wiki linking to the rotation deploy
   so the audit trail is durable.

If the leak was via a `.env` accidentally committed, also rewrite the
history (`git filter-repo`) and force-push only after confirming the
secret is fully rotated.
