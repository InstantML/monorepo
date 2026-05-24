# Design: Live Run Streaming And Restart

Date: 2026-05-23

Status: Implemented narrow v1 after fresh architecture review

Owner: Codex

## Summary

InstantML already stores metrics as runs execute, but the product does not yet
feel live. The SDK can send synchronous requests or write process-spool files,
the Rust API writes ClickHouse metric points immediately, and the web dashboard
fetches bounded series on demand. Missing pieces are run liveness, browser-side
live follow, a clear online/offline SDK mode model, and a safe way to retry or
resume failed runs from the UI.

This design accepts a narrow first slice:

- Keep online metric ingestion live by default for normal SDK runs.
- Add explicit SDK run identity and resume modes so failed runs can be resumed
  intentionally instead of guessed by working directory.
- Add persisted run heartbeat/liveness so the UI can distinguish running,
  crashed, failed, and finished runs. `killed` can be added only when every
  compatibility target accepts it.
- Add one dashboard live stream per visible project/run scope using
  server-sent events (SSE) with bounded polling fallback.
- Add copyable retry/resume commands in the UI. Agent-backed restart is a later
  design, because launch queues, leases, permissions, and secret-safe specs are
  larger than the first useful live-monitoring slice.

The smallest useful implementation should not add a broad orchestration
platform. The first UI surface should show copyable resume/retry commands using
the existing checkpoint restore snippets and explain that one-click restart
requires a future agent integration.

## Research Notes

The linked W&B page is about inference response streaming, not experiment
tracking. It still supports the product intuition: users should see incremental
output for long-running work instead of waiting for a final response, and
non-streaming requests can be less robust for slow workloads:
<https://docs.wandb.ai/inference/response-settings/streaming>.

W&B experiment tracking distinguishes run liveness and terminal failures. Its
run states include `Running`, `Finished`, `Failed`, `Crashed`, `Killed`, and
`Pending`; `Crashed` means the run stopped sending heartbeats:
<https://docs.wandb.ai/models/runs/run-states>. That is the missing concept in
InstantML today, because our `running` runs can remain running forever if the
process dies without `finish("failed")`.

W&B resume modes are a useful model but should be made more explicit for our
first slice. W&B supports `resume="must"`, `"allow"`, `"never"`, and `"auto"`,
and recommends explicit `resume="allow"` with a run ID over directory-based
`auto` when possible: <https://docs.wandb.ai/models/runs/resuming>. We should
mirror the explicit modes and defer `auto` until true offline run directories
exist.

W&B's offline path is also a useful non-streaming reference: `WANDB_MODE=offline`
saves data locally, and `wandb sync` uploads later:
<https://docs.wandb.ai/support/models/articles/can-i-run-wandb-offline>. Our
current `offline_dir` only replays failed post-init requests, so true
non-streaming workloads need client-generated run IDs and local run manifests.

W&B Launch provides the right safety boundary for UI-triggered reruns: jobs are
queued, agents pull work, and a run is created when an agent executes a launch
job. Launch jobs capture code, inputs, and environment information, and agents
run in a configured compute environment:
<https://docs.wandb.ai/platform/launch/launch-terminology>. InstantML should
copy the pull-agent boundary, not the full Launch feature set.

W&B's scale guidance reinforces that live streaming should stay bounded:
project performance depends on run count, step count, metric cardinality, log
frequency, payload size, and workspace configuration. It recommends batching
related metrics and keeping log frequency/throughput reasonable:
<https://docs.wandb.ai/models/track/limits>. Our design should stream
invalidation/deltas and re-use bounded chart endpoints, not push unbounded
history to every browser tab.

SSE is a good browser transport for first-slice dashboard live follow because
our dashboard needs server-to-client notifications only. MDN documents that SSE
is one-way, supports named events, reconnect behavior, event IDs, and retry
hints: <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>.
WebSockets are better for two-way sessions, but the classic browser WebSocket
interface lacks backpressure, which is a poor default for potentially high-rate
metric streams: <https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API>.

ClickHouse materialized views already fit the summary side of live ingestion:
ClickHouse describes materialized views as insert-time triggers that store query
results into target tables, which matches our `metric_series_mv` aggregation
path: <https://clickhouse.com/blog/using-materialized-views-in-clickhouse>.

## Goals

- Let users monitor active training metrics and logs while a run is still
  executing.
