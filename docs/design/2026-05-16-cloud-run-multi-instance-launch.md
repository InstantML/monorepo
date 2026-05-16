# Design: Cloud Run Multi-Instance Launch Wiring

Date: 2026-05-16

Status: Accepted

Owner: Codex

## Summary

InstantML now has explicit Rust service-plane roles: `combined`, `control`, and
`data`. The next launch-readiness step is to make Docker and Cloud Run tooling
deploy those roles deliberately instead of treating the split as a local-only
test shape.

The smallest useful launch shape is a split Cloud Run topology with one control
service and one data service/cell built from the same image. The control service
owns auth, users, orgs, API keys, seats, and tenant route records. The data
service owns product routes for projects, runs, metrics, logs, imports, usage,
and export. Both services share the User Data ClickHouse control table and use
the same static Cloud NAT egress for ClickHouse Cloud allowlisting.

This design does not claim shared-cell multi-writer correctness. The launchable
default keeps the data cell on manual single-instance scaling while control can
use automatic bounded scaling. That gives us real operational separation and a
clean Cloud Run shape without pretending per-process projections are a
distributed coordination layer.

## Goals

- Add an explicit deploy command for split Cloud Run control/data services.
- Keep the existing single combined Cloud Run deploy command available.
- Build one container image and deploy it with role-specific environment.
- Preserve static egress and ClickHouse Cloud access-list behavior.
- Document how routing, Docker Compose, and Cloud Run services fit together.
- Keep local/frontend env updates safe when a split deployment does not yet have
  a public load balancer or router URL.

## Non-Goals

- Do not run a live deployment as part of this change.
- Do not create a Cloud Load Balancer automatically.
- Do not raise data-plane cells to multiple active writer instances by default.
- Do not add Redis, Kafka, Spanner, Firestore, or a new coordinator.
- Do not change public REST route shapes, SDK behavior, or browser auth flows.

## Users and Use Cases

Operators need a repeatable command that can launch the current split service
shape in GCP without manually copying environment variables between Cloud Run
services.

Future agents need clear docs that distinguish:

- combined single-service deploys,
- split control/data deploys,
- dedicated single-writer data cells, and
- future shared multi-writer cells after durable write gates land.

Frontend developers still need a safe local environment file update path. A
single combined deploy can write the service URL directly. A split deploy should
only write `INSTANTML_API_BASE` when an operator provides the public load
balancer/router URL via `INSTANTML_PUBLIC_API_BASE`.

## Proposed Design

### Cloud Run Commands

Add three root scripts:

- `npm run deploy:cloud-run`: default split control/data topology.
- `npm run deploy:cloud-run:single`: explicit single combined service.
- `npm run deploy:cloud-run:multi`: split control/data topology.

`tools/deploy-cloud-run.mjs` accepts `--topology=single|split` and
`INSTANTML_CLOUD_RUN_TOPOLOGY=single|split`. When no topology is provided, the
helper defaults to `split`.

### Split Targets

The split deploy creates two Cloud Run services from one image:

| Target | Service plane | Default service name | Default scaling |
| --- | --- | --- | --- |
| Control | `control` | `instantml-control` | automatic, max 5 |
| Data cell | `data` | `instantml-data-<region>-a` | manual, 1 instance |

The defaults can be changed with:

- `INSTANTML_CLOUD_RUN_SERVICE_PREFIX`
- `INSTANTML_CLOUD_RUN_CONTROL_SERVICE`
- `INSTANTML_CLOUD_RUN_DATA_SERVICE`
- `INSTANTML_CLOUD_RUN_DATA_CELL`
- `INSTANTML_CLOUD_RUN_CONTROL_SCALING=auto|manual`
- `INSTANTML_CLOUD_RUN_DATA_SCALING=auto|manual`
- `INSTANTML_CLOUD_RUN_CONTROL_MAX_INSTANCES`
- `INSTANTML_CLOUD_RUN_DATA_MAX_INSTANCES`
- `INSTANTML_CLOUD_RUN_CONTROL_INSTANCES`
- `INSTANTML_CLOUD_RUN_DATA_INSTANCES`

### Runtime Environment

Both split services receive the existing hosted runtime environment:

- `INSTANTML_AUTH_MODE=api-key`
- `INSTANTML_DEV_AUTH_ENABLED=false`
- `INSTANTML_HOSTED_CLICKHOUSE_ENABLED=true`
- `INSTANTML_CLICKHOUSE_PROVISIONER=cloud-service`
- `INSTANTML_LOG_FORMAT=json`
- `INSTANTML_ARTIFACT_UPLOADS_ENABLED=false`
- ClickHouse Cloud/User Data secrets through Secret Manager
- Clerk settings when configured

Each target also receives its service plane:

- control: `INSTANTML_SERVICE_PLANE=control`
- data: `INSTANTML_SERVICE_PLANE=data`

The data target additionally receives `INSTANTML_CELL_ID` for operator
observability and future route records.

### Static Egress And ClickHouse Access

The deploy helper keeps the existing regional VPC, subnet, Cloud Router, Cloud
NAT, and reserved egress IP setup. Both services use the same VPC egress
settings so ClickHouse Cloud services and API keys only need the NAT IP
allowlisted.

This follows the Cloud Run static outbound IP pattern: route all Cloud Run
egress through a VPC network with Cloud NAT configured with reserved static IPs.

### Verification

After each Cloud Run service deploy, the helper checks:

- `/health`
- `/readyz`
- `/api/auth/config`
- `/openapi.json`

