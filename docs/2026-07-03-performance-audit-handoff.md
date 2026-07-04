# Performance Audit — Subagent Handoff (2026-07-03)

Scope: speed, memory, scalability, unnecessary re-renders across the four performance surfaces of the monorepo:

- **A. Web frontend, rendering** (`apps/web`) — React re-render architecture
- **B. Web frontend, data layer** (`apps/web`) — polling, fetching, bundle
- **C. Rust API server** (`apps/rust-server`) — production backend (ClickHouse + Postgres control plane, in-memory `StoreData` projection behind one `tokio::sync::Mutex`)
- **D. Python SDK** (`packages/python-sdk`) — runs inside users' training loops; per-call overhead is critical
- **E. Node reference server** (`apps/server`) — **deprecated, dev/demo only** per its README; severity capped accordingly

Every finding below was verified by reading the code (file:line anchors included). Each is written as a self-contained work packet: defect → why it hurts → fix instruction → done-when. Line numbers are anchors, not exact contracts — re-locate by the quoted identifiers if the file has drifted.

---

## Priority order (what changes the throughput class)

1. **D1+D2+D4 together** — SDK delivery batching + connection reuse + batched acks. Today the async pipeline's ceiling is (TCP+TLS handshake + 1 round trip + 1 SQLite commit) **per logged step**.
2. **C1** — remove the per-ingest ClickHouse COUNT storm (plan-capacity gate). Every metric POST currently costs 3–4 CH aggregate queries plus a full artifact scan.
3. **B1+B5** — live-refresh amplification in the dashboard: request volume scales with panel count × poll rate, not with data-change rate.
4. **A1+A2** — shell state architecture: every keystroke and every 5s poll re-renders a 5,100-line component tree with zero memoization.
5. **C3** — tiny per-request ClickHouse inserts (compounds with D1; fix both sides).

---

## A. Frontend rendering (apps/web) — re-render architecture

Context for all A findings: `app/dashboard/dashboard-shell.tsx` is a single 5,109-line client component holding **117 `useState` hooks**. There is **no `React.memo` anywhere under `app/dashboard/`**, no `createContext` to scope updates, and no list virtualization. Tab panes are conditionally mounted (only the active tab renders), which bounds the blast radius — but within the active tab, *any* shell state change re-renders everything.

### A1 (HIGH) — Filter/search inputs are shell state: every keystroke re-renders the whole dashboard
- **Where:** `app/dashboard/dashboard-shell.tsx:669` (`const [metricFilter, setMetricFilter] = useState("")`), passed down at `:4570` (`onMetricFilter={setMetricFilter}`). Audit siblings among the 117 `useState`s for the same pattern (search drafts, panel filter drafts, rename drafts — any state written on `onChange` of a text input).
- **Why it hurts:** one keystroke in the metric filter box re-runs the 5,109-line shell render plus the entire mounted tab (all metric charts included). Typing becomes visibly laggy once an org has enough runs/charts mounted.
- **Fix:** move keystroke-frequency state into the leaf component that owns the input; lift only the **debounced** (~150–250 ms) committed value into the shell. Do this for every text input whose `onChange` currently calls a shell `setState`.
- **Done when:** typing in the metrics filter does not re-render `DashboardShell` (verify with React DevTools profiler or a render counter).

### A2 (HIGH) — 5s poll installs fresh object identities and re-renders every mounted child; no memo boundaries exist
- **Where:** `app/dashboard/dashboard-shell.tsx:1424–1427` (`setSummary(nextSummary)` / `setOverview(...)` unconditional every 5s poll), `:813` (`const sortedRuns = summary.runs` — new array identity per poll), and the absence of `memo(` in any file under `app/dashboard/`.
- **Why it hurts:** even with zero data change, every 5s tick re-renders the active tab pane and every chart under it; all `useMemo`s keyed on `summary.runs`/`sortedRuns` (e.g. `:936`) recompute.
- **Fix (two parts, same packet):**
  1. In `loadDashboard`, skip `setSummary`/`setOverview` when the payload is deep-equal to current state (cheap: compare a server-provided max `updated_at`, or fall back to `JSON.stringify` equality of the response body before parsing into fresh objects).
  2. Wrap the heavy leaves in `React.memo` with stable props: `MetricChart`, the runs-table row component in `app/dashboard/runs/runs-workspace.tsx` (rows mapped at `:500`), `workspace-panel-card.tsx`, and the tab panes themselves. Hoist inline lambdas/objects passed to these into `useCallback`/`useMemo` in the shell — memo is useless without stable props.