- Make online/live behavior the default for ordinary SDK runs, while preserving
  explicit non-streaming modes for offline or batch-synced workloads.
- Add heartbeat-backed run liveness and crash detection.
- Add SDK resume semantics that are explicit, testable, and compatible with
  future UI restart actions.
- Let the UI restart/retry failed runs through copyable commands in v1; defer
  safe pull-agent queues to a separate design.
- Keep chart, log, and run-list reads bounded under existing high-load UI
  constraints.
- Avoid direct server-side execution of user training commands.

## Non-Goals

- Do not build a full W&B Launch clone in the first slice.
- Do not add Kubernetes, SageMaker, Vertex, SLURM, or Docker builders yet.
- Do not implement rewind/history truncation in this slice.
- Do not change artifact/checkpoint storage semantics.
- Do not stream every metric point to every open dashboard without bounds.
- Do not make directory-based `resume="auto"` the primary recommendation.
- Do not require SSE for correctness; polling fallback must continue to work.

## Users and Use Cases

Researchers and ML engineers need to:

- Start a run and see loss/reward/eval metrics move in the dashboard within a
  few seconds.
- Keep the dashboard open on a running job without manual refreshes.
- See when a run has stopped heartbeating and is likely crashed.
- Retry a failed run from the UI when InstantML knows how it was launched.
- Resume the same run ID when the user intentionally wants one continuous
  history after a preemption or transient crash.
- Create a new linked attempt when they want a clean retry that preserves the
  failed run for comparison.
- Run offline or batch-sync workloads without a browser expecting live updates.

## Proposed Design

### Product Semantics

Use three related but distinct concepts:

- **Live ingestion**: SDK events are uploaded while the process runs. This is
  the default for online runs.
- **Live follow**: the dashboard subscribes to updates for running runs and
  refreshes bounded data automatically. This is enabled by default for visible
  running runs and can be paused.
- **Restart/retry**: V1 UI creates copyable commands. A later agent-backed
  design can let the UI create launch requests that an external agent executes.

Recommended default:

- Enable live follow in the web app by default whenever the active view includes
  running runs.
- Keep SDK `mode="online"` as the default. In the first implementation, it can
  still use the existing synchronous transport unless `upload_mode="spool"` is
  selected. Do not flip the SDK default to hidden background upload until the
  SDK logging-overhead benchmark shows the failure and finish semantics are
  acceptable.
- Defer explicit `mode="offline"` until client-generated run IDs, local run
  manifests, sync, and replay acknowledgements are implemented.

This answers the "should streaming be default?" question as: yes for the
product experience and online ingestion, but no for removing explicit offline
and batch modes. Live should be the normal case, not the only case.

### SDK Modes And Resume

Extend `instantml.init()` and `Client.init()` with W&B-compatible lifecycle
arguments where possible:

```python
run = instantml.init(
    project="cartpole",
    id="run-uuid",
    resume="allow",       # "never" | "allow" | "must"
    upload_mode="sync",   # existing: "sync" | "spool"
)
```

First-slice behavior:

- `id=None`, `resume="never"`: current behavior; server creates a new run ID.
- `id=<id>`, `resume="never"`: create that ID only if absent, otherwise return
  conflict.
- `id=<id>`, `resume="must"`: resume only if the run exists and is resumable,
  otherwise return a clear error.
- `id=<id>`, `resume="allow"`: resume if the run exists, otherwise create a new
  run with that ID.
- `id=<id>` is UUID-only in v1. A separate human-readable `external_id` can be
  designed later if needed.
- `resume="auto"` is deferred until true run directories exist. It should not
  be implemented as "guess by current working directory" in this slice.
- `mode="online"` requires server init and supports live ingestion.
- `mode="offline"` and `mode="disabled"` are deferred until their local object,
  manifest, and replay semantics are designed.

`Run.finish(status=...)` should continue to accept:

- `finished`
- `failed`

`killed` is deferred until Rust, SDK, UI, and compatibility targets all accept
it together.

The server, not the SDK, should mark `crashed` after heartbeat expiration.

Resume should set the SDK's implicit step from server state. For each metric key
already logged, the server can expose latest step through `metric_series`.
Simplest first slice: response to resumed init includes `resume_from_step`, the
max latest step across metrics, and the SDK initializes `_auto_step` to that
value. Per-key warnings for non-increasing steps remain in place.

### Heartbeats And Run Liveness

Add a heartbeat endpoint:

