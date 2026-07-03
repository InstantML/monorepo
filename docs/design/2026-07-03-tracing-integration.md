# Design: Product Tracing Integration

Date: 2026-07-03

Status: Accepted first slice in implementation

Owner: Codex

## Summary

InstantML currently observes training runs through metrics, rank metrics, rich
objects, artifacts, console logs, checkpoints, rollouts, and run lineage. That
is strong for aggregate experiment tracking, but it does not show the nested
execution path inside an RL pipeline, agent rollout, evaluation harness, reward
function, data generator, or LLM application.

This design adds first-class product traces: nested spans and span events linked
to an existing run. A trace can represent one rollout, one evaluation example,
one training-step data-generation pass, one model call, or one multi-tool agent
turn. Traces are tenant data, not internal server logs. They are captured by the
Python SDK, ingested by the Rust data plane, stored in ClickHouse tables designed
for append-only high-volume event data, and inspected in a new dashboard Traces
workspace plus a compact Run Detail section.

The accepted first slice is native InstantML tracing for Python SDK users, but
it is intentionally narrower than the full product surface:

- SDK `run.trace(...)`, `trace.span(...)`, and `run.trace_op(...)` create nested
  spans. A minimal manual start/finish API supports callback-based frameworks.
  Provider auto-instrumentation remains a follow-up.
- Async queue and process-spool paths replay trace batches with stable
  idempotency keys. Durability is documented per mode instead of promised
  uniformly.
- Rust accepts bounded trace span event batches, dedupes accepted events by
  stable event IDs, records usage from accepted idempotent batches, maintains a
  trace summary projection, and serves paginated summaries plus topology-
  preserving bounded trace views.
- UI lists traces by active project/run and opens one run-scoped trace tree with
  details, timings, reward/token/cost fields, and sanitized previews only when
  users explicitly opt into preview capture.

This design takes inspiration from W&B Weave and Castform without copying either
product boundary. Weave's useful ideas are ops/calls/traces/threads, nested call
trees, trace comparison, trace plots, and linking trace function calls to
training runs. Castform's useful idea is downstream: traces can become training
data for RL or fine-tuning after filtering/deduping. For InstantML, the first
slice is capture and debugging; trace-to-dataset export is designed as a
follow-up so the core trace store is portable enough to support it.

References checked while drafting:

- W&B Weave overview: https://docs.wandb.ai/weave
- W&B Weave ops, calls, traces, threads: https://docs.wandb.ai/weave/guides/tracking/tracing
- W&B Weave trace view: https://docs.wandb.ai/weave/guides/tracking/trace-tree
- W&B Weave training-run integration: https://docs.wandb.ai/weave/guides/tools/weave-in-workspaces
- Castform trace fine-tuning overview: https://castform.com/docs/traces/overview
- Castform environment/rollout model: https://castform.com/docs/environments/overview
- OpenTelemetry traces concepts: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry GenAI semantic conventions repository: https://github.com/open-telemetry/semantic-conventions-genai

## Goals

- Add a production-ready trace data model for nested run-linked spans, including
  RL rollout spans, tool calls, model calls, reward functions, retrieval steps,
  data preprocessing, evaluator calls, and user-defined spans.
- Keep tracing separate from scalar metrics and internal Rust server
  observability logs.
- Make the SDK ergonomic: `run.trace(...)`, `trace.span(...)`,
  `run.trace_op(...)`, minimal manual `start_span`/`finish_span`, and optional
  provider auto-instrumentation later.
- Preserve SDK hot-path safety through batching, async queue integration,
  idempotency keys, bounded local queue size, and opt-in payload capture.
- Store trace event volume in ClickHouse with bounded list/detail read paths and
  a maintained trace summary table.
- Link every trace to an existing run and optionally to step, episode, rollout,
  rank, checkpoint, artifact, dataset row, prompt name/version, and external
  trace identifiers.
- Add a dashboard Traces tab that is useful before any advanced analytics:
  paginated list, filters, tree/timeline/detail view, and Run Detail shortcuts.
- Support export/import later by using a normalized schema that can map to and
  from OpenTelemetry/GenAI span fields without requiring an OTLP endpoint in
  the first slice.
- Add explicit trace event usage accounting rather than silently hiding trace
  cost inside metric points.

## Non-Goals

- Do not add an OpenTelemetry Collector, OTLP receiver, or vendor exporter in
  the first implementation.
- Do not replace the existing Rust request tracing/logging design. Internal
  server logs stay in Cloud Run/stdout; product traces stay in tenant
  ClickHouse data.
- Do not add a general distributed tracing backend for arbitrary microservices.
  The first scope is run-linked ML/agent/RL tracing.
- Do not auto-capture prompts, completions, tool results, environment state, or
  PII by default.
- Do not add deprecated Node server parity for the new trace endpoints.
- Do not make trace data mutable or depend on ClickHouse row updates.
- Do not build trace comparison, trace-to-dataset generation, eval queueing, or
  online scoring in the first slice.
- Do not route artifact bytes through trace ingest. Large trace attachments use
  existing artifact APIs or are truncated until a content-blob design exists.

## Users and Use Cases

RL and agent-training engineers:

- Inspect one failed rollout as a tree: prompt, model call, tool calls, reward
  components, environment transitions, and terminal state.
- Correlate reward collapse at a training step with sampled traces around that
  step.
- Debug reward hacking by opening high-reward and low-reward traces from the
  same run.

LLM fine-tuning engineers:

- Trace data generation and evaluation pipelines without turning every row into
  a loose artifact.
- Link prompt templates, model versions, token counts, cost estimates, and
  scorer outputs to a training run.

Support and platform engineers:

- Ask users for a trace ID or run ID and inspect what the SDK actually logged.
- Distinguish SDK upload failures from application/runtime failures.

Future adoption workflows:

- Export selected traces into JSONL training/eval datasets.
- Import traces from providers such as Braintrust, Langfuse, LangSmith, Weave,
  or OpenTelemetry after a dedicated importer design.

## Requirements

### Functional

- A trace belongs to exactly one InstantML org and run.
- A trace can contain one or more spans. One span is the root when
  `parent_span_id` is absent. Multiple root spans are allowed but flagged.
- Spans can arrive out of order and in multiple batches.
- Spans can be started, updated, finished, or marked interrupted without row
  mutation.
- Detail reads are run-scoped, reconstruct the latest canonical span state for a
  bounded window, and preserve tree context by including roots, ancestors, child
  counts, omitted counts, and orphan metadata.
- List reads return summaries only and never fetch full span payloads.
- Content capture is opt-in, capped, and visibly marked as redacted/truncated.
- SDK trace context works across sync functions and asyncio where Python
  context propagation supports it. Threads, process pools, distributed ranks,
  and data-loader workers require explicit carrier APIs.
- Idempotent replay produces one canonical span outcome, even if a batch is
  submitted more than once.

### Product

- The first UI should feel like a daily debugging surface, not a marketing demo:
  dense trace table, clear filters, a tree/timeline split, and detail panes.
- Trace data must link back to Runs, Metrics, Distributed, Artifacts, and Run
  Detail without duplicating those surfaces.
- RL pipeline concepts should be first-class labels: `rollout`, `env_step`,
  `reward`, `tool`, `model`, `retrieval`, `evaluator`, `dataset`, `custom`.

### Operational

- Trace ingest is a data-plane route and requires the current cell writer lease
  in hosted split mode.
- Trace read routes are data-plane routes and must be bounded.
- Trace events have their own usage counter and limit. API-request limits still
  apply to ingest/read calls.
- Storage estimates include trace table bytes where exact ClickHouse table bytes
  are available.
- All new Rust endpoints use `#[utoipa::path(...)]` and are registered in
  `ApiDoc`; then `npm run codegen:api` regenerates API types.

## Proposed Design

### Architecture Overview

```text
Python SDK
  run.trace(...), trace.span(...), minimal manual span API
  contextvars trace context
  async queue / process spool trace events
  optional OpenTelemetry/GenAI mapper later

        |
        | POST /api/runs/:run_id/traces/events
        v

Rust data API
  validate run/org/project/auth/scope
  validate span graph and payload caps
  check idempotency and trace-event limits
  insert trace span events
  append trace span index rows, accepted batch rows, and summary updates

        |
        v

ClickHouse tenant database
  trace_span_events       high-volume append-only event records
  trace_span_index        span-start/tree index for bounded child reads
  trace_summaries         append-only per-trace summary updates
  trace_ingest_batches    idempotency and usage source of truth

        |
        | GET /api/traces
        | GET /api/runs/:run_id/traces/:trace_id
        | GET /api/runs/:run_id/traces/:trace_id/spans
        v

Next dashboard
  /dashboard/traces trace list
  tree/timeline/detail viewer
  Run Detail recent traces section
```

### Terminology

- Trace: one logical execution tree inside a run, usually a rollout, evaluation
  item, agent turn, or data-generation pass.
- Span: one timed operation in the trace tree.
- Span event record: an append-only ClickHouse row representing a start, update,
  finish, exception, log annotation, or interrupted state for a span.
- Trace summary: a compact list-row projection for one trace, refreshed by the
  server at ingest time.
- Thread/session: future grouping across traces, such as all turns in one agent
  session. First slice stores optional `thread_id` but does not build a thread
  UI.

### Folder Structure

Backend:

```text
apps/rust-server/
  clickhouse/0001_initial.sql
  src/
    domain.rs                         # request/response/schema structs
    trace_store.rs                    # ClickHouse trace event/index/summary IO
    http/
      handlers/traces.rs              # ingest/list/detail/export handlers
      handlers/mod.rs                 # handler exports
      mod.rs                          # route registration
      openapi.rs                      # ApiDoc registration and envelopes
    store/
      traces.rs                       # auth-aware service validation and JSON response assembly
      usage.rs                        # trace_events usage accounting
      trace_summary.rs                # summary delta and repair helpers
```

Python SDK:

```text
packages/python-sdk/instantml/
  tracing.py                          # TraceSpan, TraceRecorder, context manager/manual APIs
  trace_payload.py                    # validation, truncation, redaction, OTel mapping helpers
  async_queue.py                      # add trace event route to allowed async matrix
  uploader.py                         # drain trace events from spool/async queues
  client.py                           # thin Run method shims only
  __init__.py                         # public exports
```

