# Self-Hosted GCP ClickHouse

Date: 2026-05-23

Status: Current hosted storage operations reference

## Purpose

InstantML's hosted production and staging Rust services now use an
InstantML-owned ClickHouse deployment on Google Cloud instead of ClickHouse
Cloud for InstantML-hosted control and tenant data. This document records the
current operating model so deploys, seeds, benchmarks, artifact checks, and
future cleanup work do not accidentally reintroduce ClickHouse Cloud for the
default hosted path.

This is not a replacement for customer-owned ClickHouse documentation. Premium
BYOC customers can still point an org at their own HTTPS ClickHouse endpoint.

## Current Hosted Shape

```text
Browser / SDK
  -> Cloud Run control/data services
  -> Google Cloud VPC
  -> self-hosted ClickHouse VM
  -> per-org tenant databases

Artifact uploads
  -> Cloud Run data service
  -> Cloudflare R2 private per-org buckets
```

Production services:

- `instantml-control`
- `instantml-data-us-central1-a`
- public API router: `api.instantml.ai`

Staging services:

- `instantml-staging-control`
- `instantml-staging-data-us-central1-a`
- public API router: `staging.api.instantml.ai`

ClickHouse:

- VM name: `instantml-clickhouse`
- Zone: `us-central1-a`
- Machine: `n2-standard-2`
- Boot/storage disk: 100 GB `pd-ssd`
- Network: `instantml-cloud-run`
- VM has no public address; Cloud Run reaches it over the Google Cloud VPC.
- Operator access should use IAP/SSH tunneling when local scripts need direct
  ClickHouse access.

## Database Layout

The self-hosted ClickHouse instance stores both control and tenant databases.

Control data:

- Production User Data records live in the production User Data database and
  table `instantml_user_data`.
- Staging uses the separate User Data database
  `instantml_user_data_staging`, also with table `instantml_user_data`.
- Staging must not write production User Data records.

Tenant data:

- Tenant databases are named `instantml_org_<org_id.simple>`.
- Each tenant database owns its `operational_records`, `metric_points`,
  `rank_metric_points`, `console_log_lines`, `metric_series`, and materialized
  view tables.
- Current InstantML-hosted tenant routes should use database-mode routing
  against this self-hosted instance. Provider-backed `cloud-service` routing is
  legacy/optional and should not be the default hosted path.

Artifacts:

- Artifact metadata stays in ClickHouse tenant operational records.
- Uploaded bytes are stored in Cloudflare R2 private buckets named
  `instantml-org-<org_id.simple>`.
- R2 buckets or objects should be deleted only after comparing them against the
  latest artifact rows in both prod and staging tenant databases.

## Usage Isolation

Usage tracking must stay org-isolated even when many tenant databases live on
one self-hosted GCP ClickHouse instance.

- Metric-point usage is always counted with an `org_id` predicate for scalar
  and rank metric tables.
- Dedicated database-mode tenants may report exact warehouse bytes from
  `system.parts` because the database is scoped to one org:
  `instantml_org_<org_id.simple>`.
- Shared-cell tenants must not expose database-wide `system.parts` bytes as
  org-exact usage because the database can contain multiple orgs. They fall
  back to org-local metadata and artifact byte estimates until per-org table
  byte accounting exists.
- Customer-owned ClickHouse tenants do not count customer warehouse bytes
  against InstantML-hosted storage; usage includes only InstantML-owned
  artifact bytes.
- Artifact storage usage is filtered by artifact metadata `org_id`; external
  artifact references are tracked separately from retained local/R2 bytes.

## Runtime Configuration

Hosted Cloud Run services should keep:

```text
INSTANTML_HOSTED_CLICKHOUSE_ENABLED=true
INSTANTML_CLICKHOUSE_PROVISIONER=database
CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT=<self-hosted GCP ClickHouse HTTP endpoint>
CLICKHOUSE_INSTANTML_USER_DATA_USERNAME=<Secret Manager value>
CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD=<Secret Manager value>
INSTANTML_TENANT_CLICKHOUSE_URL=<same self-hosted endpoint/base credentials>
INSTANTML_ARTIFACT_BACKEND=r2
INSTANTML_ARTIFACT_UPLOADS_ENABLED=true
CLOUDFLARE_R2_BUCKET_PREFIX=instantml-org
```

Staging should use the staging-scoped Secret Manager names and either
`INSTANTML_STAGING_USER_DATA_DATABASE=instantml_user_data_staging` or an
explicit staging User Data endpoint. Prod and staging may point at the same
ClickHouse VM, but their User Data databases must remain separate.

## Cost-Conscious GCP Defaults

