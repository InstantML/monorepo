# Design: Compare Page Flow

Date: 2026-05-10

Status: Accepted

Owner: Codex

## Summary

The Compare tab should be useful for the same daily workflow as the Runs workspace: select several or many runs, understand what changed, sort the evidence, and jump from scalar/config differences to notes, tags, and artifacts without losing context.

The smallest useful version keeps the current Rust `GET /api/runs/side-by-side` contract and upgrades only the frontend flow around it. The page will support column-oriented and row-oriented comparison, local row/run sorting over the bounded selected-run payload, search, tags/notes summaries, artifact presence sorting, and safe inline MP3/MP4 playback when an artifact can be streamed from the app's same-origin download route. Unsupported media and external references remain download/copy-only.

Important constraint: the current Rust side-by-side endpoint accepts at most 50 runs. The UI must enforce and explain a Compare-specific 50-run cap even though Runs workspace charting can select more runs for other flows.

## Goals

- Make Compare usable for many selected runs by adding a row-oriented scan layout in addition to the existing matrix.
- Add row sorting for default signal order, changed rows, missing values, category, label, and numeric spread.
- Add run sorting for selected order, run name, newest, status, duration, active metric latest/best, artifact presence, tags, notes, and a selected config key.
- Surface tags, notes, and artifact/media context inside Compare so runs are identifiable without switching tabs.
- Preserve saved-view state for compare layout, sorting, search, and config-sort key.
- Make restored saved views resilient when their selected run IDs no longer exist after a demo reset or data reload.
- Validate the flow in UI smoke tests and manual Browser/Computer Use QA.

## Non-Goals

- No new Rust/ClickHouse table, index, or endpoint in this slice.
- No persisted hosted workspace layout for Compare; saved views remain local browser storage.
- No artifact range streaming work in Rust; that remains tracked in `apps/rust-server/TODO.md`.
- No tag/note mutation UI in this slice because post-hoc run metadata update needs a separate design.

## Users and Use Cases

ML researchers and engineers compare runs after an experiment sweep. They need to answer:

- Which runs changed because config, seed, code/source, or status differed?
- Which run has the best/latest value for the chosen metric?
- Which compared runs have notes, tags, checkpoints, rollouts, audio, or video evidence?
- Can I scan many runs as rows without a very wide spreadsheet?

## Proposed Design

Add a Compare toolbar above the side-by-side body:

- Reference selector: current behavior.
- Diff-only checkbox: current behavior.
- Metric selector: uses the active app metric and controls `Metric latest`, `Metric best`, and metric row priority. Best is goal-aware with `metricGoal`.
- Layout selector: `Auto`, `Runs as columns`, `Runs as rows`. `Auto` resolves to rows when more than five selected runs are compared, otherwise columns.
- Row sort selector: `Signal`, `Changed first`, `Missing first`, `Category`, `Name`, `Numeric spread`.
- Run sort selector: `Selected order`, `Name`, `Newest`, `Status`, `Duration`, `Metric latest`, `Metric best`, `Artifacts`, `Tags`, `Notes`, `Config key`.
- Config key selector appears as a normal control but is only meaningful when the run sort is `Config key`.
- Search input filters compare rows by category, label, path, value, tag, note, and artifact name.

Compare data pipeline:

1. Enforce the 50-run Compare cap before calling `GET /api/runs/side-by-side`.
2. Merge selected run summary data and bounded artifact metadata into the side-by-side payload.
3. Dedupe rows by category, label, and compared values.
4. Apply search across all returned rows and run metadata before any display cap.
5. Sort rows and runs.
6. Render-cap the final rows: 80 in column layout and 40 in row layout.
7. Show a truncation note when any matching rows are hidden by the render cap.

Comparator rules:

- Missing values sort last unless the selected sort is `Missing first`.
- Ties fall back to selected order, then run name or row signal order.
- `Metric latest` sorts descending by `latest_metrics[metricKey]`; missing values last.
- `Metric best` uses `metric_aggregates[metricKey].min` for minimize metrics and `.max` for maximize metrics; missing values last.
- `Duration` sorts longest first. Running runs use elapsed time from `started_at` to now.
- `Tags` sorts by tag count, then joined tag text.
- `Notes` reads `metadata.notes`, `metadata.note`, `metadata.description`, `metadata.summary`, or `metadata.comment`, sorts present notes first, then by note text.
- `Config key` sorts by the selected config value as a string/number, missing last.
- `Numeric spread` sorts rows by max-min across numeric compared values, descending.

Column layout:

