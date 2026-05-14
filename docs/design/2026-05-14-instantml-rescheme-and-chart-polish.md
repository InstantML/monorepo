# Design: InstantML Rescheme And Chart Polish

Date: 2026-05-14

Status: Accepted

Owner: Codex

## Summary

This change rebrands the active frontend experience from the temporary `Training Observability` product name to `InstantML` and applies the public InstantML visual language from `https://instantml.ai/` as inspected on 2026-05-14: near-black app chrome, slate surfaces, emerald primary accents, compact typography, and a simple bar-and-bolt mark.

The smallest useful version is a visual and documentation rescheme on top of the existing Pluto-style workspace branch. Projects, saved local views, bounded run lists, and batched metric APIs already exist in the current frontend; this slice keeps those contracts intact while making the controls read as first-class InstantML product surface. Chart panels also move closer to the provided W&B reference by using flatter cards, lighter gridlines, thinner metric strokes, smaller points, and a red/blue-first palette that remains readable when many runs overlap.

## Goals

- Rename user-facing frontend and current guidance docs language to `InstantML`.
- Apply InstantML brand tokens from the public site without changing backend, SDK, or storage contracts.
- Make charts denser and more overlap-tolerant with thinner line strokes, smaller points, subdued grids, and clearer legend color pairing.
- Keep projects and saved views visible in the topbar and covered by existing UI smoke tests.

## Non-Goals

- Rename code package identifiers, environment variables, localStorage keys, API routes, or SDK import names such as `rlobs`.
- Add persisted hosted workspace views in this slice; saved views remain local browser state until a backend workspace-view API is accepted.
- Change run, metric, artifact, log, or project API shapes.
- Copy W&B or Pluto branding. The reference is used for chart density and workspace hierarchy only.

## Users and Use Cases

ML engineers use the dashboard all day while comparing many overlapping runs. They need the app to look like InstantML, preserve the current project selector and saved-view workflow, and make dense charts easier to scan without fetching more data or changing SDK behavior.

## Proposed Design

Brand mock:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ InstantML mark │ Project: benchmark-demo │ Status: Finished │ Operational ... │
└──────────────────────────────────────────────────────────────────────────────┘
```

Workspace/chart mock:

```text
┌ Runs rail ─────────────┐ ┌ Charts ──────────────────────────────────────────┐
│ Search runs            │ │ ┌ val/loss ─────────┐ ┌ eval/acc ─────────────┐ │
│ ○ run-a                │ │ │ thin red/blue lines│ │ thin red/blue lines  │ │
│ ○ run-b                │ │ │ light grid, small  │ │ compact legend       │ │
└────────────────────────┘ │ └────────────────────┘ └──────────────────────┘ │
                           └──────────────────────────────────────────────────┘
```

Implementation details:

- Replace public metadata, landing copy, loading shell, topbar accessible label, and web tests with `InstantML`.
- Use an inline InstantML mark based on the public site shape: three ascending emerald bars plus a cut-through bolt. Keep it vector-native so the app does not add image loading to first paint.
- Update CSS variables to align with the public site: `#07080c` background, `#0d0f15`/`#12141c` surfaces, `#34d399` dark accent, `#059669` light accent, slate text, and warm secondary color.
- Pin the accepted brand reference in this doc:
  - Dark tokens: background `#07080c`, surface `#0d0f15`, elevated surface `#12141c`, border `#1c1f2a`, foreground `#94a3b8`, heading `#f8fafc`, accent `#34d399`, accent-hover `#10b981`, warm `#e0b07a`.
  - Light tokens: background `#ffffff`, foreground `#475569`, heading `#0f172a`, surface `#f8fafc`, elevated surface `#f1f5f9`, border `#e2e8f0`, accent `#059669`, accent-hover/readable text `#047857` or darker.
  - Mark geometry: three ascending rounded bars plus a bolt cut-through, derived from the public site SVG viewbox `0 0 240 240`.
- Token roles:
  - `--text`/headings must meet WCAG AA contrast for normal text against `--bg`/`--surface`.
  - `--muted` is for secondary text only and should remain readable at 12px+.
  - `--accent` is for fills, icons, focus rings, and primary buttons; small accent text on light surfaces should use `--accent-strong` rather than `#059669`.
  - Chart colors are non-semantic. Red/blue are series colors only; status/error UI continues to use separate danger tokens.
- Keep dashboard light/dark theming. Dark remains the fresh-session default through `DashboardShell`; the root bootstrap still honors explicit saved preference.
- Chart treatment:
  - Use thinner primary strokes around `1.25px` to support many overlapping runs.
  - Use opacity around `0.9` for normal series, keep hovered/active readouts visually stronger, and preserve stable DOM order so selected/visible run order remains predictable.
  - Keep per-point markers capped by the existing marker-threshold logic; dense charts should render line paths without thousands of visible point circles except hover/active state.
  - Keep legends compact and wrapping; repeated colors are acceptable after palette exhaustion because the run label remains the primary identifier.
  - Use a red/blue-first palette like the reference, followed by InstantML emerald/warm/purple series colors.
  - Keep bounded series APIs and the existing workspace panel rendering path.
