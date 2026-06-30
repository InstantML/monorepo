# Design: Zero-Friction MCP Setup

Date: 2026-06-30

Status: Draft

Owner: Codex

## Summary

InstantML now exposes a hosted MCP endpoint at `https://mcp.instantml.ai/mcp`.
The next product step is to make connecting an agent feel like a normal
dashboard setup action instead of a docs-and-config-file chore.

The smallest useful implementation is not full OAuth. It is:

- a dashboard "Connect Agent" panel next to API-key creation,
- generated client-specific snippets that can use the copy-once API key,
- a publish-ready MCP Registry `server.json`,
- a small npm installer package scaffold for clients that still need local
  config help,
- docs that make the dashboard flow the primary path.

Full browser-based MCP OAuth remains the target zero-friction endpoint, but it
is a separate auth change and should not be rushed into the current API-key
surface without a fresh backend review.

## Goals

- Let workspace owners create a key and connect Claude Code, Codex, Cursor,
  VS Code, or local-only clients from one dashboard surface.
- Keep the hosted endpoint as the default; users should not clone the repo or
  run a local server for normal use.
- Provide a registry metadata file for remote MCP discovery.
- Provide an npm installer package scaffold for older clients and future
  one-command setup.
- Preserve existing API-key security constraints: copy-once reveal, owner/admin
  gating, and explicit bearer-token usage.

## Non-Goals

- Do not implement OAuth in this slice.
- Do not auto-write secrets into client config files from the browser.
- Do not publish an npm package or registry entry from this code change.
- Do not change the MCP tool contract or add new backend routes.
- Do not deploy a new MCP revision unless the implementation changes runtime
  behavior.

## Users and Use Cases

Primary users are workspace owners/admins who want an agent to inspect and
compare training runs. The happy path:

1. Open Dashboard -> API.
2. Create an "Agent MCP key".
3. Copy the generated setup for the user's client.
4. Ask the agent to list recent InstantML runs.

Secondary users are agent clients and registry consumers discovering the remote
server from metadata.

## Proposed Design

### Current Slice

Add an `AgentSetupPanel` in `apps/web/app/dashboard/api/`. It renders below API
key creation and uses the copy-once key when available. It generates:

- Claude Code `claude mcp add --transport http ... --header ...`
- Codex `~/.codex/config.toml` with `bearer_token_env_var`
- Cursor remote HTTP JSON
- VS Code `.vscode/mcp.json`
- local-only `mcp-remote` JSON

When no copy-once key is visible, the panel uses `instantml_...` placeholders
and nudges owners/admins to create an Agent MCP key first. Read-only members
see the docs link and cannot see stale key material.

Add `packages/mcp-installer/` as a dependency-free publishable npm package
scaffold named `@instantml/mcp`. The first CLI prints client-specific snippets;
publishing and write-to-config commands can follow after real packaging review.

Add `server.json` at the repo root as publish-ready MCP Registry metadata for
the hosted remote server. Keep package metadata out of `server.json` until
`@instantml/mcp` is actually published.

### OAuth Follow-Up

The true zero-friction version should add MCP OAuth 2.1:

- MCP clients connect to `https://mcp.instantml.ai/mcp`.
- The server advertises protected-resource/auth metadata.
- The client opens the InstantML authorization page.
- A signed-in owner/admin approves scopes.
- The auth server issues a short-lived access token scoped to the user's org
  and requested MCP scopes.
- The MCP server validates that token and forwards requests to the Rust API
  using either a delegated internal token or a constrained API-key equivalent.

This requires a separate design for authorization metadata, token storage,
scope mapping, revocation, audit events, and Clerk/session interaction.

## Component Impact

Backend:

- Current slice: none.
- OAuth follow-up: new auth endpoints and token validation path, likely in
  `apps/rust-server` or a dedicated auth edge service.

Frontend:

- Add the dashboard Agent setup panel to the API tab.

Python SDK:

- No impact.

Storage:

- Current slice: no data model changes.
- OAuth follow-up: likely token grants, refresh/session records, audit events,
  and revocation records.

Docs:

- Update public MCP docs to lead with Dashboard -> API -> Connect Agent.
- Keep manual setup and local fallback documented.