The current beta target is functional and cheap before highly available. Keep
these defaults unless live measurements justify a change:

- ClickHouse: one `n2-standard-2` VM in `us-central1-a`, no public IP, 100 GB
  `pd-ssd`, Dockerized ClickHouse, and private VPC access from Cloud Run.
- Production Cloud Run: split control/data services, 1 vCPU, 1 GiB memory,
  concurrency `20`, and manual scaling at one active instance per service.
- Staging Cloud Run: same CPU/memory/concurrency, but automatic scaling with
  min `0` and max `1` so local staging testing does not keep idle instances
  warm.
- Scaling guardrail: control/data services must remain bounded to one active
  instance unless an operator deliberately sets the unsafe multi-instance test
  flags and accepts the duplicate-write/freshness risk.
- Networking: use Direct VPC egress to reach the ClickHouse VM. Keep
  all-traffic static egress only when public BYOC/provider allowlists need one
  known outbound IP; otherwise prefer private ranges for purely private
  backend traffic.
- Logging/storage hygiene: keep Cloud NAT logging disabled by default, enable
  it only during network incidents, and add Artifact Registry cleanup policies
  for old Cloud Run images once release retention is agreed.

Do not resize the VM simply because a benchmark exists. Revisit CPU/memory only
after sustained CPU pressure, ClickHouse memory pressure, or dashboard p95s
cross the product budget. Grow storage before disk exhaustion, and add backups
or snapshots before relying on this path for customers with durability
expectations.

## Operator Access

Use a short-lived IAP tunnel for local metadata checks or one-off seed scripts:

```bash
gcloud compute ssh instantml-clickhouse \
  --zone=us-central1-a \
  --tunnel-through-iap \
  -- -N -L 18123:127.0.0.1:8123
```

Then point local-only tooling at:

```text
http://127.0.0.1:18123
```

Do not leave the tunnel running after the operation. Local seed helpers should
override only the network endpoint and continue using the tenant route's stored
database and credentials.

## Verification Checklist

Before considering a deploy or cleanup complete:

1. `GET /health` and `GET /readyz` pass for prod and staging.
2. `GET /api/auth/config` reports the expected control/data service plane from
   each router.
3. Prod and staging Cloud Run revisions use self-hosted GCP ClickHouse secrets,
   not ClickHouse Cloud endpoints.
4. New hosted tenant routes for InstantML-owned storage use `database`
   provisioner and an `instantml_org_<org_id.simple>` database.
5. The target tenant database has the ClickHouse schema applied.
6. R2 artifact upload and download work through the Rust API.
7. Any R2 cleanup was cross-checked against artifact metadata in both prod and
   staging.
8. Showcase seed projects still cover normal runs, intensive metric runs,
   distributed/rank runs, and artifact runs under separate projects.

## Current Benchmark Signal

The current hosted-path benchmark is
`benchmarks/2026-05-23-gcp-clickhouse-cloud-run-results.md`. It measured the
production Cloud Run data service reading from the self-hosted GCP ClickHouse
VM against the `normal-runs-50k` project:

- Project size: `50000` runs and `522000000` metric points.
- Org-wide read surface during org-scoped cases: `70029` runs and
  `570162046` metric points.
- Project newest-100 p95: `236 ms`.
- Project metric-best sort p95: `307 ms`.
- Project overview p95: `418 ms`.
- Single-run chart p95: `224 ms` for a 1,000-point response from a 20,000-step
  source series.

This replaces the ClickHouse Cloud benchmark as the current beta hosted
operating signal. The closest historical ClickHouse Cloud comparison used a
different 100,000-run / 600M-point dataset shape, so keep comparisons
directional rather than treating the two files as a controlled A/B.

## Backups And Follow-Ups

The current self-hosted GCP ClickHouse path lowers pilot cost and removes the
ClickHouse Cloud dependency for InstantML-owned hosted storage, but it also
puts backup and capacity responsibility on InstantML operators.

Required operating follow-ups:

- Schedule regular ClickHouse backups or disk snapshots to durable Google Cloud
  storage.
- Add disk, memory, CPU, and table-size monitoring for the VM.
- Add a budget alert and Artifact Registry image cleanup policy for the GCP
  project.
- Keep an operator runbook for restore tests and VM replacement.
- Revisit high-availability before onboarding customers that require stronger
  uptime guarantees.

## Related Docs

- `docs/architecture/current-system.md`
- `docs/architecture/multi-instance-cloud-run.md`
- `docs/architecture/current-schemas.md`
- `apps/rust-server/README.md`
- `tools/README.md`
- `apps/docs/architecture/google-clickhouse.mdx`
