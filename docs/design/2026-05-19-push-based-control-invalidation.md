# Design: Push-Based Control-State Invalidation

Date: 2026-05-19

Status: Proposal — not accepted, recommendation is to defer build

Owner: Codex

## Summary

PR #32 stopped the immediate fire: data-plane Rust instances were issuing a
full `SELECT` of `instantml_user_data` on every authenticated request, which
trips ClickHouse Cloud's connection limits under SDK burst load. The throttle
coalesces refreshes to once every 2s, at the cost of making the staleness of
control state on the data plane explicit rather than incidental.

Two follow-ups are in flight that change the staleness story but do not
eliminate polling:

- **Tier 1** — incremental `load_records` using `record_clock_micros` as a
  `WHERE created_at > ?` watermark. Removes the full-table scan; the polling
  query becomes cheap.
- **Tier 2** — move the refresh off the request hot path entirely. A
  background task on a few-second cadence (~5s working assumption) calls the
  incremental loader. Request handlers read from the in-memory projection
  without ever touching ClickHouse for control state.

After Tier 2, every data-plane instance still polls. This doc asks whether
**Tier 3** — replacing polling with a push notification from the control plane
when control records change — is worth building, and if so, how.

Recommendation: **design it now, build it after the first real customer
(Jay's team) hits a consistency issue in production, or after we have evidence
the 5s tail is hurting them.** The expected value of building Tier 3 ahead of
that evidence is low; the cost of leaving Tier 2 in place is bounded and
well-understood.

## Goals

- Decide whether to replace control-plane polling with push notifications.
- If yes, choose a transport with honest trade-offs.
- Specify a coexistence model so polling remains the correctness floor and
  push is best-effort latency improvement.
- Set a clear trigger condition for when we actually build it.

## Non-Goals

- Cross-region consensus. One region (us-central1) for now.
- Cross-cloud failover. GCP-only.
- Solving ClickHouse Cloud operational outages. Separate concern.
- Pushing tenant data-plane state (runs, metrics, attributes) between
  instances. This doc is about *control* state only: orgs, memberships,
  sessions, API keys, tenant routes.
- Removing the polling fallback. Push is additive.

## Problem Statement

After Tier 2 ships, the residual issues with control-state propagation on the
data plane are:

1. **Tail-latency floor of ~5s.** A control-plane mutation (new API key,
   revoked key, new tenant route, session expiry write) becomes visible to a
   given data-plane instance only on the next background refresh tick. With a
   5s cadence the mean lag is ~2.5s and the p99 tail sits at ~5s for that
   instance, plus whatever the propagation gap is for additional instances.

2. **API-key revocation propagation.** A revoked API key continues to be
   honored on the data plane until the next refresh. For most cases 5s is
   tolerable. For a credential-leak incident response, it isn't: the customer
   expects "revoke now" to mean revoke now. Today we have a documented
   "revocation staleness limit" (see
   `2026-05-16-multi-instance-control-data-plane.md`) but no upper bound
   tighter than the refresh cadence.

3. **Tenant route updates.** Rare (org provisioning, dedicated-cell
   migrations, plan upgrade that flips `tenant_routing_tier`). When they do
   happen, a stale route on the data plane misroutes writes to the wrong
   ClickHouse warehouse or refuses traffic. Cost of staleness is high; rate
   is very low.

4. **Wasted query rate during quiescent periods.** With Tier 2 alone, every
   data-plane instance queries the control ClickHouse every ~5s regardless of
   activity. With N data-plane instances and a 5s cadence that's N × 720
   queries/hour for control state that almost never changes. Cheap per-query
   after Tier 1, but it's still load that scales with instance count and
   serves zero purpose during quiescent periods.

The first three are latency/correctness on the worst case. The fourth is
ongoing waste.

## Options

For each: latency, reliability, ops complexity, build cost, partial-failure
behavior.

### Option 1 — GCP Pub/Sub (recommended if we build)

Control plane publishes a small message to a topic on every control-record
insert. Each data-plane instance subscribes via a per-instance subscription
(distinct subscription names per instance, so all instances receive every
message — not a competing-consumer queue).

- **Latency.** Sub-second end-to-end in normal operation. Pub/Sub publish
  latency p99 is documented at <100ms; subscriber delivery on streaming pull
  is comparable.
- **Reliability.** At-least-once delivery. Messages can be duplicated, can
  arrive out of order. We already handle both: replay applies records by
  `(created_at, event_id)` and is idempotent.
- **Ops complexity.** One new topic, one subscription per data-plane
  instance. Pub/Sub is GCP-native. The existing static-egress allowlist for
  ClickHouse Cloud does not constrain Pub/Sub (it's a Google API endpoint
  reachable from Cloud Run without additional egress config). IAM grants
  needed: control-plane service account `pubsub.publisher`, data-plane
  service account `pubsub.subscriber`. Per-instance subscription cleanup on
  Cloud Run revision teardown needs an idempotent subscription bootstrap on
  start.
- **Build cost.** ~2 days for publisher integration, subscriber loop, and
  the bootstrap/teardown of per-instance subscriptions. ~1 day for tests
  including the polling fallback. Plus ~1 day infra (topic creation,
  subscription naming convention, IAM, deploy wiring). ~4 days total.
- **Partial failure.** If publish fails after the ClickHouse insert
  succeeded (publish errors, transient Pub/Sub outage), the polling
  fallback catches it within the next tick. Correctness is preserved; we
  just lose the latency win for that specific change. If a subscriber's
  streaming pull connection drops, the next reconnect resumes from the
  subscription's ack cursor; polling continues to run.

### Option 2 — NATS or Redis Pub/Sub

Same topology as Option 1 but on different infrastructure.

- **Latency.** Comparable to Pub/Sub, often faster on the publish side
  (single-digit ms in-region).
- **Reliability.** Redis Pub/Sub is fire-and-forget — disconnected
  subscribers miss messages outright, which makes it strictly weaker than
  Pub/Sub for our use case. NATS Core has the same property; NATS JetStream
  fixes it but adds operational weight similar to running Pub/Sub
  ourselves. The polling fallback would have to do real work, not just
  catch the occasional miss.
- **Ops complexity.** We don't run a NATS or Redis cluster today. Adopting
  either means provisioning, monitoring, upgrades, IAM/auth, and one more
  thing that can be down at 2am. Not justified for the volume here (a few
  hundred control mutations per day, max, across all orgs).
- **Build cost.** ~3 days application code + ~3–5 days infra and ops
  setup. Higher than Pub/Sub.
- **Partial failure.** Same as Option 1 if using JetStream; worse with
  vanilla NATS or Redis Pub/Sub.

Reject unless we already have one of these in production for another
reason. We don't.

### Option 3 — ClickHouse change streams / materialized view with TTL

Use ClickHouse itself as the notification channel. Two sub-variants:

- **MV-based.** A materialized view on `instantml_user_data` writes to a
  short-TTL "notification" table; data-plane instances tail it. ClickHouse
  has no built-in change-feed primitive comparable to Kafka or Postgres
  LISTEN/NOTIFY — the data plane would still have to poll the
  notification table, which is just polling with extra steps.
- **Kafka-engine table.** ClickHouse can act as a Kafka consumer/producer.
  This requires a Kafka cluster, which puts us back in Option 2 territory.

- **Latency.** Same as polling, because there is no push semantic. We'd be
  reducing the polled query cost, which Tier 1 already does.
- **Reliability.** Fine. Same as today.
- **Ops complexity.** Low new infra, but the design adds a table and a
  materialized view that has to be reasoned about in migrations.
- **Build cost.** ~1 day. Cheap.
- **Partial failure.** Same as polling.

This is not actually push. It's polling a different table. Reject — it
solves the wasted-query-cost problem incidentally but doesn't move the
latency floor.

### Option 4 — HTTP webhook

Control plane POSTs `/internal/invalidate` to every known data-plane URL
on every control-record insert.

- **Latency.** Sub-second when it works.
- **Reliability.** The control plane has to know the set of live
  data-plane instances. Cloud Run instances are ephemeral and don't have
  stable URLs unless we expose each instance via a load-balancer
  backend group with NEGs. We'd be reinventing service discovery.
  Alternatively, post to the data-plane service URL and let the LB pick
  one instance — but then only one instance gets invalidated, not all.
  Sticky load-balancer routing makes this worse.
- **Ops complexity.** Service discovery for ephemeral compute is a real
  project. We don't have it.
- **Build cost.** Looks small (a HTTP client + an endpoint), but the
  discovery problem makes the realistic cost ~5+ days and the result
  fragile.
- **Partial failure.** If the control plane can't reach an instance, what
  does it do? Retry? Drop? Both are wrong without a queue.

Reject. We'd be building a worse Pub/Sub.

### Option 5 — Server-sent events from control to data

Each data-plane instance opens a long-lived SSE connection to the control
plane on startup. Control plane streams notifications to all connected
subscribers.

- **Latency.** Sub-second.
- **Reliability.** Connections drop. SSE has a documented reconnect-with-
  `Last-Event-ID` pattern, but we'd be implementing it ourselves on both
  sides, and we'd need the control plane to retain enough history to
  replay across reconnect windows. That history is exactly what Pub/Sub
  gives us for free (7-day default message retention).
- **Ops complexity.** Lower than Option 4 — no service discovery, since
  the data plane initiates the connection. But the control plane now
  holds N long-lived connections; Cloud Run's request-concurrency
  model and connection idle timeouts (currently 60min on the LB,
  configurable but capped) make this awkward. The control plane is
  itself a Cloud Run service that can scale, and SSE fan-out across a
  scaled-out publisher is its own problem.
- **Build cost.** ~3 days for the streaming endpoint, reconnect logic,
  replay buffer, and tests. ~4 days total.
- **Partial failure.** Reconnects work in the happy case. Across a
  control-plane restart, the replay buffer is lost unless persisted to
  ClickHouse, at which point we have rebuilt polling.

Reject in favor of Pub/Sub. SSE makes sense when there's a browser on
one end; with two backend services it's adding work that managed Pub/Sub
already does.

## Recommendation

If we build, build on **GCP Pub/Sub**. It is the only option that
- gets the latency floor below 1s,
- doesn't require us to operate new infrastructure,
- already fits the IAM / egress model we have,
- has built-in retention so the polling fallback doesn't carry the
  reliability load.

The other options either don't actually push (Option 3), require infra we
don't run (Option 2), require service discovery we don't have (Option 4),
or duplicate Pub/Sub's value (Option 5).

## Message Shape

The minimum useful payload is a notification, not the record itself.
Receivers respond by issuing one incremental `load_records` against
ClickHouse using their existing `record_clock_micros` watermark (i.e., the
Tier 1 path). This keeps ClickHouse as the single source of truth and
avoids the "payload too large" or "payload reordered" failure modes.

```json
{
  "type": "control_record_inserted",
  "scope": "global" | "org",
  "kind": "api_key" | "tenant_route" | "session" | "membership" | ...,
  "org_id": "uuid-or-nil",
  "created_at_micros": 1737000000000000
}
```

`created_at_micros` is advisory — used by the receiver to short-circuit if
its watermark is already past that point, so a duplicate or out-of-order
message becomes a no-op.

## Coexistence with Polling

Polling stays. Tier 2's background refresh continues to run, on a longer
cadence (e.g., 30s instead of 5s), as the correctness floor.

| Layer | Cadence | Role |
| --- | --- | --- |
| Push (Pub/Sub) | event-driven, sub-second | Latency win in happy path |
| Background poll (Tier 2) | 30s | Catches missed pushes |
| On-startup full refresh | once per process | Cold-start correctness |
| Request-time refresh (PR #32 path) | throttled to 2s | Retained as belt-and-suspenders for the auth-sensitive paths only, until we trust push fully |

We can remove the request-time refresh from the auth path once Pub/Sub has
been in production for ~2 weeks with no observed propagation issues. The
background poll stays indefinitely; it costs ~2 ClickHouse queries/minute
per data-plane instance, which is negligible after Tier 1.

## Failure Modes

- **Lost message.** Background poll catches it within 30s. Acceptable
  because the polling floor is what we have today.
- **Subscriber crash / restart.** Pub/Sub retains unacked messages on the
  per-instance subscription for up to the retention window (default 7
  days; we'd set it to 10 minutes — anything longer is wasted because the
  full-refresh-on-startup picks up the rest). Replay on reconnect resumes
  from the ack cursor.
- **Slow consumer.** Streaming pull has built-in flow control. If the
  data plane falls behind (very unlikely at the message rate involved —
  control mutations are low-volume), Pub/Sub buffers; if it exceeds the
  retention window, the messages are dropped and the polling floor
  catches up. There is no backpressure on the publisher because we don't
  want auth/signup writes to block on a notification queue.
- **Network partition between data plane and Pub/Sub.** Background poll
  continues to run against ClickHouse. Max staleness = poll cadence
  (30s). Same as Tier 2 alone, just slower than the happy path. When the
  partition heals, Pub/Sub redelivers missed messages.
- **Pub/Sub region outage.** Polling continues. We are no worse off than
  if we hadn't built this.
- **Subscription leak.** Each Cloud Run instance creates a subscription
  on boot. If instances churn, we accumulate dead subscriptions. Mitigate
  with: TTL on subscriptions (Pub/Sub supports `expirationPolicy` — set
  to 1 day), and a periodic cleanup job that deletes subscriptions older
  than N hours with no active subscriber.
- **Publish fails after ClickHouse insert succeeds.** Polling catches it
  on next tick. Not a correctness issue.
- **ClickHouse insert fails after publish succeeds.** The receiver
  queries ClickHouse, finds nothing newer than its watermark, no-ops.
  Not a correctness issue.

This is fault-tolerance only; correctness is owned by the polling floor.

## Out of Scope

- Cross-region consensus. One region for now.
- Cross-cloud failover.
- Solving operational ClickHouse outages.
- Push notifications for tenant data-plane state (run/metric writes
  between hypothetical multi-instance tenant cells). That is a much
  larger problem and is gated on the multi-instance write gate matrix in
  `2026-05-16-multi-instance-control-data-plane.md`.

## Estimated Cost

| Phase | Effort | What |
| --- | --- | --- |
| 0. Tier 1 (in flight) | — | Already covered by separate PR. |
| 1. Tier 2 (in flight) | — | Already covered by separate PR. |
| 2. Pub/Sub publisher | 1 day | Hook into `ControlStore::insert_record`. Best-effort publish; never fail the insert because publish failed. |
| 3. Pub/Sub subscriber | 1.5 days | Per-instance subscription bootstrap, streaming pull loop, ack on apply. |
| 4. Coexistence wiring | 0.5 day | Keep background poll; lengthen its cadence; remove request-time refresh from non-auth paths after a soak period. |
| 5. Tests | 1 day | Unit tests for the notification handler. One integration test that fakes a Pub/Sub message and asserts the receiver fetches and applies the new record. Polling-fallback test (subscriber disabled). |
| 6. Infra setup | 1 day | Topic, IAM, subscription expiration policy, monitoring (publish error rate, subscriber lag), deploy wiring. |
| **Total** | **~5 days** | Plus ongoing Pub/Sub costs (low — at our volume, well under $10/month). |

This is honest. ~5 days of engineering for a feature whose user-visible
effect is "API key revocation lands in 1s instead of 5s" and "tenant
route updates land in 1s instead of 5s."

## Open Question: Build Before or After First Real Customer?

Jay's team is the prototype design partner (see `wiki/people/jay.md` in
the product wiki). The question: do we build Tier 3 before they're on the
hosted product, or wait?

**Recommendation: wait.**

Reasoning:

- Tier 2's 5s propagation is acceptable for every flow we've identified
  except active credential-revocation incident response. Jay's team has
  not asked about revocation latency; they have asked about cost,
  speed-of-UI, and seat sharing. Building Pub/Sub does not move any of
  those.
- The wasted-query-cost concern (issue #4 in the problem statement) is
  real but small. At ~10 data-plane instances × 12 queries/minute = ~120
  qpm. After Tier 1 makes each query cheap, this is rounding error.
- A second customer hasn't been signed yet. We have zero production data
  on whether the 5s propagation tail is ever observed by users.
- The 5-day build cost has a real opportunity cost: it competes with
  features Jay's team has actually asked for (cost transparency,
  faster UI, seat handling).
- The failure mode of *not* building is bounded and recoverable. The
  polling floor is correct; we'd be adding push to reduce p99 latency on
  one specific propagation path. That can be done at any time without
  schema or contract changes.

**Trigger to build:**

- A reported case from Jay's team (or any customer) where stale control
  state caused a visible problem.
- OR, we add a second region (which would push the polling cadence up
  for cross-region reasons and make push more attractive).
- OR, we hit ~50+ data-plane instances and the polling query load on
  ClickHouse becomes measurable.

Until one of those, this design sits as a documented proposal. If one
hits, it's ~5 days of work to bring it online.

## Component Impact

Backend:

- `apps/rust-server/src/control_store.rs`: emit best-effort Pub/Sub
  publish after `insert_record` succeeds. Failures logged, never raised.
- `apps/rust-server/src/store/mod.rs`: subscriber loop owned by `Store`,
  bootstrapped after `rebuild()`. On receipt of a notification, call the
  Tier 1 incremental `refresh_control_records` path.
- Config: `INSTANTML_PUBSUB_PROJECT`, `INSTANTML_PUBSUB_TOPIC`,
  `INSTANTML_PUBSUB_SUBSCRIPTION_PREFIX` (per-instance suffix appended at
  startup). Absent config disables push, retains polling.

Frontend: none.

Python SDK: none.

Storage: none (ClickHouse remains source of truth).

Docs: update `docs/design/README.md`, `apps/rust-server/README.md`.

## Alternatives Considered

Already enumerated under Options. The shortlist of *not implementing*
this at all is also a real option and is the one we recommend until the
trigger condition hits.

## Decision

Not accepted for implementation. Recorded as the agreed-upon design we
will adopt if/when the trigger condition is met. Re-review at that point
to confirm Pub/Sub is still the right choice and that no new constraint
(multi-region, much higher instance count, different cloud) changes the
recommendation.
