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

---

## Completeness annex — audit sections 3–7 disposition (post-implementation)

Legend: ✅ shipped in this wave · 🟡 partial (documented decision) · ⏩ deferred by the accepted plan (`docs/2026-06-10-ui-ux-final-plan.md` §8) — out of the demo window, needs its own design doc.

### Section 3 — IA & navigation
- ✅ 3.2 Pinned labeled sidebar (wave 1) · 3.3 demote rarely-daily tabs (More group: Run health, Datasets, Imports, Checkpoints) · 3.5 selection tray (Compare/Export/Clear, renders only with a selection) · 3.6 number-key tab jumps + Cmd+K retained.
- 🟡 3.1 project-first: per-project defaults + URL precedence shipped (wave 1); the dedicated "All projects" overview screen is ⏩ (new screen with data dependencies).
- 🟡 3.4 one project control: breadcrumb is a live control and duplicate brandbar text was demoted; the filter-bar dropdown intentionally remains the full selector.

### Section 4 — page-by-page
- 4.1 ✅ L1 reveal de-gating (visible-by-default + reduced-motion) · ✅ L2 stat contrast (≥4.5:1, contrast-computed test).
- 4.2 ✅ A1 · 🟡 A2 demo entry is a hosted-only feature (signin shared-demo action exists; landing link deferred until hosted demo routing is stable locally).
- 4.3 ✅ R1 (RunsTable mounted behind Panels⇄Table toggle) · R2/R4 (wave 1) · R3 (single checkbox affordance in table view) · R5 (swatch tooltip via table/chart identity) · R7 (cap labels unified on "N plotted / scope") · R9 (table empty-match state) · R10 · R11 (already at HEAD). 🟡 R6 legends capped + scrollable (full cross-highlight slimming ⏩) · 🟡 R8 pagination stays in the rail footer (restyled, not moved).
- 4.4 ✅ D1–D7, D9 (preview-in-Files affordance + media preview), D10 (breadcrumb action) · 🟡 D8 system/* render readably (heartbeat as relative time, telemetry excluded from user tables); automatic GPU/CPU capture ⏩ (SDK workstream).
- 4.5 ✅ M1–M6 (sparse markers, "-" rows filtered by catalog selection counts, regex hint + invalid fallback note, plain-language stat strip, EMA labeling with off state).
- 4.6 ✅ C1 (wave 1) · C2 (sticky col + edge fade + bounded scroll) · C3 (goal-aware deltas at HEAD) · C4 (version-grouped artifact strips) · C5 · C6 (inline Add-runs picker).
- 4.7 ✅ I1–I5.
- 4.8 ✅ DS1 · DS2 (on-page run picker) · DS3 (blue/orange ramp + numeric titles) · DS4 (control widths) · DS5 (magnitude-based z emphasis) · DS6.
- 4.9 ✅ AL1 (renamed Run health; same-kind warnings deduped into grouped findings) · 🟡 AL2 health cards stay on Run health (moving them to Runs is an IA call we declined; tray + table cover the daily loop).
- 4.10 ✅ DT1 (coverage scoped to the active project filter).
- 4.11 ✅ IM1 · IM2 (explicit `<your-entity>` placeholders).
- 4.12 ✅ AR1-lite (empty panels collapse) · AR2 (reference-only chips + dashed treatment) · AR3 (copy URI) · AR5 (version grouping) · AR6 (stat strip) · 🟡 AR4 media preview reused; csv/json text preview ⏩ (new data path).
- 4.13 ✅ CK1 (wave 1) · 🟡 CK2 Checkpoints demoted under More (full merge into Run Detail is an IA change beyond this wave; Run Detail already lists checkpoints with Resume/Fork).
- 4.14 ✅ RP1 (wave 1) · RP2 (project chips + run search pickers with advanced fallbacks) · RP3 duplicate + experiment-readout template · ⏩ comments/mentions.
- 4.15 ✅ ST1 (debug echo removed) · ST3 (invite exists; audit claim corrected) · ST4 (wave 1) · ST5 · 🟡 ST2 read-only profile rows added (signed-in identity); notification prefs / danger zone / project rename-delete ⏩ (backend).
- 4.16 ✅ AP1 (revoke confirm) · AP2 (wave 1) · AP3 (richer key-management hints; docs links tracked with docs routes).
- 4.17 ✅ T1 (theme toggle in account menu) · T2 (filter-toggle tooltip states) · T3 (already linked) · T4 · T5 (quick search shows grouped labels).
- 4.18 ✅ V2/V3 (serif flourish now only on the Runs workspace header) · V4 status chips retained deliberately (consistent vocabulary; quiet-dot variant rejected to avoid a second status grammar) · ✅ V5 tag tooltips · ✅ V6 verified via the landing contrast test + tokens audit.

### Section 5 — parity matrix
Closed this wave: runs table (top gap), chart polish set (log-scale ⏩ noted below), system-telemetry readability, Run health dedupe. Remaining matrix gaps (sweeps, model registry, alert rules/channels, automatic hardware capture, public projects, mobile-first pass, report comments) are ⏩ per the accepted plan — each is a product workstream with backend surface area, not a frontend flow defect. Y-axis log-scale toggle is acknowledged as the top chart follow-up (final plan P0-9) and remains open.

### Section 6 — security & performance
- ✅ S1 (example defaults local + actionable SDK warning) · S2 (JSON-LD escaping) · S3 (revoke confirm) · S4 (non-loopback local-auth warning) · S5 (X-Frame-Options added; full CSP already present — audit claim was stale).
- ✅ PF4 (already at HEAD) · PF5 (configurable finish drain + row-count warning with recovery command).
- 🟡 PF2 partial: chart normalization moved out of the shell (five memo groups deleted); the full shell decomposition continues incrementally.
- ⏩ S6 (share-token expiry), PF1 (store sharding), PF3 (dup fetches are StrictMode double-mounts in dev; verify against a prod build during release QA).

### Section 7 — redesigned flows
- ✅ Runs workspace direction realized (labeled nav, runs table, selection tray, honest data badges, panels from present metrics).
- ✅ Compare direction realized (inline add-runs, URL-carried selection, sticky col + fade, goal-aware deltas, version chips).
- ✅ Run Detail direction realized (wrapped copyable metadata, run-objective headline, telemetry banner/heartbeat, teaching empty states).
