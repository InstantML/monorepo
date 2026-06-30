#!/usr/bin/env node
/**
 * InstantML MCP server (v0)
 *
 * A minimal MCP server that wraps the existing Rust API. Used as
 * the agent-substrate primitive for the v3 / agentic-research-substrate
 * decision (see product/wiki/decisions/ship-mcp-server-in-v1.md).
 *
 * Tracker tools (read-only over runs/metrics):
 *   - tracker.list_runs(project?, query?, limit?, cursor?, sort_by?, metric_key?)
 *   - tracker.get_run(run_id)
 *   - tracker.query_metrics(run_id, key, since_step?, until_step?)
 *   - tracker.list_metrics(run_id)
 *   - tracker.get_metric_series_batch(run_ids, key, ...)
 *   - tracker.compare_runs(run_ids, reference_run_id?, diff_only?)
 *   - tracker.export_runs(run_ids?, project?, query?, format?)
 *   - tracker.workspace_view_data(view, run_ids, options?)
 *
 * Report tools (read/write document surface — Notion-style live docs):
 *   - tracker.list_reports(project?, limit?)
 *   - tracker.get_report(report_id, share_token?)
 *   - tracker.create_report(title, description?, blocks, visibility?, project_id?)
 *   - tracker.update_report(report_id, title?, description?, blocks?, visibility?)
 *   - tracker.delete_report(report_id)
 *   - tracker.share_report(report_id) → { share_token, share_url }
 *   - tracker.report_block_schema() → JSON example covering every block type
 *
 * The report tools take a `blocks` array that the agent authors directly. See
 * `tracker.report_block_schema` for the exact shape of every block type
 * (heading / paragraph / markdown / code / callout / horizontal_rule / image
 * / panel_grid). The PanelGrid block accepts four panel kinds
 * (line / bar / scalar / scatter) and runsets that can pin specific run IDs.
 *
 * Usage:
 *   INSTANTML_API_URL=https://api.instantml.ai \
 *   INSTANTML_API_KEY=<scoped-key> \
 *   node tools/mcp-server.mjs
 *
 * Hosted/HTTP usage:
 *   node tools/mcp-server.mjs --transport http --host 0.0.0.0 --port 8080
 *
 * Add to Claude Code's `mcpServers` config to enable agent calls.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { buildTools } from "./mcp-server-tools.mjs";

export const DEFAULT_API_URL = "https://api.instantml.ai";
export const DEFAULT_MCP_PUBLIC_URL = "https://mcp.instantml.ai";
export const DEFAULT_WEB_URL = "https://instantml.ai";
const JSON_CONTENT_TYPE = "application/json";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID",
  // Browser-based MCP clients read the OAuth challenge to start discovery.
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function getArgValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return undefined;
}

function normalizeTransport(value) {
  const normalized = String(value ?? "stdio").toLowerCase();
  if (normalized === "http" || normalized === "streamable-http") return "http";
  return "stdio";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

export function parseCliOptions(argv = process.argv.slice(2), env = process.env) {
  const transport = normalizeTransport(
    getArgValue(argv, "--transport") ?? env.INSTANTML_MCP_TRANSPORT,
  );
  const apiUrl = getArgValue(argv, "--api-url") ?? env.INSTANTML_API_URL ?? DEFAULT_API_URL;
  const webUrl =
    firstNonEmpty(
      getArgValue(argv, "--web-url"),
      env.INSTANTML_WEB_URL,
      env.INSTANTML_FRONTEND_BASE_URL,
    ) ?? DEFAULT_WEB_URL;
  const portValue = getArgValue(argv, "--port") ?? env.INSTANTML_MCP_PORT ?? env.PORT ?? "8080";
  const port = Number.parseInt(portValue, 10);
  const hasCloudRunPort = Boolean(env.PORT);
  return {
    transport,
    apiUrl,
    webUrl,
    apiKey: env.INSTANTML_API_KEY,
    host:
      getArgValue(argv, "--host") ??
      env.INSTANTML_MCP_HOST ??
      (transport === "http" && hasCloudRunPort ? "0.0.0.0" : "127.0.0.1"),
    port: Number.isFinite(port) ? port : 8080,
  };
}

/**
 * OAuth discovery config for the hosted MCP server.
 *
 * Opt-in: returns `null` unless `INSTANTML_MCP_OAUTH_AUTH_SERVER` is set, so the
 * default (API-key bearer) behavior is unchanged. When configured, the server
 * advertises RFC 9728 protected-resource metadata and challenges
 * unauthenticated requests so OAuth-capable clients (Claude Code, Cursor,
 * VS Code) can run the browser sign-in flow against the authorization server.
 *
 * The authorization server (issuer URL) is expected to own client
 * registration, consent, PKCE, and token issuance — InstantML delegates this to
 * its existing identity provider rather than minting tokens here.
 */
