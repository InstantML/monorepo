/**
 * Tests for the /pricing route and PricingPage component.
 *
 * Mirrors the lightweight file-existence + content-grep style used in
 * landing-page.test.js. No JSDOM, no Playwright — these run under
 * `node --test` and verify:
 *   1. Route file + component file exist and export the right symbols.
 *   2. Component declares "use client" (it renders the shared landing nav).
 *   3. Page references the tier numbers shared by signup, Rust plan guards,
 *      and public docs ($0 / $199 / $699).
 *   4. Page surfaces the implemented plan limits and explicit overage model.
 *   5. CSS for the pricing route is wired into globals.css.
 *   6. Public nav routes to /pricing and keeps Docs/Pricing reachable on mobile.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");
const repoRoot = path.join(webRoot, "..", "..");

function read(relPath) {
  return fs.readFileSync(path.join(webRoot, relPath), "utf8");
}
function readRepo(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}
function exists(relPath) {
  return fs.existsSync(path.join(webRoot, relPath));
}
function existsRepo(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}
function objectLiteralBlock(src, marker) {
  const markerIndex = src.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing marker ${marker}`);
  const start = src.lastIndexOf("  {", markerIndex);
  assert.notEqual(start, -1, `missing object start for ${marker}`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const char = src[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`missing object end for ${marker}`);
}

// ── Route + component file presence ──────────────────────────────────────────
describe("pricing route — files exist", () => {
  test("app/pricing/page.tsx exists", () => {
    assert.ok(exists("app/pricing/page.tsx"));
  });

  test("components/pricing/PricingPage.tsx exists", () => {
    assert.ok(exists("components/pricing/PricingPage.tsx"));
  });

  test("workspace loading screen is scoped to dashboard routes", () => {
    assert.ok(!exists("app/loading.tsx"));
    assert.ok(exists("app/dashboard/loading.tsx"));
    const dashboardLoading = read("app/dashboard/loading.tsx");
    assert.match(dashboardLoading, /AppLoadingScreen/);
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
    "PricingPage renders the shared landing nav and must be a client component"
  );
});

// ── Tier numbers in sync with auth-flow.tsx ─────────────────────────────────
describe("PricingPage — tier numbers match signup, Rust, and docs", () => {
  const src = read("components/pricing/PricingPage.tsx");
  const authFlow = read("app/auth-flow.tsx");
  const rustDomain = readRepo("apps/rust-server/src/domain.rs");
  const pricingDocs = readRepo("apps/docs/pricing.mdx");
  const limitsDocs = readRepo("apps/docs/guides/pricing-limits-billing.mdx");
  const plans = [
    {
      id: "free",
      label: "Free",
      price: "$0",
      rustPrice: "monthly_base_usd: 0",
      storage: "2 GiB",
      seats: "2",
      projects: "2",
      runs: "100",
      metricPoints: "1M",
      apiRequests: "500k",
      ctaHref: "/signup",
      rustSnippets: [
        "included_seats: 2",
        "included_storage_bytes: 2 * GIB_BYTES",
        "projects: 2",
        "runs: 100",
        "metric_points: 1_000_000",
        "api_requests: 500_000",
      ],
    },
    {
      id: "pro",
      label: "Pro",
      price: "$199",
      rustPrice: "monthly_base_usd: 199",
      storage: "1 TiB",
      seats: "3",
      projects: "100",
      runs: "100k",
      metricPoints: "250M",
      apiRequests: "25M",
      ctaHref: "/signup?plan=pro",
      rustSnippets: [
        "included_seats: 3",
        "included_storage_bytes: 1024 * GIB_BYTES",
        "projects: 100",
        "runs: 100_000",
        "metric_points: 250_000_000",
        "api_requests: 25_000_000",
        "api_request_overage_cents_per_million: Some(200)",
      ],
    },
    {
      id: "premium",
      label: "Premium",
      price: "$699",
      rustPrice: "monthly_base_usd: 699",
      storage: "5 TiB",
      seats: "10",
      projects: "500",
      runs: "1M",
      metricPoints: "2B",
      apiRequests: "150M",
      ctaHref: "/signup?plan=premium",
      rustSnippets: [
        "included_seats: 10",
        "included_storage_bytes: 5 * 1024 * GIB_BYTES",
        "projects: 500",
        "runs: 1_000_000",
        "metric_points: 2_000_000_000",
        "api_requests: 150_000_000",
        "api_request_overage_cents_per_million: Some(100)",
      ],
    },
  ];

  for (const plan of plans) {
    test(`${plan.label} tier matches every public source`, () => {
      const planBlock = objectLiteralBlock(src, `id: "${plan.id}"`);
      assert.ok(planBlock.includes(`price: "${plan.price}"`));
      assert.ok(planBlock.includes(`${plan.seats} included seats`));
      assert.ok(planBlock.includes(plan.storage));
      assert.ok(planBlock.includes(`${plan.projects} projects`));
      assert.ok(planBlock.includes(`${plan.runs} runs`));
      assert.ok(planBlock.includes(`${plan.metricPoints} metric points`));
      assert.ok(planBlock.includes(`${plan.apiRequests} API requests`));
      assert.ok(planBlock.includes(`ctaHref: "${plan.ctaHref}"`));
      assert.ok(authFlow.includes(`price: "${plan.price}"`));
      assert.ok(authFlow.includes(`storage: "${plan.storage}"`));
      assert.ok(rustDomain.includes(plan.rustPrice));
      for (const snippet of plan.rustSnippets) assert.ok(rustDomain.includes(snippet), snippet);
      const docsRow = `| ${plan.label} | ${plan.price} / org / month | ${plan.seats} | ${plan.storage} | ${plan.projects} | ${plan.runs} | ${plan.metricPoints} | ${plan.apiRequests} |`;
      assert.ok(pricingDocs.includes(docsRow), docsRow);
      assert.ok(limitsDocs.includes(docsRow), docsRow);
    });
  }

  test("API request allowances are shown", () => {
    assert.match(src, /500k API requests/i);
    assert.match(src, /25M API requests/i);
    assert.match(src, /150M API requests/i);
    assert.match(src, /\$2 \/ 1M overage/i);
    assert.match(src, /\$1 \/ 1M overage/i);
  });

  test("paid storage overage is shown", () => {
    assert.match(src, /\$0\.03 \/ GiB-month overage/i);
  });

  test("Pro tier marked as the highlight", () => {
    assert.match(src, /id:\s*"pro"[\s\S]*?highlight:\s*true/m);
  });
});

// ── Required messaging beats ───────────────────────────────────────────────
describe("PricingPage — surfaces implemented pricing model", () => {
  const src = read("components/pricing/PricingPage.tsx");
  const route = read("app/pricing/page.tsx");

  test("shows included seat counts from plan constants", () => {
    assert.match(src, /2 included seats/i);
    assert.match(src, /3 included seats/i);
    assert.match(src, /10 included seats/i);
  });

  test("shows project, run, and metric-point limits", () => {
    assert.match(src, /2 projects/i);
    assert.match(src, /100 projects/i);
    assert.match(src, /500 projects/i);
    assert.match(src, /100 runs/i);
    assert.match(src, /100k runs/i);
    assert.match(src, /1M runs/i);
    assert.match(src, /1M metric points/i);
    assert.match(src, /250M metric points/i);
    assert.match(src, /2B metric points/i);
  });

  test("calls out no tracked-hour billing without competitor dollar math", () => {
    assert.match(src, /tracked.?hour/i);
    assert.doesNotMatch(src, /5-person team/i);
    assert.doesNotMatch(src, /\$50 \/ extra writer/i);
    assert.doesNotMatch(src, /\$70 \/ extra writer/i);
    assert.doesNotMatch(src, /wandb[/#]?10459/i);
  });

  test("explains paid overage and Free blocking", () => {
    assert.match(src, /Free and non-billable orgs are blocked/i);
    assert.match(src, /\$0\.03 \/ GiB-month/i);
    assert.match(src, /\$2\s*\/\s*1M requests/i);
    assert.match(src, /\$1\s*\/\s*1M requests/i);
  });

  test("route metadata avoids flat/no per-call overclaims", () => {
    assert.doesNotMatch(route, /Flat monthly/i);
    assert.doesNotMatch(route, /no per-call/i);
    assert.match(route, /explicit usage limits/i);
  });

  test("CTA routes to /signup", () => {
    assert.match(src, /href=["']\/signup/);
  });

  test("paid pricing CTAs preselect the requested signup plan", () => {
    const authFlow = read("app/auth-flow.tsx");
    assert.match(objectLiteralBlock(src, 'id: "pro"'), /ctaHref:\s*"\/signup\?plan=pro"/);
    assert.match(objectLiteralBlock(src, 'id: "premium"'), /ctaHref:\s*"\/signup\?plan=premium"/);
    assert.match(authFlow, /function planTierFromSearchParam/);
    assert.match(authFlow, /new URLSearchParams\(window\.location\.search\)\.get\("plan"\)/);
    assert.match(authFlow, /setPlanTier\(requestedPlan\)/);
  });

  test("managed signup plan picker does not sell organization seats into a personal workspace", () => {
    const authFlow = read("app/auth-flow.tsx");
    assert.match(authFlow, /function seatLimitForPlan\(planTier: PlanTier\): number/);
    assert.match(authFlow, /seatLimitForPlan\(planTier\)/);
    assert.match(authFlow, /seatContext\?:\s*"organization"\s*\|\s*"personal"/);
    assert.match(authFlow, /<PlanPicker[^>]*seatContext="personal"/);
    assert.match(authFlow, /seatContext=\{seatContext\}/);
    assert.match(authFlow, /seatContext === "personal" \? "1 owner seat" : plan\.seats/);
    assert.match(authFlow, /Team org · \{selectedPlan\.seats\}, reservable/);
    assert.match(authFlow, /Managed signups create a personal workspace first/);
  });

  test("links to docs pricing page", () => {
    assert.match(src, /href=["']\/docs\/pricing["']/);
    assert.ok(existsRepo("apps/docs/pricing.mdx"), "apps/docs/pricing.mdx must exist");
    const docsJson = read("../docs/docs.json");
    assert.match(docsJson, /"pricing"/);
  });

  test("decorative arrows are hidden from assistive tech", () => {
    assert.match(src, /function IconArrow\(\)[\s\S]*?aria-hidden="true"/);
    assert.match(src, /function IconArrow\(\)[\s\S]*?focusable="false"/);
  });
});

// ── Nav wiring ──────────────────────────────────────────────────────────────
describe("Landing nav links to /pricing", () => {
  const landingSrc = read("components/landing/LandingPage.tsx");
  const navSrc = read("components/landing/LandingNav.tsx");

  test("landing nav has /pricing link", () => {
    assert.match(landingSrc, /<LandingNav \/>/);
    assert.match(navSrc, /href=["']\/pricing["']/);
  });

  test("landing and pricing nav keep Docs/Pricing visible on mobile", () => {
    const pricingSrc = read("components/pricing/PricingPage.tsx");
    const css = read("app/styles/landing-system.css");

    assert.match(landingSrc, /<LandingNav \/>/);
    assert.match(pricingSrc, /<LandingNav \/>/);
    assert.match(navSrc, /href=["']\/docs["'][\s\S]*?landing-nav__link/);
    assert.match(navSrc, /href=["']\/pricing["'][\s\S]*?landing-nav__link--mobile/);
    assert.match(css, /\.landing-nav__link--mobile\s*\{\s*display:\s*inline-flex;/);
    assert.match(css, /\.landing-nav__links > \*\s*\{\s*flex-shrink:\s*0;/);
    assert.match(css, /\.landing-theme-toggle\s*\{[\s\S]*?flex:\s*0 0 44px;/);
    assert.match(css, /\.landing-cta-primary\s*\{[\s\S]*?white-space:\s*nowrap;/);
    assert.match(css, /@media \(max-width:\s*480px\)\s*\{[\s\S]*?\.landing-cta-primary--sm\s*\{[\s\S]*?display:\s*none;/);
  });

  test("landing pricing copy avoids flat-pricing overclaim", () => {
    assert.doesNotMatch(landingSrc, /flat pricing/i);
    assert.doesNotMatch(landingSrc, /flat predictable pricing/i);
    assert.match(landingSrc, /Predictable pricing/i);
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
    assert.ok(css.includes(".pricing-compare-col__value"));
  });
});
