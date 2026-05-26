# Design: Run Search Query Language

Date: 2026-05-25

Status: Accepted after fresh-agent review

Owner: Codex

## Summary

InstantML's run search currently treats the `q` parameter as whitespace tokens
that must all appear somewhere in the run search text. That behavior is fast to
understand and useful for queries like `seed 13`, but it is too weak for large
comparison workflows where researchers need to include, exclude, and group
conditions by tag, status, name, notes, config, and occasional regex patterns.

This design keeps the existing search box and `q` API parameter, preserves bare
literal search by default, and adds a small GitHub/Datadog-style query language
with explicit regex. The backend remains authoritative for parsing and
evaluation so overview counts, run pages, and "select all matching" always agree.

The syntax is intentionally smaller than MLflow's SQL-like search DSL and
smaller than W&B/Linear-style visual filter builders. The first slice optimizes
for one compact daily-workflow search box, clear inline help, safe compatibility,
and predictable performance at the current large-run target.

## Goals

- Preserve existing bare-text behavior for saved views and muscle memory.
- Add exact tag/status filters, text field qualifiers, explicit regex, boolean
  `AND`/`OR`/`NOT`, parentheses, quoted phrases, and unary exclusion.
- Keep one search box in the dashboard topbar with a compact syntax help
  popover and inline validation errors.
- Apply identical search semantics to `/api/overview`, `/api/runs/summary`,
  `/runs`, `/api/export`, and `/api/runs/summary?projection=selection`.
- Parse and compile each query once per request, not once per run.
- Keep Rust/ClickHouse as the source of truth while preserving deprecated Node
  compatibility where safe.
- Update internal docs, public docs, generated OpenAPI, and in-product search
  notes together.

## Non-Goals

- No visual filter builder in this slice.
- No MLflow-style metric/config numeric comparisons.
- No `tags:[a,b]` bracket-list syntax yet; boolean `tag:` clauses cover the
  same first use cases with less parser ambiguity.
- No separate search service, background indexer, or new database table.
- No frontend query parser beyond displaying server validation details and
  static help examples.

## Research Notes

- GitHub code search uses whitespace as implicit `AND`, quoted exact strings,
  qualifiers, uppercase boolean operators, parentheses, and slash regex. It also
  documents spacing rules and falls back to literal interpretation for ambiguous
  components.
- Datadog log search uses terms, tags/attributes, grouping, `OR`, and negation
  in a compact text box. Its tag examples map closely to run tags.
- W&B separates run name/ID regex search from a structured filter editor with
  grouped `AND`/`OR` filters. That is useful long term, but too much UI for this
  first slice.
- MLflow uses a pseudo-SQL DSL for metrics, params, tags, datasets, and run
  attributes. It is powerful for API users but too heavyweight for the current
  topbar search.
- Linear's filter builder reinforces the longer-term path: if users need many
  nested conditions often, add a visual builder later rather than bloating the
  compact query language.
- Neptune's query docs distinguish regex patterns from exact ID lists and typed
  filter objects, supporting the decision to keep regex explicit.
- Rust's `regex` crate avoids backreferences/look-around and documents
  worst-case search complexity, making it safer for user-provided patterns than
  JavaScript `RegExp`.

## Query Language

Supported examples:

```text
reward stability
"long context"
tag:baseline status:finished
name:"long context" -tag:debug
(tag:baseline OR tag:candidate) notes:ablated
re:/seed-(13|14)/
name:re:/baseline-.*/
```

Grammar rules:

- Bare terms are case-insensitive literal substring terms over the same fields
  as `all:`. Adjacent terms are implicit `AND`.
- Quoted strings are literal substrings and support only `\"` and `\\` escapes.
- Boolean operators are uppercase `AND`, `OR`, and `NOT`; lowercase words are
  literals. Precedence is `NOT`/field-group `-`, then `AND`/adjacency, then
  `OR`.
- Parentheses group expressions. Spaces are required around boolean operators.
- The `-` shorthand is equivalent to `NOT` only before a recognized field,
  explicit regex, or grouped expression; negative literals such as `-1` and
  `-loss` continue to search as plain text.
- Recognized fields are `name`, `project`, `notes`, `config`, `metadata`,
  `all`, `tag`, `tags`, `status`, and `id`.
