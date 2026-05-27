#!/usr/bin/env node
/**
 * InstantML MCP server (v0)
 *
 * A minimal MCP server that wraps the existing Rust API. Used as
 * the agent-substrate primitive for the v3 / agentic-research-substrate
 * decision (see product/wiki/decisions/ship-mcp-server-in-v1.md).
 *
 * Tracker tools (read-only over runs/metrics):
 *   - tracker.list_runs(project_id?, query?, limit?)
 *   - tracker.get_run(run_id)
 *   - tracker.query_metrics(run_id, key, since_step?, until_step?)
 *   - tracker.list_metrics(run_id)
 *
 * Report tools (read/write document surface — Notion-style live docs):
 *   - tracker.list_reports(project?, limit?)
 *   - tracker.get_report(report_id, share_token?)
 *   - tracker.create_report(title, description?, blocks, visibility?, project_id?)
 *   - tracker.update_report(report_id, title?, description?, blocks?, visibility?)
 *   - tracker.delete_report(report_id)
 *   - tracker.refresh_llm_summary(report_id, block_index)
 *   - tracker.share_report(report_id) → { share_token, share_url }
 *   - tracker.report_block_schema() → JSON example covering every block type
 *
 * The report tools take a `blocks` array that the agent authors directly. See
 * `tracker.report_block_schema` for the exact shape of every block type
 * (heading / paragraph / markdown / code / callout / horizontal_rule / image
 * / panel_grid / llm_summary). The PanelGrid block accepts four panel kinds
 * (line / bar / scalar / scatter) and runsets that can pin specific run IDs.
 *
 * Usage:
 *   INSTANTML_API_URL=https://<hosted-url> \
 *   INSTANTML_API_KEY=<scoped-key> \
 *   node tools/mcp-server.mjs
 *
 * Add to Claude Code's `mcpServers` config to enable agent calls.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { buildTools } from "./mcp-server-tools.mjs";

const API_URL = process.env.INSTANTML_API_URL;
const API_KEY = process.env.INSTANTML_API_KEY;

if (!API_URL || !API_KEY) {
  console.error(
    "ERROR: set INSTANTML_API_URL and INSTANTML_API_KEY environment variables",
  );
  process.exit(1);
}

const tools = buildTools({ apiUrl: API_URL, apiKey: API_KEY });

const server = new Server(
  { name: "instantml-mcp", version: "0.2.0" },
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
