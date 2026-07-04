# Design: Aim Gap 1 Object Explorers

Date: 2026-06-30

Status: Implemented first slice

Owner: Codex

Branch: `codex/aim-gap1-object-explorers`

## Summary

Aim's largest advantage for rich evidence browsing is not basic media logging.
InstantML already logs tables, histograms, images, audio, video, text series,
files, and artifacts. The gap is that users cannot open the dashboard and
explore these objects across runs with the same confidence as scalar metrics.
Today rich objects are primarily visible from a selected run, object row reads
are offset-based, and the web README still names media/query/text workspace
panels as future contracts.

This branch adds a route-backed Object Explorers workspace for images, audio,
video, text, tables, and histograms. It reuses the existing `AttributeRow` plus
artifact storage model, treats string-series attributes as the text source, adds
a bounded cross-run catalog route with deterministic cursor pagination, and
renders a dense explorer UI that filters by project, run search, kind, key, run,
and step range without fetching scalar metric history or artifact bytes.

## Goals

- Add a dashboard route for object explorers that is useful without selecting a
  single run first.
- Support image, audio, video, text, table, histogram, and classification-eval objects with
  kind-specific previews and safe fallbacks.
- Keep scalar metric ingestion and chart endpoints untouched.
- Add a bounded Rust object-catalog read route that returns summaries only.
- Reuse existing artifact download and table-row routes for explicit drill-down.
- Make object explorer state shareable through URL parameters.
- Verify with real SDK -> Rust -> ClickHouse -> Next UI data, browser
  interaction, keyboard navigation, and media fallback cases.

## Non-Goals

- No new object upload path.
- No new durable object table in the first slice.
- No arbitrary custom chart editor, Vega, or user-provided HTML rendering.
- No automatic artifact-byte migration for external imports.
- No compare-page fan-out across every selected run.
- No full-text table search or generated thumbnails.

## Users and Use Cases

- Fine-tuning engineers inspect prompt/completion tables and generated text
  samples across candidate runs.
- Vision and robotics engineers compare image/video rollouts at the same step
  across seeds.
- Speech users filter and play short audio examples without opening each run.
- Researchers share a URL to a filtered object explorer during review.

## Proposed Design

Add a route-backed dashboard tab at `/dashboard/objects` named `Objects`.
The tab is a dense explorer, not a landing page:

- Header: project selector/search context, object kind segmented control, key
  search, run query summary, step range controls, and refresh.
- Results: virtualized grid for media/text and compact table for table and
  histogram rows.
- Inspector: selected object details, linked run metadata, redacted artifact
  summary, download/open actions, lazy table rows, and histogram bins.
- URL state: `kind`, `key`, `q`, `run_id`, `from_step`, `to_step`, `cursor`,
  and `layout`.

Backend adds `GET /api/objects/explorer`. The route reads:

- rich-object attributes whose normalized object kind is `table`, `image`,
  `video`, `audio`, `histogram_series`, or `classification_eval`;
- text attributes with `type = "string_series"`, excluding console-capture
  paths `console/stdout` and `console/stderr` so captured logs stay in the Logs
  surface instead of flooding object browsing;
- same-run artifacts linked by `artifact_id`, but only after run/project
  visibility has already been checked.

The route does not stream artifact bytes. It only returns redacted artifact
summary fields already suitable for media previews: `id`, `name`, `uri`,
`mime_type`, `size_bytes`, and `storage_backend`. It never returns
`storage_key`, `storage_path`, local filesystem paths, signed URLs, or raw
object values larger than the preview budget. Local, R2, and external artifact
references all use the opaque `instantml://artifacts/<id>` URI on this route;
external source bucket paths or signed query strings are never echoed.

## Object Identity

Current rich objects are stored as `AttributeRow` records. The explorer exposes:

- `id`: the existing integer attribute id for compatibility with
  `/api/objects/:object_id/rows`.
- `object_id`: a stable string alias equal to `attr:<id>` in this first slice.

Using a prefixed string keeps the API safe if a future object registry uses UUIDs
or another backing store. Cursor encoding uses `object_id`, not array offsets.
The table-row route remains `/api/objects/:object_id/rows` and continues to
accept the integer `id`; the frontend passes `id` for table row drill-down.

## API Contract

`GET /api/objects/explorer`

Query parameters:

- `project?: string`
- `project_id?: string` for legacy/project-scoped compatibility
- `q?: string` using the existing run search language
- `kind?: image|audio|video|text|table|histogram|classification_eval`
- `key?: string` substring match, max 128 bytes
- `run_id?: string`
- `from_step?: number`
- `to_step?: number`
- `limit?: number`, default 50, max 100
- `cursor?: string`

