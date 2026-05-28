import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  clampPercent,
  formatBytes,
  formatRelativeTime,
  statusLabel,
  storageLine,
  toneForStatus,
} from "../src/view-model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminRoot = path.join(__dirname, "..");

test("formatBytes keeps operator storage values readable", () => {
  assert.equal(formatBytes(null), "Unavailable");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(5 * 1024 * 1024 * 1024), "5 GiB");
});

test("formatRelativeTime rounds to useful admin units", () => {
  const now = new Date("2026-05-24T12:00:00Z");
  assert.equal(formatRelativeTime("2026-05-24T11:59:40Z", now), "just now");
  assert.equal(formatRelativeTime("2026-05-24T11:10:00Z", now), "50m ago");
  assert.equal(formatRelativeTime("2026-05-23T06:00:00Z", now), "30h ago");
  assert.equal(formatRelativeTime("2026-05-20T12:00:00Z", now), "4d ago");
});

test("status helpers keep risk and storage language consistent", () => {
  assert.equal(clampPercent(125), 100);
  assert.equal(clampPercent(-10), 0);
  assert.equal(toneForStatus("storage_unconfigured"), "danger");
  assert.equal(toneForStatus("provisioning"), "warn");
  assert.equal(toneForStatus("storage_ready"), "good");
  assert.equal(statusLabel("storage_ready"), "storage ready");
  assert.equal(
    storageLine({
      storage_choice: "instantml-hosted",
      storage_state: "storage_ready",
      route_status: "ready",
    }),
    "instantml-hosted / storage ready / route ready",
  );
});

test("admin API fetch carries request-id instrumentation without logging secrets", () => {
  const source = fs.readFileSync(path.join(adminRoot, "src", "admin-data.ts"), "utf8");

  assert.match(source, /"x-request-id"/);
  assert.match(source, /instantml_admin_api_request/);
  assert(source.includes('path: "/api/admin/overview"'));
  assert.match(source, /lower\.startsWith\("instantml_"\)/);
  assert.match(source, /lower\.startsWith\("sk_test_"\)/);
  assert.match(source, /lower\.startsWith\("whsec_"\)/);
  const eventObject = source.slice(source.indexOf("const event = {"), source.indexOf("if (outcome ==="));
  for (const forbidden of ["token", "url", "apiBase", "email", "body"]) {
    assert.equal(eventObject.includes(forbidden), false);
  }
  for (const line of source.split("\n").filter((line) => line.includes("console."))) {
    assert.equal(line.includes("token"), false);
    assert.equal(line.includes("url"), false);
  }
});
