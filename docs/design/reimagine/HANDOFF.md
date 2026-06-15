# Handoff Spec: Instrument — InstantML dashboard implementation

> Developer handoff for the Instrument design language as shipped in `apps/web`.
> Companion docs: [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) (the language and its
> rules), the reference mockups in this folder, and the production stylesheets
> (`apps/web/app/styles/*`, signature layer in `instrument.css`).

## Overview

InstantML is a training-observability dashboard: run tables, metric charts,
artifacts, health monitors. Instrument treats it as a precision instrument
console — Spline Sans Mono carries every value/label/identifier, Archivo
carries prose, green is reserved for live/best, and structure comes from
hairlines on a warm paper (light, default) or warm graphite (dark) surface.

Stack: Next.js 16 app router, plain CSS custom properties (no Tailwind/CSS-in-JS),
hand-rolled SVG charts, Lucide icons, Clerk auth. Fonts load via `next/font`
(`Archivo`, `Spline Sans Mono`, `Instrument Serif` for marketing accents only).

## Layout

- App shell: sticky topbar (`--topbar-height: 48px`) + workbar (44px), left nav
  rail (56px icon mode / 212px pinned via `.shell.nav-pinned`), single scrolling
  content column. The rail's nav list (`.tab-scroll`) scrolls independently;
  its footer (pin toggle, Docs, Shortcuts) is fixed below it.
- Content grids are per-page (`.tab-grid`, `.metrics-grid`, `.artifact-workspace`,
  `.detail-body-grid`). The run-detail grid is `minmax(0,1fr) minmax(260px,.45fr)`
  with a **sticky side rail** (`.detail-side-rail`, top = topbar + 12px,
  max-height = viewport − topbar − 24px, scrolls its own overflow).
- Analysis headers (`.analysis-header`) are flex with `flex-wrap: wrap`; the
  title block gets `flex: 1 1 280px` so the stat strip wraps below rather than
  crushing the title. Never let a stat strip overlay a sibling title.

## Design Tokens (single source: `apps/web/app/styles/tokens.css`)

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg` | `#0d0f0c` | `#f6f7f3` | page canvas (dark adds 26px dot grid via `--bg-grid`/`--bg-grid-size`) |
| `--surface` / `--surface-soft` | `#121511` / `#171a15` | `#ffffff` / `#f4f6f0` | panels / wells |
| `--surface-selected` / `--surface-tint` | `#122419` / `#0f2a1d` | `#e6f7ec` | selected rows, reference rows |
| `--line` / `--line-strong` | `#20241d` / `#2e332a` | `#e0e3d8` / `#c8ccbc` | hairlines / emphasized borders, corner ticks |
| `--text` / `--muted` / `--faint` / `--dim` | `#e7eadf` / `#aab0a0` / `#8a9180` / `#79816d` | `#171a14` / `#555b4c` / `#5d644f` / `#8b9280` | text ramp; `--faint` is the floor for 11px informational text (AA) |
| `--accent` (+`-strong`,`-soft`,`-line`) | `#2be082` | `#16915c` | live, best, primary action, focus — **never decoration** |
| `--warn` / `--warm-soft` | `#f0b43e` | `#9c6f10` | warnings (pills, banners, drifting meters) |
| `--danger` / `--danger-soft` | `#f25555` | `#d23b3b` | failures, destructive |
| `--info` | `#4da3ff` | `#2d6fd1` | informational only |
| `--series-1..6` | bright set | darkened set | CSS series ladder; JS `CHART_PALETTE` (12, `src/chart-colors.js`) is theme-agnostic, every color ≥3:1 on white **and** dark (unit-enforced in `chart-colors.test.js`) |
| `--radius` / `--radius-sm` / `--radius-lg` / `--radius-pill` | 6px / 4px / 10px / 999px | same | v1.1 soft-precision geometry; chips are capsules |
| `--font-mono` / `--font-ui` | Spline Sans Mono / Archivo | same | mono = all data, labels, nav, numerals; Archivo = headings/prose |
| `--tracking-eyebrow` | `0.14em` | same | uppercase mono micro-labels |
| `--shadow` | `0 8px 24px rgba(0,0,0,.55)` | subtle | popovers only — panels use hairlines, never shadows |

Rules: route every color/radius/font through tokens; no new semantic colors
without a new *meaning*; numerals always `font-variant-numeric: tabular-nums`.

## Components (signature layer: `apps/web/app/styles/instrument.css`)

| Component | Key classes | Notes |
|---|---|---|
| Panel bezel | `.metric-card`, `.workspace-panel-card`, `.workspace-section` | corner registration ticks via `::before/::after`, inset 4px (inside the 6px curve), `--line-strong` → `--accent` on hover |
| Stat tile | `.metric-card` + tone (`good/bad/live/neutral`) | label = uppercase mono micro-label; value = 22px mono tabular; `live` tone is green; zero-failures is `neutral`, never green |
| Stat strip | `.analysis-stat-strip` | `flex: 1 1 auto; min-width: 0` beside titles; `.artifact-stat-strip` variant spans full width when alone |
| Status pill | `.pill` + `live/good/bad/warn/neutral` | uppercase mono 10.5px capsule; live=green wash, good(finished)=quiet hairline, warn=amber wash, bad=red wash |
| Rail item | `.tab-button` | mono 12px; active = green left edge + `--accent-soft` gradient wash; pin toggle (`.nav-pin-button`) is deliberately neutral even when active |
| Section head | `.detail-section h3`, `.workspace-panel-head h3`, `.detail-section summary` | uppercase mono 11px micro-label, `--muted` |
| Buttons | `button`, `.primary-button`, `.secondary`, `.ghost` | primary = flat `--accent-soft` wash + accent text (no gradients); disabled = muted surface always, even destructive |
| Status banner | `.status-strip` (+`.loading`) | quiet info banner: surface-soft, hairline, mono 12px, leading info/accent dot; wraps, never clips |
| Status message (workbar) | `.status-message` | wraps up to 420px; auto height |
| Tables | `.dtable`-style + `.col-*` | identifiers + numerals mono; numerics right-aligned; row hover = `--surface-hover` only (never recolors text); selected = `--surface-selected` + 2px accent inset |
| Empty states | `.artifact-empty-state` pattern | centered icon + bold title + one sentence + mono SDK snippet; one consolidated empty per page, never stacked empties |
| Code/config wells | `.codewell`-style, `.docs-route-code` | `white-space: pre`; docs code bodies stay dark in both themes (`!important` guard against the injected syntax theme) |

