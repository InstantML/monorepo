# Web Keyboard Shortcuts MVP

Date: 2026-05-10

## Context

`apps/web/TODO.md` tracks the W&B keyboard-shortcut and workspace-interaction parity gap. The full list includes reports, media viewers, persisted workspace objects, and command-addressable app workflows. This document accepts a narrow MVP slice that improves daily Runs workspace usage without changing the backend contract.

## Goals

- Add one global command layer for the current web app.
- Provide discoverable shortcut help in the UI.
- Add a quick search overlay for tabs, visible runs, metrics, projects, saved local views, and selected-run artifacts.
- Add global `Escape` handling for the topmost app overlay.
- Add undo/redo for local Runs workspace layout changes.
- Allow the Runs selector rail to collapse or restore from the keyboard and from a visible control.
- Allow fullscreen panels to move to previous/next panels by keyboard and buttons.

## Non-Goals

- No report editor shortcuts.
- No media zoom/pan shortcuts.
- No Rust/ClickHouse workspace view persistence.
- No URL-addressable fullscreen route state in this slice.
- No broad component extraction unless implementation pressure proves it necessary.

## Design

### Command Handling

Use a small first-party shortcut helper in `apps/web/src/shortcuts.js` and keep command registration local to `app/page.tsx` for now. The registry stores id, label, shortcut label, group, enabled state, and handler. Global key handling must ignore text inputs, textareas, native selects, and content-editable regions except for overlay-level `Escape`.

Supported commands in this slice:

- `Cmd/Ctrl+K`: open quick search.
- `?`: open keyboard shortcut help.
- `Escape`: close the topmost overlay.
- `Cmd/Ctrl+Z`: undo workspace layout mutation.
- `Cmd+Shift+Z`, `Ctrl+Shift+Z`, or `Ctrl+Y`: redo workspace layout mutation.
- `Cmd/Ctrl+.`: collapse or restore the Runs selector rail.
- `Cmd/Ctrl+J`: alternate focus between the Runs selector and workspace canvas.
- `Left` / `Right`: navigate fullscreen panels.

### Workspace History

Introduce a bounded in-memory undo/redo stack for `WorkspaceView` only. History includes add/remove/duplicate/edit panel, add section, section collapse, workspace mode changes, and reset layout. Selection, filters, project, metric, and tab state remain separate.

History is intentionally local because current workspace layouts are localStorage-backed. New mutations clear redo, and undo/redo write the resulting layout through existing localStorage persistence.

### Quick Search

Build a modal over local client data:

- App tabs.
- Current projects.
- Visible run summaries.
- Metric keys loaded in the current project/filter context.
- Local saved views.
- Artifacts attached to the currently inspected run.
- A few safe app commands.

Selecting a result routes to the relevant tab or applies the local view. Hosted, team-persistent search is a future workspace/search API follow-up.

### Runs Rail Collapse

Add `runsRailCollapsed` browser-local state. When collapsed, the rail becomes a narrow strip with count and restore affordance while the panel canvas expands. The command and visible button share the same state.

### Fullscreen Panel Navigation

Flatten workspace panels in section order. Arrow keys and previous/next buttons move within that order and stop at the edges. No wrapping in this slice.

## Test Plan

- Unit-test shortcut helper behavior.
- Extend the UI smoke test to cover help, quick search, rail collapse, workspace undo/redo, fullscreen arrow navigation, and `Escape`.
- Run `npm run test:node`, `npm run web:build`, and `npm run test:ui` before finishing.

## Review Notes

- This slice is deliberately smaller than the full parity TODO. It targets the highest-frequency Runs workspace behaviors and leaves report/media/server persistence items unchecked.
- The repository workflow asks for fresh reviewers before substantial changes. The current user request did not explicitly authorize spawning agents this turn, so this implementation stays within an accepted MVP design and uses automated tests as the review gate.
