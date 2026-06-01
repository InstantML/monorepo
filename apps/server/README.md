# Deprecated Node Server

This directory contains the deprecated Node.js API compatibility server for InstantML. The primary backend is now the Rust/ClickHouse service in `apps/rust-server`; the main frontend lives in the Next/React app under `apps/web`.

Planning note: `docs/design/2026-05-14-clickhouse-only-storage.md` defines the primary Rust/ClickHouse storage direction, while `docs/architecture/current-system.md` captures the current implemented topology. This Node server is retained for route-shape regression tests, JSON migration fixtures, and legacy local fallback.

Compatibility rule: treat this server as the v1 wire-contract oracle. Future Rust work should preserve route shapes, validation behavior, metric ordering, page-scoped summaries, idempotency behavior, importer behavior, artifact metadata/download behavior, and auth-scope semantics unless an accepted design intentionally changes the public contract.

## Responsibilities

- Preserve API compatibility for the Next/React frontend in `apps/web`.
- Preserve the Python SDK-compatible run/metric API.
- Provide local user, organization, and API-key scaffolding for hosted auth workflows.
- Provide optional org-scoped bearer-token enforcement for SDK ingestion.
- Provide UI summary endpoints.
- Provide typed attribute endpoints for configs, scalar series, text series, histograms, files, file series, and tags.
- Provide artifact/checkpoint/rollout metadata endpoints plus local artifact upload/download.
- Provide side-by-side comparison and metric aggregate summaries for the UI.
- Provide importer endpoints for Neptune Exporter-shaped, transformed W&B, and transformed MLflow JSON payloads with dry-run support.
- Provide user-owned JSON/CSV export for experiment history.
- Provide org usage summaries, blocked-at-limit write guardrails, and versioned usage export for pricing/debug planning.
- Generate/reset rich synthetic demo data only within the `demo` project.

## Storage

This slice uses dependency-free JSON persistence at `.instantml/instantml.json` by default for dev/demo mode. Local uploaded artifacts are stored beside the database under `artifacts/` unless `storageRoot` is passed to `createServer`.

The JSON store now maintains per-run metric summaries at write time in `metricSeries`. Run-table summaries and side-by-side metric aggregate values read those summaries instead of recomputing from full metric history. Raw metric history remains available through bounded metric-series endpoints.

Artifact bytes go through `src/artifact-store.js`. The current implementation is local filesystem storage, but the server no longer writes upload bytes directly in route code.

`better-sqlite3` was attempted earlier but could not build under the available Node 21.7.1 runtime. The accepted large-team deployment path is now the Rust/ClickHouse design; Node JSON remains the local compatibility store rather than a hidden production database.

## API Highlights

- `POST /runs` creates a run and maps config/tags to typed attributes.
- `POST /runs/:run_id/metrics` stores scalar metrics, updates maintained summaries, and accepts `Idempotency-Key` for retry-safe metric replay.
- `POST /api/users`, `POST /api/orgs`, and `POST /api/orgs/:org_id/api-keys` provide local hosted-auth scaffolding.
- `GET /api/runs/summary` returns bounded table summaries with latest metrics, aggregates, artifact counts, and the non-regex subset of the shared Rust run-search language. Bare text remains whitespace-token implicit `AND`; fields, exact tags/status/ID prefixes, quoted phrases, uppercase booleans, parentheses, and field/group exclusion such as `-tag:debug` are supported. Completed `re:/.../` queries return `code: "run_search_regex_unsupported"` because this deprecated server must not evaluate user JavaScript regexes.
- `PATCH /runs/:run_id` accepts status updates plus compatibility tag/note patches. `tags` replaces searchable run tags; `notes` writes `metadata.notes` and an empty note clears it.
- `POST /api/runs/:run_id/attributes` stores typed attributes.
- `GET /api/runs/:run_id/attributes` lists typed attributes with type and path-prefix filters.
- `POST /api/runs/:run_id/artifacts/upload` stores local artifact bytes and records SHA256, size, and MIME type.
- `GET /api/artifacts/:artifact_id/download` downloads stored artifact bytes.
- `GET /api/runs/side-by-side` compares selected runs by config, metadata, tags, metrics, aggregates, and attributes.
- `POST /api/demo/reset` replaces only the current org's `demo` project with 1,000 deterministic LLM/RL runs, rich train/eval/system metrics, tags, notes, hardware metadata, checkpoints, MP3 audio artifact metadata, and MP4 rollout artifact metadata.
- `POST /api/imports/neptune` imports or dry-runs a Neptune Exporter-shaped JSON payload through the shared atomic importer path.
- `POST /api/imports/wandb` imports or dry-runs a transformed W&B JSON payload with scalar history and artifact references. It does not download W&B artifact bytes.
- `POST /api/imports/mlflow` imports or dry-runs a transformed MLflow JSON payload with metric history, latest-metric fallback, params, tags, timestamps, and artifact references. It does not crawl an MLflow server or download artifact bytes.
- `GET /api/export` returns a portable JSON export filtered by project, project ID, org ID, status, and the same non-regex run-search subset. `run_ids`/`runs` selects exact visible runs, and `format=csv` returns the normalized CSV compatibility shape used by the Rust backend.
- `GET /api/usage` returns org-scoped usage counts for seats, projects, runs, current UTC calendar-month scalar metric points, retained metric-point totals, retained metric series, artifacts, API keys, exact artifact bytes, estimated metadata bytes, the monthly `usage_period`, and blocked-at-limit warning metadata.
- `GET /api/usage/export` returns the same usage shape as versioned JSON for billing/debug planning. It is not invoice truth.

