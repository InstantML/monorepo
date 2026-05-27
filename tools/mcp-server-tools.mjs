/**
 * Tool definitions for the InstantML MCP server. Split out from
 * `mcp-server.mjs` so we can import + test these handlers without pulling
 * the `@modelcontextprotocol/sdk` dependency into the test runner.
 *
 * The handlers issue HTTP requests via the global `fetch` constructor; tests
 * inject a stubbed fetch to assert the request shaping. The shipping CLI
 * (mcp-server.mjs) wires these handlers into the stdio transport.
 */

const BLOCK_SCHEMA_HINT =
  " The `blocks` array must match the shape returned by tracker.report_block_schema (heading / paragraph / markdown / code / callout / horizontal_rule / image / panel_grid / llm_summary).";

export const BLOCK_SCHEMA_EXAMPLE = {
  blocks: [
    { kind: "heading", level: 1, text: "Title of the report" },
    { kind: "paragraph", text: "One-line lede explaining what this report covers." },
    { kind: "markdown", text: "## Section\n\nFreeform **markdown** is supported." },
    { kind: "code", language: "python", code: "import instantml as ml\nrun = ml.init(project='demo')" },
    { kind: "callout", variant: "info", text: "Highlighted note — variant ∈ info | warn | success." },
    { kind: "horizontal_rule" },
    { kind: "image", url: "https://example.com/figure.png", caption: "Optional caption" },
    {
      kind: "panel_grid",
      runsets: [
        {
          name: "baseline",
          projects: ["proj-a", "proj-b"],
          pinned_run_ids: ["run-uuid-1", "proj-a/baseline-seed-0"],
          limit: 50,
        },
      ],
      panels: [
        { type: "line", metric_key: "train/loss", runset_index: 0, smoothing: 0 },
        { type: "bar", metric_key: "eval/return_mean", runset_index: 0, group_by: "project" },
        { type: "scalar", metric_key: "eval/return_mean", runset_index: 0, agg: "mean" },
        { type: "scatter", x_metric: "train/loss", y_metric: "eval/return_mean", runset_index: 0 },
      ],
    },
    { kind: "llm_summary", panelgrid_index: 7, angle: "what-worked" },
  ],
  notes: {
    panelgrid_index: "Zero-based index pointing at the panel_grid block this summary should consume.",
    angles: ["what-worked", "outliers", "config-diffs", "next-steps", "free-form"],
    panel_types: ["line", "bar", "scalar", "scatter"],
    scalar_aggs: ["min", "max", "mean", "latest"],
    runset_pinned_ids:
      "Optional list of run IDs (UUID or 'project/run-name' shorthand) to pin to the runset. Unioned with the projects query.",
    visibility: ["private", "org", "public"],
  },
};

