import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";

import {
  DEFAULT_API_URL,
  bearerTokenFromHeader,
  parseCliOptions,
} from "../mcp-server.mjs";

test("MCP entrypoint defaults to the hosted consumer API URL", () => {
  assert.equal(DEFAULT_API_URL, "https://api.instantml.ai");
  assert.deepEqual(parseCliOptions([], {}), {
    transport: "stdio",
    apiUrl: "https://api.instantml.ai",
    apiKey: undefined,
    host: "127.0.0.1",
    port: 8080,
  });
  assert.equal(
    parseCliOptions(["--transport", "streamable-http"], { PORT: "9000" }).host,
    "0.0.0.0",
  );
});

test("MCP entrypoint extracts bearer tokens for hosted HTTP mode", () => {
  assert.equal(bearerTokenFromHeader("Bearer instantml_test"), "instantml_test");
  assert.equal(bearerTokenFromHeader("bearer instantml_test"), "instantml_test");
  assert.equal(bearerTokenFromHeader("Basic abc"), null);
  assert.equal(bearerTokenFromHeader(undefined), null);
});

test("MCP HTTP mode exposes health and rejects unauthenticated MCP calls", async () => {
  const child = spawn(
    process.execPath,
    ["tools/mcp-server.mjs", "--transport", "http", "--port", "0"],
    {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, INSTANTML_API_URL: "https://api.instantml.ai" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  let port = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = stderr.match(/transport=http, host=127\.0\.0\.1, port=(\d+)/);
    if (match) {
      port = Number.parseInt(match[1], 10);
    }
  });

  try {
    const deadline = Date.now() + 5000;
    while (!port && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(port, `server did not report a port; stderr=${stderr}`);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "instantml-mcp" });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 401);
    assert.match(JSON.stringify(await response.json()), /Missing Authorization bearer token/);

    const initialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer instantml_test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "instantml-test", version: "0" },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    assert.match(await initialize.text(), /"serverInfo":\{"name":"instantml-mcp"/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
