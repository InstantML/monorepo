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
    "tracker.list_projects",
    "tracker.list_runs",
    "tracker.compare_matching_runs",
    "tracker.get_run",
    "tracker.query_metrics",
    "tracker.list_metrics",
    "tracker.get_metric_series_batch",
    "tracker.compare_runs",
    "tracker.get_run_lineage",
    "tracker.list_run_artifacts",
    "tracker.list_run_artifact_edges",
    "tracker.list_artifact_collections",
    "tracker.get_artifact_version",
    "tracker.list_artifact_versions",
    "tracker.resolve_artifact_version",
    "tracker.list_artifact_manifest",
    "tracker.get_artifact_lineage",
    "tracker.export_runs",
    "tracker.workspace_view_data",
    "tracker.list_reports",
    "tracker.get_report",
    "tracker.create_report",
    "tracker.update_report",
    "tracker.delete_report",
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

test("tracker.list_projects calls the Rust projects endpoint", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /projects": {
      projects: [
        { id: "project-1", name: "cartpole" },
        { id: "project-2", name: "iris" },
      ],
    },
  });
  try {
    const tool = findTool("tracker.list_projects", tools);
    const payload = parseTextResult(await tool.handler({}));
    assert.equal(payload.projects.length, 2);
    assert.equal(payload.projects[0].name, "cartpole");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].pathname, "/projects");
  } finally {
    restoreFetch();
  }
});

test("tracker.list_runs maps project aliases and search options to Rust summary params", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /api/runs/summary": {
      runs: [{ id: "run-1", name: "candidate" }],
      metric_keys: ["eval/return_mean"],
      total: 1,
    },
  });
  try {
    const tool = findTool("tracker.list_runs", tools);
    const payload = parseTextResult(
      await tool.handler({
        project_id: "cartpole",
        query: 'tag:baseline status:finished',
        sort_by: "metric-best",
        metric_key: "eval/return_mean",
        cursor: "offset:25",
        limit: 25,
      }),
    );
    assert.equal(payload.total, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("project"), "cartpole");
    assert.equal(url.searchParams.get("project_id"), null);
    assert.equal(url.searchParams.get("q"), "tag:baseline status:finished");
    assert.equal(url.searchParams.get("sort_by"), "metric-best");
    assert.equal(url.searchParams.get("metric_key"), "eval/return_mean");
    assert.equal(url.searchParams.get("cursor"), "offset:25");
    assert.equal(url.searchParams.get("limit"), "25");
  } finally {
    restoreFetch();
  }
});

test("tracker.compare_matching_runs posts filtered comparison body", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "POST /api/runs/compare-query": ({ body }) => ({
      total_matching_runs: 5,
      selected_run_ids: ["run-1", "run-2"],
      candidates: [
        { run_id: "run-1", rank: 1, selection_reason: "selected" },
        { run_id: "run-2", rank: 2, selection_reason: "reference" },
      ],
      rows: [{ path: "config/lr", different: true }],
      truncated: { runs: true, rows: false },
      echoed: body,
    }),
  });
  try {
    const tool = findTool("tracker.compare_matching_runs", tools);
    const payload = parseTextResult(
      await tool.handler({
        project_id: "cartpole",
        query: "tag:baseline status:finished",
        display_status: "finished",
        sort_by: "metric-best",
        metric_key: "eval/return_mean",
        limit: 2,
        reference_run_id: "run-2",
        diff_only: true,
        include_rows: false,
      }),
    );
    assert.equal(payload.total_matching_runs, 5);
    assert.equal(payload.rows[0].path, "config/lr");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      project: "cartpole",
      q: "tag:baseline status:finished",
      display_status: "finished",
      sort_by: "metric-best",
      metric_key: "eval/return_mean",
      limit: 2,
      reference_run_id: "run-2",
      diff_only: true,
      include_rows: false,
    });
  } finally {
    restoreFetch();
  }
});

test("tracker.query_metrics sends Rust step-window parameter names", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /runs/run-1/metrics": {
      metrics: [{ key: "loss", step: 10, value: 0.5 }],
    },
  });
  try {
    const tool = findTool("tracker.query_metrics", tools);
    const payload = parseTextResult(
      await tool.handler({
        run_id: "run-1",
        key: "loss",
        since_step: 10,
        until_step: 20,
        limit: 250,
      }),
    );
    assert.equal(payload.metrics[0].step, 10);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("key"), "loss");
    assert.equal(url.searchParams.get("start_step"), "10");
    assert.equal(url.searchParams.get("end_step"), "20");
    assert.equal(url.searchParams.get("since_step"), null);
    assert.equal(url.searchParams.get("until_step"), null);
  } finally {
    restoreFetch();
  }
});

