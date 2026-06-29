# Design: Hosted MCP Server

Date: 2026-06-29

Status: Draft first slice

Owner: Codex

## Summary

InstantML should match the setup pattern used by mature SaaS MCP integrations:
consumers connect their agent to a hosted remote MCP endpoint, authenticate with
their InstantML API key, and do not clone the InstantML repository or run a
local backend. The smallest useful first slice is to make the existing Node MCP
server support stateless Streamable HTTP in addition to local stdio, document
`https://mcp.instantml.ai/mcp` as the consumer endpoint, and keep local stdio as
a preview/development fallback.

This PR does not create DNS, deploy Cloud Run, implement OAuth, or publish a
standalone npm package. It makes the MCP server deployable as a hosted service
where each incoming HTTP request provides an `Authorization: Bearer <api key>`
header that is forwarded to the existing InstantML API at
`https://api.instantml.ai`.

## Goals

- Make hosted remote MCP the primary consumer setup path.
- Avoid requiring repository access, local Node installs, or backend deploys for
  normal consumers.
- Preserve the existing stdio server for local preview and clients that only
  support local MCP servers.
- Keep the MCP tools backed by the existing Rust API routes and existing API key
  scopes.

## Non-Goals

- No new product API routes, database tables, or storage changes.
- No OAuth connector flow in this slice.
- No DNS, certificate, Cloud Run, or load-balancer rollout in this PR.
- No public npm package publish workflow in this slice.

## Users and Use Cases

ML engineers and research agents should be able to add InstantML to Cursor,
Claude Code, Codex, VS Code, or similar tools by pasting a hosted MCP URL and an
InstantML API key. Internal developers can still run the stdio server from a
checkout while testing tool changes.

## Proposed Design

`tools/mcp-server.mjs` supports two transports:

- `stdio`: the existing local mode. It reads `INSTANTML_API_KEY` from the
  environment and calls `INSTANTML_API_URL`, defaulting to
  `https://api.instantml.ai`.
- `http`: a stateless Streamable HTTP mode for hosted deployment. It serves
  `POST /mcp`, requires an `Authorization: Bearer ...` header on every MCP
  request, creates a per-request MCP server bound to that API key, and forwards
  tool calls to the InstantML API. It also serves `GET /health` for deployment
  checks and responds to `OPTIONS` for remote-client compatibility.

The hosted endpoint should be deployed behind `https://mcp.instantml.ai/mcp`.
Clients that can send remote MCP headers connect directly. Clients that only
launch stdio commands can use `npx mcp-remote` as a compatibility bridge.

## Component Impact

Backend:

- No Rust API route or schema change.
- Existing Rust API endpoints remain the source of truth for auth, org access,
  scopes, run reads, metric reads, exports, and report writes.

Frontend:

- No app behavior change.

Python SDK:

- No SDK behavior change.

Storage:

- No storage change.

Docs:

- Public agent docs lead with the hosted MCP URL and document local stdio as a
  fallback.

## Data Model

No data model changes.

## API Contracts

New deployable MCP service contract:

- `GET /health` returns `{ "ok": true, "service": "instantml-mcp" }`.
- `POST /mcp` accepts Streamable HTTP MCP JSON-RPC requests.
- `POST /mcp` requires `Authorization: Bearer <instantml-api-key>`.
- Missing bearer auth returns a JSON-RPC error with HTTP 401.
- Unsupported methods on `/mcp` return a JSON-RPC error with HTTP 405.

The MCP tool contracts are unchanged from the local server.

## Performance Considerations

The hosted MCP server is request orchestration, not storage. It keeps no
session state in this slice and creates a short-lived MCP server/transport per
HTTP request. Heavy run and metric operations stay bounded by the existing tool
limits: summary pages, selected-run caps, bounded series reads, bounded
workspace panel reads, and bounded exports.

If remote MCP traffic grows enough for this per-request construction to matter,
the next slice can pool tool registries by upstream API URL while keeping API
keys request-scoped.

## Simplicity Review

This is the smallest useful hosted path because it reuses the existing MCP tool
registry and existing API key authorization. It deliberately avoids an OAuth
flow, persistent MCP sessions, server-side token storage, or a separate npm
package until real client demand justifies those additions.

## Failure Modes

- Missing or malformed bearer token: return HTTP 401 JSON-RPC error.
- Invalid InstantML API key or insufficient scope: existing API call returns an
  API error through the MCP tool result.
- Hosted MCP process cannot reach the InstantML API: tool call returns an MCP
  error result.
- Client lacks remote header support: use the documented `mcp-remote` bridge or
  local stdio fallback.

## Testing Plan

- Add a Node test for default hosted API URL, bearer extraction, health, and
  missing-auth HTTP behavior.
- Keep existing MCP tool-shaping tests for run analysis, exports, workspace
  view data, and report tools.
- Run public docs content/snippet validators after doc updates.

## Documentation Plan

- Update `apps/docs/sdk/agent-mcp.mdx` with the hosted setup, `mcp-remote`
  bridge, and local fallback.
- Update `tools/README.md` with local and hosted MCP commands.
- Keep `docs/design/README.md` linked to this design.

## Alternatives Considered

- npm package as primary path: useful for local-only clients, but mature SaaS
  integrations increasingly lead with hosted remote MCP because there is no
  local process to install or update.
- Rust-native MCP endpoint: closer to the main backend, but it would duplicate
  MCP protocol handling and tool definitions before the hosted path is proven.
- OAuth-first hosted MCP: better eventual UX, but API-key bearer auth is the
  smallest deployable slice and matches existing InstantML API key behavior.

## Review Notes

Fresh reviewer 1:

- Finding: Pending.
- Risk: This first slice is implemented before fresh design review because the
  user requested it in the active PR.
- Recommended edit: Review hosted auth, client compatibility, and deployment
  hardening before production DNS points at the service.
- Decision: Keep as draft first slice until reviewed.

Fresh reviewer 2:

- Finding: Pending.
- Risk: Same as above.
- Recommended edit: Confirm whether OAuth should supersede API-key headers
  before broader public launch.
- Decision: Keep as draft first slice until reviewed.

## Coverage Exceptions

None.

## Decision

Draft first slice implemented for PR review. Production rollout still requires
review, deployment configuration, DNS/certificate setup, and hosted smoke tests.