Frontend:

```text
apps/web/app/dashboard/
  traces/
    index.ts
    tab-pane.tsx
    trace-list.tsx
    trace-viewer.tsx
    trace-tree.tsx
    trace-timeline.tsx
    trace-detail.tsx
    trace-filters.tsx
    trace-child-loader.tsx
  detail/
    trace-panel.tsx                   # recent traces for selected run
  dashboard-config.ts                 # Traces nav item
```

Docs/examples:

```text
apps/docs/
  tracing/
    overview.md
    python-sdk.md
    privacy.md

examples/
  rl-tracing/
    README.md
    train.py
```

The implementation should not create subdirectory READMEs unless commands or
ownership differ from the parent README. Component READMEs must be updated.

## Data Flow

### SDK Capture

Users can trace manually:

```python
with run.trace("rollout", kind="rollout", step=step, attributes={"env": "cartpole"}) as trace:
    with trace.span("policy.generate", kind="model", inputs={"obs": obs}, capture="preview"):
        action = policy(obs)

    with trace.span("env.step", kind="env_step", inputs={"action": action}, capture="off") as span:
        obs, reward, done, info = env.step(action)
        span.log_metric("reward", reward)

    with trace.span("reward", kind="reward") as span:
        span.log_metric("dense_reward", reward)
```

Decorators are sugar over the same recorder after the SDK/privacy hardening in
the decorator follow-up slice. They do not auto-capture arguments or returns
unless users opt into bounded preview capture:

```python
@run.trace_op(kind="reward", capture="preview")
def score_rollout(messages, answer):
    return reward_model(messages, answer)
```

Manual start/finish exists for frameworks that already have callback hooks:

```python
span = run.start_span("retriever.search", kind="retrieval", trace_id=trace_id)
try:
    docs = search(query)
    span.finish(output={"doc_count": len(docs)})
except Exception as exc:
    span.finish_error(exc)
    raise
```

Implementation rules:

- Use `contextvars.ContextVar` for current trace/span context.
- Generate trace IDs and span IDs client-side. Use lowercase hex strings
  compatible with OpenTelemetry lengths: 32 hex chars for `trace_id`, 16 hex
  chars for `span_id`.
- Generate `event_id` once per logical event and persist it with the queued
  payload before any upload attempt. Sync retries, SQLite retries, and spool
  replay all reuse the same `event_id`.
- `sequence` is monotonically increasing per `(trace_id, span_id)`. Start is
  `1`; update/annotation/finish/interrupted events must be greater than the
  previous emitted sequence for that span. Canonical reads break rare ties with
  `(created_at,event_id)`.
- Generate one stable `Idempotency-Key` per persisted request body. Async mode
  uses the SQLite queue row ID or durable upload UUID; spool mode uses the
  fsynced request file UUID; sync mode generates a key before the first request
  and reuses it for in-process retries.
- Store optional external identifiers in attributes:
  `external.otel_trace_id`, `external.otel_span_id`,
  `external.provider_trace_id`.
- On span start, enqueue a small `started` record when tracing durability is on.
  On normal exit, enqueue a `finished` record. On exception, enqueue
  `finished` with `status="error"` and a low-cardinality `error_type`.
- If the process exits cleanly with open spans, an `atexit` hook marks them
  `interrupted` best-effort. Hard kills may still lose in-memory spans. The SDK
  must not claim durability until an event has reached SQLite, a fsynced spool
  file, or the server.
- In `upload_mode="async"`, trace events use the existing SQLite queue and
  uploader process. In `upload_mode="spool"`, trace event batches become one
  fsynced JSON request file. In `sync`, `flush()` sends them directly.

Durability matrix:

| Mode/action | Before local persistence | After SQLite/spool persistence | After server accepts | Clean `finish()`/`flush()` | `atexit`/`SIGTERM` | Hard kill |
| --- | --- | --- | --- | --- | --- | --- |
| `sync` | In-memory only; crash loses unsent events. | Not applicable unless caller also enables local queueing. | Durable in ClickHouse subject to retention. | Blocks until accepted or terminal/retryable failure is reported. | Best-effort final flush; may be interrupted by shutdown timeout. | Loses in-memory events. |
| `async` | Producer-buffer events can be lost before SQLite write. | Survives process restart and replays with same event IDs/idempotency key. | Durable in ClickHouse subject to retention. | Waits for queued events to be persisted and, when configured, uploaded. | Best-effort enqueue of `interrupted`; survives only if SQLite write completes. | Loses producer-buffer events, preserves SQLite rows. |
| `spool` | Current batch can be lost before file fsync/rename. | Survives restart and uploader replay with same body/idempotency key. | Durable in ClickHouse subject to retention. | Waits for fsynced request files and optional upload. | Best-effort `interrupted` request file. | Preserves completed spool files only. |

Context propagation matrix:

| Execution boundary | Default support | Required helper for reliable parentage |
| --- | --- | --- |
| Nested sync calls | Yes via `contextvars`. | None. |
| `asyncio` tasks created inside an active trace | Yes for normal task inheritance. | None unless framework suppresses context copying. |
| `asyncio.to_thread` | Usually yes on supported Python versions. | Use `trace.wrap(fn)` if parentage is critical. |
| `ThreadPoolExecutor` / raw `threading.Thread` | No automatic propagation. | `trace.wrap(fn)` or `ctx = trace.context(); run.attach_trace_context(ctx)`. |
| `ProcessPoolExecutor`, multiprocessing, PyTorch DataLoader workers | No automatic propagation. | Serialize `trace.context()` and attach it in the worker. |
| Distributed ranks/jobs | No automatic propagation. | Pass carrier fields (`trace_id`, `parent_span_id`, `thread_id`, `rank`) through the job payload. |

### Server Ingest

`POST /api/runs/:run_id/traces/events` receives a bounded batch:

```json
{
  "events": [
    {
      "trace_id": "7bba9f33312b3dbb8b2c2c62bb7abe2d",
      "span_id": "086e83747d0e381e",
      "parent_span_id": null,
      "event_id": "uuid",
      "sequence": 1,
      "event_kind": "started",
      "name": "rollout",
      "kind": "rollout",
      "status": "running",
      "step": 120,
      "started_at": "2026-07-03T12:00:00Z",
      "ended_at": null,
      "attributes": { "env": "cartpole" },
      "metrics": {},
      "inputs": null,
      "outputs": null,
      "error": null,
      "content_policy": "off",
      "thread_id": null,
      "rollout_id": "episode-120"
    }
  ]
}
```

The server:

1. Authenticates as browser session or bearer API key.
2. Requires `sdk:ingest` for write calls.
3. Loads the run and verifies org/project access.
4. Applies billing/payment/storage readiness/write lease gates.
5. Requires an `Idempotency-Key` for SDK and browser writes. Non-SDK internal
   callers must still provide one unless a separate trusted ingestion design
   says otherwise.
6. Looks up the idempotency key in `trace_ingest_batches`. If the body hash
   matches a previously accepted batch, return the stored response before quota
   checks or writes. If the hash differs, return `409`.
7. Validates every event before the first ClickHouse insert.
8. Checks the monthly trace-event limit using the durable usage rollup. The
   check is a guardrail; the accepted batch row is the usage source of truth.
9. Inserts all event rows into `trace_span_events`. Duplicate rows from a prior
   partial retry are tolerated because every derived read dedupes by stable
   `event_id`.
10. Inserts one row per `started` event into `trace_span_index` for bounded
   root/child window reads. Duplicate started rows are ignored by canonical
   index reads using `event_id`.
11. Appends a `trace_ingest_batches` row with the idempotency key, body hash,
   accepted event IDs, trace IDs, response JSON, billing period, and
   `usage_event_count = uniq(event_id)`.
12. Computes summary revisions for affected trace IDs from deduped accepted
   events and prior canonical state for only affected spans, then appends rows
   into `trace_summaries`.
13. Returns `{ "inserted": N, "trace_ids": [...], "dropped": 0 }`.

No handler should write some events from a batch and then reject later events.
All request validation happens before insert. If an insert after validation
fails, the client retries with the same idempotency key and event IDs. If event
rows were already durable but the batch/summary rows failed, retry can insert
duplicate raw rows; canonical reads, usage, and summary repair dedupe by
`event_id`. Detail reads can still reconstruct from span events; list reads may
temporarily miss the newest summary until retry or worker repair.

### UI Reads

Top-level Traces tab:

- `GET /api/traces?project_id=&run_id=&q=&kind=&status=&from=&to=&limit=&cursor=`
  returns paginated summaries only. The browser supplies the active project by
  default when no run is selected; API callers must provide `project_id` or
  `run_id` in v1.
- The list displays root name, run, project, status, start time, duration,
  span count, error count, model/tool/retrieval counts, reward metrics, token
  totals, and whether content is available/truncated.
- Selecting a row calls
  `GET /api/runs/:run_id/traces/:trace_id?span_limit=500`. Trace IDs are not
  globally unique enough for authorization or efficient ClickHouse seeks.

Trace detail:

- The center pane renders a tree ordered by parent/child and start time.
- A timeline strip shows relative start/end, errors, model/tool/reward spans,
  and long spans for the returned window. A full scrubber is deferred until the
  lazy child endpoint and accessibility behavior are proven.
- The right pane shows safe details for the selected span: attributes, metrics,
  token/cost fields, previews, truncation/redaction state, error, linked
  artifacts, and source run context.
- If a trace has more spans than `span_limit`, the detail endpoint returns a
  topology-preserving partial tree: roots, selected spans, ancestors for
  selected spans, child counts, omitted counts, total canonical span count,
  root count, and orphan count. The UI lazy-loads children with
  `GET /api/runs/:run_id/traces/:trace_id/spans?parent_span_id=...`.

Run Detail:

- Add a compact "Recent traces" local section or panel.
- Fetch only when Run Detail is active and the local Traces section is open.
- Show the latest traces for the selected run and link to
  `/dashboard/traces?run_id=<id>&trace_id=<trace>&span_id=<span>` when a trace
  or span is selected.

## Data Model

### `trace_span_events`

Owner: `apps/rust-server/clickhouse/0001_initial.sql` and
`apps/rust-server/src/trace_store.rs`.