- Keep the current sticky attribute column and run columns.
- Sort run columns according to the run sort selector.
- Enrich run headers with status, compact tags, notes preview, and artifact count.
- Preserve changed-cell highlighting and relative deltas.

Row layout:

- Render each run as one row with fixed identity, status, tags, notes, artifact count, active metric latest/best, and selected config value columns.
- Add compact value cells for the highest-signal sorted compare attributes after those fixed columns. This still supports full compare search without turning the whole first viewport into a sideways spreadsheet.
- This layout is preferred for many runs because vertical scanning keeps run names readable.
- The reference run remains visibly marked even if sorting moves it.

Artifact/media context:

- Fetch bounded artifacts for selected runs from `GET /api/runs/:id/artifacts?limit=12` only while Compare is active.
- Use a small concurrency-limited fetch loop with abort handling and a selection-key guard so stale artifact responses cannot overwrite newer Compare state.
- Existing `artifact_counts` are enough for run sorting and header counts while artifact rows are loading.
- Show a compact artifact strip grouped by run.
- Use inline `<audio controls>` or `<video controls>` only for safe MP3/MP4 artifacts with a same-origin `/api/artifacts/:id/download` URL. Do not autoplay.
- Unsupported MIME types, missing bytes, `demo://` URIs, and external-reference artifacts show metadata plus copy/download fallback instead of a broken player.
- Reuse the same safe media helper in Run Detail artifact cards so the root P5 media-playback TODO has one behavior.

Saved views:

- Store `compareLayout`, `compareRowSort`, `compareRunSort`, `compareSearch`, and `compareConfigSortKey` in the existing local saved-view JSON.
- Apply unknown/missing fields conservatively to defaults.

## Component Impact

Backend:

- No API changes. Existing Rust and Node compatibility routes are used.

Frontend:

- Update `apps/web/app/page.tsx` Compare state, toolbar controls, compare artifact fetching, saved-view persistence, and tests.
- Update `apps/web/app/dashboard-components.tsx` SideBySide rendering and shared artifact media preview.
- Update `apps/web/app/globals.css` for responsive Compare layouts and artifact media cards.

Python SDK:

- No change.

Storage:

- No change.

Docs:

- Update `apps/web/README.md`, root `TODO.md`, `apps/web/TODO.md`, and this design doc.

## Data Model

No persisted data model change.

Frontend-only state:

- `compareLayout`: `auto | columns | rows`.
- `compareRowSort`: `signal | changed | missing | category | name | spread`.
- `compareRunSort`: `selected | name | newest | status | duration | metric-latest | metric-best | artifacts | tags | notes | config`.
- `compareSearch`: string.
- `compareConfigSortKey`: string.
- `compareArtifactsByRun`: `Record<runId, Artifact[]>`.
- `COMPARE_RUN_LIMIT`: 50, matching the Rust side-by-side contract.

## API Contracts

Existing contracts:

- `GET /api/runs/side-by-side?run_ids=<csv>&reference_run_id=<id>&diff_only=<bool>` returns `{ runs, reference_run_id, rows }`.
- `GET /api/runs/:id/artifacts?limit=12` returns `{ artifacts }`.
- `GET /api/artifacts/:artifact_id/download` streams stored bytes when available.

No route shape or server validation changes are required.

## Performance Considerations

- Expected selected runs per compare action: up to 50 because the Rust side-by-side endpoint enforces that cap.
- Expected compare rows: process the returned payload locally, then render-cap to 80 highest-signal rows in column layout and 40 in row layout.
- Artifact reads: one bounded artifact list request per selected Compare run only while Compare is active. Limit is 12 per run. Fetches are abortable and concurrency-limited.
- Latency target: Compare remains interactive after the side-by-side payload lands; local sorting and search are linear over bounded rows and selected runs.
- Memory: avoid loading metric history. Compare uses summaries/config/metadata/attributes/artifact metadata only.
- Larger many-run compare needs a future server-side compare/query design for 90,000-run projects; this slice improves selected-run ergonomics without changing the backend.

## Simplicity Review

This design reuses the accepted Rust side-by-side endpoint, current artifact endpoints, current custom select, current saved-view storage, and existing CSS tokens. It deliberately avoids new backend persistence and avoids a new grid library until users prove the Compare layout needs spreadsheet-level virtualization.

Deferred complexity:

- Server-side compare pagination/sorting over entire projects.
- Editable notes/tags inside Compare.
- Artifact version/alias/lineage UI.
- Object-storage signed URL handling and HTTP range media streaming.

