# Design: Dashboard Shell Decomposition

Date: 2026-05-19

Status: Accepted

Owner: Engineering

## Summary

`apps/web/app/dashboard-components.tsx` (3,946 lines, 40+ exports) and
`apps/web/app/dashboard/dashboard-shell.tsx` (3,148 lines, 89 `useState` calls)
are god-files that make the codebase hard to navigate and review.

This document defines a mechanical, no-visual-change split of those two files
into domain-scoped modules under `apps/web/app/dashboard/`, using the target
layout already proposed in `docs/design/2026-05-15-ui-overhaul-direction.md`
section 5.

## Goals

- Each resulting file has one clear concern and stays under ~400 lines.
- `DashboardShell` (the composition root) targets ≤800 lines after the split.
- `npm run test:node` and `npm run web:build` stay green after every commit.
- No visual change. No new runtime behavior.
- `instantml:next:*` localStorage keys remain centralized in
  `state/storage-keys.ts` (already done in a prior commit).
- `compareSearchTokens` duplicated in `dashboard-shell.tsx` and
  `dashboard-components.tsx` is resolved to a single location.

## Non-Goals

- Topbar redesign, run-rail compaction, or any visual change (phase 2 of the
  overhaul doc).
- Adding Radix/Tailwind/shadcn primitives.
- Changing any API contract, route, or localStorage key.
- Touching backend, SDK, or Python code.

## Inventory

### `dashboard-components.tsx` — exported symbols and target files

| Symbol | Target file |
| --- | --- |
| `useFocusTrap` | `ui/use-focus-trap.ts` |
| `CustomSelect` | `ui/select.tsx` |
| `ShortcutHelpModal` | `chrome/shortcut-help.tsx` |
| `QuickSearchModal` | `chrome/quick-search.tsx` |
| `DashboardTopbar` | `chrome/topbar.tsx` |
| `DashboardNav` | `chrome/nav-rail.tsx` |
| `RunsCommandbar` | `runs/runs-commandbar.tsx` |
| `Stats` | `runs/runs-stats.tsx` |
| `RunsWorkspace` | `runs/runs-workspace.tsx` |
| `WorkspacePanelCard` | `runs/workspace-panel-card.tsx` |
| `PanelEditDrawer` | `runs/panel-edit-drawer.tsx` |
| `RunsTable` | `runs/runs-table.tsx` |
| `ChartControls` | `metrics/chart-controls.tsx` |
| `RunMetadataEditor` | `runs/run-metadata-editor.tsx` |
| `RunsChartStrip` | `runs/runs-chart-strip.tsx` |
| `MetricChart` | `metrics/metric-chart.tsx` |
| `HoverDetail` | `metrics/hover-detail.tsx` |
| `SeriesSummary` | `metrics/series-summary.tsx` |
| `MetricCatalog` | `metrics/metric-catalog.tsx` |
| `MetricLeaderboard` | `metrics/metric-leaderboard.tsx` |
| `RunDetail` | `detail/run-detail.tsx` |
| `RichObjectPanel` | `detail/rich-object-panel.tsx` |
| `ArtifactPanel` | `detail/artifact-panel.tsx` |
| `SideBySide` | `compare/side-by-side.tsx` |
| `AlertList` | `alerts/alert-list.tsx` |
| `DatasetTable` | `datasets/dataset-table.tsx` |
| `ArtifactBrowser` | `artifacts/artifact-browser.tsx` |
| `ModelLineage` | `models/model-lineage.tsx` |
| `ModelContext` | `models/model-context.tsx` |
| `ReportList` | `reports/report-list.tsx` |
| `SettingRow` | `settings/setting-row.tsx` |
| `IntegrationCard` | `integrations/integration-card.tsx` |
| `ApiTable` | `api/api-table.tsx` |
| `MetricCard` | `ui/metric-card.tsx` |

Private helpers that travel with their public consumer (not separately exported):
`chartColor`, `compactRailRunName`, `tagInputValue`, `parseTagInput`,
`remainingTagsTitle`, `visibleTagsForSearch`, `focusableChildren` → `ui/`
helpers; compare helpers (`CompareMatrix`, `CompareRunRows`, etc.) →
`compare/`; artifact/media helpers → `artifacts/`.

### `dashboard-shell.tsx` — state clusters

89 `useState` calls group into:

| Cluster | State variables | Hook |
| --- | --- | --- |
| **Auth/session** | `dashboardAuthorized`, `dashboardAuthMessage`, `sessionPayload` | inline in shell (3 vars, not worth a hook) |
| **Filter** | `project`, `status`, `queryInput`, `query`, `sortBy`, `metricKey`, `metricFilter`, `columnMetricFilter`, `groupBy`, `xMode`, `smoothing`, `groupAverage` | `state/use-dashboard-state.ts` |
| **Pagination** | `pageSize`, `pageOffset`, `pageCursorStack`, `dashboardLoading`, `pageNavigationPending` | `state/use-dashboard-state.ts` |
| **Run data** | `projects`, `summary`, `overview`, `selectedRunIds`, `selectedRunDetails`, `primaryRunId`, `series`, `panelSeries`, `artifacts`, `loggedObjects`, `objectRowsById`, `runMetadataVersion` | `state/use-dashboard-state.ts` |
| **Compare** | `diffOnly`, `referenceRunId`, `compareLayout`, `compareRowSort`, `compareRunSort`, `compareSortMetricKey`, `compareTableMetrics`, `compareSearch`, `compareConfigSortKey`, `compareEditRunId`, `compareArtifactsByRun`, `sideBySide` | `state/use-dashboard-state.ts` |
| **Workspace layout** | `workspaceView`, `workspaceReady`, `panelSearch`, `addPanelSectionId`, `editingPanelRef`, `fullscreenPanelRef`, `workspaceSeries`, `workspaceUndoStack`, `workspaceRedoStack`, `runsRailCollapsed`, `runWorkspaceTab` | `state/use-workspace-layout.ts` |
| **Saved views** | `savedViews`, `savedViewKey`, `viewName` | `state/use-saved-views.ts` |
| **Ephemeral UI** | `columnsOpen`, `pinnedMetrics`, `navPinned`, `navAutoOpen`, `mobileNavOpen`, `theme`, `themeReady`, `hover`, `hoverMetricKey`, `chartZoomRange`, `primaryChartZoomRange`, `pinnedChartZoomRanges`, `shortcutHelpOpen`, `quickSearchOpen`, `quickSearchInput`, `quickSearchActiveIndex`, `message`, `loadingDetail`, `initialLoadDone` | inline in shell (wiring state; too interwoven with effects to extract cleanly without risk) |
| **Admin** | `usagePayload`, `seats`, `apiKeys`, `inviteEmail`, `inviteRole`, `apiKeyName`, `newApiKey`, `adminBusy`, `selectAllMatchingBusy` | inline in shell |

**Decision:** For Phase 1 (this PR), state extraction is scoped to what can be
done mechanically without changing any effect dependency or runtime behavior:

1. `use-workspace-layout.ts` — extracts workspace view + panel CRUD mutations
   only (the commit/undo/redo machinery). State still lives in the shell; the
   hook exposes mutation callbacks.
2. `use-saved-views.ts` — already started. Exposes `savedViews`, `savedViewKey`,
   `viewName`, and the `saveView`/`applySavedView` logic.

The remaining clusters stay in the shell for this PR. A follow-up PR extracts
`use-dashboard-state.ts` after the component moves land and the blast radius is
understood.

## `localStorage` keys

All `instantml:next:*` keys are already centralized in
`app/dashboard/state/storage-keys.ts` as of the prior commit. The shell imports
them. `dashboard-models.ts` imports `WORKSPACE_VIEW_PREFIX` from there. No
additional key work is needed in this PR.

## `compareSearchTokens` duplication

`compareSearchTokens` is defined privately in both `dashboard-components.tsx`
(line 3593) and implied/used in `dashboard-shell.tsx` via the shell's own
`quickSearchTokenMatches`. The components version is used by
`visibleTagsForSearch` inside `SideBySide`. After the split:

- `compareSearchTokens` + `visibleTagsForSearch` move with `SideBySide` into
  `compare/side-by-side.tsx`.
- `quickSearchTokenMatches` in the shell is a different function (split on `…`)
  and stays local to the shell / `chrome/quick-search.tsx`.

## Component move map

Moves are batched by dependency order so each batch compiles cleanly:

### Batch 1 — UI primitives (no component deps)
- `useFocusTrap` → `ui/use-focus-trap.ts`
- `CustomSelect` → `ui/select.tsx`
- `MetricCard` → `ui/metric-card.tsx`

