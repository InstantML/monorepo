import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  bearerTokenFromHeader,
  isMainModule,
  parseCliOptions,
} from "../mcp-server.mjs";

test("MCP entrypoint defaults to the hosted consumer API URL", () => {
  assert.equal(DEFAULT_API_URL, "https://api.instantml.ai");
  assert.equal(DEFAULT_WEB_URL, "https://instantml.ai");
  assert.deepEqual(parseCliOptions([], {}), {
    transport: "stdio",
    apiUrl: "https://api.instantml.ai",
    webUrl: "https://instantml.ai",
    apiKey: undefined,
    host: "127.0.0.1",
    port: 8080,
  });
  assert.equal(
    parseCliOptions(["--transport", "streamable-http"], { PORT: "9000" }).host,
    "0.0.0.0",
  );
});

test("MCP entrypoint accepts a frontend URL override for report share links", () => {
  assert.equal(
    parseCliOptions([], { INSTANTML_FRONTEND_BASE_URL: "https://staging.instantml.ai/" })
      .webUrl,
    "https://staging.instantml.ai/",
  );
  assert.equal(
    parseCliOptions([], {
      INSTANTML_FRONTEND_BASE_URL: "https://staging.instantml.ai",
      INSTANTML_WEB_URL: "https://instantml.example",
    }).webUrl,
    "https://instantml.example",
  );
  assert.equal(
    parseCliOptions(["--web-url", "http://127.0.0.1:3000"], {
      INSTANTML_WEB_URL: "https://instantml.example",
    }).webUrl,
    "http://127.0.0.1:3000",
  );
});

test("MCP entrypoint detection survives symlinked launch paths", () => {
  const serverPath = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));
  const serverUrl = new URL("../mcp-server.mjs", import.meta.url).href;
  assert.equal(isMainModule(serverPath, serverUrl), true);
  assert.equal(isMainModule(undefined, serverUrl), false);
  assert.equal(isMainModule("/nonexistent/other.mjs", serverUrl), false);

  const dir = mkdtempSync(join(tmpdir(), "mcp-entry-"));
  try {
    const linkPath = join(dir, "mcp-server.mjs");
    symlinkSync(serverPath, linkPath);
    assert.equal(isMainModule(linkPath, serverUrl), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
