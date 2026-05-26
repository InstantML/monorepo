import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const invitePagePath = path.join(__dirname, "..", "app", "invite", "page.tsx");

test("accepted managed Clerk invite retries still render account actions", () => {
  const src = fs.readFileSync(invitePagePath, "utf8");

  assert.ok(src.includes('invite.status === "accepted" && managedClerkEnabled'));
  assert.ok(src.includes('preview?.status === "accepted" && managedClerkAvailable'));
  assert.ok(src.includes("{canUseInviteActions ? ("));
});

test("invite token handoff is short-lived and explicit", () => {
  const src = fs.readFileSync(invitePagePath, "utf8");

  assert.match(src, /INVITE_TOKEN_STORAGE_TTL_MS = 15 \* 60 \* 1000/, "stored invite token should have a short TTL");
  assert.match(src, /inviteHandoffRef/, "Clerk redirects should be marked as explicit invite handoffs");
  assert.match(src, /pagehide/, "tokens should be cleared when the page exits without a handoff");
  assert.match(src, /onClick=\{beginInviteHandoff\}/, "Clerk sign-in/up buttons should save the token only when clicked");
  assert.doesNotMatch(src, /saveStoredInviteToken\(parsed\)/, "opening an invite page should not immediately persist the token");
  assert.doesNotMatch(src, /saveStoredInviteToken\(token\);[\s\S]{0,120}fail\(inviteErrorMessage/, "email mismatch should not keep the token indefinitely");
});
