#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repo = process.cwd();
const rlobsDir = path.join(repo, ".rlobs");
const dataDir = path.resolve(process.env.RLOBS_DEV_PGDATA || path.join(rlobsDir, "postgres"));
const logPath = path.resolve(process.env.RLOBS_DEV_PG_LOG || path.join(rlobsDir, "postgres.log"));
const pgPort = process.env.RLOBS_DEV_PG_PORT || "54329";
const dbName = process.env.RLOBS_DEV_DB || "rlobs";
const apiPort = process.env.RLOBS_API_PORT || "8000";
const bindAddr = process.env.RLOBS_BIND_ADDR || `127.0.0.1:${apiPort}`;
const databaseUrl = process.env.DATABASE_URL || `postgres://127.0.0.1:${pgPort}/${dbName}`;
let startedPostgres = false;
let child = null;
let shuttingDown = false;

main();

function main() {
  requireCommand("initdb");
  requireCommand("pg_ctl");
  requireCommand("createdb");
  requireCommand("psql");
  requireCommand("cargo");

  fs.mkdirSync(rlobsDir, { recursive: true });
  ensurePostgres();
  ensureDatabase();

  console.log(`Training Observability Rust API starting on http://${bindAddr}`);
  console.log(`Postgres: ${databaseUrl}`);

  child = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      RLOBS_BIND_ADDR: bindAddr,
      RLOBS_AUTH_MODE: process.env.RLOBS_AUTH_MODE || "local",
      RLOBS_ARTIFACT_ROOT: process.env.RLOBS_ARTIFACT_ROOT || path.join(rlobsDir, "rust-artifacts"),
    },
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  child.on("close", (code, signal) => {
    stopPostgres();
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });
}

function ensurePostgres() {
  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    run("initdb", ["-D", dataDir, "--auth=trust"], { stdio: "inherit" });
  }
  const status = spawnSync("pg_ctl", ["-D", dataDir, "status"], { encoding: "utf8" });
  if (status.status === 0) return;
  run("pg_ctl", [
    "-D",
    dataDir,
    "-o",
    `-p ${pgPort} -c listen_addresses='127.0.0.1'`,
    "-l",
    logPath,
    "start",
  ], { stdio: "inherit" });
  startedPostgres = true;
}

function ensureDatabase() {
  const exists = spawnSync("psql", [
    "-h",
    "127.0.0.1",
    "-p",
    pgPort,
    "-d",
    "postgres",
    "-Atc",
    `SELECT 1 FROM pg_database WHERE datname = '${dbName.replaceAll("'", "''")}'`,
  ], { encoding: "utf8" });
  if (exists.status === 0 && exists.stdout.trim() === "1") return;
  run("createdb", ["-h", "127.0.0.1", "-p", pgPort, dbName], { stdio: "inherit" });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null) {
    child.kill(signal);
    return;
  }
  stopPostgres();
  process.exit(0);
}

function stopPostgres() {
  if (!startedPostgres) return;
  startedPostgres = false;
  spawnSync("pg_ctl", ["-D", dataDir, "stop", "-m", "fast"], { stdio: "ignore" });
}

function requireCommand(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${command} was not found. Install Rust and local Postgres tools before running npm run dev:api.`);
    process.exit(1);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: options.stdio || "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}
