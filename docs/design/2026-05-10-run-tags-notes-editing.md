# Design: Run Tags And Notes Editing

Date: 2026-05-10

Status: Accepted

Owner: Codex

## Summary

Tags and notes are key run identity fields for researchers scanning many experiments, but the current product only partially surfaces them. Demo runs already have `runs.tags` and `metadata.notes`, and Compare can display those fields, but run browsing does not make notes visible enough, Run Detail cannot edit them, Compare cannot edit them, and backend search only covers name, project, tags, and config text.

The smallest durable slice keeps the existing data model: tags remain `runs.tags text[]` and notes remain `runs.metadata.notes`. The Rust API extends `PATCH /runs/:run_id` so callers can update status, tags, and notes in one route. Generic metadata mutation is intentionally deferred so SDK-owned `_rlobs` source metadata, hardware metadata, and imported provenance cannot be overwritten by a broad shallow merge. Run search moves to a trigger-maintained Postgres search column that includes run name, tags, config text, and explicit note fallback fields so note/tag queries are server-backed and indexable without indexing all metadata JSON.

## Goals

- Make tags and notes visible in the Runs table and Runs workspace selector.
- Add safe post-hoc editing for tags and notes in Run Detail and Compare.
- Keep Rust/Postgres as the source of truth while preserving Node compatibility behavior.
- Make run search match notes and tags through the server-backed `q` path.
- Add first-class Python SDK helpers for notes and post-hoc tag replacement.
- Keep demo reset producing searchable tags and notes for all generated demo runs.

## Non-Goals

- No new `notes` column yet; notes stay in `metadata.notes` until lifecycle parity work decides whether notes need a dedicated audited field.
- No multi-user edit audit UI yet. Existing `PATCH /runs/:run_id` still requires `sdk:ingest` in API-key mode.
- No full 90,000-run benchmark in this slice; the large-scale search benchmark remains tracked in root and Rust TODOs.
- No rich Markdown notes editor, comments, threaded annotations, or per-panel notes.
- No hosted org/user read-only UI state yet because the current local frontend has no authenticated membership model.

## Users and Use Cases

Researchers and ML infrastructure owners use tags and notes to identify why runs exist:

- Mark baselines, candidates, failures, hardware choices, or sweep cohorts.
- Write a short note after inspecting a chart: "high reward but unstable after step 160".
- Search runs by note text such as `reward stability` or tag text such as `long-context`.
- Compare selected runs without switching tabs just to remember which run was the triage candidate.

## Proposed Design

Canonical sources:

- Tags: `runs.tags`.
- Notes: `runs.metadata.notes`.
- Read fallback: the frontend keeps reading `metadata.notes`, `metadata.note`, `metadata.description`, `metadata.summary`, and `metadata.comment` so imported data remains visible.
- Write target: the UI and SDK write only `metadata.notes`.

Rust API:

- Change `UpdateRunRequest` from status-only to optional fields: `status`, `tags`, and `notes`.
- At least one field must be present.
- `status`, when present, keeps the current validation and finish-time behavior.
- `tags`, when present, replaces `runs.tags` after existing tag validation.
- `notes`, when present, writes `metadata.notes` after trimming and length validation; an empty string removes `metadata.notes`.
- Return the updated run row in the current `{ "run": ... }` wrapper.

Search:

- Add a trigger-maintained `runs.search_text` column through a Rust migration:
  - lowercased run name
  - lowercased tags
  - lowercased config JSON
  - lowercased explicit note fallback fields: `notes`, `note`, `description`, `summary`, and `comment`
