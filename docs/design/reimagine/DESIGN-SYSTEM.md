# Instrument — the InstantML design system

> Design language for the reimagined InstantML training-observability platform.
> Lives alongside the reference implementation: `tokens.css`, `app.css`, `charts.js`, `shell.js`,
> and five reference screens (`overview.html`, `runs.html`, `run-detail.html`, `metrics.html`, `health.html`).
> Serve the folder statically (`python3 -m http.server`) to browse them.

---

## 1. Design language

**Instrument** treats the product as a flight recorder for training runs: a dark
control room where every number is telemetry and every accent color is a signal.
Influences: Grafana's panel density, W&B's run-centric workflow, aerospace
instrument bezels.

Four rules govern every screen:

1. **Mono carries data, Archivo carries prose.** Anything that is a value, label,
   identifier, or unit is set in Spline Sans Mono. Page titles, body copy, and
   descriptions use Archivo. If you can sort it, filter it, or copy it into a
   terminal — it's mono.
2. **Green means live.** `--signal` is reserved for things happening *right now*
   (running jobs, streaming data, primary actions) and best-yet values. It is
   never decoration. If everything is green, nothing is live.
3. **Hairlines, not shadows.** Structure comes from 1px borders and surface
   steps, not drop shadows. The only glow allowed is the phosphor glow on live
   chart series and the pulse ring on live dots.
4. **Dense, but never cramped.** 36px table rows, 4px spacing base, 12px panel
   gutters. Density is earned by removing chrome, not by shrinking text below
   legibility (data text never goes under 10px).

**The signature moves** (what makes a screen recognizably Instrument): the live
telemetry ticker pinned to the top of every page, corner registration ticks on
panels, pulsing dots on live entities, and uppercase tracked micro-labels on
every panel bezel.

---

## 2. Design tokens

All tokens live in `tokens.css` on `:root`. No component may hardcode a color,
font, or radius — everything routes through tokens.

### 2.1 Surfaces (warm graphite ramp)

| Token | Value | Use |
|---|---|---|
| `--bg-void` | `#080907` | App backdrop: ticker, rail |
| `--bg-canvas` | `#0d0f0c` | Main content canvas (carries the dot grid) |
| `--bg-panel` | `#121511` | Default panel surface |
| `--bg-panel-raised` | `#171a15` | Hover rows, raised surfaces |
| `--bg-inset` | `#0a0c09` | Wells: inputs, code, log tails, chart plots |
| `--bg-flood` | `rgba(43,224,130,.05)` | Selected-row wash |

The ramp is deliberately warm (green undertone), never blue-black. Depth = one
step up the ramp; never stack more than one step.

### 2.2 Lines

| Token | Value | Use |
|---|---|---|
| `--line-hair` | `#20241d` | Default 1px borders, row dividers |
| `--line-strong` | `#2e332a` | Emphasized borders, corner ticks, table header rule |
| `--line-grid` | `#1a1d17` | Chart gridlines only |

### 2.3 Text ramp

| Token | Value | Use | Contrast on `--bg-panel` |
|---|---|---|---|
| `--text-hi` | `#e7eadf` | Values, names, headings | ~13:1 |
| `--text-mid` | `#aab0a0` | Body, secondary cells | ~7:1 |
| `--text-dim` | `#848c78` | Micro-labels, units, axis ticks | ~4.6:1 |
| `--text-faint` | `#4d5345` | Decorative only — never information |

Rule: `--text-faint` may never carry meaning a user needs; it exists for
ornament (separators, ghost comparison series).

### 2.4 Signal colors (semantic)

| Token | Value | Meaning |
|---|---|---|
| `--signal` / `--signal-bright` / `--signal-dim` | `#2be082` family | Live, healthy, best-yet, primary action |
| `--warn` / `--warn-dim` | `#f0b43e` | Degraded, lagging, schema changed |
| `--crit` / `--crit-dim` | `#f25555` | Firing, crashed, NaN, threshold breach |
| `--info` / `--info-dim` | `#4da3ff` | Informational events |
| `--idle` | `#848c78` | Finished / neutral status |