- Saved view/project behavior:
  - Current saved views are local browser state and may encode a project filter.
  - The saved-view dropdown remains global to the browser profile, matching the existing contract.
  - Applying a saved view should restore its saved project/status/filter/metric state and then let existing stale-run pruning handle missing runs.
  - Existing `rlobs:next:*` localStorage keys are intentionally retained for compatibility.
- Documentation:
  - Update `PRODUCT_STRATEGY.md`, `apps/web/README.md`, and `docs/design/README.md` so future contributors use InstantML as the user-facing name.
  - Update only current guidance docs and frontend-facing surfaces in this PR. Historical design docs may keep `Training Observability` when describing previous product naming. Lowercase `training observability` remains valid as a product category.

Rename allowlist:

- `apps/web/app/layout.tsx`
- `apps/web/app/page.tsx`
- `apps/web/app/loading-screen.tsx`
- `apps/web/app/dashboard-components.tsx`
- `apps/web/app/icon.svg`
- `apps/web/tests/ui-smoke.mjs`
- `apps/web/README.md`
- `docs/design/README.md`
- `PRODUCT_STRATEGY.md`
- This design doc

## Component Impact

Backend:

- No impact.

Frontend:

- Visual token update, product-name string update, brand mark update, and chart CSS/palette update.

Python SDK:

- No impact.

Storage:

- No impact. Existing localStorage keys keep their `rlobs` prefixes to avoid breaking saved views.

Docs:

- Strategy and web README language moves to InstantML.

## Data Model

No data model changes.

## API Contracts

No API contract changes.

## Performance Considerations

- Expected rows/items per user action: unchanged from the Pluto-style workspace branch. Run lists stay paginated and chart panels fetch bounded series.
- Expected read/query shape: unchanged. Chart rendering still uses existing normalized series arrays.
- Latency target: unchanged; this is CSS/string/markup only.
- Memory concerns: no new data structures. The inline SVG mark is static. Dense charts must not add per-point markers beyond the existing cap.
- Measurement plan: run `npm run test:node`, `npm run web:build`, and `npm run test:ui`; inspect the local dashboard in browser for chart density, project/view controls, desktop/mobile layout, and light/dark theme contrast.

## Simplicity Review

The design keeps this as a narrow reskin plus chart polish. Persisted server-side workspace views and a broader namespace migration are explicitly deferred because they require backend storage contracts and migration planning.

## Failure Modes

- Saved local views could appear lost if localStorage keys were renamed; this design avoids renaming them.
- Chart strokes could become too faint in dark mode; CSS keeps high-contrast series colors and hover rings.
- Brand strings could remain in tests/docs; repository search for `Training Observability` should be run before finishing.
- Global saved views could surprise users after switching projects; the UI preserves the current global dropdown contract and saved views restore their own project filter when applied.

## Testing Plan

- Update existing UI smoke assertions from `Training Observability` to `InstantML`.
- Run `npm run test:node` for web/unit coverage.
- Run `npm run web:build` for Next compile checks.
- Run `npm run test:ui` for the Rust API plus browser UI smoke path covering projects, saved views, charts, tabs, and workspace interactions.
- Browser QA acceptance:
  - Desktop dashboard shows `InstantML` as title/accessible brand label and keeps project plus saved-view controls in the topbar.
  - Mobile/narrow dashboard does not overlap brand, project, saved view, or chart controls.
  - Light and dark themes keep readable text/focus states.
  - Dense workspace charts show thin line paths, compact legends, and capped point markers without extra fetch fan-out.

## Documentation Plan

- Update `PRODUCT_STRATEGY.md`.
- Update `apps/web/README.md`.
- Update `docs/design/README.md`.
- Keep this design doc as the accepted design for the PR.

## Alternatives Considered

- Full namespace migration from `rlobs` to `instantml`: rejected for this slice because it would touch API keys, SDK naming, environment variables, storage migrations, and localStorage compatibility.
- Default all users to light mode to match the screenshot: rejected because the public InstantML site defaults dark and the app already offers an explicit theme toggle.
- Persist saved views now: deferred because it requires a backend contract and user/org authorization design beyond a rescheme.

## Review Notes

Fresh reviewer 1:

- Finding: Rename scope, brand-token contrast, dense chart performance, and public-brand reference were underspecified.
- Risk: A visual PR could over-edit historical docs, use low-contrast accent text, or regress dense chart performance.
- Recommended edit: Add an update allowlist, token roles/contrast criteria, dense-chart acceptance rules, and pinned 2026-05-14 InstantML token/mark reference.
- Decision: Accepted and incorporated before implementation.

Fresh reviewer 2:

- Finding: Chart overlap behavior, saved-view/project scope, visual QA coverage, and red-series semantics needed firmer acceptance criteria.
- Risk: The UI could look branded but remain hard to read for many runs or make saved views feel lost after project switching.
- Recommended edit: Specify opacity/hover/marker/legend behavior, saved-view scope, browser QA acceptance, and non-semantic chart color usage.
- Decision: Accepted and incorporated before implementation.

## Coverage Exceptions

None expected.

## Decision

Accepted for implementation after review revisions.
