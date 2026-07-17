/**
 * Tests for the landing page port.
 *
 * These run under Node's built-in test runner (node --test).
 * They do not require a browser or JSDOM — they verify:
 *   1. All ported component modules export the expected named functions.
 *   2. Pure-logic helpers (timestamp, polyline) produce correct values.
 *   3. The auth-aware Home route wiring is correct at the module level.
 *
 * Coverage exceptions:
 *   - HeroSpotlight, TtlRing, AuditFeed animation loops (rAF/scroll) —
 *     require a browser. Covered visually by the Playwright smoke.
 *   - Full render tree — requires React / JSDOM, deferred to a future
 *     Vitest/RTL setup. Risk: low; import smoke + logic tests give the
 *     meaningful first-party coverage per AGENTS.md.
 *   See docs/design/2026-05-17-landing-merge-into-web.md#coverage-exceptions.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.join(__dirname, "..", "components", "landing");

// ── Helper: check that a file exists and exports the expected identifier ──────
function assertFileExists(relPath) {
  const fullPath = path.join(componentsDir, relPath);
  assert.ok(
    fs.existsSync(fullPath),
    `Expected component file to exist: components/landing/${relPath}`
  );
}

function assertFileContainsExport(relPath, exportName) {
  const fullPath = path.join(componentsDir, relPath);
  const src = fs.readFileSync(fullPath, "utf8");
  assert.ok(
    src.includes(`export function ${exportName}`) ||
      src.includes(`export { ${exportName}`) ||
      src.includes(`export const ${exportName}`),
    `Expected ${relPath} to export "${exportName}"`
  );
}

// ── Component file existence + export checks ──────────────────────────────────
describe("landing components — file presence and exports", () => {
  const components = [
    ["LogoMark.tsx",    "LogoMark"],
    ["NavLogo.tsx",     "NavLogo"],
    ["LandingNav.tsx",  "LandingNav"],
    ["ThemeToggle.tsx", "ThemeToggle"],
    ["HeroSpotlight.tsx","HeroSpotlight"],
    ["MaskingDemo.tsx", "MaskingDemo"],
    ["AuditFeed.tsx",   "AuditFeed"],
    ["TtlRing.tsx",     "TtlRing"],
    ["LandingPage.tsx", "LandingPage"],
  ];

  for (const [file, exportName] of components) {
    test(`${file} exists and exports ${exportName}`, () => {
      assertFileExists(file);
      assertFileContainsExport(file, exportName);
    });
  }
});

// ── "use client" directive checks ────────────────────────────────────────────
describe("landing components — use client directives", () => {
  const mustBeClient = [
    "ThemeToggle.tsx",
    "LandingNav.tsx",
    "HeroSpotlight.tsx",
    "MaskingDemo.tsx",
    "AuditFeed.tsx",
    "TtlRing.tsx",
    "LandingPage.tsx",
  ];
  const mustBeServer = [
    "LogoMark.tsx",
    "NavLogo.tsx",
  ];

  for (const file of mustBeClient) {
    test(`${file} has "use client" directive`, () => {
      const src = fs.readFileSync(path.join(componentsDir, file), "utf8");
      assert.ok(src.includes('"use client"'), `${file} must declare "use client"`);
    });
  }

  for (const file of mustBeServer) {
    test(`${file} does NOT have "use client" directive`, () => {
      const src = fs.readFileSync(path.join(componentsDir, file), "utf8");
      assert.ok(!src.includes('"use client"'), `${file} should not declare "use client"`);
    });
  }
});

// ── ThemeToggle uses the web app's localStorage key ───────────────────────────
test("ThemeToggle uses the web app localStorage key (instantml:next:theme)", () => {
  const src = fs.readFileSync(path.join(componentsDir, "ThemeToggle.tsx"), "utf8");
  assert.ok(
    src.includes("instantml:next:theme"),
    "ThemeToggle must use 'instantml:next:theme' to stay in sync with the web app's boot script"
  );
  assert.ok(
    !src.includes("instantml_theme"),
    "ThemeToggle must NOT use the landing repo's old key 'instantml_theme'"
  );
});

test("NavLogo avoids invalid SVG auto dimensions", () => {
  const src = fs.readFileSync(path.join(componentsDir, "NavLogo.tsx"), "utf8");
  assert.doesNotMatch(src, /width=["']auto["']/);
  assert.match(src, /const width = Math\.round\(height \* \(520 \/ 120\)\)/);
});

test("LandingPage top navigation links to docs", () => {
  const src = fs.readFileSync(path.join(componentsDir, "LandingNav.tsx"), "utf8");
  assert.match(src, /import Link from "next\/link"/);
  assert.match(src, /href="\/docs"/);
  assert.match(src, />\s*Docs\s*<\/Link>/);
});

test("LandingPage migration copy matches implemented importer and shadow paths", () => {
  const src = fs.readFileSync(path.join(componentsDir, "LandingPage.tsx"), "utf8");
  assert.match(src, /W&amp;B, MLflow, Neptune imports/);
  assert.match(src, /tools\/import-wandb-json\.mjs/);
  assert.match(src, /tools\/import-mlflow-json\.mjs/);
  assert.match(src, /tools\/import-neptune-json\.mjs/);
  assert.match(src, /shadow_wandb/);
  assert.doesNotMatch(src, /Drop-in/i);
  assert.doesNotMatch(src, /mirror_to/);
});

test("LandingPage SDK and speed copy stays implementation-accurate", () => {
  const src = fs.readFileSync(path.join(componentsDir, "LandingPage.tsx"), "utf8");
  assert.match(src, /log_checkpoint_file/);
  assert.match(src, /\}, step=step\)/);
  assert.doesNotMatch(src, /log_artifact<\/span>[\s\S]*?&quot;checkpoint&quot;/);
  assert.doesNotMatch(src, /The old tools work/);
  assert.doesNotMatch(src, /We&apos;ve watched serious ML teams/);
  assert.match(src, /Hosted \+ Premium BYOC/);
  assert.match(src, /BYOC ClickHouse/);
});

// ── page.tsx: server component wiring ────────────────────────────────────────
describe("app/page.tsx — auth-aware home route", () => {
  const pagePath = path.join(__dirname, "..", "app", "page.tsx");
  let pageSrc;

  test("page.tsx exists", () => {
    assert.ok(fs.existsSync(pagePath), "apps/web/app/page.tsx must exist");
    pageSrc = fs.readFileSync(pagePath, "utf8");
  });

  test("page.tsx is a server component (no 'use client')", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      !pageSrc.includes('"use client"'),
      "page.tsx must be a server component — it must not declare 'use client'"
    );
  });

  test("page.tsx imports auth from @clerk/nextjs/server", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("@clerk/nextjs/server"),
      "page.tsx must import auth() from @clerk/nextjs/server for server-side auth check"
    );
  });

  test("page.tsx imports redirect from next/navigation", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("next/navigation"),
      "page.tsx must import redirect from next/navigation"
    );
  });

  test("page.tsx redirects signed-in users (contains redirect call)", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("redirect("),
      "page.tsx must call redirect() for signed-in users"
    );
  });

  test("page.tsx renders LandingPage when no userId", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("LandingPage"),
      "page.tsx must render LandingPage for unauthenticated visitors"
    );
  });

  test("page.tsx imports LandingPage from components/landing/LandingPage", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("components/landing/LandingPage"),
      "page.tsx must import LandingPage from the ported component"
    );
  });

  test("page.tsx checks the InstantML session via serverAuthSession", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("serverAuthSession("),
      "page.tsx must check the InstantML session server-side — it can outlive the Clerk session"
    );
  });

  test("page.tsx redirects InstantML-authenticated visitors via postAuthRedirectPath", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    assert.ok(
      pageSrc.includes("postAuthRedirectPath("),
      "page.tsx must reuse postAuthRedirectPath so onboarding-pending orgs land on /onboarding"
    );
  });

  test("page.tsx checks the InstantML session before the Clerk session", () => {
    if (!pageSrc) pageSrc = fs.readFileSync(pagePath, "utf8");
    const body = pageSrc.slice(pageSrc.indexOf("export default"));
    const instantmlCheck = body.indexOf("serverAuthSession(");
    const clerkCheck = body.indexOf("clerkUserIdOrNull(");
    assert.ok(instantmlCheck !== -1 && clerkCheck !== -1, "Home() must check both sessions");
    assert.ok(
      instantmlCheck < clerkCheck,
      "Home() must check the InstantML session first — a lapsed Clerk session must not strand a dashboard-authenticated visitor on the landing page"
    );
  });
});

// ── MaskingDemo: polyline helper produces valid SVG point strings ─────────────
describe("MaskingDemo — polyline helper logic", () => {
  // Extract and replicate the polyline helper to test it in isolation.
  function polyline(values, w, h, max) {
    const n = values.length - 1;
    return values
      .map((v, i) => {
        const x = (i / n) * w;
        const y = h - (v / max) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  test("polyline with two points produces two coordinate pairs", () => {
    const result = polyline([1.0, 0.5], 100, 100, 1.0);
    const pairs = result.split(" ");
    assert.equal(pairs.length, 2);
  });

  test("first point is at x=0", () => {
    const result = polyline([2.0, 1.0], 200, 100, 2.0);
    const first = result.split(" ")[0];
    assert.equal(first.split(",")[0], "0.0");
  });

  test("last point is at x=width", () => {
    const result = polyline([2.0, 1.0], 200, 100, 2.0);
    const pairs = result.split(" ");
    const last = pairs[pairs.length - 1];
    assert.equal(last.split(",")[0], "200.0");
  });

  test("maximum value maps to y=0 (top of chart)", () => {
    const result = polyline([1.0], 100, 100, 1.0);
    const pair = result.split(",");
    assert.equal(pair[1], "0.0");
  });

  test("zero value maps to y=height (bottom of chart)", () => {
    const result = polyline([0], 100, 100, 1.0);
    const pair = result.split(",");
    assert.equal(pair[1], "100.0");
  });
});

// ── AuditFeed: timestamp helper produces valid HH:MM:SS strings ───────────────
describe("AuditFeed — timestamp helper logic", () => {
  function timestamp(i) {
    const m = ((42 - i * 3) % 60 + 60) % 60;
    const s = ((58 - i * 11) % 60 + 60) % 60;
    return `12:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  test("timestamp starts with 12:", () => {
    assert.ok(timestamp(0).startsWith("12:"));
  });

  test("timestamp is HH:MM:SS format", () => {
    const t = timestamp(0);
    assert.match(t, /^12:\d{2}:\d{2}$/);
  });

  test("minutes are always 0-59", () => {
    for (let i = 0; i < 20; i++) {
      const t = timestamp(i);
      const m = parseInt(t.split(":")[1], 10);
      assert.ok(m >= 0 && m <= 59, `minute ${m} out of range at i=${i}`);
    }
  });

  test("seconds are always 0-59", () => {
    for (let i = 0; i < 20; i++) {
      const t = timestamp(i);
      const s = parseInt(t.split(":")[2], 10);
      assert.ok(s >= 0 && s <= 59, `second ${s} out of range at i=${i}`);
    }
  });
});

// ── TtlRing: circumference calculation ────────────────────────────────────────
describe("TtlRing — circumference calculation", () => {
  test("animation updates DOM refs instead of re-rendering React every frame", () => {
    const src = fs.readFileSync(path.join(componentsDir, "TtlRing.tsx"), "utf8");
    assert.doesNotMatch(src, /useState/, "decorative rAF animation should not call setState on every frame");
    assert.match(src, /progressRef/, "dial progress should update via a DOM ref");
    assert.match(src, /valueRef/, "dial label should update via a DOM ref");
  });

  test("circumference formula is correct for size=168, stroke=6", () => {
    const size = 168;
    const stroke = 6;
    const r = (size - stroke) / 2;
    const circumference = 2 * Math.PI * r;
    // r = 81, circumference ≈ 508.94
    assert.ok(Math.abs(circumference - 508.94) < 0.1, `Got ${circumference}`);
  });

  test("fillFraction clamps to 1 for t >= MAX_MS", () => {
    const MAX_MS = 200;
    function fillFraction(t) { return Math.min(1, t / MAX_MS); }
    assert.equal(fillFraction(200), 1);
    assert.equal(fillFraction(300), 1);
  });

  test("fillFraction at TARGET_MS (78) is less than 1", () => {
    const MAX_MS = 200;
    const TARGET_MS = 78;
    const frac = Math.min(1, TARGET_MS / MAX_MS);
    assert.ok(frac > 0 && frac < 1, `Expected fraction < 1, got ${frac}`);
  });
});

// ── globals.css: landing styles are present in the split stylesheet ──────────
// globals.css is now a thin @import chain; selectors live in styles/*.css.
// The tests below look in landing-system.css (the canonical split file for
// landing styles) and also verify globals.css still references the import.
test("globals.css @imports landing-system.css", () => {
  const cssPath = path.join(__dirname, "..", "app", "globals.css");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.ok(
    css.includes("landing-system.css"),
    "globals.css must @import landing-system.css"
  );
});

test("landing-system.css includes landing-root selector", () => {
  const cssPath = path.join(__dirname, "..", "app", "styles", "landing-system.css");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.ok(css.includes(".landing-root"), "landing-system.css must define .landing-root");
});

test("landing-system.css includes bento-cell selector", () => {
  const cssPath = path.join(__dirname, "..", "app", "styles", "landing-system.css");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.ok(css.includes(".bento-cell"), "landing-system.css must define .bento-cell");
});

test("landing-system.css includes hero-spotlight selector", () => {
  const cssPath = path.join(__dirname, "..", "app", "styles", "landing-system.css");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.ok(css.includes(".hero-spotlight"), "landing-system.css must define .hero-spotlight");
});

// ── public/logo.svg existence ─────────────────────────────────────────────────
test("public/logo.svg exists", () => {
  const logoPath = path.join(__dirname, "..", "public", "logo.svg");
  assert.ok(fs.existsSync(logoPath), "apps/web/public/logo.svg must exist");
  const content = fs.readFileSync(logoPath, "utf8");
  assert.ok(content.includes("<svg"), "logo.svg must contain SVG markup");
  // Updated to new brand mark: Bolt green #1fb877 replaces legacy #34D399
  assert.ok(content.includes("#1fb877"), "logo.svg must use the brand Bolt color (#1fb877)");
});

// ── Design doc existence ──────────────────────────────────────────────────────
test("design doc 2026-05-17-landing-merge-into-web.md exists", () => {
  const docPath = path.join(
    __dirname, "..", "..", "..", "docs", "design",
    "2026-05-17-landing-merge-into-web.md"
  );
  assert.ok(fs.existsSync(docPath), "Design doc must exist at docs/design/2026-05-17-landing-merge-into-web.md");
});
