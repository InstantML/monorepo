# Design: Landing Page Merge into Web App

Date: 2026-05-17

Status: Accepted

Owner: Design Engineering

## Summary

The standalone landing site (`github.com/InstantML/landing`) shares the same visual language as the web app but lives in a separate Next.js project. This design merges the landing page into `apps/web/` as the `/` route, makes that route auth-aware via server-side Clerk session resolution, and preserves the full visual system (italic-serif emphasis, emerald palette, grid+glow background, mono eyebrows, bento cards, animated spotlights).

The current `apps/web/app/page.tsx` is a client component that renders a partial hero. After this change it becomes a thin async server component: signed-in users with an active InstantML session are redirected to `/dashboard/runs`; users who are Clerk-signed-in but have not yet completed the InstantML auth handshake are redirected to `/signin`; visitors with no Clerk session are served the full landing page.

## Goals

- `/` shows the polished landing page (full hero, stats, how-it-works, capabilities bento, developer section, pricing matrix, CTA, footer) when signed out.
- Signed-in + active InstantML session → server redirect `/dashboard/runs`.
- Signed-in + no InstantML session (abandoned mid-signup) → server redirect `/signin`.
- Sign-out returns to `/`, which already works because unauthed.
- Landing visual system fully preserved (animations, dark/light theme, grid+glow, italic-serif).
- No changes to API contracts, routes, or existing dashboard behavior.

## Non-Goals

- Do not delete or modify the standalone landing repo; that is a separate archival decision.
- Do not change dashboard routes, localStorage keys, or run-workspace behavior.
- Do not change backend or SDK.
- Do not introduce Tailwind to the web app (landing CSS is ported as a namespaced block in `globals.css`).

## Auth Routing

Server-side resolution order in `apps/web/app/page.tsx`:

```tsx
// Pseudocode
const { userId } = await auth();      // Clerk server-side
if (userId) {
  // Clerk session exists — check InstantML session
  // Reuse the /api/auth/session endpoint (same as dashboard-shell uses)
  // Can't make a cookie-forwarded fetch easily in RSC without a custom header;
  // simplest approach: redirect to /signin which already handles the
  // "Clerk-authenticated but no InstantML session" handshake gracefully.
  // For the active-InstantML-session branch, a server action or middleware
  // could check /api/auth/session, but given AGENTS.md's "build thin first"
  // guideline, we start with: any Clerk userId → /signin (signin page itself
  // redirects to /dashboard/runs when both sessions are active).
  redirect("/signin");
}
// No Clerk session → render landing
return <LandingPage />;
```

Rationale for the simplified branch: the existing `/signin` page already checks for an active InstantML session and redirects to `/dashboard/runs` if one exists. Routing all Clerk-signed-in visitors to `/signin` reuses that logic without duplicating the InstantML session check in `page.tsx`. A future design doc can add a direct `/dashboard/runs` redirect for visitors who have a warm InstantML session cookie, measured by whether the latency savings justify the added check.

`afterSignInUrl` / `afterSignUpUrl` in `layout.tsx` ClerkProvider remain unset here; the sign-in and sign-up pages already set `redirectUrl="/dashboard/runs"` in their Clerk-hosted-UI configuration.

## Visual System Inventory

Components ported from `/Users/tony/Desktop/instantml/landing/src/`:

| Component | File | `"use client"` | Reason |
|---|---|---|---|
| `LogoMark` | `components/LogoMark.tsx` | No | Pure SVG, no DOM events |
| `NavLogo` | `components/NavLogo.tsx` | No | Composes LogoMark + wordmark, no events |
| `ThemeToggle` | `components/ThemeToggle.tsx` | **Yes** | DOM event + `localStorage` |
| `HeroSpotlight` | `components/HeroSpotlight.tsx` | **Yes** | `requestAnimationFrame`, scroll listener |
| `MaskingDemo` | `components/MaskingDemo.tsx` | **Yes** | Marked client in source (CSS animation is fine SSR, but source uses `"use client"`) |
| `AuditFeed` | `components/AuditFeed.tsx` | **Yes** | Marquee animation, marked client in source |
| `TtlRing` | `components/TtlRing.tsx` | **Yes** | `requestAnimationFrame` + `useState` |
| `LandingPage` | `LandingPage.tsx` | **Yes** | Composes HeroSpotlight + ThemeToggle + section observer hook |

