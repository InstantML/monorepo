import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { canManageOrg, canWriteRuns, roleCapabilities, roleLabel } from "../src/roles.js";

describe("role catalog", () => {
  test("maps wire roles to product labels", () => {
    assert.equal(roleLabel("owner"), "Owner");
    assert.equal(roleLabel("admin"), "Admin");
    assert.equal(roleLabel("member"), "Write/read");
    assert.equal(roleLabel("viewer"), "Read only");
    assert.equal(roleLabel("surprise"), "Unknown");
  });

  test("matches dashboard capabilities", () => {
    assert.deepEqual(roleCapabilities("viewer"), {
      manage_billing: false,
      manage_members: false,
      write_runs: false,
      manage_api_keys: false,
    });
    assert.equal(canWriteRuns("member"), true);
    assert.equal(canManageOrg("member"), false);
    assert.equal(canManageOrg("admin"), true);
    assert.equal(canManageOrg("owner"), true);
  });
});
