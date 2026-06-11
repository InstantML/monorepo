# Audit remediation wave 2 — sections 3–7 of the UI/UX production audit

Date: 2026-06-10
Status: Accepted (implements the reviewed plan in `docs/2026-06-10-ui-ux-final-plan.md`)
Scope source: `docs/design/2026-06-10-ui-ux-production-audit.md` sections 3–7

## Problem

Wave 1 (PR #184) fixed the eight P0 blockers. The audit's remaining findings —
information architecture (section 3), the page-by-page inventory (section 4),
the security/performance review (section 6), and the redesigned flows
(section 7) — keep the dashboard short of a production demo standard:
inconsistent affordances, dead-end or noisy states, direction-naive delta
colors, unreadable system telemetry, raw-text pickers, and a handful of
small security hardening items.

## Approach

One coherent frontend wave on branch `ui-followups`, implemented in narrow
batches that each ride existing machinery instead of inventing new systems:

1. **IA (section 3).** Selection tray rendered only when a selection exists
   (Compare / Export / Clear), driven by the same `selectedRunIds` state and
   URL sync added in wave 1. Number-key tab shortcuts guarded against
   editable elements via the existing `isEditableElement` helper. Nav
   regroup: rarely-daily tabs (Alerts→Run health, Datasets, Imports,
   Checkpoints) into a collapsed-by-default "More" position in the existing
   `navGroups` config; no route changes, aliases stay valid. Breadcrumb
   project becomes a real control (opens the existing project select);
   the filter-bar dropdown remains the single full selector.
2. **Page fixes (section 4).** Each finding maps to a local change in the
   owning component; the largest is mounting the already-written-but-unused
   `RunsTable` behind a rail list/table view toggle (R1), reusing the
   existing column-chooser + `pinnedMetrics` machinery and saved-view
   persistence. Run Detail derives its headline stats from the run's own
   logged objective rather than the workspace default, and internal
   `system/instantml/*` rows leave the user metric table (they remain on the
   System tab, rendered readably).
3. **Compare (C2–C4).** Sticky first column + edge fade for horizontal
   overflow; delta colors use the existing `metricGoal` direction (the same
   source compare sorting already trusts); artifact strips group by
   name with version-count chips.
4. **Security/perf (section 6).** Example base-URL footgun removed
   (`rank-insights/train.py` gains the same `--server` default as every
   other example); JSON-LD serialized with `<` escaping; API-key revoke
   confirms; Rust server warns when local auth mode binds non-loopback;
   conservative security headers (frame-ancestors, nosniff, referrer
   policy) in `next.config.mjs`. Deep backend work the audit itself defers
   (store sharding PF1, SDK system-metric capture, alert rules engine,
   share-token expiry S6) stays deferred per the reviewed plan; the SDK
   drain budget (PF5) gets a configurable, louder finish drain.
5. **Testing.** Every logic change lands with node-test coverage in the
   existing suites (`apps/web/tests/*.test.js`); UI-state helpers are
   extracted to `src/` modules where needed so they are testable without a
   DOM, matching the repo's established pattern.

## Non-goals

- Sweeps, model registry, alert rule engines, report comments (deferred by
  the accepted plan, section 8 "Deferred").
- The full two-pane Artifacts browser redesign: this wave ships the audit's
  own quick-fix alternative (collapse empty panels, mark reference-only
  artifacts, copy-URI, version disambiguation).
- Backend store sharding (PF1) and the server-side upload-completeness
  contract (P0-7's SDK/server half).

## Failure modes considered

- Nav regroup must not break `src/routes.js` path canonicalization or the
  browser smoke around routing — group membership changes only, ids/paths
  stay stable.
- The tray and table view both read the selection model; neither introduces
  a second source of truth (everything derives from `selectedRunIds`).
- Saved views must keep deserializing older payloads; new fields are
  optional with defaults.

## Review

Reviewed against the two wave-1 independent critiques (UX power-user +
feasibility) whose recommendations shaped this scope: ride existing dead
code, sequence behind the wave-1 selection model, defer capture/rules work.
