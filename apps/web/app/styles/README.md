# Stylesheets

Split from the original `globals.css` (11,348 lines) as part of the
2026-05-18 CSS audit. See `docs/design/2026-05-18-globals-css-audit.md`.

## File map

| File | Contents | Key selectors |
|---|---|---|
| `tokens.css` | Brand primitives + light/dark design tokens | `:root`, `:root[data-theme="dark"]` |
| `base.css` | Global reset, typography, button defaults | `body`, `button`, `h1-p` |
| `landing.css` | Marketing page + auth card | `.landing-*`, `.auth-*`, `.onboarding-*` |
| `dashboard.css` | Shell, topbar, tabs, nav rail | `.shell`, `.topbar`, `.tabs`, `.brand-mark` |
| `dashboard-runs.css` | Runs workspace rail and rows | `.runs-*`, `.workspace-run-*` |
| `panels.css` | Workspace panels, canvas, modals | `.workspace-panel-*`, `.panel-drawer` |
| `charts.css` | Metric charts, axes, series | `.metric-*`, `.chart-*`, `.axis` |
| `research.css` | Distributed and Insights dashboards | `.rank-*`, `.insights-*`, `.cluster-*` |
| `run-detail.css` | Run detail, KPIs, inspector | `.run-detail-*`, `.run-kpi-*`, `.inspector` |
| `compare.css` | Compare view, leaderboard | `.compare-*`, `.leaderboard-*` |
| `dark-overrides.css` | Dark-theme overrides (Phase 3 target) | `:root[data-theme="dark"] *` |
| `overhaul.css` | Visual overhaul layers 2026-05-15 (Phase 3 target) | Duplicated rules from all feature areas |
| `mobile.css` | Mobile redesign ≤720px | `@media (max-width: 720px)` |
| `landing-system.css` | Landing visual system + animations | `.landing-root`, `.bento-*`, `@keyframes` |
| `docs.css` | First-party documentation route | `.docs-route-*` |

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
