# Design: globals.css Structural Audit and Refactor

Date: 2026-05-18

Status: Accepted

Owner: agent (css-refactor pass)

## Summary

`apps/web/app/globals.css` accumulated 11,348 lines across many feature-landing rounds. The file has 285 duplicate same-specificity selectors, ~1,650 lines of dark-theme overrides scattered 6,000+ lines away from their base rules, and at least four fully-redundant "overhaul" layers appended to the bottom. The result is a cascade that is difficult to reason about and bug-prone: fixing `.brand-mark` or `.tabs` required hunting down 3–7 copies of the same selector at wildly different line numbers.

This doc records the Phase 1 discovery findings and the accepted Phase 2 restructure plan.

## Discovery Findings

### 1. Total lines and file size

- **11,348 lines, 235.8 KB** in a single file.
- `auth.css` (292 lines) is already split out and works well as the model.

### 2. Structural sections (informal, by comment headers)

| Lines | Region |
|---|---|
| 1–129 | Brand primitives + design tokens (`:root` light + dark) |
| 130–390 | Base reset (box-sizing, body, typography, buttons, h1-p) |
| 391–799 | Landing page (nav, hero, preview mockup, auth card) |
| 800–999 | Auth/onboarding forms |
| 1,000–1,599 | Dashboard chrome (topbar, brand-mark, tabs, shell, nav rail) |
| 1,600–2,199 | Runs workspace rail + rows |
| 2,200–2,999 | Panel canvas + workspace modals |
| 3,000–4,499 | Charts (metric panels, series, hover, range, fullscreen) |
| 4,500–5,199 | Run detail (hero, KPIs, timeline, inspector) |
| 5,200–6,299 | Compare (table, matrix, evidence, artifact cells) |
| 6,300–7,360 | Dark-theme overrides (large block — a wholesale theme override for ~600+ selectors) |
| 7,361–8,285 | UI overhaul layer 2026-05-15 (re-declares ~440 lines of chrome, typography, nav) |
| 8,286–8,512 | Secondary surfaces (alerts, datasets, artifacts, settings, integrations) |
| 8,513–8,858 | Run-rail cleanup layer (re-declares rail, rows, toolbar ~346 lines) |
| 8,859–9,058 | Sidebar/Pluto-style rows layer (~200 lines) |
| 9,059–9,418 | QA-pass corrections (a11y, leak fixes, ~360 lines) |
| 9,419–9,907 | Mobile redesign (≤720px, ~489 lines) |
| 9,908–10,339 | Landing visual system (ported from standalone landing repo) |
| 10,340–11,348 | Landing animations (@keyframes, hero, spotlights, ~1,008 lines) |

### 3. Duplicate selectors

- **Total unique selectors:** 1,341
- **Selectors with 2+ definitions:** 285

Top offenders:

| Copies | Selector | Line numbers | Assessment |
|---|---|---|---|
| 7 | `.topbar` | 1009, 5777, 6015, 7383, 7770, 7806, 9456 | Conflict — each layer overrides the last |
| 7 | `.tabs` | 1472, 5833, 6031, 7497, 8886, 9218, 9602 | Conflict — background ownership fights |
| 7 | `.tab-group` | 1495, 1507, 5859, 5870, 6040, 6049, 9637 | Partially layered, partially redundant |
| 6 | `.shell` | 1454, 5828, 6020, 8865, 9466, 9598 | Conflict — grid-template-columns changes |
| 6 | `.tab-button` | 1520, 5876, 6054, 7514, 8932, 9645 | Later rules narrow earlier |
| 6 | `.api-row` | 5480, 5633, 6261, 8369, 8397, 9106 | Conflict |
| 5 | `.workspace-run-row` | 1961, 7604, 8552, 8972, 9226 | Each layer patches the previous |
| 3 | `.brand-mark` | 1035, 7414, +mobile | Last wins; earlier rules dead |

The 7-level `.topbar` and `.tabs` stacks are the direct cause of the recent `.brand-mark` and `.tabs` bugs reported.

### 4. Specificity-conflict hotspots

