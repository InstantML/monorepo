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

- Production data exists: `live-hosted-status.md` records the latest 5 live
  run IDs in project `castform-live-demo`; the generated write used 25 logged
  steps per run and 16 scalar metrics per step.
- Hosted iframe blocker is explicit: prod, app-domain, and staging
  `/api/embed/sessions` calls returned 404; dashboard routes are not frameable.
  `check_hosted_readiness.py` now inspects hosted OpenAPI for
  `POST /api/embed/sessions` and can fail strictly with
  `--require-hosted-embeds`.
- Full local iframe E2E passed: `run_local_real_iframe_e2e.py` produced 3 runs,
  3 embed sessions, verified iframe content in desktop/mobile browsers, and
  confirmed the existing-run resume path left run count unchanged at 3.
- Mocked E2E passed: `run_mocked_e2e.py` covers fresh SDK ingestion, existing
  run recovery, browser rendering, and the blocked-hosted branch where the fake
  embed route returns 404 without creating extra sessions.
- Live blocked-smoke wrapper is covered by mocked E2E and was also run against
  the latest production run IDs. The live smoke regenerated the parent manifest
  from hosted summaries, served it locally, and passed desktop `1366x900` plus
  mobile `390x844` browser checks with zero hosted sessions and an explicit
  blocked embed state.
- Castform SDK bridge shape is covered: `run_castform_bridge_smoke.py` runs the
  real `castform_live_bridge.py` CLI against a temporary fake Benchmax SDK and
  verifies the `TrainerClient.launch_training_run(...)` arguments and output
  without live credentials.
- Castform SDK workflow shape is covered: `run_castform_sdk_e2e_smoke.py`
  stitches fake Benchmax launch and fake Castform run reads into the real mirror
  adapter, real InstantML SDK, fake InstantML API, iframe-session recovery,
  parent-page serving, and browser verification.
- Call-prep gate passed: a clean-environment
  `run_call_prep_check.py --full --live --real-source castform-sdk --timeout
  240` run loaded the ignored `.env`, ran 8 commands, confirmed hosted
  readiness, regenerated the five-run live manifest, browser-verified the
  blocked production page, and ran the SDK-backed local real iframe E2E with
  one mirrored run/session plus desktop/mobile screenshots.
- Process hygiene passed: post-run checks found no lingering Rust API, Next,
  parent-page, tunnel, or E2E runner processes.
- Secret hygiene passed: committed files scan clean for live
  `instantml_...` tokens; token-bearing generated manifests remain ignored
  under `demo/castform/web/public/` and `demo/castform/run-output/`.
- Local secret ergonomics passed: the live scripts now load ignored
  `demo/castform/.env` without overriding exported variables. A clean
  environment readiness run found the production key through `.env`, and a
  clean environment `run_live_blocked_smoke.py` pass regenerated the five-run
  live manifest and passed desktop/mobile browser checks.
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
- Persistent local iframe presentation mode passed: `run_local_real_iframe_e2e.py
  --keep-running` wrote its verified parent/API/web URLs before waiting, kept a
  real one-run iframe demo alive, passed an independent
  `browser_verify.mjs --require-iframe-content` check with 42 rendered panels,
  and then stopped local API, Next, parent, and ClickHouse services cleanly on
  Ctrl-C.
- Browser handoff passed: `run_local_real_iframe_e2e.py --keep-running
  --open-browser` opened the verified parent page in Chrome, Chrome showed the
  Castform demo page with one iframe, and a frame-scoped Chrome check found
  both `INSTANTML EMBED` and `Run metrics` inside the iframe before the tab was
  closed and services were stopped.
- Castform-SDK-backed local iframe E2E passed:
  `run_local_real_iframe_e2e.py --source castform-sdk --runs 1 --steps 10
  --step-size 10 --timeout 180` launched the fake Benchmax/Castform SDK path,
  mirrored one run through the real adapter and InstantML SDK into the local
  Rust API, created one real local iframe session, verified resume did not
  duplicate runs, and passed desktop plus mobile iframe browser checks.

## Operator Path

Before the call:

```bash
python3 demo/castform/run_call_prep_check.py --full --live --real-source castform-sdk --timeout 240
```

For the current production hosted state, regenerate the live parent page from
existing production runs without duplicating data:

```bash
python3 demo/castform/run_live_blocked_smoke.py
```

For a tunnel-specific manifest, use the lower-level command:

```bash
INSTANTML_API_KEY=... python3 demo/castform/run_demo.py \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo \
  --allow-embed-blocked \
  --instantml-run-id a0c53fce-5351-476b-bd63-537c6ce442be \
  --instantml-run-id 01fff006-b7e6-4329-9d6d-c32b44eb4d3c \
  --instantml-run-id b9a7b17a-8e37-4bec-9ae2-9ea4a9bba429 \
  --instantml-run-id a51f74e9-1077-4587-87ad-9d678002aa49 \
  --instantml-run-id 1ddca3ef-fd24-4032-a95b-1d77f1c4b8aa
```

Then verify:

```bash
python3 demo/castform/verify_demo.py \
  --parent-url https://your-demo-origin.example \
  --allow-blocked-embeds

node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 5 \
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