- Add a trigram GIN index on `runs.search_text` and a GIN index on `runs.tags`.
- Update run summary, overview, and metric-key discovery filters to require every token to match `r.search_text` while preserving project/status/project-scope filters.
- Keep whitespace token semantics so `seed 13`, `reward stability`, and `long context` work as AND-token searches.
- Normalize search tokens by lowercasing, escaping `%`, `_`, and `\`, and capping token count to eight. Short tokens such as `13` still work for seed search but are not treated as proof that the trigram index will be used; 90,000-run query-plan checks remain a follow-up.

Node compatibility:

- Extend the deprecated Node store's status-only `updateRun` to accept tags and notes patches.
- Include metadata in Node search haystacks so `npm run test:ui:node` stays useful during migration cleanup.

Python SDK:

- Add `notes` to `Client.init()` and top-level `rl_observability.init()`. It maps to `metadata["notes"]` after SDK source metadata is merged.
- Add `Run.set_notes(notes: str)` and `Run.set_tags(tags: list[str])` helpers backed by `PATCH /runs/:id`.
- Keep existing `Run.add_tags()` behavior for typed attributes, but document that `set_tags()` updates the searchable run identity field.

Frontend:

- Add a visible `Notes` table column, enabled by default, with one-line clamped preview.
- Add compact tag chips and a one-line notes preview to the Runs workspace selector row without making rows tall.
- Update run search placeholders and quick-search descriptions to call out tags/notes.
- Add a shared compact tag/notes editor:
  - comma-separated tags input
  - multiline notes textarea
  - read/edit mode with explicit Save and Cancel
  - dirty-state detection and disabled saving while a request is in flight
  - inline validation copy for empty/oversized tags or notes
  - Save action calls `PATCH /runs/:id`
  - optimistic local cache merge for summary, selected-run details, and Compare runs
  - trigger side-by-side reload after edits so Compare rows update
- Place the editor prominently in Run Detail.
- Place a compact editor in Compare above the side-by-side table with its own edit-run picker. The picker defaults to the reference run but does not change the reference selector, so users can annotate another compared run without changing diffs.
- Density rules:
  - Runs table notes use one-line ellipsis with title tooltip.
  - Runs workspace rows show at most two compact tags, an overflow count, and one one-line note preview.
  - Notes column has a constrained width and hides below narrow mobile widths before the run identity column wraps.

## Component Impact

Backend:

- Rust `domain`, `store`, migrations, and tests change.
- Node compatibility store and tests change.

Frontend:

- `apps/web/app/page.tsx` adds update mutation state, Compare edit-run state, and passes save callbacks.
- `apps/web/app/dashboard-components.tsx` adds notes column, compact previews, and editor components.
- `apps/web/app/globals.css` adds compact notes/tags styles.
- UI smoke adds search/edit assertions.

Python SDK:

- Public init signature and `Run` helper methods change.
- SDK tests and README examples change.

Storage:

- Add trigger-maintained `runs.search_text`.
- Add GIN indexes for `search_text` and tags.

Docs:

- Update `apps/rust-server/README.md`, `apps/server/README.md`, `packages/python-sdk/README.md`, `apps/web/README.md`, root `TODO.md`, and component TODOs.

## Data Model

New Postgres search field and refresh trigger:

```sql
alter table runs add column search_text text not null default '';

create trigger runs_search_text_refresh
before insert or update of name, tags, config, metadata on runs
for each row
execute function runs_refresh_search_text();
```

Indexes:

```sql
create extension if not exists pg_trgm;
create index runs_search_text_trgm_idx on runs using gin (search_text gin_trgm_ops);
create index runs_tags_gin_idx on runs using gin (tags);
```

No API response shape adds `search_text`; it remains server-only.

## API Contracts

`PATCH /runs/:run_id`

Request fields are optional, but at least one is required:

```json
{
  "status": "running | finished | failed",
  "tags": ["baseline", "candidate"],
  "notes": "short human note"
}
```

Behavior:

- `status` updates status and finish timestamp.
- `tags` replaces searchable run tags.
- `notes` writes `metadata.notes`; an empty string removes `metadata.notes`.
- Invalid status, tags, oversized note text, or empty patch bodies return `400`.
- Missing run returns `404`.
- API-key mode still requires `sdk:ingest`.
 - The update SQL must include `runs.org_id = ctx.org_id` and existing project-scoped access checks remain in force.

SDK:

```python
run = ro.init(project="demo", notes="baseline PPO run", tags=["baseline"])
run.set_notes("reward improved but entropy collapsed late")
run.set_tags(["candidate", "needs-triage"])
```

`init(notes=...)` works with existing compatible servers because notes are sent inside `metadata`. `set_notes()` and `set_tags()` require a backend that supports this PATCH extension; older bootstrap/reference APIs should return a clear SDK `RlobsError`.

## Performance Considerations

- Expected write frequency: tags/notes edits are human-paced, not training-loop hot-path traffic.
- Expected search reads: every Runs summary/overview refresh can include `q`; it remains paginated and summary-only.
- The trigger-maintained `search_text` avoids repeated string construction in every query and gives Postgres a trigram index for note/tag/name/config text search without indexing arbitrary metadata blobs. The trigger is slightly more verbose than a generated column, but avoids Postgres immutability restrictions around JSON/text array expression functions.
- Tags also get a GIN index for future explicit tag filters.
- This slice does not claim full 90,000-run p95 performance. Follow-up query-plan tests and scale smoke remain required before marking large-run-count search done.
- Frontend editing mutates small run metadata and then refreshes bounded summaries; it does not fetch metric history.

## Simplicity Review

This design avoids a parallel notes table, rich text editor, custom search service, or frontend-only state. It uses the fields the product already returns in summaries and Compare, then makes them editable and searchable. The one new storage concept, `search_text`, is maintained from existing columns and does not affect API payloads.

Deferred complexity:

- Dedicated note history/audit events.
- Tag autocomplete and team-level tag taxonomy.
- Role-aware read-only controls.
- Server-side explicit filters such as `tag=baseline` and `has_notes=true`.
- Full 90,000-run query-plan benchmark.

## Failure Modes

- Patch request fails: keep UI values unchanged, show the existing topbar-safe error message, and leave the editor open.
- Patch succeeds but summary refresh fails: merge the returned tags/notes locally and show the save success; the next normal refresh reconciles counts and Compare rows.
- Side-by-side refetch fails after edit: Compare still shows locally updated run headers; row-level metadata may be stale until refresh and an error message is shown.
- Old Node server receives tag/notes patch: compatibility store accepts the same shape.
- Saved views with old `tableColumns` default to showing the new notes column through `defaultTableColumns`.

## Testing Plan

- Rust integration: update status-only patch call sites, add tags/notes patch assertion, add negative cross-project/auth search assertions where existing test scaffolding allows it, and add search-by-note/tag assertions.
- Node unit/API: update run patch validation and metadata search assertions.
- SDK unit/integration: `init(notes=...)`, `set_notes`, `set_tags`, and process-spool behavior for the new helpers.
- Frontend node tests: table column defaults include notes.
- UI smoke: after demo reset, assert Runs workspace shows tag/note snippets, Run Detail editor saves a unique note/tag, search finds that unique token, and Compare reference editor displays/saves notes.
- UI regression checks: failed save keeps edit mode open, old saved-view column preferences default notes safely, and narrow viewport text remains clipped rather than overlapping.
- Manual Computer Use QA on `http://localhost:3002`.