- **Done when:** with no running runs, a poll tick causes zero re-renders below the shell (profiler-verified).

### A3 (MEDIUM) — Chart hover is React state: full chart re-render (incl. per-point polyline strings) on every mousemove
- **Where:** `app/dashboard/metrics/metric-chart.tsx:385` (`const [hover, setHover] = useState<HoverPoint>(null)`), `:434`/`:463` (set on move/leave), `:567` (`hoverRows` derived in render body), and inline geometry built in JSX each render: `:998` (`(item.normalizedPoints ?? []).map(point => ...)` for SVG point strings) and `:254–260` (mini-chart polyline built the same way).
- **Why it hurts:** every mousemove over a chart re-renders the whole component; for sparse-SVG charts the per-point `points` strings are rebuilt each time. The component already positions the tooltip imperatively via refs (`:619–631`) — the React state round-trip is the remaining cost.
- **Fix:** memoize per-series polyline/point strings with `useMemo` keyed on `normalizedSeries`/scales (so hover re-renders don't rebuild geometry), and move crosshair + tooltip-row rendering to the existing imperative ref path (or throttle `setHover` with `requestAnimationFrame`). Dense-mode canvas is already fine — don't touch the draw effect at `:470–537`.
- **Done when:** mousemove over a 50-series chart triggers no geometry recomputation (only tooltip DOM updates).

### A4 (MEDIUM) — Unbounded client caches retained for the session
- **Where:** `app/dashboard/dashboard-shell.tsx:615` + `:851–858` — `runDirectoryRef`, a `Map<string, RunSummary>` accumulating every run ever seen (full `config`/`metadata`/`latest_metrics` per entry), never evicted. Same for `compareArtifactCacheRef` (`:637–639`, filled at `:2226`/`:2361`).
- **Why it hurts:** paging through a 10k-run org retains ~10k enriched summaries (tens of MB) in a long-lived monitoring tab; GC can never reclaim them.
- **Fix:** LRU-cap both maps (e.g. 2,000 entries): on insert past cap, evict oldest keys not in `selectedRunIds`/`primaryRunId`/`referenceRunId`.
- **Done when:** map sizes are bounded under a page-through-everything session.

### A5 (LOW-MEDIUM) — Runs table renders all rows unvirtualized
- **Where:** `app/dashboard/runs/runs-workspace.tsx:500` (`workspaceRuns.map((run, index) => ...)`); page size caps at 100 today, but selections up to `MAX_SELECTED_RUNS = 2000` (`src/state.js:1`) can flow into workspace lists.
- **Fix:** only worth virtualizing if rows regularly exceed ~200; otherwise cap what reaches the map and rely on A2's row memoization. Do A2 first, re-measure, then decide.

---

## B. Frontend data layer (apps/web) — polling, fetching, bundle

### B1 (HIGH) — Live refresh refetches every metric's full series for every run every 5s; no delta fetch
- **Where:** `app/dashboard/dashboard-shell.tsx:1659–1679` (live tick), `:2008–2049` (main series effect), `:2051–2078` (pinned), `:2080–2132` (workspace), `:5007–5085` (`fetchBatchedMetricSeries`/`fetchMetricSeriesPatch`).
- **Defect:** while any charted run is `running`, all three series effects re-POST `/api/metrics/series` for **all** panel metrics × **all** runs in the fetch set (finished runs included) with the full 1200-bucket window. Workspaces allow up to 200 panels/section (`dashboard-models.ts`, `sanitizeWorkspaceSection`).
- **Fix:** when `isLiveRefresh`, restrict the fetch set to runs with `status === "running"` (plus runs whose series is still empty) and merge via the existing `mergeMetricSeriesPatches`; keep full fetch only on signature change. Optionally add an `after_step` param to `/api/metrics/series` and thread through `fetchMetricSeriesPatch`.
- **Done when:** with 1 live + 99 finished runs charted, the 5s tick fetches series for 1 run.

### B2 (HIGH) — Log tail fetches up to 3,000 lines every 15s to display 5 — and shows the wrong tail
- **Where:** `app/dashboard/detail/overview.tsx:94–174` (`TAIL_PAGE_LIMIT = 6`, `TAIL_PAGE_SIZE = 250`, `TAIL_POLL_MS = 15_000`).
- **Defect:** the console-log API only pages forward, so the panel walks 6×250 lines per stream per poll and keeps the last 5; for logs >1500 lines the "tail" is actually the middle (acknowledged in a comment). No visibility gate.
- **Fix:** add a `tail=N`/descending-order option to `GET /api/runs/:id/logs` (server change in `apps/rust-server/src/store/console_logs.rs` + handler) and fetch exactly 5 lines; gate the interval on `document.visibilityState === "visible"` (mirror `dashboard-shell.tsx:1640–1651`).

### B3 (HIGH) — Zero code splitting: all 15 tab panes (~28k lines TSX) in one client chunk
- **Where:** `app/dashboard/dashboard-shell.tsx:19–39` (static imports of every pane); `next/dynamic` is unused anywhere in `apps/web`.
- **Fix:** wrap rarely-hit panes (`ReportsTabPane`, `InsightsTabPane`, `SettingsTabPane`, `CompareView`, `DistributedTabPane`, `AgentTabPane`, `DatasetsTabPane`, `ArtifactsTabPane`) in `next/dynamic(() => import(...), { ssr: false, loading: ... })`. Keep Runs/Metrics/Detail static.
- **Done when:** first-load JS for `/dashboard` drops materially (compare `next build` output before/after).

### B4 (HIGH) — Five-round-trip startup waterfall before first run renders
- **Where:** `app/dashboard/dashboard-shell.tsx:1326–1351` (`loadProjects`: `/projects` → awaited → `/api/dashboard/preferences`), `:1615–1621`/`:1630–1635` (`loadDashboard` gated on `projectPreferenceReady`), `:1398–1420` (`/api/runs/summary` awaited, then `/api/overview`).
- **Fix:** `Promise.all` the projects+preferences pair; in `loadDashboard`, start the overview request before awaiting summary. Keep the preference gating logic.

### B5 (MEDIUM-HIGH) — 5s metadata poll runs on every tab, never backs off, blindly setStates
- **Where:** `app/dashboard/dashboard-shell.tsx:1637–1653` (poll), `:1424–1427` (unconditional setState — shared with A2 part 1).
- **Fix:** skip polling on tabs that don't show run data (settings/reports); stretch to 30s when the previous summary had no `running` runs; make unchanged polls identity no-ops (A2 packet covers the diffing).

### B6 (MEDIUM) — Run-detail KPI poll (45s) and log tail (15s) not visibility-gated
- **Where:** `app/dashboard/detail/tab-pane.tsx:390–392`, `:498–542`, `:545–549`; plus B2's interval.
- **Fix:** wrap ticks in `document.visibilityState === "visible"`; refresh once on `visibilitychange` → visible.

### B7 (MEDIUM) — Report panels each independently re-resolve the same runset, fetching serially
- **Where:** `app/dashboard/reports/block-types/panel-chart-renderer.tsx:113–165`, `:234–262` (`resolveRunsForRunset`: awaited `/runs` GET in a per-project `for` loop), `:334–370` (per-metric serial awaits); same pattern in `run-set-table.tsx:700–755`, `panel-renderers/parallel-coordinates-renderer.tsx`, `panel-renderers/run-comparer-renderer.tsx`.
- **Fix:** hoist runset resolution to the panel-grid block (resolve each unique runset once, pass `ResolvedRun[]` down), or add a module-level promise cache keyed by `JSON.stringify(fetchSpec)`; convert serial loops to `Promise.all`.

### B8 (MEDIUM) — Alerts pane refetches `/api/runs/summary` the shell already holds
- **Where:** `app/dashboard/alerts/tab-pane.tsx:99–121`.
- **Fix:** pass `sortedRuns` from the shell and compute `buildDatasetRows(sortedRuns, metricKey)` in a `useMemo`; delete the local fetch effect.

### B9 (MEDIUM, architectural) — No conditional requests despite a 5s polling architecture
- **Where:** `src/api.js` (`ApiClient.request` — raw fetch, no ETag/If-None-Match, no request dedup).
- **Fix:** store `ETag` per GET path; send `If-None-Match`; on 304 return a "no change" sentinel callers use to skip setState. Requires the Rust server to emit ETags on the polled GETs (pairs with C-side work; do after B5).

### B10 (LOW-MEDIUM) — Artifacts/objects refetch + blank-flash on tab hops; histogram live refetch of 100 objects/5s
- **Where:** `app/dashboard/dashboard-shell.tsx:2204–2247` (artifacts), `:2249–2286` (objects) — effects keyed on `activeTab` clear + refetch when the run hasn't changed; `:1206` + `:2134–2202` — histogram timelines refetch `limit=100` objects per key each live tick.
- **Fix:** early-return when the loaded run id matches and state is populated; for histograms, track max seen step/id and fetch incrementally, or slow the cadence to 15–30s.

---

## C. Rust API server (apps/rust-server)

Architecture recap (verified): all control-plane state lives in one in-memory `StoreData` (`src/store/mod.rs:1266`, well-indexed with BTreeMap secondary indexes and a run-filter cache) behind a **single `tokio::sync::Mutex`** (`src/store/mod.rs:211`); metric points go to per-org ClickHouse `MetricStore`s; Postgres is the control-plane system of record via `persist_locked` (`src/store/mod.rs:1073`).

### C1 (HIGH) — Every metric ingest runs the plan-capacity gate: 3–4 ClickHouse aggregates + full artifact scan per POST
- **Where:** `src/store/runs/metrics.rs:55–65` and `:96–105` (`enforce_plan_capacity` called on both idempotent and plain paths of `log_metrics`) → `src/store/usage.rs:192` → `usage_counts_for_org` (`usage.rs:236+`), which per call runs `count_points_for_org` (full-org COUNT, `src/metric_store.rs:1103`), `count_points_for_org_period`, `count_series_for_org`, `warehouse_storage_bytes_for_org`, then locks `data` and scans **all** `data.artifacts` / `artifact_versions` / `artifact_upload_sessions` filtered by org.
- **Why it hurts:** ingest cost is O(org data) regardless of payload; 10 concurrent SDK loggers at modest rates translate into a constant ClickHouse aggregate-query storm and long global-mutex holds. This is the server-side dominant cost per point.
- **Fix:** cache write-gate `UsageCounts` per org with a short TTL (15–30s) in a `HashMap<Uuid, (Instant, UsageCounts)>` on `Store`, apply the incoming `UsageDelta` against the cached counts, and only recompute on expiry (or on 402-adjacent state changes). Keep exact recompute for `usage_summary`/`usage_export`. The `refresh_api_request_rollups_for_period` debounce (`usage.rs:865–889`) already shows the intended pattern.
- **Done when:** steady-state ingest issues zero ClickHouse COUNT queries between cache refreshes.

### C2 (HIGH) — Global store lock is a `Mutex`, so concurrent *readers* serialize; fallback run listing clones every matching run under it
- **Where:** `src/store/mod.rs:211` (`data: Arc<Mutex<StoreData>>`, ~30+ lock sites per store module); `src/store/runs/query.rs:310–330` (`collect_filtered_runs_with_search` non-indexed path: `.filter(...).cloned().collect()` over all org runs — full `RunRow` clones incl. config/metadata JSON — while holding the lock).
- **Why it hurts:** every request (auth context, run access checks, listings) takes the same exclusive lock; dashboard read QPS from multiple users serializes even though most accesses are reads. The clone-all path multiplies hold time on orgs with many runs whenever a filter/sort misses the indexed page path.
- **Fix (two packets):**
  1. Swap `Mutex<StoreData>` → `tokio::sync::RwLock<StoreData>`; convert read-only sites to `.read()`. Mechanical but wide — do it as its own PR, no logic changes.
  2. In the fallback listing path, collect matching run **ids** under the lock, then clone only the requested page after sorting ids (metric sorts already have `metric_sorted_page`); or store `Arc<RunRow>` in the map so "clone" is a refcount bump.
- **Done when:** concurrent GET benchmarks (`npm run benchmark:large-runs` exists) show reads scaling with cores.

### C3 (HIGH) — One tiny ClickHouse INSERT per ingest request → part explosion
- **Where:** `src/metric_store.rs:321–340` (`insert_points`: fresh `client.insert("metric_points")` + `end()` per call); `log_metrics` passes one request's points (often a single point, given the SDK's current per-event delivery, D1).
- **Why it hurts:** ClickHouse degrades badly under many small inserts (too many parts, merge pressure) — exactly the hosted-warehouse cost profile.
- **Fix:** enable async inserts for the point tables — set `async_insert=1, wait_for_async_insert=0` on the insert client (the `clickhouse` crate supports per-insert settings), or introduce a per-org buffered inserter (`clickhouse::inserter` with `with_max_rows`/`with_period` ~1s) flushed by a background task. Apply the same to `insert_rank_points` and console-log inserts. Preserve the idempotency semantics: the response may report accepted-not-yet-durable — if that's unacceptable, use `wait_for_async_insert=1` (still batches server-side).
- **Done when:** sustained 1k points/s produces O(1) parts/sec, not O(requests).

