# Castform Collaboration Demo

Artifacts for planning a Castform collaboration call and demo. These files are
self-contained so the work can be reviewed without touching product code.

Research date: 2026-06-30.

## Files

- `castform-research-brief.md`: what Castform appears to provide, public source
  links, and the observability opportunity for InstantML.
- `demo-plan.md`: call-ready demo story, runbook, fallback path, and success
  criteria.
- `integration-plan.md`: practical integration slices, data mapping, risks, and
  questions for Castform.
- `call-agenda.md`: suggested call structure and discovery questions.
- `castform-metric-mapping.json`: proposed Castform-to-InstantML field and metric
  mapping.
- `demo_env.py`: dependency-free loader for ignored local `.env` values used by
  live operator scripts.
- `castform_instantml_adapter.py`: illustrative pull-sync script using
  Benchmax's public run-read client and the InstantML SDK.
- `seed_castform_demo.py`: deterministic synthetic Castform-shaped data seeder
  for an InstantML demo workspace when live Castform credentials are unavailable.
- `e2e-design.md`: accepted local architecture for the runnable Castform to
  InstantML iframe demo.
- `assets/ui-concept.png`: generated visual concept for the local parent page.
- `run_demo.py`: hosted end-to-end writer that streams Castform-shaped training
  observations into InstantML and creates iframe embed sessions.
- `castform_live_bridge.py`: optional live Benchmax SDK launcher for uploaded
  Castform training assets.
- `run_castform_bridge_smoke.py`: no-secret smoke test that runs
  `castform_live_bridge.py` against a temporary fake Benchmax SDK and verifies
  the `TrainerClient.launch_training_run(...)` call shape.
- `run_castform_sdk_e2e_smoke.py`: no-secret Castform SDK workflow rehearsal
  that launches through a fake Benchmax SDK, mirrors fake Castform scalars/logs
  through the real adapter and InstantML SDK into a fake InstantML API, creates
  iframe sessions, serves the parent page, and browser-verifies it.
- `serve_web.py` and `web/`: local Castform-facing parent page for the hosted
  iframe embeds.
- `create_smoke_manifest.py`: deterministic local manifest generator for
  parent-page browser verification without live credentials.
- `browser_verify.mjs`: Playwright-based parent-page renderer and interaction
  verifier that redacts token-like diagnostics.
- `run_local_smoke.py`: one-command local preflight that generates the smoke
  manifest, starts the parent page, runs artifact verification, runs desktop and
  mobile browser checks, writes an ignored safe report, and stops the server.
- `run_call_prep_check.py`: one-command operator gate that runs the safe
  Castform readiness check, Benchmax bridge smoke, Castform SDK workflow smoke,
  mocked E2E recovery rehearsal, parent-page smoke, optionally the full local
  real iframe E2E under `--full`, and optionally the live persisted-data smoke
  under `--live`.
- `run_live_blocked_smoke.py`: one-command live-data recovery smoke that reuses
  the known production run IDs, writes the current blocked-embed parent-page
  manifest, serves the page locally, and browser-verifies the no-token blocked
  state.
- `check_hosted_readiness.py`: hosted preflight that checks dependencies,
  ignored generated paths, parent-origin shape, optional tunnel reachability,
  live env var presence, and `https://api.instantml.ai/health` without writing
  any data or printing secrets.
- `check_castform_readiness.py`: live Castform SDK preflight that checks the
  Benchmax/Castform SDK import, Castform API-key presence, uploaded asset
  arguments, and optional Castform app reachability without printing secrets.
- `run_mocked_e2e.py`: local fake-InstantML end-to-end rehearsal that runs the
  real hosted writer, records SDK traffic, creates mock embed sessions, serves
  the parent page, verifies the existing-run resume path without increasing the
  run count, runs artifact verification, and runs desktop/mobile browser checks
  without live credentials.
- `run_local_real_iframe_e2e.py`: one-command local real InstantML iframe E2E
  that starts an isolated Rust API, ClickHouse, Next embed app, and parent page;
  writes Castform-shaped runs through the SDK; creates real local embed
  sessions; and verifies rendered iframe panels on desktop and mobile.
- `verify_demo.py`: generated manifest and redacted-summary verifier.
- `live-runbook.md`: operator runbook for the hosted call demo.
- `live-hosted-status.md`: current live production run IDs, verification
  evidence, and the hosted iframe deployment blocker observed on 2026-07-01.
