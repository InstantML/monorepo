import assert from "node:assert/strict";
import test from "node:test";

import { BLOCK_SCHEMA_EXAMPLE, buildTools } from "../../../tools/mcp-server-tools.mjs";

/**
 * Smoke tests for the report tools exposed by the MCP server. We stub
 * `fetch` with a route table so the tool handlers exercise their real
 * request shaping logic without hitting a network. The tool factory
 * (`buildTools`) is the same one the stdio server wires into its
 * transport — we test it directly to avoid pulling in the MCP SDK
 * dependency.
 */

const API_URL = "https://example.test";
const API_KEY = "test-key";

const originalFetch = globalThis.fetch;

function installFetchStub(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      throw new Error(`No fetch stub for ${key} (url=${url.toString()})`);
    }
    let body;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url: url.toString(), pathname: url.pathname, body });
    const value = typeof handler === "function" ? handler({ body, url }) : handler;
    return {
      ok: true,
      status: value === undefined ? 204 : 200,
      async json() {
        return value ?? null;
      },
      async text() {
        return JSON.stringify(value ?? "");
      },
    };
  };
  return calls;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function findTool(name, tools) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `MCP server should expose ${name}`);
  return tool;
}

function parseTextResult(result) {
  assert.ok(result?.content?.length, "tool result has content");
  const body = result.content[0]?.text;
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

test("MCP server exposes the report tool surface", () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const names = tools.map((tool) => tool.name).sort();
  for (const expected of [
    "tracker.list_reports",
    "tracker.get_report",
    "tracker.create_report",
    "tracker.update_report",
    "tracker.delete_report",
    "tracker.refresh_llm_summary",
    "tracker.share_report",
    "tracker.report_block_schema",
    "tracker.list_org_panels",
    "tracker.add_panel_to_report",
  ]) {
    assert.ok(
      names.includes(expected),
      `expected ${expected} in MCP tool surface (got ${names.join(", ")})`,
    );
  }
});

test("tracker.list_org_panels returns the panel inventory envelope", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /api/reports/panels": {
      panels: [
        {
          report_id: "rep-1",
          report_title: "First",
          panel_index: 0,
          panel_spec: { type: "line", metric_key: "loss", runset_index: 0 },
        },
        {
          report_id: "rep-2",
          report_title: "Second",
          panel_index: 3,
          panel_spec: { type: "markdown_panel", text: "notes" },
        },
      ],
    },
  });
  try {
    const tool = findTool("tracker.list_org_panels", tools);
    const payload = parseTextResult(await tool.handler({}));
    assert.equal(payload.panels.length, 2);
    assert.equal(payload.panels[0].panel_spec.type, "line");
    assert.equal(payload.panels[1].panel_spec.type, "markdown_panel");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/api/reports/panels");
  } finally {
    restoreFetch();
  }
});

test("tracker.add_panel_to_report appends a panel to the named panel_grid block", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const initialReport = {
    id: "rep-42",
    blocks: [
      { kind: "paragraph", text: "Intro" },
      {
        kind: "panel_grid",
        runsets: [{ name: "rs", projects: ["proj-a"] }],
        panels: [{ type: "line", metric_key: "loss", runset_index: 0 }],
      },
    ],
  };
  const calls = installFetchStub({
    "GET /api/reports/rep-42": { report: initialReport },
    "PATCH /api/reports/rep-42": ({ body }) => ({
      report: { ...initialReport, blocks: body.blocks },
    }),
  });
  try {
    const tool = findTool("tracker.add_panel_to_report", tools);
    const updated = parseTextResult(
      await tool.handler({
        report_id: "rep-42",
        panel_grid_block_index: 1,
        panel_spec: { type: "scalar", metric_key: "loss", runset_index: 0, agg: "mean" },
      }),
    );
    const targetGrid = updated.blocks[1];
    assert.equal(targetGrid.panels.length, 2);
    assert.equal(targetGrid.panels[1].type, "scalar");
    // Verify only PATCH'd the report once after a GET to read existing blocks.
    assert.equal(calls.filter((call) => call.method === "GET").length, 1);
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  } finally {
    restoreFetch();
  }
});

