# InstantML — Final UI/UX Evaluation & Production-Readiness Plan

Date: 2026-06-10
Status: Final (v2 — revised after two independent agent critiques)
Supersedes / consolidates: `docs/design/2026-06-10-ui-ux-production-audit.md` (full page-by-page findings inventory)
Mockups: `docs/design/mockups/mockup-runs-workspace.html`, `mockup-compare.html`, `mockup-run-detail.html`

How this was produced:
1. Seeded 8 projects / 37 runs through the public SDK against the local Rust/ClickHouse stack, then drove every dashboard surface in Chrome (Runs, Metrics, Distributed, Run Detail + local tabs, Compare, Insights, Alerts, Datasets, Imports, Artifacts, Checkpoints, Reports, Settings, API, landing, light/dark, keyboard).
2. Reviewed `apps/web` and `apps/rust-server` for security and performance.
3. Drafted the audit, then spawned independent critique agents (a W&B-power-user UX critic and a feasibility/sequencing engineer; a third security critic was cut short by session limits — security findings below are from my own code-verified review). Their corrections are folded in and marked **[revised]**.

---

## 1. Verdict

InstantML's bones are good: real token system, professional dark theme, canvas charts, sub-200 ms API responses, an excellent Imports surface, and two genuine differentiators W&B lacks (rank-aware Distributed dashboards; first-class checkpoint fork/resume). It is not demo-ready because a handful of structural problems land in the first five minutes of any session: an unreliable nav rail, a comparison loop whose selection can't be shared or always survive navigation, cross-project defaults that open the app onto "no data" panels, metadata that clips off the screen edge, and runs that silently lose data while the UI calls them "Finished".

The biggest correction from critique: several "build X" items are actually "turn on X" — a complete sortable runs table already exists as unmounted dead code (`apps/web/app/dashboard/runs/runs-table.tsx`), metric goal-direction logic already exists (`src/state.js` `metricGoal`), upload-health states already exist (`uploadHealthForRun`), and saved views already persist selection. The plan below leans on re-mounting and wiring existing machinery rather than rebuilding it.

---

## 2. P0 blockers (corrected after critique)

| # | Finding | Status after critique | Size |
|---|---|---|---|
| P0-1 | Hover-expanding nav rail: first click expands instead of navigating, items no-op, rail overlays content, no tooltips when collapsed | Confirmed. **[revised]** Fix is small, not a rebuild: default `navPinned` to true, remove hover-open handlers (`nav-rail.tsx` ~75–78) and the `.tabs:hover` CSS, add collapsed-state tooltips. Real `<a>` anchors already exist | S |
| P0-2 | Run selection not shareable; Compare can dead-end with no on-page picker | **[revised]** Overstated as "memory-only": saved views already persist `selectedRunIds` (shell ~2620/2720). Real gaps: no URL encoding, no default-session persistence, Compare has no inline picker, and deep-linked recipients can't receive a selection. URL must carry **filter expressions or a capped id list (~50, Compare's own cap)** — not 2000 UUIDs; precedence contract (URL > saved view > default-100 auto-select) needs a design doc first | L (design doc + wk2) |
| P0-3 | Run Detail / Checkpoints right-column values clip at viewport edge (commit, platform, Python, learning rate) with no wrap/copy | Confirmed at 1440 px and 1568 px | S |
| P0-4 | "All projects" + global default metric ⇒ first screen full of "no data for metric" pills; cross-project chart mixing | Confirmed. **[revised]** Mostly default flips: `hideEmptySections` exists; per-run-set metric fallback exists (shell ~1608). New work is only the "All projects" overview screen (design doc) and migration for persisted views | M |
| P0-5 | `?project=` deep link ignored when another project filter persisted | Observed live and reproducible, but **[revised]** narrower than written: project IS seeded from URL at init; the failure path is likely the URL project being cleared before the project list loads, or saved-view apply bypassing `changeProject`. Re-verify at HEAD, fix the residual path | S |
| P0-6 | Default text instead of placeholder (report title "Untitled reportIris sweep readout"; API key name) | Confirmed; two `useState` defaults → placeholders | S |
| P0-7 | Silent data loss: runs that lost rank/metric rows to SDK `finish()` timeout show as cleanly "Finished" with only an "upload stale" chip | Confirmed (8 of 12 seeded runs lost rank data). **[revised]** UI half is mostly relabeling: `uploadHealthForRun` already computes synced/syncing-N/stale/errors with row counts — needs plain-language copy, exception-only badges, surfacing on Run Detail as a banner with a recovery action. SDK/server "expected vs received" half is a separate design-doc'd workstream | S (UI) / L (SDK) |
| P0-8 | Settings "Change to Pro/Premium" jumps straight to Stripe checkout, no in-app confirm | Confirmed. **[revised]** Demoted out of week 1 — a scripted demo never clicks it. Design doc week 1, implement week 3 | M |

