# Auth & Onboarding Redesign — design note

Mockup: `mockup.html` (open in a browser; use the bottom state switcher).

## Goals

1. Re-skin landing nav, sign in, sign up, and onboarding into the InstantML
   engineering-brutalism design language (tokens from
   `docs/design/assets/ui-overhaul-mocks/tokens.css`): near-black `#07080c`
   grid+emerald-glow ground, emerald `#34d399` accent, Geist sans, Geist Mono
   uppercase eyebrows, Instrument Serif italic emphasis, hairline borders, low
   radii, dense. The auth surface should read as "the dashboard grew an
   exterior wall," not a generic SaaS template (per
   `2026-05-11-landing-auth-onboarding.md`).
2. De-clunk the sign in / sign out flow.
3. Fix the broken landing **Sign out**.
4. Make the sign up page (account type + org name + seats) coherent and
   reachable.

## Flow changes (the de-clunking)

Current (`app/auth-flow.tsx`) problems → redesign decisions:

- **`/signin` led with a primary "Sign up with Clerk" button** next to a
  secondary "Sign in". → Sign in now has **one** primary action,
  "Continue with Clerk", and a quiet text link "New to InstantML? Create a
  workspace". Sign up mirrors it with "Already have a workspace? Sign in".
- **Two-step auth**: after the Clerk modal, the user had to click a second
  "Continue to dashboard" / "Create InstantML workspace" button. → The Clerk
  session is exchanged **automatically** on return for both sign in and sign
  up (extend the existing `signin` auto-exchange effect to `signup`). The UI
  shows a single "Opening your workspace…" busy state, no second click.
- **Onboarding conflated with returning-user sign in.** → Returning sign in
  goes straight to the dashboard. `/onboarding` (SDK-key step) is only for the
  just-created workspace. Onboarding gains a 3-step tracker (Workspace →
  Identity → SDK key) so the user knows where they are and that they are
  almost done.
- **Sign up asked for org details with no structure.** → Account type is a
  real segmented control (Customer = personal/1 seat, Business = team/3
  seats). Org name has live availability as inline mono feedback. Seats only
  appear for Business, with an explicit "no invitations are sent yet" helper
  and a `n / N used` counter chip (matches the seat-reservation contract).

## Sign-out bug

`app/page.tsx` `signOut()` does `await api.post("/api/auth/logout")` **then**
`clerk.signOut({redirectUrl:"/"})`. When the local Next app proxies to the
hosted Cloud Run API, the browser's `Origin: http://127.0.0.1:3000` is
forwarded but is **not** in the hosted API's `INSTANTML_API_ALLOWED_ORIGINS`,
so the cookie-auth mutating `/api/auth/logout` is rejected on the server
origin check. The promise throws, the `catch` only sets an error string, and
`clerk.signOut()` never runs — the user stays signed in.

Fix direction (validated in implementation/Chrome): the client sign-out must
**always clear the Clerk session even if the InstantML logout request fails**,
and surface logout failure non-fatally. Sequence Clerk sign-out and session
revoke so a rejected `/api/auth/logout` cannot strand the user signed in;
treat logout as best-effort + idempotent. Also re-check the server origin
allow-list so same-origin proxied browser logout is accepted.

## Review outcomes (3 agents: brand, a11y, UX/code)

Applied to `mockup.html`: `.serif-em` reverted to `--text-2`/1.08em (was
emerald); `.btn--primary` flattened to the flat `--accent` token (no
gradient/glow); brand-mark glow removed; over-used italic headlines demoted on
signin-busy / error / onboard-demo; `.eyebrow--danger` token used; all
`--dim` *text* (hints, step sub/idx, divider, placeholder, code comments)
moved to `--muted`/`--faint` to clear AA contrast; perpetual blinking caret
removed (WCAG 2.2.2); `aria-busy` on the busy card.

Carried into the React implementation (semantic, not visible in static
mockup): account type as native radios in a `<fieldset>`/radiogroup with
`aria-checked`; `for`/`id` on every input; focus moved to the headline after
redirect/exchange; copy-once key copy announced in the polite live region;
`aria-busy` + accessible loading name on the busy button.

Flow/code corrections from the UX/code review:
- Sign-out: `await api.post("/api/auth/logout").catch(()=>{})` (best-effort,
  swallow), **then** `clerk.signOut({redirectUrl})` unconditionally so a
  rejected logout can never strand the user signed in; logout failure shown
  non-fatally. (Server-side origin allow-list fix noted as a follow-up; the
  client change is the robust fix and is in scope here.)
- Do **not** auto-exchange signup until org name is non-empty AND available;
  reset the Clerk-exchange attempt ref on the early invalid return (mirror the
  catch) so the later real submit isn't suppressed.
- Gate the onboarding/SDK-key screen on `mode === "onboarding"` only, not on
  session presence, so a returning signed-in user on `/signin` goes to the
  dashboard instead of seeing onboarding.
- Keep the shared-demo button and dev-auth local form behind
  `config.dev_auth_enabled` (invisible on live, required for local/demo).
- Wire the seat counter to parsed seat-email count vs `seat_limit`.

## Accessibility intent (carry into implementation)

Visible `h1`/headline, labeled inputs, `role="status"`/`aria-live` on the
status line, `role="alert"` on errors, native radios or a proper radiogroup
for account type, keyboard-only completion, focus moved to the headline after
route/redirect, copy-once key announced politely, and
`prefers-reduced-motion` honored (mockup already disables animation under it).
Contrast: body text uses `--text-2`/`--muted` on `--surface`; `--dim` is
non-text only.