test("tracker.add_panel_to_report rejects a non-panel_grid block_index", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  installFetchStub({
    "GET /api/reports/rep-7": {
      report: {
        id: "rep-7",
        blocks: [{ kind: "paragraph", text: "Hi" }],
      },
    },
  });
  try {
    const tool = findTool("tracker.add_panel_to_report", tools);
    await assert.rejects(
      tool.handler({
        report_id: "rep-7",
        panel_grid_block_index: 0,
        panel_spec: { type: "line", metric_key: "loss", runset_index: 0 },
      }),
      /not a panel_grid block/,
    );
  } finally {
    restoreFetch();
  }
});

test("tracker.report_block_schema returns a JSON example covering every block kind", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const tool = findTool("tracker.report_block_schema", tools);
  const payload = parseTextResult(await tool.handler({}));
  // Sanity-check the exported constant matches the tool output.
  assert.equal(payload.blocks.length, BLOCK_SCHEMA_EXAMPLE.blocks.length);
  const kinds = payload.blocks.map((block) => block.kind);
  for (const kind of [
    "heading",
    "paragraph",
    "markdown",
    "code",
    "callout",
    "horizontal_rule",
    "image",
    "panel_grid",
    "llm_summary",
  ]) {
    assert.ok(kinds.includes(kind), `schema example missing block kind ${kind}`);
  }
  const panelGrid = payload.blocks.find((block) => block.kind === "panel_grid");
  const panelTypes = panelGrid.panels.map((panel) => panel.type).sort();
  // v1.2 added 5 more panel types beyond the original {line, bar, scalar,
  // scatter}. The schema example must cover them so agents discover the
  // expanded vocabulary.
  for (const expected of [
    "bar",
    "code_panel",
    "image_panel",
    "line",
    "markdown_panel",
    "parallel_coordinates",
    "run_comparer",
    "scalar",
    "scatter",
  ]) {
    assert.ok(panelTypes.includes(expected), `schema example missing panel type ${expected}`);
  }
  // Verify the runset documents pinned_run_ids so agents discover it.
  assert.ok(Array.isArray(panelGrid.runsets[0].pinned_run_ids));
});

test("tracker.create_report posts /api/reports with the supplied blocks", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "POST /api/reports": ({ body }) => ({
      report: {
        id: "rep-123",
        title: body.title,
        blocks: body.blocks,
        visibility: body.visibility,
      },
    }),
  });
  try {
    const tool = findTool("tracker.create_report", tools);
    const created = parseTextResult(
      await tool.handler({
        title: "Pilot recap",
        blocks: [
          { kind: "heading", level: 1, text: "Pilot recap" },
          { kind: "paragraph", text: "Body." },
        ],
        visibility: "org",
      }),
    );
    assert.equal(created.id, "rep-123");
    assert.equal(created.title, "Pilot recap");
    assert.equal(created.visibility, "org");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].pathname, "/api/reports");
    assert.equal(calls[0].body.blocks.length, 2);
    assert.equal(calls[0].body.blocks[0].kind, "heading");
  } finally {
    restoreFetch();
  }
});

test("tracker.refresh_llm_summary posts to the per-block refresh endpoint", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "POST /api/reports/rep-7/blocks/4/refresh": () => ({
      report: { id: "rep-7", blocks: [{ kind: "llm_summary", panelgrid_index: 0, angle: "what-worked", generated_text: "ok" }] },
    }),
  });
  try {
    const tool = findTool("tracker.refresh_llm_summary", tools);
    const payload = parseTextResult(
      await tool.handler({ report_id: "rep-7", block_index: 4 }),
    );
    assert.equal(payload.id, "rep-7");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/api/reports/rep-7/blocks/4/refresh");
  } finally {
    restoreFetch();
  }
});

test("tracker.share_report surfaces the share token and a derived share URL", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  installFetchStub({
    "POST /api/reports/rep-9/share": () => ({
      report: { id: "rep-9", share_token: "share-abc" },
    }),
  });
  try {
    const tool = findTool("tracker.share_report", tools);
    const payload = parseTextResult(await tool.handler({ report_id: "rep-9" }));
    assert.equal(payload.share_token, "share-abc");
    assert.ok(
      payload.share_url && payload.share_url.endsWith("/r/share-abc"),
      `share URL should end with /r/<token> (got ${payload.share_url})`,
    );
  } finally {
    restoreFetch();
  }
});
