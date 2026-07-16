# Design: Offline Run Lifecycle And Upload Completeness

Date: 2026-07-15

Status: Accepted after two fresh reviews (see Review Notes)

Owner: Claude (W&B pain-point roadmap PR-01)

## Summary

InstantML's durable async logging protects the training loop after a run
exists, but `init()` still requires a reachable server, a run's identity is
owned by the server, and a `finished` status says nothing about whether every
logged event actually arrived. Those three gaps are behind the most serious
W&B complaints this roadmap targets: offline/HPC runs that cannot start,
interrupted uploads that silently strand data, and dashboards that show a
cleanly finished run while metrics are missing.

This design defines the smallest shared contract that fixes all three without
introducing a second event system:

1. Client-generated run IDs with explicit `create`/`resume`/`auto` modes and
   idempotent run creation (implemented by PR-02).
2. A true offline mode that extends the existing process-spool event format
   into a self-describing local run directory, plus a strict no-network,
   no-disk `disabled` mode (PR-03), and a resumable `instantml sync` command
   that replays that directory (PR-04).
3. Producer/session upload accounting: each producing process reports
   per-event-class attempted/queued/acknowledged/failed/dropped counts and a
   final upload manifest, and the server derives an honest run data-state of
   `uploading`, `complete`, `incomplete`, or `unknown` (PR-05, surfaced by
   PR-06, recovered by PR-07, regression-tested by PR-08).

Everything builds on the accepted spool envelope and segment writer, the
accepted async SQLite queue, and the existing Rust `operational_records` +
in-memory index storage model. The envelope and queue gain small, additive
fields (session identity, event class, persisted idempotency keys, per-class
cumulative counters) — the event pipeline itself is not duplicated. A run
status of `finished` never implies data completeness; completeness is a
separate, explicitly-tracked dimension.

## Goals

- Let a client reserve run identity locally and later create or resume the
  same run on the server, idempotently, within its authorized org/project.
- Let a process with no network run end to end and leave a valid, inspectable
  local run directory without blocking the training loop.
- Make repeated `instantml sync` of an interrupted offline run converge to
  exactly one hosted run without re-sending delivered segments.
- Persist enough producer/session progress that the server can distinguish a
  fully drained run from a finished run with stranded or dropped data.
- Define honest server/UI data states and their exact derivation rules.
- Define mode precedence (`online`/`offline`/`disabled`), including
  environment variables, without breaking existing `upload_mode` semantics.
- Keep the metric hot path within the accepted async benchmark budgets.

## Non-Goals

- No second event system: offline extends the spool envelope and segment
  writer; sync drives the existing async-queue drain over those segments.
- No exactly-once delivery promise. Idempotent at-least-once replay plus
  honest completeness accounting is the contract. Re-sync after the server's
  idempotency-record TTL (7 days) can duplicate append-style events; the
  design documents this instead of hiding it.
- No per-call server-side control records retained forever; session
  accounting is bounded per run and appends only on state/count changes.
- No offline support for versioned artifact multipart uploads (R2 presigned
  flows) or media response chaining in this slice; they stay online-only and
  fail with clear errors offline.
- No Slurm/scratch directory defaults (PR-09), shared-run distributed
  producers beyond the identity/sequence primitives (PR-10), and no local
  dashboard (PR-11).
- No changes to the deprecated Node compatibility server; all new surfaces
  are Rust-only. Existing create-run callers are affected additively only.
- No changes to run search, archival, or experiment-context semantics.

## Users and Use Cases

- An HPC user trains on an egress-blocked compute node. `init(mode="offline")`
  creates a local run directory; after the job, `instantml sync` from a login
  node uploads it. A mid-sync interruption is resumed by re-running the same
  command.
- A training script crashes mid-run or hits a `finish()` timeout. The
  dashboard shows the run as `Incomplete` with pending/failed counts and a
  copyable recovery command instead of a clean green `finished` badge.
- A CI suite imports the SDK with `mode="disabled"` and runs the full training
  script with zero network, disk, or process-level side effects.
- A rank-0-only distributed job restarts after preemption and explicitly
  resumes the same run ID instead of creating `train-42 (2)`.

## Proposed Design

### 1. Run identity

Run IDs remain UUIDs (the Rust `RunRow.id` type does not change). The new
rule is that the client may generate the UUID:

- The SDK generates a UUIDv4 at `init()` time when the server has not been
  asked yet (offline mode always; online mode when `mode`/`run_id` options are
  used; otherwise the existing server-generated path remains).
- `CreateRunRequest` gains two optional fields:
  - `id`: canonical RFC 4122 UUID string, lowercased. Invalid strings are a
    400 `invalid_run_id`.
  - `mode`: `"create"` (default), `"resume"`, or `"auto"`.
