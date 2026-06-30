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
  " The `blocks` array must match the shape returned by tracker.report_block_schema (heading / paragraph / markdown / code / callout / horizontal_rule / image / panel_grid).";
const DEFAULT_WEB_URL = "https://instantml.ai";

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
        {
          type: "parallel_coordinates",
          runset_index: 0,
          dimensions: [{ config_key: "lr" }, { metric_key: "eval/return_mean" }],
        },
        {
          type: "run_comparer",
          runset_index: 0,
          run_ids: ["run-uuid-1"],
          fields: ["config.lr", "summary.val_acc"],
        },
        { type: "markdown_panel", text: "## Notes\nFreeform commentary alongside the charts." },
        { type: "code_panel", code: "import instantml as ml", language: "python" },
        { type: "image_panel", url: "https://example.com/fig.png", caption: "Optional caption" },
      ],
    },
  ],
  notes: {
    panel_types: [
      "line",
      "bar",
      "scalar",
      "scatter",
      "parallel_coordinates",
      "run_comparer",
      "markdown_panel",
      "code_panel",
      "image_panel",
    ],
    scalar_aggs: ["min", "max", "mean", "latest"],
    runset_pinned_ids:
      "Optional list of run IDs (UUID or 'project/run-name' shorthand) to pin to the runset. Unioned with the projects query.",
    runset_run_settings:
      "Optional map keyed by run id: { color?: string, disabled?: bool, hidden?: bool }. Power the run-set table widget.",
    visibility: ["private", "org", "public"],
  },
};

function reportFromPayload(payload) {
  return payload?.report ?? payload ?? null;
}

function baseUrl(value, fallback = DEFAULT_WEB_URL) {
  const raw = typeof value === "string" && value.trim() ? value : fallback;
  return raw.replace(/\/+$/, "");
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

function compactParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

function commaList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined && item !== null && item !== "").join(",");
  }
  return value;
}

function metricSummariesFromRunPayload(result) {
  const run = result?.run ?? result ?? {};
  const keys = Array.isArray(run.metric_keys) ? run.metric_keys : [];
  const latest = run.latest_metrics ?? {};
  const aggregates = run.metric_aggregates ?? {};
  return keys.map((key) => ({
    key,
    latest: latest[key] ?? null,
    ...(aggregates[key] ?? {}),
  }));
}

/**
 * Build the tool registry bound to a specific API URL + API key. Returns a
 * plain array — the MCP transport loop in mcp-server.mjs registers list/call
 * handlers against it.
 */