export function parseOAuthConfig(env = process.env) {
  const authServer = String(env.INSTANTML_MCP_OAUTH_AUTH_SERVER ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!authServer) return null;
  const publicUrl = String(env.INSTANTML_MCP_PUBLIC_URL ?? DEFAULT_MCP_PUBLIC_URL)
    .trim()
    .replace(/\/+$/, "");
  const resource = String(env.INSTANTML_MCP_OAUTH_RESOURCE ?? `${publicUrl}/mcp`).trim();
  const scopes = String(env.INSTANTML_MCP_OAUTH_SCOPES ?? "export:read reports:write")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    authServer,
    publicUrl,
    resource,
    scopes,
    metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
  };
}

export function protectedResourceMetadata(oauth) {
  return {
    resource: oauth.resource,
    authorization_servers: [oauth.authServer],
    scopes_supported: oauth.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "InstantML",
    resource_documentation: "https://instantml.ai/docs/sdk/agent-mcp",
  };
}

function wwwAuthenticateChallenge(oauth) {
  return [
    "Bearer",
    `resource_metadata="${oauth.metadataUrl}"`,
    'error="invalid_token"',
    'error_description="Sign in with OAuth or provide an InstantML API key."',
  ].join(" ");
}

function isProtectedResourceMetadataPath(path) {
  // Some clients append the resource path segment to the well-known URL.
  return (
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp"
  );
}

function createMcpServer({ apiUrl, apiKey, webUrl }) {
  const tools = buildTools({ apiUrl, apiKey, webUrl });

  const server = new Server(
    { name: "instantml-mcp", version: "0.3.0" },
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

  return server;
}

export function bearerTokenFromHeader(value) {
  if (!value) return null;
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function writeJson(res, statusCode, value, headers = {}) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": JSON_CONTENT_TYPE,
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function writeJsonRpcError(res, statusCode, code, message, headers = {}) {
  writeJson(
    res,
    statusCode,
    {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
    headers,
  );
}

async function startStdio({ apiUrl, apiKey, webUrl }) {
  if (!apiKey) {
    console.error("ERROR: set INSTANTML_API_KEY for stdio MCP mode");
    process.exit(1);
  }
  const server = createMcpServer({ apiUrl, apiKey, webUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`instantml-mcp listening (transport=stdio, api=${apiUrl})`);
}

async function handleHttpMcpRequest(req, res, { apiUrl, webUrl, oauth = null }) {
  if (req.method === "OPTIONS") {
    writeJson(res, 204, {});
    return;
  }
  if (req.url === "/health") {
    writeJson(res, 200, { ok: true, service: "instantml-mcp" });
    return;
  }
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  // RFC 9728 protected-resource metadata — only advertised when OAuth is on.
  if (oauth && isProtectedResourceMetadataPath(path)) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    writeJson(res, 200, protectedResourceMetadata(oauth));
    return;
  }
  if (path !== "/mcp") {
    writeJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    writeJsonRpcError(res, 405, -32000, "Method not allowed.");
    return;
  }

  const apiKey = bearerTokenFromHeader(req.headers.authorization);
  if (!apiKey) {
    // With OAuth enabled, challenge the client so it can discover the
    // authorization server and run browser sign-in. Otherwise keep the
    // original API-key-only response.
    if (oauth) {
      writeJsonRpcError(
        res,
        401,
        -32001,
        "Authentication required: sign in with OAuth or provide an API key.",
        { "WWW-Authenticate": wwwAuthenticateChallenge(oauth) },
      );
      return;
    }
    writeJsonRpcError(res, 401, -32001, "Missing Authorization bearer token.");
    return;
  }

  const server = createMcpServer({ apiUrl, apiKey, webUrl });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    res.setHeader("Access-Control-Allow-Origin", CORS_HEADERS["Access-Control-Allow-Origin"]);
    res.setHeader("Access-Control-Allow-Headers", CORS_HEADERS["Access-Control-Allow-Headers"]);
    await transport.handleRequest(req, res);
    res.on("close", () => {
      transport.close().catch((err) => console.error("MCP HTTP transport close failed:", err));
      server.close().catch((err) => console.error("MCP HTTP server close failed:", err));
    });
  } catch (err) {
    console.error("MCP HTTP request failed:", err);
    if (!res.headersSent) {
      writeJsonRpcError(res, 500, -32603, "Internal server error.");
    }
  }
}

async function startHttp(options) {
  const server = http.createServer((req, res) => {
    handleHttpMcpRequest(req, res, options).catch((err) => {
      console.error("Unhandled MCP HTTP request failure:", err);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, "Internal server error.");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const authMode = options.oauth ? `oauth+api-key (as=${options.oauth.authServer})` : "api-key";
  console.error(
    `instantml-mcp listening (transport=http, host=${options.host}, port=${port}, api=${options.apiUrl}, auth=${authMode})`,
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCliOptions(argv, env);
  if (options.transport === "http") {
    await startHttp({ ...options, oauth: parseOAuthConfig(env) });
    return;
  }
  await startStdio(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