Purpose: append-only tenant trace event storage. A span can have multiple rows.
Detail reads canonicalize only a bounded set of span IDs using
`argMax(..., tuple(sequence, created_at, event_id))`. The route must always
filter by `(org_id, project_id, run_id, trace_id)` so trace ID reuse across runs
cannot merge data or bypass authorization.

```sql
CREATE TABLE IF NOT EXISTS trace_span_events (
    org_id           UUID,
    project_id       UUID,
    run_id           UUID,
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    idempotency_key  String,
    event_id         UUID,
    sequence         UInt64 CODEC(Delta, ZSTD(3)),
    event_kind       LowCardinality(String),
    name             String CODEC(ZSTD(3)),
    kind             LowCardinality(String),
    status           LowCardinality(String),
    step             Nullable(Float64) CODEC(ZSTD(3)),
    rank             Nullable(UInt32) CODEC(Delta, ZSTD(3)),
    thread_id        String CODEC(ZSTD(3)),
    rollout_id       String CODEC(ZSTD(3)),
    started_at       DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    ended_at         Nullable(DateTime64(6, 'UTC')) CODEC(Delta, ZSTD(3)),
    duration_ms      Nullable(Float64) CODEC(ZSTD(3)),
    input_preview    String CODEC(ZSTD(3)),
    output_preview   String CODEC(ZSTD(3)),
    error_type       LowCardinality(String),
    error_preview    String CODEC(ZSTD(3)),
    attributes_json  String CODEC(ZSTD(3)),
    metrics_json     String CODEC(ZSTD(3)),
    links_json       String CODEC(ZSTD(3)),
    content_policy   LowCardinality(String),
    redaction_state  LowCardinality(String),
    truncated        UInt8,
    created_at       DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, project_id, run_id, trace_id, span_id, idempotency_key, sequence, created_at, event_id)
SETTINGS index_granularity = 8192;
```

Notes:

- `parent_span_id`, `thread_id`, and `rollout_id` use empty string when absent
  because ClickHouse `Nullable(String)` complicates query/RowBinary handling.
- `step` and `rank` use `Nullable` because missing numeric values must not be
  confused with `0`.
- `name` is not `LowCardinality` because users may create many function names.
  `kind`, `status`, `event_kind`, and policy fields are low cardinality.
- Field order in Rust `Row` structs must exactly match this schema.
- Duplicate raw rows are possible after partial retries. All read, usage, and
  summary calculations dedupe by stable `event_id`.
- Prompt/completion/tool payloads are previews only in this table. Large raw
  payload storage is deferred.

Bounded canonical state query shape after the handler has selected candidate
span IDs from `trace_span_index`:

```sql
SELECT
  trace_id,
  span_id,
  argMax(parent_span_id, tuple(sequence, created_at, event_id)) AS parent_span_id,
  argMax(name, tuple(sequence, created_at, event_id)) AS name,
  argMax(kind, tuple(sequence, created_at, event_id)) AS kind,
  argMax(status, tuple(sequence, created_at, event_id)) AS status,
  argMax(step, tuple(sequence, created_at, event_id)) AS step,
  min(started_at) AS started_at,
  argMax(ended_at, tuple(sequence, created_at, event_id)) AS ended_at,
  argMax(duration_ms, tuple(sequence, created_at, event_id)) AS duration_ms,
  argMax(attributes_json, tuple(sequence, created_at, event_id)) AS attributes_json,
  argMax(metrics_json, tuple(sequence, created_at, event_id)) AS metrics_json
FROM trace_span_events
WHERE org_id = ?
  AND project_id = ?
  AND run_id = ?
  AND trace_id = ?
  AND span_id IN ?
GROUP BY trace_id, span_id
ORDER BY started_at, span_id
```

The handler must not canonicalize an entire trace and then apply `LIMIT`.
Candidate span IDs come from the tree index first: roots, matching spans,
ancestors, and the visible child window.

### `trace_span_index`

Purpose: one append-only row per span start event for bounded tree navigation.
This table is intentionally small relative to `trace_span_events` because it
has one logical row per span rather than one row per span event. Duplicate
partial retries are tolerated and deduped by `event_id`.

```sql
CREATE TABLE IF NOT EXISTS trace_span_index (
    org_id           UUID,
    project_id       UUID,
    run_id           UUID,
    trace_id         String,
    span_id          String,
    parent_span_id   String,
    idempotency_key  String,
    event_id         UUID,
    name             String CODEC(ZSTD(3)),
    kind             LowCardinality(String),
    step             Nullable(Float64) CODEC(ZSTD(3)),
    rank             Nullable(UInt32) CODEC(Delta, ZSTD(3)),
    thread_id        String CODEC(ZSTD(3)),
    rollout_id       String CODEC(ZSTD(3)),
    started_at       DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    created_at       DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, project_id, run_id, trace_id, parent_span_id, started_at, span_id, event_id)
SETTINGS index_granularity = 8192;
```

Child-window query shape:

```sql
SELECT
  span_id,
  any(parent_span_id) AS parent_span_id,
  min(started_at) AS started_at
FROM trace_span_index
WHERE org_id = ?
  AND project_id = ?
  AND run_id = ?
  AND trace_id = ?
  AND parent_span_id = ?
GROUP BY span_id
ORDER BY started_at, span_id
LIMIT ?
```

The default trace detail response loads root windows plus ancestor paths. The
child expansion route uses the same index query for one `parent_span_id`, then
canonicalizes only the returned span IDs from `trace_span_events`.

### `trace_summaries`

Purpose: compact trace list rows. The server appends a new summary row when it
ingests accepted events for a trace. Reads canonicalize by latest
`(updated_at,event_id)` for each trace. Summaries are a projection and may be
repaired from deduped span events if a partial write occurs.

```sql
CREATE TABLE IF NOT EXISTS trace_summaries (
    org_id              UUID,
    project_id          UUID,
    run_id              UUID,
    trace_id            String,
    event_id            UUID,
    root_span_id        String,
    root_name           String CODEC(ZSTD(3)),
    status              LowCardinality(String),
    kinds               Array(LowCardinality(String)),
    started_at          DateTime64(6, 'UTC') CODEC(Delta, ZSTD(3)),
    ended_at            Nullable(DateTime64(6, 'UTC')) CODEC(Delta, ZSTD(3)),
    duration_ms         Nullable(Float64) CODEC(ZSTD(3)),
    span_count          UInt32 CODEC(Delta, ZSTD(3)),
    running_span_count  UInt32 CODEC(Delta, ZSTD(3)),
    error_count         UInt32 CODEC(Delta, ZSTD(3)),
    model_call_count    UInt32 CODEC(Delta, ZSTD(3)),
    tool_call_count     UInt32 CODEC(Delta, ZSTD(3)),
    retrieval_count     UInt32 CODEC(Delta, ZSTD(3)),
    reward_count        UInt32 CODEC(Delta, ZSTD(3)),
    input_tokens        UInt64 CODEC(Delta, ZSTD(3)),
    output_tokens       UInt64 CODEC(Delta, ZSTD(3)),
    cost_usd            Nullable(Float64) CODEC(ZSTD(3)),
    min_step            Nullable(Float64) CODEC(ZSTD(3)),
    max_step            Nullable(Float64) CODEC(ZSTD(3)),
    thread_id           String CODEC(ZSTD(3)),
    rollout_id          String CODEC(ZSTD(3)),
    summary_metrics_json String CODEC(ZSTD(3)),
    attributes_json     String CODEC(ZSTD(3)),
    content_available   UInt8,
    truncated           UInt8,
    updated_at          DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, project_id, run_id, started_at, trace_id, updated_at, event_id)
SETTINGS index_granularity = 8192;
```

Summary fields are intentionally redundant. This keeps `/api/traces` fast and
prevents trace list views from scanning every span event.

Summary maintenance algorithm:

- Summary updates are cumulative revisions, not blind batch-local deltas.
- The route dedupes the request by `event_id`, then reads the previous latest
  summary row for each touched trace.
- For touched spans only, it reads the previous canonical state and the new
  canonical state. Counters such as `running_span_count`, `error_count`,
  `model_call_count`, token totals, and reward metrics are adjusted by
  `new_state - old_state`.
- `span_count` increments only for newly accepted `started` event IDs. Duplicate
  started events with the same event ID do not change it.
- Trace status is derived from cumulative counters: `error` if any canonical
  span is error, otherwise `running` if any canonical span is running,
  otherwise `interrupted` if all roots are interrupted/stale, otherwise `ok`.
- Root fields come from the earliest root start event in `trace_span_index`;
  multiple roots are allowed and recorded as `root_count` in
  `attributes_json`.
- If any summary insert fails after event insert, the retry or repair helper
  recomputes the latest summary from deduped events and appends a new summary
  revision. List rows are eventually consistent in that failure window; detail
  reads remain authoritative.

### `trace_ingest_batches`

Purpose: durable idempotency record and usage source of truth for trace ingest.
This prevents raw duplicate rows from becoming duplicate usage after partial
ClickHouse failures or SDK replay.

```sql
CREATE TABLE IF NOT EXISTS trace_ingest_batches (
    org_id              UUID,
    project_id          UUID,
    run_id              UUID,
    idempotency_key     String,
    status              LowCardinality(String),
    body_hash           String,
    response_json       String CODEC(ZSTD(3)),
    trace_ids           Array(String),
    event_ids           Array(String),
    usage_event_count   UInt32 CODEC(Delta, ZSTD(3)),
    billing_period      String,
    accepted_at         DateTime64(6, 'UTC') DEFAULT now64(6) CODEC(Delta, ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY billing_period
ORDER BY (org_id, billing_period, run_id, idempotency_key, status, accepted_at)
SETTINGS index_granularity = 8192;
```

Idempotency reads canonicalize by latest `(accepted_at,idempotency_key)` and
require a matching `body_hash`. Monthly usage is derived from accepted batch
rows by `(org_id,billing_period)`, not from raw event table row counts.

### Usage Records

Add usage fields to the existing usage summary/export shapes:

- `trace_events_current_period`
- `trace_events_retained_total`
- `trace_traces_retained_total`
- `trace_spans_retained_total`
- `trace_estimated_metadata_bytes`

