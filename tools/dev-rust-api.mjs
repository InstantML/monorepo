#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const instantmlDir = path.join(repo, ".instantml");
const apiPort = process.env.INSTANTML_API_PORT || "8000";
const bindAddr = process.env.INSTANTML_BIND_ADDR || `127.0.0.1:${apiPort}`;
let clickhouse = null;
let child = null;
let shuttingDown = false;

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await stopClickHouse();
  process.exit(1);
});

async function main() {
  requireCommand("cargo");

  fs.mkdirSync(instantmlDir, { recursive: true });
  clickhouse = await ensureLocalClickHouse({ repo });

  console.log(`Training Observability Rust API starting on http://${bindAddr}`);
  console.log(`ClickHouse: ${clickhouse.url}${clickhouse.started ? " (started locally)" : ""}`);

  child = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      CLICKHOUSE_URL: clickhouse.url,
      INSTANTML_BIND_ADDR: bindAddr,
      INSTANTML_AUTH_MODE: process.env.INSTANTML_AUTH_MODE || "local",
      INSTANTML_ARTIFACT_ROOT: process.env.INSTANTML_ARTIFACT_ROOT || path.join(instantmlDir, "rust-artifacts"),
    },
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  child.on("close", async (code, signal) => {
    await stopClickHouse();
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null) {
    child.kill(signal);
    return;
  }
  await stopClickHouse();
  process.exit(0);
}

async function stopClickHouse() {
  if (!clickhouse) return;
  const service = clickhouse;
  clickhouse = null;
  await service.stop();
}

function requireCommand(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${command} was not found. Install Rust before running npm run dev:api.`);
    process.exit(1);
  }
}