- Unknown qualifiers such as `foo:bar` are treated as literal text for backward
  compatibility.
- Regex is explicit only: `re:/pattern/` or `field:re:/pattern/`. Bare
  `/pattern/` remains literal text.
- Regexes are case-insensitive by default through the Rust regex builder.
- Empty regexes, regexes that match the empty string, and invalid regexes return
  search validation errors.
- Incomplete live-typed constructs fall back to literal search when safe. Closed
  but invalid advanced constructs return a structured validation error.
- Positions are 1-based character columns in the original query string.
- Matching remains ASCII case-insensitive in v1, matching the current
  `to_ascii_lowercase()` behavior.

Field semantics:

- `all:` and bare terms search run name, project, tags, config JSON, metadata
  JSON, status, ID, and note fallback fields. Matching checks the bounded field
  texts independently so an unusually large config value cannot hide a later
  note/status/ID match.
- `name:`, `project:`, `notes:`, `config:`, and `metadata:` are
  case-insensitive literal substring matches unless given `re:/.../`.
- `tag:` and `tags:` are exact case-insensitive tag matches unless given
  `re:/.../`; quoted tag values support spaces and commas.
- `status:` is exact case-insensitive matching over supported statuses.
- `id:` matches UUID string prefixes and requires at least four characters
  after the prefix when parsed as a field. Shorter values fall back to literal
  while typing.
- `notes:` searches `metadata.notes`, with read fallback to `note`,
  `description`, `summary`, and `comment` for imported data.

Compatibility:

- Existing saved queries such as `seed 13`, `reward stability`, path fragments,
  config keys, and lowercase `and/or/not` retain literal behavior.
- `OR`, `AND`, `NOT`, recognized `field:value`, `(...)`, and `re:/.../` become
  advanced syntax only when the construct is complete enough to parse.
- The only expected compatibility risk is an existing saved query that already
  intentionally used separated uppercase boolean words or a recognized
  `field:value` literal. This is documented in user-facing docs.

Fallback and validation matrix:

| Query | Behavior |
| --- | --- |
| `seed 13` | literal AND over all searchable run fields |
| `lowercase and or not` | literal AND; lowercase words are not operators |
| `foo:bar` | literal `foo:bar`; unknown qualifier fallback |
| `name:` / `tag:` / `id:` | literal fallback while typing |
| `status:unknown` | structured `run_search_invalid`; recognized status field with invalid closed value |
| `(` / `tag:(baseline OR` / trailing `AND` / bare `NOT` | literal fallback while typing |
| `-1` / `-loss` | literal fallback-compatible text search, not exclusion |
| `"unterminated` / `name:"unterminated` | literal fallback while typing |
| `""` / `name:""` | structured `run_search_invalid`; closed quoted phrases must not be empty |
| `re:/` / `re:/unterminated` | literal fallback while typing |
| `re:/[/` | structured `run_search_invalid`; closed regex does not compile |
| `re:/.*/` | structured `run_search_invalid`; regex matches the empty string |
| `name:re:/foo\\/bar/` | valid field regex; escaped slash is part of the pattern |
| `id:re:/abc/` | structured `run_search_invalid`; regex is not allowed on `id` |

## Backend Design

Add a Rust search module under the run store that:

- Validates `q` length before parsing.
- Tokenizes and parses `q` into a typed AST once per request.
- Compiles regexes once per request.
- Evaluates the AST against a structured `RunSearchDocument`.
- Exposes a lightweight classification so simple legacy literal-AND queries can
  keep existing fast/indexed behavior where practical.
- Returns a normalized query object with `is_empty`, `is_simple_literal_and`,
  `is_advanced`, and `uses_regex` flags for route-level fast-path decisions.

`RunSearchDocument` is derived from each `RunRow` and cached in the in-memory
operational index. It includes:

- lowercase name and project
- lowercase note text
- lowercase serialized config and metadata text
- lowercase tags plus original tags for display-independent exact matching
- lowercase status
- UUID string

Search application order:

1. Org scope and API-key project restriction.
2. Existing `project` and `status` route filters.
3. Cheap query predicates that can quickly reject rows, especially `status`,
   `id`, and exact `tag` terms.
4. Literal substring and regex predicates.
5. Sort, pagination, summary hydration, and metric-key discovery as they work
   today.

