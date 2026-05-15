# Open Source, Brand, And Compatibility Policy

Date: 2026-05-09

Status: Accepted planning policy

## Summary

InstantML should treat openness as a trust and adoption strategy first, not as a premature community strategy. The current repo can be shared with contributors and reviewers, but a public open-source launch should wait until licensing, security posture, hosted-backend boundaries, and namespace migration are deliberate.

The public product language remains **InstantML** for now. That is descriptive, but stable enough for docs, validation calls, and internal planning. Do not pick a clever permanent brand before user validation proves which wedge matters most.

## Open Source Decision

Decision:

- Use openness to build trust, portability, and adoption.
- Do not rely on community contributions as the near-term product strategy.
- Keep hosted SaaS as the initial business motion.
- Preserve exportable schemas, local dev, and future self-host/VPC paths as trust levers.
- Pick a license before public release; no license file currently exists, so the repo should not be represented as open source yet.

Recommended path:

1. Share source privately with early design partners and contributors.
2. Keep local self-host/dev flows simple enough to evaluate.
3. Publish Rust/ClickHouse schema/API docs and export guarantees before public pricing.
4. Choose license and contribution policy before public repo launch.
5. Decide later whether the long-term model is permissive OSS, source-available core, open-core, or hosted-only with strong export/self-host options.

Hosted-backend boundary:

- Public source sharing should not imply the hosted Rust/ClickHouse service is production-ready until contract tests, tenant-isolation tests, migration tests, and deployment docs exist.
- Keep managed auth provider choices, secret handling, API-key hashing, and billing/usage rollups documented before inviting outside production use.

## Brand Decision

Decision:

- Use **InstantML** in user-facing docs and UI until external validation says the name is a liability.
- Treat it as a working public name, not a final trademark or package namespace.
- Do not rename code identifiers in this phase; namespace migration needs its own design and compatibility plan.

Naming criteria for a future final name:

- Clear to ML practitioners without explaining RL history.
- Short enough for CLI, package, and domain use.
- Does not sound like a generic logging library only.
- Can cover metrics, configs, checkpoints, artifacts, comparisons, imports, and hosted collaboration.
- Avoids direct W&B imitation.
- Searchable and legally reviewable before launch.

## Compatibility Names

Temporary compatibility identifiers:

- `instantml`: current Python SDK package.
- `instantml_api`: historical Python bootstrap API package.
- `.instantml`: local state, spool, artifact, and offline replay directory.
- `instantml://`: local artifact URI scheme.
- `instantml_...`: current local API-key prefix.
- `InstantMLError`: current Python SDK exception.
- `@instantml/server`: deprecated Node compatibility package name.
- `instantml:next:view:*`: current browser localStorage saved-view prefix.

Policy:

- Keep these identifiers stable until a namespace migration design exists.
- User-facing prose should call the product InstantML even when commands include compatibility names.
- Any future rename must include backward-compatible env vars, import aliases, storage migration notes, and tests for existing local data.

## Documentation Rules

- README and docs should use InstantML for the product.
- Historical design docs may mention older names only as context.
- Code comments, package imports, path names, and error class names may keep `instantml` until migration.
- Product claims about W&B, pricing, or speed should stay framed as strategy or hypotheses unless backed by current measurements or customer validation.
