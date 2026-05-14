import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ensureLocalClickHouse } from "./local-clickhouse.mjs";

const mode = process.argv[2] || "contract";
if (!new Set(["contract", "sdk", "ui"]).has(mode)) {
  console.error("Usage: node tools/rust-service-smoke.mjs [contract|sdk|ui]");
  process.exit(2);
}

const repo = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `rlobs-rust-${mode}-`));
const pgPort = await freePort();
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
let server = null;
let clickhouse = null;

try {
  const clickhouseUrl = `http://default:@127.0.0.1:${clickhouseHttpPort}/rlobs`;
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: clickhouseUrl,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  const dataDir = path.join(tempDir, "data");
  run("initdb", ["-D", dataDir, "--auth=trust"], { stdio: ["ignore", "ignore", "inherit"] });
  run("pg_ctl", [
    "-D",
    dataDir,
    "-o",
    `-p ${pgPort} -c listen_addresses='127.0.0.1'`,
    "-l",
    path.join(tempDir, "postgres.log"),
    "start",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  run("createdb", ["-h", "127.0.0.1", "-p", String(pgPort), "rlobs_smoke"]);

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const databaseUrl = `postgres://127.0.0.1:${pgPort}/rlobs_smoke`;
  const authMode = mode === "contract" ? "api-key" : "local";
  const bootstrapToken = "rust-smoke-bootstrap";
  const serverLog = path.join(tempDir, "server.log");
  const output = fs.openSync(serverLog, "w");
  server = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CLICKHOUSE_URL: clickhouse.url,
      RLOBS_BIND_ADDR: `127.0.0.1:${apiPort}`,
      RLOBS_AUTH_MODE: authMode,
      RLOBS_BOOTSTRAP_TOKEN: bootstrapToken,
      RLOBS_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
    },
    stdio: ["ignore", output, output],
  });
  await waitForHttp(`${baseUrl}/readyz`, server, serverLog);

  if (mode === "contract") {
    run("node", ["tools/contract-smoke.mjs"], {
      env: {
        ...process.env,
        RLOBS_CONTRACT_BASE_URL: baseUrl,
        RLOBS_CONTRACT_BOOTSTRAP_TOKEN: bootstrapToken,
      },
    });
  } else if (mode === "sdk") {
    run("python3", ["tools/rust-sdk-smoke.py"], {
      env: {
        ...process.env,
        RLOBS_RUST_SMOKE_BASE_URL: baseUrl,
      },
    });
  } else {
    run("node", ["apps/web/tests/ui-smoke.mjs"], {
      env: {
        ...process.env,
        RLOBS_UI_SMOKE_API_BASE: baseUrl,
      },
    });
  }
} finally {
  if (server) {
    server.kill();
    await onceClose(server);
  }
  if (clickhouse) await clickhouse.stop();
  run("pg_ctl", ["-D", path.join(tempDir, "data"), "stop", "-m", "fast"], { allowFailure: true, stdio: ["ignore", "ignore", "ignore"] });
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: options.stdio || "inherit",
    env: options.env || process.env,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, logPath) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    if (child.exitCode !== null) {
      throw new Error(`Rust server exited early. Log:\n${fs.readFileSync(logPath, "utf8")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Log:\n${fs.readFileSync(logPath, "utf8")}`);
}

function onceClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
