# Design: Mintlify Public Docs MVP

Date: 2026-05-23

Status: Accepted

Owner: Codex

## Summary

InstantML needs a public documentation surface with the polish and directness of
the Neptune and W&B docs references without turning the existing internal
`docs/` tree into public product documentation. The smallest useful version is
a docs-as-code Mintlify site under `apps/docs`, backed by a checked-in
`docs.json`, a handful of MDX pages, and a copied OpenAPI artifact generated
from the existing Rust `utoipa` output.

This keeps the MVP mostly content and configuration. It does not add backend
routes, storage, or product data dependencies. It uses Mintlify-compatible
source because W&B's docs are Mintlify-based, Mintlify supports `docs.json`
configuration, monorepo docs paths, and OpenAPI 3.0/3.1 generated API
documentation from repository-local specs:

- <https://github.com/wandb/docs>
- <https://www.mintlify.com/docs/organize/settings>
- <https://www.mintlify.com/docs/api-playground/openapi-setup>
- <https://www.mintlify.com/docs/deploy/monorepo>

The public docs source stays separate from internal strategy, design,
architecture, and pricing-planning docs so a future Mintlify deploy can point at
`/apps/docs` without exposing private implementation notes.

2026-05-23 amendment: the production user path is now remerged into the main
Next app at `/docs` instead of redirecting to a separate docs host. `apps/docs`
remains the public docs source and Mintlify validation/preview surface, while
`apps/web` owns a lightweight same-origin docs route that renders the MDX and
filtered OpenAPI copy. This avoids a `docs.instantml.ai` dependency until that
domain is intentionally configured.

## Goals

- Add a Mintlify MVP docs site that can be run and validated locally.
- Publish a user-facing information architecture: overview, hosted quickstart,
  SDK logging, dashboard workflow, troubleshooting, and API reference.
- Reuse the existing generated Rust OpenAPI JSON through a deterministic sync
  step instead of hand-maintaining endpoint documentation.
- Keep all changes in repo-owned files with no hosted Mintlify project setup
  required for local validation.

## Non-Goals

- Do not deploy the docs site or configure a custom domain in this change.
- Do not expose the internal `docs/design`, `docs/architecture`, `docs/product`,
  or `docs/users` trees as public docs.
- Do not expose public docs through the product dashboard shell or require an
  authenticated session for docs. The accepted amendment adds a public
  same-origin `/docs` route in `apps/web` while keeping source content in
  `apps/docs`.
- Do not add SDK public APIs, backend endpoints, auth changes, or storage
  changes.
- Do not generate full Python API reference from docstrings in this first slice.

## Users and Use Cases

Primary users:

- ML engineers evaluating InstantML for hosted experiment tracking.
- New users who need one clear path from install to first logged run.
- SDK/API users who need auth, endpoint, and troubleshooting references.

Core workflows:

1. Understand what InstantML does.
2. Sign in to the hosted dashboard and create an SDK key.
3. Create an SDK run, log metrics/config/artifacts, and flush/finish.
4. Open the hosted dashboard and compare runs.
5. Find API reference pages generated from the Rust OpenAPI spec.

## Proposed Design

Add `apps/docs` as the public docs source component.

Initial files:

- `apps/docs/README.md`: ownership, commands, validation, and publishing notes.
- `apps/docs/docs.json`: Mintlify configuration, branding, navigation, and
  OpenAPI tab.
- `apps/docs/index.mdx`: public docs landing page with quick paths.
- `apps/docs/quickstart.mdx`: hosted setup and first SDK run.
- `apps/docs/sdk/logging.mdx`: SDK logging concepts and snippets.
- `apps/docs/dashboard/compare-runs.mdx`: dashboard comparison workflow.
- `apps/docs/api/authentication.mdx`: API base URLs and API key auth.
- `apps/docs/troubleshooting.mdx`: common hosted, auth, and SDK issues.
- `apps/docs/images/*`: product mark/lockup assets copied from
  `apps/web/public/`; `apps/web/public/` remains the canonical source for brand
  SVG updates in this slice.
- `apps/docs/openapi.json`: generated docs copy of
  `apps/rust-server/openapi.generated.json`.

Add `tools/sync-docs-openapi.mjs` to copy the Rust OpenAPI artifact into
`apps/docs/openapi.json`. The script should filter the generated spec to an
explicit public path allowlist before writing any docs copy:

- `/health`
- `/readyz`
- `/projects`
- `/runs`
- `/runs/{run_id}`
- `/runs/{run_id}/metrics`
- `/api/metrics/series`
- `/api/runs/{run_id}/attributes`
- `/api/runs/{run_id}/objects`
- `/api/runs/{run_id}/artifacts`
- `/api/runs/{run_id}/artifacts/upload`
- `/api/runs/{run_id}/logs`
- `/api/objects/{object_id}/rows`
- `/api/artifacts/{artifact_id}/download`
- `/api/export`
- `/api/imports`
- `/api/imports/wandb`
- `/api/imports/mlflow`
- `/api/imports/neptune`
- `/api/usage`
- `/api/usage/export`

