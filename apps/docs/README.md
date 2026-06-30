# Public Docs Source

This directory contains the public InstantML documentation source. The
production `/docs` route in `apps/web` renders this MDX/OpenAPI content
same-origin, and Mintlify remains the validation/preview surface for the docs
source. This tree is intentionally separate from the repository-level `docs/`
tree, which contains internal design, architecture, product, and user research
documents.

## Purpose

- Give users a polished quickstart, SDK guide, dashboard workflow guide, API
  reference, and agent-readable Markdown mirrors.
- Keep public docs content in git and review it with product changes.
- Generate the public API reference from the Rust OpenAPI artifact through a
  filtered docs copy.

## Local Setup

Install repo dependencies from the root:

```bash
npm ci
```

The Mintlify CLI is a root dev dependency. Do not rely on a global `mint`
install for repository commands. The root npm overrides intentionally dedupe
React for the Mintlify preview renderer; keep that in mind when updating
Mintlify or React together.

## Common Commands

From the repository root:

```bash
npm run docs:sync-openapi
npm run docs:validate
npm run docs:dev
```

`docs:sync-openapi` filters `apps/rust-server/openapi.generated.json` to the
public route allowlist and writes `apps/docs/openapi.json`.

`docs:validate` checks that `apps/docs/openapi.json` is already in sync, checks
public MDX/config for accidental internal-doc links, then runs `mint validate`.
CI runs the same validation after the Rust API type-drift check.

`docs:dev` syncs the OpenAPI copy, then starts the Mintlify preview for content
QA. The production user path is still the Next app's `/docs` route.

## Publishing

The current production docs path is the same-origin web route
`https://instantml.ai/docs`.

The web app also serves Markdown mirrors for every public page, such as
`https://instantml.ai/docs/quickstart.md`, plus `/llms.txt` and
`/llms-full.txt` for agent and offline-reader ingestion.
The web sitemap is generated from `docs.json` navigation, and the Next `/docs`
route sets self-referencing canonical metadata for each public docs URL. Keep
navigation entries current when adding pages that should be indexed.

If a separate `docs.instantml.ai` site is reintroduced later, add the domain in
Mintlify, create the verification `TXT` records shown in the dashboard, wait
for verification/TLS provisioning, then point the `docs` CNAME at the current
Mintlify target `cname.mintlify.builders`. Update `docs.json` canonical metadata
only in the same change that changes the production docs URL.

## Testing Commands

Focused tests for the docs helper scripts:

```bash
npm run docs:test
```

Full docs validation:

```bash
npm run docs:validate
```

## Coverage Expectations

The MDX and `docs.json` files are content/config, not first-party product logic.
Helper scripts that filter API docs or guard public content should have focused
Node tests.

## Key Files And Subdirectories

- `docs.json`: Mintlify site configuration, navigation, and canonical metadata.
- `openapi.json`: generated public API reference copy. Do not edit by hand.
- `index.mdx`: public docs landing page.
- `quickstart.mdx`: hosted SaaS and SDK first-run path.
- `pricing.mdx`: public Free/Pro/Premium plan overview, no tracked-hour
  billing positioning, included usage, and overage summary.
- `benchmarks.mdx`: public hosted latency evidence, W&B comparison status, and
  benchmark fairness rules. Keep any W&B speed claims aligned with sanitized
  committed benchmark results and their caveats.
- `guides/pricing-limits-billing.mdx`: public Free/Pro/Premium pricing,
  included usage, API request rate limits, storage/request overage, and billing
  behavior.
- `concepts/`: core product concepts.
- `architecture/`: public system, storage, auth, service-plane, and schema
  reference docs, including the current Google Cloud ClickHouse hosted storage
  page.
- `sdk/`: SDK usage docs.
- `sdk/tracing.mdx`: product trace context managers, `trace_op` decorators,
  privacy/capture behavior, delivery modes, and dashboard workflow.
- `integrations/`: per-framework integration guides (PyTorch Lightning, Hugging
  Face Transformers, Keras, Optuna, tree boosting, Stable Baselines, dataset
  provenance) and the Weights & Biases migration guide. These are buyer-intent
  landing pages for "<framework> experiment tracking" queries and surface the
  thin SDK adapters and `wandb` drop-in/shadow/mirror modes.
- `dashboard/`: dashboard workflow docs, including the run-scoped Traces
  workspace and Run Detail trace entry point.
- `guides/`: examples, imports, W&B/Neptune migration walkthroughs, export,
  usage, auth, billing, storage, observability, and evergreen comparison guides
  for buyer-intent queries such as W&B alternatives and InstantML vs MLflow.
  `guides/experiment-tracking.mdx` is the pillar page for the head query
  "experiment tracking"; keep it linked from the docs index, the comparison
  guides, and the landing-page footer so it stays discoverable and indexed.
- `api/`: practical API guides plus the generated OpenAPI reference tab,
  including short-lived read-only iframe run embeds.
- `images/`: docs-local brand and product assets served by the Next `/docs`
  asset route and the Mintlify preview.
- `images/product/`: 1440x1000 dashboard screenshots for the public tour and
  workflow pages, captured from a seeded local workspace. Refresh these when
  organization/workspace switching, search, run detail files, checkpoint
  fork/lineage, artifacts, reports, settings, or API key flows materially
  change. `npm run docs:test` guards missing, unused, wrong-sized, or otherwise
  stale product captures, plus OpenAPI and benchmark evidence drift.
- Web-rendered Markdown mirrors are generated at request time from these MDX
  files; do not maintain duplicate checked-in `.md` copies.

## Design Docs

- `docs/design/2026-05-23-mintlify-docs-mvp.md`

## Notes For Future Agents

- Do not point Mintlify at the root `docs/` directory. It contains internal
  documents that are not public product docs.
- Keep `apps/web/src/docs.js` and `apps/web/app/docs/` compatible with this
  content shape when adding new MDX components or asset directories.
- Add public API paths to `tools/sync-docs-openapi.mjs` intentionally. The docs
  OpenAPI copy is a filtered public reference, not a full service dump.
- Run `npm run codegen:api` before `npm run docs:sync-openapi` when Rust
  handlers or schemas change.
