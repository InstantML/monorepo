#!/usr/bin/env node
// Seed the benchmark dataset into a local InstantML backend and mint an MCP API key.
// Usage: node seed-instantml.mjs [apiBase]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const API = process.argv[2] || "http://127.0.0.1:8077";
const ORIGIN = "http://localhost:3000";
const EMAIL = "bench@instantml.dev";

const dataset = JSON.parse(readFileSync(join(DIR, "dataset.json"), "utf8"));

let cookie = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, extraHeaders = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = setCookie.match(/instantml_session=[^;]+/);
      if (m) cookie = m[0];
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return json;
  }
  throw new Error(`${method} ${path}: rate-limited after retries`);
}

function findKey(obj, pred, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (pred(k, v)) return v;
    const nested = findKey(v, pred, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// 1) Dev sign-in
const auth = await call("POST", "/api/auth/dev/google", {
  email: EMAIL,
  display_name: "Bench User",
});
if (!cookie) throw new Error("no session cookie from dev sign-in");
console.log("signed in as", EMAIL);

// 2) Resolve org id
let orgId = findKey(auth, (k, v) => /^(org_id|organization_id)$/.test(k) && typeof v === "string");
if (!orgId) {
  const session = await call("GET", "/api/auth/session");
  orgId = findKey(session, (k, v) => /^(org_id|organization_id)$/.test(k) && typeof v === "string");
  if (!orgId) {
    const orgObj = findKey(session, (k, v) => k === "org" && v && typeof v === "object");
    orgId = orgObj?.id;
  }
}
if (!orgId) throw new Error("could not resolve org id; auth payload: " + JSON.stringify(auth).slice(0, 500));
console.log("org:", orgId);

// 3) Mint MCP API key (read + ingest so the same key also works for report writes if scoped)
const keyRes = await call("POST", `/api/orgs/${orgId}/api-keys`, {
  name: "mcp-bench",
  scopes: ["export:read", "sdk:ingest"],
});
const apiKey = findKey(keyRes, (k, v) => typeof v === "string" && v.startsWith("instantml_"));
if (!apiKey) throw new Error("no api key in response: " + JSON.stringify(keyRes).slice(0, 500));
writeFileSync(join(DIR, "instantml-key.txt"), apiKey + "\n");
console.log("api key saved to instantml-key.txt");

// 4) Projects
for (const name of dataset.projects) {
  await call("POST", "/projects", { name, description: "MCP benchmark project" }).catch((e) => {
    if (!String(e).includes("already")) throw e;
  });
  await sleep(600);
}

// 5) Runs + metrics (paced for free-tier ingest limit of 2 rps)
for (const [i, run] of dataset.runs.entries()) {
  const created = await call("POST", "/runs", {
    project: run.project,
    name: run.name,
    config: run.config,
    tags: run.tags,
  });
  const runId = findKey(created, (k, v) => k === "id" && typeof v === "string");
  if (!runId) throw new Error("no run id: " + JSON.stringify(created).slice(0, 300));
  await sleep(600);

  // merge series into per-step points
  const byStep = new Map();
  for (const [metric, points] of Object.entries(run.series || {})) {
    for (const [step, value] of points) {
      if (!byStep.has(step)) byStep.set(step, {});
      byStep.get(step)[metric] = value;
    }
  }
  const points = [...byStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, metrics]) => ({ step, metrics }));
  for (let off = 0; off < points.length; off += 60) {
    await call("POST", `/runs/${runId}/metrics/batch`, { points: points.slice(off, off + 60) });
    await sleep(600);
  }

  await call("PATCH", `/runs/${runId}`, { status: run.status, notes: run.notes });
  await sleep(600);
  console.log(`[${i + 1}/${dataset.runs.length}] ${run.name} (${run.status}, ${points.length} pts)`);
}
console.log("seed complete");
