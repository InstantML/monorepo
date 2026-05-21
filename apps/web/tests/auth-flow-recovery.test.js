/**
 * AuthFlow stale-session recovery checks.
 *
 * These are source-level guardrails for the hosted Clerk edge case where the
 * browser still has a Clerk session but InstantML cannot mint its own scoped
 * session from the cached token. Exercising this fully requires a hosted Clerk
 * browser session, so this test locks the recovery contract in place.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFlowPath = path.join(__dirname, "..", "app", "auth-flow.tsx");
const authCssPath = path.join(__dirname, "..", "app", "auth.css");

describe("AuthFlow stale Clerk session recovery", () => {
  test("retries the Clerk exchange with a non-cached token after a 401", () => {
    const src = fs.readFileSync(authFlowPath, "utf8");
    assert.match(src, /getToken\(forceFreshToken \? \{ skipCache: true \} : undefined\)/);
    assert.match(src, /error instanceof ApiError && error\.status === 401/);
    assert.match(src, /payload = await exchangeManagedClerkSession\(true\)/);
  });

  test("renders explicit user instructions and recovery actions", () => {
    const src = fs.readFileSync(authFlowPath, "utf8");
    assert.ok(src.includes("Refresh your sign-in"));
    assert.ok(src.includes("Try a fresh token first. If the message returns, sign out and sign in again."));
    assert.ok(src.includes("Try fresh token"));
    assert.ok(src.includes("Sign out and restart"));
    assert.ok(src.includes("clerk.signOut"));
  });

  test("styles the recovery panel and stacks actions on small screens", () => {
    const css = fs.readFileSync(authCssPath, "utf8");
    assert.match(css, /\.iml-recovery\{/);
    assert.match(css, /\.iml-recovery-actions\{display:grid;grid-template-columns:1fr 1fr/);
    assert.match(css, /@media \(max-width:760px\)[\s\S]*\.iml-recovery-actions\{grid-template-columns:1fr\}/);
  });
});