Add plan fields:

```text
Free:    100,000 trace events/month
Pro:      50,000,000 trace events/month
Premium: 500,000,000 trace events/month
```

Trace events are blocked at the monthly trace-event limit until paid trace-event
overage exists. This is separate from scalar metric points so users do not see
tracing consume metric quota unexpectedly. API request and storage guardrails
still apply as they do for other writes.

Usage source of truth:

- `trace_events_current_period` is derived from deduped
  `trace_ingest_batches.usage_event_count` for accepted batches in the billing
  period.
- `trace_traces_retained_total` and `trace_spans_retained_total` are summary
  projections and may lag briefly after partial failures; exports must label
  them as projection counts.
- Plan-limit checks happen before event insert using the latest usage rollup
  plus `uniq(event_id)` in the request. The accepted batch row records the
  durable usage after a successful write.
- If event rows insert but the batch row fails, retry with the same
  idempotency key can duplicate raw rows but usage is still recorded once when
  the batch row eventually lands.

## API Contracts

### `POST /api/runs/:run_id/traces/events`

Auth:

- Browser session or bearer API key.
- Requires `sdk:ingest` for API keys.
- Project-scoped keys can ingest traces only for runs in their project.

Headers:

- Required `Idempotency-Key` for SDK and browser writes. SDK async/spool modes
  send one stable key per request file or SQLite event batch. Sync mode sends a
  key for each request and reuses it for in-process retries.

Limits:

- Max 500 events per batch.
- Max 1 MiB JSON request body unless `INSTANTML_MAX_UPLOAD_BODY_BYTES` is lower.
- Max 32 KiB serialized `attributes` per event.
- Max 16 KiB serialized `metrics` per event.
- Max 4 KiB each for `input_preview`, `output_preview`, and `error_preview`.
- Max 512 bytes for `name`, `kind`, `status`, `event_kind`, `thread_id`, and
  `rollout_id`.
- Max 1,000 distinct trace IDs per request is impossible due to 500 event cap,
  but validation should still reject pathological shapes cleanly.

Request:

```json
{
  "events": [
    {
      "trace_id": "32 hex chars",
      "span_id": "16 hex chars",
      "parent_span_id": "16 hex chars or null",
      "event_id": "uuid",
      "sequence": 2,
      "event_kind": "finished",
      "name": "policy.generate",
      "kind": "model",
      "status": "ok",
      "step": 120,
      "rank": null,
      "thread_id": null,
      "rollout_id": "episode-120",
      "started_at": "2026-07-03T12:00:00Z",
      "ended_at": "2026-07-03T12:00:01.200Z",
      "duration_ms": 1200.0,
      "input_preview": "",
      "output_preview": "",
      "error_type": null,
      "error_preview": null,
      "attributes": {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-4.1-mini"
      },
      "metrics": {
        "gen_ai.usage.input_tokens": 120,
        "gen_ai.usage.output_tokens": 64,
        "reward.correctness": 0.75
      },
      "links": [],
      "content_policy": "off",
      "redaction_state": "not_captured",
      "truncated": false
    }
  ]
}
```

Response:

```json
{
  "inserted": 1,
  "trace_ids": ["7bba9f33312b3dbb8b2c2c62bb7abe2d"],
  "summary_updates": 1
}
```

Errors:

- `400 validation_error`: malformed IDs, unsupported status/kind, invalid
  timestamps, negative duration, payload too large, non-object attributes,
  non-finite numeric metrics, too many events.
- `401/403`: auth failure or missing `sdk:ingest`.
- `402 payment_required` or `plan_limit_exceeded`.
- `409`: idempotency key reused with a different request body.
- `429`: short-window rate limit or monthly API request limit.
- `503 warehouse_unavailable`.

### `GET /api/traces`

Query:

- `project_id`: required unless `run_id` is present. Browser callers may omit it
  only when the active dashboard project can be resolved server-side.
- `run_id`: optional exact run.
- `q`: optional prefix/substr search over indexed/promoted summary fields only:
  trace ID, root name, run name, rollout ID, thread ID, span kind, and status.
  Arbitrary attribute search is deferred until fields are promoted or indexed.
- `kind`: optional span/root kind filter.
- `status`: optional `running`, `ok`, `error`, `cancelled`, `interrupted`.
- `from`, `to`: RFC3339 time bounds over `started_at`. If omitted, browser
  callers default to the active project's last 7 days; API callers must provide
  a time bound unless `run_id` is present.
- `min_step`, `max_step`: optional finite step bounds.
- `limit`: default 50, max 200.
- `sort`: default `started_at_desc`. Other sorts are deferred.
- `cursor`: opaque cursor over `(started_at, trace_id, updated_at)`.

Response:

```json
{
  "traces": [
    {
      "trace_id": "7bba9f33312b3dbb8b2c2c62bb7abe2d",
      "run_id": "uuid",
      "project_id": "uuid",
      "project": "cartpole",
      "run_name": "ppo-seed-7",
      "root_name": "rollout",
      "status": "ok",
      "started_at": "2026-07-03T12:00:00Z",
      "ended_at": "2026-07-03T12:00:01.200Z",
      "duration_ms": 1200.0,
      "span_count": 12,
      "error_count": 0,
      "model_call_count": 1,
      "tool_call_count": 2,
      "reward_count": 1,
      "input_tokens": 120,
      "output_tokens": 64,
      "cost_usd": null,
      "min_step": 120,
      "max_step": 120,
      "thread_id": null,
      "rollout_id": "episode-120",
      "summary_metrics": { "reward.correctness": 0.75 },
      "content_available": false,
      "truncated": false,
      "updated_at": "2026-07-03T12:00:02Z"
    }
  ],
  "next_cursor": "opaque",
  "limit": 50
}
```

### `GET /api/runs/:run_id/traces/:trace_id`

Query:

- `span_limit`: default 500, max 1,000 in the first slice.
- `kind`, `status`, `q`: optional detail filters over promoted span fields.
  Matched spans return with roots and ancestors even when those ancestors do not
  match the filter.
- `mode`: optional `tree_window` default. A future `sampled_tree` mode may
  return representative spans across a very large trace.

Response:

```json
{
  "trace": {
    "trace_id": "...",
    "run_id": "...",
    "summary": {},
    "total_span_count": 120000,
    "root_count": 1,
    "orphan_count": 0
  },
  "spans": [
    {
      "trace_id": "...",
      "span_id": "086e83747d0e381e",
      "parent_span_id": null,
      "name": "rollout",
      "kind": "rollout",
      "status": "ok",
      "started_at": "...",
      "ended_at": "...",
      "duration_ms": 1200.0,
      "step": 120,
      "rank": null,
      "attributes": {},
      "metrics": {},
      "input_preview": "",
      "output_preview": "",
      "error": null,
      "content_policy": "off",
      "redaction_state": "not_captured",
      "truncated": false,
      "child_count": 42,
      "returned_child_count": 20,
      "omitted_child_count": 22
    }
  ],
  "limits": {
    "span_limit": 500,
    "max_span_limit": 1000
  },
  "truncated": {
    "spans": false,
    "payloads": false,
    "partial_tree": true
  },
  "root_next_cursor": null
}
```

Authorization:

- Reuse run visibility checks. Missing or unauthorized trace IDs return `404`
  rather than leaking existence across projects/orgs.
- The route is run-scoped because the ClickHouse order key and authorization
  model are `(org_id, project_id, run_id, trace_id)`. Reusing a client-generated
  `trace_id` in another run must never merge detail reads.

### `GET /api/runs/:run_id/traces/:trace_id/spans`

Lazy child expansion for large traces.

Query:

- `parent_span_id`: required. Empty string requests root spans.
- `limit`: default 100, max 500.
- `cursor`: opaque cursor over `(started_at, span_id)`.

Response:

```json
{
  "parent_span_id": "086e83747d0e381e",
  "spans": [],
  "next_cursor": "opaque",
  "child_count": 42,
  "returned": 20,
  "omitted": 22
}
```

The handler first reads child span IDs from `trace_span_index`, then
canonicalizes only those span IDs from `trace_span_events`.

### `GET /api/traces/export`

First implementation can be deferred if needed, but the data model should be
compatible with it. When implemented, it should be selected/bounded only:

- `run_trace_ids`: up to 100 `{ "run_id": "...", "trace_id": "..." }` pairs
  to avoid ambiguity from client-generated trace IDs.
- `format=jsonl`, default.
- Response uses attachment/no-store/nosniff/sandbox headers.

This route is the bridge to future Castform-style trace-to-dataset workflows.

## Python SDK API

Accepted first-slice public surface:

```python
trace = run.trace(name, kind="custom", step=None, attributes=None, capture="off")
span = run.start_span(name, kind="custom", trace_id=None, parent_span_id=None, **fields)
run.finish_span(span, output=None, metrics=None, status="ok")
ctx = trace.context()
run.attach_trace_context(ctx)
wrapped = trace.wrap(fn)
```

Deferred phase-2 sugar:

```python
@run.trace_op(name=None, kind="custom", capture="off")
def fn(...): ...
```

API semantics:

| API | First-slice behavior |
| --- | --- |
| `run.trace(...)` | Creates a new root trace context unless `trace_id` is explicitly provided. Emits a root `started` event on enter and `finished`/`interrupted`/`error` on exit. Does not capture function arguments because it is not a decorator. |
| `trace.span(...)` | Creates a child span under the current trace/span. Supports sync context managers in phase 1; async context manager support can ship in the same phase only if tested. |
| `run.start_span(...)` / `run.finish_span(...)` | Minimal callback-friendly API for frameworks that cannot use context managers. Caller is responsible for pairing calls. |
| `span.log_metric(...)` | Adds trace-local span metrics and selected summary metrics. It does not call `run.log()` or create scalar run metrics unless the user does that separately. |
| `trace.context()` | Returns a JSON-serializable carrier with `trace_id`, current `span_id`, `thread_id`, `run_id`, and optional `rank`. |
| `run.attach_trace_context(ctx)` | Attaches a carrier in another thread/process/rank so child spans keep the intended parent. |
| `trace.wrap(fn)` | Captures the current context with `contextvars.copy_context()` for thread/executor submission. |
| `@run.trace_op(...)` | Decorates sync or async functions as spans, preserves return values and `functools.wraps` metadata, batches by default, inherits only same-run context, and captures argument/return/error previews only under `capture="preview"`. |

