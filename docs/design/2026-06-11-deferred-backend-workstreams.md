# Deferred backend workstreams — store sharding, hardware capture, alert rules

Date: 2026-06-11
Status: Proposed (design only — implementation deliberately deferred)
Scope source: `docs/design/2026-06-10-ui-ux-production-audit.md` sections 5–6
(parity matrix, PF1, D8/GPU capture, AL1 alert rules)

Three audit findings are backend product workstreams, not frontend flow
defects. Per `AGENTS.md` each needs an accepted design before code; this doc
records the agreed direction, the acceptance bar, and why none of them ship
inside the UI remediation waves (PRs #184/#192), so the audit disposition is
a decision rather than an omission.

## 1. PF1 — operational store sharding

**Problem.** Every operational read/write funnels through one
`tokio::sync::Mutex<StoreData>`. Dashboard list endpoints, ingest, and replay
serialize on it; p99 latency degrades linearly with concurrent SDK writers.

**Direction.** Shard the in-process index by org: `DashMap<Uuid, OrgShard>`
(or fixed-N `Vec<Mutex<StoreData>>` with `org_id % N` routing — final shape
to be benchmarked). All current entry points already take a
`RequestContext` carrying `org_id`, so routing is mechanical; cross-org
surfaces (admin overview, platform metrics) iterate shards.

**Why deferred.** The store guide (`apps/rust-server/CLAUDE.md`) constrains
replay ordering and lock discipline ("avoid holding StoreData locks across
network I/O"); sharding interacts with full ordered replay and the
multi-instance roadmap. Wrong to land under a UI deadline without
multi-writer correctness tests.

**Acceptance.** Two-process write-uniqueness/freshness tests pass; ingest
p99 under 64 concurrent writers improves ≥5×; replay determinism tests
unchanged; no endpoint regresses.

## 2. D8 follow-up — automatic hardware metric capture (SDK)

**Problem.** `system/instantml/*` rows cover upload health only. W&B captures
GPU/CPU/memory automatically; users must hand-log hardware metrics today.

**Direction.** Opt-out background sampler in the Python SDK: a daemon thread
samples every 10s — CPU/RSS via `psutil` (already a transitive dependency of
common ML stacks; vendor a stdlib fallback), GPU via NVML when
`pynvml`/`nvidia-ml-py` import succeeds — and logs through the existing
batched metric path under `system/hardware/*` keys. Run Detail's System tab
already renders telemetry rows readably (wave 2), so the frontend cost is
zero on day one; charts come free via the metric system.

**Why deferred.** SDK dependency policy (no hard new deps), sampler overhead
budgets, and Windows/macOS NVML behavior need their own review; the SDK has
its own release cadence and contract tests.

**Acceptance.** Zero hard dependencies added; sampler ≤0.5% CPU overhead in
the example training scripts; metrics appear without user code changes;
`INSTANTML_DISABLE_SYSTEM_METRICS=1` opt-out; SDK pytest coverage for
sampler lifecycle (start, finish-drain, crash).

## 3. AL1 follow-up — alert rules engine

**Problem.** "Run health" is a derived-warnings list (deduped in wave 2). Real
alerting — user-defined conditions with notification delivery — does not
exist; W&B has `run.alert()` plus automations.

**Direction.** Three increments, each independently shippable:
1. `POST /api/runs/{id}/alert` — SDK-triggered alert records, listed on Run
   health (parity with `wandb.alert()`).
2. Rule records (`metric_key`, comparator, threshold, scope) evaluated on
   ingest against the already-maintained latest-metric index; matches create
   alert records.
3. Delivery channels (email/Slack webhook) with secret-reference storage —
   constrained by the existing "no plaintext credentials in operational
   records" posture.

**Why deferred.** New API + storage + (for channels) secret handling — all
three categories the backend guide gates behind accepted designs; delivery
infrastructure has abuse/quota implications beyond a UI wave.

**Acceptance.** Rules CRUD + evaluation covered by store tests; alert records
replay deterministically; no ingest-path latency regression >2%; channel
secrets never appear in operational payloads or logs.

## Disposition in the audit annex

With S6 implemented (`2026-06-11-share-token-expiry.md`) and these three
designs accepted-as-proposals, every section 3–7 audit item is either shipped
or carries an explicit, reviewed decision — none are silently open.