- `readiness-review.md`: dedicated review pass covering call readiness,
  verification evidence, operator commands, and residual blockers.

## Demo Paths

Live mirror path, if we have Castform and InstantML credentials:

```bash
CASTFORM_API_KEY=sk_... \
INSTANTML_API_KEY=instantml_... \
PYTHONPATH=packages/python-sdk \
python3 demo/castform/castform_instantml_adapter.py \
  --castform-run-id <castform-run-id> \
  --instantml-project castform-demo
```

Synthetic fallback path:

```bash
INSTANTML_API_KEY=instantml_... \
PYTHONPATH=packages/python-sdk \
python3 demo/castform/seed_castform_demo.py --project castform-demo --runs 10
```

Both paths are designed to populate InstantML with Castform-shaped run metadata,
reward curves, solve-rate curves, response-length curves, subreward curves,
environment logs, and lifecycle notes so the call can focus on the integration
value instead of credential setup.

## End-to-End Hosted Demo

The full demo design lives in `e2e-design.md`. The runnable slice writes to
hosted InstantML by default under the `castform-live-demo` project. As of
2026-07-01, production run writes work, but hosted embed-session routes are not
deployed; the call-ready production path therefore shows live persisted data
plus an explicit blocked-iframe state. The full real iframe proof uses the local
Rust API and local Next embed app through `run_local_real_iframe_e2e.py`.

When hosted embeds are deployed, the same `run_demo.py` command will create
hosted iframe sessions that persist through the call. The local Castform parent
page must be served through an HTTPS tunnel because hosted InstantML embeds
require an exact HTTPS, non-InstantML parent origin.

Use `live-runbook.md` for the full production-key and browser-verification
sequence.

1. Start the parent page:

   ```bash
   python3 demo/castform/serve_web.py --port 5174
   ```

2. Expose port 5174 through an HTTPS tunnel.

3. In a separate shell, provide a live InstantML API key with `sdk:ingest` and
   `export:read`, then write the demo data. The live scripts automatically load
   ignored `demo/castform/.env` values when present and preserve variables
   already exported in the shell. To mirror a real Castform run, also provide
   `CASTFORM_API_KEY` and pass `--castform-run-id <id>`.

   ```bash
   INSTANTML_API_KEY=instantml_... \
   python3 demo/castform/run_demo.py \
     --parent-origin https://your-demo-origin.example \
     --allow-embed-blocked
   ```

`run_demo.py` writes the untracked token-bearing iframe manifest to
`web/public/demo-manifest.json` and a redacted review summary to
`run-output/latest-summary.json`. While hosted embed routes are still absent,
`--allow-embed-blocked` writes a no-token blocked-state manifest after the run
data is persisted, so the parent page can show the live run cards and the
explicit deployment blocker instead of failing before the browser demo.

After hosted embed routes are deployed, reuse already-written InstantML runs
without duplicating data:

```bash
INSTANTML_API_KEY=instantml_... \
python3 demo/castform/run_demo.py \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo \
  --allow-embed-blocked \
  --instantml-run-id a0c53fce-5351-476b-bd63-537c6ce442be \
  --instantml-run-id 01fff006-b7e6-4329-9d6d-c32b44eb4d3c \
  --instantml-run-id b9a7b17a-8e37-4bec-9ae2-9ea4a9bba429 \
  --instantml-run-id a51f74e9-1077-4587-87ad-9d678002aa49 \
  --instantml-run-id 1ddca3ef-fd24-4032-a95b-1d77f1c4b8aa
```

Verify generated artifacts without exposing live tokens:

```bash
python3 demo/castform/verify_demo.py \
  --parent-url https://your-demo-origin.example \
  --allow-blocked-embeds
```

Local browser smoke before live credentials:

```bash
python3 demo/castform/run_local_smoke.py
```

The smoke report is written to `run-output/local-smoke-report.json`, which is
ignored by Git.

If port 5174 is already in use, choose a free local port for the preflight:

```bash
python3 demo/castform/run_local_smoke.py --port 0
```

Hosted readiness check before writing to InstantML:

```bash
python3 demo/castform/check_hosted_readiness.py \
  --parent-origin https://your-demo-origin.example
```