### C4 (MEDIUM-HIGH) — Global data mutex held across ClickHouse awaits in the usage snapshot job
- **Where:** `src/store/usage.rs:902–925` (`write_usage_daily_snapshots`: `let mut data = store.data.lock().await;` then `store.persist_locked(...).await` — a network round trip — before pushing to `data.usage_daily`), looped per org.
- **Why it hurts:** while each snapshot persists, **every** request on the server blocks on the global mutex; with N orgs that's N sequential stalls per job run.
- **Fix:** restructure to `persist_locked(...).await` first, then lock briefly to `data.usage_daily.push(snapshot)`. Audit the store for the same pattern (`grep -n "data.lock().await" -A5` sites where an `.await` occurs before the guard drops) — `log_metrics`' scoping (`metrics.rs:31–52`) is the correct model.
- **Done when:** no `.await` on network I/O executes while the `data` guard is live (clippy's `await_holding_lock` won't catch tokio Mutex guards — verify by review).

### C5 (MEDIUM) — Per-event idempotency: one Postgres/CH operational-record write + global-set reserve per logged point
- **Where:** `src/store/runs/metrics.rs:30–88` (idempotent path: `reserve_idempotency_key` → `persist_locked("idempotency", ...)` → data-lock insert, per request), `src/store/mod.rs:1247` (`reserve_idempotency_key` on `inflight_idempotency: Mutex<BTreeSet>`). The SDK attaches an idempotency key to **every** event (see D-context), so this whole ceremony runs per point.
- **Fix:** lands mostly for free once D1 batches delivery (one key per batch). Server-side: also verify `delete_expired_idempotency` (`usage.rs:930+`) is scheduled; the in-memory `idempotency` map otherwise grows for 7 days of keys.

