# MCP Gap Execution Progress

Date: 2026-06-30

Status: In progress

Owner: Codex

## Summary

This note tracks the five-PR MCP gap series requested after the hosted MCP
first slice. Each gap stays on its own branch and PR. The series is stacked
because the MCP tool registry, tests, and public agent docs share the same
files.

## Gaps

| Gap | Branch | Scope | Status |
| --- | --- | --- | --- |
| 1 | `codex/mcp-gap1-share-url` | Return frontend report share URLs from `tracker.share_report`. | Ready for PR |
| 2 | `codex/mcp-gap2-list-projects` | Add `tracker.list_projects`. | Ready for PR |
| 3 | `codex/mcp-gap3-compare-matching-runs` | Add server-side query comparison and MCP wrapper. | Ready for PR |
| 4 | `codex/mcp-gap4-artifact-lineage-tools` | Add read-only artifact, checkpoint, and lineage MCP tools. | Pending |
| 5 | `codex/mcp-gap5-report-markdown-export` | Add `tracker.export_report_markdown`. | Pending |

## Gap 1 Notes

- Classification: localized MCP/report-tool bug fix; no new backend route or
  storage contract.
- Implementation: add a frontend base URL setting for MCP share links, defaulted
  to `https://instantml.ai` with `INSTANTML_WEB_URL`,
  `INSTANTML_FRONTEND_BASE_URL`, and `--web-url` overrides.
- Expected result: hosted and local MCP clients receive public report links on
  `/r/<share-token>` under the web app origin, not the API origin.

## Gap 2 Notes

- Classification: localized MCP wrapper over existing Rust `GET /projects`;
  no new backend route or storage contract.
- Implementation: add `tracker.list_projects` so agents can discover valid
  projects before using `tracker.list_runs`.
- Expected result: the documented "List my InstantML projects" setup check
  works through hosted and local MCP clients.

## Gap 3 Notes

- Classification: substantial backend/MCP contract change; design doc updated
  in `docs/design/2026-06-29-agent-compare-runs-api.md`.
- Architecture review: two fresh agent reviewers approved a narrow first slice
  after tightening exact filtered top-k selection, reference semantics,
  candidate evidence, row truncation, and MCP wrapper schema.
- Implementation: add `POST /api/runs/compare-query` and
  `tracker.compare_matching_runs` so agents can rank matching runs server-side
  and receive candidate evidence plus optional bounded comparison rows.
- Expected result: agents no longer need to page `tracker.list_runs` manually
  before comparing the best or latest matching runs.

## Validation Log

- 2026-06-30 gap 1: `node --test tools/tests/mcp-server-entrypoint.test.js apps/server/tests/mcp-server-reports.test.js` passed.
- 2026-06-30 gap 1: real HTTP MCP `tools/call` against a fake upstream report-share API returned `https://staging.instantml.ai/r/share-live`.
- 2026-06-30 gap 1: `npm run docs:validate` passed.
- 2026-06-30 gap 1: local diff review and `git diff --check` completed with no findings.
- 2026-06-30 gap 2: `node --test tools/tests/mcp-server-entrypoint.test.js apps/server/tests/mcp-server-reports.test.js` passed.
- 2026-06-30 gap 2: real HTTP MCP `tools/call` against a fake upstream `GET /projects` API returned project rows.
- 2026-06-30 gap 2: `npm run docs:validate` passed.
- 2026-06-30 gap 2: local diff review and `git diff --check` completed with no findings.
- 2026-06-30 gap 3: architecture review completed by fresh reviewer agents
  Huygens and Aquinas; accepted design doc updated before implementation.
- 2026-06-30 gap 3: `cargo test --manifest-path apps/rust-server/Cargo.toml compare_matching_runs_appends_reference_within_filtered_scope` passed.
- 2026-06-30 gap 3: `node --test tools/tests/mcp-server-entrypoint.test.js apps/server/tests/mcp-server-reports.test.js` passed.
- 2026-06-30 gap 3: real HTTP MCP `tools/call` against a fake upstream
  `POST /api/runs/compare-query` API returned selected run IDs and comparison
  rows.
- 2026-06-30 gap 3: `npm run docs:validate` passed.
- 2026-06-30 gap 3: `npm run test:rust:contract` passed against a disposable
  local Rust service.
- 2026-06-30 gap 3: local diff review and `git diff --check` completed with no
  findings after tightening out-of-filter reference handling.
- 2026-06-30 gap 3: full `npm run rust:test` was attempted; non-Postgres tests
  ran, but 36 existing `sqlx::test` cases failed immediately because
  `DATABASE_URL` is unset in this shell.
- Pending: PR.
