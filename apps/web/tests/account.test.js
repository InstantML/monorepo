import assert from "node:assert/strict";
import test from "node:test";

import { accountDisplayLabel, accountInitials, safeAccountAvatarUrl } from "../src/account.js";

test("accountInitials prefers display name initials", () => {
  assert.equal(accountInitials("Ada Lovelace", "ada@example.com"), "AL");
  assert.equal(accountInitials("InstantML", "hello@instantml.ai"), "I");
});

test("accountInitials falls back to email handle", () => {
  assert.equal(accountInitials("", "lunr.eclipse+spam@gmail.com"), "LE");
  assert.equal(accountInitials(null, ""), "IM");
});

test("accountDisplayLabel includes the clearest available account identity", () => {
  assert.equal(accountDisplayLabel("Ada Lovelace", "ada@example.com"), "Ada Lovelace (ada@example.com)");
  assert.equal(accountDisplayLabel("", "ada@example.com"), "ada@example.com");
});

test("safeAccountAvatarUrl allows only https avatar urls", () => {
  assert.equal(safeAccountAvatarUrl("https://img.clerk.com/avatar.png"), "https://img.clerk.com/avatar.png");
  assert.equal(safeAccountAvatarUrl("http://example.com/avatar.png"), "");
  assert.equal(safeAccountAvatarUrl("javascript:alert(1)"), "");
});