### C6 (LOW-MEDIUM) — Redundant clone in selection projection
- **Where:** `src/store/runs/query.rs:240–247` (`selection_run_value(run.clone(), ...)` inside `into_iter().map` where `run` is already owned — the clone exists only because `controls.get(&run.id)` borrows after move).
- **Fix:** restructure to look up the control before constructing (`let control = controls.get(&run.id)...; selection_run_value(run, control)`respecting borrow order). Small win; batch with C2-packet-2.

---

## D. Python SDK (packages/python-sdk) — production-critical

Cross-cutting: D1+D2+D4 compound. The producer side (client-side buffer at `client.py:1367–1551`, SQLite claim logic) is well designed; delivery is the bottleneck.

### D1 (HIGH) — Uploader sends one HTTP request per logged event; batching exists only for claiming
- **Where:** `instantml/async_queue.py:195–245` (`drain_queue_once` claims up to 256 events/1 MB via `claim_batch` (`:417–477`), then loops `_send_request` per event at `:213–225`).
- **Why it hurts:** at 1k steps/s the uploader caps at per-request round-trip rate (~50–200 req/s over WAN); backlog grows to the 512 MB queue cap, then events drop.
- **Fix:** group consecutive claimed events targeting the same `POST /runs/{id}/metrics` into one batched request (requires/uses a batch ingestion body — coordinate with the Rust batch route; if none exists, add `POST /runs/{run_id}/metrics/batch` accepting `[{metrics, step, timestamp}, ...]`), mark all grouped sequence_ids processed together. Keep per-event delivery for non-metric paths.