`*-dim` variants (13% alpha) are the only legal chip/badge backgrounds — solid
semantic fills are reserved for dots and meters.

### 2.5 Chart series palette

`--s1` … `--s8`: green, cyan-blue, amber, magenta, violet, coral, teal,
chartreuse. Assignment is positional and stable within a view. `--s1` (signal
green) always goes to "the run you care about" — the focused, newest, or live
run. Comparison baselines (e.g. a parent fork) use `--text-faint` with a `4 4`
dash, not a palette slot.

### 2.6 Typography

| Token | Value |
|---|---|
| `--font-mono` | "Spline Sans Mono" — all data, labels, nav, tables, numerals |
| `--font-display` | "Archivo" — page titles, prose |

Scale: `--fs-micro` 10px (uppercase labels) · `--fs-data` 12px (cells, chips) ·
`--fs-body` 13px (prose) · `--fs-title` 15px · `--fs-page` 20px ·
`--fs-stat` 26px (big numerals). Uppercase mono labels always take
`letter-spacing: var(--track-micro)` (0.14em). Numerals are tabular
(`font-variant-numeric: tabular-nums`) everywhere they can be compared.

### 2.7 Geometry & motion

- Radius: one token, `--r: 6px` (v1.1 — softened from the original 3px after
  user feedback that the system read too sharp). Status chips may take full
  capsule radius in product. Corner registration ticks inset 4px so they float
  inside the curve instead of colliding with it.
- Spacing: 4px base scale (`--sp-1` 4 → `--sp-6` 32). Panel gutter is `--sp-3` (12px); grid gap is 12px.
- Shell dimensions: `--rail-w` 224px, `--ticker-h` 38px, `--row-h` 36px.
- Motion: `--ease-snap` `cubic-bezier(.2,.9,.25,1)`. Page load = single staggered
  rise (`.rise`, 450ms, 40ms stagger). Hover transitions 100–200ms. The only
  infinite animations are the live pulse ring (2.2s) and nothing else.
  All animation is disabled under `prefers-reduced-motion`.

---

## 3. Components

### 3.1 Shell

Fixed grid: ticker (top, full width) / rail (left) / main canvas. The main
canvas is the only scroll container and carries a 26px dot-grid texture at
2.5% opacity.

**Telemetry ticker** (`.ticker`) — the system's signature. Always present.
Left: pulsing `LIVE n` count. Middle: one chip per running run (short name,
52×14 sparkline, ▲/▼ delta in signal/crit). Right: ingest rate, lag, UTC clock
(live). Content is mono 11px; the feed scrolls horizontally without a visible
scrollbar. Deltas: ▲ green = improving, ▼ red = regressing, — dim = no metric.

**Nav rail** (`.rail`) — brandmark + project selector, then sections
(`Operate / Data / System`) of `.nav-item`s. Active item gets a 2px signal-green
left edge, a green icon, and a `signal-dim → transparent` gradient wash. Count
badges right-align; alert counts use `.is-alert` (crit red). Footer: avatar,
user, version.

### 3.2 Panel — the instrument bezel

```html
<div class="panel">
  <div class="panel__head">
    <span class="mlabel">eval/return_mean — active runs</span>
    <span class="panel__unit">step</span>
  </div>
  <div class="panel__body panel__body--chart">…</div>
</div>
```

- Corner **registration ticks** (7px, top-left + bottom-right) are drawn via
  `::before/::after` and turn signal-green on hover. Never remove them; they are
  the panel's identity.
- Head is 36px min, contains exactly one `.mlabel` (the metric/section name,
  lowercase metric paths preserved) plus optional right-side furniture: a unit
  (`.panel__unit`), a status chip, or a quiet "View all →" link in signal green.
- Body variants: default (12px padding), `--flush` (tables/feeds), `--chart`.

| State | Visual |
|---|---|
| Default | `--bg-panel`, hairline border, dim corner ticks |
| Hover | Corner ticks → signal green |
| Live content | Add `.chip--live` to the head, never recolor the panel |

