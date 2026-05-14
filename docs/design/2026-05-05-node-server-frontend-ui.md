# Design: Node Server and Days 5-8 Frontend

Date: 2026-05-05

Status: Implemented days 5-8 UI/server slice

Owner: Codex

## Summary

This design added the Node.js server and the day 5-8 frontend experience for the product now called Training Observability. The goal remains to make UI quality the product moat: a dense runs table, bounded metric charting, responsive filtering, clear run details, comparison overlays, artifact browsing, checkpoint timelines, rollout gallery, and a polished training-loop workflow.

Naming note: this historical design predates the Training Observability rebrand. User-facing docs and UI now use Training Observability, while code identifiers remain unchanged until a namespace migration is designed.

The Node server became the primary development surface for the days 5-8 UI slice. It served static frontend assets and exposed the same JSON API contract as the days 1-4 backend so the Python SDK could log to it without changes. The existing Python bootstrap API remained as a reference implementation and test client path.

Current status: implemented and superseded as the primary path by the Next/React app plus Rust/ClickHouse backend. Later roadmap work added typed attributes, local artifact upload/download, Neptune/W&B/MLflow-shaped imports, saved views, smoothing, grouped averages, side-by-side diffs, org/API-key scaffolding, usage summaries, and shared contract tests. The Rust/ClickHouse storage design in `docs/design/2026-05-14-clickhouse-only-storage.md` and the current architecture summary in `docs/architecture/current-system.md` describe the primary local/product backend, while this Node server remains a deprecated compatibility oracle, JSON migration source, and legacy fallback.

## Goals

- Add a Node.js server under `apps/server`.
- Preserve the existing API contract used by the Python SDK.
- Use local persistence with the same core entities: projects, runs, metrics.
- Serve a static frontend from `apps/web`.
- Build days 5-8:
  - Day 5: runs table with search/filter, tags, config columns, latest metrics
  - Day 6: run detail and bounded metric charts
  - Day 7: multi-run comparison overlays and config comparison
  - Day 8: artifact browser, checkpoint timeline, and rollout gallery
- Keep implementation simple and dependency-light.
- Add automated tests for server behavior and UI logic.
- Add browser-level verification for the rendered UI.

## Non-Goals

- Full production auth.
- Artifact uploads.
- Importers.
- React/Vite build pipeline.
- Complex client-side state framework.
- Full binary artifact upload UI.
- Production artifact object storage.
- Real video transcoding or preview generation.
- SaaS deployment.
- Replacing the Python SDK.

Current follow-up note: binary upload/download API exists in the Rust and deprecated Node servers, and the UI now includes safe MP3/MP4 previews in Run Detail and Compare. First-class media panels, transcoding, and production object storage remain deferred.

## Users and Use Cases

Primary user:

- ML/RL researcher or research engineer evaluating whether the product gives them fast local visibility into training runs.

Use cases:

1. Start the Node server.
2. Generate demo runs or log runs through the Python SDK.
3. Open the browser.
4. Filter runs by project, status, tag, or text.
5. Select one or more runs.
6. See metric summaries and compare bounded metric series.
7. Inspect run config, metadata, tags, and recent metric values.
8. Inspect checkpoint lineage, rollout records, and artifacts for a selected run.

## Proposed Design

Directory layout:

```text
apps/
  server/
    src/
      db.js
      routes.js
      server.js
      sample-data.js
    tests/
  web/
    index.html
    src/
      app.js
      app.css
      charts.js
      state.js
      api.js
      fixtures.js
```

The server will use:

- Node built-in `http` module.
- Dependency-free JSON persistence for this UI slice.
- Node built-in test runner.
- No Express for this slice.

The frontend will use:

- Plain HTML/CSS/JavaScript modules.
- SVG charts generated in the browser.
- No build step.
- Stable layout dimensions to avoid visual shifting.
- Bounded data loading.

## Component Impact

Backend / Server:

- Add `apps/server` as the Node API/static server.
- Match existing REST endpoints exactly where they overlap.
- Add UI-specific summary endpoint to avoid table N+1 metric queries.
- Add simple artifact metadata endpoints for day 8 UI.
- Serve static files with path traversal protection.

Frontend:

- Replace placeholder shell with a usable app.
- Add dense dashboard UI, runs table, charting, details, comparison, artifacts, checkpoints, and rollouts.

Python SDK:

- No API changes.
- SDK should work against the Node server because the contract is preserved.

Storage:

- Use JSON persistence because `better-sqlite3` failed to install under the available Node 21.7.1 runtime.
- Reuse the same logical entities as the Python API.
- Store data at `.rlobs/rlobs.json` by default.
- Add a future storage design before replacing JSON persistence.

Docs:

- Update root, server, web, and SDK docs with Node server as the recommended UI path.

## Data Model

Tables:

- `projects`: `id`, `name`, `description`, `created_at`
- `runs`: `id`, `project_id`, `name`, `status`, `config_json`, `tags_json`, `metadata_json`, `created_at`, `started_at`, `finished_at`
- `metrics`: `id`, `run_id`, `key`, `step`, `value`, `created_at`
- `artifacts`: `id`, `run_id`, `type`, `name`, `uri`, `step`, `size_bytes`, `metadata_json`, `created_at`