### D2 (HIGH) — No HTTP connection reuse anywhere; no compression
- **Where:** `instantml/client.py:389–436` (`Client._request` → `urllib.request.urlopen` per call at `:414`) and `instantml/async_queue.py:878–910` (`_send_request`, `urlopen` at `:900`). Every request pays TCP+TLS handshake.
- **Fix:** shared persistent `http.client.HTTPSConnection` pool keyed by host (stdlib-only, matching the SDK's zero-dep posture), gzip `Content-Encoding` for bodies >1 KB. Preserve existing retry/error mapping.

### D3 (HIGH) — Enqueue path runs a full-table `SUM()` over the SQLite queue on every producer flush
- **Where:** `instantml/async_queue.py:716–723` (`_available_queue_bytes`: `SUM(body_size_bytes)` over non-processed events), called from `enqueue_many_prepared` (`:357`) on every flush (default every 64 events/20 ms, `client.py:1531–1545`).
- **Why it hurts:** with a large backlog (slow/offline server) each 20 ms flush scans millions of rows → producer buffer (cap 4096, `client.py:1404`) overflows → silent drops in the training loop.
- **Fix:** maintain a running `queued_bytes` counter in the existing `counters` table — increment in the insert transaction, decrement in `mark_processed`/`mark_failed`/`prune_processed` — and read that.

### D4 (MEDIUM-HIGH) — Per-event UPDATE+commit and per-cycle WAL checkpoint bound uploader throughput to disk commit rate
- **Where:** `instantml/async_queue.py:497–515` (`mark_processed`: one UPDATE+commit per event), `:537–569` (`mark_retry`: extra SELECT), `:656–674` + `:785–791` (`wal_checkpoint(truncate)` after every productive drain cycle).
- **Fix:** add `mark_processed_many(sequence_ids)` (single `UPDATE ... IN` + one commit per claimed batch); in `mark_retry` reuse the `attempts` value already fetched by `claim_batch`; checkpoint WAL at most every N seconds.

### D5 (MEDIUM) — numpy/torch scalars rejected in the log hot path and **silently dropped** in async mode
- **Where:** `instantml/validation.py:60–63` (`_is_scalar_number` requires exact `int`/`float`), `log_payload.py:23–36` (raises), `client.py:1653–1677` (`_async_hot_path` converts to warn-and-drop, rate-limited at `client.py:3108–3111`). `_tensor_to_python` (`serialization.py:53–61`) exists but is not applied in `log()`.
- **Why it hurts:** a PyTorch user logging `np.float32` or 0-d tensors loses their entire training history with one warning per 5s. (Correctness bug with performance framing — highest user-facing stakes in this section.)
- **Fix:** in `_classify_log_payload`/`_validate_metrics`, coerce values exposing `.item()` via try/except before classification.

### D6 (MEDIUM) — Spool mode: two fsyncs per event under the run lock in the training thread
- **Where:** `client.py:3053–3065` (`_submit` spool branch inside `self._lock`) → `_write_process_event` (`:3869–3882`): temp write + `os.fsync` + rename + `_fsync_dir` per event.
- **Fix:** append-only JSONL segment file with fsync every N events/T ms and on `finish()`; keep atomic rename only for segment rotation.

### D7 (LOW) — Assorted hot-path overhead (batch these into one packet)
- Credentials file re-read+TOML-parsed per sync-mode request (`client.py:400` → `credentials.py:10–29`); cache on the client, invalidate on 401.
- System-metrics sampler re-runs `nvmlInit`/`nvmlShutdown` and recreates `psutil.Process` every sample (`client.py:3786–3832`); hoist into the sampler, shutdown in `stop()`.
- Per-event `json.dumps(sort_keys=True)`, `uuid.uuid4()` idempotency keys, per-call `_utc_timestamp` (`async_queue.py:319–336`, `client.py:3091`, `:2186–2195`); drop sort_keys, derive keys from per-run prefix + counter, reuse encoded bytes for length.

---

## E. Node reference server (apps/server) — dev/demo only

`apps/server/README.md` states this server is deprecated: the Rust/ClickHouse service is production; this is a wire-contract oracle and local fallback. Fix only what makes local dev painful — it's the backend for `npm run dev:api:node` and the local E2E recipe.

### E1 (MEDIUM here; architecturally severe) — Entire DB pretty-printed + synchronously rewritten on every mutation
- **Where:** `src/db.js:173–177` (`persist()` = `writeFileSync(JSON.stringify(state, null, 2))`), wrapped around every mutation via `write()` (`:2777–2781`).
- **Fix:** dirty-flag + 250 ms–1 s debounced flush (flush on close/exit), drop pretty-print, write tmp-file + rename.

### E2 (MEDIUM) — Every authenticated request (GETs included) rewrites the whole DB
- **Where:** `src/db.js:187` (`authenticateApiKey` wrapped in `write(persist, ...)` because it touches `key.last_used_at` at `:345`).
- **Fix:** call it without the persist wrapper; let `last_used_at` ride the next real flush.

### E3 (MEDIUM) — Plan-capacity check JSON-stringifies the org's entire dataset on every ingest
- **Where:** `src/db.js:471–472` → `usageForOrganization` (`:1745–1803`) → `estimateJsonBytes` (`:1887–1889`); also called from `createRun` (`:384`), `createProject` (`:364`), `createArtifact` (`:549`).
- **Fix:** incremental per-org usage counters on `state`, full recompute only in `usageSummary`/`usageExport`. (Note the symmetry with C1 — same defect class in both backends.)

### E4 (MEDIUM) — Idempotency records: O(n) scan per metric POST, unbounded growth
- **Where:** `src/db.js:461` (`state.ingestRequests.find(...)`), `:493–503` (append, never pruned; also inflates every `persist()`).
- **Fix:** lazily-cached `Map` keyed `org_id + "\0" + key` (copy the `metricSeriesIndex` pattern at `:2487–2497`); cap retention at newest ~10k.

### E5 (LOW) — Per-point duplicate attribute rows; artifacts fully buffered in memory
- **Where:** `src/db.js:478–490` (a `float_series` attribute row materialized per metric point — doubles state size), `:514–543` (full-scan reads); `src/server.js:11`, `:142`, `:273–281`, `:315–324` + `src/artifact-store.js:14–33` (50 MB base64 JSON parsed on the event loop; downloads via `readFileSync`).
- **Fix:** synthesize float_series attributes on read; per-run metric index map; `fs.createReadStream(...).pipe(res)` for downloads.

---

## Suggested subagent work packets (dependency-ordered)

| # | Packet | Findings | Touches |
|---|--------|----------|---------|
| 1 | SDK delivery batching + batch endpoint | D1, C5 (server side) | `async_queue.py`, `client.py`, `rust-server` batch route |
| 2 | SDK connection reuse + gzip | D2 | `client.py`, `async_queue.py` |
| 3 | SDK queue accounting (counter + batched acks) | D3, D4 | `async_queue.py` |
| 4 | SDK numpy/torch coercion (do first — data loss) | D5 | `validation.py`, `log_payload.py` |
| 5 | Rust write-gate usage cache | C1 | `store/usage.rs` |
| 6 | Rust RwLock swap (mechanical, own PR) | C2.1 | `store/**` |
| 7 | Rust listing clone reduction + selection clone | C2.2, C6 | `store/runs/query.rs` |
| 8 | Rust async_insert / buffered inserter | C3 | `metric_store.rs` |
| 9 | Rust lock-across-await audit | C4 | `store/usage.rs` + sweep |
| 10 | Shell input-state extraction + debounce | A1 | `dashboard-shell.tsx` + leaf inputs |
| 11 | Poll diffing + memo boundaries | A2, B5 | `dashboard-shell.tsx`, `metric-chart.tsx`, `runs-workspace.tsx` |
| 12 | Live-refresh delta fetching | B1, B10 | `dashboard-shell.tsx` |
| 13 | Tab-pane code splitting | B3 | `dashboard-shell.tsx` |
| 14 | Startup waterfall flattening | B4 | `dashboard-shell.tsx` |
| 15 | Log tail endpoint + visibility gates | B2, B6 | `detail/*.tsx`, rust `console_logs` |
| 16 | Report runset hoisting | B7, B8 | `reports/block-types/*` |
| 17 | Client cache LRU caps | A4 | `dashboard-shell.tsx` |
| 18 | Chart hover imperative path | A3 | `metric-chart.tsx` |
| 19 | ETag/304 layer (after 11) | B9 | `src/api.js`, rust handlers |
| 20 | Node dev-server hygiene (optional) | E1–E5 | `apps/server/src/*` |

Packets 1–4 and 5 are the highest leverage. 10–12 change perceived dashboard speed the most. Each packet is independently landable; only 19 has an ordering dependency (after 11's diffing) and 1 needs the server batch route agreed before the SDK side lands.
