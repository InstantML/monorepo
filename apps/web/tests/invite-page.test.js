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
