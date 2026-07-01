import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTools, OAUTH_ORG_HEADER } from "../mcp-server-tools.mjs";

test("MCP tools forward selected OAuth org as an internal API header", async () => {
  const orgId = "11111111-2222-4333-8444-555555555555";
  let captured;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ runs: [], next_cursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const tools = buildTools({
      apiUrl: "https://api.example.test",
      apiKey: "oauth-token",
      orgId,
    });
    const listRuns = tools.find((tool) => tool.name === "tracker.list_runs");
    assert.ok(listRuns, "tracker.list_runs should be registered");

    await listRuns.handler({ limit: 1 });

    assert.equal(captured.url, "https://api.example.test/api/runs/summary?limit=1");
    assert.equal(captured.headers.Authorization, "Bearer oauth-token");
    assert.equal(captured.headers[OAUTH_ORG_HEADER], orgId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP tools omit the selected-org header when no org is scoped", async () => {
  let captured;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = { headers: init.headers };
    return new Response(JSON.stringify({ projects: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const tools = buildTools({
      apiUrl: "https://api.example.test",
      apiKey: "instantml_key",
    });
    const listProjects = tools.find((tool) => tool.name === "tracker.list_projects");
    assert.ok(listProjects, "tracker.list_projects should be registered");

    await listProjects.handler({});

    assert.equal(captured.headers.Authorization, "Bearer instantml_key");
    assert.equal(captured.headers[OAUTH_ORG_HEADER], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