Rules:

- IDs are UUID strings.
- Timestamps are UTC ISO strings.
- Allowed run statuses: `running`, `finished`, `failed`.
- Metric values are finite numbers.
- Metric steps are nonnegative integers.
- Duplicate `(run_id, key, step)` metrics remain allowed.
- Metric ordering is deterministic: `step ASC, id ASC`.
- Artifact types for this slice: `checkpoint`, `rollout`, `file`.
- API validation, JSON error shape, UTC `Z` timestamps, limits, duplicate metric behavior, and ordering must match the Python bootstrap API where endpoints overlap.

Indexes:

- `projects.name` unique.
- `runs(project_id, created_at DESC)`.
- `metrics(run_id, key, step)`.
- `metrics(run_id, step)`.

## API Contracts

Existing API-compatible endpoints:

- `GET /health`
- `POST /projects`
- `GET /projects`
- `POST /runs`
- `GET /runs?project_id=...&project=...&limit=...&offset=...`
- `GET /runs/{run_id}`
- `PATCH /runs/{run_id}`
- `POST /runs/{run_id}/metrics`
- `GET /runs/{run_id}/metrics?key=...&start_step=...&end_step=...&limit=...`

UI-focused endpoints:

- `GET /api/overview?project=...`
- `GET /api/runs/summary?project=...&status=...&q=...&limit=...&offset=...`
- `GET /api/runs/{run_id}/artifacts`
- `POST /api/runs/{run_id}/artifacts`
- `POST /api/demo/reset`

`/api/runs/summary` returns run metadata plus page-scoped latest metric values and available metric keys without full series history.

Summary request:

- `project`: optional project name.
- `status`: optional `running`, `finished`, or `failed`.
- `q`: optional case-insensitive text query over run name, project name, tags JSON, and config JSON.
- `limit`: default `100`, max `500`.
- `offset`: default `0`.

Summary response:

```json
{
  "runs": [
    {
      "id": "uuid",
      "project": "cartpole",
      "name": "cartpole-seed-42",
      "status": "finished",
      "tags": ["demo"],
      "config": {"seed": 42},
      "created_at": "2026-05-05T12:00:00.000000Z",
      "finished_at": "2026-05-05T12:01:00.000000Z",
      "latest_metrics": {"eval/return_mean": 42.0},
      "metric_keys": ["eval/return_mean", "train/loss", "train/reward"],
      "artifact_counts": {"checkpoint": 2, "rollout": 1, "file": 1}
    }
  ],
  "limit": 100,
  "offset": 0,
  "total": 1,
  "metric_keys": ["eval/return_mean", "train/loss", "train/reward"]
}
```

Latest metric semantics:

- Only for runs on the current page.
- Latest per `(run_id, key)` is selected by `step DESC, id DESC`.
- Metric key list is page-scoped.
- No full-project metric history is loaded.

Chart query:

- This slice supports up to 5 selected runs.
- The frontend fetches `GET /runs/{run_id}/metrics` once per selected run and metric key.
- Each request is bounded by `limit`, default 1000 and max 5000.

Artifact request:

```json
{
  "type": "checkpoint",
  "name": "policy-step-100.pt",
  "uri": "demo://policy-step-100.pt",
  "step": 100,
  "size_bytes": 1024,
  "metadata": {"score": 42}
}
```

Demo reset safety:

- `POST /api/demo/reset` only deletes/replaces the `demo` project.
- It must not delete user projects or arbitrary database contents.

## Frontend Experience

First screen should be the actual product, not a landing page.

Layout:

- Top app bar with product name, project selector, status, and demo/reset controls.
- KPI strip: total runs, active runs, best eval return, metric point count.
- Main workspace:
  - left: runs table
  - center: metric chart/comparison
  - right: selected run detail
- Bottom band: artifacts, checkpoint timeline, rollout gallery, and selected-run comparison details.

Runs table:

- Fixed-height rows.
- Search input.
- Project/status/tag filters.
- Sort by created time, status, name, best/latest metric.
- Multi-select runs.
- Cap selected runs at 5.
- Shows config chips and tags.

Chart:

- SVG line chart.
- Bounded metric series fetch.
- Multi-run overlays.
- Smooth hover-free first slice; no fragile tooltip dependency.
- Metric key selector.
- Empty state when no metric is selected.

Run detail:

- Status, duration, tags.
- Config JSON summary.
- Metadata summary.
- Latest metrics.

Artifacts/checkpoints/rollouts:

- Artifact list grouped by type.
- Checkpoint timeline sorted by step.
- Rollout gallery using metadata and demo placeholder preview blocks.
- No binary upload UI in this slice; metadata creation endpoint exists for tests and future SDK support.

Visual direction:

- Quiet, dense, work-focused operational UI.
- No marketing hero.
- No decorative gradient/orb background.
- Use restrained colors with clear status accents.
- Stable dimensions for tables, charts, buttons, and panels.
- Use `AbortController` to cancel stale frontend requests.
- Render user/config/server values with `textContent`, not HTML injection.
- Handle malformed API responses with visible error states.