```http
POST /runs/:run_id/heartbeat
{
  "run_id": "...",
  "process_id": "client-generated-uuid",
  "hostname": "optional-hashed-or-redacted",
  "pid": 12345,
  "timestamp": "2026-05-23T12:00:00Z",
  "state": "running"
}
```

Rules:

- Requires `sdk:ingest`.
- Validates run access and active/resumable state.
- Records `last_heartbeat_at`, `last_process_id`, and `last_event_at` in run
  liveness state.
- The SDK sends heartbeats every 15 seconds for online runs, with jitter.
- Metric, log, and artifact ingest may update `last_event_at` but should not be
  the only liveness signal, because quiet training phases are common.
- The worker marks `running` runs as `crashed` when the last heartbeat is older
  than a configurable threshold, default 5 minutes.
- The UI shows "running, last seen 12s ago" for active runs and "crashed, last
  seen 6m ago" for heartbeat-expired runs.

V1 run statuses:

- `running`: persisted non-terminal run state, decorated by derived liveness.
- `finished`: normal terminal success.
- `failed`: process exited non-zero or SDK explicitly finished failed.
- `crashed`: heartbeat expired without a terminal finish.

Deferred launch statuses:

- `pending`: queued by InstantML but no agent has started it.
- `queued`: waiting in a launch queue.
- `killed`: user requested stop or agent killed the process.

Backward compatibility:

- Existing `running`, `finished`, and `failed` values remain valid.
- Deprecated Node and Python bootstrap compatibility tests only need the old
  statuses unless their route-shape smoke starts covering live restart.
- The web UI should tolerate unknown statuses by rendering a neutral pill.

### Dashboard Live Follow

Add one SSE endpoint for browser sessions:

```http
GET /api/live/runs?project_id=...&run_ids=...&metric_keys=...
Accept: text/event-stream
```

The endpoint emits compact invalidation events, not unbounded history:

```text
event: run_metric_batch
id: 000000000001
data: {"run_id":"...","metric_keys":["train/loss"],"min_step":101,"max_step":125,"point_count":25}

event: run_status
id: 000000000002
data: {"run_id":"...","status":"crashed","last_heartbeat_at":"..."}

event: keepalive
data: {}
```

Why invalidations first:

- The Rust handler already has the inserted points, but pushing point payloads
  to every dashboard creates duplicated high-volume traffic and browser memory
  pressure.
- The web app already has bounded series/log endpoints and M4 downsampling.
- A compact event can trigger debounced refresh of only visible charts and logs.

Frontend behavior:

- Open one stream for the active dashboard scope, not one stream per panel.
- Start live follow when selected/visible runs include `running` runs.
- Close the stream when no live runs are visible, when the tab is hidden for a
  configurable idle period, or when the user pauses live follow.
- On `run_metric_batch`, debounce 500-1000 ms and refresh the relevant
  `POST /api/metrics/series` patches with existing M4/point caps.
- On `run_console_batch`, fetch logs using the existing cursor window.
- On `run_status`, patch the run row immediately and schedule a summary refresh.
- Keep a bounded five-second watchdog poll while live follow is active so the
  UI still advances if a browser or same-origin proxy holds an SSE connection
  without delivering events. On stream error, close SSE and continue with the
  bounded polling path.

Server behavior:

- Use `tokio::sync::broadcast` or a small in-process fanout per org/project for
  the first single-writer slice.
- Persist correctness in ClickHouse/operational records; SSE is only a
  notification channel. Reconnects always catch up by refetching bounded
  endpoint data.
- Include SSE `id` values for browser reconnect hints, but do not rely on
  in-memory replay across server restarts.
- Send keepalive comments/events every 20-30 seconds.
- Keep Cloud Run/router timeout behavior in mind; periodic reconnect is fine.

Multi-instance caveat:

- Current hosted guidance still treats data cells as single-writer by default.
  In a future multi-writer cell, live events need either a shared pub/sub
  channel or polling fallback only. Do not claim SSE is complete multi-instance
  liveness until that design exists.

### Restart And Retry From The UI

V1 does not add launch queues or agent-backed restart. Do not let the Rust API
execute training commands. The UI should expose copyable commands that make the
safe path clear:

- **Retry as new run** (recommended): copy a snippet that creates a new run,
  preserves useful config/source metadata, optionally restores the latest
  checkpoint, and keeps the failed run immutable for comparison.