## Failure Modes

- Side-by-side request fails: keep the existing page-level error message and show the empty Compare state.
- Selected run artifact fetch fails: show Compare rows without media and keep the app usable.
- Artifact download route returns 404 for metadata-only demo artifacts: show fallback metadata rather than attempting playback for `demo://` references.
- Search filters all rows: show a targeted empty state.
- Saved view contains old fields: ignore unknown fields and default missing fields.
- Saved view contains stale run IDs: prune IDs that cannot be loaded, clear stale cached run details, and repopulate from the current visible run set when nothing valid remains.

## Testing Plan

- Extend `apps/web/tests/ui-smoke.mjs` to select Compare, switch layouts, change row/run sort, search rows, verify tags/notes/media artifact context renders, and verify saved views preserve compare state.
- Run `npm run test:node`.
- Run `npm run test:ui`.
- Run production `next build` against Rust API and Browser/Computer Use manual QA on `http://localhost:3002`.

## Documentation Plan

- Update `apps/web/README.md` Compare capabilities.
- Check off the completed Compare P1 items in `apps/web/TODO.md`.
- Check off the completed Compare-specific P5 root TODO items in `TODO.md`; leave unrelated hosted workflow items open.

## Implementation Notes

- Implemented `COMPARE_RUN_LIMIT = 50` on the frontend path before calling side-by-side.
- Compare toolbar now includes search, reference, metric, layout, row sort, run sort, config-key sort, and diff-only controls.
- `Auto` layout resolves to row scan mode for more than five compared runs; users can force column matrix mode.
- Search/dedupe/sort happens before display capping, and truncation copy tells users when matching rows are hidden.
- Compare artifact metadata fetches are bounded to 12 artifacts per compared run with a small concurrency limit and abort handling.
- Media preview is same-origin only through `/api/artifacts/:artifact_id/download`; `demo://` and external references use safe fallback text/copy/download actions.
- Run Detail artifact cards reuse the same media-preview fallback behavior.
- Compare row labels now preserve the actual key, such as `eval/return_mean · latest`, instead of reducer-only labels.
- Compare renders a compact decision summary with objective metric, best run, reference run, and largest current numeric deltas.
- Reference changes and Diff-only filtering are re-evaluated locally against the currently selected reference so stale row metadata from an old payload cannot make the table lie.
- Saved-view restore and demo reset clear stale run-detail, side-by-side, and compare-artifact caches before loading fresh runs.

Validation:

- `RLOBS_API_BASE=http://127.0.0.1:8000 npm run web:build`
- `npm run test:node`
- `npm run test:ui`
- Fresh Computer Use QA found reducer-only row labels and stale saved-view selection; both were fixed and covered by smoke assertions.

## Alternatives Considered

- Add new Rust compare endpoints now: rejected because the current endpoint already has the needed bounded data for selected runs.
- Replace Compare with a third-party data grid: rejected for this slice because the app needs a product-specific scan layout more than generic spreadsheet behavior.
- Inline all artifact downloads immediately: rejected because metadata-only and external-reference artifacts should not render broken media controls.

## Review Notes

Fresh reviewer 1:

- Finding: Compare promised the 250-run frontend selection cap even though Rust side-by-side caps at 50, row search/sort/display order was underspecified, artifact fetching could create a large N-request burst, external media playback conflicted with URI redaction, and several comparator semantics were undefined.
- Risk: Valid selections could fail, search could hide matching rows, stale artifact requests could overwrite UI state, and external media playback could leak signed URLs.
- Recommended edit: Add a 50-run Compare cap, define filter/sort/dedupe/display order, fetch artifacts with abort/concurrency limits, inline only same-origin artifact downloads, and document comparator rules.
- Decision: Accepted. The design now includes these constraints and keeps broader server-side many-run compare work out of this slice.

Fresh reviewer 2:

- Finding: Row layout could become another sideways spreadsheet, tags/notes needed canonical sources and overflow rules, search should happen before render caps, metric sorting needed an active metric, and external media playback was too permissive.
- Risk: ML researchers would still struggle to scan many runs, tags/notes might be inconsistent, and metric sort results could be surprising.
- Recommended edit: Treat row mode as a run leaderboard with fixed identity/status/tags/notes/artifact/metric/config columns, define note sources, add a metric selector, and keep external media copy/download-only.
- Decision: Accepted. Row mode is now a scan-first run layout, notes use canonical metadata keys, and metric sort uses the active Compare metric.

## Coverage Exceptions

None expected.

## Decision

Accepted after review revisions.