The bugs hit when `overhaul` layers (L7361+, L7802+) re-apply colored `.brand-mark` boxes or opaque `.tabs` backgrounds that a cleaned-up rule in the mid-file had removed. Because all copies share the same specificity (single class), the last rule always wins — but the intent was that the cleaned rule should win, not the appended one.

Most severe conflicts:
- `.topbar`: 7 definitions; `background` is set differently at L7806 ("var(--color-ink)"), L7393 ("rgba(7,8,12,0.93)"), and L9456 again.
- `.tabs`: 7 definitions; `background` fights between `color-mix(var(--bg) 70%, transparent)` (L7757) and opaque `var(--surface)` (L8886).
- `.shell`: `grid-template-columns` changes from `56px minmax(0,1fr)` to `200px minmax(0,1fr)` across copies.
- `:root[data-theme="dark"] .topbar`: 3 copies at L6305, L7393, L7823 — all different values.

### 5. Theme-specific overrides

- **Dark overrides:** 245 selector blocks in `globals.css` (plus the `:root` block at L81).
- **Light overrides:** 12 selector blocks.

Most dark overrides live in a monolithic block at L6,300–7,360, completely detached from their base rules. Example: `.status-message` base is at L1337, its dark override is at L6804 — 5,467 lines apart.

Light overrides have no symmetric counterpart for most of the ~110 class selectors that only get dark overrides. This is intentional (dark is the product default; light mode uses base-rule values), but the asymmetry is a readability hazard.

### 6. Hardcoded colors that should be tokens

265 unique hardcoded color values. Those appearing 3+ times:

| Count | Value | Status |
|---|---|---|
| 18 | `#ffffff` | Should use `var(--color-paper)` or `var(--bg)` |
| 15 | `#fff` | Same |
| 9 | `#344251` | Unnamed — should become a token |
| 7 | `rgba(31, 184, 119, 0.12)` | Should be `var(--accent-soft)` |
| 7 | `#fbfcfd` | Near-white surface — unnamed |
| 5 | `#1fb877` | Should be `var(--color-bolt)` or `var(--accent)` |
| 5 | `#f7f9fb` | Should be `var(--surface-soft)` or `var(--bg-soft)` |
| 5 | `rgba(31, 184, 119, 0.14)` | No token; create `--accent-glow-14` |
| 5 | `rgba(31, 184, 119, 0.18)` | No token; create `--accent-glow-18` |
| 5 | `rgba(31, 184, 119, 0.16)` | No token |

### 7. !important count

**29 uses** before refactor. Categories:

- SR-only / accessibility helpers (L1116–1121, L1138): **6** — legitimate, keep with comment.
- Reduced-motion media query (L9135–9138): **4** — legitimate, keep.
- Single-property overrides on table cells (L4166–4167): **2** — replaceable by specificity.
- Hover/color overrides (L5082, L5084, L6696, L10275, L10276): **5** — replaceable.
- Animation-none for no-js/prefers-reduced-motion (L10393–10395, L10464–10466, L10471–10473): **9** — legitimate.
- Layout flex overrides (L10936–10937): **2** — replaceable by specificity.

### 8. @keyframes inventory

16 keyframes defined (all in the landing animation section L10340+):

| Name | Line | Used by |
|---|---|---|
| `loading-bar` | 382 | `.app-loading-bars span::after` (L371) ✓ |
| `spotlight-drift` | 10343 | `.hero-spotlight` (L10357) ✓ |
| `spotlight-drift-secondary` | 10350 | `.hero-spotlight-secondary` (L10360) ✓ |
| `logo-iris-left` | 10368 | logo iris animation (L10379) ✓ |
| `logo-iris-right` | 10373 | logo iris animation (L10383) ✓ |
| `wordmark-in` | 10398 | `.logo-wordmark-letter` (L10403) ✓ |
| `logo-dot-emerge` | 10420 | `.logo-dot` (L10439) ✓ |
| `logo-diagonal-pulse` | 10425 | `.logo-diagonal` (L10447) ✓ |
| `logo-wordmark-text-in` | 10430 | `.logo-wordmark-text` (L10458) ✓ |
| `hero-rise` | 10477 | `.hero-rise-*` (L10481–10484) ✓ |
| `statusPulse` | 10507 | `.status-live` (L10505) ✓ |
| `flowDash` | 10520 | `.flow-path` (L10518) ✓ |
| `pulseRing` | 10526 | `.pulse-ring` (L10524) ✓ |
| `marquee-vert` | 10532 | `.audit-track` (L10536–10537) ✓ |
| `chart-sweep` | 10543 | `.chart-sweep-path` (L10549) ✓ |
| `tick-flash` | 10556 | `.tick-icon` (L10560) ✓ |