Lock and cost strategy:

- Simple literal-AND queries may keep the current created-index path while
  holding the in-memory store lock because they only run bounded substring
  checks against precomputed field text.
- Advanced queries, any regex query, and broad negation/OR queries must not
  evaluate regex or the full AST while holding `store.data.lock()`.
- For advanced queries, collect candidate `(RunRow, RunSearchDocument)` pairs
  after org/project/API-key/status route filters while holding the lock, then
  release the lock before evaluating the AST.
- Candidate collection may clone only route-scoped candidates; it must not
  clone metric series or artifacts.
- Query evaluation short-circuits cheap exact predicates before substring or
  regex checks.
- Broad regex queries are accepted only inside the hard limits below. They must
  be covered by a large-run benchmark or scale smoke before the PR is merged.

Hard limits:

- `q` length: 512 bytes.
- Search terms: 32.
- AST nodes: 64.
- Nesting depth: 8.
- Regex count: 4.
- Regex pattern length: 128 bytes.
- Per-run searched field text: 32 KiB per document field.
- Truncation is deterministic from the beginning of each field. Docs state that
  unusually large config/metadata values beyond 32 KiB are not guaranteed to be
  searchable in v1.

Errors:

- Add a structured validation helper that can emit:

```json
{
  "error": "Invalid run search: expected ')' at column 24.",
  "code": "run_search_invalid",
  "field": "q",
  "position": 24
}
```

- Preserve existing public server-error redaction.
- Add `AppError::search_validation(message, position)` and
  `AppError::with_field_code(status, code, field, position, message)` rather
  than exposing raw parser/regex errors directly.
- Search validation messages must be fixed, sanitized strings assembled by our
  parser, never raw regex crate text, stack traces, SQL, or backend internals.
- Update OpenAPI `ErrorResponse` to match the actual flat error body:
  `error: string`, `code?: string`, `field?: string`, `position?: number`.
- Every route accepting run `q` documents a `400` response.

Deprecated Node compatibility:

- Implement literal terms, fields, booleans, tags, status, and ID prefix parity.
- Do not evaluate user regex with JavaScript `RegExp`. Return
  `400 { code: "run_search_regex_unsupported", field: "q" }` for `re:` queries
  on Node.
- Keep Node tests focused on fixture parity and documented regex rejection.
- Shared Rust/Node fixture cases must cover booleans, fields, unknown-qualifier
  fallback, invalid constructs, all affected list routes, and `/api/export`.

Affected routes:

- `/api/overview`
- `/api/runs/summary`
- `/api/runs/summary?projection=selection`
- `/runs`
- `/api/export`

## Frontend Design

The topbar keeps one search input. Changes:

- Add a small help icon button next to the input with a popover of syntax
  examples and brief field/regex notes.
- Show inline validation text associated with the search input when Rust returns
  `run_search_invalid` or Node returns `run_search_regex_unsupported`.
- Keep the last valid results visible while an invalid query is shown.
- Do not show a generic global "Request was invalid" message for search syntax.
- Disable "Select all matching" while the committed search query is invalid.
- Visually stale-mark the search error when the user edits the query; clear it
  after a succeeding committed query or when filters clear.
- Keep debounce behavior and stale-query guard for "select all matching".
- Keep saved views storing the raw query string; no query mode flag in v1.

The frontend API client should preserve safe validation details on `ApiError`
without exposing arbitrary server messages for unrelated errors. Search-specific
call sites can inspect `error.code`, `error.field`, `error.position`, and a safe
server message.

Invalid-query state model:

- Store inline search errors as `searchError:
  { query: string; code: string; message: string; position: number | null } |
  null`, keyed to the committed `query`, not the live `queryInput`.
- Only errors with `field === "q"` and code `run_search_invalid` or
  `run_search_regex_unsupported` may populate `searchError`.
- The API client exposes `safeMessage` only for those allowlisted search errors;
  all other `400` responses keep the generic safe client message.
- When a committed search request fails with an allowlisted search error:
  - Do not replace `summary`, `overview`, selected runs, page cursor stack, or
    the global message.
  - End loading/navigation states.
  - Set `searchError` for that committed query.
  - Background silent polls do not re-announce the same search error.
