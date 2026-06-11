import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ADMIN_ALLOWED_EMAILS,
  DEFAULT_CLERK_DOMAIN,
  adminAllowedEmailLabel,
  adminClerkDomain,
  canLoadClerkForRequest,
  hostnameFromRequest,
  isAdminEmailAllowed,
  isInstantMlHost,
  parseAdminAllowedEmails,
} from "../src/admin-auth.mjs";
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

test("admin allowlist defaults to the temporary InstantML operator email", () => {
  assert.deepEqual(DEFAULT_ADMIN_ALLOWED_EMAILS, ["instantml.ai@gmail.com"]);
  assert.deepEqual(parseAdminAllowedEmails(undefined), ["instantml.ai@gmail.com"]);
  assert.deepEqual(parseAdminAllowedEmails(" instantml.ai@gmail.com,INSTANTML.AI@gmail.com "), [
    "instantml.ai@gmail.com",
  ]);
  assert.equal(isAdminEmailAllowed("INSTANTML.AI@gmail.com", ["instantml.ai@gmail.com"]), true);
  assert.equal(isAdminEmailAllowed("support@instantml.ai", ["instantml.ai@gmail.com"]), false);
  assert.equal(adminAllowedEmailLabel(["instantml.ai@gmail.com"]), "instantml.ai@gmail.com");
  assert.equal(adminAllowedEmailLabel(["a@example.com", "b@example.com"]), "2 configured emails");
});

test("admin Clerk domain defaults to the InstantML production root domain", () => {
  assert.equal(DEFAULT_CLERK_DOMAIN, "instantml.ai");
  assert.equal(adminClerkDomain(""), "instantml.ai");
  assert.equal(adminClerkDomain("instantml.ai"), "instantml.ai");
  assert.equal(adminClerkDomain("https://clerk.instantml.ai/v1/client"), "instantml.ai");
});

test("admin Clerk loading blocks production keys on local HTTP", () => {
  assert.equal(hostnameFromRequest("admin.instantml.ai:3001"), "admin.instantml.ai");
  assert.equal(isInstantMlHost("admin.instantml.ai"), true);
  assert.equal(isInstantMlHost("localhost"), false);
  assert.equal(canLoadClerkForRequest("pk_test_example", "localhost:3001", "http"), true);
  assert.equal(canLoadClerkForRequest("pk_live_example", "localhost:3001", "http"), false);
  assert.equal(canLoadClerkForRequest("pk_live_example", "admin.instantml.ai", "http"), false);
  assert.equal(canLoadClerkForRequest("pk_live_example", "admin.instantml.ai", "https"), true);
});

test("admin page requires Clerk allowlist before fetching overview", () => {
  const source = fs.readFileSync(path.join(adminRoot, "app", "page.tsx"), "utf8");
  assert.match(source, /currentUser/);
  assert.match(source, /isAdminEmailAllowed/);
  assert.match(source, /CLERK_SECRET_KEY/);
  assert.match(source, /if \(!canLoadClerkForRequest/);
  assert.match(source, /https:\/\/admin\.instantml\.ai/);
  assert(source.indexOf("isAdminEmailAllowed") < source.indexOf("fetchAdminOverview"));
  assert(source.indexOf("if (!canLoadClerkForRequest") < source.indexOf("viewer = await loadAdminViewer"));
  assert(source.includes("instantml.ai@gmail.com") === false);
});

test("admin CSP allows the production Clerk custom domain", () => {
  const source = fs.readFileSync(path.join(adminRoot, "next.config.mjs"), "utf8");
  assert.match(source, /https:\/\/clerk\.instantml\.ai/);
  assert.match(source, /script-src/);
  assert.match(source, /frame-src/);
  assert.match(source, /connect-src/);
  assert.match(source, /worker-src 'self' blob:/);
});

test("admin Clerk config uses the production custom domain instead of the proxy", () => {
  const layoutSource = fs.readFileSync(path.join(adminRoot, "app", "layout.tsx"), "utf8");
  const proxySource = fs.readFileSync(path.join(adminRoot, "proxy.ts"), "utf8");

  assert.match(layoutSource, /domain={clerkDomain}/);
  assert.match(proxySource, /domain:\s*adminClerkDomain\(\)/);
  assert.doesNotMatch(layoutSource, /proxyUrl/);
  assert.doesNotMatch(proxySource, /frontendApiProxy/);
  assert.doesNotMatch(proxySource, /\/__clerk\/\(\.\*\)/);
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