Response:

```json
{
  "objects": [
    {
      "object_id": "attr:123",
      "id": 123,
      "run_id": "...",
      "run_name": "seed-13",
      "project": "cartpole",
      "kind": "image",
      "key": "eval/frame",
      "step": 200,
      "created_at": "...",
      "logged_at": "...",
      "summary": { "caption": "rollout", "width": 640, "height": 480 },
      "preview": { "text": null, "truncated": false },
      "artifact": {
        "id": "...",
        "name": "frame.png",
        "uri": "instantml://artifacts/...",
        "mime_type": "image/png",
        "size_bytes": 54321,
        "storage_backend": "local"
      }
    }
  ],
  "next_cursor": null,
  "limit": 50,
  "page_info": { "pagination": "cursor", "has_next_page": false }
}
```

Cursor order is deterministic:

1. `step DESC`, with null steps after numeric steps.
2. `created_at DESC`.
3. `id DESC`.

The cursor is an opaque base64url JSON payload containing `step`, `created_at`,
and `id`, plus a schema version. Invalid, stale, or malformed cursors return
`400 object_explorer_invalid`. New matching objects inserted before the cursor
may appear on a refreshed first page; they must not duplicate rows within an
existing cursor walk.

Errors:

- `400 object_explorer_invalid` for bad kind, key length, step range, limit, or
  cursor.
- `400 run_search_invalid` for invalid `q`.
- `403` for missing `export:read` or project-scoped visibility denial.

## Preview Budgets

The route returns summaries plus tiny previews only:

- text preview: first 2,000 UTF-8 bytes plus `truncated`.
- table preview: no rows in the catalog response; use the existing row route.
- histogram preview: bins/counts only if the stored object value is under the
  existing object value limit and valid; otherwise return summary only.
- classification-eval preview: capped PR/ROC, confusion-matrix, per-class, and
  prediction arrays.
- media preview: metadata only; bytes load through the artifact route on user
  action.
- metadata and summary previews: serialized JSON capped to the same 2,000-byte
  UTF-8 boundary as text previews when a stored object predates write-time
  payload caps or came from an importer.

Large, external, missing, or unsupported artifact bytes render explicit
unavailable states. The UI must not expose local paths or raw storage details.

## Component Impact

Backend:

- Add explorer DTOs and handler under `apps/rust-server`.
- Register `#[utoipa::path(...)]` and `ApiDoc`, then run
  `npm run codegen:api`.
- Reuse `export:read`, project-scoped API-key checks, run search parsing, object
  kind normalization, and artifact redaction.

Frontend:

- Add `/dashboard/objects` route state and nav item.
- Add object explorer components with empty, loading, error, populated, media
  unavailable, and keyboard states.
- Keep data fetching gated to the Objects tab and cancellation-aware.

Python SDK:

- No required ingest changes.
- Add or update an example script that logs representative table, histogram,
  classification-eval, text, image, audio, and video data for the explorer smoke.

Storage:

- No migration planned. The Rust store maintains an in-memory per-org
  object-attribute projection keyed by the explorer cursor sort tuple so broad
  first-page reads can walk already-sorted object IDs and stop after
  `limit + 1`. A durable object manifest table remains deferred until hosted
  profiling proves the in-process projection is insufficient.

Docs:

- Update root, web, Rust, SDK, and examples READMEs.
- Add or extend public docs once implementation passes.

## Performance Considerations

- Default page size 50, maximum 100.
- Access filtering happens before artifact joins and pagination.
- Broad reads are backed by the per-org object-attribute projection and
  seek into the cursor tuple before walking at most one lookahead candidate
  beyond the requested page. More selective key/project/search filters may
  inspect additional index entries but do not sort or clone the full object
  corpus.
- Initial tab load requests no artifact bytes.
- Target local p95 under 150 ms for 1,000 matching objects in a 50-run project.
- Target hosted p95 under 350 ms for sparse rich objects across 50,000 runs.
- Browser target: first useful explorer render under 1 second on seeded local
  data, with media lazy-loading after layout.
- Benchmark with object-heavy seeded data before opening the PR.

## Simplicity Review

This design reuses the accepted rich-object storage model and adds one summary
read path plus one UI workspace. It avoids a new object registry, new upload
protocols, and Compare fan-out. The extra cursor contract is justified because
cross-run object browsing cannot remain offset-based at production scale.

Deferred:

- Object annotations/comments.
- Full-table search.
- Byte-range streaming and generated thumbnails.
- Object registry migration.

## Failure Modes

- Explorer route unavailable: tab shows a scoped API error and keeps navigation
  usable.
- Linked artifact missing: preview falls back to metadata and disables byte
  actions.
