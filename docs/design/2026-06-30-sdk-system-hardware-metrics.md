# Design: SDK automatic system/hardware metrics — close the D8 acceptance gaps

Date: 2026-06-30

Status: Accepted (implements the pre-accepted D8 design)

Owner: Claude (agent)

## Summary

`docs/design/2026-06-11-deferred-backend-workstreams.md` §2 ("D8") accepted an
opt-out background sampler in the Python SDK that logs CPU/GPU/memory through the
existing batched metric path, with a stdlib CPU/RSS fallback (zero hard deps), an
`INSTANTML_DISABLE_SYSTEM_METRICS=1` opt-out, and lifecycle test coverage.

**Most of D8 already shipped.** `packages/python-sdk/instantml/client.py` has:

- `_SystemMetricsSampler` — a `daemon` thread that samples every
  `system_metrics_interval` seconds (default 15s), default-on (`system_metrics=
  True`), started from `Client.init` (sync + async paths) and `Client.attach_run`,
  and **stopped on every exit path** (`finish()` calls `sampler.stop()`; and
  `finish_stopped()` / `__exit__` / atexit / signal flush all route through
  `finish()`). On a collection exception the loop warns and exits cleanly.
- `_collect_system_metrics()` emits the exact keys the dashboard already consumes:
  `system/cpu_percent`, `system/memory_percent`, `system/memory_used_bytes`,
  `system/process_rss_bytes`, `system/disk_percent`,
  `system/network_bytes_{sent,recv}`, and `system/gpu/{i}/{utilization_percent,
  memory_percent,memory_used_bytes,power_watts}` via NVML. (Note: D8's prose said
  `system/hardware/*`; the shipped + consumed convention is `system/*` and
  `system/gpu/{i}/*` — this design keeps the shipped convention, which the GPU &
  System Insights view and Run Detail System tab already parse.)

Two D8 acceptance items are **not yet met**, and this change adds them:

1. **`INSTANTML_DISABLE_SYSTEM_METRICS` env opt-out** (acceptance criterion) — and
   an optional `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS` override.