The last two responses must report the expected `service_plane`. The helper also
verifies the configured scaling mode where the Cloud Run description exposes it.

### Local Docker Compose

Keep `docker compose up` as the simple combined local stack.

Add a `split` Compose profile:

```bash
docker compose --profile split up --build instantml-control instantml-data
```

The split profile uses one ClickHouse container, a User Data database, a tenant
base database, and two Rust containers configured with `control` and `data`
service planes. It is for local wiring and operator understanding, not a
replacement for the hosted smoke.

## Component Impact

Backend:

- No Rust route changes.
- Deployment environment now sets service-plane roles per Cloud Run target.

Frontend:

- No frontend code changes.
- Split deploys only write local `INSTANTML_API_BASE` when
  `INSTANTML_PUBLIC_API_BASE` is provided.

Python SDK:

- No SDK code changes.
- Future direct-to-cell SDK routing still needs a separate design.

Storage:

- No ClickHouse schema change.
- User Data and tenant data route behavior remains the current Rust behavior.

Docs:

- Update Rust server README, root README, architecture docs, and Docker notes.

## Data Model

No new durable data model is introduced. `INSTANTML_CELL_ID` is an environment
label only in this change. Future tenant route records may include public cell
URLs or cell identifiers through a separate routing design.

## API Contracts

No public API contract changes. The existing platform endpoints continue to
publish role-aware diagnostics:

- `GET /api/auth/config` includes `service_plane`.
- `GET /openapi.json` includes `x-instantml-service-plane`.

## Performance Considerations

- Control-plane traffic is lower volume and can scale automatically with a
  bounded max instance count.
- Data-plane traffic is the hot path. The default deploy keeps one active data
  instance per cell until durable multi-writer gates land.
- Metric/log writes remain batched at the request level. Shared multi-writer
  cells still require durable idempotency or ClickHouse dedupe keys before
  automatic data-plane scaling is enabled.
- Static egress is shared per region. If traffic grows enough to exhaust NAT
  ports, add more NAT IPs and update ClickHouse allowlists.

## Simplicity Review

The design reuses the same binary, same Dockerfile, same Secret Manager secrets,
same Cloud Build image, and same ClickHouse routing model. The only new concept
in the deploy helper is a list of deployment targets.

Deferred complexity:

- automatic Cloud Load Balancer creation,
- direct-to-cell SDK discovery,
- public cell URL management,
- distributed write coordination,
- hosted object storage for artifact bytes.

## Failure Modes

- If the default split deployment has no public load balancer/router URL, local frontend
  env is not updated. The deploy output names the missing
  `INSTANTML_PUBLIC_API_BASE` value.
- If ClickHouse allowlisting fails, the helper warns or fails according to the
  same service/key allowlist options as the existing deploy flow.
- If a target reports the wrong service plane, deploy verification fails.
- If manual data scaling is changed to automatic before write gates are closed,
  duplicate project/import/idempotency behavior can still occur.
- If Cloud Run briefly exceeds revision-level max instances during deploys or
  spikes, correctness must still come from app/storage gates, not from max
  instance settings.

## Testing Plan

- `node --check tools/deploy-cloud-run.mjs`
- `node tools/deploy-cloud-run.mjs --help`
- `npm run rust:verify`
- `docker compose config`
- `git diff --check`

No live GCP deployment is part of this change.

## Documentation Plan

- Add `docs/architecture/multi-instance-cloud-run.md`.
- Update `docs/architecture/README.md` and `docs/architecture/current-system.md`.
- Update `docs/design/README.md`.
- Update `apps/rust-server/README.md`.
- Update root `README.md`.

## Alternatives Considered

Central hot-path proxy:

- Rejected. It adds latency and cost to metric/artifact paths while failing to
  solve durable write uniqueness.

Automatic shared data-cell scaling by default:

- Rejected for now. It would make deployment look scalable before the mutation
  gates are durable.

Separate Dockerfiles for control and data:

- Rejected. The same binary already supports service-plane roles; separate
  images would add drift without buying isolation.

Automatic load balancer creation:

- Deferred. GCP load balancer setup needs domain/certificate/host/path policy
  decisions that should be explicit operator choices.

## Review Notes

Operations review:

- Finding: split deploys need one static egress path shared by both services so
  ClickHouse Cloud allowlists stay small.
- Risk: multiple NAT IPs in later regions must be reflected in existing and new
  ClickHouse services and API keys.
- Recommended edit: keep the existing allowlist updater and emit the NAT IP in
  deploy output.
- Decision: accepted.

Rust/storage review:

- Finding: data-plane automatic scaling is unsafe until durable write
  uniqueness/idempotency lands.
- Risk: raising data cells to multiple active writers can duplicate low-volume
  entities or metric/log rows.
- Recommended edit: make data service default to manual one instance and
  document the gate.
- Decision: accepted.

## Coverage Exceptions

- Uncovered area: live GCP split Cloud Run deployment.
- Reason: this change intentionally does not deploy or mutate cloud resources.
- Risk: gcloud flag behavior or Cloud Run response shape may differ in a live
  project.
- Follow-up: run `npm run deploy:cloud-run:multi` in a controlled project, then
  record the resulting service descriptions and any script adjustments.
- Owner/date: hosted backend owner, 2026-05-16.

## Decision

Accepted. The repo now treats split Cloud Run as the default deployment shape,
with the data service defaulting to single-writer manual scaling until the
shared-cell write gates are complete. The single combined Cloud Run service is
available only through the explicit `deploy:cloud-run:single` command or
`--topology=single`.