Supported `kind` values:

```text
rollout, env_step, model, tool, retrieval, reward, evaluator,
dataset, preprocessing, postprocessing, checkpoint, artifact,
system, custom
```

Capture policy:

- `capture="off"`: default. Capture no inputs or outputs.
- `capture="preview"`: capture bounded string/JSON previews after redaction.
- `capture="full"`: not supported in v1. The SDK should raise a clear
  `ValueError` rather than silently storing a preview under a misleading name.
  Full/raw payload storage needs a separate content-blob design.

Redaction and truncation:

- Redaction runs before SQLite queue writes, spool file writes, logs, and
  network submission. Local queue files are plaintext, so raw secrets must never
  be persisted and docs must warn users about local queue storage.
- Redaction applies to every user-provided string field, not only
  `input_preview`/`output_preview`: attributes, metric string values, links,
  error previews, summary attribute projections, trace/thread/rollout labels,
  and provider metadata.
- Redact common secret keys: `api_key`, `authorization`, `password`, `token`,
  `secret`, `cookie`, `set-cookie`, `x-api-key`.
- Redact bearer-looking and `instantml_`, `sk-`, `ghp_`, `slack`, Stripe-like
  token patterns in previews.
- Truncate previews by bytes, not characters, and preserve valid UTF-8.
- Mark `truncated=true` and include byte counts in attributes.

Field visibility and search policy:

| Field group | List-visible | Detail-visible | Searchable in v1 |
| --- | --- | --- | --- |
| IDs, run/project, status, kind, root name, times, duration | Yes | Yes | Yes for exact/prefix IDs and promoted strings. |
| Trace-local numeric metrics and token/cost totals | Selected summaries only | Yes | No, except future promoted numeric filters. |
| Attributes and links | Selected allowlisted summary fields only | Yes after redaction | No arbitrary JSON search in v1. |
| Input/output/error previews | No | Yes after opt-in capture/redaction | No. |
| Local queue/spool payloads | Not user-facing | Plaintext on disk after redaction | Not searchable. |

SDK backpressure and overhead budgets:

- Default per-process soft cap: 10,000 trace events/second. Over cap, the SDK
  samples or drops low-value `update` events first and preserves start,
  finish, and error events when queue space remains.
- Default max open spans: 10,000 per process. Exceeding it records a local
  warning and drops new non-root spans until spans close.
- Default max spans per trace before sampling warning: 100,000. Users can lower
  this for dense RL environment-step tracing.
- Default trace queue high-water mark: 256 MiB or the existing async queue
  configured max, whichever is lower. Overflow policy defaults to `drop_new`
  for trace events so training loops do not block unexpectedly; `block` and
  `raise` are explicit opt-ins.
- Sampling knobs: `trace_sample_rate`, `trace_sample_by_kind`, and
  `max_spans_per_trace`.
- Terminal failure circuit breaker: after auth, project-scope, payment,
  plan-limit, or validation failure for a run, stop enqueueing new trace events
  for that run until the user calls `run.reset_upload_errors()` or starts a new
  run.
- Benchmark targets before release: `capture="off"` enqueue p95 under 50
  microseconds per span on a developer laptop; `capture="preview"` p95 under
  250 microseconds for a 4 KiB JSON-like payload; no unbounded allocations in
  the hot path.

Async/spool:

- Add trace event batches to the async allowed route matrix.
- Store route path, body, idempotency key, and size in SQLite queue exactly like
  metric/log events.
- Retry transient failures with the same classification as metric/log uploads.
- Treat validation, auth, payment, plan-limit, and project-scope failures as
  terminal.

Interoperability:

- Provide private helpers to map OpenTelemetry/GenAI attributes into the
  normalized event shape.
- Do not auto-patch OpenAI/Anthropic/LangChain in the first implementation.
  That belongs in a separate integration design because auto-capture privacy
  defaults need careful review.

## Frontend UX

### Navigation

Add `Traces` under the Analyze/Operate group near Runs, Metrics, Distributed,
and Compare. The label should be literal. Do not hide tracing inside Run Detail
only, because users need project-level trace triage.

### Traces Tab Layout

Use a dense operational layout:

- Top filter bar: active project, run, status, kind, time, step range, search.
- Left/list area: paginated trace table with compact status and count columns.
- Main viewer: selected trace tree plus accessible timeline strip.
- Right detail pane: selected span details.

Expected controls:

- Search input.
- Status/kind menus.
- Time range menu.
- Icon buttons for refresh, copy trace ID, open run, export selected.
- Toggle for "Tree" and "Timeline" if space is tight.
- No marketing explainer cards.

States:

- Loading skeleton rows for list and viewer.
- Empty state when no traces match filters.
- Partial tree state with total span count, returned span count, omitted child
  counts, and "load more children" controls.
- Unsupported state when backend route returns 404 only for old local servers.
- Error state includes safe `Request <id>` from existing API client behavior.
- Abortable list/detail fetches so stale row selections cannot render an older
  trace after a slower response wins the race.

### Run Detail Integration

Run Detail gets a local `Traces` section:

- Fetch `GET /api/traces?run_id=<id>&limit=20` only when opened.
- Render recent traces with status/duration/reward/error summary.
- Deep-link to the full Traces tab with `run_id`, `trace_id`, and optional
  `span_id` so support/debug URLs reproduce the exact context.

### Accessibility

- Trace tree uses ARIA tree or nested-list semantics with `aria-expanded`,
  `aria-selected`, visible focus, and roving tabindex.
- Keyboard behavior: arrow keys move through visible nodes, right/left expand
  and collapse, Home/End jump to first/last visible node, Enter selects.
- Tree/timeline hover data has focus equivalents and screen-reader text.
- Timeline data has an accessible table/text fallback; no required information
  is canvas-only.
- Span detail pane uses a predictable heading hierarchy and tables/lists for
  attribute and metric values.
- Error content and previews are text, not canvas-only.

## Edge Cases and Error Handling

- Out-of-order events: detail reads canonicalize latest event by per-span
  `sequence`, then `created_at`, then `event_id`; summary updates are
  append-only projections and can be repaired from deduped raw events.
- Duplicate replay: request idempotency returns the stored inserted count when
  body hash matches; canonical reads, summaries, and usage dedupe by stable
  `event_id`, not by raw ClickHouse row count.
- Missing idempotency key: reject write requests with `400 validation_error`.
  Silent non-idempotent ingest is not allowed in v1.
- Trace ID reused across runs: allowed because trace IDs are client-generated,
  but every detail/list query is scoped by run/project/org. Reuse within the
  same run is treated as the same trace.
- Conflicting span IDs: same `(trace_id, span_id)` with a different parent/name
  is accepted as a later update but flagged with
  `attributes.instantml.conflict=true` in summary repair if detected. SDK should
  never generate this.
- Parent missing: render span in an orphan group, include `orphan_count`, and
  mark trace summary `attributes.instantml.orphan_span_count`.
- Cycles: server rejects a single batch that contains an obvious parent cycle;
  detail view breaks cycles defensively if old/out-of-order events create one.
- Multiple roots: allowed; summary picks earliest root and records
  `root_count`.
- End before start: reject if both timestamps are present and duration would be
  negative beyond a small clock-skew tolerance.
- Client clock skew: accept timestamps within a wide range, but if
  `ended_at < started_at`, use server validation above. Store server
  `created_at` separately.
- Long-running spans: start events can make a trace visible as `running`;
  stale running spans older than a configurable threshold render as stale, not
  failed. A worker may append `interrupted` summaries later only after a design
  for stale-span repair.
- Process crash: queued start events survive async/spool; unqueued in-memory
  spans may be lost on hard kill. SDK docs must say this plainly.
- Partial server write: validation occurs before insert. If event insert
  succeeds but batch/summary append fails, retry with the same idempotency key
  may insert duplicate raw rows; `event_id` dedupe prevents duplicate canonical
  state, usage, and summary counts. Detail can reconstruct from events.
- Warehouse unavailable: return `503 warehouse_unavailable`; SDK retries.
- Plan limit: return `402 plan_limit_exceeded`; SDK marks queued trace events
  failed and exposes them in upload status.
- Payload too large: SDK truncates before sending; server rejects oversize
  payloads that bypass SDK.
- Sensitive payloads: default capture is off; redaction applies before local
  persistence and network send, but it is not a compliance guarantee. Docs must
  warn users that SQLite/spool queues are plaintext after redaction.
- Binary payloads: previews show type/size/hash only.
- Huge trace tree: list remains summary-only; detail returns a topology-
  preserving partial tree and lazy child expansion. UI never tries to render
  more than the returned cap and must show omitted counts honestly.
- High-cardinality names: names are stored but not indexed globally in v1; search
  is bounded to selected project/run/time windows.
- Deleted run/project: project delete semantics must remove traces from the
  projection/list by filtering to existing visible runs or by future tombstone
  design. Physical ClickHouse rows remain until retention/compaction.
- Demo workspace: read-only demo sessions can read demo traces but cannot
  ingest.
- Browser session writes: allowed only if existing product write rules allow
  browser-origin run mutation; ordinary SDK ingest remains bearer-key primary.
- Split service plane: routes are data-plane only. Control-only services must
  not expose trace product routes.
- BYOC: trace tables live in the customer-owned tenant ClickHouse database just
  like metrics; InstantML storage guardrails count only InstantML-owned
  artifacts for BYOC, but trace event plan limits still apply.
- Import/export: external trace provider import is deferred; native export
  should include enough fields to build training examples later.

## Performance Considerations

Expected volumes:

- Small RL run: 1,000 to 100,000 spans.
- Serious agent/RL training run: millions of span events if every tool/model
  step is traced.
- Trace list action: tens to hundreds of summary rows.
- Trace detail action: one trace, default 500 canonical spans plus roots,
  ancestors, child counts, and omitted counts.

Write path:

- SDK batches up to 500 trace events or 512 KiB before submit.
- Async queue group commit should reuse existing 64-event/64 KiB/20 ms producer
  batching policy where practical.
