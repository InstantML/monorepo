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
| 3 | `codex/mcp-gap3-compare-matching-runs` | Add server-side query comparison and MCP wrapper. | Pending architecture review |
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

## Validation Log

- 2026-06-30 gap 1: `node --test tools/tests/mcp-server-entrypoint.test.js apps/server/tests/mcp-server-reports.test.js` passed.
- 2026-06-30 gap 1: real HTTP MCP `tools/call` against a fake upstream report-share API returned `https://staging.instantml.ai/r/share-live`.
- 2026-06-30 gap 1: `npm run docs:validate` passed.
- 2026-06-30 gap 1: local diff review and `git diff --check` completed with no findings.
- 2026-06-30 gap 2: `node --test tools/tests/mcp-server-entrypoint.test.js apps/server/tests/mcp-server-reports.test.js` passed.
- 2026-06-30 gap 2: real HTTP MCP `tools/call` against a fake upstream `GET /projects` API returned project rows.
- 2026-06-30 gap 2: `npm run docs:validate` passed.
- 2026-06-30 gap 2: local diff review and `git diff --check` completed with no findings.
- Pending: PR.