## Performance Considerations

- Expected rows/items per user action: 50-500 runs in a project, 1,000-5,000 metric points per selected run.
- Expected write frequency: SDK can post multiple metrics per second locally.
- Expected read/query shape:
  - table loads summary rows only
  - summary endpoint computes latest metrics only for the current page of runs
  - chart fetches bounded series for up to 5 runs and one metric key
  - detail fetches one run
- Latency target: local table load under 200ms for demo-sized data.
- Pagination: run summary defaults to 100, max 500.
- Metric series: default max 1,000 per run, max 5,000.
- Indexes: metrics by run/key/step, runs by project/created.
- Memory: frontend should never fetch all metrics for a project.
- Batching: SDK batching remains out of scope.
- Measurement plan:
  - server test seeds 50 runs x 1,000 points and verifies bounded responses
  - server test verifies summary endpoint remains page-scoped
  - browser smoke verifies the UI renders and remains nonblank

List endpoints return summaries only. Full metric history is never loaded for table or dashboard defaults.

## Simplicity Review

This is the simplest useful UI moat slice because:

- No frontend build system.
- No React state framework yet.
- No backend framework.
- Artifact/media UI flows are metadata-card-first.
  - Current API can upload/download local artifact bytes, but the UI still treats artifacts mostly as metadata cards.
- No auth.
- Server serves static files and API from one process.

Complexity deferred in this slice:

- React/Vite.
- Component library.
- Canvas/WebGL charts.
- Virtualized tables.
- WebSockets.
- Importers and binary artifacts. These were partially addressed later by the Neptune-compatible roadmap slice with JSON-shaped import and local artifact upload/download APIs.
- Binary artifact upload/download.
- Real video previews.

## Failure Modes

- Node SQLite dependency install fails.
  - Use dependency-free JSON persistence for this slice and document SQLite as a future storage decision.

- API receives invalid JSON.
  - Return `400` with JSON error.

- UI cannot reach API.
  - Show an error state and keep controls usable.

- No runs exist.
  - Show a useful empty state and a demo-data button.

- Large metric history exists.
  - Fetch bounded series only.

- Demo reset is clicked with user data in the database.
  - Replace only the `demo` project and leave all other projects untouched.

- Static file path attempts traversal.
  - Return `404` and do not serve files outside `apps/web`.

- Browser automation unavailable.
  - Fall back to HTTP smoke and static screenshot via any available browser tooling.

## Testing Plan

Server:

- Unit tests for validation and persistence.
- API tests for project/run/metric lifecycle.
- API compatibility test using Python SDK against Node server.
- Contract tests for validation, error shape, UTC `Z` timestamps, pagination defaults/maxes, duplicate metrics, and ordering.
- Performance guardrail test for bounded summary/metric responses.
- Artifact metadata tests.

Frontend:

- Unit tests for pure state/filter/sort/chart helpers.
- Tests for malformed API payload handling where practical.
- Browser smoke test:
  - start server
  - reset demo data
  - open UI
  - verify main UI text, table rows, SVG chart, comparison selection, details panel, artifact browser, checkpoint timeline, and rollout gallery
  - capture screenshot artifact if possible

Coverage:

- Target 100% meaningful coverage for first-party server and frontend logic.
- Exclude static CSS/HTML and entrypoint process guards if needed.

## Documentation Plan

Update:

- `README.md`
- `apps/README.md`
- `apps/server/README.md`
- `apps/web/README.md`
- `packages/python-sdk/README.md`
- this design doc with review notes

## Alternatives Considered

### Express + React + Vite immediately

Deferred. It would be productive later, but it adds build and framework choices before we validate the UI workflow.

### Keep Python API and add only frontend

Rejected for this slice because the user explicitly requested a Node.js server.

### JSON file storage

Accepted for this UI slice after `better-sqlite3` failed to install under Node 21.7.1. This is not the final persistence design.

## Review Notes

Fresh reviewer 1:

- Finding: The design was directionally strong but too broad without an explicit implementation spine.
- Risk: Multi-run overlays, advanced sorting, seed/config cues, KPIs, details, and reset could become a broad half-built dashboard.
- Recommended edit: Define the implementation spine and data-safety rules around demo reset.
- Decision: Accepted and incorporated while preserving the user's day 5-8 scope.

Fresh reviewer 2:

- Finding: Summary endpoint semantics, chart query shape, SQLite package choice, API parity, demo reset safety, and frontend reliability safeguards needed to be explicit.
- Risk: Hidden N+1 queries, API drift, data loss from demo reset, stale requests, and unsafe static serving.
- Recommended edit: Pin `better-sqlite3`, define page-scoped summary semantics, cap multi-run chart selection at 5, require exact API contract tests, project-scope demo reset, `AbortController`, text-only DOM rendering, and path traversal protection.
- Decision: Accepted and incorporated, except `better-sqlite3` was replaced with documented JSON persistence after local install failure.

## Coverage Exceptions

None planned.

## Decision

Accepted for implementation as days 5-8 UI/server slice.