All components live in `apps/web/components/landing/`.

CSS strategy: the landing CSS is a distinct visual system with its own token names (e.g. `--background`, `--surface-elevated`, `--border`, `--heading`, `--mute`, `--dim`, `--accent`, `--accent-hover`, `--cta-primary-text`). These names collide with the dashboard CSS (which uses `--bg`, `--surface`, `--line`, `--text`, `--muted`, etc.). To prevent bleed, all landing-specific CSS is scoped under `.landing-root` class prefixes or added as landing-specific class names that are unique to landing components. The theme tokens that overlap (`--accent`, `--accent-soft`) already have the same values in both systems; truly unique landing classes (`cta-primary`, `cta-ghost`, `card-accent`, `bento-cell`, `pill`, `mono-label`, `font-serif-italic`, `section-fade`, `hero-spotlight`, etc.) are safely additive because they are not used in any dashboard component.

Logo: `public/logo.svg` is created from the landing's SVG (identical to existing `app/icon.svg` mark; the public one omits animation classes).

## File Inventory

New files:
- `docs/design/2026-05-17-landing-merge-into-web.md` (this file)
- `apps/web/components/landing/LogoMark.tsx`
- `apps/web/components/landing/NavLogo.tsx`
- `apps/web/components/landing/ThemeToggle.tsx`
- `apps/web/components/landing/HeroSpotlight.tsx`
- `apps/web/components/landing/MaskingDemo.tsx`
- `apps/web/components/landing/AuditFeed.tsx`
- `apps/web/components/landing/TtlRing.tsx`
- `apps/web/components/landing/LandingPage.tsx`
- `apps/web/public/logo.svg`
- `apps/web/tests/landing-page.test.js`

Modified files:
- `apps/web/app/page.tsx` — converted to server component with auth routing
- `apps/web/app/globals.css` — landing CSS appended in `.landing-root`-scoped block
- `apps/web/README.md` — describes merged landing and new test

## Migration Plan for Standalone Landing Repo

The standalone landing repo at `github.com/InstantML/landing` should be archived after this PR ships and DNS at `instantml.ai` cuts over to the web app. Steps:
1. Ship this PR and verify via smoke test.
2. Update DNS / Cloudflare routing: point `instantml.ai` → web app hosting.
3. Verify redirects and SEO (robots.txt, Open Graph).
4. Archive `github.com/InstantML/landing` (read-only, not deleted, for reference).

Note: The standalone landing uses `@tailwindcss/postcss` v4 and Tailwind utility classes. The web app does not use Tailwind. All landing components are ported with their Tailwind classes replaced by equivalent CSS in the scoped landing CSS block added to `globals.css`.

## Test Plan

- `apps/web/tests/landing-page.test.js` (Node `--test` runner):
  - Signed-out: `LandingPage` module imports correctly and renders without throwing.
  - Auth-aware home: tests the redirect branches (mocked `auth()`).
  - Each interactive component exports a named function (smoke import test).
- UI smoke: existing `tests/ui-smoke.mjs` already asserts "the public landing page does not fetch dashboard summaries". It will also verify the `/` route renders without dashboard API calls for an unauthenticated visitor, which continues to pass because the server component renders `<LandingPage />` directly with no API fetch.
- `npm run web:build` must pass (TypeScript, no missing imports).

## Alternatives Considered

**CSS Modules per component.** Cleaner isolation, but requires converting all Tailwind utility class strings in the landing source to module classes. The scoped-globals approach is simpler for an initial port and aligns with the web app's existing convention ("Keep styling centralized in `app/globals.css`").

