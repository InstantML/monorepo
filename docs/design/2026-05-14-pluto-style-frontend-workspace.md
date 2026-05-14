# Design: Pluto-Style Frontend Workspace, Logs, And Evidence

Date: 2026-05-14

Status: Accepted for narrow first slice after review

Owner: Codex

## Summary

This change tightens the InstantML dashboard into a denser, darker product workspace inspired by Pluto's project and run views while preserving our stronger data contracts: paginated run summaries, batched metric APIs, row-first compare, and artifact-aware comparison.

The smallest useful version is one cohesive shell:

- A project workspace where the left side is a compact run selector/table and the right side is the existing chart/dashboard/compare surface.
- A run workspace inside the existing `/dashboard/detail` tab with a persistent run header and local tabs for Summary, Data, Logs, Files, System, and Graph.
- Bounded stdout/stderr storage and APIs backed by ClickHouse.
- An evidence explorer that reuses existing artifacts and rich-object endpoints before adding a new file-storage layer.

The demo account identity remains stable. The existing shared demo email `hello@instantml.ai` and legacy alias `hello@instantml.com` should continue resolving to the same demo organization and tenant service instead of provisioning a new service on every sign-in.

## Goals

- Improve readability and density with neutral dark tokens, flatter panels, compact rows, consistent sticky headers, and explicit button variants.
- Split the largest frontend surfaces enough that Run workspace, Logs, Files, charts, compare, and derived tabs can be polished independently.
- Add ClickHouse-backed console log ingestion and bounded reads by run, stream, cursor, limit, and search.
- Add SDK and uploader methods for stdout/stderr logging that do not block scalar metric logging any more than existing SDK requests do.
- Add a virtualized terminal UI with stdout/stderr tabs, filter search, timestamps, line numbers, and safe ANSI rendering.
- Add a Files/evidence explorer with a per-run tree for artifacts, rich objects, checkpoints, and uploaded files plus a preview pane.
- Preserve batched metric APIs, row-first compare, artifact-aware comparison, and the existing dashboard tabs during migration.

## Non-Goals

- Replacing the current Next/React app framework.
- Copying Pluto's tRPC, local-query, Dexie, or per-run/per-metric fanout model.
- Building a full file object model beyond current artifact/rich-object endpoints.
- Adding new auth behavior beyond preserving stable shared demo identity.
- Loading all 100k seeded runs, all metric histories, or entire console streams into the browser.
- Pluto-style match navigation, live tailing, or previous-match lookup for logs. The first slice supports bounded forward pages plus filter search.
- Adding global dashboard nav items for run-only tabs.

## Users and Use Cases

Training engineers need to scan recent runs, compare selected runs, inspect one run's logs and evidence, and verify artifacts without losing context. The main workflows are:

- Search/filter recent runs, select a bounded set, and compare charts without loading the full warehouse.
- Open a single run and keep its identity, status, tags, and project visible while switching between Summary, Data, Logs, Files, System, and Graph.
- Search stdout/stderr lines around a failure and page forward without fetching the entire log stream.
- Browse evidence for one run by artifact, object, file, or checkpoint and preview it in place.

## Mock Layouts

Project workspace:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ InstantML        Demo org / Project: benchmark-demo             Search  User │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ RUNS          │ Charts / Dashboard / Compare                                 │
│ [search] [⚙]  │ sticky metric toolbar: key, smoothing, x-axis, refresh        │
│               │ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
│ ● run-100000  │ │ eval/return  │ │ train/loss   │ │ throughput   │          │
│ ○ run-099999  │ │ bounded API  │ │ bounded API  │ │ bounded API  │          │
│ ○ run-099998  │ └──────────────┘ └──────────────┘ └──────────────┘          │
│ ... compact   │ row-first compare remains below/behind compare tab           │
│ cursor footer │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Run workspace:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ benchmark-demo / run-100000            finished  tags...        actions      │
│ started · duration · commit · host                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ Summary | Data | Logs | Files | System | Graph                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ Selected tab body. Header stays sticky. Existing dashboard tabs remain in nav.│
└──────────────────────────────────────────────────────────────────────────────┘
```

Logs tab:

```text
┌ stdout ─ stderr ───────────────────────────── filter ── refresh ─────────┐
│ ts                         line      message                            │
│ 2026-05-14 11:21:03.123    128941    Epoch 12/80 loss=0.218 lr=3e-4     │
│ 2026-05-14 11:21:03.247    128942    ANSI colors render as safe spans   │
│ ... virtualized visible rows only ...                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Files/evidence tab:

```text
┌ evidence tree ───────────────┬ preview pane ─────────────────────────────┐
│ [search files]               │ checkpoints/model.pt                      │
│ ▾ Checkpoints                │ metadata, size, step, download            │
│   model.pt                   │                                            │
│ ▾ Media and rich objects     │ image/video/audio/table/histogram previews│
│   rollout.mp4                │ reuse current artifact/object endpoints   │
│ ▾ Files                      │                                            │
│   notes.json                 │                                            │
└──────────────────────────────┴────────────────────────────────────────────┘
```

## Proposed Design

Frontend:

- Keep `/dashboard/:tab` route compatibility and existing top-level tabs.
- Do not add top-level route IDs for `logs`, `files`, `system`, or `graph` in this first slice.
- Add local `RunWorkspaceTabId = "summary" | "data" | "logs" | "files" | "system" | "graph"` state inside `/dashboard/detail`.
- Keep direct links simple in this PR: `/dashboard/detail` opens the last selected run and defaults to Summary. Route-addressable run subtabs can follow once the component split stabilizes.
- Add a `RunWorkspace` composition around the existing Run Detail data. It renders the persistent run header, the run tab bar, and tab-specific bodies.
- Extract focused components from `apps/web/app/dashboard-components.tsx` into `apps/web/app/dashboard/components/*` while leaving `dashboard-components.tsx` as a compatibility module during the first split.
- Replace broad global dark button styling with explicit variants: `.primary-button`, `.secondary`, `.ghost`, `.icon-button`, `.copy-button`, `.tab-button`, and feature-specific row buttons.
- Gate data loads by active tab:
  - Summary/Data can use existing selected-run metric state.
  - Logs fetch only when the top-level tab is `detail`, the local run tab is `logs`, and a primary run exists.
  - Files fetch artifacts and rich objects only when the top-level tab is `detail` with local run tab `files`, or existing artifact/detail tabs require them.
  - Compare keeps the current side-by-side and artifact-aware paths.
- Keep the current single-key batched endpoint for chart panels, but cap the number of active panel fetches and queue requests with limited concurrency. A multi-key endpoint is required before supporting large saved panel grids.
- Make `/api/overview` lazy outside the first paint where practical, or ensure the first dashboard request benchmark covers `/api/overview` plus `/api/runs/summary` together.

Backend:

- Add a ClickHouse `console_log_lines` table owned by the tenant data service.
- Add `apps/rust-server/src/store/console_logs.rs` so log validation, write, and read behavior does not bloat `store/mod.rs` or `runs.rs`.
- Add `POST /api/runs/:run_id/logs` for bounded batch ingestion and `GET /api/runs/:run_id/logs` for bounded reads.
- Require `sdk:ingest` for writes and normal run access for reads.
- Validate run ownership before writing or reading.
- This is a Rust-first endpoint in this PR. Node/Python compatibility oracle tests remain unchanged unless a compatibility shim is explicitly added.

Python SDK:

- Add `Run.log_console(lines, stream="stdout", timestamp=None)`, `Run.log_stdout(...)`, and `Run.log_stderr(...)`.
- In sync mode, send one bounded batch request.
- In buffered mode, queue like existing SDK events.
- In spool mode, write the same request event format so the uploader can drain it; no extra uploader response chaining is needed.
- SDK supplies deterministic per-run, per-stream line numbers. The server rejects missing or invalid line numbers in v1.
- Uploader should send idempotency keys for `/logs` the same way it does for `/metrics`, and the Rust endpoint should deduplicate repeated spooled batches.

Design system:

- Dark neutral canvas, flatter panels, 6-8px radii, one-pixel borders, compact table rows, sticky local headers.
- Buttons do not become primary by default. Primary is explicit and rare.
- Charts and previews use the existing semantic metric colors; shell chrome stays neutral.
- No nested cards for page sections. Use rails, panels, tables, and unframed tab bodies.

Desktop density spec:

- Topbar: 44-48px target height.
- Main toolbar: 32-36px controls, sticky within the workspace.
- Left run rail: 260-280px desktop width, 44-56px row height, one-line name, compact status dot, latest metric, and at most two tags.
- Chart cards: 220-260px minimum visible height, 32-36px local header, compact legend labels, no oversized meta chips.
- Run header: 72-92px total including tab bar; sticky below the app chrome.
- Terminal rows: 28px row height, `ui-monospace`/SFMono stack, timestamp and line columns fixed, message wraps only when the user enables wrap.
- Evidence rows: 32-36px row height, small lucide icons, selected row uses neutral selected background plus accent left rail.
- Mobile: controls remain tappable, but dense tables collapse to drawers/lists without inflating desktop type scale.

Token matrix:

| Token | Light | Dark |
| --- | --- | --- |
| `--canvas` | `#f6f8fa` | `#070a0f` |
| `--surface` | `#ffffff` | `#0d1117` |
| `--surface-elevated` | `#f9fafb` | `#111821` |
| `--surface-hover` | `#eef2f6` | `#171f2a` |
| `--surface-selected` | `#e8f3ff` | `#132338` |
| `--line` | `#d8dee6` | `#263241` |
| `--text` | `#101827` | `#e6edf3` |
| `--muted` | `#5f6b7a` | `#8b98a8` |
| `--accent` | `#087f8f` | `#4aa6ff` |
| `--danger` | `#c2410c` | `#ff8a65` |

Button matrix:

- Default `button`: neutral surface, text color, line border.
- `.primary-button`: accent fill, high contrast text, used only for create/save/confirm.
- `.secondary`: neutral surface variant.
- `.ghost`: transparent command.
- `.icon-button`: square or compact icon control with tooltip/title.
- `.tab-button`: neutral selected/hover states, never primary fill.
- `.copy-button`: compact neutral secondary.
- `.danger`: danger text/border or fill only for destructive confirmation.
- Disabled: reduced opacity, no hover transform or gradient.

Likely to shrink/remove from the current UI:

- Broad stat bands above the runs table.
- Large run rail rows and repeated tag chips.
- Always-visible note previews in compact run rows.
- Oversized chart meta chips.
- Nested cards inside Run Detail.
- Empty System/Graph panels; show concise "not logged yet" states until real data exists.

## Component Impact

Backend:

- New domain request/response structs for console logs.
- New store module for console logs.
- New HTTP routes and handler functions.
- Demo seed should include a small stdout/stderr sample for at least the first demo run.

Frontend:

- New run workspace components, logs terminal, evidence explorer, and ANSI renderer.
- Existing dashboard shell data gates updated for local run tabs.
- Component split under `apps/web/app/dashboard/components/`.
- CSS tokens and button variants updated in `apps/web/app/globals.css`.

Python SDK:

- New console logging methods and tests.
- Uploader continues to replay generic request events, with idempotency for log events.

Storage:

- New ClickHouse table `console_log_lines`.
- Ordered by `(org_id, run_id, stream, line_number, ingest_id)` and partitioned by month of `created_at`.

Docs:

- Update `apps/web/README.md`, `apps/rust-server/README.md`, `apps/rust-server/clickhouse/README.md`, `apps/rust-server/src/store/README.md`, and `packages/python-sdk/README.md`.
- Update `apps/web/TODO.md` to remove or reduce completed button/split debt.

## Data Model

`console_log_lines`:

- `org_id UUID`
- `run_id UUID`
- `stream LowCardinality(String)` with allowed values `stdout` and `stderr`
- `ingest_id UUID`
- `line_number UInt64`
- `message String CODEC(ZSTD(3))`
- `logged_at DateTime64(6, 'UTC')`
- `created_at DateTime64(6, 'UTC') DEFAULT now64(6)`

Indexes/order:

- `ORDER BY (org_id, run_id, stream, line_number, ingest_id)` for deterministic cursor pagination.
- `PARTITION BY toYYYYMM(created_at)` for operational cleanup.
- Search uses bounded `positionCaseInsensitive(message, ?)` over one run/stream for the first slice, with an explicit scan cap and a `truncated` response flag. Add an ngram/bloom/text index only if hosted ClickHouse benchmarks miss the budget.

Limits:

- Max log lines per POST: 50. This keeps the client-valid worst-case batch under the default 1 MB JSON body cap when each line approaches the 16 KiB message limit.
- Max message bytes: 16 KiB.
- Default read limit: 250.
- Max read limit: 1,000.
- Cursor: opaque base64url JSON tuple `{ "line_number": <u64>, "ingest_id": "<uuid>" }`, returned as a string for JS safety.
- Line numbers: required from clients in v1. They are scoped per run and stream.
- Idempotency: writes accept `Idempotency-Key`; repeated identical batches return the stored inserted count.

## API Contracts

`POST /api/runs/:run_id/logs`

Request:

```json
{
  "stream": "stdout",
  "lines": [
    { "line_number": 1, "message": "Epoch 1 loss=1.02", "timestamp": "2026-05-14T18:00:00Z" }
  ]
}
```

Notes:

- `line_number` is required in v1.
- `timestamp` is optional and defaults to server time.
- `Idempotency-Key` is recommended for uploader/drain retries.

Response:

```json
{ "inserted": 1 }
```

`GET /api/runs/:run_id/logs?stream=stdout&cursor=opaque-cursor&limit=250&q=loss`

Response:

```json
{
  "lines": [
    {
      "run_id": "uuid",
      "stream": "stdout",
      "line_number": 1,
      "message": "Epoch 1 loss=1.02",
      "timestamp": "2026-05-14T18:00:00Z",
      "created_at": "2026-05-14T18:00:01Z"
    }
  ],
  "next_cursor": "opaque-cursor",
  "limit": 250,
  "truncated": false
}
```

Frontend request rules:

- Logs tab requests one stream at a time.
- Search resets the cursor.
- The terminal displays only a virtualized slice of returned rows.
- Files tab previews one artifact/object at a time.

SDK methods:

```python
run.log_console(["line 1", "line 2"], stream="stdout")
run.log_stdout("single stdout line")
run.log_stderr(["warning", "traceback"])
```

## Performance Considerations

Expected volume:

- A normal run can produce thousands to millions of log lines.
- The UI should request at most 250-1,000 lines per read page, one stream at a time.
- Initial dashboard and run list must not fetch logs, artifacts, objects, or all metric history.

Read/query shape:

- Run summary remains paginated/cursor based. If current implementation is offset-backed, preserve the existing UI contract and record it as a performance gap rather than deepening the issue.
- Chart fetches continue through batched run IDs.
- Logs are filtered by one org/run/stream and cursor.
- Files/evidence loads one selected run and one selected preview.

Latency target:

- Run summary/search/filter: stay near the existing benchmark budget.
- Logs page: p95 under 500 ms for a 250-line page against hosted ClickHouse.
- Metric preview: reuse existing chart budget.
- Initial dashboard: benchmark `/api/overview` plus `/api/runs/summary`; if overview dominates, lazy-load it after the run table.
- Run summaries: preserve pagination and avoid serializing unbounded metric-key maps for high-cardinality runs. A separate bounded metric catalog endpoint is preferred before high-cardinality expansion.

Memory:

- Do not store full log streams in React state.
- Keep only the current page and visible virtualized rows.

Batching:

- SDK console logging is batched by request.
- Metric APIs remain batched by run IDs.
- Avoid Pluto-style per-run/per-metric query fanout.
- Workspace panel requests are capped to visible/active panels and fetched through a small request queue, not unbounded `Promise.all`.

Measurement:

- Add tests that assert initial dashboard entry does not request logs/files.
- Reuse benchmark scripts to time run search/filter and add a log-page query benchmark after data exists.

## Simplicity Review

The first slice adds a single dedicated table and two endpoints for logs instead of overloading attributes or inventing a general file model. The Files tab reuses current artifacts/rich objects. This gives the product the visible Pluto-like affordances without committing to a broader storage layer.

Deferred complexity:

- Persistent saved workspace views beyond current local view behavior.
- Full-text log indexes.
- Infinite streaming/tailing via SSE or WebSockets.
- Pluto-style match navigation for log search.
- Server-side ANSI processing.
- New artifact namespace or folder object table.
- Route-addressable run subtabs.

## Failure Modes

- Log POST with invalid stream returns validation error.
- Log POST with missing/invalid line numbers returns validation error.
- Log POST with oversized messages returns validation error.
- Duplicate idempotency key with different body returns conflict.
- Read with inaccessible run returns not found/forbidden through existing access helpers.
- Search may be slower on huge logs; the query remains bounded to one run/stream with a scan cap and can return `truncated`.
- Artifact previews may be unavailable if bytes are missing; UI shows current fallback text/download links.
- Demo auth must reuse the existing demo org/service; any new demo service provisioning is a regression.