test("tracker.list_metrics extracts metric summaries from the run envelope", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  installFetchStub({
    "GET /runs/run-1": {
      run: {
        id: "run-1",
        metric_keys: ["loss", "eval/return_mean"],
        latest_metrics: { loss: 0.4, "eval/return_mean": 1.2 },
        metric_aggregates: {
          loss: { min: 0.3, max: 2.0, mean: 0.8 },
          "eval/return_mean": { min: 0.1, max: 1.4, mean: 0.9 },
        },
      },
    },
  });
  try {
    const tool = findTool("tracker.list_metrics", tools);
    const metrics = parseTextResult(await tool.handler({ run_id: "run-1" }));
    assert.deepEqual(metrics, [
      { key: "loss", latest: 0.4, min: 0.3, max: 2, mean: 0.8 },
      { key: "eval/return_mean", latest: 1.2, min: 0.1, max: 1.4, mean: 0.9 },
    ]);
  } finally {
    restoreFetch();
  }
});

test("tracker.get_metric_series_batch posts the batched series body", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "POST /api/metrics/series": ({ body }) => ({
      series: body.run_ids.map((run_id) => ({ run_id, metrics: [] })),
    }),
  });
  try {
    const tool = findTool("tracker.get_metric_series_batch", tools);
    const payload = parseTextResult(
      await tool.handler({
        run_ids: ["run-1", "run-2"],
        key: "loss",
        limit: 500,
        start_step: 5,
        end_step: 15,
        buckets: 256,
      }),
    );
    assert.equal(payload.series.length, 2);
    assert.deepEqual(calls[0].body, {
      key: "loss",
      run_ids: ["run-1", "run-2"],
      limit: 500,
      start_step: 5,
      end_step: 15,
      buckets: 256,
    });
  } finally {
    restoreFetch();
  }
});

test("tracker.compare_runs calls the side-by-side endpoint", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /api/runs/side-by-side": {
      runs: [{ id: "run-1" }, { id: "run-2" }],
      rows: [{ path: "config/lr", different: true }],
    },
  });
  try {
    const tool = findTool("tracker.compare_runs", tools);
    const payload = parseTextResult(
      await tool.handler({
        run_ids: ["run-1", "run-2"],
        reference_run_id: "run-1",
        diff_only: true,
      }),
    );
    assert.equal(payload.rows[0].path, "config/lr");
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("run_ids"), "run-1,run-2");
    assert.equal(url.searchParams.get("reference_run_id"), "run-1");
    assert.equal(url.searchParams.get("diff_only"), "true");
  } finally {
    restoreFetch();
  }
});

test("artifact and lineage tools call read-only Rust endpoints", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /api/runs/run-1/lineage": { run_id: "run-1", parents: [], children: [] },
    "GET /api/runs/run-1/artifacts": { artifacts: [{ id: "artifact-1" }] },
    "GET /api/runs/run-1/artifact-edges": { edges: [{ direction: "output" }] },
    "GET /api/artifact-collections": { collections: [{ id: "collection-1" }] },
    "GET /api/artifact-versions/version-1": { artifact_version: { id: "version-1" } },
    "GET /api/artifact-collections/collection-1/versions": {
      versions: [{ id: "version-1" }],
    },
    "GET /api/artifact-versions/resolve": { artifact_version: { id: "version-1" } },
    "GET /api/artifact-versions/version-1/manifest": {
      entries: [{ path: "model.bin" }],
    },
    "GET /api/artifact-versions/version-1/lineage": { nodes: [], edges: [] },
  });
  try {
    assert.equal(
      parseTextResult(await findTool("tracker.get_run_lineage", tools).handler({ run_id: "run-1" }))
        .run_id,
      "run-1",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.list_run_artifacts", tools).handler({
          run_id: "run-1",
          limit: 25,
        }),
      ).artifacts[0].id,
      "artifact-1",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.list_run_artifact_edges", tools).handler({
          run_id: "run-1",
          direction: "output",
          limit: 10,
        }),
      ).edges[0].direction,
      "output",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.list_artifact_collections", tools).handler({
          project: "cartpole",
          kind: "checkpoint",
          query: "policy",
          limit: 5,
          offset: 10,
        }),
      ).collections[0].id,
      "collection-1",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.get_artifact_version", tools).handler({
          version_id: "version-1",
        }),
      ).artifact_version.id,
      "version-1",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.list_artifact_versions", tools).handler({
          collection_id: "collection-1",
          limit: 3,
          offset: 1,
        }),
      ).versions[0].id,
      "version-1",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.resolve_artifact_version", tools).handler({
          ref: "policy:latest",
          type: "checkpoint",
          project: "cartpole",
        }),
      ).artifact_version.id,
      "version-1",
    );
    assert.equal(
      parseTextResult(
        await findTool("tracker.list_artifact_manifest", tools).handler({
          version_id: "version-1",
          path_prefix: "models/",
          limit: 20,
          offset: 2,
        }),
      ).entries[0].path,
      "model.bin",
    );
    assert.deepEqual(
      parseTextResult(
        await findTool("tracker.get_artifact_lineage", tools).handler({
          version_id: "version-1",
          limit: 30,
        }),
      ).edges,
      [],
    );

    const byPath = Object.fromEntries(calls.map((call) => [call.pathname, new URL(call.url)]));
    assert.equal(byPath["/api/runs/run-1/artifacts"].searchParams.get("limit"), "25");
    assert.equal(byPath["/api/runs/run-1/artifact-edges"].searchParams.get("direction"), "output");
    assert.equal(byPath["/api/runs/run-1/artifact-edges"].searchParams.get("limit"), "10");
    assert.equal(byPath["/api/artifact-collections"].searchParams.get("type"), "checkpoint");
    assert.equal(byPath["/api/artifact-collections"].searchParams.get("q"), "policy");
    assert.equal(byPath["/api/artifact-collections"].searchParams.get("offset"), "10");
    assert.equal(
      byPath["/api/artifact-collections/collection-1/versions"].searchParams.get("limit"),
      "3",
    );
    assert.equal(byPath["/api/artifact-versions/resolve"].searchParams.get("ref"), "policy:latest");
    assert.equal(
      byPath["/api/artifact-versions/version-1/manifest"].searchParams.get("path_prefix"),
      "models/",
    );
    assert.equal(byPath["/api/artifact-versions/version-1/lineage"].searchParams.get("limit"), "30");
  } finally {
    restoreFetch();
  }
});

