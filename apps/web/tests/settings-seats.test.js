import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPanePath = path.join(__dirname, "..", "app", "dashboard", "settings", "tab-pane.tsx");
const overhaulStylesPath = path.join(__dirname, "..", "app", "styles", "overhaul.css");

test("settings seats list hides revoked entries", () => {
  const src = fs.readFileSync(settingsPanePath, "utf8");

  assert.match(src, /visibleSeats = seats\.filter\(\(seat\) => seat\.membership\.status !== "revoked"\)/);
  assert.match(src, /visibleInvitations = invitations\.filter\(\(invitation\) => !\["accepted", "revoked"\]\.includes\(invitation\.status \?\? ""\)\)/);
  assert.match(src, /visibleSeats\.map/);
  assert.doesNotMatch(src, /\{seats\.map/);
});

test("settings seats rows use a fixed column grid", () => {
  const settingsSrc = fs.readFileSync(settingsPanePath, "utf8");
  const cssSrc = fs.readFileSync(overhaulStylesPath, "utf8");

  assert.match(settingsSrc, /className="api-row seat-row"/);
  assert.match(cssSrc, /\.admin-list \.api-row\.seat-row\s*\{[\s\S]*grid-template-columns: 126px minmax\(0, 1fr\) 150px 124px;/);
});
