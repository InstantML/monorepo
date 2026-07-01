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
- `serve_web.py` and `web/`: local Castform-facing parent page for the hosted
  iframe embeds.
- `create_smoke_manifest.py`: deterministic local manifest generator for
  parent-page browser verification without live credentials.
- `browser_verify.mjs`: Playwright-based parent-page renderer and interaction
  verifier that redacts token-like diagnostics.
- `run_local_smoke.py`: one-command local preflight that generates the smoke
  manifest, starts the parent page, runs artifact verification, runs desktop and
  mobile browser checks, writes an ignored safe report, and stops the server.
- `check_hosted_readiness.py`: hosted preflight that checks dependencies,
  ignored generated paths, parent-origin shape, optional tunnel reachability,
  live env var presence, and `https://api.instantml.ai/health` without writing
  any data or printing secrets.
- `run_mocked_e2e.py`: local fake-InstantML end-to-end rehearsal that runs the
  real hosted writer, records SDK traffic, creates mock embed sessions, serves
  the parent page, runs artifact verification, and runs desktop/mobile browser
  checks without live credentials.
- `run_local_real_iframe_e2e.py`: one-command local real InstantML iframe E2E
  that starts an isolated Rust API, ClickHouse, Next embed app, and parent page;
  writes Castform-shaped runs through the SDK; creates real local embed
  sessions; and verifies rendered iframe panels on desktop and mobile.
- `verify_demo.py`: generated manifest and redacted-summary verifier.
- `live-runbook.md`: operator runbook for the hosted call demo.
- `live-hosted-status.md`: current live production run IDs, verification
  evidence, and the hosted iframe deployment blocker observed on 2026-07-01.

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

The full demo design lives in `e2e-design.md`. The runnable slice will write to
hosted InstantML by default under a new `castform-live-demo` project and create
hosted iframe embed sessions that persist through the call. The local Castform
parent page must be served through an HTTPS tunnel because hosted InstantML
embeds require an exact HTTPS, non-InstantML parent origin.

Use `live-runbook.md` for the full production-key and browser-verification
sequence.

1. Start the parent page:

   ```bash
   python3 demo/castform/serve_web.py --port 5174
   ```

2. Expose port 5174 through an HTTPS tunnel.

3. In a separate shell, export a live InstantML API key with `sdk:ingest` and
   `export:read`, then write the demo data. To mirror a real Castform run, also
   export `CASTFORM_API_KEY` and pass `--castform-run-id <id>`.

   ```bash
   INSTANTML_API_KEY=instantml_... \
   python3 demo/castform/run_demo.py \
     --parent-origin https://your-demo-origin.example
   ```

`run_demo.py` writes the untracked token-bearing iframe manifest to
`web/public/demo-manifest.json` and a redacted review summary to
`run-output/latest-summary.json`.

After hosted embed routes are deployed, reuse already-written InstantML runs
without duplicating data:

```bash
INSTANTML_API_KEY=instantml_... \
python3 demo/castform/run_demo.py \
  --parent-origin https://your-demo-origin.example \
  --project castform-live-demo \
  --instantml-run-id 80aa6afb-4003-4756-bffc-591c541a332d \
  --instantml-run-id a2f80903-ddf8-4e84-a4dc-297480144093 \
  --instantml-run-id 46d776c3-8061-44a0-9ce5-27a9cf3ab85b \
  --instantml-run-id 2abdb990-1305-47ee-be70-c0716ac0f1c4
```

Verify generated artifacts without exposing live tokens:

```bash
python3 demo/castform/verify_demo.py \
  --parent-url https://your-demo-origin.example
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
`--allow-missing-live-inputs`.

Full local writer rehearsal without live credentials:

```bash
python3 demo/castform/run_mocked_e2e.py
```

This runs the real `run_demo.py` against a local fake InstantML API and writes
`run-output/mocked-e2e-report.json`, which is ignored by Git.

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
viewports. Do not run another `next dev` for `apps/web` at the same time; Next
uses an app-level development lock even when this script chooses a free port.

When production run data exists but hosted embed sessions are not deployed,
verify the explicit blocked state with:

```bash
node demo/castform/browser_verify.mjs \
  --url https://your-demo-origin.example \
  --expect-runs 4 \
  --expect-sessions 0 \
  --allow-blocked-embeds
```

## Verification

The scripts are dependency-light but require installed `instantml` and, for the
live mirror path, installed `benchmax` at runtime. Syntax-only verification:

```bash
python3 -m py_compile demo/castform/run_demo.py demo/castform/castform_live_bridge.py demo/castform/serve_web.py demo/castform/verify_demo.py demo/castform/castform_instantml_adapter.py demo/castform/seed_castform_demo.py demo/castform/create_smoke_manifest.py demo/castform/run_local_smoke.py demo/castform/check_hosted_readiness.py demo/castform/run_mocked_e2e.py demo/castform/run_local_real_iframe_e2e.py
node --check demo/castform/web/app.js
node --check demo/castform/browser_verify.mjs
```
