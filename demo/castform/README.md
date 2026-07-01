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
- `verify_demo.py`: generated manifest and redacted-summary verifier.
- `live-runbook.md`: operator runbook for the hosted call demo.

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

## Verification

The scripts are dependency-light but require installed `instantml` and, for the
live mirror path, installed `benchmax` at runtime. Syntax-only verification:

```bash
python3 -m py_compile demo/castform/run_demo.py demo/castform/castform_live_bridge.py demo/castform/serve_web.py demo/castform/verify_demo.py demo/castform/castform_instantml_adapter.py demo/castform/seed_castform_demo.py demo/castform/create_smoke_manifest.py demo/castform/run_local_smoke.py
node --check demo/castform/web/app.js
node --check demo/castform/browser_verify.mjs
```
