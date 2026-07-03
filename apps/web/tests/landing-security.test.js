/**
 * Audit-remediation regression tests (wave 2, sections L1/L2/S2/S5):
 *   1. Landing content is visible by default — the scroll reveal never gates
 *      first paint or no-JS rendering (L1).
 *   2. Landing stat-card text meets >= 4.5:1 contrast on the dark theme (L2).
 *   3. layout.tsx embeds JSON-LD through the escaping serializer (S2).
 *   4. next.config.mjs applies conservative security headers to all routes (S5).
 *
 * These run under Node's built-in test runner (node --test) and follow the
 * repo's read-file regex pattern — no browser or JSDOM required.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(webRoot, relPath), "utf8");
}

// ── L1: landing reveal must not gate visibility ───────────────────────────────
describe("landing reveal — content visible by default", () => {
  const css = read("app/styles/landing-system.css");
  const page = read("components/landing/LandingPage.tsx");

  test("section-fade default state is fully visible (no-JS renders content)", () => {
    const block = css.match(/\.section-fade\s*\{([^}]*)\}/);
    assert.ok(block, "landing-system.css must define .section-fade");
    assert.match(block[1], /opacity:\s*1/);
    assert.doesNotMatch(block[1], /opacity:\s*0/);
    assert.doesNotMatch(block[1], /translateY/);
  });

  test("hidden state exists only under the JS-added .section-pre class", () => {
    assert.match(css, /\.section-fade\.section-pre\s*\{[^}]*opacity:\s*0/);
  });

  test("reduced motion neutralizes the section-pre offset state", () => {
    const reduced = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.section-fade,\s*\.section-fade\.section-pre\s*\{([^}]*)\}/
    );
    assert.ok(reduced, "prefers-reduced-motion must cover .section-fade.section-pre");
    assert.match(reduced[1], /opacity:\s*1/);
    assert.match(reduced[1], /transition:\s*none/);
  });

  test("hero-rise keyframes never start invisible (hero paints text on first frame)", () => {
    const keyframes = css.match(/@keyframes hero-rise\s*\{([\s\S]*?)\n\}/);
    assert.ok(keyframes, "landing-system.css must define @keyframes hero-rise");
    assert.doesNotMatch(keyframes[1], /opacity:\s*0[\s;}]/);
  });

  test("observer hook opts into the fade only below the fold and respects reduced motion", () => {
    assert.match(page, /prefers-reduced-motion: reduce/);
    assert.match(page, /getBoundingClientRect\(\)\.top < window\.innerHeight/);
    assert.match(page, /classList\.add\("section-pre"\)/);
    assert.match(page, /classList\.remove\("section-pre"\)/);
  });
});

// ── L2: landing stat-card contrast on the dark theme ─────────────────────────
describe("landing stat cards — dark theme contrast", () => {
  const css = read("app/styles/landing-system.css");
  const tokens = read("app/styles/tokens.css");

  const darkBlock = tokens.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert.ok(darkBlock, "tokens.css must define the dark theme block");
  function darkToken(name) {
    const match = darkBlock[1].match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(match, `dark theme must define ${name} as a hex color`);
    return match[1];
  }

  function statCardColorVar(part) {
    const block = css.match(new RegExp(`\\.landing-stat-card__${part}\\s*\\{([^}]*)\\}`));
    assert.ok(block, `landing-system.css must style .landing-stat-card__${part}`);
    const colorVar = block[1].match(/color:\s*var\((--[a-z0-9-]+)\)/);
    assert.ok(colorVar, `.landing-stat-card__${part} must take its color from a token`);
    return colorVar[1];
  }

  test("stat-card key, value, and hint meet 4.5:1 on the dark card surface", () => {
    const surface = darkToken("--surface");
    for (const part of ["key", "val", "hint"]) {
      const color = darkToken(statCardColorVar(part));
      const ratio = contrastRatio(color, surface);
      assert.ok(
        ratio >= 4.5,
        `.landing-stat-card__${part} (${color}) is ${ratio.toFixed(2)}:1 on ${surface}; needs >= 4.5:1`
      );
    }
  });

  test("stat-card key no longer uses the faint label tone", () => {
    assert.notEqual(statCardColorVar("key"), "--faint");
  });
});

// ── S2: JSON-LD uses the escaping serializer ─────────────────────────────────
describe("layout.tsx — JSON-LD escaping", () => {
  const layout = read("app/layout.tsx");
  const serializer = read("src/json-ld.js");

  test("shared serializer escapes < and U+2028/U+2029", () => {
    assert.match(serializer, /function serializeJsonLd/);
    assert.match(serializer, /\\\\u003c/);
    assert.match(serializer, /\\u2028/);
    assert.match(serializer, /\\u2029/);
    assert.match(layout, /from "\.\.\/src\/json-ld\.js"/);
  });

  test("all JSON-LD blocks embed through the serializer, not raw JSON.stringify", () => {
    assert.match(layout, /serializeJsonLd\(organizationJsonLd\)/);
    assert.match(layout, /serializeJsonLd\(webSiteJsonLd\)/);
    assert.match(layout, /serializeJsonLd\(softwareApplicationJsonLd\)/);
    assert.doesNotMatch(layout, /__html:\s*JSON\.stringify/);
  });

  test("docs breadcrumb JSON-LD embeds through the serializer", () => {
    const docsPage = read("app/docs/[[...slug]]/page.tsx");
    assert.match(docsPage, /serializeJsonLd\(breadcrumbJsonLd\(page\)\)/);
    assert.doesNotMatch(docsPage, /__html:\s*JSON\.stringify/);
  });
});

// ── S5: conservative security headers on all routes ──────────────────────────
describe("next.config.mjs — security headers", () => {
  const config = read("next.config.mjs");

  test("applies nosniff, referrer policy, and frame options", () => {
    assert.match(config, /"X-Content-Type-Options",\s*value:\s*"nosniff"/);
    assert.match(config, /"Referrer-Policy",\s*value:\s*"strict-origin-when-cross-origin"/);
    assert.match(config, /"X-Frame-Options",\s*value:\s*"SAMEORIGIN"/);
  });

  test("security headers cover non-embed routes", () => {
    assert.match(config, /source:\s*"\/:path\(\(\?!embed/);
    assert.match(config, /headers:\s*securityHeaders/);
    assert.match(config, /frame-ancestors 'none'/);
  });
});

// ── WCAG relative-luminance contrast (same math as chart-colors.test.js) ─────
function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex) {
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
