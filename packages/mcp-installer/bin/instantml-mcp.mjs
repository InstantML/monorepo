#!/usr/bin/env node

import { spawn } from "node:child_process";

const DEFAULT_URL = "https://mcp.instantml.ai/mcp";
const PLACEHOLDER_KEY = "instantml_...";

function argValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function apiKey(args) {
  return argValue(args, "--api-key") || process.env.INSTANTML_API_KEY || PLACEHOLDER_KEY;
}

function url(args) {
  return argValue(args, "--url") || process.env.INSTANTML_MCP_URL || DEFAULT_URL;
}

function snippets(args) {
  const key = apiKey(args);
  const endpoint = url(args);
  return {
    "claude-code": `claude mcp add --transport http instantml ${endpoint} \\
  --header "Authorization: Bearer ${key}"`,
    codex: `# Put the key in your shell profile or launch environment:
# export INSTANTML_API_KEY=${key}

[mcp_servers.instantml]
url = "${endpoint}"
bearer_token_env_var = "INSTANTML_API_KEY"`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          instantml: {
            transport: "http",
            url: endpoint,
            headers: {
              Authorization: `Bearer ${key}`,
              Accept: "application/json, text/event-stream",
            },
          },
        },
      },
      null,
      2,
    ),
    vscode: JSON.stringify(
      {
        servers: {
          instantml: {
            type: "http",
            url: endpoint,
            headers: {
              Authorization: `Bearer ${key}`,
            },
          },
        },
      },
      null,
      2,
    ),
    local: JSON.stringify(
      {
        mcpServers: {
          instantml: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              endpoint,
              "--header",
              "Authorization:${INSTANTML_MCP_AUTH_HEADER}",
            ],
            env: {
              INSTANTML_MCP_AUTH_HEADER: `Bearer ${key}`,
            },
          },
        },
      },
      null,
      2,
    ),
  };
}

function printHelp() {
  console.log(`InstantML MCP setup helper

Usage:
  instantml-mcp print <claude-code|codex|cursor|vscode|local> [--api-key instantml_...] [--url ${DEFAULT_URL}]
  instantml-mcp bridge [--api-key instantml_...] [--url ${DEFAULT_URL}]

Environment:
  INSTANTML_API_KEY   InstantML API key used for snippets or bridge auth
  INSTANTML_MCP_URL   MCP URL override, defaults to ${DEFAULT_URL}
`);
}

function bridge(args) {
  const key = apiKey(args);
  if (!key || key === PLACEHOLDER_KEY) {
    console.error("ERROR: set INSTANTML_API_KEY or pass --api-key for bridge mode.");
    process.exit(1);
  }
  const child = spawn(
    "npx",
    ["-y", "mcp-remote", url(args), "--header", "Authorization:${INSTANTML_MCP_AUTH_HEADER}"],
    {
      env: { ...process.env, INSTANTML_MCP_AUTH_HEADER: `Bearer ${key}` },
      stdio: "inherit",
    },
  );
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "bridge") {
  bridge(args.slice(1));
} else if (command === "print") {
  const client = args[1] || "claude-code";
  const all = snippets(args.slice(2));
  if (!Object.hasOwn(all, client)) {
    console.error(`ERROR: unknown client "${client}".`);
    printHelp();
    process.exit(1);
  }
  console.log(all[client]);
} else {
  console.error(`ERROR: unknown command "${command}".`);
  printHelp();
  process.exit(1);
}