- Rust inserts batch rows into ClickHouse with one insert per table.
- Summary append is O(number of touched spans and trace IDs in the request),
  not O(project size). Full recompute is reserved for repair jobs.
- SDK hot path must enforce the local event-rate, queue-byte, open-span,
  per-trace-span, sampling, overflow, and terminal-failure circuit-breaker
  policies listed in the SDK section.

Read path:

- `/api/traces` reads `trace_summaries`, not `trace_span_events`.
- `/api/runs/:run_id/traces/:trace_id` first reads candidate span IDs from
  `trace_span_index`, then canonicalizes only those span IDs from
  `trace_span_events`. It must never group the entire trace and apply a response
  limit afterward.
- The child expansion route filters by exact parent in `trace_span_index` and
  canonicalizes only the returned child IDs.
- UI hidden tabs do not fetch traces.
- Run Detail fetches traces only when the local section is open.

Indexes/order:

- `trace_span_events` is ordered for exact trace detail and run-scoped reads.
- `trace_span_index` is ordered for exact root/child window reads.
- `trace_summaries` is ordered for org/project/run/time list filters.
- Do not use `FINAL`.
- Avoid JSON-field filtering in ClickHouse v1 except bounded post-filtering on
  returned summaries. Promote fields only after repeated query use.

Latency targets:

- Trace ingest p95 under 250 ms for a 500-event batch on local ClickHouse.
- Trace list p95 under 200 ms for a project with 1M traces when filtered to the
  active project, recent time window, newest sort, and limit 50. Broad
  cross-project unbounded reads are not supported in v1.
- Trace detail p95 under 300 ms for a 500-span topology-preserving window.
- Trace child expansion p95 under 150 ms for 100 children.

Benchmark plan:

- Add `npm run benchmark:traces` seeded with 100k traces and 10M span events
  in disposable ClickHouse.
- Measure ingest, list by run/time/status, detail windows for 100/500/1,000
  spans, child expansion windows, and production web first useful render for
  the Traces tab.
- Measure SDK hot-path overhead for `capture="off"`, `capture="preview"`,
  async queue overflow, and spool fsync behavior.

## Simplicity Review

This is the simplest useful production tracing slice because it:

- Reuses the existing run/project/org/security model.
- Reuses existing SDK upload durability instead of inventing streaming.
- Stores append-only events in ClickHouse, matching current storage direction.
- Adds a small span-start index so detail reads are bounded by tree windows.
- Adds a summary table so list views stay fast and a batch table so idempotency
  and usage have a clear source of truth.
- Keeps decorators, auto-instrumentation, OTLP, trace comparison, broad search,
  full timeline scrubbers, export UI, and dataset generation out of the first
  slice.
- Defaults content capture off, which keeps privacy and payload size tractable.

Complexity intentionally deferred:

- OTLP receiver and collector integration.
- Full prompt/completion blob storage.
- Automatic OpenAI/Anthropic/LangChain instrumentation.
- Trace comparison UI.
- Trace-to-dataset generation and filter pipelines.
- Server-side stale-running-span repair.
- Retention policy UI.
- Materialized aggregate tables for trace analytics beyond summaries.

## Testing Plan

Backend tests:

- Schema migration applies idempotently.
- Ingest validates malformed trace/span IDs, invalid parent IDs, invalid kinds,
  invalid statuses, invalid timestamps, non-finite metrics, oversize payloads,
  and too many events.
- Ingest enforces run access, project-scoped API keys, demo read-only behavior,
  payment gates, storage readiness, trace event usage limits, API short-window
  rate limits, and writer lease.
- Ingest rejects missing idempotency keys and reuses stable responses for
  matching idempotency/body hashes before quota checks.
- Idempotency returns same response for same body and `409` for different body.
- Duplicate span events canonicalize correctly in detail reads.
- Duplicate raw rows do not double-count monthly trace-event usage.
- Out-of-order start/finish events reconstruct correctly.
- Summary list returns latest summary, paginates by cursor, and uses safe
  project/run/time defaults.
- Detail read is run-scoped and hides unauthorized trace IDs as 404.
- Detail and child expansion read bounded span windows without grouping the
  entire trace.
- Summary insert failure path is retryable or covered by a repair helper using
  deduped event IDs.

SDK tests:

- Context manager records start/finish/error events.
- Manual start/finish records paired events and reports unclosed spans.
- Deferred decorator tests are added only when decorator support is implemented.
- Context propagation works for nested sync and async calls.
- Explicit carrier helpers preserve parentage across thread/process simulation.
- Capture policies off/preview produce expected previews and redactions;
  `capture="full"` raises a clear unsupported-value error in v1.
- Oversize previews truncate by bytes and remain valid UTF-8.
- Async queue and process spool write replayable trace event requests with
  stable idempotency keys.
- Durability matrix behavior is covered for sync, async, spool, `flush()`,
  `finish()`, `atexit`, terminal failures, and pre-persistence loss.
- Backpressure covers event-rate limits, queue-byte limits, sampling/drop
  policy, max open spans, and terminal-failure circuit breaker.
- Upload status reports terminal trace event failures.
- Existing `log`, `log_metrics`, rank metrics, console, artifact, and finish
  behavior remains unchanged.

Frontend tests:

- Traces tab loading/empty/error/populated states.
- Filters update the API query without fetching hidden tab data.
- Trace list pagination and row selection.
- Tree keyboard navigation and detail pane rendering.
- Large/truncated trace displays honest truncation metadata.
- Lazy child expansion preserves root/ancestor context and does not orphan
  matching spans without explanation.
- Run Detail fetches recent traces only when opened.
- Deep links with `run_id`, `trace_id`, and `span_id` select the intended trace
  after refresh.
- 404 unsupported backend fallback behaves like current rich object fallback.
- No raw token-like values appear in frontend console logs.

Integration/smoke:

- Python SDK creates a run, logs metrics, records a rollout trace, flushes, and
  the Rust API returns the trace list/detail.
- UI smoke opens Traces, selects a trace, and verifies tree/detail content.
- Hosted ClickHouse smoke covers trace ingest and read after data-plane restart.

Coverage:

- New first-party logic should have meaningful tests. Any coverage exception
  must be documented in component READMEs before implementation is accepted.

## Documentation Plan

Implementation must update:

- `README.md`: current status and commands.
- `PRODUCT_STRATEGY.md`: tracing as a training/RL/agent debugging capability if
  this becomes accepted direction.
- `apps/rust-server/README.md`: routes, schema tables, usage limits, testing.
- `apps/rust-server/src/store/README.md`: trace store responsibilities if
  needed.
- `packages/python-sdk/README.md`: public tracing API, privacy defaults,
  async/spool behavior, examples.
- `apps/web/README.md`: Traces tab behavior and testing expectations.
- `docs/architecture/current-api.md`: trace endpoints and limits.
- `docs/architecture/current-schemas.md`: trace tables and usage fields.
- `apps/docs/tracing/*.md`: user-facing docs for tracing and privacy.
- `examples/README.md` and new `examples/rl-tracing/README.md`.

## Alternatives Considered

### Store traces as rich objects

Rejected. Rich objects are run-scoped evidence items with preview rows/media.
Traces need hierarchical timing, high-volume spans, fast summary list views, and
dedupe semantics. Stuffing traces into attributes would make Run Detail and
object APIs fan out badly.

### Store traces as scalar metrics

Rejected. Metrics do not represent parent/child relationships, content previews,
errors, or tool/model metadata. This would also pollute metric catalogs.

### Add OTLP receiver first

Rejected for the first slice. OTLP is useful for interoperability, but it
introduces protobuf/HTTP/gRPC compatibility, collector docs, resource/span
mapping, sampling semantics, and privacy defaults before InstantML has a native
viewer. Native JSON ingest is smaller and can still map to OTel fields.

### Store one final row per span only

Rejected. It is simple, but hard crashes and long-running rollouts lose too much
debugging value. Append-only start/update/finish events preserve partial traces
without ClickHouse mutation.

### Use ReplacingMergeTree for span updates

Rejected for the first slice. The current ClickHouse style avoids `FINAL` and
uses explicit append plus read-time canonicalization. Keeping that pattern is
more consistent with the rest of the repo.

### Make trace events count as metric points

Rejected. It is operationally easy but surprising for users. Traces should have
their own usage field and pricing guardrail.

## Implementation Plan

### Accepted First Slice

Build now:

- Run-scoped native JSON ingest:
  `POST /api/runs/:run_id/traces/events`.
- Project/run trace list with safe defaults:
  `GET /api/traces` requiring `project_id`, `run_id`, or active dashboard
  project. Project-scoped lists default to a recent time window; run-scoped
  lists return all traces for the run unless `from`/`to` is supplied.
- Run-scoped trace detail and lazy child expansion:
  `GET /api/runs/:run_id/traces/:trace_id` and
  `GET /api/runs/:run_id/traces/:trace_id/spans`.
- ClickHouse `trace_span_events`, `trace_span_index`, `trace_summaries`, and
  `trace_ingest_batches`.
- Python SDK context-manager tracing, minimal manual span API, carrier helpers,
  preview/off capture, async/spool replay, idempotency, durability docs, and
  local backpressure.
- Dashboard Traces tab with paginated list, topology-preserving partial tree,
  child expansion, span detail pane, accessible timeline strip, and exact
  deep-links.
- Backend, SDK, frontend, integration, and benchmark coverage listed above.

Defer:

- Decorators, provider auto-instrumentation, OTLP receiver/exporter, broad JSON
  attribute search, export UI, full timeline scrubber, sampled-tree analytics,
  trace comparison, trace-to-dataset workflows, stale-span repair workers, and
  Run Detail panel if exact deep-linking is not ready.

Phase 0: design review

- Land this design doc as draft.
- Get at least three fresh reviews: storage/API, SDK/privacy, frontend/product.
- Revise before code.

Phase 1: backend storage and API

- Add ClickHouse tables and Row structs for `trace_span_events`,
  `trace_span_index`, `trace_summaries`, and `trace_ingest_batches`.
- Add `trace_store.rs` with insert, idempotency, usage, list, detail-window,
  and child-window helpers.
