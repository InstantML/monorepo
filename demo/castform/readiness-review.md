# Castform Demo Readiness Review

Review date: 2026-07-01.

## Scope

This is the dedicated review pass for the Castform collaboration demo in
`demo/castform/`. The review covered the operator path, generated-artifact
boundaries, token handling, production/live status, mocked recovery, local real
iframe proof, and remaining external blockers.

## Current Verdict

The demo is call-ready for showing InstantML observability around Castform runs
with two explicit modes:

1. Production persisted-data mode: live Castform-shaped runs exist in project
   `castform-live-demo`, and the local parent page can now be regenerated from
   those existing run IDs with `run_live_blocked_smoke.py` or
   `run_demo.py --allow-embed-blocked`.
2. Full iframe proof mode: `run_local_real_iframe_e2e.py` verifies the complete
   iframe flow against local real InstantML services.

The only known blocker for hosted production iframes is outside these demo
artifacts: production and staging still return 404 for
`POST /api/embed/sessions`, and their OpenAPI documents omit embed routes.

## Evidence Reviewed

- Production data exists: `live-hosted-status.md` records 4 run IDs, 576 metric
  points, no active/failed runs, and best `eval/reward_mean` evidence.
- Hosted iframe blocker is explicit: prod, app-domain, and staging
  `/api/embed/sessions` calls returned 404; dashboard routes are not frameable.
- Full local iframe E2E passed: `run_local_real_iframe_e2e.py` produced 3 runs,
  3 embed sessions, verified iframe content in desktop/mobile browsers, and
  confirmed the existing-run resume path left run count unchanged at 3.
- Mocked E2E passed: `run_mocked_e2e.py` covers fresh SDK ingestion, existing
  run recovery, browser rendering, and the blocked-hosted branch where the fake
  embed route returns 404 without creating extra sessions.
- Live blocked-smoke wrapper is covered by mocked E2E: the fake hosted API path
  runs `run_live_blocked_smoke.py` against existing run IDs, a 404 embed route,
  a local parent server, and desktop browser verification.
- Castform SDK bridge shape is covered: `run_castform_bridge_smoke.py` runs the
  real `castform_live_bridge.py` CLI against a temporary fake Benchmax SDK and
  verifies the `TrainerClient.launch_training_run(...)` arguments and output
  without live credentials.
- Castform SDK workflow shape is covered: `run_castform_sdk_e2e_smoke.py`
  stitches fake Benchmax launch and fake Castform run reads into the real mirror
  adapter, real InstantML SDK, fake InstantML API, iframe-session recovery,
  parent-page serving, and browser verification.
- Call-prep gate passed: `run_call_prep_check.py --full --timeout 240` passed,
  and the later fast gate passed after compact-report hardening.
- Process hygiene passed: post-run checks found no lingering Rust API, Next,
  parent-page, tunnel, or E2E runner processes.
- Secret hygiene passed: committed files scan clean for live
  `instantml_...` tokens; token-bearing generated manifests remain ignored
  under `demo/castform/web/public/` and `demo/castform/run-output/`.
- In-app browser visual handoff passed: the local real iframe page rendered 3
  run cards, 3 session tabs, and a real InstantML iframe at
  `http://127.0.0.1:61203` with no visible live token text. Screenshots were
  saved to ignored local evidence files:
  `run-output/in-app-browser-local-real-iframe.png` and
  `run-output/in-app-browser-local-real-iframe-overfit-tab.png`. The tab
  interaction changed the selected tab and iframe title to `Best vs overfit`.
- Automated screenshot evidence is now part of `run_local_real_iframe_e2e.py`;
  each run writes desktop and mobile screenshots under
  `run-output/local-real-iframe-screenshots/` and includes those paths in the
  ignored JSON report.

## Operator Path

Before the call:

```bash
python3 demo/castform/run_call_prep_check.py --full --timeout 240
```

For the current production hosted state, regenerate the live parent page from
existing production runs without duplicating data:

```bash
INSTANTML_API_KEY=... python3 demo/castform/run_live_blocked_smoke.py
```

For a tunnel-specific manifest, use the lower-level command:

```bash
INSTANTML_API_KEY=... python3 demo/castform/run_demo.py \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo \
  --allow-embed-blocked \
  --instantml-run-id 80aa6afb-4003-4756-bffc-591c541a332d \
  --instantml-run-id a2f80903-ddf8-4e84-a4dc-297480144093 \
  --instantml-run-id 46d776c3-8061-44a0-9ce5-27a9cf3ab85b \
  --instantml-run-id 2abdb990-1305-47ee-be70-c0716ac0f1c4
```

Then verify:

```bash
python3 demo/castform/verify_demo.py \
  --parent-url https://your-demo-origin.example \
  --allow-blocked-embeds

node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 4 \
  --expect-sessions 0 \
  --allow-blocked-embeds
```

When hosted embed routes are deployed, keep the same command but expect real
sessions and remove the blocked browser expectation.

## Residual Risks

- Real Castform SDK live launch still requires Castform credentials and uploaded
  assets from Castform/Benchmax. `check_castform_readiness.py` and
  `castform_live_bridge.py` are ready for that path, and the bridge CLI is
  smoke-tested with a fake Benchmax SDK. The SDK launch-to-mirror workflow is
  rehearsed with fake Castform data, but it has not been run end to end against
  a real Castform training job.
- Hosted iframes cannot be proven in production until `/api/embed/sessions` is
  deployed/enabled. The local real iframe E2E is the proof that the surrounding
  InstantML iframe contract works.
- The production API key used for call prep should be revoked after the call
  unless intentionally retained for more partner prep.