The script should also prune unreferenced component schemas from the docs copy.
Any future public route addition must be added to the allowlist intentionally in
the same change as the docs update.

The script should normalize only docs-site concerns:

- Add the hosted production `servers` entry so the Mintlify playground has a
  useful SaaS base URL.
- Remove an empty generated `info.license.name` value from the docs copy if it
  is present.
- Leave `apps/rust-server/openapi.generated.json` untouched.
- Support `--check`, which compares the generated docs copy with the committed
  `apps/docs/openapi.json` and fails without writing when they differ.

Add `tools/validate-docs-content.mjs` to keep the public docs tree from linking
to internal planning/source-of-truth paths such as `docs/design`,
`docs/product`, `docs/architecture`, `docs/users`, `PRODUCT_STRATEGY.md`,
`TODO.md`, and `AGENTS.md`.

Add root npm scripts:

- `docs:sync-openapi`: run the sync script.
- `docs:check-openapi`: run the sync script in `--check` mode.
- `docs:dev`: sync OpenAPI, then run `mint dev` from `apps/docs`.
- `docs:validate`: check the OpenAPI copy, run the public-content guard, then
  run `mint validate` from `apps/docs`.

CI should run `npm run docs:validate` after the existing API type drift check so
the public docs OpenAPI copy cannot lag behind committed generated Rust API
artifacts.

Add a first-party Next route under `apps/web/app/docs/` that renders this public
source at `/docs` and `/docs/:path*`. The route reads `apps/docs/docs.json`,
MDX pages, screenshots, and `openapi.json` directly. Keep this renderer
deliberately small: headings, paragraphs, lists, tables, code fences, images,
the docs landing cards, and a generated API reference page are enough for the
current content set. The web container must copy `apps/docs` into production
images because the route reads the source files at runtime.

Add the Mintlify CLI package as a root dev dependency so commands are
versioned with the repo instead of requiring a global install. The root lockfile
is expected to change because this repo does not use npm workspaces and `.npmrc`
saves exact package versions. The root npm overrides keep Mintlify's preview
React dependency deduped to the repo React version so `mint validate` does not
trip on multiple React instances.

Public docs content acceptance criteria:

- Command snippets must come from or be checked against `README.md`,
  `USER_DOCS.md`, `apps/web/README.md`, `packages/python-sdk/README.md`, or
  `docs/architecture/current-api.md`.
- Hosted auth language must distinguish API-key SDK use from browser session
  flows.
- Import docs must be factual and limited to implemented JSON importer routes.
- Dashboard workflow docs must describe existing UI capabilities without speed
  or competitor claims.

Update `apps/README.md`, root `README.md`, and `docs/design/README.md` with
the new component and accepted design link.

## Component Impact

Backend:

- No backend code changes.
- The docs OpenAPI copy depends on the existing generated Rust spec.

Frontend:

- `apps/web` owns the production `/docs` route and serves docs screenshots from
  `apps/docs/images`.
- `apps/docs` remains the source component, run by Mintlify for content preview
  and validation.

Python SDK:

- No SDK code changes.
- The SDK logging docs summarize existing behavior only.

Storage:

- No storage changes.

Docs:

- Public docs source component under `apps/docs`.
- First-party public docs route under `apps/web/app/docs`.
- Internal docs remain in the existing root `docs/` tree.

## Data Model

No new or changed data model.

## API Contracts

No new or changed API contracts.

The docs OpenAPI artifact is a filtered generated copy of the current Rust API
spec. It publishes only the explicit public allowlist above, prunes unreferenced
component schemas, adds docs-only `servers` metadata for Mintlify, and removes
an empty generated license value if needed. It does not define product behavior.

## Performance Considerations

- Expected rows/items per user action: small checked-in docs pages and a
  filtered OpenAPI route list.
- Expected write frequency: docs content changes through git commits.
- Expected read/query shape: same-origin Next `/docs` requests read small
  checked-in MDX/OpenAPI files and docs image assets; Mintlify preview remains
  a local validation path.
- Latency target: hosted docs should load like a lightweight documentation
  route.
- Pagination, limits, streaming, indexes: not applicable.
- Memory concerns: none beyond Mintlify build/render requirements.
- Batching needs: none.
- Measurement plan: run `npm run docs:validate` locally. Hosted performance can
  be checked after a future deploy.

## Simplicity Review

This first slice keeps Mintlify as the docs source validator and previewer, then
adds a deliberately small Next renderer for same-origin `/docs` serving. It adds
one isolated content component, a compact web route, and a simple OpenAPI sync
script. It avoids publishing internal docs, avoids a custom search stack,
avoids Python docstring extraction, and avoids automated deployment.

Deferred complexity:

- Hosted Mintlify project and custom domain setup.
- Full generated Python SDK reference.
- Automatic screenshot/video capture from the web app.
- Versioned documentation.
- Public docs analytics and feedback integrations.

