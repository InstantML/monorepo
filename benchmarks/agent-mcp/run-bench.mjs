#!/usr/bin/env node
// Agent-task benchmark runner: drives headless `claude -p` against one MCP server
// per invocation and records a stream-json transcript per task for grade.mjs.
//
// Usage: node run-bench.mjs <instantml|wandb> [taskId]
// Env:
//   INSTANTML_API_BASE     data-plane base URL (default http://127.0.0.1:8077)
//   INSTANTML_API_KEY      instantml_* key with export:read (instantml side)
//   INSTANTML_MCP_SERVER   path to tools/mcp-server.mjs (default: repo copy; its
//                          directory must resolve @modelcontextprotocol/sdk)
//   WANDB_API_KEY          W&B API key (wandb side, hosted server)
//   BENCH_MODEL            agent model (default claude-sonnet-5)
//   TRIAL                  trial number; >1 suffixes output files with .t<N>
//   RERUN=1                overwrite existing transcripts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const side = process.argv[2];
const onlyTask = process.argv[3];
if (!["instantml", "wandb"].includes(side)) {
  console.error("usage: node run-bench.mjs <instantml|wandb> [taskId]");
  process.exit(1);
}

const { tasks } = JSON.parse(readFileSync(join(DIR, "tasks.json"), "utf8"));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`set ${name} for the ${side} side`);
    process.exit(1);
  }
  return value;
}

function mcpConfig() {
  if (side === "instantml") {
    return {
      mcpServers: {
        instantml: {
          command: "node",
          args: [process.env.INSTANTML_MCP_SERVER ?? join(DIR, "..", "..", "tools", "mcp-server.mjs")],
          env: {
            INSTANTML_API_URL: process.env.INSTANTML_API_BASE ?? "http://127.0.0.1:8077",
            INSTANTML_API_KEY: requireEnv("INSTANTML_API_KEY"),
          },
        },
      },
    };
  }
  return {
    mcpServers: {
      wandb: {
        type: "http",
        url: "https://mcp.withwandb.com/mcp",
        headers: { Authorization: `Bearer ${requireEnv("WANDB_API_KEY")}` },
      },
    },
  };
}

const cfgPath = join(DIR, `mcp-${side}.json`);
writeFileSync(cfgPath, JSON.stringify(mcpConfig(), null, 2));
const outDir = join(DIR, "runs");
mkdirSync(outDir, { recursive: true });

const trial = process.env.TRIAL || "1";
const suffix = trial === "1" ? "" : `.t${trial}`;

for (const task of tasks) {
  if (onlyTask && task.id !== onlyTask) continue;
  const outFile = join(outDir, `${side}-${task.id}${suffix}.jsonl`);
  if (existsSync(outFile) && !process.env.RERUN) {
    console.log(`skip ${task.id} (exists)`);
    continue;
  }
  const started = Date.now();
  const res = spawnSync(
    "claude",
    [
      "-p", task.prompt,
      "--mcp-config", cfgPath,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      "--model", process.env.BENCH_MODEL ?? "claude-sonnet-5",
      "--max-turns", "30",
      "--output-format", "stream-json",
      "--verbose",
    ],
    { encoding: "utf8", timeout: 420_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const wall = Date.now() - started;
  writeFileSync(outFile, res.stdout || "");
  if (res.status !== 0) {
    writeFileSync(join(outDir, `${side}-${task.id}${suffix}.err`), `${res.status}\n${res.stderr || ""}`);
  }
  writeFileSync(
    join(outDir, `${side}-${task.id}${suffix}.meta.json`),
    JSON.stringify({ side, task: task.id, trial, wall_ms: wall, exit: res.status }, null, 2),
  );
  console.log(`${side}/${task.id}: exit=${res.status} wall=${(wall / 1000).toFixed(1)}s`);
}
console.log("done");
