export const INSTANTML_MCP_URL = "https://mcp.instantml.ai/mcp";
export const INSTANTML_API_KEY_PLACEHOLDER = "instantml_...";

export type AgentClientId = "claude-code" | "codex" | "cursor" | "vscode" | "local";

/**
 * How the agent client authenticates to the hosted MCP server.
 *
 * - `api-key`: paste a copy-once InstantML API key as a Bearer token.
 * - `oauth`: connect by URL only; the client opens a browser to sign in to
 *   InstantML and is granted a short-lived token via MCP OAuth. No secret to
 *   copy or rotate.
 */
export type AgentAuthMode = "api-key" | "oauth";

export type AgentSetupSnippet = {
  id: AgentClientId;
  label: string;
  filename: string;
  body: string;
};

function displayKey(apiKey: string | null | undefined) {
  const trimmed = apiKey?.trim();
  return trimmed || INSTANTML_API_KEY_PLACEHOLDER;
}

export function mcpUrlForOrg(orgId?: string | null) {
  const trimmed = orgId?.trim();
  if (!trimmed) return INSTANTML_MCP_URL;
  const url = new URL(INSTANTML_MCP_URL);
  url.searchParams.set("org_id", trimmed);
  return url.toString();
}

function apiKeySnippets(apiKey?: string | null): AgentSetupSnippet[] {
  const key = displayKey(apiKey);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      filename: "Terminal",
      body: `claude mcp add --transport http instantml ${INSTANTML_MCP_URL} \\
  --header "Authorization: Bearer ${key}"`,
    },
    {
      id: "codex",
      label: "Codex",
      filename: "~/.codex/config.toml",
      body: `# Put the key in your shell profile or launch environment:
# export INSTANTML_API_KEY=${key}

[mcp_servers.instantml]
url = "${INSTANTML_MCP_URL}"
bearer_token_env_var = "INSTANTML_API_KEY"`,
    },
    {
      id: "cursor",
      label: "Cursor",
      filename: "Cursor MCP settings",
      body: JSON.stringify(
        {
          mcpServers: {
            instantml: {
              transport: "http",
              url: INSTANTML_MCP_URL,
              headers: {
                Authorization: `Bearer ${key}`,
                Accept: "application/json, text/event-stream",
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "vscode",
      label: "VS Code",
      filename: ".vscode/mcp.json",
      body: JSON.stringify(
        {
          servers: {
            instantml: {
              type: "http",
              url: INSTANTML_MCP_URL,
              headers: {
                Authorization: `Bearer ${key}`,
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "local",
      label: "Local bridge",
      filename: "Claude Desktop / stdio clients",
      body: JSON.stringify(
        {
          mcpServers: {
            instantml: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                INSTANTML_MCP_URL,
                "--header",
                "Authorization:${INSTANTML_MCP_AUTH_HEADER}",
              ],
              env: {
                INSTANTML_MCP_AUTH_HEADER: `Bearer ${key}`,
              },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}

function oauthSnippets(orgId?: string | null): AgentSetupSnippet[] {
  const mcpUrl = mcpUrlForOrg(orgId);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      filename: "Terminal",
      body: `claude mcp add --transport http instantml "${mcpUrl}"
# Claude Code opens your browser to sign in to InstantML — no key to paste.`,
    },
    {
      id: "codex",
      label: "Codex",
      filename: "~/.codex/config.toml",
      body: `[mcp_servers.instantml]
url = "${mcpUrl}"
# No token needed — Codex completes browser sign-in on first connect.`,
    },
    {
      id: "cursor",
      label: "Cursor",
      filename: "Cursor MCP settings",
      body: JSON.stringify(
        {
          mcpServers: {
            instantml: {
              transport: "http",
              url: mcpUrl,
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "vscode",
      label: "VS Code",
      filename: ".vscode/mcp.json",
      body: JSON.stringify(
        {
          servers: {
            instantml: {
              type: "http",
              url: mcpUrl,
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "local",
      label: "Local bridge",
      filename: "Claude Desktop / stdio clients",
      body: JSON.stringify(
        {
          mcpServers: {
            instantml: {
              command: "npx",
              args: ["-y", "mcp-remote", mcpUrl],
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}

export function buildAgentSetupSnippets(
  apiKey?: string | null,
  auth: AgentAuthMode = "api-key",
  orgId?: string | null,
): AgentSetupSnippet[] {
  return auth === "oauth" ? oauthSnippets(orgId) : apiKeySnippets(apiKey);
}