## States and Interactions

| Element | State | Behavior |
|---|---|---|
| Panel | hover | corner ticks turn `--accent` (200ms `cubic-bezier(.2,.9,.25,1)`) |
| Table row | hover / selected | surface raise / green inset edge + tint; text color never changes |
| Run name (table) | click | sets inspected run **and** navigates to run detail (same as rail OPEN) |
| Primary button | hover | `--surface-tint` fill, `--accent` border |
| Inputs/selects | focus | accent border + 2px `--accent-soft` halo; `:focus-visible` global = accent outline, offset 2px |
| Dropdown option | selected | `--accent-soft` bg + `--accent-strong` text |
| Compare reference row | hover | `--surface-tint` (theme-aware; never a dark flood in light mode) |
| Workspace mode switch | automatic → manual | seeds manual board from current panels — never presents an empty board; undo available |
| Chart series (n) | n>4 / >8 / >24 / >60 | stroke opacity ramp 0.82 / 0.72 / 0.6 / 0.45; hover isolates one series, others fall to muted opacity |
| Chart x-axis = time | render | points re-sorted by timestamp per series (step interleave produces spaghetti otherwise) |
| Live entities | always | pulse/green only while running; finished decays to neutral |

## Responsive Behavior

| Breakpoint | Changes |
|---|---|
| >1400px | full topbar with utility icons separated by hairline |
| ≤1400px / ≤1360px | utility icons collapse; topbar selects shrink (`dashboard.css` media rules) |
| ≤1081px | topbar control stacking changes |
| ≤900px (`mobile.css`) | compact dashboard: rail becomes drawer (`.shell.mobile-nav-open`), stat strips stack, panels single-column |
| Short viewports | nav rail list scrolls within `.tab-scroll` (visible `--line-strong` thumb); analysis stat strips wrap under titles |

## Edge Cases

- **Empty**: one consolidated empty state per page (icon + title + sentence +
  SDK snippet). Backend-capability gaps degrade to a quiet `.status-strip`
  ("Reports aren't available on this backend yet") with actions disabled —
  never a red error banner over an intact empty state.
- **Tiny values**: metric tables use `formatMetricValue()` (`src/state.js`) —
  scientific notation below the rounding threshold so `lr=3e-4` never reads "0".
  One number = one precision everywhere it appears (KPI strip, table, timeline).
- **Acronyms**: `metricTitle()` upper-cases KL/LR/RL/GPU/CPU/SDK/API/PPO/DPO/SFT/EMA.
- **1,000+ runs**: lists paginate at 100/page; verified at 1,000 runs / 198k
  points — initial render long-task max ~158ms, search <1s. Charts cap plotted
  series per page and engage the dense-chart path beyond the palette size.
- **Long names**: ellipsize with `title` tooltip; never break numbers
  (`white-space: nowrap` + tabular nums on value cells, e.g. `.summary-row`).
- **Session expiry**: status banner wraps (no clipped UUIDs); the sign-in link
  preserves the full path + query. (Full re-auth dialog: follow-up task.)

## Animation / Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Panel ticks | hover | border-color | 200ms | `cubic-bezier(.2,.9,.25,1)` |
| Buttons/controls | hover | color/border | 120–150ms | ease / snap |
| Series emphasis | rail/legend hover | opacity | 120ms | ease |
| Loading screen | mount | shell rise + detail fade | 420/500ms | ease-out / snap |
| Live pulse | while running | ping ring | 2.2s loop | snap |

All motion is disabled under `prefers-reduced-motion` (mockup layer; honor it
for any new product animation). The pulse is the only permitted infinite loop.

## Accessibility Notes

- Focus: global `:focus-visible` accent outline (2px, offset 2px); inputs add a
  soft halo. Keyboard order: topbar → filter bar → rail → content. Known gap
  (follow-up): closing menus with Escape should return focus to the trigger.
- Charts: every SVG carries `role="img"` + `aria-label` (metric key); the range
  scrubber is labeled for drag-to-zoom.
- Severity/status never relies on color alone: pills pair color with uppercase
  text labels; deltas pair color with ▲/▼.
- Contrast: `--faint` is the floor for informational text (≥4.5:1 at 11px);
  chart palette ≥3:1 non-text contrast on both themes, enforced by unit test.
- Tables for screen readers: dataset/health "tables" are currently div-based —
  add `role="table"/"row"/"cell"` when touching them (flagged in QA).

## Known follow-ups (out of handoff scope, tracked)

Backend `/api/reports` mounting (staging), URL-as-source-of-truth view state,
global 401 re-auth dialog, table-view column sorting + pagination footer,
legend "+N more" overflow, collapsed run-rail rebuild, metric-catalog
truncation tooltips, insights degenerate-config banner, docs light syntax theme.