## Failure Modes

- Mintlify config or MDX is invalid: `npm run docs:validate` should fail before
  deployment, and `npm run web:build` catches renderer/runtime mistakes in the
  same-origin route.
- Rust OpenAPI copy drifts: `npm run docs:validate` runs
  `docs:check-openapi` and fails without writing if `apps/docs/openapi.json` is
  stale. Contributors should run `npm run docs:sync-openapi` to update it.
- The generated Rust spec is missing: the sync script fails with a clear error
  and asks the contributor to run `npm run codegen:api`.
- A non-public route appears in the docs API reference: the allowlist filter
  excludes it by default; adding it requires an intentional script change plus
  review.
- Public docs link to internal planning docs: `tools/validate-docs-content.mjs`
  fails validation before publishing.
- Public docs accidentally reference internal-only behavior: review should keep
  MVP pages focused on `USER_DOCS.md`, SDK README, and current API reference.
- Mintlify changes CLI behavior: the pinned dev dependency keeps local
  validation reproducible until the package is intentionally updated.
- Mintlify or its transitive preview tooling pulls a second React copy: the root
  npm override dedupes React to the repo version.

## Testing Plan

- Add a focused Node test for the OpenAPI normalization helper.
- Add a focused Node test for path allowlisting and component schema pruning.
- Add a focused Node test for the internal-link content guard.
- Add focused web tests for `/docs` route ownership, slug/link mapping, MDX
  parsing, asset serving, and generated API reference loading.
- Run the focused Node test directly.
- Run `npm run docs:validate`.
- Run `npm run test:node` and `npm run web:build`.

Coverage:

- The new docs content is MDX/config, not first-party product logic.
- The small sync/content-guard helpers and web docs renderer have focused tests
  for normalization, public-route filtering, component pruning, internal-link
  behavior, route ownership, slug/link mapping, and source loading.

## Documentation Plan

- Add `apps/docs/README.md`.
- Update `apps/README.md` to list the new docs app.
- Update root `README.md` to mention the public docs MVP and commands.
- Update `apps/web/README.md` to document the same-origin `/docs` route.
- Update `docs/design/README.md` after acceptance.
- Record fresh review notes in this design doc before implementation.

## Alternatives Considered

GitBook:

- Rejected for this first slice because the repo already works through
  docs-as-code, generated OpenAPI, and PR review. GitBook is stronger when a
  block editor and non-engineer authoring workflow are the core requirement.

Docusaurus:

- Viable and Neptune-like, but it requires more theme/design work to reach the
  W&B-like polish. It remains a good future fallback if Mintlify lock-in becomes
  a problem.

Fumadocs in Next:

- Viable and likely the best self-hosted long-term option if docs need deep
  integration with the existing Next stack. Rejected for the MVP because the
  user explicitly asked for Mintlify and the fastest first source format was
  Mintlify-compatible MDX/config. The accepted amendment now uses a lightweight
  custom Next renderer around that source rather than adopting Fumadocs.

Expose the existing root `docs/` directory:

- Rejected because it contains internal design, architecture, strategy, pricing,
  and user research documents that should not become public docs by accident.

## Review Notes

Fresh reviewer 1:

- Finding: Public docs accuracy gate was underspecified, OpenAPI drift detection
  was deferred, the first slice risked broad factual claims, Mintlify dependency
  maintenance needed a clearer rule, and copied brand assets needed a source
  update rule.
- Risk: Stale or inaccurate docs could publish, validation could dirty the
  worktree, and duplicated assets could drift.
- Recommended edit: Add explicit snippet/source acceptance criteria, add a
  same-slice OpenAPI check mode, keep non-core pages tightly factual, document
  the lockfile expectation, and name `apps/web/public/` as the canonical SVG
  source.
- Decision: Accepted. The design now adds `docs:check-openapi`,
  public-content acceptance criteria, lockfile/source-asset notes, and removes
  the separate imports page from the MVP navigation while allowing short factual
  import guidance where it supports quickstart or troubleshooting.

Fresh reviewer 2:

- Finding: Copying the full Rust OpenAPI spec could expose non-public routes,
  OpenAPI drift checks belonged in the first slice, and tests should cover
  route-publication and internal-docs leakage.
- Risk: A future Mintlify deploy could publish admin/auth/billing/storage routes
  or internal planning references.
- Recommended edit: Add an explicit public path allowlist/filter, same-PR drift
  check, and deterministic content guard tests.
- Decision: Accepted. The sync script will filter to a documented public path
  allowlist, prune unreferenced schemas, support `--check`, and pair with a
  public docs content guard.

## Coverage Exceptions

None.

## Decision

Accepted after fresh-agent review. Implement the narrowed Mintlify MVP with a
filtered public OpenAPI reference, same-origin `/docs` serving from `apps/web`,
no separate docs-domain deployment, and validation-first scripts.
