import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Structural tests for the /auth/device page.
// We verify static properties of the source file: key UI strings, Clerk auth
// guard, API call shape, and state machine completeness. Full interactive tests
// are in the smoke suite (apps/web/tests/ui-smoke.mjs) which requires a live
// Next.js server. These tests run in CI without a running server.

const root = fileURLToPath(new URL("../", import.meta.url));
const src = readFileSync(`${root}app/auth/device/page.tsx`, "utf8");

test("device page includes the confirmation form", () => {
  assert.ok(src.includes('<form'), "must render a <form> element");
  assert.ok(src.includes("Confirm device"), "must have a 'Confirm device' button label");
  assert.ok(src.includes("user_code"), "must send user_code to the API");
});

test("device page calls the correct API endpoint", () => {
  assert.ok(
    src.includes("/api/auth/device-code/confirm"),
    "must POST to /api/auth/device-code/confirm"
  );
});

test("device page requires a Clerk session via useAuth", () => {
  assert.ok(src.includes("useAuth"), "must import and use useAuth from @clerk/nextjs");
  assert.ok(src.includes("isSignedIn"), "must check isSignedIn before showing the form");
  assert.ok(src.includes("unauthenticated"), "must handle the unauthenticated state");
});

test("device page handles success state with close-tab message", () => {
  assert.ok(src.includes("close this tab"), "must tell the user they can close the tab on success");
  assert.ok(src.includes("success"), "must have a success state");
});

test("device page handles error state with accessible alert", () => {
  assert.ok(src.includes('role="alert"'), 'error message must have role="alert" for accessibility');
  assert.ok(src.includes("error"), "must display error messages");
});

test("device page pre-fills user_code from ?code= query param", () => {
  assert.ok(
    src.includes('params?.get("code")') || src.includes('params.get("code")'),
    "must read ?code= from search params to pre-fill the input"
  );
  assert.ok(src.includes("useSearchParams"), "must use useSearchParams hook");
});

test("device page formats user code input with auto-hyphen", () => {
  // The input auto-inserts a hyphen after 4 chars for UX.
  assert.ok(src.includes("function formatDeviceCodeInput"), "typed input should keep the XXXX-XXXX editing affordance");
  assert.ok(src.includes("normalizeDeviceUserCode"), "prefill, submit, and redirect paths should share strict device-code validation");
  assert.ok(
    src.includes("setUserCode(formattedPrefill)"),
    "prefilled codes should be sanitized before rendering",
  );
  assert.ok(
    src.includes("ABCD-EFGH") || src.includes("placeholder"),
    "must show placeholder with XXXX-XXXX format"
  );
  assert.ok(src.includes("maxLength={9}") || src.includes("maxLength="), "must cap input at 9 chars (XXXX-XXXX)");
});

test("device page sanitizes sign-in return path", () => {
  assert.match(src, /const nextCode = normalizeDeviceUserCode/, "sign-in next path should use the same strict code normalizer");
  assert.doesNotMatch(src, /encodeURIComponent\("\/auth\/device" \+ \(params\?\.get\("code"\)/, "sign-in next path should not embed the raw code query");
});

test("device page wraps with Suspense for useSearchParams", () => {
  assert.ok(src.includes("Suspense"), "must wrap with <Suspense> because useSearchParams needs it");
});