test("tracker.export_runs supports selected JSON and CSV exports", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "GET /api/export": ({ url }) => {
      if (url.searchParams.get("format") === "csv") {
        return "record_type,run_id\nrun,run-1\n";
      }
      return { runs: [{ id: "run-1" }], truncated: false };
    },
  });
  try {
    const tool = findTool("tracker.export_runs", tools);
    const jsonPayload = parseTextResult(
      await tool.handler({ run_ids: ["run-1"], format: "json" }),
    );
    const csvPayload = parseTextResult(
      await tool.handler({ run_ids: ["run-1"], format: "csv" }),
    );
    assert.equal(jsonPayload.runs[0].id, "run-1");
    assert.match(csvPayload, /record_type,run_id/);
    assert.equal(new URL(calls[0].url).searchParams.get("run_ids"), "run-1");
    assert.equal(new URL(calls[1].url).searchParams.get("format"), "csv");
  } finally {
    restoreFetch();
  }
});

test("tracker.workspace_view_data posts view plus explicit run IDs", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  const calls = installFetchStub({
    "POST /api/workspace-view-data": ({ body }) => ({
      view_data: {
        schema_version: 1,
        run_ids: body.run_ids,
        panels: [],
        warnings: [],
      },
    }),
  });
  try {
    const tool = findTool("tracker.workspace_view_data", tools);
    const payload = parseTextResult(
      await tool.handler({
        view: { metricKey: "loss" },
        run_ids: ["run-1"],
        options: { metric_point_limit: 200, max_panels: 5 },
      }),
    );
    assert.deepEqual(payload.view_data.run_ids, ["run-1"]);
    assert.deepEqual(calls[0].body, {
      view: { metricKey: "loss" },
      run_ids: ["run-1"],
      options: { metric_point_limit: 200, max_panels: 5 },
    });
  } finally {
    restoreFetch();
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

test("tracker.share_report surfaces the share token and a derived share URL", async () => {
  const tools = buildTools({
    apiUrl: API_URL,
    apiKey: API_KEY,
    webUrl: "https://staging.instantml.ai/",
  });
  installFetchStub({
    "POST /api/reports/rep-9/share": () => ({
      report: { id: "rep-9", share_token: "share-abc" },
    }),
  });
  try {
    const tool = findTool("tracker.share_report", tools);
    const payload = parseTextResult(await tool.handler({ report_id: "rep-9" }));
    assert.equal(payload.share_token, "share-abc");
    assert.equal(payload.share_url, "https://staging.instantml.ai/r/share-abc");
  } finally {
    restoreFetch();
  }
});

test("tracker.share_report uses the hosted web URL by default", async () => {
  const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });
  installFetchStub({
    "POST /api/reports/rep-10/share": () => ({
      report: { id: "rep-10", share_token: "share-default" },
    }),
  });
  try {
    const tool = findTool("tracker.share_report", tools);
    const payload = parseTextResult(await tool.handler({ report_id: "rep-10" }));
    assert.equal(payload.share_url, "https://instantml.ai/r/share-default");
  } finally {
    restoreFetch();
  }
});