- **Resume same run** (advanced): start the process with the same run ID and
  `resume="must"` or `resume="allow"` when the user wants one continuous
  history after preemption or transient failure.

The first UI surface should show:

- Source run name/status.
- Last heartbeat and failure reason when known.
- Latest checkpoint artifact, if available.
- Retry mode: new linked attempt vs same-run resume.
- Disabled state explaining that one-click restart requires a future
  agent-backed launch integration.

### Deferred Agent Restart

Agent-backed restart should be designed separately. The safe boundary remains a
minimal launch queue that an external user-controlled agent pulls:

```text
UI -> Rust control/data API -> ClickHouse launch_request records
instantml-agent -> polls/claims launch_request -> runs command on user's compute
training process -> instantml.init(...) -> Rust API -> dashboard live follow
```

Launch spec sources, in priority order:

- Explicit SDK `launch={...}` metadata passed to `init()`.
- CLI-created job template: `instantml job create --name ... --command ...`.
- Agent-provided template registered to a project/queue.
- Fallback: copyable command only, no UI-executed restart.

Minimal launch spec:

```json
{
  "schema_version": 1,
  "project_id": "...",
  "name": "cartpole-train",
  "command": ["python", "train.py"],
  "working_dir": "/workspace",
  "git": {"remote": "...", "commit": "..."},
  "env_keys": ["PYTHONPATH"],
  "checkpoint_policy": "latest-compatible"
}
```

Agent contract:

- Agent authenticates with a new `launch:agent` scoped key.
- Agent polls `GET /api/launch/queues/:queue_id/requests?status=queued`.
- Agent claims with `POST /api/launch/requests/:id/claim`.
- Agent starts the process with `INSTANTML_API_KEY`, `INSTANTML_PROJECT`,
  `INSTANTML_RUN_ID` or `INSTANTML_RETRY_OF_RUN_ID`, and resume mode env vars.
- Agent sends job status/heartbeat separate from training run heartbeat.
- Agent marks request `running`, `succeeded`, `failed`, or `killed`.

This deferred design keeps security understandable: the browser asks for work,
the backend records work, and an agent already installed in the compute
environment decides what it is willing to execute.

### Checkpoint Recovery

Use the existing checkpoint artifacts as the first restart source:

- UI restart snippets should prefer the latest checkpoint artifact from the
  failed run when `artifact_type="checkpoint"`.
- Retry as new run includes `INSTANTML_RESUME_FROM_ARTIFACT_ID` guidance and
  lets the training code decide how to restore.
- Same-run resume passes `INSTANTML_RUN_ID=<source>` and
  `INSTANTML_RESUME=must`.
- Do not attempt generic checkpoint restoration inside InstantML until
  framework-specific adapters are designed.

## Component Impact

Backend:

- Expand run status validation.
- Add run heartbeat/liveness route and worker crash detection.
- Add SSE live notifications for run metric/log/status invalidations.
- Defer launch spec, launch queue, launch request, claim, and status endpoints
  to a separate agent-pull workflow design.
- Add OpenAPI annotations and regenerate generated API files when implemented.

Frontend:

- Add live-follow state to the dashboard shell and Run Detail.
- Subscribe to one SSE stream for active live scope with polling fallback.
- Show run liveness in run rows/detail headers.
- Add Restart modal/action with disabled explanations.
- Keep existing bounded series/log fetches and cancellation-aware loaders.

Python SDK:

- Add `id` and `resume` arguments to `init()`.
- Keep true offline run creation and `instantml sync` deferred; do not document
  `mode="offline"` as complete in this slice.
- Add heartbeat sender for online runs.
- Defer optional launch metadata capture.
- Keep `upload_mode="sync" | "spool"` as the transport layer under `mode`.

Storage:

- Add run liveness state through a dedicated liveness table or bounded
  projection, not high-volume operational records.
- Defer launch specs, queues, requests, agent leases, and request events.
- Consider retention/compaction for heartbeat records before hosted rollout.

Docs:

- Update SDK README/TODO with mode/resume/live behavior.
- Update Rust README and architecture API/schema docs for statuses, heartbeat,
  and live stream.
- Update web README with live follow and Restart modal behavior.
- Add user docs for online live follow, process-spool non-live behavior, retry,
  and resume.

## Data Model

Run row additions:

- `status`: expanded enum above.
- `last_heartbeat_at: DateTime?`
- `last_event_at: DateTime?`
- `heartbeat_timeout_seconds: i64?`
- `failure_reason: String?`
- `exit_code: i32?`