New P0-class items surfaced by critique:

| # | Finding | Why it's P0-class |
|---|---|---|
| P0-9 **[new]** | **No log-scale y-axis anywhere in the chart system.** Loss curves are the most-stared-at artifact in the daily loop; every W&B user flips to log scale in their first session | Chart parity verdict was wrong ("parity minus polish"); this is a gap. Add per-panel y-log toggle + manual y-range |
| P0-10 **[new]** | **Run Detail shows only a hardcoded 5-key config list** (`detail/run-detail.tsx` ~309: algo/dataset/seed/lr/batch); every other config key is invisible outside Compare | Violates the product's own "evidence before opinion" principle and the reproducibility contract. Add full searchable config table with copy-as-JSON |
| P0-11 **[new]** | **`examples/rank-insights/train.py` defaults to `https://api.instantml.ai`** and will POST the user's API key to production when following the README (reproduced during this audit) | One-line default change + SDK warning when an `instantml_…` key targets an unexpected host. Day-1 fix |

---

## 3. The chart experience (under-weighted in v1, per UX critique)

These four items define W&B's daily feel and were missing or under-called in the first draft:

1. **Log scale + manual y-range** (P0-9).
2. **Group aggregation bands**: `groupBy`/`groupAverage` exist but render mean-only lines; add min/max or ±stddev envelopes so "is fast-lr better than baseline across seeds?" is readable at a glance. The seeded data (seed-7/seed-17 pairs) is the perfect demo.
3. **Live-run experience**: the product's wedge is "open all day while training runs", yet nothing verifies charts visibly tick during a Running run, logs follow the tail, and run rows update in place. Add a "watch a live run" audit/demo pass; a demo without a live updating run is dead on arrival.
4. **Hover cross-highlighting**: hovering a chart line should highlight the matching table row (and vice versa), with an optional synced crosshair across panels. This is what makes 30-run workspaces tractable, and it's the prerequisite for slimming down per-panel legends.
5. **Smoothing honesty**: when smoothing > 0, keep the raw series as a low-opacity ghost line (smoothed-only curves hide spikes — hiding evidence); name the smoothing algorithm.
6. **X-axis modes**: only `step | time` exist; add relative-time (and document it) before claiming chart parity.
7. **Metric direction is declared, not guessed** **[revised]**: the existing `MINIMIZE_METRIC_PATTERN` regex would mark `test/ece` as "higher is better" and color a worse calibration green. Direction-aware deltas (Compare) must come from an explicit declaration path — SDK (`define_metric(goal=…)`-style) plus per-workspace metric settings — with neutral coloring when undeclared. The regex stays only as a suggestion default.

---

## 4. IA & navigation (revised)

Keep the v1 direction — project-first hierarchy, pinned labeled sidebar, one project control, selection tray, Cmd+K — with these corrections from critique:

- **Selection tray appears only when selection > 0** (slides in); zero-selection dead space contradicts "keep dense work legible". With large selections it summarizes ("214 selected · from filter lr>0.1") rather than listing names.
- **No raw URL fragments rendered as chrome** (the v1 mockups showed `?runs=9f05,…` in the tray — same sin as the Settings debug echo). A "Copy link" button; the URL lives in the address bar.
- **Data-state badges are exception-only**: `complete` is the unmarked default; badges render only for uploading/incomplete/failed (the v1 mockup's `complete` pill on every row repeated the V4 anti-pattern it was fixing).
- **Panels keep the flexible majority of the width** **[revised]**: the v1 runs-workspace mockup inverted the emphasis (fixed 420 px panel rail, table gets the flex). Charts are what users stare at; use a draggable splitter with a collapsible table, or a table/charts view toggle.
- The runs table must be drawn and built for the hard case: 100s of runs, grouped rows, indeterminate header checkbox, "select all N matching filter" (the cross-page semantics already in `state.js`), virtualized rows.
- Tab demotions touch `src/routes.js` path canonicalization and alias maps — do the nav reorganization once, after the IA design doc, not piecemeal.
- Number-key tab shortcuts must be scope-guarded against focused inputs and added to the browser smoke suite.

Compare redesign keeps its inline run picker, shareable state, sticky first column, config-diff highlighting, and version-chip artifacts — but **must not regress today's evidence system** (rows+columns layouts, evidence sorting [signal/changed-first/missing-first/spread], per-run annotation): the run-pill strip collapses past ~8 pills into a "12 runs ▾" popover, the reference run gets an explicit change/remove menu, and deltas get an absolute/relative toggle (absolute default for bounded metrics — "+8.1% worse" on an ece of 0.124 dramatizes a 0.010 change).

Run Detail redesign additionally gets the **full config card** (P0-10), Min/Max columns instead of a noise "Mean" on monotone curves, labeled/united axes on System charts, and upload-stall events on the Timeline. The recovery command shown in the incomplete-data banner must be verified against the actual `instantml-uploader` CLI flags before shipping.

---

## 5. Full findings inventory

The complete page-by-page list (landing, auth, every tab, visual system — ~70 items with severities) lives in `docs/design/2026-06-10-ui-ux-production-audit.md` sections 4–5 and remains valid except where corrected above. Additional inventory items from critique:

- **Run lifecycle management is absent**: no delete/archive/move-project for runs anywhere; teams accumulate junk runs (this audit created 37 it cannot clean up from the UI). Minimum: delete-run with confirm.
- **W&B parity matrix refinement**: split "Runs table" into table / query language / grouping — the filter-expression language (config/metric comparisons, regex) is most of what makes W&B's table powerful. The v1 mockup's `lr > 0.1` placeholder advertises a grammar that doesn't exist; spec it or restrict the placeholder to current behavior.
- **Corrections of v1 claims** **[revised]**: R11/PF4 (visibility-gated polling) is already implemented at HEAD (`document.visibilityState` checks, shell ~1480/1514) — dropped. P0-2/P0-5 narrowed as described above. Compare's "0 runs" dead-end may only occur after explicit deselection or an empty saved view — the auto-select-100 default usually populates it; shareability remains the real issue.

---

## 6. Security & performance (from my code review; independent critique incomplete)

Verified positives: parameterized ClickHouse queries throughout `metric_store.rs`; SHA-256-hashed API keys/sessions/invite tokens; HttpOnly SameSite=Lax cookies with conditional Secure; Origin allow-list validation on mutations (CSRF); per-org and unauthenticated rate limiting; CSV formula-injection neutralization in exports; ANSI logs rendered as classed spans (no innerHTML); artifact name sanitization + path canonicalization; CSPRNG share tokens; CLI-first imports keeping third-party tokens off the server.

Issues (ranked):
- **S1 (high, DX/credential hygiene)**: example defaults to prod API (now P0-11). Fix day 1.
- **PF1 (high, scalability)**: entire control plane in in-memory maps behind one global `tokio::sync::Mutex` (`store/mod.rs`), locked on essentially every request including auth lookups; plan-capacity checks iterate all org artifacts per run-create (`store/usage.rs`). A contention and memory ceiling at the 50k-run target; needs a sharded/RwLock store or lock-free hot lookups. Schedule as a backend design doc, not demo-window work.
- **PF2 (high, frontend)**: `dashboard-shell.tsx` — 4,175 lines, 57 `useEffect`s, 13 `setSelectedRunIds` call sites — owns all cross-tab state. This is the root cause behind P0-2's difficulty; a narrow extraction (selection + URL sync + saved-view apply into one module) is now an explicit roadmap item (week 2) rather than an unscheduled lament.
- **S3 (med)**: API-key revoke is one unconfirmed "×" click.
- **S2 (med)**: JSON-LD uses plain `JSON.stringify`; adopt a `</script>`-escaping serializer before the data is dynamic.
- **PF5 (med)**: SDK `finish()` strands rows under modest bursts (reproduced); needs drain budget/progress + server acks (pairs with P0-7's SDK half).
- **S4/S5/S6 (low)**: warn if local auth mode binds non-loopback; add a CSP; share tokens lack expiry/last-access visibility.
- Unverified by independent critique (security agent was cut short — rerun later): IDOR checks on data-plane routes, `/r/:share_token` enumeration/rate limits, artifact download authz, demo-org read-only enforcement, device-code brute-force protections.

---

## 7. Revised roadmap (re-sequenced per feasibility critique)

The major re-ordering: **design docs and the selection-state extraction come before the selection rewrite and the runs table**; billing/alert-rule/system-metrics-capture scope leaves the three-week demo window; verified-small fixes land immediately.

### Week 1 — verified smalls + design docs
Land (all S, low coupling):
1. P0-11/S1: example prod-URL default + SDK host warning. Day 1.
2. P0-1: pin nav by default, remove hover-open, collapsed tooltips. Update nav smoke tests.
3. P0-3: metadata wrap/middle-truncate + copy buttons (reuse existing Copy-ID pattern).
4. P0-6: placeholder fixes. P0-5: re-verify at HEAD, fix residual URL-precedence path.
5. P0-7 (UI half): plain-language upload-health copy, exception-only badges, Run Detail banner with verified recovery command.
6. C3 direction-aware deltas using existing `metricGoal` (neutral when undeclared) — quick trust win.
7. S3: revoke confirm. Copy fixes (I5, M5-class).

Write + review design docs (per AGENTS.md, two fresh reviewers each):
(a) selection/URL contract — encoding (filter expr vs capped ids), precedence (URL > saved view > auto-select default), popstate/replaceState behavior, org-switch scrubbing, stale-id handling without URL rewriting, saved-view payload compatibility;
(b) project-first IA — sidebar regroup, "All projects" overview screen, tab demotions, breadcrumb consolidation;
(c) runs-table re-mount — reconcile the existing unmounted `RunsTable` + existing column-chooser/`pinnedMetrics` with the run rail's keyboard/bulk-select/undo features;
(d) P0-8 billing confirm flow;
(e) metric goal declaration (SDK + workspace settings).

### Week 2 — selection model + charts
1. Narrow shell extraction: selection + URL sync + saved-view apply into one owned module (the PF2 slice P0-2 needs).
2. Implement P0-2 on top: URL-encoded selection, Compare inline picker, selection tray (appears only when selection > 0; reconciled with the existing bulk-select banner and an undo answer for "Clear").
3. P0-4 defaults: `hideEmptySections` flip (with persisted-view migration decision), per-project default metric.
4. Charts: y-log toggle + manual range (P0-9), group aggregation bands, smoothing ghost line, sparse-series markers, single-point visibility.
5. Verify/fix the live-run loop (charts tick, logs tail, rows update) and script the live-run demo moment.

### Week 3 — runs table + remaining P0s + polish
1. Re-mount and extend `RunsTable` per the reviewed doc (sortable metric/config columns, grouping rows, indeterminate select, select-all-matching, virtualization) riding on the extracted state. Hover cross-highlighting chart ↔ table.
2. "All projects" overview page. P0-10 full config card on Run Detail + D2–D7 cleanups (system metrics out of summary, GOAL defined or dropped, Data tab defaults to current run).
3. P0-8 billing confirm implementation. Rename Alerts → **Run Health** with dedupe (commit to this; rules engine is deferred — don't let it creep into the crowded week).
4. Artifacts browser restructure (collections/versions tree + file preview for csv/json/png) if capacity allows; otherwise the AR1 quick fix: collapse empty panels, distinguish reference-only artifacts, copy-URI.
5. Theme toggle in account menu; landing reveal de-gating; heatmap colorblind palette + numeric tooltips; Settings split (Workspace/Members+invite/Billing/Profile) and remove the debug state echo.

### Deferred (post-demo, behind design docs, parallel non-frontend track where applicable)
System-metrics capture (SDK psutil/NVML + endpoint + charts — seed demo data instead for now), alert rules + channels, P0-7 server-side expected-vs-received heartbeat, PF5 SDK drain rework, PF1 store sharding, Sweeps, model registry stages, public projects, report comments, mobile pass, run delete/archive (small — pull forward if a slot opens).

---

## 8. Demo script anchors (what to lead with)

1. Live run ticking in a project-scoped workspace (speed story: skeletons → sub-second charts).
2. Select seed pairs → grouped chart with bands → Compare with direction-aware deltas → copy link → open in a fresh window (shareable evidence).
3. Distributed tab on a rank run: coverage, straggler highlighting, heatmap (no W&B equivalent).
4. Checkpoint → Fork → lineage graph (no W&B equivalent).
5. Imports page: W&B dry-run command, schema mapping, "tokens stay local".

## 9. Keep list (unchanged)

Distributed dashboards; Imports; fork/resume with honest confirmation copy; Cmd+K; saved views with stale-run pruning; undo/redo; canvas charts + bounded reads; the token system and dark theme; Stripe/Clerk plumbing.