## Data Model

Current slice: no new entities.

OAuth follow-up likely needs:

- `oauth_clients` or dynamic client registration metadata if clients require it.
- `oauth_grants` for user/org/client/scope approval.
- `oauth_tokens` or hashed token identifiers for revocation/audit.
- audit records for grant, token exchange, token refresh, and revoke.

## API Contracts

Current slice:

- No new API routes.
- Existing API-key creation remains the source of bearer secrets.
- `server.json` declares:
  - `remotes[0].type = "streamable-http"`
  - `remotes[0].url = "https://mcp.instantml.ai/mcp"`
  - `Authorization` header variable marked secret.
  - No `packages` entry until the npm helper is published.

OAuth follow-up:

- Implement MCP authorization discovery and protected-resource metadata.
- Implement authorization code + PKCE token exchange.
- Add scopes that map to existing API-key scopes such as `export:read` and
  report write permissions.

## Performance Considerations

Current slice:

- Dashboard rendering is static string generation; no new reads or writes.
- Generated snippets are small and local to the browser.

OAuth follow-up:

- Token validation must be a bounded hot path on every MCP request.
- Prefer locally verifiable signed tokens or a short cache keyed by token hash
  over per-tool-call database lookups.
- Audit writes should batch or stay off the scalar metric hot path.

## Simplicity Review

The current slice reuses API keys because InstantML already has key creation,
copy-once reveal, scope enforcement, and revocation. It avoids inventing a new
auth stack before the remote server has user feedback.

Deferred complexity:

- OAuth consent and refresh.
- config-file mutation from the browser.
- automatic registry publishing.

## Failure Modes

- User copies a placeholder instead of a real key: the MCP endpoint returns
  `401`; docs and dashboard label the key as copy-once.
- Client does not support remote HTTP headers: use the `mcp-remote` snippet.
- User commits a config containing an API key: docs prefer env vars where
  clients support them, and the dashboard labels copy-once secrets.
- Registry metadata drifts from hosted URL: docs tests should assert the URL.

## Testing Plan

- Node source/unit tests for generated snippets and registry metadata.
- Existing API-key UI tests should continue to assert read-only members cannot
  see stale key material.
- Docs validation after public docs updates.
- Optional browser smoke for Dashboard -> API once a local dev server is
  running.

## Documentation Plan

- `apps/docs/sdk/agent-mcp.mdx`: make dashboard setup the primary path and keep
  manual setup as advanced/fallback.
- `apps/web/README.md`: note the API tab includes agent setup snippets.
- `packages/mcp-installer/README.md`: document package status and commands.

## Alternatives Considered

Only OAuth now:

- Rejected for this slice. It is the right destination but touches auth,
  grants, token storage, audit, and MCP metadata.

Only npm package:

- Rejected as the primary path. It helps older clients but still asks users to
  run a local command and manage a secret.

Put MCP under `api.instantml.ai/mcp`:

- Rejected for now. The MCP service is independently deployed and has different
  operational concerns than the Rust API router.

## Review Notes

Fresh reviewer 1:

- Finding: Pending. OAuth must get a fresh backend/auth review before
  implementation.
- Risk: Token grants could bypass existing org/project scope checks.
- Recommended edit: Map OAuth scopes to existing API-key capabilities before
  writing code.
- Decision: Current API-key setup slice can proceed; OAuth remains blocked on
  review.

Fresh reviewer 2:

- Finding: Pending. Installer config writes need client-by-client verification.
- Risk: A CLI could write secrets into the wrong config file or repo-local
  config.
- Recommended edit: Keep the first npm package print-only until write mode has
  dedicated tests.
- Decision: Print-only scaffold is acceptable for the first slice.

## Coverage Exceptions

- Uncovered area: live OAuth authorization and registry publishing.
- Reason: Deferred by design; no OAuth implementation or publish operation in
  this slice.
- Risk: Setup still requires API-key copy/paste until OAuth lands.
- Follow-up: Implement OAuth after auth review.
- Owner/date: Codex / 2026-06-30

## Decision

Proceed with the narrow API-key setup slice. Do not implement OAuth until the
auth design receives fresh review.