- Responses keep the existing `{"run": RunRow}` envelope and add a top-level
  `"created": bool` so callers can tell creation from attach without
  comparing timestamps. The addition is additive-only; the contract smoke
  and Node-compat boundary tests are updated in PR-02 to assert the legacy
  fields are unchanged and to tolerate the new key.

Precedence for the effective run ID in the SDK:
`init(run_id=...)` > `INSTANTML_RUN_ID` > generated UUID (offline / explicit
mode) > server-generated (existing behavior).

### 2. Create/resume semantics (PR-02)

All semantics are scoped to the caller's authorized org and project
(project-scoped API keys keep their existing checks; a client-supplied ID
never bypasses org scoping — lookups are by `(org_id, run_id)`).

Concurrency model, stated precisely: cross-instance serialization for
create/resume (and the PR-05 session route) is provided by the existing
data-plane writer-lease fence (`data_plane_writer_lease`), which admits one
writer per cell and fails safe for unknown mutating routes; PR-02/PR-05 add
explicit tests that the new routes are covered by that guard. Within the
single admitted writer, the existing in-flight idempotency guard
(`reserve_idempotency_key` on `run-create:<run_id>`) deduplicates concurrent
requests. New store code must not copy `create_run`'s current
lock-across-ClickHouse-I/O shape: validate under the `StoreData` lock,
release it for `persist_locked`, then reacquire to update the index.

Create-request identity is TTL-independent, following the shipped `fork_run`
pattern: the normalized create-request hash is persisted on the run row
itself (new typed field `create_request_hash`, not user `metadata`), so
`mode="create"` replay is recognizable forever, not only within the 7-day
idempotency-record window. The idempotency record additionally caches the
full response for fast replay inside the window; billing/plan capacity checks
are skipped on any replay or resume (no new run is created, so
`enforce_plan_capacity(runs: 1)` must not run — matching `fork_run`).

`mode="create"` with `id`:

- ID unused: create the run with that ID and persist `create_request_hash`.
- ID exists and the stored `create_request_hash` matches: idempotent replay;
  return the existing run with `created: false`. No status change, no
  capacity check, no mutation. This holds beyond the idempotency TTL.
- ID exists with a different create-hash, a different project, or a different
  org: `409 run_id_conflict` (or `404` when the caller cannot see the
  existing run, to avoid cross-org existence leaks). The existing run is
  never mutated by a failed create.

`mode="auto"` with `id`: **attach-or-create, never reopen.** If the ID exists
(same visibility rules as above), return the run with `created: false` and
**no status mutation whatsoever** — a terminal run stays terminal. If the ID
is unused, create as above. Two racing `auto` calls both succeed with the
same run (writer fence + in-flight guard). `auto` is what `instantml sync`
and multi-producer attach flows use; a duplicate or late sync retry can
therefore never flip a completed run back to `running`.

`mode="resume"` with `id`: **explicit reopen.** This is the only path that
mutates lifecycle state:

- ID exists and is visible: return the run with `created: false`. If the run
  is `running`, this is a plain attach. If the run is terminal (`finished`,
  `failed`, `stopped`), resume reopens it with these exact side effects:
  - `status` returns to `running`; `finished_at` is cleared.
  - `started_at` and `created_at` are preserved (duration after re-finish
    spans the original start — the usage-metering window implication is
    accepted and documented; system-usage overlap uses the same rule it uses
    for any running run).
  - `resume_count` increments and `resumed_at` is set (typed `RunRow`
    fields, serialized only when non-default).
  - The previous terminal transition is appended to a bounded, typed
    `lifecycle` history on the run row (last 20 entries; not stored in user
    `metadata`).
  - Any existing `run_control` stop state is reset to `none` via a new
    control row recording the resume actor, so a stale stop request cannot
    immediately re-terminate the reopened run.
- ID missing: `404 run_not_found` (resume never creates).
- Project mismatch: `409 resume_project_mismatch`, no mutation.

`mode` without `id` is a 400 for `resume` and is ignored for
`create`/`auto` (server generates the ID as today). Requests without `id`
and without `mode` behave exactly as before.

### 3. Producer sessions, event classes, and persisted idempotency keys

Every producing process gets a session identity. To survive restarts without
consuming the session budget, `session_id` is **deterministic**: a UUIDv5 of
stable producer identity — `(run_id, producer kind, rank or "", absolute
data-root path hash)`. A restarted uploader or re-executed sync reuses the
same session row; a genuinely different producer (another rank, another
machine) gets a different one.

- `producer`: short descriptor, e.g. `{"kind": "sdk" | "uploader" | "sync",
  "rank": null, "host_hash": "…"}`. Hostnames are hashed; raw hostnames,
  paths, and environment values stay local.

Event classes are a closed, extensible enum:

```text
run_meta      run create/update/finish status requests
metrics       scalar metric batches
rank_metrics  rank metric batches
logs          console log batches
attributes    config/text/tag/histogram-series attribute writes
objects       rich object metadata (tables, histograms, evals)
files         artifact byte uploads (compat upload route)
traces        trace event batches
```

The spool envelope today (`{version, event_id, sequence, run_id, timestamp,
step, data, requests}`) does **not** carry session identity, event class, or
a persisted idempotency key for metric/log/finish events — only trace events
embed keys, and the drain falls back to the random `event_id`. This design
therefore specifies additive envelope changes (PR-03), not a re-reading of
existing fields:

- Each envelope gains top-level `session_id` and `class`.
- Every request in `requests` gains a persisted `idempotency_key`, stamped at
  write time. For offline/spool events the key is deterministic:
  `instantml-<run_id>-<session_id[:8]>-<class>-<sequence>`.
- `sequence` becomes per-`(session_id, class)`, starting at 1, incrementing
  by 1 per attempted event in that class. (The current drain orders by
  filename + line order and ignores `sequence`, so this is
  backward-compatible; old drains also ignore unknown envelope fields.)

**The persisted key in the segment line is the source of truth at sync
time.** Keys are never recomputed from `run.json` counters — a lost or
rewritten manifest cannot mint a second key for an already-persisted event.
Only newly produced events after a resume use the (same, deterministic)
session's next sequences; the writer initializes its sequence counters by
reading the last persisted sequence per class at startup.

Client-side replay must attach the persisted key for **every** class, not
just the four routes the spool uploader covers today; extending
key-attachment to run_meta/attributes/objects/files is in PR-04 scope, and
the matching server-side `Idempotency-Key` acceptance for objects/files
routes (with utoipa header documentation, following the fork route's
annotation) is in PR-02 scope.

### 4. Offline mode and the local run directory (PR-03)

`init(mode="offline")` (or `INSTANTML_MODE=offline`) never touches the
network. It creates:

```text
<data_root>/offline/<run_id>/
  run.json            # run manifest, atomically rewritten (tmp + rename)
  segments/           # spool-format JSONL event segments (existing writer)
  files/              # staged artifact bytes referenced by source_path
```

