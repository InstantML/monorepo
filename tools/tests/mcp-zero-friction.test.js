import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

test("MCP registry metadata points at the hosted InstantML MCP server", () => {
  const server = JSON.parse(read("server.json"));

  assert.equal(server.name, "ai.instantml/mcp");
  assert.equal(server.remotes?.[0]?.type, "streamable-http");
  assert.equal(server.remotes?.[0]?.url, "https://mcp.instantml.ai/mcp");
  assert.equal(server.remotes?.[0]?.headers?.[0]?.name, "Authorization");
  assert.equal(server.remotes?.[0]?.headers?.[0]?.isRequired, true);
  assert.equal(server.remotes?.[0]?.headers?.[0]?.isSecret, true);
  assert.equal(server.repository?.id, "tools");
  assert.equal(server.packages, undefined);
});

test("MCP installer prints client snippets for the hosted server", () => {
  const cli = new URL("../../packages/mcp-installer/bin/instantml-mcp.mjs", import.meta.url).pathname;
  const codex = execFileSync("node", [cli, "print", "codex", "--api-key", "instantml_test"], {
    encoding: "utf8",
  });
  const cursor = execFileSync("node", [cli, "print", "cursor", "--api-key", "instantml_test"], {
    encoding: "utf8",
  });

  assert.match(codex, /https:\/\/mcp\.instantml\.ai\/mcp/);
  assert.match(codex, /bearer_token_env_var = "INSTANTML_API_KEY"/);
  assert.match(cursor, /"Authorization": "Bearer instantml_test"/);
});

test("API tab includes gated Connect Agent setup snippets", () => {
  const tabPane = read("apps/web/app/dashboard/api/tab-pane.tsx");
  const panel = read("apps/web/app/dashboard/api/agent-setup.tsx");
  const snippets = read("apps/web/app/dashboard/api/agent-setup-snippets.ts");

  assert.match(tabPane, /<AgentSetupPanel/);
  assert.match(tabPane, /newApiKey=\{visibleNewApiKey\}/);
  assert.match(panel, /aria-label="Connect agent"/);
  // Client picker renders brand logos; auth method can be an API key or OAuth.
  assert.match(panel, /ClientLogo/);
  assert.match(panel, /Browser sign-in/);
  assert.match(snippets, /https:\/\/mcp\.instantml\.ai\/mcp/);
  assert.match(snippets, /claude mcp add --transport http/);
  assert.match(snippets, /mcp-remote/);
});

test("Connect Agent snippets support tokenless OAuth (browser sign-in)", () => {
  const snippets = read("apps/web/app/dashboard/api/agent-setup-snippets.ts");

  // OAuth mode connects by URL only — no Bearer token in the generated config.
  assert.match(snippets, /type AgentAuthMode = "api-key" \| "oauth"/);
  assert.match(snippets, /function oauthSnippets\(\)/);
  assert.match(snippets, /browser to sign in/i);
});