- Add domain request/response structs and validation constants.
- Add `store/traces.rs` service functions.
- Add handlers and data routes.
- Add OpenAPI annotations and regenerate API artifacts.
- Add usage fields and trace event plan limits.
- Add backend tests and benchmark seed helper.

Phase 2: Python SDK

- Add tracing module and public exports for context-manager and minimal manual
  APIs.
- Add Run shims in `client.py`.
- Add capture policy/redaction/truncation helpers.
- Add context carrier/wrap helpers.
- Add trace event route to async queue and process uploader.
- Add tests for sync, async, spool, durability matrix, backpressure, errors,
  privacy, and replay.
- Add an RL trace example.

Phase 3: frontend

- Add generated API types.
- Add dashboard config/nav item.
- Add Traces tab list, topology-preserving tree window, child expansion, detail
  pane, and accessible timeline strip.
- Add Run Detail recent traces rows only if it can deep-link exactly to
  `run_id + trace_id`; otherwise defer the panel.
- Add component/integration tests and UI smoke.
- Browser-test desktop/mobile layout and ensure large trees do not overlap.

Phase 4: docs and verification

- Update READMEs, architecture docs, public docs, and examples.
- Run relevant suites:
  - `npm run rust:fmt`
  - `npm run rust:lint`
  - `npm run rust:test`
  - `npm run codegen:api`
  - `npm run verify:api-types`
  - `npm run test:python`
  - `npm run test:rust:sdk`
  - `npm run test:ui`
  - `npm run benchmark:traces` once added

Phase 5: follow-ups

- OpenTelemetry import/export bridge.
- Auto-instrumentation for OpenAI/Anthropic/LangChain/LlamaIndex.
- Trace comparison and trace plots.
- Trace-to-dataset/export workflows inspired by Castform.
- Stale running span repair worker.
- Trace retention controls and trace storage usage breakdown.
- Broad attribute search after fields are promoted/indexed.
- Full timeline scrubber and sampled-tree exploration for very large traces.

## Decorator Follow-up Slice

Date: 2026-07-03

Status: Accepted narrow slice after fresh SDK/privacy, delivery, and testing
reviews. Implementation must include the hardening items below before the
decorator API is considered shippable.

The next SDK ergonomics slice adds `Run.trace_op(...)`, a decorator factory for
instrumenting reward functions, evaluator functions, model calls, data
preprocessing helpers, and agent tools without manually opening a `with
run.start_span(...)` block around every function body.

This is intentionally sugar over the accepted native trace recorder. It does
not add provider auto-instrumentation, monkeypatching, global decorators, OTLP
bridges, or full argument capture by default.

### Requirements

- `@run.trace_op(...)` returns a decorator that preserves `functools.wraps`
  metadata and traces each function invocation as one span.
- The span is a child of the current trace/span only when the current context
  belongs to the same `Run`. Cross-run carriers are rejected on attach and are
  not inherited implicitly.
- If no same-run context exists, the decorator creates a run-linked root span
  but does not flush on every invocation; normal `flush()`/`finish()` batching
  drains the trace events.
- An explicit `trace_id` suppresses implicit parent inheritance unless the
  caller also passes an explicit `parent_span_id`.
- `capture="off"` remains the default and captures no argument, return, or
  exception-message preview. Capture-off exceptions store only the
  low-cardinality error type.
- `capture="preview"` captures a bounded preview of call arguments and return
  value using best-effort serialization, secret redaction, truncation, and
  redaction-state logic. Instrumentation preview failures must never change the
  decorated function's return value or mask its original exception.
- Exceptions mark the span as `error`, record a low-cardinality error type plus
  bounded preview only when `capture="preview"`, and re-raise the original
  exception.
- Decorated functions work in sync code, coroutine functions, and inside
  already-active trace context.
- The API supports explicit metadata: `name`, `kind`, `step`, `rank`,
  `thread_id`, `rollout_id`, `attributes`, `metrics`, `links`, `capture`,
  `trace_id`, and `parent_span_id`. Decorator-level static `span_id` is not
  supported because repeated calls must create independent span identities.

### API Design

```python
@run.trace_op(kind="reward", capture="preview", attributes={"phase": "eval"})
def score_rollout(messages, answer):
    return reward_model(messages, answer)

@run.trace_op(name="policy.forward", kind="model", capture="off")
def forward(obs):
    return policy(obs)
```

The decorator factory lives on `Run` because it needs a concrete run ID and the
run's configured delivery mode. The implementation delegates to a helper in
`instantml.tracing` so the core tracing module owns argument-preview and
exception semantics.

### Data Flow

```text
decorated function call
  -> build one TraceSpan with current context inheritance
  -> start event emitted before user code
  -> user code executes
  -> finished/exception event emitted with bounded previews
  -> existing trace batcher handles sync, async queue, spool, or offline replay
```

No new server endpoint, ClickHouse table, UI contract, or OpenAPI type is
required.

### Edge Cases

- Non-JSON-serializable arguments under `capture="preview"` stringify through a
  best-effort preview path rather than failing the training loop.
- Secret-looking keys and token-like strings are redacted from previews,
  attributes, metrics, links, labels, and error previews before local
  SQLite/spool persistence or network submission.
- Oversized argument/return previews are truncated to the existing trace preview
  limit and marked `redaction_state="truncated"`.
- Invalid static decorator metadata, such as a malformed `kind`, invalid trace
  ID, or oversized attributes, raises before entering user code. That mirrors
  existing foreground SDK validation; async upload mode only warn-drops payloads
  that become invalid while building emitted events.
- Return values are passed through unchanged.
- Re-entrant calls create independent child spans and independent event IDs.
- Explicit `parent_span_id` or `trace_id` overrides current context only when
  the caller passes them, matching `run.start_span`.
- The decorator never auto-flushes individual calls by default, including root
  calls. Users can still call `run.flush()` or `run.finish()` to drain events.

### Tests

- SDK unit test: sync decorated function emits started/finished events, returns
  the original value, preserves function metadata, and captures bounded argument
  and output previews only when requested.
- SDK unit test: decorated function inside `run.trace(...)` becomes a child span
  of the active trace.
- SDK unit test: exceptions create an `exception` event with status `error` and
  re-raise the original exception without emitting a false success event or
  leaking exception text under `capture="off"`.
- SDK unit test: coroutine functions are traced across `await`, including
  return previews and awaited exceptions.
- SDK unit test: cross-run context is ignored/rejected, explicit trace IDs do
  not inherit mismatched parents, and decorator calls do not accept static
  `span_id`.
- SDK unit test: metadata round-trips, secret redaction, non-finite/cyclic
  preview values, re-entrant calls, sync/async queue, process spool, and offline
  replay all use the existing trace batch path and stable idempotency keys.
- Real end-to-end smoke: a short Python script against the Rust/ClickHouse
  service uses `@run.trace_op` on a realistic RL/evaluator flow, then API and
  Chrome/Computer-Use UI validation verify the decorator trace is visible in Run
  Detail and the full Traces workspace.

### Performance Notes

- With `capture="off"`, the decorator adds only span ID generation, two small
  event records, contextvar access, and existing queue/batch work around the
  user function.
- Argument and return serialization happens only for explicit
  `capture="preview"`.
- No additional browser reads or trace list fan-out are introduced.

### Out of Scope

- Auto-instrumentation for OpenAI, Anthropic, LangChain, LlamaIndex, HTTP
  clients, database clients, or arbitrary frameworks.
- Global decorators detached from a `Run` instance.
- Provider semantic mapping beyond existing user-supplied attributes and
  metrics.
- Trace-to-dataset generation.

## Review Notes

Fresh reviewer 1: storage/API

- Finding: Trace identity and detail reads were under-scoped because
  client-generated `trace_id` was read by org only, while ClickHouse keys are
  run/project scoped.
- Risk: Reused trace IDs across runs could merge spans or leak authorization
  state, and queries could not seek efficiently.
- Decision: Detail and child routes are now run-scoped:
  `GET /api/runs/:run_id/traces/:trace_id` and
  `GET /api/runs/:run_id/traces/:trace_id/spans`.

- Finding: The original detail query applied `LIMIT` after `GROUP BY`.
- Risk: Large traces would still canonicalize the whole trace before returning
  a small response.
- Decision: Added `trace_span_index` and required two-stage detail reads:
  select bounded root/child/ancestor span IDs first, then canonicalize only
  those IDs.

- Finding: Summary maintenance, idempotency, and usage accounting lacked a
  durable source of truth.
- Risk: Partial ClickHouse failures and duplicate replay could double-count
  usage or produce incorrect summary counters.
- Decision: Added stable `event_id` rules, required idempotency keys, added
  `trace_ingest_batches` as the usage/idempotency source of truth, and made
  summary revisions dedupe by event ID with repair from raw events.

Fresh reviewer 2: SDK/privacy

- Finding: Async durability language was too optimistic.
- Risk: Producer-buffer events can be lost before SQLite or spool persistence.
- Decision: Added a mode-by-mode durability matrix for `sync`, `async`,
  `spool`, `flush()`, `finish()`, `atexit`/`SIGTERM`, and hard kill.

- Finding: SDK overhead and backpressure were not bounded.
- Risk: RL environment-step tracing can slow training loops or fill disk.
- Decision: Added local caps for event rate, queue bytes, open spans,
  spans-per-trace, overflow behavior, sampling knobs, terminal-failure circuit
  breaker, and benchmark targets.

- Finding: Privacy/redaction scope was too narrow, and local queues are
  plaintext after serialization.
- Risk: Attributes, links, summary fields, and queue files could retain secrets
  even when previews are off or redacted.
- Decision: Redaction now happens before local persistence and applies to all
  user-provided string fields. Added field visibility/search policy and
  explicit plaintext local queue docs.

- Finding: Context propagation promises exceeded what `contextvars` can
  provide.
- Risk: Thread pools, process pools, data-loader workers, and distributed ranks
  could create orphaned spans.
- Decision: Added propagation support matrix and carrier/helper APIs:
  `trace.context()`, `run.attach_trace_context(...)`, and `trace.wrap(fn)`.

- Finding: API semantics around decorators, `capture="full"`, and
  `span.log_metric()` were ambiguous.
- Risk: Users could misunderstand whether decorators create traces or spans,
  whether args/returns are captured, or whether trace metrics are run metrics.
