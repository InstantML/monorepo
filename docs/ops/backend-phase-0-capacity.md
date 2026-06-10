# Backend Phase 0 Capacity Runbook

Date: 2026-06-10

Status: Phase 0 operating gate for `docs/design/2026-06-10-backend-cluster-scaling-plan.md`

## Purpose

Phase 0 keeps the current hosted backend honest before InstantML adds more
control/data cells. It does not raise service instance counts or change public
routing. It gives operators a repeatable checklist for the current cell:

- Cloud SQL connection budget.
- ClickHouse backup and restore posture.
- Cell capacity and SLO evidence.
- Write-path benchmark evidence.
- Single-writer guardrail confirmation.

Do this before adding a second data cell, increasing Cloud Run max instances, or
onboarding a customer that expects durability guarantees.

## Cloud SQL Connection Budget

Every hosted control and data service connects to the Cloud SQL Postgres
control plane. Before deploying more cells, compute the projected connection
budget:

```text
total_control_connections =
  active_revisions * active_instances_per_revision * per_instance_pool_size
  + deploy_overlap_connections
  + operator_job_connections
  + migration_job_connections
```

Run the Rust preflight from the repo root:

```bash
INSTANTML_CLOUD_SQL_CONNECTION_LIMIT=<cloud-sql-tier-limit> \
npm --silent run rust:capacity-plan
```

Useful environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `INSTANTML_CAPACITY_ACTIVE_REVISIONS` | `1` | Active revisions expected to hold Cloud SQL pools. Use `2` during traffic-split or rollout overlap. |
| `INSTANTML_CAPACITY_ACTIVE_INSTANCES` | `2` | Active Cloud Run instances/processes per active revision that connect to Cloud SQL across control and data services. Current prod split default is one control plus one data. |
| `CONTROL_DB_MAX_CONNECTIONS` | `10` | Rust sqlx pool size per process. |
| `INSTANTML_CAPACITY_DEPLOY_OVERLAP_CONNECTIONS` | `CONTROL_DB_MAX_CONNECTIONS` | Extra Cloud SQL connections reserved for no-traffic deploy, health check, and traffic flip overlap. |
| `INSTANTML_CAPACITY_OPERATOR_JOB_CONNECTIONS` | `2` | Connections reserved for operator scripts, smoke checks, or one-off diagnostics. |
| `INSTANTML_CAPACITY_MIGRATION_JOB_CONNECTIONS` | `0` | Connections reserved for migration jobs. Keep `0` until Phase 5 exists. |
| `INSTANTML_CLOUD_SQL_CONNECTION_LIMIT` | unset | Cloud SQL tier connection ceiling. Required for production preflights; the command fails when this is unset unless `--allow-unknown-limit` is passed for local exploration. |
| `INSTANTML_CAPACITY_RESERVED_HEADROOM_PERCENT` | `20` | Headroom kept free for control-plane spikes, deploy overlap, and emergency access. |

Example:

```bash
INSTANTML_CLOUD_SQL_CONNECTION_LIMIT=100 \
INSTANTML_CAPACITY_ACTIVE_REVISIONS=1 \
INSTANTML_CAPACITY_ACTIVE_INSTANCES=2 \
CONTROL_DB_MAX_CONNECTIONS=10 \
npm --silent run rust:capacity-plan
```

The command prints clean JSON to stdout when run through `npm --silent`, or when
run directly with `cargo run --quiet --manifest-path apps/rust-server/Cargo.toml
-- capacity-plan`. Plain `npm run` prints an npm lifecycle banner around the
JSON and should not be redirected into machine readers.

Treat `status: "ok"` as a pass, `unknown_limit` as an incomplete preflight, and
`over_budget` as a blocker. `capacity-plan` exits nonzero for both
`unknown_limit` and `over_budget`; pass `--allow-unknown-limit` only for local
exploratory output when the Cloud SQL tier is not known yet.

## ClickHouse Backup Gate

Each InstantML-owned ClickHouse cell must have a named backup mechanism before
it carries production customer data.

Record these fields in the operator ticket or release checklist:

| Field | Required value |
| --- | --- |
| Mechanism | GCP persistent-disk snapshot or ClickHouse-native backup job. |
| Destination | Durable GCP storage location or snapshot policy name. |
| Retention | Number of retained recovery points and deletion policy. |
| Encryption/IAM owner | Who can read/delete backups. |
| RPO | Maximum accepted data loss window. |
| RTO | Maximum restore time target. |
| Backup age alert | Alert name and threshold. |
| Restore drill target | Isolated VM/database used for validation. |

Minimum beta gate:

1. Backup job or snapshot policy exists for the current ClickHouse VM/disk.
2. Backup age alert is configured.
3. A restore drill has successfully restored into an isolated target.
4. Validation compared row counts for `operational_records`, `metric_points`,
   `rank_metric_points`, `console_log_lines`, and selected dashboard queries.
5. Active artifact metadata was checked against R2 object presence for sampled
   orgs.

Do not mark a cell `open` for paid placements if the backup age alert is firing
or no restore drill has run for the current mechanism.

## Cell Capacity Snapshot

For the current production cell, record the following before and after any
capacity-impacting deploy:

| Area | Evidence |
| --- | --- |
| Cloud Run | p50/p95/p99 latency, 5xx rate, concurrency, CPU, memory, active instances, active revisions. |
| Cloud SQL | connection utilization, pool wait/timeouts, CPU, memory, disk, backups. |
| ClickHouse | CPU, memory, disk percent, disk days-to-full estimate, query p95 by route family, insert failures, table sizes. |
| Product | active org count, retained runs, retained metric points, current-month metric/API requests, R2 bytes. |
| Routing | route failures, `/readyz` degraded state, tenant-route failed/provisioning counts. |
| Backups | latest backup time, latest restore-drill time, alert status. |

Keep high-cardinality run IDs, metric keys, user emails, artifact filenames,
tokens, and raw URLs out of metrics and tickets.

## Write-Path Benchmark Evidence

The current read benchmark remains:

```bash
INSTANTML_API_KEY=instantml_... npm run benchmark:cloud-run
```

For Phase 0, also record write-path evidence before adding cells. Until a
dedicated hosted write benchmark exists, use a disposable project/org and record
at least:

- SDK run creation latency.
- Batched scalar metric insert latency and inserted row count.
- Rank metric insert latency if the customer uses distributed/rank workflows.
- Console-log insert latency if enabled.
- Artifact metadata write latency.
- Artifact byte upload latency when R2 is enabled.
- Any `429`, `402`, `503`, or `5xx` responses.

The benchmark must use SDK/API routes, not direct ClickHouse inserts, because
the Phase 0 question is API plus data-plane capacity.

## Single-Writer Guardrail

Phase 0 does not make data cells multi-writer safe. Before every prod deploy,
confirm:

- Control and data Cloud Run services are bounded to one active instance.
- No unsafe multi-instance flags are set in production.
- Any staging load test using unsafe flags is isolated from production control
  and tenant databases.
- Deploy overlap is included in the Cloud SQL budget.

Do not raise data-cell instance counts until the writer-lease and data-plane
multi-writer gates in the scaling design are implemented.

## Backward Compatibility

This runbook and the `capacity-plan` command do not change API routes, SDK
methods, database schemas, or browser behavior. Existing local development,
contract smokes, and hosted deploy commands continue to work.
