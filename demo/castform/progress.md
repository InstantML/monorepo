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
