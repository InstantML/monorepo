# Repository Agent Guide

This guide complements `AGENTS.md`. Read `AGENTS.md` first; it remains the
source of truth for repository workflow, design reviews, tests, and ownership.

## Keep Docs Current

Every behavior, API, storage, SDK, UI, setup, workflow, or operational change
must update the relevant docs in the same branch. Do not treat documentation as
a follow-up.

For each change, check all applicable docs surfaces:

- nearest component `README.md`;
- public Mintlify docs in `apps/docs` when user-facing behavior changes;
- `apps/docs/docs.json` navigation when adding public pages;
- public screenshots in `apps/docs/images/product` when a documented UI surface
  changes materially;
- internal design docs in `docs/design` when an accepted design changes;
- architecture or operations docs in `docs/architecture` or `docs/ops` for
  system, deployment, storage, or runbook changes;
- SDK docs and examples for public SDK APIs or behavior.

Before finishing, run the focused docs checks that match the change. For public
docs changes, prefer:

```bash
npm run docs:test
npm run docs:validate
```

If a docs check cannot run, document the reason and the residual risk in the
handoff.

