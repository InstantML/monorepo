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