- External artifact reference: preview explains bytes were not imported.
- Invalid run query: preserve last successful results and show inline search
  error.
- Large table: inspector fetches only a bounded first page and exposes row
  count when available.
- Stale async response: frontend ignores it via abort/cancellation guard.

## Testing Plan

- Rust API tests for filter combinations, cursor pagination, authorization,
  invalid parameters, run search errors, artifact redaction, missing bytes, and
  preview budgets.
- Frontend tests for kind tabs, filters, URL persistence, inspector, keyboard
  navigation, empty/loading/error states, and unsafe media fallback.
- SDK/example smoke to log table, histogram, classification-eval, text, image,
  audio, and video.
- Full E2E: start disposable ClickHouse/Rust API, log rich objects with SDK,
  open Next UI, filter and inspect objects with browser/keystrokes.
- Auto-review before commit: inspect diff, run focused tests, run UI smoke, and
  record evidence in this doc.

## Documentation Plan

- `README.md`: note Object Explorers as current Rust/ClickHouse capability.
- `apps/rust-server/README.md`: document `/api/objects/explorer` and cursor
  semantics.
- `apps/web/README.md`: document Objects route, data dependencies, and QA.
- `packages/python-sdk/README.md`: link rich-object example used for smoke.
- `examples/README.md`: add explorer seed example.
- `apps/docs`: public rich-object explorer guide.

## Alternatives Considered

- Store a separate object manifest table now. Deferred until profiling proves
  the existing attribute/artifact projection cannot meet the route budget.
- Reuse per-run `/api/runs/:id/objects` from the frontend and fan out selected
  runs. Rejected because it cannot support cross-run browsing or stable
  pagination.
- Return artifact bytes inline. Rejected because it breaks scalar/read budgets
  and leaks storage concerns into the catalog.

## Review Notes

Fresh reviewer 1:

- Finding: Directionally good, but stable object identity, cursor ordering,
  artifact join/redaction, authorization order, and byte budgets were not
  precise enough.
- Risk: An explorer could duplicate rows, leak storage details, or fail to scale
  beyond a selected-run preview.
- Recommended edit: Define `object_id`, deterministic ordering, source types,
  preview byte caps, and auth-before-join behavior.
- Decision: Revise.

Fresh reviewer 2:

- Finding: The design needed exact eligibility rules and a smaller first slice
  that did not silently depend on future object storage.
- Risk: Implementation could drift into a new object registry or undocumented
  media transport work.
- Recommended edit: Reuse `AttributeRow` first, keep table rows lazy, and amend
  only if performance evidence requires a projection.
- Decision: Revise.

Re-review:

- Reviewer 1: Approved. Earlier blockers are resolved; amend the design only if
  profiling proves a projection/index is required.
- Reviewer 2: Approved. No must-fix before implementation; add a nice-to-have
  test for `project` plus `project_id` conflict behavior.

## Progress Log

- 2026-06-30: Created dedicated branch/worktree and drafted design before
  implementation.
- 2026-06-30: Revised design after two fresh reviews to add stable object IDs,
  cursor semantics, source eligibility, preview budgets, redaction rules, and
  cancellation-aware UI requirements.
- 2026-06-30: Two fresh reviewers approved the revised design for
  implementation.
- 2026-06-30: Implemented `GET /api/objects/explorer`, `/dashboard/objects`,
  generated OpenAPI/TypeScript bindings, docs, and deterministic
  `examples/object-explorer` SDK seed data.
- 2026-06-30: Verified focused Rust object tests, web route tests, production
  Next build, docs validation, direct API cursor/redaction/conflicting-project
  checks, and browser E2E on desktop and mobile with SDK-seeded text, table,
  histogram, classification-eval, and generated image objects.
- 2026-06-30: Browser E2E found that shared `kind=...` URLs initially loaded
  all object kinds and caused a hydration warning. The Objects tab now syncs
  URL filters after hydration, preserves shareable params, and handles
  back/forward navigation.
- 2026-06-30: Independent PR review found two object-explorer issues: media
  artifact summaries exposed stored local/R2 URIs, and broad explorer reads
  sorted the full candidate corpus before pagination. Fixed by returning
  `ArtifactRow::public_uri()` and adding the per-org object-attribute projection
  plus a `limit + 1` broad-read regression test.
- 2026-06-30: Full `npm run rust:test` was attempted; non-object tests that use
  sqlx Postgres test harness failed because `DATABASE_URL` is not set in this
  local environment. Focused object tests passed.

## Coverage Exceptions

None.

## Decision

Implemented first slice. Keep a separate follow-up for richer public docs
screenshots and optional audio/video example fixtures that require local media
encoder dependencies.
