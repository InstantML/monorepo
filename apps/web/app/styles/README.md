# Stylesheets

Split from the original `globals.css` (11,348 lines) as part of the
2026-05-18 CSS audit. See `docs/design/2026-05-18-globals-css-audit.md`.

## File map

| File | Contents | Key selectors |
|---|---|---|
| `tokens.css` | Brand primitives + light/dark design tokens, including shared scrollbar tones | `:root`, `:root[data-theme="dark"]` |
| `base.css` | Global reset, typography, button defaults, global scrollbar styling | `body`, `button`, `h1-p`, `::-webkit-scrollbar` |
| `landing.css` | Marketing page + auth card | `.landing-*`, `.auth-*`, `.onboarding-*` |
| `dashboard.css` | Shell, topbar, tabs, nav rail | `.shell`, `.topbar`, `.tabs`, `.brand-mark` |
| `dashboard-runs.css` | Runs workspace rail and rows | `.runs-*`, `.workspace-run-*` |
| `panels.css` | Workspace panels, canvas, modals | `.workspace-panel-*`, `.panel-drawer` |
| `charts.css` | Metric charts, axes, series | `.metric-*`, `.chart-*`, `.axis` |
| `research.css` | Distributed and Insights dashboards | `.rank-*`, `.insights-*`, `.cluster-*` |
| `run-detail.css` | Run detail, KPIs, inspector | `.run-detail-*`, `.run-kpi-*`, `.inspector` |
| `compare.css` | Compare view, leaderboard | `.compare-*`, `.leaderboard-*` |
| `traces.css` | Traces dashboard list, tree, inspector, and filters | `.traces-*`, `.trace-*` |
| `objects.css` | Cross-run logged object explorer | `.objects-*` |
| `dark-overrides.css` | Dark-theme overrides (Phase 3 target) | `:root[data-theme="dark"] *` |
| `overhaul.css` | Visual overhaul layers 2026-05-15 (Phase 3 target), including account/workspace menu and create-workspace modal rules until those are folded into dashboard styles | Duplicated rules from all feature areas, `.account-workspace-*`, `.workspace-create-*` |
| `mobile.css` | Compact dashboard redesign ≤900px | `@media (max-width: 900px)` |
| `landing-system.css` | Landing visual system + animations | `.landing-root`, `.bento-*`, `@keyframes` |
| `docs.css` | First-party documentation route | `.docs-route-*` |

## Canonical tokens

Use `tokens.css` for shared typography, spacing, color, radius, shadow, and
z-index values. The app's canonical vocabulary is the shipped token family:
`--surface`, `--surface-2`, `--surface-hover`, `--text`, `--text-2`,
`--muted`, `--faint`, `--accent`, `--line`, and related role tokens.

Font sizes should use the named scale in `tokens.css`: `--fs-micro`,
`--fs-label`, `--fs-data`, `--fs-body`, `--fs-ui`, `--fs-title`,
`--fs-lead`, `--fs-page`, `--fs-stat`, and `--fs-display`. Use the spacing
scale `--sp-0` through `--sp-8` for new margin, padding, and gap values. Keep
raw pixel values only for measured component geometry, breakpoints, icon sizes,
chart dimensions, and one-off fit fixes.

Use `--font-sans`, `--font-mono`, and `--font-serif` directly. Do not add
feature-local font aliases such as `--f-sans`, `--f-mono`, or `--mono`.

## Import order

`globals.css` imports these files in this order. Order is load-bearing:
same-specificity rules in later files win over earlier files.

`dark-overrides.css` and `overhaul.css` must come after the files they
override. `mobile.css` must come last so media queries beat desktop defaults.

## Phase 3 work (planned)

- **`dark-overrides.css`**: dissolve by moving each `:root[data-theme="dark"]`
  override immediately after its base rule in the relevant feature file.
- **`overhaul.css`**: merge each selector into its canonical feature file,
  deduplicating the ~56 intra-file duplicates in the process.

Once both files are empty, delete them and remove from the `globals.css`
import chain.

Run `node tools/css-audit.mjs apps/web/app/styles/<file>.css` to get a
per-file duplicate and !important report before merging.

## Adding new styles

1. Identify the feature area (dashboard, landing, charts, etc.).
2. Add rules to the matching split file.
3. If the rule needs a dark-mode variant, add it immediately after the base
   rule in the same file (not in `dark-overrides.css`).
4. Run `npm run test:node && npm run web:build` before committing.
