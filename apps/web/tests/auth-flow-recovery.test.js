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
const signInPagePath = path.join(__dirname, "..", "app", "signin", "page.tsx");

describe("AuthFlow stale Clerk session recovery", () => {
  test("redirects valid InstantML sessions from signin before rendering AuthFlow", () => {
    const src = fs.readFileSync(signInPagePath, "utf8");
    assert.match(src, /import \{ headers \} from "next\/headers"/);
    assert.match(src, /import \{ redirect \} from "next\/navigation"/);
    assert.match(src, /serverAuthSession\(\(await headers\(\)\)\.get\("cookie"\) \?\? ""\)/);
    assert.match(src, /if \(session\?\.authenticated\) \{[\s\S]*redirect\(postAuthRedirectPath\(session, nextPath\)\)/);
    assert.match(src, /return <AuthFlow mode="signin" \/>/);
  });

  test("keeps only known signed-in users on the app loading shell while the workspace opens", () => {
    const src = fs.readFileSync(authFlowPath, "utf8");
    assert.match(src, /import \{ AppLoadingScreen \} from "\.\/loading-screen"/);
    assert.match(src, /const signinSessionResolving =/);
    assert.match(src, /mode === "signin"[\s\S]*&& managedClerkReady[\s\S]*&& Boolean\(isSignedIn\)/);
    assert.doesNotMatch(src, /!authReady \|\| \(managedClerkReady && Boolean\(isSignedIn\)\)/);
    assert.match(src, /if \(signinSessionResolving\) \{[\s\S]*return <AppLoadingScreen detail=\{authReady \? "Opening workspace" : "Checking session"\} \/>/);
  });

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
