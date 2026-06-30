import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { parseOAuthConfig, protectedResourceMetadata } from "../mcp-server.mjs";

const AUTH_SERVER = "https://instantml.clerk.accounts.dev";

test("OAuth discovery is opt-in and off by default", () => {
  assert.equal(parseOAuthConfig({}), null);
  assert.equal(parseOAuthConfig({ INSTANTML_MCP_OAUTH_AUTH_SERVER: "   " }), null);
});

test("parseOAuthConfig advertises the hosted resource and authorization server", () => {
  const config = parseOAuthConfig({ INSTANTML_MCP_OAUTH_AUTH_SERVER: `${AUTH_SERVER}/` });
  assert.equal(config.authServer, AUTH_SERVER);
  assert.equal(config.publicUrl, "https://mcp.instantml.ai");
  assert.equal(config.resource, "https://mcp.instantml.ai/mcp");
  assert.equal(config.metadataUrl, "https://mcp.instantml.ai/.well-known/oauth-protected-resource");
  assert.deepEqual(config.scopes, ["export:read", "reports:write"]);

  const metadata = protectedResourceMetadata(config);
  assert.equal(metadata.resource, "https://mcp.instantml.ai/mcp");
  assert.deepEqual(metadata.authorization_servers, [AUTH_SERVER]);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
});

test("parseOAuthConfig honors overrides for public URL, resource, and scopes", () => {
  const config = parseOAuthConfig({
    INSTANTML_MCP_OAUTH_AUTH_SERVER: AUTH_SERVER,
    INSTANTML_MCP_PUBLIC_URL: "https://mcp.example.test/",
    INSTANTML_MCP_OAUTH_RESOURCE: "https://mcp.example.test/mcp",
    INSTANTML_MCP_OAUTH_SCOPES: "export:read, reports:write runs:read",
  });
  assert.equal(config.publicUrl, "https://mcp.example.test");
  assert.equal(config.resource, "https://mcp.example.test/mcp");
  assert.deepEqual(config.scopes, ["export:read", "reports:write", "runs:read"]);
});

async function startServer(extraEnv) {
  const child = spawn(
    process.execPath,
    ["tools/mcp-server.mjs", "--transport", "http", "--port", "0"],
    {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, INSTANTML_API_URL: "https://api.instantml.ai", ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  let port = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = stderr.match(/port=(\d+)/);
    if (match) port = Number.parseInt(match[1], 10);
  });
  const deadline = Date.now() + 5000;
  while (!port && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(port, `server did not report a port; stderr=${stderr}`);
  return { child, port, stderr: () => stderr };
}

test("OAuth mode serves protected-resource metadata and challenges unauthenticated calls", async () => {
  const { child, port, stderr } = await startServer({
    INSTANTML_MCP_OAUTH_AUTH_SERVER: AUTH_SERVER,
  });
  try {
    assert.match(stderr(), /auth=oauth\+api-key/);

    const metadataResponse = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
    );
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.resource, "https://mcp.instantml.ai/mcp");
    assert.deepEqual(metadata.authorization_servers, [AUTH_SERVER]);

    const challenge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(challenge.status, 401);
    const authenticate = challenge.headers.get("www-authenticate");
    assert.ok(authenticate, "expected a WWW-Authenticate challenge header");
    assert.match(authenticate, /Bearer/);
    assert.match(
      authenticate,
      /resource_metadata="https:\/\/mcp\.instantml\.ai\/\.well-known\/oauth-protected-resource"/,
    );
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("default mode does not advertise OAuth discovery", async () => {
  const { child, port } = await startServer({});
  try {
    const metadataResponse = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
    );
    assert.equal(metadataResponse.status, 404);

    const challenge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get("www-authenticate"), null);
    assert.match(JSON.stringify(await challenge.json()), /Missing Authorization bearer token/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