## Testing Plan

Backend:

- Unit tests for stream validation, line validation, cursor/limit validation, and response cursor construction.
- Unit tests for idempotency-key replay on log writes.
- HTTP integration coverage for POST/GET logs where existing Rust API tests allow it.
- Migration split-statements test should continue passing with the new table.

Python SDK:

- Tests for `log_console`, `log_stdout`, `log_stderr`, buffered queue behavior, SDK line number assignment, and spool event shape.
- Uploader test to prove generic event replay handles logs with idempotency keys.

Frontend:

- Unit tests for ANSI tokenization, terminal virtualization math, evidence tree construction, local run tab state, and no default primary button assumptions where practical.
- UI smoke updates:
  - Initial dashboard does not fetch logs or objects.
  - Opening Logs fetches only selected run logs.
  - Opening Files fetches selected-run artifacts/objects.
  - Compare still does not fetch rich objects.
  - Switching runs aborts or ignores stale log responses.
  - Run search remains paginated.

End-to-end:

- Start ClickHouse, Rust API, and frontend.
- Sign in as the shared demo account.
- Verify recent runs load from the seeded ClickHouse tenant.
- Open a run, inspect Summary, Data, Logs, Files, System, and Graph.
- Search logs and files/evidence.

Coverage:

- Target remains 100% meaningful first-party coverage for new pure logic and API validation paths.

## Documentation Plan

- `apps/web/README.md`: new hierarchy, logs/files tabs, data gating, smoke test commands.
- `apps/rust-server/README.md`: console log endpoints and ClickHouse table.
- `apps/rust-server/clickhouse/README.md`: schema table summary.
- `apps/rust-server/src/store/README.md`: new `console_logs.rs` ownership.
- `packages/python-sdk/README.md`: console logging methods and spool behavior.
- `apps/web/TODO.md`: mark global dark button styling and split debt progress.

## Alternatives Considered

- Store logs as rich text attributes: rejected because log streams need cursor pagination and can be much larger than attribute metadata.
- Store logs only as uploaded artifacts: rejected because the UI needs line search, stream tabs, line numbers, and bounded reads.
- Copy Pluto's query model: rejected because it fans out by selected run/metric and fetches logs unbounded.
- Build a general files table now: rejected because existing artifacts/rich objects can support the first evidence explorer.

## Review Notes

Fresh reviewer 1:

- Finding: The mocks were too schematic to drive Pluto-level hierarchy; run-specific tabs should not become global dashboard tabs; button/token rules needed an implementable matrix; logs needed explicit first-slice interaction semantics; Files needed narrower first-slice scope.
- Risk: The implementation could remain visually overlarge, clutter the global nav, and ship ambiguous log/file controls.
- Recommended edit: Add density specs, token/button matrix, local `RunWorkspaceTabId`, first-slice log filter only, and artifact/rich-object-first Files.
- Decision: Accepted and reflected in this revision.

Fresh reviewer 2:

- Finding: Log cursors were unsafe with optional line numbers; log search was only page-limited; overview and high-cardinality metric summaries could violate 100k-run constraints; panel fetch concurrency needed caps.
- Risk: Duplicate/skipped log rows, slow sparse searches, and slow initial dashboard reads.
- Recommended edit: Require client line numbers, use cursor tie-breakers, add search scan caps/truncation, benchmark overview+summary together, cap panel fetch concurrency.
- Decision: Accepted and reflected in this revision.

Fresh reviewer 3:

- Finding: Public SDK log API lacked compatibility/idempotency detail; server-derived line numbers were too risky; route expansion was broader than needed; component split needed stricter ordering; tail semantics were undefined.
- Risk: Duplicated spooled log events, overbroad route churn, and fragile implementation sequencing.
- Recommended edit: Make log endpoints Rust-first for this PR, add idempotency for `/logs`, require SDK line numbers, keep run tabs local to Detail, split selected-run resources before wider extraction, remove tail semantics.
- Decision: Accepted and reflected in this revision.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation as a narrow first slice. Route-addressable run subtabs, live tailing, match navigation, log text indexes, full file object storage, and large multi-key panel grids are deferred.
