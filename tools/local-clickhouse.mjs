import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export async function ensureLocalClickHouse(options = {}) {
  const repo = options.repo || process.cwd();
  const url = options.url || process.env.CLICKHOUSE_URL || "http://default:@127.0.0.1:8123/instantml";
  const parsed = new URL(url);

  if (await clickhouseReady(url)) {
    return { url, started: false, stop: async () => {} };
  }

  if (!canStartLocal(parsed)) {
    throw new Error(
      `ClickHouse is not reachable at ${redactedUrl(url)}. Start that service, or unset CLICKHOUSE_URL to let the local helper start a loopback ClickHouse instance.`,
    );
  }

  requireCommand("clickhouse");

  const httpPort = parsed.port || "8123";
  const dataDir = path.resolve(options.dataDir || process.env.INSTANTML_DEV_CHDATA || path.join(repo, ".instantml", "clickhouse"));
  const logDir = path.resolve(options.logDir || process.env.INSTANTML_DEV_CH_LOG_DIR || path.join(repo, ".instantml", "clickhouse-logs"));
  const tcpPort = String(options.tcpPort || process.env.INSTANTML_DEV_CH_TCP_PORT || await freePort());
  const interserverHttpPort = String(options.interserverHttpPort || process.env.INSTANTML_DEV_CH_INTERSERVER_PORT || await freePort());
  const mysqlPort = String(options.mysqlPort || process.env.INSTANTML_DEV_CH_MYSQL_PORT || await freePort());

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  for (const dir of ["tmp", "user_files", "format_schemas", "access"]) {
    fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  }

  const output = fs.openSync(path.join(logDir, "server.stdout.log"), "a");
  const child = spawn("clickhouse", [
    "server",
    "--",
    `--path=${dataDir}`,
    `--tmp_path=${path.join(dataDir, "tmp")}`,
    `--user_files_path=${path.join(dataDir, "user_files")}`,
    `--format_schema_path=${path.join(dataDir, "format_schemas")}`,
    `--access_control_path=${path.join(dataDir, "access")}`,
    `--http_port=${httpPort}`,
    `--tcp_port=${tcpPort}`,
    `--interserver_http_port=${interserverHttpPort}`,
    `--mysql_port=${mysqlPort}`,
    "--listen_host=127.0.0.1",
    `--logger.log=${path.join(logDir, "server.log")}`,
    `--logger.errorlog=${path.join(logDir, "error.log")}`,
  ], {
    cwd: dataDir,
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);

  try {
    await waitForClickHouse(url, child, path.join(logDir, "error.log"));
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    url,
    started: true,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export async function clickhouseReady(url) {
  return httpOk(clickhousePingUrl(url));
}

export async function clickhousePost(url, query, body = "") {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\/+/, "");
  parsed.pathname = "/";
  if (database) parsed.searchParams.set("database", database);
  parsed.searchParams.set("query", query);
  return httpPost(parsed, body);
}

function clickhousePingUrl(url) {
  const parsed = new URL(url);
  parsed.pathname = "/ping";
  parsed.search = "";
  return parsed;
}

function canStartLocal(parsed) {
  if (parsed.protocol !== "http:") return false;
  if (!["", "default"].includes(decodeURIComponent(parsed.username))) return false;
  if (parsed.password) return false;
  return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
}

async function waitForClickHouse(url, child, errorLogPath) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const log = fs.existsSync(errorLogPath) ? fs.readFileSync(errorLogPath, "utf8") : "";
      throw new Error(`ClickHouse exited before it was ready.\n${log}`);
    }
    if (await clickhouseReady(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const log = fs.existsSync(errorLogPath) ? fs.readFileSync(errorLogPath, "utf8") : "";
  throw new Error(`Timed out waiting for ClickHouse at ${redactedUrl(url)}.\n${log}`);
}

function httpOk(url) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const request = client.get({
      auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      protocol: url.protocol,
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function httpPost(url, body) {
  const client = url.protocol === "https:" ? https : http;
  const payload = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = client.request({
      auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
      headers: {
        "content-length": payload.byteLength,
        "content-type": "text/plain; charset=utf-8",
      },
      hostname: url.hostname,
      method: "POST",
      path: `${url.pathname}${url.search}`,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      protocol: url.protocol,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(text);
          return;
        }
        reject(new Error(`ClickHouse query failed with ${response.statusCode}: ${text}`));
      });
    });
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function requireCommand(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} was not found. Install ClickHouse locally or run the Docker stack before starting the Rust API.`);
  }
}

function redactedUrl(url) {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "REDACTED";
  return parsed.toString();
}