### 3.3 Micro-label (`.mlabel`)

The most-used primitive: 10px mono, uppercase, 0.14em tracking, `--text-dim`.
Used for panel titles, table headers, breadcrumbs, section names, axis
furniture. Do not exceed ~40 characters; it ellipsizes.

### 3.4 Stat block (`.stat`)

Big tabular numeral (26px, `--text-hi`) + optional `<small>` unit in dim + one
delta line. Delta grammar: `▲` + `.up` (green) = metric moved in the *good*
direction, `▼` + `.down` (red) = bad direction, `—` + `.flat` = steady. The
arrow follows goodness, not arithmetic sign — a latency drop is `▼ … faster`
in green text via `.up`? **No** — use the arrow that matches the number's
direction and the color that matches goodness (see MTTA on `health.html`:
`▼ 38% faster`, green). KPI strips (`run-detail.html`) are stat blocks fused
into one bordered row.

### 3.5 Data table (`.dtable`)

36px rows, hairline dividers, header = micro-labels over a `--line-strong` rule.

| Cell class | Use |
|---|---|
| `.td-name` | Primary identifier, mono, `--text-hi`; dim id suffix inline |
| `.td-num` | Right-aligned tabular numerals |
| `.td-num.is-best` | Best value in column — signal green, semibold (max one per column) |
| `.td-dim` | Secondary mono text |

States: hover row → `--bg-panel-raised`; selected row → `--bg-flood` +
2px inset signal edge. Group rows (`.group-row`) are 28px inset-background
micro-label rows; omit aggregate stats that don't exist (never "best 0.0").
Sorted header: `.is-sorted` + green `▾`. Numeric columns are always
right-aligned; sparkline columns are 72–76px.

### 3.6 Chips, tags, dots

- `.chip` — uppercase 10px mono, 20px tall, `*-dim` background + 35% border.
  Variants: `--live` (green, may embed a small pulse), `--done` (borderless dim),
  `--warn`, `--crit`, `--info`. Used for statuses (`LIVE`, `FIRING`, `BEST`,
  severity levels).
- `.tag` — quiet inset-background metadata token (run tags, rule names). Never colored.
- `.dot` — 7px status dot: `--ok` `--idle` `--warn` `--crit` `--info`,
  `--queued` (outline only). `.pulse` is a dot with an infinite ping ring —
  **only** for live/running things, max a handful per screen.

### 3.7 Controls

- `.btn` — 28px, mono uppercase 11px, hairline border, transparent.
  `--primary`: signal-dim fill + green text (one per view, it's the verb of the
  page). `--ghost`: borderless until hover. `--icon`: 28px square. Destructive
  actions reuse the base button with crit border/text (see `Stop`).
- `.input` — 28px inset well; focus = signal border + 1px dim ring.
- `.query-token` — structured filter chips (`status: running ×`) with green
  key, used in the runs toolbar; removable via `×`.
- `.seg` — segmented control for small enums (time ranges, `Step/Time`,
  `Lin/Log`). One `.is-active` raised segment.
- `.tabs` / `.tab` — real `<button role="tab">`s; active = `--text-hi` + 2px
  signal underline; counts via `.tab__n`.
- `kbd` — keycap with thickened bottom border.

### 3.8 Feeds, logs, code

- `.feed-row` — severity dot + title (mono 12px hi) + meta (run · `.tag` rule) +
  right-aligned relative time. Used for alert feeds and per-run alerts.
- `.loglines` — `white-space: pre` mono 11px well; timestamps faint, severities
  colored (`.ok/.wr/.er`). Always inside a flush panel body.
- `.codewell` — `white-space: pre` config/YAML well with quiet syntax tint:
  keys dim, values hi, strings teal, numbers amber, comments faint italic.
  Inline diff annotations live in comments (`# ↑ was 2.5e-4 in 041`).

### 3.9 Specialty data displays

- `.meter` — 4px progress bar, signal fill (`--warn` variant for drifting).
- `.heatmap` — CSS-grid matrix. **Color only flags anomalies**: quiet cells are
  near-neutral (`rgba(231,234,223, .03–.08)`), amber from PSI ≥ 0.2, red from
  ≥ 0.4. Cells scale 1.12× on hover with a dim outline; values surface via
  `title`/tooltip.
