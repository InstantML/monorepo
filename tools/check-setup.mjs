#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const checks = [];

checkNode();
checkCommand("npm", ["--version"], "npm");
checkPython();
checkRust();
checkCommand("cargo", ["--version"], "Cargo");
checkOptionalCommand("clickhouse", ["--version"], "ClickHouse", "Install the ClickHouse local binary, start ClickHouse yourself, or use Docker Compose before running Rust API/dev smokes.");
checkFile("package-lock.json", "Node lockfile");
checkFile("requirements-dev.txt", "Python dev requirements");
checkDirectory("node_modules", "Node dependencies", "Run `npm ci`.");
checkPythonPackage("pytest", "Python test runner", "Run `python3 -m pip install -r requirements-dev.txt`.");
checkPlaywright();

const failed = checks.filter((check) => check.status === "fail");
const warned = checks.filter((check) => check.status === "warn");

for (const check of checks) {
  const mark = check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "fail";
  console.log(`${mark}: ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
}

if (failed.length) {
  console.error("\nSetup check failed. See SETUP.md for the fresh-clone path.");
  process.exit(1);
}

if (warned.length) {
  console.error("\nSetup check passed with warnings. See SETUP.md if anything behaves oddly.");
} else {
  console.log("\nSetup check passed.");
}

function checkNode() {
  const version = process.versions.node;
  const [major, minor] = version.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 9)) {
    record("fail", "Node.js", `found ${version}; install Node 22 LTS or at least 20.9.0`);
    return;
  }
  if (major !== 22) {
    record("warn", "Node.js", `found ${version}; Node 22 LTS is the documented version`);
    return;
  }
  record("pass", "Node.js", version);
}

function checkPython() {
  const result = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    record("fail", "Python", "python3 was not found");
    return;
  }
  const text = `${result.stdout}${result.stderr}`.trim();
  const match = text.match(/Python (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    record("warn", "Python", `could not parse version: ${text}`);
    return;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 11)) {
    record("fail", "Python", `found ${match[0]}; install Python 3.11`);
    return;
  }
  if (major !== 3 || minor !== 11) {
    record("warn", "Python", `${match[0]}; Python 3.11 is the documented version`);
    return;
  }
  record("pass", "Python", match[0]);
}

function checkRust() {
  const result = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    record("fail", "Rust", "rustc was not found");
    return;
  }
  const text = `${result.stdout}${result.stderr}`.trim();
  const match = text.match(/rustc (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    record("warn", "Rust", `could not parse version: ${text}`);
    return;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 1 || (major === 1 && minor < 83)) {
    record("fail", "Rust", `found ${match[0]}; install Rust 1.83 or newer`);
    return;
  }
  record("pass", "Rust", text);
}

function checkCommand(command, args, name) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    record("fail", name, `${command} was not found`);
    return null;
  }
  const detail = `${result.stdout}${result.stderr}`.trim();
  record("pass", name, detail);
  return detail;
}

function checkOptionalCommand(command, args, name, hint) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    record("warn", name, hint);
    return null;
  }
  const detail = `${result.stdout}${result.stderr}`.trim();
  record("pass", name, detail);
  return detail;
}

function checkFile(filePath, name) {
  record(fs.existsSync(filePath) ? "pass" : "fail", name, filePath);
}

function checkDirectory(dirPath, name, hint) {
  record(fs.existsSync(dirPath) ? "pass" : "warn", name, fs.existsSync(dirPath) ? dirPath : hint);
}

function checkPythonPackage(packageName, name, hint) {
  const result = spawnSync("python3", ["-c", `import ${packageName}`], { encoding: "utf8" });
  record(result.status === 0 ? "pass" : "warn", name, result.status === 0 ? packageName : hint);
}

function checkPlaywright() {
  const result = spawnSync("node", ["-e", "import('playwright').then(async ({ chromium }) => { const browser = await chromium.launch(); await browser.close(); })"], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    record("pass", "Playwright Chromium", "browser launches");
    return;
  }
  record("warn", "Playwright Chromium", "Run `npx playwright install chromium` before `npm run test:ui`.");
}

function record(status, name, detail = "") {
  checks.push({ status, name, detail });
}
