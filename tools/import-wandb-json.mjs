#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const filePath = args[0];

if (!filePath || args.includes("--help")) {
  usage(0);
}

const options = parseOptions(args.slice(1));
const payload = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
const body = {
  ...payload,
  project: options.project,
  runs: payload.runs,
  dry_run: options.dryRun,
};
const endpoint = `${options.baseUrl.replace(/\/$/, "")}/api/imports/wandb${options.dryRun ? "?dry_run=true" : ""}`;
const headers = { "Content-Type": "application/json" };
if (process.env.RLOBS_API_KEY) headers.Authorization = `Bearer ${process.env.RLOBS_API_KEY}`;
const response = await fetch(endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
const decoded = await response.json();
if (!response.ok) {
  console.error(decoded.error ?? "import failed");
  process.exit(1);
}
console.log(JSON.stringify(decoded, null, 2));

function parseOptions(values) {
  const options = { baseUrl: "http://127.0.0.1:8000", project: null, dryRun: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--base-url") options.baseUrl = requiredValue(values, ++index, "--base-url");
    else if (value === "--project") options.project = requiredValue(values, ++index, "--project");
    else if (value === "--dry-run") options.dryRun = true;
    else usage(1, `unknown option: ${value}`);
  }
  if (!options.project) usage(1, "--project is required");
  return options;
}

function requiredValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) usage(1, `${flag} requires a value`);
  return value;
}

function usage(code, message = "") {
  if (message) console.error(message);
  console.error("Usage: node tools/import-wandb-json.mjs <export.json> --project <name> [--base-url http://127.0.0.1:8000] [--dry-run]");
  process.exit(code);
}
