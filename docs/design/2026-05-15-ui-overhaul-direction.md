# UI Overhaul — Research and Direction

Date: 2026-05-15

Status: Draft for review (not yet accepted)

Owner: Design Engineering

## Summary

The dashboard has the right *features* but not the right *form*. The current shell is a monolithic Next.js page (~6k LOC across two files) styled with one hand-rolled CSS sheet, while the public brand and the competitor (Pluto / mlop-ai) are both built on a much tighter design system. This memo records what I found across the codebase, the [public site](https://instantml.ai/), and the [Pluto demo](https://demo.pluto.trainy.ai/o/dev-org), then proposes a medium-scope overhaul:

1. **Restructure the shell** from two monolithic files into a small set of domain modules and a thin primitives library.
2. **Lock down a visual system** (tokens, type scale, density, chart styling) that matches the [public landing](https://instantml.ai/) — confident dark, emerald accent, sans + italic-serif emphasis, mono labels.
3. **Re-architect the topbar and run workspace** so the chrome stops competing with the data.

No backend or API contracts change. The existing routes, localStorage keys, and feature surface stay.

## What I Looked At

Local app, signed in as the shared demo (`hello@instantml.ai`, `InstantML Demo` org) after seeding 1,000 demo runs through `POST /api/demo/reset` on the Rust API at 127.0.0.1:8000:

- [`/dashboard/runs`](http://localhost:3000/dashboard/runs) — runs workspace with rail + panel canvas
- [`/dashboard/metrics`](http://localhost:3000/dashboard/metrics) — three-pane metric inspector
- [`/dashboard/detail`](http://localhost:3000/dashboard/detail) — Pluto-style run workspace (Summary / Data / Logs / Files / System / Graph)
- [`/dashboard/compare`](http://localhost:3000/dashboard/compare) — row-first compare matrix
- [`/dashboard/artifacts`](http://localhost:3000/dashboard/artifacts)
- [`/dashboard/alerts`](http://localhost:3000/dashboard/alerts)
- [`/dashboard/reports`](http://localhost:3000/dashboard/reports)
- [`/dashboard/api`](http://localhost:3000/dashboard/api)
- [`/dashboard/settings`](http://localhost:3000/dashboard/settings)

Plus the [public landing](https://instantml.ai/), the [Pluto demo](https://demo.pluto.trainy.ai/o/dev-org) (Home / Project / Run-Data / Run-Summary / Run-Logs / Run-Files), and the [mlop-ai/web](https://github.com/mlop-ai/web/tree/8b9a6eeacd31f7bad2cd8e8eaa43dd666a440b62) codebase at the pinned commit.

## Current State

### Code architecture

The active app is concentrated in two files plus one CSS sheet:

| File | Lines | Role |
| --- | ---: | --- |
| [app/dashboard-components.tsx](apps/web/app/dashboard-components.tsx) | 3,486 | ~34 exported components — every surface |
| [app/dashboard/dashboard-shell.tsx](apps/web/app/dashboard/dashboard-shell.tsx) | 2,465 | Routing, data fetch, state, all tabs |
| [app/globals.css](apps/web/app/globals.css) | ~3,500 | Every selector in the product |
| [app/dashboard-models.ts](apps/web/app/dashboard-models.ts) | 653 | View-model helpers |
| [app/dashboard-types.ts](apps/web/app/dashboard-types.ts) | 260 | Types |

No component library, no Radix primitives, no Tailwind, no token export. Hand-rolled `CustomSelect`, modal, focus-trap, drawer. Strings of `instantml:next:*` `localStorage` keys are pulled inline from the shell.

### Visual system

[`app/globals.css`](apps/web/app/globals.css) defines a working but ad-hoc token set:

```
--bg / --surface / --surface-soft / --surface-tint
--line / --line-soft
--text / --muted / --faint
--accent (#34d399 dark / #059669 light) / --accent-strong / --accent-soft
--blue / --amber / --coral / --green / --warm / --danger
--chart-card-bg / --chart-grid / --chart-axis
--radius 6px / --control-radius 4px / --tight-radius 3px
--topbar-height 74px
```

Font is `Geist`. Buttons default to `font-weight: 680` and `min-height: 32px`. Accent emerald is consistent, but density, radii, and weights vary surface to surface.

### Per-surface observations from the playthrough

**`/dashboard/runs` (Runs workspace).** The topbar packs Project select, Status select, Operational chip, filter status, Reset demo, Name input, Save view, View select, help, theme, and avatar into one 74px row — eleven controls competing for attention. Below that is a 5-stat band (Total / Active / Failed / Best metric / Metric points), then a second filter row (search / Newest / metric select / Columns / refresh), then the rail-and-canvas. The chrome above the canvas is ~200px tall before any data appears. Run rail rows are tall: status dot + bold mono name + `demo · seed 36970 · lr 0.00010` line + tag chips + truncated note preview = ~80px per row. The chart panel itself is clean and dense, with red/blue-first series and thin strokes per the recent reschema doc.

**`/dashboard/metrics`.** Three-pane: catalog (left) / chart + controls (center) / signal context + best-leaderboard (right). The information design here is the strongest in the app — eyebrow + headline + 3 stat columns reads as a real product header, not a toolbar.

**`/dashboard/detail`.** Pluto-style sticky run header with local Summary / Data / Logs / Files / System / Graph tabs. Logs render as a clean timestamp+line table with safe ANSI; Files is a left-tree + right-preview explorer keyed off checkpoints / rich objects / files. This surface is closest to the desired direction already.

**`/dashboard/compare`.** Strong eyebrow + count header, dense row matrix with reference highlight + delta column. Compare and Metrics are the most coherent surfaces today.

**`/dashboard/artifacts`, `/alerts`, `/reports`, `/api`, `/settings`.** All share the same "list + right sidebar of stats" template, which is reasonable, but the global topbar is the wrong thing for these views — every secondary tab still shows the runs filter banner, "Reset demo," "Save view," and the run-count chip, even though those controls have no meaning on `/settings`.

## Brand Reference — instantml.ai

The public site is the source of truth for "what InstantML feels like."

**Palette (dark, default):**
- Background `#07080c`, with a fixed faint cyan/teal grid pattern and a soft radial emerald glow centered upper-third
- Surface `#0d0f15`, elevated `#12141c`, border `#1c1f2a`
- Text `#f8fafc`, muted `#94a3b8`
- Accent `#34d399` (filled buttons, brand mark, hot-path emphasis)
- Warm `#e0b07a` (italic-serif emphasis spans, "Object storage" diagram label)
- Status quo / negative `#f87171` (red label tone, used very sparingly)

**Type system:**
- Primary sans (heavy weight, tight tracking) — `Geist` / Inter family
- *Italic serif* for emphasis fragments inside headlines: "One pip install. *Three SDK calls.*", "The old tools work. *They're just slow.*" — this is the most distinctive treatment on the site
- Monospace uppercase for eyebrows and labels: `WHY TEAMS SWITCH`, `PROJECT SUMMARY P95`, `STATUS QUO`, `INSTANTML`
- Large display numerals for benchmarks: `78 ms`, `118 ms`, `387 ms`

**Compositional moves:**
- Numbered comparison cards: `01 / 02 / 03` in italic serif top-left, status label top-right in mono uppercase
- ASCII-flavored architecture diagram (dashed borders, monospaced labels, dashed arrows)
- Pill CTAs: emerald-filled primary with right-arrow icon, ghost outlined secondary
- Cards have very faint borders (one-pixel `#1c1f2a`), no shadows, ~16-20px radius for hero cards but very low radius for inline chips/buttons

The vibe is *engineering brutalism* — confident, dark, dense, restrained color. Italic-serif emphasis and the grid/glow background are the two motifs that read instantly as "InstantML" rather than generic Geist-on-black.

## Competitor Reference — Pluto / mlop-ai

**Demo product.** [Pluto's](https://demo.pluto.trainy.ai) IA is org-scoped: `/o/:slug/{dashboard | projects | settings}` and `/o/:slug/projects/:name/:runId/{summary | data | logs | system | graph}`. The project view is a single screen with a left run table + right chart canvas; the run view uses an icon-only inner sidebar (Info, Chart, Terminal, Folder, Cpu, Tree). Tags are rectangular gray pills; "Completed" is a green pill; status uses a colored dot. Inside Run Summary, run metadata is shown as a 3-column grid of card-tiles (Run Name / Run ID / Project — each with label + value), then a Configuration JSON tree. Files is a unified tree of `METRICS / EVAL / TRAIN / FILES`, doubling as an evidence explorer.

The Pluto chrome is noticeably *less* than InstantML's. The top is just breadcrumbs + Invite User + chat / notifications. No persistent filter banner, no demo reset button, no save-view widget.

**Code architecture** ([mlop-ai/web @ 8b9a6e](https://github.com/mlop-ai/web/tree/8b9a6eeacd31f7bad2cd8e8eaa43dd666a440b62)):
- **Vite + React 19**, file-based routing via **TanStack Router**
- **shadcn/ui** primitives over **Radix UI** (alert, avatar, button, calendar, card, checkbox, collapsible, command, dialog, drawer, dropdown-menu, hover-card, popover, scroll-area, select, separator, sheet, sidebar, skeleton, slider, switch, tabs, tooltip, ...)
- **Tailwind v4** with `@theme` directive driving HSL CSS variables
- **TanStack Query / Table / Virtual**, **tRPC**, **Dexie** for local cache, **better-auth**
- **ECharts** for charts, **cmdk** for command palette, **xyflow + dagre** for graph view, **Remix Icons** for icons
- Component layout: `components/{ui,layout,core,charts}` with `layout/{dashboard,run,runComparison}/{layout,sidebar}.tsx`

The takeaway is not "use their stack" but "their primitive surface area is doing real work for them" — every Tooltip, DropdownMenu, Dialog, and Sidebar in their app is one accessible, themable, predictably-shaped component. Ours is N hand-rolled variants.

## The Gap

| Dimension | Today | Where we want to be |
| --- | --- | --- |
| Code | 2 files / 5,951 LOC for the entire dashboard | ~10 domain modules + a primitives folder |
| Primitives | Hand-rolled `CustomSelect`, modal, focus-trap, drawer | Radix-based primitives (Select, Dialog, DropdownMenu, Popover, Tooltip, Tabs, ScrollArea), 1 file each, shared a11y |
| Visual identity | Generic dark + emerald + Geist | + italic-serif emphasis, mono eyebrows/labels, soft grid + glow background, numbered comparison patterns from the site |
| Topbar | 11 controls in 74px, same on every tab | Compact brand + breadcrumb + global utilities; tab-scoped controls move *into* each surface's header |
| Run rail | ~80px verbose rows | ~44px Pluto-style rows (status dot · mono name · tags as overflow chips); note preview becomes hover only |
| Density | First useful data appears ~200px below the topbar on `/runs` | First useful data within ~120px |
| Settings/Reports/Alerts/API tab chrome | Inherit the runs filter banner | Get their own subheader; runs banner is workspace-scoped |
| Surface naming | "Run Detail" appears as a global tab even though Pluto-style local tabs already live inside it | Run workspace is reached *through* a run, not as a global tab; the `detail` global tab is collapsed into a "last opened run" entry point |

## Proposed Direction

### 1. Visual system

Lock the brand tokens into typed exports (one source). Match the public site:

```
// app/styles/tokens.ts (new)
export const colors = {
  bg: { dark: "#07080c", light: "#ffffff" },
  surface: { dark: "#0d0f15", light: "#ffffff" },
  surfaceElevated: { dark: "#12141c", light: "#f8fafc" },
  surfaceSoft: { dark: "#0a0c12", light: "#f8fafc" },
  line: { dark: "#1c1f2a", light: "#e2e8f0" },
  lineSoft: { dark: "#151923", light: "#eef2f7" },
  text: { dark: "#f8fafc", light: "#0f172a" },
  muted: { dark: "#94a3b8", light: "#475569" },
  accent: { dark: "#34d399", light: "#059669" },
  accentStrong: { dark: "#6ee7b7", light: "#047857" },
  warm: { dark: "#e0b07a", light: "#b7791f" },
  danger: { dark: "#f87171", light: "#dc2626" },
};
```

`globals.css` keeps emitting CSS variables, but the values come from the token module so the future (already-discussed) Tailwind/Radix swap doesn't have to relitigate brand.

**Type scale (px):** 11 / 12 / 13 / 14 / 16 / 20 / 28 / 40. Eyebrow uses 11-12 mono uppercase + 0.08em tracking. Page headlines use 28-40 sans with italic-serif emphasis spans for personality. Body and table rows stay at 12-13. Adopt the landing's italic-serif via `@font-face` (or system serif fallback) on a single `.brand-emphasis` class. Use it sparingly: page headlines on Run Detail, Compare, the empty states. Not in tables.

**Density:** baseline row height 32px for inputs/buttons, 44px for run-rail rows, 28px for log/table rows, 24px for inline status chips. Topbar collapses from 74px to 48px. Each tab gets its own ~48-56px subheader where appropriate.

**Chart palette:** keep the recent reschema choice — red/blue first, then emerald/warm/purple. Strokes ≤1.25px, opacity ~0.9, gridlines `--chart-grid` at 6% lightness against background, point markers only at hover or capped density.

**Background motif:** the `body` of authenticated dashboard pages picks up the same `radial-gradient` + linear grid the public site uses, but at lower contrast (5-8% emerald glow, 2% grid). It anchors brand without affecting data legibility.

### 2. Information architecture

Today's global nav has 12 tabs in three groups. After this overhaul:

```
Core             Workspace          Admin
─────            ─────              ─────
Runs             Reports            Settings
Metrics          Datasets           Integrations
Compare          Artifacts          API
                 Models
                 Alerts
```

Changes:

- **Drop `Run Detail` as a global tab.** Runs and Compare both deep-link to it; the global tab is empty unless you've been there. Replace with a "Last opened" affordance in the run rail and breadcrumbs.
- **Move `Reports / Datasets / Artifacts / Models / Alerts` into a single "Workspace" group** (they are all consumer surfaces of selected runs/projects).
- **Settings / Integrations / API stay** as the admin group.

### 3. Topbar redesign

Replace the current 11-control topbar with a thin two-row chrome on workspace surfaces only:

```
┌─ row 1 (48px) ──────────────────────────────────────────────────────────────┐
│ ●● InstantML │ demo / Runs                       ⌘K  ☀  AK ▾               │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ row 2 (workspace-scoped, 44px) ────────────────────────────────────────────┐
│ Project ▾  Status ▾  Search...     Newest ▾  Columns ▾  Save view  View ▾ ↻ │
└──────────────────────────────────────────────────────────────────────────────┘
```

Admin tabs (`/settings`, `/integrations`, `/api`) drop row 2 entirely and replace it with a tab-specific subheader. Reset Demo moves to Settings → Workspace where it belongs.

### 4. Run rail compaction

Today each rail row shows: status dot, mono name, second-line config string, tag chips, note preview = 4 lines per row. After:

- One line: `● rl-ppo-cartpole-seed-36970` (status dot + mono name)
- Hover/expand to reveal config string, tags as chips, note preview
- Selected row keeps a left-edge accent rail, not a full-card border

This unlocks ~2x more rows visible in the rail without scrolling, which is the W&B-parity baseline the README already aims for.

### 5. Shell restructure

Break `dashboard-components.tsx` (3,486) and `dashboard-shell.tsx` (2,465) into clearly-named modules under `apps/web/app/dashboard/`. Keep both files temporarily as compatibility re-exports during the cut.

Proposed layout (filenames only — no design changes yet, just decomposition):

```
apps/web/app/dashboard/
  shell.tsx                    ← top-level DashboardShell, no JSX trees > ~300 LOC
  state/
    use-dashboard-state.ts     ← consolidated state hook (selection, view, runs)
    use-saved-views.ts
    use-workspace-layout.ts
    storage-keys.ts            ← single source of `instantml:next:*` keys
  chrome/
    topbar.tsx                 ← row 1
    workspace-subheader.tsx    ← row 2 (workspace surfaces only)
    nav-rail.tsx
    quick-search.tsx
    shortcut-help.tsx
  runs/
    runs-workspace.tsx
    run-rail.tsx
    run-rail-row.tsx
    runs-table.tsx
    workspace-panel-card.tsx
    panel-edit-drawer.tsx
  metrics/
    metric-inspector.tsx
    metric-catalog.tsx
    metric-leaderboard.tsx
    metric-chart.tsx           ← extract from current MetricChart
    hover-detail.tsx
  detail/
    run-workspace.tsx          ← already exists, keep
    sections/{summary,data,logs,files,system,graph}.tsx
  compare/
    compare-shell.tsx
    compare-matrix.tsx
    compare-run-rows.tsx
    compare-summary.tsx
  artifacts/
  reports/
  alerts/
  datasets/
  models/
  settings/
  integrations/
  api/
  ui/
    select.tsx                 ← thin wrapper over CustomSelect today; can swap to Radix Select later
    modal.tsx
    drawer.tsx
    tabs.tsx
    tooltip.tsx
    chip.tsx
    button.tsx                 ← named variants instead of class strings
    icon-button.tsx
    use-focus-trap.ts
```

**No new dependencies in step 1.** Today's hand-rolled primitives keep working; the wrappers just centralize them. Adopting Radix can come later as a follow-up design doc, with the wrapper API designed to absorb it without churning callers.

`globals.css` stays for now but loses everything that's properly component-scoped to per-component co-located CSS modules or styled blocks. Aim: `globals.css` <1k LOC, tokens + resets + landing-page styles only.

### 6. Phased plan

Each phase ships and tests independently. Each is `npm run test:node` + `npm run web:build` + `npm run test:ui` clean before the next starts.

| Phase | Scope | Risk | Smoke impact |
| --- | --- | --- | --- |
| 0 | This memo, design doc, token export | None | None |
| 1 | Shell decomposition (file moves + compatibility re-exports), no visual change | Low — guarded by `test:ui` | None |
| 2 | Topbar redesign, run-rail compaction, removal of `Run Detail` global tab | Medium — quick search and saved-view paths touch this | Update selectors |
| 3 | Visual system pass: typography (italic-serif emphasis), background motif, density, mono eyebrows | Medium — visual regression surface | Visual diff acceptable |
| 4 | Settings / Integrations / API / Reports / Alerts subheader cleanup | Low | Light |
| 5 | Primitives folder seeded with current components, wrapper APIs documented; Radix migration deferred to its own doc | Low | None |

### 7. What I'd *not* do in this overhaul

- Migrate to Tailwind / Radix / shadcn in the same PR. Tempting (the mlop-ai stack proves the value) but blows the blast radius. Treat that as a separate design doc once the wrapper APIs in step 5 are stable.
- Rewrite charts. The recent `2026-05-14-instantml-rescheme-and-chart-polish` doc already locked the chart direction; this overhaul respects it.
- Change any API contract, route, or `localStorage` key.
- Touch the SDK or backend.

### 8. Open questions for you

1. **Italic-serif emphasis** — do we own the public-site font, or do we need to ship a system-serif fallback? (Affects whether this becomes part of phase 3 or phase 4.)
2. **"Run Detail" tab removal** — happy to drop it, or keep it pointed at the last-opened run for muscle memory?
3. **Compact rail rows** — note previews disappear by default. Keep the search-as-you-type tokenized search behavior in place to compensate?
4. **Scope of phase 1** — do we want compatibility re-exports from `dashboard-components.tsx` for a release, or do we cut imports in the same PR?

## Appendix — Screenshots captured during the playthrough

Saved by Chrome MCP during this session:

- instantml.ai hero / metrics band / SDK section / Why-teams-switch (`ss_89001rwbe`, `ss_1473vzq3s`, `ss_1922xh0al`, `ss_2398cr61q`)
- Pluto dashboard / project / run-summary / run-logs / run-files (`ss_263736byb`, `ss_5991mufwd`, `ss_1308ik2th`, `ss_9753fal0h`, `ss_19471strz`)
- Local InstantML signin / onboarding / runs / metrics / detail / compare / artifacts / settings / alerts / reports / api / detail-logs / detail-files (`ss_72436g84p`, `ss_4316w0a0i`, `ss_7411objww`, `ss_8757v1w5n`, `ss_6061cc0hx`, `ss_0453nb6ug`, `ss_1554xogvx`, `ss_46374jxv3`, `ss_7649godit`, `ss_6683yp5vk`, `ss_97170gxz2`, `ss_417987e2u`, `ss_16601u4wd`)