No dead keyframes detected. `loading-bar` is in the base section; all others belong to landing animations.

### 9. Dead-rule candidates

Conservative estimate: 151 CSS classes are not found by literal string search in TSX files. However, many are legitimately active:
- Classes used in `className` expressions with template literals (dynamic)
- Classes injected by Clerk (`__clerk_*`), Next.js dev tools, and third-party libraries
- Classes applied via `classList.add()` in plain JS
- Pseudo-classes and pseudo-elements (`:hover`, `::after`, `::before`)
- Classes documented as intentionally kept for auth.css overlap (`.eyebrow`, `.brand-mark`, `.button-link`)

Confident dead candidates (cross-referenced against TSX and noted inline in the refactored file where removed): fewer than 20 rules would be safe to delete without screenshot diffing. **Deletion deferred** to a dedicated visual-QA-backed cleanup pass.

## Strategy Decision: Option A (Split into Multiple Files)

**Chosen: Strategy A — split into scoped stylesheets.**

Rationale:
1. The file naturally decomposes: landing, auth, dashboard-chrome, runs, charts, compare, secondary surfaces, animations are already logical blocs.
2. The dark-theme overrides block (L6,300–7,360) should move to sit next to base rules, not float 5,000+ lines away. Splitting by feature moves each dark-block next to its base rules automatically.
3. Auth already lives in `auth.css` and the pattern works.
4. Option B (keep one file, consolidate) would still leave the file >5,000 lines after dedup — still hard to navigate.
5. Next.js CSS bundling supports `@import` chains in `layout.tsx` or a thin `globals.css` entry point.

**Rejected: Option B** — mechanical dedup would reduce ~2,000 lines but leave a 9,000-line monolith.

### Target file structure

```
apps/web/app/styles/
  tokens.css          — :root brand primitives + light/dark design tokens
  base.css            — box-sizing, body, typography, buttons, focus, h1-p
  landing.css         — .landing-*, .auth-page, .auth-card, .preview-*, .compare-preview-*
  dashboard.css       — .shell, .topbar, .brandbar, .tabs, .brand-mark, .nav-*, .workbar
  dashboard-runs.css  — .workspace-run-*, .runs-*, .workspace-panel-*, .section-*
  charts.css          — .metric-*, .chart-*, .panel, .axis, .series-*, .range-*
  run-detail.css      — .run-detail-*, .run-kpi-*, .inspector, .evidence-*, .detail-*
  compare.css         — .compare-*, .leaderboard-*, .side-*, .summary-*
  components.css      — .chip, .pill, .stat, .status-message, .button-link, .select-*, .icon-button, .avatar, .kbd, shared primitives
  secondary.css       — .api-row, .setting-row, .browser-row, .timeline-row, .event-row, .integration-*, .artifact-*, .readout-*
  mobile.css          — @media (max-width: 720px) block
  animations.css      — @keyframes (landing + loading-bar) + classes that animate
globals.css           — thin entry: @import chain only
```

### Dark-theme consolidation

Each split file includes the dark-theme overrides for its own selectors immediately after the base rules for those selectors. This eliminates the 6,000-line gap. The monolithic `L6300–7360` dark-theme block is dissolved into its feature files.

### Dedup approach

Within each split file, duplicate selectors are merged: the final winning property set is kept, adjacent rules that intentionally layer state (e.g. `.tab-button` + `.tab-button.active`) are kept adjacent with a comment.

## Phased Plan

### Phase 1: Design doc + audit script
- Commit: `docs/design/2026-05-18-globals-css-audit.md`
- Commit: `tools/css-audit.mjs`

