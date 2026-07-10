# PRODUCT.md

## Register

product — the surface in scope is the InstantML dashboard (`apps/web`), an
app-shell data tool: run tables, metric charts, trace trees, settings. Design
serves the data; identity stays quiet. (The public site and docs are separate
surfaces, not covered here.)

## What this is

InstantML is training observability for ML teams: experiment tracking (runs,
metrics, artifacts, logs) plus run-linked traces for RL rollouts, evals, and
reward debugging. The dashboard is where an ML engineer watches a training run
live, compares experiments, and digs into why a metric moved.

## Target users

ML engineers and researchers running long training jobs (often RL/LLM
fine-tuning). Expert users, keyboard-friendly, many hours per session, often
several runs monitored in parallel. They copy values into terminals and paste
run IDs into scripts; precision beats decoration.

## Brand personality

Calm instrumentation. Confident, technical, unflashy. Numbers are the heroes;
chrome earns its place by disappearing. Reads closer to a well-built lab
instrument than a SaaS marketing surface.

## Design system (current, governing)

`apps/web/app/styles/tokens.css` + `apps/web/app/styles/README.md` are law:

- Type: DM Sans for UI/prose, mono for data (values, IDs, units). Named font
  scale `--fs-micro … --fs-display`; never raw px font sizes.
- Spacing: `--sp-0 … --sp-8`. Radii: `--radius-sm | --radius |
  --control-radius | --radius-lg | --radius-pill`.
- Color: light theme default with full dark-theme token overrides; `--accent`
  (green) means live/primary/healthy, `--danger` for errors, `--muted` for
  secondary text, `--line` hairlines, `--surface*` steps. Charts use the JS
  `CHART_PALETTE` (`chartColor(i)`) mirrored by `--series-1…8`.
- Structure: hairline borders and surface steps, not shadows. Panels with
  `panel-head` bezels; dense tables; skeleton shimmer for loading states.
- Components: shared `CustomSelect`, skeleton primitives, status chips
  (`.workspace-run-status`, `.trace-status`), `MetricChart` geometry via
  `src/charts.js`.

`docs/design/reimagine/DESIGN-SYSTEM.md` ("Instrument") is a north-star
exploration (dark control room, phosphor telemetry). Borrow its instincts
(mono carries data, green means live, hairlines not shadows, dense but never
cramped) but implement with the current tokens — do not import its raw values
into `apps/web`.

## Anti-references

- SaaS dashboard clichés: hero-metric tiles, gradient accents, glassmorphism,
  card grids for everything.
- Decorative color: green that doesn't mean live/healthy, red that doesn't
  mean error.
- Anything that breaks copy-paste (values as images, truncated IDs without a
  copy affordance).

## Strategic design principles

1. Every value legible, monospaced, and copyable.
2. Color is semantics: state before decoration.
3. One glance answers "is it healthy, is it moving"; one click reaches the
   evidence (metric point, trace, log line).
4. Dense by removing chrome, never by shrinking below `--fs-micro`.
5. Both themes are first-class; tokens only, no raw colors in feature CSS.