Dedicated liveness records:

- `org_id`
- `run_id`
- `process_id`
- `last_heartbeat_at`
- `last_event_at`
- `state`
- `created_at`

Deferred launch records:

- `launch_spec`: reusable command/template metadata.
- `launch_queue`: queue name, allowed agent scopes, status.
- `launch_agent`: registered agent identity, version, last heartbeat.
- `launch_request`: queued user action with source run, retry mode, spec, queue,
  requester, status, claim lease, timestamps, and safe failure summary.
- `launch_event`: append-only request status history for debugging.

Indexes/order:

- Run summary/search paths should keep status filter fast.
- Deferred launch queue polling needs `(org_id, queue_id, status, created_at)`.
- Deferred agent heartbeat/status views need `(org_id, agent_id, updated_at)`.

## API Contracts

SDK:

```python
instantml.init(
    project: str,
    id: str | None = None,
    resume: Literal["never", "allow", "must"] = "never",
    upload_mode: Literal["sync", "spool"] = "sync",
)
```

Backend:

```http
POST /runs
```

Accepts optional UUID `id` and `resume`.

```http
POST /runs/:run_id/heartbeat
GET /api/live/runs
```

Error behavior:

- Resume conflict returns 409 with stable code `run_resume_conflict`.
- Resume missing with `resume="must"` returns 404 with stable code
  `run_resume_missing`.
- Agent-backed restart endpoints are not part of v1.

## Performance Considerations

Expected write frequency:

- Metrics: existing SDK logging frequency, already guarded by metric limits.
- Heartbeats: one row/event every 15-60 seconds per active run.
- SSE: one compact notification per metric/log batch, not per metric value when
  batching is used.

Read/query shape:

- Live dashboard still uses `/api/runs/summary`, `/api/metrics/series`, and log
  windows with existing caps.
- SSE invalidations should be small enough to keep one stream per dashboard
  scope cheap.
- Deferred launch queue polling should be bounded and cursor/limit based from
  the start.

Latency targets:

- New metric batch visible in active dashboard within 1-3 seconds in local and
  hosted single-writer cells.
- Crash status visible within heartbeat timeout plus worker interval.
- Live status changes appear in the dashboard within 1-3 seconds in local and
  hosted single-writer cells.

Memory:

- Do not buffer full metric histories in the SSE fanout layer.
- Limit per-connection queued notifications and drop to "needs full refresh" if
  the browser cannot keep up.

Measurement plan:

- Extend SDK overhead benchmarks to compare `sync`, `spool`, future online
  background mode, and offline sync.
- Add a local live-follow smoke with one active run, 10k metric points, and one
  open dashboard.
- Defer queue/agent smoke until the agent-backed restart design.

## Simplicity Review

The simplest useful path is live invalidation plus bounded refetch. It avoids a
new stream-processing database, WebSocket protocol, custom browser backpressure
code, or a direct command execution service. It also separates two concerns
that are easy to conflate:

- Observability live follow is a notification/read problem.
- UI restart is a job execution problem that needs an agent boundary.

Deferred complexity:

- True multi-writer live pub/sub.
- Generic cloud compute integrations.
- Docker/image builders.
- Rewind/history truncation.
- Automated checkpoint restoration.
- Collaborative queues and approval workflows.
- Streaming raw metric point payloads over SSE.

## Failure Modes

- SDK process crashes: heartbeat expires and worker marks the run `crashed`.
- Browser loses SSE connection: EventSource reconnects; UI refetches bounded
  summaries/series after reconnect.
- Server restarts: in-memory live event history is lost; persisted ClickHouse
  data remains source of truth and UI refetch catches up.
- Browser falls behind: server drops queued SSE messages and emits a
  `full_refresh_required` event.
- Multiple processes resume the same run ID: server detects active heartbeat
  ownership and rejects or warns unless explicitly allowed for distributed runs.
- Checkpoint missing: UI disables checkpoint-specific restore guidance or falls
  back to a plain resume/retry command.
- Offline mode sync duplicates events: idempotency keys remain required for
  replayed metric/log events.

## Testing Plan

Backend tests:

- Status validation accepts `running`, `finished`, `failed`, and `crashed`.
- Heartbeat updates liveness and refuses unauthorized/project-mismatched runs.
- Worker marks stale running runs as crashed but does not change terminal runs.
- Resume mode create/resume/conflict behavior.
- SSE route authenticates browser sessions, emits keepalive, and sends
  invalidation events on metric/log/status writes.
