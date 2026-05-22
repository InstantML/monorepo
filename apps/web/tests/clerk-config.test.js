import assert from "node:assert/strict";
import test from "node:test";

import { clerkIssuerConfigError, clerkIssuerFromPublishableKey, clerkIssuerMismatchMessage } from "../src/clerk-config.js";

test("Clerk config derives an issuer from a publishable key", () => {
  assert.equal(
    clerkIssuerFromPublishableKey(clerkPublishableKey("modern-mustang-72.clerk.accounts.dev")),
    "https://modern-mustang-72.clerk.accounts.dev",
  );
});

test("Clerk config reports frontend/backend issuer mismatches", () => {
  assert.equal(
    clerkIssuerMismatchMessage(
      clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
      "https://modern-mustang-72.clerk.accounts.dev",
    ),
    "",
  );

  assert.match(
    clerkIssuerMismatchMessage(
      clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
      "https://other-clerk-instance.clerk.accounts.dev",
    ),
    /authentication settings do not match/,
  );
});

test("Clerk config treats missing backend issuer as unavailable", () => {
  const error = clerkIssuerConfigError(clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"), null);

  assert.match(error.message, /temporarily unavailable/);
  assert.match(error.diagnostic, /clerk_jwt_issuer/);
});

function clerkPublishableKey(host) {
  const encoded = Buffer.from(`${host}$`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `pk_test_${encoded}`;
}
