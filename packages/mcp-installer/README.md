# @instantml/mcp

Command-line setup helper for the hosted InstantML MCP server.

The normal user path is the hosted remote endpoint:

```text
https://mcp.instantml.ai/mcp
```

This package exists for clients that still need a local command, a printable
config snippet, or a future config-file installer. It does not contain the MCP
server implementation; the hosted server runs at `mcp.instantml.ai`.

## Commands

Print setup snippets:

```bash
npx -y @instantml/mcp print claude-code --api-key instantml_...
npx -y @instantml/mcp print codex --api-key instantml_...
npx -y @instantml/mcp print cursor --api-key instantml_...
```

Run a local stdio bridge for clients that cannot pass remote HTTP headers:

```bash
INSTANTML_API_KEY=instantml_... npx -y @instantml/mcp bridge
```

`bridge` uses `mcp-remote` to forward local stdio requests to
`https://mcp.instantml.ai/mcp`.

## Publish Status

This package is staged in the monorepo but is not published until the package
release workflow is reviewed.