- OpenAPI/codegen drift tests after routes are added.

SDK tests:

- `init(id=..., resume=...)` request shaping and error handling.
- Heartbeat sender starts/stops with run lifecycle and never blocks metric log
  calls.
- Resumed init sets implicit step from server resume payload.
- `finish("failed")` and context-manager failure behavior.

Frontend tests:

- Live-follow starts only for active live runs and closes/pauses correctly.
- SSE events trigger debounced bounded series/log refresh and ignore stale
  async responses.
- Polling fallback after stream errors.
- Run rows/detail show last heartbeat, `crashed`, and neutral unknown statuses.
- Copyable retry/new run and same-run resume command snippets.

Integration/smoke tests:

- SDK -> Rust -> ClickHouse -> dashboard live update.
- Process-spool uploader -> non-live dashboard data unless a foreground
  uploader follow process later emits live notifications.
- Failed run -> UI copyable resume/retry command.

Coverage:

- Any background heartbeat or agent loop must have deterministic unit tests for
  lifecycle and retry timing; use injectable clocks where needed.

## Documentation Plan

Update these files during implementation:

- `packages/python-sdk/README.md`
- `packages/python-sdk/TODO.md`
- `apps/rust-server/README.md`
- `apps/rust-server/clickhouse/README.md`
- `apps/rust-server/src/store/README.md`
- `apps/web/README.md`
- `docs/architecture/current-api.md`
- `docs/architecture/current-schemas.md`
- `docs/design/README.md`
- Public docs in `apps/docs` after the behavior is product-ready.

## Alternatives Considered

WebSockets:

- Rejected for first slice. We do not need browser-to-server messages on the
  live channel, and browser WebSocket lacks built-in backpressure.

Polling only:

- Simpler and acceptable as fallback, but it wastes work when dashboards are
  idle and feels less live during active training. Polling alone is a viable
  temporary implementation if SSE slips.

Streaming raw points over SSE:

- Deferred. It gives lower latency for single-run charts but duplicates high
  volume payloads and requires more careful per-connection backpressure.

Server executes restart commands directly:

- Rejected. It would put arbitrary user code execution inside the API service
  and blur tenant/security boundaries.

Same-run resume as the only restart:

- Rejected. New linked retry runs are safer as the default because they preserve
  failed history and avoid accidental duplicate/non-monotonic metric writes.

Directory-based auto resume:

- Deferred. It is convenient but fragile across machines and workspace changes.
  Explicit run IDs are safer for a hosted UI restart path.

## Review Notes

Frontend reviewer:

- Finding: SSE scope must be capped because the dashboard can select up to
  2,000 runs; live refresh needs a dedicated state owner; log tailing and new
  status tones need explicit UI tests.
- Decision: V1 live follow is capped to visible/selected running runs within
  hard limits, uses a dedicated live-follow controller, and keeps restart to
  copyable commands.

API reviewer:

- Finding: The draft mixed first-slice live monitoring with future launch-agent
  restart, left UUID resume contracts ambiguous, and conflated run status with
  launch-request status.
- Decision: V1 adds UUID-only `id`/`resume`, stable create/resume response
  fields, heartbeat/liveness, SSE invalidation, and no launch endpoints.

SDK reviewer:

- Finding: True offline mode conflicts with current credential and `/runs`
  creation flow; `upload_mode="spool"` plus live heartbeat needs an explicit
  transport matrix.
- Decision: V1 adds online `id`/`resume` and heartbeat lifecycle only. True
  offline manifests/sync and live spool following are deferred.

Rust/runtime reviewer:

- Finding: Heartbeats should not be operational records, crash detection needs
  an owner/cadence, SSE must bypass the global timeout/compression path, and
  in-process fanout is only single-instance correct.
- Decision: V1 uses dedicated liveness state, explicit stale-run sweeping,
  timeout-safe SSE routing, and polling fallback for correctness.

## Coverage Exceptions

None planned.

## Decision

Accepted first slice:

1. SDK `id`/`resume` plus server resume conflicts.
2. Heartbeat/liveness and `crashed` status.
3. Dashboard live follow through capped SSE invalidations with polling fallback.
4. Copyable restart/resume commands in the UI.
5. Agent-backed UI restart only after the above slice is stable and reviewed.