export function buildTools({ apiUrl, apiKey, webUrl = DEFAULT_WEB_URL }) {
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

  async function apiText(path, params = {}) {
    const url = new URL(path, apiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/csv, application/json" },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${text.slice(0, 500)}`);
    }
    return text;
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
        "List runs. Returns metadata, config, metric summaries, status, tags, and pagination info. Use this to scan a project, search by tag/name/config/notes, sort by a metric, or build a candidate set for deeper investigation.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project name/slug. Prefer this for Rust-hosted summaries.",
          },
          project_id: {
            type: "string",
            description: "Legacy project slug/name alias. Project UUID filtering is only enforced by project-scoped API keys.",
          },
          query: {
            type: "string",
            description: "Run search query. Supports bare terms, tag:/status:/name:/notes:/config: fields, booleans, grouping, and explicit re:/.../ regex on Rust.",
          },
          status: { type: "string", description: "Optional run status filter." },
          sort_by: {
            type: "string",
            enum: ["created", "name", "status", "duration", "metric-latest", "metric-best"],
            default: "created",
          },
          metric_key: { type: "string", description: "Metric used by metric-latest or metric-best sorting." },
          cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
          limit: { type: "integer", default: 25, maximum: 1000 },
        },
      },
      handler: async (args) => {
        const result = await api("/api/runs/summary", compactParams({
          project: args.project ?? args.project_id,
          q: args.query,
          status: args.status,
          sort_by: args.sort_by,
          metric_key: args.metric_key,
          cursor: args.cursor,
          limit: args.limit ?? 25,
        }));
        return textResult(result);
      },
    },
    {
      name: "tracker.get_run",
      description:
        "Fetch full metadata for a single run UUID: name, status, config, tags, notes, metric summaries, start/end time, and source info. Use after list_runs identifies an interesting candidate.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "Run UUID." },
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
          start_step: { type: "number", description: "Inclusive lower bound on step." },
          end_step: { type: "number", description: "Inclusive upper bound on step." },
          since_step: { type: "integer", description: "Inclusive lower bound on step." },
          until_step: { type: "integer", description: "Inclusive upper bound on step." },
          limit: { type: "integer", default: 1000, maximum: 5000 },
        },
        required: ["run_id", "key"],
      },
      handler: async (args) => {
        const result = await api(`/runs/${encodeURIComponent(args.run_id)}/metrics`, compactParams({
          key: args.key,
          start_step: args.start_step ?? args.since_step,
          end_step: args.end_step ?? args.until_step,
          limit: args.limit ?? 1000,
        }));
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
        return textResult(metricSummariesFromRunPayload(result));
      },
    },
    {
      name: "tracker.get_metric_series_batch",
      description:
        "Fetch bounded metric series for many runs and one metric key using the batched Rust endpoint. Use after list_runs selects candidates. The server caps run IDs and returned points.",
      inputSchema: {
        type: "object",
        properties: {
          run_ids: { type: "array", items: { type: "string" }, description: "Run UUIDs, max 2,000." },
          key: { type: "string", description: "Metric key to fetch." },
          limit: { type: "integer", default: 1000, maximum: 5000 },
          start_step: { type: "number" },
          end_step: { type: "number" },
          buckets: { type: "integer", description: "Optional M4 downsampling bucket count for full-series reads." },
        },
        required: ["run_ids", "key"],
      },
      handler: async (args) => {
        const result = await apiJson("POST", "/api/metrics/series", compactParams({
          key: args.key,
          run_ids: args.run_ids ?? [],
          limit: args.limit ?? 1000,
          start_step: args.start_step,
          end_step: args.end_step,
          buckets: args.buckets,
        }));
        return textResult(result);
      },
    },
    {
      name: "tracker.compare_runs",
      description:
        "Compare selected runs side by side. Returns rows for config, metadata, tags, attributes, and metric summary differences. Use after list_runs narrows to at most 50 run IDs.",
      inputSchema: {
        type: "object",
        properties: {
          run_ids: { type: "array", items: { type: "string" }, description: "Run UUIDs, max 50." },
          reference_run_id: { type: "string", description: "Optional run UUID to use as the comparison reference." },
          diff_only: { type: "boolean", default: false },
        },
        required: ["run_ids"],
      },
      handler: async (args) => {
        const result = await api("/api/runs/side-by-side", compactParams({
          run_ids: commaList(args.run_ids),
          reference_run_id: args.reference_run_id,
          diff_only: args.diff_only,
        }));
        return textResult(result);
      },
    },
    {
      name: "tracker.export_runs",
      description:
        "Export selected or filtered runs as bounded JSON or CSV. JSON includes runs, metric points, metric-series summaries, attributes, artifacts, and imports within server caps.",
      inputSchema: {
        type: "object",
        properties: {
          run_ids: { type: "array", items: { type: "string" }, description: "Optional exact run UUIDs, max 100 for selected export." },
          project: { type: "string" },
          query: { type: "string", description: "Same run search query as tracker.list_runs." },
          status: { type: "string" },
          sort_by: { type: "string", enum: ["created", "name", "status", "duration", "metric-latest", "metric-best"] },
          metric_key: { type: "string" },
          format: { type: "string", enum: ["json", "csv"], default: "json" },
        },
      },
      handler: async (args) => {
        const params = compactParams({
          run_ids: commaList(args.run_ids),
          project: args.project,
          q: args.query,
          status: args.status,
          sort_by: args.sort_by,
          metric_key: args.metric_key,
          format: args.format,
        });
        if (args.format === "csv") {
          return textResult(await apiText("/api/export", params));
        }
        return textResult(await api("/api/export", params));
      },
    },
    {
      name: "tracker.workspace_view_data",
      description:
        "Resolve a portable workspace view plus explicit run IDs into bounded run summaries, panel summaries, and line-panel metric series. Use when an agent needs exactly the data a saved dashboard view would render.",
      inputSchema: {
        type: "object",
        properties: {
          view: { type: "object", description: "Portable view export, workspace-view row-like object, or saved view payload." },
          run_ids: { type: "array", items: { type: "string" }, description: "Run UUIDs, max 100." },
          options: {
            type: "object",
            properties: {
              metric_point_limit: { type: "integer", default: 500, maximum: 500 },
              max_panels: { type: "integer", default: 20, maximum: 50 },
            },
          },
        },
        required: ["view", "run_ids"],
      },
      handler: async (args) => {
        const result = await apiJson("POST", "/api/workspace-view-data", {
          view: args.view,
          run_ids: args.run_ids ?? [],
          options: args.options ?? undefined,
        });
        return textResult(result);
      },
    },
    {
      name: "tracker.list_reports",
      description:
        "List block-based reports in the org. Each entry is a summary (id, title, block_count, visibility, has_share_token, updated_at). Use this to discover existing reports before reading or editing one.",
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
        "Create a new block-based report. `blocks` is an ordered array of block objects." +
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
        const webBase = baseUrl(webUrl);
        return textResult({
          share_token: token,
          share_url: token ? `${webBase}/r/${token}` : null,
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
    {
      name: "tracker.list_org_panels",
      description:
        "Return every panel spec defined inside every PanelGrid across the caller's org. Use to find a panel to clone into a new report. Each entry is `{ report_id, report_title, panel_index, panel_spec }`.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const payload = await api("/api/reports/panels");
        return textResult({ panels: payload?.panels ?? [] });
      },
    },
    {
      name: "tracker.add_panel_to_report",
      description:
        "Append a panel to an existing PanelGrid block inside a report. `panel_grid_block_index` is the zero-based index of the target `panel_grid` block in the report's `blocks` array. `panel_spec` must match a supported panel shape (see tracker.report_block_schema). Returns the updated report.",
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string" },
          panel_grid_block_index: { type: "integer", minimum: 0 },
          panel_spec: { type: "object" },
        },
        required: ["report_id", "panel_grid_block_index", "panel_spec"],
      },
      handler: async (args) => {
        const reportPayload = await api(
          `/api/reports/${encodeURIComponent(args.report_id)}`,
        );
        const report = reportFromPayload(reportPayload);
        if (!report) {
          throw new Error(`report ${args.report_id} not found`);
        }
        const blocks = Array.isArray(report.blocks) ? [...report.blocks] : [];
        const target = blocks[args.panel_grid_block_index];
        if (!target || target.kind !== "panel_grid") {
          throw new Error(
            `block at index ${args.panel_grid_block_index} is not a panel_grid block`,
          );
        }
        const nextPanels = Array.isArray(target.panels) ? [...target.panels] : [];
        nextPanels.push(args.panel_spec);
        blocks[args.panel_grid_block_index] = { ...target, panels: nextPanels };
        const updated = await apiJson(
          "PATCH",
          `/api/reports/${encodeURIComponent(args.report_id)}`,
          { blocks },
        );
        return textResult(reportFromPayload(updated));
      },
    },
  ];
}
