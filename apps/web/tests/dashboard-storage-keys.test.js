import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The UI overhaul centralised browser-persistence keys into
// app/dashboard/state/storage-keys.ts. These literals are a stable contract:
// users' saved views / workspace layouts / theme are addressed by these exact
// strings. This guard fails loudly if a refactor ever drifts them.

const root = fileURLToPath(new URL("../", import.meta.url));
const storageKeys = readFileSync(`${root}app/dashboard/state/storage-keys.ts`, "utf8");

const REQUIRED = {
  THEME_KEY: "instantml:next:theme",
  NAV_PINNED_KEY: "instantml:next:nav-pinned",
  RUNS_RAIL_COLLAPSED_KEY: "instantml:next:runs-rail-collapsed",
  SAVED_VIEW_PREFIX: "instantml:next:local:view:",
  LEGACY_SAVED_VIEW_PREFIX: "instantml:next:view:",
  WORKSPACE_VIEW_PREFIX: "instantml:next:local:workspace:",
};

test("storage-keys preserves the exact persistence-key contract", () => {
  for (const [name, value] of Object.entries(REQUIRED)) {
    assert.match(
      storageKeys,
      new RegExp(`export const ${name} = "${value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`),
      `${name} must remain "${value}" — renaming it silently invalidates persisted user state`,
    );
  }
});

test("shell + models no longer redeclare raw persistence-key literals", () => {
  const shell = readFileSync(`${root}app/dashboard/dashboard-shell.tsx`, "utf8");
  const models = readFileSync(`${root}app/dashboard-models.ts`, "utf8");
  // The literal strings should now live only in storage-keys.ts. The shell may
  // still reference savedView label-stripping inline, but must not re-declare
  // the theme / nav / rail / view-prefix consts.
  assert.equal(/const\s+THEME_KEY\s*=/.test(shell), false, "shell must import THEME_KEY, not redeclare it");
  assert.equal(/const\s+SAVED_VIEW_PREFIX\s*=/.test(shell), false, "shell must import SAVED_VIEW_PREFIX, not redeclare it");
  assert.equal(/const\s+WORKSPACE_VIEW_PREFIX\s*=/.test(models), false, "models must import WORKSPACE_VIEW_PREFIX, not redeclare it");
});