Set `INSTANTML_REQUIRE_API_KEY=true` or pass `requireApiKey: true` to `createServer()` to require bearer API keys on tenant reads, SDK writes, imports, exports, usage summaries, and artifact downloads. In that mode, local admin scaffolding routes for users, orgs, and API keys require `X-INSTANTML-Bootstrap-Token` matching `INSTANTML_BOOTSTRAP_TOKEN` or the `bootstrapToken` server option. SDK run/metric/attribute mutations require `sdk:ingest`, artifact metadata/upload routes require `artifacts:write`, and export reads require `export:read`. Import routes require `imports:write`; default locally-created SDK keys include imports and exports for local migration testing, while usage-only keys cannot import/export run data. Usage routes require `usage:read`; default SDK ingest keys cannot read seat/API-key counts. Local dev defaults remain unauthenticated for compatibility.

New project, run, metric-ingest, artifact, import, and demo-reset writes are blocked with HTTP 402 and `code: "plan_limit_exceeded"` when the current or projected org usage exceeds the stored Free/Pro/Premium project, run, current-month metric-point, or estimated-storage limit. Metric-point usage resets on the first day of each UTC month; storage, projects, runs, seats, artifacts, metric series, and API keys are retained-resource counts. Reads, exports, and usage summaries remain available so over-limit orgs can inspect usage.

Batch attribute writes and importer writes are all-or-nothing in the Node store. Import dry-runs and real imports use the same normalized validation path, and invalid second-run metric/artifact payloads do not leave partial projects, runs, metrics, summaries, artifacts, or import records. Importers preserve external run IDs under source/import metadata instead of writing source-owned `_rlobs` keys at the top level. Artifact upload validates run, artifact metadata, and path before writing local bytes.

## Run

Install dependencies from the repo root first:

```bash
npm ci
```

From the repo root, only when you need the deprecated Node compatibility server:

```bash
npm run dev:api:node
```

The API is available at:

```text
http://127.0.0.1:8000
```

Run the Next frontend separately with `INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:build` and then `INSTANTML_API_BASE=http://127.0.0.1:8000 npm run web:start`.

Docker Compose from the repo root starts the primary Rust/ClickHouse stack, not this deprecated Node compatibility server:

```bash
docker compose up --build
```

## Test

From the repo root:

```bash
npm run test:node
npm run test:contract:node
npm run test:ui:node
```

The tests cover server persistence, org/API-key auth, usage scope enforcement, plan-limit write blocking, usage summaries/export, idempotent metric replay, strict numeric validation for SDK writes/imports, maintained metric summaries, export, the non-regex run-search compatibility subset plus regex rejection, typed attributes, artifact upload/download, Neptune/W&B/MLflow importer dry-run/import, side-by-side comparison, API contract behavior, Python SDK compatibility, frontend helper logic, demo reset safety, bounded metric queries, and static-file guardrails for custom static roots.

## Notes for Future Agents

- Keep UI summary endpoints page-scoped.
- Do not make demo reset delete user projects.
- Preserve SDK-compatible endpoints unless a design doc updates the SDK contract.
- Keep frontend values rendered as text, not injected HTML.
- Treat `docs/design/2026-05-14-clickhouse-only-storage.md` plus `docs/architecture/current-system.md` as the accepted production-storage direction. Node JSON is now deprecated compatibility and migration-source storage.
- Keep W&B-style training observability as the primary product framing; Neptune import support is an adoption path, not the whole backend identity.
- Treat the Rust/ClickHouse service as the primary backend; keep this server passing compatibility tests until migration tooling and legacy fallback are no longer needed.

Known simplification follow-ups from review:

- Add an explicit aggregate/index strategy when replacing JSON storage; do not keep expanding hidden full-history scans.
- Keep the shared contract smoke passing before changing SDK-compatible route behavior.