`<data_root>` resolves as `INSTANTML_DATA_DIR` > `./.instantml`. Directories
are 0700 and files 0600 where the OS supports chmod (no-op on Windows,
matching the async queue caveat). NFS/Lustre caveat: crash recovery depends
on `os.replace` atomicity and directory fsync, which are weaker on network
filesystems; PR-09 adds node-local scratch defaults, and PR-03 hardens the
SDK-side `_fsync_dir` to tolerate `OSError` (as the uploader's already does)
so a directory-fsync failure degrades instead of crashing the loop.

`run.json` schema (version 1):

```json
{
  "schema_version": 1,
  "run_id": "…",
  "session_id": "…",
  "producer": {"kind": "sdk"},
  "mode": "create",
  "create_request": {"project": "…", "name": "…", "config": {}, "tags": [],
                     "metadata": {}},
  "sdk_version": "…",
  "created_at": "…",
  "finish": null,
  "counts": {"metrics": {"attempted": 120, "queued": 120, "dropped": 0}, "…": {}}
}
```

- The create request is stored verbatim so `sync` can issue the exact
  idempotent `mode="create"`/`"auto"` call later.
- `counts` come from in-memory per-class counters and are checkpointed at
  segment rotation and finish — never recomputed by scanning segments during
  the run, and never fsynced per call. After a crash, exact counts are
  recovered by scanning segments; `run.json` counts are a checkpoint, not the
  source of truth.
- Events append through the existing `_SpoolSegmentWriter` (same rotation,
  fsync cadence, crash-promotion of `.pid-*` partial segments), extended with
  the envelope fields from section 3.

Finish and shutdown signatures (all local writes, no PATCH):

- `finish()` in offline mode writes `run.json.finish =
  {"status": …, "at": …, "clean": true}` after flushing segments.
- The existing SIGTERM/SIGINT lifecycle flush writes
  `{"status": "failed", "at": …, "clean": false}`.
- A hard kill (SIGKILL, power loss) leaves `finish: null`.

Sync and data-state treat both non-clean signatures (`finish: null` and
`clean: false`) as evidence toward `incomplete` unless final counts prove
full delivery.

Offline disk-full/write-failure behavior (explicit decision): the offline
writer wraps segment appends in a bounded catch-and-drop path — on `OSError`
(ENOSPC, EROFS, permission loss) it drops the event, increments the
per-class `dropped` counter, and rate-limits a warning, keeping the training
loop alive. This intentionally differs from online `spool` mode, which keeps
its accepted raise-on-write-failure behavior. Drops are visible in
`run.json.counts`, in `instantml sync` output, and force `incomplete`
server-side — never silent loss.

Supported offline in this slice: run creation, config, tags, notes, scalar
and rank metrics, console logs, text/histogram attributes, rich-object
metadata (tables, histograms, classification evals), finish state, and
small artifact byte uploads through the compat upload route (bytes staged
under `files/`, read and base64-encoded at sync time). Not supported
offline: versioned artifact multipart uploads and media helpers that require
server response chaining (`Image`/`Video`/`Audio` uploads); these raise
`UnsupportedOfflineOperation` at call time with a message naming the online
alternative.

`mode="disabled"` returns a `Run` whose logging surface is complete but every
method is a no-op returning inert values. It performs no network and no disk
I/O, does **not** install signal/atexit/fork lifecycle handlers, and does not
register itself in the active-run set — tests assert all of these. It
generates a local run ID for API-shape parity, and `upload_status()` reports
`{"mode": "disabled"}`.

Mode precedence and interaction:

- `init(mode=...)` > `INSTANTML_MODE` > default `online`.
- `upload_mode` (`async`/`sync`/`spool`) applies only to `online`;
  specifying it in `offline`/`disabled` logs a debug notice and is ignored.
- `offline_dir` (legacy failed-request spooling) is unchanged in online mode
  and unused in offline mode.
- The wandb-compat layer maps `wandb.init(mode="offline"|"dryrun")` to native
  offline and `mode="disabled"`/`WANDB_MODE=disabled` to native disabled in
  PR-03, removing the current hard-raise (its "would silently drop logs"
  rationale is obsolete once offline is durable). The compat README is
  updated in the same PR.

### 5. Resumable sync (PR-04)

`instantml sync` gains offline run directory support. Argparse resolution:
`sync tensorboard …` remains a named subcommand; a first argument that is not
a known subcommand is treated as a run directory or offline root path (the
CLI checks for a known-subcommand token first, then falls back to the path
form). `instantml-uploader` remains the drain tool for online async/spool
state; `instantml sync` is the offline-directory tool; PR-07's
`recover` wraps both. All three share the delivery machinery below — there is
no third replay implementation.

```bash
instantml sync <run_dir | offline_root> [--dry-run] [--status] [--json]
```

- `--status` reads only local state: manifest validity, per-class event and
  byte counts, finish signature, prior sync progress.
- `--dry-run` additionally validates against the server (auth, project
  access, run ID availability/compatibility) without writing events.
- Delivery mechanism (concrete reuse, not a parallel engine): sync loads
  pending segment events into a throwaway per-sync SQLite queue via the
  existing `prepare_event`/`enqueue_many_prepared`, preserving their
  persisted idempotency keys, then drives the existing `drain_queue_once`
  loop — inheriting batching, retry classification, `Retry-After` handling,
  and lease recovery. `sync-state.json` records which segments have been
  fully imported+delivered (per-segment cursor updated after each delivered
  batch); interruption resumes from the cursor.
- Sync first issues the stored create request with `mode="auto"` (never
  reopens a terminal run), then drains, then posts the final session
  manifest (section 6). A directory already marked `synced` is a **no-op**
  (verified against server state only under `--dry-run`).
- Deterministic re-batching: sync batches metric events within a single
  segment only, with a fixed `max_batch_points`, so an interrupted-and-rerun
  sync reproduces identical batch membership and the server's batch-level
  idempotency key matches. Residual duplicate risk (e.g. re-sync after the
  7-day server TTL) is documented at-least-once behavior, reported honestly
  rather than promised away.
- Output reports `accepted`, `pending`, `failed`, and `unsupported` counts by
  event class. Exit codes: `0` fully synced and complete; `3` partial
  (retryable remainder — rerun to continue); `4` permanent failures present
  (auth/validation); `5` invalid or unreadable run directory. argparse usage
  errors exit `2` and `1` remains the CLI's generic-error code, as today.
- Privacy: requests carry run/event payloads only. Local absolute paths,
  hostnames, environment variables, and credentials never leave the machine;
  the session `producer` descriptor contains only the fields in section 3.

### 6. Server-side session progress and final manifests (PR-05)

New Rust surface, following the existing `operational_records` + in-memory
index pattern with a new record kind `run_session` keyed
`(run_id, session_id)`, last-writer-wins per session:

```text
PUT /api/runs/{run_id}/sessions/{session_id}
{
  "producer": {"kind": "sdk"},
  "sdk_version": "0.9.0",
  "state": "active" | "final",
  "counts": {
    "metrics": {"attempted": 1200, "queued": 1200, "acknowledged": 1180,
                 "failed": 0, "dropped": 0},
    "logs": {"…": 0}
  },
  "last_sequences": {"metrics": 1200, "logs": 88}
}
```

- Idempotent upsert. The server clamps each per-class counter to
  `max(stored, submitted)` — a restarted uploader that recomputes lower
  counts from pruned local state cannot wedge the session; `409` is not used
  for count regressions. `400 invalid_counts` rejects structurally invalid
  payloads (negative counts, `attempted != queued + dropped`,
  `acknowledged + failed > queued`, unknown class names).
- The run must exist and be visible: `404 run_not_found` otherwise (both the
  uploader and sync post sessions only after run creation succeeded).
  `401`/`403` follow the standard auth failures; the route requires
  `sdk:ingest` and the same org/project checks as metric ingest.
- Bounded: max 64 sessions per run in this slice (`409 too_many_sessions`
  for the 65th). Deterministic session IDs (section 3) mean restarts reuse
  rows instead of consuming the budget; PR-10 revisits the bound for large
  world sizes.
- Append-volume bound: the server appends an operational record only when
  `state`, `counts`, or `last_sequences` actually change; a PUT that only
  refreshes liveness updates the in-memory `heartbeat_at` (server receipt
  time) without appending. Client cadence: PUT on state change or count
  change, throttled to at least 30 s apart, plus a keepalive at most every
  60 s while the session is active. Worst case is therefore ~120
  appends/hour/session while actively uploading and zero appends while idle;
  after a server restart the replayed heartbeat may be stale until the next
  keepalive (≤60 s), which at worst briefly reads as `incomplete`.
- Written by the uploader process (async mode) and by `instantml sync`,
  never by the training-loop hot path. Sync-mode (foreground HTTP) runs post
  a single final manifest from `finish()`.
- Client counts come from new durable per-class cumulative counters: the
  async queue's existing `counters` table gains per-class keys
  (`attempted:metrics`, `acked:metrics`, `dropped:logs`, …) updated in the
  same transactions as enqueue/mark_processed/mark_failed/drop, so counts
  survive processed-row pruning; the producer buffer gains per-class drop
  counters. Current-row `status()` scans are not the count source.

Count definitions (per event class, per session):

- `attempted`: events the user's code submitted after validation.
- `queued`: events durably persisted locally (SQLite row or spool segment).
- `acknowledged`: events whose delivery observed HTTP 2xx.
- `failed`: events terminally failed (4xx-class, non-retryable).
- `dropped`: events discarded before durable queueing (producer-buffer caps,
  queue byte/disk bounds, offline write-failure drops).

Invariants: `attempted = queued + dropped`;
`acknowledged + failed <= queued`.

### 7. Derived run data-state (PR-05 server, PR-06 UI)

Run summaries and run detail responses gain a typed `data_state` object,
computed at read time from the run row plus its session rows. The session
lookup is folded into the existing controls lock pass in `summarize_runs`
(no third lock acquisition) and is computed only for the bounded requested
page, never across the full project. The derivation clock is injectable for
deterministic tests. The OpenAPI schema types `state` as a four-value enum,
and the hand-maintained `RunSummaryRow` mirror is updated in the same change
as the `json!` builder.

```json
{
  "state": "uploading" | "complete" | "incomplete" | "unknown",
  "pending": 20, "failed": 0, "dropped": 0,
  "sessions": 1, "final_sessions": 1,
  "updated_at": "…"
}
```

Derivation rules, in order (stale threshold 300 s against server receipt
time — 5× the 60 s keepalive cadence, tolerant of brief uploader stalls):

1. No session rows exist → `unknown`. Older SDKs land here; the UI copy for
   `unknown` must not imply loss ("Upload tracking not available for this
   SDK version").
2. Any session `state="active"` with fresh heartbeat → `uploading`
   (regardless of run status: a finished run whose uploader is still
   draining is honestly `uploading`).
3. All sessions `final` and totals show `pending == 0 && failed == 0 &&
   dropped == 0` → `complete` (`pending` = `queued - acknowledged - failed`).
4. Otherwise → `incomplete`: some session went silent without a final
   manifest, or final counts admit failed/dropped/pending events.

`finished` status and `complete` data-state are independent axes. The UI
shows status and data-state separately and never renders an `incomplete` run
with the same clean treatment as a `complete` one (PR-06).

The UI's existing metric-derived upload-health chip
(`system/instantml/*` keys) remains as a live-freshness signal during a run,
but the authoritative completeness display switches to `data_state`.
Recovery UX: `incomplete` runs render the pending/failed/dropped counts and a
copyable `instantml recover` / `instantml sync` command (PR-06/PR-07).

### 8. Recovery discovery (PR-07 contract hooks)

`instantml doctor` and `instantml recover --all` discover local durable state
under the configured data roots: async queues (`<root>/async/*/queue.sqlite3`),
process spools (`<root>/spool/<run_id>/`), and offline run directories
(`<root>/offline/<run_id>/`). The doctor bundle includes SDK version, queue
counts/bytes, directory permissions, last safe error code, API reachability,
and request IDs; it excludes tokens, metric values, artifact contents, and
any path not under an explicitly approved data root. Recovery drains through
the same uploader/sync delivery paths defined above.

### 9. Idempotent replay and backward compatibility

- Every replayed event carries its persisted idempotency key (section 3);
  the server's existing org-scoped idempotency records absorb duplicate
  deliveries inside the 7-day window. Beyond that window, re-delivery of
  append-style events (metrics, logs) can duplicate points — this is
  documented at-least-once behavior; completeness counts report what the
  client observed, not a server-side dedup guarantee.
- Older SDKs never send sessions: their runs read as `unknown`, never
  `incomplete`.
- Existing create-run callers (no `id`, no `mode`) see additive-only
  response changes; new `RunRow` fields serialize only when non-default
  (`skip_serializing_if`), the Node compatibility oracle is untouched, and
  the contract smoke keeps asserting the legacy fields.

### 10. Bounded training-loop latency

- Offline mode inherits the spool writer's group-fsync bounds; no new
  synchronous I/O is added to `log_*` calls, and per-class counters are
  in-memory until rotation/finish checkpoints.
- Async mode's producer path is unchanged; session PUTs happen in the
  uploader process only.
- `finish()` keeps its bounded drain budget (`INSTANTML_FINISH_DRAIN_SECONDS`
  or explicit timeout); on timeout it writes the final local counts, leaves
  the queue/directory recoverable, warns with the exact recovery command, and
  the server-side state honestly reads `incomplete`/`uploading` rather than
  `complete`.
- The PR-05 acceptance gate re-runs the accepted SDK logging overhead
  benchmarks (`docs/design/2026-05-21-sdk-logging-overhead-benchmarks.md`)
  and the 90,000-run summary benchmark, requiring no regression beyond noise.

## Component Impact

Backend (`apps/rust-server`):

- `CreateRunRequest` gains `id` + `mode`; create/attach/resume logic,
  persisted `create_request_hash`, typed `lifecycle` history, and
  `run-create` idempotency records (PR-02).
- `Idempotency-Key` support + utoipa header documentation on objects and
  file-upload routes (PR-02).
- New `run_session` record kind, PUT route (writer-lease-guarded, verified
  by test), and read-time `data_state` derivation inside the existing
  summary lock pass (PR-05).
- OpenAPI annotations + regenerated `openapi.generated.json` and
  `api.generated.ts` for every route change, including the hand-maintained
  `RunSummaryRow` mirror.

Python SDK (`packages/python-sdk`):

- `init(mode=..., run_id=..., resume=...)`, `INSTANTML_MODE`,
  `INSTANTML_RUN_ID`, `INSTANTML_DATA_DIR`; offline run directory writer
  extending the spool envelope (session/class/keys); bounded offline
  drop-on-write-failure; offline `finish()`/signal local writes; disabled
  mode without lifecycle-handler registration; wandb-compat mode mapping
  (PR-03).
- `instantml sync` for offline directories: throwaway-queue drain reuse,
  segment cursor journal, deterministic re-batching, full-class idempotency
  key attachment (PR-04).
- Deterministic session identity, per-class cumulative counters in the queue
  and producer buffer, session PUTs and final manifest posting from the
  uploader (PR-05).
- `instantml doctor` / `instantml recover` (PR-07).

Frontend (`apps/web`):

- Replace jargon chip states with typed `data_state` rendering, Run Detail
  explanation, copyable recovery command (PR-06).

Storage:

- One new `operational_records` kind (`run_session`); no new ClickHouse
  tables; no schema migration. Appends bounded to state/count changes.

Docs:

- SDK README (modes, env vars, sync/doctor), rust-server README (new
  routes), web README (data-state UI), public Mintlify docs for offline/sync
  workflows, component TODOs.

## Data Model

- `RunRow` additions (PR-02, all `skip_serializing_if` default/empty):
  `resume_count: u32`, `resumed_at: Option<DateTime>`,
  `create_request_hash: Option<String>`,
  `lifecycle: Vec<LifecycleTransition>` (bounded, last 20; typed field, not
  user `metadata`).
- New record kind `run_session` (PR-05): struct
  `RunSessionRow { run_id, org_id, session_id, producer: Value,
  sdk_version, state, counts: BTreeMap<String, ClassCounts>,
  last_sequences: BTreeMap<String, u64>, heartbeat_at, created_at,
  updated_at }` with `ClassCounts { attempted, queued, acknowledged, failed,
  dropped }`.
- SDK async queue: per-class cumulative counter keys in the existing
  `counters` table; envelope fields `session_id`, `class`,
  `requests[].idempotency_key`.
- Local: `run.json` (schema above), `sync-state.json`
  (`{schema_version, delivered: {segment_file: cursor}, last_error,
  updated_at}`).

## API Contracts

- `POST /runs` accepts optional `id`, `mode`; returns additive
  `created: bool`. Errors: `400 invalid_run_id`, `400` for `resume` without
  `id`, `404 run_not_found` (resume, or invisible existing ID),
  `409 run_id_conflict`, `409 resume_project_mismatch`.
- `PUT /api/runs/{run_id}/sessions/{session_id}` upserts session progress.
  Errors: `400 invalid_counts`, `401`/`403` (standard auth),
  `404 run_not_found`, `409 too_many_sessions`. Counts are max-clamped, not
  409'd, on regression.
- Run summary/detail payloads gain `data_state` (typed enum schema).
- Python: `instantml.init(mode="online"|"offline"|"disabled",
  run_id=None, resume="never"|"must"|"allow")` where `resume` maps to
  `create`/`resume`/`auto`. CLI: `instantml sync`, `instantml doctor`,
  `instantml recover` as specified.

## Performance Considerations

- Session appends: only on state/count change (≤ ~120/hour/session while
  actively uploading; zero when idle); heartbeat-only PUTs are in-memory.
  Worst case for a 10-hour continuously-uploading 64-session run is ~77k
  appends over the run's lifetime — acknowledged in the tenant replay
  budget, and PR-10 must revisit compaction before raising the session
  bound.
- `data_state` derivation: O(sessions ≤ 64) per run, inside the existing
  summary lock pass, page-bounded. The 90,000-run p95 gates re-run in PR-05.
- Offline segment writes reuse measured spool behavior; no new fsync per
  call.
- `sync` batches metric events within-segment with fixed bounds
  (500 points / 1 MiB), matching the async drain.

## Simplicity Review

The design reuses: the spool envelope and segment writer (offline, with
additive fields), the async-queue drain (sync delivery via a throwaway
queue), the idempotency record + persisted-hash pattern (run creation,
following `fork_run`), and the operational-record index (sessions). The
genuinely new concepts are three: client run IDs with modes, the
session/manifest accounting schema, and the derived `data_state`. Each is
required by the honest-completeness product promise and cannot be faked from
existing signals.

## Failure Modes

- Create replay after crash (any age): same ID + same persisted create-hash
  → same run, no duplicate, no reopen.
- Duplicate/late sync of a completed run: `auto` attaches without status
  mutation; a `synced` directory is a local no-op.
- Two ranks race `auto` creation: writer-lease fence + in-flight guard
  serialize; both attach to one run.
- Sync killed mid-segment: cursor journal + persisted per-event keys make
  the rerun converge; deterministic within-segment batching reproduces batch
  idempotency keys, so a re-sent boundary batch deduplicates.
- Uploader dies before final manifest: session heartbeat goes stale → run
  reads `incomplete`; `instantml recover` reuses the deterministic session
  ID, drains, and posts the manifest.
- Uploader restarts with pruned local rows: server max-clamps counts; the
  session cannot wedge on a 409.
- Disk full during offline run: bounded drop path counts per-class drops and
  warns; drops force `incomplete` — never silent loss. Online spool mode
  keeps its raise behavior.
- SIGTERM during offline run: lifecycle flush writes
  `finish={failed, clean:false}`; hard kill leaves `finish:null`; both read
  as evidence toward `incomplete`.
- Clock skew: heartbeat staleness uses server receipt time.
- Session PUT for a never-created run: `404`; the client posts sessions only
  after create succeeds.

## Testing Plan

- Rust: create/attach/resume matrix (new ID, TTL-independent replay via
  persisted hash, conflict, cross-org 404, project-scope enforcement,
  auto-never-reopens, resume side effects incl. run_control reset and
  capacity-check skip, race via guard), writer-lease coverage test for the
  new session route, session upsert invariants (max-clamp, invalid counts,
  session bound), `data_state` derivation for all four states with injected
  clock, OpenAPI snapshot including `RunSummaryRow` mirror, Node-compat
  boundary test asserting legacy create shape plus additive `created`.
- SDK: offline end-to-end with sockets disabled (`socket.socket` guard),
  directory schema round-trip, per-class counter accounting across
  enqueue/ack/fail/drop and pruning, deterministic session IDs across
  restarts, persisted-key determinism after `run.json` loss, disabled-mode
  no-network/no-disk/no-handler assertions, offline disk-full drop path,
  offline finish/SIGTERM signatures, wandb-compat mode mapping.
- Sync: interruption-resume convergence (kill between batches),
  deterministic re-batching reproduces batch keys, dry-run, synced-dir
  no-op, exit codes, unsupported-class reporting, full-class idempotency
  key attachment.
- Integration (PR-08 expands): full offline → sync → `complete` data-state
  against local Rust/ClickHouse; finish-timeout fixture reads `incomplete`
  with recovery command; recovery drains to `complete`.

## Documentation Plan

READMEs for rust-server/SDK/web, Mintlify offline+sync guide, TODO updates,
and this design doc indexed in `docs/design/README.md`.

## Alternatives Considered

- Server-issued reservation tokens instead of client UUIDs: rejected —
  requires connectivity to reserve identity, which is the exact failure mode
  offline mode must survive.
- Reopen-on-`auto` (single resume mode): rejected in review — a late sync
  retry could silently flip a completed run to `running` and distort
  usage/duration metering. Reopen is explicit `resume` only.
- New ClickHouse table for sessions: rejected for this scale (≤64 rows per
  run, read via in-memory index); an `operational_records` kind with
  change-only appends is simpler.
- Deriving completeness from idempotency records: rejected — they expire in
  7 days and count requests, not client-observed attempts/drops.
- Making `finished` imply completeness after a drain grace period: rejected —
  that is precisely the dishonesty this roadmap removes.
- A separate offline event format: rejected — second event system, weaker
  crash behavior than the proven segment writer.

## Review Notes

Two fresh reviews were completed on 2026-07-15 before acceptance. Both
returned Accept-with-edits; all blockers and should-fix items are
incorporated above.

Fresh Rust/API/storage reviewer:

- Blocker: reopening terminal runs via `auto` (and therefore via sync
  retries) would silently flip completed runs to `running` and distort
  `finished_at`-derived usage metering, duration sorts, and `run_control`
  reconciliation. Decision: accepted — `auto` is now attach-only; reopen is
  explicit `resume` with enumerated side effects (preserve `started_at`,
  reset stop state, bounded typed lifecycle history) and capacity checks are
  skipped on replay/resume.
- Blocker/should-fix: `run-create` idempotency must survive the 7-day
  record TTL. Decision: accepted — the normalized create-hash is persisted
  on the run row (typed field), following the shipped `fork_run` pattern.
- Should-fix: cite the data-plane writer-lease fence as the real
  cross-instance serializer, add a coverage test for the new route, and
  forbid copying `create_run`'s lock-across-I/O shape. Accepted.
- Should-fix: deterministic session IDs, max-clamped counts instead of
  `409 counts_regression`, and change-only appends to bound `run_session`
  log growth. Accepted.
- Should-fix: fold `data_state` into the existing summary lock pass,
  page-bounded, widen the stale threshold, injectable clock, keep the 90k
  benchmark gate. Accepted (300 s threshold vs 60 s keepalive).
- Should-fix: additive-only compat (`skip_serializing_if`), contract-smoke
  ownership, dual-edit of the `RunSummaryRow` OpenAPI mirror. Accepted.
- Should-fix: complete session-route error codes, unknown-run rule, typed
  `data_state` enum, utoipa `Idempotency-Key` documentation. Accepted.
- Should-fix: server-managed lifecycle history in typed fields, not user
  `metadata`. Accepted.

Fresh SDK/CLI/failure-modes reviewer:

- Blocker: the claim that the spool envelope "already carries" session,
  class, and persisted idempotency keys was factually wrong (only trace
  events embed keys; sequence is per-run). Decision: accepted — section 3
  now specifies the additive envelope changes explicitly and scopes them to
  PR-03/PR-04.
- Blocker: deterministic keys must be persisted per segment line as the
  source of truth, never recomputed from `run.json`. Accepted.
- Should-fix: per-class cumulative counters that survive processed-row
  pruning, producer-side per-class drop counters. Accepted.
- Should-fix: explicit offline disk-full decision (bounded drop path with
  counters offline; online spool keeps raising). Accepted.
- Should-fix: concrete sync reuse mechanism (throwaway SQLite queue +
  `drain_queue_once`), deterministic within-segment re-batching, and honest
  documentation of >TTL duplicate risk (removed the incorrect "content
  dedup" claim). Accepted.
- Should-fix: disabled mode must skip lifecycle/signal/atexit/fork handler
  registration; wandb-compat offline/disabled mapping added to scope;
  argparse resolution for `sync`; offline `finish()`/SIGTERM local-write
  signatures; full-class client-side idempotency key attachment. All
  accepted.
- Nits: exit-code wording corrected (argparse exits 2); NFS/Lustre and
  Windows-chmod caveats plus `_fsync_dir` hardening added; counts sourced
  from in-memory counters stated explicitly. Accepted.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation as PR-02 through PR-08 of
`docs/product/2026-07-14-wandb-pain-point-roadmap.md`, in the roadmap's
recommended merge order.
