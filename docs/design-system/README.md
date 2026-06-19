# Design System Specimen

This directory contains a static, self-contained design-system specimen for the
InstantML web app.

## Purpose

`index.html` documents the current UI language, canonical app token names,
type scale, spacing scale, component primitives, and light/dark theme behavior.
The shipped token source remains `apps/web/app/styles/tokens.css`; keep this
specimen aligned with that file when tokens or component conventions change.

## View

Open the page directly from the repository root:

```bash
open docs/design-system/index.html
```

No build step is required. The page uses Google Fonts on first load, then falls
back to system fonts if the network is unavailable.

## Notes For Future Agents

- Prefer app token names such as `--surface`, `--text`, `--muted`,
  `--accent`, and `--line`.
- Do not reintroduce reference-only aliases such as `--bg-panel`,
  `--text-hi`, or `--signal` as canonical app names.
- Update this specimen whenever `apps/web/app/styles/tokens.css` changes in a
  way users or contributors should see.
