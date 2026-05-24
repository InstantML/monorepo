/**
 * Tests for the /pricing route and PricingPage component.
 *
 * Mirrors the lightweight file-existence + content-grep style used in
 * landing-page.test.js. No JSDOM, no Playwright — these run under
 * `node --test` and verify:
 *   1. Route file + component file exist and export the right symbols.
 *   2. Component declares "use client" (it uses ThemeToggle / interactive bits).
 *   3. Page references the three tier numbers from auth-flow.tsx
 *      (single source of truth: $0 / $199 / $699).
 *   4. Page surfaces the W&B comparison framing and the
 *      role-aware viewer messaging that backs Jay's demo.
 *   5. CSS for the pricing route is wired into globals.css.
 *   6. Landing nav routes to /pricing.
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
function exists(relPath) {
  return fs.existsSync(path.join(webRoot, relPath));
}

// ── Route + component file presence ──────────────────────────────────────────
describe("pricing route — files exist", () => {
  test("app/pricing/page.tsx exists", () => {
    assert.ok(exists("app/pricing/page.tsx"));
  });

  test("components/pricing/PricingPage.tsx exists", () => {
    assert.ok(exists("components/pricing/PricingPage.tsx"));
  });

  test("PricingPage.tsx exports PricingPage", () => {
    const src = read("components/pricing/PricingPage.tsx");
    assert.ok(
      src.includes("export function PricingPage"),
      "PricingPage must be a named export"
    );
  });

  test("app/pricing/page.tsx imports PricingPage", () => {
    const src = read("app/pricing/page.tsx");
    assert.ok(src.includes("PricingPage"));
    assert.ok(src.includes("components/pricing/PricingPage"));
  });
});

// ── Client component directive ───────────────────────────────────────────────
test("PricingPage.tsx declares 'use client'", () => {
  const src = read("components/pricing/PricingPage.tsx");
  assert.ok(
    src.includes('"use client"'),
    "PricingPage uses ThemeToggle and must be a client component"
  );
});

// ── Tier numbers in sync with auth-flow.tsx ─────────────────────────────────
describe("PricingPage — tier numbers match auth-flow.tsx", () => {
  const src = read("components/pricing/PricingPage.tsx");

  test("Free tier listed at $0", () => {
    assert.ok(src.includes('price: "$0"'), "Free price must be $0");
  });

  test("Pro tier listed at $199", () => {
    assert.ok(src.includes('price: "$199"'), "Pro price must be $199");
  });

  test("Premium tier listed at $699", () => {
    assert.ok(src.includes('price: "$699"'), "Premium price must be $699");
  });

  test("API request allowances are shown", () => {
    assert.match(src, /500k API requests/i);
    assert.match(src, /25M API requests/i);
    assert.match(src, /150M API requests/i);
    assert.match(src, /\$2 \/ 1M overage/i);
    assert.match(src, /\$1 \/ 1M overage/i);
  });

  test("paid storage overage is shown", () => {
    assert.match(src, /\$0\.03 \/ GB-month overage/i);
  });

  test("Pro tier marked as the highlight (Jay-class default)", () => {
    // The Pro card carries the highlight flag — the Jay-pitch lands on Pro.
    assert.match(src, /id:\s*"pro"[\s\S]*?highlight:\s*true/m);
  });
});

// ── Required messaging beats ────────────────────────────────────────────────
describe("PricingPage — surfaces Jay-demo positioning", () => {
  const src = read("components/pricing/PricingPage.tsx");

  test("names read-only viewer role", () => {
    assert.match(src, /Read-only viewer role/i);
  });

  test("includes W&B comparison framing", () => {
    assert.ok(src.includes("W&amp;B") || src.includes("W&B"));
    assert.match(src, /5-person team/i);
  });

  test("calls out tracked-hour billing as a W&B-only cost", () => {
    assert.match(src, /tracked.?hour/i);
  });

  test("calls out hosted artifact storage", () => {
    assert.match(src, /Hosted R2 storage|Hosted artifacts/i);
    assert.match(src, /\$0\.03\/GB-month/i);
  });

  test("references wandb#10459 (orphaned-artifact billing)", () => {
    assert.match(src, /wandb[/#]?10459/i);
  });

  test("CTA routes to /signup", () => {
    assert.match(src, /href=["']\/signup/);
  });
});

// ── Nav wiring ──────────────────────────────────────────────────────────────
describe("Landing nav links to /pricing", () => {
  const landingSrc = read("components/landing/LandingPage.tsx");

  test("landing nav has /pricing link", () => {
    assert.match(landingSrc, /href=["']\/pricing["']/);
  });
});

// ── CSS wiring ──────────────────────────────────────────────────────────────
describe("Pricing CSS is wired", () => {
  test("styles/pricing.css exists", () => {
    assert.ok(exists("app/styles/pricing.css"));
  });

  test("globals.css @imports pricing.css", () => {
    const css = read("app/globals.css");
    assert.ok(
      css.includes("pricing.css"),
      "globals.css must @import ./styles/pricing.css"
    );
  });

  test("pricing.css defines core pricing-* selectors", () => {
    const css = read("app/styles/pricing.css");
    assert.ok(css.includes(".pricing-tier-card"));
    assert.ok(css.includes(".pricing-compare-grid"));
    assert.ok(css.includes(".pricing-surprise"));
  });
});