For dry rehearsal before live secrets are exported, add
`--allow-missing-live-inputs`. The readiness check also inspects hosted
OpenAPI for `POST /api/embed/sessions`; while the route is absent it reports a
warning and operators should use `--allow-embed-blocked` or the local real
iframe E2E. Add `--require-hosted-embeds` when you expect real hosted iframes
and want the check to fail until that route is deployed.

Live Castform SDK readiness check before launching through uploaded assets:

```bash
python3 demo/castform/check_castform_readiness.py \
  --allow-missing-live-inputs \
  --skip-network
python3 demo/castform/run_castform_bridge_smoke.py
python3 demo/castform/run_castform_sdk_e2e_smoke.py
```

Full local writer rehearsal without live credentials:

```bash
python3 demo/castform/run_call_prep_check.py --full
python3 demo/castform/run_mocked_e2e.py
```

`run_call_prep_check.py --full` is the walk-up gate: it runs the Castform
readiness dry check, the Benchmax bridge smoke, the fake Castform SDK
launch-to-mirror workflow, the mocked InstantML E2E, the local parent-page
smoke, and the full local real iframe E2E. After a live InstantML key is
available in the environment or ignored `.env`, use
`python3 demo/castform/run_call_prep_check.py --full --live` to include hosted
readiness and the current production persisted-data browser smoke in the same
report. `run_mocked_e2e.py` alone runs the real `run_demo.py` against a local
fake InstantML API and writes
`run-output/mocked-e2e-report.json`, which is ignored by Git. It covers both
fresh SDK ingestion and the `--instantml-run-id` recovery command.

Full local real InstantML iframe E2E:

```bash
python3 demo/castform/run_local_real_iframe_e2e.py \
  --runs 3 \
  --steps 40 \
  --step-size 10 \
  --timeout 180
```

This starts an isolated local Rust API and local Next embed app, mints a
disposable local API key, writes data through the InstantML SDK, creates real
local embed sessions, reuses the same run IDs through `--instantml-run-id`
without increasing the run count, serves the Castform parent page, and verifies
that the InstantML iframe renders metric panels at desktop and mobile
viewports. It also writes ignored screenshot evidence to
`run-output/local-real-iframe-screenshots/`. Do not run another `next dev` for
`apps/web` at the same time; Next uses an app-level development lock even when
this script chooses a free port.

For an actual screen-shared demo while hosted iframe sessions are unavailable,
add `--keep-running`. The runner writes a report containing the live parent URL
before it waits, then keeps the local API, local InstantML web app, and Castform
parent page running until Ctrl-C. Add `--open-browser` to open the verified
page automatically after the checks pass:

```bash
python3 demo/castform/run_local_real_iframe_e2e.py \
  --runs 3 \
  --steps 40 \
  --step-size 10 \
  --timeout 180 \
  --keep-running \
  --open-browser
```

When production run data exists but hosted embed sessions are not deployed,
regenerate and verify the explicit blocked state with:

```bash
python3 demo/castform/run_live_blocked_smoke.py
```

This command reads the existing production run summaries, confirms the hosted
embed route is still blocked, serves the parent page locally, and runs desktop
plus mobile browser checks. If you already have an HTTPS tunnel running and
want the manifest to use that exact origin, pass
`--parent-origin https://your-demo-origin.example`. It can use
`demo/castform/.env` directly, so exporting `INSTANTML_API_KEY` is optional
when that ignored file already exists.

For an already served HTTPS origin, the direct browser verifier is:

```bash
node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 5 \
  --expect-sessions 0 \
  --allow-blocked-embeds
```

## Verification

The scripts are dependency-light but require installed `instantml` and, for the
live mirror path, installed `benchmax` at runtime. Syntax-only verification:

```bash
python3 -m py_compile demo/castform/demo_env.py demo/castform/run_demo.py demo/castform/castform_live_bridge.py demo/castform/serve_web.py demo/castform/verify_demo.py demo/castform/castform_instantml_adapter.py demo/castform/seed_castform_demo.py demo/castform/create_smoke_manifest.py demo/castform/run_local_smoke.py demo/castform/check_hosted_readiness.py demo/castform/check_castform_readiness.py demo/castform/run_mocked_e2e.py demo/castform/run_local_real_iframe_e2e.py demo/castform/run_call_prep_check.py demo/castform/run_live_blocked_smoke.py demo/castform/run_castform_bridge_smoke.py demo/castform/run_castform_sdk_e2e_smoke.py
node --check demo/castform/web/app.js
node --check demo/castform/browser_verify.mjs
```