- Decision: Decorators were deferred from the first slice until the accepted
  SDK decorator/privacy follow-up; `capture="full"` remains unsupported in v1,
  and `span.log_metric()` is explicitly trace-local.

Fresh reviewer 3: frontend/product/performance

- Finding: Large trace detail responses could render misleading partial trees.
- Risk: Returning arbitrary first spans can omit roots, ancestors, siblings, or
  context for filtered matches.
- Decision: Detail responses are topology-preserving and include roots,
  ancestors, child counts, omitted counts, total span count, root count, orphan
  count, and child-expansion cursors.

- Finding: The first slice was too broad.
- Risk: Backend storage, usage, SDK durability, full Traces workspace,
  timelines, export, decorators, and Run Detail integration would couple too
  many failure modes before the core store is proven.
- Decision: Added an explicit accepted first slice and deferred decorators,
  broad search, export UI, full timeline scrubber, sampled trees, advanced
  analytics, provider auto-instrumentation, and optional Run Detail panel work.

- Finding: List filtering defaults and search over arbitrary attributes were
  under-bounded.
- Risk: First load could be noisy or slow for large projects.
- Decision: `GET /api/traces` now requires project/run context or active
  project defaults, defaults to recent time windows and `limit=50`, and limits
  v1 search to promoted summary fields.

- Finding: Run Detail links and async viewer loads could lose exact context.
- Risk: Users would have to re-find traces, and stale responses could show the
  wrong selection.
- Decision: Deep-links include `run_id`, `trace_id`, and optional `span_id`;
  frontend implementation must use abortable list/detail loads.

- Finding: Accessibility criteria were not testable enough for a tree/timeline
  inspector.
- Risk: The core viewer could become mouse-only or canvas-only.
- Decision: Added ARIA tree/nested-list semantics, roving tabindex, keyboard
  behavior, visible focus, hover focus equivalents, and timeline table/text
  fallback requirements.

Decorator follow-up fresh reviews:

- Finding: Cross-run trace context could bleed into decorated spans.
- Risk: A function decorated on one `Run` and called inside another run's active
  trace could persist mismatched `trace_id` and `parent_span_id` values.
- Decision: `TraceSpan` now inherits only same-run context, explicit `trace_id`
  suppresses implicit parent inheritance, and `attach_trace_context` rejects
  carriers for a different run.

- Finding: Decorators make accidental capture much easier, while the SDK's
  preview/redaction path was incomplete.
- Risk: Arguments, return values, exception messages, attributes, links, or
  local queue/spool payloads could retain secrets.
- Decision: `capture="off"` stores no argument, return, or exception-message
  preview; `capture="preview"` uses best-effort serialization, redacts
  secret-looking keys and token-like strings before persistence, and truncates
  by bytes before submission.

- Finding: A static decorator `span_id` conflicts with one independent span per
  call, and root decorator calls would flush once per function invocation.
- Risk: Repeated calls could collapse into one canonical span or overload hot
  RL loops with one request/spool file per decorated call.
- Decision: `trace_op` does not accept static `span_id`, supports sync and
  coroutine functions explicitly, and never auto-flushes individual decorated
  calls by default.

- Finding: Existing real smokes did not prove the decorator path.
- Risk: Direct API-seeded traces could pass while the Python SDK decorator was
  broken.
- Decision: The Rust SDK smoke now uses `@run.trace_op` in an RL/reward-style
  trace and reads the resulting decorator span back through Rust/ClickHouse
  trace APIs.

## Coverage Exceptions

None expected. If full meaningful first-party coverage is temporarily
unreasonable, document the exception in the relevant component README and this
section before implementation is accepted.

## Implementation Progress

2026-07-03 first implementation slice:

- Added the Rust/ClickHouse ingest and read surface for native traces:
  `POST /api/runs/{run_id}/traces/events`, `GET /api/traces`,
  `GET /api/runs/{run_id}/traces/{trace_id}`, and
  `GET /api/runs/{run_id}/traces/{trace_id}/spans`.
- Added append-only ClickHouse tables for span events, span topology index,
  trace summaries, and idempotent trace batches. Hot trace rows carry the
  ingest idempotency key, reads only surface rows with an accepted batch marker,
  and usage accounting is monthly over accepted `(run_id, idempotency_key)`
  batches.
- Added validation for bounded batches, lowercase trace/span ids, event kinds,
  span kinds, statuses, finite timing fields, parent-cycle detection, preview
  content policy, JSON payload sizes, required ingest idempotency keys, and
  project/run auth scope.
- Added the Python SDK tracing API: `run.trace(...)`,
  `run.start_span(...)`, `trace.span(...)`, `span.finish(...)`,
  `span.set_output(...)`, `span.log_metric(...)`, `trace.context()`,
  `run.attach_trace_context(...)`, and `trace.wrap(fn)`. Capture defaults to
  `off`; `preview` capture is bounded and serialized before enqueueing.
- Added trace batch delivery through sync flush, async SQLite queue, process
  spool, and offline JSONL replay while preserving stable request idempotency
  keys.
- Added the React Traces dashboard tab with run/status/kind/search filters,
  paginated trace summaries, run-scoped detail loading, stale-response guards,
  deep links by `run_id`/`trace_id`/`span_id`, and lazy child-span expansion.
- Added OpenAPI registrations, generated TypeScript API contracts, and updated
  product/API/schema/SDK/web/store docs. Focused Rust, SDK, and frontend tests
  cover trace validation/cursors, usage behavior, OpenAPI route presence, SDK
  durability paths, and Traces tab wiring.
- Still deferred after this first slice: provider auto-instrumentation APIs,
  OTLP/import/export and Castform-style trace-to-dataset workflows, optimized
  incremental trace summary maintenance, large-trace timeline scrubber, and
  broad cross-browser/mobile visual coverage for trace-heavy workspaces.

2026-07-03 Run Detail follow-up:

- Added the deferred Run Detail recent-traces panel now that exact trace
  deep-linking is available. The local `Traces` section fetches only while
  opened, requests the selected run's most recent 20 trace summaries through
  `GET /api/traces?run_id=...`, relies on run-scoped trace lists being
  unbounded by the dashboard default lookback so older imported runs stay
  visible, clears stale rows immediately when switching runs, and links each row
  to the full Traces workspace with `run_id`, `trace_id`, and root `span_id`.
- Extended the authenticated UI smoke seed to ingest a native trace batch and
  verify Run Detail stays trace-lazy until the local Traces section is opened,
  then navigates through the exact full-workspace trace link.
- Hardened ClickHouse trace read SQL after the real smoke found alias
  substitution failures in summary and topology queries. Aggregate aliases now
  avoid shadowing raw columns used in filters, run/time bounds are applied inside
  the summary scan before grouping, and the smoke harness prints a Rust server
  log tail on failure so future storage errors are diagnosable without exposing
  internals in public API responses.
- Rejected same-batch span parent rewrites during ingest while preserving the
  common `started` + `finished` shape where the later finish event omits a known
  parent. Cross-batch parent repair remains deferred to explicit follow-up
  logic rather than hidden ClickHouse mutation.
- Fixed direct Traces deep-link hydration by resolving `run_id`, `trace_id`,
  and `span_id` after mount instead of reading `window.location.search` during
  the first client render. This keeps SSR and hydration text stable while still
  loading the linked trace immediately after mount.
- Fixed lazy child-span rendering so detail responses that already include flat
  descendants are displayed without an extra child request, and stale child/list
  responses cannot attach to a newly selected trace.
- Added `npm run test:ui:traces`, a targeted Rust/ClickHouse/Next smoke that
  seeds a native trace, asserts `GET /api/traces?run_id=...` returns the trace,
  opens Run Detail's local Traces section, and follows the exact deep-link into
  the full Traces workspace.
- Remaining after this follow-up: provider auto-instrumentation APIs,
  OTLP/import/export and Castform-style trace-to-dataset workflows, optimized
  incremental trace summary maintenance, large-trace timeline scrubber, and
  broader cross-browser/mobile visual coverage for trace-heavy workspaces.

2026-07-03 SDK decorator/privacy follow-up:

- Added `Run.trace_op(...)` for sync and coroutine functions. Decorated calls
  create independent spans, preserve return values and wrapper metadata, inherit
  only same-run active trace context, and batch until `flush()` or `finish()`
  instead of flushing once per function invocation.
- Hardened SDK trace privacy before decorator capture: preview serialization is
  best effort, secret-looking keys and token-like strings are redacted before
  local queue/spool/offline persistence, and `capture="off"` records exception
  type without persisting exception-message previews.
- Rejected cross-run trace carriers in `run.attach_trace_context(...)`, stopped
  implicit parent inheritance when callers pass an explicit `trace_id`, and kept
  decorator-level static `span_id` unsupported so repeated calls do not collapse
  into one canonical span.
- Extended SDK tests for decorator metadata, privacy, same-run/cross-run
  context behavior, async functions, explicit trace IDs, async queue admission,
  process spool, offline replay, and stable trace idempotency keys.
- Extended the Rust SDK smoke so a real Python `@run.trace_op` reward function
  writes to a disposable Rust/ClickHouse backend and is read back through
  `GET /api/traces` plus run-scoped trace detail.
- Required validation before closing this follow-up: run the real local
  Rust/ClickHouse backend, exercise a realistic decorator-backed trace in the
  dashboard, and verify it with Chrome/Computer Use.

2026-07-03 PR review hardening:

- Changed `GET /api/traces` time-window defaults so project-scoped browsing
  keeps the bounded seven-day lookback, while `run_id` browsing is complete
  unless callers explicitly pass `from` or `to`. This keeps Run Detail recent
  traces, full Traces deep links, and direct API reads consistent for older
  imported/backfilled runs.
- Hardened the Traces tab review feedback: debounced search before API fetches,
  shared dashboard duration formatting, shared select controls and ARIA
  selection semantics, tokenized trace styles, stale deep-link handling for
  unloaded spans, per-org trace-ingest capacity locking, batched trace-summary
  recompute, parallel independent ClickHouse detail reads, and SDK trace limit
  constants shared from the payload module.

## Decision

Accepted first slice after three fresh reviews. Implementation should stay
inside the accepted first-slice boundaries unless this design is updated with a
new review note.
