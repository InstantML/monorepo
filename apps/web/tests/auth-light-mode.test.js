import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authCssPath = path.join(__dirname, "..", "app", "auth.css");
const layoutPath = path.join(__dirname, "..", "app", "layout.tsx");

test("auth flows use light-first white surfaces", () => {
  const css = fs.readFileSync(authCssPath, "utf8");

  assert.match(css, /Light-first operational auth screens/);
  assert.match(css, /\.iml-auth,[\s\S]*--bg:#f7f8f4/);
  assert.match(css, /--surface:#ffffff/);
  assert.doesNotMatch(css, /dark-only/);
});

test("Clerk modal surfaces inherit the light auth appearance", () => {
  const src = fs.readFileSync(layoutPath, "utf8");

  assert.match(src, /const clerkAppearance = \{/);
  assert.match(src, /colorBackground: "#ffffff"/);
  assert.match(src, /colorText: "#172016"/);
  assert.match(src, /<ClerkProvider appearance=\{clerkAppearance\}>/);
});