function reportFromPayload(payload) {
  return payload?.report ?? payload ?? null;
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * Build the tool registry bound to a specific API URL + API key. Returns a
 * plain array — the MCP transport loop in mcp-server.mjs registers list/call
 * handlers against it.
 */
export function buildTools({ apiUrl, apiKey }) {
  async function api(path, params = {}) {
    const url = new URL(path, apiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
    }
    return res.json();
  }

  async function apiJson(method, path, body = undefined) {
    const url = new URL(path, apiUrl);
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return [
    {
      name: "tracker.list_runs",
      description:
        "List runs in a project. Returns metadata, config, summary, status, tags for each run. Use this to scan a project, find runs by name/tag/config, or build the candidate set for further investigation.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Project ID or slug. If omitted, lists across the user's accessible scope.",
          },
          query: {
            type: "string",
            description: "Free-text search over run name, notes, tags, config keys.",
          },
          limit: { type: "integer", default: 25, maximum: 100 },
        },
      },
      handler: async (args) => {
        const result = await api("/api/runs/summary", {
          project_id: args.project_id,
          q: args.query,
          limit: args.limit ?? 25,
        });
        return textResult(result);
      },
    },
    {
      name: "tracker.get_run",
      description:
        "Fetch full metadata for a single run: name, status, config, tags, notes, summary, start/end time, source info. Use after list_runs identifies an interesting candidate.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "Run ID (uuid) or human-readable name within a project." },
        },
        required: ["run_id"],
      },
      handler: async (args) => {
        const result = await api(`/runs/${encodeURIComponent(args.run_id)}`);
        return textResult(result);
      },
    },
    {
      name: "tracker.query_metrics",
      description:
        "Fetch time-series metric points for a single run and metric key. Returns step+value pairs ordered by step. Use to inspect loss curves, gradient norms, eval scores, system metrics, etc.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          key: { type: "string", description: "Metric name, e.g. 'train/loss', 'train/gradient_norm'." },
          since_step: { type: "integer", description: "Inclusive lower bound on step." },
          until_step: { type: "integer", description: "Inclusive upper bound on step." },
          limit: { type: "integer", default: 1000, maximum: 5000 },
        },
        required: ["run_id", "key"],
      },
      handler: async (args) => {
        const result = await api(`/runs/${encodeURIComponent(args.run_id)}/metrics`, {
          key: args.key,
          since_step: args.since_step,
          until_step: args.until_step,
          limit: args.limit ?? 1000,
        });
        return textResult(result);
      },
    },
    {
      name: "tracker.list_metrics",
      description:
        "List the metric keys logged for a run. Useful for discovering what metrics are available before querying them. Returns a flat list of metric names with their latest/min/max summary values.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
        },
        required: ["run_id"],
      },
      handler: async (args) => {
        const result = await api(`/runs/${encodeURIComponent(args.run_id)}`);
        const metrics = result.summary?.metrics ?? result.metric_series ?? result.metrics ?? [];
        return textResult(metrics);
      },
    },
    {
      name: "tracker.list_reports",
      description:
        "List Notion-style reports in the org. Each entry is a summary (id, title, block_count, visibility, has_share_token, updated_at). Use this to discover existing reports before reading or editing one.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Optional project filter (project ID or slug)." },
          limit: { type: "integer", default: 50, maximum: 200 },
        },
      },
      handler: async (args) => {
        const params = new URLSearchParams();
        if (args.project) params.set("project", String(args.project));
        if (args.limit !== undefined) params.set("limit", String(args.limit));
        const path = params.toString() ? `/api/reports?${params.toString()}` : "/api/reports";
        const result = await apiJson("GET", path);
        return textResult(result);
      },
    },
    {
      name: "tracker.get_report",
      description:
        "Fetch one report by ID, including its ordered `blocks` array. Pass `share_token` to read a report shared via magic link without org membership.",
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string" },
          share_token: {
            type: "string",
            description: "Optional share token returned by tracker.share_report.",
          },
        },
        required: ["report_id"],
      },
      handler: async (args) => {
        if (args.share_token) {
          const result = await apiJson(
            "GET",
            `/api/reports/share/${encodeURIComponent(args.share_token)}`,
          );
          return textResult(result);
        }
        const result = await apiJson(
          "GET",
          `/api/reports/${encodeURIComponent(args.report_id)}`,
        );
        return textResult(result);
      },
    },
    {
      name: "tracker.create_report",
      description:
        "Create a new Notion-style report. `blocks` is an ordered array of block objects." +
        BLOCK_SCHEMA_HINT +
        " Call tracker.report_block_schema first if you need a reference example.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          blocks: {
            type: "array",
            description:
              "Ordered list of block objects. See tracker.report_block_schema for the supported shapes.",
            items: { type: "object" },
          },
          visibility: {
            type: "string",
            enum: ["private", "org", "public"],
            default: "private",
          },
          project_id: {
            type: "string",
            description: "Optional project to scope the report to (UUID or slug).",
          },
        },
        required: ["title", "blocks"],
      },
      handler: async (args) => {
        const body = {
          title: args.title,
          description: args.description ?? null,
          blocks: args.blocks,
          visibility: args.visibility ?? "private",
        };
        if (args.project_id) body.project_id = args.project_id;
        const result = await apiJson("POST", "/api/reports", body);
        return textResult(reportFromPayload(result));
      },
    },
    {
      name: "tracker.update_report",
      description:
        "Patch an existing report. Pass only the fields you want to change; omit `blocks` to leave the document body untouched." +
        BLOCK_SCHEMA_HINT,
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          blocks: { type: "array", items: { type: "object" } },
          visibility: { type: "string", enum: ["private", "org", "public"] },
        },
        required: ["report_id"],
      },
      handler: async (args) => {
        const body = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.description !== undefined) body.description = args.description;
        if (args.blocks !== undefined) body.blocks = args.blocks;
        if (args.visibility !== undefined) body.visibility = args.visibility;
        const result = await apiJson(
          "PATCH",
          `/api/reports/${encodeURIComponent(args.report_id)}`,
          body,
        );
        return textResult(reportFromPayload(result));
      },
    },
    {
      name: "tracker.delete_report",
      description:
        "Delete a report. Returns `{ deleted: true, report_id }` on success.",
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string" },
        },
        required: ["report_id"],
      },
      handler: async (args) => {
        await apiJson(
          "DELETE",
          `/api/reports/${encodeURIComponent(args.report_id)}`,
        );
        return textResult({ deleted: true, report_id: args.report_id });
      },
    },
    {
      name: "tracker.refresh_llm_summary",
      description:
        "Re-run the LLM summary generation for a single `llm_summary` block in a report. `block_index` is the zero-based position of the target block in the report's `blocks` array.",
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string" },
          block_index: { type: "integer", minimum: 0 },
        },
        required: ["report_id", "block_index"],
      },
      handler: async (args) => {
        const result = await apiJson(
          "POST",
          `/api/reports/${encodeURIComponent(args.report_id)}/blocks/${args.block_index}/refresh`,
          {},
        );
        return textResult(reportFromPayload(result));
      },
    },
    {
      name: "tracker.share_report",
      description:
        "Generate or rotate a share token for a report. Returns `{ share_token, share_url }`. The share URL is suitable for sending to teammates outside the org; the report's `visibility` does not change.",
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string" },
        },
        required: ["report_id"],
      },
      handler: async (args) => {
        const result = await apiJson(
          "POST",
          `/api/reports/${encodeURIComponent(args.report_id)}/share`,
          {},
        );
        const report = reportFromPayload(result);
        const token = report?.share_token ?? null;
        const base = (apiUrl || "").replace(/\/+$/, "");
        return textResult({
          share_token: token,
          share_url: token ? `${base}/r/${token}` : null,
          report,
        });
      },
    },
    {
      name: "tracker.report_block_schema",
      description:
        "Return a single JSON example demonstrating every supported block kind with all fields populated. Use this as the canonical reference when authoring `blocks` for tracker.create_report / tracker.update_report.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => textResult(BLOCK_SCHEMA_EXAMPLE),
    },
  ];
}