2. **stdlib fallback** so basic CPU/RSS signals appear even when `psutil` is not
   installed (the "zero hard dependencies / metrics appear without user code
   changes" promise). Today `_collect_system_metrics` returns `{}` when the
   `psutil` import fails.

## Goals

- `INSTANTML_DISABLE_SYSTEM_METRICS=1` (truthy: `1/true/yes/on`) disables the
  automatic sampler regardless of the `system_metrics=` kwarg, with no code
  change. `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS=<float>` overrides the
  interval when valid.
- When `psutil` is absent, the sampler still emits a small, honest set of
  stdlib-derived metrics (process RSS via `resource`, load average + CPU count
  via `os`) under `system/*` keys, so telemetry "just appears".
- Zero new hard dependencies; `psutil`/`pynvml` remain optional extras.
- Lifecycle + opt-out + fallback covered by pytest.

## Non-Goals

- No backend or frontend change. System metrics already flow through the metric
  ingest path and render in the Run Detail System tab + GPU & System Insights.
- No attempt to compute a precise instantaneous `cpu_percent` without `psutil`
  (would need cross-sample state); the fallback reports honest stdlib signals
  (load average, cpu count, RSS) instead of a faked percent.
- No change to the GPU/NVML path or the psutil-present behavior.

## Users and Use Cases

- A user `pip install instantml` (no extras) and trains: RSS + load-average
  telemetry appears in the run's System tab automatically.
- A user with `instantml[system]` gets full psutil CPU/mem/disk/net + NVML GPU
  telemetry (unchanged).
- An operator sets `INSTANTML_DISABLE_SYSTEM_METRICS=1` in a CI image to silence
  the sampler fleet-wide without touching training code.

## Proposed Design

All changes are in `packages/python-sdk/instantml/client.py` + tests.

### 1. Env resolution

Add a pure helper `_resolve_system_metrics(enabled: bool, interval: float) ->
tuple[bool, float]`:

- If `INSTANTML_DISABLE_SYSTEM_METRICS` is truthy → `enabled = False`.
- If `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS` parses to a finite `> 0` float →
  override `interval` (invalid values are ignored with a warning).

Call it once at the top of `Client.init` and `Client.attach_run`, reassigning the
local `system_metrics` / `system_metrics_interval`. This covers the sync start
site, the async `_resolve_init` closure, and `attach_run` (module-level `init`/
`attach_run` delegate to `Client`, so they inherit it). An explicit
`run.start_system_metrics(...)` call is intentionally NOT gated by the env var —
the opt-out governs the automatic default, not a deliberate user call.

### 2. stdlib fallback

Make the psutil import injectable via `_load_psutil()` (returns the module or
`None`) so it is monkeypatchable in tests. In `_collect_system_metrics`:

- Resolve `psutil = psutil_module if psutil_module is not None else
  _load_psutil()`.
- If `psutil is None`, `metrics.update(_collect_system_metrics_fallback())`;
  else run the existing psutil block unchanged.
- The NVML block runs regardless (unchanged), so a GPU box without psutil still
  reports GPU telemetry.

`_collect_system_metrics_fallback()` (pure, best-effort, never raises):

- `system/process_rss_bytes` from `resource.getrusage(RUSAGE_SELF).ru_maxrss`,
  normalized (Linux reports KiB, macOS bytes) — guarded; `resource` is absent on
  Windows.
- `system/load_average_1m|5m|15m` from `os.getloadavg()` (guarded; Unix only).
- `system/cpu_count` from `os.cpu_count()`.

Returns whatever is available; `{}` only if nothing is (e.g. Windows w/o psutil).

## Component Impact

Backend / Frontend: none. Storage: none. SDK: the two additions above + tests.
Docs: SDK README + `USER_DOCS.md` note the auto-capture, the env opt-out, and the
no-psutil fallback.

## Data Model / API Contracts

No schema or HTTP contract change. Sampler emits standard metric points via the
existing `log_metrics` batched path. New env vars:
`INSTANTML_DISABLE_SYSTEM_METRICS`, `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS`.

## Performance Considerations

- One daemon thread per run; one collection every `interval` (≥ a few seconds).
  Sampling is cheap (psutil counters or a couple of `os`/`resource` calls) and
  rides the existing batched async queue — no extra HTTP per sample.
- Fallback adds only `resource`/`os` calls; no measurable overhead.
- D8 budget: ≤ 0.5% CPU overhead in example training scripts (validated by the
  long default interval + cheap collection).

## Failure Modes

- psutil collection raises → warn once, keep the run alive (existing).
- `_loop` collection raises → warn + thread exits cleanly (existing); the run is
  unaffected.
- Fallback helpers raise / are unavailable per-platform → that key is skipped;
  never raises.
- Invalid `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS` → ignored with a warning;
  the kwarg/default interval is used.

## Testing Plan

- Unit (`packages/python-sdk/tests/test_client.py`):
  - `INSTANTML_DISABLE_SYSTEM_METRICS=1` prevents the automatic sampler start
    (monkeypatch `Run.start_system_metrics`); unset → starts.
  - `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS` overrides the interval; invalid
    is ignored.
  - `_collect_system_metrics_fallback()` returns float-valued `system/*` keys on
    this platform (RSS present on Unix).
  - `_collect_system_metrics` uses the fallback when `_load_psutil` returns None
    (monkeypatched), and the psutil path when a module is injected (existing).
  - Sampler crash: a raising `_collect_system_metrics` warns and the thread
    stops (loop exits). Start/double-start/positive-interval guards + finish
    drain already covered.
- Integration / E2E: run a real SDK script (interval ~1s) against the local Rust
  API and confirm `system/*` metrics are ingested and visible in the Run Detail
  System tab.
- Commands: `python3 -m pytest packages/python-sdk/tests/test_client.py`.

## Documentation Plan

- `packages/python-sdk/README.md`: automatic system metrics, the env opt-out, the
  no-psutil fallback, and the `instantml[system]` extra for full telemetry.
- `USER_DOCS.md`: a short note under metric logging / system namespace.

## Alternatives Considered

- **Fake `cpu_percent` from load average in the fallback**: rejected as
  misleading; report honest `load_average_*` + `cpu_count` instead.
- **Gate the env var inside `start_system_metrics`**: rejected — that would also
  suppress an explicit user call; gate the automatic default at the entrypoints.
- **Add psutil as a hard dependency**: rejected by D8's zero-hard-dep policy.

## Review Notes

Fresh reviewer 1 (pre-commit, independent):

- Finding: Verified env precedence at all three automatic start sites (sync
  `init`, async `_resolve_init` closure, `attach_run`) downstream of
  `_resolve_system_metrics`; the public `start_system_metrics()` is correctly
  not gated. Confirmed Darwin `ru_maxrss` is bytes (no `*1024`); fallback never
  raises and degrades to `{}` on Windows. Confirmed the no-psutil keys don't
  break `system_usage.rs` (unknown keys fall through; `process_rss_bytes` still
  counts toward memory coverage). Zero hard deps; lifecycle untouched; tests are
  behavioral.
- Risk: None material.
- Recommended edit: None (noted that a tight env interval like `0.001` is
  accepted — consistent with the un-validated kwarg path, out of scope).
- Decision: **SHIP.**

## Implementation Status (2026-06-30)

Shipped on branch `feat/sdk-system-hardware-metrics`:

- `_resolve_system_metrics(enabled, interval)` applies `INSTANTML_DISABLE_SYSTEM_METRICS`
  (truthy → off, fleet-wide) and `INSTANTML_SYSTEM_METRICS_INTERVAL_SECONDS`
  (finite-positive override), called at the top of `Client.init` and
  `Client.attach_run` so it reaches the sync, async, and attach start sites.
- `_load_psutil()` (injectable) + `_collect_system_metrics_fallback()` emit
  `system/process_rss_bytes` (RSS via `resource`, KiB→bytes on Linux),
  `system/load_average_{1m,5m,15m}`, and `system/cpu_count` when psutil is
  absent; the psutil + NVML paths are unchanged.

Verification: full SDK suite `python3 -m pytest packages/python-sdk/tests/` =
**367 passed, `client.py` 100% coverage**. Real E2E (SDK script with
`system_metrics_interval=1.0` → local Rust API) auto-captured 7 `system/*` keys
with no user logging code (`system/cpu_percent`, `process_rss_bytes`,
`memory_percent`, `disk_percent`, network bytes), all visible in the run's
Metrics tab in the dashboard. A fresh pre-commit review returned SHIP.

## Coverage Exceptions

Windows-without-psutil yields an empty fallback (no `resource`, no
`getloadavg`); documented and acceptable (Windows ML stacks ship psutil). Not a
first-party-logic coverage gap.

## Decision

**Accepted** — implements the two unmet D8 acceptance items (env opt-out + stdlib
fallback) on the already-shipped sampler, plus the missing lifecycle/opt-out/
fallback tests. No backend/frontend/contract changes.