- When the user edits the input, visually de-emphasize the old error but keep
  actions disabled until a new committed query succeeds or clears. The error is
  removed only when the committed query changes successfully or filters clear.
- "Select all matching" is disabled when `queryInput !== query` or when
  `searchError?.query === query`.
- Applying a saved view applies its project/status/sort/selection state first,
  restores the raw query, then lets the committed load validate it. If invalid,
  previous result data remains visible with the inline error attached to the
  restored query.
- The search input uses `aria-describedby` for help and error text; the help
  button is focusable; Escape closes the popover; errors use polite live
  announcement.

## Public API And Docs

`q` remains the same string query parameter; its accepted language expands.
Update:

- Rust utoipa annotations.
- `apps/rust-server/openapi.generated.json`.
- `apps/web/src/types/api.generated.ts`.
- `apps/docs/openapi.json`.
- `apps/rust-server/README.md`.
- `apps/server/README.md`.
- `apps/web/README.md`.
- `docs/architecture/current-api.md`.
- `docs/architecture/current-system.md`.
- `docs/architecture/current-schemas.md` if search document fields are
  mentioned.
- `apps/docs/dashboard/runs-workspace.mdx`.
- `apps/docs/dashboard/compare-runs.mdx`.
- `apps/docs/api/projects-runs.mdx`.
- `apps/docs/sdk/querying-data.mdx`.
- `apps/docs/concepts/core-concepts.mdx`.
- `apps/docs/api/errors-and-limits.mdx`.
- `apps/docs/guides/imports.mdx` only if export/import examples mention `q`.

The in-product help popover is the docnote closest to the actual search bar.
It should include the examples in the query-language section and be concise
enough to remain useful during daily work.

## Testing

Rust:

- Parser/evaluator golden tests for bare search, phrases, fields, exact tags,
  status, ID prefixes, boolean precedence, parentheses, unary exclusion, regex,
  unknown qualifier fallback, and invalid constructs.
- Endpoint tests for `/api/overview`, `/api/runs/summary`, `/runs`, cursor or
  offset pagination, metric sort plus search, project/status/API-key scope, and
  `projection=selection`.
- Export tests for `/api/export?q=...` so shared `filtered_runs` behavior is
  intentional.
- Error tests for structured `run_search_invalid` responses.
- Worst-case scale/benchmark coverage for broad regex miss, broad regex match,
  broad negation, and boolean OR against the large-run benchmark dataset.

Node:

- Shared fixture-style tests for supported non-regex queries.
- Explicit test that `re:` returns `run_search_regex_unsupported`.

Frontend:

- API client tests for preserving search validation details.
- Dashboard state tests for inline search errors, last-valid results, clearing
  errors on edit, saved-view restore, and select-all invalid-query guard.
- UI smoke coverage for tag, note, boolean, and regex search against Rust.
- Accessibility checks for search help/error associations.

Docs/codegen:

- `npm run codegen:api`.
- `npm run docs:sync-openapi`.
- `npm run verify:api-types`.
- `npm run docs:check-openapi`.

Verification commands before PR:

```bash
npm run rust:fmt:check
npm run rust:lint
npm run rust:test
npm run test:node
npm run verify:api-types
npm run docs:check-openapi
npm run docs:validate
npm run test:ui
```

## Review Notes

Fresh reviewers were spawned after the design doc was created:

- Rust/API/performance review blocked on parser fallback ambiguity,
  lock-held regex evaluation risk, and exact error-helper policy. Resolved by
  adding the fallback matrix, lock-safe advanced evaluation rule, query-cost
  limits, and `AppError::search_validation` policy above.
- Frontend/UX review blocked on invalid-query state, last-valid-results data
  flow, saved-view restore, and safe error exposure. Resolved by defining
  `searchError` keyed to committed `query`, preserving summary/overview/cursor
  state on invalid searches, disabling select-all for stale/invalid committed
  queries, and allowlisting exposed search error fields/messages.
- Docs/security/contract review blocked on `/api/export`, regex CPU risk,
  ambiguous fallback behavior, flat error schema, and Node parity. Resolved by
  adding `/api/export` to the affected route set, requiring lock-safe regex
  evaluation and benchmark coverage, defining the fallback table and 1-based
  character positions, requiring fixed sanitized parser messages, and requiring
  shared Node/Rust fixture coverage with explicit Node regex rejection.
