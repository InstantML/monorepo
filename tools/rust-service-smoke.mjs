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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `instantml-rust-${mode}-`));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
let server = null;
let clickhouse = null;

try {
  const clickhouseUrl = `http://default:@127.0.0.1:${clickhouseHttpPort}/instantml`;
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: clickhouseUrl,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const authMode = mode === "contract" ? "api-key" : "local";
  const bootstrapToken = "rust-smoke-bootstrap";
  const serverLog = path.join(tempDir, "server.log");
  const output = fs.openSync(serverLog, "w");
  server = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: clickhouse.url,
      INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
      INSTANTML_AUTH_MODE: authMode,
      INSTANTML_BOOTSTRAP_TOKEN: bootstrapToken,
      INSTANTML_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
    },
    stdio: ["ignore", output, output],
  });
  await waitForHttp(`${baseUrl}/readyz`, server, serverLog);

  if (mode === "contract") {
    run("node", ["tools/contract-smoke.mjs"], {
      env: {
        ...process.env,
        INSTANTML_CONTRACT_BASE_URL: baseUrl,
        INSTANTML_CONTRACT_BOOTSTRAP_TOKEN: bootstrapToken,
      },
    });
  } else if (mode === "sdk") {
    run("python3", ["tools/rust-sdk-smoke.py"], {
      env: {
        ...process.env,
        INSTANTML_RUST_SMOKE_BASE_URL: baseUrl,
      },
    });
  } else {
    run("node", ["apps/web/tests/ui-smoke.mjs"], {
      env: {
        ...process.env,
        INSTANTML_UI_SMOKE_API_BASE: baseUrl,
      },
    });
  }
} finally {
  if (server) {
    server.kill();
    await onceClose(server);
  }
  if (clickhouse) await clickhouse.stop();
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