- `.empty` — centered dim empty-state block.

---

## 4. Chart conventions (`charts.js`)

Hand-rolled SVG, no chart library. Four renderers: `line`, `spark`, `hist`, `scrub`.

**Axes & grid.** 10px mono axis type in `--text-dim`; 4 horizontal gridlines in
`--line-grid`; no vertical gridlines; no axis spines. SI-formatted ticks
(`31k`, `1.2M`, `3.0e-4`). Left gutter 50px, right 10px.
**If the data can't be negative, the y-axis floor is 0** — never let padding
imply negative loss or return.

**Series.** Live series: 1.6px stroke, phosphor glow (`drop-shadow` of its own
color), terminal dot on the last point. Historical series: 1.3px, no glow.
Comparison ghosts: `--text-faint` dashed. First series may take an area fill
(18% → 0 vertical gradient) when it's alone or clearly primary.

**Threshold bands.** Pass `band: <value>`; renders a dashed crit line at the
threshold and a 7% crit wash from the line to the **top of the plot**. The
threshold joins the y-domain; the wash never inflates it.

**Crosshair & tooltip.** Hover = dashed vertical crosshair + shared fixed
tooltip (`.chart-tip`): step header, then one row per series (color tick, name,
tabular value), nearest-point lookup.

**Sparklines.** 14–18px tall, single stroke; live sparklines get a terminal
dot and full opacity, finished ones render at 70% in `--text-faint`.

**Range scrubber.** Full-extent mini line in `--text-dim` with a signal-tinted
window and grab handles; align its left edge with the main chart's 50px gutter.

Every chart host gets `role="img"` and an `aria-label` (auto-generated from
series names if not provided).

---

## 5. Voice & formatting

- Metric names keep their raw paths (`eval/return_mean`) — never prettified.
- Numbers: tabular, SI-shortened in axes/tickers (`41.2k`), full precision in
  tables (3 decimals for losses, 1 for returns). Steps as `31,250 /40k`.
- Times: relative in feeds (`11m ago`), absolute UTC in the ticker and run headers.
- Labels are nouns, buttons are verbs, micro-labels are uppercase, everything
  else sentence case. `—` (em dash) is the universal "no data" mark.

## 6. Accessibility

- Text ≥ 12px holds ≥ 4.5:1 on its surface; `--text-dim` (4.6:1) is the floor
  for informational text; `--text-faint` is decorative only.
- Color never carries meaning alone: severity pairs color with a chip label
  (`CRIT`), status pairs dot color with text or position, deltas pair color
  with ▲/▼ glyphs.
- All interactive elements are native (`button`, `a`, `input`) with
  `:focus-visible` signal outline; tabs use `role="tab"`/`aria-selected`;
  series toggles use `aria-pressed`; charts expose `role="img"` + labels.
- Infinite animation is limited to the live pulse; everything honors
  `prefers-reduced-motion`.

## 7. Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| Reserve `--signal` for live/best/primary | Use green as a general accent or success confetti |
| One `--primary` button per view | Stack multiple filled buttons in a header |
| Right-align every numeric column, tabular figures | Center or left-align numbers |
| Clamp y-axes at 0 for non-negative metrics | Let axis padding invent negative loss |
| Keep quiet heatmap cells neutral | Paint healthy cells bright green |
| Put exactly one mlabel in each panel head | Title panels in Archivo or sentence case |
| Use `*-dim` washes for chip fills | Use solid semantic fills behind text |
| Show comparison baselines as faint dashes | Spend palette slots on ghosts |

## 8. Extending the system

When adding a component: pick the nearest primitive (panel / chip / table /
well), reuse its states, and route every value through tokens. New semantic
colors are forbidden until a fifth *meaning* exists (not a fifth place to put
color). New chart types must adopt the axis furniture, palette order, glow
rules, and tooltip from `charts.js`. If a screen needs a second font, the
answer is no.