## Documentation Plan

- Update root `TODO.md` P5 line.
- Update `apps/web/TODO.md` P0 notes/tags items and related Compare note.
- Update `apps/rust-server/TODO.md` with this first slice done but leave 90,000-run benchmark/query-plan items open.
- Update `packages/python-sdk/TODO.md` for first-class notes/tags helpers.
- Update READMEs in `apps/web`, `apps/rust-server`, `apps/server`, and `packages/python-sdk`.

## Alternatives Considered

- Dedicated `runs.notes text` column: rejected for this slice because imports and existing UI already use metadata notes, and a dedicated column should be designed with audit/history semantics.
- Full-text `tsvector`: deferred because run search is substring/token search over identifiers, tags, config keys, and notes. Trigram search fits current behavior better.
- Frontend-only local notes: rejected because notes must be searchable, comparable, and portable through the API/SDK.
- Make `add_tags()` append to `runs.tags`: deferred because the SDK cannot safely append without fetching current tags or adding a server-side append route. `set_tags()` is explicit and predictable for this slice.

## Review Notes

Fresh reviewer 1:

- Finding: Indexing all `metadata::text` and `config::text` in a generated trigram column could bloat the table/index and make updates expensive; wildcard token semantics and short token behavior were underspecified; generic metadata merge could overwrite protected SDK/source fields; tenant scoping and SDK compatibility needed clearer treatment; the slice was too wide.
- Risk: Search could become slow or surprising at scale, provenance metadata could be corrupted, hosted routes could regress tenant isolation if copied carelessly, and older SDK backends could fail opaquely.
- Recommended edit: Index only explicit note fallback fields plus name/tags/config, escape/cap search tokens, require org predicates in the update/search implementation, reject generic metadata patching in this slice, document SDK backend-version expectations, and consider deferring Compare/SDK helpers if the slice remains too broad.
- Decision: Accepted with revisions. The design now removes generic metadata patching, narrows search metadata to note fallback fields, adds token escaping/capping, states org-scoped update/search requirements, documents SDK compatibility, and keeps Compare editing because it is a direct user-requested P5 surface but with a narrower picker-based editor.

Fresh reviewer 2:

- Finding: Compare editing was coupled to the reference run, workspace density/truncation rules were underspecified, editor states were too vague, empty-note semantics were ambiguous, and tests missed failure/responsive cases.
- Risk: Researchers would have to change the baseline to annotate another run, notes/tags could crowd the main scan surface, optimistic edits could be hard to test, and empty-note handling could complicate future filters.
- Recommended edit: Add a separate edit-run picker or per-run edit action in Compare, define chip/note truncation and responsive behavior, specify read/edit/dirty/saving/cancel/error states, pick canonical note clearing semantics, and add smoke/regression coverage beyond the happy path.
- Decision: Accepted. Compare gets an edit-run picker independent of reference, density and editor states are now explicit, empty notes remove `metadata.notes`, and the test plan includes failure/responsive/saved-view checks.

## Coverage Exceptions

None expected.

## Decision

Accepted after fresh review revisions.
