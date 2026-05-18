#!/usr/bin/env node
/**
 * InstantML MCP server (v0)
 *
 * A minimal read-only MCP server that wraps the existing Rust API. Used as
 * the agent-substrate primitive for the v3 / agentic-research-substrate
 * decision (see product/wiki/decisions/ship-mcp-server-in-v1.md).
 *
 * Four tools, all thin proxies over existing routes:
 *   - tracker.list_runs(project_id?, query?, limit?)
 *   - tracker.get_run(run_id)
 *   - tracker.query_metrics(run_id, key, since_step?, until_step?)
 *   - tracker.list_metrics(run_id)
 *
 * Usage:
 *   INSTANTML_API_URL=https://<hosted-url> \
 *   INSTANTML_API_KEY=<scoped-key> \
 *   node tools/mcp-server.mjs
 *
 * Add to Claude Code's `mcpServers` config to enable agent calls.
 *
 * Status: v0 / demo scaffold. Future: streaming subscribe tool, action
 * recommender, W&B import proxy. See decision page for the full scope plan.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_URL = process.env.INSTANTML_API_URL;
const API_KEY = process.env.INSTANTML_API_KEY;

if (!API_URL || !API_KEY) {
  console.error(
    "ERROR: set INSTANTML_API_URL and INSTANTML_API_KEY environment variables",
  );
  process.exit(1);
}

async function api(path, params = {}) {
  const url = new URL(path, API_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

const tools = [
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
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      // Reuses the run summary, which includes maintained metric_series summaries.
      const result = await api(`/runs/${encodeURIComponent(args.run_id)}`);
      const metrics = result.summary?.metrics ?? result.metric_series ?? result.metrics ?? [];
      return { content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }] };
    },
  },
];

const server = new Server(
  { name: "instantml-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  try {
    return await tool.handler(request.params.arguments ?? {});
  } catch (err) {
    return {
      content: [{ type: "text", text: `error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`instantml-mcp listening (api=${API_URL})`);