### Phase 2: Mechanical extraction
- Create `apps/web/app/styles/` directory.
- Extract each section into its own file (no property changes — pure cut/paste + dedup).
- Update `apps/web/app/globals.css` to be an `@import` chain.
- Run `npm run test:node` + `web:build` to verify.

### Phase 3: Dedup and consolidation
- Within each split file, merge duplicate selectors.
- Move dark-theme overrides next to their base rules.
- Remove confirmed dead rules (conservative set only).
- Re-run test suite.

### Phase 4: Token sweep (follow-up, not this session)
- Replace recurring hardcoded colors with new `:root` tokens.
- Verify WCAG contrast ratios are preserved.

## Test Plan

- `npm run test:node` — Node unit tests (do not touch CSS, but `landing-page.test.js` asserts `.landing-root`, `.bento-cell`, `.hero-spotlight` exist in `globals.css` — must remain true after the `@import` chain is in place, OR the test updated to check the new split file directly).
- `npm run web:build` — Next.js/Turbopack build; CSS import errors surface here.
- `apps/web/tests/ui-smoke.mjs` — Playwright smoke that asserts `.iml-landing` and structural class presence.

### Regression unknowns (visual QA required)

The following surfaces cannot be regression-tested without screenshot diffing. **Manual hard-refresh QA is required** before merging:

1. **Dark-mode dashboard chrome** — topbar/tabs background after consolidation of 7-copy `.topbar` and `.tabs`.
2. **Landing hero on mobile** — the landing animation classes are in a separate `animations.css`; verify the spotlight and logo intro fire correctly.
3. **Light mode** — the 12 light-mode overrides are scattered; consolidation could accidentally miss one.
4. **Clerk auth surfaces** — `.iml-*` classes from `auth.css` interact with globals; moving `.eyebrow` and `.brand-mark` could create z-order or inheritance surprises.
5. **Fullscreen chart panel** — uses multiple chart classes in a portal; ensure the portal still inherits the split CSS.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Next.js CSS `@import` order determines cascade; wrong order reintroduces conflict | High | Document import order; test with build |
| A dark-theme override missed when dissolving L6300–7360 block | Medium | Diff dark-theme line count before/after per file |
| Test `landing-page.test.js` asserts selectors in `globals.css` by path | Low | Update test or keep thin imports in globals.css |
| Clerk / third-party library styles depend on cascade position | Low | Keep `auth.css` import last (same as today) |
| Mobile overrides use `!important` in some places; split could break specificity | Low | Keep mobile.css imported last in chain |

## Reviewer Notes

Fresh reviewer 1 (self-review, same session):

- Finding: The `.tabs` background conflict (7 copies) is the most likely source of future visual regressions.
- Risk: Medium — wrong merge order could flip the visible background.
- Recommended edit: In `dashboard.css`, keep the `/* .tabs background is owned here */` comment and place the dark override immediately below the base rule.
- Decision: Accepted. The winning rule is the last one in the 8,859–9,059 section (`var(--surface)` for light, `var(--color-ink)` for dark). That single rule set is the canonical one.

Fresh reviewer 2 (self-review, conservative lens):

- Finding: 285 duplicate selectors is a large surface. A mechanical extraction that does not change properties is safer than an inline merge.
- Risk: Merge errors could silently change visual output.
- Recommended edit: Phase 2 = extraction only (no property merges). Phase 3 = merge one file at a time with a build check between each file. Mark duplicate blocks with `/* DUPLICATE — merged in Phase 3 */` during Phase 2.
- Decision: Accepted. Phase 2 extracts without merging; Phase 3 merges with per-file verification.

## Coverage Exceptions

- Uncovered area: Dead-rule deletion (estimated ~20 rules)
- Reason: Requires screenshot diffing to confirm rules are visually dead, not just absent from TSX static analysis.
- Risk: Low — rules are candidates, not confirmed dead.
- Follow-up: Add Playwright screenshot-diff test for landing hero + dashboard nav + /signup card. Compare before/after screenshots. Delete confirmed-dead rules in a follow-up PR.
- Owner/date: CSS refactor follow-up, 2026-05-19+

## Decision

Accepted. Phase 2 extraction proceeds immediately in this session.