**Server-component InstantML session check.** Checking `/api/auth/session` in the RSC would let us redirect active sessions directly to `/dashboard/runs` instead of bouncing through `/signin`. Deferred: adds a blocking network call on every unauthenticated landing page load if Clerk says there is no session (which is the common case). The current approach — Clerk says signed-in → redirect to `/signin` which handles the rest — adds at most one extra client-side round-trip for warm sessions.

**Keep separate landing repo.** Rejected because it creates two codebases with divergent CSS, duplicate component versions, and split DNS management. A single repo is simpler.

## Brand Identity (Follow-Up Commit)

Brand identity applied in a follow-up commit on top of the landing port (`style(web): apply InstantML brand identity`):

- **Primitives block** added at the top of `globals.css`: `--color-ink`, `--color-bolt`, `--color-deep`, `--color-soft`, `--color-paper`, `--tracking-wordmark`.
- **Accent tokens** in both light and dark mode remapped: `--accent → var(--color-bolt)`, `--accent-strong` updated, all `rgba(52, 211, 153, …)` instances replaced with `rgba(31, 184, 119, …)`.
- **Fonts**: `Geist`/`Geist_Mono` replaced with `Space_Grotesk` (400/500/600/700) and `JetBrains_Mono` (500/700) via `next/font/google`. CSS variables `--font-sans-next` and `--font-mono-next` unchanged; font stack still resolves via `var(--font-sans)` / `var(--font-mono)`.
- **SVG assets** installed: `public/instantml-mark.svg`, `public/instantml-lockup.svg`. `public/logo.svg` replaced with the new 4×4 dot-grid mark.
- **`app/icon.svg`** and **`app/apple-icon.svg`** updated to new mark (Next.js App Router auto-favicon).
- **NavLogo** and **LogoMark** components updated to render `<Image src="/instantml-lockup.svg" />` and `<Image src="/instantml-mark.svg" />` respectively.
- **DashboardTopbar** brand cell updated: mark SVG for `brand-mark`, lockup SVG for `brand-wordmark`.
- **Metadata** in `layout.tsx`: `title.template`, full description, `icons` pointing to new mark.
- **Test updated**: `landing-page.test.js` assertion for `logo.svg` brand color updated from `#34D399` to `#1fb877`.

## Review Notes

Fresh reviewer 1 (simulated):
- Finding: ThemeToggle uses `localStorage` key `instantml_theme` while the web app boot script uses `instantml:next:theme`. These diverge.
- Risk: Light/dark toggle on the landing sets a key the web app doesn't read, causing inconsistency on navigation.
- Recommended edit: Align ThemeToggle to write `instantml:next:theme` and update the `STORAGE_KEY` constant.
- Decision: Applied.

Fresh reviewer 2 (simulated):
- Finding: Redirecting all Clerk-signed-in visitors to `/signin` means a user who bookmarks `/` while signed in gets an extra hop.
- Risk: Slightly worse UX for returning signed-in users; acceptable for a first slice.
- Recommended edit: Noted as a follow-up — add a direct `/dashboard/runs` redirect once the server-side InstantML session check is confirmed reliable.
- Decision: Accepted for now, documented as follow-up.

## Coverage Exceptions

- Uncovered area: `HeroSpotlight`, `TtlRing`, `AuditFeed` internal animation loops (requestAnimationFrame, scroll listener, marquee-vert).
- Reason: These require a real browser or JSDOM with animation support to test the motion path. The Node `--test` runner does not run animations.
- Risk: Low — these are purely cosmetic; a broken animation degrades visual quality but does not affect functionality.
- Follow-up: Add Playwright visual-regression check under `INSTANTML_UI_SMOKE_FULL_WORKSPACE=1` in a follow-up.
- Owner/date: Design Engineering / 2026-05-17

## Decision

Accepted. Implementation proceeds in `feat/port-landing-to-web`.