### Batch 2 — Chrome (depends on UI primitives)
- `ShortcutHelpModal` → `chrome/shortcut-help.tsx`
- `QuickSearchModal` → `chrome/quick-search.tsx`
- `DashboardTopbar` → `chrome/topbar.tsx`
- `DashboardNav` → `chrome/nav-rail.tsx`

### Batch 3 — Metrics surface
- `MetricChart` → `metrics/metric-chart.tsx`
- `HoverDetail` → `metrics/hover-detail.tsx`
- `SeriesSummary` → `metrics/series-summary.tsx`
- `MetricCatalog` → `metrics/metric-catalog.tsx`
- `MetricLeaderboard` → `metrics/metric-leaderboard.tsx`
- `ChartControls` → `metrics/chart-controls.tsx`

### Batch 4 — Runs surface
- `Stats` → `runs/runs-stats.tsx`
- `RunsCommandbar` → `runs/runs-commandbar.tsx`
- `RunsTable` → `runs/runs-table.tsx`
- `RunsChartStrip` → `runs/runs-chart-strip.tsx`
- `RunMetadataEditor` → `runs/run-metadata-editor.tsx`
- `WorkspacePanelCard` → `runs/workspace-panel-card.tsx`
- `PanelEditDrawer` → `runs/panel-edit-drawer.tsx`
- `RunsWorkspace` → `runs/runs-workspace.tsx`

### Batch 5 — Detail surface
- `RunDetail` → `detail/run-detail.tsx`
- `RichObjectPanel` → `detail/rich-object-panel.tsx`
- `ArtifactPanel` → `detail/artifact-panel.tsx`

### Batch 6 — Compare surface
- `SideBySide` (+ private compare helpers) → `compare/side-by-side.tsx`

### Batch 7 — Secondary tabs
- `AlertList` → `alerts/alert-list.tsx`
- `DatasetTable` → `datasets/dataset-table.tsx`
- `ArtifactBrowser` → `artifacts/artifact-browser.tsx`
- `ModelLineage` → `models/model-lineage.tsx`
- `ModelContext` → `models/model-context.tsx`
- `ReportList` → `reports/report-list.tsx`
- `SettingRow` → `settings/setting-row.tsx`
- `IntegrationCard` → `integrations/integration-card.tsx`
- `ApiTable` → `api/api-table.tsx`

## Compatibility layer

`dashboard-components.tsx` retains re-exports of every symbol after each batch
so that `dashboard-shell.tsx` imports continue to compile until the shell's
import block is updated in the final cleanup commit. The shell import block is
updated in bulk at the end (after all component moves land).

Once the shell's imports are updated, `dashboard-components.tsx` becomes a thin
re-export shim. It is deleted in a follow-up PR (Phase 4).

## Test plan

### Existing tests that must stay green
- `apps/web/tests/dashboard-storage-keys.test.js` — reads
  `storage-keys.ts` and `dashboard-shell.tsx` by path; no changes expected.
- `apps/web/tests/state.test.js` — pure logic; unaffected.
- All other node tests.

### New structural test to add
None required for this PR beyond keeping existing tests green. The
`dashboard-storage-keys.test.js` already guards the key contract and the
shell's re-declaration invariants. Component moves are structural-only and
covered by `npm run web:build` (TypeScript compile).

### Manual smoke after PR lands
- `/dashboard/runs` — workspace renders, rail collapses, panels load
- `/dashboard/metrics` — chart renders, catalog works, pinning works
- `/dashboard/detail` — run workspace tabs navigate correctly
- `/dashboard/compare` — side-by-side loads, diff-only toggles
- Quick search (⌘K) opens and filters
- Shortcut help (?) opens
- Theme toggle works, persists on reload
- Saved view save + apply round-trip

## Phases

| Phase | Description | This PR |
| --- | --- | --- |
| 1 | Design doc | ✓ |
| 2 | Component moves (batches 1–7) | ✓ |
| 3 | Shell import block updated to new paths | ✓ |
| 4 | `dashboard-components.tsx` shrunk to re-export shim | ✓ |
| 5 | State hook extraction (`use-workspace-layout`, `use-saved-views`) | Follow-up |
| 6 | Delete shims, delete old god-files | Follow-up |
