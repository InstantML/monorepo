# Castform Demo Progress

## 2026-06-30

- Created branch `castform-demo-planning`.
- Researched Castform public docs and the open-source `benchmax` SDK.
- Added initial planning artifacts for a Castform collaboration demo.
- Moved all demo artifacts under `demo/castform/` after the directory-scope
  correction.

## Current Objective

Create a full end-to-end demo that:

1. Uses a Castform SDK-shaped training flow.
2. Streams training data into InstantML.
3. Creates a local webpage that displays the resulting InstantML data through
   InstantML iframes.
4. Is tested end to end with real commands and browser verification.
5. Is reviewed and committed after meaningful steps.

## 2026-07-01

- Confirmed all new work should stay under `demo/castform/`.
- Inspected the existing InstantML iframe embed API and local dev auth flow.
- Saved a frontend concept image at `assets/ui-concept.png`.
- Added `e2e-design.md` for the demo-only end-to-end architecture.
- Revised the design to write to hosted InstantML by default under
  `castform-live-demo`; hosted iframe embeds require an HTTPS parent origin, so
  the local parent page needs a tunnel for the call.
- Added the hosted demo runner and static Castform parent page. Generated live
  manifests and summaries are ignored so bearer iframe URLs are not committed.
- Added a live hosted runbook and verifier for generated manifests, redacted
  summaries, and HTTPS parent-page readiness.
- Added a live Castform/Benchmax SDK launch bridge and `run_demo.py
  --castform-run-id` mode so real Castform runs can be mirrored into the same
  hosted iframe demo flow when credentials and run IDs are available.
- Corrected stale planning-doc command paths after the move into
  `demo/castform/`.
- Added a deterministic local smoke manifest generator and Playwright browser
  verifier so the parent page can be checked for render health, tab switching,
  refresh behavior, iframe sizing, and visible-token safety before live
  credentials are used.
- Reordered the responsive parent page so narrow screens start with the
  observability content instead of setup metadata.
- Added a one-command local smoke orchestrator that starts the parent server,
  runs manifest verification plus desktop/mobile browser checks, writes an
  ignored safe report, and shuts the server down.
- Opened `https://app.castform.com/home` read-only in the browser and confirmed
  the public app home exposes the install/setup/agent/launch flow plus example
  RAG and trace training-result links mirrored by the demo story.
- Inspected the public RAG example train/eval tabs and updated the demo metric
  mapping from `conciseness` to Castform's observed `search_efficiency` reward
  component.
- Added a hosted readiness checker that validates local dependencies, ignored
  generated paths, hosted parent-origin shape, optional parent URL reachability,
  live env var presence, and InstantML API health without writing data or
  printing secrets.
- Added a mocked end-to-end rehearsal that runs the real `run_demo.py` against
  a fake local InstantML API, verifies SDK metric/text/log traffic and mock
  embed sessions, serves the parent page, and runs desktop/mobile browser
  checks without live credentials.
- Created production InstantML API key `Castform live demo 2026-07-01`, wrote
  four live Castform-shaped runs to project `castform-live-demo`, and verified
  the project has 4 runs and 576 metric points.
- Hosted iframe session creation is blocked in production: prod and staging
  return 404 for `POST /api/embed/sessions`, their OpenAPI documents omit embed
  paths, and dashboard pages are not frameable. Added a live blocked-embed page
  state and recorded details in `live-hosted-status.md`.
- Added a local real InstantML iframe E2E runner that starts an isolated Rust
  API, local ClickHouse, local Next embed app, and Castform parent page; mints a
  disposable local API key; writes Castform-shaped runs through the SDK; creates
  real local embed sessions; and browser-verifies iframe content on desktop and
  mobile. Verified with 3 runs, 3 sessions, and 42 iframe panel elements at both
  `1366x900` and `390x844`.
- Added `run_demo.py --instantml-run-id` so operators can reuse existing
  InstantML runs and mint iframe sessions without duplicating data after hosted
  embed routes are deployed. The local real iframe E2E now verifies this resume
  path by checking the run count remains unchanged before and after session
  creation.
- Upgraded the mocked E2E rehearsal to cover the same existing-run recovery
  command against a fake InstantML API, so the fast no-credential check now
  proves fresh ingestion, resume session creation, manifest verification, and
  desktop/mobile parent-page rendering.
- Added `check_castform_readiness.py` as a no-secret preflight for the live
  Castform SDK path. It checks Benchmax/Castform SDK importability, Castform
  API-key presence, uploaded asset arguments, and optional Castform app
  reachability before an operator attempts a real launch.
- Cleaned up stale hosted-demo wording so operators do not mistake the temporary
  Cloudflare tunnel or unavailable hosted embed routes for current working
  infrastructure. The docs now distinguish the live persisted-data proof from
  the local real iframe proof.
- Added `run_call_prep_check.py` as a one-command walk-up gate that runs the
  Castform readiness dry check, mocked recovery rehearsal, parent-page smoke,
  and optional full local real iframe E2E, then writes a consolidated ignored
  report.
- Added `run_demo.py --allow-embed-blocked` and verifier support for
  blocked-state manifests so operators can regenerate the live parent page from
  existing production run IDs while hosted embed routes still return 404.
- Added `readiness-review.md` as the dedicated review pass with evidence,
  operator path, and residual blockers.
- Added `run_live_blocked_smoke.py` so an operator with a live InstantML key can
  regenerate the current production persisted-data page from known run IDs,
  serve it locally, and browser-verify the blocked hosted-embed state without
  duplicating runs.
- Added `run_castform_bridge_smoke.py` to execute the live Castform bridge CLI
  against a temporary fake Benchmax SDK, verifying the
  `TrainerClient.launch_training_run(...)` call shape without live Castform
  credentials or uploaded assets.
- Added `run_castform_sdk_e2e_smoke.py` to stitch fake Benchmax launch, fake
  Castform run reads, the real mirror adapter, real InstantML SDK, fake
  InstantML API, iframe-session creation, local parent page, and browser
  verification into one no-secret Castform SDK workflow rehearsal.
